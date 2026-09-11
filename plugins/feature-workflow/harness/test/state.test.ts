import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  StateSchema, loadState, saveState, selectNextPhase,
  verifyCommandsFor, answerQuestion, allPhasesDone,
  assertRunnable, retryPhase, type State,
  checkRunLogsIgnored, runLogsDir, suggestGitignoreLineForLogs, runLogsNotIgnoredReason,
  defaultRunLogsGitCheckIgnoreExec, type RunLogsGitCheckIgnoreExec,
  resolveSandboxSettings, sandboxOriginHostAutoAdded, recordVerdict, type Phase,
  SessionVerdictSchema,
} from "../src/state.js";

function baseState(): State {
  return StateSchema.parse({
    schema_version: 1,
    workflow: "test-wf",
    repo_root: "/tmp/repo",
    branch_strategy: "topic",
    allow_push: false,
    // §26 I5 잔여 승격: assertRunnable 이 이제 verify 명령을 린트해 시작을 거부할 수 있다 —
    // "true" 는 이제 error 다. 이 파일의 assertRunnable "정상 상태는 통과한다" 테스트가 그대로
    // 통과해야 하므로 기본값을 lint 를 통과하는 값으로 바꾼다(값 자체는 실행되지 않는다 — 이
    // describe 블록의 테스트는 실제 게이트를 실행하지 않는다).
    verify_default: ["npm test"],
    status: "running",
    pending_question: null,
    answers: [],
    phases: [
      { id: 1, title: "phase one", status: "pending", depends_on: [], verify: [], attempts: 0, max_attempts: 2, sessions: [] },
      { id: 2, title: "phase two", status: "pending", depends_on: [1], verify: ["./gradlew build"], attempts: 0, max_attempts: 2, sessions: [] },
    ],
  });
}

describe("StateSchema", () => {
  it("유효한 상태를 파싱한다", () => {
    expect(baseState().workflow).toBe("test-wf");
  });
  it("잘못된 status 를 거부한다", () => {
    const bad = { ...baseState(), status: "banana" };
    expect(() => StateSchema.parse(bad)).toThrow();
  });
});

describe("StateSchema - strict 스키마 강화", () => {
  it("최상위에 오타 키가 있으면 거부한다 (예: verify_defualt)", () => {
    const s = baseState();
    const bad = { ...s, verify_defualt: ["true"] };
    expect(() => StateSchema.parse(bad)).toThrow();
  });
  it("phase 에 오타 키가 있으면 거부한다", () => {
    const s = baseState();
    const bad = { ...s, phases: [{ ...s.phases[0], verify_defualt: [] }, s.phases[1]] };
    expect(() => StateSchema.parse(bad)).toThrow();
  });
  it("pending_question 에 알 수 없는 키가 있으면 거부한다", () => {
    const s = baseState();
    const bad = {
      ...s,
      pending_question: { phase: 1, question: "Q", asked_at: "t", extra: true },
    };
    expect(() => StateSchema.parse(bad)).toThrow();
  });
  it("phase id 는 양수여야 한다", () => {
    const s = baseState();
    const bad = { ...s, phases: [{ ...s.phases[0], id: 0 }, s.phases[1]] };
    expect(() => StateSchema.parse(bad)).toThrow();
  });
  it("attempts 는 음수를 거부한다", () => {
    const s = baseState();
    const bad = { ...s, phases: [{ ...s.phases[0], attempts: -1 }, s.phases[1]] };
    expect(() => StateSchema.parse(bad)).toThrow();
  });
  it("max_attempts 는 1 미만을 거부한다", () => {
    const s = baseState();
    const bad = { ...s, phases: [{ ...s.phases[0], max_attempts: 0 }, s.phases[1]] };
    expect(() => StateSchema.parse(bad)).toThrow();
  });
  it("last_log 는 선택적 문자열 필드로 허용한다", () => {
    const s = baseState();
    const withLog = { ...s, phases: [{ ...s.phases[0], last_log: "/tmp/x.log" }, s.phases[1]] };
    expect(StateSchema.parse(withLog).phases[0].last_log).toBe("/tmp/x.log");
  });
  it("answers 항목에 phase 번호를 기록할 수 있다", () => {
    const s = baseState();
    const withPhase = { ...s, answers: [{ question: "q", answer: "a", at: "t", phase: 1 }] };
    expect(StateSchema.parse(withPhase).answers[0].phase).toBe(1);
  });
});

describe("selectNextPhase", () => {
  it("의존성이 충족된 첫 pending phase 를 고른다", () => {
    const s = baseState();
    expect(selectNextPhase(s)?.id).toBe(1);
  });
  it("의존성이 미충족이면 건너뛴다", () => {
    const s = baseState();
    s.phases[0].status = "in_progress"; // 1이 안 끝났으므로 2는 불가
    expect(selectNextPhase(s)?.id).toBe(1); // in_progress 재개(크래시 복구)
  });
  it("모두 done 이면 null", () => {
    const s = baseState();
    s.phases.forEach(p => (p.status = "done"));
    expect(selectNextPhase(s)).toBeNull();
    expect(allPhasesDone(s)).toBe(true);
  });
  it("blocked phase 는 답변 후 재선택 대상이다", () => {
    const s = baseState();
    s.phases[0].status = "blocked";
    expect(selectNextPhase(s)?.id).toBe(1);
  });
  it("회귀: 의존 phase 가 failed 면 의존하는 phase 도 선택되지 않는다", () => {
    // phase1 이 failed 로 멈춘 채 방치되면(재시도 소진), phase2(depends_on:[1]) 는
    // 아직 실행 불가 상태여야 한다 — depends_on 게이팅이 done 만 인정하는지 실검증.
    const s = baseState();
    s.phases[0].status = "failed";
    expect(selectNextPhase(s)).toBeNull();
  });
});

describe("verifyCommandsFor", () => {
  it("phase.verify 가 있으면 그것을 쓴다", () => {
    const s = baseState();
    expect(verifyCommandsFor(s, s.phases[1])).toEqual(["./gradlew build"]);
  });
  it("없으면 verify_default 로 폴백한다", () => {
    const s = baseState();
    expect(verifyCommandsFor(s, s.phases[0])).toEqual(["npm test"]);
  });
  it("phase.verify 와 verify_default 가 모두 비어있으면 throw 한다 (게이트 무력화 방지)", () => {
    const s = baseState();
    s.verify_default = [];
    expect(() => verifyCommandsFor(s, s.phases[0])).toThrow();
  });
});

describe("answerQuestion", () => {
  it("질문을 answers 로 옮기고 blocked phase 를 pending 으로 되돌린다", () => {
    const s = baseState();
    s.status = "blocked";
    s.phases[0].status = "blocked";
    s.pending_question = { phase: 1, question: "A or B?", asked_at: "2026-08-26T00:00:00Z" };
    answerQuestion(s, "B로 가자", "2026-08-26T01:00:00Z");
    expect(s.pending_question).toBeNull();
    expect(s.status).toBe("running");
    expect(s.phases[0].status).toBe("pending");
    // 강화: answers 항목에 대상 phase 번호가 함께 기록된다
    expect(s.answers[0]).toEqual({ question: "A or B?", answer: "B로 가자", phase: 1, at: "2026-08-26T01:00:00Z" });
  });
  it("pending_question 이 없으면 throw", () => {
    expect(() => answerQuestion(baseState(), "x", "t")).toThrow();
  });
  it("대상 phase 가 존재하지 않으면 throw 하고 상태를 바꾸지 않는다", () => {
    const s = baseState();
    s.status = "blocked";
    s.pending_question = { phase: 999, question: "Q", asked_at: "t" };
    expect(() => answerQuestion(s, "A", "t2")).toThrow();
    expect(s.pending_question).not.toBeNull();
    expect(s.status).toBe("blocked");
    expect(s.answers.length).toBe(0);
  });
  it("대상 phase 가 blocked 상태가 아니면 throw 하고 상태를 바꾸지 않는다", () => {
    const s = baseState();
    s.status = "blocked";
    s.phases[0].status = "pending"; // blocked 아님
    s.pending_question = { phase: 1, question: "Q", asked_at: "t" };
    expect(() => answerQuestion(s, "A", "t2")).toThrow();
    expect(s.pending_question).not.toBeNull();
    expect(s.phases[0].status).toBe("pending");
    expect(s.answers.length).toBe(0);
  });

  // B-2 회귀 테스트 (§25): PR fix 세션이 blocked 되면 phase.pr 이 이미 있는데도 "pending" 으로
  // 되돌려 전체 phase 세션이 처음부터 다시 도는 라이브락이 실행으로 재현됐다. phase.pr 이 있으면
  // in_review 로 복귀시켜 orchestrator 가 PR 폴링만 재개하게 해야 한다.
  it("B-2: phase.pr 이 있으면 pending 이 아니라 in_review 로 복귀한다 (PR 컨텍스트 보존)", () => {
    const s = baseState();
    s.status = "blocked";
    s.phases[0].status = "blocked";
    s.phases[0].pr = {
      number: 42, url: "https://ex/pull/42", head_branch: "fw/phase-1",
      handled_comment_keys: [], fix_sessions: 1,
    };
    s.pending_question = { phase: 1, question: "어떤 방식으로 반영할까요?", asked_at: "t" };
    answerQuestion(s, "옵션 A로", "t2");
    expect(s.phases[0].status).toBe("in_review");
    expect(s.status).toBe("running");
    expect(s.pending_question).toBeNull();
  });

  it("B-2: phase.pr 이 없으면(v1/유인 모드) 기존과 동일하게 pending 으로 복귀한다", () => {
    const s = baseState();
    s.status = "blocked";
    s.phases[0].status = "blocked";
    s.pending_question = { phase: 1, question: "Q", asked_at: "t" };
    answerQuestion(s, "A", "t2");
    expect(s.phases[0].pr).toBeUndefined();
    expect(s.phases[0].status).toBe("pending");
  });
});

describe("assertRunnable", () => {
  it("정상 상태는 통과한다", () => {
    expect(() => assertRunnable(baseState())).not.toThrow();
  });
  it("phases 가 비어있으면 거부한다", () => {
    const s = baseState();
    s.phases = [];
    expect(() => assertRunnable(s)).toThrow();
  });
  it("phase id 가 중복되면 거부한다", () => {
    const s = baseState();
    s.phases[1].id = 1;
    expect(() => assertRunnable(s)).toThrow(/중복/);
  });
  it("존재하지 않는 id 를 depends_on 이 참조하면 거부한다", () => {
    const s = baseState();
    s.phases[1].depends_on = [999];
    expect(() => assertRunnable(s)).toThrow(/존재하지 않는/);
  });
  it("phase 가 자기 자신을 depends_on 하면 거부한다", () => {
    const s = baseState();
    s.phases[0].depends_on = [1];
    expect(() => assertRunnable(s)).toThrow(/자기/);
  });
  it("의존성 순환이 있으면 거부한다", () => {
    const s = baseState();
    s.phases[0].depends_on = [2]; // 1→2, 2→1 순환
    expect(() => assertRunnable(s)).toThrow(/순환/);
  });
  it("유효 검증 명령이 없는 phase 가 있으면 거부한다", () => {
    const s = baseState();
    s.verify_default = [];
    s.phases[0].verify = [];
    expect(() => assertRunnable(s)).toThrow(/검증/);
  });
  it("failed phase 가 남아있으면 거부하고 fw retry 안내를 포함한다", () => {
    const s = baseState();
    s.phases[0].status = "failed";
    expect(() => assertRunnable(s)).toThrow(/fw retry/);
  });
  // §27 O2/O3, §2 D 표: halted 는 "운영자/상한이 멈춤, 그냥 이어서 돌리면 됨" — blocked 와 달리
  // assertRunnable 이 거부하면 안 된다(재개 가능해야 한다). §30 P2 체크리스트: 정상 재개 경로가
  // 이 방어에 걸리지 않는지 확인한다.
  it("halted 상태는 거부하지 않는다 (재개 가능해야 함)", () => {
    const s = baseState();
    s.status = "halted";
    s.halt_reason = "비용 상한 초과: $12.40 / $10.00";
    expect(() => assertRunnable(s)).not.toThrow();
  });
});

// §26 I5 잔여 승격: doctor.ts 의 옵트인 정적 진단(lintVerifyCommands)을 assertRunnable 이 직접
// 돌려 `fw run` 시작 자체를 거부하게 한다. severity:"error" 만 거부하고 "warn" 은 거부하지
// 않는다 — §30 P2("방어가 정상 경로를 막는다")를 반복하지 않도록, 이 방어를 통과해야 하는
// 가장 흔한 정상 사용을 반드시 함께 검증한다.
describe("assertRunnable: verify 명령 린트 승격 (§26 I5 잔여)", () => {
  // §30 P2 체크리스트 1: 정상 사용 3가지 이상을 거부하지 않는지 확인한다.
  describe("정상 verify 명령은 거부하지 않는다 (§30 P2 정상 경로)", () => {
    it.each([
      "./gradlew build",
      "npm test",
      "pytest -x",
      "make test",
      "grep -q '^- 2026' docs/pr-smoke/SMOKE.md",
      "set -o pipefail && npm test | tee build.log", // 린트가 스스로 권하는 관용구(§26 I5 오탐 수정)
    ])("verify_default: [%s] 는 시작을 거부하지 않는다", command => {
      const s = baseState();
      s.verify_default = [command];
      s.phases.forEach(p => (p.verify = []));
      expect(() => assertRunnable(s)).not.toThrow();
    });
  });

  // §30 P2 체크리스트 1 (계속): warn 만 있는 명령(무력화를 보장하지 않는 패턴)도 거부하지 않는다.
  it("warn 만 있는 명령(--passWithNoTests, 파이프)은 거부하지 않는다", () => {
    const s = baseState();
    s.verify_default = ["jest --passWithNoTests", "npm test | grep PASS"];
    s.phases.forEach(p => (p.verify = []));
    expect(() => assertRunnable(s)).not.toThrow();
  });

  // verify_default 는 비어 있고 phase 별 verify 만 있는 구성도 올바르게 검사돼야 한다(설계 문서
  // "verify_default 는 비어 있고 phase 별 verify 만 있는 경우도 올바르게 검사된다").
  it("verify_default 가 비어 있고 phase 별 verify 만 있어도 각 phase 의 verify 를 린트한다", () => {
    const s = baseState();
    s.verify_default = [];
    s.phases.forEach(p => (p.verify = ["npm test"]));
    expect(() => assertRunnable(s)).not.toThrow();

    s.phases[0].verify = ["npm test || true"]; // 무력화 패턴
    expect(() => assertRunnable(s)).toThrow(/게이트를 무력화합니다/);
  });

  // §30 P2 체크리스트 2/3: 무력화 패턴은 실제로 거부되고, 메시지에 phase/명령/사유 + fw doctor
  // 안내가 담겨 있어야 한다(탈출구가 메시지에 있어야 한다는 규칙).
  describe("게이트를 무력화하는 명령은 시작을 거부한다", () => {
    it.each([
      "npm test || true",
      "echo ok",
      "npm test &",
      "npm run test; exit 0",
      "set +e && npm test",
      "npm test | tee build.log", // pipefail 가드 없는 tee
    ])("verify_default: [%s] 는 시작을 거부한다", command => {
      const s = baseState();
      s.verify_default = [command];
      s.phases.forEach(p => (p.verify = []));
      expect(() => assertRunnable(s)).toThrow(/게이트를 무력화합니다/);
    });
  });

  it("거부 메시지에 어느 phase·어느 명령·왜 인지와 fw doctor 안내가 담긴다", () => {
    const s = baseState();
    s.verify_default = [];
    s.phases[0].verify = ["npm test || true"];
    s.phases[1].verify = ["./gradlew build"]; // 다른 phase 는 정상
    try {
      assertRunnable(s);
      throw new Error("assertRunnable 이 throw 하지 않았습니다");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain(`Phase ${s.phases[0].id}`);
      expect(msg).toContain(s.phases[0].title);
      expect(msg).toContain("npm test || true");
      expect(msg).toContain("fw doctor");
    }
  });

  // §29 MI-11 이 지적한 미탐(`--if-present` 등 오래된 문서 예시)은 이번 승격 범위가 아니다 —
  // lintVerifyCommands 규칙 테이블 자체의 개선은 §26 I5 에서 별도로 다뤘고, 여기서는 이미 있는
  // 규칙을 "실행 자체를 거부"로 승격하는 것만 다룬다. 회귀 방지로 미탐임을 명시해 둔다(다음
  // 라운드가 "왜 이게 안 잡히지" 를 다시 조사하지 않도록).
  it("알려진 미탐(--if-present)은 이번 승격 범위 밖이라 여전히 거부하지 않는다 (문서화된 한계)", () => {
    const s = baseState();
    s.verify_default = ["npm run test --if-present"];
    s.phases.forEach(p => (p.verify = []));
    expect(() => assertRunnable(s)).not.toThrow();
  });

  // §30 P2 체크리스트: 이미 done 인 phase 는 다시 실행되지 않으므로, 그 phase 의 verify 가
  // 나빠도(완료 후 사람이 STATE.json 을 손으로 고쳤거나 옛 산출물이거나) 재개를 막지 않는다 —
  // §26 C1/§29 MI-4 가 반복한 "방어가 정상 재개 경로를 막는다" 패턴의 재발 방지.
  it("done phase 의 verify 명령이 나빠도 거부하지 않는다 (재개 경로 보호)", () => {
    const s = baseState();
    s.phases[0].status = "done";
    s.phases[0].verify = ["npm test || true"]; // done 이라 다시 실행되지 않음
    s.phases[1].verify = ["npm test"]; // 아직 실행될 phase 는 정상
    expect(() => assertRunnable(s)).not.toThrow();
  });

  it("반대로 done 이 아닌 phase 의 나쁜 verify 는 여전히 거부한다 (위 테스트가 전면 우회가 아님을 확인)", () => {
    const s = baseState();
    s.phases[0].status = "pending";
    s.phases[0].verify = ["npm test || true"];
    expect(() => assertRunnable(s)).toThrow(/게이트를 무력화합니다/);
  });

  // §31 I2 인접 결함(1): "verify 비어있음" 검사가 done phase 를 skip 하지 않아 바로 아래(§30 P2
  // 근거로 done 을 skip 하는) 린트 루프와 모순이었다 — done phase 의 verify 가 비면 재개가
  // 영구히 막혔다(실측). done 은 다시 실행되지 않으므로 verify 가 비어도 무해해야 한다.
  describe("§31 I2 인접(1): done phase 의 빈 verify 는 재개를 막지 않는다", () => {
    it("done phase 의 verify 가 비어 있고 verify_default 도 비어 있어도 거부하지 않는다", () => {
      const s = baseState();
      s.phases[0].status = "done";
      s.phases[0].verify = [];
      s.verify_default = [];
      s.phases[1].verify = ["npm test"]; // 아직 실행될 phase 는 정상 verify 를 갖는다
      expect(() => assertRunnable(s)).not.toThrow();
    });

    it("반대로 done 이 아닌 phase 의 빈 verify 는 여전히 거부한다 (전면 우회가 아님을 확인)", () => {
      const s = baseState();
      s.phases[0].status = "pending";
      s.phases[0].verify = [];
      s.verify_default = [];
      expect(() => assertRunnable(s)).toThrow(/검증/);
    });
  });

  // §31 I2 인접 결함(2): 모든 non-done phase 가 자기 verify 를 가지면 verify_default 는
  // verifyCommandsFor 어디에도 나타나지 않아 린트되지 않았다 — 그런데 permissions.ts 의
  // policyFor 는 사용 여부와 무관하게 verify_default 를 세션 Bash 자동 허용 목록에 항상
  // 포함시킨다(실측: verify_default:["npm test || true"] + 모든 phase 가 자기 verify 보유 →
  // 기존 assertRunnable 통과 + policyFor(phase).verifyCommands 에 포함). 사용 여부와 무관하게
  // 항상 린트해야 한다.
  describe("§31 I2 인접(2): verify_default 는 어느 phase 도 안 써도 항상 린트된다", () => {
    it("모든 phase 가 자기 verify 를 갖고 있어도 무력화 패턴인 verify_default 는 거부한다", () => {
      const s = baseState();
      s.verify_default = ["npm test || true"]; // 무력화 패턴 — 아무 phase 도 안 씀
      s.phases.forEach(p => (p.verify = ["npm test"])); // 모든 phase 가 자기 verify 보유
      expect(() => assertRunnable(s)).toThrow(/verify_default.*게이트를 무력화합니다/s);
    });

    it("반대로 정상 verify_default 는 아무도 안 써도 거부하지 않는다", () => {
      const s = baseState();
      s.verify_default = ["npm test"]; // 정상 — 아무 phase 도 안 씀
      s.phases.forEach(p => (p.verify = ["./gradlew build"]));
      expect(() => assertRunnable(s)).not.toThrow();
    });
  });

  // §32 I-4: 바로 위 블록(§31 I2 인접(2))이 "verify_default 는 사용 여부와 무관하게 항상
  // 린트한다"를 확립했는데, 그 "항상"이 **실행될 명령이 하나도 없는 상태**(전 phase done)까지
  // 거부하는 자충수였다 — runWorkflow 가 마지막 phase 를 done 으로 저장한 직후와
  // state.status="done" 을 저장하는 사이의 창에서 크래시하면 STATE 에는 status:"running" +
  // 전 phase done 이 남는데, 그 상태에서 verify_default 가 나쁘면 영구히 `fw run` 이 거부돼
  // verify 에이전트도 못 돌고 done 으로도 못 가는 죽은 상태가 된다(§30 P2 재발, 감사자 실측).
  // 같은 파일 §31 I2 인접(1)(:361-378)은 이미 "이 phase 가 done 이면 skip" 계약을 지키는데
  // 이 블록만 전역적이라 그 계약과 자기모순이었다 — allPhasesDone 이면 건너뛰도록 고친다.
  describe("§32 I-4: 전 phase 가 done 이면 verify_default 가 나빠도 재개를 막지 않는다", () => {
    it("전 phase done + 나쁜 verify_default → 거부하지 않는다 (실행될 명령이 하나도 없다)", () => {
      const s = baseState();
      s.phases.forEach(p => {
        p.status = "done";
        p.verify = [];
      });
      s.verify_default = ["npm test || true"]; // 무력화 패턴 — 그러나 아무도 실행하지 않는다
      expect(allPhasesDone(s)).toBe(true);
      expect(() => assertRunnable(s)).not.toThrow();
    });

    it("전 phase done + 나쁜 default + phase 가 자기 verify 도 보유 → 여전히 거부하지 않는다", () => {
      const s = baseState();
      s.phases.forEach(p => {
        p.status = "done";
        p.verify = ["./gradlew build"]; // done 이라 이미 무관 — 다시 실행되지 않는다
      });
      s.verify_default = ["npm test || true"];
      expect(() => assertRunnable(s)).not.toThrow();
    });

    it("회귀: 일부 phase 만 done 이면(하나라도 미완료) 나쁜 default 는 여전히 거부한다", () => {
      const s = baseState();
      s.phases[0].status = "done";
      s.phases[0].verify = [];
      // phase 2 는 자기 verify 를 갖는다 — §31 I2 인접(2) 와 동일하게 "아무 phase 도 default 를
      // 안 써도" 여전히 거부되는지(전역 검사)를 확인하려는 것이므로, 여기서 phase 의 빈 verify
      // 로 인한 phase-단위 린트(다른 메시지)가 먼저 걸리지 않게 한다.
      s.phases[1].status = "pending"; // 아직 안 끝남
      s.phases[1].verify = ["./gradlew build"];
      s.verify_default = ["npm test || true"]; // 아무 phase 도 안 쓰지만 non-done phase 가 있다
      expect(allPhasesDone(s)).toBe(false);
      expect(() => assertRunnable(s)).toThrow(/verify_default.*게이트를 무력화합니다/s);
    });

    it("회귀: 전 phase done + verify_default 도 비어 있으면(레거시) 여전히 거부하지 않는다", () => {
      const s = baseState();
      s.phases.forEach(p => {
        p.status = "done";
        p.verify = [];
      });
      s.verify_default = [];
      expect(() => assertRunnable(s)).not.toThrow();
    });
  });
});

describe("§27 O2/O3: 상한·halted 스키마 (하위호환)", () => {
  it("max_cost_usd/max_runtime_ms 미설정 시 undefined 다 (기존 STATE.json 하위호환 — 무제한)", () => {
    const s = baseState();
    expect(s.max_cost_usd).toBeUndefined();
    expect(s.max_runtime_ms).toBeUndefined();
  });
  it("halt_reason 미설정 시 null 로 기본값이 채워진다 (옛 STATE.json 도 그대로 로드)", () => {
    const s = baseState();
    expect(s.halt_reason).toBeNull();
  });
  it("status enum 이 halted 를 허용한다", () => {
    const s = { ...baseState(), status: "halted" as const };
    expect(() => StateSchema.parse(s)).not.toThrow();
  });
  it("max_cost_usd/max_runtime_ms/halt_reason 을 명시적으로 채울 수 있다", () => {
    const s = StateSchema.parse({
      ...baseState(), status: "halted", halt_reason: "operator",
      max_cost_usd: 10, max_runtime_ms: 3_600_000,
    });
    expect(s.max_cost_usd).toBe(10);
    expect(s.max_runtime_ms).toBe(3_600_000);
    expect(s.halt_reason).toBe("operator");
  });
  it("음수/0 max_cost_usd·max_runtime_ms 는 거부한다 (positive 제약)", () => {
    expect(() => StateSchema.parse({ ...baseState(), max_cost_usd: 0 })).toThrow();
    expect(() => StateSchema.parse({ ...baseState(), max_runtime_ms: -1 })).toThrow();
  });
});

describe("retryPhase", () => {
  it("failed phase 를 pending 으로 되돌리고 attempts 를 초기화한다", () => {
    const s = baseState();
    s.status = "failed";
    s.phases[0].status = "failed";
    s.phases[0].attempts = 2;
    retryPhase(s, 1);
    expect(s.phases[0].status).toBe("pending");
    expect(s.phases[0].attempts).toBe(0);
    expect(s.status).toBe("running"); // 전역 status 도 함께 복구
  });
  it("failed 가 아닌 phase 는 거부한다", () => {
    const s = baseState();
    expect(() => retryPhase(s, 1)).toThrow();
  });
  it("존재하지 않는 id 는 거부한다", () => {
    const s = baseState();
    expect(() => retryPhase(s, 999)).toThrow();
  });
});

describe("loadState/saveState", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-")); });
  it("라운드트립한다", () => {
    saveState(dir, baseState());
    expect(loadState(dir).workflow).toBe("test-wf");
  });
  it("스키마 불일치 파일은 로드 거부한다", () => {
    fs.writeFileSync(path.join(dir, "STATE.json"), JSON.stringify({ nope: true }));
    expect(() => loadState(dir)).toThrow();
  });
});

describe("loadState - 에러 메시지 (STATE.json 경로 포함)", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-load-")); });

  it("파일이 없으면 명확한 메시지로 throw", () => {
    expect(() => loadState(dir)).toThrow(/STATE\.json/);
  });
  it("JSON 파싱에 실패하면 명확한 메시지로 throw", () => {
    fs.writeFileSync(path.join(dir, "STATE.json"), "{ not valid json");
    expect(() => loadState(dir)).toThrow(/STATE\.json/);
  });
  it("스키마가 유효하지 않으면 명확한 메시지로 throw", () => {
    fs.writeFileSync(path.join(dir, "STATE.json"), JSON.stringify({ nope: true }));
    expect(() => loadState(dir)).toThrow(/STATE\.json/);
  });
});

describe("saveState - 사전 검증 + 원자적 쓰기", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-save-")); });

  it("불변식이 깨진 state 는 저장을 거부하고 기존 파일을 보존한다", () => {
    const good = baseState();
    saveState(dir, good);
    const before = fs.readFileSync(path.join(dir, "STATE.json"), "utf-8");

    const bad = { ...good, status: "banana" } as unknown as State;
    expect(() => saveState(dir, bad)).toThrow();

    const after = fs.readFileSync(path.join(dir, "STATE.json"), "utf-8");
    expect(after).toBe(before);
    expect(fs.existsSync(path.join(dir, "STATE.json.tmp"))).toBe(false);
  });

  it("정상 저장은 STATE.json 을 갱신하고 .tmp 파일을 남기지 않는다", () => {
    saveState(dir, baseState());
    expect(fs.existsSync(path.join(dir, "STATE.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "STATE.json.tmp"))).toBe(false);
  });
});

describe("next_steps (문서통합)", () => {
  it("phase 에 next_steps 를 허용한다", () => {
    const s = baseState();
    const withSteps = { ...s, phases: [{ ...s.phases[0], next_steps: ["a.kt 이동", "빌드 확인"] }, s.phases[1]] };
    expect(StateSchema.parse(withSteps).phases[0].next_steps).toEqual(["a.kt 이동", "빌드 확인"]);
  });
  it("next_steps 는 선택 필드이고 기본은 빈 배열이다", () => {
    expect(baseState().phases[0].next_steps).toEqual([]);
  });
  it("next_steps 가 문자열 배열이 아니면 거부한다", () => {
    const s = baseState();
    const bad = { ...s, phases: [{ ...s.phases[0], next_steps: [1, 2] }, s.phases[1]] };
    expect(() => StateSchema.parse(bad)).toThrow();
  });
});

describe("PR 모드 스키마 (v2)", () => {
  it("phase 에 pr 필드를 허용한다", () => {
    const s = baseState();
    const withPr = {
      ...s,
      phases: [
        {
          ...s.phases[0],
          pr: {
            number: 42,
            url: "https://git.example.com/o/r/pull/42",
            head_branch: "fw/phase-1",
            handled_comment_keys: ["issue:999"],
            fix_sessions: 0,
          },
        },
        s.phases[1],
      ],
    };
    const parsed = StateSchema.parse(withPr);
    expect(parsed.phases[0].pr?.number).toBe(42);
    expect(parsed.phases[0].pr?.handled_comment_keys).toEqual(["issue:999"]);
  });

  it("pr 은 선택 필드다 (없어도 파싱된다)", () => {
    expect(baseState().phases[0].pr).toBeUndefined();
  });

  it("pr 에 알 수 없는 키가 있으면 거부한다", () => {
    const s = baseState();
    const bad = {
      ...s,
      phases: [{ ...s.phases[0], pr: { number: 1, url: "u", head_branch: "b", extra: true } }, s.phases[1]],
    };
    expect(() => StateSchema.parse(bad)).toThrow();
  });

  it("phase status 에 in_review 를 허용한다", () => {
    const s = baseState();
    const inReview = { ...s, phases: [{ ...s.phases[0], status: "in_review" }, s.phases[1]] };
    expect(StateSchema.parse(inReview).phases[0].status).toBe("in_review");
  });

  it("전역 status 에 awaiting_merge 를 허용한다", () => {
    const s = baseState();
    expect(StateSchema.parse({ ...s, status: "awaiting_merge" }).status).toBe("awaiting_merge");
  });

  it("pr_mode / poll_interval_ms / base_branch 를 허용하고 기본값을 준다", () => {
    const s = baseState();
    expect(StateSchema.parse(s).pr_mode).toBe(false); // 기본 false — v1 하위호환
    const withPr = StateSchema.parse({ ...s, pr_mode: true, poll_interval_ms: 5000, base_branch: "develop" });
    expect(withPr.pr_mode).toBe(true);
    expect(withPr.poll_interval_ms).toBe(5000);
    expect(withPr.base_branch).toBe("develop");
  });

  it("in_review phase 는 selectNextPhase 재선택 대상이다 (폴링 재개)", () => {
    const s = baseState();
    s.phases[0].status = "in_review";
    expect(selectNextPhase(s)?.id).toBe(1);
  });

  it("assertRunnable: pr_mode 인데 allow_push 가 false 면 거부한다", () => {
    const s = StateSchema.parse({ ...baseState(), pr_mode: true, allow_push: false });
    expect(() => assertRunnable(s)).toThrow(/allow_push/);
  });

  it("assertRunnable: pr_mode + allow_push 면 통과한다 (trusted_comment_authors 도 채워야 함)", () => {
    // §26 I6: pr_mode 는 이제 trusted_comment_authors 도 요구한다 — allow_push 만으로는
    // 통과하지 않는다 (아래 새 테스트가 그 거부를 못박는다).
    const s = StateSchema.parse({
      ...baseState(), pr_mode: true, allow_push: true, trusted_comment_authors: ["alice"],
    });
    expect(() => assertRunnable(s)).not.toThrow();
  });

  // §26 I6: pr_mode:true + trusted_comment_authors:[] 는 fail-closed 로 "아무 코멘트도 처리
  // 안 함" 자체는 옳지만, 그 상태를 아무도 알려주지 않아 사용자가 PR 을 만들고 `@fw` 를 달고
  // 밤새 아무 일도 안 일어나는 걸 다음날 아침에야 발견했다(실측). 조용히 무력화되느니 시작 전에
  // 명확히 거부하는 편이 무인 실행에서 안전하다 — pr_mode → allow_push 를 이미 강제하는 바로
  // 그 자리(위 두 테스트)와 같은 패턴이다.
  it("assertRunnable: pr_mode 인데 trusted_comment_authors 가 비어 있으면 거부한다 (§26 I6)", () => {
    const s = StateSchema.parse({
      ...baseState(), pr_mode: true, allow_push: true, trusted_comment_authors: [],
    });
    expect(() => assertRunnable(s)).toThrow(/trusted_comment_authors/);
  });

  it("assertRunnable: pr_mode + trusted_comment_authors 거부 메시지에 해결 방법이 담겨 있다 (§26 I6)", () => {
    const s = StateSchema.parse({
      ...baseState(), pr_mode: true, allow_push: true, trusted_comment_authors: [],
    });
    expect(() => assertRunnable(s)).toThrow(/trusted_comment_authors:\s*\[/);
  });

  // §29 MI-10: pr_mode:true + trusted_comment_authors:[] 는 여전히 거부해야 하지만(D14 유지),
  // "PR 만 만들고 코멘트 처리는 원치 않는다"는 정당한 사용에는 pr_comment_mode: "off" 로
  // 명시적 옵트아웃이 가능해야 한다. 실측: 리포에 커밋된 docs/pr-smoke/STATE.json 처럼
  // trusted_comment_authors 를 채울 계획이 없는 워크플로우가 fw doctor 로도 벗어날 수 없었다.
  it("assertRunnable: pr_comment_mode 기본값('trusted')은 §26 I6 거부를 그대로 유지한다", () => {
    const s = StateSchema.parse({
      ...baseState(), pr_mode: true, allow_push: true, trusted_comment_authors: [],
    });
    expect(s.pr_comment_mode).toBeUndefined(); // .optional() — 명시 안 하면 undefined
    expect(() => assertRunnable(s)).toThrow(/trusted_comment_authors/);
  });

  it("assertRunnable: pr_comment_mode: 'trusted' 를 명시해도 빈 authors 는 거부한다 (D14 유지)", () => {
    const s = StateSchema.parse({
      ...baseState(), pr_mode: true, allow_push: true, trusted_comment_authors: [],
      pr_comment_mode: "trusted",
    });
    expect(() => assertRunnable(s)).toThrow(/trusted_comment_authors/);
  });

  it("assertRunnable: 거부 메시지에 두 갈래 해결책이 모두 담겨 있다 (trusted 채우기 / off 옵트아웃)", () => {
    const s = StateSchema.parse({
      ...baseState(), pr_mode: true, allow_push: true, trusted_comment_authors: [],
    });
    try {
      assertRunnable(s);
      throw new Error("assertRunnable 이 throw 하지 않았습니다");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/trusted_comment_authors:\s*\[/);
      expect(msg).toMatch(/pr_comment_mode:\s*"off"/);
    }
  });

  it("assertRunnable: pr_comment_mode: 'off' 면 trusted_comment_authors 가 비어도 통과한다 (명시적 옵트아웃)", () => {
    const s = StateSchema.parse({
      ...baseState(), pr_mode: true, allow_push: true, trusted_comment_authors: [],
      pr_comment_mode: "off",
    });
    expect(() => assertRunnable(s)).not.toThrow();
  });

  it("pr_comment_mode 는 'trusted'/'off' 이외의 값을 거부한다", () => {
    expect(() =>
      StateSchema.parse({ ...baseState(), pr_comment_mode: "ignore" }),
    ).toThrow();
  });
});

describe("§24 감사 T1: trusted_comment_authors 스키마", () => {
  it("기본값은 빈 배열이다 (fail-closed — 명시적으로 채우기 전엔 아무도 신뢰하지 않음)", () => {
    expect(baseState().trusted_comment_authors).toEqual([]);
  });
  it("로그인 목록을 저장할 수 있다", () => {
    const s = StateSchema.parse({ ...baseState(), trusted_comment_authors: ["alice", "bob"] });
    expect(s.trusted_comment_authors).toEqual(["alice", "bob"]);
  });
  it("문자열 배열이 아니면 거부한다", () => {
    expect(() => StateSchema.parse({ ...baseState(), trusted_comment_authors: [1, 2] })).toThrow();
  });

  // §26 I6: trim 부재로 "alice " 같은 오타가 조용히 fail-closed 로 굳는 문제(실측)를 막는다.
  it("§26 I6: 각 로그인의 앞뒤 공백을 trim 한다 (오타로 인한 무음 fail-closed 방지)", () => {
    const s = StateSchema.parse({ ...baseState(), trusted_comment_authors: ["alice ", " bob\t"] });
    expect(s.trusted_comment_authors).toEqual(["alice", "bob"]);
  });

  it("§26 I6: trim 후 빈 문자열이 되면 걸러낸다", () => {
    const s = StateSchema.parse({ ...baseState(), trusted_comment_authors: ["alice", "   ", ""] });
    expect(s.trusted_comment_authors).toEqual(["alice"]);
  });
});

describe("§26 M3: workflow 이름은 git ref(fw/<workflow> 브랜치)로 안전해야 한다", () => {
  it("기존 테스트에서 쓰는 흔한 이름들은 그대로 통과한다 (회귀 방지)", () => {
    for (const name of ["test-wf", "wf", "pr-smoke", "e2e", "e2e-pr", "w", "wf1"]) {
      expect(StateSchema.parse({ ...baseState(), workflow: name }).workflow).toBe(name);
    }
  });

  it("공백이 있으면 거부한다 (실측: `fw/my feature #1` 이 git 에서 fatal)", () => {
    expect(() => StateSchema.parse({ ...baseState(), workflow: "my feature #1" })).toThrow();
  });

  it("git 메타문자(~^:?*[\\)를 거부한다", () => {
    for (const bad of ["a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b"]) {
      expect(() => StateSchema.parse({ ...baseState(), workflow: bad })).toThrow();
    }
  });

  it("연속된 `..` 을 거부한다", () => {
    expect(() => StateSchema.parse({ ...baseState(), workflow: "a..b" })).toThrow();
  });

  it("선행/후행 `.` 을 거부한다 (git check-ref-format 이 명시적으로 거부)", () => {
    for (const bad of [".wf", "wf."]) {
      expect(() => StateSchema.parse({ ...baseState(), workflow: bad })).toThrow();
    }
  });

  // §29 Minor 1: 기존 화이트리스트는 선행/후행 "-" 도 거부했는데, git 은 이를 허용한다
  // (`git check-ref-format --branch 'wf-'` 통과, `refs/heads/fw/-wf` 도 통과·checkout 성공
  // 실측 — `-wf` 단독은 `git check-ref-format --branch` 전용 옵션 오인 방지 규칙으로만 거부되고,
  // workflow 는 항상 `fw/<workflow>` 의 두 번째 세그먼트로만 쓰이므로 안전하다). 과잉 제약을
  // 완화한다.
  it("선행/후행 `-` 는 이제 허용한다 (git 이 허용 — 과잉 제약 완화)", () => {
    for (const ok of ["-wf", "wf-"]) {
      expect(StateSchema.parse({ ...baseState(), workflow: ok }).workflow).toBe(ok);
    }
  });

  // §29 Minor 1 핵심 회귀: 한국어 우선 프로젝트에서 한글 workflow 이름이 과잉 제약으로
  // 거부됐다(실측: git 은 허용하는데 fw 는 거부). 화이트리스트 → 블랙리스트 전환의 목적.
  it("유니코드(한글) workflow 이름을 허용한다 (git 도 허용 — 실측 확인됨)", () => {
    expect(StateSchema.parse({ ...baseState(), workflow: "한글피처" }).workflow).toBe("한글피처");
  });

  it("예약어 'HEAD' 는 거부한다 (git check-ref-format 이 명시적으로 거부)", () => {
    expect(() => StateSchema.parse({ ...baseState(), workflow: "HEAD" })).toThrow();
  });

  it("대소문자가 섞인 'head'/'Head' 는 git 도 허용하므로 통과한다", () => {
    expect(StateSchema.parse({ ...baseState(), workflow: "head" }).workflow).toBe("head");
    expect(StateSchema.parse({ ...baseState(), workflow: "Head" }).workflow).toBe("Head");
  });

  it("단독 '@' 는 거부한다 (git 에서 HEAD 의 별칭)", () => {
    expect(() => StateSchema.parse({ ...baseState(), workflow: "@" })).toThrow();
  });

  it("'@{' 를 포함하면 거부한다 (git 의 reflog/upstream 표기와 충돌)", () => {
    expect(() => StateSchema.parse({ ...baseState(), workflow: "a@{b" })).toThrow();
  });

  it("후행 '.lock' 은 거부한다 (git 의 lockfile 관례와 충돌)", () => {
    expect(() => StateSchema.parse({ ...baseState(), workflow: "wf.lock" })).toThrow();
  });

  it("`/` 를 포함하면 거부한다 (브랜치 계층 오조작 방지 — fw 고유 제약, git 자체는 허용)", () => {
    expect(() => StateSchema.parse({ ...baseState(), workflow: "a/b" })).toThrow();
  });

  it("빈 문자열은 거부한다", () => {
    expect(() => StateSchema.parse({ ...baseState(), workflow: "" })).toThrow();
  });
});

describe("§24 감사 S1: phase.allow_verify_file_changes / verify_file_changes_bypassed_at 스키마", () => {
  it("allow_verify_file_changes 기본값은 false 다", () => {
    expect(baseState().phases[0].allow_verify_file_changes).toBe(false);
  });
  it("true 로 설정할 수 있다", () => {
    const s = baseState();
    const withOptOut = { ...s, phases: [{ ...s.phases[0], allow_verify_file_changes: true }, s.phases[1]] };
    expect(StateSchema.parse(withOptOut).phases[0].allow_verify_file_changes).toBe(true);
  });
  it("verify_file_changes_bypassed_at 은 선택적 문자열 필드다 (기본 undefined)", () => {
    expect(baseState().phases[0].verify_file_changes_bypassed_at).toBeUndefined();
    const s = baseState();
    const withTimestamp = {
      ...s,
      phases: [{ ...s.phases[0], verify_file_changes_bypassed_at: "2026-08-27T00:00:00Z" }, s.phases[1]],
    };
    expect(StateSchema.parse(withTimestamp).phases[0].verify_file_changes_bypassed_at).toBe("2026-08-27T00:00:00Z");
  });

  it("verify_guard_baseline_sha 는 선택적 문자열 필드다 (기본 undefined, attempt 간 위조 세탁 방지용 기준점)", () => {
    expect(baseState().phases[0].verify_guard_baseline_sha).toBeUndefined();
    const s = baseState();
    const withBaseline = {
      ...s,
      phases: [{ ...s.phases[0], verify_guard_baseline_sha: "c0" }, s.phases[1]],
    };
    expect(StateSchema.parse(withBaseline).phases[0].verify_guard_baseline_sha).toBe("c0");
  });

  it("retryPhase 는 verify_guard_baseline_sha 를 초기화한다 (새 런은 새 기준점)", () => {
    const s = baseState();
    s.status = "failed";
    s.phases[0].status = "failed";
    s.phases[0].verify_guard_baseline_sha = "stale-sha";
    retryPhase(s, 1);
    expect(s.phases[0].verify_guard_baseline_sha).toBeUndefined();
  });
});

describe("§19: branch_strategy — 죽은 필드를 enum 으로 좁히되 하위호환 유지", () => {
  it("생략하면 기본값 isolate 다", () => {
    const { branch_strategy: _omit, ...rest } = baseState();
    expect(StateSchema.parse(rest).branch_strategy).toBe("isolate");
  });
  it("isolate/current/require-topic 을 그대로 허용한다", () => {
    expect(StateSchema.parse({ ...baseState(), branch_strategy: "isolate" }).branch_strategy).toBe("isolate");
    expect(StateSchema.parse({ ...baseState(), branch_strategy: "current" }).branch_strategy).toBe("current");
    expect(StateSchema.parse({ ...baseState(), branch_strategy: "require-topic" }).branch_strategy).toBe(
      "require-topic",
    );
  });
  it("하위호환: 기존 STATE.json 의 'topic' 을 'isolate' 의 별칭으로 받아들인다", () => {
    const s = StateSchema.parse({ ...baseState(), branch_strategy: "topic" });
    expect(s.branch_strategy).toBe("isolate");
  });
  it("알 수 없는 값은 거부한다 (fail-closed)", () => {
    expect(() => StateSchema.parse({ ...baseState(), branch_strategy: "yolo" })).toThrow();
  });
});

describe("§19: 기존 STATE.json 산출물이 여전히 로드된다 (회귀)", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-compat-")); });

  // §36 §30 P4 후속 — docs/harness-module-tests/STATE.json 이 실제로 이 모양이다: phase 1 이
  // 3번 attempt 했고 세 세션 모두 result:"done" 이지만 verdict 필드는 없다(§36 감사가 실측한
  // 바로 그 결함 — 게이트가 attempt 1·2 를 회송했는데 STATE 에는 흔적이 없다). 이 필드 추가가
  // 그 워크플로우를 로드조차 못 하게 만들면 안 된다.
  it("verdict 없는 sessions[](§36 이전 완주 기록)를 그대로 로드한다", () => {
    const shaped = {
      ...JSON.parse(JSON.stringify({
        schema_version: 1, workflow: "harness-module-tests", repo_root: "/tmp/repo",
        branch_strategy: "isolate", allow_push: true, verify_default: ["npm test"],
        status: "done", pending_question: null, answers: [],
      })),
      phases: [
        {
          id: 1, title: "Phase 1", status: "done", depends_on: [], verify: [],
          attempts: 3, max_attempts: 5,
          sessions: [
            { session_id: "s1", result: "done", at: "2026-08-27T00:00:00Z", kind: "phase" },
            { session_id: "s2", result: "done", at: "2026-08-27T01:00:00Z", kind: "phase" },
            { session_id: "s3", result: "done", at: "2026-08-27T02:00:00Z", kind: "phase" },
          ],
        },
      ],
    };
    fs.writeFileSync(path.join(dir, "STATE.json"), JSON.stringify(shaped, null, 2));
    const loaded = loadState(dir);
    expect(loaded.phases[0].sessions).toHaveLength(3);
    for (const s of loaded.phases[0].sessions) expect(s.verdict).toBeUndefined();
  });

  it("docs/pr-smoke/STATE.json 형태(branch_strategy:'topic', pr 필드 포함)를 그대로 로드한다", () => {
    const prSmokeShaped = {
      schema_version: 1,
      workflow: "pr-smoke",
      repo_root: "/tmp/repo",
      branch_strategy: "topic",
      allow_push: true,
      verify_default: ["grep -q '^- 2026' docs/pr-smoke/SMOKE.md"],
      verify_timeout_ms: null,
      pr_mode: true,
      poll_interval_ms: 20000,
      base_branch: "main",
      max_fix_sessions: 5,
      status: "running",
      pending_question: null,
      answers: [],
      phases: [
        {
          id: 1,
          title: "SMOKE.md 에 로그 한 줄 추가",
          status: "pending",
          depends_on: [],
          verify: [],
          attempts: 0,
          max_attempts: 2,
          last_log: "/tmp/x.log",
          pr: {
            number: 1,
            url: "https://git.example.com/o/r/pull/1",
            head_branch: "fw/phase-1",
            handled_comment_keys: ["review:5724417"],
            fix_sessions: 2,
          },
          sessions: [],
        },
      ],
    };
    fs.writeFileSync(path.join(dir, "STATE.json"), JSON.stringify(prSmokeShaped, null, 2));
    const loaded = loadState(dir);
    expect(loaded.branch_strategy).toBe("isolate");
    expect(loaded.phases[0].pr?.number).toBe(1);
  });

  // §29 Minor 2: 배포된 templates/STATE.json 이 `{{ ... }}` 플레이스홀더를 안 채운 채 그대로면
  // (또는 옛 템플릿을 복사해 일부만 채우면) loadState 가 zod 원문 대신 "어떤 필드가 미치환인지"를
  // 알려주는 친절한 메시지로 throw 해야 한다.
  it("미치환 `{{ }}` 플레이스홀더가 있으면 zod 오류 대신 친절한 메시지로 throw 한다", () => {
    const withPlaceholder = {
      schema_version: 1,
      workflow: "{{ workflow-name }}",
      repo_root: "/tmp/repo",
      status: "running",
      pending_question: null,
      answers: [],
      phases: [],
    };
    fs.writeFileSync(path.join(dir, "STATE.json"), JSON.stringify(withPlaceholder, null, 2));
    expect(() => loadState(dir)).toThrow(/플레이스홀더/);
    expect(() => loadState(dir)).toThrow(/workflow/);
  });

  it("중첩 필드(verify_default[0])의 미치환 플레이스홀더도 경로와 함께 잡아낸다", () => {
    const withPlaceholder = {
      schema_version: 1,
      workflow: "wf",
      repo_root: "/tmp/repo",
      verify_default: ["{{ 예: ./gradlew build }}"],
      status: "running",
      pending_question: null,
      answers: [],
      phases: [],
    };
    fs.writeFileSync(path.join(dir, "STATE.json"), JSON.stringify(withPlaceholder, null, 2));
    expect(() => loadState(dir)).toThrow(/verify_default/);
  });

  it("실제 배포된 templates/STATE.json 을 loadState 로 로드할 수 있다 (미치환 플레이스홀더 없음)", () => {
    const testDir = path.dirname(fileURLToPath(import.meta.url));
    const templatePath = path.join(testDir, "..", "..", "templates", "STATE.json");
    const templateRaw = fs.readFileSync(templatePath, "utf-8");
    fs.writeFileSync(path.join(dir, "STATE.json"), templateRaw);
    const loaded = loadState(dir);
    expect(loaded.workflow).toBe("REPLACE-ME");
    expect(loaded.pr_comment_mode).toBe("trusted");
  });

  it("templates/STATE.json 스켈레톤 형태(branch_strategy:'isolate', phases 비어있지 않음)를 로드한다", () => {
    const templateShaped = {
      schema_version: 1,
      workflow: "wf",
      repo_root: "/tmp/repo",
      branch_strategy: "isolate",
      allow_push: false,
      verify_default: ["true"],
      verify_timeout_ms: null,
      pr_mode: false,
      poll_interval_ms: 60000,
      base_branch: "main",
      max_fix_sessions: 10,
      trusted_comment_authors: [],
      status: "running",
      pending_question: null,
      answers: [],
      phases: [
        { id: 1, title: "p1", status: "pending", depends_on: [], verify: [], attempts: 0, max_attempts: 2, sessions: [], next_steps: [] },
      ],
    };
    fs.writeFileSync(path.join(dir, "STATE.json"), JSON.stringify(templateShaped, null, 2));
    const loaded = loadState(dir);
    expect(loaded.branch_strategy).toBe("isolate");
  });

  // §32 남은 부채/§30 P3: allow_untracked_logs 는 새 필드다 — 기존 STATE.json(이 필드가 없는)
  // 을 로드해도 깨지지 않아야 한다(하위호환). `.optional()`(`.default()` 아님)을 쓴 이유는
  // cli.ts 의 initState skeleton 리터럴을 깨지 않기 위해서다(state.ts 주석 참조).
  it("allow_untracked_logs 가 없는 기존 STATE.json 을 로드하면 undefined 다 (하위호환)", () => {
    const templateShaped = {
      schema_version: 1,
      workflow: "wf",
      repo_root: "/tmp/repo",
      branch_strategy: "isolate",
      allow_push: false,
      verify_default: ["true"],
      verify_timeout_ms: null,
      pr_mode: false,
      poll_interval_ms: 60000,
      base_branch: "main",
      max_fix_sessions: 10,
      trusted_comment_authors: [],
      status: "running",
      pending_question: null,
      answers: [],
      phases: [
        { id: 1, title: "p1", status: "pending", depends_on: [], verify: [], attempts: 0, max_attempts: 2, sessions: [], next_steps: [] },
      ],
    };
    fs.writeFileSync(path.join(dir, "STATE.json"), JSON.stringify(templateShaped, null, 2));
    const loaded = loadState(dir);
    expect(loaded.allow_untracked_logs).toBeUndefined();
  });

  it("allow_untracked_logs: true 를 명시하면 그대로 보존된다", () => {
    const s = StateSchema.parse({ ...baseState(), allow_untracked_logs: true });
    expect(s.allow_untracked_logs).toBe(true);
  });
});

// §32 남은 부채/§30 P3 — 감사자 권고: "최종 방어로는 `fw run` 시작 시 docs/<wf>/logs/ 를
// .gitignore 에 넣는지 검사하는 편이 정규식 경쟁보다 확실하다." §27 O1 감사 로그(DENY 명령
// 전문)는 §32 I-1 마스킹 재설계 이후에도 33% 는 의도적으로 마스킹하지 않으므로, 그 로그가
// 대상 리포에 커밋될 수 없게 만드는 것이 확실한 방어다.
describe("checkRunLogsIgnored (§32 남은 부채/§30 P3)", () => {
  it("runLogsDir 은 workflowDir 밑의 logs/ 를 가리킨다 (workflow 이름에서 역산하지 않는다)", () => {
    expect(runLogsDir("/repo/docs/wf")).toBe(path.join("/repo/docs/wf", "logs"));
    expect(runLogsDir("/anywhere/else")).toBe(path.join("/anywhere/else", "logs"));
  });

  it("exitCode:0 이면 ignored 다", async () => {
    const git: RunLogsGitCheckIgnoreExec = async () => ({ exitCode: 0, stderr: "" });
    const result = await checkRunLogsIgnored(git, "/repo", "/repo/docs/wf");
    expect(result).toEqual({ status: "ignored", relLogsDir: "docs/wf/logs/" });
  });

  it("exitCode:1 이면 not-ignored 다 (진짜 문제)", async () => {
    const git: RunLogsGitCheckIgnoreExec = async () => ({ exitCode: 1, stderr: "" });
    const result = await checkRunLogsIgnored(git, "/repo", "/repo/docs/wf");
    expect(result).toEqual({ status: "not-ignored", relLogsDir: "docs/wf/logs/" });
  });

  // §30 P2: 저장소가 아니거나(git exit 128) 판정 자체가 실패하면 예외 없이 degrade 한다 —
  // "진짜 not-ignored" 로 오판해 문제 삼지 않는다.
  it("exitCode:128(저장소 아님)이면 unknown 으로 degrade 한다", async () => {
    const git: RunLogsGitCheckIgnoreExec = async () => ({ exitCode: 128, stderr: "fatal: not a git repository" });
    const result = await checkRunLogsIgnored(git, "/repo", "/repo/docs/wf");
    expect(result.status).toBe("unknown");
  });

  it("exitCode:null(spawn 자체 실패, 예: git 미설치)이면 unknown 으로 degrade 한다", async () => {
    const git: RunLogsGitCheckIgnoreExec = async () => ({ exitCode: null, stderr: "spawn git ENOENT" });
    const result = await checkRunLogsIgnored(git, "/repo", "/repo/docs/wf");
    expect(result.status).toBe("unknown");
  });

  it("git 실행기가 reject 해도 예외를 던지지 않고 unknown 으로 degrade 한다", async () => {
    const git: RunLogsGitCheckIgnoreExec = async () => {
      throw new Error("boom");
    };
    const result = await checkRunLogsIgnored(git, "/repo", "/repo/docs/wf");
    expect(result.status).toBe("unknown");
  });

  // §30 P2 정상 경로: workflowDir(따라서 logs/ 도)이 repo_root 밖이면 그 리포에 커밋될 길이
  // 없으므로 검사 자체가 불필요하다 — git 을 호출하지 않아야 한다.
  it("workflowDir 이 repo_root 밖이면 outside-repo 를 반환하고 git 을 호출하지 않는다", async () => {
    let called = false;
    const git: RunLogsGitCheckIgnoreExec = async () => {
      called = true;
      return { exitCode: 0, stderr: "" };
    };
    const result = await checkRunLogsIgnored(git, "/repo", "/other/place");
    expect(result).toEqual({ status: "outside-repo", relLogsDir: null });
    expect(called).toBe(false);
  });

  // 경계 테스트: workflowDir === repoRoot 인 흔한 경우(레거시 워크플로우가 리포 루트에
  // STATE.json 을 둔 경우)는 outside-repo 가 아니라 정상적으로 "<repoRoot>/logs" 를 검사한다.
  it("workflowDir 이 repo_root 자신이면(경계값) <repo_root>/logs 를 정상적으로 검사한다", async () => {
    const git: RunLogsGitCheckIgnoreExec = async (args) => {
      expect(args).toContain("logs/");
      return { exitCode: 0, stderr: "" };
    };
    const result = await checkRunLogsIgnored(git, "/repo", "/repo");
    expect(result).toEqual({ status: "ignored", relLogsDir: "logs/" });
  });

  it("git 실행기에 넘기는 경로는 항상 후행 슬래시를 붙인다 (디렉토리 전용 패턴 매칭용)", async () => {
    // §36 I-1/I-2: exitCode:0 을 항상 돌려주면 디렉토리 질의(패턴 매칭)가 즉시 ignored 로
    // 끝나 대표 파일 재질의(fallback)는 건너뛰고, 곧바로 ls-files(추적 여부) 질의로 넘어간다 —
    // 그래서 정확히 두 번 호출된다.
    const receivedCalls: string[][] = [];
    const git: RunLogsGitCheckIgnoreExec = async args => {
      receivedCalls.push(args);
      return { exitCode: 0, stderr: "" };
    };
    await checkRunLogsIgnored(git, "/repo", "/repo/docs/wf");
    expect(receivedCalls).toEqual([
      ["check-ignore", "-q", "--no-index", "docs/wf/logs/"],
      ["ls-files", "--", "docs/wf/logs/"],
    ]);
  });

  // 실제 git 프로세스 종단 검증 — DI 스텁만으로는 실제 git 의 exit code 계약을 놓칠 수 있다.
  describe("실제 git 저장소로 검증 (defaultRunLogsGitCheckIgnoreExec)", () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-checkignore-"));
      execFileSync("git", ["init", "-q"], { cwd: dir });
    });

    it("존재하지 않는 경로도 .gitignore 패턴만으로 판정한다 (파일시스템에 없어도 됨)", async () => {
      fs.writeFileSync(path.join(dir, ".gitignore"), "docs/*/logs/\n");
      const result = await checkRunLogsIgnored(defaultRunLogsGitCheckIgnoreExec, dir, path.join(dir, "docs", "pr-smoke"));
      expect(result.status).toBe("ignored"); // docs/pr-smoke/logs 는 디스크에 존재하지 않는다
    });

    it(".gitignore 가 없으면 not-ignored 다", async () => {
      const result = await checkRunLogsIgnored(defaultRunLogsGitCheckIgnoreExec, dir, path.join(dir, "docs", "pr-smoke"));
      expect(result.status).toBe("not-ignored");
    });

    // 디렉토리 전용 glob 패턴은 후행 슬래시가 있어야만 존재하지 않는 "디렉토리 자체" 경로를
    // 매칭한다는 실측(원래 회귀 테스트 의도). §36 I-1 이후에는 그 디렉토리 질의가 실패해도
    // 대표 파일 경로(`.../logs/run-x.log` 등, 파일 경로라 애초에 이 트레일링슬래시 문제와
    // 무관하다)로 재질의해 여전히 ignored 로 판정한다 — 이 어댑터(모든 인자의 trailing "/" 를
    // 벗김)는 디렉토리 질의만 아니라 대표 파일 경로 뒤에 붙는 구분자 역할의 "/" 도 건드리지
    // 않는다(파일 경로는애초에 "/" 로 안 끝나므로). 즉 이 테스트는 이제 "디렉토리 질의 실패에도
    // 불구하고 대표 파일 재질의가 방어를 지킨다"는 §36 I-1 의 견고성을 증명하는 테스트가 됐다 —
    // 실제 프로덕션 코드(checkRunLogsIgnored)는 이 어댑터 없이 항상 후행 슬래시를 그대로 넘긴다.
    it("디렉토리 질의에서 후행 슬래시가 벗겨져도 대표 파일 재질의가 보완해 ignored 로 판정한다 (§36 I-1)", async () => {
      fs.writeFileSync(path.join(dir, ".gitignore"), "docs/*/logs/\n");
      const withoutSlash = await checkRunLogsIgnored(
        async (args, cwd) => {
          const stripped = args.map(a => (a.endsWith("/") ? a.slice(0, -1) : a));
          return defaultRunLogsGitCheckIgnoreExec(stripped, cwd);
        },
        dir,
        path.join(dir, "docs", "pr-smoke"),
      );
      expect(withoutSlash.status).toBe("ignored");
    });

    it("저장소가 아닌 디렉토리에서는 unknown 으로 degrade 한다 (예외 없음)", async () => {
      const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "fw-checkignore-notrepo-"));
      const result = await checkRunLogsIgnored(defaultRunLogsGitCheckIgnoreExec, notARepo, path.join(notARepo, "docs", "wf"));
      expect(result.status).toBe("unknown");
    });

    // §36 I-1 — logs/ 에 실제로 쌓이는 파일은 전부 `*.log`(run-<ts>.log, phase-N-attempt-M.log,
    // runlog.ts/orchestrator.ts 참조)다. `*.log` 만 있는 .gitignore(Node/GitHub 기본 템플릿 항목,
    // 이 리포 루트 .gitignore 에도 있다)는 실제로는 완전히 보호되는데, 디렉토리 자체를 질의하면
    // 매칭되지 않아 오탐 차단이 났다(§30 P2 자충수). 대표 파일명 재질의로 고친다.
    it("*.log 만 있는 .gitignore 는 디렉토리 질의로는 안 잡히지만 실제로는 완전 보호되므로 ignored 다 (§36 I-1)", async () => {
      fs.writeFileSync(path.join(dir, ".gitignore"), "*.log\n");
      // 디렉토리 자체 질의는 매칭되지 않는다는 전제를 먼저 확인해둔다(오탐의 근본 원인).
      fs.mkdirSync(path.join(dir, "docs", "pr-smoke", "logs"), { recursive: true });
      const dirOnlyCheck = await defaultRunLogsGitCheckIgnoreExec(
        ["check-ignore", "-q", "--no-index", "docs/pr-smoke/logs/"],
        dir,
      );
      expect(dirOnlyCheck.exitCode).toBe(1); // not-ignored — 디렉토리 자체는 *.log 에 안 걸린다

      const result = await checkRunLogsIgnored(defaultRunLogsGitCheckIgnoreExec, dir, path.join(dir, "docs", "pr-smoke"));
      expect(result.status).toBe("ignored");
    });

    // §36 I-2 — `git check-ignore`(index 인지)는 이미 추적 중인 경로를 패턴이 맞아도
    // not-ignored 로 답한다(§33 이전에 fw 를 돌려 로그가 이미 커밋된 리포가 정확히 이 상태).
    // 안내가 "이미 있는 줄을 추가하라"면 탈출구가 안 된다(§26 I5 재발) — alreadyTrackedInIndex
    // 로 구분해 `git rm -r --cached` 를 안내해야 한다.
    it("패턴은 맞지만 과거에 이미 커밋된 로그가 tracked 로 남아있으면 not-ignored + alreadyTrackedInIndex:true 다 (§36 I-2)", async () => {
      execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
      fs.mkdirSync(path.join(dir, "docs", "wf", "logs"), { recursive: true });
      fs.writeFileSync(path.join(dir, "docs", "wf", "logs", "run-1.log"), "old log, committed before .gitignore existed");
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "init (§33 이전 — 로그가 실수로 커밋됨)"], { cwd: dir });
      // 뒤늦게 올바른 패턴을 추가한다 — 그래도 이미 추적 중인 run-1.log 는 이 패턴만으로는 안 풀린다.
      fs.writeFileSync(path.join(dir, ".gitignore"), "docs/*/logs/\n");
      execFileSync("git", ["add", ".gitignore"], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "gitignore 추가"], { cwd: dir });

      const result = await checkRunLogsIgnored(defaultRunLogsGitCheckIgnoreExec, dir, path.join(dir, "docs", "wf"));
      expect(result.status).toBe("not-ignored");
      expect(result.alreadyTrackedInIndex).toBe(true);

      const reason = runLogsNotIgnoredReason(result.relLogsDir!, { alreadyTrackedInIndex: result.alreadyTrackedInIndex });
      expect(reason).toContain("git rm -r --cached docs/wf/logs");
      // §26 I5 재발 방지: "줄을 추가하라"는, 이미 있는 이 상황에서는 틀린 안내이므로 나오면 안 된다.
      expect(reason).not.toContain("다음 줄을 추가하세요");

      // 감사자 실측 재현: 안내대로 git rm --cached 를 실행하면 실제로 탈출구가 작동한다.
      execFileSync("git", ["rm", "-r", "--cached", "docs/wf/logs"], { cwd: dir });
      const afterFix = await checkRunLogsIgnored(defaultRunLogsGitCheckIgnoreExec, dir, path.join(dir, "docs", "wf"));
      expect(afterFix.status).toBe("ignored");
    });
  });
});

describe("checkRunLogsIgnored — §36 C-3: symlink 경유에서도 realpath 후보로 repo 내부를 정확히 판정한다", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-checkignore-symlink-"));
  });

  // 실측 재현(감사자 원 보고): repo_root 는 실경로, workflowDir 은 symlink 를 경유한 경로.
  // §36 C-3 이전에는 문자열 path.relative 순수 비교만 해서 "outside-repo" 로 오판했다 —
  // 그러면 로그 보호가 조용히 꺼지고 doctor 는 "OK — repo_root 밖" 이라는 거짓 문장을 냈다.
  it("repo_root=실경로 / workflowDir=symlink 경유 — outside-repo 로 오판하지 않는다(양방향 중 1)", async () => {
    const realDir = fs.realpathSync(dir);
    execFileSync("git", ["init", "-q"], { cwd: realDir });
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: realDir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: realDir });
    fs.writeFileSync(path.join(realDir, "a.txt"), "1");
    execFileSync("git", ["add", "."], { cwd: realDir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: realDir });
    // .gitignore 는 나중에(실제 fw 첫 실행처럼) — 여기서는 보호 여부와 무관하게 "outside-repo"
    // 로 잘못 판정되지 않는 것 자체가 핵심이므로, 패턴 없이(=not-ignored 기대) 검증한다.

    const symlinkDir = path.join(os.tmpdir(), `fw-checkignore-link-${process.pid}-${Date.now()}`);
    fs.symlinkSync(realDir, symlinkDir);
    try {
      const workflowDirViaSymlink = path.join(symlinkDir, "docs", "wf1");
      fs.mkdirSync(workflowDirViaSymlink, { recursive: true });

      const result = await checkRunLogsIgnored(defaultRunLogsGitCheckIgnoreExec, realDir, workflowDirViaSymlink);
      // 핵심 단언: outside-repo 가 아니다(고쳐지기 전에는 여기서 outside-repo 가 나왔다).
      expect(result.status).not.toBe("outside-repo");
      expect(result.status).toBe("not-ignored"); // .gitignore 가 없으므로 실제로 보호되지 않는다 — 정확한 판정
      expect(result.relLogsDir).toBe("docs/wf1/logs/");
    } finally {
      fs.unlinkSync(symlinkDir);
    }
  });

  // 반대 방향: repo_root 자체가 symlink, workflowDir 은 실경로.
  it("repo_root=symlink 경유 / workflowDir=실경로 — outside-repo 로 오판하지 않는다(양방향 중 2)", async () => {
    const realDir = fs.realpathSync(dir);
    execFileSync("git", ["init", "-q"], { cwd: realDir });
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: realDir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: realDir });
    fs.writeFileSync(path.join(realDir, ".gitignore"), "docs/*/logs/\n");
    fs.writeFileSync(path.join(realDir, "a.txt"), "1");
    execFileSync("git", ["add", "."], { cwd: realDir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: realDir });

    const workflowDir = path.join(realDir, "docs", "wf1");
    fs.mkdirSync(workflowDir, { recursive: true });

    const symlinkRepoRoot = path.join(os.tmpdir(), `fw-checkignore-reposym-${process.pid}-${Date.now()}`);
    fs.symlinkSync(realDir, symlinkRepoRoot);
    try {
      const result = await checkRunLogsIgnored(defaultRunLogsGitCheckIgnoreExec, symlinkRepoRoot, workflowDir);
      expect(result.status).not.toBe("outside-repo");
      expect(result.status).toBe("ignored"); // .gitignore 가 있으므로 실제로 보호됨 — 정확한 판정
    } finally {
      fs.unlinkSync(symlinkRepoRoot);
    }
  });

  it("진짜로 repo_root 밖인 workflowDir 은 여전히 outside-repo 다 (회귀 방지)", async () => {
    const realDir = fs.realpathSync(dir);
    execFileSync("git", ["init", "-q"], { cwd: realDir });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "fw-checkignore-outside-"));
    const result = await checkRunLogsIgnored(defaultRunLogsGitCheckIgnoreExec, realDir, path.join(outside, "docs", "wf"));
    expect(result.status).toBe("outside-repo");
    expect(result.relLogsDir).toBeNull();
  });
});

describe("suggestGitignoreLineForLogs (§32 남은 부채/§30 P3)", () => {
  it("docs/<workflow>/logs 관례를 따르면 리포 전체 와일드카드를 권한다", () => {
    expect(suggestGitignoreLineForLogs("docs/pr-smoke/logs/")).toBe("docs/*/logs/");
  });
  it("관례를 따르지 않으면 정확한 단일 경로만 권한다 (무관한 디렉토리까지 무시시키는 사고 방지)", () => {
    expect(suggestGitignoreLineForLogs("logs/")).toBe("/logs/");
    expect(suggestGitignoreLineForLogs("sub/dir/logs/")).toBe("/sub/dir/logs/");
  });
});

describe("runLogsNotIgnoredReason (§32 남은 부채/§30 P3)", () => {
  it("사유에 위험 설명·해결 줄·옵트아웃 탈출구가 모두 담긴다 (§30 P2 체크리스트: 탈출구가 메시지에 적혀 있나)", () => {
    const reason = runLogsNotIgnoredReason("docs/pr-smoke/logs/");
    expect(reason).toContain("docs/pr-smoke/logs/");
    expect(reason).toContain("§32 I-1");
    expect(reason).toContain("docs/*/logs/");
    expect(reason).toContain("allow_untracked_logs: true");
  });
});

// §37 T1 — SDK 네이티브 샌드박스 STATE 스키마 + resolveSandboxSettings. 설계 결정 S1(기본
// 옵트인 아님)/S2(failIfUnavailable 강제)를 이 describe 가 회귀 테스트로 못박는다(§30 P2 체크리스트).
describe("sandbox — §37 T1 STATE 스키마 (하위호환)", () => {
  it("sandbox 필드가 없는 기존 STATE.json 도 그대로 로드된다 (§30 P2 회귀 — 기본 동작 그대로)", () => {
    const s = baseState();
    expect(s.sandbox).toBeUndefined();
    expect(resolveSandboxSettings(s)).toBeUndefined();
  });

  it("sandbox.enabled 를 명시하지 않으면(생략) 기본값 false 로 채워진다", () => {
    const s = StateSchema.parse({ ...baseState(), sandbox: {} });
    expect(s.sandbox?.enabled).toBe(false);
    expect(resolveSandboxSettings(s)).toBeUndefined();
  });

  it("sandbox.enabled: false 를 명시해도 resolveSandboxSettings 는 undefined 다 (Options.sandbox 자체가 없다)", () => {
    const s = StateSchema.parse({ ...baseState(), sandbox: { enabled: false } });
    expect(resolveSandboxSettings(s)).toBeUndefined();
  });

  it("sandbox.enabled: true 면 resolveSandboxSettings 가 enabled:true 를 반환한다", () => {
    const s = StateSchema.parse({ ...baseState(), sandbox: { enabled: true } });
    expect(resolveSandboxSettings(s)).toMatchObject({ enabled: true });
  });

  // §37 S2 — 이 라운드의 핵심 회귀. 사용자가 뭘 넣든 failIfUnavailable 은 항상 true 로 강제된다.
  it("failIfUnavailable: false 를 STATE.json 에 넣어도 무시되고 항상 true 로 강제된다 (§37 S2)", () => {
    const s = StateSchema.parse({
      ...baseState(),
      sandbox: { enabled: true, failIfUnavailable: false },
    });
    // 스키마는 값을 받아준다(strict 파서가 정당한 시도를 거부하지 않도록, §30 P2) — 그러나
    // resolveSandboxSettings 소비 시점에는 무조건 true 다.
    expect(s.sandbox?.failIfUnavailable).toBe(false);
    expect(resolveSandboxSettings(s)?.failIfUnavailable).toBe(true);
  });

  it("failIfUnavailable 을 아예 안 넣어도 true 로 강제된다", () => {
    const s = StateSchema.parse({ ...baseState(), sandbox: { enabled: true } });
    expect(resolveSandboxSettings(s)?.failIfUnavailable).toBe(true);
  });

  it("network/filesystem/credentials 를 세밀 조정할 수 있고 그대로 전달된다", () => {
    const s = StateSchema.parse({
      ...baseState(),
      sandbox: {
        enabled: true,
        network: { allowedDomains: ["github.com", "api.anthropic.com"] },
        filesystem: { allowRead: ["/Users/me/.gradle"], denyRead: ["/Users/me/.ssh"] },
        credentials: {
          files: [{ path: "/Users/me/.config/gh/hosts.yml", mode: "mask", injectHosts: ["github.com"] }],
        },
      },
    });
    const resolved = resolveSandboxSettings(s);
    expect(resolved?.network).toEqual({ allowedDomains: ["github.com", "api.anthropic.com"] });
    expect(resolved?.filesystem).toEqual({ allowRead: ["/Users/me/.gradle"], denyRead: ["/Users/me/.ssh"] });
    expect(resolved?.credentials).toEqual({
      files: [{ path: "/Users/me/.config/gh/hosts.yml", mode: "mask", injectHosts: ["github.com"] }],
    });
  });

  // §41 C-1/C-2 — 이 라운드의 핵심 회귀. SDK `autoAllowBashIfSandboxed`/`allowUnsandboxedCommands`
  // 기본값이 둘 다 true 라서(sdk.d.ts:7264/7202), 미설정 시 SDK 기본값이 그대로 적용돼 샌드박스된
  // Bash 가 canUseTool 없이 자동 승인되거나(C-1) 세션이 dangerouslyDisableSandbox 로 매 명령마다
  // 샌드박스를 끌 수 있었다(C-2). failIfUnavailable 과 완전히 같은 계약으로, 사용자가 STATE 에
  // 무엇을 넣든(심지어 true 로 무력화를 시도해도) 항상 false 로 강제된다.
  it("autoAllowBashIfSandboxed/allowUnsandboxedCommands 를 STATE 에서 true 로 무력화해도 항상 false 로 강제된다 (§41 C-1/C-2)", () => {
    const s = StateSchema.parse({
      ...baseState(),
      sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: true },
    });
    // 스키마는 값을 받아준다(§30 P2 — 정당한 STATE 로드가 깨지지 않도록)
    expect(s.sandbox?.autoAllowBashIfSandboxed).toBe(true);
    expect(s.sandbox?.allowUnsandboxedCommands).toBe(true);
    // 그러나 resolveSandboxSettings 소비 시점에는 무조건 false 다
    const resolved = resolveSandboxSettings(s);
    expect(resolved?.autoAllowBashIfSandboxed).toBe(false);
    expect(resolved?.allowUnsandboxedCommands).toBe(false);
  });

  it("autoAllowBashIfSandboxed/allowUnsandboxedCommands 를 아예 안 넣어도 false 로 강제된다 (SDK 기본값 true 를 덮어씀)", () => {
    const s = StateSchema.parse({ ...baseState(), sandbox: { enabled: true } });
    const resolved = resolveSandboxSettings(s);
    expect(resolved?.autoAllowBashIfSandboxed).toBe(false);
    expect(resolved?.allowUnsandboxedCommands).toBe(false);
  });

  it("network/filesystem/credentials 를 생략하면 결과 객체에도 그 키가 없다 (빈 객체를 억지로 채우지 않는다)", () => {
    const s = StateSchema.parse({ ...baseState(), sandbox: { enabled: true } });
    const resolved = resolveSandboxSettings(s);
    expect(resolved).toEqual({
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
    });
  });

  it("sandbox 에 알 수 없는 키가 있으면 거부한다 (strict 스키마)", () => {
    expect(() =>
      StateSchema.parse({ ...baseState(), sandbox: { enabled: true, unknownField: 1 } }),
    ).toThrow();
  });

  it("sandbox.credentials.files 에 알 수 없는 mode 값은 거부한다", () => {
    expect(() =>
      StateSchema.parse({
        ...baseState(),
        sandbox: { enabled: true, credentials: { files: [{ path: "/x", mode: "banana" }] } },
      }),
    ).toThrow();
  });
});

// §37 sandbox-trial 막힘 1 후속 — 3차 무인 주행이 `sandbox.enabled:true` 만 켠 채(network 설정
// 없이) `git maintenance run --task=prefetch` 가 origin 으로 나가는 연결을 조용히 거부당한 것을
// 재현 가능하게 관측했다(docs/sandbox-trial/NOTES.md "막힘 1"). resolveSandboxSettings/
// sandboxOriginHostAutoAdded 의 originHost 인자가 그 관측에 대한 응답이다. §30 P2 핵심 계약:
// 사용자가 이미 network.allowedDomains 를 명시했다면(빈 배열 포함) 절대 덧붙이지 않는다.
describe("sandbox — origin 호스트 자동 allowlist 포함 (§37 sandbox-trial 막힘 1 후속)", () => {
  it("network 설정 자체가 없으면 origin 호스트를 allowedDomains 에 자동으로 채운다", () => {
    const s = StateSchema.parse({ ...baseState(), sandbox: { enabled: true } });
    const resolved = resolveSandboxSettings(s, "ghe.example.com");
    expect(resolved?.network).toEqual({ allowedDomains: ["ghe.example.com"] });
  });

  it("network 이 있지만 allowedDomains 를 안 적었으면(strictAllowlist 없이) origin 호스트를 채운다", () => {
    const s = StateSchema.parse({
      ...baseState(),
      sandbox: { enabled: true, network: { allowManagedDomainsOnly: true } },
    });
    const resolved = resolveSandboxSettings(s, "ghe.example.com");
    expect(resolved?.network).toEqual({ allowManagedDomainsOnly: true, allowedDomains: ["ghe.example.com"] });
  });

  // §41 I-3 — strictAllowlist:true 는 "정확히 이 목록만" 이라는 명시적 의도 표현이다(위 함수
  // 주석 참조). allowedDomains 를 아직 안 적었더라도 하네스가 몰래 채우면 그 의도를 깨뜨린다 —
  // 실측: 이 회귀 전에는 strictAllowlist:true 여도 origin 호스트가 자동 추가됐다.
  it("network.strictAllowlist:true 면 allowedDomains 가 없어도 origin 호스트를 자동 추가하지 않는다 (§41 I-3)", () => {
    const s = StateSchema.parse({
      ...baseState(),
      sandbox: { enabled: true, network: { strictAllowlist: true } },
    });
    const resolved = resolveSandboxSettings(s, "ghe.example.com");
    expect(resolved?.network).toEqual({ strictAllowlist: true });
  });

  it("strictAllowlist 가 없으면(§30 P2 기존 동작) origin 호스트 자동 추가가 여전히 동작한다", () => {
    const s = StateSchema.parse({ ...baseState(), sandbox: { enabled: true, network: {} } });
    const resolved = resolveSandboxSettings(s, "ghe.example.com");
    expect(resolved?.network).toEqual({ allowedDomains: ["ghe.example.com"] });
  });

  it("사용자가 allowedDomains 를 명시적으로 설정했으면 origin 호스트를 덧붙이지 않는다 (사용자 설정 존중)", () => {
    const s = StateSchema.parse({
      ...baseState(),
      sandbox: { enabled: true, network: { allowedDomains: ["github.com"] } },
    });
    const resolved = resolveSandboxSettings(s, "ghe.example.com");
    expect(resolved?.network).toEqual({ allowedDomains: ["github.com"] });
  });

  it("사용자가 allowedDomains 를 빈 배열로 명시했으면(전부 거부 의도) 그대로 존중한다", () => {
    const s = StateSchema.parse({
      ...baseState(),
      sandbox: { enabled: true, network: { allowedDomains: [] } },
    });
    const resolved = resolveSandboxSettings(s, "ghe.example.com");
    expect(resolved?.network).toEqual({ allowedDomains: [] });
  });

  it("originHost 가 null/undefined 면(로컬 전용 리포·파싱 실패) 예외 없이 기존 동작으로 degrade 한다", () => {
    const s = StateSchema.parse({ ...baseState(), sandbox: { enabled: true } });
    const expected = {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
    };
    expect(resolveSandboxSettings(s, null)).toEqual(expected);
    expect(resolveSandboxSettings(s, undefined)).toEqual(expected);
    expect(resolveSandboxSettings(s)).toEqual(expected);
  });

  it("sandbox 가 꺼져 있으면 originHost 가 있어도 여전히 undefined (§37 S1 유지)", () => {
    const s = StateSchema.parse({ ...baseState(), sandbox: { enabled: false } });
    expect(resolveSandboxSettings(s, "ghe.example.com")).toBeUndefined();
  });

  it("sandboxOriginHostAutoAdded — 자동 포함됐을 때만 그 호스트를 반환한다", () => {
    const autoAdd = StateSchema.parse({ ...baseState(), sandbox: { enabled: true } });
    expect(sandboxOriginHostAutoAdded(autoAdd, "ghe.example.com")).toBe("ghe.example.com");

    const userSet = StateSchema.parse({
      ...baseState(),
      sandbox: { enabled: true, network: { allowedDomains: ["github.com"] } },
    });
    expect(sandboxOriginHostAutoAdded(userSet, "ghe.example.com")).toBeNull();

    const disabled = StateSchema.parse({ ...baseState(), sandbox: { enabled: false } });
    expect(sandboxOriginHostAutoAdded(disabled, "ghe.example.com")).toBeNull();

    const noOriginHost = StateSchema.parse({ ...baseState(), sandbox: { enabled: true } });
    expect(sandboxOriginHostAutoAdded(noOriginHost, null)).toBeNull();

    // §41 I-3 — strictAllowlist:true 도 "자동 추가 안 함"으로 판정돼야 한다(resolveSandboxSettings 와
    // 동일한 shouldAutoAddOriginHost 판정을 공유하므로 여기서도 회귀를 잡는다)
    const strict = StateSchema.parse({
      ...baseState(),
      sandbox: { enabled: true, network: { strictAllowlist: true } },
    });
    expect(sandboxOriginHostAutoAdded(strict, "ghe.example.com")).toBeNull();
  });
});

// §36 §30 P4 후속 — 하네스가 세션에 대해 내린 판정(verdict)을 phase.sessions[] 에 영속한다.
// §36 실측: 게이트가 attempt 를 회송해도 STATE 에는 세션 자신의 result:"done" 만 남아, 회송
// 사실이 기계 기록에서 사라졌다. 아래는 (1) 새 스키마 필드의 유효성/불변식, (2) 이 필드가 없는
// 기존 STATE.json 의 하위호환 로드, (3) 공통 헬퍼 recordVerdict 의 계약을 검증한다.
describe("phase.sessions[].verdict 스키마 (§36 §30 P4)", () => {
  function sessionWith(verdict: unknown) {
    return {
      ...baseState(),
      phases: [
        {
          ...baseState().phases[0],
          sessions: [{ session_id: "s1", result: "done", at: "2026-08-28T00:00:00Z", kind: "phase", verdict }],
        },
        baseState().phases[1],
      ],
    };
  }

  it("verdict 가 없는 세션(§36 이전 레거시)은 그대로 로드된다 — undefined", () => {
    const raw = {
      ...baseState(),
      phases: [
        {
          ...baseState().phases[0],
          sessions: [{ session_id: "s1", result: "done", at: "2026-08-28T00:00:00Z", kind: "phase" }],
        },
        baseState().phases[1],
      ],
    };
    const s = StateSchema.parse(raw);
    expect(s.phases[0].sessions[0].verdict).toBeUndefined();
  });

  it("outcome:accepted 는 reason 없이 유효하다", () => {
    const s = StateSchema.parse(sessionWith({ outcome: "accepted" }));
    expect(s.phases[0].sessions[0].verdict).toEqual({ outcome: "accepted" });
  });

  it.each([
    "gate_failed", "no_commits", "commit_verification_failed", "branch_drift", "verify_tampered",
  ] as const)("outcome:bounced + reason:%s 는 유효하다", reason => {
    const s = StateSchema.parse(sessionWith({ outcome: "bounced", reason }));
    expect(s.phases[0].sessions[0].verdict).toEqual({ outcome: "bounced", reason });
  });

  it("outcome:bounced 인데 reason 이 없으면 거부한다 (사유 없는 회송은 하네스 코드의 버그다)", () => {
    expect(() => StateSchema.parse(sessionWith({ outcome: "bounced" }))).toThrow();
  });

  it("outcome:accepted 인데 reason 이 붙어 있으면 거부한다 (accepted 에는 사유가 있을 수 없다)", () => {
    expect(() => StateSchema.parse(sessionWith({ outcome: "accepted", reason: "gate_failed" }))).toThrow();
  });

  it.each(["session_failed", "session_blocked"] as const)(
    "outcome:%s 는 reason 없이 유효하고, reason 이 붙으면 거부한다",
    outcome => {
      expect(StateSchema.parse(sessionWith({ outcome })).phases[0].sessions[0].verdict).toEqual({ outcome });
      expect(() => StateSchema.parse(sessionWith({ outcome, reason: "gate_failed" }))).toThrow();
    },
  );

  it("reason 에 스키마가 모르는 값을 주면 거부한다 (오타/신규 사유 추가 누락 방지)", () => {
    expect(() => StateSchema.parse(sessionWith({ outcome: "bounced", reason: "typo_reason" }))).toThrow();
  });

  it("verdict 에 알 수 없는 키가 있으면 거부한다 (strict 스키마)", () => {
    expect(() => StateSchema.parse(sessionWith({ outcome: "accepted", extra: 1 }))).toThrow();
  });

  it("detail 은 outcome 과 무관하게 자유 문자열로 붙을 수 있다", () => {
    const s = StateSchema.parse(sessionWith({ outcome: "session_failed", detail: "무슨 일이 있었는지" }));
    expect(s.phases[0].sessions[0].verdict?.detail).toBe("무슨 일이 있었는지");
  });
});

describe("recordVerdict (§36 §30 P4/P1 — orchestrator.ts/prloop.ts 공통 헬퍼)", () => {
  function phaseWithSessions(n: number): Phase {
    return {
      id: 1, title: "p", status: "in_progress", depends_on: [], verify: [], next_steps: [],
      attempts: n, max_attempts: 5, allow_verify_file_changes: false, allow_claude_md_changes: false,
      sessions: Array.from({ length: n }, (_, i) => (
        { session_id: `s${i}`, result: "done", at: `t${i}`, kind: "phase" as const }
      )),
    };
  }

  it("sessionIndex 를 생략하면 방금 push 한 마지막 세션에 판정을 남긴다", () => {
    const phase = phaseWithSessions(2);
    recordVerdict(phase, { outcome: "accepted" });
    expect(phase.sessions[0].verdict).toBeUndefined(); // 앞 세션은 건드리지 않는다
    expect(phase.sessions[1].verdict).toEqual({ outcome: "accepted" });
  });

  it("sessionIndex 를 명시하면 그 세션에 소급 적용한다 (fix 배치 확정용)", () => {
    const phase = phaseWithSessions(3);
    recordVerdict(phase, { outcome: "bounced", reason: "gate_failed" }, 0);
    recordVerdict(phase, { outcome: "bounced", reason: "gate_failed" }, 1);
    expect(phase.sessions[0].verdict).toEqual({ outcome: "bounced", reason: "gate_failed" });
    expect(phase.sessions[1].verdict).toEqual({ outcome: "bounced", reason: "gate_failed" });
    expect(phase.sessions[2].verdict).toBeUndefined(); // 대상이 아닌 세션은 그대로
  });

  it("phase.sessions 가 비어 있으면(push 이전 호출 실수) 조용히 무시하지 않고 throw 한다", () => {
    const phase = phaseWithSessions(0);
    expect(() => recordVerdict(phase, { outcome: "accepted" })).toThrow();
  });

  it("존재하지 않는 sessionIndex 를 명시하면 throw 한다", () => {
    const phase = phaseWithSessions(1);
    expect(() => recordVerdict(phase, { outcome: "accepted" }, 5)).toThrow();
  });
});

// ── issue #3: no-op fix 세션·retry 의 PR 컨텍스트 보존 ─────────────────────────
describe("issue #3 — retryPhase 는 phase.pr 이 있으면 in_review 로 되살린다", () => {
  it("phase.pr 이 있으면 pending 이 아니라 in_review 로 복귀한다 (answerQuestion B-2 와 대칭)", () => {
    const s = baseState();
    s.status = "failed";
    s.phases[0].status = "failed";
    s.phases[0].attempts = 2;
    s.phases[0].pr = {
      number: 42, url: "https://ex/pull/42", head_branch: "fw/phase-1",
      handled_comment_keys: ["issue:1"], fix_sessions: 3,
    };
    retryPhase(s, 1);
    expect(s.phases[0].status).toBe("in_review");
    expect(s.phases[0].attempts).toBe(0);
    expect(s.phases[0].pr?.handled_comment_keys).toEqual(["issue:1"]); // PR 컨텍스트는 그대로
    expect(s.status).toBe("running");
  });

  it("스키마: phase.pr.in_flight_comment_keys 는 선택 필드다 — 없는 기존 STATE 도 그대로 로드된다 (없음 == 빈 배열)", () => {
    const s = baseState();
    const parsed = StateSchema.parse({
      ...s,
      phases: [{
        ...s.phases[0],
        pr: { number: 1, url: "u", head_branch: "fw/phase-1", handled_comment_keys: [], fix_sessions: 0 },
      }, s.phases[1]],
    });
    expect(parsed.phases[0].pr?.in_flight_comment_keys).toBeUndefined();
    const withKeys = StateSchema.parse({
      ...s,
      phases: [{
        ...s.phases[0],
        pr: { number: 1, url: "u", head_branch: "fw/phase-1", handled_comment_keys: [], fix_sessions: 0, in_flight_comment_keys: ["issue:7"] },
      }, s.phases[1]],
    });
    expect(withKeys.phases[0].pr?.in_flight_comment_keys).toEqual(["issue:7"]);
  });

  it("스키마: verdict reason 에 already_applied_unverified 를 허용한다", () => {
    expect(SessionVerdictSchema.parse({ outcome: "bounced", reason: "already_applied_unverified", detail: "x" }).reason)
      .toBe("already_applied_unverified");
  });
});

describe("issue #4 — 항목별 보고 스키마", () => {
  it("verdict reason 에 comment_items_unreported 를 허용한다", () => {
    expect(SessionVerdictSchema.parse({ outcome: "bounced", reason: "comment_items_unreported" }).reason).toBe("comment_items_unreported");
  });
  it("phase.sessions[].addressed 는 선택 필드로 저장·로드된다", () => {
    const s = baseState();
    const parsed = StateSchema.parse({
      ...s,
      phases: [{
        ...s.phases[0],
        sessions: [{
          session_id: "x", result: "done", at: "t", kind: "fix",
          addressed: [{ item: "a", status: "applied", evidence: "sha" }, { item: "b", status: "declined", evidence: "why" }],
        }],
      }, s.phases[1]],
    });
    expect(parsed.phases[0].sessions[0].addressed).toHaveLength(2);
    expect(StateSchema.parse(s).phases[0].sessions).toEqual([]);
  });
});

describe("pr-slicing: 조각 분해 스키마 (하위호환)", () => {
  // 신규 필드는 전부 optional 이어야 한다 — 기존 워크플로우의 STATE.json
  // (docs/tamper-gap/STATE.json 등)이 파싱에 실패하면 그 워크플로우들이 즉시 실행 불가가 된다.
  it("미설정 시 전부 undefined 다 (기존 STATE.json 이 그대로 로드된다)", () => {
    const s = baseState();
    expect(s.integration_branch).toBeUndefined();
    expect(s.review_split).toBeUndefined();
    expect(s.next_slice_seq).toBeUndefined();
    expect(s.phases[0].split_group).toBeUndefined();
    expect(s.phases[0].split_rationale).toBeUndefined();
    expect(s.phases[0].decompose_skipped_reason).toBeUndefined();
    expect(s.phases[0].slice_seq).toBeUndefined();
  });

  it("명시적으로 채울 수 있다", () => {
    const s = StateSchema.parse({
      ...baseState(),
      integration_branch: "feature/PROJ-123",
      review_split: { enabled: true, budget_lines: 400 },
      next_slice_seq: 3,
      phases: [
        {
          ...baseState().phases[0],
          slice_seq: 2,
          split_group: { origin_id: 1, index: 2, total: 3 },
          split_rationale: "인터페이스 추가만 담는다",
          decompose_skipped_reason: undefined,
        },
        baseState().phases[1],
      ],
    });
    expect(s.integration_branch).toBe("feature/PROJ-123");
    expect(s.review_split).toEqual({ enabled: true, budget_lines: 400 });
    expect(s.next_slice_seq).toBe(3);
    expect(s.phases[0].slice_seq).toBe(2);
    expect(s.phases[0].split_group).toEqual({ origin_id: 1, index: 2, total: 3 });
    expect(s.phases[0].split_rationale).toBe("인터페이스 추가만 담는다");
  });

  it("분해를 건너뛴 이유를 기록할 수 있다 (조용히 넘어가지 않는다 — PLAN D10)", () => {
    const s = StateSchema.parse({
      ...baseState(),
      phases: [
        { ...baseState().phases[0], decompose_skipped_reason: "분해 세션이 1조각을 반환했습니다" },
        baseState().phases[1],
      ],
    });
    expect(s.phases[0].decompose_skipped_reason).toBe("분해 세션이 1조각을 반환했습니다");
  });

  it("budget_lines 는 양의 정수여야 한다", () => {
    for (const bad of [0, -1, 1.5]) {
      expect(
        () => StateSchema.parse({ ...baseState(), review_split: { enabled: true, budget_lines: bad } }),
        `거부해야 함: ${bad}`,
      ).toThrow();
    }
  });

  it("review_split 은 enabled 없이 쓸 수 없다 (켰는지 껐는지 모호하면 안 된다)", () => {
    expect(() => StateSchema.parse({ ...baseState(), review_split: { budget_lines: 400 } })).toThrow();
  });

  it("next_slice_seq / slice_seq 는 양의 정수여야 한다 (조각 순번은 1부터)", () => {
    expect(() => StateSchema.parse({ ...baseState(), next_slice_seq: 0 })).toThrow();
    expect(() => StateSchema.parse({ ...baseState(), next_slice_seq: -1 })).toThrow();
    expect(() =>
      StateSchema.parse({
        ...baseState(),
        phases: [{ ...baseState().phases[0], slice_seq: 0 }, baseState().phases[1]],
      }),
    ).toThrow();
  });

  it("split_group 의 origin_id/index/total 은 양의 정수여야 한다", () => {
    for (const bad of [
      { origin_id: 0, index: 1, total: 2 },
      { origin_id: 1, index: 0, total: 2 },
      { origin_id: 1, index: 1, total: 0 },
      { origin_id: 1, index: 1.5, total: 2 },
    ]) {
      expect(
        () =>
          StateSchema.parse({
            ...baseState(),
            phases: [{ ...baseState().phases[0], split_group: bad }, baseState().phases[1]],
          }),
        `거부해야 함: ${JSON.stringify(bad)}`,
      ).toThrow();
    }
  });

  it("split_group / review_split 에 오타 키가 있으면 거부한다 (strict)", () => {
    expect(() =>
      StateSchema.parse({
        ...baseState(),
        phases: [
          { ...baseState().phases[0], split_group: { origin_id: 1, index: 1, total: 2, totl: 3 } },
          baseState().phases[1],
        ],
      }),
    ).toThrow();
    expect(() =>
      StateSchema.parse({ ...baseState(), review_split: { enabled: true, budget_lines: 400, budgetLines: 1 } }),
    ).toThrow();
  });
});

describe("assertRunnable — 조각 분해 전제 조건 (pr-slicing Phase 2)", () => {
  // 조각 분해는 하네스가 조각 브랜치를 만들고 통합 브랜치를 전진시켜야 성립한다. 그런데
  // branch_strategy="current" 는 "브랜치는 사용자에게 위임하고 감시도 하지 않는다" 는 설계
  // (workBranch=null)라 하네스가 브랜치를 만들 근거가 없다. 조용히 분해를 끄면 사용자는
  // 조각 PR 을 기대하는데 커다란 PR 하나를 받는다 — 그래서 시작 시점에 거부한다.
  it("review_split 켜짐 + branch_strategy=current 조합을 거부한다", () => {
    const s = {
      ...baseState(),
      branch_strategy: "current" as const,
      // pr_mode 관련 전제는 전부 갖춰 둔다 — 그래야 "current 때문에 거부됐다" 가 증명된다.
      pr_mode: true, allow_push: true, trusted_comment_authors: ["alice"],
      review_split: { enabled: true, budget_lines: 400 },
    };
    expect(() => assertRunnable(StateSchema.parse(s))).toThrow(/current/);
  });

  it("review_split 이 꺼져 있으면 branch_strategy=current 를 그대로 허용한다 (기존 동작)", () => {
    const s = {
      ...baseState(),
      branch_strategy: "current" as const,
      review_split: { enabled: false, budget_lines: 400 },
    };
    expect(() => assertRunnable(StateSchema.parse(s))).not.toThrow();
  });

  it("review_split 미설정이면 branch_strategy=current 를 그대로 허용한다 (하위호환)", () => {
    const s = { ...baseState(), branch_strategy: "current" as const };
    expect(() => assertRunnable(StateSchema.parse(s))).not.toThrow();
  });

  it("review_split 켜짐 + isolate/require-topic 는 허용한다", () => {
    for (const strategy of ["isolate", "require-topic"] as const) {
      const s = {
        ...baseState(),
        branch_strategy: strategy,
        pr_mode: true, allow_push: true, trusted_comment_authors: ["alice"],
        review_split: { enabled: true, budget_lines: 400 },
      };
      expect(() => assertRunnable(StateSchema.parse(s)), `허용해야 함: ${strategy}`).not.toThrow();
    }
  });
});

describe("assertRunnable — 조각 분해는 pr_mode 를 요구한다 (pr-slicing Phase 4)", () => {
  // 조각은 통합 브랜치로 **머지되어야** 그 브랜치가 전진하고 다음 조각이 그 위에서 시작한다.
  // pr_mode 가 꺼져 있으면 머지가 일어나지 않으므로 조각 2가 조각 1의 작업 없이 시작한다 —
  // 조용히 어긋난 결과가 나오느니 시작 시점에 거부한다.
  it("review_split 켜짐 + pr_mode 꺼짐을 거부한다", () => {
    const s = { ...baseState(), pr_mode: false, review_split: { enabled: true, budget_lines: 400 } };
    expect(() => assertRunnable(StateSchema.parse(s))).toThrow(/pr_mode/);
  });

  it("review_split 켜짐 + pr_mode 켜짐은 허용한다", () => {
    const s = {
      ...baseState(), pr_mode: true, allow_push: true, review_split: { enabled: true, budget_lines: 400 },
      trusted_comment_authors: ["alice"],
    };
    expect(() => assertRunnable(StateSchema.parse(s))).not.toThrow();
  });

  it("review_split 이 꺼져 있으면 pr_mode 와 무관하다 (기존 동작)", () => {
    const s = { ...baseState(), pr_mode: false, review_split: { enabled: false, budget_lines: 400 } };
    expect(() => assertRunnable(StateSchema.parse(s))).not.toThrow();
  });
});

describe("StateSchema — 통합 PR 기록 (pr-slicing Phase 5)", () => {
  it("미설정 시 undefined 다 (하위호환)", () => {
    expect(baseState().integration_pr).toBeUndefined();
  });

  it("통합 PR 을 기록할 수 있다", () => {
    const s = StateSchema.parse({
      ...baseState(),
      integration_pr: { number: 42, url: "https://ex/pull/42", head_branch: "feature/wf" },
    });
    expect(s.integration_pr).toEqual({ number: 42, url: "https://ex/pull/42", head_branch: "feature/wf" });
  });

  it("폴링 시각도 담을 수 있다 (며칠 도는 프로세스가 살아있는지 구분)", () => {
    const s = StateSchema.parse({
      ...baseState(),
      integration_pr: { number: 1, url: "u", head_branch: "b", last_polled_at: "2026-09-09T00:00:00Z" },
    });
    expect(s.integration_pr!.last_polled_at).toBe("2026-09-09T00:00:00Z");
  });

  it("오타 키를 거부한다 (strict)", () => {
    expect(() =>
      StateSchema.parse({ ...baseState(), integration_pr: { number: 1, url: "u", head_branch: "b", numbr: 2 } }),
    ).toThrow();
  });

  it("PR 번호는 양의 정수여야 한다", () => {
    expect(() =>
      StateSchema.parse({ ...baseState(), integration_pr: { number: 0, url: "u", head_branch: "b" } }),
    ).toThrow();
  });
});

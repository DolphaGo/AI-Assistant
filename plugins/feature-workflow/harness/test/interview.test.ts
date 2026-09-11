import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  newInterview, loadInterview, saveInterview, interviewNext, unansweredQuestions,
  applyRoleResult, applyAnswer, applyObjections, approveInterview, assemblePlan,
  questionsAsDecisionRows, buildRoleInterviewPrompt, buildObjectionPrompt, advanceInterview,
  MAX_INTERVIEW_SESSIONS, MAX_ENTRY_PATHS, MAX_GLOSSARY_TERMS, MAX_OBJECTION_ROUNDS, INTERVIEW_ROLES, INTERVIEW_FILE,
  type InterviewState, type InterviewRole, type InterviewRunnerLike,
} from "../src/interview.js";

const NOW = "2026-08-28T10:00:00Z";

// §46 — 인터뷰의 존재 이유: 종료 조건이 모델의 자기 주장이 아니라 셀 수 있는 값이다.
// (미답 질문 0 + 초안 3 + 상호 이의 0 → ready → 사람이 승인)
describe("interviewNext — 상태 기계", () => {
  it("새 인터뷰는 기획 역할부터 돌린다 (고정 순서 — 뒤 역할이 기획 답을 참조한다)", () => {
    const iv = newInterview("목표", []);
    expect(interviewNext(iv)).toEqual({ kind: "run_role", role: "planning" });
  });

  it("미답 질문이 있으면 사람 차례 — 에이전트를 더 돌리지 않는다", () => {
    let iv = newInterview("목표", []);
    iv = applyRoleResult(iv, "planning", { questions: [{ question: "범위는?", why: "결정 D1" }], draft: null }, NOW);
    const a = interviewNext(iv);
    expect(a.kind).toBe("await_answers");
    if (a.kind === "await_answers") expect(a.unanswered[0]!.id).toBe("P1");
  });

  it("답이 채워지면 다시 그 역할(초안 없음)로 돌아간다", () => {
    let iv = newInterview("목표", []);
    iv = applyRoleResult(iv, "planning", { questions: [{ question: "범위는?" }], draft: null }, NOW);
    iv = applyAnswer(iv, "P1", "모듈 A 만", NOW);
    expect(interviewNext(iv)).toEqual({ kind: "run_role", role: "planning" });
  });

  it("초안 3개가 차면 이의 라운드", () => {
    let iv = newInterview("목표", []);
    for (const role of INTERVIEW_ROLES) iv = applyRoleResult(iv, role, { questions: [], draft: `${role} 초안` }, NOW);
    expect(interviewNext(iv)).toEqual({ kind: "run_objections" });
  });

  it("이의 0건으로 라운드가 끝나면 ready — 사람의 승인만 남는다", () => {
    let iv = newInterview("목표", []);
    for (const role of INTERVIEW_ROLES) iv = applyRoleResult(iv, role, { questions: [], draft: `${role} 초안` }, NOW);
    iv = applyObjections(iv, [], NOW, 3);
    expect(iv.status).toBe("ready");
    expect(interviewNext(iv)).toEqual({ kind: "ready" });
  });

  it("이의가 나오면 대상 역할의 초안이 무효화되고 그 역할이 다시 돈다", () => {
    let iv = newInterview("목표", []);
    for (const role of INTERVIEW_ROLES) iv = applyRoleResult(iv, role, { questions: [], draft: `${role} 초안` }, NOW);
    iv = applyObjections(iv, [{ from_role: "evaluation", to_role: "planning", detail: "검증 불가능한 결정" }], NOW, 3);
    expect(iv.drafts.planning).toBeNull();
    expect(interviewNext(iv)).toEqual({ kind: "run_role", role: "planning" });
  });

  it("재작성된 초안은 다시 이의 라운드를 거쳐야 한다 (clean 플래그 리셋)", () => {
    let iv = newInterview("목표", []);
    for (const role of INTERVIEW_ROLES) iv = applyRoleResult(iv, role, { questions: [], draft: `${role} 초안` }, NOW);
    iv = applyObjections(iv, [{ from_role: "evaluation", to_role: "planning", detail: "d" }], NOW, 3);
    iv = applyRoleResult(iv, "planning", { questions: [], draft: "수정된 초안" }, NOW);
    expect(interviewNext(iv)).toEqual({ kind: "run_objections" });
    // 그 역할을 향한 이의는 재작성으로 resolved — 이력은 남는다
    expect(iv.objections).toHaveLength(1);
    expect(iv.objections[0]!.resolved).toBe(true);
  });

  it("세션 상한 도달 시 에이전트 단계는 멈추되 답 입력·승인은 막지 않는다 (§30 P2)", () => {
    let iv = newInterview("목표", []);
    iv = { ...iv, sessions_used: MAX_INTERVIEW_SESSIONS };
    expect(interviewNext(iv).kind).toBe("session_cap");
    // 상한 상태여도 미답 질문이 있으면 사람 차례가 우선이다
    let iv2 = newInterview("목표", []);
    iv2 = applyRoleResult(iv2, "planning", { questions: [{ question: "q" }], draft: null }, NOW);
    iv2 = { ...iv2, sessions_used: MAX_INTERVIEW_SESSIONS };
    expect(interviewNext(iv2).kind).toBe("await_answers");
  });
});

describe("전이 함수 — 신뢰 경계", () => {
  it("질문이 있으면 초안은 무시한다 — 답 없이 쓴 초안은 받지 않는다", () => {
    let iv = newInterview("목표", []);
    iv = applyRoleResult(iv, "planning", { questions: [{ question: "q" }], draft: "몰래 쓴 초안" }, NOW);
    expect(iv.drafts.planning).toBeNull();
    expect(unansweredQuestions(iv)).toHaveLength(1);
  });

  it("질문도 초안도 없는 계약 위반 출력도 세션 수는 소모한다 (공짜 재시도 금지)", () => {
    let iv = newInterview("목표", []);
    iv = applyRoleResult(iv, "planning", { questions: [], draft: null }, NOW);
    expect(iv.sessions_used).toBe(1);
    expect(iv.drafts.planning).toBeNull();
  });

  it("자기 자신에 대한 이의는 버린다 (자기 이의 → 자기 재작성 루프 방지)", () => {
    let iv = newInterview("목표", []);
    for (const role of INTERVIEW_ROLES) iv = applyRoleResult(iv, role, { questions: [], draft: "d" }, NOW);
    iv = applyObjections(iv, [{ from_role: "planning", to_role: "planning", detail: "자기 이의" }], NOW, 3);
    expect(iv.objections).toHaveLength(0);
    expect(iv.status).toBe("ready"); // 유효 이의 0건 → clean pass
  });

  it("이의 라운드의 세션 수는 실제 사용분(역할당 1)으로 계상한다", () => {
    let iv = newInterview("목표", []);
    for (const role of INTERVIEW_ROLES) iv = applyRoleResult(iv, role, { questions: [], draft: "d" }, NOW);
    const before = iv.sessions_used; // 3
    iv = applyObjections(iv, [], NOW, 3);
    expect(iv.sessions_used).toBe(before + 3);
  });

  it("없는 질문·중복 답변은 거부한다", () => {
    let iv = newInterview("목표", []);
    iv = applyRoleResult(iv, "planning", { questions: [{ question: "q" }], draft: null }, NOW);
    expect(() => applyAnswer(iv, "P9", "x", NOW)).toThrow("P9");
    iv = applyAnswer(iv, "P1", "첫 답", NOW);
    expect(() => applyAnswer(iv, "P1", "덮어쓰기", NOW)).toThrow("이미 답변");
  });

  it("승인은 ready 에서만 가능하다 — interviewing 상태의 승인은 거부", () => {
    const iv = newInterview("목표", []);
    expect(() => approveInterview(iv)).toThrow("ready");
  });
});

describe("assemblePlan — §28 파서와의 정합", () => {
  function readyInterview(): InterviewState {
    let iv = newInterview("Kafka 클라이언트를 3.x 로 올린다", ["src/kafka/Producer.java"]);
    iv = applyRoleResult(iv, "planning", { questions: [{ question: "구버전 소비자와의 호환은?", why: "wire format" }], draft: null }, NOW);
    iv = applyAnswer(iv, "P1", "반드시 유지", NOW);
    iv = applyRoleResult(iv, "planning", { questions: [], draft: "| ID | 결정 | 근거 | 상태 | 날짜 |\n|----|------|------|------|------|\n| D1 | 호환 유지 | 인터뷰 | accepted | 2026-08-28 |" }, NOW);
    iv = applyRoleResult(iv, "development", { questions: [], draft: "- 진입: src/kafka/Producer.java" }, NOW);
    iv = applyRoleResult(iv, "evaluation", { questions: [], draft: "- 직렬화 스냅샷 테스트 통과" }, NOW);
    iv = applyObjections(iv, [], NOW, 3);
    return approveInterview(iv);
  }

  it("생성된 PLAN 을 §28 파서(readPlanContext)가 세 절 모두 읽을 수 있다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-iv-plan-"));
    try {
      fs.writeFileSync(path.join(dir, "PLAN.md"), assemblePlan(readyInterview()));
      const { readPlanContext } = await import("../src/plan.js");
      const ctx = readPlanContext(dir);
      expect(ctx.decisions).toContain("호환 유지");
      expect(ctx.architecture).toContain("src/kafka/Producer.java");
      expect(ctx.acceptance).toContain("직렬화 스냅샷");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("인터뷰 Q&A 가 결정 행으로 들어간다 — 답이 곧 결정이다 (grill-with-docs)", () => {
    const plan = assemblePlan(readyInterview());
    expect(plan).toContain("구버전 소비자와의 호환은?");
    expect(plan).toContain("**반드시 유지**");
  });

  it("표 셀 안의 파이프·개행은 이스케이프된다 — 표가 깨지면 §28 주입이 통째로 빠진다", () => {
    let iv = newInterview("목표", []);
    iv = applyRoleResult(iv, "planning", { questions: [{ question: "a|b 냐\nc|d 냐?" }], draft: null }, NOW);
    iv = applyAnswer(iv, "P1", "x|y 로", NOW);
    const rows = questionsAsDecisionRows(iv);
    expect(rows).toContain("a\\|b 냐 c\\|d 냐?");
    expect(rows).toContain("**x\\|y 로**");
  });
});

describe("프롬프트 — §46", () => {
  it("역할 프롬프트가 목표·진입 경로·기존 Q&A 를 싣고 전체 스캔을 금지한다", () => {
    let iv = newInterview("결제 모듈 리팩토링", ["src/pay/Gateway.ts"]);
    iv = applyRoleResult(iv, "planning", { questions: [{ question: "환불 경로도 포함?" }], draft: null }, NOW);
    iv = applyAnswer(iv, "P1", "아니오, 결제 승인만", NOW);
    const p = buildRoleInterviewPrompt(iv, "development");
    expect(p).toContain("결제 모듈 리팩토링");
    expect(p).toContain("src/pay/Gateway.ts");
    expect(p).toContain("환불 경로도 포함?");
    expect(p).toContain("아니오, 결제 승인만");
    expect(p).toContain("전체 스캔 금지");
    expect(p).toContain("이미 답된 것을 다시 묻지 마라");
  });

  it("기획 프롬프트는 '가정하지 말고 물어라' 를 명시한다", () => {
    expect(buildRoleInterviewPrompt(newInterview("g", []), "planning")).toContain("가정하지 말고 물어라");
  });

  it("재작성 프롬프트에는 해소해야 할 이의가 실린다", () => {
    let iv = newInterview("목표", []);
    for (const role of INTERVIEW_ROLES) iv = applyRoleResult(iv, role, { questions: [], draft: "d" }, NOW);
    iv = applyObjections(iv, [{ from_role: "evaluation", to_role: "planning", detail: "D1 은 검증 불가" }], NOW, 3);
    iv = applyRoleResult(iv, "planning", { questions: [], draft: "수정본" }, NOW);
    // 다음 재작성이 필요한 상황을 만들기 위해 다시 이의
    iv = applyObjections(iv, [{ from_role: "development", to_role: "planning", detail: "D2 구현 불가" }], NOW, 3);
    const p = buildRoleInterviewPrompt(iv, "planning");
    expect(p).toContain("D1 은 검증 불가"); // resolved 된 과거 이의도 맥락으로 보여준다
  });

  it("이의 프롬프트는 다른 두 역할의 초안만 싣는다", () => {
    let iv = newInterview("목표", []);
    for (const role of INTERVIEW_ROLES) iv = applyRoleResult(iv, role, { questions: [], draft: `${role}-DRAFT` }, NOW);
    const p = buildObjectionPrompt(iv, "planning");
    expect(p).toContain("development-DRAFT");
    expect(p).toContain("evaluation-DRAFT");
    expect(p).not.toContain("planning-DRAFT");
    expect(p).toContain("이의를 제기하는 것");
  });
});

describe("advanceInterview — 드라이버", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-iv-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("질문 → (사람 답) → 초안 → 이의 0 → ready 전체 사이클이 돈다", async () => {
    const rolesRun: InterviewRole[] = [];
    const runner: InterviewRunnerLike = {
      async runRole(state, role) {
        rolesRun.push(role);
        if (role === "planning" && state.questions.length === 0) {
          return { output: { questions: [{ question: "범위는?", why: "" }], draft: null }, costUsd: 0.1 };
        }
        return { output: { questions: [], draft: `${role} 초안` }, costUsd: 0.1 };
      },
      async runObjections() {
        return { objections: [], costUsd: 0.05 };
      },
    };
    // 1차: planning 이 질문을 내고 멈춘다
    let iv = newInterview("목표", []);
    saveInterview(dir, iv);
    iv = await advanceInterview(dir, iv, runner, () => NOW, () => {});
    expect(interviewNext(iv).kind).toBe("await_answers");
    // 사람이 답한다
    iv = applyAnswer(iv, "P1", "모듈 A 만", NOW);
    saveInterview(dir, iv);
    // 2차: 세 초안 + 이의 라운드까지 자동 진행 → ready
    iv = await advanceInterview(dir, iv, runner, () => NOW, () => {});
    expect(iv.status).toBe("ready");
    expect(rolesRun).toEqual(["planning", "planning", "development", "evaluation"]);
    expect(iv.sessions_used).toBe(4 + 3); // 역할 4회 + 이의 3세션
    expect(iv.cost_usd).toBeCloseTo(0.1 * 4 + 0.05 * 3, 5);
    // 디스크에도 영속 — 대화형 단계에서 프로세스가 죽어도 이어갈 수 있다
    expect(loadInterview(dir).status).toBe("ready");
  });

  it("이의가 나오면 해당 역할을 재작성시키고 다시 이의 라운드를 돈다", async () => {
    let objectionRounds = 0;
    const runner: InterviewRunnerLike = {
      async runRole(_state, role) {
        return { output: { questions: [], draft: `${role} 초안 v${objectionRounds + 1}` }, costUsd: 0 };
      },
      async runObjections(_state, role) {
        // 첫 라운드에서만 evaluation 이 planning 에 이의
        if (objectionRounds === 0 && role === "evaluation") {
          objectionRounds++;
          return { objections: [{ to_role: "planning", detail: "검증 불가" }], costUsd: 0 };
        }
        return { objections: [], costUsd: 0 };
      },
    };
    let iv = newInterview("목표", []);
    saveInterview(dir, iv);
    iv = await advanceInterview(dir, iv, runner, () => NOW, () => {});
    expect(iv.status).toBe("ready");
    expect(iv.drafts.planning).toContain("v2"); // 재작성됨
    expect(iv.objections).toHaveLength(1);
    expect(iv.objections[0]!.from_role).toBe("evaluation"); // from_role 은 하네스가 채웠다
    expect(iv.objections[0]!.resolved).toBe(true);
  });

  it("세션 상한에서 멈춘다 — 무한 질문 루프 방어", async () => {
    const runner: InterviewRunnerLike = {
      async runRole() {
        // 매번 계약 위반 출력(질문도 초안도 없음) — 상태가 안 바뀌므로 상한만이 루프를 끊는다
        return { output: { questions: [], draft: null }, costUsd: 0 };
      },
      async runObjections() {
        return { objections: [], costUsd: 0 };
      },
    };
    let iv = newInterview("목표", []);
    saveInterview(dir, iv);
    iv = await advanceInterview(dir, iv, runner, () => NOW, () => {});
    expect(iv.sessions_used).toBe(MAX_INTERVIEW_SESSIONS);
    expect(interviewNext(iv).kind).toBe("session_cap");
  });

  it("세션 실패(null 출력)도 세션 수를 소모하며 드라이버를 죽이지 않는다", async () => {
    let calls = 0;
    const runner: InterviewRunnerLike = {
      async runRole(_state, role) {
        calls++;
        if (calls === 1) return { output: null }; // 첫 호출은 SDK 실패
        return { output: { questions: [], draft: `${role} 초안` } };
      },
      async runObjections() {
        return { objections: [] };
      },
    };
    let iv = newInterview("목표", []);
    saveInterview(dir, iv);
    iv = await advanceInterview(dir, iv, runner, () => NOW, () => {});
    expect(iv.status).toBe("ready");
    expect(iv.sessions_used).toBe(4 + 3); // 실패 1 + 성공 3 + 이의 3
  });
});

describe("영속성", () => {
  it("save → load 왕복이 무손실이다", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-iv-io-"));
    try {
      let iv = newInterview("목표", ["src/a.ts"]);
      iv = applyRoleResult(iv, "planning", { questions: [{ question: "q", why: "w" }], draft: null }, NOW);
      saveInterview(dir, iv);
      expect(loadInterview(dir)).toEqual(iv);
      expect(fs.existsSync(path.join(dir, INTERVIEW_FILE))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// §47 — 뒤 역할은 앞 역할의 계획서를 보고 자기 계획을 세운다. 이게 없으면 "평가 고수가
// 기획·개발 계획서를 보고 평가 방법을 확인받는" 흐름 자체가 성립하지 않는다.
describe("역할 간 계획서 전달 — §47", () => {
  it("개발 역할 프롬프트에 기획 초안이 실린다", () => {
    let iv = newInterview("목표", []);
    iv = applyRoleResult(iv, "planning", { questions: [], draft: "PLANNING-DRAFT-내용" }, NOW);
    const p = buildRoleInterviewPrompt(iv, "development");
    expect(p).toContain("PLANNING-DRAFT-내용");
    expect(p).toContain("기획 계획서 초안");
  });

  it("평가 역할 프롬프트에 기획·개발 초안이 모두 실린다", () => {
    let iv = newInterview("목표", []);
    iv = applyRoleResult(iv, "planning", { questions: [], draft: "PLAN-D" }, NOW);
    iv = applyRoleResult(iv, "development", { questions: [], draft: "DEV-D" }, NOW);
    const p = buildRoleInterviewPrompt(iv, "evaluation");
    expect(p).toContain("PLAN-D");
    expect(p).toContain("DEV-D");
    expect(p).toContain("정합해야 한다");
  });

  it("아직 초안이 없는 첫 역할(기획)에는 초안 절이 없다", () => {
    const p = buildRoleInterviewPrompt(newInterview("목표", []), "planning");
    expect(p).not.toContain("다른 역할의 계획서 초안");
  });

  it("평가 미션이 '이렇게 평가하면 되는가' 확인과 추가 확인 항목 유도를 명시한다", () => {
    const p = buildRoleInterviewPrompt(newInterview("목표", []), "evaluation");
    expect(p).toContain("이렇게 평가하면 되는가");
    expect(p).toContain("더 확인받고 싶으세요");
  });
});

// §48 — 진입 경로(구 2번)는 별도 사전 단계가 아니라 개발 고수 인터뷰의 산출물이다.
describe("진입 경로 승격 — §48", () => {
  it("개발 역할이 반환한 entry_paths 가 상태로 승격돼 이후 프롬프트·PLAN 에 실린다", () => {
    let iv = newInterview("목표", []); // --entry 없이 시작
    iv = applyRoleResult(iv, "planning", { questions: [], draft: "기획 초안" }, NOW);
    iv = applyRoleResult(
      iv, "development",
      { questions: [], draft: "- 진입: src/kafka", entry_paths: ["src/kafka/Producer.java", "src/kafka/Config.java"] },
      NOW,
    );
    expect(iv.entry_paths).toEqual(["src/kafka/Producer.java", "src/kafka/Config.java"]);
    // 이후 역할(평가) 프롬프트에 실린다
    expect(buildRoleInterviewPrompt(iv, "evaluation")).toContain("src/kafka/Producer.java");
    // 승인 후 PLAN §진입 경로에도 실린다
    iv = applyRoleResult(iv, "evaluation", { questions: [], draft: "평가 초안" }, NOW);
    iv = applyObjections(iv, [], NOW, 3);
    expect(assemblePlan(approveInterview(iv))).toContain("- src/kafka/Producer.java");
  });

  it("질문과 함께 온 부분 확정 경로도 받는다 (다음 세션 프롬프트에 바로 실리도록)", () => {
    let iv = newInterview("목표", []);
    iv = applyRoleResult(iv, "planning", { questions: [], draft: "d" }, NOW);
    iv = applyRoleResult(
      iv, "development",
      { questions: [{ question: "테스트 코드도 진입에 포함?" }], draft: null, entry_paths: ["src/pay"] },
      NOW,
    );
    expect(iv.entry_paths).toEqual(["src/pay"]);
    expect(iv.drafts.development).toBeNull(); // 질문이 있으니 초안은 여전히 거부
  });

  it("개발이 아닌 역할의 entry_paths 는 무시한다 (소유 경계)", () => {
    let iv = newInterview("목표", ["원래경로"]);
    iv = applyRoleResult(iv, "planning", { questions: [], draft: "d", entry_paths: ["기획이 주장한 경로"] }, NOW);
    expect(iv.entry_paths).toEqual(["원래경로"]);
  });

  it("개수·길이 상한을 넘는 경로는 잘라낸다 (신뢰 경계)", () => {
    let iv = newInterview("목표", []);
    const many = Array.from({ length: 30 }, (_, i) => `src/m${i}.ts`);
    iv = applyRoleResult(iv, "development", { questions: [], draft: "d", entry_paths: [...many, "x".repeat(500)] }, NOW);
    expect(iv.entry_paths).toHaveLength(MAX_ENTRY_PATHS);
  });

  it("개발 미션이 진입 경로 확정을 첫 질문·출력 계약으로 명시한다", () => {
    const p = buildRoleInterviewPrompt(newInterview("목표", []), "development");
    expect(p).toContain("첫 질문으로");
    expect(p).toContain("entry_paths 에 그 경로들을 담아");
  });
});

// §50 실측(z-parse 통주) — 이의 라운드가 7차까지 수렴하지 않았고, 상한 도달 메시지("사람이
// 판단하세요")에 대응하는 기계적 경로가 없었다. force 승인이 그 탈출구다.
describe("강제 승인 — §50", () => {
  function cappedInterview(): InterviewState {
    let iv = newInterview("목표", []);
    for (const role of INTERVIEW_ROLES) iv = applyRoleResult(iv, role, { questions: [], draft: `${role} 초안` }, NOW);
    // 미해소 이의가 있는 상태 (ready 아님)
    iv = applyObjections(iv, [{ from_role: "evaluation", to_role: "planning", detail: "이견 A" }], NOW, 3);
    iv = applyRoleResult(iv, "planning", { questions: [], draft: "수정 초안" }, NOW);
    iv = applyObjections(iv, [{ from_role: "development", to_role: "evaluation", detail: "이견 B" }], NOW, 3);
    iv = applyRoleResult(iv, "evaluation", { questions: [], draft: "수정 평가 초안" }, NOW);
    return iv; // status: interviewing, 미해소 이의 1건(이견 B... planning 재작성으로 A 는 resolved)
  }

  it("force 는 interviewing 상태에서도 승인한다 — 사람이 판단하는 탈출구", () => {
    const iv = approveInterview(cappedInterview(), { force: true });
    expect(iv.status).toBe("approved");
    expect(iv.force_approved).toBe(true);
  });

  it("force 승인 시 PLAN 에 '청정 통과 없이 승인됨' 과 마지막 이의 목록이 실린다", () => {
    // 주의: 세 초안이 다 있으면 미해소 이의는 구조적으로 0건이다(이의는 대상 초안을 무효화하고
    // 재작성 시 resolved 가 된다). force 가 기록해야 할 진실은 '마지막 초안이 재검증을 통과하지
    // 않았다' 는 사실과, 재작성이 반영했다고 '주장' 된 마지막 이의들이다.
    const plan = assemblePlan(approveInterview(cappedInterview(), { force: true }));
    expect(plan).toContain("## 미검증 승인");
    expect(plan).toContain("이견 B");
    expect(plan).toContain("재작성으로 해소 주장");
  });

  it("정상(ready) 승인에는 미검증 승인 절이 없다", () => {
    let iv = newInterview("목표", []);
    for (const role of INTERVIEW_ROLES) iv = applyRoleResult(iv, role, { questions: [], draft: "d" }, NOW);
    iv = applyObjections(iv, [], NOW, 3);
    const plan = assemblePlan(approveInterview(iv));
    expect(plan).not.toContain("미검증 승인");
  });

  it("초안이 하나라도 없으면 force 도 거부 — 재료 없이는 강제도 없다", () => {
    let iv = newInterview("목표", []);
    iv = applyRoleResult(iv, "planning", { questions: [], draft: "d" }, NOW);
    expect(() => approveInterview(iv, { force: true })).toThrow("development");
  });

  it("미답 질문이 있으면 force 도 거부", () => {
    let iv = cappedInterview();
    iv = applyRoleResult(iv, "planning", { questions: [{ question: "q?" }], draft: null }, NOW);
    expect(() => approveInterview(iv, { force: true })).toThrow("미답");
  });

  it("force 없는 기존 경로는 동작 불변 — interviewing 에서 거부", () => {
    expect(() => approveInterview(cappedInterview())).toThrow("ready");
  });
});

// §50 후속 — 초안이 자체 h2 헤딩을 가져도 §28 파서가 세 절을 전부 읽어야 한다.
// 실측: z-parse PLAN 에서 개발 방향·검증 기준이 0자로 주입됐다(초안 자체 헤딩이 절 경계를
// 침범 + "초안" 배제 토큰으로 후보 제외).
describe("assemblePlan — 초안 내부 헤딩 강등 (§50 후속)", () => {
  it("자체 ## 헤딩을 가진 초안도 세 절 모두 비영(non-zero)으로 파싱된다", async () => {
    let iv = newInterview("목표", []);
    iv = applyRoleResult(iv, "planning", { questions: [], draft: "## §핵심 결정 사항 표\n\n| ID | 결정 |\n|---|---|\n| D1 | 유지 |" }, NOW);
    iv = applyRoleResult(iv, "development", { questions: [], draft: "## §개발 방향 초안\n\n- 진입: src/kafka" }, NOW);
    iv = applyRoleResult(iv, "evaluation", { questions: [], draft: "## §검증 기준 초안\n\n- 스냅샷 통과" }, NOW);
    iv = approveInterview(iv, { force: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-iv-demote-"));
    try {
      fs.writeFileSync(path.join(dir, "PLAN.md"), assemblePlan(iv));
      const { readPlanContext } = await import("../src/plan.js");
      const ctx = readPlanContext(dir);
      expect(ctx.decisions ?? "").toContain("D1");
      expect(ctx.architecture ?? "").toContain("src/kafka");
      expect(ctx.acceptance ?? "").toContain("스냅샷 통과");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// §53 실측(z-parse) — 이의 라운드 7차·이의 32건·비용 최대 동인. 상한으로 수렴을 보장한다.
describe("이의 라운드 상한 — §53", () => {
  function roundTrip(iv: InterviewState, n: number): InterviewState {
    // 이의 1건 → 대상 재작성 → 반복 (라운드 n회)
    for (let i = 0; i < n; i++) {
      iv = applyObjections(iv, [{ from_role: "evaluation", to_role: "planning", detail: `이의 ${i}` }], NOW, 3);
      iv = applyRoleResult(iv, "planning", { questions: [], draft: `수정 ${i}` }, NOW);
    }
    return iv;
  }
  function fullDrafts(): InterviewState {
    let iv = newInterview("목표", []);
    for (const role of INTERVIEW_ROLES) iv = applyRoleResult(iv, role, { questions: [], draft: "d" }, NOW);
    return iv;
  }

  it("상한 미만이면 이의 라운드를 계속 돌린다", () => {
    const iv = roundTrip(fullDrafts(), MAX_OBJECTION_ROUNDS - 1);
    expect(interviewNext(iv)).toEqual({ kind: "run_objections" });
  });

  it("상한 도달 시 새 라운드 대신 사람에게 넘긴다 (objection_cap)", () => {
    const iv = roundTrip(fullDrafts(), MAX_OBJECTION_ROUNDS);
    expect(interviewNext(iv)).toEqual({ kind: "objection_cap", rounds: MAX_OBJECTION_ROUNDS });
    // 이 상태에서 force 승인이 가능하다 — §50 이 설계된 출구
    expect(approveInterview(iv, { force: true }).status).toBe("approved");
  });

  it("상한 도달 후에도 미답 질문이 생기면 사람 답변이 우선한다", () => {
    let iv = roundTrip(fullDrafts(), MAX_OBJECTION_ROUNDS);
    iv = applyRoleResult(iv, "planning", { questions: [{ question: "q?" }], draft: null }, NOW);
    expect(interviewNext(iv).kind).toBe("await_answers");
  });

  it("클린 통과는 상한과 무관하게 ready", () => {
    let iv = roundTrip(fullDrafts(), MAX_OBJECTION_ROUNDS - 1);
    iv = applyObjections(iv, [], NOW, 3);
    expect(interviewNext(iv)).toEqual({ kind: "ready" });
  });

  it("마지막 라운드 프롬프트가 '마지막' 임과 비차단 규칙을 명시한다", () => {
    const iv = roundTrip(fullDrafts(), MAX_OBJECTION_ROUNDS - 1);
    const p = buildObjectionPrompt(iv, "planning");
    expect(p).toContain("마지막 이의 라운드");
    expect(p).toContain("(비차단)");
  });

  it("재작성된 초안 목록을 프롬프트에 알려 불변 초안 재심을 금지한다", () => {
    const iv = roundTrip(fullDrafts(), 1);
    const p = buildObjectionPrompt(iv, "development");
    expect(p).toContain("재작성된 초안: 기획");
    expect(p).toContain("재심 금지");
  });

  it("첫 라운드에는 재작성 안내가 없다", () => {
    const p = buildObjectionPrompt(fullDrafts(), "planning");
    expect(p).not.toContain("재작성된 초안:");
    expect(p).toContain("1/" + String(MAX_OBJECTION_ROUNDS));
  });
});

// §62 실측 — h1 초안 제목이 §50 후속의 #{2,5} 강등을 빠져나가 h2 절을 종료시켰다(검증 기준
// 0자 재발). 모든 초안 헤딩은 최소 h3 가 되어야 한다.
describe("assemblePlan — h1 초안 헤딩 강등 (§62)", () => {
  it("h1 제목을 가진 초안도 세 절 모두 비영으로 파싱된다", async () => {
    let iv = newInterview("목표", []);
    iv = applyRoleResult(iv, "planning", { questions: [], draft: "# 기획 계획서\n\n| ID | 결정 |\n|---|---|\n| D1 | 유지 |" }, NOW);
    iv = applyRoleResult(iv, "development", { questions: [], draft: "# 개발 계획서\n\n- 진입: src/x.ts" }, NOW);
    iv = applyRoleResult(iv, "evaluation", { questions: [], draft: "# 평가 계획서\n\n### 자동 게이트\n- npm test 통과" }, NOW);
    iv = approveInterview(iv, { force: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-iv-h1-"));
    try {
      fs.writeFileSync(path.join(dir, "PLAN.md"), assemblePlan(iv));
      const { readPlanContext } = await import("../src/plan.js");
      const ctx = readPlanContext(dir);
      expect(ctx.decisions ?? "").toContain("D1");
      expect(ctx.architecture ?? "").toContain("src/x.ts");
      expect(ctx.acceptance ?? "").toContain("npm test 통과");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// §67 — PLAN §용어 표를 채우는 주체가 없어 §28 3절 주입 중 §용어가 구조적으로 항상 0자였다
// (tamper-gap 사이클 doctor 경고 실측, 사람이 수동으로 메움). 기획 역할이 glossary 를 초안과
// 함께 반환하면 §48(entry_paths)과 같은 패턴으로 승격 → assemblePlan 이 표로 렌더한다.
describe("glossary — §67 용어 승격·조립", () => {
  const G = [{ term: "tamper", definition: "세션이 guarded 파일을 실제로 변경한 것", avoid: "위조 의심" }];

  it("기획 역할의 glossary 는 질문과 함께 와도 승격된다 (§48 계보 — 조기 반환 앞)", () => {
    let iv = newInterview("목표", []);
    iv = applyRoleResult(iv, "planning", { questions: [{ question: "q?" }], draft: null, glossary: G }, NOW);
    expect(iv.glossary).toHaveLength(1);
    expect(iv.glossary[0]!.term).toBe("tamper");
  });

  it("개발/평가 역할의 glossary 는 무시된다 (소유 경계는 하네스가 지킨다)", () => {
    let iv = newInterview("목표", []);
    iv = applyRoleResult(iv, "development", { questions: [], draft: "d", glossary: G }, NOW);
    iv = applyRoleResult(iv, "evaluation", { questions: [], draft: "e", glossary: G }, NOW);
    expect(iv.glossary).toHaveLength(0);
  });

  it("sanitize: 빈 term/definition 제거, 개수 상한, 파이프·개행 무해화 (§62 표 깨짐 방지)", () => {
    let iv = newInterview("목표", []);
    const many = Array.from({ length: 25 }, (_, i) => ({ term: `t${i}`, definition: `d${i}` }));
    iv = applyRoleResult(iv, "planning", {
      questions: [], draft: "p",
      glossary: [
        { term: "  ", definition: "정의 있음" },          // term 없음 → 제거
        { term: "이름만", definition: "   " },             // definition 없음 → 제거
        { term: "a|b\nc", definition: "d|e" },             // 구조 문자 무해화
        ...many,
      ],
    }, NOW);
    expect(iv.glossary).toHaveLength(MAX_GLOSSARY_TERMS);
    expect(iv.glossary[0]!.term).toBe("a/b c");
    expect(iv.glossary[0]!.definition).toBe("d/e");
  });

  it("assemblePlan 렌더 → §28 파서(readPlanContext)가 §용어를 0자 아닌 주입으로 읽는다 (§50 계보 통합)", async () => {
    let iv = newInterview("목표", []);
    iv = applyRoleResult(iv, "planning", {
      questions: [], draft: "| ID | 결정 | 근거 | 상태 | 날짜 |\n|----|------|------|------|------|\n| D1 | x | y | accepted | 2026-08-31 |",
      glossary: G,
    }, NOW);
    iv = applyRoleResult(iv, "development", { questions: [], draft: "- 진입" }, NOW);
    iv = applyRoleResult(iv, "evaluation", { questions: [], draft: "- 게이트" }, NOW);
    iv = applyObjections(iv, [], NOW, 3);
    iv = approveInterview(iv);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-iv-gloss-"));
    try {
      fs.writeFileSync(path.join(dir, "PLAN.md"), assemblePlan(iv));
      const { readPlanContext } = await import("../src/plan.js");
      const ctx = readPlanContext(dir);
      expect(ctx.glossary).toContain("tamper");
      expect(ctx.glossary).toContain("guarded 파일을 실제로 변경");
      expect(ctx.diagnostics?.glossaryChars ?? 0).toBeGreaterThan(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("최신 기획 반환이 이전 glossary 를 통째로 대체한다 (재작성 초안의 용어가 현행)", () => {
    let iv = newInterview("목표", []);
    iv = applyRoleResult(iv, "planning", { questions: [], draft: "v1", glossary: G }, NOW);
    iv = applyRoleResult(iv, "planning", {
      questions: [], draft: "v2",
      glossary: [{ term: "새용어", definition: "새정의" }],
    }, NOW);
    expect(iv.glossary).toHaveLength(1);
    expect(iv.glossary[0]!.term).toBe("새용어");
  });
});

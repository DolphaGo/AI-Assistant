import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runWorkflow, defaultHeadSha, defaultVerifyCommit, defaultChangedFiles, type OrchestratorDeps, runVerificationStage } from "../src/orchestrator.js";
import { StateSchema, saveState, loadState, answerQuestion, totalCostUsd, type State } from "../src/state.js";
import type { SessionRunner, PhaseSessionResult, PhaseSessionRequest, FixPromptInput } from "../src/session.js";
import type { GateResult } from "../src/gate.js";
import type { PrClient, PrRef, PrView, RawComment } from "../src/pr.js";
import { record1, toZStdout } from "./helpers/porcelain-v2.js";

let dir: string;

// issue #4: fix 세션 결과의 항목별 보고(addressed) — 스텁 공통 값.
const ADDR = [{ item: "지적 1", status: "applied" as const, evidence: "src/a.ts:10" }];

function makeState(overrides: Partial<State> = {}): State {
  return StateSchema.parse({
    schema_version: 1, workflow: "wf", repo_root: dir, branch_strategy: "topic",
    // §26 I5 잔여 승격: assertRunnable 이 이제 verify 명령을 린트한다 — 이 파일의 gate 는
    // stub(passGate/failGate)이라 명령 문자열이 실제로 실행되지는 않지만, assertRunnable 이
    // 문자열 자체를 검사하므로 lint 를 통과하는 값이어야 한다("true" 는 이제 error). "npm test" 는
    // lint 는 통과하지만 §24 S1 verify 위조 가드(verifyReferencedFiles)가 첫 토큰 "npm" 을 보고
    // package.json 을 가드 대상으로 잡아버려, headSha 를 override 하는 다른 테스트들(§24 S1/§26
    // C3 describe 블록)의 전제를 조용히 바꿔버린다 — "git --version" 은 lint 도 통과하고 이 가드가
    // 아는 어떤 패턴에도 걸리지 않아(guardedFiles: []) 기존 "true" 와 동일하게 가드를 건드리지 않는다.
    allow_push: false, verify_default: ["git --version"], status: "running",
    pending_question: null, answers: [],
    phases: [
      { id: 1, title: "p1", status: "pending", depends_on: [], verify: [], attempts: 0, max_attempts: 2, sessions: [] },
      { id: 2, title: "p2", status: "pending", depends_on: [1], verify: [], attempts: 0, max_attempts: 2, sessions: [] },
    ],
    ...overrides,
  });
}

// HANDOFF 갱신 체크를 통과시키기 위해 스텁 runner 가 HANDOFF.md 를 다시 쓴다
function touchHandoff() {
  fs.writeFileSync(path.join(dir, "HANDOFF.md"), `updated ${Math.random()}`);
}

function stubRunner(script: Array<PhaseSessionResult | "touch-and-done">): SessionRunner {
  let i = 0;
  return {
    async runPhase(_req: PhaseSessionRequest) {
      const step = script[i++];
      if (step === "touch-and-done") {
        touchHandoff();
        return { status: "done" as const, summary: "ok", commits: ["abc"], sessionId: `s${i}` };
      }
      if (step.status === "done") touchHandoff();
      return step;
    },
    async runVerifyAgent() { return { status: "done", summary: "이상 없음", commits: [] }; },
    async runFixSession() { return { status: "done", summary: "stub", commits: [] }; },
  };
}

const passGate = async (): Promise<GateResult> => ({ passed: true, results: [] });
const failGate = async (): Promise<GateResult> =>
  ({ passed: false, results: [{ command: "false", exitCode: 1, signal: null, output: "boom", fatal: false, timedOut: false }] });

function deps(runner: SessionRunner, gate = passGate): OrchestratorDeps & { notes: string[] } {
  const notes: string[] = [];
  return {
    runner, gate,
    notify: (t, m) => notes.push(`${t}: ${m}`),
    now: () => "2026-08-26T00:00:00Z",
    log: () => {},
    // 기존 테스트는 실제 git 저장소가 아니므로, 실재 검증기를 그대로 쓰면 "abc" 같은 가짜
    // SHA 가 전부 없다고 판정돼 무한 회송된다. 커밋 검증 자체를 다루는 테스트만 override 한다.
    verifyCommit: async () => ({ ok: true }),
    // 실제 git 저장소가 아니므로 기본 headSha(실제 git rev-parse) 를 그대로 쓰면 매 시도마다
    // 불필요한 프로세스를 스폰한다 — HEAD 우회 차단(§25 과제2) 자체를 다루는 테스트만 override.
    headSha: async () => null,
    // §19: 프리플라이트/브랜치 격리가 기본 git CLI 를 그대로 쓰면 이 tmpdir 은 실제 저장소가
    // 아니므로 매번 "git 저장소가 아닙니다" 로 FAILED 정지한다(그리고 pr_mode 테스트는 실제
    // `gh auth status` 를 호출해 네트워크 대기로 타임아웃난다). "깨끗한 저장소, base_branch 와
    // 다른 브랜치"를 흉내내는 스텁을 기본으로 깔아둔다 — 프리플라이트/브랜치 전략 자체를 다루는
    // 테스트만 override 한다.
    git: async () => ({ ok: true, stdout: "", stderr: "" }),
    gh: async () => ({ ok: true, stdout: "", stderr: "" }),
    // §26 C2: 커밋의 작업 브랜치 도달성 검사도 기본은 실제 git(merge-base --is-ancestor) 을 쓴다 —
    // 이 tmpdir 은 실제 저장소가 아니므로 브랜치 격리/도달성 자체를 다루는 테스트만 override 한다.
    branchReachable: async () => ({ ok: true }),
    notes,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-orch-"));
  fs.writeFileSync(path.join(dir, "HANDOFF.md"), "initial");
});

describe("runWorkflow", () => {
  it("두 phase 를 완주하고 verify 보고서를 남기고 done", async () => {
    saveState(dir, makeState());
    const d = deps(stubRunner(["touch-and-done", "touch-and-done"]));
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    expect(s.phases.every(p => p.status === "done")).toBe(true);
    expect(fs.readFileSync(path.join(dir, "VERIFY.md"), "utf-8")).toContain("이상 없음");
    expect(d.notes.some(n => n.includes("완료"))).toBe(true);
  });

  it("blocked 결과 시 질문 기록·알림·정지하고 attempt 를 소모하지 않는다", async () => {
    saveState(dir, makeState());
    const d = deps(stubRunner([{ status: "blocked", summary: "질문", question: "A or B?", commits: [] }]));
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("blocked");
    expect(s.pending_question?.question).toBe("A or B?");
    expect(s.phases[0].status).toBe("blocked");
    expect(s.phases[0].attempts).toBe(0); // blocked 는 실패가 아님
    expect(d.notes.some(n => n.includes("BLOCKED"))).toBe(true);
    // 디스크에도 반영됨
    expect(loadState(dir).status).toBe("blocked");
  });

  it("검증 실패 → fix 재시도로 성공한다", async () => {
    saveState(dir, makeState({ phases: [makeState().phases[0]] }));
    let calls = 0;
    const gate = async (): Promise<GateResult> => (++calls === 1 ? failGate() : passGate());
    const d = deps(stubRunner(["touch-and-done", "touch-and-done"]), gate);
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    expect(s.phases[0].attempts).toBe(2);
  });

  it("재시도 소진 시 FAILED 정지 + 알림", async () => {
    saveState(dir, makeState({ phases: [makeState().phases[0]] }));
    const d = deps(stubRunner(["touch-and-done", "touch-and-done"]), failGate);
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("failed");
    expect(s.phases[0].status).toBe("failed");
    expect(d.notes.some(n => n.includes("FAILED"))).toBe(true);
  });

  it("검증 명령 자체 오류(fatal)는 재시도 없이 즉시 FAILED", async () => {
    saveState(dir, makeState({ phases: [makeState().phases[0]] }));
    const gate = async (): Promise<GateResult> =>
      ({ passed: false, results: [{ command: "nope", exitCode: 127, signal: null, output: "command not found", fatal: true, timedOut: false }] });
    const d = deps(stubRunner(["touch-and-done", "touch-and-done"]), gate);
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("failed");
    expect(s.phases[0].attempts).toBe(1); // 두 번째 시도 없음
  });

  it("blocked 상태로 시작하면 아무것도 하지 않는다", async () => {
    const st = makeState({ status: "blocked", pending_question: { phase: 1, question: "?", asked_at: "t" } });
    saveState(dir, st);
    const d = deps(stubRunner([]));
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("blocked");
  });

  it("verify 단계에서 예외가 나도 done + 완료 알림은 보장된다", async () => {
    saveState(dir, makeState({ phases: [makeState().phases[0]] }));
    const runner: SessionRunner = {
      async runPhase() {
        touchHandoff();
        return { status: "done", summary: "ok", commits: ["abc"], sessionId: "s1" };
      },
      async runVerifyAgent() {
        throw new Error("verify 보고서 작성 실패");
      },
      async runFixSession() { return { status: "done", summary: "stub", commits: [] }; },
    };
    const d = deps(runner);
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    expect(d.notes.some(n => n.includes("완료"))).toBe(true);
    expect(loadState(dir).status).toBe("done");
    // §41 I-1 후속: runner.runVerifyAgent 가 (계약을 어기고) throw 하면 결과 객체 자체를 얻지
    // 못하므로 phase.sessions 에 verify 세션을 추가로 남기지 않는다 — "실패해도 done 판정은
    // 막지 않는다"와 "없는 결과를 지어내 STATE 에 남기지 않는다"(§30 P4) 둘 다 만족해야 한다.
    expect(s.phases[0].sessions).toHaveLength(1);
    expect(s.phases[0].sessions.some(sess => sess.kind === "verify")).toBe(false);
  });

  // §43 — 세션이 낸 findings 가 STATE 에 실제로 기록되는가. report.ts 단위 테스트는 STATE 를
  // 직접 만들어 검증하므로 **이 배선이 빠져도 잡지 못한다**(실측: orchestrator 의
  // `findings: result.findings` 를 지워도 1372건이 전부 통과했다 — §30 P1 이 내 작업에서
  // 재발한 것). 배선 자체를 못박는 테스트가 반드시 따로 있어야 한다.
  it("phase 세션의 findings 가 STATE 에 기록된다", async () => {
    saveState(dir, makeState({ phases: [makeState().phases[0]] }));
    const runner: SessionRunner = {
      async runPhase() {
        touchHandoff();
        return {
          status: "done", summary: "ok", commits: ["abc"], sessionId: "s1",
          findings: [{ kind: "bug" as const, detail: "널 헤더에서 NPE" }],
        };
      },
      async runVerifyAgent() { return { status: "done", summary: "이상 없음", commits: [] }; },
      async runFixSession() { return { status: "done", summary: "stub", commits: [] }; },
    };
    const s = await runWorkflow(dir, deps(runner));
    const phaseSession = s.phases[0].sessions.find(x => x.kind === "phase")!;
    expect(phaseSession.findings).toEqual([{ kind: "bug", detail: "널 헤더에서 NPE" }]);
    // 디스크에도 영속돼야 한다 — 아침에 `fw report` 로 읽는 게 목적이다.
    expect(loadState(dir).phases[0].sessions.find(x => x.kind === "phase")!.findings).toHaveLength(1);
  });

  it("findings 는 게이트 판정에 영향을 주지 않는다 — 발견을 남겨도 done 은 done", async () => {
    saveState(dir, makeState({ phases: [makeState().phases[0]] }));
    const runner: SessionRunner = {
      async runPhase() {
        touchHandoff();
        return {
          status: "done", summary: "ok", commits: ["abc"], sessionId: "s1",
          findings: [{ kind: "plan_change" as const, detail: "Phase 3 을 쪼개야 함" }],
        };
      },
      async runVerifyAgent() { return { status: "done", summary: "ok", commits: [] }; },
      async runFixSession() { return { status: "done", summary: "stub", commits: [] }; },
    };
    const s = await runWorkflow(dir, deps(runner));
    expect(s.status).toBe("done");
    expect(s.phases[0].status).toBe("done");
  });

  // §45 — 적대적 3역할 검증. PLAN 에 절이 있으면 해당 역할이 돌고, 각 세션이 STATE 에 남는다.
  it("PLAN 에 3절이 있으면 3역할 verify 가 돌고 VERIFY.md 가 역할별로 구분된다", async () => {
    saveState(dir, makeState({ phases: [makeState().phases[0]] }));
    fs.writeFileSync(
      path.join(dir, "PLAN.md"),
      "# P\n\n## 핵심 결정 사항\n\n| ID | 결정 |\n|---|---|\n| D1 | 그대로 |\n\n## 개발 방향\n\n- 진입: src/a.ts\n\n## 검증 기준\n\n- 기존 테스트 통과\n",
    );
    const rolesSeen: Array<string | undefined> = [];
    const runner: SessionRunner = {
      async runPhase() {
        touchHandoff();
        return { status: "done", summary: "ok", commits: ["abc"], sessionId: "s1" };
      },
      async runVerifyAgent(_dir, _policy, role) {
        rolesSeen.push(role);
        return { status: "done", summary: `${role} 보고: 이상 없음`, commits: [], costUsd: 0.1 };
      },
      async runFixSession() { return { status: "done", summary: "stub", commits: [] }; },
    };
    const s = await runWorkflow(dir, deps(runner));
    expect(s.status).toBe("done");
    expect(rolesSeen).toEqual(["evaluation", "planning", "development"]);
    const verifySessions = s.phases[0].sessions.filter(x => x.kind === "verify");
    expect(verifySessions).toHaveLength(3);
    const verifyMd = fs.readFileSync(path.join(dir, "VERIFY.md"), "utf-8");
    expect(verifyMd).toContain("## 평가 검증");
    expect(verifyMd).toContain("## 기획 검증");
    expect(verifyMd).toContain("## 개발 검증");
  });

  it("비용 상한 도달 시 남은 verify 역할을 생략하되 생략 사실을 VERIFY.md 에 남긴다 (§27 O2/§30 P4)", async () => {
    const base = makeState({ phases: [makeState().phases[0]] });
    base.max_cost_usd = 5;
    saveState(dir, base);
    fs.writeFileSync(
      path.join(dir, "PLAN.md"),
      "# P\n\n## 핵심 결정 사항\n\n| ID | 결정 |\n|---|---|\n| D1 | 그대로 |\n\n## 개발 방향\n\n- 진입: src/a.ts\n",
    );
    let verifyCalls = 0;
    const runner: SessionRunner = {
      async runPhase() {
        touchHandoff();
        // phase 세션이 이미 상한 직전까지 씀 → 첫 verify(4.9+0.2=5.1)가 상한을 넘긴다
        return { status: "done", summary: "ok", commits: ["abc"], sessionId: "s1", costUsd: 4.9 };
      },
      async runVerifyAgent() {
        verifyCalls++;
        return { status: "done", summary: "이상 없음", commits: [], costUsd: 0.2 };
      },
      async runFixSession() { return { status: "done", summary: "stub", commits: [] }; },
    };
    const s = await runWorkflow(dir, deps(runner));
    expect(s.status).toBe("done"); // 상한 도달이 done 을 되돌리지 않는다 (§30 P2)
    expect(verifyCalls).toBe(1); // evaluation 만 돌고 planning/development 는 생략
    const verifyMd = fs.readFileSync(path.join(dir, "VERIFY.md"), "utf-8");
    expect(verifyMd).toContain("기획 검증 — 생략됨");
    expect(verifyMd).toContain("개발 검증 — 생략됨");
    expect(verifyMd).toContain("비용 상한");
  });

  // §47 — 합의 단계. 역할 2개 이상 + runner 가 runConsensus 를 구현했을 때만 돈다.
  it("다역할 verify 후 합의 세션이 돌고 합의문·다음 목표 제안이 기록된다", async () => {
    saveState(dir, makeState({ phases: [makeState().phases[0]] }));
    fs.writeFileSync(
      path.join(dir, "PLAN.md"),
      "# P\n\n## 핵심 결정 사항\n\n| ID | 결정 |\n|---|---|\n| D1 | 그대로 |\n\n## 개발 방향\n\n- 진입: src/a.ts\n",
    );
    let consensusReports: unknown = null;
    const runner: SessionRunner = {
      async runPhase() {
        touchHandoff();
        return { status: "done", summary: "ok", commits: ["abc"], sessionId: "s1" };
      },
      async runVerifyAgent(_d, _p, role) {
        return { status: "done", summary: `${role} 보고`, commits: [], costUsd: 0.1 };
      },
      async runFixSession() { return { status: "done", summary: "stub", commits: [] }; },
      async runConsensus(_d, _p, reports) {
        consensusReports = reports;
        return { summary: "### 합의된 완료\n- 전부", nextGoals: ["다음: 회귀 테스트 보강"], sessionId: "c1", costUsd: 0.3 };
      },
    };
    const s = await runWorkflow(dir, deps(runner));
    expect(s.status).toBe("done");
    // 합의 세션이 세 역할의 보고서를 받았다
    expect((consensusReports as Array<{ role: string }>).map(r => r.role)).toEqual(["evaluation", "planning", "development"]);
    // STATE 에 consensus 세션과 다음 목표 제안이 남았다
    const consensusSessions = s.phases[0].sessions.filter(x => x.kind === "consensus");
    expect(consensusSessions).toHaveLength(1);
    expect(consensusSessions[0]).toMatchObject({ session_id: "c1", cost_usd: 0.3, result: "done" });
    expect(s.next_goal_suggestions).toEqual(["다음: 회귀 테스트 보강"]);
    expect(loadState(dir).next_goal_suggestions).toEqual(["다음: 회귀 테스트 보강"]); // 디스크 영속
    // VERIFY.md 에 합의 절
    expect(fs.readFileSync(path.join(dir, "VERIFY.md"), "utf-8")).toContain("## 합의");
  });

  it("runner 에 runConsensus 가 없으면(레거시 스텁) 합의 없이 기존과 동일하게 완주한다", async () => {
    saveState(dir, makeState({ phases: [makeState().phases[0]] }));
    fs.writeFileSync(
      path.join(dir, "PLAN.md"),
      "# P\n\n## 핵심 결정 사항\n\n| ID | 결정 |\n|---|---|\n| D1 | 그대로 |\n\n## 개발 방향\n\n- 진입: src/a.ts\n",
    );
    const runner: SessionRunner = {
      async runPhase() {
        touchHandoff();
        return { status: "done", summary: "ok", commits: ["abc"], sessionId: "s1" };
      },
      async runVerifyAgent(_d, _p, role) { return { status: "done", summary: `${role} 보고`, commits: [] }; },
      async runFixSession() { return { status: "done", summary: "stub", commits: [] }; },
    };
    const s = await runWorkflow(dir, deps(runner));
    expect(s.status).toBe("done");
    expect(s.phases[0].sessions.some(x => x.kind === "consensus")).toBe(false);
    expect(fs.readFileSync(path.join(dir, "VERIFY.md"), "utf-8")).not.toContain("## 합의");
  });

  it("합의 세션 실패(null summary)는 실패로 기록하되 done 을 막지 않는다 (§30 P2)", async () => {
    saveState(dir, makeState({ phases: [makeState().phases[0]] }));
    fs.writeFileSync(
      path.join(dir, "PLAN.md"),
      "# P\n\n## 핵심 결정 사항\n\n| ID | 결정 |\n|---|---|\n| D1 | 그대로 |\n\n## 개발 방향\n\n- 진입: src/a.ts\n",
    );
    const runner: SessionRunner = {
      async runPhase() {
        touchHandoff();
        return { status: "done", summary: "ok", commits: ["abc"], sessionId: "s1" };
      },
      async runVerifyAgent(_d, _p, role) { return { status: "done", summary: `${role} 보고`, commits: [] }; },
      async runFixSession() { return { status: "done", summary: "stub", commits: [] }; },
      async runConsensus() { return { summary: null, nextGoals: [] }; },
    };
    const s = await runWorkflow(dir, deps(runner));
    expect(s.status).toBe("done");
    const cs = s.phases[0].sessions.find(x => x.kind === "consensus")!;
    expect(cs.result).toBe("failed");
    expect(s.next_goal_suggestions).toBeUndefined();
    expect(fs.readFileSync(path.join(dir, "VERIFY.md"), "utf-8")).toContain("## 합의 — 실패");
  });

  it("PLAN 에 절이 없으면(레거시) evaluation 1역할 + VERIFY.md 원문 그대로 — 기존 계약 유지", async () => {
    saveState(dir, makeState({ phases: [makeState().phases[0]] }));
    // PLAN.md 자체를 만들지 않는다 — 레거시 워크플로우
    const rolesSeen: Array<string | undefined> = [];
    const runner: SessionRunner = {
      async runPhase() {
        touchHandoff();
        return { status: "done", summary: "ok", commits: ["abc"], sessionId: "s1" };
      },
      async runVerifyAgent(_dir, _policy, role) {
        rolesSeen.push(role);
        return { status: "done", summary: "# 검증 보고\n이상 없음", commits: [] };
      },
      async runFixSession() { return { status: "done", summary: "stub", commits: [] }; },
    };
    await runWorkflow(dir, deps(runner));
    expect(rolesSeen).toEqual(["evaluation"]);
    expect(fs.readFileSync(path.join(dir, "VERIFY.md"), "utf-8")).toBe("# 검증 보고\n이상 없음");
  });

  it("done 상태로 시작하면 아무것도 하지 않는다 (verify 재실행/알림 재발 방지)", async () => {
    saveState(dir, makeState({ status: "done" }));
    let verifyCalls = 0;
    const runner: SessionRunner = {
      async runPhase() {
        throw new Error("호출되면 안 됨");
      },
      async runVerifyAgent() {
        verifyCalls++;
        return { status: "done", summary: "이상 없음", commits: [] };
      },
      async runFixSession() { return { status: "done", summary: "stub", commits: [] }; },
    };
    const d = deps(runner);
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    expect(verifyCalls).toBe(0);
    expect(d.notes.length).toBe(0);
  });

  it("검증 실패 fixContext 에 전체 로그 경로가 포함된다", async () => {
    saveState(dir, makeState({ phases: [makeState().phases[0]] }));
    const fixContexts: Array<string | undefined> = [];
    const runner: SessionRunner = {
      async runPhase(req) {
        fixContexts.push(req.fixContext);
        touchHandoff();
        return { status: "done", summary: "ok", commits: ["abc"], sessionId: `s${fixContexts.length}` };
      },
      async runVerifyAgent() { return { status: "done", summary: "이상 없음", commits: [] }; },
      async runFixSession() { return { status: "done", summary: "stub", commits: [] }; },
    };
    let gateCalls = 0;
    const gate = async (): Promise<GateResult> => (++gateCalls === 1 ? failGate() : passGate());
    const d = deps(runner, gate);
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    expect(fixContexts[1]).toContain(path.join(dir, "logs", "phase-1-attempt-1.log"));
  });
});

describe("커밋 존재 게이트 (mtime 대체)", () => {
  it("커밋이 없으면 done 이어도 재시도로 회송한다", async () => {
    saveState(dir, makeState({ phases: [makeState().phases[0]] }));
    let call = 0;
    const runner: SessionRunner = {
      async runPhase() {
        call++;
        // 1차: 커밋 없음 → 회송, 2차: 커밋 있음
        return { status: "done", summary: "ok", commits: call === 1 ? [] : ["abc123"], sessionId: `s${call}` };
      },
      async runFixSession() { return { status: "done", summary: "x", commits: ["c"], addressed: ADDR }; },
      async runVerifyAgent() { return { status: "done", summary: "이상 없음", commits: [] }; },
    };
    const d = { ...deps(runner), verifyCommit: async () => ({ ok: true }) };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    expect(s.phases[0].attempts).toBe(2);
  });

  it("세션이 존재하지 않는 SHA 를 보고하면 회송한다 (거짓 보고 방지)", async () => {
    saveState(dir, makeState({ phases: [makeState().phases[0]] }));
    let call = 0;
    const runner: SessionRunner = {
      async runPhase() { call++; return { status: "done", summary: "ok", commits: ["deadbeef"], sessionId: `s${call}` }; },
      async runFixSession() { return { status: "done", summary: "x", commits: ["c"], addressed: ADDR }; },
      async runVerifyAgent() { return { status: "done", summary: "이상 없음", commits: [] }; },
    };
    // 첫 SHA 는 없다고, 두 번째부터 있다고 응답
    const d = { ...deps(runner), verifyCommit: async () => ({ ok: call >= 2 }) };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    expect(s.phases[0].attempts).toBe(2);
  });

  it("HANDOFF.md 를 touch 하지 않아도 커밋만 실재하면 통과한다 (mtime 의존 제거 확인)", async () => {
    saveState(dir, makeState({ phases: [makeState().phases[0]] }));
    // HANDOFF.md 를 아예 만들지 않는다 — 옛 게이트라면 여기서 무한 회송했다
    const runner: SessionRunner = {
      async runPhase() { return { status: "done", summary: "ok", commits: ["abc123"], sessionId: "s1" }; },
      async runFixSession() { return { status: "done", summary: "x", commits: ["c"], addressed: ADDR }; },
      async runVerifyAgent() { return { status: "done", summary: "이상 없음", commits: [] }; },
    };
    const d = { ...deps(runner), verifyCommit: async () => ({ ok: true }) };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    expect(s.phases[0].attempts).toBe(1); // 첫 시도에 통과
  });
});

describe("커밋 게이트 — 'HEAD' 우회 차단 (§25 과제2: headBefore 이후 커밋인지 검증)", () => {
  it("세션이 headBefore 와 동일한 sha('HEAD' 등)를 보고하면 회송하고, 실제 새 sha 를 보고하면 통과한다", async () => {
    saveState(dir, makeState({ phases: [makeState().phases[0]] }));
    let call = 0;
    const runner: SessionRunner = {
      async runPhase() {
        call++;
        // 1차: 아무 일도 안 하고 직전 HEAD 를 그대로 보고 (우회 시도), 2차: 진짜 새 sha
        return { status: "done", summary: "ok", commits: [call === 1 ? "head0" : "newsha1"], sessionId: `s${call}` };
      },
      async runFixSession() { return { status: "done", summary: "x", commits: ["c"], addressed: ADDR }; },
      async runVerifyAgent() { return { status: "done", summary: "이상 없음", commits: [] }; },
    };
    const d = {
      ...deps(runner),
      headSha: async () => "head0",
      // 실제 defaultVerifyCommit 과 동일한 ancestry 계약을 흉내낸다: sha 가 headBefore 와 같으면 거부
      verifyCommit: async (_cwd: string, sha: string, headBefore: string | null) => ({ ok: sha !== headBefore }),
    };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    expect(s.phases[0].attempts).toBe(2); // 1차는 HEAD 그대로라 회송, 2차에 통과
  });

  it("verifyCommit 은 세션 실행 전에 캡처된 headBefore 를 정확히 전달받는다", async () => {
    saveState(dir, makeState({ phases: [makeState().phases[0]] }));
    const seenHeadBefore: Array<string | null> = [];
    const runner: SessionRunner = {
      async runPhase() { return { status: "done", summary: "ok", commits: ["newsha"], sessionId: "s1" }; },
      async runFixSession() { return { status: "done", summary: "x", commits: ["c"], addressed: ADDR }; },
      async runVerifyAgent() { return { status: "done", summary: "이상 없음", commits: [] }; },
    };
    const d = {
      ...deps(runner),
      headSha: async () => "abc-head",
      verifyCommit: async (_cwd: string, sha: string, headBefore: string | null) => {
        seenHeadBefore.push(headBefore);
        return { ok: true };
      },
    };
    await runWorkflow(dir, d);
    expect(seenHeadBefore).toEqual(["abc-head"]);
  });

  it("commits:['HEAD'] 를 반환하는 세션은 회송되고, max_attempts 를 소진하면 FAILED 로 정지한다", async () => {
    saveState(dir, makeState({ phases: [makeState().phases[0]] }));
    const runner: SessionRunner = {
      // 매번 headBefore 와 동일한 sha 를 보고 — 아무 것도 안 하고 "HEAD" 로 우회를 계속 시도
      async runPhase() { return { status: "done", summary: "아무 것도 안 함", commits: ["HEAD"], sessionId: "s" }; },
      async runFixSession() { return { status: "done", summary: "x", commits: ["c"], addressed: ADDR }; },
      async runVerifyAgent() { return { status: "done", summary: "이상 없음", commits: [] }; },
    };
    const d = {
      ...deps(runner),
      headSha: async () => "HEAD", // 세션이 "HEAD" 라는 문자열 그대로를 SHA 로 보고한다고 가정
      verifyCommit: async (_cwd: string, sha: string, headBefore: string | null) => ({ ok: sha !== headBefore }),
    };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("failed");
    expect(s.phases[0].status).toBe("failed");
    expect(d.notes.some(n => n.includes("FAILED"))).toBe(true);
  });

  describe("defaultVerifyCommit / defaultHeadSha — 실제 git 저장소 (스텁 없이)", () => {
    it("세션이 아무 것도 안 하고 HEAD 를 그대로 보고하면 회송되고, 실제로 새 커밋을 만들면 통과한다", async () => {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      fs.writeFileSync(path.join(dir, ".gitignore"), "logs/\ndocs/*/logs/\n");
      execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
      fs.writeFileSync(path.join(dir, "a.txt"), "1");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });

      saveState(dir, makeState({ repo_root: dir, phases: [makeState().phases[0]] }));

      let call = 0;
      const runner: SessionRunner = {
        async runPhase() {
          call++;
          if (call === 1) {
            // 우회 시도: 아무 것도 안 하고 현재 HEAD 를 그대로 보고
            const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString().trim();
            return { status: "done", summary: "아무 것도 안 함", commits: [head], sessionId: "s1" };
          }
          // 2차: 실제로 새 커밋을 만든다
          fs.writeFileSync(path.join(dir, "b.txt"), "2");
          execFileSync("git", ["add", "."], { cwd: dir });
          execFileSync("git", ["commit", "-q", "-m", "real work"], { cwd: dir });
          const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString().trim();
          return { status: "done", summary: "실제로 작업함", commits: [head], sessionId: "s2" };
        },
        async runFixSession() { return { status: "done", summary: "x", commits: ["c"], addressed: ADDR }; },
        async runVerifyAgent() { return { status: "done", summary: "이상 없음", commits: [] }; },
      };
      // verifyCommit/headSha 를 override 하지 않고 실제 defaultVerifyCommit/defaultHeadSha 를 태운다
      const { verifyCommit: _vc, headSha: _hs, ...bareDeps } = deps(runner);
      const s = await runWorkflow(dir, bareDeps as OrchestratorDeps);
      expect(s.status).toBe("done");
      expect(s.phases[0].attempts).toBe(2); // 1차는 회송, 2차에 실제 커밋으로 통과
    });
  });
});

describe("defaultHeadSha (§25 과제2)", () => {
  let gitDir: string;
  beforeEach(() => {
    gitDir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-headsha-"));
  });

  it("실제 git 저장소면 HEAD 의 SHA 를 반환한다", async () => {
    execFileSync("git", ["init", "-q"], { cwd: gitDir });
      fs.writeFileSync(path.join(gitDir, ".gitignore"), "logs/\ndocs/*/logs/\n");
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: gitDir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: gitDir });
    fs.writeFileSync(path.join(gitDir, "a.txt"), "1");
    execFileSync("git", ["add", "."], { cwd: gitDir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: gitDir });
    const expected = execFileSync("git", ["rev-parse", "HEAD"], { cwd: gitDir }).toString().trim();
    expect(await defaultHeadSha(gitDir)).toBe(expected);
  });

  it("git 저장소가 아니면 null 을 반환한다 (오진단 대신 존재 검증 폴백의 전제)", async () => {
    expect(await defaultHeadSha(gitDir)).toBeNull();
  });
});

describe("defaultVerifyCommit — '커밋 없음' vs 'git 오류' 구분 (§25 과제2)", () => {
  let gitDir: string;
  let head: string;
  beforeEach(() => {
    gitDir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-verifycommit-"));
    execFileSync("git", ["init", "-q"], { cwd: gitDir });
      fs.writeFileSync(path.join(gitDir, ".gitignore"), "logs/\ndocs/*/logs/\n");
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: gitDir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: gitDir });
    fs.writeFileSync(path.join(gitDir, "a.txt"), "1");
    execFileSync("git", ["add", "."], { cwd: gitDir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: gitDir });
    head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: gitDir }).toString().trim();
  });

  it("실제로 존재하는 커밋은(headBefore 없음) 통과한다", async () => {
    expect(await defaultVerifyCommit(gitDir, head, null)).toEqual({ ok: true });
  });

  it("존재하지 않는 sha 는 '커밋 없음' 사유로 실패한다", async () => {
    const r = await defaultVerifyCommit(gitDir, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", null);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("존재하지 않는 커밋");
  });

  it("git 저장소가 아니면(리포 자체 오류) '커밋 없음'과는 다른 사유(git 오류)로 실패한다", async () => {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-notgit-"));
    const r = await defaultVerifyCommit(nonGitDir, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", null);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("git 오류");
    expect(r.reason).not.toContain("존재하지 않는 커밋");
  });

  it("sha 가 headBefore 와 같으면(신규 커밋 아님) 실패한다", async () => {
    const r = await defaultVerifyCommit(gitDir, head, head);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("이번 시도");
  });

  it("sha 가 headBefore 의 후손이면(실제 새 커밋) 통과한다", async () => {
    fs.writeFileSync(path.join(gitDir, "b.txt"), "2");
    execFileSync("git", ["add", "."], { cwd: gitDir });
    execFileSync("git", ["commit", "-q", "-m", "second"], { cwd: gitDir });
    const newHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: gitDir }).toString().trim();
    expect(await defaultVerifyCommit(gitDir, newHead, head)).toEqual({ ok: true });
  });

  it("sha 가 headBefore 의 후손이 아니면(과거/무관 커밋) 실패한다", async () => {
    fs.writeFileSync(path.join(gitDir, "b.txt"), "2");
    execFileSync("git", ["add", "."], { cwd: gitDir });
    execFileSync("git", ["commit", "-q", "-m", "second"], { cwd: gitDir });
    const newHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: gitDir }).toString().trim();
    // headBefore 로 newHead(더 나중 커밋)를 주고, sha 로 head(더 이전 커밋)를 보고 — 후손 관계 역전
    const r = await defaultVerifyCommit(gitDir, head, newHead);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("HEAD 의 후손이 아닙니다");
  });
});

describe("§24 감사 S1: verify 대상 파일 위조 차단 (게이트 실행 직전 무결성 검사)", () => {
  it("verify 명령이 참조하는 파일이 이번 phase 에서 변경됐으면 회송한다", async () => {
    saveState(dir, makeState({ phases: [{ ...makeState().phases[0], verify: ["npm test"] }] }));
    const fixContexts: Array<string | undefined> = [];
    const runner: SessionRunner = {
      async runPhase(req) {
        fixContexts.push(req.fixContext);
        touchHandoff();
        return { status: "done", summary: "ok", commits: ["abc"], sessionId: `s${fixContexts.length}` };
      },
      async runVerifyAgent() { return { status: "done", summary: "이상 없음", commits: [] }; },
      async runFixSession() { return { status: "done", summary: "stub", commits: [] }; },
    };
    let call = 0;
    // 1차: package.json 이 변경됐다고 응답(위조 시도) → 회송. 2차: 변경 없음 → 통과.
    const changedFiles = async () => { call++; return call === 1 ? { ok: true as const, files: ["package.json"] } : { ok: true as const, files: [] }; };
    const d = { ...deps(runner), headSha: async () => "head0", changedFiles };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    expect(s.phases[0].attempts).toBe(2);
    expect(fixContexts[1]).toContain("package.json");
  });

  it("phase.allow_verify_file_changes=true 면 검사를 건너뛰고 로그 + STATE 에 옵트아웃 사실을 남긴다", async () => {
    saveState(dir, makeState({
      phases: [{ ...makeState().phases[0], verify: ["npm test"], allow_verify_file_changes: true }],
    }));
    const logs: string[] = [];
    const d = {
      ...deps(stubRunner(["touch-and-done"])),
      headSha: async () => "head0",
      // 옵트아웃이면 changedFiles 자체가 호출되면 안 된다 — 호출되면 즉시 테스트 실패
      changedFiles: async () => { throw new Error("옵트아웃인데 changedFiles 가 호출됨 — 회귀"); },
      log: (m: string) => logs.push(m),
    };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    expect(logs.some(l => l.includes("옵트아웃"))).toBe(true);
    expect(s.phases[0].verify_file_changes_bypassed_at).toBeDefined();
    expect(loadState(dir).phases[0].verify_file_changes_bypassed_at).toBeDefined();
  });

  it("headBefore 가 없으면(git 저장소 아님 등) 검사를 건너뛴다", async () => {
    saveState(dir, makeState({ phases: [{ ...makeState().phases[0], verify: ["npm test"] }] }));
    let changedFilesCalls = 0;
    // headSha 는 deps() 기본값(null) 그대로 둔다 — headBefore 가 없는 상황을 재현
    const d = {
      ...deps(stubRunner(["touch-and-done"])),
      changedFiles: async () => { changedFilesCalls++; return { ok: true as const, files: ["package.json"] }; },
    };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    expect(changedFilesCalls).toBe(0);
  });

  it("verify 명령이 참조 파일 패턴에 안 걸리면(예: 'git --version') 검사 자체가 스킵된다", async () => {
    saveState(dir, makeState({ phases: [makeState().phases[0]] })); // verify_default: ["git --version"]
    let changedFilesCalls = 0;
    const d = {
      ...deps(stubRunner(["touch-and-done"])),
      headSha: async () => "head0",
      changedFiles: async () => { changedFilesCalls++; return { ok: true as const, files: ["package.json"] }; },
    };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    expect(changedFilesCalls).toBe(0);
  });

  it("attempt 간 위조 세탁을 막는다: 1차에서 위조당한 파일을 되돌리지 않고 2차에서 무관한 커밋만 해도 계속 회송된다", async () => {
    // 실측된 잔여 위험: headBefore 를 attempt 마다 새로 캡처해 그것만 기준으로 diff 하면, 1차 시도가
    // 위조 커밋을 남긴 채 회송당한 뒤 2차 시도가 그 위조를 그대로 두고 무관한 파일만 커밋해도
    // (2차의 headBefore 는 이미 1차의 위조 커밋 이후이므로) diff 에 위조가 안 잡혀 통과해버린다.
    // phase.verify_guard_baseline_sha 로 "이 phase 런 시작 시점"에 기준점을 고정해 이를 막는다.
    saveState(dir, makeState({
      phases: [{ ...makeState().phases[0], verify: ["npm test"], max_attempts: 2 }],
    }));
    // 커밋 히스토리를 흉내낸다: 각 커밋이 어떤 파일을 바꿨는지 기록해두고, changedFiles(sinceSha) 는
    // sinceSha 이후의 커밋들이 건드린 파일의 합집합을 반환한다 (실제 git diff --name-only 와 동일한 의미).
    const commits = [{ sha: "c0", files: [] as string[] }];
    let call = 0;
    const runner: SessionRunner = {
      async runPhase() {
        call++;
        if (call === 1) {
          commits.push({ sha: "c1", files: ["package.json"] }); // 위조 커밋 (되돌리지 않음)
        } else {
          commits.push({ sha: "c2", files: ["feature.txt"] }); // 무관한 정상 커밋 — 위조는 방치
        }
        return { status: "done", summary: `attempt ${call}`, commits: [commits[commits.length - 1].sha], sessionId: `s${call}` };
      },
      async runFixSession() { return { status: "done", summary: "x", commits: ["c"], addressed: ADDR }; },
      async runVerifyAgent() { return { status: "done", summary: "이상 없음", commits: [] }; },
    };
    const headSha = async () => commits[commits.length - 1].sha;
    const changedFiles = async (_cwd: string, sinceSha: string) => {
      const idx = commits.findIndex(c => c.sha === sinceSha);
      const after = idx >= 0 ? commits.slice(idx + 1) : commits;
      return { ok: true as const, files: [...new Set(after.flatMap(c => c.files))] };
    };
    const d = { ...deps(runner), headSha, changedFiles };
    const s = await runWorkflow(dir, d);
    // 세탁이 통했다면 status 가 "done" 이 됐을 것이다 — 고쳐진 코드는 attempts 를 소진하고 FAILED 로
    // 안전하게 정지해야 한다 (거짓 done 보다 훨씬 낫다).
    expect(s.status).toBe("failed");
    expect(s.phases[0].attempts).toBe(2);
    expect(s.phases[0].verify_guard_baseline_sha).toBe("c0"); // 기준점이 attempt 2에서 재캡처되지 않고 고정됨
  });

  it("changedFiles 조회 자체가 실패하면(git 오류 등) 로그만 남기고 게이트 판정에 맡긴다 (무한 회송 방지)", async () => {
    saveState(dir, makeState({ phases: [{ ...makeState().phases[0], verify: ["npm test"] }] }));
    const logs: string[] = [];
    const d = {
      ...deps(stubRunner(["touch-and-done"])),
      headSha: async () => "head0",
      changedFiles: async () => { throw new Error("git diff 실패(가정)"); },
      log: (m: string) => logs.push(m),
    };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    expect(logs.some(l => l.includes("건너뜀"))).toBe(true);
  });
});

describe("§26 C3: verify 위조 가드 './' 접두 불일치 수정 + I7 모노레포 오탐 방지", () => {
  it("'./scripts/check.sh' 위조를 탐지한다 (git diff 는 './' 없이 반환)", async () => {
    saveState(dir, makeState({ phases: [{ ...makeState().phases[0], verify: ["./scripts/check.sh"] }] }));
    let call = 0;
    // git diff --name-only 는 실제로 "./" 없는 리포-상대 경로를 반환한다
    const changedFiles = async () => { call++; return call === 1 ? { ok: true as const, files: ["scripts/check.sh"] } : { ok: true as const, files: [] }; };
    const d = { ...deps(stubRunner(["touch-and-done", "touch-and-done"])), headSha: async () => "head0", changedFiles };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    expect(s.phases[0].attempts).toBe(2); // 1차 회송 + 2차 통과
  });

  it("'./gradlew' 래퍼 위조를 탐지한다", async () => {
    saveState(dir, makeState({ phases: [{ ...makeState().phases[0], verify: ["./gradlew build"] }] }));
    let call = 0;
    const changedFiles = async () => { call++; return call === 1 ? { ok: true as const, files: ["gradlew"] } : { ok: true as const, files: [] }; };
    const d = { ...deps(stubRunner(["touch-and-done", "touch-and-done"])), headSha: async () => "head0", changedFiles };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    expect(s.phases[0].attempts).toBe(2);
  });

  it("'./' 없는 형태('bash scripts/check.sh')는 그대로 계속 탐지된다 (회귀 방지)", async () => {
    saveState(dir, makeState({ phases: [{ ...makeState().phases[0], verify: ["bash scripts/check.sh"] }] }));
    let call = 0;
    const changedFiles = async () => { call++; return call === 1 ? { ok: true as const, files: ["scripts/check.sh"] } : { ok: true as const, files: [] }; };
    const d = { ...deps(stubRunner(["touch-and-done", "touch-and-done"])), headSha: async () => "head0", changedFiles };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    expect(s.phases[0].attempts).toBe(2);
  });

  it("I7: 모노레포에서 하위 패키지의 package.json 변경은 루트 npm test 가드에 오탐하지 않는다", async () => {
    saveState(dir, makeState({ phases: [{ ...makeState().phases[0], verify: ["npm test"] }] }));
    const changedFiles = async () => ({ ok: true as const, files: ["packages/foo/package.json"] }); // 루트 package.json 이 아님
    const d = { ...deps(stubRunner(["touch-and-done"])), headSha: async () => "head0", changedFiles };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    expect(s.phases[0].attempts).toBe(1); // 오탐 회송 없이 1차에 통과
  });

  it("위조 감지 시 deps.log 를 호출하고 fixContext 에 allow_verify_file_changes 옵트아웃을 언급한다 (I7 회송 사유 비가시 수정)", async () => {
    saveState(dir, makeState({ phases: [{ ...makeState().phases[0], verify: ["npm test"] }] }));
    const logs: string[] = [];
    const fixContexts: Array<string | undefined> = [];
    let call = 0;
    const runner: SessionRunner = {
      async runPhase(req) {
        fixContexts.push(req.fixContext);
        touchHandoff();
        return { status: "done", summary: "ok", commits: ["abc"], sessionId: `s${fixContexts.length}` };
      },
      async runVerifyAgent() { return { status: "done", summary: "이상 없음", commits: [] }; },
      async runFixSession() { return { status: "done", summary: "stub", commits: [] }; },
    };
    const changedFiles = async () => { call++; return call === 1 ? { ok: true as const, files: ["package.json"] } : { ok: true as const, files: [] }; };
    const d = { ...deps(runner), headSha: async () => "head0", changedFiles, log: (m: string) => logs.push(m) };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    expect(logs.some(l => l.includes("package.json"))).toBe(true);
    expect(fixContexts[1]).toContain("allow_verify_file_changes");
  });
});

// §tamper-gap: defaultChangedFiles 가 판별 유니온으로 전환되면서 orchestrator.ts(phase 루프)가
// 실제로 두 신규 요구사항을 배선하는지 못박는다 — ① rename OLD 경로도 verify_tampered 로 잡히는가
// (P1 해소, E5), ② ok:false(invalid_utf8)가 별도 reason(changed_files_untrustworthy)·중립 문구로
// fail-closed 하는가(P1/P2/P5/P6, E6/E13). §30 P1: 이 비교/조립 로직은 orchestrator.ts 와 prloop.ts
// 에 독립적으로 복붙돼 있으므로(§0 이의 해소 ①) 이 배선 테스트는 prloop.test.ts 에도 동일하게
// 필요하다(E5/E11) — 여기서는 orchestrator 쪽만 다룬다.
describe("§tamper-gap: rename OLD 노출 + U+FFFD fail-closed 배선 (orchestrator.ts)", () => {
  it("[NUL-z] rename 된 guarded 파일이 OLD 경로를 근거로 verify_tampered 로 판정된다 (E5, P1 해소)", async () => {
    saveState(dir, makeState({ phases: [{ ...makeState().phases[0], verify: ["./scripts/old-name-guarded.sh"] }] }));
    let call = 0;
    // --no-renames 채택으로 rename 시 OLD 경로가 D(삭제) 세그먼트로 changed 에 노출된다(D5) — 그
    // 배선 결과를 흉내낸 스텁. 1차: OLD 경로가 changed 에 있음(rename 발생) → 회송. 2차: 통과.
    const changedFiles = async () => {
      call++;
      return call === 1
        ? { ok: true as const, files: ["scripts/old-name-guarded.sh"] }
        : { ok: true as const, files: [] };
    };
    const d = { ...deps(stubRunner(["touch-and-done", "touch-and-done"])), headSha: async () => "head0", changedFiles };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    expect(s.phases[0].attempts).toBe(2); // 1차 회송(rename OLD 감지) + 2차 통과
    expect(s.phases[0].sessions[0].verdict?.reason).toBe("verify_tampered");
    expect(s.phases[0].sessions[0].verdict?.detail).toContain("scripts/old-name-guarded.sh");
  });

  it("[NUL-z] changedFiles 가 ok:false(invalid_utf8) 를 반환하면 bounced/changed_files_untrustworthy 로 회송하고 attempt 를 소진한다", async () => {
    saveState(dir, makeState({ phases: [{ ...makeState().phases[0], verify: ["npm test"], max_attempts: 2 }] }));
    const changedFiles = async () => ({ ok: false as const, reason: "invalid_utf8" as const, paths: ["broken-�-name.txt"] });
    const d = { ...deps(stubRunner(["touch-and-done", "touch-and-done"])), headSha: async () => "head0", changedFiles };
    const s = await runWorkflow(dir, d);
    // 인프라 오류(throw, fail-open)와 달리 이 fail-closed 분기는 게이트에 맡기지 않고 계속
    // 회송해 attempt 를 소진시킨다 — max_attempts 도달 시 사람 인계(failed)로 자연 귀결한다(P6).
    expect(s.status).toBe("failed");
    expect(s.phases[0].attempts).toBe(2);
    for (const session of s.phases[0].sessions) {
      expect(session.verdict?.outcome).toBe("bounced");
      expect(session.verdict?.reason).toBe("changed_files_untrustworthy");
    }
  });

  it("[NUL-z] guarded 파일이 아닌 무관한 파일의 U+FFFD 로도 ok:false 분기가 발동해 정지한다 (E6, 넓은 스캔 배선)", async () => {
    saveState(dir, makeState({ phases: [{ ...makeState().phases[0], verify: ["npm test"], max_attempts: 1 }] }));
    // guardedFiles 는 verifyReferencedFiles(["npm test"]) → ["package.json"] 뿐이다. 여기서 반환하는
    // 파싱-이상 경로는 guardedFiles 와 전혀 무관한 이름이다 — defaultChangedFiles 자체가 changed
    // 전체(guarded 여부 무관)를 스캔해 ok:false 를 내는 설계이므로, 소비부는 guardedFiles 와
    // 무관한 경로여도 그대로 fail-closed 해야 한다(우회 표면을 만들지 않는다).
    const changedFiles = async () => ({ ok: false as const, reason: "invalid_utf8" as const, paths: ["totally/unrelated-�-path.bin"] });
    const d = { ...deps(stubRunner(["touch-and-done"])), headSha: async () => "head0", changedFiles };
    const s = await runWorkflow(dir, d);
    expect(s.phases[0].sessions[0].verdict?.outcome).toBe("bounced");
    expect(s.phases[0].sessions[0].verdict?.reason).toBe("changed_files_untrustworthy");
    expect(s.phases[0].sessions[0].verdict?.detail).toContain("unrelated");
  });

  it("changed_files_untrustworthy 회송 시 fixContext/STATE detail 에 중립 문구가 포함되고 '위조'/'변조' 표현이 포함되지 않는다 (E13)", async () => {
    saveState(dir, makeState({ phases: [{ ...makeState().phases[0], verify: ["npm test"] }] }));
    const fixContexts: Array<string | undefined> = [];
    const runner: SessionRunner = {
      async runPhase(req) {
        fixContexts.push(req.fixContext);
        touchHandoff();
        return { status: "done", summary: "ok", commits: ["abc"], sessionId: `s${fixContexts.length}` };
      },
      async runVerifyAgent() { return { status: "done", summary: "이상 없음", commits: [] }; },
      async runFixSession() { return { status: "done", summary: "stub", commits: [] }; },
    };
    let call = 0;
    const changedFiles = async () => {
      call++;
      return call === 1
        ? { ok: false as const, reason: "invalid_utf8" as const, paths: ["broken-�-name.txt"] }
        : { ok: true as const, files: [] };
    };
    const d = { ...deps(runner), headSha: async () => "head0", changedFiles };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    const fixContext = fixContexts[1]!;
    expect(fixContext).toContain("변경 파일 목록을 신뢰할 수 없어 안전하게 정지");
    expect(fixContext).not.toContain("위조");
    expect(fixContext).not.toContain("변조");
    const detail = s.phases[0].sessions[0].verdict?.detail ?? "";
    expect(detail).not.toContain("위조");
    expect(detail).not.toContain("변조");
  });

  // §tamper-gap P4/D8/E4: 같은 attempt 에 "내용 수정된 guarded 파일"과 "이동/삭제된 guarded 파일"이
  // 동시에 존재할 때 각각 정확한 라벨(수정됨/이동·삭제됨)이 fixContext 에 매겨지는지 확인한다.
  // describeGuardedFileState 는 fs.existsSync 기반이므로 실제 임시 파일 존재 여부로 재현한다.
  // [NUL-z] 태그 없음(E12 — fs 존재 분기는 -z 파싱/파일명 신뢰 경계 클래스가 아니다).
  it("같은 attempt 에 수정된 guarded 파일과 이동/삭제된 guarded 파일이 혼재하면 각각 정확한 라벨로 fixContext 에 표기된다 (E4)", async () => {
    saveState(dir, makeState({
      phases: [{ ...makeState().phases[0], verify: ["./scripts/mod.sh", "./scripts/gone.sh"] }],
    }));
    fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(dir, "scripts", "mod.sh"), "still here, just modified");
    // "scripts/gone.sh" 는 만들지 않는다 — 이동/삭제된 상태를 재현한다.
    let call = 0;
    const changedFiles = async () => {
      call++;
      return call === 1
        ? { ok: true as const, files: ["scripts/mod.sh", "scripts/gone.sh"] }
        : { ok: true as const, files: [] };
    };
    const fixContexts: Array<string | undefined> = [];
    const runner: SessionRunner = {
      async runPhase(req) {
        fixContexts.push(req.fixContext);
        touchHandoff();
        return { status: "done", summary: "ok", commits: ["abc"], sessionId: `s${fixContexts.length}` };
      },
      async runVerifyAgent() { return { status: "done", summary: "이상 없음", commits: [] }; },
      async runFixSession() { return { status: "done", summary: "stub", commits: [] }; },
    };
    const d = { ...deps(runner), headSha: async () => "head0", changedFiles };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    const fixContext = fixContexts[1]!;
    // tampered 는 guardedFiles(verify 명령에 쓰인 형태, "./" 접두 포함)에서 필터링되므로 그 원형
    // 그대로 displayPath 된다 — changed 쪽(정규화 전 형태)이 아니다.
    expect(fixContext).toContain('수정됨: "./scripts/mod.sh"');
    expect(fixContext).toContain('이동/삭제됨(원래 경로로 복원): "./scripts/gone.sh"');
  });

  // §tamper-gap E10-③/E16/E18(정정: 5채널 중 orchestrator 쪽 2채널) — 새 메시지가 흘러가는 표시
  // 지점은 escapeControlChars 같은 신규 이스케이프 함수 없이 기존 displayPath(JSON.stringify)만
  // 경유해 개행 등 제어문자를 한 줄에 안전하게 표시해야 한다. [NUL-z] 태그 없음(E12 — 이스케이프
  // 회귀는 -z 파싱/파일명 신뢰 경계 클래스가 아니다).
  describe("displayPath 경유 이스케이프 회귀 (E10-③/E16/E18) — orchestrator 채널 2개", () => {
    const pathWithNewline = "line1\nline2-tampered.sh";

    it("채널 1(orchestrator fixContext): 개행 포함 원인 경로가 displayPath(JSON 리터럴)로 한 줄에 안전하게 표시된다", async () => {
      saveState(dir, makeState({ phases: [{ ...makeState().phases[0], verify: ["npm test"] }] }));
      const fixContexts: Array<string | undefined> = [];
      const runner: SessionRunner = {
        async runPhase(req) {
          fixContexts.push(req.fixContext);
          touchHandoff();
          return { status: "done", summary: "ok", commits: ["abc"], sessionId: `s${fixContexts.length}` };
        },
        async runVerifyAgent() { return { status: "done", summary: "이상 없음", commits: [] }; },
        async runFixSession() { return { status: "done", summary: "stub", commits: [] }; },
      };
      let call = 0;
      const changedFiles = async () => {
        call++;
        return call === 1
          ? { ok: false as const, reason: "invalid_utf8" as const, paths: [pathWithNewline] }
          : { ok: true as const, files: [] };
      };
      const d = { ...deps(runner), headSha: async () => "head0", changedFiles };
      await runWorkflow(dir, d);
      const fixContext = fixContexts[1]!;
      // displayPath(JSON.stringify) 는 개행을 리터럴 "\n" 두 글자로 이스케이프한다 — 실제 줄바꿈
      // 문자(0x0A)가 그 JSON 문자열 리터럴 안에는 없어야 한다.
      const jsonLine = fixContext.split("\n").find(l => l.includes("line1"));
      expect(jsonLine).toBeDefined();
      expect(jsonLine).toContain(JSON.stringify(pathWithNewline));
    });

    it("채널 2(orchestrator STATE detail/recordVerdict): 개행 포함 원인 경로가 displayPath(JSON 리터럴)로 안전하게 기록된다", async () => {
      saveState(dir, makeState({ phases: [{ ...makeState().phases[0], verify: ["npm test"], max_attempts: 1 }] }));
      const changedFiles = async () => ({ ok: false as const, reason: "invalid_utf8" as const, paths: [pathWithNewline] });
      const d = { ...deps(stubRunner(["touch-and-done"])), headSha: async () => "head0", changedFiles };
      const s = await runWorkflow(dir, d);
      const detail = s.phases[0].sessions[0].verdict?.detail ?? "";
      expect(detail).toBe(JSON.stringify(pathWithNewline));
    });
  });
});

// §32 남은 부채 — allow_verify_file_changes 는 옵트아웃 사용 시각을 verify_file_changes_bypassed_at
// 에 남기는데(위 describe), allow_claude_md_changes 는 사용 시각 기록이 없었다(§32 처리 결과 기록).
// state.ts 는 이 라운드 다른 에이전트 소유라 새 STATE 필드(claude_md_changes_allowed_at)를 만들 수
// 없고, 애초에 실제 차단/해제 판정은 canUseTool(permissions.ts) 안에서 일어나 STATE 를 쓸 수 있는
// 경로가 아니다(하네스 단일 작성자 원칙) — 그래서 STATE 기록 대신 deps.log 로만 남긴다(§30 P4).
describe("§32 남은 부채 — allow_claude_md_changes 사용 로그", () => {
  it("phase.allow_claude_md_changes=true 면 phase 선택 직후 로그를 남긴다 (일반 attempts 경로)", async () => {
    saveState(dir, makeState({
      phases: [{ ...makeState().phases[0], allow_claude_md_changes: true }],
    }));
    const logs: string[] = [];
    const d = { ...deps(stubRunner(["touch-and-done"])), log: (m: string) => logs.push(m) };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    expect(logs.some(l => l.includes("Phase 1") && l.includes("allow_claude_md_changes"))).toBe(true);
  });

  it("allow_claude_md_changes 기본값(false)이면 그 로그를 남기지 않는다 (§30 P2 정상 경로)", async () => {
    saveState(dir, makeState({ phases: [makeState().phases[0]] }));
    const logs: string[] = [];
    const d = { ...deps(stubRunner(["touch-and-done"])), log: (m: string) => logs.push(m) };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    expect(logs.some(l => l.includes("allow_claude_md_changes"))).toBe(false);
  });

  it("§30 P1 — in_review 로 재개되는 phase(PR 대기, runFixSession 경로)에서도 같은 로그가 남는다", async () => {
    // pr_mode 의 in_review 분기는 runPhase 를 다시 부르지 않고 곧장 runPrGate(→ 필요 시
    // runFixSession)로 간다 — 그 경로가 사는 prloop.ts 는 이 라운드에서 수정할 수 없는 다른
    // 에이전트 소유 파일이므로, 로그는 두 분기의 공통 상위 지점(phase 선택 직후)에서 한 번만
    // 나가야 한다. 이 테스트는 그 공통 지점이 실제로 in_review 경로도 덮는지 증명한다.
    const st = prState();
    st.phases[0].allow_claude_md_changes = true;
    st.phases[0].status = "in_review";
    st.phases[0].pr = { number: 42, url: "https://ex/pull/42", head_branch: "fw/phase-1", handled_comment_keys: [], fix_sessions: 0 };
    saveState(dir, st);
    const pr = stubPr({ views: [MERGED] });
    const logs: string[] = [];
    const d = { ...deps(stubRunner([])), pr, log: (m: string) => logs.push(m) }; // 세션 재실행 없음
    const s = await runWorkflow(dir, d);
    expect(s.phases[0].status).toBe("done");
    expect(logs.some(l => l.includes("Phase 1") && l.includes("allow_claude_md_changes"))).toBe(true);
  });
});

describe("defaultChangedFiles (§24 감사 S1) — 실제 git 저장소", () => {
  let gitDir: string;
  let head0: string;
  beforeEach(() => {
    gitDir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-changedfiles-"));
    execFileSync("git", ["init", "-q"], { cwd: gitDir });
      fs.writeFileSync(path.join(gitDir, ".gitignore"), "logs/\ndocs/*/logs/\n");
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: gitDir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: gitDir });
    fs.writeFileSync(path.join(gitDir, "a.txt"), "1");
    execFileSync("git", ["add", "."], { cwd: gitDir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: gitDir });
    head0 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: gitDir }).toString().trim();
  });

  it("sinceSha 이후 변경된 파일 목록을 반환한다", async () => {
    fs.writeFileSync(path.join(gitDir, "package.json"), "{}");
    execFileSync("git", ["add", "."], { cwd: gitDir });
    execFileSync("git", ["commit", "-q", "-m", "add package.json"], { cwd: gitDir });
    const result = await defaultChangedFiles(gitDir, head0);
    if (!result.ok) throw new Error("expected ok:true");
    expect(result.files).toContain("package.json");
  });

  it("변경이 없으면 빈 배열을 반환한다 (에러와 구분)", async () => {
    expect(await defaultChangedFiles(gitDir, head0)).toEqual({ ok: true, files: [] });
  });

  it("git 저장소가 아니면 빈 배열 대신 throw 한다 (조용한 검사 무력화 방지)", async () => {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-notgit-cf-"));
    await expect(defaultChangedFiles(nonGitDir, head0)).rejects.toThrow();
  });
});

function stubPr(script: {
  views: PrView[];                 // viewPr 호출 순서대로 반환
  comments?: RawComment[][];       // listComments 호출 순서대로 반환
}): PrClient & { created: PrRef[]; replies: string[]; pushed: string[]; listCommentsCalls: number } {
  let v = 0, c = 0;
  const created: PrRef[] = [];
  const replies: string[] = [];
  const pushed: string[] = [];
  const self = {
    created, replies, pushed,
    listCommentsCalls: 0,        // §29 MI-10: pr_comment_mode="off" 가 조회 자체를 건너뛰는지 확인용
    async pushBranch(o: { branch: string }) { pushed.push(o.branch); },
    async createPr() {
      const ref = { number: 42, url: "https://ex/pull/42" };
      created.push(ref);
      return ref;
    },
    async listComments() { self.listCommentsCalls++; return script.comments?.[c++] ?? []; },
    async viewPr() { return script.views[Math.min(v++, script.views.length - 1)]; },
    async postReviewComments() {},
    async postPrComment(o: { body: string }) { replies.push(o.body); },
  };
  return self;
}

const MERGED: PrView = { state: "MERGED", reviewDecision: "APPROVED", merged: true };
const APPROVED: PrView = { state: "OPEN", reviewDecision: "APPROVED", merged: false };
const OPEN: PrView = { state: "OPEN", reviewDecision: null, merged: false };
const CLOSED: PrView = { state: "CLOSED", reviewDecision: null, merged: false };

function prState() {
  // §24 감사 T1: PR 코멘트 트리거는 작성자 allowlist 로도 걸러진다(fail-closed, 기본 빈 배열).
  // 아래 PR 테스트들이 쓰는 코멘트 작성자는 전부 "alice" 이므로 여기서 신뢰 목록에 넣어둔다 —
  // allowlist 자체를 다루는 테스트는 별도 describe 에서 override 한다.
  return makeState({
    pr_mode: true, allow_push: true, poll_interval_ms: 1, phases: [makeState().phases[0]],
    trusted_comment_authors: ["alice"],
  });
}

describe("PR 게이트 (pr_mode)", () => {
  it("검증 통과 후 PR 을 만들고, merged 감지 시 phase done", async () => {
    saveState(dir, prState());
    const pr = stubPr({ views: [MERGED] });
    const d = { ...deps(stubRunner(["touch-and-done"])), pr };
    const s = await runWorkflow(dir, d);
    expect(pr.created).toHaveLength(1);
    expect(pr.pushed).toEqual(["fw/phase-1"]); // PR 생성 전에 원격 브랜치를 올려야 한다
    expect(s.phases[0].pr?.number).toBe(42);
    expect(s.phases[0].status).toBe("done");
    expect(s.status).toBe("done");
  });

  it("PR 생성 전에 pushBranch 가 먼저 호출된다 (순서 보장)", async () => {
    saveState(dir, prState());
    const order: string[] = [];
    const pr: PrClient = {
      async pushBranch(o) { order.push(`push:${o.branch}`); },
      async createPr(o) {
        order.push(`create:${o.headBranch}`);
        return { number: 42, url: "https://ex/pull/42" };
      },
      async listComments() { return []; },
      async viewPr() { return MERGED; },
      async postReviewComments() {},
      async postPrComment() {},
    };
    const d = { ...deps(stubRunner(["touch-and-done"])), pr };
    const s = await runWorkflow(dir, d);
    expect(order).toEqual(["push:fw/phase-1", "create:fw/phase-1"]);
    expect(s.status).toBe("done");
  });

  it("createPr 가 throw 하면(원격 브랜치 없음 등) phase/state 가 failed 로 확정되고 알림이 나간다", async () => {
    saveState(dir, prState());
    const pr: PrClient = {
      async pushBranch() {},
      async createPr() {
        throw new Error("GraphQL: Head sha can't be blank, Base sha can't be blank");
      },
      async listComments() { return []; },
      async viewPr() { return OPEN; },
      async postReviewComments() {},
      async postPrComment() {},
    };
    const d = { ...deps(stubRunner(["touch-and-done"])), pr };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("failed");
    expect(s.phases[0].status).toBe("failed");
    expect(d.notes.some(n => n.includes("FAILED"))).toBe(true);
    // 디스크에도 failed 로 확정 저장됨 (in_progress 로 어정쩡하게 남지 않는다)
    expect(loadState(dir).status).toBe("failed");
    expect(loadState(dir).phases[0].status).toBe("failed");
  });

  it("pushBranch 가 throw 해도 phase/state 가 failed 로 확정되고 알림이 나간다", async () => {
    saveState(dir, prState());
    let createCalled = false;
    const pr: PrClient = {
      async pushBranch() { throw new Error("git push 실패: fatal: unable to access remote"); },
      async createPr() { createCalled = true; return { number: 42, url: "https://ex/pull/42" }; },
      async listComments() { return []; },
      async viewPr() { return OPEN; },
      async postReviewComments() {},
      async postPrComment() {},
    };
    const d = { ...deps(stubRunner(["touch-and-done"])), pr };
    const s = await runWorkflow(dir, d);
    expect(createCalled).toBe(false); // push 실패 시 createPr 을 시도하면 안 된다
    expect(s.status).toBe("failed");
    expect(s.phases[0].status).toBe("failed");
    expect(d.notes.some(n => n.includes("FAILED"))).toBe(true);
    expect(loadState(dir).status).toBe("failed");
  });

  it("approve 감지 시 awaiting_merge 로 정지하고 알림한다 (머지는 사람)", async () => {
    saveState(dir, prState());
    const pr = stubPr({ views: [APPROVED] });
    const d = { ...deps(stubRunner(["touch-and-done"])), pr };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("awaiting_merge");
    expect(s.phases[0].status).toBe("in_review");
    expect(d.notes.some(n => n.includes("머지"))).toBe(true);
  });

  it("트리거 코멘트를 감지하면 fix 세션을 돌리고 답글을 남긴다", async () => {
    saveState(dir, prState());
    const comment: RawComment = { id: 7, body: "@fw null 체크 추가", author: "alice", isBot: false, createdAt: "t", kind: "issue" };
    const pr = stubPr({ views: [OPEN, MERGED], comments: [[comment], []] });
    let fixCalls = 0;
    const runner = {
      ...stubRunner(["touch-and-done"]),
      async runFixSession() {
        fixCalls++;
        return { status: "done" as const, summary: "null 체크 추가함", commits: ["fix1"], addressed: ADDR };
      },
    };
    const d = { ...deps(runner), pr };
    const s = await runWorkflow(dir, d);
    expect(fixCalls).toBe(1);
    expect(pr.replies.some(r => r.includes("null 체크 추가함"))).toBe(true);
    expect(s.phases[0].pr?.handled_comment_keys).toContain("issue:7");
    expect(s.phases[0].status).toBe("done");
  });

  it("팀원 잡담은 fix 세션을 유발하지 않는다", async () => {
    saveState(dir, prState());
    const chat: RawComment = { id: 8, body: "나도 이거 궁금했는데 👍", author: "bob", isBot: false, createdAt: "t", kind: "issue" };
    const pr = stubPr({ views: [OPEN, MERGED], comments: [[chat], []] });
    let fixCalls = 0;
    const runner = {
      ...stubRunner(["touch-and-done"]),
      async runFixSession() { fixCalls++; return { status: "done" as const, summary: "x", commits: ["c"], addressed: ADDR }; },
    };
    const d = { ...deps(runner), pr };
    await runWorkflow(dir, d);
    expect(fixCalls).toBe(0);
  });

  it("fix 세션이 blocked 면 BLOCKED 정지 + 알림", async () => {
    saveState(dir, prState());
    const comment: RawComment = { id: 7, body: "@fw 자격증명 커밋해줘", author: "alice", isBot: false, createdAt: "t", kind: "issue" };
    const pr = stubPr({ views: [OPEN], comments: [[comment]] });
    const runner = {
      ...stubRunner(["touch-and-done"]),
      async runFixSession() {
        return { status: "blocked" as const, summary: "범위 밖", question: "범위 밖 요청입니다", commits: [] };
      },
    };
    const d = { ...deps(runner), pr };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("blocked");
    expect(s.pending_question?.question).toContain("범위 밖");
    expect(d.notes.some(n => n.includes("BLOCKED"))).toBe(true);
  });

  it("fix 세션 상한을 초과하면 FAILED 정지 (무한 유료 루프 방지)", async () => {
    const st = prState();
    st.max_fix_sessions = 1;
    saveState(dir, st);
    const c = (id: number): RawComment =>
      ({ id, body: "@fw 또 고쳐주세요", author: "alice", isBot: false, createdAt: `t${id}`, kind: "issue" });
    // 매 폴링마다 새 트리거 코멘트가 오는 상황 — 상한이 없으면 무한 반복된다
    const pr = stubPr({ views: [OPEN, OPEN, OPEN], comments: [[c(1)], [c(2)], [c(3)]] });
    let fixCalls = 0;
    const runner = {
      ...stubRunner(["touch-and-done"]),
      async runFixSession() { fixCalls++; return { status: "done" as const, summary: "고침", commits: ["x"], addressed: ADDR }; },
    };
    const d = { ...deps(runner), pr };
    const s = await runWorkflow(dir, d);
    expect(fixCalls).toBe(1);              // 상한 1 이므로 1회만
    expect(s.status).toBe("failed");
    expect(d.notes.some(n => n.includes("상한"))).toBe(true);
  });

  it("트리거 코멘트 2건 중 1건째 성공·2건째 blocked → 1건째의 답글·handled 기록은 보존된다 (부분 성공 보존)", async () => {
    saveState(dir, prState());
    const c1: RawComment = { id: 1, body: "@fw 이모지 달아주세요", author: "alice", isBot: false, createdAt: "t1", kind: "issue" };
    const c2: RawComment = { id: 2, body: "@fw 표로 표현해보세요", author: "alice", isBot: false, createdAt: "t2", kind: "issue" };
    const pr = stubPr({ views: [OPEN], comments: [[c1, c2]] });
    const runner = {
      ...stubRunner(["touch-and-done"]),
      async runFixSession(input: FixPromptInput) {
        if (input.comments[0]?.id === 1) return { status: "done" as const, summary: "이모지 반영함", commits: ["fix1"], addressed: ADDR };
        return { status: "blocked" as const, summary: "모호함", question: "어떤 표 형식을 원하시나요?", commits: [] };
      },
    };
    const d = { ...deps(runner), pr };
    const s = await runWorkflow(dir, d);

    expect(s.status).toBe("blocked");
    // 1건째 답글은 이미 확정되어 있어야 한다 (2건째가 blocked 되어도 유실되지 않는다)
    expect(pr.replies.some(r => r.includes("✅ issue:1 반영") && r.includes("이모지 반영함"))).toBe(true);
    expect(s.phases[0].pr?.handled_comment_keys).toContain("issue:1");
    expect(s.phases[0].pr?.handled_comment_keys).not.toContain("issue:2");
    // 디스크에도 반영되어 있어야 재개 시 근거가 된다
    expect(loadState(dir).phases[0].pr?.handled_comment_keys).toContain("issue:1");
    expect(s.pending_question?.question).toContain("issue:2");
  });

  it("재개 시(1건째 handled 기록된 채) 폴링하면 2건째만 fix 세션이 호출된다 (중복 없음)", async () => {
    const st = prState();
    st.phases[0].status = "in_review";
    st.phases[0].pr = {
      number: 42, url: "https://ex/pull/42", head_branch: "fw/phase-1",
      handled_comment_keys: ["issue:1"], fix_sessions: 1,
    };
    saveState(dir, st);
    const c1: RawComment = { id: 1, body: "@fw 이모지 달아주세요", author: "alice", isBot: false, createdAt: "t1", kind: "issue" };
    const c2: RawComment = { id: 2, body: "@fw 표로 표현해보세요", author: "alice", isBot: false, createdAt: "t2", kind: "issue" };
    // gh 는 이미 처리한 코멘트도 다시 돌려준다 — selectActionableComments 가 걸러내야 한다
    const pr = stubPr({ views: [OPEN, MERGED], comments: [[c1, c2]] });
    const calls: RawComment[][] = [];
    const runner = {
      ...stubRunner([]), // 세션 재실행 없이 PR 폴링만 재개해야 한다
      async runFixSession(input: FixPromptInput) {
        calls.push(input.comments);
        return { status: "done" as const, summary: "표로 반영함", commits: ["fix2"], addressed: ADDR };
      },
    };
    const d = { ...deps(runner), pr };
    const s = await runWorkflow(dir, d);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(1);
    expect(calls[0][0].id).toBe(2);
    expect(s.status).toBe("done");
    expect(s.phases[0].pr?.handled_comment_keys).toEqual(["issue:1", "issue:2"]);
  });

  it("트리거 코멘트 3건 → fix 세션이 3회 호출되고 각 호출의 comments 배열 길이가 1이다", async () => {
    saveState(dir, prState());
    const c = (id: number): RawComment =>
      ({ id, body: "@fw 고쳐주세요", author: "alice", isBot: false, createdAt: `t${id}`, kind: "issue" });
    const pr = stubPr({ views: [OPEN, MERGED], comments: [[c(1), c(2), c(3)]] });
    const calls: RawComment[][] = [];
    const runner = {
      ...stubRunner(["touch-and-done"]),
      async runFixSession(input: FixPromptInput) {
        calls.push(input.comments);
        return { status: "done" as const, summary: `고침 ${input.comments[0]?.id}`, commits: [`fix${input.comments[0]?.id}`], addressed: ADDR };
      },
    };
    const d = { ...deps(runner), pr };
    const s = await runWorkflow(dir, d);

    expect(calls).toHaveLength(3);
    expect(calls.every(cs => cs.length === 1)).toBe(true);
    expect(calls.map(cs => cs[0].id)).toEqual([1, 2, 3]);
    expect(s.status).toBe("done");
  });

  it("상한이 건별로 적용된다: max_fix_sessions 2, 코멘트 3건 → 2건 처리 후 FAILED", async () => {
    const st = prState();
    st.max_fix_sessions = 2;
    saveState(dir, st);
    const c = (id: number): RawComment =>
      ({ id, body: "@fw 고쳐주세요", author: "alice", isBot: false, createdAt: `t${id}`, kind: "issue" });
    const pr = stubPr({ views: [OPEN], comments: [[c(1), c(2), c(3)]] });
    let fixCalls = 0;
    const runner = {
      ...stubRunner(["touch-and-done"]),
      async runFixSession() { fixCalls++; return { status: "done" as const, summary: "고침", commits: ["x"], addressed: ADDR }; },
    };
    const d = { ...deps(runner), pr };
    const s = await runWorkflow(dir, d);

    expect(fixCalls).toBe(2);
    expect(s.status).toBe("failed");
    expect(s.phases[0].pr?.handled_comment_keys).toEqual(["issue:1", "issue:2"]);
    expect(d.notes.some(n => n.includes("상한"))).toBe(true);
  });

  it("PR 이 머지 없이 닫히면 FAILED", async () => {
    saveState(dir, prState());
    const pr = stubPr({ views: [CLOSED] });
    const d = { ...deps(stubRunner(["touch-and-done"])), pr };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("failed");
    expect(d.notes.some(n => n.includes("FAILED"))).toBe(true);
  });

  it("이미 PR 이 있는 in_review phase 는 PR 을 다시 만들지 않고, 열린 PR 로 확인되면 재동기화 push 한다 (D)", async () => {
    // §25 D: 재실행/재개로 로컬에 새 커밋이 생겼을 수 있다 — pushBranch 를 PR 생성 시에만 하면
    // 그 커밋이 원격 PR 브랜치에 영영 안 올라간다. phase.pr 이 이미 있어도 동기화해야 한다
    // (--force-with-lease 라 새 커밋이 없으면 사실상 no-op).
    //
    // 동기화 시점은 **PR 이 열려 있다고 확인된 뒤**다. 무조건 먼저 push 하면 머지된 PR 의
    // head 브랜치가 사라진 뒤 재개가 영구히 막힌다(실전 통주 실측) — 아래 테스트 참고.
    const st = prState();
    st.phases[0].status = "in_review";
    st.phases[0].pr = { number: 42, url: "https://ex/pull/42", head_branch: "fw/phase-1", handled_comment_keys: [], fix_sessions: 0 };
    saveState(dir, st);
    const pr = stubPr({ views: [OPEN, MERGED], comments: [[], []] });
    const d = { ...deps(stubRunner([])), pr };  // 세션 재실행 없음
    const s = await runWorkflow(dir, d);
    expect(pr.created).toHaveLength(0);
    expect(pr.pushed).toEqual(["fw/phase-1"]); // 재개 시에도 동기화 push 한다
    expect(s.phases[0].status).toBe("done");
  });

  it("머지된 PR 로 재개하면 동기화 push 없이 머지를 감지한다 (head 브랜치가 사라져도)", async () => {
    // 실전 통주가 잡은 결함의 회귀 고정: 머지 후 head 브랜치가 지워지면 그 브랜치에 push 할
    // 수 없고, 무조건 push 하던 옛 동작은 게이트를 예외로 죽여 머지를 감지하지 못했다.
    const st = prState();
    st.phases[0].status = "in_review";
    st.phases[0].pr = { number: 42, url: "https://ex/pull/42", head_branch: "fw/phase-1", handled_comment_keys: [], fix_sessions: 0 };
    saveState(dir, st);
    const pr = stubPr({ views: [MERGED] });
    pr.pushBranch = async () => { throw new Error("! [rejected] (stale info)"); };
    const d = { ...deps(stubRunner([])), pr };
    const s = await runWorkflow(dir, d);
    expect(s.phases[0].status).toBe("done");
  });

  it("최초 PR 생성 시엔 pushBranch 가 정확히 1회만 호출된다 (이중 push 없음, D 셀프리뷰)", async () => {
    const st = prState();
    saveState(dir, st);
    const pr = stubPr({ views: [OPEN, MERGED], comments: [[], []] });
    const d = { ...deps(stubRunner(["touch-and-done"])), pr };
    const s = await runWorkflow(dir, d);
    expect(pr.created).toHaveLength(1);
    expect(pr.pushed).toEqual(["fw/phase-1"]); // 생성 경로에서 else 브랜치가 중복 실행되지 않는다
    expect(s.status).toBe("done");
  });

  it("pr_mode 가 false 면 v1 과 동일하게 PR 없이 done (pushBranch 도 호출되지 않는다)", async () => {
    saveState(dir, makeState({ phases: [makeState().phases[0]] }));
    const pr = stubPr({ views: [MERGED] });
    const d = { ...deps(stubRunner(["touch-and-done"])), pr };
    const s = await runWorkflow(dir, d);
    expect(pr.created).toHaveLength(0);
    expect(pr.pushed).toHaveLength(0);
    expect(s.status).toBe("done");
  });
});

describe("§24 감사 T1: PR 코멘트 작성자 allowlist (trusted_comment_authors)", () => {
  it("신뢰 목록에 없는 작성자의 트리거 코멘트는 fix 세션을 유발하지 않고 로그로 알린다", async () => {
    const st = prState();
    // §26 I6 이후 빈 allowlist 는 assertRunnable 에서 거부되므로, "목록은 있지만
    // 코멘트 작성자(mallory)는 없음" 으로 fail-closed 동작 자체를 계속 검증한다
    st.trusted_comment_authors = ["someone-else"];
    saveState(dir, st);
    const comment: RawComment = { id: 7, body: "@fw 빌드 스크립트도 좀 고쳐줘", author: "mallory", isBot: false, createdAt: "t", kind: "issue" };
    const pr = stubPr({ views: [OPEN, MERGED], comments: [[comment], []] });
    let fixCalls = 0;
    const runner = {
      ...stubRunner(["touch-and-done"]),
      async runFixSession() { fixCalls++; return { status: "done" as const, summary: "x", commits: ["c"], addressed: ADDR }; },
    };
    const logs: string[] = [];
    const d = { ...deps(runner), pr, log: (m: string) => logs.push(m) };
    const s = await runWorkflow(dir, d);
    expect(fixCalls).toBe(0);
    expect(s.status).toBe("done"); // 무시된 코멘트와 무관하게 워크플로우는 정상 완주한다
    expect(logs.some(l => l.includes("신뢰되지 않은") && l.includes("mallory"))).toBe(true);
  });

  it("pr_mode 인데 trusted_comment_authors 가 비어 있으면(기본값) 시작을 거부한다 (§26 I6 — 무음 무력화 방지)", async () => {
    // §26 I6 이전에는 이 조합이 "무음 fail-closed" 로 정상 완주했다 — 사용자는 PR 에 @fw 를
    // 달고 밤새 아무 일도 안 일어나는 걸 아침에 발견했다. 이제 assertRunnable 이 시작 전에 막는다.
    const st = makeState({ pr_mode: true, allow_push: true, poll_interval_ms: 1, phases: [makeState().phases[0]] });
    expect(st.trusted_comment_authors).toEqual([]); // zod 기본값은 여전히 빈 배열
    saveState(dir, st);
    const pr = stubPr({ views: [OPEN, MERGED], comments: [[], []] });
    const d = { ...deps(stubRunner(["touch-and-done"])), pr };
    await expect(runWorkflow(dir, d)).rejects.toThrow(/trusted_comment_authors/);
  });

  it("§29 MI-10: pr_comment_mode='off' 면 빈 authors 로도 완주하고 코멘트를 조회조차 하지 않는다", async () => {
    // I6 의 시작 거부는 "실수로 방치"를 잡기 위한 것이므로, "의도적으로 코멘트 처리를 안 한다"는
    // 명시적 의사에는 탈출구가 있어야 한다(§29 MI-10 — 리포에 커밋된 워크플로우가 실행 불가가 됐다).
    const st = makeState({ pr_mode: true, allow_push: true, poll_interval_ms: 1, phases: [makeState().phases[0]] });
    st.pr_comment_mode = "off";
    expect(st.trusted_comment_authors).toEqual([]);
    saveState(dir, st);
    const trigger: RawComment = { id: 9, body: "@fw 이것도 고쳐줘", author: "alice", isBot: false, createdAt: "t", kind: "issue" };
    const pr = stubPr({ views: [OPEN, MERGED], comments: [[trigger], [trigger]] });
    let fixCalls = 0;
    const runner = {
      ...stubRunner(["touch-and-done"]),
      async runFixSession() { fixCalls++; return { status: "done" as const, summary: "x", commits: ["c"], addressed: ADDR }; },
    };
    const s = await runWorkflow(dir, { ...deps(runner), pr });
    expect(s.status).toBe("done");
    expect(fixCalls).toBe(0);                 // 트리거가 있어도 fix 세션을 돌리지 않는다
    expect(pr.listCommentsCalls).toBe(0);     // 쓰지 않을 응답에 API 왕복을 쓰지 않는다
  });

  it("신뢰 목록에 있는 작성자의 코멘트는 정상적으로 fix 세션을 유발한다 (회귀 방지)", async () => {
    const st = prState(); // trusted_comment_authors: ["alice"]
    saveState(dir, st);
    const comment: RawComment = { id: 7, body: "@fw null 체크 추가", author: "alice", isBot: false, createdAt: "t", kind: "issue" };
    const pr = stubPr({ views: [OPEN, MERGED], comments: [[comment], []] });
    let fixCalls = 0;
    const runner = {
      ...stubRunner(["touch-and-done"]),
      async runFixSession() { fixCalls++; return { status: "done" as const, summary: "반영함", commits: ["c"], addressed: ADDR }; },
    };
    const d = { ...deps(runner), pr };
    const s = await runWorkflow(dir, d);
    expect(fixCalls).toBe(1);
    expect(s.status).toBe("done");
  });

  it("작성자 대소문자가 달라도 신뢰 목록과 매칭된다 (GitHub 로그인 대소문자 무시)", async () => {
    const st = prState();
    st.trusted_comment_authors = ["ALICE"];
    saveState(dir, st);
    const comment: RawComment = { id: 7, body: "@fw 고쳐주세요", author: "Alice", isBot: false, createdAt: "t", kind: "issue" };
    const pr = stubPr({ views: [OPEN, MERGED], comments: [[comment], []] });
    let fixCalls = 0;
    const runner = {
      ...stubRunner(["touch-and-done"]),
      async runFixSession() { fixCalls++; return { status: "done" as const, summary: "반영함", commits: ["c"], addressed: ADDR }; },
    };
    const d = { ...deps(runner), pr };
    const s = await runWorkflow(dir, d);
    expect(fixCalls).toBe(1);
  });
});

describe("C2: 답글(부산물) 실패가 handled 기록(진실)을 폐기하지 않는다", () => {
  it("성공한 fix 세션의 ✅ 답글 게시가 실패해도 handled_comment_keys 는 기록되고 워크플로우는 계속된다", async () => {
    saveState(dir, prState());
    const comment: RawComment = { id: 7, body: "@fw null 체크 추가", author: "alice", isBot: false, createdAt: "t", kind: "issue" };
    let commentsCall = 0;
    let viewCall = 0;
    const pr: PrClient = {
      async pushBranch() {},
      async createPr() { return { number: 42, url: "https://ex/pull/42" }; },
      async listComments() { commentsCall++; return commentsCall === 1 ? [comment] : []; },
      async viewPr() { viewCall++; return viewCall <= 2 ? OPEN : MERGED; },
      async postReviewComments() {},
      async postPrComment(o) {
        if (o.body.startsWith("✅")) throw new Error("secondary rate limit exceeded");
      },
    };
    const runner = {
      ...stubRunner(["touch-and-done"]),
      async runFixSession() { return { status: "done" as const, summary: "null 체크 반영함", commits: ["fix1"], addressed: ADDR }; },
    };
    const d = { ...deps(runner), pr };
    const s = await runWorkflow(dir, d);
    // 답글 게시 실패가 워크플로우를 FAILED 로 만들면 안 된다 (판정은 진실만으로 확정)
    expect(s.status).toBe("done");
    expect(s.phases[0].pr?.handled_comment_keys).toContain("issue:7");
    // 디스크에도 기록되어, 다음 폴링에서 같은 코멘트로 유료 fix 세션을 또 돌리지 않는다
    expect(loadState(dir).phases[0].pr?.handled_comment_keys).toContain("issue:7");
  });

  it("반영 실패(⚠️) 답글 게시가 실패해도 FAILED 판정과 알림은 그대로 나간다", async () => {
    saveState(dir, prState());
    const comment: RawComment = { id: 9, body: "@fw 이것도 고쳐주세요", author: "alice", isBot: false, createdAt: "t", kind: "issue" };
    const pr: PrClient = {
      async pushBranch() {},
      async createPr() { return { number: 42, url: "https://ex/pull/42" }; },
      async listComments() { return [comment]; },
      async viewPr() { return OPEN; },
      async postReviewComments() {},
      async postPrComment(o) {
        if (o.body.startsWith("⚠️")) throw new Error("secondary rate limit exceeded");
      },
    };
    const runner = {
      ...stubRunner(["touch-and-done"]),
      async runFixSession() { return { status: "failed" as const, summary: "반영 불가", commits: [] }; },
    };
    const d = { ...deps(runner), pr };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("failed");
    expect(d.notes.some(n => n.includes("리뷰 반영 실패"))).toBe(true);
    // "PR 게이트 오류" (catch-all) 로 원래 메시지가 뒤덮이지 않는다
    expect(d.notes.some(n => n.includes("PR 게이트 오류"))).toBe(false);
  });
});

describe("C1: 폴링 중 일시적 gh 오류는 지수 백오프로 재시도한다", () => {
  it("viewPr 이 2회 실패 후 성공하면 재시도 후 정상 진행된다", async () => {
    saveState(dir, prState());
    let calls = 0;
    const pr: PrClient = {
      async pushBranch() {},
      async createPr() { return { number: 42, url: "https://ex/pull/42" }; },
      async listComments() { return []; },
      async viewPr() {
        calls++;
        if (calls <= 2) throw new Error("dial tcp: i/o timeout");
        return MERGED;
      },
      async postReviewComments() {},
      async postPrComment() {},
    };
    const sleeps: number[] = [];
    const d = { ...deps(stubRunner(["touch-and-done"])), pr, sleep: async (ms: number) => { sleeps.push(ms); } };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    expect(calls).toBe(3); // 1회 실패, 2회 실패, 3회째 성공
    expect(sleeps).toEqual([1000, 4000]); // 백오프 지연이 순서대로 적용됨
  });

  it("viewPr 이 4회 모두 실패하면 재시도를 소진하고 FAILED 로 정지한다", async () => {
    saveState(dir, prState());
    let calls = 0;
    const pr: PrClient = {
      async pushBranch() {},
      async createPr() { return { number: 42, url: "https://ex/pull/42" }; },
      async listComments() { return []; },
      async viewPr() { calls++; throw new Error("dial tcp: i/o timeout"); },
      async postReviewComments() {},
      async postPrComment() {},
    };
    const d = { ...deps(stubRunner(["touch-and-done"])), pr, sleep: async () => {} };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("failed");
    expect(calls).toBe(4); // 최초 시도 + 3회 재시도
  });

  it("listComments 도 재시도 대상이다 (1회 실패 후 성공)", async () => {
    saveState(dir, prState());
    const comment: RawComment = { id: 3, body: "@fw 고쳐주세요", author: "alice", isBot: false, createdAt: "t", kind: "issue" };
    let calls = 0;
    let viewCalls = 0;
    const pr: PrClient = {
      async pushBranch() {},
      async createPr() { return { number: 42, url: "https://ex/pull/42" }; },
      async listComments() {
        calls++;
        if (calls === 1) throw new Error("dial tcp: i/o timeout");
        return calls === 2 ? [comment] : [];
      },
      async viewPr() { viewCalls++; return viewCalls <= 2 ? OPEN : MERGED; },
      async postReviewComments() {},
      async postPrComment() {},
    };
    const runner = {
      ...stubRunner(["touch-and-done"]),
      async runFixSession() { return { status: "done" as const, summary: "고침", commits: ["x"], addressed: ADDR }; },
    };
    const d = { ...deps(runner), pr, sleep: async () => {} };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("createPr/pushBranch/postPrComment 는 재시도하지 않는다 (부작용 있는 호출 — 중복 생성 위험)", async () => {
    saveState(dir, prState());
    let createCalls = 0;
    const pr: PrClient = {
      async pushBranch() {},
      async createPr() {
        createCalls++;
        throw new Error("dial tcp: i/o timeout"); // 일시적 오류처럼 보여도 재시도하면 안 된다
      },
      async listComments() { return []; },
      async viewPr() { return OPEN; },
      async postReviewComments() {},
      async postPrComment() {},
    };
    const d = { ...deps(stubRunner(["touch-and-done"])), pr, sleep: async () => {} };
    const s = await runWorkflow(dir, d);
    expect(createCalls).toBe(1); // 재시도 없이 1회만 시도하고 즉시 failed
    expect(s.status).toBe("failed");
  });
});

describe("B 통합: PR fix blocked → answerQuestion → 재개는 runFixSession 만 재실행한다 (라이브락 해소)", () => {
  it("blocked 후 답변하면 재개 시 runPhase 는 호출되지 않고 runFixSession 만 answers 를 받아 재실행된다", async () => {
    saveState(dir, prState());
    const comment: RawComment = { id: 5, body: "@fw 이 로직 방향을 확인해주세요", author: "alice", isBot: false, createdAt: "t", kind: "issue" };

    // 1차 실행: phase 세션 완료 → PR 생성 → 트리거 코멘트 감지 → fix 세션이 blocked 로 질문
    const pr1: PrClient = {
      async pushBranch() {},
      async createPr() { return { number: 42, url: "https://ex/pull/42" }; },
      async listComments() { return [comment]; },
      async viewPr() { return OPEN; },
      async postReviewComments() {},
      async postPrComment() {},
    };
    const runner1 = {
      ...stubRunner(["touch-and-done"]),
      async runFixSession() {
        return { status: "blocked" as const, summary: "방향 불명확", question: "A안과 B안 중 어느 쪽인가요?", commits: [] };
      },
    };
    const d1 = { ...deps(runner1), pr: pr1 };
    const s1 = await runWorkflow(dir, d1);
    expect(s1.status).toBe("blocked");
    expect(s1.phases[0].pr).toBeDefined(); // PR 컨텍스트가 이미 존재

    // 답변 → B-2 덕에 phase.status 가 in_review 로 복귀해야 한다
    answerQuestion(s1, "A안으로 진행해주세요", "2026-08-26T02:00:00Z");
    expect(s1.phases[0].status).toBe("in_review");
    saveState(dir, s1);

    // 2차 실행: runPhase 가 호출되면 즉시 실패시켜 "전체 phase 세션 재실행" 라이브락을 검출한다
    const fixCalls: FixPromptInput[] = [];
    let viewCalls2 = 0;
    const pr2: PrClient = {
      async pushBranch() {},
      async createPr() { throw new Error("호출되면 안 됨 — PR 이 이미 있다"); },
      async listComments() { return [comment]; }, // gh 는 이미 처리한 적 없는 같은 코멘트를 계속 돌려준다
      async viewPr() { viewCalls2++; return viewCalls2 <= 1 ? OPEN : MERGED; },
      async postReviewComments() {},
      async postPrComment() {},
    };
    const runner2: SessionRunner = {
      async runPhase() { throw new Error("runPhase 가 호출됨 — 라이브락 회귀"); },
      async runVerifyAgent() { return { status: "done", summary: "이상 없음", commits: [] }; },
      async runFixSession(input: FixPromptInput) {
        fixCalls.push(input);
        return { status: "done" as const, summary: "A안으로 반영함", commits: ["fix1"], addressed: ADDR };
      },
    };
    const d2 = { ...deps(runner2), pr: pr2 };
    const s2 = await runWorkflow(dir, d2);

    expect(s2.status).toBe("done");
    expect(fixCalls).toHaveLength(1);
    // fix 세션이 이전 질문의 답을 받아야 같은 질문을 반복하지 않는다 (B-1)
    expect(fixCalls[0].answers.some(a => a.answer === "A안으로 진행해주세요")).toBe(true);
  });
});

describe("§25 과제3: 비용 기록 (phase.sessions.cost_usd)", () => {
  it("runPhase 결과의 costUsd 가 phase.sessions 에 kind:'phase' 로 기록된다", async () => {
    saveState(dir, makeState({ phases: [makeState().phases[0]] }));
    const runner: SessionRunner = {
      async runPhase() {
        return { status: "done", summary: "ok", commits: ["abc"], sessionId: "s1", costUsd: 1.23 };
      },
      async runFixSession() { return { status: "done", summary: "x", commits: [] }; },
      async runVerifyAgent() { return { status: "done", summary: "이상 없음", commits: [] }; },
    };
    const s = await runWorkflow(dir, deps(runner));
    expect(s.status).toBe("done");
    expect(s.phases[0].sessions[0]).toMatchObject({ kind: "phase", cost_usd: 1.23, session_id: "s1" });
  });

  it("costUsd 가 없는 결과는 cost_usd 가 기록되지 않는다 (0 으로 오염되지 않음)", async () => {
    saveState(dir, makeState({ phases: [makeState().phases[0]] }));
    const runner: SessionRunner = {
      async runPhase() {
        return { status: "done", summary: "ok", commits: ["abc"], sessionId: "s1" };
      },
      async runFixSession() { return { status: "done", summary: "x", commits: [] }; },
      async runVerifyAgent() { return { status: "done", summary: "이상 없음", commits: [] }; },
    };
    const s = await runWorkflow(dir, deps(runner));
    expect(s.phases[0].sessions[0].cost_usd).toBeUndefined();
  });
});

describe("§25 과제3: fix 세션이 STATE 에 kind:'fix' 로 기록된다 (PR 왕복 재구성 가능)", () => {
  it("PR fix 세션 결과가 phase.sessions 에 kind:'fix'/cost_usd 로 기록되고, phase 세션과 구분된다", async () => {
    saveState(dir, prState());
    const comment: RawComment = { id: 7, body: "@fw null 체크 추가", author: "alice", isBot: false, createdAt: "t", kind: "issue" };
    const pr = stubPr({ views: [OPEN, MERGED], comments: [[comment], []] });
    const runner = {
      ...stubRunner(["touch-and-done"]),
      async runFixSession() {
        return { status: "done" as const, summary: "null 체크 추가함", commits: ["fix1"], sessionId: "fixsess1", costUsd: 0.42, addressed: ADDR };
      },
    };
    const d = { ...deps(runner), pr };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    const fixSessions = s.phases[0].sessions.filter(sess => sess.kind === "fix");
    expect(fixSessions).toHaveLength(1);
    expect(fixSessions[0]).toMatchObject({ session_id: "fixsess1", cost_usd: 0.42, result: "done" });
    // runPhase 결과는 별도로 kind:"phase" 로 남아있어야 한다 (fix 로 뒤덮이면 안 됨)
    expect(s.phases[0].sessions.some(sess => sess.kind === "phase")).toBe(true);
  });

  // §43 §30 P1 — findings 배선은 phase/fix/verify 세 경로 전부에 있어야 한다. phase 경로만
  // 테스트했을 때 fix 경로 배선을 지우는 mutant 가 SURVIVED 했다(실측). 세 경로를 각각
  // 못박지 않으면 "한쪽에만 설치된 방어" 가 그대로 재발한다.
  it("fix 세션의 findings 도 STATE 에 기록된다 (§43 — 세 경로 전부)", async () => {
    saveState(dir, prState());
    const comment: RawComment = { id: 7, body: "@fw null 체크 추가", author: "alice", isBot: false, createdAt: "t", kind: "issue" };
    const pr = stubPr({ views: [OPEN, MERGED], comments: [[comment], []] });
    const runner = {
      ...stubRunner(["touch-and-done"]),
      async runFixSession() {
        return {
          status: "done" as const, summary: "반영함", commits: ["fix1"], sessionId: "fixsess1", addressed: ADDR,
          findings: [{ kind: "needed" as const, detail: "리뷰어가 지적한 케이스의 회귀 테스트가 없다" }],
        };
      },
    };
    const s = await runWorkflow(dir, { ...deps(runner), pr });
    const fixSession = s.phases[0].sessions.find(sess => sess.kind === "fix")!;
    expect(fixSession.findings).toEqual([
      { kind: "needed", detail: "리뷰어가 지적한 케이스의 회귀 테스트가 없다" },
    ]);
  });
});

describe("§25 과제3: 폴링 하트비트 (phase.pr.last_polled_at)", () => {
  it("폴링마다 last_polled_at 이 deps.now() 로 갱신되고, 마지막 poll 값이 STATE 에 남는다", async () => {
    saveState(dir, prState());
    let viewCalls = 0;
    const pr: PrClient = {
      async pushBranch() {},
      async createPr() { return { number: 42, url: "https://ex/pull/42" }; },
      async listComments() { return []; },
      async viewPr() { viewCalls++; return viewCalls >= 3 ? MERGED : OPEN; },
      async postReviewComments() {},
      async postPrComment() {},
    };
    let counter = 0;
    const nowCalls: string[] = [];
    const now = () => { const v = `t${counter++}`; nowCalls.push(v); return v; };
    // §41 I-1 후속: 워크플로우 완주 후 verify 에이전트도 now() 를 한 번 더 호출한다(세션 push 의
    // `at` 필드) — 폴링이 끝난 **뒤**에 일어나는 호출이라 "테스트 전체에서 가장 마지막으로 기록된
    // now() 값" 이 더 이상 "마지막 폴링" 과 같다고 가정할 수 없다. runVerifyAgent 호출 시점의
    // nowCalls 길이를 스냅샷해 "폴링까지만" 의 마지막 값을 따로 잡는다(런타임 동작은 그대로 두고
    // 테스트의 관측 지점만 정확히 맞춘다 — 단언을 약화시키지 않는다).
    let nowCallsBeforeVerify = -1;
    const baseRunner = stubRunner(["touch-and-done"]);
    const runner: SessionRunner = {
      ...baseRunner,
      async runVerifyAgent(...args) {
        nowCallsBeforeVerify = nowCalls.length;
        return baseRunner.runVerifyAgent(...args);
      },
    };
    const d = { ...deps(runner), pr, now, sleep: async () => {} };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    expect(viewCalls).toBe(3); // OPEN, OPEN, MERGED — 3번 폴링
    expect(s.phases[0].pr?.last_polled_at).toBeDefined();
    // 폴링이 반복되는 동안 now() 가 매번 호출되어야(하트비트) 한다
    expect(nowCalls.length).toBeGreaterThanOrEqual(3);
    expect(nowCallsBeforeVerify).toBeGreaterThan(0);
    // 폴링이 끝난 시점(=verify 호출 직전)까지 가장 마지막으로 기록된 now() 값이 last_polled_at 에
    // 반영되어야 "매 폴링마다 갱신"이 보장된다
    expect(s.phases[0].pr?.last_polled_at).toBe(nowCalls[nowCallsBeforeVerify - 1]);
  });
});

type GitCall = { args: string[]; cwd: string };

// branch: 현재(가짜) HEAD 브랜치. detached:true 면 시작부터 detached HEAD 를 흉내낸다(rev-parse
// --abbrev-ref HEAD 가 리터럴 "HEAD" 를 반환). branchExists: `show-ref --verify --quiet
// refs/heads/<name>` 이 성공(이미 그 이름의 브랜치가 있음)할지 여부(§26 I4 — rev-parse --verify 는
// 동명 태그도 통과시키므로 production 코드가 show-ref 로 바뀐 것에 맞춘 스텁이다). 하네스가
// "checkout" 을 호출하면 내부 currentBranch 상태를 실제로 갱신해, 이후 rev-parse --abbrev-ref HEAD
// 재호출이 그 변화를 반영하게 한다. 세션이 브랜치를 이탈하는 시나리오는 이 스텁만으로는 재현할 수
// 없다(세션의 git 호출은 이 하네스 git 스텁과 별개 경로다) — 반환된 setBranch() 를 테스트의 커스텀
// SessionRunner.runPhase 안에서 호출해 "세션이 checkout 으로 다른 브랜치에 가 있다"를 흉내낸다.
// §19/§26 두 describe 블록에서 공유하므로 모듈 스코프로 둔다.
function makeGitStub(opts: {
  branch: string;
  dirty?: boolean;
  branchExists?: boolean;
  failCheckout?: boolean;
  detached?: boolean;
  reachable?: boolean; // merge-base --is-ancestor 결과 (기본 true)
  // §26 M5: PR merged 후 격리 브랜치 갱신 시퀀스(fetch/rev-list/checkout -B)용 스텁 옵션.
  fetchFails?: boolean;
  // §29 MI-6: 특정 브랜치명으로의 fetch 만 실패시킨다(GHE "머지 시 head 브랜치 자동 삭제" 시뮬레이션
  // — base fetch 는 성공, head fetch 만 "찾을 수 없음"으로 실패하는 상황을 재현한다).
  fetchFailsFor?: string[];
  unpushedCount?: number; // rev-list --count 결과 (기본 0 — push 안 된 커밋 없음)
  failResetCheckout?: boolean; // "checkout -B ..." (갱신용 리셋)만 실패시킨다 — 최초 격리 체크아웃(-b)과 구분
}) {
  const calls: GitCall[] = [];
  let currentBranch = opts.detached ? "HEAD" : opts.branch;
  const git = async (args: string[], cwd: string) => {
    calls.push({ args, cwd });
    if (args[0] === "rev-parse" && args[1] === "--git-dir") return { ok: true, stdout: ".git", stderr: "" };
    if (args[0] === "status") {
      return { ok: true, stdout: opts.dirty ? toZStdout([record1("x.txt")]) : "", stderr: "" };
    }
    if (args[0] === "rev-parse" && args.includes("HEAD") && !args.includes("--verify")) {
      return { ok: true, stdout: currentBranch, stderr: "" };
    }
    if (args[0] === "show-ref") {
      return opts.branchExists
        ? { ok: true, stdout: "abc123 refs/heads/x", stderr: "" }
        : { ok: false, stdout: "", stderr: "not a valid ref" };
    }
    if (args[0] === "fetch") {
      const target = args[2];
      if (opts.fetchFails || (opts.fetchFailsFor && target !== undefined && opts.fetchFailsFor.includes(target))) {
        return { ok: false, stdout: "", stderr: "fetch 실패: couldn't find remote ref" };
      }
      return { ok: true, stdout: "", stderr: "" };
    }
    if (args[0] === "rev-list" && args.includes("--count")) {
      return { ok: true, stdout: String(opts.unpushedCount ?? 0), stderr: "" };
    }
    if (args[0] === "checkout") {
      const isReset = args[1] === "-B";
      if (isReset ? opts.failResetCheckout : opts.failCheckout) {
        return { ok: false, stdout: "", stderr: "checkout 실패" };
      }
      const bIdx = args.findIndex(a => a === "-b" || a === "-B");
      const target = bIdx >= 0 ? args[bIdx + 1] : args[args.length - 1];
      currentBranch = target;
      return { ok: true, stdout: "", stderr: "" };
    }
    if (args[0] === "merge-base" && args.includes("--is-ancestor")) {
      return opts.reachable === false
        ? { ok: false, stdout: "", stderr: "not an ancestor" }
        : { ok: true, stdout: "", stderr: "" };
    }
    return { ok: true, stdout: "", stderr: "" };
  };
  return { git, calls, getCurrentBranch: () => currentBranch, setBranch: (b: string) => { currentBranch = b; } };
}

describe("§19 프리플라이트 + 브랜치 격리", () => {
  it("프리플라이트 실패(더러운 워킹트리) 시 세션을 한 번도 실행하지 않고 FAILED + 알림으로 정지한다", async () => {
    saveState(dir, makeState({ phases: [makeState().phases[0]] }));
    let ranPhase = false;
    const runner: SessionRunner = {
      async runPhase() { ranPhase = true; return { status: "done", summary: "ok", commits: ["c"], sessionId: "s" }; },
      async runFixSession() { return { status: "done", summary: "x", commits: [] }; },
      async runVerifyAgent() { return { status: "done", summary: "ok", commits: [] }; },
    };
    const { git } = makeGitStub({ branch: "main", dirty: true });
    const d = { ...deps(runner), git };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("failed");
    expect(ranPhase).toBe(false);
    expect(d.notes.some(n => n.includes("FAILED") && n.includes("프리플라이트"))).toBe(true);
  });

  // §36 I-3 — 프리플라이트가 **통과했지만 방어를 낮춘 채** 통과한 경우(allow_untracked_logs
  // 옵트아웃) 그 사실이 런로그에 남아야 한다. 조용히 건너뛰면 밤새 무인으로 돌린 뒤 "왜 로그가
  // 커밋됐지" 를 사후에 재구성할 수 없다(§30 P4). §32 가 allow_claude_md_changes 에서 남긴 것과
  // 같은 부채가 새 노브에서 반복되던 것이다.
  it("§36 I-3: 프리플라이트가 옵트아웃으로 방어를 건너뛰면 그 사실을 런로그에 남긴다", async () => {
    saveState(dir, makeState({ phases: [makeState().phases[0]] }));
    const { git } = makeGitStub({ branch: "main", branchExists: false });
    // checkIgnoreGit: exit 1 = 무시되지 않음. allow_untracked_logs 로 통과시키되 경고가 남아야 한다.
    const logs: string[] = [];
    const d = {
      ...deps(stubRunner(["touch-and-done"])),
      git,
      log: (m: string) => logs.push(m),
      checkIgnoreGit: async () => ({ exitCode: 1, stderr: "" }),
    };
    const st = loadState(dir);
    st.allow_untracked_logs = true;
    saveState(dir, st);

    await runWorkflow(dir, d as OrchestratorDeps);

    expect(logs.some(l => l.includes("allow_untracked_logs"))).toBe(true);
  });

  it("프리플라이트 실패(git 저장소 아님) 시에도 FAILED + 알림으로 정지한다", async () => {
    saveState(dir, makeState({ phases: [makeState().phases[0]] }));
    const git = async () => ({ ok: false, stdout: "", stderr: "not a git repository" });
    const d = { ...deps(stubRunner(["touch-and-done"])), git };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("failed");
    expect(d.notes.some(n => n.includes("FAILED"))).toBe(true);
  });

  it("pr_mode 에서 gh auth status 가 실패하면 FAILED + 알림으로 정지한다", async () => {
    saveState(dir, prState());
    const { git } = makeGitStub({ branch: "topic-x" }); // base_branch 아닌 브랜치 — 격리 분기는 안 탐
    const gh = async () => ({ ok: false, stdout: "", stderr: "not logged in" });
    const d = { ...deps(stubRunner(["touch-and-done"])), git, gh };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("failed");
    expect(d.notes.some(n => n.includes("FAILED"))).toBe(true);
  });

  it("branch_strategy=isolate + 현재 브랜치가 base_branch 면 feature/<workflow> 로 체크아웃한다", async () => {
    saveState(dir, makeState({ branch_strategy: "isolate", base_branch: "main", phases: [makeState().phases[0]] }));
    const { git, calls } = makeGitStub({ branch: "main", branchExists: false });
    const d = { ...deps(stubRunner(["touch-and-done"])), git };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    const checkoutCall = calls.find(c => c.args[0] === "checkout");
    expect(checkoutCall?.args).toEqual(["checkout", "-b", "feature/wf"]);
  });

  it("branch_strategy=isolate + 격리 브랜치가 이미 있으면 -b 없이 체크아웃한다", async () => {
    saveState(dir, makeState({ branch_strategy: "isolate", base_branch: "main", phases: [makeState().phases[0]] }));
    const { git, calls } = makeGitStub({ branch: "main", branchExists: true });
    const d = { ...deps(stubRunner(["touch-and-done"])), git };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    const checkoutCall = calls.find(c => c.args[0] === "checkout");
    expect(checkoutCall?.args).toEqual(["checkout", "feature/wf"]);
  });

  it("branch_strategy=isolate + 이미 다른 브랜치면 체크아웃을 호출하지 않는다 (사용자 브랜치를 건드리지 않음)", async () => {
    saveState(dir, makeState({ branch_strategy: "isolate", base_branch: "main", phases: [makeState().phases[0]] }));
    const { git, calls } = makeGitStub({ branch: "already-on-topic" });
    const d = { ...deps(stubRunner(["touch-and-done"])), git };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    expect(calls.some(c => c.args[0] === "checkout")).toBe(false);
  });

  it("branch_strategy=isolate 체크아웃 실패 시 FAILED + 알림으로 정지한다", async () => {
    saveState(dir, makeState({ branch_strategy: "isolate", base_branch: "main", phases: [makeState().phases[0]] }));
    const { git } = makeGitStub({ branch: "main", branchExists: false, failCheckout: true });
    const d = { ...deps(stubRunner(["touch-and-done"])), git };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("failed");
    expect(d.notes.some(n => n.includes("FAILED") && n.includes("체크아웃"))).toBe(true);
  });

  it("branch_strategy=current + base_branch 위에 있으면 경고만 로그하고 그대로 진행한다 (체크아웃 없음)", async () => {
    saveState(dir, makeState({ branch_strategy: "current", base_branch: "main", phases: [makeState().phases[0]] }));
    const { git, calls } = makeGitStub({ branch: "main" });
    const logs: string[] = [];
    const d = { ...deps(stubRunner(["touch-and-done"])), git, log: (m: string) => logs.push(m) };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    expect(calls.some(c => c.args[0] === "checkout")).toBe(false);
    expect(logs.some(l => l.includes("경고") && l.includes("current"))).toBe(true);
  });

  it("branch_strategy=current + 다른 브랜치면 경고 없이 그대로 진행한다", async () => {
    saveState(dir, makeState({ branch_strategy: "current", base_branch: "main", phases: [makeState().phases[0]] }));
    const { git, calls } = makeGitStub({ branch: "already-topic" });
    const logs: string[] = [];
    const d = { ...deps(stubRunner(["touch-and-done"])), git, log: (m: string) => logs.push(m) };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    expect(calls.some(c => c.args[0] === "checkout")).toBe(false);
    expect(logs.some(l => l.includes("경고"))).toBe(false);
  });

  it("branch_strategy=require-topic + base_branch 위면 세션 없이 FAILED + 알림으로 정지한다", async () => {
    saveState(dir, makeState({ branch_strategy: "require-topic", base_branch: "main", phases: [makeState().phases[0]] }));
    const { git, calls } = makeGitStub({ branch: "main" });
    let ranPhase = false;
    const runner: SessionRunner = {
      async runPhase() { ranPhase = true; return { status: "done", summary: "ok", commits: ["c"], sessionId: "s" }; },
      async runFixSession() { return { status: "done", summary: "x", commits: [] }; },
      async runVerifyAgent() { return { status: "done", summary: "ok", commits: [] }; },
    };
    const d = { ...deps(runner), git };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("failed");
    expect(ranPhase).toBe(false);
    expect(calls.some(c => c.args[0] === "checkout")).toBe(false);
    expect(d.notes.some(n => n.includes("FAILED") && n.includes("require-topic"))).toBe(true);
  });

  it("branch_strategy=require-topic + 이미 토픽 브랜치면 정상 진행한다", async () => {
    saveState(dir, makeState({ branch_strategy: "require-topic", base_branch: "main", phases: [makeState().phases[0]] }));
    const { git, calls } = makeGitStub({ branch: "my-topic" });
    const d = { ...deps(stubRunner(["touch-and-done"])), git };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    expect(calls.some(c => c.args[0] === "checkout")).toBe(false);
  });

  it("하위호환: branch_strategy:'topic' 인 기존 STATE 는 isolate 처럼 base_branch 에서 체크아웃한다", async () => {
    // state.ts 의 preprocess 가 "topic" → "isolate" 로 정규화하지만, 여기서는 그 정규화가
    // orchestrator 의 실제 판정(체크아웃 호출)에도 반영되는지 통합 검증한다.
    const raw = { ...makeState({ base_branch: "main", phases: [makeState().phases[0]] }), branch_strategy: "topic" };
    fs.writeFileSync(path.join(dir, "STATE.json"), JSON.stringify(raw, null, 2));
    const { git, calls } = makeGitStub({ branch: "main", branchExists: false });
    const d = { ...deps(stubRunner(["touch-and-done"])), git };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    expect(s.branch_strategy).toBe("isolate"); // 로드 시점에 정규화됨
    const checkoutCall = calls.find(c => c.args[0] === "checkout");
    expect(checkoutCall?.args).toEqual(["checkout", "-b", "feature/wf"]);
  });
});

describe("§26 C2/I4: 브랜치 격리가 attempt 내내 유지되는지 재확인 + 커밋의 브랜치 도달성 검증", () => {
  it("isolate: 세션이 격리 브랜치를 벗어나면 회송한다(fixContext + deps.log) — 게이트/커밋 검증까지 가지 않는다", async () => {
    saveState(dir, makeState({
      branch_strategy: "isolate", base_branch: "main",
      phases: [{ ...makeState().phases[0], max_attempts: 2 }],
    }));
    const { git, setBranch } = makeGitStub({ branch: "main", branchExists: false });
    const fixContexts: Array<string | undefined> = [];
    const logs: string[] = [];
    let calls = 0;
    const runner: SessionRunner = {
      async runPhase(req) {
        calls++;
        fixContexts.push(req.fixContext);
        if (calls === 1) {
          setBranch("main"); // 격리 브랜치(feature/wf)를 벗어나 main 으로 이탈
          return { status: "done", summary: "ok", commits: ["c1"], sessionId: "s1" };
        }
        setBranch("feature/wf"); // fixContext 지시대로 2차 시도에서 격리 브랜치로 복귀했다고 가정
        touchHandoff();
        return { status: "done", summary: "ok", commits: ["c2"], sessionId: "s2" };
      },
      async runFixSession() { return { status: "done", summary: "x", commits: [] }; },
      async runVerifyAgent() { return { status: "done", summary: "ok", commits: [] }; },
    };
    let gateCalls = 0;
    const gate = async (): Promise<GateResult> => { gateCalls++; return { passed: true, results: [] }; };
    const d = { ...deps(runner, gate), git, log: (m: string) => logs.push(m) };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    expect(s.phases[0].attempts).toBe(2); // 1차 이탈로 소진, 2차 정상 진행
    expect(fixContexts[1]).toContain("feature/wf");
    expect(logs.some(l => l.includes("이탈"))).toBe(true);
    expect(gateCalls).toBe(1); // 1차는 이탈 감지로 게이트 실행 전에 회송됨
  });

  // §25 리팩토링이 드러낸 결함: 이탈 검사가 blocked 판정보다 먼저 돌아 `continue` 로 빠져나가면
  // 세션의 질문이 사용자에게 전달되지 않고 사라지고, blocked 분기의 `attempts -= 1` 에도 도달하지
  // 못해 attempt 까지 소모됐다. max_attempts 기본 2 면 그런 세션 두 번으로 phase 가 failed 가 되고
  // 사용자는 질문을 영원히 못 본다 — BLOCKED 규약이 조용히 폐기되는 셈이다.
  it("이탈 + blocked 가 동시에 발생하면 질문을 삼키지 않고 표면화한다 (BLOCKED 규약 우선)", async () => {
    saveState(dir, makeState({
      branch_strategy: "isolate", base_branch: "main",
      phases: [{ ...makeState().phases[0], max_attempts: 2 }],
    }));
    const { git, setBranch } = makeGitStub({ branch: "main", branchExists: false });
    const logs: string[] = [];
    const notified: Array<[string, string]> = [];
    let calls = 0;
    const runner: SessionRunner = {
      async runPhase() {
        calls++;
        setBranch("main"); // 이탈하고서
        return { status: "blocked", summary: "물어볼 게 있다", question: "이 설정을 어느 파일에 둘까요?", commits: [], sessionId: "s1" };
      },
      async runFixSession() { return { status: "done", summary: "x", commits: [] }; },
      async runVerifyAgent() { return { status: "done", summary: "ok", commits: [] }; },
    };
    const d = {
      ...deps(runner),
      git,
      log: (m: string) => logs.push(m),
      notify: (t: string, m: string) => { notified.push([t, m]); },
    };
    const s = await runWorkflow(dir, d);

    expect(s.status).toBe("blocked");                       // 질문이 사라지지 않는다
    expect(s.pending_question?.question).toContain("어느 파일에 둘까요");
    expect(s.pending_question?.question).toContain("함께 발생"); // 이탈 사실도 함께 전달
    expect(s.phases[0].attempts).toBe(0);                   // 질문은 실패가 아니다 — attempt 미소모
    expect(calls).toBe(1);                                  // 재시도로 태우지 않는다
    expect(logs.some(l => l.includes("이탈"))).toBe(true);   // 이탈은 별개 사실로 로그에 남는다
    expect(notified.some(([t]) => t === "fw BLOCKED")).toBe(true);
  });

  it("require-topic: 세션이 토픽 브랜치를 벗어나면 회송한다", async () => {
    saveState(dir, makeState({
      branch_strategy: "require-topic", base_branch: "main",
      phases: [{ ...makeState().phases[0], max_attempts: 2 }],
    }));
    const { git, setBranch } = makeGitStub({ branch: "my-topic" });
    let calls = 0;
    const runner: SessionRunner = {
      async runPhase() {
        calls++;
        if (calls === 1) {
          setBranch("main");
          return { status: "done", summary: "ok", commits: ["c1"], sessionId: "s1" };
        }
        setBranch("my-topic"); // fixContext 지시대로 2차 시도에서 토픽 브랜치로 복귀했다고 가정
        touchHandoff();
        return { status: "done", summary: "ok", commits: ["c2"], sessionId: "s2" };
      },
      async runFixSession() { return { status: "done", summary: "x", commits: [] }; },
      async runVerifyAgent() { return { status: "done", summary: "ok", commits: [] }; },
    };
    const d = { ...deps(runner), git };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    expect(s.phases[0].attempts).toBe(2);
  });

  it("current 전략은 브랜치 이탈을 감시하지 않는다 (사용자에게 브랜치 자유를 위임)", async () => {
    saveState(dir, makeState({ branch_strategy: "current", base_branch: "main", phases: [makeState().phases[0]] }));
    const { git, setBranch } = makeGitStub({ branch: "already-topic" });
    const runner: SessionRunner = {
      async runPhase() {
        setBranch("yet-another-branch"); // current 전략에서는 자유롭게 이동해도 무방
        touchHandoff();
        return { status: "done", summary: "ok", commits: ["c1"], sessionId: "s1" };
      },
      async runFixSession() { return { status: "done", summary: "x", commits: [] }; },
      async runVerifyAgent() { return { status: "done", summary: "ok", commits: [] }; },
    };
    const d = { ...deps(runner), git };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    expect(s.phases[0].attempts).toBe(1); // 이탈 감시가 없으니 1차에 바로 통과
  });

  it("커밋이 작업 브랜치에서 도달 불가능하면(다른 브랜치에서 커밋) 회송한다 — 세션이 끝에 다시 체크아웃해 브랜치 검사만 통과해도 잡힌다", async () => {
    saveState(dir, makeState({
      branch_strategy: "isolate", base_branch: "main",
      phases: [{ ...makeState().phases[0], max_attempts: 2 }],
    }));
    const { git } = makeGitStub({ branch: "main", branchExists: false, reachable: false });
    let calls = 0;
    const runner: SessionRunner = {
      async runPhase() {
        calls++;
        touchHandoff();
        return { status: "done", summary: "ok", commits: [`c${calls}`], sessionId: `s${calls}` };
      },
      async runFixSession() { return { status: "done", summary: "x", commits: [] }; },
      async runVerifyAgent() { return { status: "done", summary: "ok", commits: [] }; },
    };
    // headSha/verifyCommit 은 기본 스텁(ok:true)을 쓰되, 이 테스트는 branchReachable 만 실패하게 한다
    const d = { ...deps(runner), git, headSha: async () => "head0", branchReachable: async () => ({ ok: false, reason: "not an ancestor" }) };
    const s = await runWorkflow(dir, d);
    // 재시도를 다 소진해도 도달 불가능하면(항상 false) FAILED 로 안전하게 정지해야 한다
    expect(s.status).toBe("failed");
    expect(s.phases[0].attempts).toBe(2);
  });

  it("I4: detached HEAD 에서 isolate 는 격리 브랜치를 만든다", async () => {
    saveState(dir, makeState({ branch_strategy: "isolate", base_branch: "main", phases: [makeState().phases[0]] }));
    const { git, calls } = makeGitStub({ branch: "main", detached: true, branchExists: false });
    const d = { ...deps(stubRunner(["touch-and-done"])), git };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    const checkoutCall = calls.find(c => c.args[0] === "checkout");
    expect(checkoutCall?.args).toEqual(["checkout", "-b", "feature/wf"]);
  });

  it("I4: detached HEAD 에서 require-topic 은 세션 없이 거부한다", async () => {
    saveState(dir, makeState({ branch_strategy: "require-topic", base_branch: "main", phases: [makeState().phases[0]] }));
    const { git } = makeGitStub({ branch: "main", detached: true });
    let ranPhase = false;
    const runner: SessionRunner = {
      async runPhase() { ranPhase = true; return { status: "done", summary: "ok", commits: ["c"], sessionId: "s" }; },
      async runFixSession() { return { status: "done", summary: "x", commits: [] }; },
      async runVerifyAgent() { return { status: "done", summary: "ok", commits: [] }; },
    };
    const d = { ...deps(runner), git };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("failed");
    expect(ranPhase).toBe(false);
    expect(d.notes.some(n => n.includes("FAILED") && n.includes("detached"))).toBe(true);
  });

  it("I4: 동명 태그가 있어도(show-ref 미사용시 오판할 rev-parse --verify 결과) 브랜치 존재를 정확히 판정한다", async () => {
    // makeGitStub 은 production 코드가 실제로 show-ref 를 호출한다는 전제로 branchExists 를 판정한다.
    // 이 테스트는 그 판정 함수 자체(show-ref 사용)를 검증한다 — rev-parse --verify 였다면 동명 태그가
    // 있을 때도 존재로 오판했을 것이다. branchExists:false(브랜치는 없지만 동명 태그는 있다고 가정)로
    // 설정해 -b(신규 생성)로 체크아웃하는지 확인한다.
    saveState(dir, makeState({ branch_strategy: "isolate", base_branch: "main", phases: [makeState().phases[0]] }));
    const { git, calls } = makeGitStub({ branch: "main", branchExists: false });
    const d = { ...deps(stubRunner(["touch-and-done"])), git };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    // show-ref 로 판정했다는 증거 — rev-parse --verify 호출이 없어야 한다(§26 I4)
    expect(calls.some(c => c.args[0] === "rev-parse" && c.args.includes("--verify"))).toBe(false);
    expect(calls.some(c => c.args[0] === "show-ref")).toBe(true);
    const checkoutCall = calls.find(c => c.args[0] === "checkout");
    expect(checkoutCall?.args).toEqual(["checkout", "-b", "feature/wf"]);
  });
});

describe("§29 MI-12: 재개 경로(이미 격리 브랜치에 체크아웃된 상태)도 브랜치 이탈 감시를 계속 받는다", () => {
  // applyBranchStrategy(:264 부근) 의 "이미 base_branch 가 아닌 브랜치에 있음" 분기는 두 번째
  // `fw run` 이후 모든 재개가 타는 경로다(feature/<workflow> 가 이미 체크아웃돼 있으므로). 이 분기가
  // workBranch: currentBranch 대신 workBranch: null 로 퇴화해도(§29 감사가 실측한 mutation) 기존
  // 499개 테스트가 전부 통과했다 — "이미 격리 브랜치에 있는 상태로 재개하면 이탈 감시가 작동한다"는
  // 계약을 지키는 테스트가 하나도 없었기 때문이다. 이 테스트는 그 계약을 직접 못박는다: workBranch
  // 가 null 로 퇴화하면 세션의 브랜치 이탈이 감지되지 않아 1차 시도에 바로 통과(attempts=1)하지만,
  // 정상 동작(workBranch=currentBranch)이면 이탈이 감지되어 회송된다(attempts=2).
  it("isolate + 이미 격리 브랜치(feature/wf)에 체크아웃된 채 재개하면 workBranch 가 그 브랜치로 설정되어 이탈 감시가 작동한다", async () => {
    saveState(dir, makeState({
      branch_strategy: "isolate", base_branch: "main",
      phases: [{ ...makeState().phases[0], max_attempts: 2 }],
    }));
    // 재개 시나리오 재현: 두 번째 `fw run` 은 워킹트리가 이미 feature/wf 에 체크아웃된 채로 시작된다 —
    // applyBranchStrategy 는 "!detached && currentBranch !== base_branch" 분기를 타(:264), 새로
    // 체크아웃을 시도하지 않고 그 브랜치를 그대로 workBranch 로 채택해야 한다.
    const { git, calls, setBranch } = makeGitStub({ branch: "feature/wf" });
    let attempt = 0;
    const runner: SessionRunner = {
      async runPhase() {
        attempt++;
        if (attempt === 1) {
          setBranch("main"); // 세션이 격리 브랜치를 이탈
          return { status: "done", summary: "ok", commits: ["c1"], sessionId: "s1" };
        }
        setBranch("feature/wf"); // fixContext 지시대로 복귀했다고 가정
        touchHandoff();
        return { status: "done", summary: "ok", commits: ["c2"], sessionId: "s2" };
      },
      async runFixSession() { return { status: "done", summary: "x", commits: [] }; },
      async runVerifyAgent() { return { status: "done", summary: "ok", commits: [] }; },
    };
    const logs: string[] = [];
    const d = { ...deps(runner), git, log: (m: string) => logs.push(m) };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    // 재개 경로에서 이탈 감시가 작동했다는 직접 증거 — workBranch 가 null 로 퇴화하면 이 값은 1이 된다.
    expect(s.phases[0].attempts).toBe(2);
    expect(logs.some(l => l.includes("이탈"))).toBe(true);
    // 이미 격리 브랜치에 있었으므로 새로 체크아웃을 시도하지 않는다(사용자/이전 실행의 브랜치를 건드리지 않음)
    expect(calls.some(c => c.args[0] === "checkout")).toBe(false);
  });
});

describe("§26 I3: PR fix 루프 — fix 커밋도 게이트/push 를 거쳐야 handled 로 확정된다", () => {
  it("fix 세션 성공 시 게이트가 재실행되고(2회 이상), pushBranch 가 2회차(fix 반영분) 호출된다", async () => {
    saveState(dir, prState());
    const comment: RawComment = { id: 1, body: "@fw 고쳐주세요", author: "alice", isBot: false, createdAt: "t", kind: "issue" };
    const pr = stubPr({ views: [OPEN, MERGED], comments: [[comment], []] });
    let gateCalls = 0;
    const gate = async (): Promise<GateResult> => { gateCalls++; return passGate(); };
    const runner = {
      ...stubRunner(["touch-and-done"]),
      async runFixSession() { return { status: "done" as const, summary: "고침", commits: ["fix1"], addressed: ADDR }; },
    };
    const d = { ...deps(runner, gate), pr };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    // phase 검증 1회 + fix 검증 1회 이상 — 이전에는 fix 커밋이 게이트를 한 번도 거치지 않았다(§26 실측)
    expect(gateCalls).toBeGreaterThanOrEqual(2);
    // 최초 PR 생성 push + fix 반영 push — 이전에는 2회차가 아예 없어 리뷰어가 변경을 못 봤다
    expect(pr.pushed).toEqual(["fw/phase-1", "fw/phase-1"]);
    expect(s.phases[0].pr?.handled_comment_keys).toContain("issue:1");
    expect(pr.replies.some(r => r.includes("✅ issue:1 반영"))).toBe(true);
  });

  it("fix 세션 성공 후 재검증 게이트가 실패하면 handled 로 기록하지 않고 FAILED 로 정지하며 답글에 검증 실패를 언급한다", async () => {
    saveState(dir, prState());
    const comment: RawComment = { id: 2, body: "@fw 또 고쳐주세요", author: "alice", isBot: false, createdAt: "t", kind: "issue" };
    const pr = stubPr({ views: [OPEN], comments: [[comment]] });
    let gateCalls = 0;
    // 1회차(phase 본 검증)는 통과, 2회차(fix 재검증)는 실패
    const gate = async (): Promise<GateResult> => (++gateCalls === 1 ? passGate() : failGate());
    const runner = {
      ...stubRunner(["touch-and-done"]),
      async runFixSession() { return { status: "done" as const, summary: "고쳤다고 주장", commits: ["fix2"], addressed: ADDR }; },
    };
    const d = { ...deps(runner, gate), pr };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("failed");
    expect(s.phases[0].pr?.handled_comment_keys ?? []).not.toContain("issue:2");
    expect(pr.replies.some(r => r.includes("검증 실패"))).toBe(true);
    expect(d.notes.some(n => n.includes("FAILED") && n.includes("검증 실패"))).toBe(true);
    // 게이트를 통과하지 못했으므로 fix 분의 재푸시는 없어야 한다 (최초 생성 push 1회만)
    expect(pr.pushed).toEqual(["fw/phase-1"]);
  });

  it("fix 세션이 verify 대상 파일(package.json)을 위조하면 탐지되어 handled 기록 없이 FAILED 로 정지한다", async () => {
    const st = prState();
    st.phases[0] = { ...st.phases[0], verify: ["npm test"] };
    saveState(dir, st);
    const comment: RawComment = { id: 3, body: "@fw 테스트 좀 고쳐줘", author: "alice", isBot: false, createdAt: "t", kind: "issue" };
    const pr = stubPr({ views: [OPEN], comments: [[comment]] });
    let changedCalls = 0;
    // 1회차(phase 최초 실행의 기준점 확정용)는 위조 없음, 2회차(fix 재검증)에서 위조 발견
    const changedFiles = async () => { changedCalls++; return changedCalls === 1 ? { ok: true as const, files: [] } : { ok: true as const, files: ["package.json"] }; };
    const runner = {
      ...stubRunner(["touch-and-done"]),
      async runFixSession() { return { status: "done" as const, summary: "테스트를 항상 통과하게 고침", commits: ["fix3"], addressed: ADDR }; },
    };
    const d = { ...deps(runner), pr, headSha: async () => "head0", changedFiles };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("failed");
    expect(s.phases[0].pr?.handled_comment_keys ?? []).not.toContain("issue:3");
    expect(pr.replies.some(r => r.includes("검증 대상 파일 상태가 바뀌었습니다"))).toBe(true);
    expect(pr.replies.some(r => r.includes("package.json"))).toBe(true);
    // 위조가 감지되면 게이트/재푸시 없이 즉시 실패해야 한다 (최초 생성 push 1회만)
    expect(pr.pushed).toEqual(["fw/phase-1"]);
  });
});

describe("§29 CR-2: PR fix 세션도 phase 세션과 동일한 브랜치 이탈 감시를 받는다", () => {
  it("fix 세션이 격리 브랜치를 벗어나 커밋하면 handled 로 기록하지 않고 FAILED 로 정지한다 (§29 감사 실측 시나리오)", async () => {
    saveState(dir, prState()); // prState() 는 branch_strategy 기본값(isolate)+base_branch=main
    const { git, setBranch } = makeGitStub({ branch: "main", branchExists: false });
    const comment: RawComment = { id: 7, body: "@fw 고쳐주세요", author: "alice", isBot: false, createdAt: "t", kind: "issue" };
    const pr = stubPr({ views: [OPEN], comments: [[comment]] });
    const runner = {
      ...stubRunner(["touch-and-done"]),
      async runFixSession() {
        setBranch("main"); // §29 감사 실측: fix 세션이 격리 브랜치(feature/wf)를 벗어나 main 에 커밋
        return { status: "done" as const, summary: "fixed it", commits: ["fixsha"], addressed: ADDR };
      },
    };
    const d = { ...deps(runner), git, pr };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("failed");
    // 수정 전(§29 감사)에는 이 시나리오가 done + "✅ issue:7 반영" + handled 로 확정됐다.
    expect(s.phases[0].pr?.handled_comment_keys ?? []).not.toContain("issue:7");
    expect(pr.replies.some(r => r.includes("✅"))).toBe(false);
    expect(pr.replies.some(r => r.includes("검증 실패"))).toBe(true);
    // main tip 이 PR 브랜치로 강제 push 되지 않는다 (최초 생성 push 1회만)
    expect(pr.pushed).toEqual(["fw/phase-1"]);
  });

  it("branch_strategy=current 인 fix 세션은 브랜치 이탈 감시를 받지 않는다 (사용자에게 브랜치 자유 위임, 회귀 방지)", async () => {
    const st = makeState({
      pr_mode: true, allow_push: true, poll_interval_ms: 1, trusted_comment_authors: ["alice"],
      branch_strategy: "current", phases: [makeState().phases[0]],
    });
    saveState(dir, st);
    const { git, setBranch } = makeGitStub({ branch: "already-topic" });
    const comment: RawComment = { id: 9, body: "@fw 고쳐주세요", author: "alice", isBot: false, createdAt: "t", kind: "issue" };
    const pr = stubPr({ views: [OPEN, MERGED], comments: [[comment], []] });
    const runner = {
      ...stubRunner(["touch-and-done"]),
      async runFixSession() {
        setBranch("yet-another-branch"); // current 전략에서는 자유롭게 이동해도 무방
        return { status: "done" as const, summary: "fixed it", commits: ["fixsha"], addressed: ADDR };
      },
    };
    const d = { ...deps(runner), git, pr };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    expect(s.phases[0].pr?.handled_comment_keys).toContain("issue:9");
  });
});

describe("§29 CR-3: 아무 것도 안 한(또는 stale SHA 를 보고한) fix 세션은 handled 로 기록되지 않는다", () => {
  it("fix 세션이 커밋 없이 done 을 주장하면 handled 기록·✅ 답글 없이 FAILED 로 정지한다 (무작업 fix)", async () => {
    saveState(dir, prState());
    const comment: RawComment = { id: 7, body: "@fw 고쳐주세요", author: "alice", isBot: false, createdAt: "t", kind: "issue" };
    const pr = stubPr({ views: [OPEN], comments: [[comment]] });
    const runner = {
      ...stubRunner(["touch-and-done"]),
      async runFixSession() { return { status: "done" as const, summary: "fixed it", commits: [] }; },
    };
    const d = { ...deps(runner), pr };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("failed");
    expect(s.phases[0].pr?.handled_comment_keys ?? []).not.toContain("issue:7");
    expect(pr.replies.some(r => r.includes("✅"))).toBe(false);
    expect(pr.pushed).toEqual(["fw/phase-1"]); // fix 반영분 재푸시 없음(no-op 재push 도 안 됨)
  });

  it("fix 세션이 headBeforeFix 와 동일한(신규 아닌) SHA 를 보고하면 handled 기록 없이 FAILED 로 정지한다 (stale SHA)", async () => {
    saveState(dir, prState());
    const comment: RawComment = { id: 8, body: "@fw 고쳐주세요", author: "alice", isBot: false, createdAt: "t", kind: "issue" };
    const pr = stubPr({ views: [OPEN], comments: [[comment]] });
    const runner = {
      ...stubRunner(["touch-and-done"]),
      async runFixSession() { return { status: "done" as const, summary: "fixed it", commits: ["stale-sha"], addressed: ADDR }; },
    };
    const d = {
      ...deps(runner), pr,
      headSha: async () => "stale-sha", // fix 세션 실행 직전 HEAD 와 동일한 sha 를 그대로 보고(아무 것도 안 함)
      verifyCommit: async (_cwd: string, sha: string, headBefore: string | null) => ({ ok: sha !== headBefore }),
    };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("failed");
    expect(s.phases[0].pr?.handled_comment_keys ?? []).not.toContain("issue:8");
    expect(pr.pushed).toEqual(["fw/phase-1"]);
  });
});

describe("§29 MI-11: PR fix 배치 — 게이트/push 는 코멘트별이 아니라 배치당 1회", () => {
  it("코멘트 5건이 모두 성공하면 게이트는 (phase 1 + fix 배치 1)회만 돌고 push 도 (생성 1 + 배치 1)회만 된다", async () => {
    saveState(dir, prState());
    const cs: RawComment[] = [1, 2, 3, 4, 5].map(id => (
      { id, body: "@fw 고쳐주세요", author: "alice", isBot: false, createdAt: `t${id}`, kind: "issue" as const }
    ));
    const pr = stubPr({ views: [OPEN, MERGED], comments: [cs, []] });
    let gateCalls = 0;
    const gate = async (): Promise<GateResult> => { gateCalls++; return passGate(); };
    const runner = {
      ...stubRunner(["touch-and-done"]),
      async runFixSession(input: FixPromptInput) {
        const id = input.comments[0]?.id;
        return { status: "done" as const, summary: `고침 ${id}`, commits: [`fix${id}`], addressed: ADDR };
      },
    };
    const d = { ...deps(runner, gate), pr };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    // 수정 전(§29 감사)이라면 코멘트 5건 → GATE 6회(phase 1 + fix 5) 였다.
    expect(gateCalls).toBe(2);
    // 수정 전이라면 push 도 6회(생성 1 + fix 5) 였다.
    expect(pr.pushed).toEqual(["fw/phase-1", "fw/phase-1"]);
    expect(s.phases[0].pr?.handled_comment_keys).toEqual(["issue:1", "issue:2", "issue:3", "issue:4", "issue:5"]);
    // 개별 코멘트 답글은 배치와 무관하게 코멘트당 1건씩 그대로 남는다
    expect(pr.replies.filter(r => r.includes("✅")).length).toBe(5);
  });

  it("배치 중 3번째 코멘트가 blocked 로 끊기면 1·2번째의 게이트/push/handled 는 이미 확정되어 있다 (부분 성공 보존 유지)", async () => {
    saveState(dir, prState());
    const c = (id: number): RawComment =>
      ({ id, body: "@fw 고쳐주세요", author: "alice", isBot: false, createdAt: `t${id}`, kind: "issue" });
    const pr = stubPr({ views: [OPEN], comments: [[c(1), c(2), c(3)]] });
    let gateCalls = 0;
    const gate = async (): Promise<GateResult> => { gateCalls++; return passGate(); };
    const runner = {
      ...stubRunner(["touch-and-done"]),
      async runFixSession(input: FixPromptInput) {
        const id = input.comments[0]?.id;
        if (id === 3) return { status: "blocked" as const, summary: "모호함", question: "?", commits: [] };
        return { status: "done" as const, summary: `고침 ${id}`, commits: [`fix${id}`], addressed: ADDR };
      },
    };
    const d = { ...deps(runner, gate), pr };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("blocked");
    // 1·2번째는 3번째가 blocked 되기 전에 flush 로 이미 확정되어 있어야 한다
    expect(s.phases[0].pr?.handled_comment_keys).toEqual(["issue:1", "issue:2"]);
    expect(gateCalls).toBe(2); // phase 1 + fix 배치(1·2번째) 1회 — 3번째는 게이트를 타지 않는다
    expect(pr.pushed).toEqual(["fw/phase-1", "fw/phase-1"]);
  });
});

// isolate 전략에서 모든 phase 가 같은 로컬 브랜치(feature/wf)를 공유한다 — squash/rebase 머지 시
// phase 2 의 PR 에 phase 1 커밋이 함께 담기는 결함(M5)을 재현하려면 phase 가 2개 이상이어야 한다.
// makeState() 의 기본 phases(1: 의존성 없음, 2: depends_on [1])를 그대로 쓴다. top-level 함수로 둬
// §26 M5 와 §29 MI-6 양쪽 describe 블록에서 재사용한다.
function twoPhasePrIsolateState(overrides: Partial<State> = {}): State {
  return makeState({
    pr_mode: true, allow_push: true, poll_interval_ms: 1,
    trusted_comment_authors: ["alice"],
    branch_strategy: "isolate", base_branch: "main",
    ...overrides,
  });
}

describe("§26 M5: isolate+PR 모드 — squash/rebase 머지 대비 격리 브랜치 갱신", () => {
  it("squash 머지(merged) + 다음 phase 존재 → fetch 후 격리 브랜치를 origin/base 위로 재생성한다(checkout -B)", async () => {
    saveState(dir, twoPhasePrIsolateState());
    const { git, calls } = makeGitStub({ branch: "main", branchExists: false });
    const pr = stubPr({ views: [MERGED, APPROVED] }); // phase1: merged, phase2: approve 로 정지
    const d = { ...deps(stubRunner(["touch-and-done", "touch-and-done"])), git, pr };
    const s = await runWorkflow(dir, d);

    expect(s.phases[0].status).toBe("done");
    expect(s.status).toBe("awaiting_merge"); // phase2 는 승인 대기로 정지

    const fetchCalls = calls.filter(c => c.args[0] === "fetch").map(c => c.args);
    expect(fetchCalls).toEqual([
      ["fetch", "origin", "main"],
      ["fetch", "origin", "fw/phase-1"],
    ]);
    const revList = calls.find(c => c.args[0] === "rev-list");
    // §29 MI-6: 미push 판정은 HEAD 가 아니라 파괴 대상 자신(refs/heads/feature/<workflow>)을 잰다 —
    // 이전에는 origin/<headBranch>..HEAD 로 HEAD 를 쟀는데, HEAD 가 격리 브랜치와 달라지면(세션
    // 이탈 등) 엉뚱한 ref 를 재고도 통과시켰다(실측, §29 감사).
    expect(revList?.args).toEqual(["rev-list", "--count", "origin/fw/phase-1..refs/heads/feature/wf"]);
    const resetCheckout = calls.find(c => c.args[0] === "checkout" && c.args[1] === "-B");
    // §41 I-4(branch.ts, 다른 에이전트 소유) 후속 — 재생성이 `--no-track` 없이 이뤄지면
    // branch.autoSetupMerge 기본값이 이 격리 브랜치에 upstream(main)을 조용히 심어, 사용자
    // push.default 설정에 따라 이후 `git push` 가 엉뚱하게 main 으로 갈 수 있었다(실측,
    // branch.test.ts "§41 I-4 회귀" 가 그 계약을 전담해서 검증한다). 이 테스트는 orchestrator.ts
    // 가 그 인자를 그대로 전달만 하는지(배선)를 보므로, 여기서는 인자 목록만 맞춰준다.
    expect(resetCheckout?.args).toEqual(["checkout", "-B", "feature/wf", "--no-track", "origin/main"]);
    // 안전 가드(rev-list) 확인이 재생성(checkout -B)보다 먼저 일어나야 한다 (순서 보장)
    expect(calls.indexOf(revList!)).toBeLessThan(calls.indexOf(resetCheckout!));
  });

  it("마지막 phase 면 격리 브랜치 갱신을 건너뛴다 (fetch/checkout -B 호출 없음)", async () => {
    saveState(dir, prState()); // prState() 는 isolate(기본값) + phase 1개 뿐(마지막=유일한 phase)
    const { git, calls } = makeGitStub({ branch: "main", branchExists: false });
    const pr = stubPr({ views: [MERGED] });
    const d = { ...deps(stubRunner(["touch-and-done"])), git, pr };
    const s = await runWorkflow(dir, d);

    expect(s.status).toBe("done");
    expect(calls.some(c => c.args[0] === "fetch")).toBe(false);
    expect(calls.some(c => c.args[0] === "checkout" && c.args[1] === "-B")).toBe(false);
  });

  it("current 전략은 머지 후에도 로컬 브랜치를 건드리지 않고 힌트만 로그한다(사용자 소유 브랜치는 리셋 금지)", async () => {
    saveState(dir, twoPhasePrIsolateState({ branch_strategy: "current" }));
    const { git, calls } = makeGitStub({ branch: "already-topic" }); // current 는 브랜치를 감시하지 않는다
    const pr = stubPr({ views: [MERGED, APPROVED] });
    const logs: string[] = [];
    const d = { ...deps(stubRunner(["touch-and-done", "touch-and-done"])), git, pr, log: (m: string) => logs.push(m) };
    const s = await runWorkflow(dir, d);

    expect(calls.some(c => c.args[0] === "fetch")).toBe(false);
    expect(calls.some(c => c.args[0] === "checkout")).toBe(false);
    expect(logs.filter(l => l.includes("갱신하지") && l.includes("current"))).toHaveLength(1); // 1회만
  });

  it("require-topic 전략(사용자 토픽 브랜치)도 머지 후 로컬 브랜치를 건드리지 않고 힌트만 로그한다", async () => {
    saveState(dir, twoPhasePrIsolateState({ branch_strategy: "require-topic" }));
    const { git, calls } = makeGitStub({ branch: "my-topic" });
    const pr = stubPr({ views: [MERGED, APPROVED] });
    const logs: string[] = [];
    const d = { ...deps(stubRunner(["touch-and-done", "touch-and-done"])), git, pr, log: (m: string) => logs.push(m) };
    const s = await runWorkflow(dir, d);

    expect(calls.some(c => c.args[0] === "fetch")).toBe(false);
    expect(calls.some(c => c.args[0] === "checkout")).toBe(false);
    expect(logs.some(l => l.includes("갱신하지") && l.includes("require-topic"))).toBe(true);
  });

  it("로컬 HEAD 에 push 되지 않은 커밋이 있으면 갱신을 건너뛰고 경고 로그를 남긴다 (awaiting_merge 정지 중 사람이 로컬 커밋한 경우 대비)", async () => {
    saveState(dir, twoPhasePrIsolateState());
    const { git, calls } = makeGitStub({ branch: "main", branchExists: false, unpushedCount: 2 });
    const pr = stubPr({ views: [MERGED, APPROVED] });
    const logs: string[] = [];
    const d = { ...deps(stubRunner(["touch-and-done", "touch-and-done"])), git, pr, log: (m: string) => logs.push(m) };
    const s = await runWorkflow(dir, d);

    expect(calls.some(c => c.args[0] === "fetch")).toBe(true); // 안전 가드 판단을 위해 fetch 는 수행한다
    expect(calls.some(c => c.args[0] === "checkout" && c.args[1] === "-B")).toBe(false); // 리셋은 건너뜀
    expect(logs.some(l => l.includes("push 되지 않은 커밋") && l.includes("건너"))).toBe(true);
    // 안전 가드로 갱신을 건너뛰어도 phase 자체의 완료 판정(누적 PR 로 퇴화)은 막지 않는다
    expect(s.phases[0].status).toBe("done");
    expect(s.status).toBe("awaiting_merge");
  });

  it("격리 브랜치 재생성 체크아웃이 실패해도 throw 하지 않고 로그만 남긴 채 누적 PR 로 퇴화한다", async () => {
    saveState(dir, twoPhasePrIsolateState());
    const { git, calls } = makeGitStub({ branch: "main", branchExists: false, failResetCheckout: true });
    const pr = stubPr({ views: [MERGED, APPROVED] });
    const logs: string[] = [];
    const d = { ...deps(stubRunner(["touch-and-done", "touch-and-done"])), git, pr, log: (m: string) => logs.push(m) };
    const s = await runWorkflow(dir, d);

    const resetCheckout = calls.find(c => c.args[0] === "checkout" && c.args[1] === "-B");
    expect(resetCheckout).toBeDefined(); // 재생성을 시도는 했다
    expect(s.phases[0].status).toBe("done"); // 실패해도 phase1 완료 판정은 그대로 유지된다 (throw 없음)
    expect(s.status).toBe("awaiting_merge"); // phase2 로 계속 진행됨 — 워크플로우가 멈추지 않는다
    expect(logs.some(l => l.includes("재생성 체크아웃 실패"))).toBe(true);
  });

  it("base fetch 실패 시에도 throw 하지 않고 갱신을 건너뛴다(누적 PR 로 퇴화)", async () => {
    saveState(dir, twoPhasePrIsolateState());
    const { git, calls } = makeGitStub({ branch: "main", branchExists: false, fetchFails: true });
    const pr = stubPr({ views: [MERGED, APPROVED] });
    const logs: string[] = [];
    const d = { ...deps(stubRunner(["touch-and-done", "touch-and-done"])), git, pr, log: (m: string) => logs.push(m) };
    const s = await runWorkflow(dir, d);

    expect(calls.some(c => c.args[0] === "checkout" && c.args[1] === "-B")).toBe(false);
    expect(calls.some(c => c.args[0] === "rev-list")).toBe(false); // fetch 실패 시 그 다음 단계로 안 간다
    expect(s.phases[0].status).toBe("done");
    expect(logs.some(l => l.includes("fetch 실패"))).toBe(true);
  });
});

describe("§29 MI-6: M5 안전 가드가 파괴 대상(feature/<workflow>) 자신을 재고, HEAD 이탈 시 거부한다", () => {
  it("HEAD 가 격리 브랜치를 벗어나 있으면 재생성을 거부한다 (무관한 ref 를 재고 통과시키지 않는다)", async () => {
    // §29 감사 실측: CR-2 류 이탈로 HEAD 가 main 에 남은 뒤 머지가 감지되면, 수정 전 코드는
    // origin/<headBranch>..HEAD 로 "HEAD"(=main)를 재 미push=0 으로 오판해 파괴적 리셋
    // (checkout -B feature/<workflow> origin/<base>)을 통과시켰다 — 정직한 phase 커밋이 reflog 에만
    // 남고 어느 ref 에서도 도달 불가능해졌다. 이 테스트는 그 리셋이 이제는 거부됨을 확인한다.
    const st = twoPhasePrIsolateState();
    st.phases[1].max_attempts = 1; // phase2 는 이 테스트의 관심사가 아니다 — 빨리 끝나게 한다
    saveState(dir, st);
    const { git, calls, setBranch } = makeGitStub({ branch: "main", branchExists: false });
    const pr: PrClient = {
      async pushBranch() {},
      async createPr() { return { number: 42, url: "https://ex/pull/42" }; },
      async listComments() { return []; },
      async viewPr() {
        // "머지를 확인하는 시점에 이미 HEAD 가 격리 브랜치를 벗어나 있다"를 재현한다 — 예: 사람이
        // awaiting_merge 대기 중 로컬에서 다른 브랜치로 옮겨갔거나, CR-2 이탈이 감시를 뚫었던
        // 과거 결함이 남긴 잔재.
        setBranch("main");
        return MERGED;
      },
      async postReviewComments() {},
      async postPrComment() {},
    };
    const logs: string[] = [];
    const d = { ...deps(stubRunner(["touch-and-done", "touch-and-done"])), git, pr, log: (m: string) => logs.push(m) };
    const s = await runWorkflow(dir, d);

    expect(s.phases[0].status).toBe("done"); // phase1 자체의 머지 판정은 정상
    expect(calls.some(c => c.args[0] === "fetch")).toBe(false); // 갱신 시도(fetch) 자체를 안 한다
    expect(calls.some(c => c.args[0] === "checkout" && c.args[1] === "-B")).toBe(false); // 파괴적 리셋 없음
    expect(logs.some(l => l.includes("위에 있지 않아") && l.includes("건너"))).toBe(true);
  });

  it("head 브랜치 fetch 가 실패해도(GHE 머지 시 브랜치 자동 삭제 등) origin/<base> 기준으로 대체해 갱신을 계속한다", async () => {
    // §29 감사 부수 발견: "머지 시 head 브랜치 자동 삭제"(사내 흔한 기본값)가 켜져 있으면
    // `git fetch origin fw/phase-<id>` 가 "찾을 수 없음"으로 실패해 수정 전에는 M5 갱신 자체가
    // 아예 발동하지 않았다(M5 가 고치려던 squash 누적 문제가 그 구성에서 그대로 남았다).
    saveState(dir, twoPhasePrIsolateState());
    const { git, calls } = makeGitStub({ branch: "main", branchExists: false, fetchFailsFor: ["fw/phase-1"] });
    const pr = stubPr({ views: [MERGED, APPROVED] });
    const logs: string[] = [];
    const d = { ...deps(stubRunner(["touch-and-done", "touch-and-done"])), git, pr, log: (m: string) => logs.push(m) };
    const s = await runWorkflow(dir, d);

    expect(s.phases[0].status).toBe("done");
    expect(s.status).toBe("awaiting_merge");
    // head fetch 는 실패하지만 base fetch 는 성공하므로 갱신은 origin/<base> 기준으로 계속된다
    const fetchCalls = calls.filter(c => c.args[0] === "fetch").map(c => c.args);
    expect(fetchCalls).toEqual([["fetch", "origin", "main"], ["fetch", "origin", "fw/phase-1"]]);
    const revList = calls.find(c => c.args[0] === "rev-list");
    expect(revList?.args).toEqual(["rev-list", "--count", "origin/main..refs/heads/feature/wf"]); // origin/base 로 대체
    const resetCheckout = calls.find(c => c.args[0] === "checkout" && c.args[1] === "-B");
    // §41 I-4(branch.ts, 다른 에이전트 소유) 후속 — 위 첫 번째 M5 테스트와 동일한 이유로
    // --no-track 이 붙는다(배선만 확인, 계약 자체는 branch.test.ts 전담).
    expect(resetCheckout?.args).toEqual(["checkout", "-B", "feature/wf", "--no-track", "origin/main"]); // 재생성 자체는 정상 진행
    expect(logs.some(l => l.includes("fetch 실패") && l.includes("origin/main"))).toBe(true);
  });
});

// §27 O2(비용·시간 상한)/O3(킬 스위치) — §2 D16/D17, §30 P1/P2 를 그대로 검증한다.
describe("§27 O2: 비용 상한 (max_cost_usd)", () => {
  it("이미 누적된 비용이 상한을 넘었으면, 다음 phase 의 attempt 를 시작하지 않고 halted 로 정지한다 (체크포인트 ①)", async () => {
    const base = makeState();
    const st = makeState({
      max_cost_usd: 1,
      phases: [
        {
          ...base.phases[0], status: "done", attempts: 1,
          sessions: [{ session_id: "s1", result: "done", at: "t", kind: "phase", cost_usd: 5 }],
        },
        base.phases[1],
      ],
    });
    saveState(dir, st);
    const runner: SessionRunner = {
      async runPhase() { throw new Error("호출되면 안 됨 — 비용 상한 체크포인트가 먼저 걸려야 한다"); },
      async runVerifyAgent() { return { status: "done", summary: "이상 없음", commits: [] }; },
      async runFixSession() { return { status: "done", summary: "stub", commits: [] }; },
    };
    const d = deps(runner);
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("halted");
    expect(s.halt_reason).toContain("비용 상한 초과");
    expect(s.halt_reason).toContain("$5.00");
    expect(s.halt_reason).toContain("$1.00");
    expect(s.phases[1].attempts).toBe(0); // 새 attempt 를 시작하지 않았다
    expect(d.notes.some(n => n.includes("정지"))).toBe(true);
    expect(loadState(dir).status).toBe("halted"); // 디스크에도 확정 저장
  });

  it("상한 미설정(null/undefined)이면 비용이 얼마든 무제한으로 완주한다 (§30 P2 정상 경로)", async () => {
    const base = makeState();
    saveState(dir, makeState({
      phases: [
        {
          ...base.phases[0], status: "done", attempts: 1,
          sessions: [{ session_id: "s1", result: "done", at: "t", kind: "phase", cost_usd: 999 }],
        },
        base.phases[1],
      ],
    }));
    const d = deps(stubRunner(["touch-and-done"]));
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
  });

  it("상한을 설정했지만 누적 비용이 미달이면 정상 완주한다 (§30 P2 정상 경로)", async () => {
    const base = makeState();
    saveState(dir, makeState({
      max_cost_usd: 1000,
      phases: [
        {
          ...base.phases[0], status: "done", attempts: 1,
          sessions: [{ session_id: "s1", result: "done", at: "t", kind: "phase", cost_usd: 1 }],
        },
        base.phases[1],
      ],
    }));
    const d = deps(stubRunner(["touch-and-done"]));
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
  });
});

describe("§27 O2: 시간 상한 (max_runtime_ms) — deps.now() 기준, Date.now() 직접 사용 금지", () => {
  it("runWorkflow 진입 시각 대비 경과 시간이 상한을 넘으면 첫 attempt 전에 halted 로 정지한다", async () => {
    saveState(dir, makeState({ max_runtime_ms: 1_000 }));
    let calls = 0;
    // 1번째 호출(runStartedAt) = t0, 2번째 호출(체크포인트①의 경과 시간 계산) = t0+1시간
    const timestamps = ["2026-01-01T00:00:00.000Z", "2026-01-01T01:00:00.000Z"];
    const now = () => timestamps[Math.min(calls++, timestamps.length - 1)];
    const runner: SessionRunner = {
      async runPhase() { throw new Error("호출되면 안 됨 — 시간 상한 체크포인트가 먼저 걸려야 한다"); },
      async runVerifyAgent() { return { status: "done", summary: "이상 없음", commits: [] }; },
      async runFixSession() { return { status: "done", summary: "stub", commits: [] }; },
    };
    const d = { ...deps(runner), now };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("halted");
    expect(s.halt_reason).toContain("시간 상한 초과");
    expect(s.phases[0].attempts).toBe(0);
  });

  it("상한 미설정이면 시간이 얼마나 걸리든 무제한으로 완주한다 (§30 P2 정상 경로)", async () => {
    saveState(dir, makeState({ phases: [makeState().phases[0]] }));
    const d = deps(stubRunner(["touch-and-done"]));
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
  });

  it("PR 폴링 sleep 직후(다음 폴링 전) 체크포인트에서도 시간 상한을 확인한다 (체크포인트 ③)", async () => {
    const st = prState();
    st.max_runtime_ms = 2_500;
    saveState(dir, st);
    let n = 0;
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    const now = () => new Date(base + n++ * 1000).toISOString(); // 호출마다 1초씩 흐른다
    const pr = stubPr({ views: [OPEN], comments: [[]] });
    const d = { ...deps(stubRunner(["touch-and-done"])), pr, now, sleep: async () => {} };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("halted");
    expect(s.halt_reason).toContain("시간 상한 초과");
    // PR 은 이미 만들어졌고 in_review 로 남아있다 — 세션을 중간에 죽이지 않았다(§2 D17)
    expect(s.phases[0].pr).toBeDefined();
  });
});

describe("§27 O3: 킬 스위치 (STOP 파일)", () => {
  it("실행 도중 STOP 파일이 생기면 다음 phase attempt 전에 halted(operator) 로 정지한다", async () => {
    const st = makeState();
    saveState(dir, st);
    const runner: SessionRunner = {
      async runPhase(req) {
        if (req.phase.id === 1) {
          touchHandoff();
          // 운영자가 `fw stop` 을 실행한 상황을 흉내낸다 — 세션 도중이 아니라 세션이 끝난 뒤
          fs.writeFileSync(path.join(dir, "STOP"), "2026-08-27T00:00:00Z\n");
          return { status: "done" as const, summary: "ok", commits: ["abc"], sessionId: "s1" };
        }
        throw new Error("phase 2 는 호출되면 안 됨 — STOP 체크포인트가 먼저 걸려야 한다");
      },
      async runVerifyAgent() { return { status: "done", summary: "이상 없음", commits: [] }; },
      async runFixSession() { return { status: "done" as const, summary: "stub", commits: [] }; },
    };
    const d = deps(runner);
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("halted");
    expect(s.halt_reason).toBe("operator");
    expect(s.phases[0].status).toBe("done"); // 이미 끝난 phase 는 그대로 유지된다(§2 D17)
    expect(s.phases[1].attempts).toBe(0);
    // 체크포인트는 STOP 파일을 소비(삭제)하지 않는다 — 그건 다음 `fw run` 시작 시의 몫이다
    expect(fs.existsSync(path.join(dir, "STOP"))).toBe(true);
  });

  it("STOP 파일이 없으면 정상 완주한다 (§30 P2 정상 경로)", async () => {
    saveState(dir, makeState());
    const d = deps(stubRunner(["touch-and-done", "touch-and-done"]));
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
  });

  it("`fw run` 시작 시 STOP 파일이 있으면 소비(삭제)하고 로그를 남긴 뒤 정상 진행한다", async () => {
    saveState(dir, makeState({ phases: [makeState().phases[0]] }));
    fs.writeFileSync(path.join(dir, "STOP"), "이전 정지 요청\n");
    const logs: string[] = [];
    const d = { ...deps(stubRunner(["touch-and-done"])), log: (m: string) => logs.push(m) };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    expect(fs.existsSync(path.join(dir, "STOP"))).toBe(false); // 소비(삭제)됨
    expect(logs.some(l => l.includes("STOP"))).toBe(true); // 조용히 지우지 않는다
  });

  it("fix 세션 실행 전에도 STOP 을 확인한다 (체크포인트 ②, 부분 성공은 flush 로 보존)", async () => {
    const st = prState();
    saveState(dir, st);
    const c1: RawComment = { id: 1, body: "@fw 첫 코멘트", author: "alice", isBot: false, createdAt: "t1", kind: "issue" };
    const c2: RawComment = { id: 2, body: "@fw 둘째 코멘트", author: "alice", isBot: false, createdAt: "t2", kind: "issue" };
    const pr = stubPr({ views: [OPEN], comments: [[c1, c2]] });
    let fixCalls = 0;
    const runner = {
      ...stubRunner(["touch-and-done"]),
      async runFixSession(input: FixPromptInput) {
        fixCalls++;
        // 1건째 처리 직후 STOP 이 생겼다고 흉내낸다 — 2건째는 체크포인트에서 걸려야 한다
        if (input.comments[0]?.id === 1) fs.writeFileSync(path.join(dir, "STOP"), "t\n");
        return { status: "done" as const, summary: `반영 ${input.comments[0]?.id}`, commits: [`fix${input.comments[0]?.id}`], addressed: ADDR };
      },
    };
    const d = { ...deps(runner), pr };
    const s = await runWorkflow(dir, d);
    expect(fixCalls).toBe(1); // 2건째는 fix 세션이 호출되지 않았다
    expect(s.status).toBe("halted");
    expect(s.halt_reason).toBe("operator");
    // 1건째는 이미 검증까지 끝났으므로 flush 로 보존된다(부분 성공 보존, §26/§29 교훈과 동일한 원칙)
    expect(pr.replies.some(r => r.includes("✅ issue:1 반영"))).toBe(true);
    expect(s.phases[0].pr?.handled_comment_keys).toEqual(["issue:1"]);
  });
});

// §30 P1 체크리스트: checkHaltpoint 하나의 헬퍼가 세 지점 모두에서 "어떤 트리거든" 동작하는지
// 교차 확인한다 — 위에서는 체크포인트①은 비용/시간/STOP 3종, ②/③은 각 1종만 확인했다. 아래는
// 나머지 조합(②=비용, ③=STOP)을 추가해 세 체크포인트가 복붙이 아니라 같은 함수를 공유함을 보인다.
describe("§27/§30 P1: 체크포인트 ②③ 교차 확인 (같은 checkHaltpoint 헬퍼 공유)", () => {
  it("체크포인트 ②(fix 세션 실행 전)도 비용 상한을 확인한다", async () => {
    const st = prState();
    st.max_cost_usd = 1;
    saveState(dir, st);
    const c1: RawComment = { id: 1, body: "@fw 첫 코멘트", author: "alice", isBot: false, createdAt: "t1", kind: "issue" };
    const c2: RawComment = { id: 2, body: "@fw 둘째 코멘트", author: "alice", isBot: false, createdAt: "t2", kind: "issue" };
    const pr = stubPr({ views: [OPEN], comments: [[c1, c2]] });
    let fixCalls = 0;
    const runner = {
      ...stubRunner(["touch-and-done"]),
      async runFixSession(input: FixPromptInput) {
        fixCalls++;
        // 1건째 fix 세션 자체가 상한(1)을 넘는 비용을 기록한다 — 2건째 진입 전 체크포인트에서 걸린다
        return { status: "done" as const, summary: "반영", commits: [`fix${input.comments[0]?.id}`], costUsd: 5, addressed: ADDR };
      },
    };
    const d = { ...deps(runner), pr };
    const s = await runWorkflow(dir, d);
    expect(fixCalls).toBe(1);
    expect(s.status).toBe("halted");
    expect(s.halt_reason).toContain("비용 상한 초과");
    expect(s.phases[0].pr?.handled_comment_keys).toEqual(["issue:1"]); // 1건째는 flush 로 보존
  });

  it("체크포인트 ③(PR 폴링 sleep 후)도 STOP 을 확인한다", async () => {
    saveState(dir, prState());
    const pr: PrClient = {
      async pushBranch() {},
      async createPr() { return { number: 42, url: "https://ex/pull/42" }; },
      async listComments() { return []; },
      async viewPr() {
        // 첫 폴링 응답 시점에 운영자가 STOP 을 만들었다고 흉내낸다 — sleep 이후 체크포인트에서 걸린다
        fs.writeFileSync(path.join(dir, "STOP"), "t\n");
        return OPEN;
      },
      async postReviewComments() {},
      async postPrComment() {},
    };
    const d = { ...deps(stubRunner(["touch-and-done"])), pr, sleep: async () => {} };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("halted");
    expect(s.halt_reason).toBe("operator");
    expect(s.phases[0].pr).toBeDefined(); // PR 은 이미 만들어진 채로 in_review 유지
  });
});

describe("§27 O2/O3: halted 는 재개 가능하다 (blocked 와 다름, §2 D 표)", () => {
  it("halted 상태로 시작해도 거부되지 않고 이어서 완주한다", async () => {
    const base = makeState();
    const st = makeState({
      status: "halted", halt_reason: "operator",
      phases: [{ ...base.phases[0], status: "done", attempts: 1 }, base.phases[1]],
    });
    saveState(dir, st);
    const d = deps(stubRunner(["touch-and-done"]));
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    expect(s.phases[1].status).toBe("done");
  });

  it("halted 로 시작하고 STOP 이 남아있으면 소비 후 정상 진행한다 (`fw stop` 후 `fw run` 조합)", async () => {
    const st = makeState({
      status: "halted", halt_reason: "비용 상한 초과: $1.00 / $1.00",
      phases: [makeState().phases[0]],
    });
    saveState(dir, st);
    fs.writeFileSync(path.join(dir, "STOP"), "t\n");
    const d = deps(stubRunner(["touch-and-done"]));
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    expect(fs.existsSync(path.join(dir, "STOP"))).toBe(false);
  });
});

// §26 I5 잔여 승격: 단위 테스트(state.test.ts 의 assertRunnable)는 린트 로직 자체를 검증하고,
// 여기서는 실제 `fw run` 이 타는 경로(runWorkflow)가 그 거부를 그대로 물려받는지 — 즉 cli.ts 의
// `fw run` 이 실제로 "실행 중단" + 알림으로 끝나는 경로가 맞는지 — 를 통합 레벨에서 확인한다.
describe("§26 I5 잔여 승격: runWorkflow 가 verify 린트 거부를 그대로 전파한다 (`fw run` 통합 경로)", () => {
  it("무력화 패턴(`|| true`)이 있으면 세션을 한 번도 스폰하지 않고 즉시 거부한다", async () => {
    const st = makeState({ phases: [{ ...makeState().phases[0], verify: ["npm test || true"] }] });
    saveState(dir, st);
    let runPhaseCalls = 0;
    const runner: SessionRunner = {
      async runPhase() { runPhaseCalls++; return { status: "done", summary: "ok", commits: ["c"] }; },
      async runVerifyAgent() { return { status: "done", summary: "이상 없음", commits: [] }; },
      async runFixSession() { return { status: "done", summary: "x", commits: [] }; },
    };
    await expect(runWorkflow(dir, deps(runner))).rejects.toThrow(/게이트를 무력화합니다/);
    expect(runPhaseCalls).toBe(0); // 시작 자체가 거부되므로 세션 spawn 은 일어나지 않는다(유료 비용 없음)
    // §26 D9: 거부됐으니 STATE 도 그대로다(하네스가 running 으로 덮어쓰지 않는다)
    expect(loadState(dir).status).toBe("running");
  });

  it("정상 verify 명령(예: 'git --version')은 그대로 완주한다 (§30 P2 정상 경로 회귀)", async () => {
    const st = makeState({ phases: [{ ...makeState().phases[0], verify: ["git --version"] }] });
    saveState(dir, st);
    const s = await runWorkflow(dir, deps(stubRunner(["touch-and-done"])));
    expect(s.status).toBe("done");
  });
});

// §31 적대적 감사 C1/I8/m1 재발 방지. 설계 근거: specs/2026-08-26-feature-workflow-harness-design.md §31.
describe("§31 C1: fix 루프 blocked + 배치 flush(게이트) 실패 — 질문을 삼키지 않는다", () => {
  it("c1 fix 성공(pending) → c2 fix 가 blocked 반환 + 배치 flush 게이트 실패에도 pending_question 이 남는다", async () => {
    // 감사자 실측 재현: 트리거 코멘트 2건, c1 fix 성공→pending, c2 fix 가 blocked+question 반환,
    // 배치 게이트 실패. 수정 전에는 outcome=failed / status=running / pending_question=null 이었고
    // 세션이 낸 질문이 notify·PR 답글·런로그·STATE 어디에도 남지 않았다.
    saveState(dir, prState());
    const c1: RawComment = { id: 1, body: "@fw 고쳐주세요", author: "alice", isBot: false, createdAt: "t1", kind: "issue" };
    const c2: RawComment = { id: 2, body: "@fw 또 고쳐주세요", author: "alice", isBot: false, createdAt: "t2", kind: "issue" };
    const pr = stubPr({ views: [OPEN], comments: [[c1, c2]] });
    let gateCalls = 0;
    // 1회차: phase 자신의 verify 게이트(통과) — 2회차: c2 가 blocked 되며 트리거되는 c1 배치의
    // flush 게이트(실패, "배치 게이트 실패" 재현).
    const gate = async (): Promise<GateResult> => { gateCalls++; return gateCalls === 1 ? passGate() : failGate(); };
    const runner = {
      ...stubRunner(["touch-and-done"]),
      async runFixSession(input: FixPromptInput) {
        const id = input.comments[0]?.id;
        if (id === 2) {
          return { status: "blocked" as const, summary: "모호함", question: "★★ B 를 어느 파일에 둘까요?", commits: [] };
        }
        return { status: "done" as const, summary: `고침 ${id}`, commits: [`fix${id}`], addressed: ADDR };
      },
    };
    const d = { ...deps(runner, gate), pr };
    const s = await runWorkflow(dir, d);

    expect(s.status).toBe("blocked");
    expect(gateCalls).toBe(2);
    expect(s.pending_question).not.toBeNull();
    expect(s.pending_question?.question).toContain("어느 파일에 둘까요");
    expect(d.notes.some(n => n.includes("BLOCKED"))).toBe(true);
    // 디스크에도 반영되어 있어야 `fw answer` 로 재개할 수 있다
    expect(loadState(dir).pending_question).not.toBeNull();
  });

  it("blocked + 배치 flush 실패가 함께 나면 flush 실패 사실도 질문에 덧붙는다 (브랜치 이탈 패턴과 동일)", async () => {
    saveState(dir, prState());
    const c1: RawComment = { id: 1, body: "@fw 고쳐주세요", author: "alice", isBot: false, createdAt: "t1", kind: "issue" };
    const c2: RawComment = { id: 2, body: "@fw 또 고쳐주세요", author: "alice", isBot: false, createdAt: "t2", kind: "issue" };
    const pr = stubPr({ views: [OPEN], comments: [[c1, c2]] });
    let gateCalls = 0;
    const gate = async (): Promise<GateResult> => { gateCalls++; return gateCalls === 1 ? passGate() : failGate(); };
    const runner = {
      ...stubRunner(["touch-and-done"]),
      async runFixSession(input: FixPromptInput) {
        const id = input.comments[0]?.id;
        if (id === 2) return { status: "blocked" as const, summary: "모호함", question: "질문", commits: [] };
        return { status: "done" as const, summary: `고침 ${id}`, commits: [`fix${id}`], addressed: ADDR };
      },
    };
    const d = { ...deps(runner, gate), pr };
    const s = await runWorkflow(dir, d);

    expect(s.pending_question?.question).toContain("질문");
    expect(s.pending_question?.question).toContain("함께 발생");
    expect(s.pending_question?.question).toContain("flush");
  });
});

describe("§31 I8: STOP 정지가 배치 flush(게이트) 실패로 failed 로 뒤집히지 않는다", () => {
  it("STOP 감지 시 pending 배치 flush 가 실패해도 halted 상태를 유지한다 (failed 로 덮지 않는다)", async () => {
    // 감사자 실측 재현: 체크포인트②(fix 세션 실행 전) STOP 감지 + 배치 게이트 실패 →
    // 수정 전에는 outcome=failed 가 호출부의 state.status="failed" 로 덮여
    // status="failed"+halt_reason="operator" 라는 모순 상태가 됐다. 설계(§2 D16/D17)는
    // "halted 는 그냥 이어서 `fw run` 하면 재개" 인데, failed 면 `assertRunnable` 이
    // 재시작을 거부해 운영자가 `fw retry` 를 강요받는다.
    saveState(dir, prState());
    const c1: RawComment = { id: 1, body: "@fw 고쳐주세요", author: "alice", isBot: false, createdAt: "t1", kind: "issue" };
    const c2: RawComment = { id: 2, body: "@fw 또 고쳐주세요", author: "alice", isBot: false, createdAt: "t2", kind: "issue" };
    const pr = stubPr({ views: [OPEN], comments: [[c1, c2]] });
    let gateCalls = 0;
    // 1회차: phase 자신의 verify 게이트(통과) — 2회차: STOP 감지 시점에 확정하려는 c1 배치의
    // flush 게이트(실패).
    const gate = async (): Promise<GateResult> => { gateCalls++; return gateCalls === 1 ? passGate() : failGate(); };
    const runner = {
      ...stubRunner(["touch-and-done"]),
      async runFixSession(input: FixPromptInput) {
        const id = input.comments[0]?.id;
        if (id === 1) {
          // 운영자가 `fw stop` 을 실행한 상황을 흉내낸다 — c1 세션이 끝난 직후, c2 처리 전
          fs.writeFileSync(path.join(dir, "STOP"), "2026-08-27T00:00:00Z\n");
        }
        return { status: "done" as const, summary: `고침 ${id}`, commits: [`fix${id}`], addressed: ADDR };
      },
    };
    const d = { ...deps(runner, gate), pr };
    const s = await runWorkflow(dir, d);

    expect(s.status).toBe("halted");
    expect(s.halt_reason).toBe("operator");
    expect(loadState(dir).status).toBe("halted"); // 디스크에도 확정 저장
  });
});

describe("§31 m1: 상한 경계값 — 정확히 상한에 도달해도 정지한다 (>= 이지 > 가 아니다)", () => {
  it("누적 비용이 상한과 정확히 같으면(cost === max_cost_usd) halted 로 정지한다", async () => {
    const base = makeState();
    const st = makeState({
      max_cost_usd: 5,
      phases: [
        {
          ...base.phases[0], status: "done", attempts: 1,
          sessions: [{ session_id: "s1", result: "done", at: "t", kind: "phase", cost_usd: 5 }],
        },
        base.phases[1],
      ],
    });
    saveState(dir, st);
    const runner: SessionRunner = {
      async runPhase() { throw new Error("호출되면 안 됨 — 정확히 상한에 도달해도 정지해야 한다"); },
      async runVerifyAgent() { return { status: "done", summary: "이상 없음", commits: [] }; },
      async runFixSession() { return { status: "done", summary: "stub", commits: [] }; },
    };
    const d = deps(runner);
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("halted");
    expect(s.halt_reason).toContain("비용 상한 초과");
  });

  it("경과 시간이 상한과 정확히 같으면(elapsed === max_runtime_ms) halted 로 정지한다", async () => {
    saveState(dir, makeState({ max_runtime_ms: 1_000 }));
    let calls = 0;
    // 1번째 호출(runStartedAt) = t0, 2번째 호출(체크포인트①의 경과 시간 계산) = t0 + 정확히 1000ms
    const timestamps = ["2026-01-01T00:00:00.000Z", "2026-01-01T00:00:01.000Z"];
    const now = () => timestamps[Math.min(calls++, timestamps.length - 1)];
    const runner: SessionRunner = {
      async runPhase() { throw new Error("호출되면 안 됨 — 정확히 상한에 도달해도 정지해야 한다"); },
      async runVerifyAgent() { return { status: "done", summary: "이상 없음", commits: [] }; },
      async runFixSession() { return { status: "done", summary: "stub", commits: [] }; },
    };
    const d = { ...deps(runner), now };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("halted");
    expect(s.halt_reason).toContain("시간 상한 초과");
  });
});

// §36 §30 P4 후속 — phase 루프가 세션의 자기 주장(result)과 별개로 하네스의 실제 판정(verdict)을
// phase.sessions[] 에 남기는지 점검한다. §36 감사가 실측한 문제: 게이트가 attempt 를 회송해도
// STATE 에는 세션이 스스로 쓴 result:"done" 만 남아, 회송 여부/사유가 기계 기록에서 사라졌다.
describe("§36 §30 P4 — 하네스의 판정(verdict)을 phase.sessions 에 남긴다", () => {
  it("phase 가 게이트·커밋 검증을 통과해 done 이 되면 마지막 세션에 accepted 를 남긴다", async () => {
    saveState(dir, makeState({ phases: [makeState().phases[0]] }));
    const d = deps(stubRunner(["touch-and-done"]));
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    // §41 I-1 후속: 모든 phase 가 끝나면 verify 세션도 이 phase(유일한 phase 이므로 곧 마지막
    // phase)에 append 된다 — "phase 세션 자체의 판정"은 이제 sessions[0](phase 루프가 만든 세션)
    // 에서 확인한다. sessions[1] 이 verify 세션이라는 계약은 아래 §41 I-1 describe 가 전담한다.
    expect(s.phases[0].sessions).toHaveLength(2);
    expect(s.phases[0].sessions[0].kind).toBe("phase");
    expect(s.phases[0].sessions[0].verdict).toEqual({ outcome: "accepted" });
  });

  it("세션이 blocked 를 반환하면 session_blocked 로 판정한다 (attempt 는 소모되지 않는다)", async () => {
    saveState(dir, makeState());
    const d = deps(stubRunner([{ status: "blocked", summary: "질문", question: "A or B?", commits: [] }]));
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("blocked");
    expect(s.phases[0].sessions).toHaveLength(1);
    expect(s.phases[0].sessions[0].verdict).toEqual({ outcome: "session_blocked" });
  });

  it("세션이 스스로 failed 를 보고하면(이탈 없이) session_failed 로 판정하고 로그를 남긴다", async () => {
    saveState(dir, makeState({ phases: [makeState().phases[0]] }));
    const logs: string[] = [];
    const d = { ...deps(stubRunner([{ status: "failed", summary: "손 못 댐", commits: [] }, "touch-and-done"])), log: (m: string) => logs.push(m) };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    // §41 I-1 후속: +1 은 워크플로우 마무리에 붙는 verify 세션 (아래 sessions[2])
    expect(s.phases[0].sessions).toHaveLength(3);
    expect(s.phases[0].sessions[0].verdict).toEqual({ outcome: "session_failed", detail: "손 못 댐" });
    expect(s.phases[0].sessions[1].verdict).toEqual({ outcome: "accepted" });
    expect(s.phases[0].sessions[2].kind).toBe("verify");
    expect(s.phases[0].sessions[2].verdict).toEqual({ outcome: "accepted" });
    expect(logs.some(l => l.includes("failed") && l.includes("손 못 댐"))).toBe(true);
  });

  it("격리 브랜치를 이탈하면 bounced/branch_drift 로 판정한다 (session_failed 로 뭉개지 않는다)", async () => {
    saveState(dir, makeState({
      branch_strategy: "isolate", base_branch: "main",
      phases: [{ ...makeState().phases[0], max_attempts: 2 }],
    }));
    const { git, setBranch } = makeGitStub({ branch: "main", branchExists: false });
    let calls = 0;
    const runner: SessionRunner = {
      async runPhase() {
        calls++;
        if (calls === 1) {
          setBranch("main"); // 격리 브랜치(feature/wf)를 벗어남
          return { status: "done", summary: "ok", commits: ["c1"], sessionId: "s1" };
        }
        setBranch("feature/wf");
        touchHandoff();
        return { status: "done", summary: "ok", commits: ["c2"], sessionId: "s2" };
      },
      async runFixSession() { return { status: "done", summary: "x", commits: [] }; },
      async runVerifyAgent() { return { status: "done", summary: "ok", commits: [] }; },
    };
    const d = { ...deps(runner), git };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    // §41 I-1 후속: +1 은 워크플로우 마무리에 붙는 verify 세션 (아래 sessions[2])
    expect(s.phases[0].sessions).toHaveLength(3);
    expect(s.phases[0].sessions[0].verdict?.outcome).toBe("bounced");
    expect(s.phases[0].sessions[0].verdict?.reason).toBe("branch_drift");
    expect(s.phases[0].sessions[0].verdict?.detail).toContain("feature/wf");
    expect(s.phases[0].sessions[1].verdict).toEqual({ outcome: "accepted" });
    expect(s.phases[0].sessions[2].kind).toBe("verify");
    expect(s.phases[0].sessions[2].verdict).toEqual({ outcome: "accepted" });
  });

  it("검증 대상 파일 위조가 감지되면 bounced/verify_tampered 로 판정한다", async () => {
    saveState(dir, makeState({ phases: [{ ...makeState().phases[0], verify: ["npm test"] }] }));
    let call = 0;
    const changedFiles = async () => { call++; return call === 1 ? { ok: true as const, files: ["package.json"] } : { ok: true as const, files: [] }; };
    const d = { ...deps(stubRunner(["touch-and-done", "touch-and-done"])), headSha: async () => "head0", changedFiles };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    // §41 I-1 후속: +1 은 워크플로우 마무리에 붙는 verify 세션 (아래 sessions[2])
    expect(s.phases[0].sessions).toHaveLength(3);
    // §z-parse D1/D2/E5: detail 은 displayPath(JSON.stringify) 로 가역 표기된다(의도된 변경).
    // §tamper-gap P4: detail 은 formatGuardedFileLines 로 상태 라벨이 붙는다 — 이 tmp 픽스처에는
    // package.json 이 실제로 존재하지 않으므로(describeGuardedFileState 는 fs.existsSync 기반)
    // "이동/삭제됨" 으로 판정된다(이 테스트의 관심사는 verify_tampered 판정 자체이지 라벨 분기가
    // 아니다 — 라벨 분기 자체는 별도의 혼재 케이스 테스트(E4)가 못박는다).
    expect(s.phases[0].sessions[0].verdict).toEqual({
      outcome: "bounced", reason: "verify_tampered", detail: '이동/삭제됨(원래 경로로 복원): "package.json"',
    });
    expect(s.phases[0].sessions[1].verdict).toEqual({ outcome: "accepted" });
    expect(s.phases[0].sessions[2].kind).toBe("verify");
    expect(s.phases[0].sessions[2].verdict).toEqual({ outcome: "accepted" });
  });

  // §z-parse D11/P13: tampered 비교 지점은 changed(git-출처)/guardedFiles(비-git-출처) 양쪽 모두
  // normalizeGitSourcePath(무unquote·무trim) 하나로 정규화한다. 이 테스트는 그 지점 자체를 검증한다
  // — 큰따옴표로 시작·끝나는 실제 파일명(P5 의 핵심 케이스, -z 는 quotePath 이스케이프 없이 이런
  // raw 이름을 그대로 낸다)이 두 출처 모두에 존재할 때 정확히 tampered 로 잡히는지 확인한다. 만약
  // 비교 지점이 (구) normalizeRepoPath(unquoteGitPath 포함)로 되돌아가면 changed 쪽의
  // unquoteGitPath('"weird"') 는 따옴표를 quotePath 이스케이프로 오인해 벗겨내(→"weird") guardedFiles
  // 쪽 정규화 값('"weird"', 따옴표 유지 — "./" 접두 때문에 raw 가 따옴표로 시작하지 않아 unquote
  // 조건에 안 걸림)과 어긋나 tampered 를 놓친다(false negative) — 이 회귀를 잡아내는 것이 이
  // 테스트의 목적이다(개행 자체는 guardedFiles 추출이 전부 공백-분할 구조라 embedded 개행을
  // 만들 수 없어 재현 불가능함을 NOTES 에 기록했다 — P15 와 같은 구조적 한계).
  it('[NUL-z] 큰따옴표로 시작·끝나는 실제 파일명이 changed/guardedFiles 양쪽에서 unquote 손상 없이 tampered 로 검출된다 (D11)', async () => {
    saveState(dir, makeState({ phases: [{ ...makeState().phases[0], verify: ['./"weird"'] }] }));
    let call = 0;
    const changedFiles = async () => { call++; return call === 1 ? { ok: true as const, files: ['"weird"'] } : { ok: true as const, files: [] }; };
    const d = { ...deps(stubRunner(["touch-and-done", "touch-and-done"])), headSha: async () => "head0", changedFiles };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    expect(s.phases[0].sessions).toHaveLength(3);
    // §tamper-gap P4: 이 tmp 픽스처에는 './"weird"' 파일이 실존하지 않으므로 "이동/삭제됨" 라벨.
    expect(s.phases[0].sessions[0].verdict).toEqual({
      outcome: "bounced", reason: "verify_tampered", detail: `이동/삭제됨(원래 경로로 복원): ${JSON.stringify('./"weird"')}`,
    });
    expect(s.phases[0].sessions[1].verdict).toEqual({ outcome: "accepted" });
  });

  it("게이트(비치명적 실패)가 회송하면 bounced/gate_failed 로 판정하고 로그를 남긴다", async () => {
    saveState(dir, makeState({ phases: [makeState().phases[0]] }));
    let gateCalls = 0;
    const gate = async (): Promise<GateResult> => (++gateCalls === 1 ? failGate() : passGate());
    const logs: string[] = [];
    const d = { ...deps(stubRunner(["touch-and-done", "touch-and-done"]), gate), log: (m: string) => logs.push(m) };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    // §41 I-1 후속: +1 은 워크플로우 마무리에 붙는 verify 세션 (아래 sessions[2])
    expect(s.phases[0].sessions).toHaveLength(3);
    expect(s.phases[0].sessions[0].verdict?.outcome).toBe("bounced");
    expect(s.phases[0].sessions[0].verdict?.reason).toBe("gate_failed");
    expect(s.phases[0].sessions[1].verdict).toEqual({ outcome: "accepted" });
    expect(s.phases[0].sessions[2].kind).toBe("verify");
    expect(s.phases[0].sessions[2].verdict).toEqual({ outcome: "accepted" });
    expect(logs.some(l => l.includes("검증 게이트 실패") && l.includes("회송"))).toBe(true);
  });

  it("게이트 명령 자체가 치명적 오류를 내면 즉시 FAILED 로 정지하며 bounced/gate_failed 로 판정한다", async () => {
    saveState(dir, makeState({ phases: [makeState().phases[0]] }));
    const gate = async (): Promise<GateResult> =>
      ({ passed: false, results: [{ command: "nope", exitCode: 127, signal: null, output: "command not found", fatal: true, timedOut: false }] });
    const d = deps(stubRunner(["touch-and-done"]), gate);
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("failed");
    expect(s.phases[0].sessions).toHaveLength(1);
    expect(s.phases[0].sessions[0].verdict).toEqual({
      outcome: "bounced", reason: "gate_failed", detail: expect.stringContaining("nope"),
    });
  });

  it("커밋 0건으로 done 을 주장하면 bounced/no_commits 로 판정한다 (문자열 스니핑이 아니라 result.commits 를 직접 본다)", async () => {
    saveState(dir, makeState({ phases: [makeState().phases[0]] }));
    let call = 0;
    const runner: SessionRunner = {
      async runPhase() {
        call++;
        return { status: "done", summary: "ok", commits: call === 1 ? [] : ["abc123"], sessionId: `s${call}` };
      },
      async runFixSession() { return { status: "done", summary: "x", commits: [] }; },
      async runVerifyAgent() { return { status: "done", summary: "이상 없음", commits: [] }; },
    };
    const d = { ...deps(runner), verifyCommit: async () => ({ ok: true }) };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    expect(s.phases[0].sessions[0].verdict).toEqual({
      outcome: "bounced", reason: "no_commits", detail: expect.stringContaining("커밋이 없습니다"),
    });
    expect(s.phases[0].sessions[1].verdict).toEqual({ outcome: "accepted" });
  });

  it("커밋은 있지만 신규/도달성 검증에 실패하면 bounced/commit_verification_failed 로 판정한다", async () => {
    saveState(dir, makeState({ phases: [makeState().phases[0]] }));
    let call = 0;
    const runner: SessionRunner = {
      async runPhase() {
        call++;
        return { status: "done", summary: "ok", commits: ["stale-sha"], sessionId: `s${call}` };
      },
      async runFixSession() { return { status: "done", summary: "x", commits: [] }; },
      async runVerifyAgent() { return { status: "done", summary: "이상 없음", commits: [] }; },
    };
    // 1차는 검증 실패(신규 아님), 2차는 통과
    const d = { ...deps(runner), verifyCommit: async () => ({ ok: call >= 2, reason: "이미 존재하는 커밋" }) };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    expect(s.phases[0].sessions[0].verdict).toEqual({
      outcome: "bounced", reason: "commit_verification_failed", detail: expect.stringContaining("stale-sha"),
    });
    expect(s.phases[0].sessions[1].verdict).toEqual({ outcome: "accepted" });
  });
});

// §41 I-1 — 실측: 세 주행 전부 VERIFY.md 는 남았지만 phase.sessions.push 가 없어 verify 세션이
// STATE 에 통째로 빠졌다. 파급 3중(①§27 O2 비용 상한이 이 세션의 비용을 못 봄 ②`fw report` 의
// `verify: 0건` 이 "안 돌았다"로 오독됨 ③§38 판정(recordVerdict)도 이 경로만 빠짐)을 이 라운드가
// 고쳤는지 직접 검증한다 — VERIFY.md 기록(§30 P2 회귀)은 그대로 두고, STATE 기록만 새로 추가한다.
describe("§41 I-1: verify 세션도 phase.sessions 에 기록되고 비용 상한에 반영된다", () => {
  it("verify 성공 시 마지막 phase 에 kind:'verify' 세션이 session_id/cost_usd 와 함께 추가된다", async () => {
    saveState(dir, makeState());
    const runner: SessionRunner = {
      ...stubRunner(["touch-and-done", "touch-and-done"]),
      async runVerifyAgent() {
        return { status: "done", summary: "# 검증 보고\n이상 없음", commits: [], sessionId: "verify-1", costUsd: 0.55 };
      },
    };
    const d = deps(runner);
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    // 두 phase 중 마지막(phase 2)에 붙는다 — "어느 phase 든 상한 계산에는 영향이 없다"는 설계
    // 근거(orchestrator.ts 주석)를 그대로 못박는다: phase 1 에는 verify 세션이 없어야 한다.
    expect(s.phases[0].sessions.some(sess => sess.kind === "verify")).toBe(false);
    const verifySessions = s.phases[1].sessions.filter(sess => sess.kind === "verify");
    expect(verifySessions).toHaveLength(1);
    expect(verifySessions[0]).toMatchObject({
      session_id: "verify-1", cost_usd: 0.55, result: "done",
      summary: "# 검증 보고\n이상 없음",
    });
    expect(verifySessions[0].verdict).toEqual({ outcome: "accepted" });
    // VERIFY.md 는 기존과 동일하게 report 원문을 그대로 담는다(§30 P2 회귀 — 기록 내용 불변)
    expect(fs.readFileSync(path.join(dir, "VERIFY.md"), "utf-8")).toBe("# 검증 보고\n이상 없음");
    // 디스크에도 확정 저장돼야 한다 — 메모리상의 반환값만 갱신되고 saveState 가 빠지면
    // 다음 `fw report`/`fw status` 가 이 세션을 영영 못 본다(§27 O2 의 존재 이유 그 자체).
    expect(loadState(dir).phases[1].sessions.some(sess => sess.kind === "verify")).toBe(true);
  });

  it("verify 세션이 sessionId 를 못 받으면 'unknown' 으로, 그래도 세션 자체는 기록된다", async () => {
    saveState(dir, makeState({ phases: [makeState().phases[0]] }));
    const runner: SessionRunner = {
      ...stubRunner(["touch-and-done"]),
      async runVerifyAgent() { return { status: "done", summary: "이상 없음", commits: [] }; },
    };
    const d = deps(runner);
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    const verifySession = s.phases[0].sessions.find(sess => sess.kind === "verify");
    expect(verifySession?.session_id).toBe("unknown");
    expect(verifySession?.cost_usd).toBeUndefined();
  });

  it("verify 에이전트가 failed 결과를 반환하면(스트림 오류 등) session_failed 로 판정하되 워크플로우는 done 을 유지한다", async () => {
    saveState(dir, makeState({ phases: [makeState().phases[0]] }));
    const runner: SessionRunner = {
      ...stubRunner(["touch-and-done"]),
      async runVerifyAgent() {
        return { status: "failed", summary: "(verify 에이전트 오류: SDK 스폰 실패)", commits: [] };
      },
    };
    const d = deps(runner);
    const s = await runWorkflow(dir, d);
    // §41 I-1: verify 는 게이트가 없어 재시도 루프가 없다 — 실패해도 워크플로우 자체는 이미
    // done 으로 확정된 뒤라 그대로 done 을 유지한다(bounced 개념이 없다는 orchestrator.ts 주석
    // 그대로 — "session_failed" 여도 워크플로우가 회송되지 않는다).
    expect(s.status).toBe("done");
    const verifySession = s.phases[0].sessions.find(sess => sess.kind === "verify");
    expect(verifySession?.verdict).toEqual({
      outcome: "session_failed", detail: "(verify 에이전트 오류: SDK 스폰 실패)",
    });
  });

  it("verify 세션 비용이 totalCostUsd(state.ts)의 누적 집계에 실제로 반영된다 — §27 O2 상한 계산 대상", async () => {
    saveState(dir, makeState({ phases: [makeState().phases[0]] }));
    const runner: SessionRunner = {
      ...stubRunner(["touch-and-done"]),
      async runVerifyAgent() {
        return { status: "done", summary: "이상 없음", commits: [], sessionId: "verify-2", costUsd: 3 };
      },
    };
    const d = deps(runner);
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    // phase 세션(runPhase 는 costUsd 를 안 주므로 0으로 집계) + verify 세션(3) = 3
    expect(totalCostUsd(s)).toBe(3);
    // 이 값을 이어받아 다음 `fw run`(재개 없음 — done 이라 재실행되지 않지만, §27 O2 체크포인트가
    // 보는 값이 정확히 이 함수라는 사실 자체를 못박는다)이 max_cost_usd=1 이었다면 halted 됐을
    // 금액이라는 것을 직접 계산으로 확인한다.
    expect(totalCostUsd(s)).toBeGreaterThan(1);
  });

  it("phase 가 blocked 로 끝나면(워크플로우 미완주) verify 세션이 전혀 추가되지 않는다", async () => {
    saveState(dir, makeState());
    const d = deps(stubRunner([{ status: "blocked", summary: "질문", question: "A or B?", commits: [] }]));
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("blocked");
    expect(s.phases.flatMap(p => p.sessions).some(sess => sess.kind === "verify")).toBe(false);
  });

  it("phase 가 재시도 소진으로 failed 로 끝나면(워크플로우 미완주) verify 세션이 전혀 추가되지 않는다", async () => {
    saveState(dir, makeState({ phases: [{ ...makeState().phases[0], max_attempts: 1 }] }));
    const d = deps(stubRunner([{ status: "failed", summary: "손 못 댐", commits: [] }]));
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("failed");
    expect(s.phases.flatMap(p => p.sessions).some(sess => sess.kind === "verify")).toBe(false);
  });
});

// §30 P1 규칙을 코드로 못박는다: "세션을 띄우는 경로(phase/fix)에서 blocked 는 항상
// pending_question 을 남긴다" 를 한쪽만 통과하고 다른 쪽만 깨질 수 없는 파라미터화 테스트 1개로
// 표현한다 — 다음에 한쪽만 고치면(§31 C1 처럼) 이 테스트가 실패한다.
describe("§31 §30 P1: phase 루프·fix 루프 모두 blocked 시 pending_question 을 남긴다 (파라미터화)", () => {
  it.each([
    [
      "phase 루프",
      async (): Promise<State> => {
        saveState(dir, makeState());
        const d = deps(stubRunner([{ status: "blocked", summary: "질문", question: "phase 질문", commits: [] }]));
        return runWorkflow(dir, d);
      },
    ],
    [
      "fix 루프(배치 flush 실패 동반)",
      async (): Promise<State> => {
        saveState(dir, prState());
        const c1: RawComment = { id: 1, body: "@fw", author: "alice", isBot: false, createdAt: "t1", kind: "issue" };
        const c2: RawComment = { id: 2, body: "@fw", author: "alice", isBot: false, createdAt: "t2", kind: "issue" };
        const pr = stubPr({ views: [OPEN], comments: [[c1, c2]] });
        let calls = 0;
        const gate = async (): Promise<GateResult> => { calls++; return calls === 1 ? passGate() : failGate(); };
        const runner = {
          ...stubRunner(["touch-and-done"]),
          async runFixSession(input: FixPromptInput) {
            if (input.comments[0]?.id === 2) {
              return { status: "blocked" as const, summary: "모호함", question: "fix 질문", commits: [] };
            }
            return { status: "done" as const, summary: "고침", commits: ["fix1"], addressed: ADDR };
          },
        };
        return runWorkflow(dir, { ...deps(runner, gate), pr });
      },
    ],
  ])("%s: blocked 시 pending_question 이 null 로 남지 않는다", async (_name, run) => {
    const s = await run();
    expect(s.status).toBe("blocked");
    expect(s.pending_question).not.toBeNull();
    expect(s.pending_question?.question).toBeTruthy();
  });
});

// §37 sandbox-trial 막힘 1 후속 — 3차 무인 주행이 `sandbox.enabled:true` 만 켠 채(network 설정
// 없이) `git maintenance run --task=prefetch` 가 origin 으로 나가는 연결을 조용히 거부당한 것을
// 재현 가능하게 관측했다(docs/sandbox-trial/NOTES.md "막힘 1"). preflight() 가 구한 origin
// 호스트가 phase/verify 세션 정책까지 실제로 도달하는지 확인한다(fix 세션 경로는
// prloop.test.ts 가 runPrGate 를 직접 호출해 검증한다 — §30 P1: 세 경로 전부 표로 확인).
describe("§37 sandbox-trial 막힘 1 후속: origin 호스트가 phase/verify 세션 정책에 전달된다 (§30 P1)", () => {
  const gitWithOrigin = async (args: string[]) => {
    if (args[0] === "remote" && args[1] === "get-url" && args[2] === "origin") {
      return { ok: true, stdout: "https://ghe.example.com/DolphaGo/AI-Assistant.git\n", stderr: "" };
    }
    return { ok: true, stdout: "", stderr: "" };
  };

  it("phase 세션(runPhase) 정책의 network.allowedDomains 에 origin 호스트가 자동 포함된다", async () => {
    saveState(dir, makeState({ sandbox: { enabled: true }, phases: [makeState().phases[0]] }));
    let capturedSandbox: PhaseSessionRequest["policy"]["sandbox"];
    const runner: SessionRunner = {
      async runPhase(req) {
        capturedSandbox = req.policy.sandbox;
        touchHandoff();
        return { status: "done", summary: "ok", commits: ["abc"], sessionId: "s1" };
      },
      async runVerifyAgent() { return { status: "done", summary: "이상 없음", commits: [] }; },
      async runFixSession() { return { status: "done", summary: "stub", commits: [] }; },
    };
    const d = { ...deps(runner), git: gitWithOrigin };
    const s = await runWorkflow(dir, d);
    expect(s.phases[0].status).toBe("done");
    expect(capturedSandbox?.network?.allowedDomains).toEqual(["ghe.example.com"]);
  });

  it("verify 세션(runVerifyAgent) 정책의 network.allowedDomains 에도 origin 호스트가 자동 포함된다", async () => {
    saveState(dir, makeState({ sandbox: { enabled: true } }));
    let capturedSandbox: PhaseSessionRequest["policy"]["sandbox"];
    const runner: SessionRunner = {
      async runPhase() {
        touchHandoff();
        return { status: "done", summary: "ok", commits: ["abc"], sessionId: "s1" };
      },
      async runVerifyAgent(_workflowDir, policy) {
        capturedSandbox = policy.sandbox;
        return { status: "done", summary: "이상 없음", commits: [] };
      },
      async runFixSession() { return { status: "done", summary: "stub", commits: [] }; },
    };
    const d = { ...deps(runner), git: gitWithOrigin };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    expect(capturedSandbox?.network?.allowedDomains).toEqual(["ghe.example.com"]);
  });

  it("sandbox 가 미설정이면(§30 P2 회귀) git remote get-url 자체가 호출되지 않는다", async () => {
    saveState(dir, makeState());
    let remoteCalled = false;
    const trackingGit: OrchestratorDeps["git"] = async (args) => {
      if (args[0] === "remote") remoteCalled = true;
      return { ok: true, stdout: "", stderr: "" };
    };
    const d = { ...deps(stubRunner(["touch-and-done", "touch-and-done"])), git: trackingGit };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    expect(remoteCalled).toBe(false);
  });

  // orchestrator.ts 는 runPrGate 를 두 지점(in_review 재개/phase 완료 직후)에서 호출한다(§30 P1
  // 표) — 둘 다 pre.originHost 를 넘겨야 fix 세션까지 도달한다. prloop.test.ts 는 runPrGate 를
  // 직접 호출해 originHost 인자 자체의 계약을 검증하지만, orchestrator.ts 가 실제로 그 인자를
  // 채워 넘기는지는 여기(runWorkflow 를 통째로 돈다)에서만 검증된다 — 이 테스트가 없으면
  // orchestrator.ts 의 두 호출 지점에서 인자를 빠뜨려도(§30 P1 이 기록한 반복 패턴) 아무 테스트도
  // 실패하지 않는다.
  it("PR 게이트 경로(phase 완료 → runPrGate → runFixSession)에도 orchestrator.ts 가 origin 호스트를 넘긴다", async () => {
    const state = { ...prState(), sandbox: { enabled: true } };
    saveState(dir, state);
    const c7: RawComment = { id: 7, body: "@fw 고쳐주세요", author: "alice", isBot: false, createdAt: "t7", kind: "issue" };
    const pr = stubPr({ views: [OPEN, MERGED], comments: [[c7], []] });
    let capturedSandbox: PhaseSessionRequest["policy"]["sandbox"];
    const runner: SessionRunner = {
      ...stubRunner(["touch-and-done"]),
      async runFixSession(_input: FixPromptInput, policy) {
        capturedSandbox = policy.sandbox;
        return { status: "done", summary: "고침", commits: ["fix1"], addressed: ADDR };
      },
    };
    const d = { ...deps(runner), pr, git: gitWithOrigin };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    expect(capturedSandbox?.network?.allowedDomains).toEqual(["ghe.example.com"]);
  });

  // orchestrator.ts 의 두 runPrGate 호출 지점 중 나머지 하나(in_review 로 재개되는 phase, §30 P1
  // 표의 "재개(2회차 fw run) 경로" 항목) — 위 테스트는 phase 가 방금 완료된 직후 호출을 검증하고,
  // 이 테스트는 이미 PR 이 만들어진 채 재개되는 경로를 검증한다. 하나만 고치고 다른 하나를
  // 놓치는 재발(§25 D → §26 I3 의 반복 패턴)을 막는다.
  it("PR 게이트 경로(in_review 재개 → runPrGate → runFixSession)에도 orchestrator.ts 가 origin 호스트를 넘긴다", async () => {
    const base = prState();
    const state: State = {
      ...base,
      sandbox: { enabled: true },
      phases: [{
        ...base.phases[0],
        status: "in_review",
        pr: { number: 42, url: "https://ex/pull/42", head_branch: "fw/phase-1", handled_comment_keys: [], fix_sessions: 0 },
      }],
    };
    saveState(dir, state);
    const c7: RawComment = { id: 7, body: "@fw 고쳐주세요", author: "alice", isBot: false, createdAt: "t7", kind: "issue" };
    const pr = stubPr({ views: [OPEN, MERGED], comments: [[c7], []] });
    let capturedSandbox: PhaseSessionRequest["policy"]["sandbox"];
    const runner: SessionRunner = {
      ...stubRunner([]),
      async runFixSession(_input: FixPromptInput, policy) {
        capturedSandbox = policy.sandbox;
        return { status: "done", summary: "고침", commits: ["fix1"], addressed: ADDR };
      },
    };
    const d = { ...deps(runner), pr, git: gitWithOrigin };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("done");
    expect(capturedSandbox?.network?.allowedDomains).toEqual(["ghe.example.com"]);
  });
});

// §56 — 사후 검증 단계. runWorkflow 와 fw verify 가 같은 구현을 공유하고, costCapUsd 로
// "이미 상한에 도달한 완주 워크플로우" 에도 검증만 추가로 돌릴 수 있어야 한다(z-parse 실측:
// 이 단계가 통째로 생략됐다).
describe("runVerificationStage — §56", () => {
  function doneStateOverCap(): ReturnType<typeof makeState> {
    const s = makeState({ status: "done", max_cost_usd: 5 });
    for (const ph of s.phases) ph.status = "done";
    s.phases[0].sessions.push({ session_id: "s1", result: "done", at: "t", kind: "phase", cost_usd: 6 }); // 상한 초과
    return s;
  }
  const multiRolePlan = "# P\n\n## 핵심 결정 사항\n\n| ID | 결정 |\n|---|---|\n| D1 | 그대로 |\n\n## 개발 방향\n\n- 진입: src/a.ts\n";

  it("기본(costCapUsd 미지정)은 state.max_cost_usd 를 따른다 — 상한 초과면 생략 기록", async () => {
    saveState(dir, doneStateOverCap());
    fs.writeFileSync(path.join(dir, "PLAN.md"), multiRolePlan);
    let verifyCalls = 0;
    const runner: SessionRunner = {
      async runPhase() { throw new Error("호출되면 안 됨"); },
      async runVerifyAgent() { verifyCalls++; return { status: "done", summary: "보고", commits: [] }; },
      async runFixSession() { return { status: "done", summary: "stub", commits: [] }; },
    };
    const st = loadState(dir);
    await runVerificationStage(dir, st, deps(runner), null);
    expect(verifyCalls).toBe(0);
    expect(fs.readFileSync(path.join(dir, "VERIFY.md"), "utf-8")).toContain("생략됨");
  });

  it("costCapUsd 를 넉넉히 주면 상한 초과 상태에서도 역할·합의가 실제로 돈다", async () => {
    saveState(dir, doneStateOverCap());
    fs.writeFileSync(path.join(dir, "PLAN.md"), multiRolePlan);
    let verifyCalls = 0;
    let consensusCalls = 0;
    const runner: SessionRunner = {
      async runPhase() { throw new Error("호출되면 안 됨"); },
      async runVerifyAgent(_d, _p, role) { verifyCalls++; return { status: "done", summary: `${role} 보고`, commits: [], costUsd: 0.1 }; },
      async runFixSession() { return { status: "done", summary: "stub", commits: [] }; },
      async runConsensus() { consensusCalls++; return { summary: "합의문", nextGoals: ["다음 목표"], costUsd: 0.1 }; },
    };
    const st = loadState(dir);
    await runVerificationStage(dir, st, deps(runner), null, { costCapUsd: 100 });
    expect(verifyCalls).toBe(3);
    expect(consensusCalls).toBe(1);
    const verifyMd = fs.readFileSync(path.join(dir, "VERIFY.md"), "utf-8");
    expect(verifyMd).toContain("## 합의");
    expect(verifyMd).not.toContain("생략됨");
    // STATE 에 세션·다음 목표가 영속됐다 — verify/consensus 세션은 마지막 phase 에 붙는다(§41 I-1)
    const saved = loadState(dir);
    const last = saved.phases.at(-1)!;
    expect(last.sessions.filter(x => x.kind === "verify")).toHaveLength(3);
    expect(last.sessions.filter(x => x.kind === "consensus")).toHaveLength(1);
    expect(saved.next_goal_suggestions).toEqual(["다음 목표"]);
  });

  it("costCapUsd: null 은 무제한이 아니라 명시적 무상한 — 역할이 돈다", async () => {
    saveState(dir, doneStateOverCap());
    fs.writeFileSync(path.join(dir, "PLAN.md"), multiRolePlan);
    let verifyCalls = 0;
    const runner: SessionRunner = {
      async runPhase() { throw new Error("호출되면 안 됨"); },
      async runVerifyAgent() { verifyCalls++; return { status: "done", summary: "보고", commits: [] }; },
      async runFixSession() { return { status: "done", summary: "stub", commits: [] }; },
    };
    await runVerificationStage(dir, loadState(dir), deps(runner), null, { costCapUsd: null });
    expect(verifyCalls).toBe(3);
  });
});

// ── pr-slicing Phase 2: 조각 브랜치 배선 ────────────────────────────────────
// Phase 1 검토의 교훈: 배선에 테스트가 없으면 배선을 통째로 지워도 스위트가 초록이다.
// 여기서는 "조각 분해가 켜졌을 때 phase 가 조각 브랜치에서 돌아가는가" 를 못박는다.
describe("조각 브랜치 배선 (pr-slicing Phase 2)", () => {
  /** 브랜치 전환을 기억하는 최소 git 페이크. 기본 deps 의 git 스텁은 빈 stdout 을 줘서
   *  currentBranch 가 "" 가 되고 통합 브랜치가 확정되지 않는다. 그리고 `checkout` 을 반영하지
   *  않으면 조각 브랜치를 만든 뒤에도 HEAD 가 통합 브랜치라고 답해 **이탈 감시가 정당하게
   *  회송시킨다**(실측 — 이 페이크 없이는 무한 회송으로 스크립트가 마른다). */
  /** 조각 분해는 pr_mode 를 요구한다(assertRunnable) — 머지가 있어야 통합 브랜치가 전진한다.
   *  이 describe 의 관심사는 조각 브랜치 배선이므로 PR 은 즉시 머지된 것으로 스텁한다. */
  const MERGED_PR = {
    async pushBranch() {},
    async createPr() { return { number: 1, url: "https://ex/pull/1" }; },
    async listComments() { return []; },
    async viewPr() { return { state: "MERGED" as const, reviewDecision: "APPROVED", merged: true }; },
    async postReviewComments() {},
    async postPrComment() {},
  };
  const prModeOn = {
    pr_mode: true, allow_push: true, trusted_comment_authors: ["alice"],
    review_split: { enabled: true, budget_lines: 400 },
  };

  function gitWithBranch(branch: string, calls: string[]) {
    let current = branch;
    return async (args: string[]) => {
      calls.push(args.join(" "));
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return { ok: true, stdout: `${current}\n`, stderr: "" };
      }
      if (args[0] === "checkout") {
        // ["checkout", name] | ["checkout", "-b", name, "--no-track", start]
        current = args[1] === "-b" ? args[2]! : args[1]!;
      }
      return { ok: true, stdout: "", stderr: "" };
    };
  }

  it("review_split 이 꺼져 있으면 조각 브랜치를 만들지 않는다 (기존 경로)", async () => {
    saveState(dir, makeState({ phases: [makeState().phases[0]] }));
    const calls: string[] = [];
    const d = deps(stubRunner(["touch-and-done"]));
    d.git = gitWithBranch("feature/wf", calls);
    await runWorkflow(dir, d);
    expect(calls.some(c => c.startsWith("checkout"))).toBe(false);
    expect(loadState(dir).phases[0].slice_seq).toBeUndefined();
  });

  it("통합 브랜치를 STATE 에 기록한다", async () => {
    saveState(dir, makeState({ phases: [makeState().phases[0]] }));
    const d = deps(stubRunner(["touch-and-done"]));
    d.git = gitWithBranch("feature/wf", []);
    await runWorkflow(dir, d);
    expect(loadState(dir).integration_branch).toBe("feature/wf");
  });

  it("review_split 이 켜지면 phase 가 조각 브랜치에서 돌아간다", async () => {
    saveState(dir, makeState({
      phases: [makeState().phases[0]],
      ...prModeOn,
    }));
    const calls: string[] = [];
    const d = deps(stubRunner(["touch-and-done"]));
    d.pr = MERGED_PR;
    d.git = gitWithBranch("feature/wf", calls);
    await runWorkflow(dir, d);
    const s = loadState(dir);
    expect(s.phases[0].slice_seq).toBe(1);
    // 조각 브랜치가 실제로 준비됐는지 — git 호출에 그 이름이 나타나야 한다.
    expect(calls.some(c => c.includes("feature/wf-1"))).toBe(true);
  });

  it("조각 순번은 저장된 카운터에서 받아 증가한다 (phase 배열 재계산이 아니다)", async () => {
    saveState(dir, makeState({
      phases: [makeState().phases[0], makeState().phases[1]],
      ...prModeOn,
      next_slice_seq: 7,
    }));
    const d = deps(stubRunner(["touch-and-done", "touch-and-done"]));
    d.pr = MERGED_PR;
    d.git = gitWithBranch("feature/wf", []);
    await runWorkflow(dir, d);
    const s = loadState(dir);
    expect(s.phases.map(p => p.slice_seq)).toEqual([7, 8]);
    expect(s.next_slice_seq).toBe(9);
  });

  it("조각 브랜치를 준비할 수 없으면 phase 를 failed 로 하고 멈춘다 (남의 브랜치를 덮지 않는다)", async () => {
    saveState(dir, makeState({
      phases: [makeState().phases[0]],
      ...prModeOn,
    }));
    const d = deps(stubRunner(["touch-and-done"]));
    d.pr = MERGED_PR;
    // 소유권 확인 실패를 흉내낸다: 브랜치는 존재하지만 merge-base --is-ancestor 가 실패
    d.git = async (args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { ok: true, stdout: "feature/wf\n", stderr: "" };
      if (args[0] === "merge-base") return { ok: false, stdout: "", stderr: "not an ancestor" };
      return { ok: true, stdout: "", stderr: "" };
    };
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("failed");
    expect(s.phases[0].status).toBe("failed");
    expect(d.notes.join("\n")).toMatch(/feature\/wf-1/);
  });
});

// ── pr-slicing Phase 4: 분해 게이트 ─────────────────────────────────────────
// phase 실행 **전에** 분해 세션을 돌려 조각으로 나눈다(D7). 실패·거부·1조각은 전부
// "원본 phase 를 그대로 실행" 으로 수렴하고(D10 fail-open) 그 이유를 남긴다.
describe("분해 게이트 (pr-slicing Phase 4)", () => {
  const MERGED_PR2 = {
    async pushBranch() {},
    async createPr() { return { number: 1, url: "https://ex/pull/1" }; },
    async listComments() { return []; },
    async viewPr() { return { state: "MERGED" as const, reviewDecision: "APPROVED", merged: true }; },
    async postReviewComments() {},
    async postPrComment() {},
  };
  const prModeOn2 = {
    pr_mode: true, allow_push: true, trusted_comment_authors: ["alice"],
    review_split: { enabled: true, budget_lines: 400 },
  };

  function gitFake(branch: string) {
    let current = branch;
    return async (args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { ok: true, stdout: `${current}\n`, stderr: "" };
      if (args[0] === "checkout") current = args[1] === "-b" ? args[2]! : args[1]!;
      return { ok: true, stdout: "", stderr: "" };
    };
  }

  /** 분해 결과를 고정으로 돌려주는 러너. 호출 횟수를 센다. */
  function runnerWithDecompose(
    script: Array<PhaseSessionResult | "touch-and-done">,
    decompose: unknown,
  ): SessionRunner & { calls: number } {
    const base = stubRunner(script) as SessionRunner & { calls: number };
    base.calls = 0;
    (base as SessionRunner).runDecomposeAgent = async () => {
      base.calls += 1;
      return decompose as never;
    };
    return base;
  }

  const twoSlices = {
    ok: true,
    slices: [
      { title: "조각 A", next_steps: ["A 한다"], rationale: "A 만 읽으면 된다" },
      { title: "조각 B", next_steps: ["B 한다"], rationale: "A 위에 얹힌다" },
    ],
    overallRationale: "읽는 순서대로",
    sessionId: "dec1",
    costUsd: 0.5,
  };

  function setup(runner: SessionRunner) {
    saveState(dir, makeState({ phases: [makeState().phases[0]], ...prModeOn2 }));
    const d = deps(runner);
    d.pr = MERGED_PR2;
    d.git = gitFake("feature/wf");
    return d;
  }

  it("조각 제안대로 phase 를 나눠 순서대로 실행한다", async () => {
    const runner = runnerWithDecompose(["touch-and-done", "touch-and-done"], twoSlices);
    const d = setup(runner);
    const s = await runWorkflow(dir, d);
    const group = s.phases.filter(p => p.split_group);
    expect(group).toHaveLength(2);
    expect(group.map(p => p.title)).toEqual(["조각 A", "조각 B"]);
    expect(group.every(p => p.status === "done")).toBe(true);
    expect(runner.calls).toBe(1);
  });

  it("분해 세션 기록과 비용을 phase.sessions 에 남긴다 (유료 세션이다)", async () => {
    const d = setup(runnerWithDecompose(["touch-and-done", "touch-and-done"], twoSlices));
    const s = await runWorkflow(dir, d);
    const decomposeSessions = s.phases.flatMap(p => p.sessions).filter(x => x.kind === "decompose");
    expect(decomposeSessions).toHaveLength(1);
    expect(decomposeSessions[0]!.cost_usd).toBe(0.5);
  });

  it("조각 1개를 반환하면 분해 없이 원본을 실행하고 이유를 남긴다", async () => {
    const one = { ok: true, slices: [{ title: "그대로", next_steps: ["전부"], rationale: "충분히 작다" }], overallRationale: "쪼갤 필요 없음" };
    const d = setup(runnerWithDecompose(["touch-and-done"], one));
    const s = await runWorkflow(dir, d);
    expect(s.phases.filter(p => p.split_group)).toHaveLength(0);
    expect(s.phases[0]!.decompose_skipped_reason).toBeTruthy();
    expect(s.phases[0]!.status).toBe("done");
  });

  it("제안이 검증을 통과하지 못하면 원본을 실행하고 이유를 남긴다 (fail-open)", async () => {
    const bad = { ok: true, slices: [{ title: "A", next_steps: [], rationale: "x" }, { title: "B", next_steps: ["b"], rationale: "y" }], overallRationale: "z" };
    const d = setup(runnerWithDecompose(["touch-and-done"], bad));
    const s = await runWorkflow(dir, d);
    expect(s.phases.filter(p => p.split_group)).toHaveLength(0);
    expect(s.phases[0]!.decompose_skipped_reason).toMatch(/next_steps/);
    expect(s.phases[0]!.status).toBe("done");
  });

  it("분해 세션이 실패하면 원본을 실행하고 이유를 남긴다 (주행을 막지 않는다)", async () => {
    const d = setup(runnerWithDecompose(["touch-and-done"], { ok: false, problem: "스키마 위반" }));
    const s = await runWorkflow(dir, d);
    expect(s.phases[0]!.decompose_skipped_reason).toContain("스키마 위반");
    expect(s.phases[0]!.status).toBe("done");
  });

  it("이미 건너뛴 phase 는 다시 분해를 시도하지 않는다 (유료 세션을 또 태우지 않는다)", async () => {
    const runner = runnerWithDecompose(["touch-and-done"], { ok: false, problem: "실패" });
    const d = setup(runner);
    await runWorkflow(dir, d);
    const first = runner.calls;
    // 같은 STATE 로 다시 돌린다 (phase 를 pending 으로 되돌려 재실행 상황을 만든다)
    const s2 = loadState(dir);
    s2.phases[0]!.status = "pending";
    s2.status = "running";
    saveState(dir, s2);
    const runner2 = runnerWithDecompose(["touch-and-done"], { ok: false, problem: "실패" });
    const d2 = deps(runner2);
    d2.pr = MERGED_PR2;
    d2.git = gitFake("feature/wf");
    await runWorkflow(dir, d2);
    expect(first).toBe(1);
    expect(runner2.calls).toBe(0);
  });

  it("이미 조각인 phase 는 다시 분해하지 않는다", async () => {
    const runner = runnerWithDecompose(["touch-and-done", "touch-and-done"], twoSlices);
    const d = setup(runner);
    await runWorkflow(dir, d);
    // 조각 2개를 실행하는 동안 분해 세션은 처음 1회만 돌아야 한다.
    expect(runner.calls).toBe(1);
  });

  it("review_split 이 꺼져 있으면 분해 세션을 부르지 않는다", async () => {
    const runner = runnerWithDecompose(["touch-and-done"], twoSlices);
    saveState(dir, makeState({ phases: [makeState().phases[0]] }));
    const d = deps(runner);
    d.git = gitFake("feature/wf");
    await runWorkflow(dir, d);
    expect(runner.calls).toBe(0);
  });

  it("러너가 분해를 구현하지 않으면 분해 없이 진행한다 (선택 메서드)", async () => {
    saveState(dir, makeState({ phases: [makeState().phases[0]], ...prModeOn2 }));
    const d = deps(stubRunner(["touch-and-done"])); // runDecomposeAgent 없음
    d.pr = MERGED_PR2;
    d.git = gitFake("feature/wf");
    const s = await runWorkflow(dir, d);
    expect(s.phases[0]!.status).toBe("done");
    expect(s.phases.filter(p => p.split_group)).toHaveLength(0);
  });
});

// ── pr-slicing Phase 5: 통합 PR 배선 ────────────────────────────────────────
describe("통합 PR 배선 (pr-slicing Phase 5)", () => {
  function gitFake3(branch: string) {
    let current = branch;
    return async (args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { ok: true, stdout: `${current}\n`, stderr: "" };
      if (args[0] === "checkout") current = args[1] === "-b" ? args[2]! : args[1]!;
      return { ok: true, stdout: "", stderr: "" };
    };
  }

  /** 조각 PR 은 즉시 머지되고, 통합 PR 의 상태는 인자로 고른다. */
  function prStub(integrationView: PrView) {
    const created: Array<{ headBranch: string; baseBranch: string }> = [];
    const pr: PrClient = {
      async pushBranch() {},
      async createPr(o) { created.push(o); return { number: created.length, url: `https://ex/pull/${created.length}` }; },
      async listComments() { return []; },
      async viewPr(o) {
        // 통합 PR(마지막에 만들어진 것)만 인자로 준 상태를 돌려준다.
        return o.number === created.length && created.length > 1 ? integrationView
          : { state: "MERGED" as const, reviewDecision: "APPROVED", merged: true };
      },
      async postReviewComments() {},
      async postPrComment() {},
    };
    return { pr, created };
  }

  const MERGED_VIEW = { state: "MERGED" as const, reviewDecision: "APPROVED", merged: true };
  const OPEN_VIEW = { state: "OPEN" as const, reviewDecision: null, merged: false };

  function sliceOn() {
    return makeState({
      phases: [makeState().phases[0]],
      pr_mode: true, allow_push: true, trusted_comment_authors: ["alice"],
      review_split: { enabled: true, budget_lines: 400 },
    });
  }

  it("전 phase 가 끝나면 통합 브랜치 → base 브랜치 PR 을 만든다", async () => {
    saveState(dir, sliceOn());
    const { pr, created } = prStub(MERGED_VIEW);
    const d = deps(stubRunner(["touch-and-done"]));
    d.pr = pr;
    d.git = gitFake3("feature/wf");
    const s = await runWorkflow(dir, d);
    // 조각 PR 1개 + 통합 PR 1개
    expect(created).toHaveLength(2);
    expect(created[1]!.headBranch).toBe("feature/wf");
    expect(created[1]!.baseBranch).toBe("main");
    expect(s.integration_pr?.number).toBe(2);
    expect(s.status).toBe("done");
  });

  it("통합 PR 이 머지 대기면 awaiting_merge 로 멈춘다 (done 으로 넘어가지 않는다)", async () => {
    saveState(dir, sliceOn());
    const { pr } = prStub(OPEN_VIEW);
    const d = deps(stubRunner(["touch-and-done"]));
    d.pr = pr;
    d.git = gitFake3("feature/wf");
    const s = await runWorkflow(dir, d);
    expect(s.status).toBe("awaiting_merge");
    expect(d.notes.join("\n")).toMatch(/통합 PR/);
  });

  it("review_split 이 꺼져 있으면 통합 PR 을 만들지 않는다 (기존 pr_mode 동작 유지)", async () => {
    saveState(dir, makeState({
      phases: [makeState().phases[0]],
      pr_mode: true, allow_push: true, trusted_comment_authors: ["alice"],
    }));
    const { pr, created } = prStub(MERGED_VIEW);
    const d = deps(stubRunner(["touch-and-done"]));
    d.pr = pr;
    d.git = gitFake3("feature/wf");
    const s = await runWorkflow(dir, d);
    expect(created).toHaveLength(1); // phase PR 하나뿐
    expect(s.integration_pr).toBeUndefined();
    expect(s.status).toBe("done");
  });
});

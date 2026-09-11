// Phase 2 (docs/harness-module-tests/PLAN.md): prloop.ts 전용 테스트.
//
// orchestrator.test.ts 는 runWorkflow 를 통과시키는 통합 테스트라 prloop.ts 의 exported 함수
// (runPrGate/surfaceBlockedQuestion)를 "간접 커버"할 뿐이다(§31 m11 부채). 이 파일은 그 두
// 함수를 직접 호출해 orchestrator.ts/branch.ts 없이도 prloop.ts 자신의 계약을 못박는다.
// runWorkflow 를 거치지 않으므로 workBranch 는 매 테스트가 원하는 값을 직접 인자로 넘긴다
// (applyBranchStrategy 는 branch.test.ts 가 이미 전담한다, PLAN D1 — 그 결과물을 다시 검증하지 않는다).
//
// PLAN D4: git 을 실제로 호출하는 함수(defaultVerifyCommit/defaultBranchReachable/
// defaultChangedFiles/defaultHeadSha/checkBranchDrift/verifySessionCommits/
// refreshIsolationBranchAfterMerge)는 branch.test.ts(Phase 1)가 이미 실제 git 리포/원격
// 픽스처로 검증했다. 이 파일의 관심사는 그 함수들의 반환값에 따라 prloop.ts 자신이 어떻게
// 분기하는가이므로, 여기서는 그 함수들을 스텁으로 제어한다(같은 로직을 실제 git 으로 다시
// 검증하는 것은 중복이지 새 계약을 못박지 않는다).
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runPrGate, surfaceBlockedQuestion, runIntegrationPrGate } from "../src/prloop.js";
import { StateSchema, loadState, type State, type Phase } from "../src/state.js";
import type { OrchestratorDeps } from "../src/orchestrator-types.js";
import type { SessionRunner } from "../src/session.js";
import type { PermissionPolicy } from "../src/permissions.js";
import type { GateResult } from "../src/gate.js";
import type { PrClient, PrRef, PrView, RawComment } from "../src/pr.js";
import type { InlineReviewComment } from "../src/inlinereview.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-prloop-"));
});

// ── 상태/의존성 빌더 ────────────────────────────────────────────────────────

function baseState(phaseOverrides: Partial<Phase> = {}, stateOverrides: Partial<State> = {}): State {
  return StateSchema.parse({
    schema_version: 1, workflow: "wf", repo_root: dir, branch_strategy: "isolate",
    allow_push: true, verify_default: ["git --version"], status: "running",
    pr_mode: true, poll_interval_ms: 1, base_branch: "main",
    trusted_comment_authors: ["alice"],
    pending_question: null, answers: [],
    phases: [
      {
        id: 1, title: "p1", status: "in_review", depends_on: [], verify: [],
        attempts: 0, max_attempts: 2, sessions: [],
        ...phaseOverrides,
      },
    ],
    ...stateOverrides,
  });
}

// phase.pr 이 없는 "생성 전" 상태 — runPrGate 가 pushBranch+createPr 을 직접 해야 한다.
function pendingState(overrides: Partial<Phase> = {}): State {
  return baseState({ status: "pending", ...overrides });
}

const passGate = async (): Promise<GateResult> => ({ passed: true, results: [] });
const failGate = async (): Promise<GateResult> =>
  ({ passed: false, results: [{ command: "false", exitCode: 1, signal: null, output: "boom", fatal: false, timedOut: false }] });

function stubRunner(runFixSession: SessionRunner["runFixSession"]): SessionRunner {
  return {
    async runPhase() { throw new Error("prloop 테스트는 runPhase 를 쓰지 않습니다"); },
    async runVerifyAgent() { return { status: "done", summary: "unused", commits: [] }; },
    runFixSession,
  };
}

const neverFix: SessionRunner["runFixSession"] = async () => {
  throw new Error("이 테스트에서는 fix 세션이 호출되면 안 됩니다");
};

type Deps = OrchestratorDeps & { notes: string[]; logs: string[]; sleeps: number[] };

function makeDeps(overrides: Partial<OrchestratorDeps> = {}): Deps {
  const notes: string[] = [];
  const logs: string[] = [];
  const sleeps: number[] = [];
  return {
    runner: stubRunner(neverFix),
    gate: passGate,
    notify: (t, m) => notes.push(`${t}: ${m}`),
    now: () => "2026-08-28T00:00:00Z",
    log: (m) => logs.push(m),
    sleep: async (ms) => { sleeps.push(ms); },
    nonce: () => "nonce123",
    verifyCommit: async () => ({ ok: true }),
    headSha: async () => "headsha0",
    git: async () => ({ ok: true, stdout: "fw/wf", stderr: "" }),
    branchReachable: async () => ({ ok: true }),
    notes, logs, sleeps,
    ...overrides,
  };
}

const MERGED: PrView = { state: "MERGED", reviewDecision: "APPROVED", merged: true };
const APPROVED: PrView = { state: "OPEN", reviewDecision: "APPROVED", merged: false };
const OPEN: PrView = { state: "OPEN", reviewDecision: null, merged: false };
const CLOSED: PrView = { state: "CLOSED", reviewDecision: null, merged: false };

function stubPr(script: { views: PrView[]; comments?: RawComment[][] }):
  PrClient & { created: PrRef[]; replies: string[]; pushed: string[] } {
  let v = 0, c = 0;
  const created: PrRef[] = [];
  const replies: string[] = [];
  const pushed: string[] = [];
  return {
    created, replies, pushed,
    async pushBranch(o: { branch: string }) { pushed.push(o.branch); },
    async createPr() {
      const ref = { number: 42, url: "https://ex/pull/42" };
      created.push(ref);
      return ref;
    },
    async listComments() { return script.comments?.[c++] ?? []; },
    async viewPr() { return script.views[Math.min(v++, script.views.length - 1)]; },
    async postReviewComments() {},
    async postPrComment(o: { body: string }) { replies.push(o.body); },
  };
}

// issue #4: fix 세션은 코멘트 항목별 반영 여부(addressed)를 보고해야 한다 — 기존 스텁 공통 값.
const ADDR = [{ item: "지적 1", status: "applied" as const, evidence: "src/a.ts:10" }];

const comment = (id: number, body = "@fw 고쳐주세요"): RawComment =>
  ({ id, body, author: "alice", isBot: false, createdAt: `t${id}`, kind: "issue" });

// ── surfaceBlockedQuestion ──────────────────────────────────────────────────

describe("surfaceBlockedQuestion", () => {
  it("extraProblems 가 없으면 질문을 그대로 pending_question 에 남기고 phase/state 를 blocked 로 확정한다", () => {
    const state = baseState({ status: "in_progress" });
    const phase = state.phases[0];
    const d = makeDeps();
    surfaceBlockedQuestion(dir, state, phase, "A or B?", [], d, "PR #42: ");

    expect(phase.status).toBe("blocked");
    expect(state.status).toBe("blocked");
    expect(state.pending_question).toEqual({ phase: 1, question: "A or B?", asked_at: "2026-08-28T00:00:00Z" });
    // saveState 가 실제로 호출됐는지 디스크로 확인 — 호출되지 않으면 재개 시 질문이 사라진다 (§31 C1)
    expect(loadState(dir).pending_question?.question).toBe("A or B?");
    expect(d.notes).toEqual(["fw BLOCKED: PR #42: A or B?"]);
  });

  it("extraProblems 1건은 '⚠️ 함께 발생:' 접두로 질문 뒤에 덧붙는다 (질문 자체는 사라지지 않는다)", () => {
    const state = baseState();
    const phase = state.phases[0];
    const d = makeDeps();
    surfaceBlockedQuestion(dir, state, phase, "Q?", ["브랜치 이탈"], d, "");

    expect(state.pending_question?.question).toBe("Q?\n\n⚠️ 함께 발생: 브랜치 이탈");
  });

  it("extraProblems 2건은 각각 '⚠️ 함께 발생:' 접두를 반복해 이어붙인다 (join 구분자 확정)", () => {
    const state = baseState();
    const phase = state.phases[0];
    const d = makeDeps();
    surfaceBlockedQuestion(dir, state, phase, "Q?", ["문제A", "문제B"], d, "");

    expect(state.pending_question?.question).toBe("Q?\n\n⚠️ 함께 발생: 문제A\n⚠️ 함께 발생: 문제B");
  });

  it("notify 메시지는 질문을 180자로 잘라서 보낸다 (question 필드 자체는 온전히 보존)", () => {
    const state = baseState();
    const phase = state.phases[0];
    const d = makeDeps();
    const longQuestion = "x".repeat(220);
    surfaceBlockedQuestion(dir, state, phase, longQuestion, [], d, "prefix:");

    expect(state.pending_question?.question).toBe(longQuestion); // 저장은 전체 보존
    expect(d.notes).toEqual([`fw BLOCKED: prefix:${"x".repeat(180)}`]); // 알림만 180자 절단
  });
});

// ── runPrGate: PR 생성 / 재동기화 ────────────────────────────────────────────

describe("runPrGate — PR 생성", () => {
  it("phase.pr 이 없으면 pushBranch → createPr 순으로 PR 을 만들고 in_review 로 확정 저장한다", async () => {
    const state = pendingState();
    const phase = state.phases[0];
    const pr = stubPr({ views: [MERGED] });
    const d = makeDeps({ pr });

    const outcome = await runPrGate(dir, state, phase, d, "fw/wf", d.now());

    expect(outcome).toBe("done");
    expect(pr.pushed).toEqual(["fw/phase-1"]);
    expect(pr.created).toHaveLength(1);
    expect(phase.pr).toEqual({
      number: 42, url: "https://ex/pull/42", head_branch: "fw/phase-1",
      handled_comment_keys: [], fix_sessions: 0, last_polled_at: "2026-08-28T00:00:00Z",
    });
    // runPrGate 는 outcome 만 반환하고, phase.status="done" 확정은 호출부(orchestrator.ts) 몫이다.
    expect(phase.status).toBe("in_review");
    // 생성 직후(머지 확인 전) 이미 저장돼 있어야 중단돼도 PR 번호 근거로 재개할 수 있다.
    expect(loadState(dir).phases[0].pr?.number).toBe(42);
  });

  it("createPr 에 phase/workflow 정보를 담은 headBranch/baseBranch/title/body 를 전달한다", async () => {
    const state = pendingState({ title: "테스트 phase" });
    state.base_branch = "develop";
    const phase = state.phases[0];
    let createOpts: { cwd: string; headBranch: string; baseBranch: string; title: string; body: string } | null = null;
    const pr: PrClient = {
      async pushBranch() {},
      async createPr(o) { createOpts = o; return { number: 1, url: "https://ex/pull/1" }; },
      async listComments() { return []; },
      async viewPr() { return MERGED; },
      async postReviewComments() {},
      async postPrComment() {},
    };
    const d = makeDeps({ pr });

    await runPrGate(dir, state, phase, d, "fw/wf", d.now());

    expect(createOpts).not.toBeNull();
    expect(createOpts!.baseBranch).toBe("develop");
    expect(createOpts!.headBranch).toBe("fw/phase-1");
    expect(createOpts!.title).toContain("Phase 1");
    expect(createOpts!.title).toContain("테스트 phase");
    expect(createOpts!.body).toContain("@fw");
  });

  it("createPr 이 throw 하면 재시도 없이 즉시 흡수되어 failed 로 확정된다 (부작용 호출은 재시도 대상 아님)", async () => {
    const state = pendingState();
    const phase = state.phases[0];
    let calls = 0;
    const pr: PrClient = {
      async pushBranch() {},
      async createPr() { calls++; throw new Error("생성 실패"); },
      async listComments() { return []; },
      async viewPr() { return OPEN; },
      async postReviewComments() {},
      async postPrComment() {},
    };
    const d = makeDeps({ pr });

    const outcome = await runPrGate(dir, state, phase, d, "fw/wf", d.now());

    expect(outcome).toBe("failed");
    expect(calls).toBe(1); // 재시도 없음
    expect(d.sleeps).toEqual([]); // withRetry 의 sleep 이 전혀 불리지 않음
    expect(d.notes.some(n => n.includes("PR 게이트 오류") && n.includes("생성 실패"))).toBe(true);
  });

  it("pushBranch 가 throw 하면 createPr 을 시도하지 않고 failed 로 확정된다", async () => {
    const state = pendingState();
    const phase = state.phases[0];
    let createCalled = false;
    const pr: PrClient = {
      async pushBranch() { throw new Error("원격 접근 불가"); },
      async createPr() { createCalled = true; return { number: 1, url: "x" }; },
      async listComments() { return []; },
      async viewPr() { return OPEN; },
      async postReviewComments() {},
      async postPrComment() {},
    };
    const d = makeDeps({ pr });

    const outcome = await runPrGate(dir, state, phase, d, "fw/wf", d.now());

    expect(outcome).toBe("failed");
    expect(createCalled).toBe(false);
  });

  const withPr = (): ReturnType<typeof baseState> => baseState({
    pr: { number: 42, url: "https://ex/pull/42", head_branch: "fw/phase-1", handled_comment_keys: [], fix_sessions: 0 },
  });

  it("phase.pr 이 이미 있으면 createPr 을 다시 하지 않고 재동기화 push 만 한다 (D)", async () => {
    const state = withPr();
    const phase = state.phases[0];
    // 열린 PR 이어야 재동기화가 일어난다 — 머지된 PR 은 아래 테스트대로 건너뛴다.
    const pr = stubPr({ views: [OPEN, MERGED] });
    const d = makeDeps({ pr });

    const outcome = await runPrGate(dir, state, phase, d, "fw/wf", d.now());

    expect(outcome).toBe("done");
    expect(pr.created).toHaveLength(0);
    expect(pr.pushed).toEqual(["fw/phase-1"]);
  });

  // ── 재개 시 동기화는 PR 이 아직 열려 있을 때만 의미가 있다 ────────────────
  // 실전 통주가 잡은 결함: 머지된 PR 의 head 브랜치가 사라진 뒤 재개하면(리뷰어가 GHE 의
  // "Delete branch" 를 눌렀거나 리포가 자동 삭제를 켜둔 경우 — 전자를 실측했다),
  // 없는 브랜치에 --force-with-lease push 가 stale info 로 거부되고 게이트가 예외로 죽어
  // **머지를 끝내 감지하지 못한다.** retryPhase 는 phase.pr 이 있으면 in_review 로 되살리므로
  // 재시도해도 같은 지점에서 다시 죽는 영구 루프였다. 단위 테스트가 못 잡은 이유: pushBranch 를
  // 스텁하면 "원격에 브랜치가 있는가" 라는 조건 자체가 사라진다.

  it("이미 머지된 PR 은 재동기화를 건너뛴다 (동기화의 근거가 사라진 상태다)", async () => {
    const state = withPr();
    const pr = stubPr({ views: [MERGED] });
    const d = makeDeps({ pr });

    const outcome = await runPrGate(dir, state, state.phases[0], d, "fw/wf", d.now());

    expect(outcome).toBe("done");
    expect(pr.pushed).toEqual([]);
  });

  it("머지 후 head 브랜치가 삭제돼 push 가 실패하는 상황에서도 머지를 감지한다 (실전 재현)", async () => {
    const state = withPr();
    const pr = stubPr({ views: [MERGED] });
    // 원격에서 사라진 브랜치에 push 하면 --force-with-lease 가 거부한다.
    pr.pushBranch = async () => { throw new Error("! [rejected] (stale info)"); };
    const d = makeDeps({ pr });

    const outcome = await runPrGate(dir, state, state.phases[0], d, "fw/wf", d.now());

    expect(outcome).toBe("done");
  });

  it("폴링이 여러 바퀴 돌아도 동기화 push 는 한 번만 한다 (매 폴링 push 는 CI 를 계속 재실행시킨다)", async () => {
    const state = withPr();
    const pr = stubPr({ views: [OPEN, OPEN, MERGED] });
    const d = makeDeps({ pr });

    const outcome = await runPrGate(dir, state, state.phases[0], d, "fw/wf", d.now());

    expect(outcome).toBe("done");
    expect(pr.pushed).toEqual(["fw/phase-1"]);
  });

  it("머지 없이 닫힌 PR 도 재동기화를 건너뛴다 (올릴 이유가 없다)", async () => {
    const state = withPr();
    const pr = stubPr({ views: [CLOSED] });
    const d = makeDeps({ pr });

    const outcome = await runPrGate(dir, state, state.phases[0], d, "fw/wf", d.now());

    expect(outcome).toBe("failed");
    expect(pr.pushed).toEqual([]);
  });

  it("deps.pr 가 주입되지 않으면(pr_mode 오설정) 즉시 failed 로 정지한다", async () => {
    const state = pendingState();
    const phase = state.phases[0];
    const d = makeDeps({ pr: undefined });

    const outcome = await runPrGate(dir, state, phase, d, "fw/wf", d.now());

    expect(outcome).toBe("failed");
    expect(d.notes.some(n => n.includes("PrClient 가 주입되지 않았"))).toBe(true);
  });
});

// ── runPrGate: 폴링 / merged / CLOSED / approve 정지 ─────────────────────────

describe("runPrGate — 폴링 판정", () => {
  it("OPEN 이면 poll_interval_ms 만큼 sleep 하고 재폴링하며, 매 폴링마다 last_polled_at 을 갱신한다", async () => {
    const state = baseState({
      pr: { number: 42, url: "https://ex/pull/42", head_branch: "fw/phase-1", handled_comment_keys: [], fix_sessions: 0 },
    }, { poll_interval_ms: 777 });
    const phase = state.phases[0];
    const pr = stubPr({ views: [OPEN, MERGED] });
    const d = makeDeps({ pr });

    const outcome = await runPrGate(dir, state, phase, d, "fw/wf", d.now());

    expect(outcome).toBe("done");
    expect(d.sleeps).toEqual([777]);
    expect(phase.pr?.last_polled_at).toBe("2026-08-28T00:00:00Z");
  });

  it("PR 이 머지 없이 CLOSED 되면 failed 를 반환하고 알린다", async () => {
    const state = baseState({
      pr: { number: 42, url: "https://ex/pull/42", head_branch: "fw/phase-1", handled_comment_keys: [], fix_sessions: 0 },
    });
    const phase = state.phases[0];
    const pr = stubPr({ views: [CLOSED] });
    const d = makeDeps({ pr });

    const outcome = await runPrGate(dir, state, phase, d, "fw/wf", d.now());

    expect(outcome).toBe("failed");
    expect(d.notes.some(n => n.includes("fw FAILED") && n.includes("#42") && n.includes("닫혔습니다"))).toBe(true);
  });

  it("APPROVED 리뷰 감지 시 awaiting_merge 로 저장하고 정지한다 (머지는 사람)", async () => {
    const state = baseState({
      pr: { number: 42, url: "https://ex/pull/42", head_branch: "fw/phase-1", handled_comment_keys: [], fix_sessions: 0 },
    });
    const phase = state.phases[0];
    const pr = stubPr({ views: [APPROVED] });
    const d = makeDeps({ pr });

    const outcome = await runPrGate(dir, state, phase, d, "fw/wf", d.now());

    expect(outcome).toBe("awaiting_merge");
    expect(state.status).toBe("awaiting_merge");
    expect(phase.status).toBe("in_review"); // approve 는 phase 를 건드리지 않는다
    expect(loadState(dir).status).toBe("awaiting_merge");
    expect(d.notes.some(n => n.includes("머지"))).toBe(true);
  });

  it("runPrGateInner 에서 예기치 못한 예외가 나도 밖으로 새지 않고 failed 로 확정된다 (절대 throw 하지 않는다는 계약)", async () => {
    const state = baseState({
      pr: { number: 42, url: "https://ex/pull/42", head_branch: "fw/phase-1", handled_comment_keys: [], fix_sessions: 0 },
    });
    const phase = state.phases[0];
    const pr: PrClient = {
      async pushBranch() { throw new Error("boom-resync"); },
      async createPr() { return { number: 1, url: "x" }; },
      async listComments() { return []; },
      async viewPr() { return OPEN; },
      async postReviewComments() {},
      async postPrComment() {},
    };
    const d = makeDeps({ pr });

    const outcome = await runPrGate(dir, state, phase, d, "fw/wf", d.now());

    expect(outcome).toBe("failed");
    expect(d.notes.some(n => n.startsWith("fw FAILED: PR 게이트 오류") && n.includes("boom-resync"))).toBe(true);
  });
});

// ── runPrGate: fix 루프 ──────────────────────────────────────────────────────

describe("runPrGate — fix 루프", () => {
  function reviewState(): State {
    return baseState({
      pr: { number: 42, url: "https://ex/pull/42", head_branch: "fw/phase-1", handled_comment_keys: [], fix_sessions: 0 },
    });
  }

  it("actionable 코멘트 1건 → fix 세션을 1회 실행하고, push→handled 기록→답글 순으로 확정한다", async () => {
    const state = reviewState();
    const phase = state.phases[0];
    const c7 = comment(7);
    const pr = stubPr({ views: [OPEN, MERGED], comments: [[c7], []] });
    let fixCalls = 0;
    // 어서션은 여기서 하지 않는다 — runFixSession 은 runPrGate 의 catch-all 안에서 호출되므로
    // 여기서 throw(assertion 실패 포함)해도 테스트로 전파되지 않고 "failed" 로 흡수돼버린다.
    // 대신 값을 밖으로 꺼내 await 이후에 확인한다.
    const capturedInputs: RawComment[][] = [];
    const runner = stubRunner(async (input) => {
      fixCalls++;
      capturedInputs.push(input.comments);
      return { status: "done", summary: "고쳤습니다", commits: ["fix1"], addressed: ADDR };
    });
    const d = makeDeps({ pr, runner });

    const outcome = await runPrGate(dir, state, phase, d, null, d.now());

    expect(fixCalls).toBe(1);
    expect(capturedInputs).toEqual([[c7]]); // fix 세션은 코멘트 1건씩 독립 호출된다
    expect(outcome).toBe("done");
    expect(phase.pr?.handled_comment_keys).toEqual(["issue:7"]);
    expect(pr.replies.some(r => r.includes("✅ issue:7 반영") && r.includes("고쳤습니다"))).toBe(true);
  });

  it("fix 세션이 commits:[] 로 done 을 주장하면 검증 실패로 회송하고 handled 로 기록하지 않는다 (커밋 0건 회송)", async () => {
    const state = reviewState();
    const phase = state.phases[0];
    const c7 = comment(7);
    const pr = stubPr({ views: [OPEN], comments: [[c7]] });
    const runner = stubRunner(async () => ({ status: "done", summary: "됐다고 주장", commits: [], addressed: ADDR }));
    const d = makeDeps({ pr, runner });

    const outcome = await runPrGate(dir, state, phase, d, null, d.now());

    expect(outcome).toBe("failed");
    expect(phase.pr?.handled_comment_keys).toEqual([]);
    expect(pr.replies.some(r => r.includes("검증 실패") && r.includes("커밋이 없습니다"))).toBe(true);
    expect(d.notes.some(n => n.includes("fix 검증 실패") && n.includes("커밋이 없습니다"))).toBe(true);
  });

  it("actionable 코멘트 여러 건이 모두 성공하면 게이트는 배치당 1회만 실행된다", async () => {
    const state = reviewState();
    const phase = state.phases[0];
    const cs = [comment(1), comment(2), comment(3)];
    const pr = stubPr({ views: [OPEN, MERGED], comments: [cs, []] });
    let gateCalls = 0;
    const gate = async (): Promise<GateResult> => { gateCalls++; return passGate(); };
    const runner = stubRunner(async (input) => {
      const id = input.comments[0]?.id;
      return { status: "done", summary: `고침 ${id}`, commits: [`fix${id}`], addressed: ADDR };
    });
    const d = makeDeps({ pr, runner, gate });

    const outcome = await runPrGate(dir, state, phase, d, null, d.now());

    expect(outcome).toBe("done");
    expect(gateCalls).toBe(1); // 코멘트 3건이지만 게이트는 배치 마지막에 1번
    expect(phase.pr?.handled_comment_keys).toEqual(["issue:1", "issue:2", "issue:3"]);
  });

  it("배치 게이트가 실패하면 전체를 handled 로 기록하지 않고 답글도 배치당 1건만 남긴다", async () => {
    const state = reviewState();
    const phase = state.phases[0];
    const cs = [comment(1), comment(2)];
    const pr = stubPr({ views: [OPEN], comments: [cs] });
    const runner = stubRunner(async (input) => {
      const id = input.comments[0]?.id;
      return { status: "done", summary: `고침 ${id}`, commits: [`fix${id}`], addressed: ADDR };
    });
    const d = makeDeps({ pr, runner, gate: failGate });

    const outcome = await runPrGate(dir, state, phase, d, null, d.now());

    expect(outcome).toBe("failed");
    expect(phase.pr?.handled_comment_keys).toEqual([]);
    expect(pr.replies).toHaveLength(1); // 코멘트별이 아니라 배치 전체에 답글 1건
    expect(pr.replies[0]).toContain("검증 실패");
    expect(d.notes.some(n => n.includes("fix 검증 실패"))).toBe(true);
  });

  it("handled_comment_keys 기록은 push 다음, 그 코멘트의 답글 게시보다 먼저 확정된다 (진실 우선 순서)", async () => {
    const state = reviewState();
    const phase = state.phases[0];
    const cs = [comment(1), comment(2)];
    const order: string[] = [];
    let vi = 0, ci = 0;
    const pr: PrClient = {
      async pushBranch(o) { order.push(`push:${o.branch}`); },
      async createPr() { throw new Error("phase.pr 이 이미 있으므로 호출되면 안 됩니다"); },
      async listComments() { return [cs, []][ci++] ?? []; },
      async viewPr() { return [OPEN, MERGED][Math.min(vi++, 1)]; },
      async postReviewComments() {},
      async postPrComment() {
        order.push(`reply-with-handled:${phase.pr?.handled_comment_keys.join(",")}`);
      },
    };
    const runner = stubRunner(async (input) => {
      const id = input.comments[0]?.id;
      return { status: "done", summary: `고침 ${id}`, commits: [`fix${id}`], addressed: ADDR };
    });
    const d = makeDeps({ pr, runner });

    const outcome = await runPrGate(dir, state, phase, d, null, d.now());

    expect(outcome).toBe("done");
    expect(order).toEqual([
      "push:fw/phase-1",                        // 재개 시 항상 먼저 재동기화 push (§25 D)
      "push:fw/phase-1",                        // 배치 flush — 원격에 실제로 올린 뒤에만 확정한다
      "reply-with-handled:issue:1",             // 코멘트 1 답글 시점엔 이미 handled 에 기록돼 있다
      "reply-with-handled:issue:1,issue:2",     // 코멘트 2 답글 시점엔 1,2 모두 기록돼 있다
    ]);
  });

  // §37 sandbox-trial 막힘 1 후속/§30 P1 — orchestrator.ts 가 preflight() 로 구한 originHost 를
  // runPrGate 의 마지막 인자로 넘기면, fix 세션(§30 P1 이 규정한 phase/fix/verify 세 경로 중
  // 하나)의 policyFor 에도 그 값이 전달돼 network.allowedDomains 에 반영되는지 확인한다. phase
  // 루프(orchestrator.test.ts)/verify 세션도 같은 계약을 별도로 검증한다 — 여기서 fix 경로만
  // 빠뜨리면 §30 P1 표에 이미 여러 번 기록된 패턴이 그대로 반복된다.
  it("originHost 를 넘기면 fix 세션 정책의 network.allowedDomains 에도 자동 포함된다 (§37 sandbox-trial 막힘 1 후속)", async () => {
    const state = baseState(
      { pr: { number: 42, url: "https://ex/pull/42", head_branch: "fw/phase-1", handled_comment_keys: [], fix_sessions: 0 } },
      { sandbox: { enabled: true } },
    );
    const phase = state.phases[0];
    const c7 = comment(7);
    const pr = stubPr({ views: [OPEN, MERGED], comments: [[c7], []] });
    let capturedSandbox: PermissionPolicy["sandbox"];
    const runner = stubRunner(async (_input, policy) => {
      capturedSandbox = policy.sandbox;
      return { status: "done", summary: "고쳤습니다", commits: ["fix1"], addressed: ADDR };
    });
    const d = makeDeps({ pr, runner });

    const outcome = await runPrGate(dir, state, phase, d, null, d.now(), "ghe.example.com");

    expect(outcome).toBe("done");
    expect(capturedSandbox?.network?.allowedDomains).toEqual(["ghe.example.com"]);
  });

  it("originHost 를 생략하면 fix 세션 정책은 기존 §37 T1 동작과 동일하다 (사용자가 allowedDomains 를 이미 설정한 경우 존중)", async () => {
    const state = baseState(
      { pr: { number: 42, url: "https://ex/pull/42", head_branch: "fw/phase-1", handled_comment_keys: [], fix_sessions: 0 } },
      { sandbox: { enabled: true, network: { allowedDomains: ["github.com"] } } },
    );
    const phase = state.phases[0];
    const c7 = comment(7);
    const pr = stubPr({ views: [OPEN, MERGED], comments: [[c7], []] });
    let capturedSandbox: PermissionPolicy["sandbox"];
    const runner = stubRunner(async (_input, policy) => {
      capturedSandbox = policy.sandbox;
      return { status: "done", summary: "고쳤습니다", commits: ["fix1"], addressed: ADDR };
    });
    const d = makeDeps({ pr, runner });

    // originHost 를 넘겨도(§30 P2 — 사용자 설정 존중) 이미 명시된 allowedDomains 는 그대로다.
    const outcome = await runPrGate(dir, state, phase, d, null, d.now(), "ghe.example.com");

    expect(outcome).toBe("done");
    expect(capturedSandbox?.network?.allowedDomains).toEqual(["github.com"]);
  });
});

// ── §36 §30 P4 후속 — 하네스의 판정(verdict)을 fix 세션 기록에 남긴다 ────────────────
//
// phase 루프(orchestrator.ts)와 동일하게, fix 세션도 세션의 자기 주장(result)과 하네스의 실제
// 판정(verdict)을 구분해 phase.sessions[].verdict 에 남긴다. 배치(여러 코멘트를 한 게이트로
// 묶어 판정)의 경우 배치가 확정될 때(flushPending) pending 에 들어있던 세션들에 소급 적용된다.
describe("runPrGate — 하네스의 판정(verdict) 기록 (§36 §30 P4)", () => {
  function reviewState(phaseOverrides: Partial<Phase> = {}): State {
    return baseState({
      pr: { number: 42, url: "https://ex/pull/42", head_branch: "fw/phase-1", handled_comment_keys: [], fix_sessions: 0 },
      ...phaseOverrides,
    });
  }

  it("fix 세션이 게이트·가드를 통과해 handled 로 확정되면 accepted 로 판정한다", async () => {
    const state = reviewState();
    const phase = state.phases[0];
    const c7 = comment(7);
    const pr = stubPr({ views: [OPEN, MERGED], comments: [[c7], []] });
    const runner = stubRunner(async () => ({ status: "done", summary: "고쳤습니다", commits: ["fix1"], addressed: ADDR }));
    const d = makeDeps({ pr, runner });

    const outcome = await runPrGate(dir, state, phase, d, null, d.now());

    expect(outcome).toBe("done");
    expect(phase.sessions).toHaveLength(1);
    expect(phase.sessions[0].kind).toBe("fix");
    expect(phase.sessions[0].verdict).toEqual({ outcome: "accepted" });
  });

  it("fix 세션이 blocked 를 반환하면 session_blocked 로 판정한다 (세션 자신의 주장과 구분)", async () => {
    const state = reviewState();
    const phase = state.phases[0];
    const c7 = comment(7);
    const pr = stubPr({ views: [OPEN], comments: [[c7]] });
    const runner = stubRunner(async () => (
      { status: "blocked", summary: "질문 있음", question: "어느 쪽으로 할까요?", commits: [] }
    ));
    const d = makeDeps({ pr, runner });

    const outcome = await runPrGate(dir, state, phase, d, null, d.now());

    expect(outcome).toBe("blocked");
    expect(phase.sessions[0].result).toBe("blocked");
    expect(phase.sessions[0].verdict).toEqual({ outcome: "session_blocked" });
  });

  it("fix 세션이 failed 를 반환하면 session_failed 로 판정한다", async () => {
    const state = reviewState();
    const phase = state.phases[0];
    const c7 = comment(7);
    const pr = stubPr({ views: [OPEN], comments: [[c7]] });
    const runner = stubRunner(async () => ({ status: "failed", summary: "반영 불가", commits: [] }));
    const d = makeDeps({ pr, runner });

    const outcome = await runPrGate(dir, state, phase, d, null, d.now());

    expect(outcome).toBe("failed");
    expect(phase.sessions[0].verdict).toEqual({ outcome: "session_failed", detail: "반영 불가" });
  });

  it("commits:[] 로 done 을 주장하면 bounced/no_commits 로 판정한다 (문자열 스니핑이 아니라 result.commits 를 직접 본다)", async () => {
    const state = reviewState();
    const phase = state.phases[0];
    const c7 = comment(7);
    const pr = stubPr({ views: [OPEN], comments: [[c7]] });
    const runner = stubRunner(async () => ({ status: "done", summary: "됐다고 주장", commits: [], addressed: ADDR }));
    const d = makeDeps({ pr, runner });

    const outcome = await runPrGate(dir, state, phase, d, null, d.now());

    expect(outcome).toBe("failed");
    expect(phase.sessions[0].verdict).toEqual({
      outcome: "bounced", reason: "no_commits", detail: expect.stringContaining("커밋이 없습니다"),
    });
  });

  it("보고한 커밋이 신규/도달 검증에 실패하면(0건이 아님) bounced/commit_verification_failed 로 판정한다", async () => {
    const state = reviewState();
    const phase = state.phases[0];
    const c7 = comment(7);
    const pr = stubPr({ views: [OPEN], comments: [[c7]] });
    const runner = stubRunner(async () => ({ status: "done", summary: "됐다고 주장", commits: ["stale-sha"], addressed: ADDR }));
    const d = makeDeps({ pr, runner, verifyCommit: async () => ({ ok: false, reason: "이미 존재하는 커밋" }) });

    const outcome = await runPrGate(dir, state, phase, d, null, d.now());

    expect(outcome).toBe("failed");
    expect(phase.sessions[0].verdict).toEqual({
      outcome: "bounced", reason: "commit_verification_failed", detail: expect.stringContaining("stale-sha"),
    });
  });

  it("fix 세션이 격리 브랜치를 이탈하면 bounced/branch_drift 로 판정한다 (branchDrift 가 우선)", async () => {
    const state = reviewState();
    const phase = state.phases[0];
    const c7 = comment(7);
    const pr = stubPr({ views: [OPEN], comments: [[c7]] });
    const runner = stubRunner(async () => ({ status: "done", summary: "고쳤다고 주장", commits: ["fix1"], addressed: ADDR }));
    // workBranch(아래 "fw/wf")와 다른 브랜치를 보고해 이탈을 흉내낸다
    const git = async () => ({ ok: true, stdout: "main", stderr: "" });
    const d = makeDeps({ pr, runner, git });

    const outcome = await runPrGate(dir, state, phase, d, "fw/wf", d.now());

    expect(outcome).toBe("failed");
    expect(phase.sessions[0].verdict).toEqual({
      outcome: "bounced", reason: "branch_drift", detail: expect.stringContaining("fw/wf"),
    });
  });

  it("배치(여러 코멘트)가 모두 게이트를 통과하면 배치 전체의 세션이 accepted 로 확정된다", async () => {
    const state = reviewState();
    const phase = state.phases[0];
    const cs = [comment(1), comment(2), comment(3)];
    const pr = stubPr({ views: [OPEN, MERGED], comments: [cs, []] });
    const runner = stubRunner(async input => {
      const id = input.comments[0]?.id;
      return { status: "done", summary: `고침 ${id}`, commits: [`fix${id}`], addressed: ADDR };
    });
    const d = makeDeps({ pr, runner });

    const outcome = await runPrGate(dir, state, phase, d, null, d.now());

    expect(outcome).toBe("done");
    expect(phase.sessions).toHaveLength(3);
    for (const s of phase.sessions) expect(s.verdict).toEqual({ outcome: "accepted" });
  });

  it("배치 게이트가 실패하면 그 배치의 세션 전부가 bounced/gate_failed 로 소급 판정된다", async () => {
    const state = reviewState();
    const phase = state.phases[0];
    const cs = [comment(1), comment(2)];
    const pr = stubPr({ views: [OPEN], comments: [cs] });
    const runner = stubRunner(async input => {
      const id = input.comments[0]?.id;
      return { status: "done", summary: `고침 ${id}`, commits: [`fix${id}`], addressed: ADDR };
    });
    const d = makeDeps({ pr, runner, gate: failGate });

    const outcome = await runPrGate(dir, state, phase, d, null, d.now());

    expect(outcome).toBe("failed");
    expect(phase.sessions).toHaveLength(2);
    for (const s of phase.sessions) {
      expect(s.verdict?.outcome).toBe("bounced");
      expect(s.verdict?.reason).toBe("gate_failed");
    }
  });

  it("배치 위조 가드(verify 대상 파일 수정)가 걸리면 그 배치의 세션 전부가 bounced/verify_tampered 로 판정된다", async () => {
    const state = reviewState({ verify: ["npm test"], verify_guard_baseline_sha: "base0" });
    const phase = state.phases[0];
    const c1 = comment(1);
    const pr = stubPr({ views: [OPEN], comments: [[c1]] });
    const runner = stubRunner(async () => ({ status: "done", summary: "고쳤다", commits: ["fix1"], addressed: ADDR }));
    const changedFiles = async () => ({ ok: true as const, files: ["package.json"] });
    const d = makeDeps({ pr, runner, changedFiles });

    const outcome = await runPrGate(dir, state, phase, d, null, d.now());

    expect(outcome).toBe("failed");
    expect(phase.sessions).toHaveLength(1);
    expect(phase.sessions[0].verdict).toEqual({
      outcome: "bounced", reason: "verify_tampered", detail: expect.stringContaining("package.json"),
    });
  });

  // §z-parse D11/P13: orchestrator.test.ts 의 동일 테스트(D11 주석 참조)와 같은 원칙 — fix 배치의
  // tampered 비교 지점도 changed/guardedFixFiles 양쪽 모두 normalizeGitSourcePath(무unquote·무trim)
  // 로 정규화한다. 큰따옴표로 시작·끝나는 실제 파일명(-z 는 quotePath 이스케이프 없이 그대로 낸다)
  // 이 두 출처 모두에 있을 때 정확히 tampered 로 잡히는지 확인한다 — (구) normalizeRepoPath 로
  // 되돌아가면 changed 쪽만 unquoteGitPath 에 걸려(따옴표 제거) guardedFixFiles 쪽 정규화 값과
  // 어긋나 tampered 를 놓친다(false negative, 회귀).
  it('[NUL-z] 큰따옴표로 시작·끝나는 실제 파일명이 changed/guardedFixFiles 양쪽에서 unquote 손상 없이 tampered 로 검출된다 (D11)', async () => {
    const state = reviewState({ verify: ['./"weird"'], verify_guard_baseline_sha: "base0" });
    const phase = state.phases[0];
    const c1 = comment(1);
    const pr = stubPr({ views: [OPEN], comments: [[c1]] });
    const runner = stubRunner(async () => ({ status: "done", summary: "고쳤다", commits: ["fix1"], addressed: ADDR }));
    const changedFiles = async () => ({ ok: true as const, files: ['"weird"'] });
    const d = makeDeps({ pr, runner, changedFiles });

    const outcome = await runPrGate(dir, state, phase, d, null, d.now());

    expect(outcome).toBe("failed");
    expect(phase.sessions).toHaveLength(1);
    // §tamper-gap P4: 이 tmp 픽스처에는 './"weird"' 파일이 실존하지 않으므로 "이동/삭제됨" 라벨.
    expect(phase.sessions[0].verdict).toEqual({
      outcome: "bounced", reason: "verify_tampered", detail: `이동/삭제됨(원래 경로로 복원): ${JSON.stringify('./"weird"')}`,
    });
  });

  // §tamper-gap E5/E11: orchestrator.test.ts 의 동일 시나리오(주석 참조)와 같은 이유로 prloop.ts
  // 에도 독립적으로 필요하다 — 비교/조립 로직이 공유 헬퍼가 아니라 두 파일에 각자 구현돼 있어
  // (§0 이의 해소 ①) 한쪽 테스트가 다른 쪽 배선을 증명하지 못한다. prloop 의 기존 제어 흐름(즉시
  // failed, D4)에 맞춰 검증한다.
  it("[NUL-z] rename 된 guarded 파일이 OLD 경로를 근거로 verify_tampered 로 판정되어 phase.status=failed 로 즉시 정지한다 (E5/E11)", async () => {
    const state = reviewState({ verify: ["./scripts/old-name-guarded.sh"], verify_guard_baseline_sha: "base0" });
    const phase = state.phases[0];
    const c1 = comment(1);
    const pr = stubPr({ views: [OPEN], comments: [[c1]] });
    const runner = stubRunner(async () => ({ status: "done", summary: "고쳤다", commits: ["fix1"], addressed: ADDR }));
    // --no-renames 채택으로 rename 시 OLD 경로가 D(삭제) 세그먼트로 changed 에 노출되는 배선을
    // 흉내낸 스텁(D5).
    const changedFiles = async () => ({ ok: true as const, files: ["scripts/old-name-guarded.sh"] });
    const d = makeDeps({ pr, runner, changedFiles });

    const outcome = await runPrGate(dir, state, phase, d, null, d.now());

    expect(outcome).toBe("failed");
    expect(phase.sessions).toHaveLength(1);
    expect(phase.sessions[0].verdict?.outcome).toBe("bounced");
    expect(phase.sessions[0].verdict?.reason).toBe("verify_tampered");
    expect(phase.sessions[0].verdict?.detail).toContain("scripts/old-name-guarded.sh");
  });

  it("[NUL-z] changedFiles 가 ok:false 를 반환하면 changed_files_untrustworthy 로 phase.status=failed 즉시 정지한다", async () => {
    const state = reviewState({ verify: ["npm test"], verify_guard_baseline_sha: "base0" });
    const phase = state.phases[0];
    const c1 = comment(1);
    const pr = stubPr({ views: [OPEN], comments: [[c1]] });
    const runner = stubRunner(async () => ({ status: "done", summary: "고쳤다", commits: ["fix1"], addressed: ADDR }));
    const changedFiles = async () => ({ ok: false as const, reason: "invalid_utf8" as const, paths: ["broken-�-name.txt"] });
    const d = makeDeps({ pr, runner, changedFiles });

    const outcome = await runPrGate(dir, state, phase, d, null, d.now());

    expect(outcome).toBe("failed");
    expect(phase.sessions).toHaveLength(1);
    expect(phase.sessions[0].verdict?.outcome).toBe("bounced");
    expect(phase.sessions[0].verdict?.reason).toBe("changed_files_untrustworthy");
  });

  // §tamper-gap E13: 실제 확인된 tamper(verify_tampered)와 파싱 이상(changed_files_untrustworthy)
  // 은 판정 강도는 같지만 문구는 구분한다 — prloop 의 두 채널(STATE detail, PR 공개 코멘트) 모두
  // 사실 확인 전 "위조"/"변조" 단정 표현을 쓰지 않는지 부정 단언까지 확인한다(공개 코멘트라 사실
  // 확인 전 공개 비난을 피해야 한다는 요구가 orchestrator 보다 더 크다).
  it("changed_files_untrustworthy 의 STATE detail·PR 코멘트 양쪽에 중립 문구가 포함되고 '위조'/'변조' 미포함 (E13)", async () => {
    const state = reviewState({ verify: ["npm test"], verify_guard_baseline_sha: "base0" });
    const phase = state.phases[0];
    const c1 = comment(1);
    const pr = stubPr({ views: [OPEN], comments: [[c1]] });
    const runner = stubRunner(async () => ({ status: "done", summary: "고쳤다", commits: ["fix1"], addressed: ADDR }));
    const changedFiles = async () => ({ ok: false as const, reason: "invalid_utf8" as const, paths: ["broken-�-name.txt"] });
    const d = makeDeps({ pr, runner, changedFiles });

    await runPrGate(dir, state, phase, d, null, d.now());

    const detail = phase.sessions[0].verdict?.detail ?? "";
    expect(detail).not.toContain("위조");
    expect(detail).not.toContain("변조");
    const reply = pr.replies[0]!;
    expect(reply).toContain("변경 파일 목록을 신뢰할 수 없어 안전하게 정지했습니다");
    expect(reply).not.toContain("위조");
    expect(reply).not.toContain("변조");
  });

  // §tamper-gap P4/D8/E4: prloop 쪽 채널(STATE detail, PR 코멘트)도 같은 배치에 수정/이동삭제가
  // 혼재하면 각각 정확한 라벨을 붙여야 한다 — orchestrator.test.ts 의 동일 시나리오와 같은 이유로
  // (조립 로직 독립 복붙) 여기도 필요하다(§0 이의 해소 ①, B9).
  it("수정/이동삭제 혼재 케이스에서 STATE detail·PR 코멘트 양쪽 모두 파일별 정확한 라벨이 붙는다 (E4, prloop 채널)", async () => {
    const state = reviewState({
      verify: ["./scripts/mod.sh", "./scripts/gone.sh"], verify_guard_baseline_sha: "base0",
    });
    const phase = state.phases[0];
    fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(dir, "scripts", "mod.sh"), "still here, just modified");
    // "scripts/gone.sh" 는 만들지 않는다 — 이동/삭제된 상태를 재현한다.
    const c1 = comment(1);
    const pr = stubPr({ views: [OPEN], comments: [[c1]] });
    const runner = stubRunner(async () => ({ status: "done", summary: "고쳤다", commits: ["fix1"], addressed: ADDR }));
    const changedFiles = async () => ({ ok: true as const, files: ["scripts/mod.sh", "scripts/gone.sh"] });
    const d = makeDeps({ pr, runner, changedFiles });

    await runPrGate(dir, state, phase, d, null, d.now());

    const detail = phase.sessions[0].verdict?.detail ?? "";
    expect(detail).toContain('수정됨: "./scripts/mod.sh"');
    expect(detail).toContain('이동/삭제됨(원래 경로로 복원): "./scripts/gone.sh"');
    const reply = pr.replies[0]!;
    expect(reply).toContain('수정됨: "./scripts/mod.sh"');
    expect(reply).toContain('이동/삭제됨(원래 경로로 복원): "./scripts/gone.sh"');
  });

  // §tamper-gap E10-③/E16/E18(정정: 5채널 중 prloop 쪽 3채널) — escapeControlChars 류 신규
  // 이스케이프 함수 없이 기존 displayPath(JSON.stringify)만 경유해 개행 등 제어문자를 한 줄에
  // 안전하게 표시해야 한다. [NUL-z] 태그 없음(E12).
  describe("displayPath 경유 이스케이프 회귀 (E10-③/E16/E18) — prloop 채널 3개", () => {
    const pathWithNewline = "line1\nline2-tampered.sh";

    it("채널 3(prloop fixFailureSummary → notify): 개행 포함 원인 경로가 displayPath(JSON 리터럴)로 안전하게 표시된다", async () => {
      const state = reviewState({ verify: ["npm test"], verify_guard_baseline_sha: "base0" });
      const phase = state.phases[0];
      const c1 = comment(1);
      const pr = stubPr({ views: [OPEN], comments: [[c1]] });
      const runner = stubRunner(async () => ({ status: "done", summary: "고쳤다", commits: ["fix1"], addressed: ADDR }));
      const changedFiles = async () => ({ ok: false as const, reason: "invalid_utf8" as const, paths: [pathWithNewline] });
      const d = makeDeps({ pr, runner, changedFiles });

      await runPrGate(dir, state, phase, d, null, d.now());

      const note = d.notes.find(n => n.includes("fix 검증 실패"));
      expect(note).toBeDefined();
      const line = note!.split("\n").find(l => l.includes("line1"));
      expect(line).toBeDefined();
      expect(line).toContain(JSON.stringify(pathWithNewline));
    });

    it("채널 4(prloop STATE detail): 개행 포함 원인 경로가 displayPath(JSON 리터럴)로 안전하게 기록된다", async () => {
      const state = reviewState({ verify: ["npm test"], verify_guard_baseline_sha: "base0" });
      const phase = state.phases[0];
      const c1 = comment(1);
      const pr = stubPr({ views: [OPEN], comments: [[c1]] });
      const runner = stubRunner(async () => ({ status: "done", summary: "고쳤다", commits: ["fix1"], addressed: ADDR }));
      const changedFiles = async () => ({ ok: false as const, reason: "invalid_utf8" as const, paths: [pathWithNewline] });
      const d = makeDeps({ pr, runner, changedFiles });

      await runPrGate(dir, state, phase, d, null, d.now());

      expect(phase.sessions[0].verdict?.detail).toBe(JSON.stringify(pathWithNewline));
    });

    it("채널 5(prloop PR 코멘트): 개행 포함 원인 경로가 displayPath(JSON 리터럴)로 한 줄에 안전하게 표시된다", async () => {
      const state = reviewState({ verify: ["npm test"], verify_guard_baseline_sha: "base0" });
      const phase = state.phases[0];
      const c1 = comment(1);
      const pr = stubPr({ views: [OPEN], comments: [[c1]] });
      const runner = stubRunner(async () => ({ status: "done", summary: "고쳤다", commits: ["fix1"], addressed: ADDR }));
      const changedFiles = async () => ({ ok: false as const, reason: "invalid_utf8" as const, paths: [pathWithNewline] });
      const d = makeDeps({ pr, runner, changedFiles });

      await runPrGate(dir, state, phase, d, null, d.now());

      const reply = pr.replies[0]!;
      const line = reply.split("\n").find(l => l.includes("line1"));
      expect(line).toBeDefined();
      expect(line).toContain(JSON.stringify(pathWithNewline));
    });
  });
});

// ── withRetry: 재시도 대상(viewPr/listComments) vs 비대상(createPr/postPrComment) ──

// ── runPrGate: pushBranch 의 sourceRef 배선 (§29 CR-2 회귀, §36 I-6) ─────────

describe("runPrGate — pushBranch 의 sourceRef 배선 (§29 CR-2 회귀, §36 I-6)", () => {
  // pr.test.ts 의 buildPushArgs 테스트는 "sourceRef 인자가 주어지면 올바른 git push 인자를
  // 조립하는가"만 증명한다 — prloop.ts 자신이 workBranch 로부터 그 인자를 실제로 계산해
  // pr.pushBranch 에 넘기는지는 별개의 계약이고, 지금까지 그 배선을 못박은 테스트가 없었다
  // (§36 I-6, mutation `pushSourceRef = workBranch ?? undefined` → `undefined` 가 전체
  // 스위트에서도 SURVIVED). 여기서는 runPrGate 를 통해 실제 pr.pushBranch 호출 인자를 캡처한다.
  type PushCall = { branch: string; sourceRef?: string };

  function stubPrCapturingPush(views: PrView[]): PrClient & { pushCalls: PushCall[] } {
    const pushCalls: PushCall[] = [];
    let v = 0;
    return {
      pushCalls,
      async pushBranch(o) { pushCalls.push({ branch: o.branch, sourceRef: o.sourceRef }); },
      async createPr() { return { number: 42, url: "https://ex/pull/42" }; },
      async listComments() { return []; },
      async viewPr() { return views[Math.min(v++, views.length - 1)]; },
      async postReviewComments() {},
      async postPrComment() {},
    };
  }

  it("workBranch 가 있으면(isolate/require-topic) PR 최초 생성 push 에 그 값을 sourceRef 로 명시한다", async () => {
    const state = pendingState();
    const phase = state.phases[0];
    const pr = stubPrCapturingPush([MERGED]);
    const d = makeDeps({ pr });

    await runPrGate(dir, state, phase, d, "fw/wf", d.now());

    expect(pr.pushCalls).toEqual([{ branch: "fw/phase-1", sourceRef: "fw/wf" }]);
  });

  // §36 후속: fix 루프의 배치 flush push(prloop.ts:281)는 위 두 경로와 **다른 줄**이고, 이전에는
  // `workBranch ?? undefined` 를 인라인으로 다시 계산해 pushSourceRef 변수와 갈릴 수 있었다
  // (§30 P1 — 같은 판정을 두 곳에서 하면 한쪽만 고쳤을 때 조용히 어긋난다). 그 줄이 실제로
  // sourceRef 를 넘기는지는 위 두 테스트가 덮지 못한다 — 여기서 fix 세션을 실제로 태워 확인한다.
  it("fix 루프의 배치 flush push 에도 sourceRef 가 명시된다 (§30 P1 — :114 와 :281 이 갈리지 않게)", async () => {
    const state = baseState({
      pr: { number: 42, url: "https://ex/pull/42", head_branch: "fw/phase-1", handled_comment_keys: [], fix_sessions: 0 },
    });
    const phase = state.phases[0];
    const pushCalls: Array<{ branch: string; sourceRef?: string }> = [];
    let v = 0;
    const views: PrView[] = [OPEN, MERGED];
    const pr: PrClient = {
      async pushBranch(o) { pushCalls.push({ branch: o.branch, sourceRef: o.sourceRef }); },
      async createPr() { return { number: 42, url: "https://ex/pull/42" }; },
      async listComments() { return v === 1 ? [comment(7)] : []; },
      async viewPr() { return views[Math.min(v++, views.length - 1)]!; },
      async postReviewComments() {},
      async postPrComment() {},
    };
    const runner = stubRunner(async () => ({ status: "done", summary: "고쳤습니다", commits: ["fix1"], addressed: ADDR }));
    const d = makeDeps({ pr, runner });

    await runPrGate(dir, state, phase, d, "fw/wf", d.now());

    // 재동기화 push(1회) + fix 배치 flush push(1회) — **둘 다** sourceRef 가 있어야 한다.
    expect(pushCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of pushCalls) {
      expect(call.sourceRef).toBe("fw/wf");
    }
  });

  it("workBranch 가 있으면 재동기화 push(phase.pr 이미 존재)에도 sourceRef 를 명시한다", async () => {
    const state = baseState({
      pr: { number: 42, url: "https://ex/pull/42", head_branch: "fw/phase-1", handled_comment_keys: [], fix_sessions: 0 },
    });
    const phase = state.phases[0];
    // 열린 PR 로 시작해야 재동기화가 일어난다 — 머지된 PR 은 동기화 대상이 아니다.
    const pr = stubPrCapturingPush([OPEN, MERGED]);
    const d = makeDeps({ pr });

    await runPrGate(dir, state, phase, d, "fw/wf", d.now());

    expect(pr.pushCalls).toEqual([{ branch: "fw/phase-1", sourceRef: "fw/wf" }]);
  });

  it("workBranch 가 null 이면(branch_strategy=current) sourceRef 를 넘기지 않는다 — 기존 HEAD: 동작 유지 (§2 D7)", async () => {
    const state = pendingState();
    const phase = state.phases[0];
    const pr = stubPrCapturingPush([MERGED]);
    const d = makeDeps({ pr });

    await runPrGate(dir, state, phase, d, null, d.now());

    expect(pr.pushCalls).toEqual([{ branch: "fw/phase-1", sourceRef: undefined }]);
  });
});

describe("runPrGate — withRetry 적용 범위", () => {
  it("viewPr 이 일시 실패 후 성공하면 재시도해 계속 진행한다 (조회는 재시도 대상)", async () => {
    const state = baseState({
      pr: { number: 42, url: "https://ex/pull/42", head_branch: "fw/phase-1", handled_comment_keys: [], fix_sessions: 0 },
    });
    const phase = state.phases[0];
    let calls = 0;
    const pr: PrClient = {
      async pushBranch() {},
      async createPr() { throw new Error("호출되면 안 됨"); },
      async listComments() { return []; },
      async viewPr() { calls++; if (calls === 1) throw new Error("network blip"); return MERGED; },
      async postReviewComments() {},
      async postPrComment() {},
    };
    const d = makeDeps({ pr });

    const outcome = await runPrGate(dir, state, phase, d, "fw/wf", d.now());

    expect(outcome).toBe("done");
    expect(calls).toBe(2);
    expect(d.sleeps).toEqual([1000]); // 첫 재시도 지연
    expect(d.logs.some(l => l.includes("PR 상태 조회") && l.includes("재시도 1/3"))).toBe(true);
  });

  it("viewPr 이 재시도(3회)까지 모두 실패하면 지연 [1000,4000,15000] 을 전부 소진한 뒤 failed 로 확정된다", async () => {
    const state = baseState({
      pr: { number: 42, url: "https://ex/pull/42", head_branch: "fw/phase-1", handled_comment_keys: [], fix_sessions: 0 },
    });
    const phase = state.phases[0];
    const pr: PrClient = {
      async pushBranch() {},
      async createPr() { throw new Error("호출되면 안 됨"); },
      async listComments() { return []; },
      async viewPr() { throw new Error("영구 실패"); },
      async postReviewComments() {},
      async postPrComment() {},
    };
    const d = makeDeps({ pr });

    const outcome = await runPrGate(dir, state, phase, d, "fw/wf", d.now());

    expect(outcome).toBe("failed");
    expect(d.sleeps).toEqual([1000, 4000, 15000]);
    expect(d.notes.some(n => n.includes("PR 게이트 오류") && n.includes("영구 실패"))).toBe(true);
  });

  it("listComments 도 일시 실패 후 성공하면 재시도한다 (조회는 재시도 대상)", async () => {
    const state = baseState({
      pr: { number: 42, url: "https://ex/pull/42", head_branch: "fw/phase-1", handled_comment_keys: [], fix_sessions: 0 },
    }, { poll_interval_ms: 999 });
    const phase = state.phases[0];
    let calls = 0;
    let vi = 0;
    const pr: PrClient = {
      async pushBranch() {},
      async createPr() { throw new Error("호출되면 안 됨"); },
      async listComments() { calls++; if (calls === 1) throw new Error("blip"); return []; },
      async viewPr() { return [OPEN, MERGED][Math.min(vi++, 1)]; },
      async postReviewComments() {},
      async postPrComment() {},
    };
    const d = makeDeps({ pr });

    const outcome = await runPrGate(dir, state, phase, d, "fw/wf", d.now());

    expect(outcome).toBe("done");
    expect(calls).toBe(2);
    expect(d.sleeps[0]).toBe(1000); // listComments 재시도 지연이 먼저
    expect(d.sleeps).toContain(999); // 그 다음 정상 폴링 대기
    expect(d.logs.some(l => l.includes("PR 코멘트 조회") && l.includes("재시도 1/3"))).toBe(true);
  });

  it("postPrComment 실패는 재시도하지 않고 무시된다 — handled 기록과 판정은 그대로 확정된다", async () => {
    const state = baseState({
      pr: { number: 42, url: "https://ex/pull/42", head_branch: "fw/phase-1", handled_comment_keys: [], fix_sessions: 0 },
    });
    const phase = state.phases[0];
    const c7 = comment(7);
    let vi = 0, ci = 0, postCalls = 0;
    const pr: PrClient = {
      async pushBranch() {},
      async createPr() { throw new Error("호출되면 안 됨"); },
      async listComments() { return [[c7], []][ci++] ?? []; },
      async viewPr() { return [OPEN, MERGED][Math.min(vi++, 1)]; },
      async postReviewComments() {},
      async postPrComment() { postCalls++; throw new Error("게시판 다운"); },
    };
    const runner = stubRunner(async () => ({ status: "done", summary: "고쳤습니다", commits: ["fix1"], addressed: ADDR }));
    const d = makeDeps({ pr, runner });

    const outcome = await runPrGate(dir, state, phase, d, null, d.now());

    expect(outcome).toBe("done"); // 답글 실패가 판정을 흔들지 않는다 (C2)
    expect(postCalls).toBe(1); // 재시도 없음
    expect(phase.pr?.handled_comment_keys).toEqual(["issue:7"]); // 진실은 이미 확정됨
    expect(d.logs.some(l => l.includes("답글 게시 실패") && l.includes("무시"))).toBe(true);
  });
});

// §47 — PR 본문은 신뢰 경계 밖 텍스트(세션 요약)가 외부(GitHub)로 나가는 지점이다.
describe("PR 본문 — §47 코드 레벨 요약 + 마스킹", () => {
  it("세션 요약과 실측 커밋 로그가 본문에 실린다", async () => {
    const state = pendingState({ title: "t" });
    const phase = state.phases[0];
    phase.sessions.push({ session_id: "s1", result: "done", summary: "kafka 직렬화 스냅샷 테스트 추가", at: "t", kind: "phase" });
    let body = "";
    const pr: PrClient = {
      async pushBranch() {},
      async createPr(o) { body = o.body; return { number: 1, url: "u" }; },
      async listComments() { return []; },
      async viewPr() { return MERGED; },
      async postReviewComments() {},
      async postPrComment() {},
    };
    const d = makeDeps({
      pr,
      git: async (args: string[]) =>
        args[0] === "log" ? { ok: true, stdout: "abc123 feat: 스냅샷\ndef456 test: 추가", stderr: "" } : { ok: true, stdout: "", stderr: "" },
    });
    await runPrGate(dir, state, phase, d, "fw/wf", d.now());
    expect(body).toContain("kafka 직렬화 스냅샷 테스트 추가");
    // 커밋 목록은 본문에 싣지 않는다 — GitHub 의 Commits 탭이 이미 보여준다.
    expect(body).not.toContain("abc123 feat: 스냅샷");
  });

  it("세션 요약 안의 비밀은 마스킹돼 나간다 — 외부 공개 지점", async () => {
    const state = pendingState({ title: "t" });
    const phase = state.phases[0];
    phase.sessions.push({ session_id: "s1", result: "done", summary: "토큰 ghp_AAAABBBBCCCCDDDDEEEE 로 확인함", at: "t", kind: "phase" });
    let body = "";
    const pr: PrClient = {
      async pushBranch() {},
      async createPr(o) { body = o.body; return { number: 1, url: "u" }; },
      async listComments() { return []; },
      async viewPr() { return MERGED; },
      async postReviewComments() {},
      async postPrComment() {},
    };
    await runPrGate(dir, state, phase, makeDeps({ pr }), "fw/wf", makeDeps({ pr }).now());
    expect(body).not.toContain("ghp_AAAABBBBCCCCDDDDEEEE");
    expect(body).toContain("***MASKED***");
  });
});

// docs/pr-comment-mask/PLAN.md D1~D3 — §47 은 createPr(PR 본문) 만 마스킹해 코멘트 경로(postPrComment)
// 4곳(반영 성공/실패, 배치 검증 실패, 브랜치 이탈 진단)이 마스킹 없이 외부로 나가는 재발을 남겼다.
// 이 describe 는 그 4곳 전부를 직접 때려 D1(예외 없는 마스킹)·D2(500자 절단 표기)·D3(tampered 목록
// 항목 경계 절단)을 못박는다.
describe("runPrGate — postPrComment 마스킹/절단 표기 (docs/pr-comment-mask D1~D3)", () => {
  function reviewState(phaseOverrides: Partial<Phase> = {}): State {
    return baseState({
      pr: { number: 42, url: "https://ex/pull/42", head_branch: "fw/phase-1", handled_comment_keys: [], fix_sessions: 0 },
      ...phaseOverrides,
    });
  }
  const SECRET = "ghp_AAAABBBBCCCCDDDDEEEE";

  it("fix 세션이 done 을 보고하고 요약에 비밀+500자 초과 텍스트가 섞이면 ✅ 답글이 마스킹되고 절단 표기를 갖는다 (D1/D2)", async () => {
    const state = reviewState();
    const phase = state.phases[0];
    const c7 = comment(7);
    const pr = stubPr({ views: [OPEN, MERGED], comments: [[c7], []] });
    const longSecretSummary = `토큰 ${SECRET} 로 확인함. ` + "설명".repeat(300);
    const runner = stubRunner(async () => ({ status: "done", summary: longSecretSummary, commits: ["fix1"], addressed: ADDR }));
    const d = makeDeps({ pr, runner });

    const outcome = await runPrGate(dir, state, phase, d, null, d.now());

    expect(outcome).toBe("done");
    const reply = pr.replies.find(r => r.startsWith("✅"));
    expect(reply).toBeDefined();
    expect(reply).not.toContain(SECRET);
    expect(reply).toContain("***MASKED***");
    expect(reply).toMatch(/truncated, \d+ chars total/); // D2: 잘렸다는 표기가 출력 자체에 남는다
  });

  it("fix 세션이 failed 를 보고하고 요약에 비밀+500자 초과 텍스트가 섞이면 ⚠️ 반영 실패 답글도 마스킹·절단 표기된다 (D1/D2)", async () => {
    const state = reviewState();
    const phase = state.phases[0];
    const c7 = comment(7);
    const pr = stubPr({ views: [OPEN], comments: [[c7]] });
    const longSecretSummary = `실패: ${SECRET} 유출 확인. ` + "x".repeat(600);
    const runner = stubRunner(async () => ({ status: "failed", summary: longSecretSummary, commits: [] }));
    const d = makeDeps({ pr, runner });

    const outcome = await runPrGate(dir, state, phase, d, null, d.now());

    expect(outcome).toBe("failed");
    const reply = pr.replies.find(r => r.includes("반영 실패"));
    expect(reply).toBeDefined();
    expect(reply).not.toContain(SECRET);
    expect(reply).toContain("***MASKED***");
    expect(reply).toMatch(/truncated, \d+ chars total/);
  });

  it("배치 게이트 실패 출력에 비밀+500자 초과 텍스트가 섞이면 배치 답글이 마스킹·절단 표기된다 (D1/D2)", async () => {
    const state = reviewState();
    const phase = state.phases[0];
    const cs = [comment(1)];
    const pr = stubPr({ views: [OPEN], comments: [cs] });
    const runner = stubRunner(async () => ({ status: "done", summary: "고쳤다", commits: ["fix1"], addressed: ADDR }));
    const secretOutput = `${SECRET} ` + "x".repeat(600);
    const gate = async (): Promise<GateResult> => ({
      passed: false,
      results: [{ command: "npm test", exitCode: 1, signal: null, output: secretOutput, fatal: false, timedOut: false }],
    });
    const d = makeDeps({ pr, runner, gate });

    const outcome = await runPrGate(dir, state, phase, d, null, d.now());

    expect(outcome).toBe("failed");
    expect(pr.replies).toHaveLength(1);
    expect(pr.replies[0]).not.toContain(SECRET);
    expect(pr.replies[0]).toContain("***MASKED***");
    expect(pr.replies[0]).toMatch(/truncated, \d+ chars total/);
  });

  it("배치 위조 가드가 걸리면 답글의 tampered 목록이 항목 경계에서 잘리고 '…외 N건' 표기가 붙는다 (D3)", async () => {
    const files = Array.from(
      { length: 30 },
      (_, i) => `./scripts/verify-item-${String(i).padStart(2, "0")}-long-descriptive-name.sh`,
    );
    const state = reviewState({ verify: files, verify_guard_baseline_sha: "base0" });
    const phase = state.phases[0];
    const c1 = comment(1);
    const pr = stubPr({ views: [OPEN], comments: [[c1]] });
    const runner = stubRunner(async () => ({ status: "done", summary: "고쳤다", commits: ["fix1"], addressed: ADDR }));
    const changedFiles = async () => ({ ok: true as const, files }); // 검증 대상 전부를 위조한 것으로 흉내
    const d = makeDeps({ pr, runner, changedFiles });

    const outcome = await runPrGate(dir, state, phase, d, null, d.now());

    expect(outcome).toBe("failed");
    expect(pr.replies).toHaveLength(1);
    const reply = pr.replies[0];
    expect(reply).toMatch(/…외 \d+건/);
    // 항목 경계 절단이라 잘린 지점 앞의 마지막 항목은 displayPath(JSON.stringify)로 닫힌 문자열이어야
    // 한다 — char-slice 였다면 이 마지막 줄이 닫는 인용부호 없이 중간에서 끊겼을 것이다.
    // §tamper-gap P4: 각 줄은 이제 "라벨: JSON리터럴" 형태(formatGuardedFileLines)다 — JSON 리터럴
    // 부분(마지막 ": " 뒤)만 떼어 닫힌 문자열인지 확인한다.
    const beforeSuffix = reply.split("…외")[0];
    const lastLine = beforeSuffix.trim().split("\n").pop()!;
    const jsonPart = lastLine.slice(lastLine.lastIndexOf(": ") + 2);
    expect(jsonPart.startsWith('"')).toBe(true);
    expect(jsonPart.endsWith('"')).toBe(true);
    expect(() => JSON.parse(jsonPart)).not.toThrow();
  });

  it("배치 위조 가드 경로도 예외 없이 마스킹을 거친다 — tampered 파일명에 비밀 패턴이 섞여도 답글에서 지워진다 (D1)", async () => {
    // verify_tampered 분기는 하네스가 만든 경로 목록이라 평소엔 비밀이 섞일 일이 거의 없지만, D1 은
    // "이 경로는 안전하니 예외" 라는 개별 판단을 허용하지 않는다 — 파일명 자체가 비밀 패턴을
    // 흉내내도 최종 body 는 여전히 마스킹을 거쳐야 한다.
    const tamperedFile = `./${SECRET}.sh`;
    const state = reviewState({ verify: [tamperedFile], verify_guard_baseline_sha: "base0" });
    const phase = state.phases[0];
    const c1 = comment(1);
    const pr = stubPr({ views: [OPEN], comments: [[c1]] });
    const runner = stubRunner(async () => ({ status: "done", summary: "고쳤다", commits: ["fix1"], addressed: ADDR }));
    const changedFiles = async () => ({ ok: true as const, files: [tamperedFile] });
    const d = makeDeps({ pr, runner, changedFiles });

    const outcome = await runPrGate(dir, state, phase, d, null, d.now());

    expect(outcome).toBe("failed");
    expect(pr.replies).toHaveLength(1);
    expect(pr.replies[0]).not.toContain(SECRET);
    expect(pr.replies[0]).toContain("***MASKED***");
  });

  it("fix 세션이 격리 브랜치를 이탈하면 진단 문구에 섞인 비밀 패턴도 답글에서 마스킹된다 (D1)", async () => {
    const state = reviewState();
    const phase = state.phases[0];
    const c7 = comment(7);
    const pr = stubPr({ views: [OPEN], comments: [[c7]] });
    const runner = stubRunner(async () => ({ status: "done", summary: "고쳤다고 주장", commits: ["fix1"], addressed: ADDR }));
    // 실제 브랜치 이탈 진단은 git 이 보고한 브랜치명을 그대로 문구에 담는다 — 그 출처가 비밀
    // 패턴을 흉내내도 답글은 여전히 마스킹을 거쳐야 한다(D1 — 예외 없음).
    const git = async () => ({ ok: true, stdout: SECRET, stderr: "" });
    const d = makeDeps({ pr, runner, git });

    const outcome = await runPrGate(dir, state, phase, d, "fw/wf", d.now());

    expect(outcome).toBe("failed");
    expect(pr.replies).toHaveLength(1);
    expect(pr.replies[0]).not.toContain(SECRET);
    expect(pr.replies[0]).toContain("***MASKED***");
  });
});

// ── issue #3: no-op fix 세션(already_applied) 이 FAILED 로 떨어지지 않는다 ───────────
describe("runPrGate — already_applied 결과 (issue #3)", () => {
  function reviewState(prOverrides: Partial<NonNullable<Phase["pr"]>> = {}): State {
    return baseState({
      pr: { number: 42, url: "https://ex/pull/42", head_branch: "fw/phase-1", handled_comment_keys: [], fix_sessions: 0, ...prOverrides },
    });
  }

  it("already_applied + 근거 SHA 검증 통과 → 게이트를 돌리지 않고 handled 로 확정, 답글은 '이미 반영', 판정 accepted", async () => {
    const state = reviewState();
    const phase = state.phases[0];
    const c7 = comment(7);
    const pr = stubPr({ views: [OPEN, MERGED], comments: [[c7], []] });
    let gateCalls = 0;
    const checked: string[][] = [];
    const runner = stubRunner(async () => ({ status: "already_applied", summary: "코멘트 A 반영 시 함께 정리됨", commits: ["abc1234"], addressed: ADDR }));
    const d = makeDeps({
      pr, runner,
      gate: async () => { gateCalls++; return { passed: true, results: [] }; },
      alreadyAppliedCommit: async (_cwd, sha, head, base) => { checked.push([sha, head, base]); return { ok: true }; },
    });

    const outcome = await runPrGate(dir, state, phase, d, null, d.now());

    expect(outcome).toBe("done");
    expect(checked).toEqual([["abc1234", "HEAD", "main"]]); // workBranch=null 이면 HEAD 기준
    expect(gateCalls).toBe(0); // 변경이 없는 배치에는 검증 스위트를 돌리지 않는다
    expect(phase.pr?.handled_comment_keys).toEqual(["issue:7"]);
    expect(pr.replies.some(r => r.includes("✅ issue:7 이미 반영") && r.includes("abc1234"))).toBe(true);
    expect(phase.sessions[0].verdict?.outcome).toBe("accepted");
    expect(d.notes.some(n => n.includes("FAILED"))).toBe(false);
  });

  it("workBranch 가 있으면 근거 SHA 도달성은 그 브랜치 기준으로 검증한다", async () => {
    const state = reviewState();
    const phase = state.phases[0];
    const pr = stubPr({ views: [OPEN, MERGED], comments: [[comment(7)], []] });
    const checked: string[][] = [];
    const runner = stubRunner(async () => ({ status: "already_applied", summary: "x", commits: ["abc1234"], addressed: ADDR }));
    const d = makeDeps({ pr, runner, alreadyAppliedCommit: async (_c, sha, head, base) => { checked.push([sha, head, base]); return { ok: true }; } });
    // makeDeps 의 git 스텁은 현재 브랜치를 "fw/wf" 로 답한다 — 그 값을 workBranch 로 넘겨야 이탈 판정이 안 난다
    await runPrGate(dir, state, phase, d, "fw/wf", d.now());
    expect(checked).toEqual([["abc1234", "fw/wf", "main"]]);
  });

  it("already_applied 인데 근거 SHA 가 PR 이력에 없으면 bounced/already_applied_unverified 로 회송하고 handled 로 기록하지 않는다", async () => {
    const state = reviewState();
    const phase = state.phases[0];
    const pr = stubPr({ views: [OPEN], comments: [[comment(7)]] });
    const runner = stubRunner(async () => ({ status: "already_applied", summary: "됐다고 주장", commits: ["deadbeef"], addressed: ADDR }));
    const d = makeDeps({ pr, runner, alreadyAppliedCommit: async () => ({ ok: false, reason: "PR 브랜치에서 도달 가능하지 않습니다" }) });

    const outcome = await runPrGate(dir, state, phase, d, null, d.now());

    expect(outcome).toBe("failed");
    expect(phase.pr?.handled_comment_keys).toEqual([]);
    expect(phase.sessions[0].verdict).toMatchObject({ outcome: "bounced", reason: "already_applied_unverified" });
    expect(pr.replies.some(r => r.includes("⚠️ issue:7") && r.includes("도달 가능하지 않습니다"))).toBe(true);
  });

  it("already_applied 인데 commits 가 비어 있으면(근거 없음) 역시 already_applied_unverified 로 회송한다", async () => {
    const state = reviewState();
    const phase = state.phases[0];
    const pr = stubPr({ views: [OPEN], comments: [[comment(7)]] });
    const runner = stubRunner(async () => ({ status: "already_applied", summary: "근거 없음", commits: [], addressed: ADDR }));
    const d = makeDeps({ pr, runner, alreadyAppliedCommit: async () => ({ ok: true }) });
    const outcome = await runPrGate(dir, state, phase, d, null, d.now());
    expect(outcome).toBe("failed");
    expect(phase.sessions[0].verdict).toMatchObject({ outcome: "bounced", reason: "already_applied_unverified" });
  });

  it("done 과 already_applied 가 한 배치에 섞이면 게이트는 여전히 배치당 1회 돌고 둘 다 handled 된다", async () => {
    const state = reviewState();
    const phase = state.phases[0];
    const pr = stubPr({ views: [OPEN, MERGED], comments: [[comment(1), comment(2)], []] });
    let gateCalls = 0;
    const runner = stubRunner(async (input) =>
      input.comments[0].id === 1
        ? { status: "done", summary: "A 반영(+B 중복 정리)", commits: ["fix1"], addressed: ADDR }
        : { status: "already_applied", summary: "A 에서 함께 정리됨", commits: ["fix1"], addressed: ADDR });
    const d = makeDeps({ pr, runner, gate: async () => { gateCalls++; return { passed: true, results: [] }; }, alreadyAppliedCommit: async () => ({ ok: true }) });
    const outcome = await runPrGate(dir, state, phase, d, null, d.now());
    expect(outcome).toBe("done");
    expect(gateCalls).toBe(1);
    expect(phase.pr?.handled_comment_keys).toEqual(["issue:1", "issue:2"]);
  });
});

describe("runPrGate — in_flight_comment_keys 마커 (issue #3 제안 2)", () => {
  function reviewState(prOverrides: Partial<NonNullable<Phase["pr"]>> = {}): State {
    return baseState({
      pr: { number: 42, url: "https://ex/pull/42", head_branch: "fw/phase-1", handled_comment_keys: [], fix_sessions: 0, ...prOverrides },
    });
  }

  it("fix 세션 시작 전에 코멘트 키를 in_flight 로 디스크에 기록하고, handled 확정 후 제거한다", async () => {
    const state = reviewState();
    const phase = state.phases[0];
    const pr = stubPr({ views: [OPEN, MERGED], comments: [[comment(7)], []] });
    let inFlightDuringSession: string[] | undefined;
    const runner = stubRunner(async () => {
      inFlightDuringSession = loadState(dir).phases[0].pr?.in_flight_comment_keys;
      return { status: "done", summary: "고침", commits: ["fix1"], addressed: ADDR };
    });
    const d = makeDeps({ pr, runner });
    await runPrGate(dir, state, phase, d, null, d.now());
    expect(inFlightDuringSession).toEqual(["issue:7"]);
    expect(phase.pr?.in_flight_comment_keys).toEqual([]);
    expect(loadState(dir).phases[0].pr?.in_flight_comment_keys).toEqual([]);
  });

  it("재개 시 in_flight 에 남아 있던 코멘트는 interruptedPreviously=true 로 fix 세션에 전달된다 (다른 코멘트는 아님)", async () => {
    const state = reviewState({ in_flight_comment_keys: ["issue:7"] });
    const phase = state.phases[0];
    const pr = stubPr({ views: [OPEN, MERGED], comments: [[comment(7), comment(8)], []] });
    const flags: Array<[string, boolean | undefined]> = [];
    const runner = stubRunner(async (input) => {
      flags.push([`${input.comments[0].kind}:${input.comments[0].id}`, input.interruptedPreviously]);
      return { status: "done", summary: "고침", commits: ["fix1"], addressed: ADDR };
    });
    const d = makeDeps({ pr, runner });
    await runPrGate(dir, state, phase, d, null, d.now());
    expect(flags).toEqual([["issue:7", true], ["issue:8", false]]);
    expect(phase.pr?.in_flight_comment_keys).toEqual([]);
  });

  it("세션이 bounced 로 끝나면 in_flight 마커는 남는다 — 다음 실행이 '이미 반영됐는지 먼저 확인' 힌트를 받게", async () => {
    const state = reviewState();
    const phase = state.phases[0];
    const pr = stubPr({ views: [OPEN], comments: [[comment(7)]] });
    const runner = stubRunner(async () => ({ status: "done", summary: "주장", commits: [], addressed: ADDR }));
    const d = makeDeps({ pr, runner });
    expect(await runPrGate(dir, state, phase, d, null, d.now())).toBe("failed");
    expect(loadState(dir).phases[0].pr?.in_flight_comment_keys).toEqual(["issue:7"]);
  });
});

// ── issue #4: 코멘트 항목별 반영 보고가 없으면 회송, 있으면 답글에 싣는다 ──────────
describe("runPrGate — addressed(항목별 반영 여부) 계약 (issue #4)", () => {
  function reviewState(): State {
    return baseState({
      pr: { number: 42, url: "https://ex/pull/42", head_branch: "fw/phase-1", handled_comment_keys: [], fix_sessions: 0 },
    });
  }

  it("done 인데 addressed 가 없으면 bounced/comment_items_unreported 로 회송하고 handled 로 기록하지 않는다 (커밋이 있어도)", async () => {
    const state = reviewState();
    const phase = state.phases[0];
    const pr = stubPr({ views: [OPEN], comments: [[comment(7)]] });
    const runner = stubRunner(async () => ({ status: "done", summary: "첫 지적만 고침", commits: ["fix1"] }));
    const d = makeDeps({ pr, runner });

    const outcome = await runPrGate(dir, state, phase, d, null, d.now());

    expect(outcome).toBe("failed");
    expect(phase.pr?.handled_comment_keys).toEqual([]);
    expect(phase.sessions[0].verdict).toMatchObject({ outcome: "bounced", reason: "comment_items_unreported" });
    expect(pr.replies.some(r => r.includes("⚠️ issue:7") && r.includes("항목"))).toBe(true);
  });

  it("already_applied 도 addressed 없이는 회송된다 (상태와 무관하게 항목 보고 필수)", async () => {
    const state = reviewState();
    const phase = state.phases[0];
    const pr = stubPr({ views: [OPEN], comments: [[comment(7)]] });
    const runner = stubRunner(async () => ({ status: "already_applied", summary: "이미", commits: ["abc1234"] }));
    const d = makeDeps({ pr, runner, alreadyAppliedCommit: async () => ({ ok: true }) });
    expect(await runPrGate(dir, state, phase, d, null, d.now())).toBe("failed");
    expect(phase.sessions[0].verdict).toMatchObject({ outcome: "bounced", reason: "comment_items_unreported" });
  });

  it("addressed 가 있으면 ✅ 답글에 항목별 결과가 한 줄씩 실리고, declined 가 있으면 코멘트 작성자를 멘션해 확인을 요청한다", async () => {
    const state = reviewState();
    const phase = state.phases[0];
    const pr = stubPr({ views: [OPEN, MERGED], comments: [[comment(7)], []] });
    const runner = stubRunner(async () => ({
      status: "done", summary: "1은 반영, 2는 보류", commits: ["fix1"],
      addressed: [
        { item: "설정을 공유 yml 로 이관", status: "applied", evidence: "fix1 application-jp-point.yml" },
        { item: "Feign default 위치 정정", status: "declined", evidence: "문서 5개 전제가 바뀜 — 사람 확인 필요" },
        { item: "오타", status: "not_applicable", evidence: "해당 파일 없음" },
      ],
    }));
    const d = makeDeps({ pr, runner });

    const outcome = await runPrGate(dir, state, phase, d, null, d.now());

    expect(outcome).toBe("done");
    expect(phase.pr?.handled_comment_keys).toEqual(["issue:7"]);
    const reply = pr.replies.find(r => r.startsWith("✅ issue:7"))!;
    expect(reply).toContain("반영함");
    expect(reply).toContain("설정을 공유 yml 로 이관");
    expect(reply).toContain("반영 안 함");
    expect(reply).toContain("Feign default 위치 정정");
    expect(reply).toContain("해당 없음");
    expect(reply).toContain("@alice"); // declined 항목이 있으면 리뷰어 확인 요청
    expect(phase.sessions[0].addressed).toHaveLength(3); // STATE 에도 남는다
  });

  it("declined 가 없으면 리뷰어 멘션을 붙이지 않는다", async () => {
    const state = reviewState();
    const phase = state.phases[0];
    const pr = stubPr({ views: [OPEN, MERGED], comments: [[comment(7)], []] });
    const runner = stubRunner(async () => ({ status: "done", summary: "전부 반영", commits: ["fix1"], addressed: ADDR }));
    const d = makeDeps({ pr, runner });
    await runPrGate(dir, state, phase, d, null, d.now());
    const reply = pr.replies.find(r => r.startsWith("✅ issue:7"))!;
    expect(reply).toContain("반영함");
    expect(reply).not.toContain("@alice");
  });

  it("항목 텍스트의 비밀은 마스킹돼 나간다 (세션 자기 보고 텍스트 = 신뢰 경계 밖)", async () => {
    const state = reviewState();
    const phase = state.phases[0];
    const pr = stubPr({ views: [OPEN, MERGED], comments: [[comment(7)], []] });
    const secret = "ghp_" + "A".repeat(36);
    const runner = stubRunner(async () => ({
      status: "done", summary: "ok", commits: ["fix1"],
      addressed: [{ item: `토큰 ${secret} 교체`, status: "applied", evidence: secret }],
    }));
    const d = makeDeps({ pr, runner });
    await runPrGate(dir, state, phase, d, null, d.now());
    const reply = pr.replies.find(r => r.startsWith("✅ issue:7"))!;
    expect(reply).not.toContain(secret);
  });
});

// ── pr-slicing Phase 3: 조각 PR 배선 ────────────────────────────────────────
// Phase 1 검토의 교훈대로 배선 자체를 못박는다 — 조각 PR 이 base 브랜치로 가버리면
// 중간 상태가 main/develop 에 실린다(설계 전체가 무너지는 결함인데 조용히 통과할 수 있다).
describe("조각 PR 배선 (pr-slicing Phase 3)", () => {
  // NUL 은 `\u0000` 으로 쓴다 — `\0` 뒤에 숫자가 오면 8진 이스케이프(`\0200`)로 해석돼
  // TS1487 로 컴파일이 깨진다(실측).
  const NUMSTAT = "10\t2\tsrc/a.ts\u0000200\t5\tdocs/wf/PLAN.md\u0000";

  /** git 호출을 기록하고 명령별로 그럴듯한 출력을 주는 스텁. */
  function recordingGit(calls: string[]) {
    return async (args: string[]) => {
      calls.push(args.join(" "));
      if (args[0] === "log") return { ok: true, stdout: "abc1234 feat: 조각 작업", stderr: "" };
      if (args[0] === "diff") return { ok: true, stdout: NUMSTAT, stderr: "" };
      if (args[0] === "rev-parse") return { ok: true, stdout: "feature/wf-3\n", stderr: "" };
      return { ok: true, stdout: "", stderr: "" };
    };
  }

  function sliceState() {
    const s = pendingState({ slice_seq: 3 });
    s.review_split = { enabled: true, budget_lines: 400 };
    s.integration_branch = "feature/wf";
    s.base_branch = "main";
    return s;
  }

  function captureCreate() {
    let opts: { headBranch: string; baseBranch: string; title: string; body: string } | null = null;
    const pr: PrClient = {
      async pushBranch() {},
      async createPr(o) { opts = o; return { number: 9, url: "https://ex/pull/9" }; },
      async listComments() { return []; },
      async viewPr() { return MERGED; },
      async postReviewComments() {},
      async postPrComment() {},
    };
    return { pr, get: () => opts };
  }

  it("head 는 조각 브랜치, base 는 통합 브랜치다 (base 브랜치로 가지 않는다)", async () => {
    const state = sliceState();
    const { pr, get } = captureCreate();
    const d = makeDeps({ pr, git: recordingGit([]) });
    await runPrGate(dir, state, state.phases[0], d, "feature/wf-3", d.now());
    expect(get()!.headBranch).toBe("feature/wf-3");
    expect(get()!.baseBranch).toBe("feature/wf");
    expect(get()!.baseBranch).not.toBe("main");
  });

  it("예산 실측을 통합 브랜치 기준으로 잰다 (base 브랜치가 아니다)", async () => {
    const calls: string[] = [];
    const state = sliceState();
    const { pr } = captureCreate();
    const d = makeDeps({ pr, git: recordingGit(calls) });
    await runPrGate(dir, state, state.phases[0], d, "feature/wf-3", d.now());
    expect(calls).toContain("diff --numstat -z --no-renames feature/wf..feature/wf-3");
  });

  it("커밋 목록은 더 이상 조회하지 않는다 (GitHub Commits 탭이 이미 보여준다)", async () => {
    const calls: string[] = [];
    const state = sliceState();
    const { pr } = captureCreate();
    const d = makeDeps({ pr, git: recordingGit(calls) });
    await runPrGate(dir, state, state.phases[0], d, "feature/wf-3", d.now());
    expect(calls.some(c => c.startsWith("log --oneline"))).toBe(false);
  });

  // 예산 실측은 PR 본문에서 빠졌지만 신호는 남아야 한다 — 운영자가 "다음엔 예산이나 분해
  // 품질을 조정" 할 근거다. 본문에서 지우면서 로그 배선을 빠뜨리면 조용히 사라진다.
  it("예산을 넘으면 실행 로그에 남긴다 (진행은 막지 않는다 — D13)", async () => {
    const state = sliceState();
    state.review_split = { enabled: true, budget_lines: 100 }; // 실측 217줄
    const { pr } = captureCreate();
    const d = makeDeps({ pr, git: recordingGit([]) });
    await runPrGate(dir, state, state.phases[0], d, "feature/wf-3", d.now());
    const line = d.logs.find(l => l.includes("조각 크기"));
    expect(line).toBeDefined();
    expect(line).toContain("217");
    expect(line).toContain("100");
  });

  it("예산 비교는 리뷰 대상 라인만 본다 (기록용 문서가 예산을 밀어올리지 않는다 — D14)", async () => {
    // 워크플로우 디렉토리를 repo_root 의 하위로 둬야 그 안의 문서가 기록용으로 분류된다.
    // NUMSTAT 실측: src/a.ts 12줄(리뷰 대상) + docs/wf/PLAN.md 205줄(기록용) = 합 217.
    // 예산 100 이면 합은 넘지만 리뷰 대상은 넘지 않는다 — 경고가 나오면 안 된다.
    const wfDir = path.join(dir, "docs", "wf");
    fs.mkdirSync(wfDir, { recursive: true });
    const state = sliceState();
    state.review_split = { enabled: true, budget_lines: 100 };
    const { pr } = captureCreate();
    const d = makeDeps({ pr, git: recordingGit([]) });
    await runPrGate(wfDir, state, state.phases[0], d, "feature/wf-3", d.now());
    expect(d.logs.some(l => l.includes("조각 크기"))).toBe(false);
  });

  it("예산 안이면 아무 말도 하지 않는다", async () => {
    const state = sliceState(); // budget_lines: 400 > 217
    const { pr } = captureCreate();
    const d = makeDeps({ pr, git: recordingGit([]) });
    await runPrGate(dir, state, state.phases[0], d, "feature/wf-3", d.now());
    expect(d.logs.some(l => l.includes("조각 크기"))).toBe(false);
  });

  it("조각 분해를 쓰지 않는 PR 은 실측 자체를 하지 않는다 (쓰지 않을 git 호출을 하지 않는다)", async () => {
    const calls: string[] = [];
    const state = pendingState(); // review_split 없음 → 예산도 없다
    const { pr } = captureCreate();
    const d = makeDeps({ pr, git: recordingGit(calls) });
    await runPrGate(dir, state, state.phases[0], d, "fw/wf", d.now());
    expect(calls.some(c => c.startsWith("diff --numstat"))).toBe(false);
  });

  it("제목에 조각 순번을 담는다", async () => {
    const state = sliceState();
    const { pr, get } = captureCreate();
    const d = makeDeps({ pr, git: recordingGit([]) });
    await runPrGate(dir, state, state.phases[0], d, "feature/wf-3", d.now());
    expect(get()!.title).toContain("#3");
  });

  it("본문에 리뷰 대상/기록용 분리를 싣는다", async () => {
    const state = sliceState();
    const { pr, get } = captureCreate();
    const d = makeDeps({ pr, git: recordingGit([]) });
    await runPrGate(dir, state, state.phases[0], d, "feature/wf-3", d.now());
    const body = get()!.body;
    // 파일 수·라인 수는 GitHub 의 Files changed 탭이 이미 보여주므로 본문에서 뺐다.
    expect(body).not.toContain("리뷰 범위");
    // 남는 것은 "이 PR 이 어디로 머지되는가" 뿐이다 — base 로 바로 가지 않는다는 사실이다.
    expect(body).toContain("통합 브랜치");
  });

  it("머지되면 통합 브랜치를 fast-forward 로 전진시킨다 (옛 격리 브랜치 재생성 경로가 아니다)", async () => {
    const calls: string[] = [];
    const state = sliceState();
    const { pr } = captureCreate();
    const d = makeDeps({ pr, git: recordingGit(calls) });
    await runPrGate(dir, state, state.phases[0], d, "feature/wf-3", d.now());
    expect(calls).toContain("fetch origin feature/wf:feature/wf");
    // 강제(+)를 쓰지 않는다 — 로컬 커밋을 잃지 않는 것이 이 경로의 안전 계약이다.
    expect(calls.some(c => c.includes("+feature/wf"))).toBe(false);
  });

  it("slice_seq 가 없으면(분해 대상이 아닌 phase) 기존 경로를 그대로 탄다", async () => {
    const state = sliceState();
    state.phases[0].slice_seq = undefined;
    const { pr, get } = captureCreate();
    const d = makeDeps({ pr, git: recordingGit([]) });
    await runPrGate(dir, state, state.phases[0], d, "feature/wf-3", d.now());
    expect(get()!.headBranch).toBe("fw/phase-1");
    expect(get()!.baseBranch).toBe("main");
  });

  it("review_split 이 꺼져 있으면 통합 브랜치가 설정돼 있어도 기존 경로를 탄다", async () => {
    const state = sliceState();
    state.review_split = { enabled: false, budget_lines: 400 };
    const { pr, get } = captureCreate();
    const d = makeDeps({ pr, git: recordingGit([]) });
    await runPrGate(dir, state, state.phases[0], d, "feature/wf-3", d.now());
    expect(get()!.baseBranch).toBe("main");
  });
});

describe("읽는 순서 배선 (pr-slicing Phase 3)", () => {
  function withSession(reviewOrder?: string[]) {
    return pendingState({
      sessions: [{
        session_id: "s1", result: "done", summary: "요약", at: "2026-09-09T00:00:00Z",
        kind: "phase", ...(reviewOrder ? { review_order: reviewOrder } : {}),
      }],
    });
  }

  function captureBody() {
    let body = "";
    const pr: PrClient = {
      async pushBranch() {},
      async createPr(o) { body = o.body; return { number: 1, url: "https://ex/pull/1" }; },
      async listComments() { return []; },
      async viewPr() { return MERGED; },
      async postReviewComments() {},
      async postPrComment() {},
    };
    return { pr, get: () => body };
  }

  it("앵커를 잡지 못한 항목은 이유까지 본문에 남는다 (정보가 사라지지 않는다)", async () => {
    // 기본 git 스텁은 diff 를 내지 않으므로 앵커가 없다 — 두 항목 모두 본문으로 간다.
    const state = withSession(["src/schema.ts — 새 필드 정의", "test/schema.test.ts — 제약 검증"]);
    const { pr, get } = captureBody();
    const d = makeDeps({ pr });
    await runPrGate(dir, state, state.phases[0], d, "fw/wf", d.now());
    expect(get()).toContain("1. src/schema.ts — 새 필드 정의");
    expect(get()).toContain("2. test/schema.test.ts — 제약 검증");
  });

  it("읽는 순서가 없으면 그 목록을 만들지 않는다 (fail-open)", async () => {
    const state = withSession();
    const { pr, get } = captureBody();
    const d = makeDeps({ pr });
    await runPrGate(dir, state, state.phases[0], d, "fw/wf", d.now());
    expect(get()).not.toContain("직접 확인");
    expect(get()).toContain("@fw");
  });

  it("읽는 순서도 마스킹을 거친다 (세션 출처 텍스트가 외부로 나간다)", async () => {
    const state = withSession(["토큰은 ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 였다"]);
    const { pr, get } = captureBody();
    const d = makeDeps({ pr });
    await runPrGate(dir, state, state.phases[0], d, "fw/wf", d.now());
    expect(get()).not.toContain("ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  // ── 인라인 코멘트 배선 ────────────────────────────────────────────────
  // 이 프로젝트에서 결함이 반복적으로 나온 자리가 "순수 함수는 검증됐지만 배선은 아무도
  // 확인하지 않은" 지점이다. 조립(planReviewOrder/buildReviewPayload)은 inlinereview.test.ts
  // 가 보고, 여기서는 **그 결과가 실제로 호출까지 도달하는가**만 본다.

  const U0 = [
    "diff --git a/src/schema.ts b/src/schema.ts",
    "--- a/src/schema.ts",
    "+++ b/src/schema.ts",
    "@@ -12,0 +13,4 @@",
    "+added",
  ].join("\n");

  function gitWithU0(u0: string | null = U0) {
    return async (args: string[]) => {
      if (args[0] === "log") return { ok: true, stdout: "abc1234 feat", stderr: "" };
      if (args[0] === "diff" && args[1] === "-U0") {
        return u0 === null
          ? { ok: false, stdout: "", stderr: "fatal: bad revision" }
          : { ok: true, stdout: u0, stderr: "" };
      }
      if (args[0] === "diff") return { ok: true, stdout: "", stderr: "" };
      return { ok: true, stdout: "fw/wf", stderr: "" };
    };
  }

  function captureReview(opts: { failInline?: boolean; failComment?: boolean } = {}) {
    const inline: { number: number; comments: readonly InlineReviewComment[]; intro: string }[] = [];
    const replies: string[] = [];
    const order: string[] = [];
    let body = "";
    const pr: PrClient = {
      async pushBranch() {},
      async createPr(o) {
        order.push("createPr");
        body = o.body;
        return { number: 7, url: "https://ex/pull/7" };
      },
      async listComments() { return []; },
      async viewPr() { return MERGED; },
      async postReviewComments(o) {
        order.push("postReviewComments");
        if (opts.failInline) throw new Error("422 line must be part of the diff");
        inline.push({ number: o.number, comments: o.comments, intro: o.intro });
      },
      async postPrComment(o) {
        order.push("postPrComment");
        if (opts.failComment) throw new Error("게시판 다운");
        replies.push(o.body);
      },
    };
    return { pr, inline, replies, order, body: () => body };
  }

  it("앵커가 잡히는 항목은 코드 위 인라인으로 가고 본문에서는 빠진다", async () => {
    const state = withSession(["src/schema.ts — 새 필드 정의가 여기 있다"]);
    const cap = captureReview();
    const d = makeDeps({ pr: cap.pr, git: gitWithU0() });
    await runPrGate(dir, state, state.phases[0], d, "fw/wf", d.now());

    expect(cap.inline).toHaveLength(1);
    expect(cap.inline[0]!.number).toBe(7);
    expect(cap.inline[0]!.comments).toEqual([{
      path: "src/schema.ts", line: 13, side: "RIGHT",
      body: "**1/1 — 여기부터 읽으세요**\n\n새 필드 정의가 여기 있다",
    }]);
    // 이유도 순서도 코드 위에 있으므로 본문에는 남지 않는다 — 같은 글을 두 곳에 두지 않는다.
    expect(cap.body()).not.toContain("새 필드 정의가 여기 있다");
    expect(cap.body()).not.toContain("1. src/schema.ts");
    // 대신 어디를 보라고만 알린다.
    expect(cap.body()).toContain("Files changed");
  });

  it("PR 을 만들고 기록을 저장한 뒤에 코멘트를 붙인다 (중간에 실패해도 PR 을 또 만들지 않는다)", async () => {
    const state = withSession(["src/schema.ts — 이유"]);
    const cap = captureReview();
    const d = makeDeps({ pr: cap.pr, git: gitWithU0() });
    await runPrGate(dir, state, state.phases[0], d, "fw/wf", d.now());

    expect(cap.order.indexOf("createPr")).toBeLessThan(cap.order.indexOf("postReviewComments"));
    expect(loadState(dir).phases[0].pr?.number).toBe(7);
  });

  it("diff 에 없는 파일을 지목한 항목은 인라인을 만들지 않고 본문에 이유까지 남긴다", async () => {
    const state = withSession(["docs/배경.md — 왜 이렇게 했는지"]);
    const cap = captureReview();
    const d = makeDeps({ pr: cap.pr, git: gitWithU0() });
    await runPrGate(dir, state, state.phases[0], d, "fw/wf", d.now());

    expect(cap.order).not.toContain("postReviewComments");
    expect(cap.body()).toContain("1. docs/배경.md — 왜 이렇게 했는지");
  });

  it("인라인 코멘트가 422 로 거부되면 phase 를 죽이지 않고 전문을 일반 코멘트로 남긴다", async () => {
    const state = withSession(["src/schema.ts — 새 필드 정의가 여기 있다"]);
    const cap = captureReview({ failInline: true });
    const d = makeDeps({ pr: cap.pr, git: gitWithU0() });

    const outcome = await runPrGate(dir, state, state.phases[0], d, "fw/wf", d.now());

    expect(outcome).toBe("done");
    // 본문에는 경로만 남았으므로, 실패를 조용히 접으면 이유를 볼 곳이 없어진다.
    expect(cap.replies).toHaveLength(1);
    expect(cap.replies[0]).toContain("읽는 순서");
    expect(cap.replies[0]).toContain("1. src/schema.ts — 새 필드 정의가 여기 있다");
    expect(d.logs.some(l => l.includes("인라인 코멘트 실패"))).toBe(true);
  });

  it("대체 코멘트까지 실패해도 phase 판정은 유지하고 사실만 남긴다", async () => {
    const state = withSession(["src/schema.ts — 이유"]);
    const cap = captureReview({ failInline: true, failComment: true });
    const d = makeDeps({ pr: cap.pr, git: gitWithU0() });

    const outcome = await runPrGate(dir, state, state.phases[0], d, "fw/wf", d.now());

    expect(outcome).toBe("done");
    expect(d.logs.some(l => l.includes("읽는 순서 코멘트도 실패"))).toBe(true);
  });

  it("diff 를 조회하지 못하면 인라인을 포기하고 본문 목록으로만 남기며 그 사실을 로그에 남긴다", async () => {
    const state = withSession(["src/schema.ts — 새 필드 정의가 여기 있다"]);
    const cap = captureReview();
    const d = makeDeps({ pr: cap.pr, git: gitWithU0(null) });
    await runPrGate(dir, state, state.phases[0], d, "fw/wf", d.now());

    expect(cap.order).not.toContain("postReviewComments");
    expect(cap.body()).toContain("1. src/schema.ts — 새 필드 정의가 여기 있다");
    expect(d.logs.some(l => l.includes("코드에 붙이지 못합니다"))).toBe(true);
  });

  it("읽는 순서가 없으면 diff 조회 실패를 로그로 떠들지 않는다 (붙일 것이 없다)", async () => {
    const state = withSession();
    const cap = captureReview();
    const d = makeDeps({ pr: cap.pr, git: gitWithU0(null) });
    await runPrGate(dir, state, state.phases[0], d, "fw/wf", d.now());

    expect(d.logs.some(l => l.includes("코드에 붙이지 못합니다"))).toBe(false);
  });

  it("인라인 코멘트도 마스킹을 거친다 (세션 출처 텍스트가 GitHub 으로 나간다)", async () => {
    const state = withSession(["src/schema.ts — 토큰 ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 로 붙였다"]);
    const cap = captureReview();
    const d = makeDeps({ pr: cap.pr, git: gitWithU0() });
    await runPrGate(dir, state, state.phases[0], d, "fw/wf", d.now());

    expect(cap.inline[0]!.comments[0]!.body).not.toContain("ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });
});

// 검증 명령은 PR 본문에서 뺐다(사용자 결정) — 리뷰어가 아니라 운영자용 정보라 실행 로그와
// STATE 에만 남는다. 그래서 이 자리에 있던 '본문에 검증 명령이 실린다' 배선 테스트 2건을
// 지웠다. verifyCommandsFor 자체(어떤 명령이 이 phase 의 검증인가)는 state.test.ts 가 본다.

// ── pr-slicing Phase 5: 통합 PR 게이트 (D6) ─────────────────────────────────
// 조각 PR 이 전부 머지된 뒤 통합 브랜치 → base 브랜치 PR 하나로 마무리한다. 이 PR 은
// 조각별로 이미 리뷰가 끝났으므로 승인만 받으면 되고, 코멘트 fix 루프는 돌지 않는다.
describe("runIntegrationPrGate (pr-slicing Phase 5)", () => {
  function doneState(over: Partial<State> = {}): State {
    const s = baseState({ status: "done" }, {
      pr_mode: true, allow_push: true, base_branch: "main",
      integration_branch: "feature/wf",
      review_split: { enabled: true, budget_lines: 400 },
      ...over,
    });
    s.phases[0]!.status = "done";
    s.phases[0]!.slice_seq = 1;
    s.phases[0]!.pr = { number: 11, url: "https://ex/pull/11", head_branch: "feature/wf-1", handled_comment_keys: [], fix_sessions: 0 };
    return s;
  }

  function prStub(view: PrView) {
    const created: Array<{ headBranch: string; baseBranch: string; title: string; body: string }> = [];
    const pushed: string[] = [];
    const pr: PrClient = {
      async pushBranch(o) { pushed.push(o.branch); },
      async createPr(o) { created.push(o); return { number: 99, url: "https://ex/pull/99" }; },
      async listComments() { return []; },
      async viewPr() { return view; },
      async postReviewComments() {},
      async postPrComment() {},
    };
    return { pr, created, pushed };
  }

  it("통합 브랜치를 head, base 브랜치를 base 로 PR 을 만든다", async () => {
    const state = doneState();
    const { pr, created, pushed } = prStub(MERGED);
    const d = makeDeps({ pr });
    const outcome = await runIntegrationPrGate(dir, state, d, d.now());
    expect(outcome).toBe("done");
    expect(pushed).toEqual(["feature/wf"]);
    expect(created).toHaveLength(1);
    expect(created[0]!.headBranch).toBe("feature/wf");
    expect(created[0]!.baseBranch).toBe("main");
  });

  it("본문에 조각 PR 링크를 담는다", async () => {
    const state = doneState();
    const { pr, created } = prStub(MERGED);
    const d = makeDeps({ pr });
    await runIntegrationPrGate(dir, state, d, d.now());
    expect(created[0]!.body).toContain("https://ex/pull/11");
  });

  it("만든 PR 을 STATE 에 기록한다 (재실행 시 재생성하지 않는다)", async () => {
    const state = doneState();
    const { pr, created } = prStub(MERGED);
    const d = makeDeps({ pr });
    await runIntegrationPrGate(dir, state, d, d.now());
    expect(state.integration_pr?.number).toBe(99);
    // 같은 state 로 다시 부르면 PR 을 또 만들지 않는다
    await runIntegrationPrGate(dir, state, d, d.now());
    expect(created).toHaveLength(1);
  });

  it("머지되지 않았으면 awaiting_merge 로 사람에게 넘긴다", async () => {
    const state = doneState();
    const { pr } = prStub({ state: "OPEN", reviewDecision: null, merged: false });
    const d = makeDeps({ pr, sleep: async () => { throw new Error("폴링하지 않아야 한다"); } });
    const outcome = await runIntegrationPrGate(dir, state, d, d.now());
    expect(outcome).toBe("awaiting_merge");
    expect(d.notes.join("\n")).toMatch(/통합|머지/);
  });

  it("머지 없이 닫히면 failed 다", async () => {
    const state = doneState();
    const { pr } = prStub({ state: "CLOSED", reviewDecision: null, merged: false });
    const d = makeDeps({ pr });
    expect(await runIntegrationPrGate(dir, state, d, d.now())).toBe("failed");
  });

  it("통합 브랜치가 없으면 만들지 않고 건너뛴다 (조각 분해를 쓰지 않은 워크플로우)", async () => {
    const state = doneState({ integration_branch: undefined });
    const { pr, created } = prStub(MERGED);
    const d = makeDeps({ pr });
    expect(await runIntegrationPrGate(dir, state, d, d.now())).toBe("done");
    expect(created).toHaveLength(0);
  });

  it("PrClient 가 없으면 failed 다 (조용히 넘어가지 않는다)", async () => {
    const state = doneState();
    const d = makeDeps({ pr: undefined });
    expect(await runIntegrationPrGate(dir, state, d, d.now())).toBe("failed");
  });
});

// ── pr-slicing: 조각 PR 의 base(통합 브랜치)는 원격에 있어야 한다 ────────────
// **실전 통주가 잡은 결함.** 단위 테스트는 createPr 을 스텁하므로 "base 가 원격에 존재하는가"를
// 검증할 수 없었다. 실제 gh 는 없는 base 에 PR 을 만들지 못한다(실측):
//   gh pr create 실패: No commits between feature/slice-smoke and feature/slice-smoke-1,
//                      Base ref must be a branch (createPullRequest)
// 옛 토폴로지에서는 base 가 base_branch 라 항상 원격에 있었지만, 통합 브랜치는 로컬에서
// 만들어지므로 첫 조각 PR 전에 하네스가 올려야 한다.
describe("조각 PR 의 base 원격 보장 (실전 통주 회귀)", () => {
  function sliceState() {
    const s = pendingState({ slice_seq: 1 });
    s.review_split = { enabled: true, budget_lines: 400 };
    s.integration_branch = "feature/wf";
    s.base_branch = "main";
    return s;
  }

  /** ls-remote 응답을 고르는 git 스텁. */
  function gitWithRemote(hasIntegration: boolean, calls: string[]) {
    return async (args: string[]) => {
      calls.push(args.join(" "));
      if (args[0] === "ls-remote") {
        return hasIntegration
          ? { ok: true, stdout: "abc123\trefs/heads/feature/wf\n", stderr: "" }
          : { ok: true, stdout: "", stderr: "" };
      }
      if (args[0] === "log") return { ok: true, stdout: "abc1234 feat", stderr: "" };
      return { ok: true, stdout: "", stderr: "" };
    };
  }

  function capture() {
    const pushed: string[] = [];
    const order: string[] = [];
    const pr: PrClient = {
      async pushBranch(o) { pushed.push(o.branch); order.push(`push:${o.branch}`); },
      async createPr() { order.push("createPr"); return { number: 1, url: "https://ex/pull/1" }; },
      async listComments() { return []; },
      async viewPr() { return MERGED; },
      async postReviewComments() {},
      async postPrComment() {},
    };
    return { pr, pushed, order };
  }

  it("통합 브랜치가 원격에 없으면 조각 PR 을 만들기 전에 올린다", async () => {
    const calls: string[] = [];
    const { pr, pushed, order } = capture();
    const d = makeDeps({ pr, git: gitWithRemote(false, calls) });
    await runPrGate(dir, sliceState(), sliceState().phases[0], d, "feature/wf-1", d.now());
    expect(pushed).toContain("feature/wf");
    // 순서가 중요하다 — base 가 원격에 없는 상태로 createPr 을 부르면 gh 가 거부한다.
    expect(order.indexOf("push:feature/wf")).toBeLessThan(order.indexOf("createPr"));
    expect(calls.some(c => c.startsWith("ls-remote"))).toBe(true);
  });

  it("이미 원격에 있으면 통합 브랜치를 올리지 않는다 (원격이 앞서 있을 수 있다)", async () => {
    const { pr, pushed } = capture();
    const d = makeDeps({ pr, git: gitWithRemote(true, []) });
    await runPrGate(dir, sliceState(), sliceState().phases[0], d, "feature/wf-1", d.now());
    expect(pushed).not.toContain("feature/wf");
    expect(pushed).toContain("feature/wf-1"); // 조각 브랜치는 여전히 올린다
  });

  it("조각 분해가 꺼져 있으면 base 를 올리지 않는다 (base_branch 는 원래 원격에 있다)", async () => {
    const s = sliceState();
    s.review_split = { enabled: false, budget_lines: 400 };
    const calls: string[] = [];
    const { pr, pushed } = capture();
    const d = makeDeps({ pr, git: gitWithRemote(false, calls) });
    await runPrGate(dir, s, s.phases[0], d, "feature/wf-1", d.now());
    expect(pushed).toEqual(["fw/phase-1"]);
    expect(calls.some(c => c.startsWith("ls-remote"))).toBe(false);
  });
});

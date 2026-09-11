import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runWorkflow } from "../src/orchestrator.js";
import { runGate } from "../src/gate.js";
import { StateSchema, saveState, loadState } from "../src/state.js";
import type { SessionRunner } from "../src/session.js";
import type { PrClient, PrView, RawComment } from "../src/pr.js";

describe("e2e PR 루프: 생성 → 코멘트 반영 → approve 정지 → 재개 → merged", () => {
  it("실제 게이트와 파일시스템으로 전체 흐름이 동작한다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-e2e-pr-"));
    fs.writeFileSync(path.join(dir, "HANDOFF.md"), "initial");
    saveState(dir, StateSchema.parse({
      schema_version: 1, workflow: "e2e-pr", repo_root: dir, branch_strategy: "topic",
      allow_push: true, pr_mode: true, poll_interval_ms: 1,
      trusted_comment_authors: ["alice"],
      // §26 I5 잔여 승격 이후: 실제 게이트(runGate)로 실행되고 assertRunnable 린트도 통과해야
      // 한다 — "true" 는 이제 error 로 거부된다. "git --version" 은 lint 통과 + 이 tmpdir(git
      // 저장소 아님)에서도 그대로 성공한다.
      verify_default: ["git --version"], status: "running",
      pending_question: null, answers: [],
      phases: [{ id: 1, title: "p1", status: "pending", depends_on: [], verify: [], attempts: 0, max_attempts: 2, sessions: [] }],
    }));

    const comment: RawComment = { id: 11, body: "@fw 로깅 낮춰주세요", author: "alice", isBot: false, createdAt: "t", kind: "issue" };
    const OPEN: PrView = { state: "OPEN", reviewDecision: null, merged: false };
    const APPROVED: PrView = { state: "OPEN", reviewDecision: "APPROVED", merged: false };
    const MERGED: PrView = { state: "MERGED", reviewDecision: "APPROVED", merged: true };

    let viewIdx = 0;
    const views = [OPEN, APPROVED, MERGED];
    const commentQueue: RawComment[][] = [[comment], [], []];
    let cIdx = 0;
    const replies: string[] = [];
    const pushed: string[] = [];
    const pr: PrClient = {
      async pushBranch(o) { pushed.push(o.branch); },
      async createPr() { return { number: 7, url: "https://ex/pull/7" }; },
      async listComments() { return commentQueue[Math.min(cIdx++, commentQueue.length - 1)]; },
      async viewPr() { return views[Math.min(viewIdx++, views.length - 1)]; },
      async postReviewComments() {},
      async postPrComment(o) { replies.push(o.body); },
    };

    let fixCalls = 0;
    const runner: SessionRunner = {
      async runPhase() {
        fs.writeFileSync(path.join(dir, "HANDOFF.md"), `updated ${Date.now()}`);
        return { status: "done", summary: "phase ok", commits: ["sha1"], sessionId: "s1" };
      },
      async runFixSession() {
        fixCalls++;
        return { status: "done", summary: "로깅을 debug 로 낮춤", commits: ["sha2"], addressed: [{ item: "로그 레벨을 debug 로", status: "applied" as const, evidence: "sha2" }] };
      },
      async runVerifyAgent() { return { status: "done", summary: "# 검증 보고\n이상 없음", commits: [] }; },
    };
    const deps = {
      runner, gate: runGate, pr, notify: () => {},
      now: () => new Date().toISOString(), log: () => {}, sleep: async () => {}, nonce: () => "testnonce",
      // 이 tmpdir 은 실제 git 저장소가 아니므로, 가짜 SHA("sha1" 등)를 실재로 취급하도록 스텁
      verifyCommit: async () => ({ ok: true }),
      // §19: 프리플라이트가 실제 git/gh CLI 를 쓰면 이 tmpdir 은 저장소가 아니라서 FAILED 로
      // 정지하고, pr_mode 라 실제 `gh auth status` 네트워크 호출까지 타므로 느려진다.
      git: async () => ({ ok: true, stdout: "", stderr: "" }),
      gh: async () => ({ ok: true, stdout: "", stderr: "" }),
      // §26 C2: 커밋의 작업 브랜치 도달성 검사도 기본은 실제 git 을 쓴다 — 이 tmpdir 은 실제
      // 저장소가 아니므로 스텁한다(브랜치 격리/도달성 자체를 다루는 건 orchestrator.test.ts 몫).
      branchReachable: async () => ({ ok: true }),
    };

    // 1차 주행: 코멘트 반영 후 approve 감지 → awaiting_merge 로 정지
    let s = await runWorkflow(dir, deps);
    expect(fixCalls).toBe(1);
    expect(replies.some(r => r.includes("로깅을 debug 로 낮춤"))).toBe(true);
    expect(s.status).toBe("awaiting_merge");
    // §26 I3: 게이트 통과 후 fix 커밋도 push 해야 리뷰어가 실제 변경을 본다 — 최초 PR 생성 전
    // 1회 + fix 세션 성공(게이트 재실행 통과) 후 1회, 총 2회.
    expect(pushed).toEqual(["fw/phase-1", "fw/phase-1"]);
    expect(loadState(dir).phases[0].pr?.number).toBe(7);
    expect(loadState(dir).phases[0].pr?.handled_comment_keys).toContain("issue:11");

    // 2차 주행(사람이 머지한 뒤 재실행): PR 재생성 없이 merged 감지 → 완주
    s = await runWorkflow(dir, deps);
    expect(s.status).toBe("done");
    expect(s.phases[0].status).toBe("done");
    expect(fs.existsSync(path.join(dir, "VERIFY.md"))).toBe(true);
  });
});

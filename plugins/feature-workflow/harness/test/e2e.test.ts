import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runWorkflow } from "../src/orchestrator.js";
import { runGate } from "../src/gate.js";
import { StateSchema, saveState, loadState, answerQuestion } from "../src/state.js";
import type { SessionRunner } from "../src/session.js";

describe("e2e: blocked → answer → 재개 → 완주", () => {
  it("실제 게이트(runGate)와 파일시스템으로 전체 흐름이 동작한다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-e2e-"));
    fs.writeFileSync(path.join(dir, "HANDOFF.md"), "initial");
    saveState(dir, StateSchema.parse({
      schema_version: 1, workflow: "e2e", repo_root: dir, branch_strategy: "topic",
      // §26 I5 잔여 승격 이후: verify_default/verify 는 실제 게이트(runGate)로 실행되고
      // assertRunnable 린트도 통과해야 한다 — "true"/"echo ..." 는 둘 다 이제 error 로 거부된다.
      // "git --version"/"git rev-parse HEAD" 는 lint 를 통과하면서 이 tmpdir(git 저장소 아님)에서도
      // 그대로 성공하는 명령이다.
      allow_push: false, verify_default: ["git --version"], status: "running",
      pending_question: null, answers: [],
      phases: [
        { id: 1, title: "p1", status: "pending", depends_on: [], verify: [], attempts: 0, max_attempts: 2, sessions: [] },
        { id: 2, title: "p2", status: "pending", depends_on: [1], verify: ["git --version"], attempts: 0, max_attempts: 2, sessions: [] },
      ],
    }));

    let call = 0;
    const runner: SessionRunner = {
      async runPhase(req) {
        call++;
        if (call === 1) {
          // phase 1 첫 세션: 질문 발생
          return { status: "blocked", summary: "결정 필요", question: "A안 B안?", commits: [] };
        }
        // 이후 세션: 답변이 주입됐는지 확인하고 정상 완료
        if (call === 2) expect(req.answers[0]?.answer).toBe("B안으로");
        fs.writeFileSync(path.join(dir, "HANDOFF.md"), `updated by call ${call}`);
        return { status: "done", summary: "ok", commits: [`sha${call}`], sessionId: `s${call}` };
      },
      async runVerifyAgent() { return { status: "done", summary: "# 검증 보고\n이상 없음", commits: [] }; },
      async runFixSession() { return { status: "done", summary: "stub", commits: [] }; },
    };
    const deps = {
      runner, gate: runGate, notify: () => {}, now: () => new Date().toISOString(), log: () => {},
      // 이 tmpdir 은 실제 git 저장소가 아니므로, 가짜 SHA("sha1" 등)를 실재로 취급하도록 스텁
      verifyCommit: async () => ({ ok: true }),
      // §19: 프리플라이트가 실제 git CLI 를 쓰면 이 tmpdir 은 저장소가 아니라서 FAILED 로
      // 정지한다 — "깨끗한 저장소, base_branch 와 다른 브랜치"를 흉내낸다.
      git: async () => ({ ok: true, stdout: "", stderr: "" }),
      // §26 C2: 커밋의 작업 브랜치 도달성 검사도 기본은 실제 git 을 쓴다 — 이 tmpdir 은 실제
      // 저장소가 아니므로 스텁한다(브랜치 격리/도달성 자체를 다루는 건 orchestrator.test.ts 몫).
      branchReachable: async () => ({ ok: true }),
    };

    // 1차 주행: blocked 로 정지
    let s = await runWorkflow(dir, deps);
    expect(s.status).toBe("blocked");

    // 사용자 답변 (fw answer 에 해당)
    const st = loadState(dir);
    answerQuestion(st, "B안으로", new Date().toISOString());
    saveState(dir, st);

    // 2차 주행: 완주
    s = await runWorkflow(dir, deps);
    expect(s.status).toBe("done");
    expect(s.phases.every(p => p.status === "done")).toBe(true);
    // 검증 로그와 VERIFY 보고서가 남았다
    expect(fs.existsSync(path.join(dir, "VERIFY.md"))).toBe(true);
    expect(fs.readdirSync(path.join(dir, "logs")).length).toBeGreaterThan(0);
  });
});

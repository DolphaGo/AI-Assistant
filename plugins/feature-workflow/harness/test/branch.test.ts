// branch.ts 전용 테스트 (docs/harness-module-tests §31 m11 부채 해소).
//
// orchestrator.test.ts 는 runWorkflow 를 통과시키는 통합 테스트라 이 모듈의 분기를 "간접 커버"만
// 한다 — 계약이 못박히지 않는다(PLAN D1: orchestrator.test.ts 는 손대지 않는다, 이 파일은 추가만).
// 여기서는 branch.ts 의 exported 함수를 직접 호출해 각 분기를 못박는다. 스텁 git 으로 충분한
// 함수(applyBranchStrategy/checkBranchDrift/verifySessionCommits)는 스텁을 쓰고, 실제 git 을
// 호출하는 함수(defaultVerifyCommit/defaultBranchReachable/defaultChangedFiles/
// refreshIsolationBranchAfterMerge)는 실제 git 리포 픽스처로 검증한다(PLAN D4 — 스텁 전용 금지).
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  applyBranchStrategy,
  checkBranchDrift,
  verifySessionCommits,
  defaultVerifyCommit,
  defaultBranchReachable,
  defaultChangedFiles,
  refreshIsolationBranchAfterMerge,
  describeGuardedFileState,
  formatGuardedFileLines,
  verifyAlreadyAppliedCommits,
  createSliceBranch,
  advanceIntegrationBranchAfterMerge,
  defaultAlreadyAppliedCommit,
  type GitExecResult,
} from "../src/branch.js";
import { StateSchema, type State } from "../src/state.js";
import type { OrchestratorDeps, CommitCheck } from "../src/orchestrator-types.js";
import type { CliExecResult } from "../src/preflight.js";

function makeState(overrides: Partial<State> = {}): State {
  return StateSchema.parse({
    schema_version: 1,
    workflow: "wf",
    repo_root: "/tmp/does-not-matter",
    branch_strategy: "isolate",
    base_branch: "main",
    allow_push: false,
    verify_default: ["git --version"],
    status: "running",
    pending_question: null,
    answers: [],
    phases: [
      { id: 1, title: "p1", status: "pending", depends_on: [], verify: [], attempts: 0, max_attempts: 2, sessions: [] },
      { id: 2, title: "p2", status: "pending", depends_on: [1], verify: [], attempts: 0, max_attempts: 2, sessions: [] },
    ],
    ...overrides,
  });
}

// git 실행기 스텁 — 호출된 args 를 기록해두고, 매처가 매칭되는 첫 응답을 반환한다.
function stubGit(
  handlers: Array<{ match: (args: string[]) => boolean; result: CliExecResult }>,
  calls: string[][] = [],
): (args: string[], cwd: string) => Promise<CliExecResult> {
  return async (args: string[]) => {
    calls.push(args);
    const h = handlers.find(h => h.match(args));
    if (h) return h.result;
    return { ok: true, stdout: "", stderr: "" };
  };
}

const ok = (stdout = ""): CliExecResult => ({ ok: true, stdout, stderr: "" });
const fail = (stderr = "boom"): CliExecResult => ({ ok: false, stdout: "", stderr });

describe("applyBranchStrategy", () => {
  const noopDeps = () => ({ log: (_m: string) => {} });

  it("git 저장소가 아님(currentBranch=null, detached=false) 이면 방어적으로 통과시킨다", async () => {
    const calls: string[][] = [];
    const git = stubGit([], calls);
    const r = await applyBranchStrategy(makeState(), { currentBranch: null, detached: false }, { git, ...noopDeps() });
    expect(r).toEqual({ ok: true, workBranch: null });
    expect(calls).toHaveLength(0); // git 을 아예 호출하지 않는다
  });

  describe("isolate", () => {
    it("base_branch 위에 있으면 feature/<workflow> 를 새로 만들어 체크아웃한다 (없으면 -b)", async () => {
      const calls: string[][] = [];
      const git = stubGit(
        [
          { match: a => a[0] === "show-ref", result: fail() }, // 존재하지 않음
          { match: a => a[0] === "checkout", result: ok() },
        ],
        calls,
      );
      const r = await applyBranchStrategy(
        makeState({ branch_strategy: "isolate", base_branch: "main" }),
        { currentBranch: "main", detached: false },
        { git, ...noopDeps() },
      );
      expect(r).toEqual({ ok: true, workBranch: "feature/wf" });
      expect(calls).toContainEqual(["checkout", "-b", "feature/wf"]);
    });

    it("격리 브랜치가 이미 있으면 -b 없이 체크아웃만 한다", async () => {
      const calls: string[][] = [];
      const git = stubGit(
        [
          { match: a => a[0] === "show-ref", result: ok() }, // 이미 존재
          { match: a => a[0] === "checkout", result: ok() },
        ],
        calls,
      );
      const r = await applyBranchStrategy(
        makeState({ branch_strategy: "isolate", base_branch: "main" }),
        { currentBranch: "main", detached: false },
        { git, ...noopDeps() },
      );
      expect(r).toEqual({ ok: true, workBranch: "feature/wf" });
      expect(calls).toContainEqual(["checkout", "feature/wf"]);
      expect(calls).not.toContainEqual(["checkout", "-b", "feature/wf"]);
    });

    it("detached HEAD 면 격리 브랜치를 만들어 체크아웃한다", async () => {
      const git = stubGit([
        { match: a => a[0] === "show-ref", result: fail() },
        { match: a => a[0] === "checkout", result: ok() },
      ]);
      const r = await applyBranchStrategy(
        makeState({ branch_strategy: "isolate" }),
        { currentBranch: null, detached: true },
        { git, ...noopDeps() },
      );
      expect(r).toEqual({ ok: true, workBranch: "feature/wf" });
    });

    it("이미 base_branch 가 아닌 브랜치 위에 있으면 그 브랜치를 그대로 쓰고 체크아웃을 시도하지 않는다", async () => {
      const calls: string[][] = [];
      const git = stubGit([], calls);
      const r = await applyBranchStrategy(
        makeState({ branch_strategy: "isolate", base_branch: "main" }),
        { currentBranch: "already-topic", detached: false },
        { git, ...noopDeps() },
      );
      expect(r).toEqual({ ok: true, workBranch: "already-topic" });
      expect(calls).toHaveLength(0);
    });

    it("체크아웃이 실패하면 ok:false 로 사유를 담아 반환한다", async () => {
      const git = stubGit([
        { match: a => a[0] === "show-ref", result: fail() },
        { match: a => a[0] === "checkout", result: fail("fatal: 디스크 가득") },
      ]);
      const r = await applyBranchStrategy(
        makeState({ branch_strategy: "isolate", base_branch: "main" }),
        { currentBranch: "main", detached: false },
        { git, ...noopDeps() },
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.problem).toContain("feature/wf");
        expect(r.problem).toContain("디스크 가득");
      }
    });
  });

  describe("current", () => {
    it("토픽 브랜치 위에 있으면 workBranch:null 을 반환하고 경고를 남기지 않는다 (이탈 감시 제외)", async () => {
      const logs: string[] = [];
      const r = await applyBranchStrategy(
        makeState({ branch_strategy: "current", base_branch: "main" }),
        { currentBranch: "my-topic", detached: false },
        { git: stubGit([]), log: m => logs.push(m) },
      );
      expect(r).toEqual({ ok: true, workBranch: null });
      expect(logs).toHaveLength(0);
    });

    it("base_branch 위에 있으면 workBranch:null 이되 경고 로그를 남긴다", async () => {
      const logs: string[] = [];
      const r = await applyBranchStrategy(
        makeState({ branch_strategy: "current", base_branch: "main" }),
        { currentBranch: "main", detached: false },
        { git: stubGit([]), log: m => logs.push(m) },
      );
      expect(r).toEqual({ ok: true, workBranch: null });
      expect(logs.some(l => l.includes("main"))).toBe(true);
    });

    it("detached HEAD 여도 강제하지 않고 workBranch:null 을 반환한다 (사용자 위임)", async () => {
      const r = await applyBranchStrategy(
        makeState({ branch_strategy: "current" }),
        { currentBranch: null, detached: true },
        { git: stubGit([]), ...noopDeps() },
      );
      expect(r).toEqual({ ok: true, workBranch: null });
    });
  });

  describe("require-topic", () => {
    it("detached HEAD 면 세션 없이 거부한다", async () => {
      const r = await applyBranchStrategy(
        makeState({ branch_strategy: "require-topic" }),
        { currentBranch: null, detached: true },
        { git: stubGit([]), ...noopDeps() },
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.problem).toContain("detached");
    });

    it("base_branch 위에 있으면 거부한다", async () => {
      const r = await applyBranchStrategy(
        makeState({ branch_strategy: "require-topic", base_branch: "main" }),
        { currentBranch: "main", detached: false },
        { git: stubGit([]), ...noopDeps() },
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.problem).toContain("main");
    });

    it("토픽 브랜치 위에 있으면 그 브랜치를 workBranch 로 통과시킨다", async () => {
      const r = await applyBranchStrategy(
        makeState({ branch_strategy: "require-topic", base_branch: "main" }),
        { currentBranch: "my-topic", detached: false },
        { git: stubGit([]), ...noopDeps() },
      );
      expect(r).toEqual({ ok: true, workBranch: "my-topic" });
    });
  });
});

describe("applyBranchStrategy — branchRefExists 는 refs/heads/ 네임스페이스만 본다 (§26 I4 회귀, §36 I-6)", () => {
  // 스텁 git 으로는 "브랜치 판정에 refs/heads/ 한정을 쓰는가" 자체를 증명할 수 없다 — 스텁은 그
  // 판정 로직 자신을 대신 흉내낼 뿐이라, `rev-parse --verify` 로 퇴행해도 스텁 호출부만 맞으면
  // 통과해버린다(§29 교훈: 스텁 전용 금지, PLAN D4). 실제 git 리포에 동명 태그를 만들어 재현한다.
  // §26 I4 실측: `git rev-parse --verify --quiet feature/wf1` 는 태그를 브랜치로 오판해
  // `git checkout feature/wf1`(브랜치 아님, -b 없음)이 detached HEAD 로 이어진다.
  function realGit(cwd: string) {
    return (args: string[], gitCwd: string): Promise<CliExecResult> =>
      new Promise(resolve => {
        try {
          const stdout = execFileSync("git", args, { cwd: gitCwd ?? cwd }).toString();
          resolve({ ok: true, stdout, stderr: "" });
        } catch (err) {
          const e = err as { stdout?: Buffer; stderr?: Buffer; message: string };
          resolve({ ok: false, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? e.message });
        }
      });
  }

  it("브랜치는 없고 동명 태그만 있으면 태그를 브랜치로 오판하지 않고 새 브랜치를 만들어 체크아웃한다 (detached 로 빠지지 않는다)", async () => {
    const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-branch-tagclash-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: gitDir });
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: gitDir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: gitDir });
    fs.writeFileSync(path.join(gitDir, "a.txt"), "1");
    execFileSync("git", ["add", "."], { cwd: gitDir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: gitDir });

    // §26 I4 실측 그대로 재현: "feature/wf1" 이름의 태그만 있고 동명 브랜치는 없다.
    execFileSync("git", ["tag", "feature/wf1"], { cwd: gitDir });

    const state = makeState({ workflow: "wf1", branch_strategy: "isolate", base_branch: "main", repo_root: gitDir });
    const logs: string[] = [];
    const r = await applyBranchStrategy(
      state,
      { currentBranch: "main", detached: false },
      { git: realGit(gitDir), log: (m: string) => logs.push(m) },
    );

    expect(r).toEqual({ ok: true, workBranch: "feature/wf1" });

    // 핵심 단언: HEAD 가 브랜치를 가리켜야 한다(symbolic-ref 성공) — 태그를 체크아웃했다면(브랜치
    // 오판) detached HEAD 가 되어 symbolic-ref 자체가 실패(exit != 0)한다.
    const symbolicRef = spawnSync("git", ["symbolic-ref", "-q", "HEAD"], { cwd: gitDir, encoding: "utf8" });
    expect(symbolicRef.status).toBe(0);
    expect(symbolicRef.stdout.trim()).toBe("refs/heads/feature/wf1");

    // "새로 만들어 체크아웃"했다는 로그 — 브랜치가 아직 없다고 올바르게 판단했다는 방증(이미
    // 있다고 오판했다면 -b 없는 checkout 로그가 남아야 한다).
    expect(logs.some(l => l.includes("새로 만들어 체크아웃"))).toBe(true);
  });
});

describe("checkBranchDrift", () => {
  it("workBranch 가 null 이면(branch_strategy=current) 감시하지 않고 항상 통과한다", async () => {
    const calls: string[][] = [];
    const git = stubGit([], calls);
    const r = await checkBranchDrift("/repo", null, git);
    expect(r).toEqual({ ok: true });
    expect(calls).toHaveLength(0); // git 을 아예 부르지 않는다
  });

  it("실제 브랜치가 workBranch 와 같으면 통과한다", async () => {
    const git = stubGit([{ match: () => true, result: ok("feature/wf\n") }]);
    const r = await checkBranchDrift("/repo", "feature/wf", git);
    expect(r).toEqual({ ok: true });
  });

  it("이탈했으면(다른 브랜치) 이탈 사실과 복귀 명령을 담아 거부한다", async () => {
    const git = stubGit([{ match: () => true, result: ok("main\n") }]);
    const r = await checkBranchDrift("/repo", "feature/wf", git);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problem).toContain("feature/wf");
      expect(r.problem).toContain("main");
      expect(r.problem).toContain("git checkout feature/wf");
    }
  });

  it("현재 브랜치를 확인할 수 없으면(git 실패) '확인 불가'로 이탈 처리한다", async () => {
    const git = stubGit([{ match: () => true, result: fail() }]);
    const r = await checkBranchDrift("/repo", "feature/wf", git);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toContain("확인 불가");
  });
});

describe("verifySessionCommits", () => {
  function depsWith(overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
    return {
      runner: undefined as never,
      gate: undefined as never,
      notify: () => {},
      now: () => "t",
      log: () => {},
      ...overrides,
    };
  }

  it("커밋이 0건이면 verifyCommit 을 호출하지 않고 즉시 거부한다", async () => {
    let called = false;
    const d = depsWith({ verifyCommit: async () => { called = true; return { ok: true }; } });
    const r = await verifySessionCommits("/repo", "feature/wf", "head0", [], d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toContain("커밋이 없습니다");
    expect(called).toBe(false);
  });

  it("존재하지 않는(stale) SHA 는 verifyCommit 사유를 그대로 담아 거부한다", async () => {
    const d = depsWith({
      verifyCommit: async (): Promise<CommitCheck> => ({ ok: false, reason: "존재하지 않는 커밋입니다" }),
      branchReachable: async () => ({ ok: true }),
    });
    const r = await verifySessionCommits("/repo", "feature/wf", "head0", ["deadbeef"], d);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problem).toContain("deadbeef");
      expect(r.problem).toContain("존재하지 않는 커밋입니다");
    }
  });

  it("존재/신규성은 통과하지만 작업 브랜치에서 도달 불가하면 거부한다 (branchReachable 분기)", async () => {
    let reachableCalledWith: [string, string] | null = null;
    const d = depsWith({
      verifyCommit: async () => ({ ok: true }),
      branchReachable: async (_cwd: string, sha: string, branch: string) => {
        reachableCalledWith = [sha, branch];
        return { ok: false, reason: "도달 가능하지 않습니다" };
      },
    });
    const r = await verifySessionCommits("/repo", "feature/wf", "head0", ["newsha"], d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toContain("도달 가능하지 않습니다");
    expect(reachableCalledWith).toEqual(["newsha", "feature/wf"]);
  });

  it("workBranch 가 null 이면 branchReachable 을 호출하지 않는다 (current 전략은 감시 제외)", async () => {
    let called = false;
    const d = depsWith({
      verifyCommit: async () => ({ ok: true }),
      branchReachable: async () => { called = true; return { ok: true }; },
    });
    const r = await verifySessionCommits("/repo", null, "head0", ["newsha"], d);
    expect(r).toEqual({ ok: true });
    expect(called).toBe(false);
  });

  it("여러 커밋 중 일부만 실패하면 실패한 것만 상세 사유에 포함한다", async () => {
    const d = depsWith({
      verifyCommit: async (_cwd: string, sha: string) => (sha === "bad" ? { ok: false, reason: "무관한 커밋" } : { ok: true }),
      branchReachable: async () => ({ ok: true }),
    });
    const r = await verifySessionCommits("/repo", "feature/wf", "head0", ["good", "bad"], d);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problem).toContain("bad");
      expect(r.problem).toContain("무관한 커밋");
      expect(r.problem).not.toContain("good:");
    }
  });

  it("모두 통과하면 ok:true", async () => {
    const d = depsWith({ verifyCommit: async () => ({ ok: true }), branchReachable: async () => ({ ok: true }) });
    const r = await verifySessionCommits("/repo", "feature/wf", "head0", ["c1", "c2"], d);
    expect(r).toEqual({ ok: true });
  });

  it("deps 에 verifyCommit/branchReachable 이 없으면 실제 defaultVerifyCommit/defaultBranchReachable 로 폴백한다", async () => {
    // 스텁을 아예 주지 않고 실제 git 리포로 검증 — PLAN D4: 폴백 계약 자체가 이 함수의 핵심 분기다.
    const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-branch-vsc-"));
    execFileSync("git", ["init", "-q"], { cwd: gitDir });
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: gitDir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: gitDir });
    fs.writeFileSync(path.join(gitDir, "a.txt"), "1");
    execFileSync("git", ["add", "."], { cwd: gitDir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: gitDir });
    const head0 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: gitDir }).toString().trim();
    execFileSync("git", ["checkout", "-q", "-b", "topic"], { cwd: gitDir });
    fs.writeFileSync(path.join(gitDir, "b.txt"), "2");
    execFileSync("git", ["add", "."], { cwd: gitDir });
    execFileSync("git", ["commit", "-q", "-m", "second"], { cwd: gitDir });
    const head1 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: gitDir }).toString().trim();

    const d = depsWith({}); // verifyCommit/branchReachable 미지정 — 폴백 경로
    const r = await verifySessionCommits(gitDir, "topic", head0, [head1], d);
    expect(r).toEqual({ ok: true });

    // 존재하지 않는 브랜치를 workBranch 로 주면 defaultBranchReachable 폴백이 거부해야 한다
    const rBad = await verifySessionCommits(gitDir, "other-branch-not-exist", head0, [head1], d);
    expect(rBad.ok).toBe(false);
  });
});

describe("defaultVerifyCommit / defaultBranchReachable / defaultChangedFiles — 실제 git 리포 (PLAN D4)", () => {
  let gitDir: string;
  let head0: string;

  beforeEach(() => {
    gitDir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-branch-git-"));
    execFileSync("git", ["init", "-q"], { cwd: gitDir });
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: gitDir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: gitDir });
    fs.writeFileSync(path.join(gitDir, "a.txt"), "1");
    execFileSync("git", ["add", "."], { cwd: gitDir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: gitDir });
    head0 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: gitDir }).toString().trim();
  });

  describe("defaultBranchReachable", () => {
    it("sha 가 해당 브랜치에서 도달 가능하면 통과한다", async () => {
      execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd: gitDir });
      fs.writeFileSync(path.join(gitDir, "b.txt"), "2");
      execFileSync("git", ["add", "."], { cwd: gitDir });
      execFileSync("git", ["commit", "-q", "-m", "on feature"], { cwd: gitDir });
      const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: gitDir }).toString().trim();
      expect(await defaultBranchReachable(gitDir, sha, "feature")).toEqual({ ok: true });
    });

    it("sha 가 다른 브랜치에서만 만들어졌으면(도달 불가) 거부한다", async () => {
      // main 에서 갈라진 두 개의 독립 브랜치: other 에서 커밋을 만들고, feature 는 그 커밋을 모른다.
      execFileSync("git", ["checkout", "-q", "-b", "other"], { cwd: gitDir });
      fs.writeFileSync(path.join(gitDir, "other.txt"), "x");
      execFileSync("git", ["add", "."], { cwd: gitDir });
      execFileSync("git", ["commit", "-q", "-m", "on other"], { cwd: gitDir });
      const otherSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: gitDir }).toString().trim();
      execFileSync("git", ["checkout", "-q", "-b", "feature", head0], { cwd: gitDir });
      const r = await defaultBranchReachable(gitDir, otherSha, "feature");
      expect(r.ok).toBe(false);
      expect(r.reason).toContain("도달 가능하지 않습니다");
    });

    it("git 저장소가 아니면 '커밋 없음'과 다른 사유(git 오류)로 실패한다", async () => {
      const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-branch-notgit-"));
      const r = await defaultBranchReachable(nonGitDir, head0, "main");
      expect(r.ok).toBe(false);
      expect(r.reason).toContain("git 오류");
    });
  });

  describe("defaultVerifyCommit", () => {
    it("git 실행 파일이 없으면(ENOENT) exist 단계에서 spawnErrorCode 사유로 실패한다", async () => {
      // PATH 를 git 이 없는 디렉토리 하나로 좁혀 execFile('git', ...) 자체가 스폰에 실패(ENOENT)하게
      // 만든다 — "커밋 없음"과 "git 을 실행조차 못함"을 구분하는 분기(§25 GitExecResult.spawnErrorCode)를
      // 못박는다. 빈 문자열("") 대신 실재하지 않는 디렉토리를 쓰는 이유: PATH="" 의 조회 동작은
      // POSIX 상 구현별로 갈릴 수 있어(예: 현재 디렉토리로 취급) 이식성이 떨어진다.
      const originalPath = process.env.PATH;
      process.env.PATH = "/nonexistent-dir-for-fw-branch-test-path-override";
      try {
        const r = await defaultVerifyCommit(gitDir, head0, null);
        expect(r.ok).toBe(false);
        expect(r.reason).toContain("git 실행 실패");
      } finally {
        process.env.PATH = originalPath;
      }
    });
  });

  describe("defaultChangedFiles", () => {
    it("git 저장소가 아니면 throw 한다 (빈 배열로 조용히 넘기지 않는다)", async () => {
      const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-branch-notgit-cf-"));
      await expect(defaultChangedFiles(nonGitDir, head0)).rejects.toThrow(/git diff 오류/);
    });

    // §z-parse Phase 2(D8): -z 전환 + trim 제거. 선행/후행 개행 파일명은 trim 이 남아 있으면
    // 경계 개행이 조용히 잘려나가는(그 결과 이후 tamper 비교가 어긋나는) 핵심 회귀 케이스라
    // toContain(정확한 문자열 일치)로 직접 판별한다. 따옴표·비ASCII 는 quotePath 8진 이스케이프가
    // -z 에는 적용되지 않는다는 것(Phase 0 실측)을 함께 확인한다.
    it("[NUL-z] 선행·후행 개행·따옴표·비ASCII 파일명이 trim 없이 원문 그대로 반환된다 (D8)", async () => {
      execFileSync("git", ["checkout", "-q", "-b", "topic"], { cwd: gitDir });
      const leadingNewline = "\nleading.txt";
      const trailingNewline = "trailing.txt\n";
      const withQuote = 'file"with"quote.txt';
      const withUnicode = "한글파일.txt";
      fs.writeFileSync(path.join(gitDir, leadingNewline), "1");
      fs.writeFileSync(path.join(gitDir, trailingNewline), "1");
      fs.writeFileSync(path.join(gitDir, withQuote), "1");
      fs.writeFileSync(path.join(gitDir, withUnicode), "1");
      execFileSync("git", ["add", "-A"], { cwd: gitDir });
      execFileSync("git", ["commit", "-q", "-m", "add weird files"], { cwd: gitDir });

      const result = await defaultChangedFiles(gitDir, head0);
      if (!result.ok) throw new Error("expected ok:true");
      expect(result.files).toContain(leadingNewline);
      expect(result.files).toContain(trailingNewline);
      expect(result.files).toContain(withQuote);
      expect(result.files).toContain(withUnicode);
    });

    // §tamper-gap P1/P3/D5/E20: --no-renames 채택으로 rename(git mv) 된 guarded 파일의 OLD 경로가
    // D(삭제) 세그먼트로, NEW 경로가 A(추가) 세그먼트로 각각 노출되어야 한다 — 이게 이번 사이클의
    // 핵심 해소 대상(P1 미탐)이다. E20: 모킹이 아니라 실제 임시 git 저장소 + 실제 `git mv` 로
    // 검증해야 한다(모킹 예외는 E2 의 "macOS 가 비-UTF8 파일명 생성을 거부한다"는 물리적 불가능에만
    // 적용되고, rename 은 모든 플랫폼에서 실재현 가능하므로 그 사유가 없다).
    it("[NUL-z] rename(git mv) 된 파일의 OLD 경로와 NEW 경로가 모두 changed 에 포함된다 (P1 해소, E20)", async () => {
      execFileSync("git", ["checkout", "-q", "-b", "rename-topic"], { cwd: gitDir });
      const oldName = "old-guarded.sh";
      const newName = "new-guarded.sh";
      fs.writeFileSync(path.join(gitDir, oldName), "1");
      execFileSync("git", ["add", "-A"], { cwd: gitDir });
      execFileSync("git", ["commit", "-q", "-m", "add rename source"], { cwd: gitDir });
      const headBeforeRename = execFileSync("git", ["rev-parse", "HEAD"], { cwd: gitDir }).toString().trim();
      execFileSync("git", ["mv", oldName, newName], { cwd: gitDir });
      execFileSync("git", ["commit", "-q", "-m", "rename guarded file"], { cwd: gitDir });

      const result = await defaultChangedFiles(gitDir, headBeforeRename);
      if (!result.ok) throw new Error("expected ok:true");
      expect(result.files).toContain(oldName);
      expect(result.files).toContain(newName);
    });

    // §tamper-gap E7(실측, NOTES.md 기록 필수): 로컬 `diff.renames=copies` 설정을 강제로 켠
    // 상태에서도 명령행의 `--no-renames` 가 우선해 rename/copy 를 D+A(변경없음)로 분해하는지
    // 확인한다 — 이 전제가 무너지면 "rename/copy record 필드 파싱 코드 자체가 도달 불가능해진다"
    // (D1 축소, E7 승인)는 판단이 무효가 된다. git 옵션 우선순위(명령행 플래그가 설정 파일보다
    // 우선)는 문서화된 git 동작이지만, 이 리포의 구현이 실제로 그 우선순위에 의존하므로 직접
    // 재현해 박아둔다.
    it("[NUL-z] diff.renames=copies 강제 설정 하에서도 --no-renames 가 우선해 rename 을 D+A 로 분해한다 (E7 실측)", async () => {
      execFileSync("git", ["config", "diff.renames", "copies"], { cwd: gitDir });
      execFileSync("git", ["checkout", "-q", "-b", "e7-renames-copies-topic"], { cwd: gitDir });
      const oldName = "e7-old.sh";
      const newName = "e7-new.sh";
      fs.writeFileSync(path.join(gitDir, oldName), "1");
      execFileSync("git", ["add", "-A"], { cwd: gitDir });
      execFileSync("git", ["commit", "-q", "-m", "add e7 rename source"], { cwd: gitDir });
      const headBeforeRename = execFileSync("git", ["rev-parse", "HEAD"], { cwd: gitDir }).toString().trim();
      execFileSync("git", ["mv", oldName, newName], { cwd: gitDir });
      execFileSync("git", ["commit", "-q", "-m", "e7 rename guarded file"], { cwd: gitDir });

      // 대조 실측: diff.renames=copies 가 실제로 rename 감지를 켜는 설정임을 먼저 확인한다 —
      // --no-renames 없이 plain `--name-status` 를 돌리면 R(rename) 레코드가 나와야 한다(이
      // 설정이 아무 효과가 없다면 이 실측 자체가 무의미해진다).
      const withRenamesDetection = execFileSync(
        "git", ["diff", "--name-status", `${headBeforeRename}..HEAD`], { cwd: gitDir },
      ).toString();
      expect(withRenamesDetection).toMatch(/^R\d*\s/m);

      // 핵심 실측: defaultChangedFiles(--no-renames 포함)는 같은 설정·같은 리포에서도 R 레코드를
      // 내지 않고 OLD/NEW 를 각각 별도 세그먼트(D+A)로 낸다.
      const result = await defaultChangedFiles(gitDir, headBeforeRename);
      if (!result.ok) throw new Error("expected ok:true");
      expect(result.files).toContain(oldName);
      expect(result.files).toContain(newName);
      const nameStatus = execFileSync(
        "git", ["diff", "--no-renames", "--name-status", `${headBeforeRename}..HEAD`], { cwd: gitDir },
      ).toString();
      expect(nameStatus).not.toMatch(/^R\d*\s/m);
      expect(nameStatus).not.toMatch(/^C\d*\s/m);
    });

    // §tamper-gap E10-①: --no-renames 플래그 추가가 rename 이 없는 diff(수정/추가/삭제만)의 반환
    // 내용에 영향을 주지 않는다는 형식 불변을 못박는다 — plain `git diff --name-only -z`(플래그
    // 추가 전과 동일한 커맨드)의 실측 결과와 defaultChangedFiles 의 결과가 정확히 같은 집합이어야
    // 한다.
    it("[NUL-z] rename 이 없는 diff(M/A/D만)에서 반환 내용이 --no-renames 적용 전과 동일하다 (E10-①, 형식 불변)", async () => {
      execFileSync("git", ["checkout", "-q", "-b", "no-rename-topic"], { cwd: gitDir });
      // 기준점 자체에도 삭제될 파일 하나를 포함시켜 M/A/D 세 종류를 모두 재현한다.
      fs.writeFileSync(path.join(gitDir, "to-delete.txt"), "will be removed");
      execFileSync("git", ["add", "-A"], { cwd: gitDir });
      execFileSync("git", ["commit", "-q", "-m", "baseline with a file to delete"], { cwd: gitDir });
      const baseline = execFileSync("git", ["rev-parse", "HEAD"], { cwd: gitDir }).toString().trim();

      fs.writeFileSync(path.join(gitDir, "added.txt"), "new");
      fs.writeFileSync(path.join(gitDir, "a.txt"), "modified content"); // beforeEach 가 만든 기존 파일 수정
      fs.rmSync(path.join(gitDir, "to-delete.txt"));
      execFileSync("git", ["add", "-A"], { cwd: gitDir });
      execFileSync("git", ["commit", "-q", "-m", "M/A/D only, no renames"], { cwd: gitDir });

      const result = await defaultChangedFiles(gitDir, baseline);
      if (!result.ok) throw new Error("expected ok:true");

      // "적용 전"(플래그 추가 전 코드 골격 — `git diff --name-only -z`, --no-renames 없음)을 같은
      // 리포에서 직접 재현해 비교한다. rename 이 없는 diff 이므로 두 커맨드는 항상 같은 집합을 내야
      // 한다(--no-renames 는 rename/copy 감지를 끄는 것일 뿐 M/A/D 판정에는 영향이 없다).
      const before = execFileSync("git", ["diff", "--name-only", "-z", `${baseline}..HEAD`], { cwd: gitDir })
        .toString().split("\0").filter(s => s.length > 0);
      expect(new Set(result.files)).toEqual(new Set(before));
      expect(result.files).toContain("added.txt");
      expect(result.files).toContain("a.txt");
      expect(result.files).toContain("to-delete.txt");
    });

    // §tamper-gap P1/P2/P5/E2/E8/E14: U+FFFD 감지는 defaultChangedFiles 자신이 ok:false 를 내는
    // 것까지 배선돼야 완료다(E8) — 순수 감지 함수만 분리해 테스트하면 배선 누락을 못 잡는다(E5 와
    // 같은 클래스의 갭). macOS(APFS) 가 잘못된 UTF-8 바이트 파일명 생성을 거부해 실파일로는 이
    // 케이스를 재현할 수 없으므로(E2), gitExec 주입 파라미터로 git 실행 자체를 모킹한다.
    it("U+FFFD 를 포함한 경로가 있으면 ok:false, reason:invalid_utf8 을 반환한다 (gitExec 주입, E2/E8/E14) [NUL-z]", async () => {
      const invalidPath = "broken-�-name.txt";
      const validPath = "fine.txt";
      const stdout = [validPath, invalidPath].join("\0") + "\0";
      const stubGitExec = async (_args: string[], _cwd: string): Promise<GitExecResult> => ({
        exitCode: 0, stdout, stderr: "", timedOut: false,
      });
      const result = await defaultChangedFiles(gitDir, head0, stubGitExec);
      expect(result).toEqual({ ok: false, reason: "invalid_utf8", paths: [invalidPath] });
    });

    it("gitExec 주입이 없으면 기본값(실제 execGit)으로 동작한다 — 기존 호출부(인자 2개)가 그대로 컴파일/동작한다", async () => {
      fs.writeFileSync(path.join(gitDir, "no-inject.txt"), "1");
      execFileSync("git", ["add", "-A"], { cwd: gitDir });
      execFileSync("git", ["commit", "-q", "-m", "no inject"], { cwd: gitDir });
      const result = await defaultChangedFiles(gitDir, head0); // 3번째 인자 생략
      if (!result.ok) throw new Error("expected ok:true");
      expect(result.files).toContain("no-inject.txt");
    });
  });

  // §tamper-gap D3(A)/E9: describeGuardedFileState 는 fs.existsSync 기반으로 modified/moved_or_deleted
  // 를 판별하는 순수 헬퍼다 — branch.test.ts 관례("branch.ts 의 exported 함수는 직접 호출해 각
  // 분기를 못박는다")를 따라 여기서 직접 호출해 두 분기를 못박는다. [NUL-z] 태그 없음(E12 — -z
  // 파싱/파일명 신뢰 경계와 무관한 fs 존재 분기).
  describe("describeGuardedFileState (D3(A)/E9)", () => {
    it("그 경로에 파일이 실제로 존재하면 'modified' 를 반환한다", () => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fw-branch-guardstate-"));
      fs.writeFileSync(path.join(cwd, "exists.txt"), "1");
      expect(describeGuardedFileState(cwd, "exists.txt")).toBe("modified");
    });

    it("그 경로에 파일이 존재하지 않으면 'moved_or_deleted' 를 반환한다", () => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fw-branch-guardstate-"));
      expect(describeGuardedFileState(cwd, "does-not-exist.txt")).toBe("moved_or_deleted");
    });

    it("formatGuardedFileLines 는 각 파일의 실제 상태에 맞는 라벨 + displayPath 를 한 줄씩 붙인다", () => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fw-branch-guardstate-"));
      fs.writeFileSync(path.join(cwd, "modified.txt"), "1");
      const lines = formatGuardedFileLines(cwd, ["modified.txt", "deleted.txt"]);
      expect(lines).toEqual([
        '수정됨: "modified.txt"',
        '이동/삭제됨(원래 경로로 복원): "deleted.txt"',
      ]);
    });
  });
});

describe("refreshIsolationBranchAfterMerge (§26 M5) — 실제 git 원격 픽스처 (PLAN D4)", () => {
  let remoteDir: string;
  let cloneDir: string;
  const isolationBranch = "feature/wf";

  function git(args: string[], cwd = cloneDir) {
    return execFileSync("git", args, { cwd }).toString().trim();
  }

  beforeEach(() => {
    // bare 원격 + 그 원격을 clone 한 작업 디렉토리로 실제 fetch/push 시나리오를 재현한다.
    remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-branch-remote-"));
    execFileSync("git", ["init", "-q", "--bare"], { cwd: remoteDir });
    // bare 리포 생성 직후 HEAD 심볼릭 레퍼런스는 로컬 git 의 기본 브랜치명(예: master)을 가리킨다.
    // 아래에서 seed 리포는 "main" 으로 push 하는데, push 만으로는 원격 HEAD 가 갱신되지 않는다 —
    // 그 상태로 clone 하면 "remote HEAD refers to nonexistent ref" 로 어떤 로컬 브랜치도 체크아웃되지
    // 않는 unborn HEAD 클론이 된다(실측: feature/wf 체크아웃 직후 rev-parse 가 ref 없음으로 실패, seedDir2
    // 클론은 엉뚱한 브랜치에 커밋해 `push origin main` 이 "src refspec main does not match any" 로
    // 실패). HEAD 를 미리 refs/heads/main 으로 맞춰 이 문제를 없앤다.
    execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: remoteDir });

    const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-branch-seed-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: seedDir });
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: seedDir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: seedDir });
    fs.writeFileSync(path.join(seedDir, "a.txt"), "1");
    execFileSync("git", ["add", "."], { cwd: seedDir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: seedDir });
    execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: seedDir });
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: seedDir });

    cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-branch-clone-"));
    execFileSync("git", ["clone", "-q", remoteDir, cloneDir]);
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: cloneDir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: cloneDir });
  });

  function defaultGit(cwd: string) {
    return (args: string[], gitCwd: string): Promise<CliExecResult> =>
      new Promise(resolve => {
        try {
          const stdout = execFileSync("git", args, { cwd: gitCwd ?? cwd }).toString();
          resolve({ ok: true, stdout, stderr: "" });
        } catch (err) {
          const e = err as { stdout?: Buffer; stderr?: Buffer; message: string };
          resolve({ ok: false, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? e.message });
        }
      });
  }

  it("조건 2: 다음 phase 가 없으면(마지막 phase) 갱신을 시도하지 않는다", async () => {
    const state = makeState({ repo_root: cloneDir, branch_strategy: "isolate", phases: [makeState().phases[0]] });
    const phase = { ...state.phases[0], status: "in_review" as const };
    const logs: string[] = [];
    const gitCalls: string[][] = [];
    const gitTrack = (args: string[], cwd: string) => { gitCalls.push(args); return defaultGit(cloneDir)(args, cwd); };
    await refreshIsolationBranchAfterMerge(state, phase, isolationBranch, "fw/phase-1", { git: gitTrack, log: (m: string) => logs.push(m) } as unknown as OrchestratorDeps);
    expect(gitCalls).toHaveLength(0);
  });

  it("사용자 소유 브랜치(branch_strategy != isolate 또는 workBranch != 격리 브랜치)는 절대 건드리지 않는다", async () => {
    const state = makeState({ repo_root: cloneDir, branch_strategy: "current", phases: [makeState().phases[0], makeState().phases[1]] });
    const phase = state.phases[0];
    const logs: string[] = [];
    const gitCalls: string[][] = [];
    const gitTrack = (args: string[], cwd: string) => { gitCalls.push(args); return defaultGit(cloneDir)(args, cwd); };
    await refreshIsolationBranchAfterMerge(state, phase, "user-owned-branch", "fw/phase-1", { git: gitTrack, log: (m: string) => logs.push(m) } as unknown as OrchestratorDeps);
    expect(gitCalls).toHaveLength(0);
    expect(logs.some(l => l.includes("사용자 소유 브랜치"))).toBe(true);
  });

  it("HEAD 가 격리 브랜치 위가 아니면(이탈) 재생성을 거부하고 로그만 남긴다", async () => {
    git(["checkout", "-q", "-b", isolationBranch]);
    git(["checkout", "-q", "-b", "somewhere-else"]); // 격리 브랜치를 벗어남
    const state = makeState({ repo_root: cloneDir, branch_strategy: "isolate", phases: [makeState().phases[0], makeState().phases[1]] });
    const phase = state.phases[0];
    const logs: string[] = [];
    const beforeSha = git(["rev-parse", isolationBranch]);
    await refreshIsolationBranchAfterMerge(
      state, phase, isolationBranch, "fw/phase-1",
      { git: defaultGit(cloneDir), log: (m: string) => logs.push(m) } as unknown as OrchestratorDeps,
    );
    const afterSha = git(["rev-parse", isolationBranch]);
    expect(afterSha).toBe(beforeSha); // 파괴 대상이 그대로 보존됨
    expect(logs.some(l => l.includes("갱신을 건너뜁니다"))).toBe(true);
  });

  it("fetch 실패(원격 접근 불가) 시 재생성 없이 퇴화한다", async () => {
    git(["checkout", "-q", "-b", isolationBranch]);
    execFileSync("git", ["remote", "set-url", "origin", "/nonexistent/remote/path"], { cwd: cloneDir });
    const state = makeState({ repo_root: cloneDir, branch_strategy: "isolate", phases: [makeState().phases[0], makeState().phases[1]] });
    const phase = state.phases[0];
    const logs: string[] = [];
    const beforeSha = git(["rev-parse", isolationBranch]);
    await refreshIsolationBranchAfterMerge(
      state, phase, isolationBranch, "fw/phase-1",
      { git: defaultGit(cloneDir), log: (m: string) => logs.push(m) } as unknown as OrchestratorDeps,
    );
    const afterSha = git(["rev-parse", isolationBranch]);
    expect(afterSha).toBe(beforeSha); // fetch 실패로 재생성이 일어나지 않음
    expect(logs.some(l => l.includes("fetch 실패"))).toBe(true);
  });

  it("정상 경로: 격리 브랜치 위에서 HEAD 가 일치하고 미push 커밋이 없으면 origin/base 위로 재생성한다", async () => {
    git(["checkout", "-q", "-b", isolationBranch]);
    // 원격의 main 이 앞서 나간 상태를 흉내낸다(다른 클라이언트가 이 phase 를 머지했다고 가정)
    const seedDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "fw-branch-seed2-"));
    execFileSync("git", ["clone", "-q", remoteDir, seedDir2]);
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: seedDir2 });
    execFileSync("git", ["config", "user.name", "t"], { cwd: seedDir2 });
    fs.writeFileSync(path.join(seedDir2, "merged.txt"), "1");
    execFileSync("git", ["add", "."], { cwd: seedDir2 });
    execFileSync("git", ["commit", "-q", "-m", "merged phase 1"], { cwd: seedDir2 });
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: seedDir2 });
    const newBaseSha = execFileSync("git", ["rev-parse", "main"], { cwd: seedDir2 }).toString().trim();

    const state = makeState({ repo_root: cloneDir, branch_strategy: "isolate", phases: [makeState().phases[0], makeState().phases[1]] });
    const phase = state.phases[0];
    const logs: string[] = [];
    await refreshIsolationBranchAfterMerge(
      state, phase, isolationBranch, "fw/phase-1",
      { git: defaultGit(cloneDir), log: (m: string) => logs.push(m) } as unknown as OrchestratorDeps,
    );
    const afterSha = git(["rev-parse", isolationBranch]);
    expect(afterSha).toBe(newBaseSha); // origin/main(갱신된 base) 위로 재생성됨
    expect(logs.some(l => l.includes("재생성했습니다"))).toBe(true);
  });

  it("§41 I-4 회귀: 재생성 후 격리 브랜치에 upstream(branch.<name>.merge/.remote)이 설정되지 않는다 (--no-track)", async () => {
    // 스텁으로는 이 결함이 안 잡힌다(감사자 실측) — `branch.autoSetupMerge`(기본 true)는 실제 git
    // 설정 파일에 기록되는 부작용이라 스텁 git 실행기를 통과시키는 것만으로는 재현되지 않는다.
    // 실제 git 리포에서 `checkout -B <name> origin/<base>` 뒤 git config 를 직접 읽어야 한다.
    git(["checkout", "-q", "-b", isolationBranch]);
    const seedDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "fw-branch-seed3-"));
    execFileSync("git", ["clone", "-q", remoteDir, seedDir2]);
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: seedDir2 });
    execFileSync("git", ["config", "user.name", "t"], { cwd: seedDir2 });
    fs.writeFileSync(path.join(seedDir2, "merged2.txt"), "1");
    execFileSync("git", ["add", "."], { cwd: seedDir2 });
    execFileSync("git", ["commit", "-q", "-m", "merged phase 1"], { cwd: seedDir2 });
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: seedDir2 });

    const state = makeState({ repo_root: cloneDir, branch_strategy: "isolate", phases: [makeState().phases[0], makeState().phases[1]] });
    const phase = state.phases[0];
    const logs: string[] = [];
    await refreshIsolationBranchAfterMerge(
      state, phase, isolationBranch, "fw/phase-1",
      { git: defaultGit(cloneDir), log: (m: string) => logs.push(m) } as unknown as OrchestratorDeps,
    );

    // 재생성이 실제로 일어났는지 먼저 확인(선행 조건) — 그렇지 않으면 아래 config 부재가 무의미하다.
    expect(logs.some(l => l.includes("재생성했습니다"))).toBe(true);

    // 핵심 단언: --no-track 없이 `checkout -B <name> origin/<base>` 를 실행하면
    // branch.autoSetupMerge 기본값이 이 값들을 자동으로 채운다(§41 I-4 실측). 둘 다 비어 있어야
    // feature/wf 위에서 친 `git push`/`git pull` 이 main 과 뒤섞이지 않는다.
    const mergeCfg = spawnSync("git", ["config", "--get", `branch.${isolationBranch}.merge`], { cwd: cloneDir, encoding: "utf8" });
    const remoteCfg = spawnSync("git", ["config", "--get", `branch.${isolationBranch}.remote`], { cwd: cloneDir, encoding: "utf8" });
    expect(mergeCfg.status).not.toBe(0);
    expect(mergeCfg.stdout.trim()).toBe("");
    expect(remoteCfg.status).not.toBe(0);
    expect(remoteCfg.stdout.trim()).toBe("");
  });

  it("격리 브랜치에 미push 커밋이 있으면(사람이 로컬에 커밋함) 재생성을 건너뛴다", async () => {
    git(["checkout", "-q", "-b", isolationBranch]);
    fs.writeFileSync(path.join(cloneDir, "local-only.txt"), "1");
    git(["add", "."]);
    git(["commit", "-q", "-m", "사람이 로컬에 남긴 커밋"]);
    const beforeSha = git(["rev-parse", isolationBranch]);

    const state = makeState({ repo_root: cloneDir, branch_strategy: "isolate", phases: [makeState().phases[0], makeState().phases[1]] });
    const phase = state.phases[0];
    const logs: string[] = [];
    await refreshIsolationBranchAfterMerge(
      state, phase, isolationBranch, "fw/phase-1",
      { git: defaultGit(cloneDir), log: (m: string) => logs.push(m) } as unknown as OrchestratorDeps,
    );
    const afterSha = git(["rev-parse", isolationBranch]);
    expect(afterSha).toBe(beforeSha); // 유실 없이 그대로 보존
    expect(logs.some(l => l.includes("push 되지 않은 커밋"))).toBe(true);
  });
});

// §51 실측(z-parse Phase 2) — 세션이 "SHA + 커밋 메시지 전문" 을 보고해 회송 2회·$2.31 이
// 보고 형식 때문에 낭비됐다. 선행 hex 토큰만 뽑아 검증하되, 검증 자체는 그대로 전부 수행한다.
describe("verifySessionCommits — §51 커밋 보고 관용", () => {
  const okVerify = async (_cwd: string, sha: string) =>
    /^[0-9a-f]{7,40}$/i.test(sha) ? { ok: true as const } : { ok: false as const, reason: `존재하지 않음: ${sha}` };
  const deps = { verifyCommit: okVerify, branchReachable: async () => ({ ok: true as const }) } as never;

  it("'SHA + 메시지' 형식에서 SHA 만 뽑아 검증한다", async () => {
    const r = await verifySessionCommits("/repo", null, null, ["eae008a fix(fw-harness): -z 전환"], deps);
    expect(r.ok).toBe(true);
  });

  it("bare SHA 는 기존 그대로 통과한다", async () => {
    expect((await verifySessionCommits("/repo", null, null, ["eae008a1b2c3"], deps)).ok).toBe(true);
  });

  it("hex 토큰이 없으면 원문 그대로 검증에 넘겨 기존 오류가 나온다 (관용이 진단을 가리지 않음)", async () => {
    const r = await verifySessionCommits("/repo", null, null, ["HEAD"], deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toContain("HEAD");
  });

  it("추출된 SHA 도 검증은 전부 그대로 받는다 — 존재하지 않으면 실패", async () => {
    const failVerify = async (_c: string, sha: string) => ({ ok: false as const, reason: `없음: ${sha}` });
    const r = await verifySessionCommits("/repo", null, null, ["abcdef1 아무 메시지"], {
      verifyCommit: failVerify, branchReachable: async () => ({ ok: true as const }),
    } as never);
    expect(r.ok).toBe(false);
  });
});

// ── issue #3: already_applied 근거 커밋 검증 ───────────────────────────────────
describe("verifyAlreadyAppliedCommits / defaultAlreadyAppliedCommit (issue #3)", () => {
  it("commits 가 비어 있으면 근거 없음으로 거부한다 (dep 호출 없이)", async () => {
    let called = 0;
    const r = await verifyAlreadyAppliedCommits("/x", "HEAD", "main", [], {
      alreadyAppliedCommit: async () => { called++; return { ok: true }; },
    } as never);
    expect(r.ok).toBe(false);
    expect(called).toBe(0);
    if (!r.ok) expect(r.problem).toContain("근거 커밋");
  });

  it("각 커밋을 alreadyAppliedCommit(headRef, baseBranch) 로 검증하고 하나라도 실패하면 거부한다", async () => {
    const seen: string[][] = [];
    const r = await verifyAlreadyAppliedCommits("/x", "feature/wf", "main", ["abc1234 feat: x", "def5678"], {
      alreadyAppliedCommit: async (_cwd: string, sha: string, head: string, base: string) => {
        seen.push([sha, head, base]);
        return sha === "def5678" ? { ok: false, reason: "base 에 이미 있음" } : { ok: true };
      },
    } as never);
    expect(seen).toEqual([["abc1234", "feature/wf", "main"], ["def5678", "feature/wf", "main"]]); // 선행 hex 토큰만
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toContain("def5678");
  });

  it("모두 통과하면 ok", async () => {
    const r = await verifyAlreadyAppliedCommits("/x", "HEAD", "main", ["abc1234"], {
      alreadyAppliedCommit: async () => ({ ok: true }),
    } as never);
    expect(r).toEqual({ ok: true });
  });

  describe("defaultAlreadyAppliedCommit — 실제 git 리포", () => {
    let gitDir: string;
    let baseSha: string;
    let featureSha: string;
    let otherSha: string;

    beforeEach(() => {
      gitDir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-branch-aa-"));
      const g = (args: string[]) => execFileSync("git", args, { cwd: gitDir }).toString().trim();
      g(["init", "-q", "-b", "main"]);
      g(["config", "user.email", "t@t.com"]);
      g(["config", "user.name", "t"]);
      fs.writeFileSync(path.join(gitDir, "a.txt"), "1");
      g(["add", "."]); g(["commit", "-q", "-m", "init"]);
      baseSha = g(["rev-parse", "HEAD"]);
      g(["checkout", "-q", "-b", "other"]);
      fs.writeFileSync(path.join(gitDir, "o.txt"), "o");
      g(["add", "."]); g(["commit", "-q", "-m", "other"]);
      otherSha = g(["rev-parse", "HEAD"]);
      g(["checkout", "-q", "-b", "feature", "main"]);
      fs.writeFileSync(path.join(gitDir, "b.txt"), "2");
      g(["add", "."]); g(["commit", "-q", "-m", "on feature"]);
      featureSha = g(["rev-parse", "HEAD"]);
    });

    it("PR 브랜치에만 있는 커밋(base 에는 없음)이면 통과한다", async () => {
      expect(await defaultAlreadyAppliedCommit(gitDir, featureSha, "feature", "main")).toEqual({ ok: true });
    });

    it("base 브랜치에 이미 있는 커밋(예: 최초 커밋)을 근거로 대면 거부한다 — PR 이 만든 변경이 아니다", async () => {
      const r = await defaultAlreadyAppliedCommit(gitDir, baseSha, "feature", "main");
      expect(r.ok).toBe(false);
      expect(r.reason).toContain("main");
    });

    it("PR 브랜치에서 도달 불가능한 커밋(다른 브랜치)이면 거부한다", async () => {
      const r = await defaultAlreadyAppliedCommit(gitDir, otherSha, "feature", "main");
      expect(r.ok).toBe(false);
      expect(r.reason).toContain("도달");
    });

    it("존재하지 않는 SHA 면 거부한다", async () => {
      const r = await defaultAlreadyAppliedCommit(gitDir, "0123456789abcdef0123456789abcdef01234567", "feature", "main");
      expect(r.ok).toBe(false);
      expect(r.reason).toContain("존재하지 않는");
    });

    it("base 브랜치가 로컬에 없으면 origin/<base> 로 폴백하고, 그것도 없으면 거부한다(fail-closed)", async () => {
      const r = await defaultAlreadyAppliedCommit(gitDir, featureSha, "feature", "nope");
      expect(r.ok).toBe(false);
      expect(r.reason).toContain("nope");
    });
  });
});

// ── pr-slicing Phase 2: 조각 브랜치 생성 ──────────────────────────────────────
// 스텁이 아니라 실제 git 리포로 검증한다(PLAN D4 — 스텁 전용 금지). 이 함수의 핵심 계약은
// "남의 브랜치를 덮지 않는다" 인데, 스텁으로는 ancestry 판정 자체를 흉내내게 되어 계약이
// 못박히지 않는다.
describe("createSliceBranch — 조각 브랜치 생성과 소유권 확인", () => {
  function realGit(defaultCwd: string) {
    return (args: string[], gitCwd?: string): Promise<CliExecResult> =>
      new Promise(resolve => {
        try {
          const stdout = execFileSync("git", args, { cwd: gitCwd ?? defaultCwd }).toString();
          resolve({ ok: true, stdout, stderr: "" });
        } catch (err) {
          const e = err as { stdout?: Buffer; stderr?: Buffer; message: string };
          resolve({ ok: false, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? e.message });
        }
      });
  }

  function newRepo(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "fw-slice-"));
    const g = (...args: string[]) => execFileSync("git", args, { cwd: d, stdio: "pipe" });
    g("init", "-q", "-b", "main", ".");
    g("config", "user.email", "t@t.com");
    g("config", "user.name", "t");
    fs.writeFileSync(path.join(d, "a.txt"), "1");
    g("add", ".");
    g("commit", "-q", "-m", "init");
    return d;
  }

  const git = (d: string) => (...args: string[]) => execFileSync("git", args, { cwd: d, stdio: "pipe" }).toString();
  const head = (d: string) => git(d)("rev-parse", "--abbrev-ref", "HEAD").trim();
  const sha = (d: string, ref: string) => git(d)("rev-parse", ref).trim();

  it("조각 브랜치가 없으면 통합 브랜치에서 새로 만들어 체크아웃한다", async () => {
    const d = newRepo();
    git(d)("checkout", "-q", "-b", "feature/wf");
    const r = await createSliceBranch({ cwd: d, integrationBranch: "feature/wf", seq: 1, git: realGit(d) });
    expect(r).toEqual({ ok: true, branch: "feature/wf-1" });
    expect(head(d)).toBe("feature/wf-1");
    expect(sha(d, "feature/wf-1")).toBe(sha(d, "feature/wf"));
    fs.rmSync(d, { recursive: true, force: true });
  });

  it("--no-track 으로 만든다 (사용자 git 설정을 조용히 바꾸지 않는다 — §41 I-4)", async () => {
    const d = newRepo();
    // `branch.autoSetupMerge=always` 를 켠 상태에서 재현한다. 기본값(true)은 시작점이
    // remote-tracking 브랜치일 때만 upstream 을 붙이므로, 로컬 통합 브랜치에서 딴 이 픽스처
    // 에서는 `--no-track` 을 지워도 아무 차이가 없어 **뮤테이션을 못 잡는다**(실측). `always` 는
    // 로컬 시작점에도 붙이므로 그 설정을 쓰는 사용자의 실제 위험을 그대로 재현한다.
    git(d)("config", "branch.autoSetupMerge", "always");
    git(d)("checkout", "-q", "-b", "feature/wf");
    await createSliceBranch({ cwd: d, integrationBranch: "feature/wf", seq: 1, git: realGit(d) });
    // upstream 이 설정되면 조각 브랜치 위에서 친 git pull/push 가 엉뚱한 브랜치와 동기화된다.
    // `git config --get` 은 키가 없으면 exit 1 이므로(= 원하는 상태) spawnSync 로 받는다.
    const cfg = spawnSync("git", ["config", "--get", "branch.feature/wf-1.merge"], { cwd: d, encoding: "utf8" });
    expect(cfg.stdout.trim()).toBe("");
    fs.rmSync(d, { recursive: true, force: true });
  });

  it("이미 있고 tip 이 통합 브랜치와 같으면 그대로 체크아웃한다 (재실행 멱등)", async () => {
    const d = newRepo();
    git(d)("checkout", "-q", "-b", "feature/wf");
    git(d)("branch", "feature/wf-1");
    const r = await createSliceBranch({ cwd: d, integrationBranch: "feature/wf", seq: 1, git: realGit(d) });
    expect(r.ok).toBe(true);
    expect(head(d)).toBe("feature/wf-1");
    fs.rmSync(d, { recursive: true, force: true });
  });

  it("이미 있고 통합 브랜치 위에 우리 커밋이 쌓여 있으면 파괴하지 않고 체크아웃한다 (retry)", async () => {
    const d = newRepo();
    git(d)("checkout", "-q", "-b", "feature/wf");
    git(d)("checkout", "-q", "-b", "feature/wf-1");
    fs.writeFileSync(path.join(d, "b.txt"), "2");
    git(d)("add", ".");
    git(d)("commit", "-q", "-m", "이전 시도의 작업");
    const before = sha(d, "feature/wf-1");
    git(d)("checkout", "-q", "feature/wf");

    const r = await createSliceBranch({ cwd: d, integrationBranch: "feature/wf", seq: 1, git: realGit(d) });
    expect(r.ok).toBe(true);
    // 커밋이 살아 있어야 한다 — checkout -B 로 리셋하면 이전 시도의 작업이 사라진다.
    expect(sha(d, "feature/wf-1")).toBe(before);
    expect(head(d)).toBe("feature/wf-1");
    fs.rmSync(d, { recursive: true, force: true });
  });

  // 검토 확정 결함(중)의 회귀 방지 장치. 실측: 워크플로우 "wf" 의 조각 1 은 feature/wf-1 이고,
  // 이것은 워크플로우 "wf-1" 의 통합 브랜치와 **같은 ref** 다. 이름 규칙으로는 못 막으므로
  // (어떤 구분자를 써도 그 구분자를 포함한 이름이 같은 충돌을 만든다) 이 검사가 유일한 방어다.
  it("통합 브랜치와 갈라진 브랜치면 거부한다 (다른 워크플로우 소유 가능성)", async () => {
    const d = newRepo();
    // 워크플로우 "wf-1" 이 먼저 자기 통합 브랜치(feature/wf-1)에 작업을 쌓았다
    git(d)("checkout", "-q", "-b", "feature/wf-1");
    fs.writeFileSync(path.join(d, "other.txt"), "다른 워크플로우의 작업");
    git(d)("add", ".");
    git(d)("commit", "-q", "-m", "다른 워크플로우 커밋");
    const otherSha = sha(d, "feature/wf-1");
    // 워크플로우 "wf" 는 별도 통합 브랜치에 자기 작업을 쌓았다 (두 이력이 갈라진다)
    git(d)("checkout", "-q", "-b", "feature/wf", "main");
    fs.writeFileSync(path.join(d, "mine.txt"), "내 작업");
    git(d)("add", ".");
    git(d)("commit", "-q", "-m", "내 커밋");

    const r = await createSliceBranch({ cwd: d, integrationBranch: "feature/wf", seq: 1, git: realGit(d) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toMatch(/feature\/wf-1/);
    // 남의 브랜치가 한 글자도 바뀌지 않아야 한다
    expect(sha(d, "feature/wf-1")).toBe(otherSha);
    // 거부했으면 브랜치를 옮기지도 않는다
    expect(head(d)).toBe("feature/wf");
    fs.rmSync(d, { recursive: true, force: true });
  });

  it("통합 브랜치 이름이 유효하지 않으면 거부한다 (던지지 않는다)", async () => {
    const d = newRepo();
    const r = await createSliceBranch({ cwd: d, integrationBranch: "bad name", seq: 1, git: realGit(d) });
    expect(r.ok).toBe(false);
    fs.rmSync(d, { recursive: true, force: true });
  });

  it("통합 브랜치가 존재하지 않으면 거부한다", async () => {
    const d = newRepo();
    const r = await createSliceBranch({ cwd: d, integrationBranch: "feature/nope", seq: 1, git: realGit(d) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toMatch(/feature\/nope/);
    fs.rmSync(d, { recursive: true, force: true });
  });
});

// ── pr-slicing Phase 2: 머지 후 통합 브랜치 전진 ────────────────────────────
// 조각 PR 이 통합 브랜치로 머지되면 로컬 통합 브랜치를 그 상태로 따라가게 해야 한다 —
// 그러지 않으면 다음 조각이 낡은 기준에서 갈라져 나가 조각 PR diff 에 앞 조각이 다시 담긴다.
//
// **파괴적 리셋을 쓰지 않는다.** 기존 refreshIsolationBranchAfterMerge 는 `checkout -B
// <브랜치> --no-track origin/<base>` 로 브랜치를 재생성하고 그 위험을 안전 가드 세 겹으로
// 막았다. 그 함수가 그래야 했던 이유는 **옛 토폴로지에서는 하네스가 격리 브랜치에 직접
// 커밋했기** 때문이다 — squash 머지되면 origin/<base> 에는 내용만 있고 원본 커밋이 없어
// 관계가 fast-forward 가 아니게 되고, 강제 재생성 말고는 누적을 끊을 방법이 없었다.
//
// 새 토폴로지에서는 하네스가 통합 브랜치에 **직접 커밋하지 않는다**(세션은 조각 브랜치에서
// 작업한다, D2). 통합 브랜치는 원격에서 일어나는 머지로만 전진하므로 로컬은 항상 원격의
// 조상이고, `git fetch origin <int>:<int>` 가 **강제 없이** 성공한다 — squash 머지에서도
// 그렇다(아래 테스트가 실측으로 못박는다). 그래서 이 함수에는 데이터 손실 경로가 없다:
// fast-forward 가 아니면 git 이 스스로 거부하고 우리는 그 실패를 흡수해 퇴화할 뿐이다.
describe("advanceIntegrationBranchAfterMerge — 강제 없는 fast-forward 전진", () => {
  function realGit(defaultCwd: string) {
    return (args: string[], gitCwd?: string): Promise<CliExecResult> =>
      new Promise(resolve => {
        try {
          const stdout = execFileSync("git", args, { cwd: gitCwd ?? defaultCwd, stdio: "pipe" }).toString();
          resolve({ ok: true, stdout, stderr: "" });
        } catch (err) {
          const e = err as { stdout?: Buffer; stderr?: Buffer; message: string };
          resolve({ ok: false, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? e.message });
        }
      });
  }

  /** 원격(bare) + 작업 클론을 만들고, 통합 브랜치와 커밋 하나가 든 조각 브랜치를 준비한다.
   *  반환된 work 는 HEAD 가 조각 브랜치에 있다(실제 주행 시점의 상태). */
  function setup(): { root: string; work: string; remote: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fw-adv-"));
    const remote = path.join(root, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", remote], { stdio: "pipe" });
    const work = path.join(root, "work");
    execFileSync("git", ["clone", "-q", remote, work], { stdio: "pipe" });
    const g = (...args: string[]) => execFileSync("git", args, { cwd: work, stdio: "pipe" });
    g("config", "user.email", "t@t");
    g("config", "user.name", "t");
    fs.writeFileSync(path.join(work, "a.txt"), "base");
    g("add", ".");
    g("commit", "-q", "-m", "base");
    g("branch", "-M", "main");
    g("push", "-q", "origin", "main");
    g("checkout", "-q", "-b", "feature/wf");
    g("push", "-q", "origin", "feature/wf");
    g("checkout", "-q", "-b", "feature/wf-1", "--no-track", "feature/wf");
    fs.writeFileSync(path.join(work, "b.txt"), "조각1");
    g("add", ".");
    g("commit", "-q", "-m", "조각1 작업");
    g("push", "-q", "origin", "feature/wf-1");
    return { root, work, remote };
  }

  /** 원격에서 조각 브랜치를 통합 브랜치로 머지한다(실제로는 사람이 GHE 에서 한다). */
  function mergeOnRemote(remote: string, mode: "squash" | "merge"): void {
    const m = fs.mkdtempSync(path.join(os.tmpdir(), "fw-adv-m-"));
    execFileSync("git", ["clone", "-q", remote, m], { stdio: "pipe" });
    const g = (...args: string[]) => execFileSync("git", args, { cwd: m, stdio: "pipe" });
    g("config", "user.email", "t@t");
    g("config", "user.name", "t");
    g("checkout", "-q", "feature/wf");
    if (mode === "squash") {
      g("merge", "-q", "--squash", "origin/feature/wf-1");
      g("commit", "-q", "-m", "squash: 조각1");
    } else {
      g("merge", "-q", "--no-ff", "-m", "merge: 조각1", "origin/feature/wf-1");
    }
    g("push", "-q", "origin", "feature/wf");
    fs.rmSync(m, { recursive: true, force: true });
  }

  const sha = (d: string, ref: string) => execFileSync("git", ["rev-parse", ref], { cwd: d, stdio: "pipe" }).toString().trim();
  const head = (d: string) => execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: d, stdio: "pipe" }).toString().trim();

  it("squash 머지 후 강제 없이 fast-forward 로 전진한다", async () => {
    const { root, work, remote } = setup();
    mergeOnRemote(remote, "squash");
    const before = sha(work, "feature/wf");
    const r = await advanceIntegrationBranchAfterMerge({
      cwd: work, integrationBranch: "feature/wf", git: realGit(work),
    });
    expect(r.advanced).toBe(true);
    expect(sha(work, "feature/wf")).not.toBe(before);
    expect(sha(work, "feature/wf")).toBe(sha(work, "origin/feature/wf"));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("merge 커밋 머지 후에도 전진한다", async () => {
    const { root, work, remote } = setup();
    mergeOnRemote(remote, "merge");
    const r = await advanceIntegrationBranchAfterMerge({
      cwd: work, integrationBranch: "feature/wf", git: realGit(work),
    });
    expect(r.advanced).toBe(true);
    expect(sha(work, "feature/wf")).toBe(sha(work, "origin/feature/wf"));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("HEAD 는 조각 브랜치에 그대로 남는다 (통합 브랜치로 옮기지 않는다)", async () => {
    const { root, work, remote } = setup();
    mergeOnRemote(remote, "squash");
    await advanceIntegrationBranchAfterMerge({ cwd: work, integrationBranch: "feature/wf", git: realGit(work) });
    expect(head(work)).toBe("feature/wf-1");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("로컬 통합 브랜치에 사람이 커밋해 갈라져 있으면 전진하지 않고 그 커밋을 보존한다", async () => {
    const { root, work, remote } = setup();
    mergeOnRemote(remote, "squash");
    // 사람이 로컬 통합 브랜치에 직접 커밋한 상황(하네스는 이러지 않지만 사람은 할 수 있다)
    const g = (...args: string[]) => execFileSync("git", args, { cwd: work, stdio: "pipe" });
    g("checkout", "-q", "feature/wf");
    fs.writeFileSync(path.join(work, "human.txt"), "사람이 직접 커밋");
    g("add", ".");
    g("commit", "-q", "-m", "사람 커밋");
    const humanSha = sha(work, "feature/wf");
    g("checkout", "-q", "feature/wf-1");

    const r = await advanceIntegrationBranchAfterMerge({
      cwd: work, integrationBranch: "feature/wf", git: realGit(work),
    });
    expect(r.advanced).toBe(false);
    // 강제 갱신을 하지 않으므로 사람 커밋이 살아 있어야 한다 — 이 함수의 핵심 안전 계약이다.
    expect(sha(work, "feature/wf")).toBe(humanSha);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("원격에 통합 브랜치가 없으면(머지 시 자동 삭제 등) 실패를 흡수하고 사유를 남긴다", async () => {
    const { root, work } = setup();
    const r = await advanceIntegrationBranchAfterMerge({
      cwd: work, integrationBranch: "feature/nope", git: realGit(work),
    });
    expect(r.advanced).toBe(false);
    expect(r.reason).toBeTruthy();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("HEAD 가 통합 브랜치 위에 있으면 건너뛴다 (git 이 현재 브랜치로의 fetch 를 거부한다)", async () => {
    const { root, work, remote } = setup();
    mergeOnRemote(remote, "squash");
    execFileSync("git", ["checkout", "-q", "feature/wf"], { cwd: work, stdio: "pipe" });
    const r = await advanceIntegrationBranchAfterMerge({
      cwd: work, integrationBranch: "feature/wf", git: realGit(work),
    });
    expect(r.advanced).toBe(false);
    expect(r.reason).toMatch(/HEAD|현재 브랜치/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

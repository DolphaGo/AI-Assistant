// base 브랜치 감지 전용 테스트 (docs/pr-slicing Phase 1, PLAN D15).
//
// 지금까지 `fw init` 은 base_branch 를 "main" 으로 하드코딩했다. git flow 리포(develop ←
// feature/*)에서는 PR 이 develop 이 아니라 main 으로 가고, 조각 분해가 들어가면 잘못된 base 의
// PR 이 phase 당 여러 개 생겨 피해가 배로 커진다.
//
// 감지 규칙은 `/start` 스킬(commands/start.md)에만 산문으로 있던 것을 하네스 함수로 옮긴 것이다
// — 규칙이 두 곳에 있으면 다음 라운드에 갈린다. 그래서 "develop 이 있으면 git flow 로 본다" 가
// origin/HEAD 보다 **우선**한다: git flow 리포의 origin/HEAD 는 보통 main/master 를 가리키지만
// 실제 통합 대상은 develop 이다.
import { describe, it, expect } from "vitest";
import { detectBaseBranch } from "../src/branch.js";
import type { CliExecResult } from "../src/preflight.js";

const OK = (stdout = ""): CliExecResult => ({ ok: true, stdout, stderr: "" });
const FAIL = (stderr = "boom"): CliExecResult => ({ ok: false, stdout: "", stderr });

/** args 를 공백으로 이어붙인 문자열을 키로 응답을 고르는 스텁. 등록되지 않은 명령은 실패로 답한다
 *  — "예상치 못한 git 호출이 조용히 성공으로 취급되는" 상황을 만들지 않는다. */
function stubGit(responses: Record<string, CliExecResult>) {
  const calls: string[] = [];
  const git = async (args: string[]): Promise<CliExecResult> => {
    const key = args.join(" ");
    calls.push(key);
    return responses[key] ?? FAIL(`unstubbed: ${key}`);
  };
  return { git, calls };
}

const LOCAL_DEVELOP = "show-ref --verify --quiet refs/heads/develop";
const REMOTE_DEVELOP = "show-ref --verify --quiet refs/remotes/origin/develop";
const ORIGIN_HEAD = "symbolic-ref refs/remotes/origin/HEAD";
const GIT_DIR = "rev-parse --git-dir";
const remoteRef = (branch: string) => `show-ref --verify --quiet refs/remotes/origin/${branch}`;

/** develop 은 없고 origin/HEAD 가 주어진 ref 를 가리키는 리포. 그 ref 의 실존 여부를 골라 준다. */
function stubWithOriginHead(headRef: string, opts: { targetExists: boolean; isRepo?: boolean }) {
  const target = headRef.replace(/^refs\/remotes\/origin\//, "");
  return stubGit({
    [LOCAL_DEVELOP]: FAIL(),
    [REMOTE_DEVELOP]: FAIL(),
    [ORIGIN_HEAD]: OK(`${headRef}\n`),
    [remoteRef(target)]: opts.targetExists ? OK() : FAIL(),
    [GIT_DIR]: (opts.isRepo ?? true) ? OK(".git\n") : FAIL(),
  });
}

/** 아무 신호도 없는 정상 git 리포. */
function stubNoSignal(opts: { isRepo?: boolean } = {}) {
  return stubGit({
    [LOCAL_DEVELOP]: FAIL(),
    [REMOTE_DEVELOP]: FAIL(),
    [ORIGIN_HEAD]: FAIL(),
    [GIT_DIR]: (opts.isRepo ?? true) ? OK(".git\n") : FAIL(),
  });
}

describe("detectBaseBranch — develop 우선", () => {
  it("로컬에 develop 이 있으면 develop 을 고른다 (git flow)", async () => {
    const { git } = stubGit({ [LOCAL_DEVELOP]: OK() });
    const result = await detectBaseBranch("/repo", git);
    expect(result.branch).toBe("develop");
    expect(result.source).toBe("develop");
  });

  it("로컬에 없고 origin 에 develop 이 있으면 develop 을 고른다", async () => {
    const { git } = stubGit({ [LOCAL_DEVELOP]: FAIL(), [REMOTE_DEVELOP]: OK() });
    const result = await detectBaseBranch("/repo", git);
    expect(result.branch).toBe("develop");
    expect(result.source).toBe("develop");
  });

  it("develop 이 origin/HEAD 보다 우선한다", async () => {
    // git flow 리포의 origin/HEAD 는 보통 main 을 가리키지만 통합 대상은 develop 이다.
    const { git } = stubGit({
      [LOCAL_DEVELOP]: OK(),
      [ORIGIN_HEAD]: OK("refs/remotes/origin/main\n"),
    });
    const result = await detectBaseBranch("/repo", git);
    expect(result.branch).toBe("develop");
  });

  it("develop 이 감지되면 origin/HEAD 를 묻지 않는다", async () => {
    // 불필요한 git 왕복을 만들지 않는다.
    const { git, calls } = stubGit({ [LOCAL_DEVELOP]: OK() });
    await detectBaseBranch("/repo", git);
    expect(calls).not.toContain(ORIGIN_HEAD);
  });

  it("감지 근거를 사람이 읽을 수 있는 한 줄로 준다", async () => {
    const { git } = stubGit({ [LOCAL_DEVELOP]: OK() });
    const result = await detectBaseBranch("/repo", git);
    expect(result.reason).toContain("develop");
    expect(result.reason.length).toBeGreaterThan(0);
    expect(result.reason).not.toContain("\n");
  });
});

describe("detectBaseBranch — origin/HEAD", () => {
  it("origin/HEAD 가 가리키는 브랜치가 실재하면 그것을 쓴다", async () => {
    const { git } = stubWithOriginHead("refs/remotes/origin/main", { targetExists: true });
    const result = await detectBaseBranch("/repo", git);
    expect(result.branch).toBe("main");
    expect(result.source).toBe("origin-head");
  });

  it("main 이 아닌 이름을 가리켜도 그대로 쓴다", async () => {
    const { git } = stubWithOriginHead("refs/remotes/origin/trunk", { targetExists: true });
    const result = await detectBaseBranch("/repo", git);
    expect(result.branch).toBe("trunk");
    expect(result.source).toBe("origin-head");
  });

  it("슬래시가 든 기본 브랜치 이름도 온전히 살린다", async () => {
    const { git } = stubWithOriginHead("refs/remotes/origin/release/2026", { targetExists: true });
    const result = await detectBaseBranch("/repo", git);
    expect(result.branch).toBe("release/2026");
  });

  // 개발 렌즈 검토 확정 결함(상): 형식만 검증하고 **실존을 검증하지 않아** dangling 심볼릭 ref
  // 에서 존재하지 않는 브랜치를 확신 있는 문구와 함께 base_branch 로 확정했다. 실측 재현:
  // 원격이 master→main 으로 rename 된 뒤 `git fetch --prune` 하면 origin/master 는 사라지는데
  // origin/HEAD 는 여전히 그것을 가리키고 `symbolic-ref` 는 exit 0 을 낸다.
  // develop 경로는 show-ref 로 실존을 확인하는데 이 경로만 빠져 있던 비대칭이 원인이었다.
  it("origin/HEAD 가 존재하지 않는 브랜치를 가리키면 폴백한다 (dangling 심볼릭 ref)", async () => {
    const { git } = stubWithOriginHead("refs/remotes/origin/master", { targetExists: false });
    const result = await detectBaseBranch("/repo", git);
    expect(result.branch).toBe("main");
    expect(result.source).toBe("fallback");
    expect(result.fallbackReason).toBe("dangling-origin-head");
    // 원인과 처방이 문구에 있어야 한다 — 사용자가 왜 폴백됐는지 알 수 있게.
    expect(result.reason).toContain("master");
  });

  it("존재하지 않는 브랜치를 base 로 쓰지 않는지 실존 검사로 확인한다", async () => {
    const { git, calls } = stubWithOriginHead("refs/remotes/origin/main", { targetExists: true });
    await detectBaseBranch("/repo", git);
    expect(calls).toContain(remoteRef("main"));
  });

  it("origin/HEAD 출력이 예상 형식이 아니면 폴백한다", async () => {
    // 조용히 엉뚱한 값을 base_branch 로 쓰면 PR 이 존재하지 않는 브랜치를 향한다.
    for (const weird of ["", "   ", "HEAD\n", "refs/heads/main\n", "refs/remotes/origin/\n"]) {
      const { git } = stubGit({
        [LOCAL_DEVELOP]: FAIL(),
        [REMOTE_DEVELOP]: FAIL(),
        [ORIGIN_HEAD]: OK(weird),
        [GIT_DIR]: OK(".git\n"),
      });
      const result = await detectBaseBranch("/repo", git);
      expect(result.source, `폴백해야 함: ${JSON.stringify(weird)}`).toBe("fallback");
      expect(result.branch).toBe("main");
    }
  });

  // 평가 렌즈 검토 확정 결함(중): 이름 유효성 가드가 테스트로 못 박히지 않아(뮤테이션 생존)
  // 지워도 초록이었다 — 위 "예상 형식" 입력들은 전부 접두 검사나 빈 이름 검사에서 걸러져
  // 이 가드에 **도달하지 않았기** 때문이다. 접두는 맞고 이름만 무효한 입력이 필요하다.
  it("접두는 맞지만 이름이 git ref 로 무효하면 폴백한다", async () => {
    for (const badName of ["bad name", ".hidden", "x.lock", "has~tilde", "dot..dot"]) {
      const { git } = stubWithOriginHead(`refs/remotes/origin/${badName}`, { targetExists: true });
      const result = await detectBaseBranch("/repo", git);
      expect(result.source, `폴백해야 함: ${JSON.stringify(badName)}`).toBe("fallback");
      expect(result.branch).toBe("main");
    }
  });
});

describe("detectBaseBranch — 폴백 사유 구분", () => {
  // 개발 렌즈 검토 확정 결함(중): git 의 모든 실패를 "브랜치 없음"으로 접어, "git 리포가
  // 아님"·"git 실행 불가"·"정말 감지 실패"가 전부 같은 문구로 수렴하고 원인과 무관한 교정
  // 지시("git flow 리포라면 develop 으로 고치세요")를 냈다. 같은 파일의 isRepoLevelGitError·
  // spawnErrorCode 가 세운 "인프라 오류와 정상 음성 판정을 섞지 않는다" 규율과 어긋났다.
  it("정상 리포인데 신호가 없으면 no-signal 로 폴백한다", async () => {
    const { git } = stubNoSignal();
    const result = await detectBaseBranch("/repo", git);
    expect(result.branch).toBe("main");
    expect(result.source).toBe("fallback");
    expect(result.fallbackReason).toBe("no-signal");
    expect(result.reason).toMatch(/감지/);
  });

  it("git 리포가 아니면(또는 git 을 실행할 수 없으면) not-a-repo 로 구분한다", async () => {
    const { git } = stubNoSignal({ isRepo: false });
    const result = await detectBaseBranch("/not-a-repo", git);
    expect(result.branch).toBe("main");
    expect(result.source).toBe("fallback");
    expect(result.fallbackReason).toBe("not-a-repo");
    // 원인과 무관한 교정 지시를 내지 않는다 — "develop 으로 고치세요" 는 이 경우 답이 아니다.
    expect(result.reason).not.toContain("git flow");
  });

  it("리포 여부는 폴백할 때만 묻는다 (정상 경로에 git 왕복을 늘리지 않는다)", async () => {
    const { git, calls } = stubGit({ [LOCAL_DEVELOP]: OK() });
    await detectBaseBranch("/repo", git);
    expect(calls).not.toContain(GIT_DIR);
  });

  it("폴백 사유는 성공 경로에서는 비어 있다", async () => {
    const { git } = stubGit({ [LOCAL_DEVELOP]: OK() });
    expect((await detectBaseBranch("/repo", git)).fallbackReason).toBeUndefined();
  });
});

// §25 리팩토링: orchestrator.ts 에서 브랜치 전략·이탈 감시·커밋 도달성(git 상호작용 전반)을 이
// 모듈로 옮겼다(순수 이동 — 로직 변경 없음). orchestrator.ts(phase 루프)와 prloop.ts(PR fix 루프)
// 양쪽이 이 모듈의 checkBranchDrift/verifySessionCommits 를 공유해서 쓴다 — §30 P1("방어를 한
// 경로에만 세운다")이 세 라운드 연속 재발한 교훈이 "복붙 대신 공통 헬퍼로 뺀다"였다.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { State, Phase } from "./state.js";
import { defaultGitExec, type CliExecResult } from "./preflight.js";
import type { OrchestratorDeps, CommitCheck, ChangedFilesResult } from "./orchestrator-types.js";
import { displayPath } from "./paths.js";

const GIT_VERIFY_TIMEOUT_MS = 60_000; // pr.ts EXEC_TIMEOUT_MS 와 동일한 계약 — 무기한 걸리지 않게

// §tamper-gap D7: export 추가 — defaultChangedFiles 의 gitExec 주입 파라미터 타입을 테스트가
// 참조하기 위함(E8, 실제 git 실행을 모킹/주입해 U+FFFD 배선까지 검증한다).
export interface GitExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** spawn 자체 실패(예: ENOENT — git 실행 파일 없음) 시의 Node 오류 코드. exitCode 와 별개로
   *  구분해야 "커밋 없음"(정상적인 음성 판정)과 "git 을 실행할 수조차 없음"(인프라 오류)이 안 섞인다. */
  spawnErrorCode?: string;
}

function execGit(args: string[], cwd: string): Promise<GitExecResult> {
  return new Promise(resolve => {
    // LC_ALL/LANG 을 C 로 고정 — git 오류 메시지가 시스템 로케일에 따라 번역되면(예: 한국어
    // 환경에서 "깃 저장소가 아닙니다") isRepoLevelGitError 의 영문 패턴 매칭이 조용히 깨져
    // "리포 자체 오류"와 "커밋 없음"을 구분하지 못하게 된다 — 실측으로 확인된 결함.
    const env = { ...process.env, LC_ALL: "C", LANG: "C" };
    execFile("git", args, { cwd, timeout: GIT_VERIFY_TIMEOUT_MS, env }, (err, stdout, stderr) => {
      if (!err) {
        resolve({ exitCode: 0, stdout: stdout ?? "", stderr: stderr ?? "", timedOut: false });
        return;
      }
      const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
      if (typeof e.code === "string") {
        resolve({ exitCode: null, stdout: "", stderr: stderr || e.message, timedOut: false, spawnErrorCode: e.code });
        return;
      }
      resolve({
        exitCode: typeof e.code === "number" ? e.code : null,
        stdout: stdout ?? "",
        stderr: stderr || e.message,
        timedOut: !!e.killed,
      });
    });
  });
}

// git 저장소 자체의 오류(리포 아님 등)와 "그 객체/조상 관계가 없다"는 정상적 negative 판정을
// 구분하기 위한 휴리스틱. 종료 코드만으로는 구분할 수 없다 — `git cat-file -e <sha>^{commit}` 은
// sha 가 실재하지 않는 흔한 "정상적" 케이스에서도 128(리비전 파싱 자체 실패, "Not a valid object
// name")을 낸다. "리포 자체가 아니다"류 오류만 메시지 패턴으로 좁혀서 구분한다.
function isRepoLevelGitError(stderr: string): boolean {
  return /not a git repository/i.test(stderr);
}

// 세션 실행 전 HEAD 를 기록한다 (§25 — 커밋 게이트가 "HEAD" 로 통과되는 우회 차단의 전제).
export const defaultHeadSha = async (cwd: string): Promise<string | null> => {
  const r = await execGit(["rev-parse", "HEAD"], cwd);
  if (r.exitCode !== 0 || r.timedOut || r.spawnErrorCode) return null;
  const sha = r.stdout.trim();
  return sha.length > 0 ? sha : null;
};

// 세션이 보고한 커밋 SHA 를 검증한다: (1) 실제로 존재하는가, (2) headBefore 가 있으면 그 이후에
// 새로 생긴 커밋인가(=headBefore 의 후손이고 headBefore 자신은 아님). 예전 게이트는 존재 여부만
// 확인해 세션이 아무것도 안 하고 `commits:["HEAD"]`(또는 기존 커밋 SHA)를 반환해도 통과시켰다
// (§25 Important — "HANDOFF 를 내용 없이 touch"와 같은 등급의 우회). ancestry 검증까지 더해야
// "이번 시도에서 실제로 만든 커밋"임을 확인할 수 있다.
export const defaultVerifyCommit = async (
  cwd: string,
  sha: string,
  headBefore: string | null,
): Promise<CommitCheck> => {
  const exist = await execGit(["cat-file", "-e", `${sha}^{commit}`], cwd);
  if (exist.spawnErrorCode) {
    return { ok: false, reason: `git 실행 실패(${exist.spawnErrorCode}) — git 이 설치되어 있는지 확인하세요` };
  }
  if (exist.timedOut) {
    return { ok: false, reason: "git cat-file 명령이 타임아웃(60초)됐습니다" };
  }
  if (exist.exitCode !== 0) {
    if (isRepoLevelGitError(exist.stderr)) {
      return { ok: false, reason: `git 오류(리포 상태를 확인하세요): ${exist.stderr.trim().slice(0, 300)}` };
    }
    return { ok: false, reason: `git 에 존재하지 않는 커밋입니다: ${sha}` };
  }
  if (headBefore === null) return { ok: true }; // git 저장소가 아님 등 — 기존처럼 존재 검증만
  if (sha === headBefore) {
    return { ok: false, reason: "이번 시도에서 새로 생성된 커밋이 아닙니다 (직전 HEAD 와 동일한 SHA)" };
  }
  const anc = await execGit(["merge-base", "--is-ancestor", headBefore, sha], cwd);
  if (anc.spawnErrorCode) {
    return { ok: false, reason: `git 실행 실패(${anc.spawnErrorCode})` };
  }
  if (anc.timedOut) {
    return { ok: false, reason: "git merge-base 명령이 타임아웃(60초)됐습니다" };
  }
  if (anc.exitCode !== 0) {
    if (isRepoLevelGitError(anc.stderr)) {
      return { ok: false, reason: `git 오류(리포 상태를 확인하세요): ${anc.stderr.trim().slice(0, 300)}` };
    }
    return { ok: false, reason: "이번 시도 이전에 이미 존재하던 커밋입니다 (HEAD 의 후손이 아닙니다)" };
  }
  return { ok: true };
};

// §26 C2 감사: 커밋 존재/ancestry(defaultVerifyCommit)만으로는 "세션이 base_branch 에 커밋한 뒤
// 격리 브랜치로 되돌아가 이탈 감시만 피해가는" 공격을 못 잡는다 — headBefore 의 후손이라는 조건은
// base_branch 에서도 그대로 성립하기 때문이다(격리 브랜치가 base_branch 의 그 시점에서 갈라져
// 나왔다면). 보고된 커밋이 "작업 브랜치 자신"에서 도달 가능한지(그 브랜치의 조상인지)까지 확인해야
// 한다 — 다른 브랜치에서 만든 커밋은 격리 브랜치가 그 이후 갈라지지 않는 한 조상이 될 수 없다.
export const defaultBranchReachable = async (
  cwd: string,
  sha: string,
  branch: string,
): Promise<CommitCheck> => {
  const anc = await execGit(["merge-base", "--is-ancestor", sha, branch], cwd);
  if (anc.spawnErrorCode) {
    return { ok: false, reason: `git 실행 실패(${anc.spawnErrorCode})` };
  }
  if (anc.timedOut) {
    return { ok: false, reason: "git merge-base 명령이 타임아웃(60초)됐습니다" };
  }
  if (anc.exitCode !== 0) {
    if (isRepoLevelGitError(anc.stderr)) {
      return { ok: false, reason: `git 오류(리포 상태를 확인하세요): ${anc.stderr.trim().slice(0, 300)}` };
    }
    return {
      ok: false,
      reason: `커밋(${sha})이 작업 브랜치(${branch}) 에서 도달 가능하지 않습니다 — 다른 브랜치에서 커밋되었을 수 있습니다`,
    };
  }
  return { ok: true };
};

// §29 CR-2 감사: phase 세션과 fix 세션(PR 루프) 공통 방어 — 세션 실행 직후 격리/토픽 브랜치를
// 이탈했는지 재확인한다. 이전에는 phase 경로(:403 부근)에만 있고 runFixSession 뒤에는 이 검사가
// 하나도 없어(실측), fix 세션이 격리 브랜치를 벗어나(예: `git checkout main`) 커밋해도 그대로
// "반영" 판정을 받았다. 복붙하면 다음 라운드에 또 갈리므로(§29 의 구조적 교훈) 공통 함수로 뺀다 —
// 아래 runWorkflow(phase 루프)와 runPrGateInner(fix 루프) 양쪽이 반드시 이 함수를 거치게 한다.
export async function checkBranchDrift(
  cwd: string,
  workBranch: string | null,
  gitExec: (args: string[], cwd: string) => Promise<CliExecResult>,
): Promise<{ ok: true } | { ok: false; problem: string }> {
  if (workBranch === null) return { ok: true }; // branch_strategy=current — 사용자에게 위임(감시 제외)
  const afterBranch = await gitExec(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const actualBranch = afterBranch.ok ? afterBranch.stdout.trim() : null;
  if (actualBranch === workBranch) return { ok: true };
  const actualDesc = actualBranch && actualBranch.length > 0 ? actualBranch : "(확인 불가)";
  return {
    ok: false,
    problem:
      `작업 브랜치(${workBranch}) 를 벗어나 ${actualDesc} 에 있습니다. ` +
      `\`git checkout ${workBranch}\` 로 돌아간 뒤 작업을 다시 커밋하세요.`,
  };
}

// §29 CR-3 감사: phase 세션과 fix 세션 공통 방어 — 커밋이 존재하고(§25) headBefore 이후 신규이며
// (ancestry) 작업 브랜치에서 도달 가능한지(§26 C2) 검증한다. 이전에는 fix 세션 결과에 이 검증이
// 전혀 없어(`result.commits` 는 답글 문구에만 쓰였다, 실측) 커밋 0개인 "아무 것도 안 한" fix
// 세션도, 기존 SHA 를 재보고하는 fix 세션도 그대로 handled 영구 기록을 얻었다.
export async function verifySessionCommits(
  cwd: string,
  workBranch: string | null,
  headBefore: string | null,
  commits: string[],
  deps: OrchestratorDeps,
): Promise<{ ok: true } | { ok: false; problem: string }> {
  if (commits.length === 0) {
    return { ok: false, problem: "커밋이 없습니다. 작업을 의미 단위로 커밋한 뒤 done 을 반환하세요." };
  }
  // §51 실측(z-parse Phase 2): 세션이 commits 원소에 bare SHA 대신 "SHA + 커밋 메시지 전문"
  // 을 넣어 보고했고, 그 문자열이 그대로 cat-file 에 넘어가 회송 2회·$2.31 이 보고 **형식**
  // 때문에 낭비됐다(작업 자체는 1차에 완성). 각 원소의 선행 hex 토큰만 뽑아 검증한다 —
  // 관용이 위조 표면을 열지 않는 이유: 추출된 토큰도 기존 검증(존재·ancestry·브랜치 도달
  // 가능성)을 전부 그대로 통과해야 한다. hex 토큰이 아예 없으면 원문 그대로 넘겨 기존
  // 오류 메시지가 나오게 둔다(§30 P2 — 관용이 진단을 가리면 안 된다).
  const normalized = commits.map(c => {
    const m = c.trim().match(/^([0-9a-f]{7,40})\b/i);
    return m ? m[1]! : c;
  });
  const verifyCommit = deps.verifyCommit ?? defaultVerifyCommit;
  const branchReachable = deps.branchReachable ?? defaultBranchReachable;
  const checks = await Promise.all(normalized.map(async sha => {
    const base = await verifyCommit(cwd, sha, headBefore);
    if (!base.ok || workBranch === null) return base;
    return branchReachable(cwd, sha, workBranch);
  }));
  const failedIdx = checks.reduce<number[]>((acc, c, i) => (c.ok ? acc : [...acc, i]), []);
  if (failedIdx.length === 0) return { ok: true };
  const details = failedIdx.map(i => `${normalized[i]}: ${checks[i].reason ?? "검증 실패"}`).join("; ");
  return {
    ok: false,
    problem: `보고한 커밋 검증 실패 — ${details}. 실제로 새 커밋을 만든 뒤 정확한 SHA 를 반환하세요.`,
  };
}

// issue #3: fix 세션의 "이미 반영돼 있음"(status:"already_applied") 근거 커밋 검증.
// 세션이 아무 일도 하지 않고 통과하는 우회를 막는 세 조건을 전부 요구한다:
//   (1) 실재하는 커밋이고 (2) PR 브랜치(headRef)에서 도달 가능하며 (3) base_branch 에는 **없다**
//   — (3) 이 없으면 최초 커밋 SHA 하나만 대면 어떤 코멘트든 "이미 반영됨"으로 넘길 수 있다.
//   base 는 로컬 브랜치를 먼저, 없으면 origin/<base> 를 본다. 둘 다 없으면 fail-closed(거부) —
//   "검사를 못 했다"를 "통과"로 접지 않는다(§30 P4).
// merge-base --is-ancestor 의 종료 코드 규약: 0=조상, 1=조상 아님, 그 외=오류 — 문자열 스니핑이
// 아니라 종료 코드로 세 상태를 구분한다(§30 P3).
async function resolveRef(cwd: string, ref: string): Promise<boolean> {
  const r = await execGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd);
  return r.exitCode === 0 && !r.timedOut && !r.spawnErrorCode;
}

export const defaultAlreadyAppliedCommit = async (
  cwd: string,
  sha: string,
  headRef: string,
  baseBranch: string,
): Promise<CommitCheck> => {
  const exist = await defaultVerifyCommit(cwd, sha, null); // 존재 검증만(headBefore=null)
  if (!exist.ok) return exist;
  const reach = await defaultBranchReachable(cwd, sha, headRef);
  if (!reach.ok) return reach;
  const baseRef = (await resolveRef(cwd, baseBranch)) ? baseBranch
    : (await resolveRef(cwd, `origin/${baseBranch}`)) ? `origin/${baseBranch}` : null;
  if (baseRef === null) {
    return {
      ok: false,
      reason: `base 브랜치(${baseBranch} / origin/${baseBranch})를 로컬에서 확인할 수 없어 "이미 반영됨" 근거를 검증하지 못했습니다`,
    };
  }
  const inBase = await execGit(["merge-base", "--is-ancestor", sha, baseRef], cwd);
  if (inBase.spawnErrorCode) return { ok: false, reason: `git 실행 실패(${inBase.spawnErrorCode})` };
  if (inBase.timedOut) return { ok: false, reason: "git merge-base 명령이 타임아웃(60초)됐습니다" };
  if (inBase.exitCode === 0) {
    return {
      ok: false,
      reason: `커밋(${sha})은 base 브랜치(${baseRef})에 이미 있는 커밋입니다 — 이 PR 이 만든 변경의 근거가 될 수 없습니다`,
    };
  }
  if (inBase.exitCode !== 1) {
    return { ok: false, reason: `git 오류(리포 상태를 확인하세요): ${inBase.stderr.trim().slice(0, 300)}` };
  }
  return { ok: true };
};

// issue #3: verifySessionCommits 와 대칭 — already_applied 결과의 commits(근거 SHA)를 검증한다.
// 빈 배열은 "근거 없음"으로 즉시 거부한다(세션이 SHA 없이 "이미 반영됨"만 주장하는 것은 no-op
// 세탁이다). 원소의 선행 hex 토큰만 뽑는 관용은 verifySessionCommits 와 동일한 이유(§51).
export async function verifyAlreadyAppliedCommits(
  cwd: string,
  headRef: string,
  baseBranch: string,
  commits: string[],
  deps: OrchestratorDeps,
): Promise<{ ok: true } | { ok: false; problem: string }> {
  if (commits.length === 0) {
    return {
      ok: false,
      problem: "\"이미 반영됨\" 의 근거 커밋이 없습니다. 반영이 담긴 커밋 SHA 를 commits 에 넣어 already_applied 를 반환하거나, 실제로 반영해 커밋한 뒤 done 을 반환하세요.",
    };
  }
  const normalized = commits.map(c => {
    const m = c.trim().match(/^([0-9a-f]{7,40})\b/i);
    return m ? m[1]! : c;
  });
  const check = deps.alreadyAppliedCommit ?? defaultAlreadyAppliedCommit;
  const results = await Promise.all(normalized.map(sha => check(cwd, sha, headRef, baseBranch)));
  const failedIdx = results.reduce<number[]>((acc, r, i) => (r.ok ? acc : [...acc, i]), []);
  if (failedIdx.length === 0) return { ok: true };
  const details = failedIdx.map(i => `${normalized[i]}: ${results[i].reason ?? "검증 실패"}`).join("; ");
  return {
    ok: false,
    problem: `"이미 반영됨" 근거 커밋 검증 실패 — ${details}. PR 브랜치 이력에 실재하는 커밋 SHA 만 근거로 제시하세요.`,
  };
}

// §24 감사 S1: verify 명령이 참조하는 파일이 이번 phase 에서 바뀌었는지 확인하기 위한 diff 목록.
// 실패 시 빈 배열을 반환하면 "검사했더니 변경 없음"과 구분이 안 돼, git 오류가 그대로 검사 무력화로
// 이어진다(정확히 이 위조를 막으려는 기능이 그 자체 오류로 우회되는 셈) — 그래서 실패는 reject 로
// 구분한다. 호출부(runWorkflow)가 이를 catch 해 "검사 불가"로 로그만 남기고 진행할지 결정한다.
// §z-parse Phase 2(D8): `-z` 추가 + `split("\0")` — 기존 `split("\n").map(trim).filter(Boolean)`
// 의 `.trim()` 을 제거했다. 개행으로 시작·끝나는 실제 파일명(이번 -z 전환이 다루려는 핵심 케이스)이
// 있으면 trim 이 그 경계 개행을 조용히 잘라내 changed 목록에 손상된 경로가 담긴다 — 이후
// orchestrator.ts/prloop.ts 의 tamper 비교(normalizeGitSourcePath, 무trim)가 아무리 정확해도
// changed 쪽 원본이 이미 훼손된 뒤라 미탐(위조 파일을 못 잡음) 방향으로 어긋난다. `filter(s =>
// s.length > 0)` 는 트레일링 NUL 이 만드는 빈 세그먼트만 걸러낸다(원본 미trim 세그먼트 기준).
//
// §tamper-gap(z-parse 후속) P1/P3/D5: `--no-renames` 를 추가했다 — rename/copy 유사도 탐지 자체를
// 꺼서 `--name-only` 가 OLD/NEW 를 별도의 D(삭제)+A(추가) 세그먼트로 자연 노출한다. 이전에는 rename
// 된 guarded 파일의 OLD 경로가 changed 에 안 잡혀(--name-only 가 rename 을 "NEW 경로 하나"로만
// 보고) 세션이 verify 참조 파일을 git mv 로 옮기면 tamper 대조가 미탐했다(P1). `--no-renames` 채택
// 덕분에 rename/copy record(R100/C100 등) 필드 개수를 파싱하는 코드 자체가 이 구현에는 존재하지
// 않는다 — P3(copy 소스는 changed 에 포함하지 않는다)도 별도 처리 없이 자동 충족된다: copy 소스는
// 내용이 바뀌지 않으므로 애초에 M/A/D 어느 세그먼트에도 나타나지 않는다. (구현 중 실측: 로컬
// `diff.renames=copies` 를 강제로 켠 상태에서도 `--no-renames` 가 우선해 rename/copy 를 전부
// D+A/변경없음으로 분해함을 실제 git 으로 확인 — NOTES.md 기록.)
//
// §tamper-gap P1/P2/P5: git 이 exit 0 으로 성공했지만 출력을 신뢰할 수 없는 경우(현재 유일한
// 트리거: 디코딩 결과에 U+FFFD 대체 문자가 섞인 경로)는 인프라 오류(위 throw, §25 C1 fail-open)와
// 분리해 ok:false(reason:"invalid_utf8")로 반환한다 — 같은 catch 로 합류시키지 않는다(P1). U+FFFD
// 는 이 changed 목록 **전체**(guarded 여부 무관)를 스캔해 감지한다(E6 — guarded 파일 뒤에 깨진
// 이름을 숨겨 우회하는 표면을 만들지 않기 위해 넓은 스캔 범위를 의도적으로 유지한다).
//
// gitExec 는 §26 C1/§29 CR-2 등 이 파일의 다른 export 함수들과 달리 기존에는 주입 지점이 없었다
// (E8) — U+FFFD 테스트가 실제 비-UTF8 바이트 파일명을 만들 수 없는 플랫폼(macOS APFS 가 유효하지
// 않은 UTF-8 파일명 생성을 거부, E2)에서도 이 배선(감지 로직이 아니라 defaultChangedFiles 자체가
// ok:false 를 내는 것)을 검증할 수 있도록 선택 파라미터로 추가했다. 기본값은 실제 execGit 이라
// 기존 호출부(`(deps.changedFiles ?? defaultChangedFiles)(cwd, sinceSha)`, 인자 2개)는 그대로다.
export const defaultChangedFiles = async (
  cwd: string,
  sinceSha: string,
  gitExec: (args: string[], cwd: string) => Promise<GitExecResult> = execGit,
): Promise<ChangedFilesResult> => {
  const r = await gitExec(["diff", "--no-renames", "--name-only", "-z", `${sinceSha}..HEAD`], cwd);
  if (r.spawnErrorCode) {
    throw new Error(`git 실행 실패(${r.spawnErrorCode}) — git 이 설치되어 있는지 확인하세요`);
  }
  if (r.timedOut) {
    throw new Error("git diff 명령이 타임아웃(60초)됐습니다");
  }
  if (r.exitCode !== 0) {
    throw new Error(`git diff 오류(리포 상태를 확인하세요): ${r.stderr.trim().slice(0, 300)}`);
  }
  const files = r.stdout.split("\0").filter(s => s.length > 0);
  const invalid = files.filter(f => f.includes("�"));
  if (invalid.length > 0) {
    return { ok: false, reason: "invalid_utf8", paths: invalid };
  }
  return { ok: true, files };
};

// §tamper-gap D3/D8: guarded 파일이 tampered 로 판정됐을 때 "무엇이 어떻게 바뀌었는지"를
// 구분한다 — 같은 문구("검증 대상 파일을 수정했습니다")로 뭉뚱그리면, rename/삭제로 그 경로에
// 파일이 더 이상 없는데도 "수정을 되돌리라"는 실제 상태와 어긋난 지시가 나가 무인 세션이 잘못된
// 복구를 시도하거나 회송 루프에 빠질 수 있다(§51 실측과 같은 클래스, P4). OLD→NEW 매핑 배관은
// 하지 않는다(D3(A)) — `--no-renames` 채택으로 그 매핑 자체가 존재하지 않고, 다음 세션은 리포
// 안에서 git log/status 로 목적지를 스스로 조사할 수 있다.
export function describeGuardedFileState(cwd: string, relPath: string): "modified" | "moved_or_deleted" {
  return fs.existsSync(path.join(cwd, relPath)) ? "modified" : "moved_or_deleted";
}

// orchestrator.ts(phase 루프)와 prloop.ts(fix 루프) 양쪽이 이 포맷터 하나를 공유한다(D8, §30 P1 —
// 같은 문구 조립을 복붙하면 다음 라운드에 갈린다는 이 하네스의 반복된 교훈). 각 줄은
// displayPath(JSON 문자열 리터럴)로 가역 표기한다 — 다음 세션이 JSON.parse 로 원본 파일명을
// 정확히 재구성할 수 있게 한다(기존 tamper 문구 관례 그대로 유지, escapeControlChars 류 신규
// 이스케이프 함수는 만들지 않는다 — E18).
export function formatGuardedFileLines(cwd: string, tampered: string[]): string[] {
  return tampered.map(f => {
    const label = describeGuardedFileState(cwd, f) === "modified" ? "수정됨" : "이동/삭제됨(원래 경로로 복원)";
    return `${label}: ${displayPath(f)}`;
  });
}

// workBranch: isolate/require-topic 에서 세션이 계속 머물러야 하는 브랜치 이름. null 이면(git 저장소가
// 아님/branch_strategy=current) 이후 attempt 마다 이탈 감시·커밋 도달성 검증을 하지 않는다 —
// "current" 전략은 사용자에게 브랜치 자유를 위임하는 설계라(§ 메모: 브랜치 전략 강제 금지) 의도적으로
// 감시 대상에서 뺀다.
type BranchStrategyOutcome = { ok: true; workBranch: string | null } | { ok: false; problem: string };

// §68: 격리 브랜치 이름 규칙의 유일한 정의처 — applyBranchStrategy(생성)와
// refreshIsolationBranchAfterMerge(머지 후 재생성)가 서로 다른 이름을 계산하면 "만든 브랜치와
// 리셋하는 브랜치가 다른" 사고가 나므로 한 함수로 모은다. 구 이름은 `fw/<workflow>` 였는데
// 사용자 결정으로 start 단계가 만드는 토픽 브랜치(`feature/<티켓ID>` 등)와 접두를 통일했다.
// 주의: 이 접두 변경으로 "start 가 만든 feature/X 위에서 isolate 로 돌다 base 로 돌아가 재실행"
// 하면 하네스가 feature/<workflow> 를 새로 만들 수 있다 — 같은 네임스페이스를 공유하는 대가로,
// 파괴적 재생성(refreshIsolationBranchAfterMerge)은 기존 가드(HEAD 일치 + 미push 커밋 0)가
// 그대로 지킨다.
export function isolationBranchName(workflow: string): string {
  return `feature/${workflow}`;
}

// ── pr-slicing D3/D12: 조각 브랜치 이름 ──────────────────────────────────────
// 조각 브랜치는 통합 브랜치 이름에서 **하이픈으로** 파생한다: `<통합브랜치>-<순번>`.
// 슬래시로 파생하면 안 된다 — git 은 ref 를 파일/디렉토리로 저장하므로 통합 브랜치
// `feature/X` 가 존재하는 상태에서는 `feature/X/1` 을 만들 수 없다(D/F 충돌, 실측):
//   fatal: cannot lock ref 'refs/heads/feature/PROJ-123/1':
//          'refs/heads/feature/PROJ-123' exists; cannot create 'refs/heads/feature/PROJ-123/1'
// 하이픈 파생은 접두를 통합 브랜치에서 그대로 물려받으므로 사용자가 정한 브랜치 관례
// (`feature/`·`topic/`·무엇이든)를 자동으로 따라간다 — 접두 설정값(`pr_head_prefix`)을
// 별도로 두지 않는 근거다(D12).

/**
 * `git check-ref-format refs/heads/<name>` 과 동일한 판정. 통합 브랜치 이름은 사람이
 * STATE.json 에 직접 적을 수 있어(하네스가 만든 이름만 오는 것이 아니다) 파생 **전에**
 * 검증해야 한다 — 검증 없이 파생하면 "하네스는 통과시켰는데 git 이 거부" 하는 실패가 무인
 * 주행 중에 난다. 규칙 표류를 막기 위해 test/slicebranch.test.ts 가 실제 git 과 대조한다.
 *
 * 기준을 `--branch` 모드가 아니라 `refs/heads/<name>` 으로 잡은 이유: `--branch` 는 `@{-1}`
 * 같은 **이전 브랜치 단축 표기까지 확장해서** 받으므로 순수한 이름 검증기가 아니다.
 *
 * git 보다 엄격하게 굴지 않는다 — 예를 들어 `@` 한 글자는 git 이 실제로 브랜치로 만들어주므로
 * (실측 확인) 여기서도 통과시킨다. 브랜치 이름 관례는 사용자에게 위임한다는 원칙이 우선이고,
 * 하네스가 git 보다 좁게 막으면 정상 사용이 조용히 실패한다.
 *
 * **의도적 divergence 하나**: 선행 하이픈(`-x`)은 `check-ref-format` 이 통과시키지만 `git
 * branch`/`git checkout -B` 는 이를 옵션으로 파싱해 `--` 를 붙여도 거부한다(실측 —
 * `fatal: '-x' is not a valid branch name`). 하네스는 **실제로 만들 수 있는 이름**만 유효로
 * 봐야 하므로 이 부류만 거부한다. test/slicebranch.test.ts 가 그 근거(git 이 실제로 거부하는
 * 것)를 실측으로 못박아, git 이 나중에 허용하게 바뀌면 테스트가 깨져 재검토하게 한다.
 */
export function isValidGitBranchName(name: string): boolean {
  if (name.length === 0) return false;
  if (name.startsWith("-")) return false; // 위 divergence — git CLI 가 옵션으로 파싱한다
  if (name.includes("..") || name.includes("@{")) return false;
  // ASCII 제어문자·공백·git 이 리비전 문법에 쓰는 문자
  if (/[\x00-\x1f\x7f ~^:?*[\\]/.test(name)) return false;
  if (name.endsWith(".")) return false;
  // 선행·후행 `/` 와 `//` 는 빈 세그먼트를 만들므로 아래 seg.length 검사가 함께 잡는다
  // (별도 검사를 두면 어느 규칙이 실제로 동작하는지 흐려진다 — 검토에서 지적된 중복 방어).
  return name
    .split("/")
    .every(seg => seg.length > 0 && !seg.startsWith(".") && !seg.endsWith(".lock"));
}

/** 통합 브랜치 이름과 조각 순번으로 조각 브랜치 이름을 만든다. 파생 결과가 git 브랜치
 *  이름으로 유효하지 않으면 던진다 — 조용히 잘못된 이름을 반환하지 않는다. */
export function sliceBranchName(integrationBranch: string, seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 1) {
    throw new Error(`조각 순번은 1 이상의 정수여야 합니다: ${seq}`);
  }
  if (integrationBranch.trim().length === 0) {
    throw new Error("통합 브랜치 이름이 비어 있습니다");
  }
  if (!isValidGitBranchName(integrationBranch)) {
    throw new Error(`git 브랜치 이름으로 쓸 수 없습니다: ${JSON.stringify(integrationBranch)}`);
  }
  const name = `${integrationBranch}-${seq}`;
  if (!isValidGitBranchName(name)) {
    throw new Error(`파생한 조각 브랜치 이름이 git 브랜치 이름으로 유효하지 않습니다: ${JSON.stringify(name)}`);
  }
  return name;
}

// ── pr-slicing D15: base 브랜치 감지 ────────────────────────────────────────
// `fw init` 이 base_branch 를 "main" 으로 하드코딩하던 것을 대체한다. git flow 리포
// (develop ← feature/*)에서 main 이 박히면 PR 이 통합 대상이 아닌 곳으로 가고, 조각 분해가
// 들어가면 잘못된 base 의 PR 이 phase 당 여러 개 생겨 피해가 배로 커진다.
//
// 규칙은 `/start` 스킬(commands/start.md)에 산문으로만 있던 것을 여기로 옮긴 것이다 — 같은
// 판단이 스킬 프롬프트와 하네스 두 곳에 있으면 다음 라운드에 갈린다(§30 P1). **develop 이
// origin/HEAD 보다 우선한다**: git flow 리포의 origin/HEAD 는 보통 main/master 를 가리키지만
// 실제 통합 대상은 develop 이다.

export interface BaseBranchDetection {
  branch: string;
  source: "develop" | "origin-head" | "fallback";
  /** 사람에게 보여줄 감지 근거 한 줄(개행 없음). "감지했다/못 했다"를 조용히 삼키지 않기
   *  위한 관측 필드다(§30 P4) — 호출부가 그대로 출력한다. */
  reason: string;
  /**
   * 폴백일 때 그 사유(성공 경로에서는 undefined). 소비처(`fw doctor` 진단 등)가 reason
   * **문자열 매칭**에 의존하지 않도록 기계가 읽는 코드를 따로 둔다 — 문구는 다듬을 수 있어야
   * 하고, 문구에 기대는 소비처가 생기면 다듬을 때 조용히 깨진다.
   *  - "not-a-repo": git 저장소가 아니거나 git 을 실행할 수 없다(인프라 오류)
   *  - "dangling-origin-head": origin/HEAD 가 실재하지 않는 브랜치를 가리킨다
   *  - "no-signal": 정상 리포인데 감지할 신호가 없다(정상적인 음성 판정)
   */
  fallbackReason?: "not-a-repo" | "dangling-origin-head" | "no-signal";
}

const FALLBACK_BASE_BRANCH = "main";
const ORIGIN_HEAD_REF_PREFIX = "refs/remotes/origin/";

export async function detectBaseBranch(
  cwd: string,
  git: (args: string[], cwd: string) => Promise<CliExecResult>,
): Promise<BaseBranchDetection> {
  const refExists = async (ref: string): Promise<boolean> =>
    (await git(["show-ref", "--verify", "--quiet", ref], cwd)).ok;

  if (await refExists("refs/heads/develop")) {
    return { branch: "develop", source: "develop", reason: "로컬에 develop 브랜치가 있어 git flow 로 판단했습니다" };
  }
  if (await refExists(`${ORIGIN_HEAD_REF_PREFIX}develop`)) {
    return { branch: "develop", source: "develop", reason: "origin 에 develop 브랜치가 있어 git flow 로 판단했습니다" };
  }

  // origin/HEAD 가 가리키는 이름이 **실재하는지**까지 확인한다. 형식만 보면 안 되는 이유(검토
  // 실측): 원격이 master→main 으로 rename 된 뒤 `git fetch --prune` 을 하면 origin/master 는
  // 사라지는데 origin/HEAD 는 여전히 그것을 가리키고 `symbolic-ref` 는 exit 0 을 낸다(dangling
  // 심볼릭 ref — rename 후 흔하다). 그 상태에서 형식만 통과시키면 실재하지 않는 브랜치를
  // 확신 있는 문구와 함께 base_branch 로 확정하고, 그 오판은 하류 전체(격리 브랜치 판정·PR
  // 커밋 목록·머지 후 재생성)에서 서로 다른 문구의 실패로 흩어져 원인 추적이 어렵다.
  // develop 경로는 처음부터 show-ref 로 실존을 확인했는데 이 경로만 빠져 있던 비대칭이었다.
  let danglingTarget: string | null = null;
  const head = await git(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd);
  if (head.ok) {
    const ref = head.stdout.trim();
    if (ref.startsWith(ORIGIN_HEAD_REF_PREFIX)) {
      const branch = ref.slice(ORIGIN_HEAD_REF_PREFIX.length);
      // 형식이 어긋나면(빈 이름·유효하지 않은 ref 이름) 조용히 쓰지 않는다.
      if (branch.length > 0 && isValidGitBranchName(branch)) {
        if (await refExists(ref)) {
          return {
            branch,
            source: "origin-head",
            reason: `원격 기본 브랜치(origin/HEAD → ${branch})를 base 로 정했습니다`,
          };
        }
        danglingTarget = branch;
      }
    }
  }

  return fallbackBaseBranch(cwd, git, danglingTarget);
}

// 폴백 사유를 구분한다. 예전에는 git 의 모든 실패를 "브랜치 없음"으로 접어 "git 저장소가
// 아님"·"git 실행 불가"·"정말 감지 실패"가 전부 같은 문구로 수렴하고, 원인과 무관한 교정
// 지시("git flow 리포라면 develop 으로 고치세요")를 냈다(검토 실측). 이 파일의
// isRepoLevelGitError(:57)·spawnErrorCode(:24) 가 이미 "인프라 오류와 정상적인 음성 판정을
// 섞지 않는다"는 규율을 세워 뒀는데 이 함수만 그것을 따르지 않았다.
//
// 리포 여부 판정에 stderr 문자열 매칭을 쓰지 않는 이유: 이 함수가 받는 git 실행기는
// preflight.ts 의 run() 계열이라 branch.ts 의 execGit 과 달리 LC_ALL=C 를 강제하지 않는다 —
// 영문 패턴은 로케일에 따라 조용히 깨진다(한국어 환경에서 "fatal: 리모트 저장소에서 읽을
// 수 없습니다" 로 실측됨). 종료 코드만 보는 `rev-parse --git-dir` 로 판정한다.
async function fallbackBaseBranch(
  cwd: string,
  git: (args: string[], cwd: string) => Promise<CliExecResult>,
  danglingTarget: string | null,
): Promise<BaseBranchDetection> {
  if (danglingTarget !== null) {
    return {
      branch: FALLBACK_BASE_BRANCH,
      source: "fallback",
      fallbackReason: "dangling-origin-head",
      reason:
        `origin/HEAD 가 실재하지 않는 브랜치(${danglingTarget})를 가리켜 ${FALLBACK_BASE_BRANCH} 로 ` +
        "두었습니다 — `git remote set-head origin -a` 로 고친 뒤 base_branch 를 확인하세요",
    };
  }
  // 폴백 경로에서만 묻는다 — 정상 경로에 git 왕복을 늘리지 않는다.
  if (!(await git(["rev-parse", "--git-dir"], cwd)).ok) {
    return {
      branch: FALLBACK_BASE_BRANCH,
      source: "fallback",
      fallbackReason: "not-a-repo",
      reason:
        `git 저장소가 아니거나 git 을 실행할 수 없어 base 브랜치를 정하지 못했습니다 — ` +
        `${FALLBACK_BASE_BRANCH} 로 두었습니다. --repo 경로와 git 설치를 확인하세요`,
    };
  }
  return {
    branch: FALLBACK_BASE_BRANCH,
    source: "fallback",
    fallbackReason: "no-signal",
    reason:
      `base 브랜치를 감지하지 못해 ${FALLBACK_BASE_BRANCH} 로 두었습니다 — ` +
      "git flow 리포라면 STATE.json 의 base_branch 를 develop 으로 고치세요",
  };
}

// §26 I4: 브랜치 존재 판정에 `git rev-parse --verify --quiet <name>` 을 쓰면 그 이름의 rev 를 폭넓게
// (브랜치 아닌 태그·커밋 등도) 해석해버려, 동명 태그가 있으면 "브랜치가 존재한다"고 오판하고
// `git checkout <name>`(브랜치 전환이 아니라 태그 체크아웃)이 detached HEAD 로 이어진다.
// `git show-ref --verify --quiet refs/heads/<name>` 은 refs/heads/ 네임스페이스만 봐서 이 오판이 없다.
async function branchRefExists(
  git: (args: string[], cwd: string) => Promise<CliExecResult>,
  cwd: string,
  branchName: string,
): Promise<boolean> {
  const r = await git(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], cwd);
  return r.ok;
}

// ── pr-slicing Phase 2: 조각 브랜치 생성 ──────────────────────────────────────
// 세션은 통합 브랜치가 아니라 **조각 브랜치**에서 작업·커밋한다(PLAN D2). 조각마다 통합
// 브랜치에서 새로 딴다.
//
// **파괴적 재생성(`checkout -B`)을 쓰지 않는다.** PLAN 의 Phase 2 지시서는 `-B` 를 적어
// 뒀지만, 검토가 실측한 이름 충돌(워크플로우 `wf` 의 조각 1 = 워크플로우 `wf-1` 의 통합
// 브랜치, 같은 ref)을 감안하면 `-B` 는 남의 브랜치를 말없이 덮는 도구가 된다. 이름 규칙으로는
// 이 충돌을 막을 수 없으므로(`isValidWorkflowName` 이 하이픈·숫자·점을 모두 허용해 어떤
// 구분자를 써도 같은 충돌이 생기고, `/` 는 D/F 충돌로 돌아간다) **소유권 확인이 유일한
// 방어**다. 확인에 실패하면 덮지 않고 사람에게 돌린다.
//
// 소유권 판정: 통합 브랜치 tip 이 그 브랜치의 조상이어야 한다(= 그 브랜치가 통합 브랜치
// 위에 얹혀 있어야 한다). 우리가 앞선 시도에서 만든 조각 브랜치는 이 조건을 만족하고,
// 다른 워크플로우의 통합 브랜치는 이력이 갈라져 만족하지 않는다.
export async function createSliceBranch(opts: {
  cwd: string;
  integrationBranch: string;
  seq: number;
  git: (args: string[], cwd: string) => Promise<CliExecResult>;
  log?: (msg: string) => void;
}): Promise<{ ok: true; branch: string } | { ok: false; problem: string }> {
  const { cwd, integrationBranch, seq, git } = opts;
  const log = opts.log ?? (() => {});

  let branch: string;
  try {
    branch = sliceBranchName(integrationBranch, seq);
  } catch (err) {
    // sliceBranchName 은 던지는 계약이지만 이 함수는 던지지 않는다 — 호출부(orchestrator)가
    // 다른 실패와 같은 방식으로 다룰 수 있어야 한다.
    return { ok: false, problem: `조각 브랜치 이름을 만들 수 없습니다: ${(err as Error).message}` };
  }

  if (!(await branchRefExists(git, cwd, integrationBranch))) {
    return {
      ok: false,
      problem: `통합 브랜치(${integrationBranch})가 로컬에 없어 조각 브랜치를 만들 수 없습니다.`,
    };
  }

  if (!(await branchRefExists(git, cwd, branch))) {
    // §41 I-4: `--no-track` 필수. 생략하면 시작점이 로컬 브랜치여도 branch.autoSetupMerge
    // 설정에 따라 upstream 이 붙어, 조각 브랜치 위에서 사람이 친 push/pull 이 엉뚱한 곳으로 간다.
    const create = await git(["checkout", "-b", branch, "--no-track", integrationBranch], cwd);
    if (!create.ok) {
      return { ok: false, problem: `조각 브랜치(${branch}) 생성 실패: ${create.stderr.trim().slice(0, 300)}` };
    }
    return { ok: true, branch };
  }

  // 이미 그 이름의 브랜치가 있다 — 소유권을 확인한다.
  const owned = await git(["merge-base", "--is-ancestor", integrationBranch, branch], cwd);
  if (!owned.ok) {
    // 원인을 단정하지 않는다(§30 P5) — 확인된 사실은 "통합 브랜치 위에 얹혀 있지 않다" 뿐이고,
    // 그 이유는 다른 워크플로우 소유일 수도, 이미 머지된 옛 조각일 수도, git 오류일 수도 있다.
    return {
      ok: false,
      problem:
        `조각 브랜치 이름(${branch})이 이미 쓰이고 있고, 그 브랜치가 통합 브랜치(${integrationBranch}) ` +
        "위에 얹혀 있지 않아 덮지 않았습니다. 다른 워크플로우의 브랜치이거나 이미 머지된 옛 조각일 " +
        `수 있습니다 — \`git log ${branch}\` 로 확인한 뒤, 남겨둘 것이면 이름을 바꾸거나 삭제하고 다시 실행하세요.`,
    };
  }

  const checkout = await git(["checkout", branch], cwd);
  if (!checkout.ok) {
    return { ok: false, problem: `조각 브랜치(${branch}) 체크아웃 실패: ${checkout.stderr.trim().slice(0, 300)}` };
  }
  log(`조각 브랜치(${branch})가 이미 있어 그대로 이어서 씁니다 — 앞선 시도의 커밋은 보존됩니다.`);
  return { ok: true, branch };
}

// ── pr-slicing Phase 2: 머지 후 통합 브랜치 전진 ────────────────────────────
// 조각 PR 이 통합 브랜치로 머지되면 로컬 통합 브랜치도 그 상태를 따라가야 한다 — 그러지
// 않으면 다음 조각이 낡은 기준에서 갈라져 나가 조각 PR diff 에 앞 조각이 다시 담긴다
// (§26 M5 가 옛 토폴로지에서 고치려던 것과 같은 증상).
//
// **파괴적 리셋을 쓰지 않는다** — 그리고 새 토폴로지에서는 쓸 필요가 없다.
// refreshIsolationBranchAfterMerge(아래)가 `checkout -B ... --no-track origin/<base>` 로
// 브랜치를 강제 재생성하고 그 위험을 안전 가드 세 겹으로 막아야 했던 이유는, **옛
// 토폴로지에서는 하네스가 격리 브랜치에 직접 커밋했기** 때문이다: squash 머지되면
// origin/<base> 에는 내용만 반영되고 원본 커밋이 없어 로컬 브랜치가 원격의 조상이 아니게
// 되고(비-fast-forward), 강제 재생성 말고는 누적을 끊을 방법이 없었다.
//
// 새 토폴로지에서 세션은 **조각 브랜치**에서만 커밋한다(D2). 통합 브랜치는 원격에서
// 일어나는 머지로만 전진하므로 로컬 통합 브랜치는 항상 원격의 조상이고, 따라서
// `git fetch origin <int>:<int>` 가 강제 없이 성공한다 — squash 머지에서도 그렇다(실측
// 확인, test/branch.test.ts 가 그 사실 자체를 못박는다). 결과적으로 이 함수에는 데이터
// 손실 경로가 아예 없다: fast-forward 가 아니면 git 이 스스로 거부하고, 우리는 그 실패를
// 흡수해 "누적 PR 로 퇴화" 할 뿐이다(기존 함수의 안전 가드가 하던 역할을 git 이 대신한다).
export async function advanceIntegrationBranchAfterMerge(opts: {
  cwd: string;
  integrationBranch: string;
  git: (args: string[], cwd: string) => Promise<CliExecResult>;
  log?: (msg: string) => void;
}): Promise<{ advanced: boolean; reason?: string }> {
  const { cwd, integrationBranch, git } = opts;
  const log = opts.log ?? (() => {});

  // git 은 **현재 체크아웃된 브랜치**로의 fetch 를 거부한다. 그 상황이면 raw git 오류를
  // 흘리는 대신 무엇이 잘못됐는지 말해주고 건너뛴다(정상 주행에서는 HEAD 가 조각 브랜치에 있다).
  const headRes = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (headRes.ok && headRes.stdout.trim() === integrationBranch) {
    const reason =
      `HEAD 가 통합 브랜치(${integrationBranch}) 위에 있어 전진을 건너뜁니다 — ` +
      "조각 브랜치에서 실행되어야 합니다.";
    log(reason);
    return { advanced: false, reason };
  }

  // 강제 옵션(`+`/`--force`)을 쓰지 않는 것이 이 함수의 안전 계약이다.
  const fetched = await git(["fetch", "origin", `${integrationBranch}:${integrationBranch}`], cwd);
  if (!fetched.ok) {
    const reason =
      `통합 브랜치(${integrationBranch}) 전진 실패 — 다음 조각 PR 에 앞 조각의 diff 가 함께 ` +
      `담길 수 있습니다: ${fetched.stderr.trim().slice(0, 300)}`;
    log(reason);
    return { advanced: false, reason };
  }
  log(`통합 브랜치(${integrationBranch})를 origin 기준으로 전진시켰습니다.`);
  return { advanced: true };
}

// §19/§26: branch_strategy 판정. preflight 가 이미 확인한 currentBranch/detached 를 재사용한다(git 을
// 두 번 묻지 않는다). currentBranch 가 null 이고 detached 도 아니면(git 저장소가 아님 등) preflight 가
// 이미 그 문제를 FAILED 로 걸렀어야 하므로 여기서는 방어적으로 통과시킨다.
export async function applyBranchStrategy(
  state: State,
  branchInfo: { currentBranch: string | null; detached: boolean },
  deps: { git: (args: string[], cwd: string) => Promise<CliExecResult>; log: (msg: string) => void },
): Promise<BranchStrategyOutcome> {
  const { currentBranch, detached } = branchInfo;
  if (currentBranch === null && !detached) return { ok: true, workBranch: null };

  if (state.branch_strategy === "current") {
    // §26 I4: detached 여도 "current" 전략은 사용자에게 위임한다 — 강제하지 않는다.
    if (!detached && currentBranch === state.base_branch) {
      deps.log(
        `경고: branch_strategy=current 인데 현재 브랜치(${currentBranch})가 base_branch(${state.base_branch}) 와 ` +
          "같습니다 — 세션이 이 브랜치에 직접 커밋합니다.",
      );
    }
    // "current" 는 이탈 감시 대상에서 제외한다(workBranch: null) — 사용자가 브랜치를 자유롭게 쓴다.
    return { ok: true, workBranch: null };
  }

  if (state.branch_strategy === "require-topic") {
    // §26 I4: detached HEAD 는 "토픽 브랜치에 있다"고 볼 수 없다 — 세션 없이 거부한다.
    if (detached) {
      return {
        ok: false,
        problem:
          "detached HEAD 상태입니다 (branch_strategy=require-topic). 토픽 브랜치를 만들어 체크아웃한 뒤 " +
          "다시 실행하세요.",
      };
    }
    if (currentBranch === state.base_branch) {
      return {
        ok: false,
        problem:
          `base_branch(${state.base_branch}) 에서 직접 실행할 수 없습니다 (branch_strategy=require-topic). ` +
          "토픽 브랜치를 만들어 체크아웃한 뒤 다시 실행하거나, branch_strategy 를 isolate 로 바꾸세요.",
      };
    }
    return { ok: true, workBranch: currentBranch };
  }

  // isolate (기본값 — "topic" 별칭도 state.ts 에서 여기 도달하기 전에 isolate 로 정규화된다)
  if (!detached && currentBranch !== state.base_branch) {
    return { ok: true, workBranch: currentBranch }; // 이미 base_branch 가 아닌 브랜치에 있음 — 그대로 진행
  }

  // 여기 도달 = base_branch 위에 있거나(§19), detached HEAD(§26 I4) — 둘 다 격리 브랜치가 필요하다.
  const branchName = isolationBranchName(state.workflow);
  // 이미 그 이름의 브랜치가 있으면 체크아웃, 없으면 새로 만든다 — 재실행/재개 시 매번 새
  // 브랜치를 만들려다 "이미 존재함" 오류로 실패하지 않게 한다.
  const exists = await branchRefExists(deps.git, state.repo_root, branchName);
  const checkoutArgs = exists ? ["checkout", branchName] : ["checkout", "-b", branchName];
  const checkout = await deps.git(checkoutArgs, state.repo_root);
  if (!checkout.ok) {
    return {
      ok: false,
      problem: `격리 브랜치(${branchName}) 체크아웃에 실패했습니다: ${checkout.stderr.trim().slice(0, 300)}`,
    };
  }
  deps.log(
    `branch_strategy=isolate — ${detached ? "detached HEAD 상태라" : `현재 브랜치가 base_branch(${state.base_branch}) 와 같아`} ` +
      `${branchName} 로 ${exists ? "체크아웃했습니다" : "새로 만들어 체크아웃했습니다"}.`,
  );
  return { ok: true, workBranch: branchName };
}

// §26 M5: isolate 전략에서는 모든 phase 가 같은 로컬 격리 브랜치(feature/<workflow>)를 공유한다. PR 게이트는
// phase 마다 그 시점의 HEAD 를 fw/phase-<id> 로 push 해 PR(base=state.base_branch)을 만드는데, merge
// commit/ff 머지면 merge-base 가 그 phase 의 tip 이라 다음 phase PR 의 diff 는 그 phase 만 담긴다.
// 하지만 squash/rebase 머지(사내 GHE 에서 흔함)면 base_branch 에는 phase 의 "내용"만 반영되고 "원본
// 커밋"은 없어 merge-base 가 워크플로우 시작점으로 밀려버린다 — 다음 phase 의 PR 에 이전 phase 의
// 커밋+diff 가 통째로 다시 담긴다(리뷰어가 이미 머지된 변경을 다시 봄). merged 판정 직후 로컬 격리
// 브랜치를 갱신된 base 위로 재생성해 이 누적을 끊는다.
// 사용자 소유 브랜치(current/require-topic, 또는 isolate 라도 이미 사용자 브랜치에 있던 경우)는
// 절대 건드리지 않는다 — 하네스가 남의 브랜치를 리셋해선 안 된다는 원칙(사용자 피드백으로 확립)이
// squash 대응보다 우선한다. 이 경우는 힌트 로그만 남긴다.
export async function refreshIsolationBranchAfterMerge(
  state: State, phase: Phase, workBranch: string | null, headBranch: string, deps: OrchestratorDeps,
): Promise<void> {
  // 조건 2: 이 phase 뒤에 실행할 phase 가 없으면(마지막 phase) 갱신할 필요가 없다 — 그 이후 PR 이 없다.
  const hasNextPhase = state.phases.some(p => p.id !== phase.id && p.status !== "done");
  if (!hasNextPhase) return;

  // 조건 1: isolate 전략이고 현재 작업 브랜치가 하네스 소유 격리 브랜치(feature/<workflow>)일 때만 리셋한다.
  const isolationBranch = isolationBranchName(state.workflow);
  if (state.branch_strategy !== "isolate" || workBranch !== isolationBranch) {
    // 매 phase 반복 로그가 되지 않게 — merged 시점(이 함수 호출 시점)에 phase 당 1회만 남는다.
    deps.log(
      `Phase ${phase.id}: PR 머지 확인(branch_strategy=${state.branch_strategy}) — 로컬 브랜치를 갱신하지 ` +
        "않습니다(사용자 소유 브랜치는 건드리지 않습니다). 사내 GHE 에서 흔한 squash/rebase 머지라면 다음 " +
        "phase 의 PR 에 이번 phase 의 커밋/diff 가 함께 담길 수 있습니다.",
    );
    return;
  }

  const cwd = state.repo_root;
  const git = deps.git ?? defaultGitExec;

  // §29 MI-6: 파괴 대상(feature/<workflow>)과 실제 HEAD 가 다르면 리셋을 거부한다 — 이전에는 미push
  // 판정을 origin/<headBranch>..HEAD 로 HEAD 기준으로 쟀는데, CR-2 류 이탈(또는 awaiting_merge
  // 정지 중 사람이 다른 브랜치로 옮겨간 경우)로 HEAD 가 격리 브랜치와 달라지면 엉뚱한 ref 를
  // 재고도 통과시켰다(실측: 정직한 phase 커밋이 어느 ref 에서도 도달 불가해짐). HEAD 가 파괴
  // 대상 자신 위에 있을 때만 진행한다 — 그렇지 않으면 안전한 쪽인 스킵(누적 PR 로 퇴화)을 택한다.
  const headCheck = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const headBranchNow = headCheck.ok && headCheck.stdout.trim().length > 0 ? headCheck.stdout.trim() : "(확인 불가)";
  if (!headCheck.ok || headBranchNow !== isolationBranch) {
    deps.log(
      `Phase ${phase.id}: 현재 브랜치(${headBranchNow}) 가 격리 브랜치(${isolationBranch}) 위에 있지 않아 ` +
        "갱신을 건너뜁니다(누적 PR 로 퇴화) — 다른 작업이 진행 중이거나 브랜치가 바뀌었을 수 있어 안전하게 스킵합니다.",
    );
    return;
  }

  const fetchBase = await git(["fetch", "origin", state.base_branch], cwd);
  if (!fetchBase.ok) {
    deps.log(
      `Phase ${phase.id}: 격리 브랜치 갱신을 위한 base(${state.base_branch}) fetch 실패 — 갱신을 건너뜁니다 ` +
        `(누적 PR 로 퇴화): ${fetchBase.stderr.trim().slice(0, 300)}`,
    );
    return;
  }
  const fetchHead = await git(["fetch", "origin", headBranch], cwd);
  // §29 MI-6 부수 발견: GHE/GitHub 의 "머지 시 head 브랜치 자동 삭제"(사내에서 흔한 기본값)를
  // 켜두면 이 fetch 가 "couldn't find remote ref" 로 실패해 예전에는 M5 갱신 자체가 아예 발동하지
  // 않았다(M5 가 고치려던 squash 누적 문제가 그 구성에서 그대로 남는다). head fetch 가 실패해도
  // base fetch 는 이미 성공했으므로(방금 머지됐으니 origin/<base> 가 이 phase 의 내용을 담고
  // 있다) 미push 판정 기준을 origin/<base> 로 대체해 계속 진행한다.
  const unpushedBaseRef = fetchHead.ok ? `origin/${headBranch}` : `origin/${state.base_branch}`;
  if (!fetchHead.ok) {
    deps.log(
      `Phase ${phase.id}: 격리 브랜치 갱신을 위한 head(${headBranch}) fetch 실패(머지 시 브랜치 자동 삭제 구성일 ` +
        `수 있음) — 미push 판정을 ${unpushedBaseRef} 기준으로 대체합니다: ${fetchHead.stderr.trim().slice(0, 300)}`,
    );
  }

  // 조건 3(안전 가드, 필수): awaiting_merge 정지 중에 사람이 로컬에 커밋했을 수 있다. 파괴 대상인
  // 격리 브랜치 자신(refs/heads/feature/<workflow>) 이 방금 fetch 한 원격 기준의 후손이 아니면(=push 안
  // 된 커밋이 있으면) 갱신을 건너뛴다 — 데이터 손실보다 기존 동작인 누적 PR 로 퇴화하는 쪽이 낫다.
  // §29 MI-6: 위 headCheck 로 HEAD==isolationBranch 를 이미 확인했지만, 재는 대상은 HEAD 가 아니라
  // ref 자신(refs/heads/<isolationBranch>)을 명시한다 — 그래야 이 함수가 재는 것과 실제로 파괴하는
  // 것이 항상 같은 ref 임이 코드만 봐도 보장된다(HEAD 별칭에 의존하지 않는다).
  const unpushed = await git(["rev-list", "--count", `${unpushedBaseRef}..refs/heads/${isolationBranch}`], cwd);
  if (!unpushed.ok) {
    deps.log(
      `Phase ${phase.id}: 미push 커밋 확인 실패 — 격리 브랜치 갱신을 건너뜁니다(누적 PR 로 퇴화): ` +
        `${unpushed.stderr.trim().slice(0, 300)}`,
    );
    return;
  }
  const count = Number.parseInt(unpushed.stdout.trim(), 10);
  if (!Number.isFinite(count) || count !== 0) {
    deps.log(
      `Phase ${phase.id}: 로컬 HEAD 에 push 되지 않은 커밋이 있어(rev-list --count=${unpushed.stdout.trim()}) ` +
        "격리 브랜치 갱신을 건너뜁니다 — 다음 phase 의 PR 에 이번 phase 의 diff 가 함께 담길 수 있습니다.",
    );
    return;
  }

  // 하네스 소유 브랜치라 -B 리셋이 안전하다(위 가드로 유실 없음이 보장된 상태). 실패해도 throw 하지
  // 않고 로그만 남긴다 — 기존 동작(누적 PR)으로 퇴화할 뿐 워크플로우를 막지 않는다.
  //
  // §41 I-4: `--no-track` 필수. `branch.autoSetupMerge` 기본값(true)은 시작점이 remote-tracking
  // 브랜치(origin/<base>)면 새/재생성 브랜치의 upstream 을 그 원격 브랜치로 **자동 설정**한다.
  // 실측(감사자 픽스처): `--no-track` 없이 이 줄을 실행하면 `git config branch.fw/wf.merge` =
  // `refs/heads/main` 이 생기고, 그 상태의 fw/wf 위에서 `git pull` 을 치면 main 이 조용히 병합된다.
  // §40 이 고친 `pr.ts`(-u 제거)와 **같은 결함, 더 나쁜 방향** — §40 은 main 의 upstream 이
  // fw 브랜치로 바뀌었지만(사람이 main 에서 pull/push 하면 오작동), 여기는 **fw 브랜치의
  // upstream 이 main** 이 되어 `push.default=upstream` 사용자가 fw/wf 위에서 친 `git push` 가
  // main 으로 간다. 하네스가 사용자의 로컬 git 설정을 조용히 바꾸는 것은 그 자체로 결함이라는
  // §40 의 원칙이 이 경로에도 그대로 적용된다 — `--no-track` 은 트래킹 정보만 생략할 뿐 브랜치를
  // origin/<base> 위로 재생성하는 목적(§26 M5 squash 대응)에는 영향이 없다.
  const reset = await git(["checkout", "-B", isolationBranch, "--no-track", `origin/${state.base_branch}`], cwd);
  if (!reset.ok) {
    deps.log(
      `Phase ${phase.id}: 격리 브랜치(${isolationBranch}) 재생성 체크아웃 실패 — 갱신을 건너뜁니다 ` +
        `(누적 PR 로 퇴화): ${reset.stderr.trim().slice(0, 300)}`,
    );
    return;
  }
  deps.log(
    `Phase ${phase.id}: 격리 브랜치(${isolationBranch}) 를 origin/${state.base_branch} 위로 재생성했습니다 ` +
      "(squash/rebase 머지 대비 — 다음 phase PR 에 이번 phase 커밋이 누적되지 않게 함).",
  );
}

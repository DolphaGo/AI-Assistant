import fs from "node:fs";
import { execFile } from "node:child_process";
import type { State } from "./state.js";
import {
  checkRunLogsIgnored, runLogsNotIgnoredReason, defaultRunLogsGitCheckIgnoreExec, repoRelativeCandidates,
  type RunLogsGitCheckIgnoreExec,
} from "./state.js";
import { normalizeRepoRelative, displayPath, truncateForDisplay } from "./paths.js";

// git/gh 실행 결과 — orchestrator.ts 의 headSha/changedFiles 스텁과 같은 얕은 계약(ok/stdout/stderr).
// exitCode 를 노출하지 않는 이유: 프리플라이트는 "성공/실패"만 판정하면 되고, 실패 사유는
// stderr 문자열로 충분하다(§25 기존 게이트들과 달리 fatal/재시도 분기가 없다).
export interface CliExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface PreflightDeps {
  // repo_root 가 git 저장소인지, 워킹트리가 깨끗한지, 현재 브랜치가 무엇인지 확인하는 데 쓴다.
  git: (args: string[], cwd: string) => Promise<CliExecResult>;
  // pr_mode 일 때만 `gh auth status` 확인에 쓴다. 생략하면(테스트가 git 만 스텁하는 v1 경로 등)
  // 기본 gh CLI 실행기를 쓴다 — pr_mode 가 아니면 애초에 호출되지 않는다.
  gh?: (args: string[], cwd: string) => Promise<CliExecResult>;
  // §33/§35: 실행 로그 디렉토리가 git 에 무시되는지 확인하는 데 쓴다. **위 `git` 과 계약이 다르다** —
  // `git check-ignore -q` 는 "무시 안 됨" 을 exit 1 로 알리는데, CliExecResult 를 만드는 공용
  // run() 헬퍼는 execFile 이 exit 1 을 에러로 취급하는 것을 ok:false 로 접고 빈 stderr 를
  // err.message 로 채운다 — 그러면 "진짜 무시 안 됨"(exit 1, stderr 없음)과 "git 저장소 아님"
  // (exit 128)이 구별 불가가 되어 방어가 조용히 무력화된다(§33 담당자가 실측으로 확인).
  // 그래서 exit code 를 그대로 보는 전용 실행기를 따로 받는다.
  checkIgnoreGit?: RunLogsGitCheckIgnoreExec;
}

export interface PreflightResult {
  ok: boolean;
  // 발견된 문제 전부(가능한 한 많이 모아서 한 번에 보고한다 — 하나 고치고 다시 돌렸다가
  // 다음 문제를 만나는 왕복을 줄인다). 각 문제 문자열에는 해결 방법을 함께 담는다.
  problems: string[];
  // git 저장소 확인에 성공했을 때만 채워진다. 브랜치 격리 판정(§19 orchestrator)에 재사용한다.
  // detached HEAD 면(§26 I4) null — "HEAD" 라는 문자열을 실제 브랜치명으로 오인하지 않기 위함.
  currentBranch: string | null;
  // §26 C2/I4: `git rev-parse --abbrev-ref HEAD` 가 detached 상태에서 문자열 "HEAD" 를 반환하는데,
  // 이를 그대로 currentBranch 로 쓰면 브랜치 격리 판정(applyBranchStrategy)이 "HEAD" 라는 이름의
  // 브랜치가 실재하는 것처럼 오판한다(onBase=false 로 isolate 를 건너뜀). 명시적으로 구분해 반환한다.
  detached: boolean;
  // §36 I-3: problems 와 달리 ok 판정에는 영향이 없다 — "문제" 가 아니라 "사용자가 위험을 알고도
  // 명시적으로 수용해 방어를 건너뛴 사실의 기록" 이다(예: allow_untracked_logs:true 로 로그 보호
  // 게이트를 통과). 조용히 건너뛰면 §32 가 allow_claude_md_changes 에서 이미 지적한 것과 같은
  // 부채(옵트아웃 사용 시각이 어디에도 안 남는다)가 새 노브에서 반복된다. 호출부(orchestrator.ts,
  // 이번 라운드 소유 파일이 아니라 직접 배선하지 않는다 — 정확한 패치안은 구현 보고서 참조)가
  // 이 배열을 런로그에 deps.log 로 남기는 것을 권장한다.
  warnings: string[];
  // §37 sandbox-trial 막힘 1 후속 — `git remote get-url origin` 에서 뽑은 호스트(parseRemoteHost,
  // §26 M4). pr_mode 의 gh 인증 검사와 샌드박스 network.allowedDomains 자동 포함(state.ts
  // resolveSandboxSettings) 양쪽이 이 값을 쓴다 — 호출자가 이 값을 policyFor 에 그대로 전달한다.
  // origin 이 없거나(로컬 전용 리포) `git remote get-url` 실패·호스트 파싱 불가 시 null — 예외
  // 없이 degrade(§30 P2 회귀 표 참조).
  originHost: string | null;
}

const EXEC_TIMEOUT_MS = 60_000;

function run(cmd: string, args: string[], cwd: string): Promise<CliExecResult> {
  return new Promise(resolve => {
    execFile(cmd, args, { cwd, timeout: EXEC_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, stdout: stdout ?? "", stderr: (stderr || (err as Error).message).toString() });
        return;
      }
      resolve({ ok: true, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

export const defaultGitExec = (args: string[], cwd: string): Promise<CliExecResult> => run("git", args, cwd);
export const defaultGhExec = (args: string[], cwd: string): Promise<CliExecResult> => run("gh", args, cwd);

// §41 m-2: parseRemoteHost 가 뽑아낸 값은 두 곳으로 직행한다 — pr_mode 의 gh 인증 호스트 비교
// (§26 M4)와 §39 샌드박스 `network.allowedDomains` 자동 포함. 둘 다 "이 문자열이 실제로 접속
// 가능한 호스트인가"를 신뢰한다. §30 P3("판정 불가면 거부")에 따라, 형태가 호스트로서 이상하면
// null 을 반환한다 — 이상한 값을 그대로 반환해 호출자가 잘못 신뢰하게 두지 않는다.
//
// 거부 대상(감사자 실측 — 전부 garbage): 빈 라벨/공백("ho st"), 와일드카드("*", "*.evil.com"),
// 호스트 문법에 속하지 않는 문자가 섞인 잔재(예: "git@" — scp-like 정규식이 host 없이 user@ 만
// 남았을 때 백트래킹으로 통째로 삼킨 값).
//
// 통과 대상(§30 P2 — 정당한 호스트를 막지 않는다): DNS 라벨(하이픈 포함, 사내 단일 라벨 호스트
// 포함 — "gitlab", "git-server.corp"), IDN/punycode 라벨("xn--..." 도 표준 라벨 문자셋의 부분집합),
// IPv4(dotted-decimal 뿐 아니라 "2130706433" 같은 정수 표기가 WHATWG URL 파서에서 정규화된
// "127.0.0.1" 도 포함 — 이미 올바른 호스트로 정규화된 결과이므로 별도 처리가 필요 없다),
// IPv6 리터럴(URL.hostname 이 반환하는 대괄호 형태, 예: "[::1]"), 포트(hostname 자체에는 포트가
// 섞이지 않으므로 영향 없음).
function isValidHost(host: string): boolean {
  if (!host) return false;
  if (/\s/.test(host)) return false;
  if (host.includes("*")) return false;
  // IPv6 리터럴 — WHATWG URL 의 hostname 은 대괄호를 포함해 반환한다("[::1]", "[2001:db8::1]").
  if (host.startsWith("[") && host.endsWith("]")) {
    return /^\[[0-9a-f:]+\]$/i.test(host);
  }
  // DNS 라벨(IPv4 dotted-decimal 도 이 라벨 문법의 부분집합이라 별도 분기가 필요 없다) — RFC 1123:
  // 각 라벨은 영문/숫자로 시작·끝나고 중간에 하이픈을 허용한다("*"·"@"·공백은 여기서 이미 걸러진다).
  const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
  return host.split(".").every(label => LABEL_RE.test(label));
}

// §26 M4: `git remote get-url origin` 이 돌려주는 URL 에서 호스트만 뽑는 순수 함수. SSH scp-like
// 형태(`git@host:owner/repo.git`, 포트 없음), `ssh://[user@]host[:port]/...`, `https://host[:port]/...`,
// 사용자정보 포함 `https://user:pass@host/...` 를 모두 커버한다. 못 알아보면 null(호출자가 호스트
// 없는 기존 동작으로 퇴화).
export function parseRemoteHost(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  // scheme:// 형태(ssh://, https://, http://, git:// 등) — WHATWG URL 이 host/port/userinfo를
  // 전부 알아서 분리해준다.
  //
  // §41 m-2 감사: `new URL()` 은 리터럴 "://" 가 없어도 스킴 문법(`[a-zA-Z][a-zA-Z0-9+.-]*:`)만
  // 맞으면 예외 없이 성공한다 — `mailto:`/`data:`/`javascript:` 같은 opaque-path URI(호스트/권한
  // 자체가 없는 형태)가 그렇다. git 은 이런 문자열을 URL 로 취급하지 않는다(git 의 판별 규칙은
  // "문자열에 리터럴 '://' 이 있는가" 뿐이다). 예전 코드는 `new URL()` 이 예외를 던지지 않으면
  // hostname 이 비어 있어도 그대로 아래 scp-like 분기로 원문을 다시 던졌고, 그 결과 콜론 앞
  // 토큰("javascript", "data")을 호스트로 오인했다(실측: "javascript:alert(1)" → "javascript").
  // → `new URL()` 이 예외 없이 성공했다면 그 문자열은 이미 유효한 URI 문법으로 확정된 것이니
  // scp-like 로 재해석하지 않는다 — hostname 이 비어 있으면 그대로 null(오류가 아니라 "이 URI 에는
  // 신뢰할 호스트가 없다"는 뜻).
  try {
    const parsed = new URL(trimmed);
    if (!parsed.hostname) return null;
    const host = parsed.hostname.toLowerCase();
    // §41 m-1: 이 `.toLowerCase()` 의 mutation 은 이 분기에서 원리적으로 죽일 수 없다 —
    // WHATWG URL 스펙이 `hostname` getter 를 항상 소문자로 정규화해 반환하도록 못박고 있어서
    // (실측: `new URL("https://GIT.LINECORP.COM/x").hostname === "ghe.example.com"`, IPv6
    // 리터럴의 16진수도 동일), `new URL()` 을 거친 값은 이미 소문자다. SURVIVED 는 테스트 공백이
    // 아니라 이 지점의 구조적 성질이다 — 그래도 `new URL()` 내부 구현에 기대지 않는 명시적
    // 계약으로 남긴다(비용이 없고, scp-like 분기와 코드 형태를 맞춰 유지보수 시 한쪽만 지우는
    // 실수를 줄인다). 실제로 관측 가능한 소문자화 계약은 아래 scp-like 분기(정규식 추출이라
    // 정규화가 없다)의 회귀 테스트가 못박는다.
    return isValidHost(host) ? host : null; // "https://*/x" 같은 와일드카드는 여기서 거부된다
  } catch {
    // scheme 문법 자체가 아닌 경우(대개 `user@host:path`의 '@'가 스킴 문자셋에 없어 예외를 던진다)
    // — 아래 scp-like 분기로 이어간다.
  }

  // scp-like 형태: `[user@]host:path` (호스트 뒤가 `//` 가 아닌 콜론). git 자체가 지원하는
  // 유일한 no-scheme 축약형이라 URL 파서가 못 읽는다.
  const scpMatch = trimmed.match(/^(?:[^@/]+@)?([^:/]+):(?!\/\/)/);
  if (scpMatch) {
    const host = scpMatch[1]!.toLowerCase();
    // §41 m-2: host 가 없이 "user@" 만 매칭될 수 있다(예: "git@:noowner/r" — 정규식이 백트래킹
    // 으로 "git@" 통째를 그룹 1 로 삼킨다). isValidHost 가 '@' 를 포함한 값을 거부해 걸러낸다.
    return isValidHost(host) ? host : null;
  }

  return null;
}

// §26 C1 감사: saveState() 는 매 attempt/phase 마다 <workflowDir>/STATE.json 을 다시 쓴다. workflowDir 은
// 규약상 repo_root 내부(docs/<workflow>/)라 첫 `fw run` 이 끝나는 순간 워킹트리는 항상 dirty 가 되고,
// 이후 모든 재개(fw answer → fw run)가 이 청결 검사에서 거부됐다(실측 확인). workflowDir 이 repo_root
// 내부면 그 서브트리를 청결 검사에서 제외한다. pathspec(`:(exclude)`) 대신 `--porcelain` 전체 결과를
// 받아 직접 필터링한다 — git 버전에 따라 pathspec magic 지원이 갈릴 수 있어 더 안전하다.
//
// §29 MI-4 감사: 문자열 상대경로 접두 비교만으로는 4가지 실측 구성에서 재개가 계속 막혔다.
//   B. `docs/` 전체가 아직 untracked 면 git 이 `?? docs/` 로 축약해 워크플로우 하위 파일명이
//      아예 안 보인다 → 아래에서 `--untracked-files=all` 로 항상 펼쳐 받는다(git 이 다시는
//      디렉토리로 축약하지 않으므로 "펼친 뒤 재판정" 같은 별도 분기가 필요 없다).
//   D. state.repo_root 는 realpath 로 저장돼 있는데 workflowDir 계산에 symlink 가 섞이면(예:
//      macOS `/tmp`→`/private/tmp`) 문자열 path.relative 가 "../.." 로 어긋난다.
//   F. workflowDir 자기 자신이 symlink 면, git 은 그 symlink 노드를 대상 디렉토리로 "따라
//      들어가지" 않고 하나의 파일처럼 별도 엔트리로 보고한다 — 그 리터럴 경로(예: "link-wf1")는
//      realpath 로 해석한 실제 대상 경로(예: "real/wf1")와 다르다.
// D 는 realpath 형태의 후보가 필요하고 F 는 리터럴(realpath 안 한) 형태의 후보가 필요해서
// 서로 다른 해법을 요구한다 — 그래서 아래 workflowDirCandidates 가 "리터럴"과 "realpath 정규화"
// 두 후보를 모두 계산해, 그중 하나에라도 속하면 "워크플로우 산출물" 로 인정한다. normalizeRepoRelative
// 로 NFC 정규화까지 함께 적용해 E(한글 이름)에서 quotePath 해제 후 형태가 어긋나지 않게 한다.
//
// §36 C-3: 이 리터럴+realpath 두 후보 계산 자체는 state.ts 의 repoRelativeCandidates 로 뽑아
// checkRunLogsIgnored(§33/§35 로그 보호 게이트)와 공유한다 — 감사에서 그 함수가 `path.relative`
// 순수 어휘 비교만 쓰다가 이 파일과 다른 답을 내(symlink 조합에서 "밖" 오판) 로그 보호가
// 조용히 꺼지고 doctor 가 거짓 문장을 낸 사고가 있었다(§30 P1 — 같은 질문을 두 곳에서 답하다
// 갈린 다섯 번째 사례). 여기서는 normalizeRepoRelative(NFC·darwin 대소문자 무시)까지 추가로
// 적용해 porcelain 출력과의 멤버십 비교에 쓴다 — checkRunLogsIgnored 는 git 질의용 경로 문자열
// 자체가 필요해 정규화하지 않은 원본을 그대로 쓴다(그 파일 주석 참조).
function workflowDirCandidates(repoRoot: string, workflowDir?: string): string[] {
  if (!workflowDir) return [];
  const { literal, real } = repoRelativeCandidates(repoRoot, workflowDir);
  const candidates = new Set<string>();
  if (literal !== null) candidates.add(normalizeRepoRelative(literal));
  if (real !== null) candidates.add(normalizeRepoRelative(real));
  return [...candidates];
}

// `git status --porcelain=v2 --untracked-files=all -z` 출력을 NUL(\0) 필드 스트림으로 파싱한다
// (§porcelain-v2 이행 — P1~P9/D1~D15 참조. 이 파서는 v1(-z) 을 전량 대체한다, 듀얼 파서 없음).
//
// v2 는 모든 레코드가 타입 문자(1/2/u/?/!)로 자기 서술한다 — v1 이 "OLD 필드가 있는지 없는지"를
// XY 문자만 보고 추측해야 했던 것과 근본적으로 다르다. 레코드 타입별로 고정된 개수의 공백 구분
// 토큰을 소비한 뒤 나머지 전체를 path 로 삼는다(D4 — naive `split(" ")` 금지: -z 는 quotePath 를
// 안 하므로 path 자체에 공백이 올 수 있어, 순진하게 공백으로 전부 쪼개면 path 가 잘린다).
//   1(ordinary)  = "1 XY sub mH mI mW hH hI path"        → 8 고정 토큰 + path
//   2(rename/copy) = "2 XY sub mH mI mW hH hI score path" → 9 고정 토큰(score 포함) + path,
//                     그 뒤에 origPath 가 별도 NUL 필드로 하나 더 온다(v2 인코딩상 2 만 두
//                     번째 필드를 가진다 — 1/u 는 한 줄로 끝난다)
//   u(unmerged)  = "u XY sub m1 m2 m3 mW h1 h2 h3 path"  → 10 고정 토큰 + path
//   ?/!(untracked/ignored) = "? path" / "! path"          → 타입 + 공백만, 나머지 전부 path
//
// 문자군 검증(D4/D5/D6, P2 로 넓어진 fail-closed 범위 — 위조 탐지 소비자 특성상 모르는 레코드를
// 스킵하면 그 레코드의 경로를 못 보는 조용한 미탐이 된다):
//   - XY: 1/2 는 각 자리가 {M,A,D,R,C,U,T,X,.} 집합(D6-완화-정정 스레드 반영 — '.' 은 "해당 쪽
//     무변경" 을 뜻하는 매우 흔한 정상 출력이다, 예: "1 .M ..."). u 는 머지 의미론상 완결된 7개
//     조합(DD/AU/UD/UA/DU/AA/UU) 화이트리스트만(D5).
//   - mode(mH/mI/mW 또는 m1/m2/m3/mW): 8진 문자 + 고정 6자리(D6).
//   - hash(hH/hI 또는 h1/h2/h3): 16진 문자 + 길이 {40, 64}(D6 — SHA-1/SHA-256 오브젝트 포맷
//     양쪽 정상 출력을 다 통과시킨다, 40 단독 강제 금지).
//   - sub: `N...` 폼 또는 `S`+[C.][M.][U.] 폼(D6).
//   - score(2 전용): `[RC]` + 숫자 1~3자리(D6, 파서 소비 후 버림 — P4, PreflightResult 는 불변).
//
// mid_field_missing(D3/D9/D14): '2' 레코드가 origPath 를 소비하기 **직전**, 그 자리의 다음 NUL
// 필드가 1/2/u 세 헤더 형태 중 하나의 "완전한 유효 헤더"와 우연히 일치하는지 lookahead 로
// 검사한다(D3 — 이 헤더 검증기 자체를 그대로 재사용, "검증기 하나 용도 둘"). 일치하면 그 필드는
// origPath 가 아니라 다음 레코드의 상태줄이 잘못 소비될 뻔한 것이므로 fail-closed 로 정지하고
// 원본 '2' 레코드 원문과 오인 후보였던 다음 레코드 원문을 둘 다 결과에 담는다(D9 — 두 증거
// 병렬 보존이 이 이행의 존재 이유를 증명하는 핵심 수용 기준이다). `?`/`!` 형태와는 애초에
// 비교하지 않는다(D14 — 오탐 비용이 미탐 비용+이중 안전망보다 크다는 판단).
//
// stream_ended(D12): '2' 레코드의 origPath 자리에서 다음 NUL 필드 자체가 없음(fields[i+1] ===
// undefined) — 오인할 대상(다음 필드)조차 없는, mid_field_missing 과는 다른 실패 모드라 별도
// 카테고리로 분리한다(카테고리 신설 근거 = 테스트 판별력, D8).
//
// -z 출력에는 core.quotePath 8진 이스케이프가 전혀 적용되지 않는다(Phase 0 실측, NOTES.md ①) —
// 그래서 v1 텍스트 파싱에 있던 unquoteGitPath 호출은 쓰지 않는다(함수 자체는 비-git 출처용으로
// paths.ts/gate.ts 에 존치).
//
// §29 MI-5 감사(유지): rename/copy 레코드는 NEW/OLD 두 경로 모두 반환한다 — `git mv production.ts
// docs/wf1/production.ts` 처럼 workflowDir 밖 파일을 안으로 옮기면 NEW 만 보고 "워크플로우
// 산출물뿐" 으로 오판해 원본 파일 실종을 놓친다. 반환 순서는 [NEW, OLD](v2 필드가 그 순서로
// 온다, 별도 재정렬 불필요) — score 는 검증 후 버려 반환 레코드에 담기지 않는다(P4).
export type PorcelainReason =
  | "unknown_type"
  | "xy_invalid"
  | "mode_invalid"
  | "hash_invalid"
  | "sub_invalid"
  | "score_invalid"
  | "token_shortage"
  | "stream_ended"
  | "mid_field_missing";

// D8/E6: 이 배열이 exhaustiveness 메타 테스트(카테고리별 최소 기형 입력 픽스처 테이블의 키 집합과
// 대조)의 런타임 순회 대상이다. `satisfies` 로 위 유니온과 결속해, 카테고리를 하나 추가하고 이
// 배열에 반영하지 않으면 typecheck 가 잡는다.
export const REASONS = [
  "unknown_type",
  "xy_invalid",
  "mode_invalid",
  "hash_invalid",
  "sub_invalid",
  "score_invalid",
  "token_shortage",
  "stream_ended",
  "mid_field_missing",
] as const satisfies readonly PorcelainReason[];

type PorcelainZParseResult =
  | { ok: true; records: string[][] }
  | { ok: false; reason: PorcelainReason; malformedRaw: string; nextRaw?: string };

// XY 두 자리(1/2 전용) 개별 문자 집합 — v2 공식 스펙: 상태 코드 문자 또는 "해당 쪽 무변경" 마커 '.'.
const XY_CHARS = new Set(["M", "A", "D", "R", "C", "U", "T", "X", "."]);
function isValidOrdinaryXYChar(c: string): boolean {
  return XY_CHARS.has(c);
}
// u(병합충돌) 전용 — 머지 의미론상 완결된 7개 조합만(D5). DA/AD 는 의도적으로 배제.
const U_XY_WHITELIST = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

const MODE_RE = /^[0-7]{6}$/;
function isValidMode(m: string): boolean {
  return MODE_RE.test(m);
}

const HASH_RE = /^[0-9a-fA-F]{40}$|^[0-9a-fA-F]{64}$/;
function isValidHash(h: string): boolean {
  return HASH_RE.test(h);
}

function isValidSub(s: string): boolean {
  if (s.length !== 4) return false;
  if (s[0] === "N") return s.slice(1) === "...";
  if (s[0] === "S") {
    return (s[1] === "C" || s[1] === ".") && (s[2] === "M" || s[2] === ".") && (s[3] === "U" || s[3] === ".");
  }
  return false;
}

const SCORE_RE = /^[RC]\d{1,3}$/;
function isValidScore(s: string): boolean {
  return SCORE_RE.test(s);
}

// 레코드 타입별 고정 토큰 수(타입 문자 자신 포함) — D4. path 는 이 개수만큼 소비하고 남는 전체다.
const FIXED_TOKEN_COUNT: Record<"1" | "2" | "u", number> = { "1": 8, "2": 9, u: 10 };

// field 에서 앞쪽 `count` 개의 공백 구분 토큰을 소비하고, 나머지 전체(공백을 포함할 수 있다 —
// path 는 quotePath 이스케이프가 없는 원문이다)를 path 로 돌려준다. 토큰이 count 개에 못 미치면
// (기대한 구분 공백 자체가 없음) null — token_shortage 트리거.
function consumeFixedTokens(field: string, count: number): { tokens: string[]; path: string } | null {
  const tokens: string[] = [];
  let rest = field;
  for (let i = 0; i < count; i++) {
    const spaceIdx = rest.indexOf(" ");
    if (spaceIdx === -1) return null;
    tokens.push(rest.slice(0, spaceIdx));
    rest = rest.slice(spaceIdx + 1);
  }
  return { tokens, path: rest };
}

// D3/D4 헤더 검증기 — mid_field_missing lookahead 와 본 파싱 양쪽이 재사용한다("검증기 하나,
// 용도 둘"). tokens 는 consumeFixedTokens 가 뽑은 고정 토큰 배열(타입 문자 포함)이다.
function validateHeaderTokens(type: "1" | "2" | "u", tokens: string[]): PorcelainReason | null {
  const xy = tokens[1]!;
  if (type === "u") {
    if (!U_XY_WHITELIST.has(xy)) return "xy_invalid";
  } else {
    if (xy.length !== 2 || !isValidOrdinaryXYChar(xy[0]!) || !isValidOrdinaryXYChar(xy[1]!)) return "xy_invalid";
  }

  const sub = tokens[2]!;
  if (!isValidSub(sub)) return "sub_invalid";

  if (type === "u") {
    // u: sub m1 m2 m3 mW h1 h2 h3
    if (![tokens[3]!, tokens[4]!, tokens[5]!, tokens[6]!].every(isValidMode)) return "mode_invalid";
    if (![tokens[7]!, tokens[8]!, tokens[9]!].every(isValidHash)) return "hash_invalid";
  } else {
    // 1/2: sub mH mI mW hH hI [score]
    if (![tokens[3]!, tokens[4]!, tokens[5]!].every(isValidMode)) return "mode_invalid";
    if (![tokens[6]!, tokens[7]!].every(isValidHash)) return "hash_invalid";
    if (type === "2" && !isValidScore(tokens[8]!)) return "score_invalid";
  }
  return null;
}

// D3/D14: candidate(다음 NUL 필드)가 1/2/u 세 헤더 형태 중 하나의 "완전한 유효 헤더"인지 —
// mid_field_missing lookahead 전용. `?`/`!` 와는 애초에 비교하지 않는다(트리거 대상이 아니라
// 매칭 대상에서 배제, D14).
function looksLikeCompleteHeader(candidate: string): boolean {
  const type = candidate[0];
  if (type !== "1" && type !== "2" && type !== "u") return false;
  const consumed = consumeFixedTokens(candidate, FIXED_TOKEN_COUNT[type]);
  if (!consumed) return false;
  return validateHeaderTokens(type, consumed.tokens) === null;
}

export function parsePorcelainZ(stdoutZ: string): PorcelainZParseResult {
  // 트레일링 NUL 이 만드는 빈 세그먼트만 걸러낸다(Phase 0 실측) — 실제 경로 필드는 git status 가
  // 절대 빈 문자열로 내지 않으므로 빈 문자열 필터링이 legit 필드를 삼킬 위험이 없다.
  const fields = stdoutZ.split("\0").filter(f => f.length > 0);
  const records: string[][] = [];
  let i = 0;
  while (i < fields.length) {
    const field = fields[i]!;
    const type = field[0];

    if (type === "?" || type === "!") {
      const consumed = consumeFixedTokens(field, 1);
      if (!consumed) return { ok: false, reason: "token_shortage", malformedRaw: field };
      records.push([consumed.path]);
      i += 1;
      continue;
    }

    if (type !== "1" && type !== "2" && type !== "u") {
      return { ok: false, reason: "unknown_type", malformedRaw: field };
    }

    const consumed = consumeFixedTokens(field, FIXED_TOKEN_COUNT[type]);
    if (!consumed) return { ok: false, reason: "token_shortage", malformedRaw: field };

    const headerReason = validateHeaderTokens(type, consumed.tokens);
    if (headerReason) return { ok: false, reason: headerReason, malformedRaw: field };

    if (type === "2") {
      const nextField = fields[i + 1];
      if (nextField === undefined) {
        return { ok: false, reason: "stream_ended", malformedRaw: field };
      }
      if (looksLikeCompleteHeader(nextField)) {
        return { ok: false, reason: "mid_field_missing", malformedRaw: field, nextRaw: nextField };
      }
      records.push([consumed.path, nextField]);
      i += 2;
    } else {
      records.push([consumed.path]);
      i += 1;
    }
  }
  return { ok: true, records };
}

// isPathInsideAnyCandidate 의 p 는 항상 parsePorcelainZ 가 뽑은 git-출처 경로다 — 개행으로
// 시작·끝나는 실제 파일명이 그 자체일 수 있으므로 trim:false 로 정규화한다(D6). candidates
// (workflowDirCandidates 의 literal/real, 설정 경로이지 git-출처가 아니다)는 옵션 없이(기본
// trim:true) 그대로 계산된다 — 이 함수 호출부만 한정해서 trim 을 생략한다.
function isPathInsideAnyCandidate(p: string, candidates: string[]): boolean {
  const norm = normalizeRepoRelative(p, { trim: false });
  return candidates.some(c => norm === c || norm.startsWith(`${c}/`));
}

// 파싱된 레코드 중 workflowDir(후보 중 하나) 안쪽 항목만으로 이뤄지지 않은(=워크플로우 밖 변경이
// 섞인) 레코드가 하나라도 있으면 true 를 반환한다. rename/copy 레코드는 NEW·OLD 둘 다 후보 안에
// 있어야만 "워크플로우 산출물뿐" 으로 제외된다(MI-5 로직 유지).
function hasEntriesOutsideCandidates(records: string[][], candidates: string[]): boolean {
  return records.some(paths => !paths.every(p => isPathInsideAnyCandidate(p, candidates)));
}

/**
 * `fw run` 시작 시(assertRunnable 다음) 호출되는 무인 실행 전 안전 점검(§19).
 * repo_root 존재·git 저장소 여부·워킹트리 청결·현재 브랜치·(pr_mode 면) gh 인증을 확인한다.
 * 절대 throw 하지 않는다 — 모든 문제를 모아 problems 에 담아 반환하고, 호출자(orchestrator)가
 * FAILED 정지 + 알림으로 처리한다.
 * workflowDir 을 넘기면(§26 C1) repo_root 내부에 있는 그 서브트리(STATE.json/.fw.lock/logs/ 등
 * 하네스 자신의 산출물)는 워킹트리 청결 검사에서 제외한다.
 */
export async function preflight(state: State, deps: PreflightDeps, workflowDir?: string): Promise<PreflightResult> {
  const problems: string[] = [];
  const warnings: string[] = [];
  let currentBranch: string | null = null;
  let detached = false;

  let repoRootIsDir = false;
  try {
    repoRootIsDir = fs.statSync(state.repo_root).isDirectory();
    if (!repoRootIsDir) {
      problems.push(
        `repo_root 가 디렉토리가 아닙니다: ${state.repo_root} — STATE.json 의 repo_root 를 리포 루트 절대 경로로 고치세요.`,
      );
    }
  } catch {
    problems.push(
      `repo_root 가 존재하지 않습니다: ${state.repo_root} — STATE.json 의 repo_root 를 확인하세요.`,
    );
  }

  if (repoRootIsDir) {
    const gitDirCheck = await deps.git(["rev-parse", "--git-dir"], state.repo_root);
    if (!gitDirCheck.ok) {
      problems.push(
        `${state.repo_root} 가 git 저장소가 아닙니다 — repo_root 를 git 저장소 경로로 바꾸거나 그 경로에서 git init 하세요.`,
      );
    } else {
      // §29 MI-4 B: --untracked-files=all 을 항상 요청해 git 이 새-untracked 디렉토리를 `?? docs/`
      // 로 축약해버리는 것을 원천 차단한다(펼쳐 받은 뒤에는 항상 개별 파일 경로라 아래 접두 판정이
      // 그대로 통하고, 축약 여부를 감지해 재조회하는 별도 분기가 필요 없다). G/H(워크플로우 밖 변경)
      // 판정에는 영향이 없다 — 이 플래그는 untracked 항목의 세분화만 바꾸고 tracked 변경/무관한
      // 항목의 dirty 여부 자체는 그대로다.
      // porcelain v2 이행(P1~P9/D1~D15) — 레코드 타입(1/2/u/?/!)이 필드 개수를 스스로 서술해
      // v1 -z 의 구조적 한계("중간 필드 누락"이 다음 레코드 상태줄을 OLD 로 오인해 조용히
      // fail-open 되는 것)가 사라진다. -z 는 그대로 유지(개행·따옴표·비ASCII 파일명이
      // core.quotePath 8진 이스케이프 없이 NUL 로 구분된 원문 그대로 나온다, Phase 0 실측).
      const statusCheck = await deps.git(["status", "--porcelain=v2", "--untracked-files=all", "-z"], state.repo_root);
      if (!statusCheck.ok) {
        // D10(D1 정정본) — 구식 git(2.11 미만)은 `--porcelain=v2` 자체를 인식하지 못해 커맨드가
        // 여기(parsePorcelainZ 도달 이전)서 실패한다. 그래서 버전 프로브는 이 분기 한 곳에만
        // 지연 호출한다(P5 — 위조 탐지가 아니라 전제 진단이라 fail-open: 버전 문자열이 파싱되고
        // 2.11 미만일 때만 힌트를 덧붙이고, 파싱 불가면 가드를 건너뛴다. 정상 경로에서는 이
        // 분기 자체에 들어오지 않으므로 `git --version` 스폰이 0회다).
        let versionHint = "";
        const versionCheck = await deps.git(["--version"], state.repo_root);
        if (versionCheck.ok) {
          const m = versionCheck.stdout.match(/git version (\d+)\.(\d+)/);
          if (m) {
            const major = Number(m[1]);
            const minor = Number(m[2]);
            if (major < 2 || (major === 2 && minor < 11)) {
              versionHint = ` (git ${major}.${minor} 감지 — 이 하네스는 2.11+ 필요)`;
            }
          }
        }
        problems.push(
          `워킹트리 상태 확인(git status)에 실패했습니다: ${statusCheck.stderr.trim().slice(0, 300)}${versionHint}`,
        );
      } else {
        const parsed = parsePorcelainZ(statusCheck.stdout);
        if (!parsed.ok) {
          // D3/P2 — fail-closed: 위조 탐지 경로의 기형·미인식 레코드는 건너뛰지 않고 정지한다
          // (기존 problems→ok:false→FAILED 하드정지 관례를 그대로 따른다, 사람이 `fw retry` 로
          // 재개). D8/D11 — 사람용 메시지는 공용 템플릿 + snake_case 카테고리 토큰 하나(카테고리별
          // 문구 사전 없음), mid_field_missing 만 두 번째 증거(오인될 뻔한 다음 레코드 원문)가
          // 고정 라벨로 덧붙는다(D9). 각 증거는 독립적으로 truncateForDisplay(displayPath(...))
          // 적용(D9 — 합산 상한이면 한 증거가 다른 증거를 밀어낸다).
          const evidence =
            `문제 레코드: ${truncateForDisplay(displayPath(parsed.malformedRaw))}` +
            (parsed.reason === "mid_field_missing" && parsed.nextRaw !== undefined
              ? ` / 다음 레코드 원문: ${truncateForDisplay(displayPath(parsed.nextRaw))}`
              : "");
          problems.push(
            `git status -z 출력에서 예상과 다른 필드 구조(${parsed.reason})를 발견했습니다 — ${evidence}. ` +
              "위조 탐지를 신뢰할 수 없는 상태라 안전하게 정지합니다. git 버전/환경을 확인한 뒤 " +
              "`fw retry` 로 재개하세요.",
          );
        } else {
          const candidates = workflowDirCandidates(state.repo_root, workflowDir);
          const dirty = candidates.length > 0
            ? hasEntriesOutsideCandidates(parsed.records, candidates)
            : parsed.records.length > 0;
          if (dirty) {
            problems.push(
              "워킹트리에 커밋되지 않은 변경이 있습니다 — 세션이 만드는 변경과 사람이 만든 변경이 섞이면 " +
                "커밋 게이트/diff 위조 검사가 오염됩니다. 변경을 커밋하거나, 워크플로우와 무관한 변경이면 " +
                "다른 브랜치로 옮긴 뒤 다시 실행하세요.",
            );
          }
        }
      }

      const branchCheck = await deps.git(["rev-parse", "--abbrev-ref", "HEAD"], state.repo_root);
      if (!branchCheck.ok) {
        problems.push(
          `현재 브랜치를 확인할 수 없습니다(git rev-parse --abbrev-ref HEAD): ${branchCheck.stderr.trim().slice(0, 300)}`,
        );
      } else {
        const branchName = branchCheck.stdout.trim();
        // §26 C2/I4: detached HEAD 에서는 이 명령이 브랜치명이 아니라 리터럴 문자열 "HEAD" 를
        // 반환한다 — 그걸 그대로 currentBranch 로 쓰면 "HEAD" 라는 브랜치가 실재하는 것처럼
        // 오판된다. 명시적으로 구분한다.
        if (branchName === "HEAD") {
          detached = true;
          currentBranch = null;
        } else {
          currentBranch = branchName;
        }
      }
    }
  }

  // §37 sandbox-trial 막힘 1 후속 — origin 호스트는 pr_mode(아래 gh 인증 검사)와 샌드박스
  // (resolveSandboxSettings 의 network.allowedDomains 자동 포함, 호출자가 policyFor 에 전달)
  // 양쪽이 쓴다. 어느 쪽도 필요 없으면(pr_mode:false && sandbox 미설정/꺼짐) 이 `git remote
  // get-url origin` 호출 자체가 일어나지 않는다 — 관련 없는 사용자에게 새 프로세스 호출을 추가
  // 하지 않는다(§30 P2 회귀 방지: "sandbox 미설정 → 기존 동작 그대로" 는 git 조회조차 하지
  // 않는 것을 포함한다). state.sandbox?.enabled 는 state.ts resolveSandboxSettings 의 게이트
  // 조건(`!cfg?.enabled`)과 동일한 판정이다(§30 P1) — 그 함수를 여기서 호출하지 않는 이유는
  // SandboxSettings 반환값이 필요 없고 boolean 판정만 필요하기 때문이다.
  let originHost: string | null = null;
  if (state.pr_mode || state.sandbox?.enabled) {
    const remoteCheck = await deps.git(["remote", "get-url", "origin"], state.repo_root);
    originHost = remoteCheck.ok ? parseRemoteHost(remoteCheck.stdout.trim()) : null;
  }

  if (state.pr_mode) {
    const ghExec = deps.gh ?? defaultGhExec;
    // §26 M4: 호스트를 지정하지 않은 `gh auth status` 는 github.com 인증만 있어도 통과해버려서,
    // origin 이 사내 GHE(ghe.example.com 등)를 가리켜도 엉뚱한 호스트 인증으로 프리플라이트를
    // 통과할 수 있었다. origin 리모트 URL에서 실제 호스트를 뽑아 그 호스트로 검사한다.
    const authArgs = originHost ? ["auth", "status", "--hostname", originHost] : ["auth", "status"];
    const authCheck = await ghExec(authArgs, state.repo_root);
    if (!authCheck.ok) {
      problems.push(
        originHost
          ? `pr_mode 인데 \`${originHost}\` 에 gh 인증이 없습니다 — \`gh auth login --hostname ${originHost}\` 를 실행하세요.`
          : "pr_mode 인데 `gh auth status` 가 실패했습니다 — `gh auth login` 으로 인증한 뒤 다시 실행하세요.",
      );
    }
  }

  // §33/§35 — 실행 로그 보호(§30 P3 구조적 방어). §27 O1 감사 로그는 DENY 명령 **전문**을
  // 남기고, §32 I-1 이 재설계한 마스킹도 완전하지 않다(33% 누출, 40자 hex 는 git SHA 와 구별
  // 불가라 의도적 미마스킹). 정규식으로 완벽을 노리는 경쟁은 이길 수 없으므로, 자격증명이 섞인
  // 로그가 **대상 리포에 커밋되는 것** 자체를 막는다.
  //
  // 경고가 아니라 거부인 이유: 밤샘 무인 주행 중에는 경고를 아무도 안 본다(§27 O4 가 알림에서
  // 고친 그 실패 모드). 차단 비용은 `.gitignore` 한 줄이고 유출 비용은 히스토리 재작성 +
  // 자격증명 교체다. 그리고 `fw doctor` 는 이미 거부하므로, run 만 경고면 §30 P1(같은 판정,
  // 두 곳에서 다른 답)이 된다. §26 C1 류의 막다른 차단이 아니다 — 진단(`fw doctor`)과
  // 탈출구(`allow_untracked_logs: true`)가 같은 라운드에 함께 있다.
  if (workflowDir) {
    const check = await checkRunLogsIgnored(
      deps.checkIgnoreGit ?? defaultRunLogsGitCheckIgnoreExec,
      state.repo_root,
      workflowDir,
    );
    // "unknown"(git 저장소 아님·check-ignore 실행 실패)은 문제로 치지 않는다 — 진단 불가를
    // 차단으로 바꾸면 §30 P2 다. "outside-repo" 는 애초에 커밋될 일이 없다(§36 C-3: 리터럴+
    // realpath 두 후보 중 하나라도 repo 안이면 여기 도달하지 않고 ignored/not-ignored 로 판정된다).
    if (check.status === "not-ignored") {
      if (state.allow_untracked_logs) {
        // §36 I-3: 조용히 건너뛰지 않는다 — 위험을 감수하기로 한 선택이라는 사실을 warnings 에
        // 남겨 호출부(런로그)가 표시할 수 있게 한다(problems 가 아니므로 ok 는 그대로 true).
        warnings.push(
          `allow_untracked_logs: true 로 로그 보호를 건너뛰었습니다 — ${check.relLogsDir} 가 git 에 ` +
            "무시되지 않지만 위험을 감수하고 계속 진행합니다(감사 로그에 마스킹되지 않은 자격증명이 " +
            "남을 수 있습니다, §32 I-1).",
        );
      } else {
        problems.push(runLogsNotIgnoredReason(check.relLogsDir!, { alreadyTrackedInIndex: check.alreadyTrackedInIndex }));
      }
    }
  }

  return { ok: problems.length === 0, problems, currentBranch, detached, warnings, originHost };
}

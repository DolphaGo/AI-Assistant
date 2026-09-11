import fs from "node:fs";
import path from "node:path";

// §29 MI-4/MI-7 공용 경로 정규화 모듈. preflight.ts(§26 C1 워킹트리 청결 검사)와 gate.ts(§26 C3
// 위조 가드)가 서로 다른 git 하위 명령(status/diff)의 출력을 다루지만 겪는 문제는 동일하다 —
//   1) core.quotePath(기본 true) 가 비ASCII 경로를 8진 이스케이프로 감싼 문자열로 낸다
//   2) 같은 경로라도 realpath(symlink)·유니코드 정규화 형태(NFC/NFD)·대소문자(macOS 기본
//      case-insensitive 파일시스템)에 따라 문자열 비교가 실패할 수 있다
// 전부 순수 함수로 구성해 preflight.ts/gate.ts 가 각자의 시그니처를 유지한 채 재사용한다.
//
// §29 잔여 부채 처리(후속 라운드): permissions.ts 에도 거의 동일한 realpathClimb 이 병렬 작업
// 제약 때문에 독립 구현돼 있었다. 두 구현을 비교한 결과 동작 차이는 없다 — 유일한 차이는
// `trailing.length` vs `trailing.length > 0` 뒤 3항 연산자 조건인데 trailing 은 항상 0 이상의
// 배열 길이(number)라 둘의 진리값은 모든 입력에서 동일하다. 존재하지 않는 경로/symlink 루프/권한
// 오류 처리 로직(try/catch → dirname 으로 한 단계씩 올라가며 재시도, 루트 도달 시 원본 반환)도
// 완전히 동일했다. 이 모듈(paths.ts)의 realpathOrClimb 을 정본으로 삼아 permissions.ts 가 이를
// import 해서 쓰도록 통합했다 — 순수 리팩토링이며 permissions.ts 의 기존 insideRepo 테스트가
// 하나도 안 깨지는 것으로 동작 동등성을 재확인했다(§30 P2).

/**
 * 존재하는 최상위 조상까지 거슬러 올라가며 realpath 로 해석한다. 아직 존재하지 않는 경로(예: 이번
 * attempt 에서 처음 만들어질 workflowDir)라도 존재하는 조상 부분만 symlink 해석하고 나머지
 * 세그먼트는 문자열 그대로 이어붙여 반환한다 — fs.realpathSync 는 경로 전체가 실존해야 하므로
 * 그대로 쓰면 신규 경로에서 매번 throw 한다.
 */
export function realpathOrClimb(p: string): string {
  const trailing: string[] = [];
  let current = p;
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return trailing.length > 0 ? path.join(real, ...trailing.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return p; // 루트까지 갔는데도 존재하는 조상이 없음 — 원본 그대로 반환
      trailing.push(path.basename(current));
      current = parent;
    }
  }
}

// git 의 core.quotePath(기본 true) 는 경로에 비ASCII 바이트나 특수문자가 있으면 전체를 큰따옴표로
// 감싸고 각 바이트를 C 스타일로 이스케이프한다(`\`, `"`, 제어문자는 \n/\t 등 니모닉으로, 그 외
// 비ASCII 바이트는 8진 \NNN 으로). 여러 바이트로 이뤄진 UTF-8 문자(한글 등)는 옥텟 하나하나가
// 별도의 \NNN 로 나오므로 **바이트 단위로 모은 뒤 한 번에 UTF-8 디코드**해야 한다 — 문자 단위로
// 하나씩 디코드하면 멀티바이트 시퀀스가 쪼개져 깨진 문자(mojibake)가 된다.
// 따옴표로 감싸이지 않은 입력은 애초에 quotePath 대상이 아니었다는 뜻이므로 그대로 반환한다.
const SIMPLE_ESCAPES: Record<string, number> = {
  a: 0x07, b: 0x08, f: 0x0c, n: 0x0a, r: 0x0d, t: 0x09, v: 0x0b,
  "\\": 0x5c, '"': 0x22,
};

export function unquoteGitPath(raw: string): string {
  if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') return raw;
  const inner = raw.slice(1, -1);
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  let i = 0;
  while (i < inner.length) {
    const ch = inner[i]!;
    if (ch === "\\") {
      const rest = inner.slice(i + 1);
      const octal = rest.match(/^[0-7]{3}/);
      if (octal) {
        bytes.push(parseInt(octal[0], 8) & 0xff);
        i += 4;
        continue;
      }
      const next = rest[0];
      if (next !== undefined && next in SIMPLE_ESCAPES) {
        bytes.push(SIMPLE_ESCAPES[next]!);
        i += 2;
        continue;
      }
      // 알 수 없는 이스케이프 — 백슬래시를 버리고 다음 문자를 리터럴로 취급하는 보수적 폴백.
      // 이 함수는 보안 경계가 아니라 표시/경로비교용 정규화라 판정 실패보다 원문을 최대한
      // 보존하는 쪽이 낫다.
      if (next !== undefined) {
        bytes.push(...encoder.encode(next));
        i += 2;
        continue;
      }
      // 문자열이 '\' 하나로 끝남(비정상 입력) — 그 문자 자체를 push
      bytes.push(...encoder.encode(ch));
      i += 1;
      continue;
    }
    bytes.push(...encoder.encode(ch));
    i += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

// 리포-상대 경로 비교를 위한 정규화: 선행 "./", 중복/후행/선행 슬래시 정리, path.normalize 상당의
// 처리, 유니코드 NFC 정규화, 그리고 (옵션) 대소문자 무시.
//
// NFC 정규화는 플랫폼 무관하게 항상 적용한다 — macOS(APFS) 는 파일이 생성된 경로(터미널 입력/앱/
// 언어별 정규화 습관)에 따라 NFC 든 NFD 든 그대로 저장하므로, git 이 보고하는 문자열과 우리가 JS
// 리터럴/realpath 로 얻은 문자열이 같은 문자를 서로 다른 정규화 형태로 표현할 수 있다. 두 형태는
// 항상 같은 글자를 가리키므로 NFC 로 맞춰도 오탐(다른 파일을 같다고 오판)이 생기지 않는다.
//
// 대소문자 무시는 기본적으로 `process.platform === "darwin"` 일 때만 켠다: macOS 기본 파일시스템
// (APFS 기본 포맷)이 case-insensitive 라 "Package.json" 과 "package.json" 이 실제로 같은 파일을
// 가리키기 때문이다. Linux(사내 CI 포함)는 기본이 case-sensitive 라 무조건 소문자로 접으면 실제로
// 다른 두 파일을 같은 것으로 오판할 위험이 있어 게이트를 둔다 — darwin 이 아닌 한 대소문자를
// 그대로 유지한다. opts.caseInsensitive 로 명시적으로 재정의할 수 있다(테스트/장차 FS 감지 고도화 용).
//
// opts.trim (기본 true, §z-parse D4/D6/D8/D10): 선행/후행 공백류(개행 포함)를 제거할지 여부.
// 기존 호출부는 전부 옵션을 넘기지 않으므로 기본값 true 로 동작이 그대로 보존된다. git -z 로 파싱한
// 경로(개행으로 시작·끝나는 실제 파일명이 그 자체일 수 있음)를 다루는 신규 호출부만 trim:false 를
// 명시적으로 넘겨 원문 경계 공백을 보존한다 — trim 은 "사용자가 손으로 입력한 경로의 우발적 공백
// 제거"에는 맞지만, git 이 보고한 실제 파일명 앞뒤의 개행을 조용히 지워버리면 서로 다른 두 경로가
// 같은 것으로 오판되거나(과잉 차단) 위조 비교가 어긋나는(과소 차단) 결과를 낳는다.
export function normalizeRepoRelative(
  p: string,
  opts: { caseInsensitive?: boolean; trim?: boolean } = {},
): string {
  const caseInsensitive = opts.caseInsensitive ?? process.platform === "darwin";
  const trim = opts.trim ?? true;
  let s = trim ? p.trim() : p;
  if (s === "") return s;
  s = s.split(path.sep).join("/");
  s = path.posix.normalize(s);
  if (s === ".") s = "";
  s = s.replace(/^\/+/, "").replace(/\/+$/, "");
  s = s.normalize("NFC");
  if (caseInsensitive) s = s.toLowerCase();
  return s;
}

// ── 표시용 가역 이스케이프 (§z-parse P4/D1) ─────────────────────────────────
// -z 로 파싱한 경로는 개행·제어문자를 원문 그대로 담을 수 있다(git 의 core.quotePath 는 -z 출력에는
// 적용되지 않는다). 이런 문자열을 로그/오류 메시지/다음 세션 프롬프트에 그대로 찍으면 한 줄처럼
// 보이던 로그가 여러 줄로 쪼개지거나 뒤섞여 경로 경계를 알아볼 수 없게 된다. JSON.stringify 는
// 제어문자를 표준 이스케이프 시퀀스로 바꿔 한 줄에 안전하게 표시하면서도, 다음 세션이
// JSON.parse 로 원본 문자열을 정확히 복원할 수 있는 가역 표기다 — 그래서 "표시용"과 "실행 지시용
// 프롬프트에 넣는 용도"를 하나의 표기로 통일할 수 있다.
export function displayPath(p: string): string {
  return JSON.stringify(p);
}

// ── 임의 길이 원문 절단 표기 (§z-parse D7 전용) ──────────────────────────────
// displayPath 와 용도가 다르다 — displayPath 는 "경로 하나"를 가역적으로 표시하는 것이 목적이고,
// truncateForDisplay 는 길이가 정해지지 않은 원문(예: 기형 -z 레코드 전체, 여러 필드가 이어붙은
// 바이트열)이 오류 메시지를 무한정 늘리지 않도록 상한을 두는 것이 목적이다. 진단 가능성(D7 —
// fail-closed 오류 메시지는 사람이 원인을 봐야 하므로 최소한의 원문을 담아야 한다)과 메시지 크기
// 상한을 동시에 만족시킨다. 잘림 여부와 원본 길이를 표기에 남겨 "이게 전체냐 일부냐"를 사람이
// 헷갈리지 않게 한다.
export function truncateForDisplay(text: string, limit = 200): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…(truncated, ${text.length} chars total)`;
}

// ── 셸 명령 형태 인식 ────────────────────────────────────────────────────────
// §31 후속: `bash -c '...'` 언래퍼가 gate.ts(verifyReferencedFiles)와 verifylint.ts(린트
// 정규화) 두 곳에 각각 구현돼 있었다. 같은 문제를 두 곳에서 풀면 갈라진다는 것이 §30 P1 의
// 교훈이므로 여기로 합친다(paths.ts 는 로컬 import 가 없는 leaf 모듈이라 순환 위험이 없다).
//
// **셸 인용 규칙을 정확히 흉내내려 하지 않는다** (§30 P3 — permissions.ts 의 토크나이저가 그
// 방향으로 두 번 뚫렸다). 여는/닫는 인용부호가 같은 종류(한 겹)인 단순한 형태만 넓게 잡고
// 나머지는 놓친다 — 이 함수의 미탐은 안전 문제가 아니라 커버리지 문제다.
//
// 선택적으로 호출 시점 pipefail 플래그를 인식한다(`bash -o pipefail -c '...'`,
// `bash -eo pipefail -c '...'`): 이 형태는 안쪽에 `set -o pipefail` 이 없어도 파이프라인
// 전체의 실패가 호출자 exit code 에 반영되므로, 린트가 오탐하지 않으려면 알아야 한다(§31 I1).
//
// §32 m-3 — 감사 실측: `bash -lc 'exit 0'`/`sh -ec 'exit 0'`/`/bin/bash -c 'exit 0'` 는 전부
// 이 정규식이 벗기지 못해 verifylint.ts 쪽 이슈가 0건이었다(항상 exit 0 인데 미탐). 원인은
// 리터럴 "bash"/"sh" 만 인식했고(절대경로 접두·zsh/ksh 미인식) `-c` 도 "정확히 -c" 만
// 인식했다(`-lc`/`-ec` 같은 로그인/errexit 플래그와 묶인 클러스터 미인식). 아래처럼 넓혔다:
//   - `(?:\S*\/)?` — `/bin/bash`, `/usr/bin/sh` 같은 절대/상대 경로 접두를 허용
//   - `(?:ba|z|k)?sh` — bash/zsh/ksh/sh 전부 인식(플레인 `sh` 포함)
//   - `-[a-zA-Z]*c` — `-c` 뿐 아니라 `-lc`/`-ec`/`-xc` 같이 다른 플래그와 묶인 클러스터도 인식
//     (마지막 글자가 `c` 이면 그 뒤 인자가 실행할 명령 문자열이라는 것은 bash 옵션 파싱 규칙과
//     일치한다 — PIPEFAIL_SET_RE 의 "-o" 클러스터 규칙과 같은 논리).
// 이 확장은 gate.ts(verifyReferencedFiles)도 같이 쓴다 — 벗기는 형태가 늘어나면 그만큼 재귀
// 분석 대상이 늘어나 "가드 대상 파일 집합"이 커질 뿐(§30 P1 공유 헬퍼), 벗기던 것을 못 벗기게
// 되는 방향의 변화는 없다 — 즉 항상 상위집합이고 우회를 새로 만들지 않는다(§32 m-4 확인 사항,
// paths.test.ts/gate.test.ts 로 재확인).
const SH_C_WRAPPER_RE = /^(?:\S*\/)?(?:ba|z|k)?sh\s+(-[a-zA-Z]*o\s+pipefail\s+)?-[a-zA-Z]*c\s+(['"])([\s\S]*)\2$/;

export interface ShCUnwrapped {
  /** 인용부호를 벗긴 안쪽 명령 */
  inner: string;
  /** 감싸는 호출에 `-o pipefail` 계열 플래그가 있었나 */
  pipefailForced: boolean;
}

/** `bash -c '...'` / `sh -c "..."` (+ 선택적 `-o pipefail`) 를 벗긴다. 형태가 아니면 null. */
export function unwrapShC(text: string): ShCUnwrapped | null {
  const m = text.match(SH_C_WRAPPER_RE);
  if (!m) return null;
  return { inner: m[3]!, pipefailForced: Boolean(m[1]) };
}

import { unwrapShC } from "./paths.js";

// §18/§26 I5 — 이 도구의 전체 가치가 verify 명령의 exit code 한 점에 걸려 있는데, 그 신뢰가
// 한동안 "사용자의 산문 규율"로만 지켜졌다(README/SKILL/start.md 의 경고는 코드 검사가 없었다).
// 여기서는 그 산문 규칙을 실제로 검사 가능한 순수 함수로 옮긴다.
//
// §26 I5 잔여(승격) 배경: 원래 이 모듈의 내용은 doctor.ts 안에 있었고 `fw doctor` 의 옵트인
// 진단에만 쓰였다 — `fw run` 은 이 린트를 전혀 보지 않아, `npm test || true` 처럼 항상 exit 0 인
// 명령이 fw doctor 에서도 "ok" 로 나오면서 밤새 게이트가 전부 "통과"하고 워크플로우가 done 이 될
// 수 있었다(§29 MI-11 실측). state.ts 의 assertRunnable 이 이 린트로 시작을 거부하게 승격하면서,
// state.ts → doctor.ts → state.ts 순환 의존을 피하기 위해 린트 로직 자체를 이 leaf 모듈로
// 분리했다. doctor.ts 는 기존 export(`lintVerifyCommands`/`VerifyIssue`)를 그대로 re-export 해
// 기존 호출부·테스트가 깨지지 않게 한다.
//
// §31 I1/I2 적대적 재감사 배경: §26 I5 잔여 승격이 `fw run` 시작 자체를 거부하는 등급으로
// 올라가면서, 이 린트의 오탐(정당한 명령을 거부)과 미탐(진짜 무력화 패턴을 놓침) 양쪽 모두의
// 파급력이 커졌다. 실측된 문제 2가지를 이번에 고친다:
//   - I1(오탐, Critical 급): `set -eo pipefail`/`set -euo pipefail`(플래그 조합형) 과
//     `bash -o pipefail -c '...'`(호출 시점 플래그), `if [ -f x ]; then npm test; fi`(조건이
//     아니라 본문에 실제 검증이 있는 조건문) 이 전부 `fw run` 시작을 거부당했다 — 전부 실제
//     셸에서는 exit code 가 정상 전파된다(실측). 조합형 플래그를 인식하는 정규식으로 바꾸고,
//     `bash/sh -c` 래퍼(및 그 호출 시점 pipefail 플래그)를 벗겨 안쪽 명령을 재귀적으로 검사하며,
//     if/then/fi 는 본문이 실제로 실패할 수 있는 명령이면(=조건이 참일 때 실패가 정상 전파되면)
//     error 가 아니라 warn 으로 낮춘다(§30 P2 — 방어가 정상 경로를 막지 않게 한다).
//   - I2(미탐, Important 급): `exit 0` 단독, 주석만 있는 명령(`#...`), `bash -c 'exit 0'`,
//     `npm test || /usr/bin/true`(`||` 뒤 always-zero 목록이 `true`/`:` 뿐이었음), `npm test |
//     cat`(파이프 종단이 exit code 를 삼킴, `| tee` 만 잡던 문제), `( npm test; exit 0 )`(괄호
//     그룹), `npm test & # bg`(후행 주석)가 전부 시작을 통과했다 — 원인은 (a) `||` 뒤
//     always-zero 판정이 `true`/`:` 뿐이었고 (b) 규칙들이 `^`/`$` 로 명령 전체를 앵커링해
//     `bash -c` 래핑·후행 주석·괄호 그룹으로 쉽게 무력화됐기 때문이다. §30 P3("모르는 문법을
//     만나면 거부한다")를 따라 규칙 자체를 정교화하는 대신, 검사 전에 명령을 "정규화"
//     (주석 제거 → 괄호/중괄호 그룹 벗기기 → bash/sh -c 래퍼 벗기기, 고정점까지 반복)해 기존
//     규칙이 실제로 봐야 할 알맹이를 보게 만든다.
export interface VerifyIssue {
  command: string;
  severity: "error" | "warn";
  reason: string;
}

// §26 I5 감사: 이전 버전은 문자열 3~4개(`|| true`, `; true`, 단독 `true`/`:`, echo-only)에
// 고정된 개별 if 블록이었다 — `|| exit 0`, `|| echo ...`, `set +e`, 트레일링 `&`, `; exit 0`,
// `if ... fi` 같은 "같은 효과의 다른 표현"을 놓쳤다(실측). 게다가 `| tee` 규칙은 자신이 제시하는
// 해결책(`set -o pipefail && ... | tee ...`)을 적용해도 계속 error 로 잡아 사용자가 안내를 따라도
// 탈출할 수 없었다(실측 — §18 "실측 신뢰"의 신뢰성 문제). 규칙을 데이터 테이블로 재구성해 새
// 패턴을 규칙 하나 추가로 반영할 수 있게 한다.

// ---------------------------------------------------------------------------
// §31 I2: 정규화 전처리 — 검사 전에 (a) 후행 주석 (b) 괄호/중괄호 그룹 (c) bash/sh -c 래퍼를
// 벗겨 규칙이 "알맹이"를 보게 한다. 파서를 정확히 흉내내지 않는다(§30 P3) — 못 벗기면 그냥
// 원문 그대로 두고 기존 규칙에 맡긴다(미탐으로 남을지언정 오탐을 새로 만들지 않는다).
// ---------------------------------------------------------------------------

// 인용 밖의 첫 "#" 부터 끝까지 제거한다. "#" 은 공백 뒤(또는 문자열 시작)에 와야 주석으로 친다
// (셸에서 "foo#bar" 의 "#" 은 주석이 아니다). 작은따옴표/큰따옴표 안의 "#" 은 건너뛴다.
function stripTrailingComment(text: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "#" && !inSingle && !inDouble && (i === 0 || /\s/.test(text[i - 1]!))) {
      return text.slice(0, i);
    }
  }
  return text;
}

// 여는/닫는 문자가 명령 "전체"를 감싸고, 그 사이에서 depth 가 정확히 끝에서만 0 이 되는지
// 확인한다(문자열 중간에 우연히 등장하는 짝은 걸러낸다 — 예: "foo(a) && bar(b)").
function isBalancedWrapping(text: string, open: string, close: string): boolean {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) return i === text.length - 1;
        if (depth < 0) return false;
      }
    }
  }
  return false;
}

function stripOuterGroup(text: string): string | null {
  if (text.length < 2) return null;
  if (text[0] === "(" && text[text.length - 1] === ")" && isBalancedWrapping(text, "(", ")")) {
    return text.slice(1, -1);
  }
  if (text[0] === "{" && text[text.length - 1] === "}" && isBalancedWrapping(text, "{", "}")) {
    return text.slice(1, -1);
  }
  return null;
}

// `bash -c '...'`(+ 선택적 `-o pipefail`) 언래퍼는 paths.ts 의 `unwrapShC` 로 합쳤다 —
// gate.ts 의 verifyReferencedFiles 도 같은 문제를 풀고 있었고, 같은 문제를 두 곳에서 풀면
// 갈라진다(§30 P1). paths.ts 는 로컬 import 가 없는 leaf 모듈이라 순환 위험이 없다.

interface Normalized {
  core: string;
  // 감싸는 `bash/sh -o pipefail -c '...'` 호출이 있었으면 true — 이 경우 안쪽 명령에
  // `set -o pipefail` 이 따로 없어도 파이프라인 전체의 실패가 호출자의 exit code 에 반영된다.
  pipefailForced: boolean;
}

// §32 m-3: `env` 는 뒤에 오는 명령을 그대로 실행하고 그 exit code 를 투명하게 전달한다(자체
// 적으로 무엇도 삼키지 않는다) — `env CI=true npm test` 는 완전히 정당한 verify 명령이다
// (§30 P2, 감사자가 "정상 경로" 표에 직접 명시). 문제는 `env` 뒤에 실제 명령이 없고 이미
// 알려진 항상-성공 패턴만 남는 경우(`env true`)뿐이다. `env` 접두와 그 뒤에 이어지는
// `VAR=value` 할당들을 벗겨서 기존 규칙이 알맹이를 보게 만든다 — 새 판정 규칙이 아니라
// unwrapShC 와 같은 "정규화" 전략이다: env 뒤에 실제 검증 명령이 남으면(`npm test` 등) 그
// 명령은 원래 하던 대로 그대로 검사되어 이슈가 없다.
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S*)\s+/;

function stripEnvPrefix(text: string): string | null {
  const m = text.match(/^env\s+/);
  if (!m) return null;
  let rest = text.slice(m[0].length);
  for (;;) {
    const assign = rest.match(ENV_ASSIGNMENT_RE);
    if (!assign) break;
    rest = rest.slice(assign[0].length);
  }
  return rest.trim();
}

// §32 m-3: `eval '...'` 는 인용된 문자열을 그대로 셸에 다시 넘겨 실행한다 — `bash/sh -c`와
// 동일하게 완전히 투명한 exit code 전파다(`eval 'exit 0'` 는 사실상 `exit 0` 그 자체). 정적
// 문자열(작은/큰따옴표 한 겹)만 인식한다 — `eval "$(...)"` 처럼 동적으로 생성되는 형태는
// 벗기지 않고 그대로 둔다(§30 P3 — 판정 불가한 문법은 거부하지 않고 그냥 놓친다, 미탐으로
// 남을지언정 오탐을 만들지 않는다).
const EVAL_RE = /^eval\s+(['"])([\s\S]*)\1$/;

function unwrapEval(text: string): string | null {
  const m = text.match(EVAL_RE);
  return m ? m[2]! : null;
}

// 고정점(더 이상 벗길 게 없음)까지 반복한다. 반복 상한(20)은 병적으로 깊은 중첩에 대한 방어일
// 뿐 — 실전 verify 명령이 이 깊이로 중첩될 일은 없다.
function normalizeForLint(input: string): Normalized {
  let text = input;
  let pipefailForced = false;
  for (let i = 0; i < 20; i++) {
    const withoutComment = stripTrailingComment(text).trim();
    if (withoutComment !== text) {
      text = withoutComment;
      continue;
    }

    const grouped = stripOuterGroup(text);
    if (grouped !== null) {
      text = grouped.trim();
      continue;
    }

    const shC = unwrapShC(text);
    if (shC) {
      text = shC.inner.trim();
      pipefailForced = pipefailForced || shC.pipefailForced;
      continue;
    }

    const envStripped = stripEnvPrefix(text);
    if (envStripped !== null && envStripped !== text) {
      text = envStripped;
      continue;
    }

    const evalInner = unwrapEval(text);
    if (evalInner !== null) {
      text = evalInner.trim();
      continue;
    }

    break;
  }
  return { core: text, pipefailForced };
}

// "||" 를 먼저 마스킹한 뒤 남은 "|" 의 위치가 진짜 파이프(단일 파이프라인)다. 없으면 -1.
function firstRealPipeIndex(trimmed: string): number {
  return trimmed.replace(/\|\|/g, "@@").indexOf("|");
}

function hasRealPipe(trimmed: string): boolean {
  return firstRealPipeIndex(trimmed) >= 0;
}

function isEchoOnly(trimmed: string): boolean {
  // "echo 만으로 구성" — 체인 연산자(&&, ||, ;, |)가 전혀 없고 echo 로 시작하면 명령 전체가
  // echo 뿐이라는 뜻이다. "echo ok && npm test" 처럼 뒤에 실제 검증이 이어지면 그 검증의 exit
  // code 가 여전히 전체 판정에 반영되므로 여기 해당하지 않는다(의도적으로 제외).
  return /^echo\b/.test(trimmed) && !/(&&|\|\||;|\|)/.test(trimmed);
}

// §31 I1: 이전 버전은 리터럴 `-o` 만 인식해 `set -eo pipefail`/`set -euo pipefail` 같은 흔한
// 플래그 조합형을 놓쳤다(실측: 전부 실제 셸에서 pipefail 이 정상 적용되는데 린트만 거부). bash
// 의 짧은 옵션 클러스터는 왼쪽에서부터 순서대로 처리되고 `-o` 는 인자(다음 단어)를 소비하므로,
// 클러스터의 "마지막 글자"가 `o` 일 때만 그 뒤의 단어가 `-o` 의 인자가 된다(`-eo pipefail` =
// -e, -o pipefail / `-oe pipefail` 은 -o 의 인자가 "e" 가 되어 버려 pipefail 이 적용되지 않는다
// — 이 규칙은 그 실제 bash 파싱 순서를 그대로 반영한다).
//
// §32 m-1: `(?:^|&&)` 만 인정하던 앞선 버전은 `set -o pipefail` 앞에 다른 문장이 하나라도 있으면
// (`;` 로 구분되거나 `export CI=true;` 처럼 앞선 대입 뒤에 오면) 탈출구 자체가 안 먹었다(실측
// 전부 exit 7 정상 전파): `export CI=true; set -o pipefail; npm test | tee`, `cd app; set -o
// pipefail; npm test | tee`. `set` 은 셸 명령문 어디에 와도(문장 구분자 `;`/`&&`/개행 뒤, 또는
// 문자열 맨 앞) 그 시점부터 shell 옵션에 적용되므로 `;`/개행도 유효한 선행 경계다.
const PIPEFAIL_SET_RE = /(?:^|&&|;|\n)\s*set\s+-[a-zA-Z]*o\s+pipefail\b/;

// §31 I1: `bash -o pipefail -c '...'`/`bash -eo pipefail -c '...'` 처럼 `set` 이 아니라 셸
// 호출 시점의 `-o pipefail` 플래그로 지정하는 형태 — normalizeForLint 가 이미 이 래퍼를 벗기며
// pipefailForced 플래그로 넘겨주므로, 여기서는 그 플래그만 보면 된다(문자열을 다시 스캔하지
// 않는다 — 단일 진실 공급원).
function isPipefailGuarded(trimmed: string, pipefailForced: boolean): boolean {
  if (pipefailForced) return true;
  const guardMatch = PIPEFAIL_SET_RE.test(trimmed) ? trimmed.search(PIPEFAIL_SET_RE) : -1;
  if (guardMatch < 0) return false;
  const pipeIdx = firstRealPipeIndex(trimmed);
  return pipeIdx >= 0 && guardMatch < pipeIdx;
}

// `if <cond>; then <body>; fi` 는 else/elif 가 없으면 POSIX 상 "조건이 거짓이면(=실행된 분기가
// 없으면) exit 0" 이다. else/elif 가 있으면 그 분기가 실패를 어떻게 다루는지 정적으로 단정할 수
// 없어(예: `else exit 1; fi` 는 오히려 실패를 올바르게 전파) 아예 잡지 않는다(판단 유보).
const IF_THEN_RE = /^if\b[\s\S]*\bthen\b[\s\S]*\bfi\s*;?\s*$/;

function isBareIfWithoutElse(trimmed: string): boolean {
  return IF_THEN_RE.test(trimmed) && !/\b(else|elif)\b/.test(trimmed);
}

// §31 I1 실측: `if [ -f package.json ]; then npm test; fi` 는 조건이 참이면(package.json 이
// 있으면) `then` 절이 실행되고 if 문 전체의 exit code 는 그 절의 마지막 명령(npm test) 의 exit
// code 그대로다 — 조건이 거짓일 때만 exit 0 이 된다. 반면 `if npm test; then echo ok; fi` 는
// "then" 절이 항상 성공하는 명령(echo)뿐이라 조건 참/거짓 양쪽 분기 모두 exit 0 이 되어
// 완전히 무력화된다. 두 형태를 구분하려면 "then" 절 본문이 그 자체로 실패할 수 있는지를 봐야
// 한다 — 본문이 비어있거나 이미 알려진 "항상 성공" 패턴(echo-only/standalone-true)이면 조건의
// 참/거짓과 무관하게 전체가 무력화되므로 error 로 남기고, 그렇지 않으면(본문이 실제 검증
// 명령일 가능성이 있으면) 조건이 거짓인 경로만 문제이므로 warn 으로 낮춘다(§30 P2).
function ifThenBody(trimmed: string): string {
  const m = trimmed.match(/^if\b[\s\S]*?\bthen\b([\s\S]*)\bfi\s*;?\s*$/);
  if (!m) return "";
  return m[1]!.trim().replace(/;\s*$/, "").trim();
}

function isTrivialIfBody(body: string): boolean {
  return body === "" || /^(?:true|:)$/.test(body) || isEchoOnly(body);
}

function isBareIfNoElseTrivialBody(trimmed: string): boolean {
  return isBareIfWithoutElse(trimmed) && isTrivialIfBody(ifThenBody(trimmed));
}

function isBareIfNoElseNonTrivialBody(trimmed: string): boolean {
  return isBareIfWithoutElse(trimmed) && !isTrivialIfBody(ifThenBody(trimmed));
}

// §31 I2: "||" 뒤에 오는 절이 실패를 전파하지 않는다고 "알려진" 것들 — 화이트리스트가 아니라
// "실패를 삼키는 것으로 확인된" 목록이다. 여기 없는 것(`|| some-unknown-cmd`)은 error 로
// 단정하지 않는다 — `|| exit 1` 처럼 실패를 올바르게 전파하는 형태까지 막으면 §26 I5 가 이미
// 겪은 자충수가 재발한다(§30 P2). `test`(단독 조건식)는 실행 결과에 따라 실패할 수 있어
// 일부러 목록에서 뺐다(감사 초안이 예시로 들었지만, 항상 성공을 보장하지 않아 오탐 위험이 더
// 크다고 판단 — §31 보고서 참고).
const OR_KNOWN_SAFE_CLAUSE_RE =
  /^(?:true|:|exit\s+0|echo\b.*|printf\b.*|\/usr\/bin\/true|\/bin\/true|sleep\b.*|cd\b.*|pwd)$/;
// 실패를 그대로 전파하는 것으로 "알려진" 형태 — 여기 해당하면 error 도 warn 도 달지 않는다
// (기존 회귀: `npm test || exit 1` 은 이슈가 전혀 없어야 한다).
const OR_KNOWN_PROPAGATING_CLAUSE_RE = /^exit\s+[1-9]\d*$/;

// "||" 뒤에 오는 절 전부를 뽑는다. 각 절은 다음 `;`/`&`(=`&&`)/`|` 또는 문자열 끝까지다. 셸
// 인용을 완전히 흉내내지 않는다(§30 P3 — 못 뽑는 것은 괜찮지만 잘못 뽑지는 않는다는 기존 방침과
// 동일선상. 인용 안에 "||" 가 있는 극히 드문 경우는 의도적으로 포기한다).
function orClauses(trimmed: string): string[] {
  const segments = trimmed.split("||");
  const clauses: string[] = [];
  for (let i = 1; i < segments.length; i++) {
    const m = segments[i]!.match(/^\s*([^;&|]*)/);
    const clause = (m ? m[1]! : "").trim();
    if (clause) clauses.push(clause);
  }
  return clauses;
}

// §32 m-3: 감사 실측 — `npm test || (exit 0)`/`npm test || command true` 는 여전히 exit 0 인데
// OR_KNOWN_SAFE_CLAUSE_RE 가 문자 그대로만 비교해 놓쳤다(warn 만, error 없음). `(exit 0)` 는
// 절 전체가 괄호로 감싸였을 뿐 alwaysZero 판정에는 영향이 없고(stripOuterGroup 이 이미 이 문제를
// 풀고 있다 — §30 P1 재사용), `command true` 는 `command` 빌트인이 별칭/함수를 우회해 그대로
// `true` 를 실행할 뿐이다(exit 0 은 동일). 둘 다 "판정에 무관한 겉포장"이라 벗기고 나서 검사한다.
function normalizeOrClause(clause: string): string {
  const unwrapped = stripOuterGroup(clause);
  let c = (unwrapped ?? clause).trim();
  c = c.replace(/^command\s+/, "");
  return c;
}

function hasKnownAlwaysZeroOrClause(trimmed: string): boolean {
  return orClauses(trimmed).some(c => OR_KNOWN_SAFE_CLAUSE_RE.test(normalizeOrClause(c)));
}

// §31 I2: 판정 불가한 `||` 절은 error 로 단정하지 않고 warn 으로 남긴다(§30 P2). 이미 알려진
// always-zero 절이 있는 명령은 error 규칙이 먼저 잡아 warn 루프 자체가 실행되지 않으므로
// (lintVerifyCommands 의 hasError 게이트), 여기 도달했다는 것은 always-zero 절이 없다는 뜻이다.
function hasUnknownOrClause(trimmed: string): boolean {
  return orClauses(trimmed).some(c => {
    const n = normalizeOrClause(c);
    return !OR_KNOWN_SAFE_CLAUSE_RE.test(n) && !OR_KNOWN_PROPAGATING_CLAUSE_RE.test(n);
  });
}

// §31 I2: `| cat` 은 `| tee` 와 같은 문제(파이프 종단의 exit code 로 전체가 판정됨)를 겪으면서도
// tee 와 달리 산출물을 남기는 등의 부수 효과조차 없다 — 존재할 정당한 이유가 사실상 없는
// "그대로 통과" 필터라 error 로 잡는다. `| head -N`/`| tail -N` 은 CI 로그를 자르는 매우 흔한
// 관용구라(예: `pytest -q | tail -20`) 같은 문제를 안고 있어도 warn 에 그친다(과잉 차단이 더
// 나쁘다는 §30 P2 판단 — 이미 "real-pipe" warn 규칙이 잡아준다). 확신이 없는 head/tail 류를
// error 로 올리지 않기로 한 이 판단은 §31 감사가 `pytest -q | tail -20` 을 "정상 경로(warn 이
// 정상)"로 명시했기 때문이다.
function pipesIntoCat(trimmed: string): boolean {
  return /\|\s*cat\b/.test(trimmed.replace(/\|\|/g, "@@"));
}

// §32 m-1: `set +e` 자체는 항상 위험 신호이지만(뒤이은 명령의 실패가 조용히 무시될 수 있다),
// `rc=$?; ...; exit $rc` 처럼 종료 코드를 변수에 담아뒀다가 정리 작업(cleanup) 뒤에 명시적으로
// 그 값으로 exit 하는 관용구는 오히려 "실패를 보존하려는 의도"다(실측: `set +e; npm test;
// rc=$?; docker compose down; exit $rc` 는 실제 셸에서 exit 7 이 정상 전파된다 — docker
// compose down 자체가 실패해도 우리가 잡아둔 rc 로 exit 하므로 npm test 의 실패가 가려지지
// 않는다). 이 관용구가 보이면 error 대신 warn 으로 낮춘다(§30 P2) — 그 사이(rc 캡처와 exit
// 사이)의 다른 명령이 실패를 삼킬 수도 있다는 점은 여전히 남아 warn 은 유지한다.
const RC_CAPTURE_RE = /\b([A-Za-z_][A-Za-z0-9_]*)=\$\?/;

function hasExitCodePreservationIdiom(core: string): boolean {
  const m = core.match(RC_CAPTURE_RE);
  if (!m) return false;
  const varName = m[1]!;
  const exitRe = new RegExp(`exit\\s+"?\\$\\{?${varName}\\}?"?\\b`);
  return exitRe.test(core);
}

interface LintRule {
  id: string;
  test: (core: string, pipefailForced: boolean) => boolean;
  message: string;
}

// error 규칙: 게이트를 구조적으로 무력화하는(또는 무력화할 개연성이 매우 높은) 패턴 — 검증이
// 실패해도 절대(또는 통상적으로) non-zero exit 하지 않는다. `core` 는 normalizeForLint 를 거친
// 뒤의 문자열이다(주석/괄호 그룹/bash·sh -c 래퍼가 벗겨진 상태).
const ERROR_RULES: LintRule[] = [
  {
    id: "standalone-true",
    // §32 m-3: 후행 `;` 하나를 허용한다 — `{ true; }` 를 stripOuterGroup 이 벗기면 남는 core 는
    // "true;"(중괄호 안 마지막 문장의 세미콜론이 그대로 남는다)이지 "true" 가 아니다. 엄격한
    // `$` 앵커만 쓰면 그룹을 벗긴 뒤에도 이 흔한 형태를 여전히 놓친다(실측: 이슈 0건).
    test: core => /^(?:true|:)\s*;?\s*$/.test(core),
    message: "명령이 `true`/`:` 단독이라 항상 성공합니다 — 실제 검증을 수행하지 않습니다.",
  },
  {
    id: "standalone-exit-zero",
    // §31 I2: `exit 0` 단독(체인 없이 명령 전체가 이것뿐인 경우) — `bash -c 'exit 0'` 도
    // normalizeForLint 가 래퍼를 벗기면 여기 걸린다.
    // §32 m-3: standalone-true 와 같은 이유로 후행 `;` 하나를 허용한다(`{ exit 0; }` 대응).
    test: core => /^exit\s+0\s*;?\s*$/.test(core),
    message: "명령이 `exit 0` 단독이라 항상 성공합니다 — 실제 검증을 수행하지 않습니다.",
  },
  {
    id: "or-always-zero",
    // §31 I2: `|| true`/`|| :` 뿐 아니라 `|| exit 0`/`|| echo ...`/`|| printf ...`/
    // `|| /usr/bin/true`/`|| /bin/true`/`|| sleep ...`/`|| cd ...`/`|| pwd` 도 모두 실패를
    // 삼켜 항상 exit 0 으로 끝나는 것으로 알려진 형태다. §32 m-3: `(exit 0)`/`command true` 처럼
    // 괄호/`command` 로 감싸도(normalizeOrClause 가 벗긴다) 마찬가지로 잡는다.
    test: hasKnownAlwaysZeroOrClause,
    message:
      "`||` 뒤에 실패를 삼키는 것으로 알려진 명령(`true`/`:`/`exit 0`/`echo ...`/`printf ...`/" +
      "`/usr/bin/true`/`/bin/true`/`sleep ...`/`cd ...`/`pwd`, 괄호로 감싸거나 `command` 를 붙여도 " +
      "동일)이 있어 항상 exit 0 이 됩니다 — 검증이 무력화됩니다. 실패를 실제로 전파하도록 바꾸세요" +
      "(예: `|| exit 1`).",
  },
  {
    id: "trailing-true-or-colon",
    // §32 m-3: `true && true` 도 마지막 `&& true` 가 앞선 실패를 항상 가린다 — 기존에는 `;` 로
    // 끝나는 형태(`; true`)만 잡았는데, trailing-exit-zero 규칙이 이미 `;`/`&&` 양쪽을 같은
    // 값(`exit 0`)에 대해 잡고 있는 것과 달리 이 규칙만 `;` 로 좁아 있었다(비대칭 결함).
    test: core => /(?:;|&&)\s*(?:true|:)\s*$/.test(core),
    message: "`; true`/`&& true`(또는 `; :`/`&& :`)로 끝나 앞 명령이 실패해도 마지막 exit code 는 항상 0 입니다. 제거하세요.",
  },
  {
    id: "trailing-exit-zero",
    test: core => /(?:;|&&)\s*exit\s+0\s*$/.test(core),
    // `&& exit 0` 은 엄밀히는 앞 명령이 실패하면 단락 평가로 실행조차 되지 않아 그 자체로 결과를
    // 바꾸지는 않지만(항상 이미 성공했을 때만 도달), 실전에서 의미 없는 "명시적 성공 강제"로만
    // 쓰이고 `;` 와 혼동해 실제로는 실패를 삼킬 의도로 잘못 작성되는 사례가 흔해 함께 error 로
    // 잡는다(§26 감사가 `; exit 0` 과 `&& exit 0` 을 같은 항목으로 묶어 지적).
    message: "`; exit 0`/`&& exit 0` 로 끝나면 앞 명령의 실패가 항상 가려집니다(또는 무의미한 명시적 성공 강제입니다). 제거하세요.",
  },
  {
    id: "echo-only",
    test: isEchoOnly,
    message: "`echo` 로만 구성된 명령은 항상 exit 0 입니다 — 실제 검증 명령으로 교체하세요.",
  },
  {
    id: "comment-or-empty",
    // §31 I2: `#npm test` 처럼 명령 전체가 주석이면 normalizeForLint 가 core 를 빈 문자열로
    // 만든다 — 셸이 아무 것도 실행하지 않고 exit 0 으로 끝나는 것과 동일하다.
    test: core => core === "",
    message:
      "명령이 전부 주석이거나(예: `#npm test`) 래퍼를 벗기면 실행되는 내용이 남지 않습니다 — 항상 성공(exit 0)한 것처럼 보일 뿐 아무 것도 검증하지 않습니다.",
  },
  {
    id: "tee-without-pipefail",
    // §26 I5 오탐 수정: `set -o pipefail && ... | tee ...`(또는 `bash -o pipefail -c '... | tee
    // ...'`) 처럼 pipefail 로 가드된 경우는 파이프라인 전체의 실패가 반영되므로 더는 error 가
    // 아니다(린트가 제시하는 해결책 그대로 적용해도 계속 error 로 잡히던 문제, 실측).
    //
    // §32 m-2: 메시지가 먼저 권하던 `set -o pipefail && ...` 는 `/bin/sh` 가 dash 인 배포판
    // (여러 Linux 기본값)에서 `set: Illegal option -o pipefail`(exit 2)로 하드 실패한다(실측 —
    // gate.ts 의 runGate 가 `spawn(cmd, { shell: true })` = `/bin/sh` 로 실행한다). 이식성이
    // "걱정되면" 대신 쓰라던 `bash -o pipefail -c '...'` 를 먼저 권하도록 순서를 바꾼다 — 이
    // 형태는 셸 자체를 bash 로 못박아 어떤 `/bin/sh` 를 쓰든 항상 동작한다.
    test: (core, pipefailForced) => /\|\s*tee\b/.test(core.replace(/\|\|/g, "@@")) && !isPipefailGuarded(core, pipefailForced),
    message:
      "`| tee` 는 tee 의 exit code 로 판정됩니다 — 원래 명령이 실패해도 tee 자체는 보통 성공해 게이트를 통과시킵니다. " +
      "tee 를 제거하거나 `bash -o pipefail -c '... | tee ...'` 처럼 bash 를 명시적으로 호출하세요(권장 — `/bin/sh` 가 " +
      "pipefail 을 지원하지 않는 dash 빌드일 수 있습니다). 이미 bash 환경이 보장돼 있다면 `set -o pipefail && ... | tee ...` 도 됩니다.",
  },
  {
    id: "pipe-cat-without-pipefail",
    test: (core, pipefailForced) => pipesIntoCat(core) && !isPipefailGuarded(core, pipefailForced),
    message:
      "`| cat` 은 cat 의 exit code 로 판정됩니다 — 원래 명령이 실패해도 cat 은 그대로 통과시켜 게이트가 무력화됩니다(가공 없는 " +
      "단순 통과라 tee 와 달리 남기는 산출물도 없습니다). cat 을 제거하거나 `bash -o pipefail -c '...'` 로 바꾸세요(권장 — `/bin/sh` " +
      "가 dash 이면 `set -o pipefail` 이 하드 실패할 수 있습니다). 이미 bash 환경이면 `set -o pipefail && ...` 도 됩니다.",
  },
  {
    id: "exit-zero-flag",
    test: core => /--exit-zero\b/.test(core),
    message: "`--exit-zero` 류 옵션은 오류가 있어도 exit 0 을 강제합니다 — 옵션을 제거하세요.",
  },
  {
    id: "set-plus-e",
    // §32 m-1: `rc=$?; ...; exit $rc` 로 종료 코드를 명시적으로 보존·전파하는 관용구가 같은
    // 명령에 있으면 error 로 단정하지 않는다(§30 P2) — WARN_RULES 의 "set-plus-e-with-rc-capture"
    // 가 대신 경고를 남긴다.
    test: core => /\bset\s+\+e\b/.test(core) && !hasExitCodePreservationIdiom(core),
    message: "`set +e` 는 에러 발생 시 중단을 해제합니다 — 뒤이은 명령의 실패가 무시되기 쉬워집니다. 제거하세요.",
  },
  {
    id: "background",
    // 마지막이 단일 `&`(직전 문자가 `&` 가 아님 — `&&` 는 제외)면 셸이 자식을 백그라운드로 돌리고
    // 즉시 자기 자신의 exit code(보통 0)를 반환한다 — 실제 명령의 성패와 무관해진다.
    test: core => /(?<!&)&\s*$/.test(core),
    message: "명령이 `&`(백그라운드)로 끝나면 셸이 결과를 기다리지 않고 즉시 성공을 반환합니다 — `&` 를 제거하세요.",
  },
  {
    id: "if-then-fi-no-else-trivial-body",
    // §31 I1: 본문이 그 자체로 항상 성공하는 패턴(echo-only/standalone-true/빈 본문)이면 조건의
    // 참/거짓과 무관하게 전체가 무력화된다 — 이때만 error 로 남긴다.
    test: isBareIfNoElseTrivialBody,
    message:
      "`if <cmd>; then <항상 성공하는 본문> fi` (else/elif 없음) 는 조건이 참이든 거짓이든 exit code 가 항상 0 입니다 — " +
      "실패를 명시적으로 전파하도록(`else exit 1; fi` 등) 바꾸거나 if 로 감싸지 마세요.",
  },
];

// warn 규칙: 판정을 흐릴 수 있지만 그 자체로 항상 무력화는 아닌 패턴. error 가 이미 확정된
// 명령에는 덧붙이지 않는다(같은 구조를 놓고 error 와 warn 이 중복 보고되는 것을 피함).
const WARN_RULES: LintRule[] = [
  {
    id: "real-pipe",
    // pipefail 로 가드된 파이프는 마지막 명령의 exit code 만 보는 게 아니므로 경고 대상에서 뺀다.
    test: (core, pipefailForced) => hasRealPipe(core) && !isPipefailGuarded(core, pipefailForced),
    message: "파이프(`|`)가 있으면 마지막 명령의 exit code 만 반영됩니다 — 앞 단계 실패가 가려질 수 있습니다. `set -o pipefail` 사용을 고려하세요.",
  },
  {
    id: "semicolon-without-and",
    test: core => core.includes(";") && !core.includes("&&"),
    message: "`;` 로만 명령을 나열하면 앞 명령이 실패해도 뒤 명령이 계속 실행됩니다 — `&&` 로 연결해 실패를 전파하세요.",
  },
  {
    id: "set-plus-e-with-rc-capture",
    // §32 m-1: ERROR_RULES 의 "set-plus-e" 가 이 관용구를 error 에서 제외했으므로, 여기서
    // 대신 경고만 남긴다 — `rc=$?` 캡처와 `exit $rc` 사이의 다른 명령이 실패를 삼킬 가능성은
    // 여전히 남아 있어 완전히 무시하지는 않는다(§30 P2 — 정당한 관용구를 막지 않되 흔적은 남긴다).
    test: core => /\bset\s+\+e\b/.test(core) && hasExitCodePreservationIdiom(core),
    message:
      "`set +e` 뒤에도 `rc=$?` 로 종료 코드를 저장했다가 `exit $rc` 로 전파하는 관용구가 보입니다 — " +
      "의도적인 종료 코드 보존으로 보이지만, 그 사이(캡처와 exit 사이)의 다른 명령이 실패를 조용히 " +
      "삼키지 않는지 확인하세요.",
  },
  {
    id: "pass-with-no-tests",
    // "테스트가 하나도 없어도 실패시키지 않는다" 는 정당한 용도(신규 모듈 스캐폴딩 등)가 있어
    // error 로 단정하지 않는다 — 다만 존재 자체가 "테스트 미작성"을 조용히 허용할 수 있으므로 경고는 남긴다.
    test: core => /--passWithNoTests\b/i.test(core) || /--passWithNoFiles\b/i.test(core),
    message: "`--passWithNoTests`/`--passWithNoFiles` 는 테스트가 하나도 없어도 성공 처리합니다 — 의도한 것인지 확인하세요.",
  },
  {
    id: "if-then-fi-no-else-nontrivial-body",
    // §31 I1: 본문이 실제로 실패할 수 있는 명령이면(예: `if [ -f package.json ]; then npm test;
    // fi`), 조건이 참인 흔한 경로에서는 실패가 정상 전파된다(실측) — 조건이 거짓일 때만 조용히
    // exit 0 이 되므로 "무력화"라고 단정할 수 없다. error 대신 warn 에 그친다(§30 P2).
    test: isBareIfNoElseNonTrivialBody,
    message:
      "`if <cond>; then <검증> fi` (else/elif 없음) 는 <cond> 가 거짓이면 조용히 exit 0 이 됩니다 — " +
      "<cond> 가 참이면 본문의 실패가 정상 전파되지만, 조건 자체가 검증을 건너뛰게 만들 수 있는지 확인하세요.",
  },
  {
    id: "or-unknown-clause",
    // §31 I2: `||` 뒤에 알려진 always-zero 패턴도, 알려진 실패-전파 패턴(`exit <nonzero>`)도
    // 아닌 명령이 있으면 판정 불가 — error 로 단정하지 않고(§30 P2, `|| exit 1` 류 오탐 방지)
    // 경고만 남긴다. or-always-zero 가 이미 error 로 잡은 명령은 hasError 게이트로 이 규칙까지
    // 오지 않는다.
    test: hasUnknownOrClause,
    message:
      "`||` 뒤의 명령이 실패를 삼키는지 판정할 수 없습니다 — 의도적으로 실패를 전파하는지 확인하세요(예: `|| exit 1` 은 안전합니다).",
  },
];

/**
 * verify 명령 목록을 정적으로 검사해 게이트를 무력화하는 패턴(error)과 판정을 흐릴 수 있는
 * 패턴(warn)을 찾는다. 순수 함수 — 파일/프로세스에 접근하지 않는다.
 */
export function lintVerifyCommands(commands: string[]): VerifyIssue[] {
  const issues: VerifyIssue[] = [];

  for (const command of commands) {
    const trimmed = command.trim();
    if (!trimmed) continue;

    const { core, pipefailForced } = normalizeForLint(trimmed);

    let hasError = false;
    for (const rule of ERROR_RULES) {
      if (rule.test(core, pipefailForced)) {
        issues.push({ command, severity: "error", reason: rule.message });
        hasError = true;
      }
    }

    // 이미 error 로 확정된 명령은 아래 warn 을 덧붙이지 않는다 — 같은 구조(파이프/세미콜론)를
    // 놓고 error 와 warn 이 중복 보고되는 것을 피한다.
    if (!hasError) {
      for (const rule of WARN_RULES) {
        if (rule.test(core, pipefailForced)) {
          issues.push({ command, severity: "warn", reason: rule.message });
        }
      }
    }
  }

  return issues;
}

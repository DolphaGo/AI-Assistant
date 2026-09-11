import fs from "node:fs";
import path from "node:path";

// §28 W1 — PLAN.md 의 §핵심 결정 사항 / §용어 절을 세션 프롬프트에 실제로 주입하기 위한
// 추출기. state.answers 는 이미 "## 사용자 결정 사항" 으로 토상 주입되고 있는데(session.ts),
// PLAN 의 결정·용어는 "PLAN.md 를 읽어라" 라는 말뿐이라 세션이 실제로 읽는지 보장이 없었다
// (설계 §28). 같은 대우를 하기 위한 순수 함수 모음 — 파일 I/O 는 readPlanContext 에만 있고
// extractSection 은 마크다운 문자열만 다루는 순수 함수라 단위 테스트가 쉽다.
//
// §31 I6 재작업: 감사가 실측한 8종 제목 형태 중 6종이 조용히 null 로 떨어지거나(§핵심 결정,
// 1. 핵심 결정, 📌 핵심 결정, setext, 결정 사항, 주요 결정) 구버전 h3 절을 잘못 골랐다. 아래
// findAllHeadings/pickShallowestThenLast/헤딩 별칭 화이트리스트가 그 교정이다. 관측(§30 P4)은
// readPlanContext 의 diagnostics 필드와 doctor.ts 의 [PLAN 결정·용어 주입] 절에 있다.

/** 절 하나가 프롬프트에 기여할 수 있는 최대 길이. PLAN 이 거대해지면 프롬프트가 폭발하므로
 *  상한을 두고, 초과분은 잘라내고 잘렸음을 표시한다. */
const SECTION_CHAR_CAP = 4000;

function truncationMarker(heading: string): string {
  return `\n...(이하 생략 — PLAN §${heading} 절이 ${SECTION_CHAR_CAP}자를 초과했습니다)`;
}

/** 마크다운 ATX 헤딩(`#`~`######`) 한 줄을 매치한다. */
const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;

/** setext 헤딩 밑줄(`===...` → h1, `---...` → h2). 표 구분선(`|----|`)은 파이프가 섞여 있어
 *  이 정규식과 겹치지 않는다. */
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;

/** 코드펜스 여는/닫는 줄(``` 또는 ~~~, 3개 이상). 닫는 줄은 같은 문자·같은 개수 이상이어야
 *  한다(CommonMark 규칙 — 열 때보다 짧은 펜스로는 못 닫는다). */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

// 제목 매칭은 관대해야 한다 — 정확 일치만 하면 "## 핵심 결정 사항 / 제약" 같은 기존
// 워크플로우의 변형 제목이 조용히 누락된다(§30 P2). 공백을 지우고 대소문자를 무시한 뒤
// keyword 로 시작하는지만 본다: "핵심 결정" 은 "핵심 결정 사항", "핵심 결정 사항 / 제약",
// "핵심 결정" 전부와 매치하되, "최종 결정" 같은 무관한 제목과는 매치하지 않는다.
function normalizeHeadingText(s: string): string {
  return s.replace(/\s+/g, "").toLowerCase();
}

/** 제목 앞의 장식(§ 기호, "1." "1)" 류 번호, 이모지/기호 문자)을 반복해서 벗긴다.
 *  "1. § 📌 핵심 결정" 처럼 장식이 섞여도(관측되진 않았지만 방어적으로) 대응하도록 더 이상
 *  벗길 게 없을 때까지 돈다. */
function stripHeadingDecoration(text: string): string {
  let t = text.trim();
  for (;;) {
    const before = t;
    t = t.replace(/^§+\s*/, "");
    t = t.replace(/^\d+[.)]\s*/, "");
    // \p{S} 는 유니코드 "Symbol" 대분류(이모지 대부분 포함, 📌 U+1F4CC 도 So 로 분류됨).
    t = t.replace(/^[\p{Extended_Pictographic}\p{S}]+\s*/u, "");
    if (t === before) break;
  }
  return t;
}

// §31 I6 — "완전 자유 부분 일치"는 쓰지 않는다. 예를 들어 keyword 를 "결정" 한 글자로 두면
// "결정 배경"(NOTES.md 관례상 "왜 이 결정을 했는가"라는 배경 설명 절이지 결정 표 자체가
// 아니다)과 "최종 결정"(무관한 결론)까지 결정 표로 오인해 §30 P2 를 재발시킨다. 대신 실측된
// 변형(§핵심 결정/1. 핵심 결정/📌 핵심 결정/setext)은 stripHeadingDecoration 이 흡수하고,
// 어순이 다른 동의어("결정 사항", "주요 결정")는 화이트리스트로 흡수한다. 화이트리스트는
// 접두 매칭이므로 "결정 배경"(→ "결정배경", 어느 별칭으로도 시작하지 않음)과 "최종 결정"
// (→ "최종결정")은 자연히 걸러진다 — 별도 차단 목록이 필요 없다.
// 이 화이트리스트가 완전하지는 않다(예: 전혀 다른 조어의 새 변형은 여전히 놓칠 수 있다) —
// 이건 산문 제목을 기계가 완벽히 이해할 수 없다는 근본 한계이고(설계 §28 "남는 한계"),
// 그래서 readPlanContext 의 diagnostics 로 미탐을 드러나게 하는 쪽을 택했다(§30 P4).
const DECISIONS_ALIASES = ["핵심 결정", "결정 사항", "주요 결정"];
const GLOSSARY_ALIASES = ["용어"];
// §42 — §검증 기준(인수 기준) 절. 하네스는 "무엇을 검증할지" 를 스스로 정하지 않는다 —
// 상황마다 다르기 때문이다(마이그레이션이면 "Kafka 직렬화 결과가 안 바뀐다", 리팩토링이면
// "공개 API 시그니처가 안 바뀐다"). 사람이 PLAN 에 써넣은 것을 **그대로 운반**해 무인
// 세션과 검증 에이전트 양쪽에 주입한다. 실측된/예상되는 표기 변형을 별칭으로 흡수한다.
// §44 — §개발 방향 절. 3역할(기획/개발/평가) 중 **개발 고수**의 산출물이다. 특히 여기에
// "이 작업의 진입 경로"(어떤 파일부터 읽어야 하는가)가 들어간다 — 프로젝트 전체를 스캔하는
// 것은 토큰 낭비이면서 정작 중요한 곳을 놓친다. 사람이 지정한 진입점에서 시작해 연결된
// 코드로 점진적으로 넓히는 것이 이 절의 용도다.
const ARCHITECTURE_ALIASES = [
  "개발 방향", "개발 방침", "구현 방향", "기술 방향", "설계 방향", "아키텍처", "진입 경로",
  "architecture", "implementation notes",
];
const ACCEPTANCE_ALIASES = [
  "검증 기준", "완료 조건", "완료 기준", "인수 기준", "수용 기준", "합격 기준", "검증 항목",
  "acceptance", "definition of done", "dod",
];

function headingMatches(headingText: string, keywords: readonly string[]): boolean {
  const normalized = normalizeHeadingText(stripHeadingDecoration(headingText));
  return keywords.some(k => normalized.startsWith(normalizeHeadingText(k)));
}

// §32 I-6 — 접두 매칭 화이트리스트는 "결정 배경"/"최종 결정" 같은 무관한 제목은 걸러내지만
// (어느 별칭으로도 시작하지 않으므로), 같은 별칭으로 "시작하면서" 뒤에 다른 성격을 알리는
// 꼬리표가 붙은 제목까지는 못 거른다 — 감사 실측 5종:
//   "핵심 결정 배경(폐기)"(→ "핵심결정배경(폐기)".startsWith("핵심결정"))         — 폐기된 초안
//   "주요 결정권자 목록"(→ "주요결정권자목록".startsWith("주요결정"))             — 사람 목록
//   "결정 사항 변경 이력"(→ "결정사항변경이력".startsWith("결정사항"))            — 변경 이력
//   "용어 사용 지침"(→ "용어사용지침".startsWith("용어"))                        — 작성 지침 산문
//   "용어 정리 TODO"(→ "용어정리todo".startsWith("용어"))                        — 미완성 TODO
// 전부 "결정 표"도 "용어 정의"도 아닌 그 주변 문서다. 부정 후행 검사로 이런 꼬리표가 붙은
// 제목을 후보에서 제외한다. 토큰은 실측된 것만 담는다 — 과도하면 "핵심 결정 사항 (2026-08
// 갱신)" 같은 정당한 제목까지 걸러 §30 P2 를 재발시킨다(그래서 "갱신"/"업데이트" 류는 목록에
// 없다 — 최신화는 오히려 반가운 신호다). 한국어·영어 표기를 모두 받아들인다.
const EXCLUDED_HEADING_TOKENS = [
  "배경", "이력", "지침", "todo", "폐기", "초안", "구버전", "권자", "담당",
  "deprecated", "draft", "history", "guideline",
];

function isExcludedHeading(headingText: string): boolean {
  const normalized = normalizeHeadingText(stripHeadingDecoration(headingText));
  return EXCLUDED_HEADING_TOKENS.some(t => normalized.includes(t));
}

/** 화이트리스트로 매치되고 배제 토큰이 없는 후보만 남긴다. findSection 과 appendDecisionRow
 *  양쪽이 "어떤 헤딩이 결정/용어 절 후보인가"를 같은 기준으로 판단해야 한다(§30 P1) — 판단
 *  기준이 갈리면 readPlanContext 가 고른 절과 fw answer 가 append 하는 절이 달라질 수 있다. */
function matchingHeadingCandidates(
  headings: readonly HeadingCandidate[],
  keywords: readonly string[],
): HeadingCandidate[] {
  return headings.filter(h => headingMatches(h.text, keywords) && !isExcludedHeading(h.text));
}

/** 한 줄이 마크다운 ATX 헤딩이면 [레벨, 제목텍스트] 를, 아니면 null 을 반환한다.
 *  (정규식 판정을 `.match()` 로 통일 — 헤딩 검출 목적일 뿐 상태를 갖는 g/y 플래그가 없어
 *  `RegExp.prototype.exec` 와 결과가 동일하다.) */
function matchHeading(line: string): { level: number; text: string } | null {
  const m = line.match(HEADING_RE);
  return m ? { level: m[1].length, text: m[2] } : null;
}

function matchSetextLevel(line: string): number | null {
  const m = line.match(SETEXT_RE);
  if (!m) return null;
  return m[1]![0] === "=" ? 1 : 2;
}

function matchFence(line: string): { ch: string; len: number } | null {
  const m = line.match(FENCE_RE);
  if (!m) return null;
  const token = m[1]!;
  return { ch: token[0]!, len: token.length };
}

/**
 * lines[start,end) 를 순회하며 코드펜스 안의 줄(여는/닫는 델리미터 포함)을 건너뛰고, 펜스
 * 밖의 줄만 콜백한다. §31 I6-4 — "펜스 안의 `#`/밑줄을 헤딩으로 오인하지 않는다"를 세 곳
 * (헤딩 탐지·결정 표 헤더 탐색·플레이스홀더 표 데이터 행 탐색)이 각자 구현하면 다음 라운드에
 * 갈린다(§30 P1) — 상태기계를 한 곳에 둔다. 콜백이 `false` 를 반환하면 즉시 멈춘다.
 */
function forEachUnfencedLine(
  lines: string[],
  start: number,
  end: number,
  fn: (line: string, idx: number) => boolean | void,
): void {
  let fence: { ch: string; len: number } | null = null;
  for (let i = start; i < end; i++) {
    const line = lines[i]!;
    const f = matchFence(line);
    if (fence) {
      if (f && f.ch === fence.ch && f.len >= fence.len) fence = null;
      continue; // 펜스 안(닫는 줄 포함)은 절대 콜백하지 않는다
    }
    if (f) {
      fence = f;
      continue; // 여는 펜스 줄 자체도 콜백 대상이 아니다
    }
    if (fn(line, i) === false) return;
  }
}

interface HeadingCandidate {
  level: number;
  text: string;
  lineIdx: number;
}

/** 문서 전체에서 ATX + setext 헤딩을 전부 찾는다(코드펜스 안은 제외). lineIdx 오름차순. */
function findAllHeadings(lines: string[]): HeadingCandidate[] {
  const result: HeadingCandidate[] = [];
  forEachUnfencedLine(lines, 0, lines.length, (line, i) => {
    const atx = matchHeading(line);
    if (atx) {
      result.push({ level: atx.level, text: atx.text, lineIdx: i });
      return;
    }
    // setext: 바로 다음 줄이 밑줄이고, 이 줄이 비어있지 않고 표 행도 아니어야 한다(CommonMark —
    // 앞뒤에 빈 줄 없이 문단 바로 뒤에 오는 =/- 전용 줄만 setext 로 인정한다).
    if (i + 1 < lines.length) {
      const underline = matchSetextLevel(lines[i + 1]!);
      if (underline !== null && line.trim().length > 0 && !line.trim().startsWith("|")) {
        result.push({ level: underline, text: line.trim(), lineIdx: i });
      }
    }
  });
  return result;
}

/** 절이 끝나지 않은 채(코드펜스가 열린 채로) 절 경계에 도달하면, 같은 문자로 닫는 줄을
 *  합성해 덧붙인다. §31 I6-4 — 미종결 펜스를 그대로 내보내면 그 뒤 프롬프트 전체가 "코드블록
 *  안"으로 잘못 해석된다. 원본 PLAN 을 고치는 게 아니라 "주입될 텍스트"만 안전하게 만든다. */
function closeUnterminatedFence(lines: string[]): string[] {
  let fence: { ch: string; len: number } | null = null;
  for (const line of lines) {
    const f = matchFence(line);
    if (fence) {
      if (f && f.ch === fence.ch && f.len >= fence.len) fence = null;
    } else if (f) {
      fence = f;
    }
  }
  if (fence === null) return lines;
  return [...lines, fence.ch.repeat(fence.len)];
}

/** 후보 중 가장 얕은 레벨(h2 > h3)을 고르고, 레벨이 같으면 마지막(문서에서 더 아래) 것을
 *  고른다. §31 I6-3 — "### 핵심 결정 요약(구버전)" 이 앞서고 "## 핵심 결정 사항"(진짜, h2)이
 *  뒤에 오는 문서에서 구버전을 주입하는 사고를 막는다.
 *
 *  "동레벨이면 마지막"을 고른 근거: PLAN 은 위→아래로 누적 편집되고 W2(`fw answer`)가 항상
 *  문서 뒤쪽 표에 append 하므로, 동일 레벨 헤딩이 여러 개면 텍스트상 더 아래(나중)에 있는
 *  것이 최신일 확률이 높다. 이 휴리스틱은 틀릴 수 있다(사람이 구버전을 일부러 아래로
 *  재배치했다면) — 그 안전망은 append-only 규칙(§28): 잘못 골라도 원본 절은 문서에 그대로
 *  남아 있어 사람이 확인할 수 있다.
 *
 *  §32 I-6-3 재검토: 감사가 실측한 반대 방향 사고(h2 "(초안 — 폐기)" 가 앞서고 h3 "(확정)"
 *  이 뒤에 오면 얕은 h2 가 잘못 뽑힘)는 "얕은 레벨 우선" 자체의 결함이 아니라, 초안/폐기
 *  절이 애초에 후보에 남아 있었던 게 문제였다 — isExcludedHeading(위)이 이제 그 후보를
 *  걸러내므로 이 시나리오는 후보가 하나(h3)만 남아 해소된다. "얕은 레벨 우선"을 일반 규칙
 *  으로 유지하는 근거: PLAN 은 관례상 최상위 결정 표를 문서 앞쪽(예: "## 핵심 결정 사항")에
 *  두고 그 하위에 세부 논의/보충 설명을 "###"로 중첩하는 구조를 쓴다 — 더 깊은 레벨이 항상
 *  "그 위 절의 부연"이라는 CommonMark 문서 관례를 따르면 얕은 레벨이 여전히 옳은 기본값이다.
 *  배제 토큰으로도 못 거르는 새로운 형태의 "얕은 레벨=구버전" 문서가 있을 수 있다는 점은
 *  인정한다 — 그런 경우를 조용히 잘못 고르지 않도록, 후보가 2개 이상이면(아래
 *  matchingHeadingCandidates 호출부) 두 절 중 하나만 주입하되 diagnostics 에 후보 목록을
 *  실어 "다른 후보가 있었다"는 사실 자체를 드러낸다(§30 P4) — 어느 쪽이 맞는지 기계가 확신할
 *  수 없는 이상, 둘 다 주입해 프롬프트를 혼란시키는 것보다 하나만 고르고 사람이 doctor/런로그로
 *  확인할 수 있게 하는 쪽이 안전하다는 기존 판단을 유지한다. */
function pickShallowestThenLast(candidates: HeadingCandidate[]): HeadingCandidate | null {
  if (candidates.length === 0) return null;
  let best = candidates[0]!;
  for (let i = 1; i < candidates.length; i++) {
    if (candidates[i]!.level <= best.level) best = candidates[i]!;
  }
  return best;
}

interface FoundSection {
  /** 매치된 헤딩 원문 줄(트림됨) — 진단 표시용. ATX 면 "## ..." 그대로, setext 면 "#" 없이
   *  본문 텍스트 그대로. */
  headingLine: string;
  /** 헤딩 다음 줄부터 다음 같은/상위 레벨 헤딩(또는 문서 끝)까지의 본문. trim 되어 있고
   *  코드펜스가 열린 채 끝났으면 닫는 줄이 합성되어 있다. 절이 비어 있으면 빈 문자열. */
  body: string;
  /** §32 I-6 — 배제 토큰을 통과한 전체 후보 목록(선택된 것 포함, lineIdx 오름차순). 후보가
   *  2개 이상이면 readPlanContext 가 diagnostics 로 "골랐다는 사실보다 다른 후보가 있었다는
   *  사실"을 노출한다(§30 P4). */
  candidates: HeadingCandidate[];
}

function findSection(lines: string[], keywords: readonly string[]): FoundSection | null {
  const headings = findAllHeadings(lines);
  const candidates = matchingHeadingCandidates(headings, keywords);
  const best = pickShallowestThenLast(candidates);
  if (best === null) return null;

  let endIdx = lines.length;
  for (const h of headings) {
    if (h.lineIdx > best.lineIdx && h.level <= best.level) {
      endIdx = h.lineIdx;
      break;
    }
  }
  const bodyLines = closeUnterminatedFence(lines.slice(best.lineIdx + 1, endIdx));
  return { headingLine: lines[best.lineIdx]!.trim(), body: bodyLines.join("\n").trim(), candidates };
}

/**
 * PLAN.md 본문(마크다운 전체)에서 주어진 제목의 절(다음 같은/상위 레벨 제목까지, 없으면
 * 문서 끝까지)을 추출한다. 제목을 찾지 못했거나 절 내용이 비어 있으면 null.
 *
 * `heading` 은 느슨하게(장식 제거 + 접두 매칭, 배열이면 그중 하나) 비교된다. 제목 자체는
 * 반환값에 포함하지 않는다(본문만). 코드펜스 안의 `#`/setext 밑줄은 헤딩으로 보지 않는다.
 */
export function extractSection(markdown: string, heading: string | readonly string[]): string | null {
  const keywords = Array.isArray(heading) ? heading : [heading as string];
  const lines = markdown.split(/\r?\n/);
  const found = findSection(lines, keywords);
  if (found === null) return null;
  return found.body.length > 0 ? found.body : null;
}

/** 절 본문에서 인용 블록(`> ...`) 줄을 제거한다 — 템플릿의 "표 형식 유지하라" 같은 작성
 *  지침이 세션 프롬프트에 그대로 섞이면 노이즈이자 잠재적 혼선이다. */
function stripBlockquotes(text: string): string {
  return text
    .split("\n")
    .filter(line => !/^\s*>/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 표 구분선 행(`|----|------|` 류, 정렬 콜론 포함)인지 판정한다. */
function isTableDividerRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length > 0 && /^[\s:|-]+$/.test(trimmed) && trimmed.includes("-");
}

/** m6(§31) — 표 행 한 줄이 "틀만 있는" 플레이스홀더인지 판정한다. 두 가지를 잡는다:
 *  ①미치환 템플릿 변수 `{{ ... }}` 를 포함한 행 ②ID 열만 채워지고 나머지 칸이 전부 빈
 *  스켈레톤 행(`| D2 | | | | |`). 헤더/구분선 행은 뒤쪽 칸이 채워져 있어(예: "결정", "----")
 *  이 판정에 걸리지 않는다 — 그래서 호출부가 헤더/구분선을 따로 예외 처리하지 않아도 된다. */
function isPlaceholderTableRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return false;
  if (/\{\{[^}]*\}\}/.test(trimmed)) return true;
  const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim());
  if (cells.length <= 1) return false;
  return cells.slice(1).every(c => c.length === 0);
}

/** 절 본문(문자열) 안에서 첫 번째 표(헤더+구분선, 코드펜스 안은 제외)를 찾아 데이터 행 구간
 *  [dataStart, dataEnd) 를 반환한다. 열 개수에 무관하다 — §핵심 결정(5열)과 §용어(2열) 양쪽에
 *  다 쓰기 위해 findDecisionTable 과 별도로 둔다. 표가 없으면(산문 절) null. */
function locateTableDataRows(lines: string[]): { dataStart: number; dataEnd: number } | null {
  let found: { dataStart: number; dataEnd: number } | null = null;
  forEachUnfencedLine(lines, 0, lines.length - 1, (line, i) => {
    if (line.trim().startsWith("|") && isTableDividerRow(lines[i + 1]!)) {
      let end = i + 2;
      while (end < lines.length && lines[end]!.trim().startsWith("|")) end++;
      found = { dataStart: i + 2, dataEnd: end };
      return false; // 첫 표를 찾았으면 중단
    }
    return undefined;
  });
  return found;
}

/** m6(§31) — 미치환 템플릿 플레이스홀더 행과 "ID만 있고 나머지가 빈" 스켈레톤 행을 표에서
 *  제거한다. 표가 없는 산문 절은 그대로 둔다. 필터 후 데이터 행이 하나도 남지 않으면(절
 *  전체가 미기입 템플릿이었다는 뜻) 빈 문자열을 반환해 processSection 이 null 로 떨어지게
 *  한다 — "전부 필터링되면 절을 null 로"(요구사항 그대로). */
function filterPlaceholderRows(text: string): string {
  const lines = text.split("\n");
  const table = locateTableDataRows(lines);
  if (table === null) return text;
  const result: string[] = [];
  let keptDataRows = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (i >= table.dataStart && i < table.dataEnd) {
      if (isPlaceholderTableRow(line)) continue;
      keptDataRows++;
    }
    result.push(line);
  }
  if (keptDataRows === 0) return "";
  return result.join("\n");
}

function capSection(text: string, heading: string): string {
  if (text.length <= SECTION_CHAR_CAP) return text;
  return text.slice(0, SECTION_CHAR_CAP) + truncationMarker(heading);
}

function processSection(raw: string, heading: string): string | null {
  let text = stripBlockquotes(raw);
  if (text.length === 0) return null;
  text = filterPlaceholderRows(text); // m6
  if (text.trim().length === 0) return null;
  return capSection(text, heading);
}

export interface PlanDiagnostics {
  /** PLAN.md 파일 자체가 있었는가. 없으면 아래 필드는 전부 무의미(기본값)하다 — 레거시/
   *  HANDOFF-only 워크플로우의 정상 상태다(§30 P2). */
  planFound: boolean;
  /** §핵심 결정 절로 매치된 헤딩 원문(없으면 null). 내용이 전부 필터링돼 0자여도 헤딩을
   *  찾았으면 null 이 아니다 — "헤딩 미발견"과 "헤딩은 있는데 내용이 없음"을 구분하기 위함. */
  decisionsHeading: string | null;
  glossaryHeading: string | null;
  /** 실제로 프롬프트에 주입된(절단 후) 문자 수. 못 찾았거나 내용이 없으면 0. */
  decisionsChars: number;
  glossaryChars: number;
  /** §42 — §검증 기준 절. 선택 필드인 이유는 위 acceptance 와 동일. */
  acceptanceHeading?: string | null;
  acceptanceChars?: number;
  /** §44 — §개발 방향 절. */
  architectureHeading?: string | null;
  architectureChars?: number;
  // §32 I-6 — 배제 토큰을 통과한 후보가 2개 이상이었을 때만 채워지는 optional 필드(선택 필드로
  // 두는 이유는 §31 I6 재작업 당시와 동일 — session.ts/doctor.ts 가 이미 5-필드 PlanDiagnostics
  // 리터럴을 곳곳에서 만들고 있어(다른 에이전트 소유, 이 라운드에서 건드릴 수 없음), 여기서
  // 필수로 만들면 그 파일들이 컴파일 에러가 난다). 감사자 권고(§30 P4): "골랐다는 사실보다
  // '다른 후보가 있었다'가 정보다" — pickShallowestThenLast 가 하나를 고르고 나면 나머지
  // 후보의 존재 자체가 조용히 사라지던 것을, 이 필드로 관측 가능하게 만든다. 후속 과제: 이
  // 필드를 실제로 사람에게 보여주는 배선(doctor.ts 의 [PLAN 결정·용어 주입] 절, session.ts 의
  // formatPlanContextLog)은 그 파일들의 소유 에이전트 몫이다 — 여기서는 값만 채운다.
  decisionsCandidateCount?: number;
  decisionsCandidateHeadings?: string[];
  glossaryCandidateCount?: number;
  glossaryCandidateHeadings?: string[];
}

export interface PlanContext {
  decisions: string | null;
  glossary: string | null;
  /** §42 — §검증 기준 절. 선택 필드로 둔다(decisions/glossary 만 담은 기존 리터럴이 여러
   *  파일에 있어 필수로 만들면 전부 컴파일 에러가 난다 — diagnostics 와 같은 이유). */
  acceptance?: string | null;
  /** §44 — §개발 방향 절(진입 경로 포함). 선택 필드인 이유는 위와 동일. */
  architecture?: string | null;
  // 선택 필드로 둔다(§31 I6) — session.test.ts 등 다른 소유자의 코드가 이미 { decisions,
  // glossary } 만 있는 PlanContext 리터럴을 만들고 있어(session.ts 소유, 이 라운드에서 건드릴
  // 수 없음), 여기서 필수로 만들면 그 파일들이 컴파일 에러가 난다. readPlanContext(실제 구현)는
  // 항상 채워서 반환하므로 doctor.ts 는 안전하게 읽을 수 있다.
  diagnostics?: PlanDiagnostics;
}

const DECISIONS_HEADING = "핵심 결정";
const GLOSSARY_HEADING = "용어";
const ACCEPTANCE_HEADING = "검증 기준";
const ARCHITECTURE_HEADING = "개발 방향";

const EMPTY_DIAGNOSTICS: PlanDiagnostics = {
  planFound: false,
  decisionsHeading: null,
  glossaryHeading: null,
  decisionsChars: 0,
  glossaryChars: 0,
};

/**
 * workflowDir/PLAN.md 에서 §핵심 결정 사항·§용어 절을 읽어온다. 파일이 없거나 절이 없으면
 * 해당 값(또는 둘 다)은 조용히 null — 예외를 던지지 않는다. 하위호환 필수: 기존 워크플로우의
 * PLAN 은 산문 형식이라 이 두 절이 없을 수 있다(§30 P2 — 방어가 정상 경로를 막으면 안 된다).
 *
 * §31 I6 — 반환값에 diagnostics 를 추가했다(시그니처 유지, 필드 추가). session.ts 는
 * `.decisions`/`.glossary` 만 읽으므로 이 추가는 호환된다. 무엇을 찾고 못 찾았는지는
 * `fw doctor` 의 [PLAN 결정·용어 주입] 절이 사람에게 보여준다(§30 P4 — 통과/실패가 아니라
 * 무엇을 관측했는지를 남긴다).
 */
export function readPlanContext(workflowDir: string): PlanContext {
  let markdown: string;
  try {
    markdown = fs.readFileSync(path.join(workflowDir, "PLAN.md"), "utf-8");
  } catch {
    return { decisions: null, glossary: null, acceptance: null, architecture: null, diagnostics: EMPTY_DIAGNOSTICS };
  }
  try {
    const lines = markdown.split(/\r?\n/);
    const decisionsFound = findSection(lines, DECISIONS_ALIASES);
    const glossaryFound = findSection(lines, GLOSSARY_ALIASES);
    const acceptanceFound = findSection(lines, ACCEPTANCE_ALIASES);
    const architectureFound = findSection(lines, ARCHITECTURE_ALIASES);
    const decisions = decisionsFound ? processSection(decisionsFound.body, DECISIONS_HEADING) : null;
    const glossary = glossaryFound ? processSection(glossaryFound.body, GLOSSARY_HEADING) : null;
    const acceptance = acceptanceFound ? processSection(acceptanceFound.body, ACCEPTANCE_HEADING) : null;
    const architecture = architectureFound ? processSection(architectureFound.body, ARCHITECTURE_HEADING) : null;
    // §32 I-6 — 후보가 2개 이상일 때만 candidate* 필드를 채운다(요구사항 그대로: "후보가 2개
    // 이상이면"). 원문 헤딩 줄(lines[c.lineIdx].trim())로 표시한다 — headingLine 과 동일한
    // 표현(ATX 는 "## ..." 그대로, setext 는 "#" 없이 본문 텍스트)을 쓴다.
    const decisionsCandidates =
      decisionsFound && decisionsFound.candidates.length >= 2
        ? decisionsFound.candidates.map(c => lines[c.lineIdx]!.trim())
        : null;
    const glossaryCandidates =
      glossaryFound && glossaryFound.candidates.length >= 2
        ? glossaryFound.candidates.map(c => lines[c.lineIdx]!.trim())
        : null;
    return {
      decisions,
      glossary,
      acceptance,
      architecture,
      diagnostics: {
        planFound: true,
        decisionsHeading: decisionsFound?.headingLine ?? null,
        glossaryHeading: glossaryFound?.headingLine ?? null,
        acceptanceHeading: acceptanceFound?.headingLine ?? null,
        architectureHeading: architectureFound?.headingLine ?? null,
        decisionsChars: decisions?.length ?? 0,
        glossaryChars: glossary?.length ?? 0,
        acceptanceChars: acceptance?.length ?? 0,
        architectureChars: architecture?.length ?? 0,
        ...(decisionsCandidates
          ? { decisionsCandidateCount: decisionsCandidates.length, decisionsCandidateHeadings: decisionsCandidates }
          : {}),
        ...(glossaryCandidates
          ? { glossaryCandidateCount: glossaryCandidates.length, glossaryCandidateHeadings: glossaryCandidates }
          : {}),
      },
    };
  } catch {
    // 이 블록의 모든 함수는 순수 문자열 처리라 실질적으로 던지지 않지만, 이 경로가 무인 주행을
    // 막지 않는다는 계약을 명시적으로 지킨다.
    return { decisions: null, glossary: null, acceptance: null, architecture: null, diagnostics: { ...EMPTY_DIAGNOSTICS, planFound: true } };
  }
}

// ---------------------------------------------------------------------------
// §28 W2 — `fw answer` 가 BLOCKED 질문의 답을 STATE.answers 뿐 아니라 PLAN.md §핵심 결정
// 표에도 append 한다. grill-with-docs 의 핵심("결정을 인터뷰 도중에 문서로 남긴다")이 지금까지
// STATE.json 에만 있었던 절반을 채운다.
//
// 소유권 경계(설계 §28): STATE=하네스, PLAN=사람이라는 기존 경계는 무인 phase/fix 세션에
// 적용되는 것이고, `fw answer` 는 사람이 직접 호출하는 명령이므로 위반이 아니다. 그래도
// **append-only** 를 지킨다 — 사람이 PLAN 을 동시에 편집 중일 수 있으므로 기존 행은 절대
// 고쳐 쓰지 않는다(아래 appendDecisionRow 는 기존 줄 배열을 그대로 두고 새 줄 하나만 삽입한다).
// ---------------------------------------------------------------------------

/** PLAN.md §핵심 결정 표의 한 행. */
export interface DecisionRow {
  id: string;
  decision: string;
  rationale: string;
  status: string;
  date: string;
}

const DECISION_TABLE_HEADER = "| ID | 결정 | 근거 | 상태 | 날짜 |";
const DECISION_TABLE_DIVIDER = "|----|------|------|------|------|";
// §28 형식(설계 §28, docs/pr-smoke/PLAN.md 실측)의 열 개수. 이 값과 다른 표는 구 형식/사용자
// 커스텀으로 보고 손대지 않는다(§30 P2 — 남의 표를 망가뜨리는 게 최악).
const DECISION_TABLE_COLUMNS = 5;

/** 원본 문서의 줄바꿈 방식(CRLF/LF)을 감지한다. §31 m2 — `fw answer` 가 CRLF 파일 전체를
 *  LF 로 재작성하면 "기존 행을 절대 고쳐 쓰지 않는다"(append-only) 원칙을 깬다(git diff 가
 *  파일 전체를 바꾼 것처럼 보인다). 파일에 CRLF 가 하나라도 있으면 CRLF 로 판단한다 — 섞여
 *  있는 경우는 드물고, 있다면 이미 원본이 일관적이지 않았다는 뜻이라 어느 쪽을 골라도
 *  완벽하진 않다. */
function detectLineEnding(markdown: string): "\r\n" | "\n" {
  return markdown.includes("\r\n") ? "\r\n" : "\n";
}

/** 표 셀에 사용자 원문(질문/답변)을 그대로 넣어도 마크다운 표가 깨지지 않게 한다.
 *  개행은 공백으로 접고, 백슬래시와 파이프를 이스케이프한다.
 *
 *  §31 m3 — 반드시 백슬래시를 먼저 이스케이프한 다음 파이프를 이스케이프해야 한다. 원문에
 *  이미 `\|`(홀수 백슬래시+파이프, 예: 사용자가 정규식이나 이스케이프된 OR 를 답변에 그대로
 *  쓴 경우)가 있으면, 파이프만 이스케이프하는 예전 로직은 `\\|`(짝수 개 백슬래시+파이프)를
 *  만든다 — GFM 표 파서는 파이프 앞 백슬래시 개수가 짝수면 "이스케이프 안 됨"으로 읽어
 *  구분자로 취급한다(열이 늘어난다, 실측 확인). 백슬래시를 먼저 두 배로 늘리면(`\`→`\\`)
 *  그 뒤에 파이프를 이스케이프해도 항상 파이프 앞 백슬래시 개수가 홀수로 유지되어 렌더링 시
 *  원문이 정확히 복원된다. */
function sanitizeCell(text: string): string {
  return text
    .replace(/\r?\n/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .trim();
}

function formatDecisionRow(row: DecisionRow): string {
  return `| ${sanitizeCell(row.id)} | ${sanitizeCell(row.decision)} | ${sanitizeCell(row.rationale)} | ${sanitizeCell(row.status)} | ${sanitizeCell(row.date)} |`;
}

/** 마크다운 표 행 한 줄의 셀 개수. 표 행이 아니면 null. */
function tableRowColumnCount(line: string): number | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  return inner.split("|").length;
}

/**
 * lines[sectionStart, sectionEnd) 범위(§핵심 결정 절 본문) 안에서 마크다운 표를 찾는다.
 * 헤더 행 바로 다음이 구분선이어야 표로 인정한다(우연히 "|" 로 시작하는 산문 오탐 방지).
 * 표가 없으면(산문/리스트 절, 또는 완전히 빈 절) null — 호출부가 append 를 포기하는 신호.
 *
 * §31 m5 — 코드펜스 안의 예시 표(문서 설명용)를 진짜 표로 오인해 그 안에 결정 행을 끼워
 * 넣던 결함을 고쳤다. forEachUnfencedLine 으로 펜스 안 줄은 헤더 탐색에서 아예 제외한다
 * (I6-4 와 같은 상태기계 재사용 — §30 P1).
 */
function findDecisionTable(
  lines: string[],
  sectionStart: number,
  sectionEnd: number,
): { lastRowLineIdx: number; columnCount: number } | null {
  let headerIdx = -1;
  forEachUnfencedLine(lines, sectionStart, sectionEnd, (line, i) => {
    if (line.trim().startsWith("|")) {
      headerIdx = i;
      return false;
    }
    return undefined;
  });
  if (headerIdx === -1) return null;
  const dividerIdx = headerIdx + 1;
  if (dividerIdx >= sectionEnd || !isTableDividerRow(lines[dividerIdx]!)) return null;
  const columnCount = tableRowColumnCount(lines[headerIdx]!);
  if (columnCount === null) return null;

  let lastRowLineIdx = dividerIdx;
  for (let i = dividerIdx + 1; i < sectionEnd; i++) {
    if (lines[i]!.trim().startsWith("|")) lastRowLineIdx = i;
    else break;
  }
  return { lastRowLineIdx, columnCount };
}

/**
 * PLAN.md 마크다운 문자열에 §핵심 결정 표 행을 append 한 새 문자열을 반환하는 순수 함수.
 * 절이 없으면 §28 형식(표 헤더+구분선)으로 새 절을 문서 끝에 만들어 붙인다.
 *
 * append 할 수 없는 경우(아래 두 가지) **원본 markdown 을 문자 그대로 반환한다** — 이 "무변경"
 * 자체가 appendDecisionToPlan 에게 실패 신호가 된다:
 *   1. 절은 있지만 표가 없다(산문/리스트로 쓰인 기존 PLAN, §30 P2 가 다루는 사례) — 사람이
 *      쓴 산문 아래에 표를 만들어 붙이는 것도 고려했으나, 그 산문이 이미 결정을 설명하고
 *      있을 수 있어 자동으로 형식을 바꾸는 쪽이 더 위험하다고 판단했다(보수적 선택).
 *   2. 표는 있지만 열 개수가 §28 형식(5열)과 다르다(구 형식/사용자 커스텀) — 열이 다른 표에
 *      맞춰 셀을 끼워 넣으면 표가 깨진다.
 * 기존 행은 절대 고치지 않는다 — 항상 마지막 데이터 행 다음에 새 줄 하나만 삽입한다.
 *
 * §31 m2 — 원본의 줄바꿈 방식(CRLF/LF)을 감지해 그대로 유지한다. 내부 연산은 전부 LF 로 쪼갠
 * 배열 위에서 하고, 마지막에 원본 방식으로 join 한다 — split(/\r?\n/) 은 두 방식 모두 안전하게
 * 흡수하므로 내부 로직 변경이 필요 없다.
 */
export function appendDecisionRow(markdown: string, row: DecisionRow): string {
  const eol = detectLineEnding(markdown);
  const lines = markdown.split(/\r?\n/);

  const headings = findAllHeadings(lines);
  // §32 I-6 — findSection 과 같은 matchingHeadingCandidates 헬퍼를 쓴다(§30 P1). 예전엔 이 줄이
  // headingMatches 만 걸러 findSection 과 다른 기준으로 후보를 골랐다 — "핵심 결정 배경(폐기)"
  // 같은 절이 여기서는 append 대상으로, readPlanContext 에서는 주입 대상으로 서로 다르게
  // 취급될 수 있었다는 뜻이다. 같은 헬퍼를 쓰면 두 경로가 항상 같은 절을 가리킨다.
  const candidates = matchingHeadingCandidates(headings, DECISIONS_ALIASES);
  const best = pickShallowestThenLast(candidates);

  if (best === null) {
    // 절 자체가 없다 — §28 형식으로 새 절을 만들어 문서 끝에 붙인다(기존 내용은 무변경).
    const needsBlankLineBefore = lines.length > 0 && lines[lines.length - 1]!.trim() !== "";
    const newSection = [
      ...(needsBlankLineBefore ? [""] : []),
      "## 핵심 결정 사항",
      "",
      DECISION_TABLE_HEADER,
      DECISION_TABLE_DIVIDER,
      formatDecisionRow(row),
    ];
    return [...lines, ...newSection].join(eol);
  }

  let sectionEnd = lines.length;
  for (const h of headings) {
    if (h.lineIdx > best.lineIdx && h.level <= best.level) {
      sectionEnd = h.lineIdx;
      break;
    }
  }

  const table = findDecisionTable(lines, best.lineIdx + 1, sectionEnd);
  if (table === null || table.columnCount !== DECISION_TABLE_COLUMNS) {
    return markdown; // 산문 절이거나 열 개수가 다른 표 — 원본 그대로(무변경 = 실패 신호)
  }

  const newLines = [...lines];
  newLines.splice(table.lastRowLineIdx + 1, 0, formatDecisionRow(row));
  return newLines.join(eol);
}

/**
 * §핵심 결정 표에서 다음 ID(`D<n>`)를 계산하는 순수 함수. **ID 열에서만** `D\d+` 패턴을 찾아
 * 최댓값 + 1을 반환한다.
 *
 * §31 m4 — 예전엔 절 본문 전체 텍스트에서 `D\d+` 를 찾았다. 그러면 "결정"/"근거" 칸에 사람이나
 * 세션이 적은 자유 텍스트에 우연히 `D9999` 같은 문자열(질문 인용, 이슈 번호 등)이 섞이면 다음
 * ID 가 그 값으로 오염된다(D2 → D10000). ID 열만 보면 이 오염 경로가 사라진다. 추가로 비정상적
 * 으로 긴 숫자(`D999...9`, Number.MAX_SAFE_INTEGER 초과)는 부동소수점 정밀도를 잃으므로 무시
 * 한다 — 사람이 실수로 그런 ID 를 넣었더라도 다음 ID 계산이 그 값을 베껴 폭주하지 않는다.
 *
 * 절이 없거나 비어 있으면(첫 결정) "D1". 표가 `D<n>` 이 아닌 다른 ID 체계(예: `DEC-1`)만 쓰고
 * 있으면 매치가 없어 역시 "D1" 부터 시작한다.
 */
export function nextDecisionId(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const found = findSection(lines, DECISIONS_ALIASES);
  if (found === null || found.body.length === 0) return "D1";

  let max = 0;
  for (const line of found.body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|");
    const idCell = (cells[0] ?? "").trim();
    const m = idCell.match(/^D(\d+)$/);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isSafeInteger(n) && n > max) max = n;
  }
  return `D${max + 1}`;
}

/**
 * workflowDir/PLAN.md 파일에 결정 행을 append 한다(부작용 있음). 성공하면 파일을 덮어쓰고
 * true, 아래 두 경우는 **아무것도 쓰지 않고** false 를 반환한다 — 조용히 삼키지 않고 호출부
 * (`fw answer`)가 사용자에게 알리도록 판단을 위임한다:
 *   - PLAN.md 파일이 없다(레거시/HANDOFF-only 워크플로우 등)
 *   - appendDecisionRow 가 산문 절/열 개수 불일치로 원본을 그대로 돌려준 경우(무변경)
 */
export function appendDecisionToPlan(workflowDir: string, row: DecisionRow): boolean {
  const planPath = path.join(workflowDir, "PLAN.md");
  let markdown: string;
  try {
    markdown = fs.readFileSync(planPath, "utf-8");
  } catch {
    return false;
  }
  const next = appendDecisionRow(markdown, row);
  if (next === markdown) return false;
  fs.writeFileSync(planPath, next, "utf-8");
  return true;
}

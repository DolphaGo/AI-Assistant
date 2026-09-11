// 인라인 리뷰 코멘트 조립 — 조각 PR 의 "읽는 순서"를 Files changed 의 코드 위에 올린다.
//
// **왜 이 파일이 필요한가.** 읽는 순서는 원래 PR 본문의 한 절이었다. 리뷰어는 본문에서
// "cli.ts 의 193번째 줄 근처를 보라"를 읽고 Files changed 로 넘어가 그 줄을 직접 찾아야 했다 —
// 안내가 코드에서 떨어져 있어 진입 비용이 그대로 남았다(pain #3).
//
// **왜 앵커를 diff 에서만 뽑는가.** GHE 3.19 실측(PR #5 왕복):
//   · diff 에 없는 줄을 주면 422 `line must be part of the diff` 이고, 리뷰 하나에 코멘트를
//     묶어 보내므로 **앵커 하나만 틀려도 코멘트 전체가 거부된다**. 세션이 쓴 "193번째 줄
//     근처"는 검증할 수 없는 추측이다 — 본문 산문일 때는 무해했지만 API 인자로 승격시키면
//     실패이거나(422) 엉뚱한 코드에 박혀 리뷰어를 적극적으로 오해시킨다. 그래서 세션에게는
//     "어떤 파일을 왜 먼저 보라"만 받고, **몇 번째 줄인지는 하네스가 diff 에서 잰다**.
//   · `subject_type:"file"` 은 422 `Field is not defined on DraftPullRequestReviewComment` —
//     리뷰 API 로는 파일 단위 코멘트를 붙일 수 없다. 그래서 붙일 줄이 없는 파일(바이너리,
//     내용 변경 없는 이름변경)은 인라인을 포기하고 본문에 이유까지 남긴다.
//   · `side:"LEFT"` + 삭제된 줄은 통과한다 — 삭제만 있는 파일의 앵커로 쓸 수 있다.
//
// 이 파일에는 I/O 가 없다. git 실행과 gh 호출은 각각 prloop.ts / pr.ts 가 하고, 여기서는
// 그 출력에서 앵커를 뽑아 코멘트를 조립하는 판정만 한다.

export type AnchorSide = "RIGHT" | "LEFT";

/** 한 파일에 코멘트를 붙일 수 있는 지점. diff 에서 뽑았으므로 GitHub 이 반드시 받는다. */
export interface DiffAnchor {
  path: string;
  line: number;
  side: AnchorSide;
}

export interface InlineReviewComment {
  path: string;
  line: number;
  side: AnchorSide;
  body: string;
}

export interface ReviewOrderPlan {
  /** 코드 위에 붙일 코멘트. 비어 있으면 호출부는 API 를 부르지 않는다. */
  comments: InlineReviewComment[];
  /**
   * **인라인을 붙이지 못한** 항목만. 붙인 항목은 이유가 코드 위에 있으므로 여기 오지 않는다 —
   * 같은 글을 본문과 코드 두 곳에 두지 않는다. 순서 번호는 전체 기준을 유지하므로, 1·3번이
   * 인라인으로 가고 2번만 남으면 이 배열은 `["2. ..."]` 가 된다(그 자체가 "두 번째로 볼 것"
   * 이라는 정보다).
   */
  bodyLines: string[];
}

// `@@ -<oldStart>[,<oldCount>] +<newStart>[,<newCount>] @@` — 카운트 생략은 1을 뜻한다.
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * `--- a/x` / `+++ b/x` 에서 경로를 꺼낸다. 판정하지 못하면 **포기**(null)한다 — 오인해서
 * 엉뚱한 값을 보내는 것보다 그 파일의 인라인을 접고 본문에 남기는 편이 안전하다.
 *
 * 검사는 접두 하나뿐이고, 그것으로 세 경우가 한꺼번에 걸러진다(§30 P1 — 방어를 겹치지 않는다.
 * 아래는 전부 `a/`/`b/` 로 시작하지 않으므로 별도 분기를 두면 죽은 코드가 된다):
 *   · `/dev/null` — 그 쪽에 파일이 없다(파일 생성/삭제)
 *   · git 이 인용한 경로(`"a/pa\tth"`) — 인용부호가 앞에 붙는다. 억지로 역이스케이프하면
 *     실제 경로와 어긋난 값이 GitHub 으로 나가 코멘트가 엉뚱한 파일에 붙거나 422 가 된다.
 *   · 우리가 부르지 않은 형태의 diff(`--src-prefix` 등) — 추측하지 않는다.
 *
 * 빈 경로(`--- a/`)만은 접두 검사를 통과하므로 따로 막는다. 빈 문자열은 null 이 아니라서
 * 호출부의 `?? ` 를 그대로 통과해 `path: ""` 인 코멘트가 만들어지고, 그러면 리뷰 전체가
 * 422 로 거부된다 — 실패가 그 파일 하나로 끝나지 않는다.
 */
function stripDiffPrefix(raw: string, prefix: "a/" | "b/"): string | null {
  if (!raw.startsWith(prefix)) return null;
  const p = raw.slice(prefix.length);
  return p.length > 0 ? p : null;
}

/**
 * `git diff -U0` 출력에서 파일별 앵커를 하나씩 뽑는다.
 *
 * 파일 하나에 hunk 가 여러 개면 **줄을 추가하는 첫 hunk** 를 고른다 — 삭제 hunk 가 앞에
 * 있어도 새 코드 쪽에 리뷰어를 내려놓는 편이 낫다. 추가가 전혀 없으면(삭제만 있는 파일)
 * 첫 삭제 hunk 의 옛 쪽 줄에 LEFT 로 붙인다. 둘 다 없으면 앵커를 만들지 않는다.
 */
export function parseDiffAnchors(stdout: string): DiffAnchor[] {
  const out: DiffAnchor[] = [];
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let current: DiffAnchor | null = null;
  // 추가 hunk 를 찾은 뒤에는 더 볼 필요가 없다 — 뒤 hunk 가 앵커를 밀어내지 못하게 잠근다.
  let locked = false;
  // **경로 헤더는 hunk 가 시작되기 전에만 읽는다.** diff 의 *내용* 이 diff 처럼 보일 수 있다:
  // `-- a/x` 라는 줄이 삭제되면 출력에 `-` 접두가 붙어 `--- a/x` 가 되고, 헤더와 구별할 수
  // 없다. 이 오인이 실제로 무엇을 부수는지가 중요하다 — 위조된 경로는 diff 에 없는 파일이므로
  // GitHub 이 422 로 **리뷰 전체를 거부**한다(코멘트 하나가 아니라 전부 잃는다). 그래서
  // "그럴싸한 헤더를 무시"하는 게 아니라 헤더를 읽는 구간 자체를 닫아 원리적으로 막는다.
  let inHeader = false;

  const flush = (): void => {
    if (current !== null) out.push(current);
    oldPath = null;
    newPath = null;
    current = null;
    locked = false;
    inHeader = false;
  };

  for (const raw of stdout.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      flush();
      inHeader = true;
      continue;
    }
    if (inHeader && raw.startsWith("--- ")) {
      oldPath = stripDiffPrefix(raw.slice(4).trim(), "a/");
      continue;
    }
    if (inHeader && raw.startsWith("+++ ")) {
      newPath = stripDiffPrefix(raw.slice(4).trim(), "b/");
      continue;
    }
    // hunk 판정은 HUNK_RE 하나로 한다. `startsWith("@@")` 를 앞에 두면 정규식의 `^` 가
    // 결과를 바꾸지 못해(이미 `@@` 로 시작함이 보장됨) 죽은 방어가 된다(§30 P1). `^` 를
    // 남기는 쪽을 택한 이유: 내용 줄에는 항상 `+`/`-` 접두가 붙으므로 `^@@` 는 내용이
    // hunk 헤더로 위조되는 것을 원리적으로 막는다.
    const m = HUNK_RE.exec(raw);
    if (m === null) continue;
    inHeader = false;
    if (locked) continue;
    // 삭제된 파일은 `+++ /dev/null` 이라 새 쪽에 경로가 없다 — 옛 경로로 되돌아간다.
    const filePath = newPath ?? oldPath;
    if (filePath === null) continue;
    const oldCount = m[2] === undefined ? 1 : Number(m[2]);
    const newCount = m[4] === undefined ? 1 : Number(m[4]);
    if (newCount >= 1) {
      current = { path: filePath, line: Number(m[3]), side: "RIGHT" };
      locked = true;
      continue;
    }
    if (oldCount >= 1 && current === null) {
      current = { path: filePath, line: Number(m[1]), side: "LEFT" };
    }
  }
  flush();
  return out;
}

// 세션은 `review_order` 를 "경로 — 한 줄 이유" 산문으로 쓴다(session.ts 프롬프트). 경로와
// 이유를 갈라야 이유만 코멘트 본문에 실을 수 있다. em dash 가 규약이지만, 없으면 첫 공백까지를
// 경로로 본다 — 규약을 지키지 않은 항목도 최대한 살린다(못 살리면 본문에 그대로 남으니 손실은 없다).
function splitOrderItem(item: string): { candidate: string; reason: string } {
  const dash = item.indexOf("—");
  if (dash >= 0) {
    return { candidate: item.slice(0, dash), reason: item.slice(dash + 1).trim() };
  }
  const ws = item.search(/\s/);
  if (ws < 0) return { candidate: item, reason: "" };
  return { candidate: item.slice(0, ws), reason: item.slice(ws + 1).trim() };
}

// 세션이 쓴 경로 표기의 흔한 장식(백틱·인용부호·`./` 접두·뒤 구두점)을 걷어낸다. 이건 추측이
// 아니다 — 걷어낸 결과가 실제 변경 파일과 정확히 대응되는지는 아래 resolveAnchor 가 diff 로
// 확인하고, 대응되지 않으면 인라인을 포기한다.
function normalizeCandidate(text: string): string {
  return text
    .replace(/\\/g, "/")
    .trim()
    .replace(/^[`"']+/, "")
    .replace(/[`"']+$/, "")
    .replace(/^\.\//, "")
    .replace(/[:,;.]+$/, "")
    .trim();
}

/**
 * 세션이 지목한 경로를 실제 변경 파일에 대응시킨다. 정확히 하나로 좁혀지지 않으면 **포기**한다 —
 * 엉뚱한 파일에 코멘트가 박히는 것보다 본문에 남는 편이 낫다.
 *
 * 접미 매칭(`cli.ts` → `src/cli.ts`)을 허용하는 이유: 세션이 리포 루트 기준 전체 경로를 항상
 * 쓰지는 않는다. `/` 경계를 요구해 `li.ts` 가 `cli.ts` 에 붙는 일을 막고, 둘 이상 걸리면
 * 모호하다고 판정해 포기한다(모호함을 추측으로 메우지 않는다).
 */
function resolveAnchor(candidate: string, anchors: readonly DiffAnchor[]): DiffAnchor | null {
  if (candidate.length === 0) return null;
  // 정확히 대응되는 파일이 있으면 접미 탐색으로 내려가지 않는다 — 그마저 둘 이상이면(같은
  // 경로의 앵커가 중복) 어느 쪽인지 모르므로 포기한다.
  const exact = anchors.filter(a => a.path === candidate);
  if (exact.length > 0) return exact.length === 1 ? exact[0]! : null;
  const suffix = anchors.filter(a => a.path.endsWith(`/${candidate}`));
  return suffix.length === 1 ? suffix[0]! : null;
}

/**
 * 읽는 순서를 **순서(본문)** 와 **위치+이유(인라인)** 로 가른다.
 *
 * 인라인 코멘트는 흩어져 있어 순서를 표현할 수 없다 — 그래서 순서는 본문 목록에 남기고,
 * 각 파일의 이유는 그 파일 변경 지점으로 옮긴다. 중복이 아니라 역할 분리다.
 *
 * `itemsMasked` 는 **이미 `maskSecrets` 를 거친** 세션 텍스트여야 한다(이 값은 GitHub 으로
 * 나간다). 이 함수는 마스킹하지 않는다 — 파라미터 이름이 호출부가 잊지 않게 하는 장치다.
 */
export function planReviewOrder(
  itemsMasked: readonly string[],
  anchors: readonly DiffAnchor[],
): ReviewOrderPlan {
  // 개행을 접는다 — 남겨두면 목록 구조가 깨져 항목 하나가 "2. 위조된 항목"을 덧붙일 수 있다
  // (buildPrBody 의 읽는 순서 절과 formatAddressedLines 가 같은 이유로 하는 처리다).
  const items = itemsMasked
    .map(s => s.replace(/[\r\n]+/g, " ").trim())
    .filter(s => s.length > 0);

  const comments: InlineReviewComment[] = [];
  const bodyLines: string[] = [];
  const total = items.length;

  items.forEach((item, i) => {
    const seq = i + 1;
    const { candidate, reason } = splitOrderItem(item);
    const anchor = resolveAnchor(normalizeCandidate(candidate), anchors);
    // 이유가 없으면 인라인을 만들지 않는다 — 본문 줄과 똑같은 정보라 코드에 붙일 값이 없다.
    if (anchor === null || reason.length === 0) {
      bodyLines.push(`${seq}. ${item}`);
      return;
    }
    // 첫 항목에만 "여기부터" 를 붙인다 — 인라인 코멘트는 파일 순서대로 보이지 않으므로
    // 리뷰어가 어디서 시작하는지 코드 위에서 바로 알 수 있어야 한다.
    const head = seq === 1 ? `**${seq}/${total} — 여기부터 읽으세요**` : `**${seq}/${total}**`;
    comments.push({ path: anchor.path, line: anchor.line, side: anchor.side, body: `${head}\n\n${reason}` });
    // 본문에는 넣지 않는다 — 이유가 코드 위에 있고, 순서도 코멘트의 `N/M` 이 말해준다.
  });

  return { comments, bodyLines };
}

/**
 * `gh api ... --input` 으로 보낼 리뷰 생성 payload.
 *
 * 필드를 스프레드가 아니라 하나씩 옮겨 담는다 — 실측에서 `subject_type` 이 422 를 냈으므로
 * (`Field is not defined on DraftPullRequestReviewComment`) 우리가 확인한 필드만 나가야 한다.
 * `event:"COMMENT"` 로 고정한다: APPROVE/REQUEST_CHANGES 는 사람의 판정이고, 하네스가 자기
 * PR 을 승인하는 것은 이 프로젝트의 "머지는 사람만" 규칙과 정면으로 어긋난다.
 */
export function buildReviewPayload(opts: {
  comments: readonly InlineReviewComment[];
  intro: string;
  /**
   * 모든 본문의 **첫 줄**에 붙일 하네스 센티널(`HARNESS_SENTINEL`). 값을 주입받는 이유는
   * import 순환을 만들지 않기 위함이다(pr.ts 가 이 파일을 쓴다).
   *
   * 이게 왜 필수인가: 인라인 코멘트는 `pulls/{n}/comments` 에 저장되고 **폴링 루프가 그
   * 엔드포인트를 다시 읽는다**. 코멘트 작성자는 하네스의 토큰 소유자, 즉 보통
   * `trusted_comment_authors` 에 들어 있는 사람이다 — 그래서 세션이 쓴 이유에 `@fw` 가
   * 섞이면 하네스가 **자기 코멘트를 신뢰된 지시로 읽고** fix 세션을 띄운다. 센티널로
   * 시작하는 본문은 `isTriggerComment` 가 비트리거로 판정해 그 고리를 끊는다.
   *
   * 리뷰 본문(intro)은 `pulls/{n}/reviews` 에 있어 오늘은 다시 읽히지 않는다. 그래도 같이
   * 붙이는 쪽을 택했다 — 표면마다 다르게 두면 나중에 "어디가 다시 읽히는지"를 매번
   * 되짚어야 하고, 그 되짚기를 한 번 빠뜨리면 구멍이 된다.
   */
  sentinel: string;
}): string {
  const mark = (body: string): string => `${opts.sentinel}\n${body}`;
  return JSON.stringify({
    event: "COMMENT",
    body: mark(opts.intro),
    comments: opts.comments.map(c => ({
      path: c.path, line: c.line, side: c.side, body: mark(c.body),
    })),
  });
}

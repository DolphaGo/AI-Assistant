import { execFile } from "node:child_process";
import { z } from "zod";
import { buildReviewPayload, type InlineReviewComment } from "./inlinereview.js";

// ── 타입 ────────────────────────────────────────────────────────────────

export interface PrRef {
  number: number;
  url: string;
}

export interface PrView {
  state: "OPEN" | "CLOSED" | "MERGED";
  reviewDecision: string | null;       // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null
  merged: boolean;
}

/** 하네스가 쓰는 모든 PR 코멘트의 첫 줄. 이걸로 시작하는 코멘트는 자기 답글로 간주한다. */
export const HARNESS_SENTINEL = "[fw-harness]";

export interface RawComment {
  id: number;
  body: string;
  author: string;
  isBot: boolean;
  createdAt: string;
  kind: "issue" | "review";   // id 시퀀스가 별개이므로 출처를 구분한다 (I1)
}

/** 하네스가 PR 을 다루는 유일한 창구. 테스트는 스텁을 주입한다. */
export interface PrClient {
  /**
   * 지정 브랜치를 원격에 올린다 (PR 생성 전제). 이미 있으면 갱신한다.
   * sourceRef 를 넘기면 그 ref 의 tip 을 올린다 — 넘기지 않으면 HEAD 를 올린다(기존 동작,
   * branch_strategy=current 처럼 workBranch 를 모르는/사용자 소유 브랜치 경로가 여전히 이걸 쓴다).
   * §29 CR-2: isolate/require-topic 처럼 하네스가 workBranch 를 알고 있으면 그 브랜치 자신을
   * 명시해, 세션이 이탈해 HEAD 가 다른 곳(예: main)에 가 있어도 엉뚱한 tip 이 PR 브랜치로
   * 올라가지 않게 한다.
   */
  pushBranch(opts: { cwd: string; branch: string; sourceRef?: string }): Promise<void>;
  createPr(opts: {
    cwd: string; headBranch: string; baseBranch: string; title: string; body: string;
  }): Promise<PrRef>;
  listComments(opts: { cwd: string; number: number }): Promise<RawComment[]>;
  viewPr(opts: { cwd: string; number: number }): Promise<PrView>;
  postPrComment(opts: { cwd: string; number: number; body: string }): Promise<void>;
  /**
   * 코드 위(Files changed)에 인라인 코멘트를 붙인다 — 여러 개를 **리뷰 하나로** 보낸다.
   * 실측(GHE 3.19)에서 이 호출은 전부-아니면-전무다: 앵커 하나가 diff 밖이면 422 로 전체가
   * 거부된다. 그래서 comments 의 line/side 는 반드시 diff 에서 뽑은 값이어야 한다.
   */
  postReviewComments(opts: {
    cwd: string; number: number; comments: readonly InlineReviewComment[]; intro: string;
  }): Promise<void>;
}

// ── 순수 파서 (단위 테스트 대상) ─────────────────────────────────────────

export function parsePrCreateOutput(stdout: string): PrRef {
  const urls = stdout.trim().split(/\s+/)
    .map(t => t.replace(/[.,)\]]+$/, ""))
    .filter(t => /^https?:\/\/.+\/pull\/\d+$/.test(t));
  const url = urls[urls.length - 1];              // gh 는 마지막 줄에 URL 을 출력한다
  if (!url) throw new Error(`gh pr create 출력에서 PR URL 을 찾지 못했습니다: ${stdout.trim().slice(0, 200)}`);
  return { number: Number(url.split("/").pop()), url };
}

const PR_STATES = ["OPEN", "CLOSED", "MERGED"] as const;

export function parsePrView(stdout: string): PrView {
  let json: { state?: string; reviewDecision?: string | null; mergedAt?: string | null };
  try {
    json = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`PR 상태 JSON 파싱 실패: ${(err as Error).message}`);
  }
  const state = String(json.state ?? "").toUpperCase();
  if (!(PR_STATES as readonly string[]).includes(state)) {
    throw new Error(`PR 상태를 알 수 없습니다: ${json.state}`);
  }
  // 사내 GHE 는 리뷰 승인 미결 상태를 null 대신 빈 문자열("")로 준다 (실전 스모크 결함 2).
  // 빈 문자열/undefined 를 null 로 정규화하고, 값이 있으면 대문자로 정규화해 표기 변형("approved")을 흡수한다.
  const reviewDecision = json.reviewDecision ? json.reviewDecision.toUpperCase() : null;
  return {
    state: state as PrView["state"],
    reviewDecision,
    // mergedAt 단독 판정은 제로타임에 오판한다 — state 와 교차 검증 (I4)
    merged: state === "MERGED" && Boolean(json.mergedAt),
  };
}

const GhCommentSchema = z.object({
  id: z.number().int(),
  body: z.string().nullish(),
  user: z.object({ login: z.string().nullish(), type: z.string().nullish() }).nullish(),
  created_at: z.string().nullish(),
});

export function parseComments(stdout: string, kind: "issue" | "review"): RawComment[] {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`코멘트 JSON 파싱 실패: ${(err as Error).message}`);
  }
  // --slurp 은 페이지별 배열을 배열로 감싼다 → 평탄화 (C1)
  const flat = Array.isArray(json) ? (json as unknown[]).flat() : json;
  const parsed = z.array(GhCommentSchema).safeParse(flat);
  if (!parsed.success) {
    throw new Error(`코멘트 응답 형식이 올바르지 않습니다: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data.map(c => ({
    id: c.id,
    body: c.body ?? "",
    author: c.user?.login ?? "unknown",
    isBot: c.user?.type === "Bot" || (c.user?.login ?? "").endsWith("[bot]"),   // M1
    createdAt: c.created_at ?? "",
    kind,
  }));
}

// ── pr-slicing Phase 3: PR 제목·본문 조립 (순수 함수) ────────────────────────
// 조립을 runPrGateInner 안의 인라인 문자열에서 빼낸 이유: 인라인이면 "리뷰 가이드가 실제로
// 본문에 실리는지" 를 PR 생성 전체를 스텁하지 않고는 테스트할 수 없다. Phase 1 검토의 교훈
// (배선에 테스트가 없으면 배선을 지워도 스위트가 초록이다)을 이 절이 반영한 것이다.

export interface SlicePrInfo {
  /** 워크플로우 전체 조각 순번(1부터). 조각 브랜치 이름과 PR 제목에 쓴다(D5). */
  seq: number;
  /** 원본 phase 안에서 몇 번째 조각인지 */
  index: number;
  total: number;
  /** 원본 phase id. 내부 phase id 는 D9(마지막 조각이 원본 id 를 물려받는다) 때문에 실행
   *  순서와 무관하므로 사람에게 보이는 곳에는 이 값만 쓴다. */
  originId: number;
  /** 분해 세션이 제시한 "왜 이 경계가 하나의 리뷰 단위인가". 없으면 그 절을 만들지 않는다. */
  rationale?: string;
}

export function buildPrTitle(opts: {
  workflow: string;
  phaseId: number;
  phaseTitle: string;
  slice?: SlicePrInfo;
}): string {
  if (!opts.slice) return `[fw] Phase ${opts.phaseId}: ${opts.phaseTitle}`;
  const s = opts.slice;
  return `[fw] ${opts.workflow} #${s.seq} — Phase ${s.originId} (${s.index}/${s.total}): ${opts.phaseTitle}`;
}

/**
 * PR 본문. **리뷰어가 알아야 할 것만** 담는다.
 *
 * 예전 본문은 하네스의 내부 사정을 기준으로 짜여 있었다 — 절 제목마다 그 값의 출처를 괄호로
 * 설명했고("변경 요약(무인 세션 보고)", "커밋(main 대비 실측)", "검증(이 조각이 통과한
 * 명령)"), 조각 위치·분해 근거·파일별 증감·예산 실측이 세션이 쓴 설명보다 위에 있었다.
 * 리뷰어에게는 전부 소음이다. 특히 커밋 목록과 파일별 증감은 **GitHub 이 Commits /
 * Files changed 탭에서 이미 보여주므로** 본문에 다시 적는 것은 처음부터 중복이었다.
 *
 * 그래서 본문에서 뺀 것: 조각 분해 근거, 리뷰 대상/기록용 파일 수·라인 수, 예산 초과 표기,
 * 커밋 목록, 통과한 검증 명령. 없앤 것이 아니라 **자리를 옮겼다** — 예산 초과는 실행 로그로
 * 가고(운영자용 신호다), 나머지는 STATE·실행 로그·GitHub 자체 탭에 그대로 남는다.
 *
 * 남는 것은 세 가지뿐이다: 이 PR 이 어디로 머지되는가(조각일 때만), 세션이 쓴 설명, 읽는
 * 순서를 어디서 보는가.
 */
export function buildPrBody(opts: {
  /** 이 PR 의 base. 조각 PR 이면 통합 브랜치이고, 그 사실을 리뷰어에게 알려야 한다. */
  baseBranch: string;
  /**
   * **이미 `maskSecrets` 를 거친** 세션 설명. 이 함수는 마스킹하지 않는다 — 순수 조립만 한다.
   * 파라미터 이름의 `Masked` 가 호출부가 잊지 않게 하는 유일한 장치다(신뢰 경계 밖 텍스트가
   * 외부(GitHub)로 나가는 지점이다).
   */
  sessionSummaryMasked: string | null;
  /** 조각 PR 이면 위치. 순번·원본 phase id 는 제목에 있으므로 본문에서는 쓰지 않는다. */
  slice?: { index: number; total: number };
  /**
   * 인라인 코멘트를 **붙이지 못한** 읽는 순서 항목(번호와 이유 포함). 붙인 항목은 코드 위에
   * 있으므로 여기 오지 않는다 — 같은 글을 두 곳에 두지 않는다. 붙일 수 없었던 항목만 남겨
   * 어느 경로로도 정보가 사라지지 않게 한다.
   */
  reviewOrderLines?: readonly string[];
  /** 인라인 코멘트를 하나라도 붙였는가. 없는 안내를 있다고 가리키지 않기 위한 값이다. */
  hasInlineReviewGuide?: boolean;
}): string {
  const lines: string[] = [];

  if (opts.slice) {
    lines.push(
      `조각 ${opts.slice.index}/${opts.slice.total} — 통합 브랜치 \`${opts.baseBranch}\` 로 머지됩니다 ` +
        `(base 브랜치로 바로 가지 않습니다).`,
      ``,
    );
  }

  lines.push(opts.sessionSummaryMasked ?? "(세션 요약 없음)");

  if (opts.hasInlineReviewGuide) {
    lines.push(
      ``,
      "어떤 파일부터 왜 봐야 하는지는 **Files changed** 의 인라인 코멘트에 적어뒀습니다.",
    );
  }

  const rest = (opts.reviewOrderLines ?? []).filter(l => l.length > 0);
  if (rest.length > 0) {
    // 인라인을 붙일 수 없었던 항목(diff 에 없는 파일, 바이너리 등)이라 코드 위에 자리가 없다.
    lines.push(``, "코드에 표시하지 못한 항목은 직접 확인해 주세요:", ...rest.map(l => `- ${l}`));
  }

  lines.push(
    ``,
    "리뷰 반영을 요청할 때는 코멘트에 `@fw` 를 붙여주세요 (마커가 없는 코멘트는 하네스가 읽지 않습니다).",
  );
  return lines.join("\n");
}

// ── pr-slicing Phase 5: 통합 PR (D6) ────────────────────────────────────────
// 조각 PR 이 전부 통합 브랜치로 머지된 뒤, 통합 브랜치 → base 브랜치 PR 하나로 마무리한다.
// 이 PR 의 diff 는 결국 전체지만 **조각별로 이미 리뷰가 끝났으므로** 승인만 받으면 된다 —
// 그 사실을 본문이 명시해야 리뷰어가 처음부터 다시 읽지 않는다.

export interface SlicePrLink {
  seq: number;
  url: string;
  title: string;
}

export function buildIntegrationPrTitle(opts: { workflow: string }): string {
  return `[fw] ${opts.workflow} 통합 — 조각 PR 리뷰 완료분 반영`;
}

/**
 * 통합 PR 본문. 조각 PR 본문과 같은 원칙이다 — 리뷰어가 알아야 할 것만 담는다.
 *
 * 커밋 목록은 싣지 않는다: GitHub 의 Commits 탭이 이미 보여주고, 통합 PR 은 조각들의 합이라
 * 그 목록이 특히 길다. 대신 **조각 PR 링크**를 싣는다 — 이건 GitHub 이 대신 보여줄 수 없고,
 * "이미 리뷰가 끝났으니 처음부터 다시 읽지 않아도 된다"는 이 PR 의 유일한 핵심 정보다.
 */
export function buildIntegrationPrBody(opts: {
  baseBranch: string;
  integrationBranch: string;
  /** 이 워크플로우가 만든 조각 PR 들(순번 순서). 비어 있으면 그 절을 만들지 않는다. */
  slicePrs: readonly SlicePrLink[];
}): string {
  const lines: string[] = [
    `\`${opts.integrationBranch}\` → \`${opts.baseBranch}\` — 통합 브랜치에 쌓인 결과를 한 번에 반영합니다.`,
  ];

  const slices = [...opts.slicePrs].sort((a, b) => a.seq - b.seq);
  if (slices.length > 0) {
    lines.push(
      ``,
      "이 PR 의 diff 는 아래 조각들의 합입니다 — **각 조각은 이미 개별 리뷰를 통과했습니다.** " +
        "처음부터 다시 읽지 않아도 되고, 조각 사이의 상호작용만 확인하면 됩니다.",
      ``,
      ...slices.map(s2 => `- #${s2.seq} ${s2.title} — ${s2.url}`),
    );
  }
  return lines.join("\n");
}

// ── pr-slicing Phase 3: 리뷰 대상 / 기록용 파일 분리 (D14) ──────────────────
// 실측 근거: tamper-gap 워크플로우 머지가 15 files/+1934 였고 그중 워크플로우 문서 기록이
// 단독 +1061 이었다 — PR 부피의 절반 이상이 리뷰 대상이 아닌 인수인계 기록이었다.
//
// 이 분리는 **휴리스틱이 아니라 사실**이다. workflowDir 은 하네스가 아는 값이므로 그 하위
// 경로(PLAN/NOTES/STATE/인터뷰 기록)는 확정적으로 기록용이다 — "docs/ 로 시작하면 문서"
// 같은 경로 패턴 추측을 하지 않는다. 그래서 다른 워크플로우의 문서(docs/other/...)는
// 리뷰 대상으로 남는다: 이 PR 이 남의 워크플로우 문서를 건드렸다는 것은 리뷰어가 봐야 할
// 신호이지 숨길 기록이 아니다.

export interface DiffStat {
  path: string;
  added: number;
  deleted: number;
  /** 바이너리 파일 — git 이 라인 수를 "-" 로 낸다. 0 으로 세되 목록에서 빼지 않는다
   *  (라인 수가 0이라고 리뷰가 필요 없는 것은 아니다). */
  binary: boolean;
}

/**
 * `git diff --numstat -z --no-renames` 출력을 파싱한다. 실측한 형식은
 * `<added>\t<deleted>\t<path>\0` 반복이고 바이너리는 양쪽이 `-` 다.
 *
 * `-z` 를 쓰는 이유는 defaultChangedFiles(branch.ts)와 같다 — 개행이 든 파일명이 있어도
 * 레코드 경계가 깨지지 않는다. 탭은 앞의 두 개만 구분자로 취급한다(파일명에 탭이 있을 수 있다).
 * 형식이 어긋난 레코드는 조용히 0 으로 세지 않고 **버린다** — 0 으로 세면 예산 실측이
 * 실제보다 작게 나와 "예산 안에 들어왔다"는 잘못된 신호를 준다.
 */
export function parseNumstatZ(stdout: string): DiffStat[] {
  const out: DiffStat[] = [];
  for (const record of stdout.split("\0")) {
    if (record.length === 0) continue;
    const t1 = record.indexOf("\t");
    if (t1 < 0) continue;
    const t2 = record.indexOf("\t", t1 + 1);
    if (t2 < 0) continue;
    const addedRaw = record.slice(0, t1);
    const deletedRaw = record.slice(t1 + 1, t2);
    const filePath = record.slice(t2 + 1);
    if (filePath.length === 0) continue;
    const binary = addedRaw === "-" && deletedRaw === "-";
    if (binary) {
      out.push({ path: filePath, added: 0, deleted: 0, binary: true });
      continue;
    }
    const added = Number(addedRaw);
    const deleted = Number(deletedRaw);
    if (!Number.isSafeInteger(added) || !Number.isSafeInteger(deleted) || added < 0 || deleted < 0) continue;
    out.push({ path: filePath, added, deleted, binary: false });
  }
  return out;
}

export interface ReviewDiffSummary {
  /** 리뷰어가 실제로 봐야 하는 파일(코드·테스트) */
  review: DiffStat[];
  /** 워크플로우 인수인계 기록 — 리뷰 대상이 아니다 */
  record: DiffStat[];
  /** review 의 추가+삭제 합. 예산(review_split.budget_lines) 비교 대상이다 */
  reviewLines: number;
  recordLines: number;
}

/** 표기 변형(뒤 슬래시, `./` 접두, 역슬래시)을 흡수해 비교 가능한 접두로 만든다. */
function normalizeDirPrefix(dir: string): string {
  return dir.replace(/\\/g, "/").trim().replace(/^\.\//, "").replace(/\/+$/, "");
}

/**
 * workflowDirRel 이 null 이면(리포 밖 등 판정 불가) **전부 리뷰 대상으로 둔다** — 판정하지
 * 못했다는 이유로 파일을 기록용으로 숨기면 리뷰어가 봐야 할 것이 조용히 사라진다.
 */
export function classifyReviewDiff(
  stats: readonly DiffStat[],
  workflowDirRel: string | null,
): ReviewDiffSummary {
  const dir = workflowDirRel === null ? "" : normalizeDirPrefix(workflowDirRel);
  const review: DiffStat[] = [];
  const record: DiffStat[] = [];
  for (const s of stats) {
    // `${dir}/` 로 비교해야 형제 디렉토리(docs/wf 와 docs/wf-extra)를 오판하지 않는다.
    const isRecord = dir.length > 0 && s.path.startsWith(`${dir}/`);
    (isRecord ? record : review).push(s);
  }
  const sum = (xs: readonly DiffStat[]): number => xs.reduce((n, x) => n + x.added + x.deleted, 0);
  return { review, record, reviewLines: sum(review), recordLines: sum(record) };
}

// ── 신뢰 경계 규약 1: 명시 마커만 지시로 인정 (설계 §12) ─────────────────
// PR 코멘트에는 팀원 잡담·다른 사람 멘션·봇 출력이 섞이고, 누구든 프롬프트 인젝션을
// 쓸 수 있다. 따라서 "나에게 한 말"을 관례가 아니라 명시 마커로 정의한다.
// 마커 뒤에는 공백·구두점·문자열 끝만 허용한다 (word char 또는 하이픈이 오면 불허)
// — `@fwhatever`·`@fw-bot` 둘 다 차단하고, `@fw`·`@fw,`·`@fw:`·줄끝은 허용한다.
const TRIGGER_RE = /(^|\s)(@fw(?![\w-])|\/fw\s+fix(?![\w-]))/i;

// 인용문(> ) 판정 — 리스트/체크박스 접두를 건너뛴 뒤에도 `>` 면 인용으로 취급한다.
// `- > x`·`1. > x`·`- [ ] > x` 처럼 Quote-reply 가 리스트 한 겹 안에 숨는 것을 막는다.
const QUOTE_RE = /^\s*(?:[-*+]\s+|\d+[.)]\s+)*(?:\[[ xX]\]\s+)?>/;

// 마크다운에서 "지시가 아닌 영역"을 제거한다 (C3).
// 오탐(코드·인용을 지시로 읽는 것)보다 미탐 방향으로 실패하게 기울인다.
export function stripNonInstruction(body: string): string {
  // 1) HTML 주석 — 사람 눈에 안 보이므로 감사 불가. 미닫힘도 끝까지 제거
  let text = body.replace(/<!--[\s\S]*?(-->|$)/g, "\n");
  // 1b) <details> 접힘 블록 — 기본 접혀서 사람 눈에 안 보이므로 주석과 같은 부류. 미닫힘도 끝까지 제거
  text = text.replace(/<details[\s\S]*?(<\/details>|$)/gi, "\n");
  // 2) 펜스 상태 머신(```/~~~, 3개 이상, EOF 를 닫힘으로 간주) + 인용문 + 4-space 들여쓰기 제외.
  // 백틱 런 스트립보다 먼저 처리한다 — 순수 백틱만으로 된 펜스 마커 줄(예: "```")은 자기 자신과
  // 스퓨리어스하게 자기매칭돼(런 길이>=2면 항상 부분 백트래킹으로 매칭) 펜스 인식이 깨지기 때문
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      continue;                       // 펜스 내부 — EOF 도 닫힘으로 간주(미닫힌 펜스 흡수)
    }
    if (m) { fence = m[1]; continue; }
    if (QUOTE_RE.test(line)) continue;             // 인용문 (Quote reply, 리스트/체크박스 중첩 포함)
    if (/^( {4,}|\t)/.test(line)) continue;        // 4-space 들여쓰기 코드블록
    out.push(line);
  }
  // 3) 백틱 런 인식 인라인 코드 (``@fw`` 같은 이중 백틱 포함) — 펜스 제거 후 나머지 텍스트에만 적용.
  // 치환 문자는 공백이 아닌 word char("x") — 공백으로 치환하면 원문에 없던 단어 경계가 생겨
  // `` `x`@fw `` 처럼 마커 앞에 공백이 전혀 없던 경우까지 트리거로 오판한다 (#11)
  const stripped = out.join("\n").replace(/(`+)[^\n]*?\1/g, "x");
  // 4) 강조 문자 제거 — **@fw** 같은 미탐 방지
  return stripped.replace(/[*_~]/g, "");
}

export function isTriggerComment(c: RawComment): boolean {
  if (c.isBot) return false;                                    // 봇 출력은 지시가 아니다
  if (c.body.trimStart().startsWith(HARNESS_SENTINEL)) return false;  // 센티널 (C2)
  return TRIGGER_RE.test(stripNonInstruction(c.body));
}

// ── 신뢰 경계 규약 2: 마커는 신원을 정하지 않는다 (§24 감사 T1) ────────────
// isTriggerComment 는 "나에게 한 말인가"(마커 유무)만 판정한다. 사내 GHE 에서는 리포 읽기
// 권한자 누구나 코멘트를 달 수 있어, 마커만으로는 "말할 자격이 있는가"를 정할 수 없다.
// 그래서 작성자가 STATE.json 의 trusted_comment_authors 에 있는지를 별도로 검사한다.
// 목록이 비어 있으면 아무도 신뢰하지 않는다(fail-closed) — 명시적으로 채워야 동작한다.
// GitHub/GHE 로그인은 대소문자를 구분하지 않으므로 비교도 대소문자 무시로 한다.
function isTrustedCommentAuthor(author: string, trustedAuthors: string[]): boolean {
  const lower = author.toLowerCase();
  return trustedAuthors.some(a => a.toLowerCase() === lower);
}

export function selectActionableComments(
  comments: RawComment[],
  opts: { handled: string[]; trustedAuthors: string[] },      // "kind:id" 복합 키 (I1)
): RawComment[] {
  const handled = new Set(opts.handled);
  return comments.filter(
    c =>
      !handled.has(`${c.kind}:${c.id}`) &&
      isTriggerComment(c) &&
      isTrustedCommentAuthor(c.author, opts.trustedAuthors),
  );
}

// 트리거 마커는 있지만 작성자가 신뢰 목록에 없어 무시된 코멘트 — fail-closed 로 조용히 버리면
// 사용자가 "왜 하네스가 반응하지 않는지" 알 방법이 없다. orchestrator 가 이 목록으로 로그를 남긴다.
export function selectUntrustedTriggerComments(
  comments: RawComment[],
  opts: { handled: string[]; trustedAuthors: string[] },
): RawComment[] {
  const handled = new Set(opts.handled);
  return comments.filter(
    c =>
      !handled.has(`${c.kind}:${c.id}`) &&
      isTriggerComment(c) &&
      !isTrustedCommentAuthor(c.author, opts.trustedAuthors),
  );
}

export function commentKey(c: RawComment): string {
  return `${c.kind}:${c.id}`;
}

// ── gh/git CLI 구현 ──────────────────────────────────────────────────────

const EXEC_TIMEOUT_MS = 60_000;

// stdin 을 받는 이유: 리뷰 생성 payload 는 `comments` 가 **중첩 배열**이라 `-f key=value`
// 플래그로 표현할 수 없다. `--input -` 로 JSON 을 넘긴다. 파일 경로(`--input @file`)를 쓰지
// 않는 것은 의도다 — 임시 파일을 남기지 않고, 세션이 쓴 텍스트가 디스크를 경유하지 않는다.
function gh(args: string[], cwd: string, stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("gh", args, { cwd, maxBuffer: 32 * 1024 * 1024, timeout: EXEC_TIMEOUT_MS },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`gh ${args.slice(0, 3).join(" ")} 실패: ${stderr || err.message}`));
          return;
        }
        resolve(stdout);
      });
    if (stdin === undefined) return;
    // gh 가 먼저 죽으면 write 가 EPIPE 를 내는데, 그 에러는 execFile 콜백이 아니라 스트림으로
    // 온다 — 잡지 않으면 프로세스 전체를 죽이는 unhandled error 가 된다. reject 로 옮겨
    // 호출부의 fail-open 경로가 처리하게 한다.
    child.stdin?.on("error", (err: Error) => reject(new Error(`gh stdin 쓰기 실패: ${err.message}`)));
    child.stdin?.end(stdin);
  });
}

// gh() 와 동일한 계약(execFile — 셸 미개입으로 인젝션 안전, timeout, 명확한 에러)의 git 버전.
// PR 생성 전 현재 HEAD 를 원격 브랜치로 올리는 데 쓴다(pushBranch).
function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 32 * 1024 * 1024, timeout: EXEC_TIMEOUT_MS },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`git ${args.slice(0, 3).join(" ")} 실패: ${stderr || err.message}`));
          return;
        }
        resolve(stdout);
      });
  });
}

// 순수 함수로 분리 — execFile 호출 자체는 단위 테스트하기 어렵지만 인자 조립은 검증 가능해야 한다.
// <sourceRef>:refs/heads/<branch> 형태를 쓰는 이유: 로컬에 그 이름의 브랜치를 만들지 않고도 지정
// 커밋을 원격 브랜치로 올릴 수 있어, 세션의 작업 브랜치가 무엇이든(main 이든 topic 이든) 동작한다.
// sourceRef 생략 시 기본 "HEAD" — branch_strategy=current(§29 CR-2 — workBranch 를 모르는/사용자
// 소유 브랜치) 경로의 기존 동작을 그대로 유지한다. isolate/require-topic 은 orchestrator 가
// workBranch 를 sourceRef 로 명시해, HEAD 가 어디에 있든(세션 이탈 등) 그 tip 이 아니라 작업
// 브랜치 자신의 tip 이 올라가게 한다.
// --force-with-lease: 하네스가 매 시도마다 같은 이름(fw/phase-<id>)으로 재푸시할 수 있어야 하므로
// 단순 push 로는 안 되지만(비-fast-forward 거부), 완전한 --force 는 그 사이 다른 사람이 그 브랜치에
// 올린 커밋을 조용히 지워버릴 수 있다 — lease 는 로컬이 알던 원격 상태와 실제 원격이 다르면 거부한다.
// §40 — `-u`(--set-upstream)를 쓰지 않는다. **실측된 사고:** `-u` 는 refspec 의 목적지가 아니라
// **현재 브랜치**의 upstream 을 덮어쓴다. pr-smoke 주행이 `HEAD:refs/heads/fw/phase-1` 을 -u 로
// push 하면서 이 리포의 `main` upstream 이 `origin/fw/phase-1` 로 바뀌었고, 그 상태가 세션이
// 끝난 뒤에도 남았다(`git config branch.main.merge` = refs/heads/fw/phase-1 로 확인).
// 이후 사람이 `main` 에서 무심코 `git pull`/`git push` 를 치면 엉뚱한 브랜치와 동기화된다 —
// **하네스가 사용자의 로컬 git 설정을 조용히 바꾸는 것은 그 자체로 결함이다.**
// -u 는 이득도 없다: pushBranch 는 항상 명시 refspec 을 쓰고, createPr 은 `--head` 를 명시한다.
export function buildPushArgs(branch: string, sourceRef?: string): string[] {
  return ["push", "origin", `${sourceRef ?? "HEAD"}:refs/heads/${branch}`, "--force-with-lease"];
}

// listComments 의 gh api 인자 조립 — 순수 함수로 분리 (execFile 호출 자체는 단위 테스트가 어렵다).
// 실전 스모크 결함 1: gh api 는 -f/-F 플래그가 붙으면 명시 메서드가 없어도 요청을 자동으로 POST 로
// 바꾼다. -f per_page=100 을 조회 요청에 얹었다가 코멘트 *조회* 가 코멘트 *생성* 요청이 되어 422 로
// 실패했다. per_page 는 URL 쿼리로 직접 붙이고(-f 는 전혀 쓰지 않는다) --paginate/--slurp 로 페이지를
// 모은다 — 실제로 GET 요청으로 페이지네이션이 그대로 동작함을 확인했다.
export function buildCommentsFetchArgs(kind: "issue" | "review", number: number): string[] {
  const resource = kind === "issue" ? "issues" : "pulls";
  return ["api", `repos/{owner}/{repo}/${resource}/${number}/comments?per_page=100`, "--paginate", "--slurp"];
}

// 리뷰 생성(인라인 코멘트) 의 gh api 인자 조립. `--method POST` 를 명시하는 이유: `--input` 이
// 있으면 gh 가 알아서 POST 로 바꾸지만, 그 암묵 전환에 기대면 조회가 생성이 되는 사고(실전
// 스모크 결함 1)와 같은 형태의 오해가 반복된다 — 쓰기 요청은 쓰기라고 적는다.
export function buildReviewCreateArgs(number: number): string[] {
  return ["api", "--method", "POST", `repos/{owner}/{repo}/pulls/${number}/reviews`, "--input", "-"];
}

export class GhPrClient implements PrClient {
  async pushBranch(opts: { cwd: string; branch: string; sourceRef?: string }): Promise<void> {
    await git(buildPushArgs(opts.branch, opts.sourceRef), opts.cwd);
  }

  async createPr(opts: {
    cwd: string; headBranch: string; baseBranch: string; title: string; body: string;
  }): Promise<PrRef> {
    const out = await gh(
      ["pr", "create", "--head", opts.headBranch, "--base", opts.baseBranch,
       "--title", opts.title, "--body", opts.body],
      opts.cwd,
    );
    return parsePrCreateOutput(out);
  }

  async listComments(opts: { cwd: string; number: number }): Promise<RawComment[]> {
    // 일반 코멘트(issues) + 리뷰 라인 코멘트(pulls) 양쪽을 모은다
    const kinds: Array<"issue" | "review"> = ["issue", "review"];
    const settled = await Promise.allSettled(
      kinds.map(kind => gh(buildCommentsFetchArgs(kind, opts.number), opts.cwd)),
    );
    const out: RawComment[] = [];
    let lastErr: Error | null = null;
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") out.push(...parseComments(r.value, kinds[i]));
      else lastErr = r.reason as Error;
    });
    // 양쪽 다 실패하면 폴링을 계속할 근거가 없다. 한쪽만 실패면 부분 열화로 진행 (I5)
    if (out.length === 0 && lastErr) throw lastErr;
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));   // 시간순 (I1)
  }

  async viewPr(opts: { cwd: string; number: number }): Promise<PrView> {
    const out = await gh(
      ["pr", "view", String(opts.number), "--json", "state,reviewDecision,mergedAt"],
      opts.cwd,
    );
    return parsePrView(out);
  }

  async postPrComment(opts: { cwd: string; number: number; body: string }): Promise<void> {
    // 센티널을 첫 줄에 강제 — 다음 폴링에서 자기 답글을 확실히 배제한다 (C2)
    const body = `${HARNESS_SENTINEL}\n${opts.body}`;
    await gh(["pr", "comment", String(opts.number), "--body", body], opts.cwd);
  }

  async postReviewComments(opts: {
    cwd: string; number: number; comments: readonly InlineReviewComment[]; intro: string;
  }): Promise<void> {
    await gh(
      buildReviewCreateArgs(opts.number),
      opts.cwd,
      // 센티널 부착은 buildReviewPayload 가 한다 — 인라인 코멘트는 pulls/{n}/comments 로
      // 다시 읽히므로 필수다(C2 와 같은 이유, 근거는 그 함수 주석에).
      buildReviewPayload({ comments: opts.comments, intro: opts.intro, sentinel: HARNESS_SENTINEL }),
    );
  }
}

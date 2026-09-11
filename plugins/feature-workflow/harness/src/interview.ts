import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

// ---------------------------------------------------------------------------
// §46 — 3역할 인터뷰. 목표 구조의 3~6번을 담당한다:
//   3. 기획 고수가 기획서로 쓰기 애매한 부분을 인터뷰
//   4. 개발 고수가 개발하기 애매한 부분을 인터뷰
//   5. 평가 고수가 뭘 평가·검증할지 애매한 부분을 인터뷰
//   6. 기획 / 개발 방향 / 평가 계획 작성
//
// 기존 스킬의 "grill me" 는 산문 지시라 모델이 두세 개 묻고 "충분한 것 같습니다" 로 넘어가도
// 막을 수단이 없었다. 하네스가 된다는 것은 **인터뷰의 종료 조건을 기계가 갖는다**는 뜻이다:
//   미답 질문 0건  AND  역할별 초안 3개  AND  상호 이의 0건  →  ready  →  사람이 승인
// 어느 하나라도 모델의 자기 주장("충분하다")으로 채울 수 없다 — 전부 셀 수 있는 값이다.
//
// 이의(objection) 라운드가 핵심이다. 역할이 스스로 "더 물을 게 없다" 고 선언하는 것은
// §30 P4(자기 주장은 증명이 아니다) 위반이지만, **다른 역할이 그 초안에 이의를 걸 수 없을 때**
// 통과시키는 것은 적대적 검증이다 — §45 의 검증 메커니즘을 인터뷰 단계로 앞당긴 것.
//
// 코드 파악은 전체 스캔이 아니라 **사람이 지정한 진입 경로**에서 시작한다(§44 와 같은 원칙 —
// 전체 스캔은 토큰 낭비이면서 정작 중요한 곳을 놓친다). 진입 경로를 어디로 할지 자체가
// 개발 역할의 인터뷰 질문이 될 수 있다.
//
// 소유권: INTERVIEW.json 은 하네스 소유(STATE.json 과 동일 계약). PLAN.md 는 승인 시점에
// 단 한 번, 사람의 명시적 명령(fw interview approve)으로만 쓰인다 — 시작과 끝은 사람이다.
// ---------------------------------------------------------------------------

export const INTERVIEW_FILE = "INTERVIEW.json";

/** 역할 순서는 고정 — 기획이 먼저다. 개발·평가 세션은 기획 질문의 답을 컨텍스트로 받으므로
 *  순서가 바뀌면 뒤 역할이 근거 없이 초안을 쓴다. */
export const INTERVIEW_ROLES = ["planning", "development", "evaluation"] as const;
export type InterviewRole = (typeof INTERVIEW_ROLES)[number];

export const INTERVIEW_ROLE_LABEL: Record<InterviewRole, string> = {
  planning: "기획",
  development: "개발",
  evaluation: "평가",
};

const QUESTION_ID_PREFIX: Record<InterviewRole, string> = {
  planning: "P",
  development: "D",
  evaluation: "E",
};

// 에이전트 세션(역할 실행 + 이의 라운드) 총 횟수 상한. 무한 인터뷰(질문 → 답 → 새 질문 → ...)
// 를 막는 기계적 안전장치다 — 상한 도달 시 실패가 아니라 "지금까지의 재료로 사람이 판단하라"
// 로 끝난다(§30 P2 — 방어가 정상 경로를 실패로 만들면 안 된다).
// §50 실측(z-parse 통주): 처음 12 로 잡았으나 실전 인터뷰는 질문 29건·이의 9건·재작성
// 라운드 포함 약 26세션이 필요했다 — 질문·이의가 많은 것은 인터뷰가 잘 되고 있다는 신호이지
// 폭주가 아니다. 폭주(계약 위반 출력 반복)만 걸러내면 되므로 실측치의 약 1.4배로 잡는다.
export const MAX_INTERVIEW_SESSIONS = 66;

// §53 실측(z-parse 통주): 이의 라운드가 7차까지 돌며 라운드마다 정당하지만 점점 가늘어지는
// 이의로 초안을 무효화했다 — 이의 32건 중 뒤 라운드는 "한 표시 지점의 join 형식" 수준까지
// 내려갔고, 인터뷰 비용($32)의 최대 동인이었다. 이의의 가치는 처음 2~3라운드에 몰려 있고
// (전면 재설계급 발견은 전부 1~2라운드), 그 뒤는 한계 효용이 급감한다. 상한 도달 시 실패가
// 아니라 "남은 판단은 사람 몫" 으로 넘긴다(§50 --force 가 그 설계된 출구다).
export const MAX_OBJECTION_ROUNDS = 3;

const InterviewQuestionSchema = z
  .object({
    id: z.string(),
    role: z.enum(INTERVIEW_ROLES),
    question: z.string(),
    /** 왜 이 질문이 결정에 필요한가 — 답하는 사람이 질문의 무게를 알 수 있어야 한다. */
    why: z.string().default(""),
    answer: z.string().nullable().default(null),
    asked_at: z.string(),
    answered_at: z.string().nullable().default(null),
  })
  .strict();
export type InterviewQuestion = z.infer<typeof InterviewQuestionSchema>;

const InterviewObjectionSchema = z
  .object({
    from_role: z.enum(INTERVIEW_ROLES),
    to_role: z.enum(INTERVIEW_ROLES),
    detail: z.string(),
    /** 대상 역할이 초안을 다시 쓰면 resolved 로 바뀐다 — 이력은 지우지 않는다(감사 가치). */
    resolved: z.boolean().default(false),
    at: z.string(),
  })
  .strict();
export type InterviewObjection = z.infer<typeof InterviewObjectionSchema>;

export const InterviewStateSchema = z
  .object({
    schema_version: z.literal(1),
    /** 사람이 쓴 목표 (목표 구조 1번). 하네스는 이 문장을 만들지도 고치지도 않는다. */
    goal: z.string().min(1),
    /** 사람이 지정한 진입 경로 (2번의 대체 — 전체 스캔 금지). 비워둘 수 있다: 그 경우
     *  "어디부터 읽어야 하는가" 가 개발 역할의 첫 질문이 되는 것이 정상 경로다. */
    entry_paths: z.array(z.string()).default([]),
    status: z.enum(["interviewing", "ready", "approved"]),
    /** 지금까지 실행된 에이전트 세션 수 (역할 실행 + 이의 라운드). MAX_INTERVIEW_SESSIONS 상한. */
    sessions_used: z.number().int().nonnegative().default(0),
    /** 인터뷰에 쓴 누적 비용(USD). 상한은 두지 않는다 — 세션 수 상한이 이미 지출을 묶는다. */
    cost_usd: z.number().nonnegative().default(0),
    questions: z.array(InterviewQuestionSchema).default([]),
    drafts: z
      .object({
        planning: z.string().nullable().default(null),
        development: z.string().nullable().default(null),
        evaluation: z.string().nullable().default(null),
      })
      .strict(),
    objections: z.array(InterviewObjectionSchema).default([]),
    /** 마지막 이의 라운드가 "이의 0건" 으로 끝났는가. 초안이 하나라도 바뀌면 false 로 리셋 —
     *  바뀐 초안은 다시 이의 라운드를 통과해야 한다. */
    objection_pass_clean: z.boolean().default(false),
    /** §50 — 사람이 이의 미수렴 상태에서 강제 승인했음을 기록. PLAN §미해소 이견 절의 근거. */
    force_approved: z.boolean().default(false),
    /** §53 — 지금까지 실행된 이의 라운드 수. MAX_OBJECTION_ROUNDS 도달 시 새 라운드를 돌리지
     *  않고 사람에게 넘긴다(objection_cap). 구버전 파일은 default 0 으로 그대로 파싱된다. */
    objection_rounds: z.number().int().nonnegative().default(0),
    /** §67 — 기획 역할이 초안과 함께 반환한 용어 정의. assemblePlan 이 PLAN §용어 표로
     *  렌더한다 — 이전에는 이 표를 채우는 주체가 없어 §28 3절 주입 중 §용어가 구조적으로
     *  항상 0자였다(tamper-gap 사이클에서 doctor 경고로 실측, 사람이 수동으로 메움).
     *  구버전 파일은 default [] 로 그대로 파싱된다. */
    glossary: z
      .array(
        z.object({ term: z.string(), definition: z.string(), avoid: z.string().default("") }).strict(),
      )
      .default([]),
  })
  .strict();
export type InterviewState = z.infer<typeof InterviewStateSchema>;

export function newInterview(goal: string, entryPaths: string[]): InterviewState {
  return InterviewStateSchema.parse({
    schema_version: 1,
    goal,
    entry_paths: entryPaths,
    status: "interviewing",
    sessions_used: 0,
    cost_usd: 0,
    questions: [],
    drafts: { planning: null, development: null, evaluation: null },
    objections: [],
    objection_pass_clean: false,
  });
}

export function loadInterview(workflowDir: string): InterviewState {
  const raw = fs.readFileSync(path.join(workflowDir, INTERVIEW_FILE), "utf-8");
  return InterviewStateSchema.parse(JSON.parse(raw));
}

export function saveInterview(workflowDir: string, state: InterviewState): void {
  // STATE.json 과 동일한 원자적 쓰기 계약까지는 필요 없다(인터뷰는 사람이 지켜보는 대화형
  // 단계라 무인 크래시 내구성 요구가 낮다) — 다만 쓰기 실패는 조용히 삼키지 않는다.
  fs.writeFileSync(path.join(workflowDir, INTERVIEW_FILE), JSON.stringify(state, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// 상태 기계 — 다음에 무엇을 해야 하는지는 전부 셀 수 있는 값으로 결정된다.
// ---------------------------------------------------------------------------

export type InterviewAction =
  /** 미답 질문이 있다 — 사람 차례. 에이전트는 돌지 않는다. */
  | { kind: "await_answers"; unanswered: InterviewQuestion[] }
  /** 이 역할의 초안이 없다(또는 이의로 무효화됐다) — 역할 세션을 돌릴 차례. */
  | { kind: "run_role"; role: InterviewRole }
  /** 초안 3개 완비 — 상호 이의 라운드를 돌릴 차례. */
  | { kind: "run_objections" }
  | { kind: "objection_cap"; rounds: number }
  /** 미답 0·초안 3·이의 0 — 사람의 승인(fw interview approve)만 남았다. */
  | { kind: "ready" }
  /** 세션 상한 도달 — 지금까지의 재료로 사람이 판단한다. */
  | { kind: "session_cap"; used: number }
  /** 이미 승인됨 — 할 일 없음. */
  | { kind: "approved" };

export function unansweredQuestions(state: InterviewState): InterviewQuestion[] {
  return state.questions.filter(q => q.answer === null);
}

export function interviewNext(state: InterviewState): InterviewAction {
  if (state.status === "approved") return { kind: "approved" };
  if (state.status === "ready") return { kind: "ready" };

  // ① 사람 차례가 최우선 — 미답 질문을 두고 에이전트를 더 돌리면, 답 없이 쓴 초안이
  //    나중에 답과 충돌한다(인터뷰의 존재 이유 자체를 무효화).
  const unanswered = unansweredQuestions(state);
  if (unanswered.length > 0) return { kind: "await_answers", unanswered };

  // ② 상한 — 에이전트를 더 돌려야 하는 상황에서만 검사한다(답 입력·승인은 막지 않는다).
  if (state.sessions_used >= MAX_INTERVIEW_SESSIONS) {
    return { kind: "session_cap", used: state.sessions_used };
  }

  // ③ 초안이 빈 역할(고정 순서) — 기획 먼저.
  for (const role of INTERVIEW_ROLES) {
    if (state.drafts[role] === null) return { kind: "run_role", role };
  }

  // ④ 초안 3개 완비 — 마지막 이의 라운드가 깨끗했으면 ready, 아니면 이의 라운드.
  // §53 — 라운드 상한 도달 시 새 라운드를 돌리지 않는다: 초안 3개 + 미답 0 인 지금이
  // 사람이 판단할 수 있는 상태다(--force 승인 가능). 상한 없이 두면 라운드마다 점점
  // 가늘어지는 정당한 이의가 초안을 계속 무효화해 ready 에 영원히 도달하지 못한다(실측 7차).
  if (!state.objection_pass_clean) {
    if (state.objection_rounds >= MAX_OBJECTION_ROUNDS) {
      return { kind: "objection_cap", rounds: state.objection_rounds };
    }
    return { kind: "run_objections" };
  }
  return { kind: "ready" };
}

// ---------------------------------------------------------------------------
// 전이 함수 — 세션 결과·사람의 답을 상태에 반영한다. 전부 순수(복사본 반환).
// ---------------------------------------------------------------------------

function nextQuestionId(state: InterviewState, role: InterviewRole): string {
  const prefix = QUESTION_ID_PREFIX[role];
  const used = state.questions.filter(q => q.role === role).length;
  return `${prefix}${used + 1}`;
}

/** 역할 세션의 출력: 질문 목록 또는 초안. 계약상 질문이 하나라도 있으면 초안은 무시한다 —
 *  "물을 게 남았는데 초안도 썼다" 는 답을 안 듣고 결정했다는 뜻이므로 질문 쪽이 보수적이다. */
export interface RoleSessionOutput {
  questions: Array<{ question: string; why?: string }>;
  draft: string | null;
  /** §48 — 진입 경로는 별도 사전 단계(구 2번)가 아니라 **개발 고수 인터뷰의 산출물**이다.
   *  개발 역할이 사용자의 답으로 확정한 경로를 여기 담으면 하네스가 entry_paths 로 승격해
   *  이후 모든 역할 프롬프트와 PLAN §진입 경로에 실린다. CLI --entry 는 "이미 아는 사람의
   *  지름길"(선택)로 남는다. */
  entry_paths?: string[];
  /** §67 — 용어 정의는 **기획 고수 인터뷰의 산출물**이다(용어 통일은 기획 소유).
   *  다른 역할이 채워도 applyRoleResult 가 무시한다 — 소유 경계는 하네스가 지킨다. */
  glossary?: Array<{ term: string; definition: string; avoid?: string }>;
}

// §48 — entry_paths 는 신뢰 경계 밖 값이다. 개수·길이 상한(초과분은 버리되 아래
// applyRoleResult 가 원본 개수를 보존하지 않으므로 상한 자체를 넉넉히 둔다 — 경로 20개를
// 넘는 "진입" 지정은 이미 전체 스캔과 다르지 않아 목적을 잃는다).
export const MAX_ENTRY_PATHS = 20;
const ENTRY_PATH_CHAR_CAP = 300;

// §67 — glossary 도 신뢰 경계 밖 값이다(§48 과 같은 원칙). term 은 항목의 정체성이라 비면
// 버리고, definition/avoid 는 내용이라 자르되 버리지 않는다. `|` 와 개행은 마크다운 표의
// 구조 문자라 셀 안에 원문으로 들어가면 표가 깨져 plan.ts 파서가 행을 오독한다(§62 조립기↔
// 파서 통합 결함과 같은 클래스) — 치환으로 무해화한다.
export const MAX_GLOSSARY_TERMS = 20;
const GLOSSARY_TERM_CHAR_CAP = 60;
const GLOSSARY_DEF_CHAR_CAP = 300;
const GLOSSARY_AVOID_CHAR_CAP = 100;

function sanitizeGlossaryCell(text: string, cap: number): string {
  return text.replace(/\s+/g, " ").replace(/\|/g, "/").trim().slice(0, cap);
}

export function sanitizeGlossary(
  entries: Array<{ term: string; definition: string; avoid?: string }>,
): Array<{ term: string; definition: string; avoid: string }> {
  return entries
    .map(e => ({
      term: sanitizeGlossaryCell(e.term, GLOSSARY_TERM_CHAR_CAP),
      definition: sanitizeGlossaryCell(e.definition, GLOSSARY_DEF_CHAR_CAP),
      avoid: sanitizeGlossaryCell(e.avoid ?? "", GLOSSARY_AVOID_CHAR_CAP),
    }))
    .filter(e => e.term.length > 0 && e.definition.length > 0)
    .slice(0, MAX_GLOSSARY_TERMS);
}

export function applyRoleResult(
  state: InterviewState,
  role: InterviewRole,
  output: RoleSessionOutput,
  now: string,
): InterviewState {
  const next: InterviewState = structuredClone(state);
  next.sessions_used += 1;
  // §48 — 진입 경로 승격은 질문 분기보다 **먼저** 한다. 질문과 함께 온 부분 확정 경로도
  // 다음 역할 세션 프롬프트에 바로 실려야 하기 때문이다(질문 분기는 조기 반환한다 — 처음
  // 구현에서 이 아래 두었다가 테스트가 잡았다). 개발 역할만 승격 가능(소유 경계).
  if (role === "development" && output.entry_paths && output.entry_paths.length > 0) {
    next.entry_paths = output.entry_paths
      .map(x => x.trim())
      .filter(x => x.length > 0 && x.length <= ENTRY_PATH_CHAR_CAP)
      .slice(0, MAX_ENTRY_PATHS);
  }
  // §67 — 용어 승격도 §48 과 동일하게 질문 조기 반환보다 먼저 한다(질문과 함께 온 부분
  // 확정 용어도 유실하지 않는다). 기획 역할만 승격 가능(소유 경계). 최신 반환이 이전 것을
  // 통째로 대체한다 — 재작성된 초안의 용어가 항상 현행이다.
  if (role === "planning" && output.glossary && output.glossary.length > 0) {
    const sanitized = sanitizeGlossary(output.glossary);
    if (sanitized.length > 0) next.glossary = sanitized;
  }
  if (output.questions.length > 0) {
    for (const q of output.questions) {
      next.questions.push({
        id: nextQuestionId(next, role),
        role,
        question: q.question,
        why: q.why ?? "",
        answer: null,
        asked_at: now,
        answered_at: null,
      });
    }
    return next;
  }
  if (output.draft && output.draft.trim().length > 0) {
    next.drafts[role] = output.draft;
    // 초안이 바뀌었으므로 이전 이의 통과는 무효 — 바뀐 초안은 다시 이의 라운드를 거쳐야 한다.
    // (mutation 참고: 이 리셋은 현 상태 기계에서는 도달 불가능한 방어다 — clean=true 는 ready
    //  상태에서만 존재하고 ready 에서는 run_role 이 돌지 않는다. 그래서 이 줄을 지우는 mutant 는
    //  equivalent 다. 그래도 남긴다: 사람이 INTERVIEW.json 을 손으로 고치거나 승인 흐름이 바뀌면
    //  이 불변식이 코드에 없다는 사실이 그때 사고가 된다. §41 m-2 전례 — 억지 테스트로 죽일 수
    //  없는 mutant 는 죽은 척하게 만들지 말고 여기 기록한다.)
    next.objection_pass_clean = false;
    // 이 역할을 향한 미해결 이의는 재작성으로 응답된 것으로 본다(이의 자체는 이력으로 남는다).
    for (const o of next.objections) {
      if (o.to_role === role && !o.resolved) o.resolved = true;
    }
    return next;
  }
  // 질문도 초안도 없는 출력 — 세션이 계약을 어겼다. 상태는 바꾸지 않되 세션 수는 이미 셌다
  // (공짜 재시도를 무한히 주면 상한의 의미가 없다).
  return next;
}

export function applyAnswer(state: InterviewState, questionId: string, answer: string, now: string): InterviewState {
  const next: InterviewState = structuredClone(state);
  const q = next.questions.find(x => x.id === questionId);
  if (!q) throw new Error(`질문 ${questionId} 이(가) 없습니다. fw interview 로 현재 질문을 확인하세요.`);
  if (q.answer !== null) throw new Error(`질문 ${questionId} 은(는) 이미 답변됐습니다: ${q.answer}`);
  q.answer = answer;
  q.answered_at = now;
  return next;
}

export function applyObjections(
  state: InterviewState,
  raised: Array<{ from_role: InterviewRole; to_role: InterviewRole; detail: string }>,
  now: string,
  /** 이 이의 라운드에 실제로 쓴 세션 수 — 역할당 1세션(독립 관점)이 기본이므로 보통 3이다.
   *  1 로 과소 계상하면 상한(MAX_INTERVIEW_SESSIONS)이 실제 지출의 1/3 만 세는 구멍이 된다. */
  sessionsSpent: number,
): InterviewState {
  const next: InterviewState = structuredClone(state);
  next.sessions_used += sessionsSpent;
  next.objection_rounds += 1; // §53 — 상한 판정용 라운드 카운트
  // 자기 자신에 대한 이의는 버린다 — 자기 초안이 불만이면 다시 쓰면 될 일이고, 실측 없이
  // 허용하면 "자기 이의 → 자기 재작성" 루프로 세션 상한만 태운다.
  const valid = raised.filter(o => o.from_role !== o.to_role);
  if (valid.length === 0) {
    next.objection_pass_clean = true;
    next.status = "ready";
    return next;
  }
  for (const o of valid) {
    next.objections.push({ ...o, resolved: false, at: now });
    // 이의를 받은 초안은 무효화 — 그 역할이 이의를 컨텍스트로 받아 다시 쓴다.
    next.drafts[o.to_role] = null;
  }
  next.objection_pass_clean = false;
  return next;
}

export function approveInterview(state: InterviewState, opts?: { force?: boolean }): InterviewState {
  // §50 실측(z-parse 통주): 세션 상한 도달 메시지는 "사람이 판단하세요" 인데 승인은 ready
  // 에서만 가능해 **사람이 판단할 기계적 경로가 없었다** — 이의 라운드가 7차까지 정당하지만
  // 점점 가늘어지는 이의를 계속 내면(라운드마다 초안 무효화) ready 에 영원히 도달하지 못한다.
  // force 승인이 그 탈출구다: "시작과 끝은 사람" 이라는 설계 원칙의 기계적 구현.
  //   - 조건: 세 초안 전부 존재 + 미답 질문 0 — 재료 없이는 강제도 없다.
  //   - 미해소 이의는 지우지 않는다 — assemblePlan 이 §미해소 이견 절로 PLAN 에 그대로 싣는다
  //     (§47 합의 원칙과 동일: 이견을 뭉개면 문서 전체가 무효다).
  if (opts?.force) {
    const missing = INTERVIEW_ROLES.filter(r => state.drafts[r] === null);
    if (missing.length > 0) {
      throw new Error(`강제 승인에도 세 초안이 전부 필요합니다 — 없는 초안: ${missing.join(", ")}. fw interview 로 초안을 채우세요.`);
    }
    if (unansweredQuestions(state).length > 0) {
      throw new Error("미답 질문이 남아 있으면 강제 승인할 수 없습니다 — fw interview-answer 로 먼저 답하세요.");
    }
    const next: InterviewState = structuredClone(state);
    next.status = "approved";
    next.force_approved = true;
    return next;
  }
  if (state.status !== "ready") {
    throw new Error(
      `승인은 ready 상태에서만 가능합니다 (현재: ${state.status}). fw interview 로 남은 단계를 확인하세요. ` +
        `이의 라운드가 수렴하지 않으면 fw interview-approve --force 로 사람이 마무리할 수 있습니다(미해소 이견은 PLAN 에 남습니다).`,
    );
  }
  const next: InterviewState = structuredClone(state);
  next.status = "approved";
  return next;
}

// ---------------------------------------------------------------------------
// PLAN 조립 — 승인 시점에 단 한 번, 사람의 명령으로만 실행된다.
// ---------------------------------------------------------------------------

/** 인터뷰 Q&A 를 §핵심 결정 표의 행으로 변환한다. 인터뷰의 답이 곧 결정이다(grill-with-docs) —
 *  별도 문서에 두면 세션 주입(§28)에서 빠진다. 역할 초안이 이미 결정 표를 담고 있어도 Q&A 는
 *  따로 붙는다: 초안은 에이전트의 산출물이고 Q&A 는 사람의 발화라 출처가 다르다. */
export function questionsAsDecisionRows(state: InterviewState): string {
  const answered = state.questions.filter(q => q.answer !== null);
  if (answered.length === 0) return "";
  const rows = answered.map(
    q => `| ${q.id} | ${oneLine(q.question)} → **${oneLine(q.answer!)}** | 인터뷰(${INTERVIEW_ROLE_LABEL[q.role]}) | accepted | ${(q.answered_at ?? "").slice(0, 10)} |`,
  );
  return ["| ID | 결정 | 근거 | 상태 | 날짜 |", "|----|------|------|------|------|", ...rows].join("\n");
}

function oneLine(s: string): string {
  // 표 셀 안에서 파이프·개행은 표를 깨뜨린다 — 마크다운 표가 깨지면 §28 파서가 절을 통째로
  // 놓치므로(주입 누락) 단순 치환으로 방어한다.
  return s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
}

// §50 후속 실측 — 초안이 자체 h2 헤딩(예: "## §개발 방향 초안")을 갖고 있으면, 템플릿의
// 절 헤딩("## 개발 방향") 본문이 비어 §28 파서가 0자를 주입하고, 초안 자체 헤딩은 "초안"
// 배제 토큰(§32 I-6)에 걸려 후보에서 제외된다 — 개발 방향·검증 기준이 통째로 주입에서
// 빠졌다(z-parse PLAN 실측: architecture 0자, acceptance 0자). 초안을 템플릿 절의 **본문**
// 으로 넣는 것이므로 초안 내부 헤딩을 한 단계 강등해 절 경계를 침범하지 않게 한다.
// §62 실측(porcelain-v2 승인): 평가 초안이 h1 제목("# 평가 계획서…")으로 시작해 h2 템플릿
// 절("## 검증 기준")을 즉시 종료시켰고 — §50 후속의 #{2,5} 정규식이 h1 을 빠뜨려 — 검증
// 기준 주입이 다시 0자가 됐다. 규칙을 "초안의 모든 헤딩은 최소 h3" 로 바꾼다: h1/h2→h3,
// h3→h4, … 어떤 초안 헤딩도 h2 절 경계를 침범할 수 없다.
function demoteHeadings(draft: string): string {
  return draft.replace(/^(#{1,5})(\s)/gm, (_m, hashes: string, sp: string) => "#".repeat(Math.max(3, hashes.length + 1)) + sp);
}

export function assemblePlan(state: InterviewState): string {
  const entries =
    state.entry_paths.length > 0 ? state.entry_paths.map(p => `- ${p}`).join("\n") : "- (지정 안 됨 — 개발 방향의 진입 경로 참조)";
  const qa = questionsAsDecisionRows(state);
  // §50 — 강제 승인의 정직한 기록. 주의: "세 초안 존재 + 미해소 이의" 는 동시에 성립하지
  // 않는다(이의는 대상 초안을 무효화하고, 재작성되면 resolved 로 바뀐다). 강제 승인이 실제로
  // 남기는 진실은 "마지막 초안들이 이의 라운드 재검증을 통과하지 않았다" 는 사실이다 — 그걸
  // 숨기면 §핵심 결정 표의 "상호 이의 0건 통과" 전제가 조용히 거짓이 된다(§30 P4). 최근
  // 라운드에서 재작성으로 '해소 주장' 된 이의들도 함께 싣는다 — 재작성이 이의를 실제로
  // 반영했는지는 검증 에이전트가 이 목록으로 대조한다.
  const recentObjections = state.force_approved ? state.objections.slice(-6) : [];
  const objectionSection = state.force_approved
    ? `\n## 미검증 승인 (사람이 강제 승인 — §50)\n\n` +
      `이 PLAN 의 마지막 초안들은 상호 이의 라운드의 청정 통과(이의 0건) **없이** 사람이 승인했다.\n` +
      `아래는 마지막 이의들이다 — 재작성이 이를 실제로 반영했는지 검증 단계에서 대조하라.\n\n` +
      (recentObjections.length > 0
        ? recentObjections.map(o => `- [${o.from_role} → ${o.to_role}]${o.resolved ? " (재작성으로 해소 주장)" : " (미해소)"} ${oneLine(o.detail).slice(0, 400)}`).join("\n") + `\n`
        : `(기록된 이의 없음)\n`)
    : "";
  return `# ${oneLine(state.goal).slice(0, 80)}

> **For agentic workers:** 이 문서는 전체 작업의 단일 출처(SoT)다. 작업 시작 전 NOTES.md 와 \`STATE.json\`(phase 별 \`next_steps\`) 을 반드시 읽고, 끝나면 갱신한다.

**Goal:** ${state.goal}

## 진입 경로

${entries}

## PR/Phase 단위 작업 순서

| Phase | 제목 | 산출물 | 검증 |
|-------|------|--------|------|
| 1 | (사람이 채우세요 — §개발 방향의 phase 제안 참고) | | |

## 핵심 결정 사항

> 표 형식 유지 — 하네스가 파싱해 무인 세션 프롬프트에 주입한다(설계 §28).
> 행을 지우지 않고 뒤집힌 결정은 \`superseded by D<n>\` 으로 표시한다.

${qa ? qa + "\n\n" : ""}${demoteHeadings(state.drafts.planning ?? "")}

## 개발 방향

${demoteHeadings(state.drafts.development ?? "")}

## 검증 기준

${demoteHeadings(state.drafts.evaluation ?? "")}
${objectionSection}
## 용어

| 용어 | 정의 | 쓰지 않는 말 |
|------|------|-------------|
${state.glossary.map(g => `| ${g.term} | ${g.definition} | ${g.avoid} |`).join("\n")}${state.glossary.length > 0 ? "\n" : ""}`;
}

// ---------------------------------------------------------------------------
// 역할 프롬프트 — 진입 경로에서 시작해 점진 확장, 전체 스캔 금지.
// ---------------------------------------------------------------------------

const ROLE_INTERVIEW_MISSION: Record<InterviewRole, string> = {
  planning: `당신은 **기획 고수**다. 이 목표를 기획서로 확정하기에 애매한 부분을 찾아 사용자에게 묻는 것이 임무다.
- 목표의 범위(무엇이 포함되고 무엇이 제외되는가), 사용자·이해관계자, 예외 상황, 우선순위 충돌을 파고들어라.
- 스스로 가정으로 메울 수 있어 보여도 **가정하지 말고 물어라** — 인터뷰에서 안 물은 것은 검증 단계에서 아무도 확인하지 않는다.
- 더 물을 것이 없으면 §핵심 결정 사항 표(| ID | 결정 | 근거 | 상태 | 날짜 |)를 초안으로 반환하라.
- 초안을 반환할 때는 **glossary 도 함께 반환하라**(핵심 용어 5~15개: term/definition/avoid) —
  PLAN §용어 표가 되어 무인 세션 전부에 주입된다. 목표·결정에 등장하는 개념 중 오독 여지가
  있는 것을 골라라(용어 통일은 기획의 산출물이다).`,
  development: `당신은 **개발 고수**다. 이 목표를 개발하기에 애매한 부분을 찾아 사용자에게 묻는 것이 임무다.
- 진입 경로가 지정됐으면 그 파일부터 읽고 import/호출 관계로 점진 확장하라. **전체 스캔 금지.**
- 진입 경로가 없거나 불충분하면 **첫 질문으로** "어느 경로부터 읽어야 하는가" 를 물어라 —
  진입 경로 확정이 당신 인터뷰의 산출물 중 하나다.
- 사용자의 답으로 경로가 정해지면 entry_paths 에 그 경로들을 담아 반환하라(질문과 함께여도 된다).
- 기존 구조와의 충돌, 호환성 요구(깨도 되는가), 의존성 추가 허용 여부, phase 분할을 파고들어라.
- 더 물을 것이 없으면 §개발 방향 초안(진입 경로·구조 방침·phase 분할 제안 포함)을 반환하라.`,
  evaluation: `당신은 **평가 고수**다. 이 목표의 완료를 무엇으로 판정할지 애매한 부분을 찾아 사용자에게 묻는 것이 임무다.
- 기획·개발 계획서 초안(아래에 있다)을 읽고 **"이렇게 평가하면 되는가"** 를 구체적 평가 방법으로 만들어 사용자에게 확인받아라.
- "잘 됐다" 를 **명령 하나의 exit code 로 확인할 수 있는 형태**로 만들 수 있는지 파고들어라 — 하네스의 게이트는 그것만 판정할 수 있다.
- 바뀌면 안 되는 것(동작·형식·성능)이 무엇인지, 그것을 못박는 테스트가 이미 있는지 물어라.
- "이 밖에 어떤 점을 더 확인받고 싶으세요?" — 사용자가 스스로 중요하다고 여기는 확인 항목을 끌어내라.
- 더 물을 것이 없으면 §검증 기준 초안(각 항목이 확인 가능한 형태)을 반환하라.`,
};

function renderQuestionHistory(state: InterviewState): string {
  const answered = state.questions.filter(q => q.answer !== null);
  if (answered.length === 0) return "(아직 없음)";
  return answered.map(q => `- [${q.id}/${INTERVIEW_ROLE_LABEL[q.role]}] Q: ${q.question}\n  A: ${q.answer}`).join("\n");
}

/** §47 — 다른 역할의 계획서 초안. 뒤 역할은 앞 역할의 초안을 보고 자기 계획을 세운다:
 *  개발 고수는 기획 초안을 보고 "이 기획이면 이렇게 개발하겠다" 를, 평가 고수는 기획·개발
 *  초안을 보고 "이렇게 평가하면 되는가" 를 쓴다. 역할 순서(INTERVIEW_ROLES)가 기획 → 개발 →
 *  평가로 고정된 이유가 이것이다. 재작성(이의 후) 시에는 뒤 역할의 초안도 이미 존재할 수
 *  있는데, 그것도 보여준다 — 재작성이 다른 초안과 정합하도록. */
function renderOtherDrafts(state: InterviewState, role: InterviewRole): string {
  const others = INTERVIEW_ROLES.filter(r => r !== role && state.drafts[r] !== null);
  if (others.length === 0) return "";
  const sections = others
    .map(r => `### ${INTERVIEW_ROLE_LABEL[r]} 계획서 초안\n${state.drafts[r]}`)
    .join("\n\n");
  return `\n## 다른 역할의 계획서 초안 (당신의 계획은 이것과 정합해야 한다 — 어긋나면 질문하거나 이의 라운드에서 걸어라)\n${sections}\n`;
}

function renderMyObjections(state: InterviewState, role: InterviewRole): string {
  const mine = state.objections.filter(o => o.to_role === role && o.resolved);
  if (mine.length === 0) return "";
  const items = mine.map(o => `- [${INTERVIEW_ROLE_LABEL[o.from_role]} 역할의 이의] ${o.detail}`).join("\n");
  return `\n## 당신의 이전 초안에 제기된 이의 (반드시 해소하거나, 해소할 수 없으면 질문으로 되돌려라)\n${items}\n`;
}

export function buildRoleInterviewPrompt(state: InterviewState, role: InterviewRole): string {
  const entries = state.entry_paths.length > 0 ? state.entry_paths.map(p => `- ${p}`).join("\n") : "(지정 안 됨)";
  return `${ROLE_INTERVIEW_MISSION[role]}

## 목표 (사용자가 직접 작성 — 고치지 마라)
${state.goal}

## 코드 진입 경로 (여기서 시작해 점진 확장 — 전체 스캔 금지)
${entries}

## 지금까지의 질문과 답 (전 역할 공유 — 이미 답된 것을 다시 묻지 마라)
${renderQuestionHistory(state)}
${renderOtherDrafts(state, role)}${renderMyObjections(state, role)}
## 출력 계약
구조화 출력으로 반환하라:
- 물을 것이 남았으면 questions 에 담아라 (question: 한 문장, why: 이 답이 어떤 결정을 좌우하는지).
  질문이 있으면 draft 는 null 로 두어라 — 답을 안 듣고 쓴 초안은 받지 않는다.
- 더 물을 것이 없으면 questions 를 비우고 draft 에 마크다운 초안을 담아라.
- 읽기 도구만 사용하고 아무것도 수정하지 마라.`;
}

export function buildObjectionPrompt(state: InterviewState, role: InterviewRole): string {
  const others = INTERVIEW_ROLES.filter(r => r !== role);
  const sections = others
    .map(r => `### ${INTERVIEW_ROLE_LABEL[r]} 초안 (to_role: "${r}")\n${state.drafts[r] ?? "(없음)"}`)
    .join("\n\n");
  // §53 — 라운드가 진행될수록 이의의 한계 효용이 급감한다(실측: 뒤 라운드는 표시 형식
  // 수준). 라운드 번호와 남은 기회를 알려 "치명적인 것 위주로, 사소한 것은 이의가 아니라
  // 대상 역할이 다음 재작성에서 참고할 수 있게 detail 에 명시" 를 유도하고, 직전 라운드에서
  // 재작성된 초안이 무엇인지 알려 불변 초안에 대한 재이의를 억제한다.
  const round = state.objection_rounds + 1;
  const lastRoundTargets = [...new Set(
    state.objections.filter(o => o.resolved).slice(-6).map(o => o.to_role as InterviewRole),
  )];
  const redrafted = lastRoundTargets.length > 0
    ? `\n직전 라운드 이의로 재작성된 초안: ${lastRoundTargets.map(r => INTERVIEW_ROLE_LABEL[r]).join(", ")} — 재작성되지 않은 초안에 대한 새 이의는 재작성분과의 정합성 문제만 허용된다(이미 통과한 내용의 재심 금지).`
    : "";
  const lastChance = round >= MAX_OBJECTION_ROUNDS
    ? `\n**이번이 마지막 이의 라운드다(${round}/${MAX_OBJECTION_ROUNDS}).** 여기서 안 걸린 이의는 사람 승인으로 넘어간다 — 치명적인 것(실행 불가·검증 불가·목표 불일치)만 걸어라. 표현·형식 수준의 지적은 이의가 아니라 개선 제안으로 detail 에 "(비차단)" 을 붙여 남겨라 — 비차단 제안만 있으면 objections 를 비워라.`
    : `\n(이의 라운드 ${round}/${MAX_OBJECTION_ROUNDS} — 상한 도달 시 남은 판단은 사람에게 넘어간다)`;
  return `당신은 **${INTERVIEW_ROLE_LABEL[role]} 고수**다. 아래 다른 두 역할의 초안을 읽고 **이의를 제기하는 것**이 임무다.
통과시키는 것이 목표가 아니다 — 당신의 관점에서 실행 불가능하거나, 검증 불가능하거나, 목표와 어긋나는 부분을 찾아라.${lastChance}${redrafted}

## 목표
${state.goal}

## 지금까지의 질문과 답
${renderQuestionHistory(state)}

${sections}

## 출력 계약
구조화 출력으로 반환하라:
- 이의가 있으면 objections 에 담아라 (to_role: 대상 역할, detail: 무엇이 왜 문제인지 한 단락).
- 억지 이의를 만들지 마라 — 실제로 실행·검증·목표 정합에 영향을 주는 것만. 없으면 빈 배열.
- 읽기 도구만 사용하고 아무것도 수정하지 마라.`;
}

// ---------------------------------------------------------------------------
// 드라이버 — 에이전트가 할 수 있는 단계(run_role/run_objections)만 자동 진행하고,
// 사람 차례(await_answers/ready/session_cap)에서 멈춘다. SDK 는 주입받는다(테스트 가능).
// ---------------------------------------------------------------------------

export interface InterviewRunnerLike {
  runRole(state: InterviewState, role: InterviewRole): Promise<{ output: RoleSessionOutput | null; costUsd?: number }>;
  /** 이의 세션의 출력에는 from_role 이 없다 — **하네스가 채운다.** 세션이 자기 역할을
   *  사칭해 다른 역할 명의로 이의를 남기는 것을 구조적으로 막는다(신뢰 경계). */
  runObjections(
    state: InterviewState,
    role: InterviewRole,
  ): Promise<{ objections: Array<{ to_role: InterviewRole; detail: string }> | null; costUsd?: number }>;
}

export async function advanceInterview(
  workflowDir: string,
  initial: InterviewState,
  runner: InterviewRunnerLike,
  now: () => string,
  log: (msg: string) => void,
): Promise<InterviewState> {
  let state = initial;
  for (;;) {
    const action = interviewNext(state);
    if (action.kind === "run_role") {
      log(`${INTERVIEW_ROLE_LABEL[action.role]} 역할 인터뷰 세션 실행 중...`);
      const r = await runner.runRole(state, action.role);
      state = applyRoleResult(state, action.role, r.output ?? { questions: [], draft: null }, now());
      state.cost_usd += r.costUsd ?? 0;
      saveInterview(workflowDir, state);
      continue;
    }
    if (action.kind === "run_objections") {
      log("상호 이의 라운드 실행 중 (역할당 1세션)...");
      const merged: Array<{ from_role: InterviewRole; to_role: InterviewRole; detail: string }> = [];
      let spent = 0;
      let cost = 0;
      for (const role of INTERVIEW_ROLES) {
        const r = await runner.runObjections(state, role);
        spent += 1;
        cost += r.costUsd ?? 0;
        for (const o of r.objections ?? []) merged.push({ from_role: role, to_role: o.to_role, detail: o.detail });
      }
      state = applyObjections(state, merged, now(), spent);
      state.cost_usd += cost;
      saveInterview(workflowDir, state);
      continue;
    }
    return state; // await_answers / ready / session_cap / approved — 사람 차례
  }
}

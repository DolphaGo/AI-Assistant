import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import type { SandboxSettings } from "@anthropic-ai/claude-agent-sdk";
import { lintVerifyCommands } from "./verifylint.js";
import { realpathOrClimb } from "./paths.js";

// §26 M3 / §29 Minor 1: workflow 는 `feature/<workflow>` 로 그대로 git 브랜치 이름이 된다
// (orchestrator.ts applyBranchStrategy). 원래는 영숫자·-·_·. 만 허용하는 화이트리스트였는데,
// 이게 git 보다 엄격해 한글 등 유니코드 workflow 이름을 거부했다(실측: 한국어 우선 프로젝트에서
// 과잉 제약. `git check-ref-format --branch '한글피처'` 는 통과하고 실제 checkout 도 성공한다).
// git 이 허용하는 범위에 맞추기 위해 화이트리스트 대신, git-check-ref-format(1) 이 실제로
// 거부하는 것만 금지하는 블랙리스트로 바꾼다 (실측으로 하나씩 확인):
//   - 공백/탭 등 whitespace, ASCII 제어문자(0x00-0x1F, 0x7F)
//   - 메타문자 ~ ^ : ? * [ \
//   - 연속된 ".." (git 이 range 표기로 해석)
//   - "@{" 리터럴 (git 의 reflog/upstream 표기와 충돌)
//   - 선행/후행 "." (git 이 명시적으로 거부)
//   - 후행 ".lock" (git 의 lockfile 관례와 충돌)
//   - 단독 "@" (git 에서 HEAD 의 별칭)
//   - 예약어 "HEAD" (git check-ref-format 이 명시적으로 거부 — `head`/`Head` 는 git 도 허용)
// 유니코드 문자(한글 포함)는 이 블랙리스트에 없다 — git 도 허용하므로 통과시킨다(실측 확인).
// fw 고유 제약으로 "/" 는 계속 금지한다: workflow 는 `feature/<workflow>` 브랜치의 단일 세그먼트이자
// `docs/<workflow>` 디렉토리명과 1:1 대응해야 하므로 계층 구분자를 허용하면 그 대응이 깨진다.
const WORKFLOW_NAME_FORBIDDEN_CHARS_RE = /[\s~^:?*[\\\x00-\x1f\x7f]/;

export function isValidWorkflowName(name: string): boolean {
  if (name.length === 0) return false;
  if (WORKFLOW_NAME_FORBIDDEN_CHARS_RE.test(name)) return false;
  if (name.includes("..")) return false;
  if (name.includes("@{")) return false;
  if (name.includes("/")) return false;
  if (name === "@") return false;
  if (name === "HEAD") return false;
  if (name.startsWith(".") || name.endsWith(".")) return false;
  if (name.endsWith(".lock")) return false;
  return true;
}

const WORKFLOW_NAME_ERROR =
  "workflow 이름은 git 브랜치 이름(feature/<workflow>)으로 안전해야 합니다 — 금지: 공백/제어문자, " +
  "메타문자 ~^:?*[\\, 연속 \"..\", \"@{\", 선행·후행 \".\", 후행 \".lock\", 단독 \"@\", 예약어 " +
  '"HEAD", "/" (유니코드 문자·한글은 git 도 허용하므로 사용할 수 있습니다)';

// ── §36 §30 P4 후속 — 하네스의 판정을 세션 기록에 영속한다 ──────────────────────────
//
// 세션의 자기 주장(위 `result`, 문자열 그 자체를 신뢰하지 않는다)과 하네스가 실제로 내린 판정은
// 다른 것이다. orchestrator.ts(phase 루프)/prloop.ts(fix 루프) 둘 다 세션이 "done" 을 주장해도
// 게이트·커밋 검증·브랜치 이탈 감시·위조 가드를 통과해야만 그 주장을 받아들인다(§2 D8) — 그런데
// 그 판정 자체(회송했다는 사실과 사유)는 지금까지 gitignore 된 실행 로그에만 남았다. 2회의 무인
// 주행(§35/§36)에서 phase 1 이 attempt 1·2 에서 실제로 회송됐는데 STATE 에는 세 세션 모두
// result:"done" 만 남아, 회송 여부/사유 재구성이 세션이 자발적으로 쓴 커밋 메시지에만 의존했다
// (§36 "두 번의 무인 주행 검증" 절 실측 — 기계 기록으로는 불가능했다는 뜻).
//
// outcome 은 네 가지:
//   - "accepted": 세션의 done 주장을 하네스가 검증을 거쳐 받아들였다 (phase.status="done" 으로
//     이어지거나 fix 세션이 handled 로 확정된다)
//   - "bounced": 세션이 done 을 주장했으나 하네스가 거부해 같은 phase 를 다음 attempt(또는 다음
//     fix 세션)로 돌려보냈다 — reason 필수. PLAN.md(docs/fw-report) §용어의 "회송" 정의 그대로:
//     세션 자신의 failed 와는 구분한다.
//   - "session_failed": 세션이 스스로 실패를 보고했다 (하네스가 검증할 done 주장 자체가 없다)
//   - "session_blocked": 세션이 질문을 반환해 사람의 답이 필요하다 (하네스가 검증할 done 주장
//     자체가 없다)
//
// reason 은 "bounced" 일 때만 채워진다 — 아래 값들은 orchestrator.ts/prloop.ts 의 실제 회송
// 분기(§30 P1 표, 이 라운드 실측으로 코드에서 직접 찾은 것)를 그대로 나열한 것이지 추측이 아니다:
//   - "gate_failed": 검증 명령(verify) 게이트가 실패했다(치명적 명령 오류 포함)
//   - "no_commits": 세션이 커밋을 하나도 만들지 않고 done 을 주장했다 (verifySessionCommits)
//   - "commit_verification_failed": 보고한 커밋이 headBefore 이후 신규가 아니거나(ancestry)
//     작업 브랜치에서 도달 불가능하다(verifySessionCommits)
//   - "branch_drift": 세션이 격리/토픽 브랜치를 이탈한 채 커밋했다 (checkBranchDrift)
//   - "verify_tampered": 검증 명령이 참조하는 파일(스크립트/빌드 설정)을 세션이 직접 수정했다
//     (verifyReferencedFiles 가드)
//   - "changed_files_untrustworthy": §tamper-gap P1/P2/P5 — changedFiles 가 git 실행에는
//     성공했지만 출력 구조를 신뢰할 수 없다고 판정했다(현재 유일한 트리거: U+FFFD 감지). 판정
//     강도(fail-closed, 진행 정지)는 verify_tampered 와 동일하지만, 사실 확인 전 공개 비난을
//     피하기 위해(prloop 의 PR 공개 코멘트 등) 별도 reason·중립 문구로 기록한다 — 실제 확인된
//     위조와 합류시키지 않는다.
//   - "already_applied_unverified": issue #3 — fix 세션이 "이미 반영되어 있어 추가 커밋이
//     불필요하다"(status:"already_applied")고 보고했으나, 근거로 댄 커밋 SHA 가 (a) 비어 있거나
//     (b) git 에 없거나 (c) PR 브랜치 이력에서 도달 불가능하거나 (d) base_branch 에 이미 있는
//     커밋(=이 PR 이 만든 변경이 아님)이라 하네스가 그 주장을 받아들이지 않았다
//     (verifyAlreadyAppliedCommits). "세션의 주장을 믿지 않는다"는 원칙을 SHA 실존·도달성
//     검증으로 유지하되, 정직한 no-op 보고가 no_commits 로 뭉개져 워크플로우 전체를 FAILED
//     로 떨어뜨리던 결함(실측: 겹치는 리뷰 코멘트, 커밋·push 후 중단 재개)을 분리한다.
//   - "comment_items_unreported": issue #4 — fix 세션이 done/already_applied 를 주장했으나 코멘트의
//     요구/지적을 항목별로 보고하는 addressed 가 비어 있다. 하네스는 항목 수를 셀 수 없지만(자연어)
//     "항목 추출 자체를 안 함"은 잡는다 — 실측: 두 문장짜리 코멘트의 첫 문장만 반영하고 done.
//
// 하위호환: 이 필드는 `.optional()` 이다 — 이 필드가 없는 기존 STATE.json(§36 이전에 완주한
// docs/harness-module-tests 등)은 그대로 로드된다. report.ts 가 verdict 유무로 "판정 기록
// 이전 버전" 을 구분해, 없는 데이터를 지어내지 않는다(PLAN D4 정신 유지).
export const SessionVerdictReasonEnum = z.enum([
  "gate_failed",
  "no_commits",
  "commit_verification_failed",
  "branch_drift",
  "verify_tampered",
  "changed_files_untrustworthy",
  "already_applied_unverified",
  "comment_items_unreported",
]);
export type SessionVerdictReason = z.infer<typeof SessionVerdictReasonEnum>;

export const SessionVerdictSchema = z
  .object({
    outcome: z.enum(["accepted", "bounced", "session_failed", "session_blocked"]),
    reason: SessionVerdictReasonEnum.optional(),
    // 사람이 읽는 사유 요약 — summary 와 동일한 계약(호출부가 길이를 잘라 넣는다, 스키마 자체는
    // 강제하지 않는다 — §29 Minor 2 의 findPlaceholderPath 처럼 스키마보다 먼저 방어하는 값들과
    // 같은 이유로 여기서는 단순 string 으로 둔다).
    detail: z.string().optional(),
  })
  .strict()
  // reason 은 "bounced" 일 때만, 그리고 항상 있어야 한다 — "bounced 인데 사유가 없다"/"accepted 인데
  // 사유가 붙어 있다" 둘 다 하네스 코드의 버그다. 이 불변식을 스키마에 못박아 두면 recordVerdict
  // 호출부의 실수(§30 P1 — 여러 호출부가 있으므로 한쪽만 어길 수 있다)를 saveState 시점에
  // 즉시 잡아낸다(조용히 저장돼 나중에야 발견되는 것보다 낫다).
  .refine(v => (v.outcome === "bounced" ? v.reason !== undefined : v.reason === undefined), {
    message: 'reason 은 outcome:"bounced" 일 때만, 그리고 반드시 있어야 합니다',
  });
export type SessionVerdict = z.infer<typeof SessionVerdictSchema>;

export const PhaseSchema = z
  .object({
    id: z.number().int().positive(),
    title: z.string(),
    status: z.enum(["pending", "in_progress", "in_review", "done", "failed", "blocked"]),
    depends_on: z.array(z.number().int()).default([]),
    verify: z.array(z.string()).default([]),
    // 이 phase 에서 세션이 수행할 상세 작업 단계 (구 인수인계 문서의 "다음에 할 일" 절 흡수). PLAN 작성 시 채운다.
    next_steps: z.array(z.string()).default([]),
    attempts: z.number().int().nonnegative().default(0),
    max_attempts: z.number().int().min(1).default(2),
    // orchestrator 가 마지막 검증 로그 경로를 기록한다 (재시도/디버깅 시 참조)
    last_log: z.string().optional(),
    // §24 감사 S1 옵트아웃: 이 phase 는 검증 명령이 참조하는 파일(빌드 설정/스크립트)을 이번 phase 에서
    // 의도적으로 고칠 수 있다(예: 빌드 설정 자체를 바꾸는 phase). 기본 false — 세션이 검증 대상 파일을
    // 수정하면 게이트 위조로 간주해 회송한다. true 로 두면 그 검사를 건너뛰되, "의도적 허용"과 "몰래
    // 위조"를 구분할 수 있도록 사용 시점을 verify_file_changes_bypassed_at 에 기록한다.
    allow_verify_file_changes: z.boolean().default(false),
    // §32 C-2 옵트아웃: 이 phase 는 리포 루트 CLAUDE.md 를 의도적으로 고칠 수 있다(예: 리포 관례
    // 정리 phase). 기본 false — CLAUDE.md 는 **모든 향후 세션의 프롬프트에 주입**되고 커밋되면
    // git 에 영속하므로, 무인 세션이 거기에 지시를 심으면 그 리포의 이후 모든 워크플로우가 그것을
    // 받는다(§32 C-2 실측). 그래서 STATE.json/PLAN.md 와 같은 등급으로 쓰기를 차단하되, 정당한
    // 작업이 막히지 않도록(§30 P2) phase 단위 탈출구를 둔다.
    //
    // allow_verify_file_changes 와 달리 "사용 시각" 기록이 아직 없다 — 그 필드는 orchestrator 가
    // 게이트 판정 시점에 쓰는데, CLAUDE.md 차단은 permissions.ts(canUseTool)에서 일어나고 그
    // 경로는 STATE 를 쓸 수 없다(하네스 단일 작성자 원칙). 후속: orchestrator 가 phase 시작 시
    // 이 플래그가 켜져 있으면 claude_md_changes_allowed_at 을 남기게 배선.
    allow_claude_md_changes: z.boolean().default(false),
    verify_file_changes_bypassed_at: z.string().optional(),
    // §24 감사 S1 보강: 위조 검사의 diff 기준점을 "이 phase 런(run)이 시작된 시점"에 한 번 고정해
    // attempt 마다 다시 잡지 않는다. attempt 마다 새로 캡처한 headBefore 를 기준으로 삼으면, 1차
    // 시도에서 검증 파일을 위조당해 회송된 뒤 그 커밋을 되돌리지 않고 방치한 채 2차 시도에서 무관한
    // 파일만 커밋해도(2차의 headBefore 는 이미 1차의 위조 커밋 이후이므로) diff 에 위조가 안 잡혀
    // 그대로 통과해버리는 "attempt 간 위조 세탁" 이 실측됐다. fw retry(재시도)로 이 phase 를 처음부터
    // 다시 시작할 때만 초기화한다(state.ts retryPhase 참조).
    verify_guard_baseline_sha: z.string().optional(),
    // ── pr-slicing: 조각 분해 (docs/pr-slicing PLAN D8/D9) ────────────────────
    // 조각은 새 개념이 아니라 phase 다 — 이 phases 배열에 phase 로 편입된다(D8). 아래 필드는
    // "이 phase 가 어느 원본의 몇 번째 조각인가" 를 기록할 뿐이고, 세션·게이트·PR·머지 대기·
    // 이탈 감시는 기존 phase 배관을 그대로 탄다.
    // 전부 optional 이다 — 기존 워크플로우의 STATE.json(신규 필드가 하나도 없다)이 파싱에
    // 실패하면 그 워크플로우들이 즉시 실행 불가가 된다.
    /** 이 phase 가 조각이면 그 위치. 마지막 조각은 원본 phase id 를 물려받으므로(D9) 그 조각도
     *  이 값을 갖는다(index === total). 없으면 분해되지 않은 원본 phase 다. */
    split_group: z
      .object({
        origin_id: z.number().int().positive(),
        index: z.number().int().positive(),
        total: z.number().int().positive(),
      })
      .strict()
      .optional(),
    /** 분해 세션이 제시한 "왜 이 경계가 하나의 리뷰 단위인가". 조각 PR 본문에 그대로 실린다. */
    split_rationale: z.string().optional(),
    /** 분해를 시도했지만 하지 않은 이유(1조각 반환·검증 거부·세션 실패). fail-open(D10) 으로
     *  원본 phase 를 그대로 실행하되, 조용히 넘어가지 않기 위해 이유를 남긴다. */
    decompose_skipped_reason: z.string().optional(),
    /** 이 phase 의 조각 순번(워크플로우 전체에서 1부터). 조각 브랜치 이름과 PR 제목에 쓴다 —
     *  내부 phase id 는 D9 때문에 실행 순서와 무관하므로 사람에게 보이는 곳에 쓰지 않는다(D5). */
    slice_seq: z.number().int().positive().optional(),
    // v2 PR 모드: 이 phase 가 만든 PR. PROGRESS.md 에 중복 기록하지 않는다(설계 §5)
    pr: z
      .object({
        number: z.number().int().positive(),
        url: z.string(),
        head_branch: z.string(),
        // 이미 fix 를 반영한 코멘트 — 재처리 방지. issue/review 코멘트 id 시퀀스가 별개이므로
        // "kind:id" 복합 키로 저장한다 (I1)
        handled_comment_keys: z.array(z.string()).default([]),
        // 이 PR 에 대해 실행한 fix 세션 횟수 — max_fix_sessions 와 비교해 상한을 건다 (C2-2)
        fix_sessions: z.number().int().nonnegative().default(0),
        // 하트비트(§25 과제3) — 폴링 구간이 완전 무음이라 하네스가 살아있는지 멈춘 건지
        // 구분이 안 됐다. 매 폴링(viewPr 성공)마다 갱신해 `fw status` 에서 확인할 수 있게 한다.
        last_polled_at: z.string().optional(),
        // issue #3 제안 2 — fix 세션을 띄우기 "직전"에 그 코멘트 키를 기록하고, handled 로 확정될
        // 때 지운다. 세션이 커밋·push 를 마쳤지만 handled 기록 전에 fw run 이 죽으면(Ctrl-C/kill)
        // 재개 시 여기 남은 키를 보고 "직전 실행이 이 코멘트를 처리하던 중 중단됐다 — PR 브랜치
        // 이력에 이미 반영됐는지 먼저 확인하라"는 힌트를 fix 프롬프트에 붙인다(prloop.ts).
        // handled 와 달리 "진실"이 아니라 힌트다 — 재개 시 세션이 already_applied 로 답하면
        // 하네스가 SHA 를 검증해 확정하고, 아니면 평소처럼 반영한다. 기존 STATE/테스트 픽스처와의
        // 호환을 위해 optional 로 둔다(없음 == 빈 배열) — 소비처(prloop.ts)가 `?? []` 로 읽는다.
        in_flight_comment_keys: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    sessions: z
      .array(
        z
          .object({
            session_id: z.string(),
            result: z.string(),
            summary: z.string().optional(),
            at: z.string(),
            // 이 세션이 어느 경로에서 실행됐는지 (§25 과제3) — 기본 phase 세션과 PR fix 세션을
            // 구분해야 밤새 PR 왕복이 몇 번 돌았는지 STATE 만으로 재구성할 수 있다.
            // §47 — "consensus" 신설: 3역할 검증 보고서를 종합하는 합의 세션. 기존 STATE 파싱에
            // 영향 없음(새 값은 새 기록에만 나타난다). report.ts 의 SESSION_KINDS 와 함께 바꿔야
            // 한다 — 한쪽만 바꾸면 비용 집계가 이 세션을 조용히 빠뜨린다(§41 I-2 와 같은 거짓 0).
            // pr-slicing — "decompose" 신설: phase 를 조각으로 나누는 읽기 전용 세션. 아래
            // report.ts 의 SESSION_KINDS 와 **반드시 함께** 바꾼다.
            kind: z.enum(["phase", "fix", "verify", "consensus", "decompose"]).default("phase"),
            // 세션 비용(USD) — 4개 SDK 결과 경로(mapPhaseResult)에서 수집되는데 스키마에 자리가
            // 없어 그동안 어디에도 기록되지 않았다 (§25 과제3).
            cost_usd: z.number().optional(),
            // pr-slicing — 세션이 제안한 "읽는 순서"(session.ts PhaseSessionResult.reviewOrder
            // 미러). PR 본문 조립 시점(prloop.ts)에는 세션 객체가 아니라 STATE 의 이 기록만
            // 남아 있으므로 여기에 보존해야 한다. 선택 필드(기존 STATE 호환).
            review_order: z.array(z.string()).optional(),
            // §36 §30 P4 후속 — 하네스가 이 세션에 대해 실제로 내린 판정(위 SessionVerdictSchema
            // 참조). `.optional()` — 이 필드가 없으면 이 세션 기록은 판정 기록 이전 버전이다.
            verdict: SessionVerdictSchema.optional(),
            // §43 — 이 세션이 발견했지만 **이번 목표의 범위가 아닌** 것들. 세션 단위로 두는
            // 이유는 출처(어느 phase 의 몇 번째 시도가 발견했는가)가 보존되기 때문이다.
            // 집계는 report.ts 가 전 phase 의 sessions 를 순회해서 한다(§41 I-1 과 같은 이유).
            // PLAN(사람 소유)이 아니라 STATE(하네스 소유)에 쌓는다 — 주행 중 PLAN 이 바뀌면
            // AI 가 스스로 성공 조건을 재정의할 수 있어 게이트가 무의미해진다.
            // issue #4 — fix 세션의 코멘트 항목별 처리 결과(session.ts AddressedItem 미러). 감사
            // 추적용: PR 답글에도 실리지만 STATE 가 하네스 소유의 원본이다. 선택 필드(기존 STATE 호환).
            addressed: z
              .array(
                z
                  .object({
                    item: z.string(),
                    status: z.enum(["applied", "already_applied", "declined", "not_applicable"]),
                    evidence: z.string(),
                  })
                  .strict(),
              )
              .optional(),
            findings: z
              .array(
                z
                  .object({
                    kind: z.enum(["bug", "learned", "needed", "plan_change"]),
                    detail: z.string(),
                  })
                  .strict(),
              )
              .optional(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

// ── §37 T1 — SDK 네이티브 샌드박스 STATE 스키마 ──────────────────────────────────────
//
// §36 C-1 이 실증한 것: `decideBash` 는 **Bash 문자열**을 보는데 `npm run <script>` 는 **파일
// 안의 셸 문자열**을 실행한다 — 검사 지점과 실행 지점이 다르다(`.GIT/hooks/pre-commit`, §32 C-1도
// 같은 축). canUseTool 기반 권한 검사는 이 축을 원리적으로 못 막는다. `@anthropic-ai/claude-agent-sdk`
// 의 `Options.sandbox?: SandboxSettings`(node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts)는
// 실행을 **커널에서** 막으므로 이 축 전체를 덮는다(§37 설계 결정 표).
//
// 아래 스키마는 SDK 의 SandboxSettings 전체가 아니라 §34 T1 이 원한 3가지(네트워크 allowlist·
// repo 밖 읽기 차단·커널 수준 쓰기 차단)와 §37 S4(자격증명 mask)에 필요한 부분집합만 미러링한다
// — envVars/awsPairs/sigv4/ignoreViolations/ripgrep 등 이 하네스가 아직 쓰지 않는 필드는 옮기지
// 않는다. 쓰지 않는 필드까지 스키마에 얹으면 SDK 가 그 스키마를 바꿀 때마다 미사용 필드까지
// 동기화해야 하고, STATE.json 작성자에게 검증되지 않은 옵션까지 "지원됨"으로 오인시킬 위험이
// 있다(§30 P3 "모르면 거부"의 변주 — 여기서는 "안 쓰는 건 노출하지 않는다"로 적용한다).
const SandboxCredentialFileSchema = z
  .object({
    path: z.string(),
    mode: z.enum(["deny", "mask"]),
    extract: z.string().optional(),
    onExtractNoMatch: z.enum(["deny", "error", "warn"]).optional(),
    decode: z.enum(["jwt"]).optional(),
    maskClaims: z.array(z.string()).optional(),
    maskDuplicates: z.boolean().optional(),
    injectHosts: z.array(z.string()).optional(),
  })
  .strict();

const SandboxNetworkConfigSchema = z
  .object({
    allowedDomains: z.array(z.string()).optional(),
    deniedDomains: z.array(z.string()).optional(),
    strictAllowlist: z.boolean().optional(),
    allowManagedDomainsOnly: z.boolean().optional(),
    allowUnixSockets: z.array(z.string()).optional(),
    allowAllUnixSockets: z.boolean().optional(),
    allowLocalBinding: z.boolean().optional(),
    allowMachLookup: z.array(z.string()).optional(),
    httpProxyPort: z.number().int().optional(),
    socksProxyPort: z.number().int().optional(),
    tlsTerminate: z
      .object({ caCertPath: z.string().optional(), caKeyPath: z.string().optional() })
      .strict()
      .optional(),
  })
  .strict();

const SandboxFilesystemConfigSchema = z
  .object({
    allowRead: z.array(z.string()).optional(),
    denyRead: z.array(z.string()).optional(),
    allowWrite: z.array(z.string()).optional(),
    denyWrite: z.array(z.string()).optional(),
    allowManagedReadPathsOnly: z.boolean().optional(),
    disabled: z.boolean().optional(),
  })
  .strict();

const SandboxCredentialsConfigSchema = z
  .object({
    files: z.array(SandboxCredentialFileSchema).optional(),
  })
  .strict();

// §37 S1/S2 설계 결정(specs/2026-08-26-feature-workflow-harness-design.md §37):
//   - enabled 기본 false(옵트인) — §30 P2 가 이 세션 최대 결함원이었고, 샌드박스가 정상 작업
//     (빌드 캐시 접근 등)을 막는지에 대한 실측 데이터가 아직 0 이다. 실전 주행으로 검증하기
//     전까지는 기존 동작(비샌드박스)을 유지한다.
//   - failIfUnavailable 필드는 **받아는 두되 강제로 덮어쓴다** — resolveSandboxSettings(아래)가
//     사용자가 무엇을 넣든 항상 true 로 고정한다. 스키마 자체에서 이 필드를 거부(strict 파서가
//     "알 수 없는 키" 에러)하면 정당한 시도(문서를 보고 명시적으로 false 를 써본 사용자)까지
//     STATE 로드 자체를 깨뜨린다(§30 P2) — 그래서 "받아주되 소비 시점에 무시한다"를 택한다.
//   - §41 C-1/C-2 후속: autoAllowBashIfSandboxed/allowUnsandboxedCommands 도 같은 계약이다 —
//     스키마는 계속 받아주지만 resolveSandboxSettings 가 소비 시점에 항상 false 로 강제한다
//     (자세한 실측 근거는 resolveSandboxSettings 위 주석 참조).
export const SandboxConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    failIfUnavailable: z.boolean().optional(),
    autoAllowBashIfSandboxed: z.boolean().optional(),
    allowUnsandboxedCommands: z.boolean().optional(),
    network: SandboxNetworkConfigSchema.optional(),
    filesystem: SandboxFilesystemConfigSchema.optional(),
    credentials: SandboxCredentialsConfigSchema.optional(),
  })
  .strict();

export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;

export const StateSchema = z
  .object({
    schema_version: z.literal(1),
    workflow: z.string().refine(isValidWorkflowName, { message: WORKFLOW_NAME_ERROR }),
    repo_root: z.string(),
    // 하네스가 어느 브랜치에서 작업할지 결정한다. 죽은 필드였던 것을 실제 판정에 쓴다(§19 —
    // 이전에는 스키마·템플릿·설계에만 존재하고 src/ 어디서도 읽지 않아, main 에서 fw run 을
    // 돌리면 세션이 그대로 main 에 커밋을 쌓았다).
    //  - "isolate": 현재 브랜치가 base_branch 와 같으면 feature/<workflow> 브랜치를 만들어 체크아웃
    //    (기본, 권장)
    //  - "current": 현재 체크아웃된 브랜치에서 그대로 작업 (사용자가 이미 토픽 브랜치를 만든 경우)
    //  - "require-topic": base_branch 에 있으면 거부하고 사용자가 직접 브랜치를 만들게 한다
    // 하위호환: 기존 STATE.json 들이 "topic" 을 쓰고 있었다(템플릿·스모크 산출물). enum 을
    // 좁히면서 그 파일들의 로드를 깨뜨리지 않도록 "topic" 을 "isolate" 의 별칭으로 매핑한다.
    branch_strategy: z.preprocess(
      v => (v === "topic" ? "isolate" : v),
      z.enum(["isolate", "current", "require-topic"]),
    ).default("isolate"),
    allow_push: z.boolean().default(false),
    // §32 남은 부채(§30 P3): docs/<workflow>/logs/ 에는 §27 O1 감사 로그(DENY 명령 전문)가
    // 쌓이고, §32 I-1 이 마스킹을 자격증명 기반으로 재설계한 뒤에도 **의도적으로** 마스킹하지
    // 않는 값이 있다(인용 없는 40자 소문자 hex 는 git SHA 와 구별 불가 — I-1 주석 참조, 실측
    // 33% 잔여 누출). 정규식으로 완벽한 마스킹을 겨루는 대신(§30 P3: "문법을 흉내내려다
    // 진다"), 그 로그가 대상 리포에 커밋될 수 없게 만드는 것이 확실한 방어다
    // (checkRunLogsIgnored, 이 파일 하단 참조). 미설정 시 false 와 동일하게 취급(=검사를
    // 통과해야 실행, 소비처에서 `?? false`)하되, 대상 리포에 아직 `docs/*/logs/` .gitignore
    // 항목이 없는 것은 흔한 "첫 실행" 상태일 수 있다(§26 C1/§29 MI-10 이 같은 모양의 자충수를
    // 이미 두 번 냈다 — "정상 첫 사용을 막는 방어"). allow_verify_file_changes/
    // allow_claude_md_changes 와 같은 패턴으로, 위험을 알고도 계속하려는 사용자에게 STATE 로
    // 명시적 옵트아웃을 준다("실수로 방치"와 "의도적 수용"을 STATE 만 보고 구분하기 위함,
    // §30 P2 체크리스트 3번째 항목). `.default()` 가 아니라 `.optional()` 인 이유는
    // pr_comment_mode/verify_timeout_ms 와 동일하다 — cli.ts 의 `initState` skeleton(State
    // 타입 리터럴)이 이 필드를 명시하지 않아도 계속 컴파일되게 하기 위해서다(`.default()` 는
    // z.infer 출력 타입에서 그 프로퍼티를 필수로 만들어 그 리터럴을 깨뜨린다).
    allow_untracked_logs: z.boolean().optional(),
    // §37 T1/S3 — SDK 네이티브 샌드박스 설정. 워크플로우마다 필요한 접근이 다르므로(모노레포·
    // 도커·사내 레지스트리) STATE 에 둔다. `.optional()`(`.default()` 아님)인 이유는 다른
    // optional 필드들과 동일하다 — cli.ts 의 `initState` skeleton(State 타입 리터럴)이 이
    // 필드를 명시하지 않아도 계속 컴파일되게 하기 위해서다. 미설정 시 undefined 로 로드되고
    // resolveSandboxSettings(아래)가 "비활성"과 동일하게 취급한다(§37 S1 — 기본 옵트인 아님).
    sandbox: SandboxConfigSchema.optional(),
    verify_default: z.array(z.string()).default([]),
    // 검증 명령당 타임아웃(ms). null/미지정 시 gate 의 기본값(30분). 대형 빌드는 상향할 것
    verify_timeout_ms: z.number().int().positive().nullish(),
    // v2 PR 모드 노브. false/미지정이면 v1 과 동일하게 동작한다(하위호환)
    pr_mode: z.boolean().default(false),
    poll_interval_ms: z.number().int().positive().default(60_000),
    base_branch: z.string().default("main"),
    // ── pr-slicing: 통합 브랜치 토폴로지 (docs/pr-slicing PLAN D1/D2) ──────────
    // 조각 PR 은 base_branch 가 아니라 **통합 브랜치**로 머지된다. base_branch 는 워크플로우
    // 끝의 통합 PR(통합 브랜치 → base_branch, D6) 에만 쓰인다.
    /** 조각 PR 이 머지되어 쌓이는 브랜치. applyBranchStrategy 가 확정해 기록한다. 미설정이면
     *  아직 확정되지 않았거나 조각 분해를 쓰지 않는 워크플로우다. */
    integration_branch: z.string().optional(),
    /** 조각 분해 노브. 미설정/`enabled:false` 면 기존 동작과 **완전히 동일**하다(PLAN §검증
     *  기준 2 — 하위호환). `budget_lines` 는 강제 상한이 아니라 분해 세션에 주는 목표치다(D13). */
    review_split: z
      .object({ enabled: z.boolean(), budget_lines: z.number().int().positive() })
      .strict()
      .optional(),
    /** pr-slicing D6 — 통합 브랜치 → base 브랜치 PR. 워크플로우당 하나만 만든다(이 필드가
     *  있으면 재생성하지 않는다). 조각 PR 은 phase.pr 에 있고 이건 마지막 관문이다. */
    integration_pr: z
      .object({
        number: z.number().int().positive(),
        url: z.string(),
        head_branch: z.string(),
        last_polled_at: z.string().optional(),
      })
      .strict()
      .optional(),
    /** 다음에 부여할 조각 순번(1부터). phase 배열을 훑어 재계산하지 않고 저장한다 — 재계산
     *  방식은 `fw retry` 로 조각을 다시 도는 경로에서 이미 쓴 순번을 재사용해 브랜치 이름이
     *  충돌한다. */
    next_slice_seq: z.number().int().positive().optional(),
    // PR 당 fix 세션 상한. 초과 시 FAILED 정지(Task 5 소관) — 무기한 폴링과
    // 상한 없는 유료 fix 세션이 공존하지 않도록 하는 구조적 방어선 (C2-2)
    max_fix_sessions: z.number().int().positive().default(10),
    // §27 O2: 누적 세션 비용(USD) 상한 — totalCostUsd(state) 가 이 값에 도달하면 "halted" 로
    // 정지한다. verify_timeout_ms 와 동일한 계약으로 nullish(미설정 시 무제한 — 기존 동작과 동일,
    // §30 P2 정상 경로 회귀 방지)로 둔다. `.default()` 를 쓰지 않는 이유도 verify_timeout_ms 와
    // 같다 — cli.ts initState 의 State 리터럴 스켈레톤이 이 필드를 명시하지 않아도 컴파일되게
    // 하기 위해서다.
    max_cost_usd: z.number().positive().nullish(),
    // §47 — 합의 세션이 제안한 다음 사이클 목표 후보. 하네스는 제안만 기록한다 — 다음
    // 사이클을 열지(fw interview --goal), 무엇을 고를지는 사람이 결정한다(되먹임의 연결 고리).
    next_goal_suggestions: z.array(z.string()).optional(),
    // §27 O2: 이 `fw run` 실행의 벽시계 시간 상한(ms) — orchestrator 가 runWorkflow 진입 시각
    // (deps.now() 로 기록, Date.now() 직접 호출 금지 — 테스트 결정론성)과 매 체크포인트에서
    // 비교한다. nullish 미설정 시 무제한(기존 동작 그대로).
    max_runtime_ms: z.number().int().positive().nullish(),
    // §24 감사 T1: PR 코멘트의 `@fw`/`/fw fix` 마커는 "나에게 한 말인가" 만 정하고 "말할 자격이
    // 있는가" 는 정하지 않는다 — 사내 GHE 에서 리포 읽기 권한자 누구나 트리거를 걸 수 있었다.
    // 이 목록에 있는 로그인(대소문자 무시)만 트리거 자격이 있다. 기본 빈 배열 — 명시적으로 채우기
    // 전까지는 아무도 신뢰하지 않는다(fail-closed). pr_mode 를 쓰려면 반드시 채워야 한다.
    // §26 I6: trim 없이 저장하면 "alice " 같은 오타가 절대 매칭되지 않아 조용히 fail-closed 로
    // 굳는다(트리거가 아무 것도 반영되지 않는데 원인이 안 보임, 실측). trim 후 빈 문자열이 되면
    // (공백만 있던 항목) 걸러낸다 — 트리거 판정 쪽에서 빈 로그인과 우연히 매칭될 여지를 없앤다.
    trusted_comment_authors: z
      .array(z.string())
      .default([])
      .transform(arr => arr.map(a => a.trim()).filter(a => a.length > 0)),
    // §29 MI-10: I6(D14)이 fail-closed 로 "pr_mode:true + trusted_comment_authors:[]" 를
    // 시작 거부로 막은 것 자체는 유효하다 — 하지만 "PR 만 만들고 코멘트 처리는 원치 않는다"는
    // 정당한 사용에 탈출구가 없어서, 리포에 이미 커밋돼 있던 워크플로우(docs/pr-smoke)가
    // 실행도 doctor 진단도 안 되는 상태로 굳었다(실측). 이 노브로 "실수로 빈 채 방치"(trusted +
    // 빈 배열 → 여전히 거부, D14 유지)와 "의도적으로 코멘트 처리를 안 씀"(off → 통과)을
    // STATE 만 보고 구분한다.
    //   - "trusted"(기본): 기존 동작 — trusted_comment_authors 가 비면 assertRunnable 이 거부
    //   - "off": 코멘트를 폴링/처리하지 않는다 — trusted_comment_authors 가 비어도 통과
    // .optional() (default 아님): 이 필드가 없는 기존 STATE.json 은 undefined 로 로드되고
    // "trusted" 와 동일하게 취급한다(assertRunnable 등 소비처에서 `?? "trusted"`) — cli.ts 의
    // `initState` skeleton 객체(State 타입 리터럴)가 이 필드를 명시하지 않아도 계속 컴파일되게
    // 하기 위해 `.default()` 대신 `.optional()` 을 쓴다(default 는 z.infer 출력 타입에서 필수
    // 프로퍼티가 되어 그 리터럴을 깨뜨린다). 후속: orchestrator.ts 가 이 값을 읽어 pr_comment_mode
    // === "off" 면 코멘트 폴링/fix 세션을 건너뛰도록 배선해야 한다(아직 미배선 — 스키마만 준비).
    pr_comment_mode: z.enum(["trusted", "off"]).optional(),
    // §27 O2/O3: "halted" 신설 — 운영자(`fw stop`)나 상한(max_cost_usd/max_runtime_ms) 이 다음
    // 체크포인트에서 멈춘 상태. **blocked 와 다르다** — blocked 는 "사람의 답변이 필요"
    // (pending_question 이 채워짐), halted 는 "그냥 이어서 돌리면 됨"(§2 D 표, §27). 이 구분을
    // 지키기 위해 runWorkflow 의 시작 가드(`state.status === "blocked"` 조기 반환)와
    // assertRunnable 양쪽 다 halted 를 거부하지 않는다 — halted 는 재개 가능해야 한다.
    status: z.enum(["running", "blocked", "awaiting_merge", "failed", "done", "halted"]),
    // §27 O2/O3: halted 사유(예: "비용 상한 초과: $12.40 / $10.00", "operator"). 기존 STATE.json
    // 에는 이 필드가 없으므로 `.default(null)` 로 하위호환 — 미설정 필드가 있는 옛 파일도 그대로
    // 로드되고, 새로 halted 로 전이될 때만 값이 채워진다. 타입은 `string | null` (undefined 아님 —
    // §27 설계에 명시된 계약).
    halt_reason: z.string().nullable().default(null),
    pending_question: z
      .object({ phase: z.number().int(), question: z.string(), asked_at: z.string() })
      .strict()
      .nullable(),
    answers: z
      .array(
        z
          .object({
            question: z.string(),
            answer: z.string(),
            at: z.string(),
            phase: z.number().int().optional(),
          })
          .strict(),
      )
      .default([]),
    phases: z.array(PhaseSchema),
  })
  .strict();

export type State = z.infer<typeof StateSchema>;
export type Phase = z.infer<typeof PhaseSchema>;
export type BranchStrategy = State["branch_strategy"];

export function statePath(workflowDir: string): string {
  return path.join(workflowDir, "STATE.json");
}

// §36 §30 P4/P1 후속 — 하네스가 세션에 대해 내린 판정을 phase.sessions 의 해당 원소에 남기는
// 유일한 지점. orchestrator.ts(phase 루프)와 prloop.ts(fix 루프) 둘 다 이 함수 하나만 호출한다 —
// §30 P1("방어를 한 경로에만 세운다")이 여섯 번 재발한 교훈 그대로, 복붙하면 다음 라운드에
// 갈린다. sessionIndex 를 생략하면 방금 push 한 마지막 세션(가장 흔한 경우 — phase 루프는
// attempt 당 세션이 하나뿐이다)을 가리킨다. prloop.ts 의 fix 배치(여러 코멘트를 한 게이트로 묶어
// 판정하는 flushPending)처럼 나중에 확정되는 여러 세션에 소급 적용해야 할 때만 인덱스를 명시한다.
// 대상 인덱스가 없으면(호출 순서 오류) 조용히 무시하지 않고 throw 한다 — 판정이 어디에도 안
// 붙는 채로 사라지는 것보다 즉시 드러나는 편이 낫다.
export function recordVerdict(phase: Phase, verdict: SessionVerdict, sessionIndex?: number): void {
  const idx = sessionIndex ?? phase.sessions.length - 1;
  const target = phase.sessions[idx];
  if (!target) {
    throw new Error(`recordVerdict: phase.sessions[${idx}] 가 없습니다 (session push 이후에 호출하세요)`);
  }
  target.verdict = verdict;
}

// 세션 비용(USD) 집계 — cli.ts(`fw status`)와 runlog.ts(`fw log`) 양쪽이 같은 공식을
// 쓰도록 여기 한 곳에만 둔다(§20 — 관측 확장 시 계산식이 두 곳에서 따로 놀지 않게).
export function phaseCostUsd(phase: Phase): number {
  return phase.sessions.reduce((sum, sess) => sum + (sess.cost_usd ?? 0), 0);
}

// 워크플로우 전체 비용(USD) — 모든 phase 의 sessions(phase/fix/verify 모두 포함) 비용 합산.
// 밤새 유료 세션이 몇 번 돌든 STATE 만 보고 총 지출을 알 수 있어야 한다 (§25 과제3).
export function totalCostUsd(state: State): number {
  return state.phases.reduce((sum, p) => sum + phaseCostUsd(p), 0);
}

// §27 O2: cli.ts(fw status)와 runlog.ts(fw log) 양쪽이 "상한이 설정돼 있으면 상한 대비로
// 보여라"는 같은 표시 규칙을 쓰도록 여기 한 곳에 둔다(totalCostUsd 와 같은 이유 — §20). 미설정
// (nullish)이면 기존 "$X" 형식 그대로 — §30 P2 정상 경로 회귀 방지.
export function formatCostLine(cost: number, maxCostUsd: number | null | undefined): string {
  return maxCostUsd != null
    ? `총 비용: $${cost.toFixed(2)} / $${maxCostUsd.toFixed(2)}`
    : `총 비용: $${cost.toFixed(2)}`;
}

// §37 sandbox-trial 막힘 1 후속 — 3차 무인 주행이 `sandbox.enabled:true` 만 켠 채(network 설정
// 없이) 돌아 `git maintenance run --task=prefetch` 가 origin(`ghe.example.com:443`)으로 나가는
// 아웃바운드 연결을 조용히(정상 작업은 막지 않고) 거부당한 것을 재현 가능하게 관측했다
// (docs/sandbox-trial/NOTES.md "막힘 1"). 그 관측이 준 근거: **하네스는 어차피 이 호스트로
// push/PR 을 한다**(§2 D13) — origin 호스트는 세션이 정당하게 쓰는 통로이지 새로 여는 구멍이
// 아니다. 그래서 origin 호스트를 network.allowedDomains 자동 포함 후보로 삼는다.
//
// 다만 §29 CR-1 이 실증한 긴장은 여전히 유효하다 — 자격증명이 섞인 값을 그 호스트로 유출하는
// 요청도 "정당한 호스트로의 요청"과 구분되지 않는다(`gh api ... -f body=@~/.aws/credentials`).
// 이 함수는 그 유출 경로 자체를 막지 않는다(그건 canUseTool/credentials.files 소관) — 여기서
// 판단하는 것은 오직 "이 호스트로의 네트워크 연결 자체를 허용할 것인가" 이고, 답은 "허용한다,
// 단 사용자가 이미 allowedDomains 를 명시했다면 그 목록을 존중하고 덧붙이지 않는다" 이다.
// 근거: allowedDomains 를 명시했다는 것 자체가 "정확히 이 목록만" 이라는 의도적 선택이다(특히
// network.strictAllowlist:true 와 함께 쓰이면 더욱 그렇다 — SDK 의 관리형 기본 도메인마저 끄고
// 정확한 화이트리스트만 남기겠다는 뜻이므로, 하네스가 항목을 몰래 추가하면 그 의도를 깨뜨린다).
// allowedDomains 자체를 아예 안 적었다면(네트워크 절 전체 생략 포함) 사용자가 아직 그 목록에
// 대해 어떤 의도도 표현하지 않은 것이므로, 이 하네스가 실측으로 확인한 "확실히 필요한 최소
// 하나"를 채워 넣는 것은 사용자 의도를 거스르지 않는다(§30 P2 — 방어를 처음부터 정상 경로가
// 막히지 않게 설계).
// §41 I-3 — 위 문단이 스스로 적어놓은 근거("strictAllowlist:true 와 함께 쓰이면 더욱 그렇다")를
// 코드가 지키지 않았다(실측: strictAllowlist:true 인데도 자동 추가됨). allowedDomains 를 아직
// 안 적었더라도 strictAllowlist:true 는 그 자체로 "정확한 화이트리스트만 남기겠다"는 의도
// 표현이므로, allowedDomains 를 나중에(또는 지금) 채우는 것은 반드시 사용자 자신이어야 한다 —
// 이 조건이 없으면 "정확히 이 목록만"이라는 strictAllowlist 의 계약을 하네스가 몰래 깬다.
function shouldAutoAddOriginHost(
  cfg: SandboxConfig,
  originHost: string | null | undefined,
): originHost is string {
  return !!originHost && cfg.network?.allowedDomains === undefined && cfg.network?.strictAllowlist !== true;
}

// §37 T1 — STATE.sandbox 를 SDK Options.sandbox(SandboxSettings)로 변환하는 유일한 지점.
// permissions.ts 의 policyFor(PermissionPolicy.sandbox 를 채우는 곳)와 cli.ts(`fw status`)/
// doctor.ts(`fw doctor`, 켜짐 표시)가 전부 이 함수 하나를 통해서만 "샌드박스가 켜졌는가"를
// 판정한다(§30 P1 — 판정 기준이 여러 곳에서 따로 계산되면 다음 라운드에 갈린다).
//
//   - §37 S1: state.sandbox 가 없거나 enabled 가 false 면 undefined 를 반환한다 — 호출자가
//     Options.sandbox 자리에 그대로 대입해도 필드 자체가 없는 것과 동일하다(기존 비샌드박스
//     동작과 완전히 같다, §30 P2 회귀 방지의 핵심).
//   - §37 S2: enabled 가 true 면 failIfUnavailable 을 **항상 true 로 강제**한다 — state.sandbox
//     에 사용자가 무엇을 넣었든(심지어 명시적으로 false 를 넣었어도) 무시한다. 샌드박스가
//     없는데 있다고 믿고 도는 것이 최악이기 때문이다(§30 P3 fail-closed).
//   - §41 C-1/C-2(적대적 감사, 2026-08-28): 같은 계약을 autoAllowBashIfSandboxed/
//     allowUnsandboxedCommands 에도 적용한다 — **항상 false 로 강제**하고 state.sandbox 값은
//     완전히 무시한다. 실측 근거:
//     * C-1 — SDK `sandbox.autoAllowBashIfSandboxed` 기본값이 **true** 다(node_modules/
//       @anthropic-ai/claude-agent-sdk/sdk.d.ts:7264, "…is independent and still defaults to
//       true, so set it to false to keep prompting for sandboxed commands"). 이 필드가
//       미설정이면 SDK 가 그 기본값(true)을 쓰므로, 샌드박스가 켜진 세션의 Bash 호출은
//       canUseTool 을 거치지 않고 자동 승인됐다 — 세 번째 무인 주행 런로그가 이를 실증한다
//       (샌드박스 ON 런의 ALLOW 요약이 `Bash×0`인데도 그 세션은 `git commit`/`npx vitest run`/
//       `git stash` 를 확실히 실행했다). 그 결과 checkPushSafety(§24 S2)·GH_DENY_PREFIXES
//       (§24 — gh pr merge 차단)·gh api 엔드포인트 좁히기·rm -rf 차단·isDestructiveGit·
//       hasShellExpansion(§29 CR-1)·§27 O1 감사 로그 전체가 무효화된다. §37 은 샌드박스를
//       권한 게이트 위에 "덧붙이는 층"으로 설계했지만 이 기본값 때문에 실제로는 "대체하는
//       층"이 되어 있었다.
//     * C-2 — SDK `sandbox.allowUnsandboxedCommands` 기본값도 **true** 다(sdk.d.ts:7202).
//       이 필드가 켜져 있으면(또는 미설정으로 기본값을 쓰면) Bash 도구 입력의
//       `dangerouslyDisableSandbox:true`(sdk-tools.d.ts:737)가 그 한 번의 명령을 샌드박스
//       밖에서 실행시킨다 — 세션이 매 명령마다 스스로 샌드박스를 끌 수 있는 길이다. false 로
//       고정해 이 SDK 옵트아웃 경로 자체를 원천 차단한다(플래그 자체는 permissions.ts 의
//       toCanUseTool 이 updatedInput 에서 추가로 제거한다 — 이중 방어).
//     스키마(SandboxConfigSchema)는 이 두 필드를 계속 받아준다(§30 P2 — strict 파서가 정당한
//     시도를 거부하면 STATE 로드 자체가 깨진다) — 다만 이 소비 시점에서 그 값을 항상 덮어쓴다.
//
// originHost 는 **이 함수가 git 을 호출해서 구하지 않는다** — 이 함수는 여전히 순수 함수다.
// 호출자(preflight.ts 가 이미 pr_mode 검사를 위해 `git remote get-url origin` 을 실행하던 지점을
// 재사용해 구한 값)가 인자로 넘긴다. originHost 를 생략(undefined)하면 이 함수는 §37 T1 원래
// 동작과 완전히 동일하다 — origin 호스트 자동 포함은 이 인자를 넘기는 호출자에게만 적용된다.
export function resolveSandboxSettings(state: State, originHost?: string | null): SandboxSettings | undefined {
  const cfg = state.sandbox;
  if (!cfg?.enabled) return undefined;
  const settings: SandboxSettings = {
    enabled: true,
    failIfUnavailable: true,
    // §41 C-1/C-2: cfg 가 무엇을 넣었든(명시적 true 포함) 무시하고 항상 false. 위 함수 주석 참조.
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: false,
  };
  if (cfg.network) settings.network = cfg.network;
  if (cfg.filesystem) settings.filesystem = cfg.filesystem;
  if (cfg.credentials) settings.credentials = cfg.credentials;
  if (shouldAutoAddOriginHost(cfg, originHost)) {
    settings.network = { ...settings.network, allowedDomains: [originHost] };
  }
  return settings;
}

// §37 후속(sandbox-trial 막힘 1)/§30 P4 — resolveSandboxSettings 가 origin 호스트를 방금
// 자동으로 붙였는지(사용자가 명시한 목록이 아니라 이 하네스가 채운 것인지)를 관측 전용으로
// 알려주는 함수. shouldAutoAddOriginHost 판정 하나를 doctor.ts(`fw doctor` 표시)와
// permissions.ts(런로그 표시)가 공유한다 — 판정을 두 곳에서 각자 다시 계산하면 다음 라운드에
// 갈린다(§30 P1). resolveSandboxSettings 자체의 반환 타입(SandboxSettings | undefined)을
// "무엇을 자동으로 붙였는가"까지 담도록 바꾸지 않은 이유: 기존 호출부(cli.ts `fw status`,
// doctor.ts 의 enabled 판정)가 truthy 체크만 하므로 반환 타입을 바꾸면 그쪽까지 갱신해야 하고,
// 이 정보가 필요한 곳은 지금 두 곳뿐이라 별도 조회 함수가 더 낮은 결합도를 만든다.
export function sandboxOriginHostAutoAdded(state: State, originHost: string | null | undefined): string | null {
  const cfg = state.sandbox;
  if (!cfg?.enabled) return null;
  return shouldAutoAddOriginHost(cfg, originHost) ? originHost : null;
}

// §29 Minor 2: templates/STATE.json 의 `{{ ... }}` 플레이스홀더를 치환하지 않고 그대로
// 두면(또는 옛 템플릿을 복사해 일부만 채우면) zod 스키마 오류로 이어져 "플레이스홀더를
// 치환하세요"가 아니라 암호 같은 메시지가 나온다(실측). JSON 트리를 훑어 `{{` 를 포함한
// 첫 문자열 필드의 경로를 찾아 loadState 가 zod 보다 먼저 친절한 메시지로 잡아낸다.
function findPlaceholderPath(value: unknown, trail: string[] = []): string | null {
  if (typeof value === "string") {
    return value.includes("{{") ? trail.join(".") || "(root)" : null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findPlaceholderPath(value[i], [...trail, `[${i}]`]);
      if (found) return found;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const found = findPlaceholderPath(v, [...trail, key]);
      if (found) return found;
    }
    return null;
  }
  return null;
}

export function loadState(workflowDir: string): State {
  const file = statePath(workflowDir);

  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (err) {
    throw new Error(`STATE.json 을 읽을 수 없습니다 (${file}): ${(err as Error).message}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`STATE.json 파싱에 실패했습니다 (${file}): ${(err as Error).message}`);
  }

  const placeholderPath = findPlaceholderPath(json);
  if (placeholderPath) {
    throw new Error(
      `STATE.json 에 템플릿 플레이스홀더가 치환되지 않았습니다: ${placeholderPath} (${file}). ` +
        "fw init 으로 새로 만들거나 해당 필드 값을 직접 채우세요.",
    );
  }

  const result = StateSchema.safeParse(json);
  if (!result.success) {
    throw new Error(
      `STATE.json 스키마가 유효하지 않습니다 (${file}):\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}

export function saveState(workflowDir: string, state: State): void {
  // 불변식(스키마) 확인 없이 디스크에 쓰지 않는다 — 훼손된 STATE.json 을 남기지 않기 위한 방어선
  const validated = StateSchema.parse(state);
  const file = statePath(workflowDir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(validated, null, 2) + "\n");
  fs.renameSync(tmp, file); // 같은 파일시스템 내 rename 은 원자적 — 쓰다 만 STATE.json 노출 방지
}

// pending/blocked(답변 후 재개)/in_progress(크래시 복구) 중 의존성이 충족된 첫 phase.
// 반환값은 state.phases 내부 객체의 live reference 다 — 호출자가 직접 변형한 뒤 saveState 한다.
export function selectNextPhase(state: State): Phase | null {
  const doneIds = new Set(state.phases.filter(p => p.status === "done").map(p => p.id));
  return (
    state.phases.find(
      p =>
        (p.status === "pending" ||
          p.status === "in_progress" ||
          p.status === "in_review" ||
          p.status === "blocked") &&
        p.depends_on.every(d => doneIds.has(d)),
    ) ?? null
  );
}

export function allPhasesDone(state: State): boolean {
  return state.phases.every(p => p.status === "done");
}

// 게이트는 폴백(phase.verify 또는 verify_default 둘 중 하나)만 실행하고,
// 권한 정책(policyFor)은 합집합을 허용한다 — 의도된 차이다.
export function verifyCommandsFor(state: State, phase: Phase): string[] {
  const commands = phase.verify.length > 0 ? phase.verify : state.verify_default;
  if (commands.length === 0) {
    // assertRunnable 이 `fw run` 시작 시점에 선차단하지만, 이중 안전망으로 여기서도 막는다.
    throw new Error(
      `Phase ${phase.id} 에 유효한 검증 명령이 없습니다 (phase.verify 와 verify_default 모두 비어 있음)`,
    );
  }
  return commands;
}

export function answerQuestion(state: State, answer: string, at: string): void {
  if (!state.pending_question) throw new Error("pending_question 이 없습니다");
  const q = state.pending_question;
  const phase = state.phases.find(p => p.id === q.phase);
  if (!phase || phase.status !== "blocked") {
    throw new Error(
      `답변 대상 phase(${q.phase}) 가 없거나 blocked 상태가 아닙니다 — 조용히 무시하지 않습니다`,
    );
  }
  state.answers.push({ question: q.question, answer, phase: q.phase, at });
  // B-2: PR 컨텍스트(phase.pr)가 있으면 in_review 로 복귀시켜 재개 시 세션을 처음부터 다시
  // 돌리지 않고 PR 폴링만 재개하게 한다. "pending" 으로 되돌리면 orchestrator 의 in_review
  // 분기를 못 타 이미 PR 로 올라간 작업을 통째로 재구현하는 라이브락에 빠진다.
  phase.status = phase.pr ? "in_review" : "pending";
  state.pending_question = null;
  state.status = "running";
}

// ── §30 P3 구조적 방어: 실행 로그가 커밋될 수 있는 근본 위험 ────────────────────────
//
// 감사자 권고(§32 남은 부채): "최종 방어로는 `fw run` 시작 시 docs/<wf>/logs/ 를 .gitignore 에
// 넣는지 검사하는 편이 정규식 경쟁보다 확실하다." §27 O1 감사 로그는 DENY 명령 **전문**을 남기고,
// §32 I-1 마스킹 재설계 이후에도 **33%** 는 의도적으로 마스킹하지 않는다(인용 없는 40자 소문자
// hex 비밀은 git SHA 와 구별 불가 — I-1 주석 참조, "SHA·브랜치·원격 이름을 잃지 않는다"를 우선한
// 트레이드오프). 정규식으로 완벽한 마스킹을 겨루는 경쟁은 §30 P3("문법을 흉내내려다 진다") 그대로
// 진다 — 그 로그가 대상 리포에 **커밋될 수 없게** 만드는 편이 확실하다.
//
// 이 검사는 git 실행이 필요해 바로 아래 assertRunnable(State 만 받는 순수 동기 함수)에 넣을 수
// 없다 — orchestrator.ts 가 assertRunnable 을 동기로 호출하는 계약을 이 라운드에서 깰 수 없다.
// 그래서 이 파일에는 **순수 로직**(주입된 git 실행기를 받는 async 함수)만 두고, 실제 호출은
// preflight.ts(`fw run` 시작 게이트, §36 C-2 로 이번 라운드에 실제 배선·회귀 테스트 완료)와
// doctor.ts(진단 표시)가 한다.
//
// **git 실행기 계약을 preflight.ts 의 PreflightDeps.git(CliExecResult: {ok,stdout,stderr})
// 과 일부러 다르게 뒀다** — 처음에는 그 계약을 그대로 재사용하려 했으나 실측 결과 근본 결함이
// 드러났다: preflight.ts 의 공용 `run()` 헬퍼는 exec 가 실패하면 `stderr || err.message` 로
// stderr 를 채운다. `git check-ignore -q` 가 "매칭 안 됨"(exit 1, 진짜 stderr 없음)으로 끝나도
// Node 의 execFile 은 이를 에러로 취급해 err 를 채우고, 그 결과 `err.message`(예: "Command
// failed: git check-ignore -q logs/\n")가 stderr 자리를 채운다 — "진짜 not-ignored"(exit 1)와
// "판정 불가"(exit 128, 저장소 아님)를 stderr 유무로 구분하려던 최초 설계가 이 대체 때문에
// **실제로는 항상 "판정 불가"로 오분류**되는 것이 실측으로 드러났다(개발 중 실제 git 저장소로
// 재현: exit 1 인데 stderr 가 채워져 not-ignored 가 전부 unknown 으로 사라짐 — 그대로 뒀으면
// 이 방어 전체가 프로덕션에서 조용히 무력화되는 §26 I5 류 사고였다). 그래서 exit code 를 직접
// 받는 전용 계약으로 바꿨다 — exit code 는 대체될 수 없는 유일한 신호다.
//
// §36 I-2 감사 이후: 같은 실행기로 `git ls-files`(추적 파일 나열)도 돌려야 해서 stdout 도
// 받는다(선택 필드로 추가 — 기존에 `{exitCode, stderr}` 만 반환하던 테스트 스텁들이 계속
// 타입체크를 통과하게 하기 위함, §30 P2 정상 경로 보호).

export interface RunLogsGitCheckIgnoreExec {
  (args: string[], cwd: string): Promise<{ exitCode: number | null; stderr: string; stdout?: string }>;
}

/** 기본 구현 — 실제 git CLI. exitCode 는 execFile 콜백의 err.code(숫자)에서 뽑는다. spawn 자체가
 *  실패하면(git 미설치 등) err.code 가 "ENOENT" 같은 문자열이라 숫자가 아니고, 그러면 null 로
 *  반환해 호출자가 판정 불가(unknown)로 degrade 하게 한다. */
export const defaultRunLogsGitCheckIgnoreExec: RunLogsGitCheckIgnoreExec = (args, cwd) =>
  new Promise(resolve => {
    execFile("git", args, { cwd, timeout: 60_000 }, (err, stdout, stderr) => {
      if (!err) {
        resolve({ exitCode: 0, stderr: (stderr ?? "").toString(), stdout: (stdout ?? "").toString() });
        return;
      }
      const code = (err as NodeJS.ErrnoException & { code?: unknown }).code;
      resolve({
        exitCode: typeof code === "number" ? code : null,
        stderr: (stderr ?? "").toString(),
        stdout: (stdout ?? "").toString(),
      });
    });
  });

// §36 C-3 — repoRoot 기준 target 의 저장소-내부 상대경로 후보를 "리터럴"(문자열 그대로 비교)과
// "realpath 정규화"(symlink 를 실제 대상으로 해석한 뒤) 두 가지로 계산한다. 어느 쪽이든
// repoRoot 안이면(".." 로 시작하지 않고 절대경로가 아니면) 값을 채우고, 둘 다 아니면 target 은
// repoRoot 밖이다.
//
// 이 판정은 원래 checkRunLogsIgnored 안에 `path.relative` 순수 어휘 비교로만 있었는데, 바로
// 옆(당시) preflight.ts 의 workflowDirCandidates 는 이미 리터럴+realpath 두 후보를 계산하고
// 있었다(§29 MI-4 가 macOS symlink 때문에 넣은 것) — **같은 질문("target 이 repoRoot 안인가")을
// 한 파일 안에서 두 방식으로 답하고 있었다**(§30 P1). 실측: repo_root 는 realpath, workflowDir
// 은 symlink 경유(또는 그 반대)로 주어지면 문자열 비교만으로는 "밖" 으로 오판해 이 로그 보호
// 게이트 전체가 조용히 꺼지고, `fw doctor` 는 "OK — repo_root 밖이라 검사하지 않습니다" 라는
// **거짓 문장**을 냈다(로그는 실제로 repo 안에 쌓이고 커밋될 수 있었다). 양방향(repo_root=실/
// workflowDir=symlink, repo_root=symlink/workflowDir=실) 모두 재현됨 — test/state.test.ts 참조.
//
// preflight.ts 의 workflowDirCandidates 가 이 함수를 그대로 import 해서 쓴다(§30 P1 — 복붙하면
// 다음 라운드에 또 갈린다). state.ts 에 둔 이유: preflight.ts 가 이미 이 파일(checkRunLogsIgnored
// 등)을 import 하므로, 반대 방향으로 다시 import 하면 순환 의존이 생긴다 — 의존이 이미 한
// 방향으로 흐르는 이 파일이 공유 위치로 적합하다. (paths.ts 는 이번 라운드 다른 에이전트와의
// 파일 소유 경계 밖이라 손대지 않는다 — realpathOrClimb 자체는 그대로 재사용한다.)
export interface RepoRelativeCandidates {
  /** repoRoot 문자열 그대로 비교한 상대경로. repoRoot 밖이면 null. */
  literal: string | null;
  /** repoRoot/target 양쪽을 realpath(symlink 해석)한 뒤의 상대경로. repoRoot 밖이면 null. */
  real: string | null;
}

export function repoRelativeCandidates(repoRoot: string, target: string): RepoRelativeCandidates {
  const literalRel = path.relative(repoRoot, target);
  const literal =
    literalRel !== "" && !literalRel.startsWith("..") && !path.isAbsolute(literalRel) ? literalRel : null;

  const realRepoRoot = realpathOrClimb(repoRoot);
  const realTarget = realpathOrClimb(target);
  const realRel = path.relative(realRepoRoot, realTarget);
  const real = realRel !== "" && !realRel.startsWith("..") && !path.isAbsolute(realRel) ? realRel : null;

  return { literal, real };
}

export type RunLogsIgnoreStatus =
  | "ignored" // git 이 이 경로를 무시한다 — 안전
  | "not-ignored" // git 이 이 경로를 추적한다 — 커밋될 수 있다(문제)
  | "outside-repo" // 로그 디렉토리가 repo_root 밖 — 애초에 그 리포에 커밋될 길이 없다
  | "unknown"; // git 저장소가 아니거나 check-ignore 실행 자체가 실패 — 판정 불가(§30 P2: degrade)

export interface RunLogsIgnoreCheck {
  status: RunLogsIgnoreStatus;
  /** repo_root 기준 상대경로 + 후행 "/"(표시용). outside-repo 면 null. */
  relLogsDir: string | null;
  /** §36 I-2 — status:"not-ignored" 이면서 이 값이 true 면, .gitignore 패턴 자체는 이미 맞지만
   *  (--no-index 판정으로는 무시됨) 과거에 이미 커밋된 로그가 git index 에 여전히 추적 중이라
   *  패턴과 무관하게 계속 추적된다는 뜻이다(§33 이전에 fw 를 돌려 로그가 이미 커밋된 리포가
   *  정확히 이 상태 — `git rm -r --cached <logs>` 로 추적을 해제해야 한다). false/undefined 면
   *  패턴 자체가 안 맞는(또는 판정 불가) 통상적인 not-ignored 다. */
  alreadyTrackedInIndex?: boolean;
}

/** 실행 로그가 실제로 쌓이는 디렉토리. runlog.ts/orchestrator.ts 가 `<workflowDir>/logs/` 에 쓴다
 *  (workflow 이름에서 "docs/<workflow>/logs" 로 역산하지 않는다 — workflowDir 은 사용자가 임의
 *  경로로 줄 수 있는 CLI 인자다, cli.ts 의 `run <workflowDir>` 참조). */
export function runLogsDir(workflowDir: string): string {
  return path.join(workflowDir, "logs");
}

// relLogsDir 이 관례(§20: `docs/<workflow>/logs`)를 따르면 리포 전체에 적용되는 와일드카드
// 한 줄을 권하고, 아니면(workflowDir 이 그 관례 밖) 정확한 경로 하나만 권한다 — 틀린 와일드카드를
// 권했다가 무관한 디렉토리까지 무시시키는 사고를 피한다.
export function suggestGitignoreLineForLogs(relLogsDir: string): string {
  const parts = relLogsDir.split("/").filter(Boolean); // 예: ["docs", "pr-smoke", "logs"]
  if (parts.length === 3 && parts[0] === "docs" && parts[2] === "logs") {
    return "docs/*/logs/";
  }
  return `/${relLogsDir}`;
}

/** git check-ignore 한 경로를 질의해 순수 패턴 매칭 결과만 얻는다(추적 여부는 보지 않는다 —
 *  `--no-index` 를 붙여 index 를 아예 참조하지 않게 한다, §36 I-2). exit 0=ignored, exit
 *  1=not-ignored, 그 외(128 등)/실행 실패=unknown. */
async function queryPatternMatches(
  git: RunLogsGitCheckIgnoreExec,
  cwd: string,
  relPath: string,
): Promise<"ignored" | "not-ignored" | "unknown"> {
  try {
    const { exitCode } = await git(["check-ignore", "-q", "--no-index", relPath], cwd);
    if (exitCode === 0) return "ignored";
    if (exitCode === 1) return "not-ignored";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/** `git ls-files -- <relPath>` 로 그 경로 아래 **현재 git index 에 추적 중인 파일**이 있는지
 *  본다(§36 I-2). 패턴 매칭과 무관하게, 과거에 이미 커밋된 파일은 .gitignore 를 추가해도 계속
 *  추적된다 — 이게 "패턴은 맞는데 여전히 커밋될 수 있는" 상태의 근본 원인이다. 반환값:
 *  true=추적 중인 파일 있음, false=없음(비어있는 stdout), null=판정 불가(저장소 아님 등). */
async function queryHasTrackedFiles(
  git: RunLogsGitCheckIgnoreExec,
  cwd: string,
  relPath: string,
): Promise<boolean | null> {
  try {
    const { exitCode, stdout } = await git(["ls-files", "--", relPath], cwd);
    if (exitCode !== 0) return null;
    return (stdout ?? "").trim().length > 0;
  } catch {
    return null;
  }
}

/**
 * `<workflowDir>/logs/` 가 repoRoot 의 git 에 의해 무시되는지 판정한다. git 실행기를 주입받는
 * 비동기 함수라 순수하지 않다(위 설명 참조).
 *
 * 실측(2026-08, 임시 git 저장소): `git check-ignore -q --no-index <path>` 는
 *   - .gitignore 에 매칭되면 exit 0 — **경로가 디스크에 없어도 판정된다**(순수 패턴 매칭이라,
 *     아직 한 번도 실행하지 않아 logs/ 가 없는 최초 실행에서도 검사할 수 있다).
 *   - 매칭 안 되면 exit 1.
 *   - 대상이 저장소가 아니면(fatal) exit 128 — 그래서 exit code 로만 셋을 구분한다(0=ignored,
 *     1=not-ignored, 그 외 전부 unknown). stderr 는 신호로 쓰지 않는다 — 위 헤더 주석 참조
 *     (공용 CliExecResult 헬퍼를 거치면 exit 1 의 빈 stderr 가 err.message 로 채워져 exit 1 과
 *     exit 128 을 구분할 수 없게 되는 것을 실측으로 확인했다).
 *   - **디렉토리 전용 패턴**(예: `docs`, 임의 세그먼트, `logs` 로 이어지는 glob)은 경로가 아직
 *     존재하지 않을 때 **후행 슬래시가 있어야만** 매칭된다(존재하는 실제 디렉토리는 슬래시
 *     유무와 무관하게 매칭됨, 실측 확인) — 그래서 항상 후행 슬래시를 붙여 질의한다.
 *
 * §36 실측(적대적 재감사)으로 드러난 두 오탐/오차단을 이 함수가 함께 고친다:
 *   - **I-1**: `docs/wf/logs/` 디렉토리 자체를 질의하면 `*.log` 만 있는 `.gitignore`(logs/ 에
 *     실제로 쌓이는 파일은 전부 `run-<ts>.log`/`phase-N-attempt-M.log` 라 이 패턴이면 사실은
 *     완전히 보호된다)에서 매칭되지 않아 오탐이 난다. 디렉토리 질의가 실패하면 대표 파일명
 *     둘로 재질의해, 실제 산출물이 전부 무시되면 통과시킨다.
 *   - **I-2**: `git check-ignore`(플레인, index 를 본다)는 이미 **추적 중인 경로**를 패턴이
 *     맞아도 not-ignored 로 답한다(실측 확인, 아래 queryHasTrackedFiles 참조) — §33 이전에 fw 를
 *     돌려 로그가 이미 커밋된 리포가 정확히 이 상태다. 이 함수는 **패턴 매칭**(--no-index, 추적
 *     여부 무관)과 **추적 여부**(ls-files)를 분리된 질문으로 각각 판정해 이 둘을 구분한다 —
 *     패턴은 맞는데 추적 중이면 alreadyTrackedInIndex:true 로 표시하고 여전히 not-ignored 로
 *     보고한다(`git rm -r --cached` 안내는 runLogsNotIgnoredReason 참조).
 *
 * §36 C-3: workflowDir/repoRoot 후보 계산은 repoRelativeCandidates(위)로 통일했다 — 문자열
 * 비교만으로는 symlink 경유 조합에서 실제로는 repo 안인데도 outside-repo 로 오판했다.
 */
export async function checkRunLogsIgnored(
  git: RunLogsGitCheckIgnoreExec,
  repoRoot: string,
  workflowDir: string,
): Promise<RunLogsIgnoreCheck> {
  const logsDir = runLogsDir(workflowDir);
  const { literal, real } = repoRelativeCandidates(repoRoot, logsDir);
  const rel = literal ?? real;
  if (rel === null) {
    // workflowDir(따라서 그 logs/ 도)가 리터럴로도 realpath 로도 repoRoot 밖 — 이 리포에 커밋될
    // 길이 없으므로 검사할 이유가 없다(§30 P2 정상 경로).
    return { status: "outside-repo", relLogsDir: null };
  }
  const relPosix = rel.split(path.sep).join("/").replace(/\/+$/, "") + "/";

  const dirMatch = await queryPatternMatches(git, repoRoot, relPosix);
  if (dirMatch === "unknown") return { status: "unknown", relLogsDir: relPosix };

  let patternOk = dirMatch === "ignored";
  if (!patternOk) {
    // §36 I-1 — 디렉토리 전체가 아니라 실제 산출 파일명(*.log 등)만 무시하는 패턴일 수 있다.
    // 둘 다 무시돼야("완전 보호") 통과시킨다.
    const repFiles = [`${relPosix}run-x.log`, `${relPosix}phase-1-attempt-1.log`];
    const repResults = await Promise.all(repFiles.map(f => queryPatternMatches(git, repoRoot, f)));
    if (repResults.some(r => r === "unknown")) return { status: "unknown", relLogsDir: relPosix };
    patternOk = repResults.every(r => r === "ignored");
  }
  if (!patternOk) {
    return { status: "not-ignored", relLogsDir: relPosix };
  }

  // §36 I-2 — 패턴은 맞는다. 그래도 과거에 이미 커밋된 로그가 index 에 남아 있으면 여전히
  // 커밋될 수 있다(패턴은 새 파일에만 적용되고, 이미 추적 중인 경로는 그대로 추적된다).
  const tracked = await queryHasTrackedFiles(git, repoRoot, relPosix);
  if (tracked === null) return { status: "unknown", relLogsDir: relPosix };
  if (tracked) return { status: "not-ignored", relLogsDir: relPosix, alreadyTrackedInIndex: true };
  return { status: "ignored", relLogsDir: relPosix };
}

/** preflight.problems 항목으로 바로 쓸 수 있는 한 줄 사유(§30 P3). doctor.ts 는 같은 정보를
 *  사람이 보기 좋은 여러 줄로 나눠 보여준다.
 *  §36 I-2: alreadyTrackedInIndex 가 true 면 ".gitignore 줄을 추가하라" 는 안내는 **이미 있는
 *  줄을 다시 추가하라는 것과 같아 탈출구가 안 된다**(§26 I5 류 자충수 재발 — 감사자 실측:
 *  사용자가 안내를 그대로 따라도 문제가 계속된다). 그 경우 `git rm -r --cached` 로 분기한다. */
export function runLogsNotIgnoredReason(
  relLogsDir: string,
  opts: { alreadyTrackedInIndex?: boolean } = {},
): string {
  if (opts.alreadyTrackedInIndex) {
    const cachedPath = relLogsDir.replace(/\/+$/, "");
    return (
      `${relLogsDir} 는 .gitignore 패턴과 이미 일치하지만(패턴 자체는 올바릅니다), git 이 ` +
      "이 경로를 **이미 추적 중**입니다 — 과거(§33 이전)에 커밋된 로그가 index 에 남아 있으면 " +
      ".gitignore 를 추가해도 계속 추적되어 커밋될 수 있습니다(감사 로그의 마스킹되지 않은 " +
      `자격증명 포함, §32 I-1 참조). 다음을 실행해 추적을 해제하세요: \`git rm -r --cached ` +
      `${cachedPath}\` (디스크의 파일은 그대로 남습니다). 이미 커밋된 로그는 git 히스토리에도 ` +
      "남아 있으니, 자격증명이 실제로 노출됐다면 히스토리 재작성(git filter-repo 등)도 " +
      "고려하세요. (또는 allow_untracked_logs: true 로 위험을 감수하고 실행하려면 STATE.json 에 " +
      "그렇게 설정하세요)"
    );
  }
  const suggestion = suggestGitignoreLineForLogs(relLogsDir);
  return (
    `${relLogsDir} 가 git 에 무시되지 않습니다 — 감사 로그(§27 O1)에 마스킹되지 않은 자격증명이 ` +
    "남을 수 있고(§32 I-1: 마스킹은 완전하지 않다), 커밋되면 되돌리기 어렵습니다. 리포 루트 " +
    `.gitignore 에 다음 줄을 추가하세요: ${suggestion} (또는 allow_untracked_logs: true 로 ` +
    "위험을 감수하고 실행하려면 STATE.json 에 그렇게 설정하세요)"
  );
}

// `fw run` 시작 시 호출되는 불변식 검사. 위반 시 명확한 한국어 메시지로 throw 하여 실행을 거부한다.
export function assertRunnable(state: State): void {
  if (state.phases.length === 0) {
    throw new Error("실행할 phase 가 없습니다 (phases 가 비어 있습니다)");
  }

  // pr-slicing: 조각 분해는 하네스가 조각 브랜치를 만들고 통합 브랜치를 전진시켜야 성립한다.
  // branch_strategy="current" 는 "브랜치를 사용자에게 위임하고 이탈 감시도 하지 않는다"는
  // 설계(applyBranchStrategy 가 workBranch:null 을 반환)라 하네스가 브랜치를 만들 근거가 없다.
  // 조용히 분해를 끄지 않고 시작 시점에 거부한다 — 삼키면 사용자는 조각 PR 을 기대하는데
  // 커다란 PR 하나를 받고, 왜 그런지 알 방법이 없다(§30 P4).
  // 조각은 통합 브랜치로 **머지되어야** 그 브랜치가 전진하고 다음 조각이 그 위에서 시작한다
  // (advanceIntegrationBranchAfterMerge). pr_mode 가 꺼져 있으면 머지가 일어나지 않으므로
  // 조각 2가 조각 1 의 작업 없이 시작한다 — 조용히 어긋난 결과를 내느니 시작 시점에 거부한다.
  if (state.review_split?.enabled && !state.pr_mode) {
    throw new Error(
      "review_split.enabled=true 는 pr_mode=true 를 요구합니다 — 조각은 통합 브랜치로 머지되어야 " +
        "다음 조각이 그 위에서 시작합니다. pr_mode 없이는 머지가 일어나지 않아 조각들이 서로의 " +
        "작업을 보지 못합니다.",
    );
  }

  if (state.review_split?.enabled && state.branch_strategy === "current") {
    throw new Error(
      "review_split.enabled=true 는 branch_strategy=\"current\" 와 함께 쓸 수 없습니다 — " +
        "조각 분해는 하네스가 조각 브랜치를 만들어야 하지만 \"current\" 는 브랜치를 사용자에게 " +
        "위임하는 전략입니다. branch_strategy 를 \"isolate\" 또는 \"require-topic\" 으로 바꾸거나 " +
        "review_split.enabled 를 false 로 두세요.",
    );
  }

  const seen = new Set<number>();
  for (const p of state.phases) {
    if (seen.has(p.id)) {
      throw new Error(`phase id 가 중복됩니다: ${p.id}`);
    }
    seen.add(p.id);
  }

  const ids = new Set(state.phases.map(p => p.id));
  for (const p of state.phases) {
    for (const d of p.depends_on) {
      if (d === p.id) {
        throw new Error(`Phase ${p.id} 가 자기 자신을 depends_on 으로 참조합니다`);
      }
      if (!ids.has(d)) {
        throw new Error(`Phase ${p.id} 가 존재하지 않는 phase(${d}) 를 depends_on 으로 참조합니다`);
      }
    }
  }

  // 의존성 순환 검사 (DFS, 3색 마킹: white=미방문, gray=탐색 중, black=완료)
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<number, number>(state.phases.map(p => [p.id, WHITE]));
  const byId = new Map(state.phases.map(p => [p.id, p]));
  const visit = (id: number, trail: number[]): void => {
    color.set(id, GRAY);
    const phase = byId.get(id);
    if (phase) {
      for (const d of phase.depends_on) {
        if (color.get(d) === GRAY) {
          throw new Error(`의존성 순환이 감지되었습니다: ${[...trail, id, d].join(" -> ")}`);
        }
        if (color.get(d) === WHITE) {
          visit(d, [...trail, id]);
        }
      }
    }
    color.set(id, BLACK);
  };
  for (const p of state.phases) {
    if (color.get(p.id) === WHITE) visit(p.id, []);
  }

  // §31 I2 인접 결함(1): 바로 아래 린트 루프는 done phase 를 §30 P2 근거로 skip 하는데, 이
  // "비어있음" 검사가 그러지 않으면 모순이다 — 완료된 레거시 워크플로우를 STATE.json 스키마
  // 변경(verify 필수 아님 등) 이후에 재개하려 할 때, done phase 의 verify 가 비어 있다는 이유로
  // (다시 실행되지도 않을 phase인데) 영구히 재개가 막히는 것이 실측됐다. done phase 는 다시
  // 실행되지 않으므로(selectNextPhase 가 done 을 고르지 않음) 여기서도 동일하게 skip 한다.
  for (const p of state.phases) {
    if (p.status === "done") continue;
    const commands = p.verify.length > 0 ? p.verify : state.verify_default;
    if (commands.length === 0) {
      throw new Error(
        `Phase ${p.id} 에 유효한 검증 명령이 없습니다 (phase.verify 와 verify_default 모두 비어 있음) — 검증 없는 phase 는 허용되지 않습니다`,
      );
    }
  }

  // §26 I5 잔여 승격: verify 명령 정적 린트(무력화 패턴 검출)를 `fw doctor` 의 옵트인 진단에서
  // `fw run` 시작 시점의 실제 게이트로 끌어올린다. `npm test || true` 처럼 항상 exit 0 인 명령은
  // 위 "비어 있지 않은지" 검사를 통과하지만 실질적으로 아무 것도 검증하지 않는다(§29 MI-11:
  // "밤새 11회 게이트가 전부 통과하고 done 이 된다" 실측). severity:"error" 만 거부한다 — "warn"
  // (파이프·세미콜론 등)은 판정을 흐릴 수 있지만 항상 무력화를 뜻하지는 않으므로 시작을 막지
  // 않는다(§30 P2 — 과잉 차단 방지: `set -o pipefail && npm test | tee build.log` 처럼 린트가
  // 스스로 권하는 관용구까지 막으면 §26 I5 가 이미 겪은 자충수를 반복하게 된다).
  //
  // done phase 는 검사하지 않는다 — done 은 이미 검증을 통과했고 다시 실행되지 않으므로(재개 시
  // selectNextPhase 가 done phase 를 다시 고르지 않는다), 완료 이후 verify 문자열이 (의도적으로든
  // 실수로든) 나쁘게 바뀌어도 그것만으로 정상 재개를 막을 이유가 없다 — §30 P2 규칙("방어가 정상
  // 경로를 막지 않게 하라")과 §26 C1/§29 MI-4(재개 경로를 막은 과잉 방어)의 재발 방지다.
  for (const p of state.phases) {
    if (p.status === "done") continue;
    const commands = verifyCommandsFor(state, p); // 위에서 이미 비어있지 않음을 확인함
    const errors = lintVerifyCommands(commands).filter(i => i.severity === "error");
    if (errors.length > 0) {
      const detail = errors.map(i => `  - [${i.command}] ${i.reason}`).join("\n");
      throw new Error(
        `Phase ${p.id}(${p.title}) 의 검증 명령이 게이트를 무력화합니다 — 실행을 거부합니다:\n${detail}\n` +
          "`fw doctor <workflow-dir>` 로 전체 phase 의 검증 명령을 한 번에 점검할 수 있습니다.",
      );
    }
  }

  // §31 I2 인접 결함(2): 모든 non-done phase 가 자기 verify 를 가지고 있으면 verify_default 는
  // verifyCommandsFor 어디에서도 반환되지 않아 위 루프에서 전혀 린트되지 않는다(실측:
  // verify_default:["npm test || true"] + 모든 phase 가 자기 verify 보유 → 위 루프 통과). 그런데
  // permissions.ts 의 policyFor 는 phase 가 실제로 그 값을 쓰는지와 무관하게 verify_default 를
  // 항상 세션 Bash 자동 허용 목록(policy.verifyCommands)에 합집합으로 포함시킨다 — 즉 게이트가
  // 실행하지 않는(그래서 린트도 안 되는) 값이 세션에게는 "이 명령은 자동 승인됨"으로 노출된다.
  // permissions.ts 는 다른 에이전트 소유라 그 합집합 설계 자체는 바꾸지 않고, 린트 쪽에서
  // 사용 여부와 무관하게 verify_default 를 항상 검사해 이 구멍을 막는다.
  //
  // §32 I-4: 그런데 "항상" 검사하면 **실행될 명령이 하나도 없는 상태**까지 거부하게 된다.
  // runWorkflow(orchestrator.ts)는 마지막 phase 를 "done" 으로 저장한 직후와 state.status="done"
  // 을 저장하는 사이에 창이 있다. 밤샘 무인 주행에서 킬 스위치/OOM/크래시로 정확히 그 창에서
  // 죽으면 STATE 에는 status:"running" + 전 phase status:"done" 이 남는다 — selectNextPhase 는
  // 이제 아무 phase 도 고르지 않고(모두 done), verify_default 를 실행할 세션도 다시는 뜨지 않는다.
  // 그런데도 verify_default 에 나쁜 값이 있으면 여기서 매번 거부해 `fw run` 자체가 영구히 막히고
  // (verify 에이전트도 못 돌고 done 으로 전이도 못 하는 죽은 상태로 굳는다 — §30 P2 재발, 감사자
  // 실측). **바로 위 두 루프(:405-413 의 "비어있음" 검사, :427-438 의 phase 별 린트)는 이미 phase
  // 단위로 done 을 skip 하는데, 이 블록만 전역적이라 그 계약을 놓쳤다 — 같은 파일 안에서
  // 자기모순이었다.**
  //
  // 수정: 전 phase 가 done 이면(allPhasesDone) 이 블록 전체를 건너뛴다. 위 두 루프의 "이 phase만
  // done 이면 skip" 과 조건이 다르다는 점에 유의 — verify_default 는 전역 값이라 아직 안 끝난
  // phase 가 하나라도 있으면 그 phase 가 verify_default 를 쓸 수 있으므로(§31 I2 인접(2) 그대로)
  // 계속 검사해야 한다. "모든" phase 가 끝났을 때만 실행될 명령이 정말 하나도 없다고 확신할 수
  // 있다.
  if (!allPhasesDone(state) && state.verify_default.length > 0) {
    const defaultErrors = lintVerifyCommands(state.verify_default).filter(i => i.severity === "error");
    if (defaultErrors.length > 0) {
      const detail = defaultErrors.map(i => `  - [${i.command}] ${i.reason}`).join("\n");
      throw new Error(
        `verify_default 의 검증 명령이 게이트를 무력화합니다 — 실행을 거부합니다:\n${detail}\n` +
          "`fw doctor <workflow-dir>` 로 전체 phase 의 검증 명령을 한 번에 점검할 수 있습니다.",
      );
    }
  }

  // PR 모드는 fix 커밋을 PR 브랜치에 push 해야 성립한다
  if (state.pr_mode && !state.allow_push) {
    throw new Error("pr_mode 는 allow_push: true 가 필요합니다 (PR 브랜치에 push 해야 함)");
  }

  // §26 I6: trusted_comment_authors 가 비어 있으면 fail-closed 로 "아무 코멘트도 처리 안 함"
  // 자체는 옳지만, 그 상태를 아무도 알려주지 않아 사용자가 PR 을 만들고 `@fw` 를 달고 밤새 아무
  // 일도 안 일어나는 걸 다음날 아침에야 발견했다(실측: assertRunnable 통과·doctor 도 문제없음으로
  // 보고·단서는 deps.log 한 줄뿐). 조용히 무력화되느니 시작 전에 명확히 멈추는 편이 무인 실행에서
  // 안전하다 — 바로 위 allow_push 검사와 같은 자리·같은 패턴이다.
  // §29 MI-10: 다만 이 거부에는 "PR 만 만들고 코멘트 처리는 원치 않는다"는 정당한 사용의
  // 탈출구가 없었다 — pr_comment_mode: "off" 를 명시한 경우는 "실수로 방치"가 아니라 "의도적
  // 옵트아웃"이므로 거부하지 않는다(D14 는 "trusted"(기본) 경로에서만 유지).
  const commentMode = state.pr_comment_mode ?? "trusted";
  if (state.pr_mode && commentMode !== "off" && state.trusted_comment_authors.length === 0) {
    throw new Error(
      "pr_mode 는 trusted_comment_authors 가 최소 1개 필요합니다 — 아무도 지정하지 않으면 " +
        "PR 코멘트를 전부 무시한 채(fail-closed) 아무 알림 없이 조용히 대기만 합니다. 둘 중 하나를 " +
        "선택하세요:\n" +
        '  - 코멘트를 반영받으려면: trusted_comment_authors: ["<github-login>"] 를 채우세요\n' +
        '  - PR 만 만들고 코멘트 처리는 원치 않으면: pr_comment_mode: "off" 로 두세요',
    );
  }

  for (const p of state.phases) {
    if (p.status === "failed") {
      throw new Error(`Phase ${p.id} 가 failed 상태로 남아있습니다 — fw retry <dir> ${p.id} 로 되살리세요`);
    }
  }
}

// failed phase 를 명시적으로 되살린다. 없거나 failed 가 아니면 throw (조용한 no-op 금지).
export function retryPhase(state: State, id: number): void {
  const phase = state.phases.find(p => p.id === id);
  if (!phase || phase.status !== "failed") {
    throw new Error(`Phase ${id} 는 재시도할 수 없습니다 (failed 상태의 phase 만 재시도 가능합니다)`);
  }
  // issue #3 제안 4: PR 컨텍스트(phase.pr)가 있으면 in_review 로 되살린다 — answerQuestion 의 B-2
  // 와 같은 이유다. "pending" 으로 되돌리면 재개 시 orchestrator 의 in_review 분기(PR 폴링만
  // 재개)를 타지 않고 phase 세션이 새로 떠서, 이미 PR 로 올라간 작업을 재구현하고 끝나면 **새
  // PR 을 하나 더 만들** 수 있다(실측: fix 세션 FAILED 뒤 fw retry → fw run 경로).
  phase.status = phase.pr ? "in_review" : "pending";
  phase.attempts = 0;
  // S1 위조 검사 기준점도 새 런으로 취급해 초기화한다 — 안 그러면 이전 런에서 위조당한 채
  // 방치된 파일이 계속 "기준점 이전" 취급돼 재시도 후에도 영원히 회송(또는 반대로 낡은 기준점이
  // 지금 이미 정상인 상태를 계속 의심)하는 상태로 굳어버린다.
  phase.verify_guard_baseline_sha = undefined;
  // 되살린 뒤 전역 status 를 failed 로 남기면 fw status 표시가 실제와 어긋난다
  if (state.status === "failed") state.status = "running";
}

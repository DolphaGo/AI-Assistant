// §25 리팩토링: orchestrator.ts 에서 PR 게이트 전체(폴링·코멘트 트리거·fix 세션 배치·머지/승인
// 판정)를 이 모듈로 옮겼다(순수 이동 — 로직 변경 없음). 원래 파일의 감사 지적("runPrGateInner
// 112줄, 파일의 48%가 PR 코드")이 이 모듈 분리의 직접적 근거다. branch.ts(checkBranchDrift/
// verifySessionCommits/refreshIsolationBranchAfterMerge)와 halt.ts(checkHaltpoint)를 그대로
// 재사용해 phase 루프와 동일한 방어를 받는다(§30 P1).
import path from "node:path";
import { randomBytes } from "node:crypto";
import { saveState, verifyCommandsFor, recordVerdict, type State, type Phase } from "./state.js";
import { policyFor } from "./permissions.js";
import { maskSecrets, type FixPromptInput, type PhaseSessionResult, type AddressedItem } from "./session.js";
import { verifyReferencedFiles, normalizeGitSourcePath } from "./gate.js";
import { displayPath, truncateForDisplay } from "./paths.js";
import {
  selectActionableComments, selectUntrustedTriggerComments, commentKey, type RawComment,
  buildPrTitle, buildPrBody, buildIntegrationPrTitle, buildIntegrationPrBody,
  parseNumstatZ, classifyReviewDiff,
} from "./pr.js";
import { parseDiffAnchors, planReviewOrder } from "./inlinereview.js";
import { defaultGitExec } from "./preflight.js";
import type { OrchestratorDeps } from "./orchestrator-types.js";
import {
  checkBranchDrift, verifySessionCommits, verifyAlreadyAppliedCommits, refreshIsolationBranchAfterMerge,
  advanceIntegrationBranchAfterMerge,
  defaultHeadSha, defaultChangedFiles, formatGuardedFileLines,
} from "./branch.js";
import { checkHaltpoint } from "./halt.js";

// "halted": §27 O2/O3 체크포인트가 PR 폴링/fix 세션 루프 안에서 상한/STOP 을 감지했다.
// checkHaltpoint 가 이미 state 를 저장했으므로 호출부는 그대로 반환하면 된다.
type GateOutcome = "done" | "awaiting_merge" | "blocked" | "failed" | "halted";

// §31 C1/§30 P1: phase 루프(orchestrator.ts)와 fix 루프(이 파일) 양쪽이 "세션이 blocked 를
// 반환했다"는 사실을 표면화하는 방식이 갈리면 한쪽만 고쳐지고 다음 라운드에 또 갈린다 —
// f7c19ae 가 phase 루프의 브랜치 이탈 삼킴만 고치고 이 파일의 동일 구조 결함(배치 flush 실패로
// pending_question 이 통째로 사라지는 버그, §31 감사 C1)을 놓친 사고가 실제로 이렇게 났다.
// 두 루프가 이 함수 하나로 pending_question 세팅·저장·알림을 한다 — extraProblems 는 "질문과
// 별개로 함께 알려야 할 사실"(브랜치 이탈, 배치 flush 실패 등)을 0개 이상 받아 "함께 발생" 으로
// 덧붙인다. 질문 자체는 extraProblems 유무와 무관하게 항상 pending_question 에 남는다 —
// 이게 이 헬퍼가 존재하는 유일한 이유다.
export function surfaceBlockedQuestion(
  workflowDir: string,
  state: State,
  phase: Phase,
  baseQuestion: string,
  extraProblems: string[],
  deps: OrchestratorDeps,
  notifyPrefix: string,
): void {
  const question = extraProblems.length > 0
    ? `${baseQuestion}\n\n⚠️ 함께 발생: ${extraProblems.join("\n⚠️ 함께 발생: ")}`
    : baseQuestion;
  phase.status = "blocked";
  state.status = "blocked";
  state.pending_question = { phase: phase.id, question, asked_at: deps.now() };
  saveState(workflowDir, state);
  deps.notify("fw BLOCKED", `${notifyPrefix}${question.slice(0, 180)}`);
}

// §pr-comment-mask D3: tamperedFiles(displayPath 로 이미 JSON 리터럴화된 항목) 목록을 PR 코멘트에
// 실을 때 truncateForDisplay 같은 char-slice 를 쓰면 JSON 문자열 리터럴 중간이 잘려 닫히지 않은
// 이스케이프가 남는다(§z-parse 가 STATE detail 에서 이미 피한 문제, 320행 참조) — 표시 목적(가역·
// 무모호)이 중간 절단으로 무너진다. 그래서 truncateForDisplay 를 재사용하지 않고, 항목(줄) 경계에서만
// 자르는 별도 헬퍼를 둔다(D2 의 "새 절단 헬퍼 금지"는 char-slice 절단 중복을 금지한 것이고, 이건
// 다른 종류의 절단이다). 최소 한 항목은 넘겨 넣어(예산을 넘어도) "표시할 게 없다"는 오해를 막는다.
function truncateListForDisplay(items: readonly string[], limit = 500): string {
  const kept: string[] = [];
  let used = 0;
  for (const item of items) {
    const added = kept.length === 0 ? item.length : item.length + 1; // +1 은 join 개행
    if (kept.length > 0 && used + added > limit) break;
    kept.push(item);
    used += added;
  }
  const remaining = items.length - kept.length;
  return remaining > 0 ? `${kept.join("\n")}\n…외 ${remaining}건` : kept.join("\n");
}

// issue #4 — PR 답글용 항목별 결과 줄. item/evidence 는 세션 자기 보고 텍스트(신뢰 경계 밖)라 각각
// maskSecrets 를 거치고 한 줄로 접는다(개행이 있으면 목록 구조가 깨져 다음 항목을 위조할 수 있다).
const ADDRESSED_LABEL: Record<AddressedItem["status"], string> = {
  applied: "✅ 반영함",
  already_applied: "⏭ 이미 반영됨",
  declined: "❌ 반영 안 함",
  not_applicable: "➖ 해당 없음",
};
function formatAddressedLines(items: readonly AddressedItem[]): string[] {
  const oneLine = (t: string) => truncateForDisplay(maskSecrets(t).replace(/[\r\n]+/g, " "), 300);
  return items.map(a => `- ${ADDRESSED_LABEL[a.status]} — ${oneLine(a.item)}: ${oneLine(a.evidence)}`);
}
// GitHub 로그인은 영숫자·하이픈만 허용된다 — 그 외 문자가 섞인 author 는 멘션하지 않는다(코멘트
// author 필드는 API 응답이지만, 멘션은 알림을 쏘는 부작용이 있어 형태를 한 번 더 좁힌다).
function mentionFor(author: string): string | null {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(author) ? `@${author}` : null;
}

const defaultSleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
// 예측 가능하거나 재사용된 nonce 는 데이터 격리를 무력화한다 — 매 호출 새 난수
const defaultNonce = (): string => randomBytes(12).toString("hex");

// 며칠짜리 폴링에서 네트워크 블립은 확률 1 이다 — 일시적 오류로 워크플로우를 죽이지 않는다 (§25 C1).
// viewPr/listComments 같은 순수 조회에만 적용한다. createPr/pushBranch/postPrComment 처럼 부작용이
// 있는 호출에 적용하면 실패-후-재시도가 중복 PR 생성/중복 답글을 유발할 수 있어 제외한다.
async function withRetry<T>(fn: () => Promise<T>, deps: OrchestratorDeps, label: string): Promise<T> {
  const delays = [1000, 4000, 15000];
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= delays.length) throw err;
      deps.log(`${label} 실패(재시도 ${i + 1}/${delays.length}): ${(err as Error).message}`);
      await (deps.sleep ?? defaultSleep)(delays[i]);
    }
  }
}

/**
 * PR 게이트: PR 을 만들고(없으면), 트리거 코멘트를 fix 세션으로 반영하며,
 * merged → done / approve → awaiting_merge(사람이 머지) / closed → failed 를 판정한다.
 * 폴링은 무기한이며, 중단해도 STATE 의 phase.pr 로 재개된다.
 */
// gate.ts/session.ts 와 동일한 계약 — "절대 throw 하지 않는다". runPrGateInner 는 pr.* 호출이
// 실패하면(예: 존재하지 않는 원격 브랜치로 gh pr create) throw 할 수 있는데, 그게 runWorkflow 밖으로
// 새 나가면 phase.status 가 in_progress 로 어정쩡하게 남는다. 여기서 흡수해 failed 로 확정한다.
// workBranch: runWorkflow 가 이 실행(fw run) 시작 시점에 applyBranchStrategy 로 확정한 작업 브랜치
// (§26 C2 와 동일한 값). §26 M5 — merged 직후 격리 브랜치를 갱신할지 판단하는 데 쓴다.
// originHost(§37 sandbox-trial 막힘 1 후속): orchestrator.ts 가 preflight() 로 이미 구한 값을
// 그대로 넘긴다(§30 P1 — git 을 다시 호출하지 않는다). 아래 runPrGateInner 의 runFixSession 이
// policyFor 에 이 값을 전달해야 fix 세션(§30 P1 세 경로 중 하나)에도 network.allowedDomains
// 자동 포함이 적용된다. 생략(undefined)하면 기존 동작과 동일하다.
export async function runPrGate(
  workflowDir: string, state: State, phase: Phase, deps: OrchestratorDeps, workBranch: string | null,
  runStartedAt: string, originHost?: string | null,
): Promise<GateOutcome> {
  try {
    return await runPrGateInner(workflowDir, state, phase, deps, workBranch, runStartedAt, originHost);
  } catch (err) {
    deps.notify("fw FAILED", `PR 게이트 오류: ${(err as Error).message}`);
    return "failed";
  }
}

/**
 * pr-slicing D6 — 통합 PR 게이트. 모든 phase(조각 포함)가 끝난 뒤 통합 브랜치 → base
 * 브랜치 PR 하나를 만들고 머지를 확인한다.
 *
 * 조각 PR 게이트(runPrGate)와 **의도적으로 다른** 두 가지:
 *   1. 코멘트 fix 루프를 돌지 않는다. 조각별로 이미 리뷰가 끝났고, 이 PR 에 달린 지적을
 *      여기서 고치면 그 변경은 어느 조각에도 리뷰되지 않은 채 들어간다.
 *   2. 무기한 폴링하지 않는다. 머지 대기 상태면 awaiting_merge 로 사람에게 넘기고 끝낸다 —
 *      조각들이 이미 다 머지된 시점이라 하네스가 더 할 일이 없다. `fw run` 을 다시 돌리면
 *      STATE 의 integration_pr 로 재개해 머지 여부만 다시 확인한다.
 *
 * 통합 브랜치가 없으면(조각 분해를 쓰지 않은 워크플로우) 아무것도 하지 않고 done 이다.
 */
export async function runIntegrationPrGate(
  workflowDir: string, state: State, deps: OrchestratorDeps, runStartedAt: string,
): Promise<GateOutcome> {
  const integrationBranch = state.integration_branch;
  if (!integrationBranch || integrationBranch.length === 0) return "done";

  const pr = deps.pr;
  if (!pr) {
    // 조용히 넘어가지 않는다 — 통합 PR 이 없으면 작업이 base 브랜치에 영원히 안 들어간다.
    deps.notify("fw FAILED", "통합 PR 을 만들 수 없습니다 — PrClient 가 주입되지 않았습니다");
    return "failed";
  }
  const cwd = state.repo_root;
  const gitExec = deps.git ?? defaultGitExec;

  if (!state.integration_pr) {
    if (checkHaltpoint(workflowDir, state, deps, runStartedAt)) return "halted";
    await pr.pushBranch({ cwd, branch: integrationBranch, sourceRef: integrationBranch });
    // 조각 PR 링크는 STATE 의 사실만 쓴다(세션 주장이 아니다). 순번이 없는 phase(분해 전에
    // 만들어진 PR)는 순번 0 으로 두어 목록 앞쪽에 모인다.
    const slicePrs = state.phases
      .filter(p => p.pr)
      .map(p => ({ seq: p.slice_seq ?? 0, url: p.pr!.url, title: p.title }));
    const ref = await pr.createPr({
      cwd,
      headBranch: integrationBranch,
      baseBranch: state.base_branch,
      title: buildIntegrationPrTitle({ workflow: state.workflow }),
      body: buildIntegrationPrBody({ baseBranch: state.base_branch, integrationBranch, slicePrs }),
    });
    state.integration_pr = { number: ref.number, url: ref.url, head_branch: integrationBranch };
    saveState(workflowDir, state);
    deps.log(`통합 PR 생성: ${ref.url}`);
  }

  const prRef = state.integration_pr;
  const view = await withRetry(() => pr.viewPr({ cwd, number: prRef.number }), deps, "통합 PR 상태 조회");
  prRef.last_polled_at = deps.now();
  saveState(workflowDir, state);

  if (view.merged) {
    deps.log(`통합 PR #${prRef.number} 머지 확인 — 워크플로우 산출물이 ${state.base_branch} 에 반영됐습니다`);
    return "done";
  }
  if (view.state === "CLOSED") {
    deps.notify("fw FAILED", `통합 PR #${prRef.number} 이 머지 없이 닫혔습니다`);
    return "failed";
  }
  deps.notify(
    "fw 통합 PR 대기",
    `조각 리뷰가 모두 끝났습니다 — 통합 PR #${prRef.number} 을 머지하면 완료됩니다: ${prRef.url}`,
  );
  return "awaiting_merge";
}

async function runPrGateInner(
  workflowDir: string, state: State, phase: Phase, deps: OrchestratorDeps, workBranch: string | null,
  runStartedAt: string, originHost?: string | null,
): Promise<GateOutcome> {
  const pr = deps.pr;
  if (!pr) {
    deps.notify("fw FAILED", "pr_mode 인데 PrClient 가 주입되지 않았습니다");
    return "failed";
  }
  const sleep = deps.sleep ?? defaultSleep;
  const nonce = deps.nonce ?? defaultNonce;
  const cwd = state.repo_root;
  const gitExec = deps.git ?? defaultGitExec;
  // §29 CR-2: workBranch 가 있으면(isolate/require-topic) push 의 소스를 HEAD 가 아니라 그 브랜치
  // 자신으로 명시한다. `buildPushArgs` 의 기존 계약(HEAD:refs/heads/<branch>)은 branch_strategy=
  // current(workBranch===null, 사용자 소유 브랜치 — §2 D7 브랜치 전략은 사용자에게 위임)에서만
  // 그대로 쓴다. isolate/require-topic 은 checkBranchDrift 가 이미 "HEAD==workBranch" 를 확인한
  // 뒤에만 여기 도달하지만, push 시점에 ref 를 명시해두면 그 확인과 실제 push 대상이 항상 같은
  // 것임이 코드만 봐도 보장된다(HEAD 라는 가변 별칭에 의존하지 않는 방어 심층화).
  const pushSourceRef = workBranch ?? undefined;

  // ── pr-slicing D1/D2: 조각 PR 은 base 브랜치가 아니라 통합 브랜치로 간다 ──────
  // 조각 분해가 켜진 phase 의 PR 은 `<조각 브랜치> → <통합 브랜치>` 다. base 브랜치(main/
  // develop)로는 워크플로우 끝의 통합 PR 하나만 간다(D6, Phase 5). head 는 세션이 실제로
  // 작업한 조각 브랜치 자신이다 — orchestrator 가 workBranch 로 그 이름을 넘긴다(Phase 2).
  // 네 조건을 모두 확인하는 이유: 하나라도 빠진 상태로 통합 브랜치를 base 로 잡으면 존재하지
  // 않는 브랜치를 향한 PR 이 만들어지거나 조각 브랜치가 아닌 곳을 push 하게 된다.
  const slicing =
    state.review_split?.enabled === true &&
    typeof state.integration_branch === "string" &&
    state.integration_branch.length > 0 &&
    phase.slice_seq !== undefined &&
    workBranch !== null;
  const prBaseBranch = slicing ? state.integration_branch! : state.base_branch;

  // 재개 경로에서만 켜진다 — 방금 만든 PR 은 그 자리에서 이미 push 했으므로 동기화가 필요없다.
  let needsSync = false;

  if (!phase.pr) {
    const headBranch = slicing ? workBranch! : `fw/phase-${phase.id}`;

    // **실전 통주가 잡은 결함**: 조각 PR 의 base(통합 브랜치)는 원격에 존재해야 한다. gh 는
    // 없는 base 에 PR 을 만들지 못한다(실측: "No commits between … , Base ref must be a
    // branch"). 옛 토폴로지에서는 base 가 base_branch 라 항상 원격에 있었지만, 통합 브랜치는
    // 로컬에서 만들어지므로 첫 조각 PR 전에 하네스가 올려야 한다. 단위 테스트는 createPr 을
    // 스텁하므로 이 조건을 검증할 수 없었다 — 실제 왕복만이 드러낸다.
    //
    // 이미 원격에 있으면 **건드리지 않는다**: 앞 조각이 머지되어 원격이 로컬보다 앞서 있을 수
    // 있고, 그 상태에서 push 하면 머지 결과를 되돌리려 드는 셈이다(--force-with-lease 가
    // 거부하겠지만 애초에 시도할 이유가 없다).
    if (slicing) {
      const remote = await gitExec(["ls-remote", "--heads", "origin", prBaseBranch], cwd);
      if (!remote.ok) {
        // 판정 불가 — 조용히 넘어가지 않고 남긴다. base 가 정말 없으면 아래 createPr 이
        // 실패하며 그 원인을 그대로 보여준다(§30 P4: 못 했다를 했다로 접지 않는다).
        deps.log(
          `통합 브랜치(${prBaseBranch})의 원격 존재를 확인하지 못했습니다 — ` +
            `PR 생성이 실패하면 이 브랜치를 먼저 push 해야 합니다: ${remote.stderr.trim().slice(0, 200)}`,
        );
      } else if (remote.stdout.trim().length === 0) {
        await pr.pushBranch({ cwd, branch: prBaseBranch, sourceRef: prBaseBranch });
        deps.log(`통합 브랜치(${prBaseBranch})를 원격에 올렸습니다 — 조각 PR 의 base 로 필요합니다`);
      }
    }
    // PR 은 원격 브랜치가 있어야 만들 수 있다 — 현재 HEAD(또는 workBranch)를 그 이름으로 올린다.
    // 세션은 PLAN/next_steps 지시대로 현재 브랜치(main 이든 topic 이든)에서 작업·커밋할 뿐, 그 이름의
    // 브랜치를 만들거나 push 하지 않으므로 여기서 하네스가 대신 해야 한다.
    await pr.pushBranch({ cwd, branch: headBranch, sourceRef: pushSourceRef });
    // §47 — PR 본문의 본체는 세션이 쓴 설명이다. 신뢰 경계 밖 텍스트가 **외부(GitHub)로
    // 나가는 지점**이므로 maskSecrets 를 반드시 거친다(세션이 읽은 비밀이 섞였을 수 있다).
    // 커밋 목록·파일별 증감은 본문에 싣지 않는다 — GitHub 의 Commits / Files changed 탭이
    // 이미 보여주므로 본문에 다시 적으면 리뷰어가 읽어야 할 글이 그만큼 밀려난다.
    const lastPhaseSession = [...phase.sessions].reverse().find(s2 => s2.kind === "phase");
    const diffRange = `${prBaseBranch}..${pushSourceRef ?? "HEAD"}`;

    // 예산 실측(D13/D14). PR 본문에서는 뺐지만 **신호까지 없앤 것은 아니다** — 이건 리뷰어가
    // 아니라 운영자에게 필요한 정보라 실행 로그로 보낸다("다음 워크플로우에서 예산이나 분해
    // 품질을 조정할 근거"). 넘어도 막지 않는다(D13 — 목표지 상한이 아니다).
    //
    // 비교 대상은 **리뷰 대상 라인만**이다. 기록용 워크플로우 문서를 합산하면 "조각이 크다"는
    // 신호가 문서 분량에 오염된다(D14). 조회 실패는 조용히 0 으로 접지 않고 넘어간다 —
    // 실패를 "예산 안에 들어왔다"로 읽히게 하지 않는다.
    const budgetLines = state.review_split?.budget_lines;
    if (budgetLines !== undefined) {
      const numstat = await gitExec(["diff", "--numstat", "-z", "--no-renames", diffRange], cwd);
      if (numstat.ok) {
        const rel = path.relative(cwd, workflowDir);
        const workflowDirRel =
          rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : null;
        const d = classifyReviewDiff(parseNumstatZ(numstat.stdout), workflowDirRel);
        if (d.reviewLines > budgetLines) {
          deps.log(
            `조각 크기: 리뷰 대상 ${d.reviewLines}줄이 목표(${budgetLines}줄)를 넘었습니다 — ` +
              "진행은 막지 않습니다" +
              (d.recordLines > 0 ? ` (기록용 문서 ${d.recordLines}줄은 뺀 수치입니다).` : "."),
          );
        }
      }
    }

    // split_group 은 Phase 4(분해 세션)가 채운다. 아직 분해되지 않은 phase 도 조각 분해가
    // 켜져 있으면 조각 PR 이므로 1/1 로 싣는다 — "이 PR 이 통합 브랜치로 간다"는 사실이
    // 리뷰어에게 보여야 한다.
    const slice = slicing
      ? {
          seq: phase.slice_seq!,
          index: phase.split_group?.index ?? 1,
          total: phase.split_group?.total ?? 1,
          originId: phase.split_group?.origin_id ?? phase.id,
        }
      : undefined;
    // 세션 요약은 신뢰 경계 밖 텍스트이고 이 본문은 외부(GitHub)로 나간다 — 조립 함수에
    // 넘기기 **전에** 마스킹한다(buildPrBody 는 순수 조립만 하고 마스킹하지 않는다).
    const summaryMasked = lastPhaseSession?.summary ? maskSecrets(lastPhaseSession.summary) : null;

    // 읽는 순서를 **순서(본문)** 와 **위치+이유(코드 위 인라인)** 로 가른다.
    // 앵커(몇 번째 줄)는 diff 에서만 뽑는다 — 세션이 쓴 "193번째 줄 근처"는 검증할 수 없는
    // 추측이고, GHE 3.19 실측에서 diff 밖의 줄이 하나라도 있으면 422 로 **인라인 코멘트
    // 전체가 거부**된다(전부-아니면-전무). 추측을 API 인자로 승격시키지 않는다.
    // 세션 출처 텍스트는 GitHub 으로 나가므로 여기서 한 번 마스킹하고, 그 결과를 본문과
    // 인라인이 함께 쓴다(마스킹 지점을 둘로 늘리면 한쪽을 빠뜨린다 — §30 P1).
    const reviewOrderMasked = lastPhaseSession?.review_order?.map(line => maskSecrets(line)) ?? [];
    const u0 = await gitExec(["diff", "-U0", "--no-renames", diffRange], cwd);
    if (!u0.ok && reviewOrderMasked.length > 0) {
      deps.log(
        `diff 조회 실패로 읽는 순서를 코드에 붙이지 못합니다 — 본문 목록으로만 남깁니다: ` +
          u0.stderr.trim().slice(0, 200),
      );
    }
    const reviewPlan = planReviewOrder(reviewOrderMasked, u0.ok ? parseDiffAnchors(u0.stdout) : []);
    // 인라인이 실패했을 때 대신 남길 전문. 앵커 없이 계획하면 이유까지 담긴 목록이 나온다 —
    // 같은 함수를 쓰므로 번호·개행 처리가 본문과 어긋나지 않는다.
    const fullOrderLines = planReviewOrder(reviewOrderMasked, []).bodyLines;

    const ref = await pr.createPr({
      cwd, headBranch, baseBranch: prBaseBranch,
      title: buildPrTitle({ workflow: state.workflow, phaseId: phase.id, phaseTitle: phase.title, slice }),
      body: buildPrBody({
        baseBranch: prBaseBranch,
        sessionSummaryMasked: summaryMasked,
        slice,
        reviewOrderLines: reviewPlan.bodyLines,
        hasInlineReviewGuide: reviewPlan.comments.length > 0,
      }),
    });
    phase.pr = { number: ref.number, url: ref.url, head_branch: headBranch, handled_comment_keys: [], fix_sessions: 0 };
    phase.status = "in_review";
    saveState(workflowDir, state);
    deps.log(`PR 생성: ${ref.url}`);

    // 읽는 순서를 코드 위에 올린다. **PR 기록을 저장한 뒤에** 한다 — 여기서 실패해도 PR 번호가
    // STATE 에 남아 재개 시 같은 PR 을 또 만들지 않는다.
    if (reviewPlan.comments.length > 0) {
      try {
        await pr.postReviewComments({
          cwd,
          number: ref.number,
          comments: reviewPlan.comments,
          intro: "읽는 순서를 각 파일의 변경 지점에 인라인으로 남겼습니다 — 본문 목록의 번호와 같습니다.",
        });
        deps.log(`읽는 순서를 코드에 인라인으로 남겼습니다 (${reviewPlan.comments.length}건)`);
      } catch (err) {
        // fail-open 이지만 **조용히 넘어가면 안 된다**: 본문에는 경로만 남기고 이유를 인라인에
        // 실었으므로, 실패를 접으면 리뷰어가 이유를 어디서도 볼 수 없다. 전문을 일반 코멘트로
        // 대신 남겨 정보가 사라지지 않게 한다(§30 P4 — 못 했다를 했다로 접지 않는다).
        deps.log(`인라인 코멘트 실패 — 읽는 순서를 일반 코멘트로 남깁니다: ${(err as Error).message}`);
        try {
          await pr.postPrComment({
            cwd,
            number: ref.number,
            body: ["## 읽는 순서 (무인 세션 제안)", ...fullOrderLines].join("\n"),
          });
        } catch (err2) {
          deps.log(`읽는 순서 코멘트도 실패했습니다: ${(err2 as Error).message}`);
        }
      }
    }
  } else {
    // 재실행/재개로 새 커밋이 생겼을 수 있다 — 폴링 전에 동기화한다. 이게 없으면 리뷰어가
    // 낡은 코드를 보고 머지하는데 하네스는 done 을 보고한다 (§25 D). pushBranch 는
    // --force-with-lease 라 새 커밋이 없으면 no-op 에 가깝다.
    //
    // **단, PR 상태를 먼저 본다.** 위 근거는 "아직 리뷰될 수 있는 PR" 에만 성립한다. 이미
    // 머지·닫힌 PR 에 push 할 이유는 없는데, 무조건 push 하면 실전에서 **재개가 영구히
    // 막힌다**(실전 통주 실측). **머지된 PR 의 head 브랜치는 사라지기 쉽다** — GHE 는 머지
    // 직후 모든 PR 에 "Delete branch" 버튼을 띄우고(실측된 경로다: 이 리포는
    // delete_branch_on_merge 가 꺼져 있는데도 브랜치가 없어졌다), 리포 설정으로 자동 삭제를
    // 켜둔 곳도 있다. 그 브랜치가 원격에 없으면 --force-with-lease 가 `stale info` 로 거부하고
    // 게이트가 예외로 죽어 머지를 끝내 감지하지 못한다. retryPhase 는 phase.pr 이 있으면
    // in_review 로 되살리므로(중복 PR 방지) 재시도해도 같은 지점에서 다시 죽는다.
    //
    // push 실패를 try/catch 로 삼키는 쪽을 택하지 않은 것은 의도다 — 그러면 열린 PR 의
    // 동기화 실패까지 조용히 넘어가 §25 D 가 막으려던 상황(리뷰어가 낡은 코드를 본다)이
    // 그대로 돌아온다. 방어가 무의미해진 상태(머지·닫힘)만 정확히 골라 건너뛴다.
    //
    // 판정을 위해 PR 상태를 **따로 조회하지 않는다.** 바로 아래 폴링 루프가 첫 바퀴에서 이미
    // 같은 사실을 가져오므로, 여기서 한 번 더 부르면 같은 조회가 두 곳에 살게 된다(§30 P1).
    // 그래서 동기화를 루프 안 "PR 이 열려 있다고 판정된 지점" 으로 옮겼다 — 아래 needsSync 참고.
    needsSync = true;
  }

  const prRef = phase.pr;
  for (;;) {
    const view = await withRetry(() => pr.viewPr({ cwd, number: prRef.number }), deps, "PR 상태 조회");
    // 하트비트(§25 과제3) — 정상 폴링은 완전 무음이라 며칠 도는 프로세스가 살아있는지 멈춘 건지
    // 로그만으로 구분이 안 됐다. 매 폴링 성공마다 시각을 기록해 `fw status` 에서 확인할 수 있게 한다.
    prRef.last_polled_at = deps.now();
    saveState(workflowDir, state);
    if (view.merged) {
      deps.log(`PR #${prRef.number} 머지 확인`);
      // §26 M5: 다음 phase 가 있고 격리 브랜치를 하네스가 소유하고 있으면, squash/rebase 머지로 인한
      // phase 간 커밋 누적을 끊기 위해 갱신된 base 위로 재생성을 시도한다(안전 가드 실패 시 퇴화).
      // pr-slicing D18: 조각 PR 이 통합 브랜치로 머지됐으면 로컬 통합 브랜치를 강제 없는
      // fast-forward 로 전진시킨다(다음 조각이 낡은 기준에서 갈라지지 않게). 조각 분해가
      // 꺼져 있으면 옛 경로(격리 브랜치를 base 위로 재생성)를 그대로 쓴다 — 두 경로는 서로
      // 다른 토폴로지를 담당하므로 하나로 합치지 않는다.
      if (slicing) {
        await advanceIntegrationBranchAfterMerge({
          cwd, integrationBranch: state.integration_branch!, git: gitExec, log: deps.log,
        });
      } else {
        await refreshIsolationBranchAfterMerge(state, phase, workBranch, prRef.head_branch, deps);
      }
      return "done";
    }
    if (view.state === "CLOSED") {
      deps.notify("fw FAILED", `PR #${prRef.number} 이 머지 없이 닫혔습니다`);
      return "failed";
    }

    // 여기까지 왔다는 것은 PR 이 **열려 있다**는 뜻이다 — 재개 시 동기화를 할 자리가 정확히
    // 여기다(§25 D). 위 두 분기가 머지·닫힘을 이미 걷어냈으므로, 원격에서 사라진 head
    // 브랜치에 push 하다 게이트가 죽는 일이 구조적으로 일어나지 않는다. 코멘트 조회보다
    // 먼저 해서, 이 바퀴에서 처리할 지적이 최신 코드를 기준으로 판정되게 한다.
    if (needsSync) {
      await pr.pushBranch({ cwd, branch: prRef.head_branch, sourceRef: pushSourceRef });
      needsSync = false;
      deps.log(`PR #${prRef.number} 브랜치 동기화`);
    }

    // §29 MI-10: pr_comment_mode="off" 는 "PR 만 만들고 코멘트는 처리하지 않겠다"는 명시적
    // 의사다(§26 I6 이 만든 "빈 trusted_comment_authors = 시작 거부"의 정당한 탈출구).
    // 코멘트 조회 자체를 건너뛴다 — 어차피 쓰지 않을 응답에 GHE API 왕복을 쓰지 않는다.
    // 폴링은 계속한다: merged/CLOSED/approve 감지는 코멘트와 무관하게 필요하다.
    const commentMode = state.pr_comment_mode ?? "trusted";
    const comments =
      commentMode === "off"
        ? []
        : await withRetry(() => pr.listComments({ cwd, number: prRef.number }), deps, "PR 코멘트 조회");
    // 자기 답글 배제는 신원(login)이 아니라 센티널로 한다 (C2 — 하네스는 사람 계정으로 답글을 단다)
    // §24 감사 T1: 마커는 "나에게 한 말인가"만 정하므로, 사내 GHE 에서 리포 읽기 권한자 누구나
    // 트리거를 걸 수 있었다. trusted_comment_authors 로 "말할 자격이 있는가"까지 걸러낸다.
    const trustedAuthors = state.trusted_comment_authors;
    const actionable = selectActionableComments(comments, { handled: prRef.handled_comment_keys, trustedAuthors });

    // fail-closed 로 조용히 버리면 사용자가 왜 하네스가 반응하지 않는지 알 방법이 없다 — 무시된
    // 트리거 코멘트가 있으면 로그로 알린다.
    const untrusted = selectUntrustedTriggerComments(comments, { handled: prRef.handled_comment_keys, trustedAuthors });
    if (untrusted.length > 0) {
      const sampleAuthors = [...new Set(untrusted.map(c => c.author))].slice(0, 5).join(", ");
      deps.log(
        `신뢰되지 않은 작성자의 트리거 코멘트 ${untrusted.length}건 무시(${sampleAuthors} 등). ` +
        "STATE 의 trusted_comment_authors 에 추가하세요",
      );
    }

    if (actionable.length > 0) {
      // 실전 스모크 결함: 트리거 코멘트를 전부 모아 한 fix 세션에 넘기면, 세션이 일부만
      // 반영·커밋·push 한 채 나머지에서 blocked 를 반환할 수 있다. 그 경우 배치 전체가
      // 처리되지 않은 것으로 취급돼 답글(감사 추적)도 handled 기록도 안 남고, 재개 시 이미
      // 반영한 코멘트를 다시 처리하는 중복 작업이 발생한다. fix 세션 자체(코멘트별 유료 세션
      // 호출)는 여전히 1건씩 독립 실행한다.
      deps.log(`트리거 코멘트 ${actionable.length}건 감지 — 1건씩 처리한다`);

      // §29 MI-11: 게이트(전체 verify 스위트)는 코멘트 1건마다가 아니라 이 배치(현재 폴링에서
      // 감지된 actionable 전체 중 연속으로 성공한 구간)의 마지막에 1회만 돌린다. 실측(§29 감사):
      // 코멘트 5건 → GATE 6회, pushBranch 6회 — max_fix_sessions 기본 10이면 리뷰 1라운드에 최대
      // 11회 전체 테스트(+10개 유료 세션)가 직렬로 돈다(스위트 8분이면 88분). CR-3 의 커밋
      // 존재/신규성/도달성 검증은 코멘트별로 그대로 유지한다 — git 명령 몇 개라 싸고, 비용 폭발의
      // 원인이 아니다.
      //
      // 트레이드오프 판단(요청된 근거 기록): 코멘트 1·2·3 을 한 배치로 묶어 게이트를 1번만 돌리면
      // "3번째 반영이 실은 게이트를 깼는데 1·2번은 이미 handled" 상황 자체가 아예 생기지 않는다
      // — 배치 전체가 게이트를 통과해야만 전부 handled 로 확정되므로(all-or-nothing) 코멘트별
      // 즉시 게이트보다 오히려 원자성이 더 강하다. 반대급부는 "1번은 사실 멀쩡한데 3번 때문에
      // 1번도 재작업(다음 폴링에서 재시도) 대상이 된다"는 되돌림 비용인데, 무인 야간 주행에서는
      // 유료 세션을 코멘트 수만큼 반복 태우는 쪽보다 훨씬 싸다(재시도는 fw retry 없이 다음 폴링이
      // 자동으로 다시 시도한다 — handled 로 기록되지 않았으므로). 단, blocked/failed/검증 실패로
      // 배치가 중간에 끊기면 그 시점까지 pending(이미 done + 커밋 검증 통과)한 항목은 즉시
      // flush 해 "부분 성공 보존"(실전 스모크 결함 학습, §26) 을 그대로 유지한다.
      const fixCommands = verifyCommandsFor(state, phase);
      const guardedFixFiles = verifyReferencedFiles(fixCommands);
      // §36 §30 P4: sessionIndex 를 함께 들고 다닌다 — 이 배치의 최종 판정(accepted/bounced)은
      // flushPending 이 게이트를 다 돌린 "뒤"에야 정해지는데, phase.sessions 에는 이미 각 fix
      // 세션이 push 돼 있다(개별 세션 실행 직후). 배치가 통과/실패했을 때 그 세션들 각각에
      // 소급 적용하려면 어느 phase.sessions 원소인지가 필요하다 — recordVerdict(phase, verdict,
      // sessionIndex) 의 sessionIndex 인자가 정확히 이 용도다.
      // issue #3: noChange — 세션이 already_applied(추가 커밋 없음, 근거 SHA 검증 통과)로 끝난 항목.
      // 배치 전체가 noChange 면 위조 가드·게이트를 건너뛴다(변경이 없는데 8분짜리 스위트를 돌릴 이유가
      // 없다). 하나라도 실제 커밋이 있으면 배치 전체가 평소처럼 게이트를 받는다.
      const pending: Array<{ comment: RawComment; result: PhaseSessionResult; sessionIndex: number; noChange: boolean }> = [];
      // issue #3 제안 2: 직전 실행이 처리하던 중 중단된 코멘트 키(이 폴링 시작 시점 스냅샷). 아래
      // 루프가 새 키를 추가하기 전에 잡아야 "이번 실행이 방금 기록한 키"와 섞이지 않는다.
      const resumedKeys = new Set(prRef.in_flight_comment_keys ?? []);

      // pending 배치를 게이트에 태워 확정(push+handled+답글)하거나 실패로 되돌린다. pending 이
      // 비어 있으면 아무 것도 하지 않는다(게이트를 돌릴 대상이 없으면 비용을 쓰지 않는다).
      const flushPending = async (): Promise<"ok" | "failed"> => {
        if (pending.length === 0) return "ok";
        const keys = pending.map(p => commentKey(p.comment)).join(", ");
        const allNoChange = pending.every(p => p.noChange);
        if (allNoChange) {
          deps.log(`Phase ${phase.id}: fix 배치(${keys}) 는 추가 커밋이 없는 already_applied 만이라 위조 가드·게이트를 건너뜁니다`);
        }
        let fixFailureSummary: string | null = null;
        // §36 §30 P4: fixFailureSummary 가 어느 방어에서 왔는지(위조 가드 vs 게이트)를 구조적으로
        // 구분해 verdict.reason 에 그대로 쓴다 — 문자열을 다시 스니핑하지 않는다(§30 P3).
        // §tamper-gap P1/P5: "changed_files_untrustworthy" — git 은 성공했지만 출력 구조를 신뢰할
        // 수 없는 경우(U+FFFD 감지) 를 실제 확인된 verify_tampered 와 별도 reason 으로 구분한다.
        let fixFailureReason: "verify_tampered" | "gate_failed" | "changed_files_untrustworthy" | null = null;
        // §z-parse D1/D2: verify_tampered 사유의 STATE detail 은 gate_failed 와 다른 표기(한 줄에
        // 하나씩 displayPath, char-slice 없음)를 쓴다 — 그러려면 원본 tampered 배열을 이 배치
        // 스코프까지 들고 나와야 한다(아래 try 블록 안에서만 계산되던 지역 변수였다).
        let tamperedFiles: string[] = [];
        // §tamper-gap: changed_files_untrustworthy 사유의 STATE detail/PR 코멘트가 원인 경로를
        // 표시하려면 마찬가지로 배치 스코프까지 들고 나와야 한다.
        let untrustworthyPaths: string[] = [];

        // 위조 가드 — fix 세션도 phase 세션과 마찬가지로 verify 대상 파일을 고칠 수 있다. 기준점은
        // 이 phase 최초 실행에서 고정한 verify_guard_baseline_sha 를 그대로 쓴다(§24/§26 C3 와 동일
        // 원칙 — attempt/세션마다 기준점을 다시 잡으면 위조 세탁이 가능해진다). 배치 전체의 누적
        // diff 를 한 번에 검사하므로 배치 내 어느 코멘트가 위조했든 잡아낸다.
        if (!allNoChange && guardedFixFiles.length > 0 && !phase.allow_verify_file_changes && phase.verify_guard_baseline_sha) {
          try {
            const result = await (deps.changedFiles ?? defaultChangedFiles)(cwd, phase.verify_guard_baseline_sha);
            if (!result.ok) {
              // §tamper-gap P1/P2/P5: orchestrator.ts 와 동일 원칙 — 인프라 오류(아래 catch,
              // fail-open 유지)와 분리된 별도 fail-closed 분기. prloop 의 PR 공개 코멘트로 나갈 수
              // 있으므로 사실 확인 전 "위조"/"변조" 단정 표현을 절대 쓰지 않는다(P5 — 공개 비난 금지).
              untrustworthyPaths = result.paths;
              fixFailureSummary =
                "변경 파일 목록을 신뢰할 수 없어 안전하게 정지했습니다 (디코딩 결과에 잘못된 문자가 포함된 " +
                "경로가 있습니다, 각 줄 JSON 문자열 리터럴):\n" +
                result.paths.map(displayPath).join("\n") +
                "\n\n이 경로가 이번 배치에서 만들어졌다면 제거하거나 올바른 이름으로 바꾼 뒤 다시 시도하세요.";
              fixFailureReason = "changed_files_untrustworthy";
              deps.log(
                `Phase ${phase.id}: fix 배치(${keys}) 변경 파일 목록 파싱 이상(U+FFFD) — ${JSON.stringify(result.paths)}`,
              );
            } else {
              const changed = result.files;
              // §z-parse D11/P13: orchestrator.ts 와 동일 원칙 — 비교 지점에서만 로컬로
              // normalizeGitSourcePath(무unquote·무trim)를 적용한다. 변수 공유 없음.
              const normalizedChanged = new Set(changed.map(normalizeGitSourcePath));
              const tampered = guardedFixFiles.filter(g => normalizedChanged.has(normalizeGitSourcePath(g)));
              if (tampered.length > 0) {
                tamperedFiles = tampered;
                // §tamper-gap P4/D8: formatGuardedFileLines(branch.ts, orchestrator.ts 와 공유)로
                // 파일별 실제 상태(수정 vs 이동/삭제)를 반영한 라벨을 붙인다.
                // §z-parse D1/D2: orchestrator.ts:273-281 과 동일 원칙 — 경로 블록을 프로즈보다 먼저
                // 배치하고 각 경로를 displayPath(JSON 리터럴)로 가역 표기한다.
                const lines = formatGuardedFileLines(cwd, tampered);
                fixFailureSummary =
                  "검증 대상 파일 상태가 바뀌었습니다 (각 줄 상태 라벨 + JSON 문자열 리터럴):\n" +
                  lines.join("\n") +
                  "\n\n검증 스크립트/빌드 설정을 바꾸거나 이동/삭제하면 게이트 판정을 신뢰할 수 없습니다. " +
                  "의도적으로 검증 설정을 바꿔야 한다면 STATE.json 의 phase.allow_verify_file_changes 를 " +
                  "true 로 설정해 이 검사를 옵트아웃할 수 있습니다.";
                fixFailureReason = "verify_tampered";
                // §z-parse D5: log() 는 runlog(줄 단위 tail)로 가므로 물리 한 줄 유지 —
                // JSON.stringify(배열) 하나의 리터럴로 남긴다.
                deps.log(`Phase ${phase.id}: fix 배치(${keys}) 검증 대상 파일 상태 변경 감지 — ${JSON.stringify(tampered)}`);
              }
            }
          } catch (err) {
            deps.log(`fix 세션 검증 대상 파일 변경 확인 실패(건너뜀): ${(err as Error).message}`);
          }
        }

        // 게이트 재실행 — fix 배치의 커밋도 phase 커밋과 동일하게 검증을 통과해야 한다. 로그 경로는
        // phase 검증 로그와 구분한다.
        if (fixFailureSummary === null && !allNoChange) {
          const fixLogFile = path.join(workflowDir, "logs", `phase-${phase.id}-fix-${prRef.fix_sessions}.log`);
          phase.last_log = fixLogFile;
          saveState(workflowDir, state);
          const fixGate = await deps.gate({
            commands: fixCommands, cwd, logFile: fixLogFile,
            timeoutMs: state.verify_timeout_ms ?? undefined,
          });
          if (!fixGate.passed) {
            const fatal = fixGate.results.find(r => r.fatal);
            fixFailureSummary = fatal
              ? `검증 명령 자체 오류: ${fatal.command}`
              : "검증 실패:\n" +
                fixGate.results.map(r => `$ ${r.command} (exit ${r.exitCode})\n${r.output.slice(-2000)}`).join("\n") +
                `\n\n전체 로그: ${fixLogFile}`;
            fixFailureReason = "gate_failed";
          }
        }

        if (fixFailureSummary !== null) {
          // §36 §30 P4: 배치 전체가 거부됐으므로 pending 에 들어있던 세션 전부에 같은 판정을
          // 소급 적용한다 — 각 세션은 개별적으로는 done/커밋 검증을 통과했지만, 배치 게이트가
          // 실패하면 결국 handled 로 확정되지 못한다(§30 P4: "통과가 곧 이행을 뜻하지 않는다").
          // fixFailureReason 이 null 일 수 없다 — fixFailureSummary 를 채우는 두 분기(위조/게이트)
          // 모두 함께 채운다(TypeScript 는 이를 모르므로 no-op 폴백만 둔다).
          const reason = fixFailureReason ?? "gate_failed";
          // §z-parse D2/실제 소스 확인 2항: verify_tampered 는 char-slice 없이 각 경로를 한 줄에
          // 하나씩(JSON 리터럴)로 남긴다 — 500자 슬라이스가 JSON 리터럴 중간을 잘라 닫히지 않은
          // 이스케이프가 남는 표시 손상을 막는다(정확히 이번 작업이 없애려는 성질). gate_failed 는
          // 게이트 출력 텍스트라 이번 범위 밖 — 기존 500자 슬라이스 그대로 둔다.
          // §tamper-gap P4/P5: verify_tampered 는 formatGuardedFileLines(수정 vs 이동/삭제 라벨)로,
          // changed_files_untrustworthy 는 별도 reason·중립 문구(원인 경로만, "위조"/"변조" 미포함)로
          // 구분한다 — 셋 다 char-slice 없이 표시한다.
          const detail =
            reason === "verify_tampered" ? formatGuardedFileLines(cwd, tamperedFiles).join("\n")
            : reason === "changed_files_untrustworthy" ? untrustworthyPaths.map(displayPath).join("\n")
            : fixFailureSummary.slice(0, 500);
          for (const p of pending) {
            recordVerdict(phase, { outcome: "bounced", reason, detail }, p.sessionIndex);
          }
          // 반영이 완결되지 않았으므로 배치 전체를 handled 로 기록하지 않는다 — 다음 폴링에서
          // 재시도된다(fix_sessions 카운터는 코멘트별로 이미 증가했으므로 무한 루프는 안 된다).
          //
          // §pr-comment-mask D1: postPrComment 는 외부 공개 지점(GitHub 로 나가는 텍스트) — §47 이
          // createPr 본문만 마스킹하고 이 코멘트 경로를 빠뜨린 재발(§30 P1)을 막기 위해 body 조립
          // 시점에 반드시 maskSecrets 를 거친다. gate_failed 텍스트는 게이트 출력(로그)이라 비밀이
          // 섞여 나올 수 있다 — 먼저 마스킹한 뒤 truncateForDisplay 로 자른다(반대 순서면 절단이
          // 토큰 중간을 잘라 마스킹 정규식이 매치하지 못한 절반이 그대로 노출될 수 있다).
          // D3: verify_tampered 는 위 detail 과 동일하게 항목 경계(줄 단위, JSON 리터럴)로 표기한
          // tamperedFiles 를 그대로 쓴다 — char-slice 로 다시 잘라 리터럴을 손상시키지 않는다.
          // 이 분기는 하네스가 만든 경로 목록이라 비밀이 섞일 가능성은 낮지만, 최종 body 를 한 번 더
          // maskSecrets 로 감싸 "이 분기는 안전하니 예외" 라는 판단을 코드에 남기지 않는다(D1 —
          // 예외 없음, §30 P1: 그런 개별 판단이 쌓이면 결국 한 곳이 빠진다).
          const commentSummary =
            reason === "verify_tampered"
              ? `검증 대상 파일 상태가 바뀌었습니다:\n${truncateListForDisplay(formatGuardedFileLines(cwd, tamperedFiles), 500)}`
              : reason === "changed_files_untrustworthy"
              ? `변경 파일 목록을 신뢰할 수 없어 안전하게 정지했습니다:\n${truncateListForDisplay(untrustworthyPaths.map(displayPath), 500)}`
              : truncateForDisplay(maskSecrets(fixFailureSummary), 500);
          try {
            await pr.postPrComment({
              cwd, number: prRef.number,
              body: maskSecrets(`⚠️ ${keys} 반영했으나 검증 실패: ${commentSummary}`),
            });
          } catch (err) {
            deps.log(`답글 게시 실패(무시): ${(err as Error).message}`);
          }
          deps.log(`Phase ${phase.id}: fix 배치(${keys}) 검증 실패 — handled 로 기록하지 않습니다.`);
          deps.notify("fw FAILED", `PR #${prRef.number} ${keys} fix 검증 실패: ${fixFailureSummary.slice(0, 300)}`);
          pending.length = 0;
          return "failed";
        }

        // §36 §30 P4: 배치가 게이트/가드를 통과했다 — pending 의 세션 전부를 accepted 로 확정한다.
        // push/handled 기록보다 먼저 정해도 안전하다(이 시점 이후로는 실패 분기가 없다 — 아래
        // pushBranch 가 throw 하면 runPrGate 의 catch-all 이 흡수해 failed 로 정리하지만, 그건
        // "판정 자체가 틀렸다"는 뜻이 아니라 반영 확정의 다음 단계(전송)가 실패했다는 뜻이라
        // verdict 를 되돌리지 않는다 — gate.ts/pr.ts 전반의 "로그는 부산물, 판정이 제품" 원칙과
        // 동일하게 다룬다).
        for (const p of pending) {
          // issue #3: already_applied 로 확정된 세션은 accepted 이되 "추가 커밋 없음"을 detail 로 남겨
          // fw report 가 실제 반영 세션과 구분할 수 있게 한다(outcome 을 늘리지 않는다 — report.ts 의
          // accepted/bounced 집계 계약을 그대로 유지).
          recordVerdict(
            phase,
            p.noChange
              ? { outcome: "accepted", detail: `already_applied — 근거 커밋: ${p.result.commits.join(", ")}` }
              : { outcome: "accepted" },
            p.sessionIndex,
          );
        }

        // 게이트/가드 통과 — 원격에 push 해야 리뷰어가 실제 변경을 본다(§26 I3 핵심 결함). handled
        // 기록·답글보다 먼저 해야, push 가 실패(throw)할 때 "push 안 됐는데 처리됨"으로 확정되지
        // 않는다(throw 는 runPrGate 의 catch-all 이 흡수해 failed 로 정리한다). §29 CR-2: sourceRef
        // 로 workBranch 를 명시해 HEAD 가 아니라 작업 브랜치 자신의 tip 을 push 한다.
        // §36 후속: `workBranch ?? undefined` 를 여기서 다시 계산하지 않고 위(:114)에서 한 번
        // 계산한 pushSourceRef 를 쓴다 — 같은 판정을 두 곳에서 하면 한쪽만 고쳤을 때 조용히
        // 갈린다(§30 P1). Q6 mutation 이 :114 만 건드려 이 줄을 검증 범위 밖에 두고 있었다.
        await pr.pushBranch({ cwd, branch: prRef.head_branch, sourceRef: pushSourceRef });

        // 진실(처리 완료)을 먼저 확정한다 — 답글은 부산물이므로 실패해도 판정을 흔들면 안 된다 (C2).
        for (const { comment, result, noChange } of pending) {
          const key = commentKey(comment);
          prRef.handled_comment_keys.push(key);
          // issue #3 제안 2: handled 가 진실로 확정된 순간 in_flight 힌트는 소용을 다했다 — 같은 saveState 로 지운다.
          prRef.in_flight_comment_keys = (prRef.in_flight_comment_keys ?? []).filter(k => k !== key);
          saveState(workflowDir, state);
          // §pr-comment-mask D1/D2: result.summary 는 세션이 작성한 요약이라 신뢰 경계 밖 텍스트다
          // — 마스킹 먼저, 절단은 표기가 남는 truncateForDisplay 로(위 gate_failed 분기와 동일 순서
          // 원칙). result.commits 는 verifySessionCommits 로 존재·신규성·도달성이 검증된 SHA 뿐이라
          // 마스킹 대상이 아니다.
          // issue #4 — 항목별 결과를 답글에 그대로 싣는다. addressed 는 위 가드가 비어 있지 않음을 보장
          // 했지만 타입상 optional 이라 방어적으로 처리한다. declined 가 하나라도 있으면 코멘트 작성자를
          // 멘션해 명시적 확인을 요청한다 — "반영했습니다" 한 줄 뒤에 부분 반영이 숨는 것이 이 이슈의 핵심.
          const items = result.addressed ?? [];
          const itemBlock = items.length > 0 ? `\n항목별:\n${formatAddressedLines(items).join("\n")}` : "";
          const mention = items.some(a => a.status === "declined") ? mentionFor(comment.author) : null;
          const askBlock = mention ? `\n${mention} 반영하지 않은 항목이 있습니다 — 확인 부탁드립니다.` : "";
          try {
            await pr.postPrComment({
              cwd, number: prRef.number,
              body: noChange
                ? `✅ ${key} 이미 반영됨 (추가 커밋 없음): ${truncateForDisplay(maskSecrets(result.summary), 500)}${itemBlock}\n근거 커밋: ${result.commits.join(", ")}${askBlock}`
                : `✅ ${key} 반영: ${truncateForDisplay(maskSecrets(result.summary), 500)}${itemBlock}${result.commits.length ? `\n커밋: ${result.commits.join(", ")}` : ""}${askBlock}`,
            });
          } catch (err) {
            deps.log(`답글 게시 실패(무시): ${(err as Error).message}`);
          }
        }
        pending.length = 0;
        return "ok";
      };

      for (const comment of actionable) {
        // §27 O2/O3 체크포인트 ②: 새 fix 세션(=새 유료 세션)을 띄우기 직전. max_fix_sessions
        // 상한 검사와 동일한 "부분 성공 보존" 패턴 — 이미 확보된 pending 은 flush 해 보존한다.
        // §31 I8: checkHaltpoint 가 true 를 반환하면(=STOP/상한 감지, state 는 이미 halted 로
        // 저장됨) flush 결과와 무관하게 "halted" 를 유지한다. 수정 전에는 flush(배치 게이트)가
        // 실패하면 여기서 "failed" 를 반환해 호출부가 state.status 를 failed 로 덮어써
        // status="failed"+halt_reason="operator" 라는 모순 상태를 만들었다(실측, §31 감사) —
        // 그 결과 운영자가 STOP 만 눌렀는데 `fw retry` 를 요구받았다(설계: halted 는 그냥
        // `fw run` 으로 재개). flush 실패 사실 자체는 flushPending() 이 이미 로그·PR 답글·
        // notify("fw FAILED") 로 남기므로 여기서는 상태만 지킨다.
        if (checkHaltpoint(workflowDir, state, deps, runStartedAt)) {
          const flushResult = await flushPending();
          if (flushResult === "failed") {
            deps.log(`Phase ${phase.id}: 정지 시점 pending 배치 flush 실패 — halted 상태는 그대로 유지합니다.`);
          }
          return "halted";
        }
        // 상한 검사는 매 건마다, 카운터 증가 전에 — 무인 하네스에 "무기한 폴링 + 상한 없는
        // 유료 세션" 이 공존해선 안 된다 (C2-2). 상한 초과로 중단하기 전에 이미 확보된 pending
        // 은 flush 해 보존한다("부분 성공 보존").
        if (prRef.fix_sessions >= state.max_fix_sessions) {
          // §31 C1 과 동일한 결함 형태(flush 실패가 자기 사유를 지운다) — flush 성공 여부와
          // 무관하게 "상한 초과" 자체는 항상 notify 한다.
          const flushResult = await flushPending();
          const flushNote = flushResult === "failed" ? " (또한 직전 배치 flush 도 실패 — 로그 참조)" : "";
          deps.notify("fw FAILED", `PR #${prRef.number} fix 세션 상한(${state.max_fix_sessions}) 초과${flushNote}`);
          return "failed";
        }
        prRef.fix_sessions += 1;
        // issue #3 제안 2: 세션을 띄우기 "직전"에 마커를 디스크에 남긴다 — 이 다음 어느 지점에서 죽어도
        // (세션 실행 중, 게이트 중, push 중) 재개 시 이 코멘트가 "처리 중이었음"으로 보인다. handled
        // 확정(flushPending) 때 지우고, blocked/failed/회송으로 끝나면 그대로 남아 다음 실행이 힌트를 받는다.
        const thisKey = commentKey(comment);
        prRef.in_flight_comment_keys = [...new Set([...(prRef.in_flight_comment_keys ?? []), thisKey])];
        saveState(workflowDir, state);
        deps.log(`  ${thisKey} → fix 세션 (${prRef.fix_sessions}/${state.max_fix_sessions})${resumedKeys.has(thisKey) ? " [직전 실행 중단 재개]" : ""}`);

        // §29 CR-2/CR-3: fix 세션이 무엇을 했는지 검증하려면 그 세션 실행 "직전" HEAD 가 필요하다
        // (phase 세션과 동일한 계약 — headBefore 이후 커밋인지 확인해야 "아무 것도 안 하고 기존
        // SHA 를 재보고" 하는 우회를 막는다).
        const headBeforeFix = await (deps.headSha ?? defaultHeadSha)(state.repo_root);

        const input: FixPromptInput = {
          workflowDir, phase, prNumber: prRef.number, comments: [comment],
          answers: state.answers,   // B-1: 이전 질문의 답을 fix 세션에도 주입 — 안 그러면 같은 질문을 반복한다
          nonce: nonce(),   // 코멘트 본문이 데이터 영역을 탈출하지 못하게 (C4)
          interruptedPreviously: resumedKeys.has(thisKey),   // issue #3 제안 2
        };
        // §68: phase 세션과 동일하게 workBranch 를 넘긴다 — fix 세션도 작업 브랜치에 커밋 후
        // push(pr_mode 는 fw/phase-<id> 헤드지만, 세션이 작업 브랜치 자체를 push 하는 경로 보존).
        const result = await deps.runner.runFixSession(input, policyFor(state, phase, workflowDir, originHost, workBranch));
        // §25 과제3: fix 세션이 STATE 에 전혀 기록되지 않아 PR 왕복이 몇 번 돌았는지 STATE 만으로
        // 재구성할 수 없었다. phase.sessions 에 kind:"fix" 로 남긴다(이후 saveState 호출들이
        // 이 mutation 을 함께 디스크에 반영한다 — blocked/done/failed 각 분기 참조).
        phase.sessions.push({
          session_id: result.sessionId ?? "unknown",
          result: result.status,
          summary: result.summary.slice(0, 1000),
          at: deps.now(),
          kind: "fix",
          cost_usd: result.costUsd,
          // §43 — 범위 밖 발견 사항 (§30 P1 — phase/verify 와 동일하게 세 경로 전부 기록).
          findings: result.findings,
          // issue #4 — 코멘트 항목별 처리 결과(감사 추적 원본).
          addressed: result.addressed,
        });

        if (result.status === "blocked") {
          // §36 §30 P4: 세션의 자기 주장(질문)과 별개로 하네스의 판정도 남긴다 — phase 루프의
          // session_blocked 와 동일한 계약(recordVerdict 는 sessionIndex 생략 시 방금 push 한
          // 마지막 원소를 가리킨다).
          recordVerdict(phase, { outcome: "session_blocked" });
          // §31 C1: 이 코멘트만 사람에게 넘긴다 — 앞서 처리한 건들은 flush 로 답글·handled
          // 기록을 확정한다. **수정 전에는 flush 가 실패하면(배치 게이트 실패 등) 여기서 즉시
          // "failed" 를 반환해 아래의 pending_question 세팅에 영원히 도달하지 못했다**(실측,
          // §31 감사 — 트리거 2건, 1건 성공 후 2건째 blocked, 배치 게이트 실패 → 세션의 질문이
          // notify·PR 답글·런로그·STATE 어디에도 남지 않고 유료 세션 1건만 소모됨). flush 결과는
          // 질문과 별개의 "함께 발생한 사실"로 덧붙일 뿐, 질문 자체가 사라지는 경로는 없어야
          // 한다 — phase 루프의 브랜치 이탈 패턴과 동일(surfaceBlockedQuestion, §30 P1).
          const flushResult = await flushPending();
          surfaceBlockedQuestion(
            workflowDir, state, phase, `${commentKey(comment)}: ${result.question ?? "(질문 누락)"}`,
            flushResult === "failed" ? ["이전 코멘트 배치 반영 확정(flush) 실패 — 로그를 확인하세요."] : [],
            deps, `PR #${prRef.number}: `,
          );
          return "blocked";
        }
        if (result.status === "failed") {
          // §36 §30 P4: 세션이 스스로 실패를 보고했다 — 하네스가 검증할 done 주장 자체가 없다.
          recordVerdict(phase, { outcome: "session_failed", detail: result.summary.slice(0, 500) });
          // §31 C1 과 동일한 결함 형태 — flush 실패 여부와 무관하게 이 코멘트 자신의 실패
          // 사유(답글·notify)는 항상 남긴다. flush 실패는 별도 사실로 notify 에 덧붙인다.
          const flushResult = await flushPending();
          // C2: 답글은 부산물이다 — 게시가 실패해도 (이미 FAILED 로 확정되는) 판정 자체를
          // 흔들거나, 이 실패 알림을 "PR 게이트 오류"라는 다른 메시지로 뒤덮어선 안 된다.
          // §pr-comment-mask D1/D2: result.summary 는 세션 자기 보고 텍스트 — 마스킹 먼저, 표기가
          // 남는 truncateForDisplay 로 자른다(위 두 postPrComment 호출과 동일 원칙).
          try {
            await pr.postPrComment({
              cwd, number: prRef.number,
              body: `⚠️ ${commentKey(comment)} 반영 실패: ${truncateForDisplay(maskSecrets(result.summary), 500)}`,
            });
          } catch (err) {
            deps.log(`답글 게시 실패(무시): ${(err as Error).message}`);
          }
          const flushNote = flushResult === "failed" ? " (또한 직전 배치 flush 도 실패 — 로그 참조)" : "";
          deps.notify("fw FAILED", `PR #${prRef.number} 리뷰 반영 실패: ${result.summary}${flushNote}`);
          return "failed";
        }

        // §29 CR-2/CR-3: fix 세션이 "done" 을 주장해도 phase 세션과 동일한 방어 2종을 거쳐야
        // "반영됨"으로 확정할 수 있다 — ①격리/토픽 브랜치 이탈 감시 ②커밋 존재/신규성/도달성
        // 검증. 이전에는 fix 경로에 둘 다 없어(§29 감사 실측) main 으로 이탈해 커밋해도, 심지어
        // 커밋 0개인 채로도 그대로 "반영" 판정을 받았다. checkBranchDrift/verifySessionCommits
        // 공통 함수 참조 — phase 루프와 복붙하면 다음 라운드에 또 갈리므로(§29 교훈) 여기서도
        // 같은 함수를 호출한다.
        //
        // issue #3: status:"already_applied" 는 "추가 커밋 없음" 의 정직한 보고다 — 이전에는 이 어휘가
        // 없어 세션이 done+commits:[] 로 보고할 수밖에 없었고 그게 no_commits 회송 → 워크플로우 FAILED
        // 로 떨어졌다(실측 2회: 겹치는 리뷰 코멘트, 커밋·push 후 중단 재개). 이제는 근거 SHA 를
        // verifyAlreadyAppliedCommits(실존·PR 브랜치 도달성·base 미포함)로 검증해 통과하면 handled 로
        // 확정하고 정상 진행한다. "세션의 주장을 믿지 않는다"는 원칙은 그대로다 — 검증 대상이
        // "새 커밋"에서 "근거 커밋"으로 바뀔 뿐이다. 도달성의 기준은 실제로 PR 로 push 되는 ref
        // (pushSourceRef ?? HEAD — 위 push 호출들과 같은 값)다.
        const noChange = result.status === "already_applied";
        const branchDrift = await checkBranchDrift(cwd, workBranch, gitExec);
        // issue #4: 커밋 검증 "앞"에 항목별 보고 유무를 본다 — 커밋이 있어도 코멘트의 지적 일부를
        // 조용히 넘긴 세션(실측: 두 문장 중 첫 문장만 반영)을 "커밋이 있으니 통과"로 확정하지 않기
        // 위해서다. 하네스는 항목 수를 셀 수 없으므로(자연어) 내용은 검증하지 않고, "항목 추출 자체를
        // 안 함"(addressed 비어 있음)만 잡는다. 이후 답글이 항목별 결과를 그대로 실어 리뷰어가 본다.
        const itemsReported = !!result.addressed && result.addressed.length > 0;
        const guardOutcome = !branchDrift.ok
          ? branchDrift
          : !itemsReported
            ? {
                ok: false as const,
                problem:
                  "코멘트의 요구/지적을 항목별로 보고하지 않았습니다(addressed 비어 있음). 코멘트에서 개별 항목을 " +
                  "추출해 각각 applied/already_applied/declined/not_applicable 과 근거를 addressed 에 적은 뒤 다시 반환하세요.",
              }
          : noChange
            ? await verifyAlreadyAppliedCommits(cwd, pushSourceRef ?? "HEAD", prBaseBranch, result.commits, deps)
            : await verifySessionCommits(cwd, workBranch, headBeforeFix, result.commits, deps);
        if (!guardOutcome.ok) {
          // §36 §30 P4: branchDrift 가 먼저 실패했으면 그게 사유다(phase 루프와 동일 우선순위).
          // 아니면 verifySessionCommits 가 실패한 것이므로 result.commits 를 직접 보고 "커밋
          // 0건"과 "보고한 커밋이 신규/도달 불가"를 구조적으로 구분한다(문자열 스니핑 금지, §30 P3).
          // already_applied 의 근거 검증 실패는 별도 사유(already_applied_unverified)다.
          const reason = !branchDrift.ok
            ? "branch_drift"
            : !itemsReported ? "comment_items_unreported"
            : noChange ? "already_applied_unverified"
            : result.commits.length === 0 ? "no_commits" : "commit_verification_failed";
          recordVerdict(phase, { outcome: "bounced", reason, detail: guardOutcome.problem });
          // §31 C1 과 동일한 결함 형태 — flush 실패 여부와 무관하게 이 코멘트 자신의 가드 위반
          // 사유(답글·로그·notify)는 항상 남긴다. flush 실패는 별도 사실로 notify 에 덧붙인다.
          const flushResult = await flushPending();
          // §pr-comment-mask D1: guardOutcome.problem 자체는 하네스가 만든 진단 문구지만, D1 은
          // postPrComment 로 나가는 모든 body 에 예외 없이 maskSecrets 를 적용하기로 했다(§30 P1 —
          // "이 경로는 안전해 보인다"는 판단이 누적되면 결국 한 곳이 빠진다). 원문에 절단이 없었으므로
          // 여기서 새로 절단을 추가하지는 않는다.
          try {
            await pr.postPrComment({
              cwd, number: prRef.number,
              body: `⚠️ ${commentKey(comment)} 반영했으나 검증 실패: ${maskSecrets(guardOutcome.problem)}`,
            });
          } catch (err) {
            deps.log(`답글 게시 실패(무시): ${(err as Error).message}`);
          }
          deps.log(
            `Phase ${phase.id}: fix 세션(${commentKey(comment)}) 검증 실패 — handled 로 기록하지 않습니다: ` +
              guardOutcome.problem,
          );
          const flushNote = flushResult === "failed" ? " (또한 직전 배치 flush 도 실패 — 로그 참조)" : "";
          deps.notify(
            "fw FAILED",
            `PR #${prRef.number} ${commentKey(comment)} fix 검증 실패: ${guardOutcome.problem.slice(0, 300)}${flushNote}`,
          );
          return "failed";
        }

        // §36 §30 P4: 이 세션의 최종 판정(accepted 인지 배치 게이트에 막혀 bounced 인지)은 아직
        // 모른다 — flushPending 이 배치를 확정할 때 sessionIndex 로 소급 적용한다.
        pending.push({ comment, result, sessionIndex: phase.sessions.length - 1, noChange });
      }

      if ((await flushPending()) === "failed") return "failed";
      continue; // 전부 처리했으면 즉시 재확인 (새 코멘트가 왔을 수 있다)
    }

    if (view.reviewDecision === "APPROVED") {
      state.status = "awaiting_merge";
      saveState(workflowDir, state);
      deps.notify("fw 승인됨 ✅", `PR #${prRef.number} approve — 머지해주세요: ${prRef.url}`);
      return "awaiting_merge";
    }

    await sleep(state.poll_interval_ms);
    // §27 O2/O3 체크포인트 ③: sleep 직후, 다음 폴링(viewPr) 전. 무기한 폴링을 끊는 자리 —
    // 폴링(viewPr/listComments) 자체는 저렴한 조회라 죽이지 않고, "다음 대기"로 넘어가기 전에만
    // 멈춘다(§2 D17 — 새 걸음을 떼기 직전).
    if (checkHaltpoint(workflowDir, state, deps, runStartedAt)) return "halted";
  }
}

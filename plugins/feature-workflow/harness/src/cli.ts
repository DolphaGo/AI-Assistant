#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadState, saveState, answerQuestion, retryPhase, statePath, totalCostUsd, formatCostLine,
  resolveSandboxSettings, type State,
} from "./state.js";
import { runWorkflow, runVerificationStage } from "./orchestrator.js";
import { runGate } from "./gate.js";
import { notifier } from "./notify.js";
import { AgentSdkRunner } from "./session.js";
import { GhPrClient } from "./pr.js";
import { acquireLock, peekLiveLock, type LockInfo } from "./lock.js";
import {
  runDoctor, doctorHasProblems, formatDoctorReport,
  sandboxNeutralizationSignals, sandboxNeutralizationNotes, isSandboxNeutralized,
} from "./doctor.js";
import { getVersion } from "./index.js";
import { detectBaseBranch } from "./branch.js";
import { defaultGitExec } from "./preflight.js";
import { createRunLogger, listRunLogFiles, readLastLines, formatRunLog, type RunLogger, startSleepInhibitor } from "./runlog.js";
import { requestStop } from "./stop.js";
import { appendDecisionToPlan, nextDecisionId, type DecisionRow } from "./plan.js";
import { buildReport, formatReport } from "./report.js";
import {
  newInterview, loadInterview, saveInterview, interviewNext, applyAnswer, approveInterview,
  assemblePlan, advanceInterview, unansweredQuestions, INTERVIEW_FILE, INTERVIEW_ROLE_LABEL,
  MAX_INTERVIEW_SESSIONS,
} from "./interview.js";
import { InterviewAgentRunner } from "./session.js";

// §20 — totalCostUsd 는 state.ts 로 옮겨 cli.ts(fw status)와 runlog.ts(fw log)가 같은
// 계산식을 공유하게 했다. 기존 테스트/호출부가 "../src/cli.js" 에서 그대로 import 할 수 있도록
// 여기서 재수출한다(하위호환).
export { totalCostUsd };

// §46 — 인터뷰 현황 출력. 다음에 무엇을 해야 하는지(사람 차례인지)를 항상 마지막 줄에 남긴다.
function printInterviewStatus(iv: import("./interview.js").InterviewState): void {
  console.log("");
  console.log(`[인터뷰] 세션 ${iv.sessions_used}/${MAX_INTERVIEW_SESSIONS} · $${iv.cost_usd.toFixed(2)} · 상태 ${iv.status}`);
  for (const role of ["planning", "development", "evaluation"] as const) {
    console.log(`  ${INTERVIEW_ROLE_LABEL[role]} 초안: ${iv.drafts[role] ? "있음" : "없음"}`);
  }
  const action = interviewNext(iv);
  if (action.kind === "await_answers") {
    console.log(`\n❓ 답이 필요한 질문 ${action.unanswered.length}건:`);
    for (const q of action.unanswered) {
      console.log(`  [${q.id}/${INTERVIEW_ROLE_LABEL[q.role]}] ${q.question}`);
      if (q.why) console.log(`      (왜: ${q.why})`);
    }
    console.log(`\n답하기: fw interview-answer <dir> <ID> <답변> — 전부 답한 뒤 fw interview <dir> 재실행`);
  } else if (action.kind === "ready") {
    console.log("\n✅ 인터뷰 완료 조건 충족 (미답 0 · 초안 3 · 이의 0) — fw interview-approve <dir> 로 승인하면 PLAN.md 초안이 생성됩니다");
  } else if (action.kind === "objection_cap") {
    console.log(
      `\n⏸ 이의 라운드 상한(${action.rounds}회) 도달 — 초안 3개와 미답 0 상태입니다. 남은 판단은 사람 몫입니다:\n` +
        `   fw interview-approve <dir> --force 로 승인하면 마지막 이의 목록이 PLAN §미검증 승인 절에 남습니다.`,
    );
  } else if (action.kind === "session_cap") {
    console.log(`\n⏸ 세션 상한(${MAX_INTERVIEW_SESSIONS}) 도달 — 지금까지의 질문·초안으로 사람이 판단하세요 (INTERVIEW.json 참조)`);
  } else if (action.kind === "approved") {
    console.log("\n이미 승인된 인터뷰입니다.");
  }
}

const STATUS_ICON: Record<string, string> = {
  pending: "☐", in_progress: "▣", in_review: "◍", done: "☑", failed: "✗", blocked: "⊘",
};

// §27 O2/O3: 워크플로우 전역 상태(state.status) 아이콘 — phase 아이콘(STATUS_ICON)과는 다른
// 값 집합이다. halted 만 눈에 띄게 표시한다("운영자/상한이 멈춤, 이어서 돌리면 됨"을 blocked 와
// 시각적으로도 구분하기 위함) — 나머지 상태는 기존 출력 형식을 그대로 유지한다(표시 안 함).
const WORKFLOW_STATUS_ICON: Record<string, string> = { halted: "⏸ " };

// answer/retry 가 실행 중인 fw run 을 감지했을 때 띄우는 경고 문구. 차단하지 않고
// 경고만 한다(§17) — 순수 함수로 분리해 문구를 테스트한다.
export function formatLockWarning(live: LockInfo): string {
  return (
    `경고: PID ${live.pid} (시작 ${live.startedAt}) 의 fw run 이 이 워크플로우를 실행 중인 것으로 보입니다. ` +
    `지금 진행하면 실행 중인 하네스와 STATE.json 을 동시에 쓰게 되어 상태가 뒤집힐 수 있습니다.`
  );
}

// §27 O3: `fw stop` 이 출력하는 안내 문구 — formatLockWarning 과 같은 이유로 순수 함수로 분리해
// 테스트한다(커맨드 액션 자체는 fs 부작용 + console.log 뿐인 얇은 배선으로 남긴다).
export function formatStopMessage(live: LockInfo | null): string {
  return live
    ? `STOP 파일을 만들었습니다 — PID ${live.pid} (시작 ${live.startedAt}) 의 fw run 이 다음 체크포인트에서 ` +
        "정지합니다 (비용/시간 상한과 같은 자리 — 세션 도중에 죽이지 않습니다)."
    : "STOP 파일을 만들었습니다 — 하지만 지금 이 워크플로우를 실행 중인 fw run 프로세스가 감지되지 " +
        "않습니다. 다음 `fw run` 은 이 STOP 파일을 소비(삭제)하고 정상적으로 시작합니다.";
}

// §28 W2 — `fw answer` 가 BLOCKED 답변을 STATE.answers 뿐 아니라 PLAN.md §핵심 결정 표에도
// append 한다(설계 §28 "결정을 인터뷰 도중에 문서로 남긴다"). "결정" 셀 하나로 합칠 때 질문이
// 길면 표가 보기 힘들어지므로 각 조각을 별도로 잘라낸다.
const DECISION_CELL_PART_CAP = 120;

function truncateForCell(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

/** 질문+답변을 §핵심 결정 표의 "결정" 셀 한 줄로 합친다. 순수 함수. */
export function buildDecisionCellText(question: string, answer: string): string {
  return `${truncateForCell(question, DECISION_CELL_PART_CAP)} → ${truncateForCell(answer, DECISION_CELL_PART_CAP)}`;
}

/** appendAnswerDecision 의 결과 — 성공(recorded)이면 실제 부여된 ID 를 담는다. 각 분기가
 *  formatPlanAnswerMessage 에서 서로 다른 문구로 이어지도록 discriminated union 으로 둔다. */
export type PlanAnswerOutcome =
  | { kind: "recorded"; id: string }
  | { kind: "no-plan-file" }
  | { kind: "table-mismatch" }
  | { kind: "error"; message: string };

/**
 * BLOCKED 질문에 대한 답을 PLAN.md §핵심 결정 표에 append 한다. **실패해도 예외를 던지지
 * 않는다** — `fw answer` 의 본질은 STATE.answers 기록이고 PLAN 기록은 부산물이다(§25 C2
 * "진실 먼저, 부산물 나중"). 호출부는 이 결과를 사용자에게 보여주기만 하면 된다.
 */
export function appendAnswerDecision(
  dir: string,
  pending: { phase: number; question: string },
  answer: string,
  at: string,
): PlanAnswerOutcome {
  try {
    const planPath = path.join(dir, "PLAN.md");
    if (!fs.existsSync(planPath)) return { kind: "no-plan-file" };
    const markdown = fs.readFileSync(planPath, "utf-8");
    const id = nextDecisionId(markdown);
    const row: DecisionRow = {
      id,
      decision: buildDecisionCellText(pending.question, answer),
      rationale: `BLOCKED 질문에 대한 사용자 답변 (fw answer 자동 기록) — phase ${pending.phase}`,
      status: "accepted",
      date: at.slice(0, 10),
    };
    return appendDecisionToPlan(dir, row) ? { kind: "recorded", id } : { kind: "table-mismatch" };
  } catch (err) {
    return { kind: "error", message: (err as Error).message ?? String(err) };
  }
}

/** appendAnswerDecision 결과를 사람이 읽는 한 줄로. 성공/실패/스킵을 항상 사용자에게 보여준다
 *  (§30 P2 — 조용히 삼키지 않는다). */
export function formatPlanAnswerMessage(outcome: PlanAnswerOutcome): string {
  switch (outcome.kind) {
    case "recorded":
      return `PLAN.md §핵심 결정에 ${outcome.id} 로 기록했습니다`;
    case "no-plan-file":
      return "PLAN.md 가 없어 결정 기록을 건너뛰었습니다 (STATE 에는 기록됨)";
    case "table-mismatch":
      return "PLAN.md §핵심 결정 표 형식이 달라 기록하지 못했습니다 — 직접 추가하세요";
    case "error":
      return `PLAN.md 결정 기록 중 오류 (무시하고 계속합니다): ${outcome.message}`;
  }
}

// §41 C-3/§30 P1 — `fw doctor` 의 [샌드박스] 절과 같은 판정(sandboxNeutralizationSignals)을
// 공유한다. 두 표시면이 "활성"만 말하고 서로 다른 근거로 갈리면 §30 P1 여덟 번째 재발이다.
export function sandboxStatusLabel(state: State): string {
  const settings = resolveSandboxSettings(state);
  if (!settings) return "비활성";
  const signals = sandboxNeutralizationSignals(settings);
  if (!isSandboxNeutralized(signals)) return "활성";
  return `활성 (⚠ ${sandboxNeutralizationNotes(signals).join(", ")})`;
}

export function formatStatus(state: State): string {
  const lines = [
    `${WORKFLOW_STATUS_ICON[state.status] ?? ""}workflow: ${state.workflow}  [${state.status}]`,
    `repo: ${state.repo_root}`,
    // §37 T1/S3 — resolveSandboxSettings 를 재계산이 아니라 그대로 재사용한다(§30 P1: policyFor 와
    // 같은 판정 기준). 꺼짐은 기본값이라 문제로 표시하지 않는다(§30 P2) — 단순 관측.
    // §41 C-3 — "활성"만으로는 무력화(filesystem.disabled/와일드카드 도메인) 여부를 알 수 없었다.
    // sandboxStatusLabel 이 doctor.ts 와 같은 판정을 공유해 두 표시면이 갈리지 않게 한다.
    `샌드박스: ${sandboxStatusLabel(state)}`,
    formatCostLine(totalCostUsd(state), state.max_cost_usd),
    // §27 O2/O3: halted 는 blocked 와 달리 "왜 멈췄는지" 를 halt_reason 한 줄로 보여줘야 한다 —
    // pending_question 과 동일한 자리(요약 다음)에 둔다.
    ...(state.status === "halted" && state.halt_reason ? [`⏸ 정지 사유: ${state.halt_reason}`] : []),
    // pr-slicing: 조각 PR 들이 머지되는 통합 브랜치의 최종 PR(통합 브랜치 → base_branch). 아직
    // 만들어지지 않았으면(integration_pr 없음) 배열에 아무 것도 추가되지 않아 기존 lines 와
    // 바이트 단위로 동일하다 — PLAN §검증 기준 2/3(회귀 고정 · "통합 PR" 문구 미노출)의 근거.
    ...(state.integration_pr ? [`통합 PR: #${state.integration_pr.number} ${state.integration_pr.url}`] : []),
    "",
    ...state.phases.flatMap(p => {
      // §36 §30 P4 후속 — 세션의 자기 주장(result)만 보이던 자리에 하네스의 판정(verdict)도
      // 간단히 곁들인다. verdict 가 없는(레거시) 세션은 0건으로 취급돼 출력이 이전과 동일하다
      // (§30 P2 — 정상/기존 경로 회귀 방지). 0건이면 아예 표시하지 않아 평소엔 조용하다.
      const bounced = p.sessions.filter(s => s.verdict?.outcome === "bounced").length;
      const bouncedPart = bounced > 0 ? `, 회송 ${bounced}` : "";
      // pr-slicing: 조각으로 분해된 phase 는 "원본의 몇 번째 조각인지" 를 시도 표기 뒤에 덧붙인다.
      // split_group 이 없는(분해되지 않은) phase 는 splitPart 가 빈 문자열이라 아래 템플릿 결과가
      // 도입 전과 바이트 단위로 동일하다 — PLAN §검증 기준 2(회귀 고정)의 근거.
      const splitPart = p.split_group ? ` (조각 ${p.split_group.index}/${p.split_group.total})` : "";
      const lines = [`${STATUS_ICON[p.status]} Phase ${p.id}: ${p.title} (시도 ${p.attempts}/${p.max_attempts}${bouncedPart})${splitPart}`];
      // §26 M2: verify_file_changes_bypassed_at 은 "의도적 허용(allow_verify_file_changes)과 몰래
      // 위조를 구분"하려고 만든 감사 흔적인데 지금까지 어디에도 노출되지 않았다. 게이트 방어가
      // 의도적으로 낮춰진 상태라는 뜻이므로 조용히 한 줄 끼워넣지 않고 경고 톤으로 눈에 띄게 표시한다.
      if (p.verify_file_changes_bypassed_at) {
        lines.push(
          `   ⚠️  검증 파일 변경 허용됨 (allow_verify_file_changes) — ${p.verify_file_changes_bypassed_at}`,
        );
      }
      if (p.pr) lines.push(`   PR #${p.pr.number}: ${p.pr.url}`);
      // 하트비트(§25 과제3) — 정상 폴링은 무음이라 하네스가 살아있는지 멈춘 건지 로그만으론
      // 구분 안 됐다. in_review 인 동안 마지막 폴링 시각을 보여준다.
      if (p.status === "in_review" && p.pr?.last_polled_at) lines.push(`   마지막 폴링: ${p.pr.last_polled_at}`);
      if (p.status === "failed" && p.last_log) lines.push(`   로그: ${p.last_log}`);
      return lines;
    }),
  ];
  if (state.pending_question) {
    lines.push("", `❓ BLOCKED 질문 (Phase ${state.pending_question.phase}):`);
    lines.push(`   ${state.pending_question.question}`);
    lines.push(`   → fw answer <workflow-dir> "<답변>" 후 fw run 으로 재개`);
  }
  return lines.join("\n");
}

// baseBranch: pr-slicing PLAN D15 — 예전에는 "main" 하드코딩이었다. git flow 리포
// (develop ← feature/*)에서 그대로 두면 PR 이 통합 대상이 아닌 main 으로 가고, 조각 분해가
// 들어가면 잘못된 base 의 PR 이 phase 당 여러 개 생겨 피해가 배로 커진다. 호출부(`fw init`)가
// detectBaseBranch 결과를 넘긴다. 생략 시 "main" — 기존 호출부 하위호환.
export function initState(workflowDir: string, repoRoot: string, baseBranch = "main"): void {
  if (fs.existsSync(statePath(workflowDir))) {
    throw new Error(`STATE.json 이 이미 존재합니다: ${statePath(workflowDir)}`);
  }
  fs.mkdirSync(workflowDir, { recursive: true });
  const skeleton: State = {
    schema_version: 1,
    workflow: path.basename(path.resolve(workflowDir)),
    repo_root: repoRoot,
    branch_strategy: "isolate",
    allow_push: false,
    verify_default: [],
    pr_mode: false,
    poll_interval_ms: 60_000,
    base_branch: baseBranch,
    max_fix_sessions: 10,
    trusted_comment_authors: [],
    status: "running",
    // §27 O2/O3: halt_reason 은 zod `.default(null)` 라 State 출력 타입에서 필수 프로퍼티다
    // (pr_comment_mode 와 달리 `string | null` 로 고정하려고 optional 대신 default 를 택했다 —
    // state.ts 주석 참조) — 여기서 명시하지 않으면 컴파일이 깨진다.
    halt_reason: null,
    pending_question: null,
    answers: [],
    phases: [],
  };
  saveState(workflowDir, skeleton);
}

// §69: `docs/` 접두는 내부 구현 디테일 — 사용자는 워크플로우 이름만 치면 된다
// (`fw run writing-training` == `fw run docs/writing-training`). 규칙은 예측 가능하게 단순히:
//   - 경로 구분자 포함/절대경로/명시적 상대경로(`.`, `..`)면 기존 그대로 해석한다(하위호환 —
//     docs 밖의 커스텀 위치도 여전히 경로로 지정할 수 있다).
//   - 단독 이름이면: 현재 디렉토리의 `<이름>/STATE.json` 이 있으면 그 디렉토리(docs 안에서
//     실행하는 경우), 없으면 `docs/<이름>` 으로 해석한다. STATE.json 존재를 기준으로 삼는
//     이유: 이름과 같은 무관한 디렉토리(예: 소스 폴더)가 우연히 있어도 docs/ 쪽으로 가게 —
//     빈 디렉토리 존재만으로 워크플로우 탐색이 가로채지지 않는다.
// `fw init <이름>` 도 같은 규칙이라 docs/<이름> 에 생성된다 — 만든 곳과 찾는 곳이 항상 같다.
export function resolveWorkflowDir(arg: string): string {
  const bareName =
    !arg.includes("/") && !arg.includes(path.sep) && !path.isAbsolute(arg) && arg !== "." && arg !== "..";
  if (!bareName) return path.resolve(arg);
  const asIs = path.resolve(arg);
  if (fs.existsSync(path.join(asIs, "STATE.json"))) return asIs;
  return path.resolve("docs", arg);
}

// 테스트에서 import 될 때 CLI 가 실행되지 않도록 가드.
// basename 문자열 휴리스틱은 npm link 설치(심볼릭 링크 이름이 "fw")에서 깨진다 —
// argv[1] 은 심볼릭 링크를 안 풀지만 realpathSync 는 양쪽을 실제 경로로 정규화하므로
// "이 모듈이 직접 실행됐는가"를 정확히 판정할 수 있다.
const invokedDirectly = (() => {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

// 커맨드 등록은 invokedDirectly 여부와 무관하게 항상 수행한다 — `program.parse()` (실제 실행)만
// 가드 대상이다. Phase 2(fw report 배선 테스트)에서 "커맨드 등록" 자체(예: report 가 program.commands
// 에 있는지)와 각 액션의 출력 형식을 program.parseAsync 로 직접 구동해 검증하려면 program 인스턴스가
// 테스트에서 import 가능해야 한다 — 그래서 module-scope 로 export 한다. 커맨드 정의 자체는 fs/process
// 부작용이 없다(각 action 콜백 안에서만 발생하고, .action(...) 등록은 콜백을 실행하지 않는다).
//
// §36 m-5 — 예전에는 이 블록이 `.version(getVersion())` 을 직접 호출했다. getVersion() 자체는
// 매 호출마다 fs.readFileSync(package.json) 을 하는 순수 함수지만(index.ts), 이 블록은
// invokedDirectly 와 무관하게 **항상**(즉 cli.ts 를 import 만 해도) 실행되므로 "커맨드 정의는
// fs 부작용이 없다"는 이 주석의 전제를 그 한 줄만 깨고 있었다 — package.json 이 없는 환경에서
// cli.js 를 import 하기만 해도 ENOENT 로 죽는다(실측). 커밋 메시지·NOTES·VERIFY.md 세 곳 모두
// "부작용 없음/순수 리팩터링" 이라 적었으나 틀렸다.
//
// 고침: Commander.version(str) 의 내부 구현(`-V, --version` 옵션 등록 + "option:<name>" 리스너)을
// 그대로 재현하되, 버전 문자열을 실제로 `--version`/`-V` 가 파싱되는 시점에만 계산한다. 옵션
// 등록 자체(.option 호출)는 부작용이 없고, getVersion() 호출은 리스너 콜백 안으로 옮겨져
// import 시점이 아니라 파싱 시점에만 실행된다 — `fw --version` 동작은 그대로 유지된다.
export let program: Command;
{
  program = new Command();
  program.name("fw").description("feature-workflow 무인 하네스");
  program.option("-V, --version", "output the version number");
  program.on("option:version", () => {
    console.log(getVersion());
    process.exit(0);
  });

  program
    .command("run <workflowDir>")
    .description("STATE.json 기반 자율 주행 시작")
    .action(async (workflowDir: string) => {
      const dir = resolveWorkflowDir(workflowDir);

      // 동시 실행 가드(§17) — 이미 살아있는 fw run 이 같은 STATE.json 을 잡고 있으면
      // 여기서 거부한다. 실패는 기존 catch 와 동일하게 알림+exit 1 로 처리한다.
      let release: (() => void) | null;
      try {
        release = acquireLock(dir, () => new Date().toISOString());
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        notifier("fw FAILED", message.slice(0, 180));
        console.error(`\n실행 중단: ${message}`);
        process.exit(1);
        return;
      }

      // 정상 종료(아래 process.exit 호출)·미처리 예외·Ctrl-C(SIGINT)·kill(SIGTERM) 중
      // 어느 경로로 빠져나가든 Node 는 "exit" 이벤트를 동기적으로 발생시키므로,
      // 락 해제를 한 곳에 모아 크래시에도 락이 남지 않게 한다.
      process.on("exit", () => release?.());
      process.on("SIGINT", () => process.exit(130));
      process.on("SIGTERM", () => process.exit(143));

      // §20/§9 — deps.log 가 지금까지 console.log 로만 배선돼 터미널을 닫으면 소실됐다.
      // docs/<workflow>/logs/run-<ts>.log 에도 append 하는 로거로 교체한다. 락과 같은 방식으로
      // "exit" 에 close() 를 걸어 정상/예외/시그널 어느 경로로 빠져나가든 마지막 줄이 남게 한다.
      const runLogger: RunLogger = createRunLogger(dir, () => new Date().toISOString());
      process.on("exit", () => runLogger.close());
      // §59 — 밤새 주행 중 절전으로 세션이 죽는 실측 사고 방지 (darwin 한정, 실패해도 계속)
      startSleepInhibitor(runLogger.log);

      try {
        const state = await runWorkflow(dir, {
          // §27 O1: canUseTool 의 allow/deny 를 실행 로그에 남긴다. §29 CR-1(자격증명 유출이 실제로
          // 성립했던 사례)에서 "무엇이 실행됐는지 재구성할 수 없다" 가 실제 대가로 드러났다.
          // 세 번째 인자를 주지 않으면 감사 로그가 잠들어 있으므로 여기서 싱크를 주입한다.
          runner: new AgentSdkRunner(undefined, undefined, runLogger.log),
          gate: runGate,
          notify: notifier,
          now: () => new Date().toISOString(),
          log: runLogger.log,
          pr: new GhPrClient(),
        });
        console.log("\n" + formatStatus(state));
        console.log(`\n실행 로그: ${runLogger.path}`);
        // done: 0, awaiting_merge: 0(정상 정지 — 사람이 머지할 차례), 그 외: 1
        process.exit(state.status === "done" || state.status === "awaiting_merge" ? 0 : 1);
      } catch (err) {
        // runWorkflow 를 탈출한 throw(assertRunnable/saveState fs 오류 등)도
        // 반드시 알림과 함께 정지한다 — "완료 또는 알림과 함께 정지" 계약의 마감선
        const message = (err as Error).message ?? String(err);
        notifier("fw FAILED", message.slice(0, 180));
        console.error(`\n실행 중단: ${message}`);
        console.error(`실행 로그: ${runLogger.path}`);
        process.exit(1);
      }
    });

  // 동기 명령의 예외를 raw 스택트레이스 대신 명확한 메시지로 출력한다
  const guard = (fn: () => void) => () => {
    try {
      fn();
    } catch (err) {
      console.error((err as Error).message ?? String(err));
      process.exit(1);
    }
  };

  // guard 의 비동기 버전. 동기 guard 에 async 함수를 넘기면 rejection 이 잡히지 않고
  // unhandled 로 새 나가 종료 코드가 0 이 된다 — 실패가 성공으로 보인다. 오류 처리 계약
  // (메시지 출력 + exit 1)은 guard 와 반드시 같아야 하므로 복붙하지 않고 바로 옆에 둔다.
  const guardAsync = (fn: () => Promise<void>) => async () => {
    try {
      await fn();
    } catch (err) {
      console.error((err as Error).message ?? String(err));
      process.exit(1);
    }
  };

  // §27 O3 — 킬 스위치. `nohup`/백그라운드로 띄운 fw run 은 PID 를 몰라 시그널로 못 멈춘다.
  // STOP 파일을 만들어두면 살아있는 fw run 이 다음 체크포인트(§2 D17 — 새 걸음 떼기 직전)에서
  // 스스로 halted 로 정지한다. status/answer/retry 와 같은 정책(§17) — 락을 잡지 않는다
  // (관측·조작을 차단하지 않는다).
  // §56 — 완료된 워크플로우에 3역할 적대 검증 + 합의를 사후 실행. z-parse 통주에서 이
  // 단계가 비용 상한으로 통째로 생략된 실측이 계기다. runWorkflow 와 같은 구현
  // (runVerificationStage)을 공유한다 — 여기만의 검증 로직은 없다(§30 P1).
  program
    .command("verify <workflowDir>")
    .description("3역할 적대 검증 + 합의를 사후 실행해 VERIFY.md 를 갱신한다 (완료된 워크플로우 대상)")
    .option("--budget <usd>", "이 실행에 추가로 허용할 비용 상한(USD) — 현재 누적 비용에 더해진다", "10")
    .action(async (workflowDir: string, opts: { budget: string }) => {
      const dir = resolveWorkflowDir(workflowDir);
      let release: (() => void) | null;
      try {
        release = acquireLock(dir, () => new Date().toISOString());
      } catch (err) {
        console.error(`\n실행 중단: ${(err as Error).message}`);
        process.exit(1);
        return;
      }
      process.on("exit", () => release?.());
      const runLogger: RunLogger = createRunLogger(dir, () => new Date().toISOString());
      process.on("exit", () => runLogger.close());
      startSleepInhibitor(runLogger.log); // §59 — fw run 과 동일 (검증도 세션을 돌린다)
      try {
        const state = loadState(dir);
        if (state.phases.length === 0) throw new Error("phases 가 비어 있습니다 — 검증할 산출물이 없습니다");
        const budget = Number(opts.budget);
        if (!Number.isFinite(budget) || budget <= 0) throw new Error(`--budget 은 양수여야 합니다: ${opts.budget}`);
        const costCapUsd = totalCostUsd(state) + budget;
        await runVerificationStage(dir, state, {
          runner: new AgentSdkRunner(undefined, undefined, runLogger.log),
          gate: runGate,
          notify: notifier,
          now: () => new Date().toISOString(),
          log: runLogger.log,
          pr: new GhPrClient(),
        }, null, { costCapUsd });
        console.log(`\nVERIFY.md 갱신됨: ${path.join(dir, "VERIFY.md")}`);
        console.log(`실행 로그: ${runLogger.path}`);
        console.log("\n" + formatReport(buildReport(loadState(dir))));
        process.exit(0);
      } catch (err) {
        console.error(`\n검증 실행 중단: ${(err as Error).message}`);
        console.error(`실행 로그: ${runLogger.path}`);
        process.exit(1);
      }
    });

  program
    .command("stop <workflowDir>")
    .description("STOP 파일을 만들어 다음 체크포인트에서 정지하도록 요청 (킬 스위치)")
    .action((workflowDir: string) => guard(() => {
      const dir = resolveWorkflowDir(workflowDir);
      requestStop(dir, new Date().toISOString());
      console.log(formatStopMessage(peekLiveLock(dir)));
    })());

  program
    .command("status <workflowDir>")
    .description("현재 상태 출력")
    .action((workflowDir: string) => guard(() => {
      console.log(formatStatus(loadState(resolveWorkflowDir(workflowDir))));
    })());

  // answer/retry 는 실행 중인 STATE.json 을 건드릴 수 있으므로, 살아있는 fw run 이
  // 감지되면 경고만 하고 진행을 막지는 않는다 — 사용자가 의도적으로 개입하는 경우가 있다
  // (§17: status/answer/retry/init 은 락을 잡지 않는다 — 관측·조작을 차단하지 않는다).
  const warnIfLiveLock = (dir: string): void => {
    const live = peekLiveLock(dir);
    if (live) console.warn(formatLockWarning(live));
  };

  program
    .command("answer <workflowDir> <answer...>")
    .description("BLOCKED 질문에 답 기록")
    // §28 W2: 기본은 PLAN.md §핵심 결정 표에도 append 한다(grill-with-docs 취지 — 결정을
    // 문서로 남긴다). 자동 기록을 원치 않으면 --no-plan.
    .option("--no-plan", "PLAN.md §핵심 결정 표 자동 기록을 건너뛴다 (STATE 기록은 항상 수행)")
    .action((workflowDir: string, answerWords: string[], opts: { plan: boolean }) => guard(() => {
      const dir = resolveWorkflowDir(workflowDir);
      warnIfLiveLock(dir);
      const state = loadState(dir);
      // answerQuestion 이 state.pending_question 을 null 로 비우므로, PLAN 기록에 필요한
      // phase/question 정보는 그 전에 캡처해둔다.
      const pending = state.pending_question;
      const at = new Date().toISOString();
      const answerText = answerWords.join(" ");
      answerQuestion(state, answerText, at);
      saveState(dir, state);
      console.log("답변 기록 완료 — `fw run` 으로 재개하세요");

      if (opts.plan && pending) {
        console.log(formatPlanAnswerMessage(appendAnswerDecision(dir, pending, answerText, at)));
      }
    })());

  program
    .command("retry <workflowDir> <phaseId>")
    .description("failed phase 를 pending 으로 되살리고 attempts 초기화")
    .action((workflowDir: string, phaseId: string) => guard(() => {
      const dir = resolveWorkflowDir(workflowDir);
      warnIfLiveLock(dir);
      const id = Number(phaseId);
      if (!Number.isInteger(id)) {
        throw new Error(`phaseId 는 정수여야 합니다: ${phaseId}`);
      }
      const state = loadState(dir);
      retryPhase(state, id);
      saveState(dir, state);
      console.log(`Phase ${phaseId} 를 pending 으로 되돌렸습니다 — \`fw run\` 으로 재개하세요`);
    })());

  program
    .command("init <workflowDir>")
    .description("스켈레톤 STATE.json 생성 (phases 는 PLAN.md 기준으로 채울 것 — 채우기 전 fw run 은 시작 거부됨)")
    .option("--repo <path>", "대상 리포 루트", process.cwd())
    .action((workflowDir: string, opts: { repo: string }) => guardAsync(async () => {
      const repoRoot = path.resolve(opts.repo);
      // pr-slicing D15: base 브랜치를 감지해 넘긴다. 감지 근거를 반드시 출력한다 — 폴백
      // (감지 실패 → main)을 조용히 삼키면 git flow 리포에서 PR 이 엉뚱한 곳으로 가는 것을
      // 사용자가 PR 이 만들어진 뒤에야 알게 된다.
      const detected = await detectBaseBranch(repoRoot, defaultGitExec);
      initState(resolveWorkflowDir(workflowDir), repoRoot, detected.branch);
      console.log(`생성됨: ${resolveWorkflowDir(workflowDir)}/STATE.json — phases 를 채우세요`);
      console.log(`base_branch: ${detected.branch} — ${detected.reason}`);
    })());

  // §46 — 3역할 인터뷰. 종료 조건이 기계적이다: 미답 질문 0 + 초안 3 + 상호 이의 0 → ready.
  // 시작(목표·진입 경로)과 끝(승인)은 사람만 할 수 있다 — 에이전트는 가운데(질문 생성·초안·
  // 이의)만 맡는다.
  program
    .command("interview <workflowDir>")
    .description("3역할(기획/개발/평가) 인터뷰를 진행한다 — 질문이 나오면 멈추고, fw interview-answer 로 답한 뒤 재실행")
    .option("--goal <text>", "목표 (INTERVIEW.json 이 없을 때 필수 — 새 인터뷰 시작)")
    .option("--entry <paths>", "(선택) 코드 진입 경로를 이미 알면 미리 지정 (쉼표 구분) — 없으면 개발 고수가 인터뷰에서 물어 확정한다")
    .option("--repo <path>", "대상 리포 루트", process.cwd())
    .action(async (workflowDir: string, opts: { goal?: string; entry?: string; repo: string }) => {
      const dir = resolveWorkflowDir(workflowDir);
      const file = path.join(dir, INTERVIEW_FILE);
      let iv;
      if (!fs.existsSync(file)) {
        if (!opts.goal) {
          console.error("INTERVIEW.json 이 없습니다. 새 인터뷰는 --goal 로 시작하세요:");
          console.error('  fw interview <dir> --goal "이루려는 것 한두 문장" --entry src/a.ts,src/b.ts');
          process.exitCode = 1;
          return;
        }
        fs.mkdirSync(dir, { recursive: true });
        iv = newInterview(opts.goal, opts.entry ? opts.entry.split(",").map(x => x.trim()).filter(Boolean) : []);
        saveInterview(dir, iv);
        console.log(`인터뷰 시작: ${file}`);
      } else {
        iv = loadInterview(dir);
        if (opts.goal) {
          console.error("이미 진행 중인 인터뷰가 있습니다 — --goal 은 무시됩니다 (목표 변경은 새 디렉토리에서).");
        }
      }
      const runner = new InterviewAgentRunner(
        { repoRoot: path.resolve(opts.repo), verifyCommands: [], allowPush: false },
        undefined,
        msg => console.log(`  ${msg}`),
      );
      iv = await advanceInterview(dir, iv, runner, () => new Date().toISOString(), msg => console.log(msg));
      printInterviewStatus(iv);
    });

  program
    .command("interview-answer <workflowDir> <questionId> <answer...>")
    .description("인터뷰 질문에 답한다 (예: fw interview-answer docs/wf P1 '기존 API 호환 유지')")
    .action((workflowDir: string, questionId: string, answerWords: string[]) => guard(() => {
      const dir = resolveWorkflowDir(workflowDir);
      const iv = applyAnswer(loadInterview(dir), questionId, answerWords.join(" "), new Date().toISOString());
      saveInterview(dir, iv);
      const remaining = unansweredQuestions(iv);
      console.log(`${questionId} 답변 기록됨.` + (remaining.length > 0
        ? ` 남은 질문 ${remaining.length}건 — fw interview-answer 로 마저 답하세요.`
        : " 미답 질문 없음 — fw interview 를 다시 실행해 다음 단계로 진행하세요."));
    })());

  program
    .command("interview-approve <workflowDir>")
    .description("ready 상태의 인터뷰를 승인해 PLAN.md 초안을 생성한다 (기존 PLAN.md 가 있으면 거부)")
    // §50 — 이의 라운드 미수렴 시 사람이 마무리하는 탈출구. 미해소 이견은 PLAN §미해소 이견 절에 남는다.
    .option("--force", "이의 미수렴 상태에서 사람 권한으로 승인 (세 초안·미답 0 필수, 미해소 이견은 PLAN 에 기록)")
    .action((workflowDir: string, opts: { force?: boolean }) => guard(() => {
      const dir = resolveWorkflowDir(workflowDir);
      const planPath = path.join(dir, "PLAN.md");
      // 기존 PLAN 을 조용히 덮어쓰는 것은 파괴적이다 — 사람이 직접 지우고 다시 실행해야 한다.
      if (fs.existsSync(planPath)) {
        throw new Error(`PLAN.md 가 이미 있습니다: ${planPath} — 덮어쓰지 않습니다. 필요하면 직접 지우고 재실행하세요.`);
      }
      const iv = approveInterview(loadInterview(dir), { force: opts.force === true });
      fs.writeFileSync(planPath, assemblePlan(iv));
      saveInterview(dir, iv);
      console.log(`승인됨 — PLAN.md 초안 생성: ${planPath}`);
      console.log("다음 단계: ① PLAN.md 의 Phase 표를 채우고 ② fw init 으로 STATE 를 만들고 ③ fw run");
    })());

  // §18 — 게이트 신뢰성 실측. 락은 잡지 않는다(읽기+정적 검사 위주)지만, 기본 동작이 verify
  // 명령을 실제로 1회 실행하므로 대상 리포에 빌드/테스트 부작용(캐시 생성 등)이 남을 수 있다.
  // --no-run 으로 그 실행을 건너뛰고 정적 검사·프리플라이트·STATE 불변식만 볼 수 있다.
  program
    .command("doctor <workflowDir>")
    .description("게이트 신뢰성 점검 — verify 명령 정적 검사 + 프리플라이트 + STATE 불변식 + (기본) 실측 실행")
    .option("--no-run", "verify 명령을 실제로 실행하지 않고 정적 검사만 수행")
    .action(async (workflowDir: string, opts: { run: boolean }) => {
      const dir = resolveWorkflowDir(workflowDir);
      try {
        const report = await runDoctor(dir, { run: opts.run });
        console.log(formatDoctorReport(report));
        process.exit(doctorHasProblems(report) ? 1 : 0);
      } catch (err) {
        console.error((err as Error).message ?? String(err));
        process.exit(1);
      }
    });

  // §20 — 무인으로 밤새 돌린 뒤 "무슨 일이 있었나"를 STATE.json 원본을 열지 않고 한 화면에.
  // status 와 같은 락 정책(관측은 막지 않음) — 락을 잡지 않는다.
  program
    .command("log <workflowDir>")
    .description("STATE.json 요약 + 세션 이력 + 실행 로그 파일 목록을 한 화면에 출력")
    .option("--last <n>", "가장 최근 run 로그 파일의 마지막 N 줄도 함께 출력", (v: string) => Number(v))
    .action((workflowDir: string, opts: { last?: number }) => guard(() => {
      const dir = resolveWorkflowDir(workflowDir);
      const state = loadState(dir); // 디렉토리/STATE.json 이 없거나 깨졌으면 여기서 명확한 메시지로 throw
      const logFiles = listRunLogFiles(dir);
      let tail: { n: number; lines: string[] } | undefined;
      if (typeof opts.last === "number" && Number.isFinite(opts.last) && opts.last > 0 && logFiles.length > 0) {
        tail = { n: opts.last, lines: readLastLines(logFiles[0]!, opts.last) };
      }
      console.log(formatRunLog(state, logFiles, tail));
    })());

  // §34 T2 — "게이트가 통과했다"는 알아도 "잘 돌아갔는가"는 몰랐다. buildReport/formatReport
  // (report.ts, Phase 1) 는 STATE 만으로 판단 재료를 계산하는 순수 함수라 이 액션은 그대로
  // loadState → buildReport → formatReport → console.log 로 얇게 배선한다(PLAN D3). log/status
  // 와 같은 락 정책 — 관측용이라 락을 잡지 않는다(§17).
  program
    .command("report <workflowDir>")
    .description("완주/진행 중 워크플로우의 attempts·세션·비용 등 판단 재료를 집계해 출력 (§34 T2)")
    .action((workflowDir: string) => guard(() => {
      const dir = resolveWorkflowDir(workflowDir);
      const state = loadState(dir); // 디렉토리/STATE.json 이 없거나 깨졌으면 여기서 명확한 메시지로 throw
      console.log(formatReport(buildReport(state)));
    })());

  if (invokedDirectly) {
    program.parse();
  }
}

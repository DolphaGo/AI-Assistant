import fs from "node:fs";
import path from "node:path";
import {
  loadState, saveState, selectNextPhase, verifyCommandsFor, allPhasesDone,
  assertRunnable, recordVerdict, totalCostUsd, type State,
} from "./state.js";
import { readPlanContext } from "./plan.js";
import { selectVerifyRoles, VERIFY_ROLE_LABEL, type ConsensusInput } from "./session.js";
import { policyFor } from "./permissions.js";
import { verifyReferencedFiles, normalizeGitSourcePath } from "./gate.js";
import { displayPath } from "./paths.js";
import { preflight, defaultGitExec, defaultGhExec } from "./preflight.js";
import { consumeStopFile } from "./stop.js";
import type { OrchestratorDeps } from "./orchestrator-types.js";
import {
  applyBranchStrategy, checkBranchDrift, verifySessionCommits, defaultHeadSha, defaultChangedFiles,
  formatGuardedFileLines, createSliceBranch,
} from "./branch.js";
import { checkHaltpoint } from "./halt.js";
import { validateSliceProposals, applyDecomposition } from "./decompose.js";
import { runPrGate, surfaceBlockedQuestion, runIntegrationPrGate } from "./prloop.js";

// §25 리팩토링(엔지니어링 감사 — "runWorkflow 162줄 + runPrGateInner 112줄, 파일의 48%가 PR
// 코드"): 이 파일은 phase 루프(runWorkflow)만 남기고 브랜치 전략/이탈 감시/커밋 검증은
// branch.ts 로, PR 게이트 전체는 prloop.ts 로, 상한·킬 스위치 체크포인트는 halt.ts 로 옮겼다
// (순수 이동 — 로직 변경 없음). cli.ts 는 이 파일에서 runWorkflow 만 import 하지만, 기존에
// 이 파일이 공개해 온 타입/함수(OrchestratorDeps, CommitCheck, defaultHeadSha, defaultVerifyCommit,
// defaultBranchReachable, defaultChangedFiles)는 테스트가 직접 import 하므로 그대로 재수출한다.
export type { OrchestratorDeps, CommitCheck } from "./orchestrator-types.js";
export { defaultHeadSha, defaultVerifyCommit, defaultBranchReachable, defaultChangedFiles } from "./branch.js";

export async function runWorkflow(workflowDir: string, deps: OrchestratorDeps): Promise<State> {
  // §27 O2: 이 fw run 실행의 벽시계 기준점. 함수 진입 시각을 deps.now() 로 고정해 이후 모든
  // max_runtime_ms 비교가 이 값을 기준으로 삼는다.
  const runStartedAt = deps.now();
  const state = loadState(workflowDir);
  if (state.status === "blocked") {
    deps.log("BLOCKED 상태입니다 — `fw answer` 로 답한 뒤 다시 실행하세요");
    return state;
  }
  if (state.status === "done") {
    deps.log("이미 완료된 워크플로우입니다");
    return state;
  }
  assertRunnable(state); // 불변식 위반(phase 없음/교착/verify 없음/failed 잔존) 시 시작 거부

  // §27 O3: `fw run` 시작 시 STOP 이 남아있으면 소비(삭제)한다 — "이번엔 새로 돌리겠다"는 명시적
  // 의사표시다. 조용히 지우면 사용자가 만든 파일이 말없이 사라지는 셈이라 반드시 로그로 알린다.
  // halted(상한/이전 STOP)로 멈췄던 워크플로우를 재개할 때도 이 경로를 타므로, halted 는 거부
  // 없이 재개 가능해야 한다는 설계(§2 D 표)와 맞물린다.
  if (consumeStopFile(workflowDir)) {
    deps.log("STOP 파일을 발견해 소비(삭제)했습니다 — 새 실행 의사로 간주하고 계속 진행합니다.");
  }

  // §19: 프리플라이트 — repo_root 존재·git 저장소 여부·워킹트리 청결·(pr_mode 면) gh 인증을
  // 확인한다. 여기서 걸러지지 않으면 세션이 더러운 워킹트리나 존재하지 않는 리포에서 커밋 게이트가
  // 오염된 채로 밤새 돌게 된다.
  const gitExec = deps.git ?? defaultGitExec;
  const ghExec = deps.gh ?? defaultGhExec;
  // §26 C1: workflowDir 을 넘겨 그 서브트리(STATE.json/.fw.lock/logs/)를 워킹트리 청결 검사에서
  // 제외한다 — 안 그러면 saveState() 가 매 attempt 마다 STATE.json 을 다시 써 첫 실행 이후 모든
  // 재개가 이 검사에서 거부된다.
  const pre = await preflight(state, { git: gitExec, gh: ghExec, checkIgnoreGit: deps.checkIgnoreGit }, workflowDir);
  if (!pre.ok) {
    state.status = "failed";
    saveState(workflowDir, state);
    const detail = pre.problems.map((p, i) => `${i + 1}. ${p}`).join("\n");
    deps.log(`프리플라이트 실패:\n${detail}`);
    deps.notify(
      "fw FAILED",
      `프리플라이트 실패 — ${pre.problems[0]}${pre.problems.length > 1 ? ` (외 ${pre.problems.length - 1}건, 로그 참조)` : ""}`,
    );
    return state;
  }

  // §36 I-3: 프리플라이트가 **통과했지만 방어를 낮춘 채** 통과한 경우(현재는
  // allow_untracked_logs 옵트아웃) 그 사실을 런로그에 남긴다. 조용히 건너뛰면 밤새 무인으로
  // 돌린 뒤 "왜 로그가 커밋됐지" 를 사후에 재구성할 수 없다 — §32 가 allow_claude_md_changes
  // 에서 남긴 것과 같은 부채가 새 노브에서 반복되던 것이다(§30 P4).
  for (const w of pre.warnings) deps.log(`⚠ ${w}`);

  // §19/§26 C2/I4: 브랜치 격리 — branch_strategy 에 따라 base_branch 에서 그대로 커밋하지 않도록 한다.
  const branchCheck = await applyBranchStrategy(
    state,
    { currentBranch: pre.currentBranch, detached: pre.detached },
    { git: gitExec, log: deps.log },
  );
  if (!branchCheck.ok) {
    state.status = "failed";
    saveState(workflowDir, state);
    deps.log(`브랜치 정책 실패: ${branchCheck.problem}`);
    deps.notify("fw FAILED", branchCheck.problem.slice(0, 300));
    return state;
  }
  // §26 C2: isolate/require-topic 일 때만 세션이 머물러야 하는 브랜치를 기억한다(phase 실행 컨텍스트
  // 지역 변수 — STATE 에는 남기지 않는다). git checkout/switch 는 세션에 허용된 명령이라, 매 세션
  // 실행 직후 이 값과 실제 HEAD 를 대조해야 격리가 attempt 내내 유지된다.
  const workBranch = branchCheck.workBranch;

  // pr-slicing D1/D2: applyBranchStrategy 가 확정한 브랜치가 곧 **통합 브랜치**다 — 조각 PR 이
  // 머지되어 쌓이는 곳. 조각 브랜치는 이 이름에서 파생되므로(D3) STATE 에 기록해 조각 PR·통합
  // PR 이 같은 값을 보게 한다. workBranch 가 null 인 경우(branch_strategy="current")는 기록하지
  // 않는다 — assertRunnable 이 그 조합에서 조각 분해를 이미 거부한다.
  // 빈 문자열은 "브랜치를 확인하지 못했다"와 같게 취급한다 — 그걸 통합 브랜치로 기록하면
  // 조각 브랜치 이름이 "-1" 로 파생돼(선행 하이픈, git 이 만들 수 없는 이름) 엉뚱한 실패가 된다.
  const integrationBranch = workBranch !== null && workBranch.length > 0 ? workBranch : null;
  const sliceEnabled = state.review_split?.enabled === true && integrationBranch !== null;
  if (integrationBranch !== null && state.integration_branch !== integrationBranch) {
    state.integration_branch = integrationBranch;
    deps.log(`통합 브랜치: ${integrationBranch} (조각 PR 이 머지되어 쌓이는 브랜치)`);
  }

  state.status = "running";
  saveState(workflowDir, state);

  for (;;) {
    const phase = selectNextPhase(state);
    if (!phase) {
      if (!allPhasesDone(state)) {
        // assertRunnable 이 선차단하지만, 실행 중 상태 변화에 대한 방어선
        state.status = "failed";
        saveState(workflowDir, state);
        deps.notify("fw FAILED", "진행 가능한 phase 가 없습니다 (의존성 교착)");
        return state;
      }
      break;
    }

    // §32 C-2 후속(남은 부채) — allow_claude_md_changes 사용 시각 기록. 선례(allow_verify_file_changes
    // → verify_file_changes_bypassed_at)와 달리 STATE 필드를 새로 만들지 않는다: state.ts 는 이
    // 라운드에서 다른 에이전트 소유라 필드를 추가할 수 없고(state.ts:67-70 주석 참조), 애초에 그
    // 실제 차단/해제 판정은 canUseTool(permissions.ts) 안에서 일어나 STATE 를 쓸 수 있는 경로가
    // 아니다(하네스 단일 작성자 원칙). 대신 §30 P4("방어를 낮췄다는 사실이 어디에도 안 남으면
    // 사후 재구성이 불가능하다")를 지키기 위해 deps.log 로만 남긴다.
    // §30 P1 — 이 phase 는 이후 두 경로 중 하나(또는 순차로 둘 다)로 세션을 띄운다: 바로 아래
    // in_review 분기(→ runPrGate → prloop.ts 의 runFixSession, 다른 에이전트 소유라 이 라운드에서
    // 수정 불가)와, 그 아래 일반 attempts 루프(→ deps.runner.runPhase). prloop.ts 를 건드릴 수
    // 없으므로 "runPhase 호출 직전"에만 넣으면 in_review 로 재개되는 phase(운영자가 워크플로우를
    // 재시작해 이 phase 가 이미 PR 대기 중인 경우)는 이 로그를 영영 못 받는다 — 두 분기 **모두의
    // 공통 상위 지점**인 여기(phase 선택 직후, 분기 이전)에 한 번만 둬서 복붙 없이 양쪽을 덮는다.
    if (phase.allow_claude_md_changes) {
      deps.log(
        `Phase ${phase.id}: CLAUDE.md 수정 허용됨(allow_claude_md_changes) — 이 phase 의 세션이 리포 관례 문서를 고칠 수 있습니다`,
      );
    }

    // ── pr-slicing D7/D10: 분해 게이트 ────────────────────────────────────
    // phase 를 실행하기 **전에** 읽기 전용 세션으로 조각 경계를 정한다. 여기서 분해하면
    // continue 로 루프에 재진입하고, selectNextPhase 가 첫 조각을 자연히 고른다 — 이후
    // orchestrator 의 나머지 코드는 한 줄도 조각을 알 필요가 없다.
    //
    // 발동 조건이 좁은 이유:
    //   - status==="pending": in_progress/in_review 로 재개된 phase 를 쪼개면 이미 만들어진
    //     커밋이 어느 조각에도 속하지 않는 상태가 된다(§2 D17 과 같은 규율).
    //   - split_group 없음: 이미 조각인 phase 를 또 쪼개지 않는다.
    //   - decompose_skipped_reason 없음: 한 번 "분해하지 않기로" 판정한 phase 에 재실행마다
    //     유료 세션을 다시 태우지 않는다.
    //   - runDecomposeAgent 있음: 선택 메서드다(구현하지 않은 러너면 분해 없이 진행).
    if (
      sliceEnabled &&
      phase.status === "pending" &&
      phase.split_group === undefined &&
      phase.decompose_skipped_reason === undefined &&
      deps.runner.runDecomposeAgent
    ) {
      // 유료 세션을 띄우기 직전 — 다른 세션 경로와 같은 체크포인트 규율.
      if (checkHaltpoint(workflowDir, state, deps, runStartedAt)) return state;

      const planContext = readPlanContext(workflowDir);
      const decomposed = await deps.runner.runDecomposeAgent(
        {
          phaseId: phase.id,
          phaseTitle: phase.title,
          nextSteps: phase.next_steps,
          verify: verifyCommandsFor(state, phase),
          budgetLines: state.review_split?.budget_lines ?? 0,
          plan: planContext,
        },
        // 분해 세션은 읽기 전용이라 작업 브랜치가 의미 없지만, 정책 조립은 다른 세션과
        // 같은 함수를 쓴다(§30 P1). 아직 조각 브랜치를 만들기 전이므로 통합 브랜치를 넘긴다.
        policyFor(state, phase, workflowDir, pre.originHost, workBranch),
      );

      // 분해도 유료 세션이다 — 비용 집계에서 빠지면 "왜 돈이 더 나갔지" 를 재구성할 수 없다.
      phase.sessions.push({
        session_id: decomposed.sessionId ?? "unknown",
        result: decomposed.ok ? "done" : "failed",
        summary: (decomposed.ok ? decomposed.overallRationale : decomposed.problem).slice(0, 1000),
        at: deps.now(),
        kind: "decompose",
        cost_usd: decomposed.costUsd,
      });

      // fail-open(D10): 실패·거부·1조각은 전부 "원본 phase 를 그대로 실행" 으로 수렴한다.
      // 분해는 리뷰 편의 장치이고, 그것 때문에 워크플로우가 멈추는 건 본말전도다. 다만
      // 이유는 반드시 남긴다 — 조용히 넘어가면 왜 안 쪼개졌는지 알 방법이 없다(§30 P4).
      // 회송(재시도)은 하지 않는다: 편의 장치에 유료 세션을 한 번 더 태울 근거가 약하고,
      // 자동 재분해는 무한 분해 루프의 입구다(D11).
      const skip = (reason: string): void => {
        phase.decompose_skipped_reason = reason;
        saveState(workflowDir, state);
        deps.log(`Phase ${phase.id}: 분해하지 않고 그대로 실행합니다 — ${reason}`);
      };

      if (!decomposed.ok) {
        skip(decomposed.problem);
      } else if (decomposed.slices.length < 2) {
        skip(`분해 세션이 조각 1개를 반환했습니다(쪼갤 필요 없음): ${decomposed.overallRationale}`);
      } else {
        const check = validateSliceProposals(decomposed.slices);
        if (!check.ok) {
          skip(check.problem);
        } else {
          applyDecomposition(state, phase, decomposed.slices);
          saveState(workflowDir, state);
          deps.log(
            `Phase ${phase.id}: 조각 ${decomposed.slices.length}개로 나눴습니다 — ${decomposed.overallRationale}`,
          );
          continue; // 루프 재진입 — selectNextPhase 가 첫 조각을 고른다
        }
      }
    }

    // pr-slicing D2: 조각 분해가 켜져 있으면 세션은 통합 브랜치가 아니라 **조각 브랜치**에서
    // 작업한다. 이 phase 전용 브랜치를 통합 브랜치에서 따고, 이후 이 phase 의 모든 방어
    // (이탈 감시·커밋 도달성·권한 정책)가 그 브랜치를 기준으로 동작하게 한다.
    // 아래 두 경로(in_review 재개 / 일반 attempts 루프) **공통 상위 지점**에 둔다 — 한쪽에만
    // 두면 다른 경로가 통합 브랜치에서 그대로 커밋한다(§30 P1).
    let phaseWorkBranch = workBranch;
    if (sliceEnabled && state.integration_branch) {
      // 순번은 phase 배열에서 재계산하지 않고 저장된 카운터에서 받는다 — 재계산은 fw retry 로
      // 조각을 다시 도는 경로에서 이미 쓴 순번을 재사용해 브랜치 이름이 충돌한다.
      if (phase.slice_seq === undefined) {
        phase.slice_seq = state.next_slice_seq ?? 1;
        state.next_slice_seq = phase.slice_seq + 1;
        saveState(workflowDir, state);
      }
      const slice = await createSliceBranch({
        cwd: state.repo_root,
        integrationBranch: state.integration_branch,
        seq: phase.slice_seq,
        git: gitExec,
        log: deps.log,
      });
      if (!slice.ok) {
        // 남의 브랜치를 덮지 않고 멈춘다(D17) — 사람이 판단할 문제다.
        phase.status = "failed";
        state.status = "failed";
        saveState(workflowDir, state);
        deps.log(`Phase ${phase.id}: 조각 브랜치를 준비할 수 없습니다 — ${slice.problem}`);
        deps.notify("fw FAILED", slice.problem.slice(0, 300));
        return state;
      }
      phaseWorkBranch = slice.branch;
      deps.log(`Phase ${phase.id}: 조각 브랜치 ${slice.branch} 에서 작업합니다 (통합 브랜치: ${state.integration_branch})`);
    }

    // in_review 로 남은 phase 는 세션을 다시 돌리지 않고 PR 폴링만 재개한다
    if (state.pr_mode && phase.pr && phase.status === "in_review") {
      const outcome = await runPrGate(workflowDir, state, phase, deps, phaseWorkBranch, runStartedAt, pre.originHost);
      // halted 는 checkHaltpoint 가 이미 state 를 halted 로 저장했다 — 그대로 반환한다(blocked/
      // awaiting_merge 와 동일하게 phase.status 를 덮어쓰지 않는다).
      if (outcome === "blocked" || outcome === "awaiting_merge" || outcome === "halted") return state;
      if (outcome === "failed") {
        phase.status = "failed";
        state.status = "failed";
        saveState(workflowDir, state);
        return state;
      }
      phase.status = "done";
      saveState(workflowDir, state);
      continue; // 다음 phase 로
    }

    phase.status = "in_progress";
    saveState(workflowDir, state);
    deps.log(`▶ Phase ${phase.id}: ${phase.title}`);

    let fixContext: string | undefined;
    let phaseDone = false;

    while (phase.attempts < phase.max_attempts) {
      // §27 O2/O3 체크포인트 ①: 새 attempt(=새 유료 세션)를 띄우기 직전. §2 D17 — 여기서 멈추면
      // "아직 아무 세션도 안 띄운" 상태라 커밋이 반쯤 된 상태가 남을 수 없다.
      if (checkHaltpoint(workflowDir, state, deps, runStartedAt)) return state;
      phase.attempts += 1;
      saveState(workflowDir, state);

      // §25: 세션이 무엇을 하기 **전에** HEAD 를 기록해야 "그 이후 커밋인지" 판정할 수 있다.
      // 세션 실행 후에 재는 건 의미가 없다 — 세션이 만든 커밋까지 headBefore 에 포함돼버린다.
      const headBefore = await (deps.headSha ?? defaultHeadSha)(state.repo_root);

      const result = await deps.runner.runPhase({
        workflowDir, phase, answers: state.answers,
        // §37 sandbox-trial 막힘 1 후속: pre.originHost(위 preflight() 가 이미 구한 값, §30 P1 —
        // git 을 다시 호출하지 않고 재사용)를 넘겨 network.allowedDomains 자동 포함이 이 경로에도
        // 적용되게 한다.
        // §68: workBranch 를 넘겨 세션이 자기 작업 브랜치(feature/<workflow> 등)를 push 할 수
        // 있게 한다 — 격리 브랜치 접두 변경(fw/→feature/)으로 접두 허용에서 빠졌기 때문.
        policy: policyFor(state, phase, workflowDir, pre.originHost, phaseWorkBranch), fixContext,
      });
      phase.sessions.push({
        session_id: result.sessionId ?? "unknown",
        result: result.status,
        // 실패 이유를 남기지 않으면 무인 실행이 왜 죽었는지 사후 진단이 불가능하다
        summary: result.summary.slice(0, 1000),
        at: deps.now(),
        kind: "phase",
        cost_usd: result.costUsd,
        // §43 — 범위 밖 발견 사항. 세 경로(phase/fix/verify) 전부가 같은 기록을 받는다(§30 P1).
        findings: result.findings,
        // pr-slicing — PR 본문 조립 시점에는 세션 객체가 없고 STATE 기록만 남으므로 보존한다.
        review_order: result.reviewOrder,
      });

      // §26 C2/§29 CR-2: 세션이 격리/토픽 브랜치를 이탈했는지 재확인한다 — `git checkout`/
      // `git switch` 는 세션에 허용된 명령이라 자유롭게 브랜치를 옮길 수 있다(applyBranchStrategy 는
      // `fw run` 당 한 번만 실행돼 재확인하지 않으면 격리가 무력화된다, 실측 확인). 이탈했으면
      // 세션이 무엇을 주장하든(done/blocked/failed) 신뢰하지 않고 즉시 회송한다. fix 세션(PR 루프)
      // 도 동일한 검사를 받는다 — checkBranchDrift 공통 함수 참조.
      const branchDrift = await checkBranchDrift(state.repo_root, phaseWorkBranch, gitExec);
      if (!branchDrift.ok) {
        deps.log(`Phase ${phase.id}: 브랜치 이탈 감지 — ${branchDrift.problem}`);
      }

      // §25 리팩토링이 드러낸 비대칭(phase 루프는 이탈 검사를 blocked/failed 판정보다 **먼저**
      // 하고 fix 루프는 나중에 했다): 이탈 검사를 먼저 하면 `continue` 로 빠져나가 **세션의 질문이
      // 사용자에게 전달되지 않고 사라지고**, blocked 분기의 `attempts -= 1` 에도 도달하지 못해
      // attempt 까지 소모된다. max_attempts 기본 2 면 그런 세션 두 번으로 phase 가 failed 가 되고
      // 사용자는 질문을 영원히 못 본다 — BLOCKED 규약은 "물을 사람이 없을 때 독단 판단 금지"의
      // 유일한 기계 장치인데 그게 조용히 폐기되는 셈이다. 따라서 **질문은 항상 표면화한다.**
      // 이탈은 별개의 사실이므로 함께 알린다(질문에 덧붙이고 위에서 로그도 남겼다).
      // 두 파일이 하나로 붙어 있을 때는 두 루프가 500줄 넘게 떨어져 이 비대칭이 안 보였다(§30 P1).
      if (result.status === "blocked") {
        phase.attempts -= 1; // 질문은 실패가 아니다
        // §36 §30 P4: 세션의 자기 주장(질문)과 별개로, 하네스의 판정도 STATE 에 남긴다 — "이
        // 세션은 done/failed 를 검증받은 게 아니라 질문을 반환했다"는 사실 자체가 기록이다.
        recordVerdict(phase, { outcome: "session_blocked" });
        // §31 C1/§30 P1: pending_question 세팅·저장·알림은 prloop.ts 의 fix 루프와 공유하는
        // surfaceBlockedQuestion 헬퍼 하나로 한다 — 브랜치 이탈처럼 "질문과 별개로 함께 알려야
        // 할 사실"은 extraProblems 로 넘긴다. 복붙하면(이전 라운드처럼) 한쪽만 고쳐지고 다음
        // 라운드에 또 갈린다.
        surfaceBlockedQuestion(
          workflowDir, state, phase, result.question ?? "(질문 누락)",
          branchDrift.ok ? [] : [branchDrift.problem], deps, `Phase ${phase.id}: `,
        );
        return state;
      }

      // 이탈했으면 세션의 done/failed 주장은 신뢰하지 않는다 — 회송해 격리 브랜치에서 다시 하게 한다.
      if (!branchDrift.ok) {
        // §36 §30 P4: branchDrift 는 세션이 무엇을 주장했든(done/failed) 우선한다 — 판정도 그
        // 우선순위를 그대로 반영해 "branch_drift" 로 기록한다(session_failed 로 뭉개지 않는다).
        recordVerdict(phase, { outcome: "bounced", reason: "branch_drift", detail: branchDrift.problem });
        fixContext = result.status === "failed"
          ? `직전 세션 실패: ${result.summary}\n${branchDrift.problem}`
          : branchDrift.problem;
        continue;
      }

      if (result.status === "failed") {
        recordVerdict(phase, { outcome: "session_failed", detail: result.summary.slice(0, 500) });
        deps.log(`Phase ${phase.id}: 세션이 failed 를 보고했습니다 — ${result.summary.slice(0, 300)}`);
        fixContext = `직전 세션 실패: ${result.summary}`;
        continue;
      }

      // done 주장 → 하네스가 직접 검증
      // issue #3: status:"already_applied" 는 fix 세션(prloop.ts) 전용 어휘다. phase 세션이 이 값을
      // 내면 여기서 done 과 동일한 경로를 타고, 아래 verifySessionCommits 가 "headBefore 이후 신규
      // 커밋"을 요구하므로 근거로 댄 기존 SHA 는 commit_verification_failed 로 회송된다 — phase 는
      // "이미 반영됨"으로 끝낼 수 없다(별도 분기를 두지 않는 것이 의도다).
      const commands = verifyCommandsFor(state, phase);

      // §24 감사 S1: 게이트를 돌리기 전, 세션이 verify 명령 자체(스크립트/빌드 설정)를 고쳐
      // 게이트를 위조하지 않았는지 확인한다. `scripts.test` 를 "echo pass; exit 0" 로 바꾸는 식의
      // 자기 조작은 게이트가 그 명령을 그대로 실행하는 한 exitCode 판정만으로는 못 잡는다.
      const guardedFiles = verifyReferencedFiles(commands);
      if (guardedFiles.length > 0) {
        if (phase.allow_verify_file_changes) {
          // 정당한 경우(빌드 설정 자체를 고치는 phase)를 완전히 막으면 과하다 — 옵트아웃은 허용하되
          // "의도적 허용"과 "몰래 위조"를 구분할 수 있도록 로그와 STATE 양쪽에 흔적을 남긴다.
          // §z-parse D12: join(", ") 은 경로 자체에 쉼표/개행이 있으면 경계가 모호해진다 —
          // JSON.stringify(배열) 은 물리 한 줄을 유지하면서도(D5 — 이 log() 는 runlog 로 감) 각
          // 원소를 가역적으로 표기한다. 여기서 정규화되는 값은 그대로다 — 표기만 바뀐다(P13).
          deps.log(
            `Phase ${phase.id}: allow_verify_file_changes=true — 검증 대상 파일(${JSON.stringify(guardedFiles)}) 변경 검사를 건너뜁니다 (옵트아웃)`,
          );
          phase.verify_file_changes_bypassed_at = deps.now();
          saveState(workflowDir, state);
        } else if (headBefore) {
          // 기준점은 이 phase "런" 전체에 고정한다(attempt 마다 재캡처하지 않는다) — 그렇지 않으면
          // 1차 시도에서 위조당해 회송된 뒤 그 커밋을 되돌리지 않고 방치한 채 2차 시도에서 무관한
          // 파일만 커밋해도, 2차의 headBefore 가 이미 1차의 위조 커밋 이후라 diff 에 안 걸려 그대로
          // 통과해버리는 "attempt 간 위조 세탁" 이 실측으로 확인됐다. fw retry 로만 초기화된다.
          if (!phase.verify_guard_baseline_sha) {
            phase.verify_guard_baseline_sha = headBefore;
            saveState(workflowDir, state);
          }
          const guardSince = phase.verify_guard_baseline_sha;
          try {
            const result = await (deps.changedFiles ?? defaultChangedFiles)(state.repo_root, guardSince);
            if (!result.ok) {
              // §tamper-gap P1/P2/P5: git 은 exit 0 으로 성공했지만 출력 구조를 신뢰할 수 없다
              // (U+FFFD 감지) — 인프라 오류(아래 catch, fail-open 유지)와 분리된 별도 분기로
              // fail-closed 처리한다. 실제 확인된 tamper 와 합류하지 않도록 별도 reason·중립
              // 문구를 쓴다 — 사실 확인 전에 "위조"/"변조" 로 단정하지 않는다(P5).
              const detail = result.paths.map(displayPath).join("\n");
              fixContext =
                "변경 파일 목록을 신뢰할 수 없어 안전하게 정지했습니다 (디코딩 결과에 잘못된 문자가 포함된 " +
                "경로가 있습니다, 각 줄 JSON 문자열 리터럴):\n" +
                detail +
                "\n\n이 경로가 이번 시도에서 만들어졌다면 제거하거나 올바른 이름으로 바꾼 뒤 done 을 반환하세요.";
              deps.log(`Phase ${phase.id}: 변경 파일 목록 파싱 이상(U+FFFD) — ${JSON.stringify(result.paths)}`);
              recordVerdict(phase, {
                outcome: "bounced", reason: "changed_files_untrustworthy", detail,
              });
              continue;
            }
            const changed = result.files;
            // §26 C3 감사: verifyReferencedFiles 는 "./scripts/check.sh" 처럼 명령에 쓰인 형태 그대로
            // 반환하는데 git diff --name-only 는 "./" 없는 리포-상대 경로를 반환한다 — 정규화 없이
            // endsWith("/"+g) 로 비교하면 "./" 유무로만 갈려 가장 직접적인 위조(./gradlew 등)를
            // 놓친다. 양쪽을 정규화한 뒤 정확 일치로만 비교한다 — 이렇게 하면 basename 만 있는 가드
            // 항목(package.json 등)도 하위 경로(packages/foo/package.json)에 오탐하지 않는다(I7).
            // §z-parse D11/P13: 이 비교 지점에서만 로컬로 normalizeGitSourcePath(무unquote·무trim)를
            // 적용한다 — changed/guardedFiles 변수 자체는 바꾸지 않는다(:249 표시용 guardedFiles 는
            // 기존 값 그대로). branch.ts 가 -z 로 파싱한 changed 쪽 원본이 더 이상 core.quotePath 로
            // 감싸이지 않으므로, 우연히 큰따옴표로 시작·끝나는 실제 파일명을 normalizeRepoPath 의
            // unquoteGitPath 가 quotePath 이스케이프로 오인해 손상시킬 위험을 피한다.
            const normalizedChanged = new Set(changed.map(normalizeGitSourcePath));
            const tampered = guardedFiles.filter(g => normalizedChanged.has(normalizeGitSourcePath(g)));
            if (tampered.length > 0) {
              // §tamper-gap P4/D8: 같은 attempt 에 "내용 수정"과 "이동/삭제"가 혼재할 수 있으므로
              // formatGuardedFileLines(branch.ts, orchestrator/prloop 공유)로 파일별 실제 상태를
              // 반영한 라벨을 붙인다 — 사라진 파일에 "수정을 되돌리라"는 어긋난 지시를 내지 않는다.
              // §z-parse D1/D2: 경로 블록을 프로즈보다 먼저, 빈 줄로 분리해 배치한다 — join(", ")
              // 는 프로즈 문장 중간에 삽입돼 경로 자체의 쉼표/개행과 문장 구분자가 뒤섞였다. 각 경로는
              // displayPath(JSON 문자열 리터럴)로 가역 표기해 다음 세션이 JSON.parse 로 원본 파일명을
              // 정확히 재구성할 수 있게 한다 — 그 사실을 아래 헤더 문장에 한 줄로 명시한다.
              const lines = formatGuardedFileLines(state.repo_root, tampered);
              fixContext =
                "검증 대상 파일 상태가 바뀌었습니다 (각 줄 상태 라벨 + JSON 문자열 리터럴):\n" +
                lines.join("\n") +
                "\n\n검증 스크립트/빌드 설정을 바꾸거나 이동/삭제하면 게이트 판정을 신뢰할 수 없습니다. 수정된 " +
                "파일은 변경을 되돌리고, 이동/삭제된 파일은 원래 경로로 복원한 뒤 done 을 반환하세요. 이 phase 가 " +
                "검증 설정 자체를 의도적으로 고쳐야 한다면 STATE.json 의 phase.allow_verify_file_changes 를 " +
                "true 로 설정해 이 검사를 옵트아웃할 수 있습니다.";
              // §26 I7: 이 회송은 지금까지 deps.log 를 호출하지 않아 사용자가 왜 세션이 소진됐는지
              // 알 방법이 없었다 — 로그로 남긴다.
              // §z-parse D5: log() 는 append-전용 줄-단위 tail 로그(runlog)로 가므로 물리 한 줄을
              // 유지해야 한다 — 배열 전체를 JSON.stringify 하나의 한 줄 리터럴로 남긴다.
              deps.log(`Phase ${phase.id}: 검증 대상 파일 상태 변경 감지 — ${JSON.stringify(tampered)}`);
              // §36 §30 P4: 하네스의 판정도 STATE 에 남긴다 — deps.log 는 gitignore 된 실행
              // 로그에만 쌓이지만 verdict 는 STATE.json 을 통해 `fw report`/`fw status`/`fw log`
              // 어디서든 재구성할 수 있다.
              // §z-parse D2: STATE detail 은 한 줄에 하나씩(char-slice 없이 JSON 리터럴 줄바꿈 join).
              recordVerdict(phase, {
                outcome: "bounced", reason: "verify_tampered", detail: lines.join("\n"),
              });
              continue;
            }
          } catch (err) {
            // 검사 자체가 불가능(git 오류 등)하면 이 attempt 는 검증을 건너뛴다 — 무기한 회송보다
            // 로그로 남기고 기존 게이트(exitCode 판정)에 맡기는 쪽을 택한다(§25 C1 과 동일한 원칙:
            // 인프라 오류로 무인 워크플로우를 막다른 길로 몰지 않는다).
            deps.log(`검증 대상 파일 변경 확인 실패(건너뜀): ${(err as Error).message}`);
          }
        }
        // headBefore 가 없으면(git 저장소가 아님 등) 검사할 기준점이 없으므로 건너뛴다.
      }

      const logFile = path.join(workflowDir, "logs", `phase-${phase.id}-attempt-${phase.attempts}.log`);
      phase.last_log = logFile;
      const gate = await deps.gate({ commands, cwd: state.repo_root, logFile, timeoutMs: state.verify_timeout_ms ?? undefined });

      if (!gate.passed) {
        const fatal = gate.results.find(r => r.fatal);
        if (fatal) {
          // 명령 자체 오류(미존재/실행 불가/spawn 실패) — 재시도 무의미
          recordVerdict(phase, {
            outcome: "bounced", reason: "gate_failed",
            detail: `검증 명령 자체 오류(치명적): ${fatal.command}`,
          });
          phase.status = "failed";
          state.status = "failed";
          saveState(workflowDir, state);
          deps.notify("fw FAILED", `검증 명령 자체 오류: ${fatal.command}`);
          return state;
        }
        // §36 §30 P4: 이전에는 게이트 실패가 fixContext(다음 세션 프롬프트)로만 전달되고
        // deps.log/STATE 어디에도 남지 않았다 — 회송 사실이 "세션이 다음 attempt 에서 커밋
        // 메시지에 뭐라고 썼는가" 에만 의존했다(§36 실측). 실행 로그와 STATE 양쪽에 남긴다.
        deps.log(
          `Phase ${phase.id}: 검증 게이트 실패 — attempt ${phase.attempts}/${phase.max_attempts} 회송 ` +
            `(${gate.results.filter(r => r.exitCode !== 0).map(r => r.command).join(", ")})`,
        );
        recordVerdict(phase, {
          outcome: "bounced", reason: "gate_failed",
          detail: gate.results.filter(r => r.exitCode !== 0).map(r => `${r.command} (exit ${r.exitCode})`).join("; "),
        });
        fixContext =
          "검증 실패:\n" +
          gate.results
            .map(r => `$ ${r.command} (exit ${r.exitCode})\n${r.output.slice(-4000)}`)
            .join("\n") +
          `\n\n전체 로그: ${logFile} (Read 도구로 열어 근본 원인을 확인하라)`;
        continue;
      }

      // 세션의 "done" 주장을 커밋으로 검증한다 — 인수인계 문서 touch 대신 실제 산출물(커밋) 존재로 판정.
      // 검증 게이트가 이미 산출물을 실행·판정하므로, 커밋이 있으면 "일했다" 로 충분하다.
      // §25: 존재 여부만으로는 세션이 아무 일도 안 하고 `commits:["HEAD"]`(또는 기존 커밋 SHA)를
      // 반환해도 통과한다 — headBefore 이후에 생긴 커밋인지(ancestry)까지 확인해야 우회를 막는다.
      // §26 C2/§29 CR-3: 커밋의 브랜치 도달성 검사도 함께 — 세션이 base_branch 에 커밋한 뒤 격리
      // 브랜치로 되돌아가 위의 이탈 감시(현재 브랜치 재확인)만 피해가는 경우를 잡는다. fix 세션도
      // 동일한 검사를 받는다 — verifySessionCommits 공통 함수 참조.
      const commitCheck = await verifySessionCommits(state.repo_root, phaseWorkBranch, headBefore, result.commits, deps);
      if (!commitCheck.ok) {
        // §36 §30 P4: "커밋 0건"과 "보고한 커밋이 신규/도달 불가"는 별개 사유다 — 문자열을
        // 스니핑해 구분하지 않는다(§30 P3: 문법을 흉내내려다 진다). result.commits 는 세션이
        // 보고한 값 그대로이므로 여기서 직접 구조적으로 판정한다.
        const reason = result.commits.length === 0 ? "no_commits" : "commit_verification_failed";
        deps.log(`Phase ${phase.id}: ${commitCheck.problem}`);
        recordVerdict(phase, { outcome: "bounced", reason, detail: commitCheck.problem });
        fixContext = commitCheck.problem;
        continue;
      }

      // §36 §30 P4: 여기까지 도달했다는 것은 세션의 done 주장이 게이트·위조 가드·커밋 검증을
      // 전부 통과했다는 뜻이다 — pr_mode 여부와 무관하게 "이 세션"에 대한 판정은 accepted 로
      // 확정한다(그 뒤 PR 리뷰 왕복에서 벌어지는 일은 별도의 fix 세션들의 판정이다).
      recordVerdict(phase, { outcome: "accepted" });

      if (state.pr_mode) {
        const outcome = await runPrGate(workflowDir, state, phase, deps, phaseWorkBranch, runStartedAt, pre.originHost);
        if (outcome === "blocked" || outcome === "awaiting_merge" || outcome === "halted") return state;
        if (outcome === "failed") {
          phase.status = "failed";
          state.status = "failed";
          saveState(workflowDir, state);
          return state;
        }
      }
      phase.status = "done";
      saveState(workflowDir, state);
      deps.log(`✓ Phase ${phase.id} 완료 (검증 통과)`);
      phaseDone = true;
      break;
    }

    if (!phaseDone) {
      phase.status = "failed";
      state.status = "failed";
      saveState(workflowDir, state);
      deps.notify("fw FAILED", `Phase ${phase.id} 재시도 소진 (${phase.max_attempts}회)`);
      return state;
    }
  }

  if (allPhasesDone(state)) {
    // pr-slicing D6 — 조각 분해를 썼다면 조각들은 통합 브랜치에만 쌓여 있다. base 브랜치로
    // 보내는 통합 PR 이 마지막 관문이고, 그게 머지되기 전에는 워크플로우가 끝난 게 아니다.
    // review_split 이 꺼진 워크플로우는 phase PR 이 이미 base 브랜치로 갔으므로 건너뛴다
    // (기존 pr_mode 동작을 그대로 유지한다).
    if (sliceEnabled) {
      const outcome = await runIntegrationPrGate(workflowDir, state, deps, runStartedAt);
      if (outcome === "halted") return state; // checkHaltpoint 가 이미 저장했다
      if (outcome === "awaiting_merge") {
        state.status = "awaiting_merge";
        saveState(workflowDir, state);
        return state;
      }
      if (outcome === "failed") {
        state.status = "failed";
        saveState(workflowDir, state);
        return state;
      }
    }
    state.status = "done";
    saveState(workflowDir, state);
    // §45/§56 — 적대적 3역할 검증 + 합의. 본문은 runVerificationStage 로 추출됐다:
    // `fw verify`(완료된 워크플로우 사후 검증)와 이 경로가 같은 구현을 공유해야
    // 한쪽만 고쳐지는 §30 P1 이 재발하지 않는다.
    try {
      await runVerificationStage(workflowDir, state, deps, pre.originHost);
    } catch (err) {
      // verify 보고서는 부산물 — 실패해도 done 판정을 막지 않는다(§30 P2). AgentSdkRunner 는
      // 항상 결과 객체를 반환하므로 이 catch 는 임의 SessionRunner 구현에 대한 방어망이다.
      deps.log(`verify 보고서 생성 실패(무시): ${(err as Error).message}`);
    }
    deps.notify("fw 완료 ✅", `${state.workflow} 워크플로우 완료`);
  }
  return state;
}

// §56 — 적대적 3역할 검증 + 합의 단계. runWorkflow(전 phase 완료 직후)와 `fw verify`
// (완료된 워크플로우에 사후 실행 — z-parse 통주에서 이 단계가 비용 상한으로 통째로 생략된
// 실측이 계기) 두 호출부가 이 하나의 구현을 공유한다(§30 P1). 예외는 던질 수 있다 —
// 부산물 계약(실패해도 done 을 막지 않음)은 호출부의 try/catch 몫이다.
export async function runVerificationStage(
  workflowDir: string,
  state: State,
  deps: OrchestratorDeps,
  originHost: string | null,
  opts?: {
    /** 이 실행의 비용 상한. 생략하면 state.max_cost_usd (runWorkflow 경로의 기존 동작 그대로).
     *  `fw verify --budget` 은 "현재 누적 + 추가 예산" 을 계산해 넘긴다 — 이미 상한에 도달한
     *  완주 워크플로우에도 검증만 추가로 돌릴 수 있게 하기 위함이다. */
    costCapUsd?: number | null;
  },
): Promise<void> {
  const costCap = opts !== undefined && "costCapUsd" in opts ? opts.costCapUsd ?? null : state.max_cost_usd ?? null;
  const verifyRoles = selectVerifyRoles(readPlanContext(workflowDir));
  deps.log(`verify 에이전트 실행 (역할: ${verifyRoles.map(r => VERIFY_ROLE_LABEL[r]).join("/")})`);
{
      const verifySections: string[] = [];
      const consensusInputs: ConsensusInput[] = [];
      for (const role of verifyRoles) {
        // §45/§27 O2 — verify 는 done 이후의 부산물이라 상한 초과를 halted 로 되돌리지 않는다
        // (§30 P2 — 부산물이 정상 경로의 결론을 바꾸면 안 된다). 대신 남은 역할만 생략하고,
        // 생략했다는 사실을 VERIFY.md 에 남긴다(§30 P4 — 조용한 생략은 "전부 검증했다" 로 읽힌다).
        if (costCap != null && totalCostUsd(state) >= costCap) {
          verifySections.push(`## ${VERIFY_ROLE_LABEL[role]} 검증 — 생략됨 (비용 상한 $${costCap} 도달)`);
          deps.log(`verify ${VERIFY_ROLE_LABEL[role]} 역할 생략 — 비용 상한 도달`);
          continue;
        }
        const result = await deps.runner.runVerifyAgent(workflowDir, policyFor(state, null, workflowDir, originHost), role);
        verifySections.push(`## ${VERIFY_ROLE_LABEL[role]} 검증\n\n${result.summary}`);
        if (result.status !== "failed") consensusInputs.push({ role, report: result.summary });
      // §41 I-1 — verify 세션도 phase/fix 두 경로와 동일하게 STATE 에 남긴다(§30 P1: 세션을 띄우는
      // 3경로 전부가 같은 방어/기록을 받아야 한다). 이전에는 VERIFY.md 만 쓰고 sessions.push 가 없어
      // ①§27 O2 max_cost_usd 가 이 유료 세션의 비용을 못 보고 ②`fw report` 의 `verify: 0건` 이
      // "안 돌았다"로 오독되고 ③§38 판정(recordVerdict)도 이 경로만 빠졌었다(§41 실측).
      //
      // 어느 phase 에 붙이는가: state.ts 의 STATE 스키마는 phase 단위 배열(phases[].sessions[])뿐이고
      // verify 전용 자리가 없다 — 이 라운드에서 state.ts 스키마는 바꿀 수 없으므로(파일 소유권 분리)
      // 기존 구조 안에서 자리를 찾아야 한다. verify 는 phase 단위가 아니라 워크플로우 마무리에 1회만
      // 도므로 "이 phase 가 만들었다"는 인과관계는 원래 없다 — 그런데 state.ts 의 totalCostUsd 는
      // phases[].sessions[] 를 전부(어느 phase 든) 합산하고, report.ts 의 costByKind/verdict 집계도
      // 마찬가지로 전체 phase 를 순회하므로(직접 확인함), **어느 phase 에 붙이든 상한 계산·리포트
      // 집계 결과는 동일하다.** 그렇다면 사람이 `fw status`/`fw log` 로 phase 별 세션을 볼 때 가장
      // 자연스러운 자리, 즉 **마지막 phase**를 택한다 — 워크플로우가 끝나자마자 그 phase 바로
      // 다음에 실행된 것이므로 시간적으로도 가장 인접하다. state.phases 는 이 시점에 항상 비어있지
      // 않다(assertRunnable 이 진입 시 빈 배열을 거부한다).
      const lastPhase = state.phases[state.phases.length - 1];
      lastPhase.sessions.push({
        session_id: result.sessionId ?? "unknown",
        result: result.status,
        summary: result.summary.slice(0, 1000),
        at: deps.now(),
        kind: "verify",
        cost_usd: result.costUsd,
        // §43 — verify 는 구조화 출력을 쓰지 않아 실제로는 항상 undefined 지만, 세 경로가
        // 같은 형태를 공유해야 한쪽만 고치고 다른 쪽을 놓치는 사고가 안 난다(§41 I-1 의 교훈).
        findings: result.findings,
      });
      // §38(§30 P4) 판정 — verify 는 게이트를 거치지 않아 phase/fix 루프의 "회송(bounced)" 개념이
      // 없다(재시도 루프가 없다 — 실패해도 워크플로우는 그대로 done 이다, 바로 아래 참고). 그래서
      // SessionVerdictSchema 의 네 outcome 중 실제로 벌어질 수 있는 것은 둘뿐이다: 에이전트가 정상
      // 응답했으면 "accepted"(보고서 내용이 문제를 지적했더라도 "세션 실행 자체"는 정상 완료다),
      // SDK/스트림이 죽었으면 "session_failed". "bounced"(재시도 사유가 필요)와 "session_blocked"
      // (verify 는 질문을 반환하는 구조화 출력이 없다)는 이 경로에 대응하는 사실 자체가 없으므로
      // 쓰지 않는다 — 스키마에 새 outcome 을 추가하지도 않았다(추가가 필요하면 보고하라는 지시에
      // 따라, 기존 값으로 충분하다고 판단해 스키마는 그대로 둔다).
      recordVerdict(
        lastPhase,
        result.status === "failed"
          ? { outcome: "session_failed", detail: result.summary.slice(0, 500) }
          : { outcome: "accepted" },
      );
      // 역할마다 즉시 저장 — 다음 역할 세션이 죽어도 앞 역할의 기록·비용은 STATE 에 남는다
      // (§27 O2 의 상한 검사가 이 누적값을 읽으므로 루프 선두의 생략 판단도 이 저장에 의존한다).
      saveState(workflowDir, state);
      }
      // §47 — 합의 단계. 세 역할의 "적대적이고 비판적인 토크" 를 종합해 ①합의된 완료
      // ②합의된 문제 ③이견 ④다음 목표 제안을 만든다. 역할이 2개 이상 돌았을 때만 의미가
      // 있고(1편으로는 종합할 대상이 없다), runner 가 이 optional 메서드를 구현했을 때만 돈다
      // (기존 스텁·레거시 구현은 그대로 동작 — §30 P2). 상한 검사는 역할 루프와 동일.
      if (consensusInputs.length >= 2 && deps.runner.runConsensus) {
        if (costCap != null && totalCostUsd(state) >= costCap) {
          verifySections.push(`## 합의 — 생략됨 (비용 상한 $${costCap} 도달)`);
          deps.log("합의 세션 생략 — 비용 상한 도달");
        } else {
          const consensus = await deps.runner.runConsensus(
            workflowDir, policyFor(state, null, workflowDir, originHost), consensusInputs,
          );
          const lastPhase = state.phases[state.phases.length - 1];
          lastPhase.sessions.push({
            session_id: consensus.sessionId ?? "unknown",
            result: consensus.summary !== null ? "done" : "failed",
            summary: (consensus.summary ?? "(합의 세션 실패)").slice(0, 1000),
            at: deps.now(),
            kind: "consensus",
            cost_usd: consensus.costUsd,
          });
          recordVerdict(
            lastPhase,
            consensus.summary === null
              ? { outcome: "session_failed", detail: "합의 세션이 유효한 합의문을 반환하지 않음" }
              : { outcome: "accepted" },
          );
          if (consensus.summary !== null) {
            verifySections.push(`## 합의\n\n${consensus.summary}`);
            if (consensus.nextGoals.length > 0) {
              // 제안은 STATE 에 기록만 한다 — 다음 사이클을 열지는 사람이 결정한다(되먹임의
              // 연결 고리이자 경계). fw report 가 [다음 목표 제안] 으로 보여준다.
              state.next_goal_suggestions = consensus.nextGoals;
            }
          } else {
            verifySections.push("## 합의 — 실패 (세션이 유효한 합의문을 반환하지 않음)");
          }
          saveState(workflowDir, state);
        }
      }
      // §41 I-1 하위호환 — 역할이 하나(레거시 PLAN)면 VERIFY.md 는 기존과 동일하게 보고서
      // 원문을 그대로 담는다(기존 테스트가 원문 일치를 못박고 있고, VERIFY.md 를 읽는 외부
      // 스크립트가 있어도 깨지지 않는다). 여러 역할일 때만 역할별 절로 구분한다.
      fs.writeFileSync(
        path.join(workflowDir, "VERIFY.md"),
        verifySections.length === 1 && verifyRoles.length === 1
          ? verifySections[0]!.replace(/^## 평가 검증\n\n/, "")
          : verifySections.join("\n\n"),
      );
}
}

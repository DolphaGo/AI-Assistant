// §25 리팩토링: orchestrator.ts 에서 §27 O2/O3(비용·시간 상한, 킬 스위치) 정지 체크포인트를 이
// 모듈로 옮겼다(순수 이동 — 로직 변경 없음). runWorkflow(phase 루프)와 prloop.ts 의 PR 폴링/fix
// 세션 루프 양쪽이 이 함수 하나를 공유해서 쓴다(§30 P1 — 복붙하면 다음 라운드에 갈린다).
import { saveState, totalCostUsd, type State } from "./state.js";
import { isStopRequested, stopFileProblem } from "./stop.js";
import type { OrchestratorDeps } from "./orchestrator-types.js";

// §27 O2/O3, §30 P1: 상한(비용·시간)·킬 스위치(STOP 파일) 체크포인트. "새 걸음을 떼기 직전"에만
// 두는 게 설계 원칙(§2 D17) — 돌고 있는 세션을 중간에 죽이면 커밋이 반쯤 된 상태가 남는다. 세
// 지점(①phase attempt 루프 진입 전 ②fix 세션 실행 전 ③PR 폴링 sleep 후) 모두 이 함수 하나를
// 거치게 한다 — 복붙하면 다음 라운드에 갈린다(§30 P1 교훈, checkBranchDrift/verifySessionCommits
// 와 동일한 이유로 공통 헬퍼로 뺐다).
//
// 우선순위: STOP(운영자의 명시적 의사) → 비용 상한 → 시간 상한. 셋 다 걸리지 않으면 false 를
// 반환해 정상 경로(상한 미설정/미달)를 전혀 건드리지 않는다(§30 P2).
export function checkHaltpoint(
  workflowDir: string,
  state: State,
  deps: OrchestratorDeps,
  runStartedAt: string,
): boolean {
  if (isStopRequested(workflowDir)) {
    // §32 I-5: 정상적인 `fw stop` (일반 파일, 쓰기 가능한 디렉토리)이면 사유는 그대로 "operator"
    // 다 — 다음 `fw run` 시작 시 consumeStopFile 이 정상 소비하고 계속 진행하므로 이 문자열을
    // 바꾸면 안 된다(orchestrator.test.ts 가 `toBe("operator")` 로 정확히 검증한다, §30 P2 회귀
    // 방지). STOP 이 비정상(디렉토리·권한 없음 등, `mkdir STOP` 시나리오)일 때만 사유를 늘려
    // "재실행해도 왜 또 정지하는지"를 halt_reason 에 남긴다 — `fw status`/`fw log` 로 원인이
    // 보여야 사람이 STOP 을 직접 지우고 나서야 벗어날 수 있다는 걸 알 수 있다.
    const problem = stopFileProblem(workflowDir);
    haltWorkflow(workflowDir, state, deps, problem ? `operator (${problem})` : "operator");
    return true;
  }
  if (state.max_cost_usd != null) {
    const cost = totalCostUsd(state);
    if (cost >= state.max_cost_usd) {
      haltWorkflow(
        workflowDir, state, deps,
        `비용 상한 초과: $${cost.toFixed(2)} / $${state.max_cost_usd.toFixed(2)}`,
      );
      return true;
    }
  }
  if (state.max_runtime_ms != null) {
    // deps.now() 로만 시간을 잰다 — Date.now() 를 직접 쓰면 테스트가 주입한 now() 와 어긋나
    // 결정론적 테스트가 불가능해진다.
    const elapsedMs = Date.parse(deps.now()) - Date.parse(runStartedAt);
    if (elapsedMs >= state.max_runtime_ms) {
      haltWorkflow(
        workflowDir, state, deps,
        `시간 상한 초과: ${elapsedMs}ms / ${state.max_runtime_ms}ms (시작 ${runStartedAt})`,
      );
      return true;
    }
  }
  return false;
}

// §32 I-5: 세 가지 halted 사유가 "재개 가능"이라는 점에서는 같지만, "그냥 재실행하면 되는가"는
// 사유마다 다르다 — 감사자 실측:
//   - operator(STOP, 정상 파일)  → 다음 `fw run` 이 소비하고 계속 간다. 재실행하면 된다.
//   - 시간 상한                 → 새 `fw run` 은 runStartedAt 을 다시 기록하므로 재실행하면 된다.
//   - 비용 상한                 → totalCostUsd 는 STATE 에 쌓인 phases[].sessions[].cost_usd 의
//     누적이라 재실행해도 그대로 남아있다 — 상한을 올리거나 누적을 정리하지 않는 한 다음
//     체크포인트에서 **즉시** 다시 halted 된다. "재실행하세요"는 사실과 반대되는 안내였다.
//   - operator(STOP, 비정상)     → 다음 `fw run` 이 시작 시 소비를 다시 시도하지만 같은 이유로
//     실패하고, 이 체크포인트에서 다시 halted 된다. "재실행하세요"만 말하면 영구 루프의 원인이
//     안 보인다 — reason 문자열에 이미 담긴 사유를 그대로 안내에 반영한다.
// 정확한 사유 판별은 reason 문자열의 접두(모두 이 파일의 checkHaltpoint 가 직접 조립한 값이라
// 형식이 고정돼 있다)로 한다 — 별도 enum 을 추가하면 상태 백리스크(orchestrator.test.ts 의
// `toBe("operator")` 회귀 등)를 늘릴 수 있어 문자열 판별로 충분한 최소 변경을 택한다.
// §32 후속: `fw doctor` 의 정지 절도 같은 안내를 보여줘야 한다. 런로그에서만 사유별로 분기하고
// doctor 표시면에는 "그대로 재개할 수 있습니다" 를 하드코딩해 두면, 비용 상한/STOP 삭제 실패로
// 멈춘 워크플로우에 대해 두 화면이 **상반된 안내**를 한다 — I-5 가 지적한 "반대 안내" 를 표시면
// 하나만 고친 셈이 된다(§30 P1: 방어·안내를 한 경로에만 세우지 마라). export 해서 공유한다.
export function haltGuidance(reason: string): string {
  if (reason.startsWith("비용 상한 초과")) {
    return (
      "재실행해도 즉시 다시 정지합니다 — 이 상한은 완료된 phase 를 포함한 누적 비용 " +
      "(totalCostUsd) 기준입니다. max_cost_usd 를 올리거나 STATE.json 의 " +
      "phases[].sessions[].cost_usd 누적을 정리한 뒤 다시 실행하세요."
    );
  }
  if (reason.startsWith("operator (STOP 파일 삭제 실패")) {
    return "재실행해도 같은 사유로 다시 정지합니다 — 위 사유를 해결한 뒤 다시 실행하세요.";
  }
  return "재개하려면 `fw run` 을 다시 실행하세요 (halted 는 이어서 돌 수 있습니다).";
}

function haltWorkflow(workflowDir: string, state: State, deps: OrchestratorDeps, reason: string): void {
  state.status = "halted";
  state.halt_reason = reason;
  saveState(workflowDir, state);
  deps.log(`⏸ 정지: ${reason} — ${haltGuidance(reason)}`);
  deps.notify("fw 정지", reason);
}

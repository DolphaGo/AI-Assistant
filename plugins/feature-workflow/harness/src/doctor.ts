import { execFile } from "node:child_process";
import type { SandboxSettings } from "@anthropic-ai/claude-agent-sdk";
import {
  loadState, assertRunnable, verifyCommandsFor, totalCostUsd, formatCostLine, allPhasesDone,
  checkRunLogsIgnored, suggestGitignoreLineForLogs, defaultRunLogsGitCheckIgnoreExec, runLogsNotIgnoredReason,
  resolveSandboxSettings, sandboxOriginHostAutoAdded,
  type State, type Phase, type RunLogsIgnoreCheck, type RunLogsGitCheckIgnoreExec,
} from "./state.js";
import { isStopRequested, stopFileProblem } from "./stop.js";
import { haltGuidance } from "./halt.js";
import { preflight, defaultGitExec, defaultGhExec, type PreflightDeps, type PreflightResult } from "./preflight.js";
import { runGate, type Gate, type CommandResult } from "./gate.js";
import { lintVerifyCommands, type VerifyIssue } from "./verifylint.js";
import { readPlanContext, type PlanDiagnostics } from "./plan.js";
import { detectBaseBranch, type BaseBranchDetection } from "./branch.js";

// §18 — 이 도구의 전체 가치가 verify 명령의 exit code 한 점에 걸려 있는데, 그 신뢰가 한동안
// "사용자의 산문 규율"로만 지켜졌다(README/SKILL/start.md 의 경고는 코드 검사가 없었다).
//
// §26 I5 잔여(승격, 이번 라운드 완료): 이전에는 이 린트가 `fw doctor` 의 옵트인 진단에만 쓰이고
// `fw run` 은 전혀 보지 않아, `npm test || true` 처럼 항상 exit 0 인 명령이 fw doctor 에서도
// "ok" 로 나오면서 밤새 게이트가 전부 "통과"하고 워크플로우가 done 이 될 수 있었다(§29 MI-11
// 실측). 이제 state.ts 의 assertRunnable 이 이 린트(severity: "error")로 `fw run` 시작 자체를
// 거부한다 — 실제 규칙 테이블은 순환 의존(state.ts → doctor.ts → state.ts)을 피하기 위해
// verifylint.ts(leaf 모듈)로 옮겼고, 여기서는 기존 호출부/테스트가 깨지지 않도록 그대로
// re-export 한다.
export type { VerifyIssue };
export { lintVerifyCommands };

export interface PhaseVerifyLint {
  phaseId: number;
  phaseTitle: string;
  commands: string[];
  issues: VerifyIssue[];
}

function lintPhase(state: State, phase: Phase): PhaseVerifyLint {
  let commands: string[] = [];
  try {
    commands = verifyCommandsFor(state, phase);
  } catch {
    // phase.verify 와 verify_default 가 모두 비어 있음 — assertRunnable(stateInvariants 절)이
    // 이미 이 문제를 보고하므로 여기서는 조용히 빈 목록으로 취급한다(중복 보고 방지).
    commands = [];
  }
  return { phaseId: phase.id, phaseTitle: phase.title, commands, issues: lintVerifyCommands(commands) };
}

export interface PhaseVerifyRun {
  phaseId: number;
  phaseTitle: string;
  commands: string[];
  passed: boolean;
  results: CommandResult[];
}

export interface StateInvariantsResult {
  ok: boolean;
  problem: string | null;
}

// §27 O2/O3 진단: 정지 신호와 상한은 "왜 하네스가 아무 일도 안 하는가" 의 가장 흔한 원인이
// 될 수 있으므로 doctor 가 먼저 알려줘야 한다. 특히 남아 있는 STOP 파일은 `fw run` 이 시작 시
// 소비하도록 설계됐지만, 소비 전에 다른 이유로 죽으면 남고 그 뒤 실행이 첫 체크포인트에서
// 계속 정지한다 — 사용자에게는 "돌렸는데 그냥 멈춘다" 로만 보인다.
export interface HaltDiagnostics {
  // STOP 파일이 남아 있나 (fw run 이 시작 시 소비하지만 남아 있을 수 있다)
  stopFilePresent: boolean;
  // §32 I-5: STOP 이 있는데 **정상적으로 소비될 수 없는 상태**인가(디렉토리·권한 없음 등,
  // `mkdir STOP` 시나리오). null = 문제 없음(STOP 없음, 또는 있어도 정상 파일 + 쓰기 가능한
  // 디렉토리). non-null = 다음 `fw run` 도 소비에 실패해 같은 사유로 다시 halted 될 것이다 —
  // 이건 "운영자가 방금 fw stop 을 눌러 STOP 이 남아있는" 정상 상태와 명확히 구분되는 이상
  // 상태이므로 doctorHasProblems 가 이것만 문제로 센다(§30 P2 위반이 아니다).
  stopFileProblem: string | null;
  // STATE 가 halted 로 주차돼 있나 + 그 사유
  halted: boolean;
  haltReason: string | null;
  // 상한 대비 현재 누적 비용 (상한 미설정이면 maxCostUsd 는 null)
  costUsd: number;
  maxCostUsd: number | null;
  maxRuntimeMs: number | null;
}

export interface DoctorReport {
  workflow: string;
  repoRoot: string;
  preflight: PreflightResult;
  stateInvariants: StateInvariantsResult;
  phaseLints: PhaseVerifyLint[];
  // §31 후속: phaseLints 는 `verifyCommandsFor`(phase.verify 우선, 없으면 default) 기준이라
  // **모든 non-done phase 가 자기 verify 를 가지면 `verify_default` 가 리포트에 아예 안 뜬다.**
  // 그런데 `fw run`(assertRunnable)은 §31 I2 이후 default 를 항상 린트해 거부하므로, 진단
  // 도구가 "OK" 라고 한 뒤 `fw run` 이 거부하는 어긋남이 생긴다. default 를 별도로 린트해 둔다.
  defaultLint: VerifyIssue[];
  // default 가 실제로 어느 phase 의 유효 명령으로 쓰이는지 — 안 쓰이면 리포트에서 그 사실을
  // 함께 알려 사용자가 "왜 쓰지도 않는 명령 때문에 막히나" 를 이해할 수 있게 한다.
  //
  // §32 SURVIVED M60: 이 필드는 `status !== "done" && verify.length === 0` 기준이다 —
  // `status !== "done"` 을 빼면 이미 끝난(재실행되지 않을) phase 까지 "이 phase 가 default 를
  // 쓴다"고 잘못 보고하게 된다(전 phase가 done이어도 항상 true가 되어버림). 회귀 테스트는
  // test/doctor.test.ts 의 "SURVIVED M60" describe 참조.
  defaultUsedByPhase: boolean;
  // §32 I-4: state.ts 의 assertRunnable 은 이제 전 phase 가 done 이면(allPhasesDone) verify_default
  // 린트 블록 전체를 건너뛴다(실행될 명령이 없으므로) — doctor 도 같은 계약이어야 "doctor 는
  // 문제 없다고 했는데 fw run 은 거부한다"(또는 그 반대) 는 어긋남이 생기지 않는다.
  // doctorHasProblems 와 formatDoctorReport 양쪽이 이 값으로 판정/문구를 assertRunnable 과 맞춘다.
  allPhasesDone: boolean;
  // null = --no-run 으로 실측을 건너뜀. 빈 배열 = 실행할 검증 명령이 하나도 없었음.
  runs: PhaseVerifyRun[] | null;
  halt: HaltDiagnostics;
  // §31 I6/§30 P4 — readPlanContext(§28 W1)가 PLAN.md 의 §핵심 결정·§용어 절을 실제로 찾았는지,
  // 몇 자를 주입했는지를 사람이 볼 수 있게 한다. session.ts(다른 에이전트 소유)는 이 결과를
  // deps.log 로 남기지 않으므로, 지금은 doctor 가 유일한 관측 창구다(후속 배선 필요 — 보고서 참조).
  planContext: PlanDiagnostics;
  // §32 남은 부채/§30 P3 — docs/<workflow>/logs/ 가 git 에 무시되는지(state.ts 의
  // checkRunLogsIgnored 참조). "not-ignored" 인데 allowUntrackedLogs 가 false 면
  // doctorHasProblems 가 exit 1 로 올린다 — §27 O1 감사 로그(DENY 명령 전문)가 마스킹되지 않은
  // 채 대상 리포에 커밋될 수 있는 근본 위험이라 정적 검사·STATE 불변식과 같은 급으로 다룬다.
  runLogsProtection: RunLogsProtectionDiagnostics;
  // pr-slicing Phase 5 — 조각 분해 관측(켜짐 여부·예산·통합 브랜치·조각 그룹·건너뛴 이유·
  // base 브랜치 관례 불일치·통합 PR). doctorHasProblems 판정에는 넣지 않는다 — 전부
  // 정보이거나 의도적일 수 있는 경고다(샌드박스 절과 같은 취급).
  // `.optional()` 인 이유는 PlanDiagnostics 와 같다 — 테스트/다른 소비처가 이미 DoctorReport
  // 리터럴을 만들고 있어 필수로 하면 그 리터럴들이 전부 컴파일 에러가 난다. runDoctor 는
  // 항상 채워서 반환하므로 formatDoctorReport 는 안전하게 읽을 수 있다.
  reviewSplit?: ReviewSplitDiagnostics;
  // §37 T1 — 샌드박스 켜짐 여부·플랫폼 지원 힌트. doctorHasProblems 판정에는 넣지 않는다(아래
  // SandboxDiagnostics 정의 다음의 doctorHasProblems 참조) — 꺼짐은 기본값이라 문제가 아니다(§30 P2).
  sandbox: SandboxDiagnostics;
}

export interface RunLogsProtectionDiagnostics extends RunLogsIgnoreCheck {
  // state.allow_untracked_logs — 사용자가 위험을 알고도 명시적으로 수용했는지(§30 P2 탈출구).
  allowUntrackedLogs: boolean;
}

// §37 T1/S3/§30 P4 — "샌드박스를 켰다"(또는 "안 켰다")는 사실이 눈에 보여야 한다(§36 I-3 이
// 이미 겪은 부채 — 관측 없이 배선만 하면 다음 라운드에 같은 질문이 반복된다).
export interface SandboxDiagnostics {
  // resolveSandboxSettings(state) 가 undefined 를 반환하지 않는지 — state.ts 의 §37 S1 옵트인
  // 판정을 doctor 가 재계산하지 않고 그대로 재사용한다(§30 P1).
  enabled: boolean;
  // 이 프로세스가 돌고 있는 플랫폼. 실제로 세션을 띄워 샌드박스가 동작하는지까지는 확인하지
  // 않는다(§37 지시 — 유료 세션 실행 금지) — SDK 문서(sdk.d.ts)가 언급하는 지원 플랫폼과
  // 이름만 대조한 **미검증** 힌트다.
  platform: NodeJS.Platform;
  // darwin(Seatbelt)/linux(bubblewrap)/win32(네이티브) — SDK 문서가 명시적으로 언급하는
  // 플랫폼 3종. 그 외는 지원 여부를 이 하네스가 판단할 근거가 없다. 여전히 **이름 대조**다
  // (D3 잔여 — win32/darwin 은 이번 phase 범위 밖, 아래 bwrapCheck 주석 참조).
  platformKnownSupported: boolean;
  // sandbox-trial PLAN D3/D4 — Linux 의 실제 의존성(bubblewrap/`bwrap`)이 PATH 에 있어
  // 호출 가능한지 **실측**한 결과. platform !== "linux" 면 이 실측 자체가 적용되지 않으므로
  // null(검사 안 함) — "미확인"과는 다른 뜻이다(미확인은 실측을 시도했지만 판정 못한 경우,
  // null 은 애초에 이 플랫폼에 해당 없음). darwin(Seatbelt)/win32(네이티브)는 이번 phase
  // 범위 밖이라 아직 실측하지 않는다 — 있지도 않은 확신을 표시하지 않기 위해 여기도 null 이다.
  bwrapCheck: BwrapCheck | null;
  // §37 sandbox-trial 막힘 1 후속/§30 P4 — resolveSandboxSettings(state, preflight.originHost) 가
  // 실제로 만든 network.allowedDomains(있다면). enabled:false 면 sandbox 자체가 없으므로 null.
  // allowedDomains 를 아예 설정하지 않았고 origin 호스트도 못 구했으면(로컬 전용 리포 등) 역시
  // null — "허용 목록이 비어 있다(전부 거부)"인 빈 배열과는 다른 뜻이다.
  networkAllowedDomains: string[] | null;
  // sandboxOriginHostAutoAdded(state.ts) 와 동일한 판정 — 그 배열 중 어느 항목이 사용자가 적은
  // 것이 아니라 이 하네스가 origin 호스트를 자동으로 채운 것인지. 사용자가 network.allowedDomains
  // 를 명시했다면(빈 배열 포함) 항상 null이다(§30 P2 — 사용자 설정을 존중).
  originHostAutoAdded: string | null;
  // §41 C-3 — 무력화 신호. 아래 sandboxNeutralizationSignals 의 주석 참조(자세한 근거는 거기 있다).
  // 요약: filesystem.disabled:true(SDK: "unrestricted read/write access to the host filesystem")나
  // 와일드카드 네트워크 도메인(`*`)이 켜져 있으면 "샌드박스가 켜졌다"는 사실만으로는 실제
  // 보호 수준을 알 수 없다 — §37 S3 가 원한 "켜졌는지 보여줘야 한다"는 목적에는 "무엇이
  // 켜졌는가"까지 포함된다(§30 P4). autoAllowBashIfSandboxed/allowUnsandboxedCommands 는 여기
  // 없다 — state.ts 담당자가 그 두 필드를 resolveSandboxSettings 소비 시점에 항상 false 로
  // 강제하므로(§41 C-1/C-2), 강제 후 값은 사용자가 STATE 에 무엇을 넣든 항상 안전한 쪽으로
  // 고정된다. 강제된 필드를 여기서도 표시하면 "사용자가 무력화를 시도했다"는 인상을 주지만
  // 실제 동작에는 전혀 영향이 없어 오히려 혼란만 준다(failIfUnavailable 강제와 같은 논리 —
  // 그 필드도 "강제 적용" 한 줄만 알리고 사용자가 뭘 넣었는지는 보여주지 않는다).
  filesystemDisabled: boolean;
  wildcardNetworkDomains: string[];
}

// §41 C-3 — 값이 "*"(또는 "*" 만의 반복)인 도메인만 "사실상 모든 아웃바운드를 허용한다"로 본다.
// "*.github.com" 처럼 특정 도메인 하위로 범위를 좁힌 와일드카드는 SDK 문서가 명시한 정당한
// 스코프 축소 문법이므로 여기 포함하지 않는다 — 과잉 탐지는 정상 사용을 오탐으로 만든다(§30 P2).
// 감사자가 실측으로 지적한 것도 정확히 `allowedDomains: ["*"]`(전체 개방)였다.
function isBroadDomainPattern(domain: string): boolean {
  return /^\*+$/.test(domain.trim());
}

export interface SandboxNeutralizationSignals {
  filesystemDisabled: boolean;
  wildcardNetworkDomains: string[];
}

// §41 C-3 — resolveSandboxSettings 가 실제로 만든 SandboxSettings(강제 적용 후) 를 보고 무력화
// 신호를 판정하는 유일한 지점. doctor.ts(`fw doctor`)와 cli.ts(`fw status`) 양쪽이 이 함수 하나만
// 호출한다(§30 P1 — 판정 기준이 두 곳에서 따로 계산되면 다음 라운드에 갈린다). STATE 원본이 아니라
// **이 함수의 인자로 들어오는 resolveSandboxSettings 결과**를 봐야 한다 — 그래야 다른 필드(예:
// failIfUnavailable)처럼 강제 적용된 값이 반영된 "실제로 무엇이 허용되는가"를 판정하게 된다.
export function sandboxNeutralizationSignals(settings: SandboxSettings | undefined): SandboxNeutralizationSignals {
  return {
    filesystemDisabled: settings?.filesystem?.disabled === true,
    wildcardNetworkDomains: (settings?.network?.allowedDomains ?? []).filter(isBroadDomainPattern),
  };
}

/** 무력화 신호가 하나라도 있으면 true. "활성" 표시 문구를 바꿀지 판정하는 공유 기준. */
export function isSandboxNeutralized(signals: SandboxNeutralizationSignals): boolean {
  return signals.filesystemDisabled || signals.wildcardNetworkDomains.length > 0;
}

/** 사람이 읽는 무력화 사유 목록. doctor 의 다중 행 표시와 status 의 한 줄 표시가 이 문구를 공유한다. */
export function sandboxNeutralizationNotes(signals: SandboxNeutralizationSignals): string[] {
  const notes: string[] = [];
  if (signals.filesystemDisabled) notes.push("파일시스템 격리 꺼짐(filesystem.disabled)");
  if (signals.wildcardNetworkDomains.length > 0) {
    notes.push(`네트워크 allowedDomains 와일드카드(${signals.wildcardNetworkDomains.join(", ")})`);
  }
  return notes;
}

// PLAN D4 — 실측이 불가능하거나 불확실하면 "미확인"으로 표시한다(있지도 않은 확신을 표시하지
// 않는다). "found"/"not-found"는 실제로 프로세스를 스폰해 얻은 결과이고, "unconfirmed"는 스폰
// 자체가 ENOENT 도 아니고 성공도 아닌 애매한 실패(권한 문제 등)일 때다.
export interface BwrapCheck {
  status: "found" | "not-found" | "unconfirmed";
  // 사람이 리포트에서 판정 근거를 확인할 수 있게(§30 P4 — 관측 가능성).
  detail: string;
}

const BWRAP_CHECK_TIMEOUT_MS = 5_000;

// Linux 에서 `bwrap`(bubblewrap)이 실제로 실행 가능한지 실측한다 — PATH 문자열을 파싱해
// 추론하는 대신 실제로 스폰해본다(스폰 성공 자체가 "실행 가능한 바이너리가 존재한다"는 가장
// 직접적인 증거다). exit code/시그널과 무관하게 스폰이 성공하면 존재를 확인한 것으로 본다 —
// `bwrap --version` 이 미래에 실패하는 옵션이 되더라도 이 판정은 흔들리지 않는다.
export function defaultCheckBwrap(): Promise<BwrapCheck> {
  return new Promise(resolve => {
    execFile("bwrap", ["--version"], { timeout: BWRAP_CHECK_TIMEOUT_MS }, (err) => {
      if (!err) {
        resolve({ status: "found", detail: "`bwrap --version` 실행 성공" });
        return;
      }
      const e = err as NodeJS.ErrnoException & { signal?: NodeJS.Signals | null };
      if (e.code === "ENOENT") {
        resolve({ status: "not-found", detail: "PATH 에서 `bwrap` 실행 파일을 찾을 수 없습니다 (ENOENT)" });
        return;
      }
      if (typeof e.code === "number" || e.signal) {
        // 스폰은 성공했다(바이너리가 존재하고 실행됐다) — 종료 코드가 0이 아니거나 시그널로
        // 죽었더라도 "존재 여부" 판정에는 영향이 없다.
        resolve({ status: "found", detail: "`bwrap` 이 스폰됐습니다 (종료 코드/시그널과 무관하게 실행 파일은 존재합니다)" });
        return;
      }
      // ENOENT 도 아니고 정상 스폰도 아닌 애매한 실패(예: 권한 문제) — 있다고도 없다고도
      // 단정하지 않는다(PLAN D4).
      resolve({ status: "unconfirmed", detail: `실측 실패(원인 불명): ${e.message}` });
    });
  });
}

export interface DoctorDeps {
  // preflight 와 동일한 계약(§19 재사용) — 기본은 실제 git/gh CLI. 테스트는 스텁 주입.
  git?: PreflightDeps["git"];
  gh?: PreflightDeps["gh"];
  gate?: Gate;
  // 기본 true — 각 phase 의 verify 명령을 실제로 1회 실행해 "지금 통과하는지" 확인한다.
  // false 면 정적 검사·프리플라이트·STATE 불변식만 본다(`fw doctor --no-run`).
  run?: boolean;
  // §32 남은 부채/§30 P3: checkRunLogsIgnored 전용 git 실행기. 위 `git`(CliExecResult 계약)과
  // 일부러 분리했다 — state.ts 의 checkRunLogsIgnored 주석 참조("exit 1 의 빈 stderr 가
  // err.message 로 채워져 not-ignored 와 저장소 아님을 구분할 수 없게 되는 것을 실측으로
  // 확인"). 기본은 실제 git CLI(defaultRunLogsGitCheckIgnoreExec) — 테스트는 스텁 주입.
  checkIgnoreGit?: RunLogsGitCheckIgnoreExec;
  // §37 T1 — [샌드박스] 절의 플랫폼 힌트. 기본은 실제 process.platform. 테스트가 다른 플랫폼을
  // 흉내내려면(예: linux CI 에서 darwin 라벨을 확인) 주입한다.
  platform?: NodeJS.Platform;
  // sandbox-trial PLAN D3 — platform === "linux" 일 때 bwrap 실측에 쓸 실행기. 기본은
  // defaultCheckBwrap(실제 스폰). 테스트가 found/not-found/unconfirmed 각 분기와 mutant 판별력을
  // 확인하려면 주입한다.
  checkBwrap?: () => Promise<BwrapCheck>;
}

/**
 * `fw doctor <dir>` 의 핵심 로직. STATE.json 을 읽어 프리플라이트·STATE 불변식·verify 명령
 * 정적 검사·(옵션) 실측 실행을 모두 모아 하나의 리포트로 반환한다. 어느 것도 throw 하지 않는다
 * (loadState 자체의 실패는 예외 — STATE.json 이 없거나 깨졌으면 점검할 대상이 없으므로 호출자가
 * 처리한다).
 */
// ── pr-slicing Phase 5: 조각 분해 진단 ──────────────────────────────────────
// 새 기능은 관측 창구가 있어야 한다(§30 P4). "왜 안 쪼개졌는지"·"통합 브랜치가 무엇인지"·
// "base 브랜치가 리포 관례와 어긋나지 않는지"를 사람이 볼 수 있어야 한다 — 조각 PR 이
// 잘못된 곳으로 가는 사고는 PR 이 만들어진 뒤에 알면 이미 늦다.

export interface ReviewSplitDiagnostics {
  enabled: boolean;
  budgetLines: number | null;
  integrationBranch: string | null;
  /** 원본 phase 별 조각 그룹과 진행률 */
  sliceGroups: Array<{ originId: number; total: number; doneCount: number }>;
  /** 분해를 건너뛴 phase 와 그 이유 — fail-open 이 조용히 넘어가지 않게 하는 관측 지점 */
  skipped: Array<{ phaseId: number; reason: string }>;
  /** 설정된 base_branch 가 감지 결과와 다르면 채워진다. 의도적일 수 있어 경고일 뿐이다. */
  baseBranchMismatch: { configured: string; detected: string; reason: string } | null;
  integrationPrUrl: string | null;
}

/**
 * detected 가 null 이면(감지를 돌리지 않았음) 불일치 판정을 하지 않는다. 감지가 폴백
 * (source:"fallback")이어도 판정하지 않는다 — 감지 **실패**를 "관례 위반"으로 오인해
 * 사용자에게 엉뚱한 경고를 내지 않기 위함이다(D15 의 폴백 사유 구분과 같은 규율).
 */
export function buildReviewSplitDiagnostics(
  state: State,
  detected: BaseBranchDetection | null,
): ReviewSplitDiagnostics {
  const groups = new Map<number, { originId: number; total: number; doneCount: number }>();
  for (const p of state.phases) {
    const g = p.split_group;
    if (!g) continue;
    const entry = groups.get(g.origin_id) ?? { originId: g.origin_id, total: g.total, doneCount: 0 };
    if (p.status === "done") entry.doneCount += 1;
    groups.set(g.origin_id, entry);
  }
  const mismatch =
    detected !== null && detected.source !== "fallback" && detected.branch !== state.base_branch
      ? { configured: state.base_branch, detected: detected.branch, reason: detected.reason }
      : null;
  return {
    enabled: state.review_split?.enabled === true,
    budgetLines: state.review_split?.budget_lines ?? null,
    integrationBranch: state.integration_branch ?? null,
    sliceGroups: [...groups.values()].sort((a, b) => a.originId - b.originId),
    skipped: state.phases
      .filter(p => p.decompose_skipped_reason !== undefined)
      .map(p => ({ phaseId: p.id, reason: p.decompose_skipped_reason! })),
    baseBranchMismatch: mismatch,
    integrationPrUrl: state.integration_pr?.url ?? null,
  };
}

export async function runDoctor(workflowDir: string, deps: DoctorDeps = {}): Promise<DoctorReport> {
  const state = loadState(workflowDir);

  let stateInvariants: StateInvariantsResult;
  try {
    assertRunnable(state);
    stateInvariants = { ok: true, problem: null };
  } catch (err) {
    stateInvariants = { ok: false, problem: (err as Error).message ?? String(err) };
  }

  const gitExec = deps.git ?? defaultGitExec;
  const ghExec = deps.gh ?? defaultGhExec;
  // §26 C1: workflowDir 을 넘겨 그 서브트리(STATE.json/.fw.lock/logs/)를 워킹트리 청결 검사에서 제외
  // §36 m-1: deps.checkIgnoreGit 을 여기도 전달한다 — 안 그러면 preflight() 내부의 로그 보호
  // 판정과 아래 runLogsProtection 판정이 (스텁 주입 시) 서로 다른 git 실행기를 타서 어긋날 수
  // 있다(프로덕션에서는 둘 다 defaultRunLogsGitCheckIgnoreExec 로 우연히 일치했을 뿐이다 —
  // §30 P1 잠복 사례, 감사자 실측으로 확인).
  const pre = await preflight(state, { git: gitExec, gh: ghExec, checkIgnoreGit: deps.checkIgnoreGit }, workflowDir);

  const phaseLints = state.phases.map(p => lintPhase(state, p));

  let runs: PhaseVerifyRun[] | null = null;
  if (deps.run !== false) {
    const gate = deps.gate ?? runGate;
    runs = [];
    for (const phase of state.phases) {
      const lint = phaseLints.find(l => l.phaseId === phase.id);
      const commands = lint?.commands ?? [];
      if (commands.length === 0) continue; // 실행할 게 없음 — STATE 불변식에서 이미 보고됨
      // §26 M1: orchestrator.ts 는 state.verify_timeout_ms 를 gate 에 넘기는데(§20 대형 빌드
      // 상향 지원) doctor 는 이걸 빠뜨려 gate 기본값(30분)으로 "실측"해왔다 — doctor 가 "지금
      // 통과하는지" 실측한다는 신뢰를 실제 fw run 과 다른 조건으로 재는 셈이었다(실측 확인).
      const result = await gate({ commands, cwd: state.repo_root, timeoutMs: state.verify_timeout_ms ?? undefined });
      runs.push({ phaseId: phase.id, phaseTitle: phase.title, commands, passed: result.passed, results: result.results });
    }
  }

  const halt: HaltDiagnostics = {
    stopFilePresent: isStopRequested(workflowDir),
    // §32 I-5: stopFileProblem 은 STOP 을 건드리지 않는 진단이므로 doctor 실행 자체가 STOP 을
    // 소비해버리는 부작용이 없다 — "정상 STOP 파일이 doctor 를 한 번 돌렸더니 사라졌다" 같은
    // 사고를 방지한다.
    stopFileProblem: stopFileProblem(workflowDir),
    halted: state.status === "halted",
    haltReason: state.halt_reason ?? null,
    costUsd: totalCostUsd(state),
    maxCostUsd: state.max_cost_usd ?? null,
    maxRuntimeMs: state.max_runtime_ms ?? null,
  };

  // §31 I6 — readPlanContext 자체는 예외를 던지지 않는 계약(§30 P2)이므로 여기서도 감싸지 않는다.
  const planContext = readPlanContext(workflowDir).diagnostics ?? {
    planFound: false, decisionsHeading: null, glossaryHeading: null, decisionsChars: 0, glossaryChars: 0,
  };

  // §31 후속: default 는 어느 phase 도 쓰지 않아도 린트한다(assertRunnable 과 같은 계약).
  const defaultLint = lintVerifyCommands(state.verify_default);
  const defaultUsedByPhase = state.phases.some(
    p => p.status !== "done" && p.verify.length === 0,
  );

  // §32 남은 부채/§30 P3: checkRunLogsIgnored 자체는 throw 하지 않는 계약(§30 P2 — 판정 불가는
  // "unknown"으로 degrade)이므로 여기서도 감싸지 않는다. gitExec 는 preflight 와 동일한 것을
  // 재사용한다(§19 재사용 원칙 — 같은 git 실행기를 두 곳에서 따로 만들지 않는다).
  const runLogsProtection: RunLogsProtectionDiagnostics = {
    ...(await checkRunLogsIgnored(
      deps.checkIgnoreGit ?? defaultRunLogsGitCheckIgnoreExec, state.repo_root, workflowDir,
    )),
    allowUntrackedLogs: state.allow_untracked_logs ?? false,
  };

  // §37 T1 — resolveSandboxSettings 를 그대로 재사용한다(§30 P1: fw status·policyFor 와 같은
  // 판정 기준). 플랫폼 힌트는 실제로 세션을 띄우지 않고 이름만 대조하는 미검증 정보다.
  const platform = deps.platform ?? process.platform;
  // sandbox-trial PLAN D3/D4 — Linux 에서만 실제 의존성(bwrap)을 실측한다(이번 phase 범위).
  // 다른 플랫폼은 실측 대상이 아니므로 null(미확인이 아니라 "해당 없음").
  let bwrapCheck: BwrapCheck | null = null;
  if (platform === "linux") {
    const checkFn = deps.checkBwrap ?? defaultCheckBwrap;
    try {
      bwrapCheck = await checkFn();
    } catch (err) {
      // defaultCheckBwrap/주입된 checkFn 은 reject 하지 않는 계약이지만, 방어적으로 감싼다 —
      // 여기서도 예외가 나면 "없다"가 아니라 "미확인"으로 degrade 한다(PLAN D4, §30 P2).
      bwrapCheck = { status: "unconfirmed", detail: `실측 중 예외: ${(err as Error).message ?? String(err)}` };
    }
  }
  // §37 sandbox-trial 막힘 1 후속 — pre.originHost 는 위 preflight() 호출이 이미 구했다(§30 P1:
  // git 을 다시 호출하지 않고 재사용). resolveSandboxSettings/sandboxOriginHostAutoAdded 가
  // policyFor(permissions.ts)와 완전히 같은 기준으로 "실제로 무엇이 허용되는가" 를 계산한다 —
  // doctor 는 그 계산을 재구현하지 않고 그대로 관측만 한다(§30 P4).
  const sandboxSettings = resolveSandboxSettings(state, pre.originHost);
  // §41 C-3 — resolveSandboxSettings 의 실제 반환값(강제 적용 후)을 그대로 넘긴다. STATE 원본을
  // 다시 읽지 않는다(§30 P1 — 판정은 한 곳에서만).
  const neutralization = sandboxNeutralizationSignals(sandboxSettings);
  const sandbox: SandboxDiagnostics = {
    enabled: !!sandboxSettings,
    platform,
    platformKnownSupported: platform === "darwin" || platform === "linux" || platform === "win32",
    bwrapCheck,
    networkAllowedDomains: sandboxSettings?.network?.allowedDomains ?? null,
    originHostAutoAdded: sandboxOriginHostAutoAdded(state, pre.originHost),
    filesystemDisabled: neutralization.filesystemDisabled,
    wildcardNetworkDomains: neutralization.wildcardNetworkDomains,
  };

  return {
    workflow: state.workflow, repoRoot: state.repo_root, preflight: pre, stateInvariants,
    phaseLints, runs, halt, planContext, defaultLint, defaultUsedByPhase, runLogsProtection, sandbox,
    reviewSplit: buildReviewSplitDiagnostics(state, await detectBaseBranch(state.repo_root, gitExec)),
    allPhasesDone: allPhasesDone(state),
  };
}

/** 리포트에 exit 1 로 이어질 문제가 있는지. warn 단독으로는 실패로 치지 않는다. */
export function doctorHasProblems(report: DoctorReport): boolean {
  const lintErrors =
    report.phaseLints.some(l => l.issues.some(i => i.severity === "error")) ||
    // §31 후속/§32 I-4: assertRunnable 은 이제 전 phase 가 done 이면(allPhasesDone) default 린트를
    // 아예 건너뛴다(실행될 명령이 없으므로) — doctor 도 같은 예외를 두지 않으면 "fw run 은 이제
    // 통과하는데 doctor 는 여전히 exit 1" 이라는 새 어긋남이 생긴다.
    (!report.allPhasesDone && report.defaultLint.some(i => i.severity === "error"));
  const runFailures = (report.runs ?? []).some(r => !r.passed);
  // §27 O2/O3 — STOP 파일과 halted 는 **문제가 아니다.** `fw run` 은 시작 시 STOP 을 소비(삭제)
  // 하므로(orchestrator.ts) 남아 있는 STOP 이 다음 실행을 막지 않고, halted 도 그냥 이어서
  // `fw run` 하면 재개된다(blocked 와 달리 답변이 필요 없다). 둘 다 표시만 하고 exit 1 로 만들지
  // 않는다 — 운영자가 `fw stop` 을 쓴 직후의 정상 상태를 실패로 보고하면 §30 P2(방어가 정상 경로를
  // 막는다) 를 그대로 재현하게 된다.
  //
  // §32 I-5 — 그러나 STOP 이 **정상적으로 소비될 수 없는 상태**(디렉토리·권한 없음 등, `mkdir
  // STOP` 시나리오)는 다르다. 이건 "운영자가 방금 fw stop 을 눌러 파일이 남아있는" 정상 상태가
  // 아니라, 사람이 손으로 치우기 전까지 매 `fw run` 이 같은 이유로 다시 halted 되는 이상 상태다
  // (감사자 실측: run#1~3 전부 halted, doctor 는 계속 exit 0 이라 아무도 원인을 못 봤다). 이걸
  // exit 1 로 올리는 건 §30 P2 위반이 아니다 — 오히려 "정상 STOP 은 exit 0" 규칙을 지키면서
  // "비정상 STOP 만" 구분해서 잡는 것이 P2 규칙 그 자체다.
  const stopIsStuck = report.halt.stopFileProblem != null;
  //
  // §31 I6 — report.planContext 는 **의도적으로 이 판정에 포함하지 않는다.** §핵심 결정/§용어
  // 절이 없는 PLAN 은 레거시 워크플로우의 정상 상태다(§30 P2) — 미발견을 exit 1 로 만들면
  // "PR 만 만들고 코멘트 처리는 원치 않는다" 류의 정당한 사용까지 doctor 가 막게 된다(§29
  // MI-10 이 이미 겪은 자충수의 재발). planContext 는 표시(관측, §30 P4)만 하고 판정엔 넣지 않는다.
  //
  // §32 남은 부채/§30 P3 — runLogsProtection 은 위 planContext 와 반대로 **판정에 넣는다.**
  // "not-ignored" 는 §27 O1 감사 로그(DENY 명령 전문, 33% 는 의도적으로 마스킹하지 않음)가 대상
  // 리포에 커밋될 수 있는 상태라 정적 검사·STATE 불변식과 같은 급의 실질적 위험이다. 다만
  // "outside-repo"(커밋될 길이 없음)와 "unknown"(git 저장소가 아니거나 판정 자체가 실패)은
  // §30 P2 그대로 문제로 보지 않는다 — 그리고 allowUntrackedLogs(§30 P2 탈출구)가 켜져 있으면
  // 사용자가 위험을 알고도 명시적으로 수용한 것이므로 역시 문제로 보지 않는다.
  const logsUnprotected =
    report.runLogsProtection.status === "not-ignored" && !report.runLogsProtection.allowUntrackedLogs;
  //
  // §41 C-3 — report.sandbox.filesystemDisabled/wildcardNetworkDomains 는 **의도적으로 이 판정에
  // 넣지 않는다.** 샌드박스 자체가 옵트인(§37 S1)이고, SDK 문서(sdk.d.ts:7264)는
  // filesystem.disabled 를 "네트워크 격리는 유지한 채 파일시스템 격리만 끄는" 정당한 배포
  // 패턴(egress 통제가 목적인 배포)으로 명시한다 — 사용자가 알고도 선택했을 수 있는 설정을
  // exit 1 로 만들면 §30 P2(방어가 정상 경로를 막는다) 그대로다. C-3 이 요구한 것은 "차단"이
  // 아니라 "정직한 표시"(§37 S3 — 켜졌는지/무엇이 켜졌는지 보여줘야 한다)이므로, 여기서는
  // 판정에 넣지 않고 formatDoctorReport 의 `⚠` 표시(sandboxSectionLines)로만 알린다 — allow_push
  // 미설정이 문제가 아닌 것과 같은 종류의 "옵트인 위험 수용"이다.
  return (
    !report.preflight.ok || !report.stateInvariants.ok || lintErrors || runFailures || stopIsStuck ||
    logsUnprotected
  );
}

// §32 남은 부채/§30 P4 — §32 I-6 이 plan.ts 에 채워둔 decisions/glossaryCandidate{Count,Headings}
// 를 아무도 표시하지 않고 있었다. 감사자 권고: "골랐다는 사실보다 '다른 후보가 있었다' 가
// 정보다." 후보가 2개 이상이어도 문제(exit 1)로 만들지 않는다 — 정당한 PLAN 구조일 수 있으므로
// (§30 P2) planContextSectionLines 전체와 마찬가지로 순수 표시다.
function candidateWarningLines(count: number | undefined, headings: string[] | undefined): string[] {
  if (count === undefined || !headings || count < 2) return [];
  const quoted = headings.map(h => `"${h}"`).join(", ");
  return [
    `    ⚠️ 후보가 ${count}개 있었습니다: ${quoted}`,
    "       — 의도한 절이 맞는지 확인하세요.",
  ];
}

/** §31 I6/§30 P4 — "PLAN 결정/용어가 주입됐다"는 주장을 doctor 가 직접 확인시켜준다. 절이
 *  없거나 제목이 인식되지 않는 것 자체는 실패가 아니라 정보다(레거시 PLAN 이 정상이므로 —
 *  §30 P2, doctorHasProblems 참조) — 그래서 여기는 exit code 에 영향을 주지 않는 순수 표시. */
function planContextSectionLines(diag: PlanDiagnostics): string[] {
  const lines: string[] = ["[PLAN 결정·용어·검증기준 주입]"];
  if (!diag.planFound) {
    lines.push("  PLAN.md: 없음 — 결정/용어/검증기준 주입 없이 진행합니다 (레거시 워크플로우는 정상입니다)");
    return lines;
  }
  lines.push("  PLAN.md: 있음");

  const describe = (label: string, heading: string | null, chars: number, sectionExample: string): string => {
    if (heading === null) {
      return `  ${label}: 미발견 — 절이 없거나 제목이 인식되지 않았습니다. 표 형식으로 \`## ${sectionExample}\` 절을 두세요.`;
    }
    if (chars === 0) {
      return `  ${label}: 발견 (${heading}) — 그러나 0자 주입됨 (표가 비어 있거나 미치환 템플릿 행만 있습니다)`;
    }
    return `  ${label}: 발견 (${heading}, ${chars}자 주입)`;
  };
  lines.push(describe("§핵심 결정", diag.decisionsHeading, diag.decisionsChars, "핵심 결정 사항"));
  lines.push(...candidateWarningLines(diag.decisionsCandidateCount, diag.decisionsCandidateHeadings));
  lines.push(describe("§용어", diag.glossaryHeading, diag.glossaryChars, "용어"));
  lines.push(...candidateWarningLines(diag.glossaryCandidateCount, diag.glossaryCandidateHeadings));
  // §42 — §검증 기준. 선택 필드라 구버전 diagnostics(5필드)면 undefined 이므로 ?? 로 흡수한다.
  // 이 절이 없는 것도 실패가 아니다(§30 P2) — 다만 "무엇을 근거로 완료를 판정하는가" 가
  // 세션·검증 에이전트에 전달되지 않는다는 뜻이므로 사람이 볼 수 있게 남긴다.
  lines.push(describe("§검증 기준", diag.acceptanceHeading ?? null, diag.acceptanceChars ?? 0, "검증 기준"));
  lines.push(describe("§개발 방향", diag.architectureHeading ?? null, diag.architectureChars ?? 0, "개발 방향"));
  return lines;
}

/** §32 남은 부채/§30 P3 — runLogsProtection 을 사람이 보는 리포트에 표시한다. "not-ignored"
 *  이면서 옵트아웃도 안 돼 있는 경우만 실제 문제(exit 1, doctorHasProblems 참조)로 이어진다. */
function runLogsSectionLines(check: RunLogsProtectionDiagnostics): string[] {
  const lines: string[] = ["[실행 로그 보호]"];
  switch (check.status) {
    case "ignored":
      lines.push(`  OK — ${check.relLogsDir} 가 git 에 무시됩니다`);
      break;
    case "outside-repo":
      lines.push("  OK — workflowDir 이 repo_root 밖입니다 (이 리포에는 커밋될 수 없으므로 검사하지 않습니다)");
      break;
    case "unknown":
      lines.push(
        "  판정할 수 없습니다 (repo_root 가 git 저장소가 아니거나 git check-ignore 실행에 실패했습니다) " +
          "— 문제로 보지 않습니다",
      );
      break;
    case "not-ignored": {
      const relLogsDir = check.relLogsDir ?? "(알 수 없음)";
      if (check.allowUntrackedLogs) {
        lines.push(
          `  ⚠ ${relLogsDir} 가 git 에 무시되지 않지만 allow_untracked_logs: true 로 위험을`,
          "    감수하기로 했습니다 — 감사 로그의 자격증명이 커밋될 수 있습니다.",
        );
      } else if (check.alreadyTrackedInIndex) {
        // §36 I-2: .gitignore 패턴 자체는 맞지만(그 사실을 먼저 확인시켜 사용자가 "안내를 따랐는데
        // 왜 또 걸리나" 로 헤매지 않게 한다) 과거에 이미 커밋된 로그가 index 에 남아 있다 —
        // "줄을 추가하라" 안내는 이미 있는 줄을 다시 추가하라는 것과 같아 탈출구가 안 된다
        // (§26 I5 류 자충수 재발 방지, 감사자 실측).
        const cachedPath = relLogsDir.replace(/\/+$/, "");
        lines.push(
          `  ✗ ${relLogsDir} 는 .gitignore 패턴과 이미 일치하지만, git 이 이 경로를 이미`,
          "    추적 중입니다(과거에 커밋된 로그가 index 에 남아 있습니다) — 다음을 실행해",
          "    추적을 해제하세요(디스크의 파일은 그대로 남습니다):",
          `        git rm -r --cached ${cachedPath}`,
          "    이미 커밋된 로그는 git 히스토리에도 남아 있으니, 자격증명이 실제로 노출됐다면",
          "    히스토리 재작성(git filter-repo 등)도 고려하세요.",
        );
      } else {
        const suggestion = check.relLogsDir ? suggestGitignoreLineForLogs(check.relLogsDir) : "docs/*/logs/";
        lines.push(
          `  ✗ ${relLogsDir} 가 git 에 무시되지 않습니다 — 감사 로그에 마스킹되지 않은`,
          "    자격증명이 남을 수 있고(§32 I-1: 마스킹은 완전하지 않다), 커밋되면 되돌리기 어렵습니다.",
          "    리포 루트 .gitignore 에 다음 줄을 추가하세요:",
          `        ${suggestion}`,
        );
      }
      break;
    }
  }
  return lines;
}

// §36 m-1: preflight.problems 와 runLogsSectionLines 가 "로그가 git 에 무시되지 않는다" 는 같은
// 사실을 각각 보고해 doctor 리포트에 그 문제가 **두 번** 나타났다(§27 O1 감사 로그 감사자 실측).
// runLogsSectionLines 가 이미 더 자세한(§36 I-2 분기 포함) 버전을 보여주므로, [프리플라이트]
// 절에서는 그와 정확히 같은 문자열을 걸러낸다 — doctorHasProblems 판정(report.preflight.ok)은
// 건드리지 않고 **표시만** 정리한다(문자열이 같은 라운드에 바뀌면 이 필터도 함께 갱신해야
// 한다는 점을 주석으로 남겨 §30 P1 재발을 경계한다).
function filteredPreflightProblems(report: DoctorReport): string[] {
  const rlp = report.runLogsProtection;
  if (rlp.status !== "not-ignored" || rlp.allowUntrackedLogs || !rlp.relLogsDir) {
    return report.preflight.problems;
  }
  const duplicate = runLogsNotIgnoredReason(rlp.relLogsDir, { alreadyTrackedInIndex: rlp.alreadyTrackedInIndex });
  return report.preflight.problems.filter(p => p !== duplicate);
}

/** 비용 상한 대비 표시. 상한이 없으면 금액만. (cli/runlog 와 같은 규칙 — state.formatCostLine 재사용) */
function haltSectionLines(halt: HaltDiagnostics): string[] {
  const lines: string[] = ["[정지 신호 / 상한]"];
  if (halt.stopFilePresent) {
    lines.push(
      "  ⏸ STOP 파일이 남아 있습니다 — 정지 요청이 아직 반영되지 않았거나, 정지된 뒤 남은 흔적입니다.",
      "     다음 `fw run` 이 시작 시 이 파일을 소비(삭제)하고 정상 진행하므로 따로 지울 필요는 없습니다.",
    );
    // §32 I-5: 위 안내는 "정상 STOP 파일"을 전제로 한다 — STOP 이 디렉토리이거나 권한이 없어
    // 삭제될 수 없는 상태(`mkdir STOP` 시나리오)라면 그 전제가 깨진다. 이 경우를 exit 1 로
    // 올리는 doctorHasProblems 판정과 짝을 이루도록, 원인을 여기서 명시한다.
    if (halt.stopFileProblem) {
      lines.push(`  ✗ ${halt.stopFileProblem}`);
    }
  }
  if (halt.halted) {
    const reason = halt.haltReason ?? "(사유 없음)";
    lines.push(`  ⏸ halted — 정지 사유: ${reason}`);
    // §32 후속: 사유별 안내를 halt.ts 와 **공유**한다. 여기에 "그대로 재개할 수 있습니다" 를
    // 하드코딩해 두면 비용 상한·STOP 삭제 실패로 멈춘 경우 런로그와 doctor 가 상반된 안내를 한다
    // (§30 P1 — I-5 를 표시면 하나만 고친 셈). blocked 와의 차이는 그 뒤에 덧붙인다.
    lines.push(`     ${haltGuidance(reason)}`);
    lines.push("     (blocked 와 달리 답변은 필요하지 않습니다.)");
  }
  lines.push(`  ${formatCostLine(halt.costUsd, halt.maxCostUsd)}`);
  if (halt.maxRuntimeMs != null) {
    lines.push(`  실행 시간 상한: ${Math.round(halt.maxRuntimeMs / 60_000)}분`);
  }
  if (!halt.stopFilePresent && !halt.halted && halt.maxCostUsd == null && halt.maxRuntimeMs == null) {
    lines.push("  (상한 미설정 — max_cost_usd / max_runtime_ms 로 무인 주행 폭주를 막을 수 있습니다)");
  }
  return lines;
}

// §37 T1/§30 P4 — 샌드박스 켜짐 여부와 플랫폼 힌트를 표시한다. **꺼짐은 exit 1 로 올리지
// 않는다**(§30 P2 — 기본값이 옵트아웃이므로 켜지 않은 것 자체는 문제가 아니다, doctorHasProblems
// 참조) — 대신 켜는 방법을 권고만 한다.
function sandboxSectionLines(diag: SandboxDiagnostics): string[] {
  const lines: string[] = ["[샌드박스]"];
  if (diag.enabled) {
    // §41 C-3 — "활성"이라는 한 마디가 filesystem.disabled/와일드카드 도메인까지 켜져 있어도
    // 그대로 찍히던 것이 감사에서 지적된 결함이다. 무력화 신호가 있으면 문장 자체를 조건부로
    // 바꾸고(● 대신 ⚠), 무엇이 무력화됐는지 바로 아래 줄에 구체적으로 남긴다.
    const notes = sandboxNeutralizationNotes({
      filesystemDisabled: diag.filesystemDisabled,
      wildcardNetworkDomains: diag.wildcardNetworkDomains,
    });
    if (notes.length > 0) {
      lines.push(`  ⚠ 활성 (단, ${notes.join(", ")}) — failIfUnavailable=true 강제 적용`);
      for (const note of notes) lines.push(`    - ${note}`);
    } else {
      lines.push("  ● 활성 — failIfUnavailable=true 강제 적용 (의존성이 없으면 세션이 오류로 종료합니다)");
    }
    // §37 sandbox-trial 막힘 1 후속/§30 P4 — "무엇이 실제로 허용되는가" 를 보여준다. 자동 포함된
    // origin 호스트는 사용자가 적은 항목과 구분해 "(자동)" 을 붙인다(§30 P2 — 사용자가
    // network.allowedDomains 를 명시했다면 이 자동 포함 자체가 일어나지 않으므로
    // originHostAutoAdded 는 그때 항상 null이다).
    if (diag.networkAllowedDomains === null) {
      lines.push("  네트워크 allowedDomains: 미설정 (SDK 기본 정책 적용 — 이 하네스가 채운 값 없음)");
    } else if (diag.networkAllowedDomains.length === 0) {
      lines.push("  네트워크 allowedDomains: 빈 배열 (모든 아웃바운드 거부)");
    } else {
      const shown = diag.networkAllowedDomains
        .map(d => (d === diag.originHostAutoAdded ? `${d} (자동: git origin)` : d))
        .join(", ");
      lines.push(`  네트워크 allowedDomains: ${shown}`);
    }
  } else {
    lines.push(
      "  ○ 비활성 (기본값) — canUseTool 권한 검사는 요청을 검사할 뿐 실행을 막지 못합니다(§36 C-1).",
      '    STATE.json 에 { "sandbox": { "enabled": true } } 를 설정하면 SDK 네이티브 샌드박스로',
      "    실행 시점 자체를 커널에서 차단할 수 있습니다 (§37 — 먼저 실전 주행으로 정상 작업이",
      "    막히지 않는지 검증한 뒤 켜는 것을 권장합니다).",
    );
  }
  const supportNote = diag.platformKnownSupported
    ? "SDK 문서상 지원 플랫폼 — 실제 동작 여부는 세션을 띄워야 확인됩니다(미검증)"
    : "SDK 문서에 명시된 지원 플랫폼(darwin/linux/win32)이 아닙니다 — 지원 여부 확인 필요";
  lines.push(`  플랫폼: ${diag.platform} (${supportNote})`);

  // sandbox-trial PLAN D3/D4/D5 — bwrap 실측 결과를 표시한다. 어느 상태든(없음/미확인 포함)
  // exit 1 로 이어지지 않는다(doctorHasProblems 는 report.sandbox 를 보지 않는다 — 샌드박스는
  // 옵트인이므로 미지원/미확인을 문제로 만들지 않는다).
  if (diag.platform === "linux") {
    if (diag.bwrapCheck === null) {
      lines.push("  bubblewrap(bwrap): 미확인 — 실측을 실행하지 않았습니다");
    } else {
      switch (diag.bwrapCheck.status) {
        case "found":
          lines.push(`  bubblewrap(bwrap): 있음 — 실측 확인 (${diag.bwrapCheck.detail})`);
          break;
        case "not-found":
          lines.push(`  bubblewrap(bwrap): 없음 — 실측 확인 (${diag.bwrapCheck.detail})`);
          lines.push("    Linux 샌드박스(bubblewrap)를 쓰려면 bwrap 을 설치하세요 (예: apt install bubblewrap).");
          break;
        case "unconfirmed":
          lines.push(
            `  bubblewrap(bwrap): 미확인 — ${diag.bwrapCheck.detail}`,
            "    (있다고도 없다고도 단정하지 않습니다)",
          );
          break;
      }
    }
  }
  return lines;
}

// pr-slicing Phase 5 — 조각 분해 관측 절. 판정(exit code)에는 넣지 않는다: 꺼짐은 기본값이고
// base 브랜치 불일치는 의도적일 수 있다(샌드박스 절과 같은 취급).
function reviewSplitSectionLines(rs: ReviewSplitDiagnostics): string[] {
  const lines: string[] = ["[조각 분해]"];
  if (!rs.enabled) {
    lines.push('  \u25cb 비활성 (기본값) — STATE 에 { "review_split": { "enabled": true, "budget_lines": 400 } }');
    lines.push("    을 넣으면 phase 를 리뷰 가능한 조각 PR 로 나눕니다 (pr_mode 가 함께 필요합니다).");
  } else {
    lines.push(`  활성 — 조각 목표 ${rs.budgetLines ?? "?"}줄 (코드+테스트, 워크플로우 문서 제외)`);
    lines.push(`  통합 브랜치: ${rs.integrationBranch ?? "(아직 확정되지 않음 — fw run 시작 시 정해집니다)"}`);
    for (const g of rs.sliceGroups) {
      lines.push(`  Phase ${g.originId}: 조각 ${g.doneCount}/${g.total} 완료`);
    }
    if (rs.integrationPrUrl) lines.push(`  통합 PR: ${rs.integrationPrUrl}`);
  }
  for (const sk of rs.skipped) {
    lines.push(`  ! Phase ${sk.phaseId} 는 분해하지 않았습니다 — ${sk.reason}`);
  }
  if (rs.baseBranchMismatch) {
    const m = rs.baseBranchMismatch;
    lines.push(`  ! base_branch 가 ${m.configured} 인데 리포 관례는 ${m.detected} 로 보입니다 (${m.reason}).`);
    lines.push("    의도적이면 무시하세요 — git flow 리포라면 base_branch 를 고쳐야 합니다.");
  }
  return lines;
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`fw doctor — ${report.workflow} (${report.repoRoot})`, "");

  lines.push("[프리플라이트]");
  // §36 m-1: 로그 미보호 문제는 아래 [실행 로그 보호] 절이 더 자세히 보여주므로 여기서는
  // 걸러낸다(중복 보고 제거) — filteredPreflightProblems 참조. report.preflight.ok 자체(다른
  // 문제가 없었는지)는 그대로 유지하되, 표시는 이 필터링된 목록 기준으로 한다.
  const preflightProblems = filteredPreflightProblems(report);
  if (preflightProblems.length === 0) {
    lines.push("  OK");
  } else {
    for (const p of preflightProblems) lines.push(`  ✗ ${p}`);
  }
  lines.push("");

  lines.push("[STATE 불변식]");
  lines.push(report.stateInvariants.ok ? "  OK" : `  ✗ ${report.stateInvariants.problem}`);
  lines.push("");

  lines.push("[검증 명령 정적 검사]");
  const phasesWithIssues = report.phaseLints.filter(l => l.issues.length > 0);
  // §31 후속: verify_default 를 별도 줄로 항상 보여준다 — 어느 phase 도 쓰지 않으면 phaseLints
  // 에는 안 나타나는데 `fw run` 은 그것 때문에 거부하므로, 안 보이면 원인을 찾을 수 없다.
  if (report.defaultLint.length > 0) {
    // §32 I-4: 전 phase 가 done 이면 assertRunnable 이 이 값을 더는 검사하지 않는다(실행될
    // 명령이 없으므로) — "fw run 은 이것도 검사한다"는 문구가 이제 사실이 아니게 되므로 여기서
    // 갈라 써야 한다. 안 그러면 doctor 가 exit 0 을 내면서도 틀린 이유를 댄다.
    const usage = report.allPhasesDone
      ? "verify_default (공용 — 모든 phase 가 done 이라 `fw run` 재개 시 이 값을 검사하지 않는다)"
      : report.defaultUsedByPhase
        ? "verify_default (공용)"
        : "verify_default (공용 — 현재 어느 phase 도 쓰지 않지만 `fw run` 은 이것도 검사한다)";
    lines.push(`  ${usage}:`);
    for (const issue of report.defaultLint) {
      const tag = issue.severity === "error" ? "✗ ERROR" : "! WARN";
      lines.push(`    ${tag} [${issue.command}] ${issue.reason}`);
    }
  }
  if (phasesWithIssues.length === 0 && report.defaultLint.length === 0) {
    lines.push("  OK");
  } else if (phasesWithIssues.length > 0) {
    for (const pl of phasesWithIssues) {
      lines.push(`  Phase ${pl.phaseId} (${pl.phaseTitle}):`);
      for (const issue of pl.issues) {
        const tag = issue.severity === "error" ? "✗ ERROR" : "! WARN";
        lines.push(`    ${tag} [${issue.command}] ${issue.reason}`);
      }
    }
  }
  lines.push("");

  lines.push("[검증 명령 실측]");
  if (report.runs === null) {
    lines.push("  건너뜀 (--no-run)");
  } else if (report.runs.length === 0) {
    lines.push("  실행할 검증 명령이 없습니다");
  } else {
    for (const r of report.runs) {
      lines.push(`  Phase ${r.phaseId} (${r.phaseTitle}): ${r.passed ? "PASS" : "FAIL"}`);
      for (const cr of r.results) {
        const notes: string[] = [];
        if (cr.timedOut) notes.push("timeout");
        if (cr.fatal) notes.push("fatal");
        const suffix = notes.length > 0 ? ` (${notes.join(", ")})` : "";
        lines.push(`    $ ${cr.command} → exit ${cr.exitCode}${suffix}`);
      }
    }
  }
  lines.push("");

  lines.push(...planContextSectionLines(report.planContext), "");

  lines.push(...runLogsSectionLines(report.runLogsProtection), "");

  lines.push(...sandboxSectionLines(report.sandbox), "");

  if (report.reviewSplit) lines.push(...reviewSplitSectionLines(report.reviewSplit), "");

  // §27 O2/O3 — "왜 하네스가 아무 일도 안 하는가" 의 가장 흔한 원인(남은 STOP 파일·halted 주차)을
  // 결과 줄 바로 위에 둔다.
  lines.push(...haltSectionLines(report.halt), "");

  lines.push(
    doctorHasProblems(report)
      ? "결과: 문제 있음 — 위 항목을 해결한 뒤 다시 실행하세요 (exit 1)"
      : "결과: 문제 없음 (exit 0)",
  );

  return lines.join("\n");
}

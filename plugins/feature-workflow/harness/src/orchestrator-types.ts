import type { RunLogsGitCheckIgnoreExec } from "./state.js";
// §25 리팩토링: orchestrator.ts 가 1166줄로 비대해져(감사 지적 — runWorkflow 162줄 + runPrGateInner
// 112줄, 파일의 48%가 PR 코드) branch.ts/prloop.ts/halt.ts 로 분할했다. OrchestratorDeps/CommitCheck
// 는 세 모듈 전부(branch.ts 의 verifySessionCommits, prloop.ts 의 runPrGate 계열, halt.ts 의
// checkHaltpoint)가 참조하는 공통 타입이라, orchestrator.ts 안에 두면 그 모듈들이 orchestrator.ts 를
// 다시 import 하는 순환 의존이 생긴다(orchestrator.ts → branch.ts/prloop.ts/halt.ts 는 값 import 이므로
// 역방향 타입 import 만 있어도 그래프가 순환한다). 이 파일로 뽑아 모두가 한 방향으로만 의존하게 한다.
// orchestrator.ts 는 이 파일의 타입을 그대로 재수출해 기존 `import { type OrchestratorDeps } from
// "./orchestrator.js"` 를 쓰는 cli.ts/테스트가 전혀 바뀌지 않게 한다.
import type { SessionRunner } from "./session.js";
import type { Gate } from "./gate.js";
import type { Notifier } from "./notify.js";
import type { PrClient } from "./pr.js";
import type { CliExecResult } from "./preflight.js";

// §tamper-gap P1/P2/D2: defaultChangedFiles(및 이를 주입받는 OrchestratorDeps.changedFiles)의
// 계약을 판별 유니온으로 전환한다 — preflight.ts 의 PorcelainZParseResult(§P8/D3) 선례와 동일한
// 패턴이다. git 실행 자체의 실패(spawn 오류·타임아웃·비영 종료)는 여전히 throw(기존 바깥쪽
// catch, §25 C1 fail-open)로 남는다 — "인프라 오류"와 "git 이 성공했지만 출력 구조를 신뢰할 수
// 없는 경우"(현재 유일한 트리거: U+FFFD 감지, reason:"invalid_utf8")를 같은 catch 로 합류시키지
// 않기 위해 반환값 층위에서 분리한다(P1). ok:false 는 fail-closed 로 처리되어야 한다 — 판별
// 유니온이라 소비처(orchestrator.ts/prloop.ts)와 테스트 더블 양쪽이 ok:false 처리를 컴파일
// 시점에 강제당한다(instanceof 런타임 분기와 달리 잊을 수 없다).
export type ChangedFilesResult =
  | { ok: true; files: string[] }
  | { ok: false; reason: "invalid_utf8"; paths: string[] };

export interface OrchestratorDeps {
  runner: SessionRunner;
  gate: Gate;
  notify: Notifier;
  now: () => string; // ISO timestamp
  log: (msg: string) => void;
  pr?: PrClient;                                  // pr_mode 일 때만 필요
  sleep?: (ms: number) => Promise<void>;          // 테스트에서 즉시 반환하도록 주입
  nonce?: () => string;                           // fix 프롬프트 데이터 구분자용 (기본: crypto 난수)
  // 세션 실행 전 HEAD 를 기록해 "그 이후에 생긴 커밋인지" 판정하는 데 쓴다 (§25 — "HEAD" 우회 차단).
  // git 저장소가 아니거나 명령 실패 시 null. 테스트는 스텁 주입.
  headSha?: (cwd: string) => Promise<string | null>;
  // 세션이 보고한 SHA 가 실제 git 에 존재하고, headBefore 가 있으면 그 이후에 생긴 커밋인지 확인
  // (거짓 done 방지). 테스트는 스텁 주입.
  verifyCommit?: (cwd: string, sha: string, headBefore: string | null) => Promise<CommitCheck>;
  // §24 감사 S1: 게이트가 실행할 verify 명령이 참조하는 파일(package.json/gradlew 등)이 이번 phase
  // 에서 변경됐는지 확인한다. sinceSha(=headBefore) 이후 변경된 파일 목록을 반환한다.
  // 실패(git 오류 등) 시에는 빈 배열로 조용히 넘기지 않고 reject 로 구분한다 — 호출부가 "검사를
  // 못 했다"와 "검사했더니 변경이 없었다"를 다르게 취급할 수 있어야 한다. 테스트는 스텁 주입.
  // §tamper-gap D2: 성공했으나 경로 목록을 신뢰할 수 없으면(U+FFFD 감지) ok:false 로 구분한다 —
  // 위 reject(인프라 오류, fail-open 유지)와는 별개의 채널이다(P1).
  changedFiles?: (cwd: string, sinceSha: string) => Promise<ChangedFilesResult>;
  // §19: 프리플라이트(리포/워킹트리/브랜치 확인)와 branch_strategy=isolate 의 체크아웃에 쓰는 git
  // 실행기. 기본은 실제 git CLI. 테스트는 스텁 주입(기존 changedFiles/headSha 와 같은 패턴).
  git?: (args: string[], cwd: string) => Promise<CliExecResult>;
  // §19: pr_mode 프리플라이트의 `gh auth status` 확인에 쓰는 gh 실행기. 기본은 실제 gh CLI.
  gh?: (args: string[], cwd: string) => Promise<CliExecResult>;
  // §36 후속: 실행 로그 보호 검사(§33/§35)가 쓰는 전용 git 실행기. `git`/`gh` 와 계약이 다르다 —
  // `git check-ignore -q` 는 "무시 안 됨" 을 exit 1 로 알리는데 CliExecResult 를 만드는 run() 헬퍼가
  // 그걸 ok:false + err.message 로 접어 "진짜 무시 안 됨" 과 "git 저장소 아님" 을 구별 불가로 만든다.
  // **전달하지 않으면 preflight 가 기본값(실제 git)을 쓰므로 테스트가 스텁을 주입해도 무시된다** —
  // doctor.ts 가 §36 m-1 에서 같은 결함을 고쳤는데 orchestrator 에도 있었다(§30 P1).
  checkIgnoreGit?: RunLogsGitCheckIgnoreExec;
  // §26 C2: 세션이 보고한 커밋이 격리/토픽 작업 브랜치(workBranch)에서 실제로 도달 가능한지
  // (`git merge-base --is-ancestor <sha> <workBranch>`) 확인한다. workBranch 가 없으면(branch_strategy
  // =current 등) 호출되지 않는다. 테스트는 스텁 주입.
  branchReachable?: (cwd: string, sha: string, branch: string) => Promise<CommitCheck>;
  // issue #3: fix 세션이 "이미 반영돼 있음"(status:"already_applied")의 근거로 댄 커밋 SHA 가
  // 실재하고, PR 브랜치(headRef — workBranch 또는 HEAD)에서 도달 가능하며, base_branch 에는 없는
  // (=이 PR 이 만든 변경인) 커밋인지 확인한다. verifyCommit 과 달리 "headBefore 이후 신규" 조건은
  // 없다 — 이미 있던 커밋을 근거로 대는 것이 바로 이 결과의 정의다. 테스트는 스텁 주입.
  alreadyAppliedCommit?: (cwd: string, sha: string, headRef: string, baseBranch: string) => Promise<CommitCheck>;
}

export interface CommitCheck {
  ok: boolean;
  /** ok=false 일 때만 사용 — "커밋 없음"과 "git 명령 자체 오류"를 구분해 fixContext 에 정확한
   *  사유를 전달한다 (§25). 없으면 orchestrator 가 일반 메시지로 대체한다. */
  reason?: string;
}

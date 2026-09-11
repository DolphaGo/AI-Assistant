import fs from "node:fs";
import path from "node:path";
import { getVersion } from "./index.js";
import { loadState, totalCostUsd, phaseCostUsd, formatCostLine, type State } from "./state.js";

// §20/§9 — 하네스 실행 로그를 파일로 남긴다. `deps.log` 가 지금까지 console.log 로만 배선돼
// stdout 으로만 나갔다(터미널을 닫으면 소실). docs/<workflow>/logs/run-<ts>.log 에 append 하고
// 콘솔에도 그대로 출력해, "밤새 뭐가 있었나"를 다음날 아침 파일로 재구성할 수 있게 한다.

export interface RunLogger {
  log: (msg: string) => void;
  close: () => void;
  path: string;
}

const STATUS_ICON: Record<string, string> = {
  pending: "☐", in_progress: "▣", in_review: "◍", done: "☑", failed: "✗", blocked: "⊘",
};

// 최근 로그 파일 목록에서 몇 개까지 보여줄지 — 밤새 재시도가 쌓여도 한 화면을 넘기지 않기 위함
const MAX_LISTED_LOG_FILES = 5;

// 파일명에 콜론(:)을 쓸 수 없는 파일시스템(특히 과거 macOS/Windows 관례)이 있어 치환한다.
// 밀리초·타임존(Z)은 파일명 구분 목적상 불필요해 함께 잘라낸다.
// "2026-08-27T01:23:45.678Z" -> "2026-08-27T01-23-45"
function stampForFilename(iso: string): string {
  return iso.slice(0, 19).replace(/:/g, "-");
}

// 각 로그 줄 접두 타임스탬프. "2026-08-27T01:23:45.678Z" -> "[01:23:45]"
function timePrefix(iso: string): string {
  return `[${iso.slice(11, 19)}]`;
}

// §31 I5 ② — `fw run | tee run.txt` 처럼 출력을 파이핑했을 때 reader(tee 등)가 먼저 죽으면
// echo(기본값 console.log)가 쓰는 process.stdout 이 EPIPE 로 실패한다. 이 실패는 스트림 내부에서
// **비동기 'error' 이벤트**로만 나타나 어떤 try/catch 로도 잡히지 않고, 리스너가 없으면 Node
// 기본 동작(프로세스 종료, exit 1)으로 이어진다 — 실측: STATE 가 in_progress 로 잔존한 채
// 하네스가 죽는다. EPIPE 는 "읽는 쪽이 사라졌다" 는 뜻일 뿐 하네스 로직의 결함이 아니므로
// 무해화한다. 다른 종류의 stdout 오류까지 삼키면 진짜 문제를 숨기게 되므로 그대로 다시 던진다
// (그 경우도 이전과 동일하게 프로세스가 죽는다 — 동작을 넓히지 않고 EPIPE 만 좁혀서 막는다).
// 스트림을 인자로 받아 기본값 process.stdout 을 쓰되, 테스트는 가짜 이벤트 이미터를 넘겨
// 실제 프로세스의 stdout 을 건드리지 않고 검증할 수 있게 한다.
//
// §32 m-8 — 예전엔 "이미 아무 'error' 리스너나 있으면" 설치 자체를 건너뛰었다. 문제는 그
// 리스너가 "우리 가드"라는 보장이 없다는 것이다: 다른 모듈이 먼저 등록한, EPIPE 를 구분하지
// 않는 범용 error 리스너(예: 무조건 로그만 남기고 아무것도 안 하거나, 반대로 무조건 프로세스를
// 종료하는 리스너)가 있으면 우리 방어가 통째로 사라진 채 그 리스너의 동작에 운명을 맡기게
// 된다. Node 의 EventEmitter 는 같은 이벤트에 리스너를 여러 개 등록해도 전부 호출하므로(하나가
// 있다고 다른 하나를 막을 이유가 없다), "이미 리스너가 있는지"가 아니라 "이 스트림에 **우리
// 가드**를 이미 설치했는지"만 판단하면 된다 — WeakSet 으로 스트림 객체 자체의 아이덴티티를
// 추적해, 같은 스트림(예: 같은 프로세스에서 createRunLogger 를 여러 번 호출할 때의
// process.stdout)에 우리 가드가 중복 등록되는 것만 막고, 남이 먼저 걸어둔 무관한 리스너의
// 유무와는 무관하게 항상 우리 가드를 추가한다.
const epipeGuardedStreams = new WeakSet<object>();

export function installEpipeGuard(stream: Pick<NodeJS.WriteStream, "on" | "listenerCount"> = process.stdout): void {
  if (epipeGuardedStreams.has(stream)) return;
  epipeGuardedStreams.add(stream);
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EPIPE") throw err;
  });
}

/**
 * docs/<workflow>/logs/run-<ISO타임스탬프>.log 에 append 하며 콘솔에도 그대로 출력하는
 * 로거를 만든다. 시작 시 workflow/repo_root/시작 시각/fw 버전을 담은 헤더 한 줄을 남긴다.
 *
 * 파일 쓰기 실패는 무해화한다 — gate.ts 의 "로그는 부산물, 판정이 제품" 원칙과 동일하게,
 * 실행 로그도 부산물이므로 기록 실패가 콘솔 출력이나 하네스 실행을 막으면 안 된다. 최초
 * 실패 시에만 콘솔에 한 번 경고하고, 이후로는 조용히 콘솔 출력만 계속한다.
 */
export function createRunLogger(
  workflowDir: string,
  now: () => string,
  echo: (msg: string) => void = console.log,
): RunLogger {
  // §31 I5 ② — echo 의 기본값(console.log)이 쓰는 process.stdout 이 파이프 대상 소멸(EPIPE)로
  // 실패해도 하네스가 죽지 않게 한다.
  installEpipeGuard();
  const logsDir = path.join(workflowDir, "logs");
  const filePath = path.join(logsDir, `run-${stampForFilename(now())}.log`);

  let writeFailed = false;
  const appendToFile = (line: string): void => {
    try {
      fs.mkdirSync(logsDir, { recursive: true });
      fs.appendFileSync(filePath, line + "\n");
    } catch (err) {
      if (!writeFailed) {
        writeFailed = true;
        echo(`경고: 실행 로그 파일 쓰기 실패 — 이후 콘솔 출력만 유지합니다 (${(err as Error).message})`);
      }
      // 그 외에는 조용히 무시 — 로그 기록 실패로 하네스 실행을 막지 않는다
    }
  };

  // repo_root 는 함수 시그니처에 없어 STATE.json 에서 읽는다. 아직 STATE.json 이 없거나
  // 깨져 있어도 로거 생성 자체는 막지 않는다 — 그 유효성 검사는 runWorkflow 가 별도로 한다.
  let repoRoot = "(알 수 없음)";
  try {
    repoRoot = loadState(workflowDir).repo_root;
  } catch {
    // 무시 — 위 주석 참조
  }
  const header =
    `=== fw run 시작 — workflow=${path.basename(path.resolve(workflowDir))} ` +
    `repo_root=${repoRoot} fw v${getVersion()} 시작=${now()} ===`;
  // §31 I5 ③ — appendToFile 을 echo 보다 먼저 호출한다. 이전 순서(echo 먼저)는 콘솔 쓰기가
  // 실패(EPIPE 등)하면 그 뒤의 appendToFile 이 실행되지 않아 DENY/헤더가 영속 로그 파일에서도
  // 함께 사라졌다 — "로그는 부산물, 판정이 제품" 이라는 원칙과 별개로, 부산물 중에서도 파일이
  // 콘솔보다 오래 남는 진짜 기록이므로 먼저 남긴다.
  appendToFile(`${timePrefix(now())} ${header}`);
  echo(header);

  const log = (msg: string): void => {
    appendToFile(`${timePrefix(now())} ${msg}`);
    echo(msg);
  };

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    appendToFile(`${timePrefix(now())} === fw run 종료 ===`);
  };

  return { log, close, path: filePath };
}

/**
 * docs/<workflow>/logs/ 아래 run-*.log 파일 경로를 최신순(파일명 내림차순 — 타임스탬프가
 * ISO 순서라 문자열 정렬이 곧 시간 순서다)으로 반환한다. logs/ 디렉토리가 없으면 빈 배열.
 */
export function listRunLogFiles(workflowDir: string): string[] {
  const logsDir = path.join(workflowDir, "logs");
  let entries: string[];
  try {
    entries = fs.readdirSync(logsDir);
  } catch {
    return [];
  }
  return entries
    .filter(f => /^run-.*\.log$/.test(f))
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    .map(f => path.join(logsDir, f));
}

/** 파일의 마지막 N 줄을 반환한다. 파일이 없거나 읽을 수 없으면 빈 배열. */
export function readLastLines(filePath: string, n: number): string[] {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop(); // 끝의 개행이 만든 빈 원소 제거
  return lines.slice(-n);
}

export interface RunLogTail {
  n: number;
  lines: string[];
}

/**
 * `fw log` 의 출력을 만드는 순수 함수. STATE.json 요약 헤더 + phase 별 시도/비용/PR +
 * phase 별 세션 이력(시간순) + BLOCKED 질문 + 최근 run 로그 파일 목록(+선택적 tail)을
 * 사람이 읽는 형식으로 조립한다. fs/네트워크에 접근하지 않는다 — 호출자(cli.ts)가 STATE 와
 * 로그 파일 목록/tail 을 미리 읽어 넘긴다.
 */
export function formatRunLog(state: State, logFiles: string[], tail?: RunLogTail): string {
  const lines: string[] = [];
  // §27 O2/O3: halted 는 밤새 돌다가 상한/운영자가 멈춘 상태 — 아침에 이 한 화면만 보고 바로
  // 알아채야 하므로 blocked 와 같은 톤(아이콘)으로 눈에 띄게 표시한다.
  const statusIcon = state.status === "halted" ? "⏸ " : "";
  lines.push(`${statusIcon}fw log — ${state.workflow} [${state.status}]`);
  lines.push(`repo: ${state.repo_root}`);
  lines.push(formatCostLine(totalCostUsd(state), state.max_cost_usd));
  if (state.status === "halted" && state.halt_reason) {
    lines.push(`⏸ 정지 사유: ${state.halt_reason}`);
  }
  lines.push("");

  for (const p of state.phases) {
    const cost = phaseCostUsd(p);
    lines.push(
      `${STATUS_ICON[p.status] ?? "?"} Phase ${p.id}: ${p.title} ` +
        `(시도 ${p.attempts}/${p.max_attempts}, 세션 비용 $${cost.toFixed(2)})`,
    );
    // §26 M2: allow_verify_file_changes 로 검증 위조 가드가 의도적으로 낮춰진 phase 는 밤새 돌린
    // 결과를 아침에 볼 때 반드시 눈에 띄어야 한다 — cli.ts formatStatus 와 같은 문구를 쓴다.
    if (p.verify_file_changes_bypassed_at) {
      lines.push(
        `   ⚠️  검증 파일 변경 허용됨 (allow_verify_file_changes) — ${p.verify_file_changes_bypassed_at}`,
      );
    }
    if (p.pr) lines.push(`   PR #${p.pr.number}: ${p.pr.url}`);

    if (p.sessions.length === 0) {
      lines.push("   세션 이력 없음");
    } else {
      const sorted = [...p.sessions].sort((a, b) => a.at.localeCompare(b.at));
      for (const s of sorted) {
        const costPart = s.cost_usd !== undefined ? `$${s.cost_usd.toFixed(2)}` : "-";
        const summary = s.summary ? ` — ${s.summary.slice(0, 200)}` : "";
        // §36 §30 P4 후속 — 세션의 자기 주장(위 s.result)과 별개로 하네스가 실제로 내린 판정을
        // 보여준다. verdict 가 없으면(§36 이전 레거시 세션) 이 부분을 통째로 생략한다 — 이전
        // 출력과 완전히 동일해야 한다(§30 P2 회귀 방지, notComputable 과 같은 원칙).
        const verdictPart = s.verdict
          ? ` → 판정: ${s.verdict.outcome}${s.verdict.reason ? `(${s.verdict.reason})` : ""}`
          : "";
        lines.push(`   - ${s.at} [${s.kind}] ${s.result} (비용 ${costPart})${verdictPart}${summary}`);
      }
    }
    lines.push("");
  }

  if (state.pending_question) {
    lines.push(`❓ BLOCKED 질문 (Phase ${state.pending_question.phase}):`);
    lines.push(`   ${state.pending_question.question}`);
    lines.push(`   → fw answer <workflow-dir> "<답변>" 후 fw run 으로 재개`);
    lines.push("");
  }

  const shown = logFiles.slice(0, MAX_LISTED_LOG_FILES);
  lines.push(`실행 로그 (최근 ${shown.length}개 / 전체 ${logFiles.length}개):`);
  if (shown.length === 0) {
    lines.push("   (없음)");
  } else {
    for (const f of shown) lines.push(`   - ${f}`);
  }

  if (tail && tail.lines.length > 0) {
    lines.push("");
    lines.push(`최근 로그 마지막 ${tail.n}줄 (${logFiles[0] ?? ""}):`);
    for (const l of tail.lines) lines.push(`   ${l}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// §59 — 절전 방지. 실측(pr-comment-mask 1차 시도): 밤새 주행 중 맥이 잠들어 세션이
// "Your computer went to sleep mid-response" 로 죽고 attempt 하나($)를 태웠다.
// darwin 에서는 fw run/fw verify 가 스스로 `caffeinate -dims -w <자기 PID>` 를 띄운다 —
// -w <pid> 는 그 프로세스가 죽으면 caffeinate 도 함께 종료되므로 별도 정리가 필요 없다.
// 실패해도 주행을 막지 않는다(§30 P2): caffeinate 부재/스폰 실패는 로그 한 줄로 남기고
// 계속 간다. 비 darwin 은 조용히 스킵한다 — 리눅스 서버는 통상 절전이 없고, systemd-inhibit
// 은 명령을 감싸는 방식이라 다른 설계가 필요하다(필요해지면 별도 라운드).
// ---------------------------------------------------------------------------

import { spawn as nodeSpawn } from "node:child_process";

export function startSleepInhibitor(
  log: (msg: string) => void,
  platform: NodeJS.Platform = process.platform,
  pid: number = process.pid,
  spawnFn: typeof nodeSpawn = nodeSpawn,
): void {
  if (platform !== "darwin") return;
  try {
    const child = spawnFn("caffeinate", ["-dims", "-w", String(pid)], {
      stdio: "ignore",
      detached: false,
    });
    // 스폰 자체는 비동기로 실패할 수 있다(ENOENT 등) — 에러를 안 먹으면 프로세스가 죽는다.
    child.on("error", err => {
      log(`절전 방지(caffeinate) 시작 실패(무시): ${(err as Error).message}`);
    });
    child.unref();
    log(`절전 방지: caffeinate -dims -w ${pid} 시작 (주행 종료 시 자동 해제)`);
  } catch (err) {
    log(`절전 방지(caffeinate) 시작 실패(무시): ${(err as Error).message}`);
  }
}

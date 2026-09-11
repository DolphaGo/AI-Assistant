import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { normalizeRepoRelative, unquoteGitPath, unwrapShC } from "./paths.js";

// ── §z-parse P5/P10/D4/D10: git-출처 전용 정규화 ─────────────────────────────
// normalizeRepoPath(아래)는 두 출처를 한 함수로 정규화해 왔다 — verify 명령에 사람이 손으로 적은
// 비-git 출처 경로(guardedFiles)와, branch.ts 의 defaultChangedFiles 가 git diff/status -z 로
// 파싱해낸 git-출처 경로(changed)다. -z 전환 이전에는 git 출력이 core.quotePath 로 감싸여 있어
// unquoteGitPath 를 거는 것이 두 출처 모두에 안전했지만, -z 출력은 quotePath 이스케이프가 없는
// 원문 그대로다 — 파일명이 우연히 큰따옴표로 시작·끝나면(-z 는 그런 raw 파일명을 그대로 낸다)
// unquoteGitPath 가 이를 quotePath 이스케이프로 오인해 손상시킨다. 같은 이유로 trim() 도
// 생략해야 한다 — 개행으로 시작·끝나는 실제 파일명(-z 전환이 다루려는 핵심 케이스)의 경계
// 공백이 조용히 잘리면 서로 다른 두 경로가 같은 것으로 오판되거나 tamper 비교가 어긋난다.

// 자식을 프로세스 그룹 리더(detached:true)로 띄워 손자 프로세스까지 죽인다 — 트레이드오프로 실행 중인
// 하위 프로세스에 Ctrl-C(SIGINT)가 자동 전달되지 않는다 (CLI/README 에서 시그널 포워딩 후속 처리 예정).

export interface CommandResult {
  command: string;
  exitCode: number | null;
  signal: string | null;
  // stdout/stderr 를 발생 순서 그대로 하나의 문자열로 병합한다 — 재현 로그를 시간순 그대로 남기려는 의도된 설계
  output: string;
  // 명령 자체를 실행할 수 없음(spawn 실패, 미존재, 실행 권한 없음) — 재시도 무의미, 즉시 FAILED 용
  fatal: boolean;
  timedOut: boolean;
}

export interface GateResult {
  passed: boolean;
  results: CommandResult[];
}

export interface GateOptions {
  commands: string[];
  cwd: string;
  logFile?: string;
  timeoutMs?: number;
}

export type Gate = (opts: GateOptions) => Promise<GateResult>;

// 명령 하나가 무한정 매달려 오케스트레이터 전체를 행 상태로 만들지 않도록 하는 기본 상한
export const DEFAULT_TIMEOUT_MS = 30 * 60_000;

// SIGTERM 이 안 먹히는 명령을 위한 최후 수단까지의 유예 시간
const SIGKILL_GRACE_MS = 5000;

// 로그 폭주 방지 — 항상 "마지막" 256KB(문자 수 근사)를 남긴다. 실패 원인은 보통 출력 끝부분에 있다.
const OUTPUT_CAP = 256 * 1024;
const TRUNCATION_MARKER = "[출력 앞부분 잘림]\n";

function appendCapped(current: string, chunk: string): string {
  const base = current.startsWith(TRUNCATION_MARKER) ? current.slice(TRUNCATION_MARKER.length) : current;
  const next = base + chunk;
  if (next.length <= OUTPUT_CAP) return next;
  return TRUNCATION_MARKER + next.slice(next.length - OUTPUT_CAP);
}

// 사용자 스크립트가 관례적으로 반환하는 exit 127/126 (예: 자체 정의된 에러 코드)까지 fatal 로 오판하지
// 않도록, 셸이 실제로 "명령을 실행할 수 없었다"는 메시지를 남겼을 때만 fatal 로 판정한다.
const FATAL_MESSAGE_RE = /not found|command not found|Permission denied|No such file/i;

function isFatalExit(exitCode: number | null, output: string): boolean {
  return (exitCode === 127 || exitCode === 126) && FATAL_MESSAGE_RE.test(output);
}

function runCommand(command: string, cwd: string, timeoutMs: number): Promise<CommandResult> {
  return new Promise(resolve => {
    // stdin 을 ignore 해 입력을 기다리는 명령이 즉시 EOF 로 실패하게 한다 (행 방지 1단계)
    // detached:true 로 셸을 프로세스 그룹 리더로 띄운다 — 복합 명령(&&, |)이나 내부에서 sleep 하는
    // 래퍼 스크립트는 손자 프로세스로 실행되므로, 셸 PID 만 죽이면 손자가 살아남아 탈출한다 (행 방지 2단계)
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    let output = "";
    let timedOut = false;
    let settled = false;
    let sigtermTimer: NodeJS.Timeout | undefined;
    let sigkillTimer: NodeJS.Timeout | undefined;
    let hardDeadlineTimer: NodeJS.Timeout | undefined;

    const append = (chunk: string): void => {
      output = appendCapped(output, chunk);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    // 셸 PID 만이 아니라 프로세스 그룹 전체(-pid)에 신호를 보낸다 — 그래야 손자/고아까지 닿는다.
    // 그룹 kill 이 실패하면(이미 종료 등) 직계 프로세스만이라도 시도한다.
    const killGroup = (sig: NodeJS.Signals): void => {
      try {
        process.kill(-child.pid!, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* 이미 종료됨 */
        }
      }
    };

    const clearTimers = (): void => {
      clearTimeout(sigtermTimer);
      clearTimeout(sigkillTimer);
      clearTimeout(hardDeadlineTimer);
    };

    // close/error/하드데드라인 등 여러 경로로 확정될 수 있어 중복 resolve 를 여기서 한 번에 막는다
    const settle = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(result);
    };

    sigtermTimer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      sigkillTimer = setTimeout(() => {
        killGroup("SIGKILL");
        // SIGKILL 로 그룹을 다 죽였는데도 고아가 stdout 파이프를 쥔 채로 close 가 안 오면
        // (극단적 재부모화 등) 무한 대기 대신 여기서 판정을 강제로 확정한다
        hardDeadlineTimer = setTimeout(() => {
          output = appendCapped(
            output,
            "\n[하드 데드라인] SIGKILL 후에도 종료를 확인하지 못해 강제로 판정을 확정합니다",
          );
          settle({ command, exitCode: null, signal: "SIGKILL", output, fatal: false, timedOut: true });
        }, SIGKILL_GRACE_MS);
      }, SIGKILL_GRACE_MS);
    }, timeoutMs);

    child.on("error", err => {
      // spawn 자체가 실패한 경로 — 기존 수집분을 버리지 않고 에러 메시지를 덧붙인다
      output = appendCapped(output, `\n[spawn error] ${String(err)}`);
      settle({ command, exitCode: null, signal: null, output, fatal: true, timedOut });
    });

    child.on("close", (code, signal) => {
      if (timedOut) {
        output = appendCapped(output, `\n[타임아웃: ${timeoutMs}ms 초과]`);
      }
      settle({ command, exitCode: code, signal, output, fatal: isFatalExit(code, output), timedOut });
    });
  });
}

// §24 감사 S1: 세션은 STATE.json 을 못 고치지만, 검증 게이트가 실행하는 파일(package.json/gradlew/
// build.gradle/Makefile/scripts/*.sh 등)은 repo 내부라 Write 권한이 허용한다. 그 파일을 세션이 직접
// 고치면(예: "npm test" 를 항상 exit 0 하도록 바꾸기) 게이트가 위조된 판정을 그대로 통과시킨다.
// orchestrator 는 이 함수로 verify 명령이 참조할 만한 파일을 뽑아, 그 파일들이 이번 phase 에서
// 실제로 변경됐는지 확인해 위조를 걸러낸다(§24 최우선 실행 순서 1). 오탐(과잉 차단)보다 미탐(과소
// 추출) 쪽이 더 위험하므로 넓게 잡는다 — 검증 대상이 아닌 파일까지 걸려도 사용자가 fixContext 를
// 보고 판단할 수 있지만, 실제 위조 파일을 놓치면 그대로 우회된다.
const SCRIPT_EXT_RE = /\.(sh|py|js|ts)$/;

function firstToken(command: string): string {
  return command.trim().split(/\s+/)[0] ?? "";
}

// §26 C3 감사: verifyReferencedFiles 는 "./scripts/check.sh" 처럼 명령에 쓰인 형태 그대로 반환하는데,
// git diff --name-only 는 "scripts/check.sh" 처럼 리포-루트 상대경로(선행 "./" 없음)를 반환한다.
// orchestrator 의 위조 매칭이 이 두 형태를 그대로 비교해(`endsWith("/" + g)`) "./" 유무로만 갈려
// 영원히 매칭에 실패했다(실측: `./gradlew`, `./scripts/check.sh` 위조 미탐지). 양쪽을 이 함수로
// 정규화한 뒤 정확 일치로 비교해야 한다 — basename 만 있는 가드 항목(package.json 등)도 정규화 후
// 정확 일치만 허용하면 하위 경로(packages/foo/package.json)에 오탐하지 않는다(I7 도 함께 해결).
//
// §29 MI-7 감사: "./" 제거만으로는 부족했다 — 비ASCII 경로가 있으면 git diff --name-only 도
// core.quotePath 로 감싼 8진 이스케이프 문자열(`"scripts/\355\225\234\352\270\200.sh"`)을 내는데
// 이 함수가 그걸 그대로 문자열 비교해 한글 스크립트 위조가 미탐지됐다. 그리고 macOS 기본
// case-insensitive 파일시스템(`Package.json` vs `package.json`)과 NFC/NFD 정규화 형태 차이도
// 문자열 비교를 갈랐다. paths.ts 의 unquoteGitPath(quotePath 이스케이프 해제) + normalizeRepoRelative
// (NFC 정규화 + darwin 한정 대소문자 무시)를 추가해 세 가지를 한 번에 해결한다. 시그니처는 유지.
export function normalizeRepoPath(p: string): string {
  const trimmed = p.trim();
  if (trimmed === "") return trimmed;
  return normalizeRepoRelative(unquoteGitPath(trimmed));
}

// git-출처 경로(branch.ts 의 defaultChangedFiles 가 -z 로 파싱한 changed, 및 tampered 비교
// 시점에 같은 기준으로 정규화되는 guardedFiles) 전용 변형 — unquote 생략(P5), 안쪽·바깥쪽 trim
// 모두 생략(D4/D10). 이름은 P10 확정대로 새로 붙인다 — normalizeRepoPath 는 gate.test.ts 의
// quotePath pinned 테스트가 검증하는 unquote 동작을 물려받아야 하므로 이름·동작을 그대로 유지한다.
export function normalizeGitSourcePath(p: string): string {
  return p === "" ? p : normalizeRepoRelative(p, { trim: false });
}

// §29 MI-8 감사: §26 C3 본문이 "기타 미탐" 으로 적어둔 항목이 경로 정규화(§26 처리)만으로는
// 해결되지 않고 그대로 남아 있었다 — verifyReferencedFiles 자체가 이 형태들을 아예 인식하지
// 못했다(추출 결과가 빈 배열). 무인 주행에서 세션이 npx/모노레포 설정 파일을 자유롭게 Write 할
// 수 있는 이상, 아래 네 형태는 최소한 가드해야 한다:
//   - "cd <dir> && <cmd>"       → <dir>/ 접두를 붙여 그 서브디렉토리의 설정 파일도 가드 대상
//   - "npx <tool>"              → 그 도구가 읽는 설정 파일(알려진 도구만 좁게 매핑 — 과잉 가드 방지)
//   - "docker compose ..."      → compose 파일(docker-compose.y*ml / compose.y*ml)
//   - "bash -c '<cmd>'"         → 따옴표 안 명령을 재귀적으로 재분석
// §29 의 구조적 교훈("모르는 문법은 거부")을 여기 그대로 옮기면 오탐(과잉 차단)이 §26 I7 처럼
// 재발한다 — 이 함수의 실패 모드는 "미탐"(놓치면 위조 미탐지)이지 안전 침해가 아니므로, 대신
// "확실히 아는 패턴만 넓게, 애매한 건 그냥 안 뽑는다" 는 반대 방향의 보수성을 적용한다. 예:
// `cd <dir> &&` 는 정확히 이 형태(디렉토리에 공백 없음, `&&` 체이닝)만 인식하고 `cd -`/세미콜론
// 체이닝/복잡한 인용은 그냥 놓친다 — 못 뽑는 것이지 잘못 뽑는 게 아니다.
const NPX_TOOL_CONFIG_FILES: Record<string, string[]> = {
  // 감사 실측 사례(vitest) + 동급으로 흔한 jest 만 좁게 매핑한다. 매핑에 없는 npx 호출은 그대로
  // 미탐으로 남긴다 — 모든 npx 도구의 설정 파일을 다 알 수도 없고, 안다고 우겨서 넓히면 그
  // 도구와 무관한 정당한 설정 변경까지 위조로 오인해 회송하는 §26 I7 류 오탐이 재발한다.
  vitest: ["vitest.config.ts", "vitest.config.js", "vitest.config.mjs", "vitest.config.cjs"],
  jest: ["jest.config.ts", "jest.config.js", "jest.config.cjs", "jest.config.mjs", "jest.config.json"],
};

const COMPOSE_FILES = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];

// `bash -c '...'` 언래퍼는 paths.ts 의 `unwrapShC` 로 합쳤다 — verifylint.ts 도 같은 문제를
// 풀고 있었고, 같은 문제를 두 곳에서 풀면 갈라진다(§30 P1). 인용 규칙을 정확히 흉내내지 않는
// 이유는 그 함수의 주석 참조(§30 P3).
const CD_CHAIN_RE = /^cd\s+(\S+)\s*&&\s*(.+)$/;

function withPrefix(dirPrefix: string, name: string): string {
  return dirPrefix ? `${dirPrefix}/${name}` : name;
}

function collectReferencedFiles(commands: string[], dirPrefix: string, out: Set<string>): void {
  for (const raw of commands) {
    const cmd = raw.trim();
    if (!cmd) continue;

    const cdMatch = cmd.match(CD_CHAIN_RE);
    if (cdMatch) {
      const subPrefix = withPrefix(dirPrefix, cdMatch[1]!);
      collectReferencedFiles([cdMatch[2]!], subPrefix, out);
      continue; // "cd" 자체는 참조 파일이 없다 — 재귀 결과만 채택
    }

    const shC = unwrapShC(cmd);
    if (shC) {
      collectReferencedFiles([shC.inner], dirPrefix, out);
      continue;
    }

    const tokens = cmd.split(/\s+/).filter(Boolean);
    const first = firstToken(cmd);

    // "./gradlew", "./scripts/check.sh" 처럼 리포 내 실행 파일을 직접 호출하는 형태
    if (first.startsWith("./")) out.add(withPrefix(dirPrefix, first));

    if (first === "npm" || first === "pnpm" || first === "yarn") {
      out.add(withPrefix(dirPrefix, "package.json"));
    }

    if (first === "npx" && tokens[1]) {
      const configs = NPX_TOOL_CONFIG_FILES[tokens[1]];
      if (configs) configs.forEach(f => out.add(withPrefix(dirPrefix, f)));
    }

    if ((first === "docker" && tokens[1] === "compose") || first === "docker-compose") {
      COMPOSE_FILES.forEach(f => out.add(withPrefix(dirPrefix, f)));
    }

    // "gradle"/"gradlew"/"./gradlew" 모두 커버 (첫 토큰이 그 이름으로 끝나면 매칭)
    if (first === "gradle" || first === "gradlew" || first.endsWith("/gradlew")) {
      out.add(withPrefix(dirPrefix, "build.gradle"));
      out.add(withPrefix(dirPrefix, "build.gradle.kts"));
      out.add(withPrefix(dirPrefix, "settings.gradle"));
      out.add(withPrefix(dirPrefix, "settings.gradle.kts"));
      out.add(withPrefix(dirPrefix, "gradle.properties"));
    }

    if (first === "make") {
      out.add(withPrefix(dirPrefix, "Makefile"));
      out.add(withPrefix(dirPrefix, "makefile"));
    }

    if (first === "pytest" || first === "python" || first === "python3") {
      out.add(withPrefix(dirPrefix, "pyproject.toml"));
      out.add(withPrefix(dirPrefix, "setup.cfg"));
      out.add(withPrefix(dirPrefix, "tox.ini"));
      out.add(withPrefix(dirPrefix, "conftest.py"));
    }

    if (first === "cargo") out.add(withPrefix(dirPrefix, "Cargo.toml"));

    if (first === "go") out.add(withPrefix(dirPrefix, "go.mod"));

    // 명령 어디든(첫 토큰이 아니어도) .sh/.py/.js/.ts 로 끝나는 토큰이 있으면 그 경로도 참조 대상 —
    // 예: "bash scripts/check.sh", "node scripts/build.js"
    for (const tok of tokens) {
      if (SCRIPT_EXT_RE.test(tok)) out.add(withPrefix(dirPrefix, tok));
    }
  }
}

export function verifyReferencedFiles(commands: string[]): string[] {
  const out = new Set<string>();
  collectReferencedFiles(commands, "", out);
  return [...out];
}

export const runGate: Gate = async ({ commands, cwd, logFile, timeoutMs = DEFAULT_TIMEOUT_MS }) => {
  // 빈 게이트를 통과로 취급하면 검증 강제가 무력화된다 (state.assertRunnable 이 선차단하는 3중 방어)
  if (commands.length === 0) throw new Error("검증 명령이 비어 있습니다 — 빈 게이트는 허용되지 않습니다");
  const results: CommandResult[] = [];
  for (const command of commands) {
    const r = await runCommand(command, cwd, timeoutMs);
    results.push(r);
    // 첫 실패에서 중단 — timedOut 도 실패다 (exitCode 가 우연히 0 이어도 그룹을 이미 강제 종료했다)
    if (r.exitCode !== 0 || r.timedOut) break;
  }
  // exitCode 만 보면 안 된다 — 고아가 파이프를 쥔 채 셸이 먼저 exit 0 으로 끝나는 경우
  // timedOut=true 인데 exitCode=0 이 될 수 있다. 타임아웃은 항상 실패로 취급한다.
  const passed =
    results.length === commands.length && results.every(r => r.exitCode === 0 && !r.timedOut);

  if (logFile) {
    // 로그는 부산물, 판정(passed/results)이 제품이다 — 기록 실패가 게이트 결과를 흔들면 안 된다
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      const body = results
        .map(r => {
          const notes: string[] = [];
          if (r.signal) notes.push(`killed by ${r.signal}`);
          if (r.fatal) notes.push("fatal");
          if (r.timedOut) notes.push("timedOut");
          const suffix = notes.length > 0 ? ` (${notes.join(", ")})` : "";
          return `$ ${r.command}\n(exit ${r.exitCode}${suffix})\n${r.output}`;
        })
        .join("\n---\n");
      fs.writeFileSync(logFile, `passed: ${passed}\n\n${body}`);
    } catch {
      // 무시 — 위 주석 참조
    }
  }

  return { passed, results };
};

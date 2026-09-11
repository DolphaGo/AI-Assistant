import { describe, it, expect, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { z } from "zod";
import { createRunLogger, listRunLogFiles, readLastLines, formatRunLog, installEpipeGuard, startSleepInhibitor } from "../src/runlog.js";
import { StateSchema, saveState, loadState, type State } from "../src/state.js";
import { getVersion } from "../src/index.js";

function baseState(overrides: Partial<z.input<typeof StateSchema>> = {}): State {
  return StateSchema.parse({
    schema_version: 1,
    workflow: "test-wf",
    repo_root: "/tmp/repo",
    branch_strategy: "topic",
    allow_push: false,
    verify_default: ["npm test"],
    status: "running",
    pending_question: null,
    answers: [],
    phases: [],
    ...overrides,
  });
}

describe("createRunLogger", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-runlog-"));
  });

  it("logs/run-<타임스탬프>.log 파일을 만든다 (콜론 치환, 밀리초/Z 절삭)", () => {
    const echoed: string[] = [];
    const logger = createRunLogger(dir, () => "2026-08-27T01:23:45.678Z", m => echoed.push(m));
    expect(logger.path).toBe(path.join(dir, "logs", "run-2026-08-27T01-23-45.log"));
    expect(fs.existsSync(logger.path)).toBe(true);
  });

  it("생성 시 workflow/repo_root/fw 버전을 담은 헤더 줄을 남기고 콘솔에도 echo 한다", () => {
    saveState(dir, baseState({ workflow: path.basename(dir), repo_root: "/my/repo" }));
    const echoed: string[] = [];
    const logger = createRunLogger(dir, () => "2026-08-27T01:23:45.678Z", m => echoed.push(m));
    const content = fs.readFileSync(logger.path, "utf-8");
    expect(content).toContain("fw run 시작");
    expect(content).toContain("repo_root=/my/repo");
    expect(content).toContain(`fw v${getVersion()}`);
    expect(echoed.some(m => m.includes("fw run 시작"))).toBe(true);
  });

  it("STATE.json 이 없어도 로거 생성 자체는 막지 않는다(repo_root 를 '알 수 없음'으로 표기)", () => {
    const logger = createRunLogger(dir, () => "2026-08-27T01:23:45.678Z");
    const content = fs.readFileSync(logger.path, "utf-8");
    expect(content).toContain("repo_root=(알 수 없음)");
  });

  it("log() 는 [HH:mm:ss] 접두를 붙여 콘솔과 파일에 동시에 남긴다", () => {
    const echoed: string[] = [];
    const logger = createRunLogger(dir, () => "2026-08-27T01:23:45.000Z", m => echoed.push(m));
    logger.log("Phase 1 시작");
    const content = fs.readFileSync(logger.path, "utf-8");
    expect(content).toContain("[01:23:45] Phase 1 시작");
    expect(echoed).toContain("Phase 1 시작"); // 콘솔에는 접두 없이 그대로(echo 는 console.log 대체용)
  });

  it("여러 번 log() 하면 append 되어 이전 줄이 남는다", () => {
    const logger = createRunLogger(dir, () => "2026-08-27T01:23:45.000Z");
    logger.log("첫 줄");
    logger.log("둘째 줄");
    const content = fs.readFileSync(logger.path, "utf-8");
    expect(content).toContain("첫 줄");
    expect(content).toContain("둘째 줄");
    expect(content.indexOf("첫 줄")).toBeLessThan(content.indexOf("둘째 줄"));
  });

  it("close() 는 종료 줄을 남기고, 두 번 호출해도 한 번만 기록한다", () => {
    const logger = createRunLogger(dir, () => "2026-08-27T01:23:45.000Z");
    logger.close();
    logger.close();
    const content = fs.readFileSync(logger.path, "utf-8");
    const matches = content.match(/fw run 종료/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("파일 쓰기가 실패해도 throw 하지 않고 콘솔로만 폴백하며, 경고는 최초 1회만 출력한다", () => {
    // logs/ 자리에 일반 파일을 미리 만들어 mkdirSync(logsDir) 가 항상 실패하게 한다
    fs.writeFileSync(path.join(dir, "logs"), "not a directory");
    const echoed: string[] = [];
    const logger = createRunLogger(dir, () => "2026-08-27T01:23:45.000Z", m => echoed.push(m));
    expect(() => logger.log("메시지1")).not.toThrow();
    expect(() => logger.log("메시지2")).not.toThrow();
    expect(() => logger.close()).not.toThrow();
    expect(fs.existsSync(logger.path)).toBe(false);
    const warnings = echoed.filter(m => m.includes("경고") && m.includes("실행 로그 파일 쓰기 실패"));
    expect(warnings.length).toBe(1); // 최초 실패에만 경고
    expect(echoed).toContain("메시지1");
    expect(echoed).toContain("메시지2");
  });

  // §31 I5 ③ — 예전 순서(echo 먼저, appendToFile 나중)는 콘솔 쓰기가 실패(EPIPE 등)하면 그 뒤의
  // appendToFile 이 실행되지 않아 DENY 가 영속 로그 파일에서도 함께 사라졌다. 두 줄의 순서를
  // 바꿔(appendToFile 먼저) 콘솔이 죽어도 파일에는 이미 남게 한다.
  it("§31 I5 ③: log() 는 echo 보다 먼저 파일에 기록한다 — echo 가 실패해도 파일엔 이미 남는다", () => {
    let echoCallCount = 0;
    const flakyEcho = (_msg: string): void => {
      echoCallCount++;
      if (echoCallCount > 1) throw new Error("EPIPE (2번째 호출부터 실패 시뮬레이션)");
    };
    // 첫 번째 echo 호출(헤더)은 성공해야 로거 생성 자체가 막히지 않는다.
    const logger = createRunLogger(dir, () => "2026-08-27T01:23:45.000Z", flakyEcho);
    // log() 의 echo(2번째 호출)가 던지므로 log() 자체는 그 예외를 그대로 전파한다(기존 계약
    // 유지 — 이 수정은 "echo 실패를 무해화"가 아니라 "파일 기록 순서를 먼저"가 목적이다).
    expect(() => logger.log("DENY 메시지")).toThrow();
    const content = fs.readFileSync(logger.path, "utf-8");
    expect(content).toContain("DENY 메시지"); // echo 가 실패했어도 appendToFile 은 이미 끝났다
  });
});

// §31 I5 ② — `fw run | tee run.txt` 에서 reader 가 먼저 죽으면 echo(console.log)가 쓰는
// process.stdout 이 EPIPE 로 실패한다. 이 실패는 비동기 'error' 이벤트로만 나타나 어떤
// try/catch 로도 못 잡히고, 리스너가 없으면 Node 기본 동작(프로세스 종료)으로 이어진다.
// 실제 process.stdout 을 건드리지 않고, 인자로 받은 가짜 이벤트 이미터로 계약을 검증한다.
describe("installEpipeGuard — §31 I5 ②", () => {
  it("EPIPE 오류는 무해화하고(다시 던지지 않음), 다른 오류는 그대로 다시 던진다", () => {
    const fake = new EventEmitter();
    installEpipeGuard(fake as unknown as Parameters<typeof installEpipeGuard>[0]);
    const epipeErr = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    expect(() => fake.emit("error", epipeErr)).not.toThrow();

    const otherErr = Object.assign(new Error("write EOTHER"), { code: "EOTHER" });
    expect(() => fake.emit("error", otherErr)).toThrow("write EOTHER");
  });

  it("이미 'error' 리스너가 있으면 중복 등록하지 않는다", () => {
    const fake = new EventEmitter();
    installEpipeGuard(fake as unknown as Parameters<typeof installEpipeGuard>[0]);
    installEpipeGuard(fake as unknown as Parameters<typeof installEpipeGuard>[0]);
    expect(fake.listenerCount("error")).toBe(1);
  });

  it("createRunLogger 는 생성 시 (기본 process.stdout 대상으로) 예외 없이 가드를 설치한다", () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "fw-runlog-epipe-"));
    expect(() => createRunLogger(dir2, () => "2026-08-27T01:23:45.000Z")).not.toThrow();
  });

  // §32 m-8 — 예전엔 "이미 아무 'error' 리스너나 있으면" 설치를 통째로 건너뛰었다. 그 기존
  // 리스너가 EPIPE 를 구분하지 않는 무관한 리스너라면 우리 방어가 사라진 채였다. 아래 두 테스트는
  // "이름은 배선을 주장하고 어서션은 아무것도 증명하지 않는다"(§32 SURVIVED M28 지적)는 비판을
  // 정면으로 겨냥한다 — `not.toThrow()` 가 아니라 실제 listenerCount 변화와, 등록된 리스너를
  // 직접 호출했을 때의 동작으로 배선을 증명한다.
  it("§32 m-8: 무관한 error 리스너가 이미 있어도 자신의 EPIPE 가드를 추가로 등록한다 (listenerCount 로 증명)", () => {
    const fake = new EventEmitter();
    fake.on("error", () => {}); // 다른 모듈이 먼저 등록해 둔, EPIPE 를 구분하지 않는 무관한 리스너
    expect(fake.listenerCount("error")).toBe(1);
    installEpipeGuard(fake as unknown as Parameters<typeof installEpipeGuard>[0]);
    // 우리 가드가 "이미 리스너가 있으니 건너뛴다"로 사라지지 않고 추가로 붙어야 한다.
    expect(fake.listenerCount("error")).toBe(2);
  });

  it("§32 m-8: 무관한 리스너가 있는 상태에서도 EPIPE 는 프로세스를 죽이지 않고, 다른 에러는 여전히 전파된다", () => {
    const fake = new EventEmitter();
    const foreignCalls: string[] = [];
    fake.on("error", (err: NodeJS.ErrnoException) => {
      foreignCalls.push(err.code ?? "?"); // 무관한 리스너는 그냥 관측만 하고 다시 던지지 않는다
    });
    installEpipeGuard(fake as unknown as Parameters<typeof installEpipeGuard>[0]);
    expect(fake.listenerCount("error")).toBe(2);

    const epipeErr = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    // 두 리스너 모두 호출되지만(무관한 리스너는 관측만, 우리 가드는 무해화), 프로세스를 죽이는
    // 예외가 새지 않는다.
    expect(() => fake.emit("error", epipeErr)).not.toThrow();
    expect(foreignCalls).toEqual(["EPIPE"]); // 무관한 리스너도 정상 호출됨(등록이 실제로 됐다는 증거)

    const otherErr = Object.assign(new Error("write EOTHER"), { code: "EOTHER" });
    expect(() => fake.emit("error", otherErr)).toThrow("write EOTHER"); // 우리 가드는 EPIPE 외엔 다시 던진다
  });

  it("§32 m-8: 같은 스트림 객체에 반복 호출해도 우리 가드는 한 번만 등록된다(다른 스트림 객체엔 각각 등록)", () => {
    const streamA = new EventEmitter();
    const streamB = new EventEmitter();
    installEpipeGuard(streamA as unknown as Parameters<typeof installEpipeGuard>[0]);
    installEpipeGuard(streamA as unknown as Parameters<typeof installEpipeGuard>[0]);
    installEpipeGuard(streamA as unknown as Parameters<typeof installEpipeGuard>[0]);
    installEpipeGuard(streamB as unknown as Parameters<typeof installEpipeGuard>[0]);
    expect(streamA.listenerCount("error")).toBe(1);
    expect(streamB.listenerCount("error")).toBe(1);
  });
});

describe("listRunLogFiles", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-runlog-list-"));
  });

  it("logs/ 디렉토리가 없으면 빈 배열", () => {
    expect(listRunLogFiles(dir)).toEqual([]);
  });

  it("run-*.log 파일만 최신순(파일명 내림차순)으로 반환하고 다른 파일은 제외한다", () => {
    const logsDir = path.join(dir, "logs");
    fs.mkdirSync(logsDir);
    fs.writeFileSync(path.join(logsDir, "run-2026-08-27T01-00-00.log"), "a");
    fs.writeFileSync(path.join(logsDir, "run-2026-08-27T03-00-00.log"), "b");
    fs.writeFileSync(path.join(logsDir, "run-2026-08-27T02-00-00.log"), "c");
    fs.writeFileSync(path.join(logsDir, "phase-1-attempt-1.log"), "게이트 출력 — 제외 대상");
    const files = listRunLogFiles(dir);
    expect(files).toEqual([
      path.join(logsDir, "run-2026-08-27T03-00-00.log"),
      path.join(logsDir, "run-2026-08-27T02-00-00.log"),
      path.join(logsDir, "run-2026-08-27T01-00-00.log"),
    ]);
  });
});

describe("readLastLines", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-runlog-tail-"));
  });

  it("존재하지 않는 파일이면 빈 배열", () => {
    expect(readLastLines(path.join(dir, "nope.log"), 5)).toEqual([]);
  });

  it("마지막 N 줄만 반환하고 끝의 개행이 만든 빈 줄은 포함하지 않는다", () => {
    const file = path.join(dir, "run.log");
    fs.writeFileSync(file, "a\nb\nc\nd\ne\n");
    expect(readLastLines(file, 2)).toEqual(["d", "e"]);
  });

  it("N 이 전체 줄 수보다 크면 전체를 반환한다", () => {
    const file = path.join(dir, "run.log");
    fs.writeFileSync(file, "a\nb\n");
    expect(readLastLines(file, 10)).toEqual(["a", "b"]);
  });
});

describe("formatRunLog", () => {
  it("workflow/status/repo/총 비용 헤더를 포함한다", () => {
    const s = baseState({ status: "running", repo_root: "/r" });
    const out = formatRunLog(s, []);
    expect(out).toContain("fw log — test-wf [running]");
    expect(out).toContain("repo: /r");
    expect(out).toContain("총 비용: $0.00");
  });

  it("phase 별 시도/세션 비용/PR 번호를 보여준다", () => {
    const s = baseState({
      phases: [
        {
          id: 1, title: "p1", status: "in_review", depends_on: [], verify: [],
          attempts: 1, max_attempts: 2,
          pr: { number: 7, url: "https://ex/pull/7", head_branch: "fw/phase-1", handled_comment_keys: [], fix_sessions: 0 },
          sessions: [{ session_id: "s1", result: "done", at: "2026-08-27T00:00:00.000Z", kind: "phase", cost_usd: 1.5 }],
        },
      ],
    });
    const out = formatRunLog(s, []);
    expect(out).toContain("Phase 1: p1");
    expect(out).toContain("시도 1/2");
    expect(out).toContain("세션 비용 $1.50");
    expect(out).toContain("PR #7: https://ex/pull/7");
    expect(out).toContain("총 비용: $1.50");
  });

  it("phase 별 세션을 kind 와 함께 시간순으로 나열하고 summary 는 200자로 자른다", () => {
    const longSummary = "x".repeat(250);
    const s = baseState({
      phases: [
        {
          id: 1, title: "p1", status: "done", depends_on: [], verify: [],
          attempts: 1, max_attempts: 2,
          sessions: [
            { session_id: "s2", result: "done", at: "2026-08-27T02:00:00.000Z", kind: "fix", cost_usd: 0.2 },
            { session_id: "s1", result: "done", at: "2026-08-27T01:00:00.000Z", kind: "phase", cost_usd: 0.1, summary: longSummary },
          ],
        },
      ],
    });
    const out = formatRunLog(s, []);
    const iPhase = out.indexOf("2026-08-27T01:00:00.000Z");
    const iFix = out.indexOf("2026-08-27T02:00:00.000Z");
    expect(iPhase).toBeGreaterThan(-1);
    expect(iFix).toBeGreaterThan(iPhase); // 시간순
    expect(out).toContain("[phase]");
    expect(out).toContain("[fix]");
    expect(out).not.toContain("x".repeat(201)); // 200자 초과분은 잘림
    expect(out).toContain("x".repeat(200));
  });

  // §36 §30 P4 후속 — 세션의 자기 주장(result)과 하네스의 실제 판정(verdict)을 나란히 보여준다.
  it("verdict 가 있으면 세션 줄에 하네스의 판정을 덧붙인다 (bounced 는 사유도 함께)", () => {
    const s = baseState({
      phases: [
        {
          id: 1, title: "p1", status: "in_progress", depends_on: [], verify: [],
          attempts: 2, max_attempts: 5,
          sessions: [
            { session_id: "s1", result: "done", at: "2026-08-27T01:00:00.000Z", kind: "phase", verdict: { outcome: "bounced", reason: "gate_failed" } },
            { session_id: "s2", result: "done", at: "2026-08-27T02:00:00.000Z", kind: "phase", verdict: { outcome: "accepted" } },
          ],
        },
      ],
    });
    const out = formatRunLog(s, []);
    expect(out).toContain("판정: bounced(gate_failed)");
    expect(out).toContain("판정: accepted");
  });

  it("verdict 가 없는(레거시) 세션은 판정 표시를 생략한다 (§30 P2 회귀 — 기존 출력과 동일)", () => {
    const s = baseState({
      phases: [
        {
          id: 1, title: "p1", status: "done", depends_on: [], verify: [],
          attempts: 1, max_attempts: 2,
          sessions: [{ session_id: "s1", result: "done", at: "2026-08-27T01:00:00.000Z", kind: "phase" }],
        },
      ],
    });
    const out = formatRunLog(s, []);
    expect(out).not.toContain("판정:");
  });

  it("세션이 없는 phase 는 '세션 이력 없음'을 보여준다", () => {
    const s = baseState({
      phases: [{ id: 1, title: "p1", status: "pending", depends_on: [], verify: [], attempts: 0, max_attempts: 2, sessions: [] }],
    });
    expect(formatRunLog(s, [])).toContain("세션 이력 없음");
  });

  it("BLOCKED 질문이 있으면 표시한다", () => {
    const s = baseState({
      status: "blocked",
      pending_question: { phase: 1, question: "A or B?", asked_at: "t" },
      phases: [{ id: 1, title: "p1", status: "blocked", depends_on: [], verify: [], attempts: 1, max_attempts: 2, sessions: [] }],
    });
    const out = formatRunLog(s, []);
    expect(out).toContain("BLOCKED 질문");
    expect(out).toContain("A or B?");
  });

  it("BLOCKED 질문이 없으면 표시하지 않는다", () => {
    const s = baseState({ phases: [] });
    expect(formatRunLog(s, [])).not.toContain("BLOCKED");
  });

  it("로그 파일이 없으면 '(없음)' 을 보여준다", () => {
    const out = formatRunLog(baseState(), []);
    expect(out).toContain("실행 로그 (최근 0개 / 전체 0개)");
    expect(out).toContain("(없음)");
  });

  it("로그 파일 목록을 최대 5개까지만 보여주되 전체 개수는 함께 표기한다", () => {
    const files = Array.from({ length: 8 }, (_, i) => `/wf/logs/run-${i}.log`);
    const out = formatRunLog(baseState(), files);
    expect(out).toContain("실행 로그 (최근 5개 / 전체 8개)");
    for (const f of files.slice(0, 5)) expect(out).toContain(f);
    for (const f of files.slice(5)) expect(out).not.toContain(f);
  });

  it("tail 이 주어지면 최근 로그 파일의 마지막 줄들을 함께 보여준다", () => {
    const out = formatRunLog(baseState(), ["/wf/logs/run-2.log", "/wf/logs/run-1.log"], {
      n: 2,
      lines: ["첫줄", "둘째줄"],
    });
    expect(out).toContain("최근 로그 마지막 2줄");
    expect(out).toContain("/wf/logs/run-2.log");
    expect(out).toContain("첫줄");
    expect(out).toContain("둘째줄");
  });

  it("tail 이 없으면 tail 섹션을 출력하지 않는다", () => {
    const out = formatRunLog(baseState(), ["/wf/logs/run-1.log"]);
    expect(out).not.toContain("마지막");
  });

  describe("§26 M2: verify_file_changes_bypassed_at 노출", () => {
    it("설정돼 있으면 경고 톤으로 phase 블록에 표시한다", () => {
      const s = baseState({
        phases: [{
          id: 1, title: "p1", status: "in_progress", depends_on: [], verify: [],
          attempts: 1, max_attempts: 2, sessions: [],
          allow_verify_file_changes: true,
          verify_file_changes_bypassed_at: "2026-08-27T01:23:45Z",
        }],
      });
      const out = formatRunLog(s, []);
      expect(out).toContain("⚠️");
      expect(out).toContain("검증 파일 변경 허용됨");
      expect(out).toContain("allow_verify_file_changes");
      expect(out).toContain("2026-08-27T01:23:45Z");
    });

    it("없으면 경고를 표시하지 않는다", () => {
      const s = baseState({
        phases: [{ id: 1, title: "p1", status: "pending", depends_on: [], verify: [], attempts: 0, max_attempts: 2, sessions: [] }],
      });
      expect(formatRunLog(s, [])).not.toContain("검증 파일 변경 허용됨");
    });
  });

  describe("§27 O2/O3: halted 표시 + 상한 대비 비용", () => {
    it("halted 상태는 ⏸ 아이콘·정지 사유를 보여준다 — 밤새 결과를 아침에 한 화면에서 보는 목적", () => {
      const s = baseState({ status: "halted", halt_reason: "비용 상한 초과: $12.40 / $10.00" });
      const out = formatRunLog(s, []);
      expect(out).toContain("⏸");
      expect(out).toContain("[halted]");
      expect(out).toContain("정지 사유");
      expect(out).toContain("비용 상한 초과: $12.40 / $10.00");
    });

    it("halted 가 아니면 정지 사유 줄을 표시하지 않는다 (§30 P2 정상 경로)", () => {
      const s = baseState({ status: "running" });
      expect(formatRunLog(s, [])).not.toContain("정지 사유");
    });

    it("max_cost_usd 가 설정돼 있으면 fw status 와 동일하게 '$X / $Y' 로 상한 대비를 보여준다", () => {
      const s = baseState({
        max_cost_usd: 10,
        phases: [{
          id: 1, title: "p1", status: "in_progress", depends_on: [], verify: [],
          attempts: 1, max_attempts: 2,
          sessions: [{ session_id: "s1", result: "done", at: "t", kind: "phase", cost_usd: 3.2 }],
        }],
      });
      expect(formatRunLog(s, [])).toContain("총 비용: $3.20 / $10.00");
    });

    it("max_cost_usd 미설정이면 기존처럼 '총 비용: $X' 만 보여준다 (§30 P2)", () => {
      const out = formatRunLog(baseState(), []);
      expect(out).toContain("총 비용: $0.00");
      expect(out).not.toContain("/ $");
    });
  });
});

describe("fw log 의 에러 경로 — 없는 디렉토리", () => {
  it("STATE.json 이 없는 디렉토리를 넘기면 loadState 가 명확한 에러로 throw 한다 (fw log 의 첫 단계)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-runlog-missing-"));
    expect(() => loadState(dir)).toThrow(/STATE\.json/);
  });

  it("워크플로우 디렉토리 자체가 존재하지 않아도 명확한 에러로 throw 한다", () => {
    expect(() => loadState("/tmp/definitely-does-not-exist-fw-wf-xyz")).toThrow(/STATE\.json/);
  });
});

// §59 실측(pr-comment-mask 1차) — 밤새 주행 중 절전으로 세션이 죽었다. darwin 에서
// caffeinate 를 자기 PID 에 걸어 주행 동안 절전을 막는다. 실패는 주행을 막지 않는다(§30 P2).
describe("startSleepInhibitor — §59", () => {
  function fakeSpawn() {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const child = { on: (_e: string, _cb: unknown) => child, unref: () => {} };
    const spawn = ((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    return { calls, spawn };
  }

  it("darwin 에서 caffeinate -dims -w <pid> 를 띄우고 로그를 남긴다", () => {
    const { calls, spawn } = fakeSpawn();
    const logs: string[] = [];
    startSleepInhibitor(m => logs.push(m), "darwin", 4242, spawn);
    expect(calls).toEqual([{ cmd: "caffeinate", args: ["-dims", "-w", "4242"] }]);
    expect(logs.some(l => l.includes("절전 방지") && l.includes("4242"))).toBe(true);
  });

  it("비 darwin 에서는 아무것도 하지 않는다", () => {
    const { calls, spawn } = fakeSpawn();
    startSleepInhibitor(() => {}, "linux", 1, spawn);
    expect(calls).toHaveLength(0);
  });

  it("spawn 이 throw 해도 던지지 않고 로그만 남긴다 (§30 P2 — 주행을 막지 않는다)", () => {
    const logs: string[] = [];
    const throwing = (() => { throw new Error("ENOENT caffeinate"); }) as unknown as typeof import("node:child_process").spawn;
    expect(() => startSleepInhibitor(m => logs.push(m), "darwin", 1, throwing)).not.toThrow();
    expect(logs.some(l => l.includes("실패(무시)"))).toBe(true);
  });
});

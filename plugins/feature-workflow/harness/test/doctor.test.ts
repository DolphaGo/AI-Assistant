import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  lintVerifyCommands, runDoctor, doctorHasProblems, formatDoctorReport, defaultCheckBwrap,
  sandboxNeutralizationSignals, isSandboxNeutralized, sandboxNeutralizationNotes,
  buildReviewSplitDiagnostics,
  type DoctorReport, type BwrapCheck,
} from "../src/doctor.js";
import { StateSchema, saveState, type State } from "../src/state.js";
import type { CliExecResult } from "../src/preflight.js";
import type { Gate } from "../src/gate.js";

describe("lintVerifyCommands", () => {
  it("정상 명령은 아무 issue 도 만들지 않는다", () => {
    expect(lintVerifyCommands(["./gradlew build"])).toEqual([]);
    expect(lintVerifyCommands(["npm test"])).toEqual([]);
    expect(lintVerifyCommands(["grep -q '^- 2026' file"])).toEqual([]);
  });

  it("error: `|| true` 는 검증을 무력화한다", () => {
    const issues = lintVerifyCommands(["npm test || true"]);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("error");
  });

  it("error: `|| :` 도 같은 패턴으로 잡는다", () => {
    const issues = lintVerifyCommands(["npm test || :"]);
    expect(issues.some(i => i.severity === "error")).toBe(true);
  });

  it("error: `; true` 로 끝나면 항상 성공한다", () => {
    const issues = lintVerifyCommands(["npm test; true"]);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("error");
  });

  it("error: 단독 `true` 는 실제 검증이 아니다", () => {
    const issues = lintVerifyCommands(["true"]);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("error");
  });

  it("error: 단독 `:` 도 같은 패턴이다", () => {
    const issues = lintVerifyCommands([":"]);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("error");
  });

  it("error: `echo` 만으로 구성된 명령은 항상 성공한다", () => {
    const issues = lintVerifyCommands(["echo ok"]);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("error");
  });

  it("echo 뒤에 실제 검증이 && 로 이어지면 echo-only 로 보지 않는다", () => {
    const issues = lintVerifyCommands(["echo starting && npm test"]);
    expect(issues.some(i => i.reason.includes("echo"))).toBe(false);
  });

  it("error: `| tee` 는 tee 의 exit code 로 판정된다", () => {
    const issues = lintVerifyCommands(["npm test | tee out.log"]);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("error");
  });

  it("error: `--exit-zero` 류 옵션은 오류를 삼킨다", () => {
    const issues = lintVerifyCommands(["eslint . --exit-zero"]);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("error");
  });

  it("warn: 파이프는 마지막 명령의 exit code 만 반영된다", () => {
    const issues = lintVerifyCommands(["npm test | grep PASS"]);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("warn");
  });

  it("warn: && 없이 세미콜론으로 여러 명령을 나열하면 앞 실패가 무시될 수 있다", () => {
    const issues = lintVerifyCommands(["npm run build; npm test"]);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("warn");
  });

  it("&& 로 연결된 여러 명령은 warn 하지 않는다", () => {
    const issues = lintVerifyCommands(["npm run build && npm test"]);
    expect(issues).toEqual([]);
  });

  it("여러 명령을 한 번에 넣으면 각각 독립적으로 검사한다", () => {
    const issues = lintVerifyCommands(["npm test", "npm test || true", "./gradlew build"]);
    expect(issues).toHaveLength(1);
    expect(issues[0].command).toBe("npm test || true");
  });

  it("빈 문자열/공백만 있는 명령은 무시한다", () => {
    expect(lintVerifyCommands(["", "   "])).toEqual([]);
  });
});

// §26 I5 오탐: 린트가 스스로 권하는 해결책(`set -o pipefail && ... | tee ...`)을 그대로 적용해도
// 계속 error 로 잡혀 사용자가 안내를 따라도 탈출할 수 없었다(실측). pipefail 이 && 로 앞서 연결돼
// 있으면 tee 뒤 exit code 가 아니라 파이프라인 전체의 실패를 반영하므로 더는 error 가 아니어야 한다.
describe("§26 I5 오탐 수정: `set -o pipefail && ... | tee ...` 는 린트를 통과해야 한다", () => {
  it("린트가 제시하는 해결책 그대로는 error 가 없다", () => {
    const issues = lintVerifyCommands(["set -o pipefail && npm test | tee build.log"]);
    expect(issues.some(i => i.severity === "error")).toBe(false);
  });

  it("pipefail 가드가 없는 `| tee` 는 여전히 error 다 (회귀 방지)", () => {
    const issues = lintVerifyCommands(["npm test | tee build.log"]);
    expect(issues.some(i => i.severity === "error")).toBe(true);
  });

  it("pipefail 설정이 tee 파이프보다 뒤에 있으면(가드가 안 걸림) 여전히 error 다", () => {
    const issues = lintVerifyCommands(["npm test | tee build.log && set -o pipefail"]);
    expect(issues.some(i => i.severity === "error")).toBe(true);
  });
});

// §26 I5 미탐 보강: `|| true` 는 잡으면서 `|| exit 0` 등 같은 효과의 다른 표현은 놓치는 문제.
// "종료 코드를 삼키는 패턴" 을 문자열 3~4개가 아니라 범주로 잡는다.
describe("§26 I5 미탐 보강: 종료 코드를 삼키는 패턴을 범주로 잡는다", () => {
  it("error: `|| exit 0` 은 실패를 삼킨다", () => {
    const issues = lintVerifyCommands(["npm test || exit 0"]);
    expect(issues.some(i => i.severity === "error")).toBe(true);
  });

  it("error: `|| echo FAILED` 도 항상 exit 0 으로 끝난다", () => {
    const issues = lintVerifyCommands(["npm test || echo FAILED"]);
    expect(issues.some(i => i.severity === "error")).toBe(true);
  });

  it("error: `set +e` 는 에러 중단을 해제해 실패를 무시하기 쉽게 만든다", () => {
    const issues = lintVerifyCommands(["set +e && npm test"]);
    expect(issues.some(i => i.severity === "error")).toBe(true);
  });

  it("error: 마지막이 `&`(백그라운드)면 셸이 즉시 성공을 반환한다", () => {
    const issues = lintVerifyCommands(["npm test &"]);
    expect(issues.some(i => i.severity === "error")).toBe(true);
  });

  it("error: `; exit 0` 로 끝나면 앞 명령의 실패가 항상 가려진다", () => {
    const issues = lintVerifyCommands(["npm test; exit 0"]);
    expect(issues.some(i => i.severity === "error")).toBe(true);
  });

  it("error: `&& exit 0` 도 같은 패턴으로 잡는다 (의미 없는 명시적 성공 강제)", () => {
    const issues = lintVerifyCommands(["npm test && exit 0"]);
    expect(issues.some(i => i.severity === "error")).toBe(true);
  });

  it("error: `if <cmd>; then ... fi` (else 없음) 는 조건이 실패해도 exit 0 이 된다", () => {
    const issues = lintVerifyCommands(["if npm test; then echo ok; fi"]);
    expect(issues.some(i => i.severity === "error")).toBe(true);
  });

  it("warn: `--passWithNoTests` 는 정당한 사용도 있어 error 대신 warn 에 그친다", () => {
    const issues = lintVerifyCommands(["jest --passWithNoTests"]);
    expect(issues.some(i => i.severity === "error")).toBe(false);
    expect(issues.some(i => i.severity === "warn")).toBe(true);
  });

  it("회귀: `|| exit 1` 처럼 실패를 그대로 전파하는 형태는 오탐하지 않는다", () => {
    expect(lintVerifyCommands(["npm test || exit 1"])).toEqual([]);
  });

  it("회귀: else 가 있는 if/then/fi 는 (판단 유보로) error 로 잡지 않는다", () => {
    const issues = lintVerifyCommands(["if npm test; then echo ok; else exit 1; fi"]);
    expect(issues.some(i => i.severity === "error")).toBe(false);
  });
});

function baseState(overrides: Partial<State> = {}): State {
  return StateSchema.parse({
    schema_version: 1,
    workflow: "wf",
    repo_root: "/tmp/does-not-matter",
    branch_strategy: "isolate",
    allow_push: false,
    // 모든 호출부가 verify_default 를 override 하므로 이 기본값은 실제로는 쓰이지 않는다 — 그래도
    // §26 I5 잔여 승격 이후 "true" 를 기본값 예시로 두지 않는다(assertRunnable 이 이제 error 로
    // 거부하는 값이므로 무심코 그대로 쓰는 걸 피한다).
    verify_default: ["npm test"],
    status: "running",
    pending_question: null,
    answers: [],
    phases: [
      { id: 1, title: "phase one", status: "pending", depends_on: [], verify: [], attempts: 0, max_attempts: 2, sessions: [] },
    ],
    ...overrides,
  });
}

const okGit = async (): Promise<CliExecResult> => ({ ok: true, stdout: "", stderr: "" });

describe("runDoctor / doctorHasProblems / formatDoctorReport", () => {
  it("모든 게 정상이면 문제 없음을 보고한다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-"));
    const state = baseState({ repo_root: dir, verify_default: ["true"] });
    saveState(dir, state);

    const passingGate: Gate = async ({ commands }) => ({
      passed: true,
      results: commands.map(c => ({ command: c, exitCode: 0, signal: null, output: "", fatal: false, timedOut: false })),
    });

    const report = await runDoctor(dir, { git: okGit, gate: passingGate });
    // "true" 는 정상 실행되지만(exit 0), lintVerifyCommands 상으로는 error 다 — 정적 검사가
    // 실측과 별개로 계속 작동하는지 확인하기 위해 일부러 문제 있는 명령을 그대로 둔다.
    expect(doctorHasProblems(report)).toBe(true);
    expect(report.phaseLints[0].issues.some(i => i.severity === "error")).toBe(true);
  });

  it("정상 명령 + 정상 리포는 문제 없음(exit 0)을 보고한다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-"));
    const state = baseState({ repo_root: dir, verify_default: ["npm test"] });
    saveState(dir, state);

    const passingGate: Gate = async ({ commands }) => ({
      passed: true,
      results: commands.map(c => ({ command: c, exitCode: 0, signal: null, output: "", fatal: false, timedOut: false })),
    });

    const report = await runDoctor(dir, { git: okGit, gate: passingGate });
    expect(doctorHasProblems(report)).toBe(false);
    expect(formatDoctorReport(report)).toContain("문제 없음 (exit 0)");
  });

  it("프리플라이트 실패를 문제로 반영한다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-"));
    const state = baseState({ repo_root: dir, verify_default: ["npm test"] });
    saveState(dir, state);

    const failGit = async (): Promise<CliExecResult> => ({ ok: false, stdout: "", stderr: "fatal: not a git repository" });
    const report = await runDoctor(dir, { git: failGit, run: false });
    expect(report.preflight.ok).toBe(false);
    expect(doctorHasProblems(report)).toBe(true);
    expect(formatDoctorReport(report)).toContain("문제 있음");
  });

  it("STATE 불변식 위반(검증 없음)을 잡아 리포트로 보고한다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-"));
    const state = baseState({ repo_root: dir, verify_default: [] });
    saveState(dir, state);

    const report = await runDoctor(dir, { git: okGit, run: false });
    expect(report.stateInvariants.ok).toBe(false);
    expect(report.stateInvariants.problem).toMatch(/검증 명령이 없습니다/);
    expect(doctorHasProblems(report)).toBe(true);
  });

  it("--no-run(deps.run=false) 이면 실측을 건너뛴다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-"));
    const state = baseState({ repo_root: dir, verify_default: ["npm test"] });
    saveState(dir, state);

    let gateCalled = false;
    const gate: Gate = async ({ commands }) => {
      gateCalled = true;
      return { passed: true, results: commands.map(c => ({ command: c, exitCode: 0, signal: null, output: "", fatal: false, timedOut: false })) };
    };

    const report = await runDoctor(dir, { git: okGit, run: false, gate });
    expect(gateCalled).toBe(false);
    expect(report.runs).toBeNull();
    expect(formatDoctorReport(report)).toContain("건너뜀 (--no-run)");
  });

  it("실측 실행이 실패하면 문제로 보고한다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-"));
    const state = baseState({ repo_root: dir, verify_default: ["npm test"] });
    saveState(dir, state);

    const failingGate: Gate = async ({ commands }) => ({
      passed: false,
      results: commands.map(c => ({ command: c, exitCode: 1, signal: null, output: "boom", fatal: false, timedOut: false })),
    });

    const report = await runDoctor(dir, { git: okGit, gate: failingGate });
    expect(report.runs).not.toBeNull();
    expect(report.runs![0].passed).toBe(false);
    expect(doctorHasProblems(report)).toBe(true);
    expect(formatDoctorReport(report)).toContain("FAIL");
  });

  // §26 M1: doctor 가 gate({commands, cwd}) 만 넘겨 state.verify_timeout_ms 를 무시했다
  // (orchestrator.ts 는 제대로 넘김 — 두 경로가 어긋나 doctor 의 "실측"이 실제 run 과 다른
  // 조건으로 재는 문제, 실측 확인). doctor 도 동일하게 timeoutMs 를 전달해야 한다.
  it("§26 M1: state.verify_timeout_ms 를 gate 에 전달한다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-"));
    const state = baseState({ repo_root: dir, verify_default: ["npm test"], verify_timeout_ms: 12_345 });
    saveState(dir, state);

    let capturedTimeoutMs: number | undefined;
    const gate: Gate = async ({ commands, timeoutMs }) => {
      capturedTimeoutMs = timeoutMs;
      return { passed: true, results: commands.map(c => ({ command: c, exitCode: 0, signal: null, output: "", fatal: false, timedOut: false })) };
    };

    await runDoctor(dir, { git: okGit, gate });
    expect(capturedTimeoutMs).toBe(12_345);
  });

  it("§26 M1: verify_timeout_ms 가 없으면 undefined 를 전달한다 (gate 자체 기본값에 위임)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-"));
    const state = baseState({ repo_root: dir, verify_default: ["npm test"] });
    saveState(dir, state);

    let capturedTimeoutMs: number | undefined | null = null;
    const gate: Gate = async ({ commands, timeoutMs }) => {
      capturedTimeoutMs = timeoutMs;
      return { passed: true, results: commands.map(c => ({ command: c, exitCode: 0, signal: null, output: "", fatal: false, timedOut: false })) };
    };

    await runDoctor(dir, { git: okGit, gate });
    expect(capturedTimeoutMs).toBeUndefined();
  });

  // §26 I6 point 3: pr_mode:true + trusted_comment_authors:[] 는 이제 assertRunnable 이 거부하므로,
  // doctor 의 STATE 불변식 절에서 자동으로 문제로 보고돼야 한다("fw run" 이전에 "fw doctor" 로 발견).
  it("§26 I6: pr_mode + 빈 trusted_comment_authors 를 STATE 불변식 문제로 보고한다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-"));
    // §26 I5 잔여 승격 이후: verify_default 가 lint error("true")면 assertRunnable 이 그 이유로
    // 먼저 거부해 이 테스트가 노리는 trusted_comment_authors 사유를 가린다 — lint 를 통과하는
    // 값으로 바꿔 이 테스트가 원래 검증하려는 불변식만 단독으로 걸리게 한다.
    const state = baseState({
      repo_root: dir, verify_default: ["npm test"], pr_mode: true, allow_push: true, trusted_comment_authors: [],
    });
    saveState(dir, state);

    // §63 실측 — pr_mode:true 픽스처인데 gh 스텁이 없어 preflight 가 **실제 gh auth status 를
    // 스폰**했고, 사내 GHE 응답이 지연된 날 이 테스트가 타임아웃으로 죽었다(코드 회귀가 아니라
    // 네트워크 의존 테스트였던 것). deps.gh 주입 자리가 이미 있으니 쓰는 것이 계약이다.
    const report = await runDoctor(dir, { git: okGit, gh: async () => ({ ok: true, stdout: "", stderr: "" }), run: false });
    expect(report.stateInvariants.ok).toBe(false);
    expect(report.stateInvariants.problem).toMatch(/trusted_comment_authors/);
    expect(doctorHasProblems(report)).toBe(true);
    expect(formatDoctorReport(report)).toContain("trusted_comment_authors");
  });

  it("실제 git 저장소 + 실제 gate(runGate) 로 grep 검증이 통과함을 확인한다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-real-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    // 이 테스트는 **.gitignore 가 없는 상태**를 검증한다 — 다른 픽스처와 달리 일부러 만들지 않는다.
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "SMOKE.md"), "# smoke\n- 2026-hello\n");
    // §32 남은 부채/§30 P3: workflowDir(여기서는 repo_root 자신)의 logs/ 가 .gitignore 되어
    // 있지 않으면 runLogsProtection 이 "not-ignored" 로 판정해 doctorHasProblems 를 true 로
    // 올린다 — 이 테스트는 그 검사와 무관한 것(gate 실측)을 확인하려는 것이므로, 실전에서도
    // 정상적으로 설정된 리포를 흉내내 .gitignore 를 함께 커밋한다.
    fs.writeFileSync(path.join(dir, ".gitignore"), "logs/\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });

    const state = baseState({ repo_root: dir, verify_default: ["grep -q '^- 2026' SMOKE.md"] });
    saveState(dir, state);
    // STATE.json 자체가 repo_root 안에 있으므로, 커밋해두지 않으면 preflight 의 워킹트리
    // 청결 검사가 "커밋되지 않은 변경"으로 걸린다 — 실전에서도 STATE.json 은 커밋된 파일이다
    // (docs/pr-smoke/STATE.json 참조).
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "add STATE.json"], { cwd: dir });

    const report = await runDoctor(dir); // 기본 deps — 실제 git/gh/runGate 사용
    expect(report.preflight.ok).toBe(true);
    expect(report.runs![0].passed).toBe(true);
    expect(doctorHasProblems(report)).toBe(false);
  });

  it("§26 C1: workflowDir(docs/<workflow>/) 이 repo_root 서브디렉토리일 때, STATE.json 을 다시 고쳐도(재개 흉내) preflight 가 실패하지 않는다", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-real-"));
    execFileSync("git", ["init", "-q"], { cwd: repoRoot });
      fs.writeFileSync(path.join(repoRoot, ".gitignore"), "logs/\ndocs/*/logs/\n");
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repoRoot });
    const workflowDir = path.join(repoRoot, "docs", "wf");
    fs.mkdirSync(workflowDir, { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "SMOKE.md"), "# smoke\n- 2026-hello\n");

    const state = baseState({ repo_root: repoRoot, verify_default: ["grep -q '^- 2026' SMOKE.md"] });
    saveState(workflowDir, state);
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "init incl. STATE.json"], { cwd: repoRoot });

    // saveState() 재호출 흉내 — 실전에서 매 attempt/phase 마다 벌어지는 일. 커밋하지 않는다.
    saveState(workflowDir, state);

    const report = await runDoctor(workflowDir); // 기본 deps — 실제 git/gh/runGate 사용
    expect(report.preflight.ok).toBe(true);
  });

  // §27 O3 + §30 P2: 남은 STOP 파일은 **표시하되 문제로 치지 않는다.** `fw run` 이 시작 시
  // 소비(삭제)하므로 다음 실행을 막지 않고, 운영자가 `fw stop` 을 쓴 직후에는 남아 있는 게
  // 정상이다 — 이걸 exit 1 로 만들면 정상 상태를 실패로 보고하게 된다.
  it("§27 O3: 남아 있는 STOP 파일을 표시하되 문제로 치지 않는다 (정상 상태를 실패로 보고하지 않는다)", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-stop-"));
    execFileSync("git", ["init", "-q"], { cwd: repoRoot });
      fs.writeFileSync(path.join(repoRoot, ".gitignore"), "logs/\ndocs/*/logs/\n");
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repoRoot });
    const workflowDir = path.join(repoRoot, "docs", "wf");
    fs.mkdirSync(workflowDir, { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "SMOKE.md"), "# smoke\n- 2026-hello\n");
    // §32 남은 부채/§30 P3: docs/*/logs/ 를 .gitignore 해 정상적으로 설정된 리포를 흉내낸다 —
    // 안 그러면 runLogsProtection 이 "not-ignored" 로 잡혀 이 테스트가 노리는 STOP 표시 판정과
    // 무관하게 doctorHasProblems 가 true 가 된다.
    fs.writeFileSync(path.join(repoRoot, ".gitignore"), "logs/\ndocs/*/logs/\n");
    const state = baseState({ repo_root: repoRoot, verify_default: ["grep -q '^- 2026' SMOKE.md"] });
    saveState(workflowDir, state);
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });

    const before = await runDoctor(workflowDir);
    expect(before.halt.stopFilePresent).toBe(false);
    expect(doctorHasProblems(before)).toBe(false);

    fs.writeFileSync(path.join(workflowDir, "STOP"), "2026-08-27T00:00:00Z\n");
    const after = await runDoctor(workflowDir);
    expect(after.halt.stopFilePresent).toBe(true);
    expect(doctorHasProblems(after)).toBe(false); // 표시는 하되 exit 1 로 만들지 않는다
    const out = formatDoctorReport(after);
    expect(out).toContain("STOP 파일이 남아 있습니다");
    expect(out).toContain("소비(삭제)하고 정상 진행"); // 실제 동작과 일치하는 안내
    expect(out).not.toContain("첫 체크포인트에서 즉시 정지"); // fw run 이 소비하므로 사실이 아니다
  });

  // §32 I-5: 감사자가 실측한 `mkdir docs/wf/STOP` 시나리오 — STOP 이 일반 파일이 아니면
  // unlink 가 매번 실패해 `fw run` 이 영구히 halted 를 반복한다. 이건 "운영자가 방금 fw stop 을
  // 눌러 STOP 이 남아있는" 정상 상태(위 테스트)와 달리, 사람이 직접 치우기 전까지 해결되지 않는
  // 이상 상태다 — doctor 는 이 경우만 구분해서 exit 1 을 내야 한다(정상 STOP 은 계속 exit 0).
  it("§32 I-5: STOP 이 디렉토리이면(mkdir STOP) 정상 STOP 과 달리 문제로 판정한다 (exit 1)", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-stopdir-"));
    execFileSync("git", ["init", "-q"], { cwd: repoRoot });
      fs.writeFileSync(path.join(repoRoot, ".gitignore"), "logs/\ndocs/*/logs/\n");
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repoRoot });
    const workflowDir = path.join(repoRoot, "docs", "wf");
    fs.mkdirSync(workflowDir, { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "SMOKE.md"), "# smoke\n- 2026-hello\n");
    const state = baseState({ repo_root: repoRoot, verify_default: ["grep -q '^- 2026' SMOKE.md"] });
    saveState(workflowDir, state);
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });

    fs.mkdirSync(path.join(workflowDir, "STOP")); // 감사자 실측 시나리오: 파일이 아니라 디렉토리
    const report = await runDoctor(workflowDir);
    expect(report.halt.stopFilePresent).toBe(true);
    expect(report.halt.stopFileProblem).not.toBeNull();
    expect(doctorHasProblems(report)).toBe(true); // 정상 STOP 과 달리 exit 1
    const out = formatDoctorReport(report);
    expect(out).toContain("STOP 파일 삭제 실패");
    expect(out).toContain("결과: 문제 있음");

    fs.rmdirSync(path.join(workflowDir, "STOP"));
  });

  // §30 P2 정상 경로 회귀: "STOP 이 없다" 와 "STOP 이 정상 파일이다" 둘 다 stopFileProblem 이
  // null 이어야 한다 — 위 이상 상태 판정이 정상 경로까지 잡아먹지 않는지 명시적으로 고정한다.
  it("§30 P2 회귀: STOP 이 없거나 정상 파일이면 stopFileProblem 은 null 이다", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-stopok-"));
    execFileSync("git", ["init", "-q"], { cwd: repoRoot });
      fs.writeFileSync(path.join(repoRoot, ".gitignore"), "logs/\ndocs/*/logs/\n");
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repoRoot });
    const workflowDir = path.join(repoRoot, "docs", "wf");
    fs.mkdirSync(workflowDir, { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "SMOKE.md"), "# smoke\n- 2026-hello\n");
    // §32 남은 부채/§30 P3 — 위 STOP 테스트와 같은 이유로 docs/*/logs/ 를 .gitignore 한다.
    fs.writeFileSync(path.join(repoRoot, ".gitignore"), "logs/\ndocs/*/logs/\n");
    const state = baseState({ repo_root: repoRoot, verify_default: ["grep -q '^- 2026' SMOKE.md"] });
    saveState(workflowDir, state);
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });

    const noStop = await runDoctor(workflowDir);
    expect(noStop.halt.stopFileProblem).toBeNull();

    fs.writeFileSync(path.join(workflowDir, "STOP"), "t\n");
    const normalStop = await runDoctor(workflowDir);
    expect(normalStop.halt.stopFileProblem).toBeNull();
    expect(doctorHasProblems(normalStop)).toBe(false);
  });

  // halted 는 문제가 아니다 — 운영자가 멈췄고 `fw run` 으로 그대로 재개하면 된다(blocked 와 다르다).
  it("§27 O2: halted 상태는 표시하되 문제로 치지 않는다 (재개 가능한 정상 상태)", () => {
    const report: DoctorReport = {
      workflow: "wf", repoRoot: "/r",
      preflight: { ok: true, problems: [], currentBranch: "main", detached: false, warnings: [], originHost: null },
      stateInvariants: { ok: true, problem: null },
      defaultLint: [], defaultUsedByPhase: true, allPhasesDone: false,
      halt: { stopFilePresent: false, stopFileProblem: null, halted: true, haltReason: "비용 상한 초과: $12.40 / $10.00", costUsd: 12.4, maxCostUsd: 10, maxRuntimeMs: null },
      phaseLints: [], runs: null,
      planContext: { planFound: false, decisionsHeading: null, glossaryHeading: null, decisionsChars: 0, glossaryChars: 0 },
      runLogsProtection: { status: "ignored", relLogsDir: "docs/wf/logs/", allowUntrackedLogs: false },
      sandbox: { enabled: false, platform: "darwin", platformKnownSupported: true, bwrapCheck: null, networkAllowedDomains: null, originHostAutoAdded: null, filesystemDisabled: false, wildcardNetworkDomains: [] },
    };
    expect(doctorHasProblems(report)).toBe(false);
    const out = formatDoctorReport(report);
    expect(out).toContain("halted");
    expect(out).toContain("비용 상한 초과");
    expect(out).toContain("$12.40 / $10.00"); // 상한 대비로 보여준다
    // §32 후속(계약 교정): 이전 단언은 `toContain("재개할 수 있습니다")` 였다 — 비용 상한으로
    // 멈춘 상태인데 doctor 가 "재개할 수 있습니다" 라고 말하는 것을 **테스트가 못박고 있었다.**
    // totalCostUsd 는 STATE 누적이므로 재실행하면 즉시 다시 halted 된다(§32 I-5 가 런로그 쪽만
    // 고쳤고 이 표시면은 남아 있었다 — §30 P1). 이제 halt.ts 의 haltGuidance 를 공유한다.
    expect(out).toContain("재실행해도 즉시 다시 정지합니다");
    expect(out).toContain("max_cost_usd");                 // 해결 방법이 함께 나온다
    expect(out).not.toContain("재개하려면 `fw run` 을 다시 실행하세요");
    expect(out).toContain("답변은 필요하지 않습니다");      // blocked 와의 차이는 유지
  });

  // §32 후속: STOP/시간 상한은 실제로 재개 가능하므로 안내가 달라야 한다 — 사유별 분기가
  // doctor 표시면에도 적용됐는지(런로그와 갈리지 않는지) 확인한다.
  it("§32 후속: 재개 가능한 정지(operator)에는 재실행 안내를 그대로 보여준다", () => {
    const report: DoctorReport = {
      workflow: "wf", repoRoot: "/r",
      preflight: { ok: true, problems: [], currentBranch: "main", detached: false, warnings: [], originHost: null },
      stateInvariants: { ok: true, problem: null },
      defaultLint: [], defaultUsedByPhase: true, allPhasesDone: false,
      halt: { stopFilePresent: false, stopFileProblem: null, halted: true, haltReason: "operator", costUsd: 0, maxCostUsd: null, maxRuntimeMs: null },
      phaseLints: [], runs: null,
      planContext: { planFound: false, decisionsHeading: null, glossaryHeading: null, decisionsChars: 0, glossaryChars: 0 },
      runLogsProtection: { status: "ignored", relLogsDir: "docs/wf/logs/", allowUntrackedLogs: false },
      sandbox: { enabled: false, platform: "darwin", platformKnownSupported: true, bwrapCheck: null, networkAllowedDomains: null, originHostAutoAdded: null, filesystemDisabled: false, wildcardNetworkDomains: [] },
    };
    expect(doctorHasProblems(report)).toBe(false);
    const out = formatDoctorReport(report);
    expect(out).toContain("재개하려면 `fw run` 을 다시 실행하세요");
    expect(out).not.toContain("재실행해도");
  });

  it("formatDoctorReport 는 phase 별 issue 와 실측 결과를 모두 출력한다", () => {
    const report: DoctorReport = {
      workflow: "wf",
      repoRoot: "/r",
      preflight: { ok: true, problems: [], currentBranch: "main", detached: false, warnings: [], originHost: null },
      stateInvariants: { ok: true, problem: null },
      defaultLint: [], defaultUsedByPhase: true, allPhasesDone: false,
      halt: { stopFilePresent: false, stopFileProblem: null, halted: false, haltReason: null, costUsd: 0, maxCostUsd: null, maxRuntimeMs: null },
      phaseLints: [
        { phaseId: 1, phaseTitle: "p1", commands: ["npm test || true"], issues: [{ command: "npm test || true", severity: "error", reason: "무력화" }] },
      ],
      runs: [
        { phaseId: 1, phaseTitle: "p1", commands: ["npm test || true"], passed: true, results: [{ command: "npm test || true", exitCode: 0, signal: null, output: "", fatal: false, timedOut: false }] },
      ],
      planContext: { planFound: false, decisionsHeading: null, glossaryHeading: null, decisionsChars: 0, glossaryChars: 0 },
      runLogsProtection: { status: "ignored", relLogsDir: "docs/wf/logs/", allowUntrackedLogs: false },
      sandbox: { enabled: false, platform: "darwin", platformKnownSupported: true, bwrapCheck: null, networkAllowedDomains: null, originHostAutoAdded: null, filesystemDisabled: false, wildcardNetworkDomains: [] },
    };
    const out = formatDoctorReport(report);
    expect(out).toContain("Phase 1 (p1)");
    expect(out).toContain("ERROR");
    expect(out).toContain("PASS");
    expect(out).toContain("문제 있음");
  });
});

// §37 T1/S3/§30 P4 — 샌드박스가 켜졌는지·플랫폼 지원 힌트가 doctor 리포트에 보여야 한다(§36 I-3
// 이 이미 겪은 "배선했지만 관측이 없다" 부채 재발 방지). §30 P2 핵심 계약: **꺼짐은 exit 1 로
// 만들지 않는다** — 옵트인이 기본이므로 켜지 않은 것 자체는 문제가 아니다.
describe("runDoctor — [샌드박스] 진단 (§37 T1)", () => {
  it("sandbox 미설정(기본)이면 enabled:false 를 보고하고 doctorHasProblems 는 false 다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-sandbox-"));
    const state = baseState({ repo_root: dir, verify_default: ["npm test"] });
    saveState(dir, state);

    const passingGate: Gate = async ({ commands }) => ({
      passed: true,
      results: commands.map(c => ({ command: c, exitCode: 0, signal: null, output: "", fatal: false, timedOut: false })),
    });

    const report = await runDoctor(dir, { git: okGit, gate: passingGate, platform: "darwin" });
    expect(report.sandbox.enabled).toBe(false);
    expect(doctorHasProblems(report)).toBe(false); // §30 P2 — 꺼짐은 문제가 아니다
    const out = formatDoctorReport(report);
    expect(out).toContain("[샌드박스]");
    expect(out).toContain("비활성");
    expect(out).not.toContain("문제 있음");
  });

  it("sandbox.enabled:true 면 report.sandbox.enabled 가 true 이고 formatDoctorReport 가 '활성'을 보여준다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-sandbox-"));
    const state = baseState({
      repo_root: dir, verify_default: ["npm test"],
      sandbox: { enabled: true, failIfUnavailable: false }, // 소비 시점에 강제되는지는 state.test.ts 소관
    });
    saveState(dir, state);

    const passingGate: Gate = async ({ commands }) => ({
      passed: true,
      results: commands.map(c => ({ command: c, exitCode: 0, signal: null, output: "", fatal: false, timedOut: false })),
    });

    const report = await runDoctor(dir, { git: okGit, gate: passingGate, platform: "darwin" });
    expect(report.sandbox.enabled).toBe(true);
    expect(doctorHasProblems(report)).toBe(false);
    expect(formatDoctorReport(report)).toContain("활성");
  });

  it("platform 을 주입하면 그 값과 지원 플랫폼 여부를 보고한다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-sandbox-"));
    const state = baseState({ repo_root: dir, verify_default: ["npm test"] });
    saveState(dir, state);

    const passingGate: Gate = async ({ commands }) => ({
      passed: true,
      results: commands.map(c => ({ command: c, exitCode: 0, signal: null, output: "", fatal: false, timedOut: false })),
    });

    const linuxReport = await runDoctor(dir, { git: okGit, gate: passingGate, platform: "linux" });
    expect(linuxReport.sandbox.platform).toBe("linux");
    expect(linuxReport.sandbox.platformKnownSupported).toBe(true);
    expect(formatDoctorReport(linuxReport)).toContain("linux");

    const unknownReport = await runDoctor(dir, { git: okGit, gate: passingGate, platform: "aix" });
    expect(unknownReport.sandbox.platformKnownSupported).toBe(false);
    expect(doctorHasProblems(unknownReport)).toBe(false); // 미지원 플랫폼도 exit 1 은 아니다(§30 P2)
    expect(formatDoctorReport(unknownReport)).toContain("확인 필요");
  });

  // §37 sandbox-trial 막힘 1 후속 — [샌드박스] 절이 "실제로 무엇이 허용되는가" 와 "그중 무엇이
  // 자동 포함됐는가" 를 사용자가 설정한 것과 구분해서 보여주는지(§30 P4).
  describe("§37 sandbox-trial 막힘 1 후속: [샌드박스] 절의 network.allowedDomains 표시", () => {
    const passingGate: Gate = async ({ commands }) => ({
      passed: true,
      results: commands.map(c => ({ command: c, exitCode: 0, signal: null, output: "", fatal: false, timedOut: false })),
    });
    const gitWithOrigin = async (args: string[]): Promise<CliExecResult> => {
      if (args[0] === "remote" && args[1] === "get-url" && args[2] === "origin") {
        return { ok: true, stdout: "https://ghe.example.com/DolphaGo/AI-Assistant.git\n", stderr: "" };
      }
      return okGit();
    };

    it("network 설정이 없으면 origin 호스트를 자동 포함으로 보고하고 '(자동' 표시가 붙는다", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-sandbox-"));
      const state = baseState({
        repo_root: dir, verify_default: ["npm test"], sandbox: { enabled: true },
      });
      saveState(dir, state);

      const report = await runDoctor(dir, { git: gitWithOrigin, gate: passingGate, platform: "darwin" });
      expect(report.sandbox.networkAllowedDomains).toEqual(["ghe.example.com"]);
      expect(report.sandbox.originHostAutoAdded).toBe("ghe.example.com");
      const out = formatDoctorReport(report);
      expect(out).toContain("ghe.example.com (자동: git origin)");
    });

    it("사용자가 allowedDomains 를 명시했으면 자동 포함 표시 없이 그대로 보여준다", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-sandbox-"));
      const state = baseState({
        repo_root: dir, verify_default: ["npm test"],
        sandbox: { enabled: true, network: { allowedDomains: ["github.com"] } },
      });
      saveState(dir, state);

      const report = await runDoctor(dir, { git: gitWithOrigin, gate: passingGate, platform: "darwin" });
      expect(report.sandbox.networkAllowedDomains).toEqual(["github.com"]);
      expect(report.sandbox.originHostAutoAdded).toBeNull();
      const out = formatDoctorReport(report);
      expect(out).toContain("github.com");
      expect(out).not.toContain("자동");
    });

    it("network 설정도 origin 호스트도 없으면 '미설정' 을 보여준다", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-sandbox-"));
      const state = baseState({
        repo_root: dir, verify_default: ["npm test"], sandbox: { enabled: true },
      });
      saveState(dir, state);

      const report = await runDoctor(dir, { git: okGit, gate: passingGate, platform: "darwin" });
      expect(report.sandbox.networkAllowedDomains).toBeNull();
      expect(report.sandbox.originHostAutoAdded).toBeNull();
      expect(formatDoctorReport(report)).toContain("미설정");
    });
  });
});

describe("sandboxNeutralizationSignals / isSandboxNeutralized / sandboxNeutralizationNotes (§41 C-3)", () => {
  it("undefined settings(샌드박스 비활성)는 무력화 신호가 전혀 없다", () => {
    const signals = sandboxNeutralizationSignals(undefined);
    expect(signals).toEqual({ filesystemDisabled: false, wildcardNetworkDomains: [] });
    expect(isSandboxNeutralized(signals)).toBe(false);
    expect(sandboxNeutralizationNotes(signals)).toEqual([]);
  });

  it("filesystem.disabled:true 만 있으면 그 신호만 감지한다", () => {
    const signals = sandboxNeutralizationSignals({ enabled: true, filesystem: { disabled: true } });
    expect(signals.filesystemDisabled).toBe(true);
    expect(signals.wildcardNetworkDomains).toEqual([]);
    expect(isSandboxNeutralized(signals)).toBe(true);
    expect(sandboxNeutralizationNotes(signals)).toEqual(["파일시스템 격리 꺼짐(filesystem.disabled)"]);
  });

  it("allowedDomains 에 순수 와일드카드(*)가 섞여 있으면 그것만 추려낸다", () => {
    const signals = sandboxNeutralizationSignals({
      enabled: true, network: { allowedDomains: ["github.com", "*", "*.internal.example"] },
    });
    // "*.internal.example" 은 스코프가 좁혀진 정당한 와일드카드라 포함하지 않는다
    expect(signals.wildcardNetworkDomains).toEqual(["*"]);
    expect(isSandboxNeutralized(signals)).toBe(true);
  });

  it("filesystem.disabled:false 는 무력화로 세지 않는다 (명시적 false)", () => {
    const signals = sandboxNeutralizationSignals({ enabled: true, filesystem: { disabled: false } });
    expect(signals.filesystemDisabled).toBe(false);
    expect(isSandboxNeutralized(signals)).toBe(false);
  });
});

// §41 C-3 — 감사 실측: filesystem.disabled:true·와일드카드 allowedDomains(["*"])를 STATE 에 넣어도
// 무력화해도 예전에는 `fw doctor`/`fw status` 가 "샌드박스: 활성" 만 말하고 무엇이 무력화됐는지
// 전혀 보여주지 않았다(doctorHasProblems 도 report.sandbox 를 아예 보지 않았다). §37 S3 의 존재
// 이유가 "켜졌는지 보여줘야 한다" 인데 "무엇이 켜졌는가" 를 빠뜨린 결함이다.
describe("runDoctor — §41 C-3: 무력화 신호(filesystem.disabled/와일드카드 도메인)를 표시한다", () => {
  const passingGate: Gate = async ({ commands }) => ({
    passed: true,
    results: commands.map(c => ({ command: c, exitCode: 0, signal: null, output: "", fatal: false, timedOut: false })),
  });

  it("filesystem.disabled:true 면 report.sandbox.filesystemDisabled 가 true 이고 doctor 가 ⚠ 로 표시한다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-sandbox-c3-"));
    const state = baseState({
      repo_root: dir, verify_default: ["npm test"],
      sandbox: { enabled: true, filesystem: { disabled: true } },
    });
    saveState(dir, state);

    const report = await runDoctor(dir, { git: okGit, gate: passingGate, platform: "darwin" });
    expect(report.sandbox.filesystemDisabled).toBe(true);
    expect(report.sandbox.wildcardNetworkDomains).toEqual([]);
    // §37 S1/§30 P2 — 옵트인 위험 수용이므로 exit 1 로 만들지 않는다(판단 근거는 doctorHasProblems
    // 주석 참조).
    expect(doctorHasProblems(report)).toBe(false);
    const out = formatDoctorReport(report);
    expect(out).toContain("⚠");
    expect(out).toContain("파일시스템 격리 꺼짐");
    // "활성"이 무조건 찍히던 예전 문구가 그대로 남아 있으면 안 된다 — 조건부 문장으로 바뀌어야 한다.
    expect(out).not.toContain("● 활성 — failIfUnavailable=true 강제 적용 (의존성이 없으면");
  });

  it("네트워크 allowedDomains 가 와일드카드(*)면 report.sandbox.wildcardNetworkDomains 에 담기고 doctor 가 ⚠ 로 표시한다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-sandbox-c3-"));
    const state = baseState({
      repo_root: dir, verify_default: ["npm test"],
      sandbox: { enabled: true, network: { allowedDomains: ["*"] } },
    });
    saveState(dir, state);

    const report = await runDoctor(dir, { git: okGit, gate: passingGate, platform: "darwin" });
    expect(report.sandbox.filesystemDisabled).toBe(false);
    expect(report.sandbox.wildcardNetworkDomains).toEqual(["*"]);
    expect(doctorHasProblems(report)).toBe(false);
    const out = formatDoctorReport(report);
    expect(out).toContain("⚠");
    expect(out).toContain("와일드카드");
  });

  it("filesystem.disabled 와 와일드카드 도메인이 함께면 두 사유가 모두 표시된다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-sandbox-c3-"));
    const state = baseState({
      repo_root: dir, verify_default: ["npm test"],
      sandbox: { enabled: true, filesystem: { disabled: true }, network: { allowedDomains: ["*"] } },
    });
    saveState(dir, state);

    const report = await runDoctor(dir, { git: okGit, gate: passingGate, platform: "darwin" });
    expect(report.sandbox.filesystemDisabled).toBe(true);
    expect(report.sandbox.wildcardNetworkDomains).toEqual(["*"]);
    const out = formatDoctorReport(report);
    expect(out).toContain("파일시스템 격리 꺼짐");
    expect(out).toContain("와일드카드");
  });

  // §30 P2 회귀 — 특정 도메인 하위로 범위를 좁힌 정당한 와일드카드(`*.github.com`)까지 "무력화"로
  // 오탐하면 정상 사용이 경고 대상이 된다. 이건 무력화 신호에 넣지 않는다.
  it("§30 P2 회귀: `*.github.com` 처럼 스코프가 좁혀진 와일드카드는 무력화로 보지 않는다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-sandbox-c3-"));
    const state = baseState({
      repo_root: dir, verify_default: ["npm test"],
      sandbox: { enabled: true, network: { allowedDomains: ["*.github.com"] } },
    });
    saveState(dir, state);

    const report = await runDoctor(dir, { git: okGit, gate: passingGate, platform: "darwin" });
    expect(report.sandbox.wildcardNetworkDomains).toEqual([]);
    const out = formatDoctorReport(report);
    expect(out).not.toContain("⚠");
    expect(out).toContain("● 활성 — failIfUnavailable=true 강제 적용 (의존성이 없으면");
  });

  // §30 P2 회귀 — 무력화 신호가 없는 정상 sandbox.enabled:true 는 기존 출력 그대로여야 한다.
  it("§30 P2 회귀: 무력화 신호 없는 정상 활성화는 기존처럼 ⚠ 없이 표시된다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-sandbox-c3-"));
    const state = baseState({
      repo_root: dir, verify_default: ["npm test"],
      sandbox: { enabled: true },
    });
    saveState(dir, state);

    const report = await runDoctor(dir, { git: okGit, gate: passingGate, platform: "darwin" });
    expect(report.sandbox.filesystemDisabled).toBe(false);
    expect(report.sandbox.wildcardNetworkDomains).toEqual([]);
    const out = formatDoctorReport(report);
    expect(out).not.toContain("⚠");
    expect(out).toContain("● 활성");
  });

  // §30 P2 회귀 — sandbox 미설정/enabled:false 는 이 판정 자체가 적용되지 않는다(기존 출력 그대로).
  it("§30 P2 회귀: sandbox 미설정이면 무력화 필드가 모두 false/빈 배열이고 경고가 없다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-sandbox-c3-"));
    const state = baseState({ repo_root: dir, verify_default: ["npm test"] });
    saveState(dir, state);

    const report = await runDoctor(dir, { git: okGit, gate: passingGate, platform: "darwin" });
    expect(report.sandbox.filesystemDisabled).toBe(false);
    expect(report.sandbox.wildcardNetworkDomains).toEqual([]);
    expect(doctorHasProblems(report)).toBe(false);
    expect(formatDoctorReport(report)).not.toContain("⚠");
  });
});

// sandbox-trial PLAN D3/D4/D5/D6 — 플랫폼 판정을 이름 대조에서 실측으로 바꾼다: Linux 에서
// bubblewrap(bwrap) 이 실제로 PATH 에서 스폰 가능한지 확인한다. 실측 불가/불확실은 "미확인"으로
// 표시하고(D4), 어떤 결과든(없음/미확인 포함) doctorHasProblems 를 true 로 올리지 않는다(D5 —
// 샌드박스는 옵트인이라 doctor 가 실패시키지 않는다).
describe("runDoctor — Linux bwrap 의존성 실측 (sandbox-trial PLAN D3/D4/D5)", () => {
  const passingGate: Gate = async ({ commands }) => ({
    passed: true,
    results: commands.map(c => ({ command: c, exitCode: 0, signal: null, output: "", fatal: false, timedOut: false })),
  });

  it("platform !== linux 이면 bwrapCheck 는 null(해당 없음)이고, 리포트에 bwrap 줄이 없다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-bwrap-"));
    const state = baseState({ repo_root: dir, verify_default: ["npm test"] });
    saveState(dir, state);

    // checkBwrap 을 일부러 "호출되면 실패"하는 스텁으로 넣는다 — platform !== linux 일 때
    // 실제로 호출되지 않는다는 것까지 증명한다(호출됐다면 이 테스트가 예외로 실패한다).
    const checkBwrap = async (): Promise<never> => {
      throw new Error("platform !== linux 인데 checkBwrap 이 호출됐다");
    };

    const report = await runDoctor(dir, { git: okGit, gate: passingGate, platform: "darwin", checkBwrap });
    expect(report.sandbox.bwrapCheck).toBeNull();
    expect(formatDoctorReport(report)).not.toContain("bubblewrap");
  });

  it("found: checkBwrap 이 found 를 반환하면 '있음'으로 표시하고 문제로 치지 않는다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-bwrap-"));
    const state = baseState({ repo_root: dir, verify_default: ["npm test"] });
    saveState(dir, state);

    const checkBwrap = async (): Promise<BwrapCheck> => ({ status: "found", detail: "`bwrap --version` 실행 성공" });
    const report = await runDoctor(dir, { git: okGit, gate: passingGate, platform: "linux", checkBwrap });

    expect(report.sandbox.bwrapCheck).toEqual({ status: "found", detail: "`bwrap --version` 실행 성공" });
    expect(doctorHasProblems(report)).toBe(false);
    const out = formatDoctorReport(report);
    expect(out).toContain("bubblewrap(bwrap): 있음");
    expect(out).not.toContain("결과: 문제 있음");
  });

  it("not-found: checkBwrap 이 not-found 를 반환하면 '없음'으로 표시하되 여전히 문제로 치지 않는다 (D5)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-bwrap-"));
    const state = baseState({ repo_root: dir, verify_default: ["npm test"] });
    saveState(dir, state);

    const checkBwrap = async (): Promise<BwrapCheck> => ({ status: "not-found", detail: "PATH 에서 `bwrap` 실행 파일을 찾을 수 없습니다 (ENOENT)" });
    const report = await runDoctor(dir, { git: okGit, gate: passingGate, platform: "linux", checkBwrap });

    expect(report.sandbox.bwrapCheck?.status).toBe("not-found");
    expect(doctorHasProblems(report)).toBe(false); // 미지원(없음)도 exit 1 이 아니다 — 옵트인이므로
    const out = formatDoctorReport(report);
    expect(out).toContain("bubblewrap(bwrap): 없음");
    expect(out).toContain("apt install bubblewrap");
  });

  it("unconfirmed: 실측이 불확실하면 있다고도 없다고도 단정하지 않고 '미확인'으로 표시한다 (D4)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-bwrap-"));
    const state = baseState({ repo_root: dir, verify_default: ["npm test"] });
    saveState(dir, state);

    const checkBwrap = async (): Promise<BwrapCheck> => ({ status: "unconfirmed", detail: "실측 실패(원인 불명): EACCES" });
    const report = await runDoctor(dir, { git: okGit, gate: passingGate, platform: "linux", checkBwrap });

    expect(report.sandbox.bwrapCheck?.status).toBe("unconfirmed");
    expect(doctorHasProblems(report)).toBe(false);
    const out = formatDoctorReport(report);
    expect(out).toContain("bubblewrap(bwrap): 미확인");
    expect(out).toContain("단정하지 않습니다");
  });

  // §30 P2 방어적 회귀 — checkBwrap 자체가 계약을 어기고 reject 해도(구현 버그·예상 밖 예외),
  // runDoctor 는 "없다"로 단정하지 않고 미확인으로 degrade 한다. 어느 쪽으로든 exit 1 로
  // 만들지 않는다(D5).
  it("checkBwrap 이 reject 해도 예외가 전파되지 않고 미확인으로 degrade 한다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-bwrap-"));
    const state = baseState({ repo_root: dir, verify_default: ["npm test"] });
    saveState(dir, state);

    const checkBwrap = async (): Promise<BwrapCheck> => {
      throw new Error("예상치 못한 구현 버그");
    };
    const report = await runDoctor(dir, { git: okGit, gate: passingGate, platform: "linux", checkBwrap });

    expect(report.sandbox.bwrapCheck?.status).toBe("unconfirmed");
    expect(doctorHasProblems(report)).toBe(false);
  });

  // defaultCheckBwrap 자체의 실측이 진짜 동작하는지 — mock 없이 실제 프로세스를 스폰해, PATH
  // 조회의 독립적인 두 번째 경로(`sh -c "command -v bwrap"`)와 결과가 일치하는지 교차 검증한다.
  // 이 테스트는 이 dev/CI 머신에 bwrap 이 있든 없든 통과해야 한다 — "이 환경엔 없다"를
  // 하드코딩하는 대신, 독립된 측정 수단과 비교해 defaultCheckBwrap 이 실제로 판별력이 있음을
  // 증명한다(다르게 나오면 방금 이 테스트가 실측 로직의 버그를 잡은 것이다).
  it("defaultCheckBwrap: 실제 스폰 결과가 독립적인 PATH 조회(`command -v`)와 일치한다", async () => {
    let independentlyExists = true;
    try {
      execFileSync("sh", ["-c", "command -v bwrap"], { stdio: "ignore" });
    } catch {
      independentlyExists = false;
    }

    const result = await defaultCheckBwrap();
    expect(result.status).toBe(independentlyExists ? "found" : "not-found");
    expect(result.detail.length).toBeGreaterThan(0);
  });
});

// §32 남은 부채/§30 P3 — docs/<workflow>/logs/ 가 git 에 의해 무시되는지(state.ts 의
// checkRunLogsIgnored). §27 O1 감사 로그(DENY 명령 전문)는 §32 I-1 마스킹 재설계 이후에도
// 33% 는 의도적으로 마스킹하지 않으므로, 그 로그가 대상 리포에 커밋될 수 없게 만드는 것이
// 정규식 경쟁보다 확실한 방어다(감사자 권고). "not-ignored" 이고 옵트아웃도 안 됐을 때만
// exit 1 — outside-repo/unknown/옵트아웃은 §30 P2 그대로 문제로 치지 않는다.
describe("runDoctor — [실행 로그 보호] 진단 (§32 남은 부채/§30 P3)", () => {
  // 결정론적 단위 테스트 — 실제 git 프로세스 없이 DI 배선(DoctorDeps.checkIgnoreGit) 자체를
  // 검증한다. exitCode:1 은 "git 이 이 경로를 무시하지 않는다"(진짜 문제)의 실제 git 신호다
  // (state.ts checkRunLogsIgnored 주석의 실측 참조).
  it("checkIgnoreGit 이 exitCode:1 을 반환하면 문제로 보고하고 정확한 해결 줄을 보여준다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-logs-"));
    const state = baseState({ repo_root: dir, verify_default: ["npm test"] });
    saveState(dir, state);

    const passingGate: Gate = async ({ commands }) => ({
      passed: true,
      results: commands.map(c => ({ command: c, exitCode: 0, signal: null, output: "", fatal: false, timedOut: false })),
    });
    const checkIgnoreGit = async (): Promise<{ exitCode: number | null; stderr: string }> => ({ exitCode: 1, stderr: "" });

    const report = await runDoctor(dir, { git: okGit, gate: passingGate, checkIgnoreGit });
    expect(report.runLogsProtection.status).toBe("not-ignored");
    expect(doctorHasProblems(report)).toBe(true);
    const out = formatDoctorReport(report);
    expect(out).toContain("[실행 로그 보호]");
    expect(out).toContain("가 git 에 무시되지 않습니다");
    expect(out).toContain("§32 I-1: 마스킹은 완전하지 않다");
    expect(out).toContain("리포 루트 .gitignore 에 다음 줄을 추가하세요:");
    // workflowDir === repo_root === dir(basename 이 "docs/<workflow>" 관례 밖) 이므로
    // 와일드카드가 아니라 정확한 단일 경로(logs/)를 권한다 — 관례를 따르는 경우는 아래 별도
    // 테스트("docs/<workflow> 관례...")에서 확인한다.
    expect(out).toContain("/logs/");
  });

  // workflowDir 이 정확히 docs/<workflow> 관례를 따를 때 와일드카드 권고(docs/*/logs/)가 나온다.
  it("workflowDir 이 docs/<workflow> 관례를 따르면 docs/*/logs/ 를 권한다", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-logs-conv-"));
    const workflowDir = path.join(repoRoot, "docs", "pr-smoke");
    fs.mkdirSync(workflowDir, { recursive: true });
    const state = baseState({ repo_root: repoRoot, verify_default: ["npm test"] });
    saveState(workflowDir, state);

    const passingGate: Gate = async ({ commands }) => ({
      passed: true,
      results: commands.map(c => ({ command: c, exitCode: 0, signal: null, output: "", fatal: false, timedOut: false })),
    });
    const checkIgnoreGit = async (): Promise<{ exitCode: number | null; stderr: string }> => ({ exitCode: 1, stderr: "" });

    const report = await runDoctor(workflowDir, { git: okGit, gate: passingGate, checkIgnoreGit });
    expect(report.runLogsProtection.relLogsDir).toBe("docs/pr-smoke/logs/");
    const out = formatDoctorReport(report);
    expect(out).toContain("docs/pr-smoke/logs/ 가 git 에 무시되지 않습니다");
    expect(out).toContain("        docs/*/logs/"); // 정확한 해결 줄(들여쓰기 포함)
  });

  it("checkIgnoreGit 이 exitCode:0 을 반환하면 OK 로 표시하고 문제로 치지 않는다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-logs-ok-"));
    const state = baseState({ repo_root: dir, verify_default: ["npm test"] });
    saveState(dir, state);

    const passingGate: Gate = async ({ commands }) => ({
      passed: true,
      results: commands.map(c => ({ command: c, exitCode: 0, signal: null, output: "", fatal: false, timedOut: false })),
    });
    const checkIgnoreGit = async (): Promise<{ exitCode: number | null; stderr: string }> => ({ exitCode: 0, stderr: "" });

    const report = await runDoctor(dir, { git: okGit, gate: passingGate, checkIgnoreGit });
    expect(report.runLogsProtection.status).toBe("ignored");
    expect(doctorHasProblems(report)).toBe(false);
    expect(formatDoctorReport(report)).toContain("가 git 에 무시됩니다");
  });

  // §30 P2 탈출구: 위험을 알고도 명시적으로 수용한 사용자는 막지 않는다 — 다만 위험을
  // 감수했다는 사실은 표시한다("실수로 방치"와 "의도적 수용"을 STATE 만 보고 구분).
  it("allow_untracked_logs: true 면 not-ignored 여도 문제로 치지 않되 옵트아웃 사실을 표시한다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-logs-optout-"));
    const state = baseState({ repo_root: dir, verify_default: ["npm test"] });
    (state as { allow_untracked_logs?: boolean }).allow_untracked_logs = true;
    saveState(dir, state);

    const passingGate: Gate = async ({ commands }) => ({
      passed: true,
      results: commands.map(c => ({ command: c, exitCode: 0, signal: null, output: "", fatal: false, timedOut: false })),
    });
    const checkIgnoreGit = async (): Promise<{ exitCode: number | null; stderr: string }> => ({ exitCode: 1, stderr: "" });

    const report = await runDoctor(dir, { git: okGit, gate: passingGate, checkIgnoreGit });
    expect(report.runLogsProtection.status).toBe("not-ignored");
    expect(doctorHasProblems(report)).toBe(false); // 옵트아웃했으므로 문제로 치지 않는다
    const out = formatDoctorReport(report);
    expect(out).toContain("allow_untracked_logs: true 로 위험을");
  });

  // §30 P2 정상 경로: workflowDir 이 repo_root 밖이면 애초에 그 리포에 커밋될 길이 없으므로
  // 검사하지 않는다(문제로 치지 않는다).
  it("§30 P2 정상 경로: workflowDir 이 repo_root 밖이면 검사하지 않고 통과한다", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-logs-outside-repo-"));
    const workflowDir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-logs-outside-wf-"));
    const state = baseState({ repo_root: repoRoot, verify_default: ["npm test"] });
    saveState(workflowDir, state);

    const passingGate: Gate = async ({ commands }) => ({
      passed: true,
      results: commands.map(c => ({ command: c, exitCode: 0, signal: null, output: "", fatal: false, timedOut: false })),
    });
    // outside-repo 판정은 git 호출 전에 끝나야 한다 — 호출되면 실패하는 스텁으로 그 사실을 증명한다.
    const checkIgnoreGit = async (): Promise<{ exitCode: number | null; stderr: string }> => {
      throw new Error("outside-repo 인데 git 을 호출했다 — 검사가 불필요하게 실행됨");
    };

    const report = await runDoctor(workflowDir, { git: okGit, gate: passingGate, checkIgnoreGit });
    expect(report.runLogsProtection.status).toBe("outside-repo");
    expect(doctorHasProblems(report)).toBe(false);
    expect(formatDoctorReport(report)).toContain("workflowDir 이 repo_root 밖입니다");
  });

  // §30 P2 정상 경로: git 저장소가 아니거나 check-ignore 실행 자체가 실패하면 예외 없이
  // degrade 한다 — 진단 불가를 문제로 만들지 않는다.
  it("§30 P2 정상 경로: git 저장소가 아니면(exitCode:128) 문제로 치지 않고 degrade 한다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-logs-notrepo-"));
    const state = baseState({ repo_root: dir, verify_default: ["npm test"] });
    saveState(dir, state);

    const passingGate: Gate = async ({ commands }) => ({
      passed: true,
      results: commands.map(c => ({ command: c, exitCode: 0, signal: null, output: "", fatal: false, timedOut: false })),
    });
    const checkIgnoreGit = async (): Promise<{ exitCode: number | null; stderr: string }> => ({
      exitCode: 128,
      stderr: "fatal: not a git repository",
    });

    const report = await runDoctor(dir, { git: okGit, gate: passingGate, checkIgnoreGit });
    expect(report.runLogsProtection.status).toBe("unknown");
    expect(doctorHasProblems(report)).toBe(false);
    expect(formatDoctorReport(report)).toContain("판정할 수 없습니다");
  });

  // §30 P2 정상 경로: 실제 프리플라이트 실패(failGit) 시나리오에서도 로그 보호 판정 자체는
  // 별도 실행기(checkIgnoreGit 기본값 = 실제 git)를 타므로, git 이 아닌 임시 디렉토리를 만나면
  // "unknown" 으로 조용히 degrade 해야 한다(예외를 던지지 않는다).
  it("§30 P2 정상 경로: 기본 checkIgnoreGit(실제 git)도 저장소가 아니면 예외 없이 degrade 한다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-logs-realnotrepo-"));
    const state = baseState({ repo_root: dir, verify_default: ["npm test"] });
    saveState(dir, state);

    const failGitLocal = async (): Promise<CliExecResult> => ({ ok: false, stdout: "", stderr: "fatal: not a git repository" });
    const report = await runDoctor(dir, { git: failGitLocal, run: false }); // checkIgnoreGit 미지정 — 기본값(실제 git) 사용
    expect(report.runLogsProtection.status).toBe("unknown");
  });

  // 실제 git 저장소 종단 테스트 — DI 를 신뢰하지 않고 진짜 git check-ignore 동작으로 재확인한다.
  it("실제 git 저장소 + .gitignore 없음 → not-ignored 로 실측되고 exit 1 로 이어진다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-logs-realgit-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    // 이 테스트는 **.gitignore 가 없는 상태**를 검증한다 — 다른 픽스처와 달리 일부러 만들지 않는다.
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "SMOKE.md"), "# smoke\n- 2026-hello\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });

    const state = baseState({ repo_root: dir, verify_default: ["grep -q '^- 2026' SMOKE.md"] });
    saveState(dir, state);
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "add STATE.json"], { cwd: dir });

    const report = await runDoctor(dir); // 기본 deps 전부 — 실제 git 사용
    expect(report.runLogsProtection.status).toBe("not-ignored");
    expect(doctorHasProblems(report)).toBe(true);

    // .gitignore 를 추가하면 다음 실행은 통과한다(§30 P2: 탈출구가 실제로 작동한다).
    fs.writeFileSync(path.join(dir, ".gitignore"), "logs/\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "add gitignore"], { cwd: dir });
    const after = await runDoctor(dir);
    expect(after.runLogsProtection.status).toBe("ignored");
    expect(doctorHasProblems(after)).toBe(false);
  });
});

// §36 C-3 — symlink 경유 workflowDir/repo_root 에서도 doctor 가 "repo_root 밖" 이라는 거짓
// 문장을 내지 않는지 실제 git 저장소로 종단 검증한다(state.test.ts 는 checkRunLogsIgnored 자체를
// 단위 테스트한다 — 여기서는 runDoctor 전체 경로/표시 문구까지 확인한다).
describe("runDoctor — §36 C-3: symlink 경유에서도 로그 보호 판정이 정확하고 doctor 문구가 거짓이 아니다", () => {
  it("workflowDir 이 symlink 를 경유해도 'repo_root 밖' 거짓 문장을 내지 않고 실제 보호 여부(not-ignored)를 정확히 보고한다", async () => {
    const realDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-c3-real-")));
    execFileSync("git", ["init", "-q"], { cwd: realDir });
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: realDir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: realDir });
    fs.writeFileSync(path.join(realDir, "a.txt"), "1");
    execFileSync("git", ["add", "."], { cwd: realDir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: realDir });
    // .gitignore 는 일부러 두지 않는다 — "실제로 보호되지 않는다" 는 사실을 미리 알고 검증한다
    // (고쳐지기 전에는 이 사실과 무관하게 outside-repo 로 오판해 "OK" 가 나왔다).

    const symlinkDir = path.join(os.tmpdir(), `fw-doctor-c3-link-${process.pid}-${Date.now()}`);
    fs.symlinkSync(realDir, symlinkDir);
    try {
      const workflowDirViaSymlink = path.join(symlinkDir, "docs", "wf1");
      fs.mkdirSync(workflowDirViaSymlink, { recursive: true });
      const state = baseState({ repo_root: realDir, verify_default: ["npm test"] });
      saveState(workflowDirViaSymlink, state);

      const report = await runDoctor(workflowDirViaSymlink, { run: false }); // 기본 deps(실제 git), 실측 실행만 생략
      expect(report.runLogsProtection.status).toBe("not-ignored");
      const out = formatDoctorReport(report);
      expect(out).not.toContain("workflowDir 이 repo_root 밖입니다");
      expect(out).toContain("가 git 에 무시되지 않습니다");
      expect(doctorHasProblems(report)).toBe(true);
    } finally {
      fs.unlinkSync(symlinkDir);
    }
  });

  it("반대 방향(repo_root 가 symlink) 이어도 정확히 판정한다 — .gitignore 가 있으면 ignored", async () => {
    const realDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-c3-real2-")));
    execFileSync("git", ["init", "-q"], { cwd: realDir });
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: realDir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: realDir });
    fs.writeFileSync(path.join(realDir, ".gitignore"), "docs/*/logs/\n");
    fs.writeFileSync(path.join(realDir, "a.txt"), "1");
    execFileSync("git", ["add", "."], { cwd: realDir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: realDir });

    const workflowDir = path.join(realDir, "docs", "wf1");
    fs.mkdirSync(workflowDir, { recursive: true });

    const symlinkRepoRoot = path.join(os.tmpdir(), `fw-doctor-c3-reposym-${process.pid}-${Date.now()}`);
    fs.symlinkSync(realDir, symlinkRepoRoot);
    try {
      const state = baseState({ repo_root: symlinkRepoRoot, verify_default: ["npm test"] });
      saveState(workflowDir, state);

      const report = await runDoctor(workflowDir, { run: false });
      expect(report.runLogsProtection.status).toBe("ignored");
      const out = formatDoctorReport(report);
      expect(out).not.toContain("workflowDir 이 repo_root 밖입니다");
      expect(doctorHasProblems(report)).toBe(false);
    } finally {
      fs.unlinkSync(symlinkRepoRoot);
    }
  });
});

// §36 m-1 — doctor 가 로그 미보호를 [프리플라이트] 절과 [실행 로그 보호] 절에 각각 한 번씩,
// 도합 두 번 보고하고 있었다(감사자 실측). 그리고 doctor.ts 가 자기 자신의 preflight() 호출에
// deps.checkIgnoreGit 을 전달하지 않아, 스텁을 주입해도 preflight 내부 판정은 항상 실제 git 을
// 탔다 — 프로덕션에서만 우연히 checkRunLogsIgnored 판정과 일치했을 뿐인 §30 P1 잠복 사례였다.
describe("runDoctor — §36 m-1: [프리플라이트]·[실행 로그 보호] 중복 보고 제거 + checkIgnoreGit 배선 일치", () => {
  it("로그 미보호 메시지가 리포트 전체에 정확히 한 번만 나타난다 (중복 제거)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-m1-dedupe-"));
    const state = baseState({ repo_root: dir, verify_default: ["npm test"] });
    saveState(dir, state);
    const checkIgnoreGit = async (): Promise<{ exitCode: number | null; stderr: string }> => ({ exitCode: 1, stderr: "" });

    const report = await runDoctor(dir, { git: okGit, run: false, checkIgnoreGit });
    const out = formatDoctorReport(report);
    const occurrences = out.split("가 git 에 무시되지 않습니다").length - 1;
    expect(occurrences).toBe(1);
  });

  it("로그 미보호가 유일한 문제일 때 [프리플라이트] 절은 'OK' 를 보여준다 (표시만 정리, exit code 는 그대로 문제로 친다)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-m1-preflight-ok-display-"));
    const state = baseState({ repo_root: dir, verify_default: ["npm test"] });
    saveState(dir, state);
    const checkIgnoreGit = async (): Promise<{ exitCode: number | null; stderr: string }> => ({ exitCode: 1, stderr: "" });

    const report = await runDoctor(dir, { git: okGit, run: false, checkIgnoreGit });
    const out = formatDoctorReport(report);
    const preflightSection = out.split("[STATE 불변식]")[0]!;
    expect(preflightSection).toContain("[프리플라이트]\n  OK");
    // 그래도 전체 결과는 여전히 문제 있음이다 — 표시만 정리했을 뿐 판정은 안 바뀐다.
    expect(doctorHasProblems(report)).toBe(true);
    expect(out).toContain("결과: 문제 있음");
  });

  // §36 m-1 (둘째 결함) — doctor.ts:158 이 deps.checkIgnoreGit 을 preflight() 에 전달하지 않으면
  // preflight() 내부 판정은 항상 defaultRunLogsGitCheckIgnoreExec(실제 git) 을 타서, dir 이
  // 실제 git 저장소가 아닐 때 "unknown" 으로 degrade 해 문제를 못 본다 — 반면 runLogsProtection
  // 은 주입된 스텁(exitCode:1, "not-ignored") 을 타서 문제를 본다. 배선이 맞으면 두 판정이
  // 일치해 report.preflight.ok 도 false 가 된다.
  it("checkIgnoreGit 스텁이 preflight() 내부 판정에도 전달돼 report.preflight.ok 가 일치한다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-m1-wiring-"));
    // 실제 git 저장소가 아니다 — 배선이 안 됐다면 preflight() 내부 checkRunLogsIgnored 는
    // 기본(실제 git) 을 타 "저장소 아님"(unknown) 으로 degrade 해 problems 에 아무것도 안 남긴다.
    const state = baseState({ repo_root: dir, verify_default: ["npm test"] });
    saveState(dir, state);
    const checkIgnoreGit = async (): Promise<{ exitCode: number | null; stderr: string }> => ({ exitCode: 1, stderr: "" });

    const report = await runDoctor(dir, { git: okGit, run: false, checkIgnoreGit });
    expect(report.runLogsProtection.status).toBe("not-ignored"); // 스텁을 통해 본 판정
    expect(report.preflight.ok).toBe(false); // preflight() 내부도 같은 스텁을 타야 함께 문제로 본다
    expect(report.preflight.problems.some(p => p.includes("git 에 무시되지 않습니다"))).toBe(true);
  });
});

// §31 I6/§30 P4 — "PLAN §핵심 결정/§용어가 세션 프롬프트에 주입된다"는 주장을 doctor 가 직접
// 확인시켜준다. 어느 경우에도 exit code(doctorHasProblems)에는 영향을 주지 않아야 한다 —
// PLAN 절 미발견은 레거시 워크플로우의 정상 상태다(§30 P2, §29 MI-10 재발 방지).
describe("runDoctor — [PLAN 결정·용어·검증기준 주입] 진단 (§31 I6, §42)", () => {
  it("PLAN.md 가 없으면 '없음' 으로 표시하고 문제로 치지 않는다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-plan-"));
    const state = baseState({ repo_root: dir, verify_default: ["npm test"] });
    saveState(dir, state);

    const passingGate: Gate = async ({ commands }) => ({
      passed: true,
      results: commands.map(c => ({ command: c, exitCode: 0, signal: null, output: "", fatal: false, timedOut: false })),
    });

    const report = await runDoctor(dir, { git: okGit, gate: passingGate });
    expect(report.planContext.planFound).toBe(false);
    expect(doctorHasProblems(report)).toBe(false);
    const out = formatDoctorReport(report);
    expect(out).toContain("[PLAN 결정·용어·검증기준 주입]");
    expect(out).toContain("PLAN.md: 없음");
  });

  it("§결정/§용어 절이 없는 레거시 산문 PLAN.md → '미발견' 으로 표시하고 문제로 치지 않는다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-plan-"));
    const state = baseState({ repo_root: dir, verify_default: ["npm test"] });
    saveState(dir, state);
    fs.writeFileSync(path.join(dir, "PLAN.md"), "# 오래된 마이그레이션 플랜\n\n산문으로만 쓰여 있다.\n");

    const passingGate: Gate = async ({ commands }) => ({
      passed: true,
      results: commands.map(c => ({ command: c, exitCode: 0, signal: null, output: "", fatal: false, timedOut: false })),
    });

    const report = await runDoctor(dir, { git: okGit, gate: passingGate });
    expect(report.planContext.planFound).toBe(true);
    expect(report.planContext.decisionsHeading).toBeNull();
    expect(doctorHasProblems(report)).toBe(false); // 미발견은 문제가 아니다(§30 P2)
    const out = formatDoctorReport(report);
    expect(out).toContain("PLAN.md: 있음");
    expect(out).toContain("§핵심 결정: 미발견");
    expect(out).toContain("§용어: 미발견");
  });

  it("실제 docs/pr-smoke/PLAN.md(표 형식) → 결정·용어가 발견되고 문자 수가 표시된다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-plan-"));
    const state = baseState({ repo_root: dir, verify_default: ["npm test"] });
    saveState(dir, state);
    const testDir = path.dirname(fileURLToPath(import.meta.url));
    const realPlanPath = path.join(testDir, "fixtures", "pr-smoke", "PLAN.md");
    const realPlan = fs.readFileSync(realPlanPath, "utf-8");
    fs.writeFileSync(path.join(dir, "PLAN.md"), realPlan);

    const passingGate: Gate = async ({ commands }) => ({
      passed: true,
      results: commands.map(c => ({ command: c, exitCode: 0, signal: null, output: "", fatal: false, timedOut: false })),
    });

    const report = await runDoctor(dir, { git: okGit, gate: passingGate });
    expect(report.planContext.decisionsHeading).toBe("## 핵심 결정 사항");
    expect(report.planContext.glossaryHeading).toBe("## 용어");
    expect(report.planContext.decisionsChars).toBeGreaterThan(0);
    expect(report.planContext.glossaryChars).toBeGreaterThan(0);
    expect(doctorHasProblems(report)).toBe(false);
    const out = formatDoctorReport(report);
    expect(out).toContain("§핵심 결정: 발견 (## 핵심 결정 사항,");
    expect(out).toContain("자 주입)");
    expect(out).toContain("§용어: 발견 (## 용어,");
  });

  // §32 남은 부채/§30 P4 — plan.ts(§32 I-6)가 채워온 decisionsCandidateCount/Headings 를
  // doctor 가 표시하는지 확인한다. 감사자 권고: "골랐다는 사실보다 '다른 후보가 있었다' 가
  // 정보다." 후보가 여럿이어도 정당한 PLAN 구조일 수 있으므로(§30 P2) 문제(exit 1)로 만들지
  // 않는다 — 표시만 한다.
  it("§30 P4: 절 후보가 2개 이상이면 doctor 가 '후보가 N개 있었습니다' 로 표시하고 문제로 치지 않는다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-plan-candidates-"));
    const state = baseState({ repo_root: dir, verify_default: ["npm test"] });
    saveState(dir, state);
    fs.writeFileSync(
      path.join(dir, "PLAN.md"),
      [
        "## 핵심 결정 사항",
        "",
        "| ID | 결정 |",
        "|----|------|",
        "| D1 | 첫 번째 절 결정 |",
        "",
        "## 주요 결정",
        "",
        "| ID | 결정 |",
        "|----|------|",
        "| D2 | 두 번째 절 결정 |",
      ].join("\n"),
    );

    const passingGate: Gate = async ({ commands }) => ({
      passed: true,
      results: commands.map(c => ({ command: c, exitCode: 0, signal: null, output: "", fatal: false, timedOut: false })),
    });

    const report = await runDoctor(dir, { git: okGit, gate: passingGate });
    expect(report.planContext.decisionsCandidateCount).toBe(2);
    expect(doctorHasProblems(report)).toBe(false); // 후보 다수는 문제가 아니다(§30 P2)
    const out = formatDoctorReport(report);
    expect(out).toContain('⚠️ 후보가 2개 있었습니다: "## 핵심 결정 사항", "## 주요 결정"');
    expect(out).toContain("의도한 절이 맞는지 확인하세요.");
  });

  // §30 P2 정상 경로 회귀: 후보가 하나뿐이면(가장 흔한 정상 사용) 경고 줄이 아예 없어야 한다.
  it("§30 P2 회귀: 절 후보가 하나뿐이면 후보 경고를 표시하지 않는다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-plan-onecand-"));
    const state = baseState({ repo_root: dir, verify_default: ["npm test"] });
    saveState(dir, state);
    fs.writeFileSync(
      path.join(dir, "PLAN.md"),
      "## 핵심 결정 사항\n\n| ID | 결정 |\n|----|------|\n| D1 | 유일 결정 |\n",
    );

    const passingGate: Gate = async ({ commands }) => ({
      passed: true,
      results: commands.map(c => ({ command: c, exitCode: 0, signal: null, output: "", fatal: false, timedOut: false })),
    });

    const report = await runDoctor(dir, { git: okGit, gate: passingGate });
    expect(report.planContext.decisionsCandidateCount).toBeUndefined();
    const out = formatDoctorReport(report);
    expect(out).not.toContain("후보가");
  });
});

// §31 후속 — phaseLints 는 verifyCommandsFor(phase.verify 우선) 기준이라, 모든 non-done phase 가
// 자기 verify 를 가지면 verify_default 가 리포트에 아예 안 뜬다. 그런데 assertRunnable 은 §31 I2
// 이후 default 를 항상 린트해 `fw run` 을 거부한다 — 진단이 "문제 없음" 이라 한 뒤 실행이 거부하면
// 사용자는 원인을 찾을 수 없다. doctor 가 같은 기준으로 판정하고 그 사실을 보여줘야 한다.
describe("§31 후속: fw doctor 가 어느 phase 도 쓰지 않는 verify_default 도 검사한다", () => {
  function reportWith(overrides: Partial<DoctorReport>): DoctorReport {
    return {
      workflow: "wf", repoRoot: "/r",
      preflight: { ok: true, problems: [], currentBranch: "main", detached: false, warnings: [], originHost: null },
      stateInvariants: { ok: true, problem: null },
      phaseLints: [], defaultLint: [], defaultUsedByPhase: true, allPhasesDone: false,
      halt: { stopFilePresent: false, stopFileProblem: null, halted: false, haltReason: null, costUsd: 0, maxCostUsd: null, maxRuntimeMs: null },
      planContext: { planFound: false, decisionsHeading: null, glossaryHeading: null, decisionsChars: 0, glossaryChars: 0 },
      runLogsProtection: { status: "ignored", relLogsDir: "docs/wf/logs/", allowUntrackedLogs: false },
      sandbox: { enabled: false, platform: "darwin", platformKnownSupported: true, bwrapCheck: null, networkAllowedDomains: null, originHostAutoAdded: null, filesystemDisabled: false, wildcardNetworkDomains: [] },
      runs: null,
      ...overrides,
    };
  }

  it("default 에 error 가 있으면 phase 린트가 깨끗해도 문제로 판정한다 (fw run 과 같은 기준)", () => {
    const report = reportWith({
      defaultLint: [{ command: "npm test || true", severity: "error", reason: "무력화" }],
      defaultUsedByPhase: false,
    });
    expect(doctorHasProblems(report)).toBe(true);
    const out = formatDoctorReport(report);
    expect(out).toContain("verify_default");
    expect(out).toContain("어느 phase 도 쓰지 않지만");  // 왜 막히는지 설명이 함께 나온다
    expect(out).toContain("npm test || true");
    expect(out).not.toContain("[검증 명령 정적 검사]\n  OK");  // OK 라고 하지 않는다
  });

  it("default 가 실제로 쓰이는 경우에는 그 사실을 부연하지 않는다", () => {
    const out = formatDoctorReport(reportWith({
      defaultLint: [{ command: "npm test | cat", severity: "error", reason: "파이프 종단" }],
      defaultUsedByPhase: true,
    }));
    expect(out).toContain("verify_default (공용)");
    expect(out).not.toContain("어느 phase 도 쓰지 않지만");
  });

  it("default 에 warn 만 있으면 문제로 치지 않되 표시는 한다", () => {
    const report = reportWith({
      defaultLint: [{ command: "pytest -q | tail -20", severity: "warn", reason: "파이프" }],
    });
    expect(doctorHasProblems(report)).toBe(false);
    expect(formatDoctorReport(report)).toContain("! WARN");
  });

  it("default 가 깨끗하면 기존처럼 OK 만 나온다 (회귀)", () => {
    const out = formatDoctorReport(reportWith({}));
    expect(out).toContain("[검증 명령 정적 검사]");
    expect(out).not.toContain("verify_default");
  });

  // §32 I-4: assertRunnable(state.ts) 은 이제 전 phase 가 done 이면 verify_default 린트를
  // 건너뛴다(실행될 명령이 없으므로) — doctor 가 여전히 무조건 exit 1 을 내면 "fw run 은 이제
  // 통과하는데 doctor 는 문제 있다고 한다"는 새 어긋남이 생긴다. doctor 도 같은 예외를 둬야 한다.
  describe("§32 I-4: 전 phase 가 done 이면 default 의 error 를 문제로 치지 않는다", () => {
    it("allPhasesDone:true + default error → 문제로 치지 않는다 (fw run 과 같은 기준)", () => {
      const report = reportWith({
        defaultLint: [{ command: "npm test || true", severity: "error", reason: "무력화" }],
        defaultUsedByPhase: false,
        allPhasesDone: true,
      });
      expect(doctorHasProblems(report)).toBe(false);
    });

    it("리포트 문구도 '더는 검사하지 않는다'로 바뀐다 (allPhasesDone:false 문구와 구분)", () => {
      const out = formatDoctorReport(reportWith({
        defaultLint: [{ command: "npm test || true", severity: "error", reason: "무력화" }],
        defaultUsedByPhase: false,
        allPhasesDone: true,
      }));
      expect(out).toContain("verify_default");
      expect(out).toContain("검사하지 않는다");
      expect(out).not.toContain("어느 phase 도 쓰지 않지만"); // allPhasesDone:false 전용 문구가 아니다
    });

    it("allPhasesDone:false 면 종전처럼 문제로 친다 (회귀 — 전면 무력화가 아님)", () => {
      const report = reportWith({
        defaultLint: [{ command: "npm test || true", severity: "error", reason: "무력화" }],
        defaultUsedByPhase: false,
        allPhasesDone: false,
      });
      expect(doctorHasProblems(report)).toBe(true);
    });
  });
});

// §32 SURVIVED M60 — doctor.ts 의 defaultUsedByPhase 는 `status !== "done" && verify.length === 0`
// 기준이다. `status !== "done"` 을 빼는 mutation 이 §31 후속 수정 이후 테스트 0 개로 생존했다
// (감사 보고 SURVIVED 12건 중 하나). 실제 runDoctor 계산 결과로 이 조건이 살아있는지 직접 검증한다
// (기존 테스트는 전부 reportWith 로 값을 손으로 넣어 계산 로직 자체를 통과하지 않았다).
describe("§32 SURVIVED M60: defaultUsedByPhase 는 done phase 를 '사용'으로 세지 않는다", () => {
  it("done phase 의 빈 verify 는 default 사용으로 잡지 않는다 (status !== \"done\" 이 없으면 오탐)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-m60-"));
    const state = baseState({
      repo_root: dir,
      verify_default: ["npm test"],
      phases: [
        { id: 1, title: "p1(done, 빈 verify)", status: "done", depends_on: [], verify: [], next_steps: [], attempts: 1, max_attempts: 2, allow_verify_file_changes: false, allow_claude_md_changes: false, sessions: [] },
        { id: 2, title: "p2(pending, 자기 verify 보유)", status: "pending", depends_on: [], verify: ["./gradlew build"], next_steps: [], attempts: 0, max_attempts: 2, allow_verify_file_changes: false, allow_claude_md_changes: false, sessions: [] },
      ],
    });
    saveState(dir, state);

    const report = await runDoctor(dir, { git: okGit, run: false });
    // mutant(status !== "done" 제거)라면 phase 1(빈 verify)이 "default 를 쓴다"로 잡혀 true 가
    // 된다 — 실제로는 done 이라 다시 실행되지 않으므로 false 여야 한다.
    expect(report.defaultUsedByPhase).toBe(false);
  });

  it("반대로 non-done phase 의 빈 verify 는 여전히 default 사용으로 잡는다 (전면 무력화 아님)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-doctor-m60-"));
    const state = baseState({
      repo_root: dir,
      verify_default: ["npm test"],
      phases: [
        { id: 1, title: "p1(pending, 빈 verify → default 사용)", status: "pending", depends_on: [], verify: [], next_steps: [], attempts: 0, max_attempts: 2, allow_verify_file_changes: false, allow_claude_md_changes: false, sessions: [] },
      ],
    });
    saveState(dir, state);

    const report = await runDoctor(dir, { git: okGit, run: false });
    expect(report.defaultUsedByPhase).toBe(true);
  });
});

// ── pr-slicing Phase 5: 조각 분해 진단 ──────────────────────────────────────
// 새 기능은 관측 창구가 있어야 한다(§30 P4). 왜 안 쪼개졌는지, 통합 브랜치가 무엇인지,
// base 브랜치가 리포 관례와 어긋나지 않는지를 사람이 볼 수 있어야 한다.
describe("buildReviewSplitDiagnostics", () => {
  function st(over: Partial<State> = {}, phases?: unknown): State {
    return StateSchema.parse({
      schema_version: 1, workflow: "wf", repo_root: "/tmp/r", branch_strategy: "isolate",
      allow_push: false, verify_default: ["npm test"], status: "running",
      pending_question: null, answers: [],
      phases: phases ?? [
        { id: 1, title: "p1", status: "pending", depends_on: [], verify: [], attempts: 0, max_attempts: 2, sessions: [] },
      ],
      ...over,
    });
  }

  it("꺼져 있으면 그 사실만 보고한다", () => {
    const d = buildReviewSplitDiagnostics(st(), null);
    expect(d.enabled).toBe(false);
    expect(d.budgetLines).toBeNull();
  });

  it("켜져 있으면 예산과 통합 브랜치를 보고한다", () => {
    const d = buildReviewSplitDiagnostics(
      st({ review_split: { enabled: true, budget_lines: 400 }, integration_branch: "feature/wf" }),
      null,
    );
    expect(d.enabled).toBe(true);
    expect(d.budgetLines).toBe(400);
    expect(d.integrationBranch).toBe("feature/wf");
  });

  it("조각 그룹을 원본 phase 별로 묶어 진행률을 센다", () => {
    const phases = [
      { id: 5, title: "A", status: "done", depends_on: [], verify: [], attempts: 0, max_attempts: 2, sessions: [], split_group: { origin_id: 3, index: 1, total: 3 } },
      { id: 6, title: "B", status: "done", depends_on: [5], verify: [], attempts: 0, max_attempts: 2, sessions: [], split_group: { origin_id: 3, index: 2, total: 3 } },
      { id: 3, title: "C", status: "pending", depends_on: [6], verify: [], attempts: 0, max_attempts: 2, sessions: [], split_group: { origin_id: 3, index: 3, total: 3 } },
    ];
    const d = buildReviewSplitDiagnostics(st({ review_split: { enabled: true, budget_lines: 400 } }, phases), null);
    expect(d.sliceGroups).toEqual([{ originId: 3, total: 3, doneCount: 2 }]);
  });

  it("분해를 건너뛴 phase 와 이유를 보고한다 (왜 안 쪼개졌는지가 정보다)", () => {
    const phases = [
      { id: 1, title: "p1", status: "pending", depends_on: [], verify: [], attempts: 0, max_attempts: 2, sessions: [], decompose_skipped_reason: "조각 1개를 반환했습니다" },
    ];
    const d = buildReviewSplitDiagnostics(st({ review_split: { enabled: true, budget_lines: 400 } }, phases), null);
    expect(d.skipped).toEqual([{ phaseId: 1, reason: "조각 1개를 반환했습니다" }]);
  });

  it("base 브랜치가 감지 결과와 다르면 알린다 (경고 — 의도적일 수 있다)", () => {
    const d = buildReviewSplitDiagnostics(
      st({ base_branch: "main" }),
      { branch: "develop", source: "develop", reason: "로컬에 develop 이 있어 git flow 로 판단" },
    );
    expect(d.baseBranchMismatch).toEqual({
      configured: "main", detected: "develop", reason: "로컬에 develop 이 있어 git flow 로 판단",
    });
  });

  it("base 브랜치가 감지 결과와 같으면 알리지 않는다", () => {
    const d = buildReviewSplitDiagnostics(
      st({ base_branch: "develop" }),
      { branch: "develop", source: "develop", reason: "r" },
    );
    expect(d.baseBranchMismatch).toBeNull();
  });

  it("감지를 못 했으면(폴백) 불일치로 보고하지 않는다 — 감지 실패를 관례 위반으로 오인하지 않는다", () => {
    const d = buildReviewSplitDiagnostics(
      st({ base_branch: "main" }),
      { branch: "main", source: "fallback", fallbackReason: "not-a-repo", reason: "r" },
    );
    expect(d.baseBranchMismatch).toBeNull();
  });

  it("통합 PR 이 있으면 URL 을 보고한다", () => {
    const d = buildReviewSplitDiagnostics(
      st({ integration_pr: { number: 9, url: "https://ex/pull/9", head_branch: "feature/wf" } }),
      null,
    );
    expect(d.integrationPrUrl).toBe("https://ex/pull/9");
  });
});

describe("formatDoctorReport — 조각 분해 절 (pr-slicing Phase 5)", () => {
  function baseReport(reviewSplit?: DoctorReport["reviewSplit"]): DoctorReport {
    return {
      workflow: "wf", repoRoot: "/tmp/r",
      preflight: { ok: true, problems: [], currentBranch: "feature/wf", detached: false, warnings: [], originHost: null },
      stateInvariants: { ok: true, problem: null },
      phaseLints: [], defaultLint: [], defaultUsedByPhase: true, allPhasesDone: false,
      runs: null,
      halt: { stopFilePresent: false, costUsd: 0, maxCostUsd: null, maxRuntimeMs: null, status: "running", haltReason: null },
      planContext: { planFound: false, decisionsHeading: null, glossaryHeading: null, decisionsChars: 0, glossaryChars: 0 },
      runLogsProtection: { status: "ignored", relLogsDir: "docs/wf/logs", allowUntrackedLogs: false, suggestion: null },
      sandbox: { enabled: false, platform: "darwin", platformSupported: true, neutralized: false, notes: [] },
      reviewSplit,
    } as unknown as DoctorReport;
  }

  it("조각 분해가 꺼져 있으면 꺼졌다고 보여준다", () => {
    const out = formatDoctorReport(baseReport({
      enabled: false, budgetLines: null, integrationBranch: null,
      sliceGroups: [], skipped: [], baseBranchMismatch: null, integrationPrUrl: null,
    }));
    expect(out).toContain("[조각 분해]");
    expect(out).toMatch(/비활성|꺼/);
  });

  it("켜져 있으면 예산과 통합 브랜치를 보여준다", () => {
    const out = formatDoctorReport(baseReport({
      enabled: true, budgetLines: 400, integrationBranch: "feature/wf",
      sliceGroups: [], skipped: [], baseBranchMismatch: null, integrationPrUrl: null,
    }));
    expect(out).toContain("400");
    expect(out).toContain("feature/wf");
  });

  it("조각 그룹 진행률과 건너뛴 이유를 보여준다", () => {
    const out = formatDoctorReport(baseReport({
      enabled: true, budgetLines: 400, integrationBranch: "feature/wf",
      sliceGroups: [{ originId: 3, total: 3, doneCount: 2 }],
      skipped: [{ phaseId: 1, reason: "조각 1개를 반환했습니다" }],
      baseBranchMismatch: null, integrationPrUrl: null,
    }));
    expect(out).toContain("2/3");
    expect(out).toContain("조각 1개를 반환했습니다");
  });

  it("base 브랜치 불일치를 경고로 보여준다", () => {
    const out = formatDoctorReport(baseReport({
      enabled: true, budgetLines: 400, integrationBranch: "feature/wf",
      sliceGroups: [], skipped: [],
      baseBranchMismatch: { configured: "main", detected: "develop", reason: "로컬에 develop 이 있음" },
      integrationPrUrl: null,
    }));
    expect(out).toContain("develop");
    expect(out).toContain("main");
  });

  it("통합 PR URL 을 보여준다", () => {
    const out = formatDoctorReport(baseReport({
      enabled: true, budgetLines: 400, integrationBranch: "feature/wf",
      sliceGroups: [], skipped: [], baseBranchMismatch: null,
      integrationPrUrl: "https://ex/pull/9",
    }));
    expect(out).toContain("https://ex/pull/9");
  });

  it("reviewSplit 이 없는(구버전) 보고서에도 동작한다", () => {
    expect(() => formatDoctorReport(baseReport(undefined))).not.toThrow();
  });
});

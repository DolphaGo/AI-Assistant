import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkHaltpoint } from "../src/halt.js";
import { StateSchema, loadState, saveState, type State } from "../src/state.js";
import { stopFilePath } from "../src/stop.js";
import type { OrchestratorDeps } from "../src/orchestrator-types.js";

// §32 I-5: checkHaltpoint(halt.ts)는 세 체크포인트가 공유하는 정지 판정 헬퍼다. 이 테스트는
// halt.ts 만을 대상으로 한다 — orchestrator.ts/prloop.ts(다른 소유)의 배선 자체는 orchestrator.test.ts
// 가 이미 덮는다. 여기서는 감사자가 지적한 두 가지를 직접 검증한다:
//   1. STOP 이 정상 파일이면 halt_reason 이 정확히 "operator" 로 남는다(§30 P2 회귀 —
//      orchestrator.test.ts 의 `toBe("operator")` 와 같은 계약, 문자열을 바꾸면 그 테스트가 깨진다).
//   2. STOP 이 비정상(디렉토리 등)이면 halt_reason 에 그 사실이 담기고, 안내 문구도 사유별로
//      갈린다(비용 상한은 "재실행해도 다시 정지", STOP 비정상도 "재실행해도 다시 정지",
//      operator 정상/시간 상한은 기존 "재개하려면 다시 실행하세요").

function baseState(overrides: Partial<State> = {}): State {
  return StateSchema.parse({
    schema_version: 1,
    workflow: "wf",
    repo_root: "/tmp/does-not-matter",
    branch_strategy: "isolate",
    allow_push: false,
    verify_default: ["npm test"],
    status: "running",
    pending_question: null,
    answers: [],
    phases: [
      { id: 1, title: "phase one", status: "in_progress", depends_on: [], verify: ["npm test"], attempts: 0, max_attempts: 2, sessions: [] },
    ],
    ...overrides,
  });
}

function makeDeps(overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps & { logs: string[]; notifications: Array<{ title: string; message: string }> } {
  const logs: string[] = [];
  const notifications: Array<{ title: string; message: string }> = [];
  return {
    runner: {
      async runPhase() { throw new Error("checkHaltpoint 테스트는 세션을 실행하지 않는다"); },
      async runVerifyAgent() { throw new Error("checkHaltpoint 테스트는 세션을 실행하지 않는다"); },
      async runFixSession() { throw new Error("checkHaltpoint 테스트는 세션을 실행하지 않는다"); },
    },
    gate: async () => ({ passed: true, results: [] }),
    notify: (title: string, message: string) => { notifications.push({ title, message }); },
    now: () => "2026-08-28T00:00:00.000Z",
    log: (msg: string) => logs.push(msg),
    logs,
    notifications,
    ...overrides,
  };
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-halt-"));
});

describe("checkHaltpoint — §30 P2 정상 경로", () => {
  it("STOP 없음 + 상한 미설정이면 정지하지 않는다 (false)", () => {
    const state = baseState();
    saveState(dir, state);
    const deps = makeDeps();
    expect(checkHaltpoint(dir, state, deps, "2026-08-28T00:00:00.000Z")).toBe(false);
    expect(loadState(dir).status).toBe("running");
  });
});

describe("checkHaltpoint — operator(STOP): 정상 파일은 halt_reason 이 정확히 'operator' 다 (회귀)", () => {
  it("STOP 이 일반 파일이면 halt_reason === 'operator' (orchestrator.test.ts 의 toBe 계약 유지)", () => {
    const state = baseState();
    saveState(dir, state);
    fs.writeFileSync(stopFilePath(dir), "2026-08-28T00:00:00Z\n");
    const deps = makeDeps();

    const halted = checkHaltpoint(dir, state, deps, "2026-08-28T00:00:00.000Z");

    expect(halted).toBe(true);
    expect(state.status).toBe("halted");
    expect(state.halt_reason).toBe("operator"); // 정확히 이 문자열이어야 한다 — 확장하면 안 됨
    expect(deps.logs.some(l => l.includes("재개하려면 `fw run` 을 다시 실행하세요"))).toBe(true);
    // 체크포인트는 STOP 을 소비(삭제)하지 않는다 — 그건 fw run 시작 시점의 몫이다.
    expect(fs.existsSync(stopFilePath(dir))).toBe(true);
  });
});

describe("checkHaltpoint — §32 I-5: STOP 이 비정상(mkdir STOP)이면 halt_reason 에 사유가 담긴다", () => {
  it("STOP 이 디렉토리면 halt_reason 이 'operator' 를 확장해 삭제 실패 사유를 포함한다", () => {
    const state = baseState();
    saveState(dir, state);
    fs.mkdirSync(stopFilePath(dir));
    const deps = makeDeps();

    const halted = checkHaltpoint(dir, state, deps, "2026-08-28T00:00:00.000Z");

    expect(halted).toBe(true);
    expect(state.halt_reason).not.toBeNull();
    expect(state.halt_reason).toMatch(/^operator \(/); // "operator" 단독이 아니라 확장된 형태
    expect(state.halt_reason).toContain("STOP 파일 삭제 실패");
    // 감사자가 지적한 안내 반전 — "재실행하세요"만 말하지 않고 같은 사유로 다시 정지함을 알린다
    expect(deps.logs.some(l => l.includes("재실행해도 같은 사유로 다시 정지합니다"))).toBe(true);
    expect(deps.logs.some(l => l.includes("재개하려면 `fw run` 을 다시 실행하세요"))).toBe(false);

    fs.rmdirSync(stopFilePath(dir));
  });
});

describe("checkHaltpoint — §32 I-5: 비용 상한 안내가 '재실행해도 다시 정지'로 바뀐다", () => {
  it("비용 상한 초과 시 재실행 안내가 아니라 '재실행해도 즉시 다시 정지' 안내를 남긴다", () => {
    const state = baseState({
      max_cost_usd: 1,
      phases: [{
        id: 1, title: "p1", status: "in_progress", depends_on: [], verify: ["npm test"], next_steps: [],
        attempts: 0, max_attempts: 2, allow_verify_file_changes: false, allow_claude_md_changes: false,
        sessions: [{ session_id: "s1", result: "done", at: "t", kind: "phase", cost_usd: 5 }],
      }],
    });
    saveState(dir, state);
    const deps = makeDeps();

    const halted = checkHaltpoint(dir, state, deps, "2026-08-28T00:00:00.000Z");

    expect(halted).toBe(true);
    expect(state.halt_reason).toContain("비용 상한 초과");
    expect(deps.logs.some(l => l.includes("재실행해도 즉시 다시 정지합니다"))).toBe(true);
    expect(deps.logs.some(l => l.includes("max_cost_usd"))).toBe(true);
    // 사실과 반대되는 옛 안내가 이 사유에는 더는 붙지 않는다
    expect(deps.logs.some(l => l.includes("재개하려면 `fw run` 을 다시 실행하세요"))).toBe(false);
  });
});

describe("checkHaltpoint — §32 I-5: 시간 상한은 기존 '재개하려면 다시 실행' 안내를 유지한다 (재실행하면 실제로 재개된다)", () => {
  it("시간 상한 초과 시 기존 안내를 그대로 유지한다 (회귀)", () => {
    const state = baseState({ max_runtime_ms: 1000 });
    saveState(dir, state);
    const deps = makeDeps({ now: () => "2026-08-28T00:00:05.000Z" }); // 5초 경과 > 1000ms

    const halted = checkHaltpoint(dir, state, deps, "2026-08-28T00:00:00.000Z");

    expect(halted).toBe(true);
    expect(state.halt_reason).toContain("시간 상한 초과");
    expect(deps.logs.some(l => l.includes("재개하려면 `fw run` 을 다시 실행하세요"))).toBe(true);
  });
});

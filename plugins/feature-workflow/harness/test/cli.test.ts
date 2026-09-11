import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  formatStatus, initState, formatLockWarning, formatStopMessage, totalCostUsd,
  buildDecisionCellText, appendAnswerDecision, formatPlanAnswerMessage, program, resolveWorkflowDir,
} from "../src/cli.js";
import { StateSchema, loadState, saveState, formatCostLine } from "../src/state.js";
import { execFileSync } from "node:child_process";

describe("formatStatus", () => {
  it("상태·phase 표·질문을 출력한다", () => {
    const s = StateSchema.parse({
      schema_version: 1, workflow: "wf", repo_root: "/r", branch_strategy: "topic",
      allow_push: false, verify_default: [], status: "blocked",
      pending_question: { phase: 1, question: "A or B?", asked_at: "t" },
      answers: [],
      phases: [{ id: 1, title: "p1", status: "blocked", depends_on: [], verify: [], attempts: 1, max_attempts: 2, sessions: [] }],
    });
    const out = formatStatus(s);
    expect(out).toContain("blocked");
    expect(out).toContain("p1");
    expect(out).toContain("A or B?");
  });

  // pr-slicing: split_group 이 있는 phase 는 "몇 번째 조각인지" 를 phase 줄에 보여준다.
  it("pr-slicing: split_group 이 있으면 '(조각 N/M)' 을 phase 줄에 보여준다", () => {
    const s = StateSchema.parse({
      schema_version: 1, workflow: "wf", repo_root: "/r", branch_strategy: "topic",
      allow_push: false, verify_default: [], status: "blocked",
      pending_question: { phase: 1, question: "A or B?", asked_at: "t" },
      answers: [],
      phases: [{
        id: 1, title: "p1", status: "blocked", depends_on: [], verify: [], attempts: 1, max_attempts: 2,
        sessions: [], split_group: { origin_id: 1, index: 1, total: 3 },
      }],
    });
    expect(formatStatus(s)).toContain("(조각 1/3)");
  });

  // §30 P2 — split_group 이 없는(도입 전과 동일한) STATE 는 출력이 한 글자도 바뀌지 않아야
  // 한다(PLAN §검증 기준 2). 위 첫 번째 테스트와 같은 fixture 로 그 불변을 못박는다.
  it("pr-slicing: split_group 이 없으면 phase 줄이 도입 전과 동일하다 (회귀 고정)", () => {
    const s = StateSchema.parse({
      schema_version: 1, workflow: "wf", repo_root: "/r", branch_strategy: "topic",
      allow_push: false, verify_default: [], status: "blocked",
      pending_question: { phase: 1, question: "A or B?", asked_at: "t" },
      answers: [],
      phases: [{ id: 1, title: "p1", status: "blocked", depends_on: [], verify: [], attempts: 1, max_attempts: 2, sessions: [] }],
    });
    const out = formatStatus(s);
    expect(out).toContain("Phase 1: p1 (시도 1/2)");
    expect(out).not.toContain("조각");
  });

  // pr-slicing: integration_pr 이 있으면 상단 요약에 통합 PR 줄(번호+URL)을 보여준다.
  it("pr-slicing: integration_pr 이 있으면 상단 요약에 통합 PR 줄을 보여준다", () => {
    const s = StateSchema.parse({
      schema_version: 1, workflow: "wf", repo_root: "/r", branch_strategy: "topic",
      allow_push: false, verify_default: [], status: "running",
      pending_question: null, answers: [], phases: [],
      integration_pr: { number: 7, url: "https://github.com/.../7", head_branch: "feature/slice-smoke" },
    });
    const out = formatStatus(s);
    expect(out).toContain("https://github.com/.../7");
    expect(out).toContain("통합 PR: #7");
  });

  // §30 P2 — integration_pr 이 없는(도입 전과 동일한) STATE 는 "통합 PR" 문구가 전혀 나오지
  // 않아야 한다(PLAN §검증 기준 3). 기존 fixture 로 그 불변을 못박는다.
  it("pr-slicing: integration_pr 이 없으면 '통합 PR' 문구가 나오지 않는다 (회귀 고정)", () => {
    const s = StateSchema.parse({
      schema_version: 1, workflow: "wf", repo_root: "/r", branch_strategy: "topic",
      allow_push: false, verify_default: [], status: "blocked",
      pending_question: { phase: 1, question: "A or B?", asked_at: "t" },
      answers: [],
      phases: [{ id: 1, title: "p1", status: "blocked", depends_on: [], verify: [], attempts: 1, max_attempts: 2, sessions: [] }],
    });
    const out = formatStatus(s);
    expect(out).not.toContain("통합 PR");
  });

  // §37 T1/S3/§30 P4 — 샌드박스가 켜졌는지가 `fw status` 에서도 보여야 한다(§36 I-3 이 이미
  // 겪은 부채 재발 방지). 기본(sandbox 미설정)은 "비활성"이다.
  it("§37 T1: sandbox 미설정이면 '비활성' 을 보여준다 (기본, §30 P2 회귀)", () => {
    const s = StateSchema.parse({
      schema_version: 1, workflow: "wf", repo_root: "/r", branch_strategy: "topic",
      allow_push: false, verify_default: [], status: "running",
      pending_question: null, answers: [], phases: [],
    });
    expect(formatStatus(s)).toContain("샌드박스: 비활성");
  });

  it("§37 T1: sandbox.enabled:true 면 '활성' 을 보여준다", () => {
    const s = StateSchema.parse({
      schema_version: 1, workflow: "wf", repo_root: "/r", branch_strategy: "topic",
      allow_push: false, verify_default: [], status: "running",
      pending_question: null, answers: [], phases: [],
      sandbox: { enabled: true },
    });
    expect(formatStatus(s)).toContain("샌드박스: 활성");
  });

  // §41 C-3/§30 P1 — `fw doctor` 의 [샌드박스] 절과 같은 판정을 `fw status` 도 써야 한다. 두
  // 표시면이 "활성" 만 말하고 무력화 여부에서 갈리면 §30 P1 재발이다.
  describe("§41 C-3: 무력화 신호가 있으면 '활성' 한 마디로 뭉개지 않는다", () => {
    it("filesystem.disabled:true 면 '활성' 뒤에 무력화 경고가 붙는다", () => {
      const s = StateSchema.parse({
        schema_version: 1, workflow: "wf", repo_root: "/r", branch_strategy: "topic",
        allow_push: false, verify_default: [], status: "running",
        pending_question: null, answers: [], phases: [],
        sandbox: { enabled: true, filesystem: { disabled: true } },
      });
      const out = formatStatus(s);
      expect(out).toContain("샌드박스: 활성 (⚠");
      expect(out).toContain("파일시스템 격리 꺼짐");
    });

    it("네트워크 allowedDomains 와일드카드(*)면 '활성' 뒤에 무력화 경고가 붙는다", () => {
      const s = StateSchema.parse({
        schema_version: 1, workflow: "wf", repo_root: "/r", branch_strategy: "topic",
        allow_push: false, verify_default: [], status: "running",
        pending_question: null, answers: [], phases: [],
        sandbox: { enabled: true, network: { allowedDomains: ["*"] } },
      });
      const out = formatStatus(s);
      expect(out).toContain("샌드박스: 활성 (⚠");
      expect(out).toContain("와일드카드");
    });

    // §30 P2 회귀 — 무력화 신호가 없으면 기존처럼 "활성" 만 나오고 괄호 경고가 붙지 않는다.
    it("§30 P2 회귀: 무력화 신호가 없으면 괄호 경고 없이 '활성' 만 보여준다", () => {
      const s = StateSchema.parse({
        schema_version: 1, workflow: "wf", repo_root: "/r", branch_strategy: "topic",
        allow_push: false, verify_default: [], status: "running",
        pending_question: null, answers: [], phases: [],
        sandbox: { enabled: true },
      });
      const out = formatStatus(s);
      expect(out).toContain("샌드박스: 활성");
      expect(out).not.toContain("⚠");
    });
  });

  it("failed phase 에 last_log 가 있으면 로그 경로를 함께 보여준다", () => {
    const s = StateSchema.parse({
      schema_version: 1, workflow: "wf", repo_root: "/r", branch_strategy: "topic",
      allow_push: false, verify_default: [], status: "failed",
      pending_question: null,
      answers: [],
      phases: [{
        id: 2, title: "p2", status: "failed", depends_on: [], verify: [],
        attempts: 2, max_attempts: 2, sessions: [],
        last_log: "/tmp/wf/logs/phase-2-attempt-2.log",
      }],
    });
    const out = formatStatus(s);
    expect(out).toContain("로그: /tmp/wf/logs/phase-2-attempt-2.log");
  });
});

// §36 §30 P4 후속 — 세션의 자기 주장(result) 옆에 하네스가 실제로 내린 판정(bounced 건수)도
// 간단히 보여준다. verdict 데이터가 없는(§36 이전) 기존 STATE.json 에 대해서는 출력이 이전과
// 완전히 동일해야 한다(§30 P2 회귀 방지).
describe("formatStatus — §36 §30 P4: 시도 옆 회송 표시", () => {
  function phaseWithSessions(sessions: Array<Record<string, unknown>>) {
    return StateSchema.parse({
      schema_version: 1, workflow: "wf", repo_root: "/r", branch_strategy: "topic",
      allow_push: false, verify_default: [], status: "running",
      pending_question: null, answers: [],
      phases: [{ id: 1, title: "p1", status: "in_progress", depends_on: [], verify: [], attempts: 2, max_attempts: 5, sessions }],
    });
  }

  it("verdict 가 없는(레거시) 세션만 있으면 회송 표시를 하지 않는다 (§30 P2 회귀 — 기존 출력과 동일)", () => {
    const s = phaseWithSessions([
      { session_id: "s1", result: "done", at: "t1", kind: "phase" },
    ]);
    const out = formatStatus(s);
    expect(out).toContain("(시도 2/5)");
    expect(out).not.toContain("회송");
  });

  it("verdict.outcome:accepted 뿐이면 회송 표시를 하지 않는다 (bounced 가 없다)", () => {
    const s = phaseWithSessions([
      { session_id: "s1", result: "done", at: "t1", kind: "phase", verdict: { outcome: "accepted" } },
    ]);
    expect(formatStatus(s)).not.toContain("회송");
  });

  it("bounced 세션이 있으면 시도 옆에 회송 건수를 보여준다", () => {
    const s = phaseWithSessions([
      { session_id: "s1", result: "done", at: "t1", kind: "phase", verdict: { outcome: "bounced", reason: "gate_failed" } },
      { session_id: "s2", result: "done", at: "t2", kind: "phase", verdict: { outcome: "bounced", reason: "no_commits" } },
      { session_id: "s3", result: "done", at: "t3", kind: "phase", verdict: { outcome: "accepted" } },
    ]);
    const out = formatStatus(s);
    expect(out).toContain("(시도 2/5, 회송 2)");
  });
});

describe("formatStatus — PR 정보 (v2)", () => {
  it("in_review phase 의 PR 번호·URL 을 보여준다", () => {
    const s = StateSchema.parse({
      schema_version: 1, workflow: "wf", repo_root: "/r", branch_strategy: "topic",
      allow_push: true, pr_mode: true, verify_default: ["npm test"], status: "awaiting_merge",
      pending_question: null, answers: [],
      phases: [{
        id: 1, title: "p1", status: "in_review", depends_on: [], verify: [],
        attempts: 1, max_attempts: 2, sessions: [],
        pr: { number: 42, url: "https://ex/pull/42", head_branch: "fw/phase-1", handled_comment_keys: ["issue:7"] },
      }],
    });
    const out = formatStatus(s);
    expect(out).toContain("awaiting_merge");
    expect(out).toContain("#42");
    expect(out).toContain("https://ex/pull/42");
  });

  it("PR 이 없는 phase 는 PR 줄을 출력하지 않는다", () => {
    const s = StateSchema.parse({
      schema_version: 1, workflow: "wf", repo_root: "/r", branch_strategy: "topic",
      allow_push: false, verify_default: ["npm test"], status: "running",
      pending_question: null, answers: [],
      phases: [{ id: 1, title: "p1", status: "pending", depends_on: [], verify: [], attempts: 0, max_attempts: 2, sessions: [] }],
    });
    expect(formatStatus(s)).not.toContain("PR");
  });
});

describe("formatStatus / totalCostUsd — 비용 관측 (§25 과제3)", () => {
  const withSessions = (sessions: Array<{ cost_usd?: number; kind?: "phase" | "fix" | "verify" }>) =>
    StateSchema.parse({
      schema_version: 1, workflow: "wf", repo_root: "/r", branch_strategy: "topic",
      allow_push: false, verify_default: ["npm test"], status: "running",
      pending_question: null, answers: [],
      phases: [
        {
          id: 1, title: "p1", status: "in_progress", depends_on: [], verify: [],
          attempts: 1, max_attempts: 2,
          sessions: sessions.map((s, i) => ({
            session_id: `s${i}`, result: "done", at: "t", kind: s.kind ?? "phase", cost_usd: s.cost_usd,
          })),
        },
      ],
    });

  it("totalCostUsd 는 모든 phase 의 sessions cost_usd 를 합산한다 (kind 무관)", () => {
    const s = withSessions([{ cost_usd: 1.2 }, { cost_usd: 0.35, kind: "fix" }, { cost_usd: undefined }]);
    expect(totalCostUsd(s)).toBeCloseTo(1.55);
  });

  it("cost_usd 가 전혀 없으면 0 이다", () => {
    const s = withSessions([{ cost_usd: undefined }]);
    expect(totalCostUsd(s)).toBe(0);
  });

  it("formatStatus 는 워크플로우 총 비용 한 줄을 포함한다", () => {
    const s = withSessions([{ cost_usd: 2.5 }, { cost_usd: 0.5, kind: "fix" }]);
    expect(formatStatus(s)).toContain("총 비용: $3.00");
  });

  it("in_review phase 는 last_polled_at 이 있으면 '마지막 폴링' 을 보여준다 (하트비트)", () => {
    const s = StateSchema.parse({
      schema_version: 1, workflow: "wf", repo_root: "/r", branch_strategy: "topic",
      allow_push: true, pr_mode: true, verify_default: ["npm test"], status: "running",
      pending_question: null, answers: [],
      phases: [{
        id: 1, title: "p1", status: "in_review", depends_on: [], verify: [],
        attempts: 1, max_attempts: 2, sessions: [],
        pr: {
          number: 42, url: "https://ex/pull/42", head_branch: "fw/phase-1",
          handled_comment_keys: [], fix_sessions: 0, last_polled_at: "2026-08-27T00:00:00.000Z",
        },
      }],
    });
    expect(formatStatus(s)).toContain("마지막 폴링: 2026-08-27T00:00:00.000Z");
  });

  it("last_polled_at 이 없으면 '마지막 폴링' 줄을 출력하지 않는다", () => {
    const s = StateSchema.parse({
      schema_version: 1, workflow: "wf", repo_root: "/r", branch_strategy: "topic",
      allow_push: true, pr_mode: true, verify_default: ["npm test"], status: "running",
      pending_question: null, answers: [],
      phases: [{
        id: 1, title: "p1", status: "in_review", depends_on: [], verify: [],
        attempts: 1, max_attempts: 2, sessions: [],
        pr: { number: 42, url: "https://ex/pull/42", head_branch: "fw/phase-1", handled_comment_keys: [], fix_sessions: 0 },
      }],
    });
    expect(formatStatus(s)).not.toContain("마지막 폴링");
  });
});

describe("formatStatus — §26 M2: verify_file_changes_bypassed_at 노출", () => {
  it("verify_file_changes_bypassed_at 이 설정돼 있으면 경고 톤으로 표시한다", () => {
    const s = StateSchema.parse({
      schema_version: 1, workflow: "wf", repo_root: "/r", branch_strategy: "topic",
      allow_push: false, verify_default: ["npm test"], status: "running",
      pending_question: null, answers: [],
      phases: [{
        id: 3, title: "p3", status: "in_progress", depends_on: [], verify: [],
        attempts: 1, max_attempts: 2, sessions: [],
        allow_verify_file_changes: true,
        verify_file_changes_bypassed_at: "2026-08-27T01:23:45Z",
      }],
    });
    const out = formatStatus(s);
    expect(out).toContain("⚠️");
    expect(out).toContain("검증 파일 변경 허용됨");
    expect(out).toContain("allow_verify_file_changes");
    expect(out).toContain("2026-08-27T01:23:45Z");
  });

  it("verify_file_changes_bypassed_at 이 없으면 경고를 표시하지 않는다", () => {
    const s = StateSchema.parse({
      schema_version: 1, workflow: "wf", repo_root: "/r", branch_strategy: "topic",
      allow_push: false, verify_default: ["npm test"], status: "running",
      pending_question: null, answers: [],
      phases: [{ id: 1, title: "p1", status: "pending", depends_on: [], verify: [], attempts: 0, max_attempts: 2, sessions: [] }],
    });
    expect(formatStatus(s)).not.toContain("검증 파일 변경 허용됨");
  });
});

describe("§27 O2/O3: formatStatus — halted 표시 + 상한 대비 비용", () => {
  const haltedState = (overrides: Partial<{ halt_reason: string | null; max_cost_usd: number | null }> = {}) =>
    StateSchema.parse({
      schema_version: 1, workflow: "wf", repo_root: "/r", branch_strategy: "topic",
      allow_push: false, verify_default: ["npm test"], status: "halted",
      halt_reason: "비용 상한 초과: $12.40 / $10.00",
      pending_question: null, answers: [],
      phases: [{ id: 1, title: "p1", status: "in_progress", depends_on: [], verify: [], attempts: 1, max_attempts: 2, sessions: [] }],
      ...overrides,
    });

  it("halted 상태는 ⏸ 아이콘과 [halted] 를 표시한다", () => {
    const out = formatStatus(haltedState());
    expect(out).toContain("⏸");
    expect(out).toContain("[halted]");
  });

  it("halt_reason 이 있으면 정지 사유 줄을 보여준다", () => {
    const out = formatStatus(haltedState());
    expect(out).toContain("정지 사유");
    expect(out).toContain("비용 상한 초과: $12.40 / $10.00");
  });

  it("halted 가 아니면 정지 사유 줄을 출력하지 않는다 (§30 P2 정상 경로 회귀 방지)", () => {
    const s = StateSchema.parse({
      schema_version: 1, workflow: "wf", repo_root: "/r", branch_strategy: "topic",
      allow_push: false, verify_default: ["npm test"], status: "running",
      pending_question: null, answers: [],
      phases: [{ id: 1, title: "p1", status: "pending", depends_on: [], verify: [], attempts: 0, max_attempts: 2, sessions: [] }],
    });
    expect(formatStatus(s)).not.toContain("정지 사유");
  });

  it("max_cost_usd 가 설정돼 있으면 '총 비용: $X / $Y' 로 상한 대비를 보여준다", () => {
    const s = StateSchema.parse({
      schema_version: 1, workflow: "wf", repo_root: "/r", branch_strategy: "topic",
      allow_push: false, verify_default: ["npm test"], status: "running", max_cost_usd: 10,
      pending_question: null, answers: [],
      phases: [{
        id: 1, title: "p1", status: "in_progress", depends_on: [], verify: [],
        attempts: 1, max_attempts: 2,
        sessions: [{ session_id: "s1", result: "done", at: "t", kind: "phase", cost_usd: 3.2 }],
      }],
    });
    expect(formatStatus(s)).toContain("총 비용: $3.20 / $10.00");
  });

  it("max_cost_usd 미설정이면 기존처럼 '총 비용: $X' 만 보여준다 (§30 P2)", () => {
    const s = StateSchema.parse({
      schema_version: 1, workflow: "wf", repo_root: "/r", branch_strategy: "topic",
      allow_push: false, verify_default: ["npm test"], status: "running",
      pending_question: null, answers: [],
      phases: [{ id: 1, title: "p1", status: "pending", depends_on: [], verify: [], attempts: 0, max_attempts: 2, sessions: [] }],
    });
    const out = formatStatus(s);
    expect(out).toContain("총 비용: $0.00");
    expect(out).not.toContain("/ $");
  });
});

describe("formatCostLine (§27 O2)", () => {
  it("상한 미설정(null/undefined)이면 '$X' 만 반환한다", () => {
    expect(formatCostLine(3, null)).toBe("총 비용: $3.00");
    expect(formatCostLine(3, undefined)).toBe("총 비용: $3.00");
  });
  it("상한 설정 시 '$X / $Y' 를 반환한다", () => {
    expect(formatCostLine(3.2, 10)).toBe("총 비용: $3.20 / $10.00");
  });
});

describe("formatLockWarning — answer/retry 의 동시 실행 경고 문구 (§17)", () => {
  it("PID 와 시작 시각을 포함한 경고 문구를 만든다", () => {
    const msg = formatLockWarning({ pid: 4242, startedAt: "2026-08-27T00:00:00.000Z" });
    expect(msg).toContain("4242");
    expect(msg).toContain("2026-08-27T00:00:00.000Z");
    expect(msg).toMatch(/실행 중/);
  });
});

describe("formatStopMessage — fw stop 안내 문구 (§27 O3)", () => {
  it("살아있는 fw run 이 있으면 PID/시작 시각과 함께 정지 예고를 보여준다", () => {
    const msg = formatStopMessage({ pid: 4242, startedAt: "2026-08-27T00:00:00.000Z" });
    expect(msg).toContain("4242");
    expect(msg).toContain("2026-08-27T00:00:00.000Z");
    expect(msg).toMatch(/체크포인트/);
  });
  it("살아있는 프로세스가 없으면 그 사실과 다음 fw run 이 소비한다는 안내를 보여준다", () => {
    const msg = formatStopMessage(null);
    expect(msg).toMatch(/감지되지/);
    expect(msg).toMatch(/fw run/);
  });
});

describe("initState", () => {
  it("스켈레톤 STATE.json 을 만든다 (이미 있으면 거부)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-cli-"));
    initState(dir, "/my/repo");
    const s = loadState(dir);
    expect(s.workflow).toBe(path.basename(dir));
    expect(s.repo_root).toBe("/my/repo");
    expect(s.phases).toEqual([]);
    // §27 O2/O3: 새로 만든 워크플로우는 halted 가 아니고 상한도 무제한이어야 한다(기존 동작 유지)
    expect(s.status).toBe("running");
    expect(s.halt_reason).toBeNull();
    expect(s.max_cost_usd).toBeUndefined();
    expect(s.max_runtime_ms).toBeUndefined();
    expect(() => initState(dir, "/my/repo")).toThrow(/이미 존재/);
  });

  // pr-slicing PLAN D15: base_branch 를 "main" 으로 하드코딩하면 git flow 리포에서 PR 이
  // develop 이 아니라 main 으로 간다. detectBaseBranch 결과를 받아 쓸 수 있어야 한다.
  it("base_branch 를 넘기면 그 값으로 만든다 (fw init 이 감지 결과를 넘긴다)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-cli-base-"));
    initState(dir, "/my/repo", "develop");
    expect(loadState(dir).base_branch).toBe("develop");
  });

  it("base_branch 를 생략하면 main 이다 (기존 호출부 하위호환)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-cli-base-default-"));
    initState(dir, "/my/repo");
    expect(loadState(dir).base_branch).toBe("main");
  });
});

describe("buildDecisionCellText — §28 W2", () => {
  it("질문 → 답변 형태로 한 줄로 합친다", () => {
    expect(buildDecisionCellText("A or B?", "A")).toBe("A or B? → A");
  });

  it("긴 질문/답변은 각각 절단한다", () => {
    const longQuestion = "x".repeat(200);
    const longAnswer = "y".repeat(200);
    const cell = buildDecisionCellText(longQuestion, longAnswer);
    expect(cell.length).toBeLessThan(260);
    expect(cell).toContain("…");
  });

  it("개행/여러 공백을 한 줄로 접는다", () => {
    expect(buildDecisionCellText("여러\n줄   질문", "답")).toBe("여러 줄 질문 → 답");
  });
});

describe("appendAnswerDecision / formatPlanAnswerMessage — §28 W2, §30 P2 정상 경로 회귀", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-cli-answer-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("PLAN.md 가 없으면 no-plan-file — fw answer 자체는 여전히 성공(STATE만 기록되는 정상 경로)", () => {
    const outcome = appendAnswerDecision(dir, { phase: 1, question: "A or B?" }, "A", "2026-08-27T00:00:00.000Z");
    expect(outcome).toEqual({ kind: "no-plan-file" });
    expect(formatPlanAnswerMessage(outcome)).toMatch(/PLAN\.md 가 없어/);
  });

  it("PLAN.md 에 §핵심 결정 표가 있으면 D<n> 으로 기록하고 recorded 를 반환한다", () => {
    fs.writeFileSync(
      path.join(dir, "PLAN.md"),
      [
        "## 핵심 결정 사항",
        "| ID | 결정 | 근거 | 상태 | 날짜 |",
        "|----|------|------|------|------|",
        "| D1 | 기존 결정 | 기존 근거 | accepted | 2026-08-26 |",
      ].join("\n"),
    );
    const outcome = appendAnswerDecision(dir, { phase: 3, question: "브랜치 전략은?" }, "isolate", "2026-08-27T00:00:00.000Z");
    expect(outcome).toEqual({ kind: "recorded", id: "D2" });
    expect(formatPlanAnswerMessage(outcome)).toBe("PLAN.md §핵심 결정에 D2 로 기록했습니다");

    const after = fs.readFileSync(path.join(dir, "PLAN.md"), "utf-8");
    expect(after).toContain("| D1 | 기존 결정 | 기존 근거 | accepted | 2026-08-26 |"); // 기존 행 무변경
    expect(after).toContain("브랜치 전략은? → isolate");
    expect(after).toContain("(fw answer 자동 기록)");
    expect(after).toContain("phase 3");
    expect(after).toContain("| accepted | 2026-08-27 |");
  });

  it("표 열 개수가 다르면 table-mismatch — PLAN.md 는 손대지 않는다", () => {
    const original = ["## 핵심 결정 사항", "| ID | 결정 | 상태 |", "|----|------|------|", "| D1 | 옛 형식 | accepted |"].join("\n");
    fs.writeFileSync(path.join(dir, "PLAN.md"), original);
    const outcome = appendAnswerDecision(dir, { phase: 1, question: "Q" }, "A", "2026-08-27T00:00:00.000Z");
    expect(outcome).toEqual({ kind: "table-mismatch" });
    expect(formatPlanAnswerMessage(outcome)).toMatch(/표 형식이 달라/);
    expect(fs.readFileSync(path.join(dir, "PLAN.md"), "utf-8")).toBe(original);
  });

  it("여러 번 호출하면 ID가 증가한다(D2, D3, ...)", () => {
    fs.writeFileSync(
      path.join(dir, "PLAN.md"),
      ["## 핵심 결정 사항", "| ID | 결정 | 근거 | 상태 | 날짜 |", "|----|------|------|------|------|", "| D1 | x | y | accepted | 2026-08-26 |"].join("\n"),
    );
    const first = appendAnswerDecision(dir, { phase: 1, question: "Q1" }, "A1", "2026-08-27T00:00:00.000Z");
    const second = appendAnswerDecision(dir, { phase: 2, question: "Q2" }, "A2", "2026-08-27T00:00:00.000Z");
    expect(first).toEqual({ kind: "recorded", id: "D2" });
    expect(second).toEqual({ kind: "recorded", id: "D3" });
  });
});

// Phase 2(§34 T2) — report.ts(buildReport/formatReport) 자체의 집계 로직은 report.test.ts 가
// 이미 상세히 검증한다. 여기서는 "커맨드 등록"과 "cli.ts 의 얇은 배선"(PLAN D3: loadState →
// buildReport → formatReport → console.log)만 확인한다 — report.ts 내부 계산을 다시 베끼면
// 배선이 아니라 report.test.ts 를 중복 검증하는 것이 된다.
describe("fw report — 커맨드 배선 (§34 T2, PLAN D3)", () => {
  it("program 에 report 커맨드가 log/status 와 함께 등록되어 있다", () => {
    const names = program.commands.map(c => c.name());
    expect(names).toContain("report");
    expect(names).toContain("status");
    expect(names).toContain("log");
  });

  it("report <dir> 는 STATE.json 을 읽어 formatReport 출력을 console.log 로 내보낸다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-cli-report-"));
    try {
      saveState(dir, StateSchema.parse({
        schema_version: 1, workflow: "report-wf", repo_root: "/r", branch_strategy: "isolate",
        allow_push: false, verify_default: ["npm test"], status: "running",
        pending_question: null, answers: [],
        phases: [{
          id: 1, title: "p1", status: "in_progress", depends_on: [], verify: [],
          attempts: 1, max_attempts: 2,
          sessions: [{ session_id: "s1", result: "done", at: "2026-08-28T00:00:00Z", kind: "phase", cost_usd: 1.23 }],
        }],
      }));

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      let calls: unknown[][];
      try {
        await program.parseAsync(["node", "fw", "report", dir]);
        // mockRestore() 는 원래 구현을 되돌리는 것뿐 아니라 mock.calls 기록도 지운다 — restore
        // 전에 먼저 복사해둔다 (그렇지 않으면 항상 빈 배열을 보고 실패한다).
        calls = logSpy.mock.calls.map(c => [...c]);
      } finally {
        logSpy.mockRestore();
      }

      // formatReport 가 실제로 호출됐다는 증거로, buildReport 없이는 만들어지지 않는 값(비용
      // 합산·워크플로우 이름·D1 고정 문구)이 출력에 그대로 나타나는지만 확인한다 — 집계
      // 로직 자체의 옳고 그름은 report.test.ts 몫이다.
      const out = calls.map(c => String(c[0])).join("\n");
      expect(out).toContain("report-wf");
      expect(out).toContain("$1.23");
      expect(out).toContain("판단 재료");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("STATE.json 이 없는 디렉토리를 넘기면 에러 메시지를 출력하고 exit(1) 한다 (log/status 와 동일한 guard 정책)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-cli-report-missing-"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    try {
      await program.parseAsync(["node", "fw", "report", dir]);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// §36 m-5 — cli.ts 의 커맨드 등록 블록(`export let program; { ... }`)은 invokedDirectly 와 무관하게
// import 시점에 항상 실행된다(program 을 테스트에서 import 해 쓸 수 있어야 하므로 — 위 모든 테스트가
// 그 전제 위에 있다). 예전 코드는 그 블록 안에서 `.version(getVersion())` 을 직접 호출했는데,
// getVersion() 은 매 호출마다 fs.readFileSync(package.json) 을 한다(index.ts) — 즉 cli.js 를
// **import 만 해도** package.json 을 읽고, 그 파일이 없는 사본(예: dist 만 복사 배포)에서는
// ENOENT 로 죽는다(감사자 실측). 커밋 메시지·NOTES·VERIFY.md 세 곳 모두 "부작용 없음/순수
// 리팩터링" 이라 적었으나 틀렸다 — 이 테스트가 그 주장을 실측으로 대체한다.
//
// fs.readFileSync 를 직접 스파이하는 대신 index.ts 의 getVersion 자체를 모킹해 호출 횟수를 잰다 —
// index.ts 는 다른 이유(디스크 I/O)로도 readFileSync 를 쓸 수 있으므로, "getVersion 호출 여부"가
// "import 시점 부작용이 사라졌다"는 주장에 더 직접적으로 대응하는 증거다.
describe("cli.ts import 시점 부작용 (§36 m-5)", () => {
  afterEach(() => {
    vi.doUnmock("../src/index.js");
    vi.resetModules();
  });

  it("cli.js 를 import 하는 것만으로는 getVersion() 이 호출되지 않는다", async () => {
    vi.resetModules();
    const getVersionMock = vi.fn(() => "9.9.9-mock");
    vi.doMock("../src/index.js", () => ({ getVersion: getVersionMock }));

    await import("../src/cli.js");

    // §36 이전 코드(`.version(getVersion())`)라면 이 시점에 이미 1회 호출됐어야 한다.
    expect(getVersionMock).not.toHaveBeenCalled();
  });

  it("--version/-V 를 실제로 파싱하는 시점에만 getVersion() 이 호출되고 값이 출력된다", async () => {
    vi.resetModules();
    const getVersionMock = vi.fn(() => "9.9.9-mock");
    vi.doMock("../src/index.js", () => ({ getVersion: getVersionMock }));

    const cliMod = await import("../src/cli.js");
    expect(getVersionMock).not.toHaveBeenCalled(); // import 시점엔 아직 안 불림

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    try {
      await cliMod.program.parseAsync(["node", "fw", "--version"]);
      expect(getVersionMock).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledWith("9.9.9-mock");
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      logSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});

// §69 — `fw run <이름>` 의 docs/ 접두 자동 해석. 사용자는 워크플로우 이름만 치면 되고,
// 경로를 명시하면(구분자/절대경로/명시적 상대) 기존 동작 그대로다(하위호환).
describe("resolveWorkflowDir (§69)", () => {
  let tmp: string;
  let prevCwd: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fw-resolve-"));
    prevCwd = process.cwd();
    process.chdir(tmp);
  });
  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("단독 이름은 docs/<이름> 으로 해석한다", () => {
    // macOS 의 /tmp 는 /private/tmp 심볼릭 링크라 cwd 와 path.resolve 결과가 다를 수 있다 —
    // 기대값도 같은 방식(path.resolve)으로 계산해 비교한다.
    expect(resolveWorkflowDir("writing-training")).toBe(path.resolve("docs", "writing-training"));
  });

  it("현재 디렉토리에 <이름>/STATE.json 이 있으면 그쪽을 우선한다 (docs 안에서 실행하는 경우)", () => {
    fs.mkdirSync(path.join(tmp, "wf"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "wf", "STATE.json"), "{}");
    expect(resolveWorkflowDir("wf")).toBe(path.resolve("wf"));
  });

  it("이름과 같은 디렉토리가 있어도 STATE.json 이 없으면 docs/<이름> 으로 간다 (무관한 소스 폴더에 가로채이지 않음)", () => {
    fs.mkdirSync(path.join(tmp, "wf"), { recursive: true }); // STATE.json 없는 동명 디렉토리
    expect(resolveWorkflowDir("wf")).toBe(path.resolve("docs", "wf"));
  });

  it("경로 구분자가 있으면 기존 그대로 해석한다 (하위호환 — docs 밖 커스텀 위치 포함)", () => {
    expect(resolveWorkflowDir("docs/wf")).toBe(path.resolve("docs/wf"));
    expect(resolveWorkflowDir("./wf")).toBe(path.resolve("wf"));
    expect(resolveWorkflowDir("other/place/wf")).toBe(path.resolve("other/place/wf"));
  });

  it("절대경로와 `.`/`..` 은 기존 그대로 해석한다", () => {
    const abs = path.join(tmp, "somewhere");
    expect(resolveWorkflowDir(abs)).toBe(path.resolve(abs));
    expect(resolveWorkflowDir(".")).toBe(path.resolve("."));
    expect(resolveWorkflowDir("..")).toBe(path.resolve(".."));
  });
});

// 평가 렌즈 검토 확정 결함(상/중): Phase 1 의 유일한 동작 변경인 `fw init` base 감지 배선에
// 테스트가 0건이었다. 뮤테이션 3종(배선 원상복구 / 근거 출력 삭제 / 감지 결과 무시)이 모두
// 생존해, "기존 테스트 전부 통과" 가 D15 의 검증 근거가 될 수 없는 상태였다.
// guardAsync 의 catch(그 존재 이유가 "실패가 성공으로 보이지 않게 하는 것")도 무측정이었다.
describe("fw init — base 브랜치 감지 배선 (PLAN D15)", () => {
  function makeGitRepo(withDevelop: boolean): string {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "fw-init-repo-"));
    const run = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
    run(["init", "-q", "-b", "main", "."]);
    run(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "i"]);
    if (withDevelop) run(["branch", "develop"]);
    return repo;
  }

  it("develop 이 있는 리포에서 base_branch 를 develop 으로 만든다", async () => {
    const repo = makeGitRepo(true);
    const wfDir = path.join(repo, "wf");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let out: string;
    try {
      await program.parseAsync(["node", "fw", "init", wfDir, "--repo", repo]);
      out = logSpy.mock.calls.map(c => String(c[0])).join("\n");
    } finally {
      logSpy.mockRestore();
    }
    expect(loadState(wfDir).base_branch).toBe("develop");
    // 감지 근거를 사람에게 보여준다 — 폴백을 조용히 삼키면 PR 이 만들어진 뒤에야 알게 된다.
    expect(out).toContain("develop");
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("develop 이 없으면 origin/HEAD·폴백 경로를 타고 근거를 함께 출력한다", async () => {
    const repo = makeGitRepo(false);
    const wfDir = path.join(repo, "wf");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let out: string;
    try {
      await program.parseAsync(["node", "fw", "init", wfDir, "--repo", repo]);
      out = logSpy.mock.calls.map(c => String(c[0])).join("\n");
    } finally {
      logSpy.mockRestore();
    }
    // 원격이 없는 리포이므로 폴백(main)이고, 그 사실이 출력에 드러나야 한다.
    expect(loadState(wfDir).base_branch).toBe("main");
    expect(out).toMatch(/base_branch: main/);
    expect(out).toMatch(/감지/);
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("init 이 실패하면 메시지를 출력하고 exit(1) 한다 (guardAsync 가 rejection 을 삼키지 않는다)", async () => {
    const repo = makeGitRepo(false);
    const wfDir = path.join(repo, "wf");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await program.parseAsync(["node", "fw", "init", wfDir, "--repo", repo]);
    } finally {
      logSpy.mockRestore();
    }
    // 두 번째 init 은 "STATE.json 이 이미 존재합니다" 로 실패해야 한다.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const logSpy2 = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await program.parseAsync(["node", "fw", "init", wfDir, "--repo", repo]);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errSpy.mock.calls.map(c => String(c[0])).join("\n")).toMatch(/이미 존재/);
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
      logSpy2.mockRestore();
    }
    fs.rmSync(repo, { recursive: true, force: true });
  });
});

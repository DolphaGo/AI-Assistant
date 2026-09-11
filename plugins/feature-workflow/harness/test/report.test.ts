import { describe, it, expect } from "vitest";
import type { z } from "zod";
import { StateSchema, type State } from "../src/state.js";
import { buildReport, formatReport } from "../src/report.js";

function baseState(overrides: Partial<z.input<typeof StateSchema>> = {}): State {
  return StateSchema.parse({
    schema_version: 1,
    workflow: "test-wf",
    repo_root: "/tmp/repo",
    branch_strategy: "isolate",
    allow_push: false,
    verify_default: ["npm test"],
    status: "running",
    pending_question: null,
    answers: [],
    phases: [],
    ...overrides,
  });
}

describe("buildReport", () => {
  it("phase 별 attempts/maxAttempts/세션 수/비용을 각 phase 의 데이터로부터 정확히 집계한다", () => {
    const state = baseState({
      phases: [
        {
          id: 1,
          title: "Phase 하나",
          status: "done",
          attempts: 2,
          // §36 m-4(R14) — max_attempts 를 기본값(2)으로 두면 `maxAttempts: p.max_attempts` 를
          // `maxAttempts: 2` 로 하드코딩해도 이 값이 우연히 일치해 mutant 가 안 걸린다. 기본값이
          // 아닌 값(5)을 써서 하드코딩 mutant 가 실제로 틀린 수치를 내도록 한다.
          max_attempts: 5,
          sessions: [
            { session_id: "s1", result: "done", at: "2026-08-28T01:00:00Z", kind: "phase", cost_usd: 1.5 },
            { session_id: "s2", result: "done", at: "2026-08-28T02:00:00Z", kind: "fix", cost_usd: 0.25 },
          ],
        },
      ],
    });

    const report = buildReport(state);
    expect(report.phases).toHaveLength(1);
    const [p1] = report.phases;
    // attempts 는 phase.attempts 를 그대로 반영해야 한다 (sessions.length 와 다를 수 있음 — NOTES 참조)
    expect(p1.attempts).toBe(2);
    // maxAttempts 는 phase.max_attempts 를 그대로 반영해야 한다 (기본값 2 가 아닌 5)
    expect(p1.maxAttempts).toBe(5);
    expect(p1.sessionCount).toBe(2);
    // 1.5 + 0.25 = 1.75 — 합이 아니라 한쪽만 취하거나 곱하면 이 값이 나오지 않는다
    expect(p1.costUsd).toBeCloseTo(1.75);
    expect(p1.id).toBe(1);
    expect(p1.title).toBe("Phase 하나");
    expect(p1.status).toBe("done");
  });

  it("cost_usd 가 없는 세션은 phase.costUsd 집계(state.ts phaseCostUsd)에서 0 원으로 취급돼 죽지 않는다", () => {
    // 이 테스트는 report.ts 가 아니라 state.ts 의 phaseCostUsd(phase.sessions 의 cost_usd ?? 0 합산)를
    // 거쳐 나오는 PhaseReport.costUsd 계약을 검증한다. report.ts 자신이 별도로 계산하는
    // costByKind 의 `cost_usd ?? 0`(§36 R1)은 이 테스트로 검증되지 않는다 — 그 계약은 아래
    // "costByKind 도 cost_usd 가 없는 세션을 독립적으로 0 원 취급한다" 테스트가 전담한다.
    const state = baseState({
      phases: [
        {
          id: 1,
          title: "P",
          status: "in_progress",
          sessions: [{ session_id: "s1", result: "bounced", at: "2026-08-28T01:00:00Z", kind: "phase" }],
        },
      ],
    });
    const report = buildReport(state);
    expect(report.phases[0].costUsd).toBe(0);
    expect(report.phases[0].sessionCount).toBe(1);
  });

  it("costByKind 도 cost_usd 가 없는 세션을 독립적으로 0 원 취급한다 (report.ts 자신의 ?? 0, §36 R1)", () => {
    // §36 R1 SURVIVED: report.ts:84 부근 costByKind 집계 루프의 `s.cost_usd ?? 0` 를 `?? 1` 로
    // 바꿔도 위 phaseCostUsd 테스트는 costByKind 를 안 보므로 안 걸린다. 여기서 costByKind 를
    // 직접 검증해, cost_usd 가 없는 세션이 섞여도 costByKind 합계가 틀어지지 않게 못박는다.
    const state = baseState({
      phases: [
        {
          id: 1,
          title: "P",
          status: "in_progress",
          sessions: [
            { session_id: "s1", result: "done", at: "2026-08-28T01:00:00Z", kind: "phase", cost_usd: 2 },
            // cost_usd 없음 — ?? 1 mutant 하에서는 이 세션이 $1 로 계산돼 phase 합계가 3 이 된다
            { session_id: "s2", result: "bounced", at: "2026-08-28T02:00:00Z", kind: "phase" },
          ],
        },
      ],
    });
    const report = buildReport(state);
    const phaseKind = report.costByKind.find(k => k.kind === "phase");
    // 2(정의됨) + 0(없음, ?? 1 이면 3) = 2 여야 한다
    expect(phaseKind).toEqual({ kind: "phase", sessionCount: 2, costUsd: 2 });
    // §36 이 지적한 정확한 실례: costByKind 합계와 totalCostUsd(state.ts phaseCostUsd 경유)가
    // 어긋나지 않아야 한다. ?? 1 mutant 하에서는 costByKind 합계만 3이 되어 totalCostUsd(2)와
    // 어긋난 채 리포트가 자신 있게 출력된다 — 그 어긋남을 여기서 직접 잡는다.
    const sumOfKinds = report.costByKind.reduce((s, k) => s + k.costUsd, 0);
    expect(sumOfKinds).toBeCloseTo(report.totalCostUsd);
    expect(report.totalCostUsd).toBeCloseTo(2);
  });

  it("kind 별 비용 전 종류(phase/fix/verify/consensus/decompose)를 모든 phase 에 걸쳐 정확히 합산하고, 항상 전부 나열한다", () => {
    const state = baseState({
      phases: [
        {
          id: 1,
          title: "P1",
          status: "done",
          sessions: [
            { session_id: "s1", result: "done", at: "2026-08-28T01:00:00Z", kind: "phase", cost_usd: 1.5 },
            { session_id: "s2", result: "fixed", at: "2026-08-28T02:00:00Z", kind: "fix", cost_usd: 0.25 },
          ],
        },
        {
          id: 2,
          title: "P2",
          status: "done",
          depends_on: [1],
          sessions: [
            { session_id: "s3", result: "done", at: "2026-08-28T03:00:00Z", kind: "phase", cost_usd: 2 },
            { session_id: "s4", result: "verified", at: "2026-08-28T04:00:00Z", kind: "verify", cost_usd: 3 },
          ],
        },
      ],
    });

    const report = buildReport(state);
    expect(report.costByKind).toEqual([
      { kind: "phase", sessionCount: 2, costUsd: 3.5 },
      { kind: "fix", sessionCount: 1, costUsd: 0.25 },
      { kind: "verify", sessionCount: 1, costUsd: 3 },
      // §47 — consensus 종류 신설. 없는 워크플로우에서도 0건으로 명시(누락과 구분).
      { kind: "consensus", sessionCount: 0, costUsd: 0 },
      // pr-slicing — 분해 세션도 유료 세션이라 집계에서 빠지면 비용이 조용히 새어나간다.
      { kind: "decompose", sessionCount: 0, costUsd: 0 },
    ]);
    // costByKind 를 다 더하면 totalCostUsd 와 같아야 한다 — 종류 분류가 새고 있지 않다는 교차 검증
    const sumOfKinds = report.costByKind.reduce((s, k) => s + k.costUsd, 0);
    expect(sumOfKinds).toBeCloseTo(report.totalCostUsd);
    expect(report.totalCostUsd).toBeCloseTo(6.75);
  });

  it("어떤 phase 도 fix/verify 세션이 없으면 그 종류는 0건/$0 으로 명시된다 (누락과 구분)", () => {
    const state = baseState({
      phases: [
        {
          id: 1,
          title: "P",
          status: "done",
          sessions: [{ session_id: "s1", result: "done", at: "2026-08-28T01:00:00Z", kind: "phase", cost_usd: 1 }],
        },
      ],
    });
    const report = buildReport(state);
    const fix = report.costByKind.find(k => k.kind === "fix");
    const verify = report.costByKind.find(k => k.kind === "verify");
    expect(fix).toEqual({ kind: "fix", sessionCount: 0, costUsd: 0 });
    expect(verify).toEqual({ kind: "verify", sessionCount: 0, costUsd: 0 });
  });

  it.each([
    ["done", true],
    ["running", false],
    ["blocked", false],
    ["failed", false],
    ["halted", false],
    ["awaiting_merge", false],
  ] as const)("status=%s 이면 completed=%s", (status, expected) => {
    const state = baseState({ status, phases: [{ id: 1, title: "P", status: "done", sessions: [] }] });
    expect(buildReport(state).completed).toBe(expected);
  });

  it("미완주(running/blocked/failed) 워크플로우도 예외 없이 리포트를 만든다 (PLAN D5)", () => {
    for (const status of ["running", "blocked", "failed"] as const) {
      const state = baseState({
        status,
        pending_question:
          status === "blocked" ? { phase: 1, question: "브랜치를 새로 만들까요?", asked_at: "2026-08-28T00:00:00Z" } : null,
        phases: [
          { id: 1, title: "P1", status: status === "failed" ? "failed" : "in_progress", attempts: 1, sessions: [] },
        ],
      });
      expect(() => buildReport(state)).not.toThrow();
      const report = buildReport(state);
      expect(report.completed).toBe(false);
      expect(() => formatReport(report)).not.toThrow();
    }
  });

  it("BLOCKED 질문과 답변 이력을 그대로 통과시킨다", () => {
    const state = baseState({
      status: "blocked",
      pending_question: { phase: 2, question: "DB 마이그레이션을 지금 돌릴까요?", asked_at: "2026-08-28T05:00:00Z" },
      answers: [{ question: "이전 질문", answer: "네, 진행하세요", at: "2026-08-27T00:00:00Z", phase: 1 }],
      phases: [
        { id: 1, title: "P1", status: "done", sessions: [] },
        { id: 2, title: "P2", status: "blocked", depends_on: [1], sessions: [] },
      ],
    });
    const report = buildReport(state);
    expect(report.pendingQuestion).toEqual({ phase: 2, question: "DB 마이그레이션을 지금 돌릴까요?", asked_at: "2026-08-28T05:00:00Z" });
    expect(report.answers).toEqual([{ question: "이전 질문", answer: "네, 진행하세요", at: "2026-08-27T00:00:00Z", phase: 1 }]);
  });

  // §36 §30 P4 후속 — state.ts 의 SessionVerdictSchema 가 하네스의 판정을 phase.sessions[].verdict
  // 에 영속하게 되면서, 예전에 "낼 수 없는 지표"로 선언했던 회송 사유 분포를 이제 실제로 낼 수
  // 있다. 단 이 필드가 없는 세션(§36 이전에 기록된 "레거시" 세션)에 대해서는 여전히 계산하지
  // 않는다 — 아래 세 테스트가 "세션 없음"/"레거시만"/"혼재" 세 갈래를 각각 검증한다.

  it("세션이 하나도 없으면 지어낼 데이터도 감출 레거시도 없다 — notComputable 은 비어 있다", () => {
    const report = buildReport(baseState());
    expect(report.notComputable).toEqual([]);
    expect(report.verdict).toEqual({
      trackedSessionCount: 0,
      legacySessionCount: 0,
      accepted: 0,
      bounced: 0,
      sessionFailed: 0,
      sessionBlocked: 0,
      bounceReasons: [
        { reason: "gate_failed", count: 0 },
        { reason: "no_commits", count: 0 },
        { reason: "commit_verification_failed", count: 0 },
        { reason: "branch_drift", count: 0 },
        { reason: "verify_tampered", count: 0 },
        // §tamper-gap: SessionVerdictReasonEnum 신규 값 — SESSION_VERDICT_REASONS(report.ts:46)
        // 가 .options 를 그대로 순회하므로 report.ts 코드 변경 없이 자동으로 0건부터 집계된다.
        { reason: "changed_files_untrustworthy", count: 0 },
        // issue #3: already_applied 근거 SHA 검증 실패 — 마찬가지로 enum 추가만으로 자동 집계된다.
        { reason: "already_applied_unverified", count: 0 },
        { reason: "comment_items_unreported", count: 0 },
      ],
    });
  });

  it("verdict 필드가 없는(§36 이전) 세션만 있으면 '기록 이전 버전' 임을 notComputable 에 명시하고 지어내지 않는다 (PLAN D4)", () => {
    const state = baseState({
      phases: [
        {
          id: 1,
          title: "레거시 phase",
          status: "done",
          sessions: [
            { session_id: "s1", result: "done", at: "2026-08-20T00:00:00Z", kind: "phase" },
            { session_id: "s2", result: "done", at: "2026-08-20T01:00:00Z", kind: "phase" },
          ],
        },
      ],
    });
    const report = buildReport(state);
    expect(report.verdict.trackedSessionCount).toBe(0);
    expect(report.verdict.legacySessionCount).toBe(2);
    // 지어낸 수치가 없어야 한다 — 전부 0
    expect(report.verdict.accepted).toBe(0);
    expect(report.verdict.bounced).toBe(0);
    expect(report.notComputable.some(n => n.includes("기록 이전 버전") && n.includes("2건"))).toBe(true);
  });

  it("verdict 가 있는 세션과 없는(레거시) 세션이 혼재하면 레거시는 제외하고 tracked 세션만 집계한다", () => {
    const state = baseState({
      phases: [
        {
          id: 1,
          title: "혼재 phase",
          status: "done",
          sessions: [
            { session_id: "legacy", result: "done", at: "2026-08-20T00:00:00Z", kind: "phase" },
            {
              session_id: "tracked",
              result: "done",
              at: "2026-08-28T00:00:00Z",
              kind: "phase",
              verdict: { outcome: "accepted" },
            },
          ],
        },
      ],
    });
    const report = buildReport(state);
    expect(report.verdict.trackedSessionCount).toBe(1);
    expect(report.verdict.legacySessionCount).toBe(1);
    expect(report.verdict.accepted).toBe(1);
    expect(report.notComputable.some(n => n.includes("1건") && n.includes("기록 이전 버전"))).toBe(true);
  });

  it("verdict 가 있으면 accepted/bounced(사유별)/session_failed/session_blocked 를 실제로 집계한다", () => {
    const state = baseState({
      phases: [
        {
          id: 1,
          title: "P1",
          status: "failed",
          sessions: [
            { session_id: "a1", result: "done", at: "2026-08-28T00:00:00Z", kind: "phase", verdict: { outcome: "accepted" } },
            {
              session_id: "b1", result: "done", at: "2026-08-28T01:00:00Z", kind: "phase",
              verdict: { outcome: "bounced", reason: "gate_failed", detail: "npm test 실패" },
            },
            {
              session_id: "b2", result: "done", at: "2026-08-28T02:00:00Z", kind: "phase",
              verdict: { outcome: "bounced", reason: "gate_failed", detail: "npm test 실패 2" },
            },
            {
              session_id: "b3", result: "done", at: "2026-08-28T03:00:00Z", kind: "fix",
              verdict: { outcome: "bounced", reason: "no_commits" },
            },
            { session_id: "f1", result: "failed", at: "2026-08-28T04:00:00Z", kind: "phase", verdict: { outcome: "session_failed" } },
            { session_id: "q1", result: "blocked", at: "2026-08-28T05:00:00Z", kind: "phase", verdict: { outcome: "session_blocked" } },
          ],
        },
      ],
    });
    const report = buildReport(state);
    expect(report.verdict.trackedSessionCount).toBe(6);
    expect(report.verdict.legacySessionCount).toBe(0);
    expect(report.verdict.accepted).toBe(1);
    expect(report.verdict.bounced).toBe(3);
    expect(report.verdict.sessionFailed).toBe(1);
    expect(report.verdict.sessionBlocked).toBe(1);
    expect(report.verdict.bounceReasons).toEqual([
      { reason: "gate_failed", count: 2 },
      { reason: "no_commits", count: 1 },
      { reason: "commit_verification_failed", count: 0 },
      { reason: "branch_drift", count: 0 },
      { reason: "verify_tampered", count: 0 },
      { reason: "changed_files_untrustworthy", count: 0 },
      { reason: "already_applied_unverified", count: 0 },
      { reason: "comment_items_unreported", count: 0 },
    ]);
    expect(report.notComputable).toEqual([]);
  });
});

describe("formatReport", () => {
  it("phase 별 시도/세션/비용과 kind 별 비용을 텍스트로 드러낸다", () => {
    const state = baseState({
      workflow: "my-wf",
      status: "running",
      phases: [
        {
          id: 1,
          title: "집계",
          status: "in_progress",
          attempts: 3,
          // §36 m-4(R14) — max_attempts 기본값(2)을 그대로 두면 "시도 3/2" 라는 우연한 일치가
          // `maxAttempts: p.max_attempts` → `maxAttempts: 2` 하드코딩 mutant 를 가려버린다.
          // 기본값이 아닌 5 로 둬서 하드코딩 mutant 가 실제로 틀린 문자열("시도 3/2")을 내도록 한다.
          max_attempts: 5,
          sessions: [
            { session_id: "s1", result: "bounced", at: "2026-08-28T01:00:00Z", kind: "phase", cost_usd: 1.5 },
            { session_id: "s2", result: "verified", at: "2026-08-28T02:00:00Z", kind: "verify", cost_usd: 2.5 },
          ],
        },
      ],
    });
    const text = formatReport(buildReport(state));
    expect(text).toContain("my-wf");
    expect(text).toContain("[running]");
    expect(text).toContain("완주: 아니오");
    expect(text).toContain("시도 3/5"); // max_attempts = 5 (기본값 2 가 아님 — §36 m-4)
    expect(text).toContain("세션 2건");
    expect(text).toContain("$4.00"); // phase 총 비용 1.5+2.5
    expect(text).toContain("phase: 1건, $1.50");
    expect(text).toContain("verify: 1건, $2.50");
    expect(text).toContain("fix: 0건, $0.00");
  });

  it("완주한 워크플로우는 '완주: 예' 를 보여준다", () => {
    const state = baseState({ status: "done", phases: [{ id: 1, title: "P", status: "done", sessions: [] }] });
    const text = formatReport(buildReport(state));
    expect(text).toContain("완주: 예");
  });

  it("BLOCKED 질문이 있으면 텍스트에 포함한다", () => {
    const state = baseState({
      status: "blocked",
      pending_question: { phase: 1, question: "이 값을 써도 될까요?", asked_at: "2026-08-28T00:00:00Z" },
      phases: [{ id: 1, title: "P", status: "blocked", sessions: [] }],
    });
    const text = formatReport(buildReport(state));
    expect(text).toContain("BLOCKED 질문 (Phase 1)");
    expect(text).toContain("이 값을 써도 될까요?");
  });

  it("세션이 하나도 없으면 '낼 수 없는 지표' 는 (없음)으로 표시한다 — 지어낼 것도 감출 것도 없다", () => {
    const text = formatReport(buildReport(baseState()));
    expect(text).toContain("[낼 수 없는 지표]");
    expect(text).toContain("(없음)");
  });

  // §36 §30 P4 후속 — [하네스 판정] 섹션에 accepted/bounced/session_failed/session_blocked 총계와
  // bounced 사유별 분포가 실제 숫자로 나타나는지 검증한다(전부 0 으로 뭉개는 mutant 를 잡기 위해
  // 각 항목을 서로 다른 건수로 둔다).
  it("[하네스 판정] 섹션에 accepted/bounced/session_failed/session_blocked 및 사유별 분포가 나타난다", () => {
    const state = baseState({
      phases: [
        {
          id: 1,
          title: "P1",
          status: "failed",
          sessions: [
            { session_id: "a1", result: "done", at: "2026-08-28T00:00:00Z", kind: "phase", verdict: { outcome: "accepted" } },
            { session_id: "a2", result: "done", at: "2026-08-28T01:00:00Z", kind: "phase", verdict: { outcome: "accepted" } },
            {
              session_id: "b1", result: "done", at: "2026-08-28T02:00:00Z", kind: "phase",
              verdict: { outcome: "bounced", reason: "branch_drift" },
            },
            { session_id: "f1", result: "failed", at: "2026-08-28T03:00:00Z", kind: "phase", verdict: { outcome: "session_failed" } },
            { session_id: "f2", result: "failed", at: "2026-08-28T04:00:00Z", kind: "phase", verdict: { outcome: "session_failed" } },
            { session_id: "f3", result: "failed", at: "2026-08-28T05:00:00Z", kind: "phase", verdict: { outcome: "session_failed" } },
            { session_id: "q1", result: "blocked", at: "2026-08-28T06:00:00Z", kind: "phase", verdict: { outcome: "session_blocked" } },
          ],
        },
      ],
    });
    const text = formatReport(buildReport(state));
    expect(text).toContain("[하네스 판정]");
    expect(text).toContain("accepted: 2건, bounced: 1건, session_failed: 3건, session_blocked: 1건");
    expect(text).toContain("branch_drift: 1건");
    expect(text).toContain("gate_failed: 0건");
  });

  // §41 I-2/PLAN D4 — 판정 기록이 전혀 없는(§38 이전 버전) 워크플로우에서 예전에는 이 블록이
  // "accepted: 0건, bounced: 0건, ..., gate_failed: 0건" 을 사실처럼 찍었다(실측: 실제로 2번
  // 회송당한 harness-module-tests Phase 1 이 다른 실행에서는 legacy 세션만 있어 0건으로 보였다).
  // 없는 데이터를 0 으로 내지 않고 "판정 기록 없음"이라는 사실 자체를 보여줘야 한다.
  it("§41 I-2: 판정 기록이 전혀 없으면(trackedSessionCount=0) '판정 기록 없음' 한 줄로 대체하고 거짓 0 을 내지 않는다", () => {
    const state = baseState({
      phases: [
        {
          id: 1,
          title: "레거시 phase",
          status: "done",
          sessions: [
            { session_id: "s1", result: "done", at: "2026-08-20T00:00:00Z", kind: "phase" },
            { session_id: "s2", result: "done", at: "2026-08-20T01:00:00Z", kind: "phase" },
          ],
        },
      ],
    });
    const text = formatReport(buildReport(state));
    expect(text).toContain("[하네스 판정]");
    expect(text).toContain("판정 기록 없음");
    expect(text).toContain("§38 이전 버전");
    // 거짓 0 을 내던 예전 문구가 나오면 안 된다.
    expect(text).not.toContain("accepted: 0건");
    expect(text).not.toContain("gate_failed: 0건");
    expect(text).not.toContain("회송 사유:");
  });

  // §41 I-2 — 혼재(레거시+판정 기록 병존) 케이스는 전량 집계가 아니라는 것을 헤더에서 바로
  // 알 수 있어야 한다("세션 1/2 집계"). 숫자 자체(accepted 등)는 여전히 tracked 세션 기준으로
  // 정확히 나와야 한다(기존 buildReport 집계 계약은 그대로 유지).
  it("§41 I-2: 혼재(레거시+판정 기록)면 헤더에 표본 크기를 명시하고 tracked 세션만 집계해 보여준다", () => {
    const state = baseState({
      phases: [
        {
          id: 1,
          title: "혼재 phase",
          status: "done",
          sessions: [
            { session_id: "legacy", result: "done", at: "2026-08-20T00:00:00Z", kind: "phase" },
            {
              session_id: "tracked",
              result: "done",
              at: "2026-08-28T00:00:00Z",
              kind: "phase",
              verdict: { outcome: "accepted" },
            },
          ],
        },
      ],
    });
    const text = formatReport(buildReport(state));
    expect(text).toContain("[하네스 판정]");
    expect(text).toContain("세션 1/2 집계");
    expect(text).toContain("accepted: 1건, bounced: 0건, session_failed: 0건, session_blocked: 0건");
  });

  // §41 I-2 — 판정 기록이 있는(레거시 0건) 워크플로우는 기존처럼 표본 크기 헤더 없이 그대로
  // 보여야 한다(§30 P2 회귀 방지 — 이미 있는 정상 경로를 새 표시로 어지럽히지 않는다).
  it("§41 I-2 §30 P2 회귀: 전량이 판정 기록이면(레거시 0건) 표본 크기 헤더를 붙이지 않는다", () => {
    const state = baseState({
      phases: [
        {
          id: 1,
          title: "P1",
          status: "done",
          sessions: [
            { session_id: "a1", result: "done", at: "2026-08-28T00:00:00Z", kind: "phase", verdict: { outcome: "accepted" } },
          ],
        },
      ],
    });
    const text = formatReport(buildReport(state));
    expect(text).toContain("accepted: 1건");
    expect(text).not.toContain("집계 — 나머지는");
  });

  it("레거시 세션(verdict 없음)만 있으면 [낼 수 없는 지표] 에 '기록 이전 버전' 안내가 실제로 출력된다", () => {
    const state = baseState({
      phases: [
        {
          id: 1,
          title: "레거시 phase",
          status: "done",
          sessions: [{ session_id: "s1", result: "done", at: "2026-08-20T00:00:00Z", kind: "phase" }],
        },
      ],
    });
    const text = formatReport(buildReport(state));
    expect(text).toContain("[낼 수 없는 지표]");
    expect(text).toContain("기록 이전 버전");
    // "[낼 수 없는 지표]" 섹션 자체는 실제 안내 문구를 담아야 한다 — "(없음)" 으로 뭉개지면 안
    // 된다(다른 섹션의 "(없음)" 과 혼동하지 않도록 그 섹션만 잘라 확인한다).
    const section = text.slice(text.indexOf("[낼 수 없는 지표]"));
    expect(section).not.toContain("(없음)");
  });

  it("phase 가 하나도 없어도 예외 없이 출력한다", () => {
    const text = formatReport(buildReport(baseState({ phases: [] })));
    expect(text).toContain("(phase 없음)");
  });

  // §36 R11 SURVIVED — STATUS_ICON[p.status] ?? "?" 전체를 상수 "?" 로 바꿔도 기존 테스트가
  // 전부 통과했다. 상태별로 실제 아이콘 글자가 달라지는지를 직접 못박는다.
  it.each([
    ["pending", "☐"],
    ["in_progress", "▣"],
    ["in_review", "◍"],
    ["done", "☑"],
    ["failed", "✗"],
    ["blocked", "⊘"],
  ] as const)("phase status=%s 는 아이콘 %s 로 표시된다 (항상 '?' 로 뭉개지지 않는다)", (status, icon) => {
    const state = baseState({ phases: [{ id: 1, title: "P", status, sessions: [] }] });
    const text = formatReport(buildReport(state));
    expect(text).toContain(`${icon} Phase 1: P`);
    expect(text).not.toContain("? Phase 1: P");
  });

  // §36 R12 SURVIVED — 답변 이력에서 "Phase ${a.phase} — " 표기를 통째로 지워도 기존 테스트가
  // 전부 통과했다(어떤 테스트도 답변 이력 섹션에서 Phase 표기를 확인하지 않았다). phase 가 있는
  // 답변과 없는 답변을 함께 넣어, 있을 때만 표기되는 것을 직접 검증한다.
  it("답변 이력에 Phase 표기가 실제로 나타난다 (있으면 표시, 없으면 생략)", () => {
    const state = baseState({
      answers: [
        { question: "브랜치를 새로 만들까요?", answer: "네", at: "2026-08-28T00:00:00Z", phase: 3 },
        { question: "phase 없는 질문", answer: "아니오", at: "2026-08-28T01:00:00Z" },
      ],
      phases: [{ id: 3, title: "P3", status: "done", sessions: [] }],
    });
    const text = formatReport(buildReport(state));
    // phase 가 있는 답변은 "Phase 3 — Q: ..." 형태로 나타나야 한다 (phasePart 를 항상 지우는
    // mutant 를 잡는다)
    expect(text).toContain("2026-08-28T00:00:00Z Phase 3 — Q: 브랜치를 새로 만들까요?");
    // phase 가 없는 답변은 Phase 표기 없이 시각 바로 뒤에 "Q: " 가 와야 한다 — 정확한 줄
    // 전체를 대조해, Phase 표기를 항상 붙이는 반대쪽 mutant 도 함께 잡는다
    expect(text).toContain("2026-08-28T01:00:00Z Q: phase 없는 질문");
  });
});

// §43 — 9번(피드백) 의 출구. 주행은 원래 목표로 끝내고, 범위 밖 발견은 여기 모아 보고한다.
// PLAN 을 주행 중에 고치면 AI 가 스스로 성공 조건을 재정의할 수 있으므로, 발견은 STATE 에만
// 쌓이고 반영 여부는 사람이 결정한다.
describe("범위 밖 발견 사항 — §43", () => {
  const withFindings = (): State =>
    baseState({
      phases: [
        {
          id: 1, title: "P1", status: "done", attempts: 1, max_attempts: 2,
          sessions: [
            {
              session_id: "s1", result: "done", at: "t", kind: "phase", cost_usd: 1,
              findings: [
                { kind: "learned", detail: "Feign 인코더가 2.x 에서 바뀜" },
                { kind: "bug", detail: "널 헤더에서 NPE" },
              ],
            },
          ],
        },
        {
          id: 2, title: "P2", status: "done", attempts: 1, max_attempts: 2,
          sessions: [
            {
              session_id: "s2", result: "done", at: "t", kind: "fix", cost_usd: 1,
              findings: [{ kind: "plan_change", detail: "Phase 3 을 둘로 쪼개야 함" }],
            },
          ],
        },
      ],
    });

  it("전 phase·전 세션에서 발견 사항을 출처와 함께 모은다", () => {
    const r = buildReport(withFindings());
    expect(r.findings).toHaveLength(3);
    expect(r.findings).toContainEqual({ phaseId: 1, sessionKind: "phase", kind: "bug", detail: "널 헤더에서 NPE" });
    expect(r.findings).toContainEqual({ phaseId: 2, sessionKind: "fix", kind: "plan_change", detail: "Phase 3 을 둘로 쪼개야 함" });
  });

  it("종류별로 묶어 출력하고 버그를 먼저 보여준다", () => {
    const out = formatReport(buildReport(withFindings()));
    expect(out).toContain("[범위 밖 발견 사항]");
    expect(out).toContain("버그 (1건)");
    expect(out).toContain("[Phase 1/phase] 널 헤더에서 NPE");
    expect(out).toContain("PLAN 수정 제안 (1건)");
    expect(out.indexOf("버그 (1건)")).toBeLessThan(out.indexOf("알게 된 것 (1건)"));
  });

  it("반영 여부가 사람 몫임을 명시한다", () => {
    expect(formatReport(buildReport(withFindings()))).toContain("사람이 정합니다");
  });

  it("발견이 없으면 (없음) — 거짓 정보를 만들지 않는다", () => {
    const out = formatReport(buildReport(baseState({ phases: [] })));
    expect(out).toContain("[범위 밖 발견 사항]\n  (없음)");
  });

  it("findings 가 없는 구버전 STATE 도 그대로 동작한다 (하위호환)", () => {
    const legacy = baseState({
      phases: [{ id: 1, title: "P", status: "done", attempts: 1, max_attempts: 2,
        sessions: [{ session_id: "s", result: "done", at: "t", kind: "phase" }] }],
    });
    expect(buildReport(legacy).findings).toEqual([]);
  });
});

// §47 — 되먹임의 출구: 합의 세션의 다음 목표 제안을 사람에게 보여준다.
describe("다음 목표 제안 — §47", () => {
  it("STATE 의 next_goal_suggestions 를 표시하고 다음 사이클 시작법을 안내한다", () => {
    const state = baseState({ phases: [], next_goal_suggestions: ["Kafka 소비자 재시도 로직 보강", "빠진 회귀 테스트 추가"] });
    const out = formatReport(buildReport(state));
    expect(out).toContain("[다음 목표 제안]");
    expect(out).toContain("Kafka 소비자 재시도 로직 보강");
    expect(out).toContain("fw interview");
  });

  it("제안이 없으면 (없음) — 지어내지 않는다", () => {
    const out = formatReport(buildReport(baseState({ phases: [] })));
    expect(out).toContain("[다음 목표 제안]\n  (없음)");
  });
});

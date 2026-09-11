import {
  totalCostUsd, phaseCostUsd, SessionVerdictReasonEnum, type State, type Phase, type SessionVerdictReason,
} from "./state.js";

// §34 T2 — 하네스가 "게이트가 통과했다" 는 알지만 "잘 돌아갔는가" 는 모른다. 이미 STATE.json 에
// 있는 데이터(phases[].sessions[], attempts, answers, pending_question)를 집계해 사람이 판단할
// 재료를 만든다. buildReport/formatReport 모두 순수 함수다 — fs/네트워크/프로세스에 접근하지
// 않는다(PLAN D3, formatStatus/formatRunLog/formatDoctorReport 와 같은 패턴).
//
// PLAN D2: STATE 에 새 필드를 추가하지 않는다 — 이미 있는 값만 재조합한다.
// PLAN D1: 숫자를 목표로 삼지 않는다 — 이 모듈은 판단 재료를 주는 것이지 점수를 매기지 않는다.
//   그래서 buildReport/formatReport 어디에도 "좋음/나쁨" 판정이나 합격선 비교가 없다.

export type SessionKind = Phase["sessions"][number]["kind"];

// 세션 kind 는 phase(작업)/fix(PR 코멘트 반영)/verify(검증 에이전트) 셋 뿐이다(state.ts
// PhaseSchema.sessions.kind enum). 비용 해석이 종류에 따라 갈리므로(PLAN §용어) 항상 세 종류를
// 전부 나열한다 — 어떤 워크플로우에 fix/verify 세션이 하나도 없어도 "0건" 으로 명시해, "이
// 워크플로우엔 애초에 그 종류가 없었다"와 "집계가 빠졌다"를 구분할 수 있게 한다.
// §47 — state.ts 의 kind enum 과 함께 움직인다(한쪽만 바꾸면 비용 집계가 조용히 샌다).
const SESSION_KINDS: readonly SessionKind[] = ["phase", "fix", "verify", "consensus", "decompose"];

export interface PhaseReport {
  id: number;
  title: string;
  status: Phase["status"];
  attempts: number;
  maxAttempts: number;
  sessionCount: number;
  costUsd: number;
}

export interface KindCost {
  kind: SessionKind;
  sessionCount: number;
  costUsd: number;
}

// §36 §30 P4 후속 — 회송(bounce) 사유 분포는 더 이상 "낼 수 없는 지표" 가 아니다. state.ts 의
// SessionVerdictSchema(§36 §30 P4)가 하네스의 판정을 phase.sessions[].verdict 로 영속하게 되면서
// PLAN D4 가 "낼 수 없다"고 선언했던 값이 실제로 STATE 에 생겼다. 단, **판정 기록 이전에 완주한
// 워크플로우**(verdict 필드가 없는 세션)에 대해서는 여전히 계산하지 않는다 — 없는 데이터를
// 추측해 그럴듯한 숫자를 채우는 것은 그 자체가 §30 P4 위반이다(D4 정신은 유지, 대상만 좁아졌다).
// 아래 SESSION_VERDICT_REASONS 는 state.ts 스키마의 reason enum 값을 그대로 가져온다(복붙 금지 —
// 스키마가 사유를 늘리면 이 리스트도 자동으로 따라간다).
const SESSION_VERDICT_REASONS: readonly SessionVerdictReason[] = SessionVerdictReasonEnum.options;

export interface VerdictReasonCount {
  reason: SessionVerdictReason;
  count: number;
}

// 하네스가 세션에 대해 실제로 내린 판정의 집계. costByKind 와 같은 관례 — 세션이 하나도 없는
// 사유도 0건으로 명시해 "그 사유가 없었다"와 "집계가 빠졌다"를 구분한다.
export interface VerdictSummary {
  // verdict 필드가 있는(=§36 §30 P4 이후에 기록된) 세션 수 — 아래 accepted/bounced/... 는
  // 이 세션들만의 집계다.
  trackedSessionCount: number;
  // verdict 필드가 없는(=판정 기록 이전 버전) 세션 수. 0 이 아니면 notComputable 에 안내가 남는다.
  legacySessionCount: number;
  accepted: number;
  bounced: number;
  sessionFailed: number;
  sessionBlocked: number;
  /** bounced 세션만의 사유별 분포. */
  bounceReasons: VerdictReasonCount[];
}

function buildVerdictSummary(state: State): VerdictSummary {
  let trackedSessionCount = 0;
  let legacySessionCount = 0;
  let accepted = 0;
  let bounced = 0;
  let sessionFailed = 0;
  let sessionBlocked = 0;
  const reasonCounts = new Map<SessionVerdictReason, number>(SESSION_VERDICT_REASONS.map(r => [r, 0]));

  for (const p of state.phases) {
    for (const s of p.sessions) {
      if (!s.verdict) {
        legacySessionCount += 1;
        continue;
      }
      trackedSessionCount += 1;
      switch (s.verdict.outcome) {
        case "accepted":
          accepted += 1;
          break;
        case "session_failed":
          sessionFailed += 1;
          break;
        case "session_blocked":
          sessionBlocked += 1;
          break;
        case "bounced":
          bounced += 1;
          if (s.verdict.reason) {
            reasonCounts.set(s.verdict.reason, (reasonCounts.get(s.verdict.reason) ?? 0) + 1);
          }
          break;
      }
    }
  }

  return {
    trackedSessionCount,
    legacySessionCount,
    accepted,
    bounced,
    sessionFailed,
    sessionBlocked,
    bounceReasons: SESSION_VERDICT_REASONS.map(reason => ({ reason, count: reasonCounts.get(reason) ?? 0 })),
  };
}

// legacySessionCount 가 0 이 아닐 때만 notComputable 에 안내를 추가한다(PLAN D4 정신 — 없는 데이터를
// 지어내지 않되, 지어내지 않는다는 사실 자체는 명시한다). 전부 레거시(trackedSessionCount===0)와
// 일부만 레거시(혼재)는 문구를 다르게 한다 — 혼재 워크플로우는 실제로 부분 집계가 가능하기 때문에
// "전혀 집계할 수 없다"고 하면 그 자체가 부정확한 안내다.
function verdictNotComputableNotes(verdict: VerdictSummary): string[] {
  if (verdict.legacySessionCount === 0) return [];
  if (verdict.trackedSessionCount === 0) {
    return [
      `이 워크플로우는 하네스 판정(verdict) 기록 이전 버전이라 회송 사유 분포를 집계할 수 없습니다 ` +
        `(세션 ${verdict.legacySessionCount}건 모두 판정 기록 없음)`,
    ];
  }
  return [
    `세션 ${verdict.legacySessionCount}건은 하네스 판정(verdict) 기록 이전 버전이라 회송 사유 분포 집계에서 ` +
      `제외됩니다 (판정 기록이 있는 세션 ${verdict.trackedSessionCount}건만 집계)`,
  ];
}

export interface Report {
  workflow: string;
  status: State["status"];
  // 전 phase 가 done 으로 끝났는지가 아니라, 워크플로우 전역 상태가 "done" 인지로 판정한다 —
  // orchestrator.ts 는 selectNextPhase 가 더 고를 phase 가 없을 때만 state.status 를 "done" 으로
  // 쓴다(orchestrator.ts:335 부근). running/blocked/halted/failed 는 모두 미완주다(PLAN D5 —
  // 이 값들도 리포트 자체는 정상적으로 나와야 한다. completed:false 가 "리포트 생성 실패"를
  // 뜻하지 않는다).
  completed: boolean;
  totalCostUsd: number;
  costByKind: KindCost[];
  phases: PhaseReport[];
  pendingQuestion: State["pending_question"];
  answers: State["answers"];
  verdict: VerdictSummary;
  notComputable: string[];
  /** §43 — 주행 중 발견했지만 이번 목표의 범위가 아니었던 것들. 출처(phase/kind)를 붙여
   *  집계한다. 이 목록이 다음 사이클을 열지 말지 판단하는 재료다 — 판단은 사람이 한다. */
  findings: FindingReport[];
  /** §47 — 합의 세션이 제안한 다음 사이클 목표 후보. 되먹임의 연결 고리 — 사람이 이 중
   *  하나를 골라 fw interview --goal 로 다음 사이클을 시작한다(또는 무시한다). */
  nextGoalSuggestions: string[];
}

export interface FindingReport {
  phaseId: number;
  // SessionKind 를 참조한다 — 유니온을 복제하면 kind 가 늘 때 한쪽만 바뀌어 갈린다
  // (pr-slicing 이 "decompose" 를 추가하며 실제로 여기서 컴파일 에러로 드러났다).
  sessionKind: SessionKind;
  kind: "bug" | "learned" | "needed" | "plan_change";
  detail: string;
}

const FINDING_LABEL: Record<FindingReport["kind"], string> = {
  bug: "버그",
  learned: "알게 된 것",
  needed: "더 필요한 것",
  plan_change: "PLAN 수정 제안",
};

// 표시 순서 — 사람이 먼저 봐야 하는 순서다(고장 → 결정 필요 → 보완 → 참고).
const FINDING_ORDER: FindingReport["kind"][] = ["bug", "plan_change", "needed", "learned"];

/**
 * STATE 를 받아 지표를 계산하는 순수 함수. fs/프로세스에 접근하지 않는다(PLAN D3) — 호출자
 * (cli.ts, Phase 2 소관)가 loadState 로 미리 읽어 넘긴다.
 */
function collectFindings(state: State): FindingReport[] {
  const out: FindingReport[] = [];
  for (const p of state.phases) {
    for (const s of p.sessions) {
      for (const f of s.findings ?? []) {
        out.push({ phaseId: p.id, sessionKind: s.kind, kind: f.kind, detail: f.detail });
      }
    }
  }
  return out;
}

export function buildReport(state: State): Report {
  const phases: PhaseReport[] = state.phases.map(p => ({
    id: p.id,
    title: p.title,
    status: p.status,
    attempts: p.attempts,
    maxAttempts: p.max_attempts,
    sessionCount: p.sessions.length,
    costUsd: phaseCostUsd(p),
  }));

  const costByKind: KindCost[] = SESSION_KINDS.map(kind => {
    let sessionCount = 0;
    let costUsd = 0;
    for (const p of state.phases) {
      for (const s of p.sessions) {
        if (s.kind === kind) {
          sessionCount += 1;
          costUsd += s.cost_usd ?? 0;
        }
      }
    }
    return { kind, sessionCount, costUsd };
  });

  const verdict = buildVerdictSummary(state);

  return {
    workflow: state.workflow,
    status: state.status,
    completed: state.status === "done",
    totalCostUsd: totalCostUsd(state),
    costByKind,
    phases,
    pendingQuestion: state.pending_question,
    answers: state.answers,
    verdict,
    notComputable: verdictNotComputableNotes(verdict),
    findings: collectFindings(state),
    nextGoalSuggestions: state.next_goal_suggestions ?? [],
  };
}

const STATUS_ICON: Record<string, string> = {
  pending: "☐", in_progress: "▣", in_review: "◍", done: "☑", failed: "✗", blocked: "⊘",
};

/**
 * buildReport 의 결과를 사람이 읽는 텍스트로 조립한다. formatStatus/formatRunLog 와 같은
 * 패턴 — 순수 함수라 표시 내용을 fs 없이 테스트할 수 있다.
 */
export function formatReport(report: Report): string {
  const lines: string[] = [];
  lines.push(`fw report — ${report.workflow} [${report.status}]`);
  lines.push(`완주: ${report.completed ? "예" : "아니오"}`);
  lines.push(`총 비용: $${report.totalCostUsd.toFixed(2)}`);
  lines.push("");

  lines.push("[세션 종류별 비용]");
  for (const kc of report.costByKind) {
    lines.push(`  ${kc.kind}: ${kc.sessionCount}건, $${kc.costUsd.toFixed(2)}`);
  }
  lines.push("");

  // §41 I-2/PLAN D4 — 이전에는 이 블록이 trackedSessionCount 와 무관하게 항상 accepted/bounced
  // 등을 숫자로 찍었다. 판정 기록이 하나도 없는(§38 이전 버전) 워크플로우도 "gate_failed: 0건"
  // 처럼 사실인 것처럼 보였고, 반증은 화면 맨 아래 [낼 수 없는 지표]에만 있어 위쪽 헤더만 보면
  // "회송이 없었다"로 오독됐다(실측: harness-module-tests Phase 1 은 실제로 2번 회송당했는데도
  // legacy 세션만 있던 다른 실행에서 0건으로 찍혔다). 없는 데이터를 0으로 내지 않는다(D4 정신).
  lines.push("[하네스 판정]");
  if (report.verdict.trackedSessionCount === 0) {
    lines.push("  (판정 기록 없음 — §38 이전 버전)");
  } else {
    // 혼재(레거시+판정 기록 병존)면 헤더에 표본 크기를 명시한다 — 전량 집계처럼 보이지 않게.
    if (report.verdict.legacySessionCount > 0) {
      const total = report.verdict.trackedSessionCount + report.verdict.legacySessionCount;
      lines.push(`  (세션 ${report.verdict.trackedSessionCount}/${total} 집계 — 나머지는 §38 이전 버전)`);
    }
    lines.push(
      `  accepted: ${report.verdict.accepted}건, bounced: ${report.verdict.bounced}건, ` +
        `session_failed: ${report.verdict.sessionFailed}건, session_blocked: ${report.verdict.sessionBlocked}건`,
    );
    lines.push("  회송 사유:");
    for (const r of report.verdict.bounceReasons) {
      lines.push(`    ${r.reason}: ${r.count}건`);
    }
  }
  lines.push("");

  lines.push("[Phase 별 시도/세션/비용]");
  if (report.phases.length === 0) {
    lines.push("  (phase 없음)");
  } else {
    for (const p of report.phases) {
      lines.push(
        `  ${STATUS_ICON[p.status] ?? "?"} Phase ${p.id}: ${p.title} — ` +
          `시도 ${p.attempts}/${p.maxAttempts}, 세션 ${p.sessionCount}건, $${p.costUsd.toFixed(2)}`,
      );
    }
  }
  lines.push("");

  if (report.pendingQuestion) {
    lines.push(`❓ BLOCKED 질문 (Phase ${report.pendingQuestion.phase}):`);
    lines.push(`   ${report.pendingQuestion.question}`);
    lines.push("");
  }

  // §43 — 9번(피드백) 의 출구. 주행은 원래 목표로 끝내고, 범위 밖 발견은 여기 모아 사람에게
  // 보고한다. 다음 사이클을 열지는 사람이 결정한다 — 하네스는 판단하지 않고 재료만 낸다.
  lines.push("[범위 밖 발견 사항]");
  if (report.findings.length === 0) {
    lines.push("  (없음)");
  } else {
    for (const kind of FINDING_ORDER) {
      const group = report.findings.filter(f => f.kind === kind);
      if (group.length === 0) continue;
      lines.push(`  ${FINDING_LABEL[kind]} (${group.length}건):`);
      for (const f of group) lines.push(`    - [Phase ${f.phaseId}/${f.sessionKind}] ${f.detail}`);
    }
    lines.push("  → 이 중 무엇을 다음 사이클로 넘길지는 사람이 정합니다 (하네스는 PLAN 을 고치지 않습니다)");
  }
  lines.push("");

  // §47 — 되먹임의 출구. 하네스는 제안만 보여준다 — 고르는 것도, 여는 것도 사람이다.
  lines.push("[다음 목표 제안]");
  if (report.nextGoalSuggestions.length === 0) {
    lines.push("  (없음)");
  } else {
    for (const g of report.nextGoalSuggestions) lines.push(`  - ${g}`);
    lines.push('  → 다음 사이클: fw interview <새 디렉토리> --goal "<위 항목>"');
  }
  lines.push("");

  lines.push("[답변 이력]");
  if (report.answers.length === 0) {
    lines.push("  (없음)");
  } else {
    for (const a of report.answers) {
      const phasePart = a.phase !== undefined ? `Phase ${a.phase} — ` : "";
      lines.push(`  ${a.at} ${phasePart}Q: ${a.question}`);
      lines.push(`             A: ${a.answer}`);
    }
  }
  lines.push("");

  lines.push("[낼 수 없는 지표]");
  if (report.notComputable.length === 0) {
    lines.push("  (없음)");
  } else {
    for (const note of report.notComputable) lines.push(`  - ${note}`);
  }
  lines.push("");
  lines.push("※ 이 리포트는 판단 재료입니다 — 시도/비용이 적을수록 좋다는 뜻은 아닙니다 (PLAN D1)");

  return lines.join("\n");
}

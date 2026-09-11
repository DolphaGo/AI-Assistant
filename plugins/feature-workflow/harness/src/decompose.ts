// pr-slicing Phase 4: 런타임 phase 분해.
//
// 조각은 새 개념이 아니라 **phase** 다(PLAN D8). state.phases 배열에 phase 로 편입되므로
// 세션·커밋 검증·게이트·PR·머지 대기·이탈 감시가 전부 기존 배관을 그대로 탄다 — `phase.slices[]`
// 같은 하위 개념을 두면 그 배관이 두 벌이 되고, 이 하네스에서 §30 P1 이 세 라운드 연속
// 재발한 게 정확히 그 형태다.
//
// state.ts 가 아니라 별도 모듈인 이유: state.ts 는 이미 1,100줄이 넘고 이 파일의 관심사
// (분해 제안 검증 + phase 배열 재구성)는 STATE 스키마·불변식과 독립적이다. branch.ts/
// prloop.ts/halt.ts 를 orchestrator.ts 에서 떼어낸 것과 같은 분리다.
import type { State, Phase } from "./state.js";

/** 분해 세션이 제안하는 조각 하나. session.ts 의 출력 스키마가 이 형태를 미러링한다. */
export interface SliceProposal {
  title: string;
  next_steps: string[];
  /** 생략하면 원본 phase 의 verify 를 물려받는다 — 검증 없는 phase 를 만들지 않기 위함. */
  verify?: string[];
  /** 세션의 추정치. 하네스는 이 값을 신뢰하지 않고 관측용으로만 쓴다(실측은 PR 생성 시점). */
  estimated_lines?: number;
  /** "왜 이 경계가 하나의 리뷰 단위인가". 조각 PR 본문에 그대로 실려 리뷰어의 판단 근거가 된다. */
  rationale: string;
}

/**
 * 한 phase 를 나눌 수 있는 조각 수의 상한. 넘으면 거부한다 — 조각마다 PR 과 사람의 머지가
 * 한 번씩 붙으므로, 분해 세션이 20개로 쪼개면 리뷰 부담이 오히려 폭증한다.
 */
export const MAX_SLICES = 8;

export type DecomposeCheck = { ok: true } | { ok: false; problem: string };

const isBlank = (s: string): boolean => s.trim().length === 0;

/**
 * 분해 세션의 제안을 하네스가 직접 검증한다 — 세션 주장을 그대로 믿지 않는 이 리포의 원칙.
 * 조각이 하나뿐인 것은 **위반이 아니다**: "쪼갤 필요가 없다"는 판단도 분해 세션의 정당한
 * 결론이다(PLAN D13 — 쪼갤지 여부 자체를 세션에 맡긴다). 호출부가 length===1 을 보고
 * 분해 없이 진행한다.
 */
export function validateSliceProposals(slices: readonly SliceProposal[]): DecomposeCheck {
  if (slices.length === 0) {
    return { ok: false, problem: "조각 제안이 비어 있습니다 — 쪼개지 않겠다면 조각 1개로 반환하세요." };
  }
  if (slices.length > MAX_SLICES) {
    return {
      ok: false,
      problem:
        `조각이 ${slices.length}개입니다 — 최대 ${MAX_SLICES}개까지만 허용합니다. ` +
        "조각마다 PR 과 사람의 머지가 한 번씩 붙으므로 너무 잘게 쪼개면 리뷰 부담이 오히려 커집니다.",
    };
  }
  for (const [i, s] of slices.entries()) {
    const at = `조각 ${i + 1}`;
    if (isBlank(s.title)) return { ok: false, problem: `${at}: title 이 비어 있습니다.` };
    if (s.next_steps.length === 0 || s.next_steps.every(isBlank)) {
      return {
        ok: false,
        problem: `${at}: next_steps 가 비어 있습니다 — 다음 세션이 할 일 없이 시작하게 됩니다.`,
      };
    }
    if (isBlank(s.rationale)) {
      return {
        ok: false,
        problem: `${at}: rationale 이 비어 있습니다 — "왜 이 경계가 하나의 리뷰 단위인가"가 조각 PR 본문에 실려 리뷰어의 판단 근거가 됩니다.`,
      };
    }
  }
  return { ok: true };
}

/**
 * 원본 phase 를 조각들로 대체한다(PLAN D9). **state.phases 를 제자리에서 바꾼다.**
 *
 * id 배분: 조각 1..N-1 에 기존 최대 id 다음 번호를 주고, **마지막 조각이 원본 id 를
 * 물려받는다**. 배열에는 원본 자리 **앞에** 조각 1..N-1 을 끼워 넣는다.
 * 이 배치의 이유는 하나다 — 후속 phase 의 `depends_on: [원본 id]` 가 그대로 "조각 전체
 * 완료"를 가리켜 **기존 참조를 하나도 고치지 않아도 된다**. 참조를 재배선하는 방식은
 * 놓친 참조 하나가 조용한 의존성 오류로 남는다.
 *
 * 원본 phase 객체는 마지막 조각으로 **변형**한다(새 객체로 교체하지 않는다) — 호출부
 * (orchestrator)가 그 객체 참조를 들고 있기 때문이다.
 *
 * 조각 사이에는 depends_on 사슬을 건다. 배열 순서만으로도 selectNextPhase 는 순서대로
 * 고르지만, 순서에만 의존하면 나중에 배열을 정렬하는 코드가 생겼을 때 조각이 뒤섞인다.
 */
export function applyDecomposition(
  state: State,
  phase: Phase,
  slices: readonly SliceProposal[],
): void {
  const total = slices.length;
  if (total < 2) return; // 분해 없음 — 호출부가 이미 판단하지만 방어적으로 no-op

  const originIndex = state.phases.indexOf(phase);
  if (originIndex < 0) return; // 이 state 의 phase 가 아니다 — 손대지 않는다

  const maxId = state.phases.reduce((m, p) => Math.max(m, p.id), 0);
  const originDependsOn = [...phase.depends_on];
  const inheritedVerify = [...phase.verify];

  // 조각 1..N-1 (마지막 제외)을 새 phase 로 만든다.
  const inserted: Phase[] = [];
  let previousId: number | null = null;
  for (let i = 0; i < total - 1; i++) {
    const s = slices[i]!;
    const id = maxId + i + 1;
    inserted.push({
      id,
      title: s.title,
      status: "pending",
      // 첫 조각이 원본의 의존을 물려받고, 그 뒤는 앞 조각에 사슬로 붙는다.
      depends_on: previousId === null ? originDependsOn : [previousId],
      verify: s.verify && s.verify.length > 0 ? [...s.verify] : inheritedVerify,
      next_steps: [...s.next_steps],
      attempts: 0,
      max_attempts: phase.max_attempts,
      allow_verify_file_changes: phase.allow_verify_file_changes,
      allow_claude_md_changes: phase.allow_claude_md_changes,
      sessions: [],
      split_group: { origin_id: phase.id, index: i + 1, total },
      split_rationale: s.rationale,
    });
    previousId = id;
  }

  // 원본을 마지막 조각으로 변형한다.
  const last = slices[total - 1]!;
  phase.title = last.title;
  phase.next_steps = [...last.next_steps];
  phase.verify = last.verify && last.verify.length > 0 ? [...last.verify] : inheritedVerify;
  phase.depends_on = previousId === null ? originDependsOn : [previousId];
  phase.split_group = { origin_id: phase.id, index: total, total };
  phase.split_rationale = last.rationale;
  phase.status = "pending";
  phase.attempts = 0;
  // sessions 는 **비우지 않는다**. 이 시점에 원본에는 방금 끝난 분해 세션 기록(비용 포함)이
  // 들어 있고, 비우면 그 유료 세션이 비용 집계에서 통째로 사라진다(실측으로 잡힌 결함).
  // 시도 횟수는 새 작업 기준으로 0 이지만 이력은 감사 기록이라 성격이 다르다.

  state.phases.splice(originIndex, 0, ...inserted);
}

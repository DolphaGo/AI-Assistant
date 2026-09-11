// 런타임 phase 분해 전용 테스트 (docs/pr-slicing Phase 4).
//
// 조각은 새 개념이 아니라 phase 다(D8) — state.phases 배열에 phase 로 편입된다. 그래야
// 세션·게이트·PR·머지 대기·이탈 감시가 전부 기존 배관을 그대로 탄다.
//
// id 배분 규칙(D9)이 이 파일의 핵심 계약이다: 조각 1..N-1 에 새 id 를 주고 **마지막 조각이
// 원본 id 를 물려받으며**, 배열의 원본 자리 **앞에** 조각 1..N-1 을 끼워 넣는다. 이렇게 하면
// 후속 phase 의 depends_on:[원본 id] 이 그대로 "조각 전체 완료"를 가리켜 기존 참조를 하나도
// 고치지 않아도 된다.
import { describe, it, expect } from "vitest";
import {
  validateSliceProposals, applyDecomposition, MAX_SLICES, type SliceProposal,
} from "../src/decompose.js";
import { StateSchema, selectNextPhase, assertRunnable, type State } from "../src/state.js";

function makeState(): State {
  return StateSchema.parse({
    schema_version: 1, workflow: "wf", repo_root: "/tmp/r", branch_strategy: "isolate",
    allow_push: false, verify_default: ["npm test"], status: "running",
    pending_question: null, answers: [],
    phases: [
      { id: 1, title: "p1", status: "done", depends_on: [], verify: [], attempts: 0, max_attempts: 2, sessions: [] },
      { id: 2, title: "p2", status: "done", depends_on: [1], verify: [], attempts: 0, max_attempts: 2, sessions: [] },
      { id: 3, title: "구현", status: "pending", depends_on: [2], verify: ["./gradlew build"], attempts: 0, max_attempts: 3, sessions: [] },
      { id: 4, title: "p4", status: "pending", depends_on: [3], verify: [], attempts: 0, max_attempts: 2, sessions: [] },
    ],
  });
}

const slice = (n: number, over: Partial<SliceProposal> = {}): SliceProposal => ({
  title: `조각 ${n}`,
  next_steps: [`${n}번째 할 일`],
  rationale: `${n}번째 리뷰 단위인 이유`,
  ...over,
});

describe("validateSliceProposals", () => {
  it("정상 제안을 통과시킨다", () => {
    expect(validateSliceProposals([slice(1), slice(2)])).toEqual({ ok: true });
  });

  it("조각이 하나뿐인 것은 위반이 아니다 (분해하지 않겠다는 판단이다)", () => {
    expect(validateSliceProposals([slice(1)])).toEqual({ ok: true });
  });

  it("빈 목록은 거부한다 (판단 자체를 하지 않은 것이다)", () => {
    const r = validateSliceProposals([]);
    expect(r.ok).toBe(false);
  });

  it("next_steps 가 비어 있으면 거부한다 (다음 세션이 할 일 없이 시작한다)", () => {
    for (const bad of [[], ["  "], [""]]) {
      const r = validateSliceProposals([slice(1, { next_steps: bad }), slice(2)]);
      expect(r.ok, `거부해야 함: ${JSON.stringify(bad)}`).toBe(false);
      if (!r.ok) expect(r.problem).toMatch(/next_steps/);
    }
  });

  it("rationale 이 비어 있으면 거부한다 (리뷰어의 판단 근거가 사라진다)", () => {
    const r = validateSliceProposals([slice(1, { rationale: "   " }), slice(2)]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toMatch(/rationale|근거/);
  });

  it("title 이 비어 있으면 거부한다", () => {
    const r = validateSliceProposals([slice(1, { title: "" }), slice(2)]);
    expect(r.ok).toBe(false);
  });

  it(`조각이 ${MAX_SLICES}개를 넘으면 거부한다 (머지 횟수 폭주 방지)`, () => {
    const many = Array.from({ length: MAX_SLICES + 1 }, (_, i) => slice(i + 1));
    const r = validateSliceProposals(many);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toContain(String(MAX_SLICES));
  });

  it(`정확히 ${MAX_SLICES}개는 통과한다 (경계)`, () => {
    const exact = Array.from({ length: MAX_SLICES }, (_, i) => slice(i + 1));
    expect(validateSliceProposals(exact)).toEqual({ ok: true });
  });

  it("문제를 발견하면 몇 번째 조각인지 알려준다", () => {
    const r = validateSliceProposals([slice(1), slice(2, { rationale: "" })]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toContain("2");
  });
});

describe("applyDecomposition — id 배분과 삽입 순서 (D9)", () => {
  it("마지막 조각이 원본 phase id 를 물려받는다", () => {
    const s = makeState();
    const origin = s.phases.find(p => p.id === 3)!;
    applyDecomposition(s, origin, [slice(1), slice(2), slice(3)]);
    const group = s.phases.filter(p => p.split_group?.origin_id === 3);
    expect(group).toHaveLength(3);
    expect(group[group.length - 1]!.id).toBe(3);
  });

  it("조각 1..N-1 은 기존 최대 id 다음 번호를 받는다", () => {
    const s = makeState(); // max id = 4
    applyDecomposition(s, s.phases.find(p => p.id === 3)!, [slice(1), slice(2), slice(3)]);
    const group = s.phases.filter(p => p.split_group?.origin_id === 3);
    expect(group.map(p => p.id)).toEqual([5, 6, 3]);
  });

  it("배열에서 원본 자리 앞에 삽입해 실행 순서를 만든다", () => {
    const s = makeState();
    applyDecomposition(s, s.phases.find(p => p.id === 3)!, [slice(1), slice(2)]);
    expect(s.phases.map(p => p.id)).toEqual([1, 2, 5, 3, 4]);
  });

  it("후속 phase 의 depends_on 을 한 글자도 바꾸지 않는다 (D9 의 존재 이유)", () => {
    const s = makeState();
    const before = s.phases.find(p => p.id === 4)!.depends_on.slice();
    applyDecomposition(s, s.phases.find(p => p.id === 3)!, [slice(1), slice(2), slice(3)]);
    expect(s.phases.find(p => p.id === 4)!.depends_on).toEqual(before);
    expect(before).toEqual([3]); // 여전히 원본 id 를 가리키고, 그게 마지막 조각이다
  });

  it("조각들을 순서대로 실행하도록 depends_on 을 사슬로 잇는다", () => {
    const s = makeState();
    applyDecomposition(s, s.phases.find(p => p.id === 3)!, [slice(1), slice(2), slice(3)]);
    const [a, b, c] = s.phases.filter(p => p.split_group?.origin_id === 3);
    expect(a!.depends_on).toEqual([2]); // 원본의 의존을 첫 조각이 물려받는다
    expect(b!.depends_on).toEqual([a!.id]);
    expect(c!.depends_on).toEqual([b!.id]);
  });

  it("selectNextPhase 가 조각을 순서대로 고른다", () => {
    const s = makeState();
    applyDecomposition(s, s.phases.find(p => p.id === 3)!, [slice(1), slice(2), slice(3)]);
    const order: number[] = [];
    for (let i = 0; i < 3; i++) {
      const next = selectNextPhase(s)!;
      order.push(next.id);
      next.status = "done";
    }
    expect(order).toEqual([5, 6, 3]);
    expect(selectNextPhase(s)!.id).toBe(4); // 조각이 전부 끝나야 후속 phase 로 간다
  });
});

describe("applyDecomposition — 조각 phase 의 내용", () => {
  it("split_group 에 원본 id 와 위치를 담는다", () => {
    const s = makeState();
    applyDecomposition(s, s.phases.find(p => p.id === 3)!, [slice(1), slice(2), slice(3)]);
    const group = s.phases.filter(p => p.split_group?.origin_id === 3);
    expect(group.map(p => p.split_group)).toEqual([
      { origin_id: 3, index: 1, total: 3 },
      { origin_id: 3, index: 2, total: 3 },
      { origin_id: 3, index: 3, total: 3 },
    ]);
  });

  it("분해 근거를 split_rationale 에 담는다 (조각 PR 본문에 실린다)", () => {
    const s = makeState();
    applyDecomposition(s, s.phases.find(p => p.id === 3)!, [
      slice(1, { rationale: "인터페이스만 추가한다" }), slice(2),
    ]);
    expect(s.phases.find(p => p.id === 5)!.split_rationale).toBe("인터페이스만 추가한다");
  });

  it("verify 를 생략한 조각은 원본의 verify 를 물려받는다 (검증 없는 phase 를 만들지 않는다)", () => {
    const s = makeState();
    applyDecomposition(s, s.phases.find(p => p.id === 3)!, [slice(1), slice(2)]);
    for (const p of s.phases.filter(x => x.split_group?.origin_id === 3)) {
      expect(p.verify).toEqual(["./gradlew build"]);
    }
  });

  it("조각이 자기 verify 를 주면 그것을 쓴다", () => {
    const s = makeState();
    applyDecomposition(s, s.phases.find(p => p.id === 3)!, [
      slice(1, { verify: ["npm run lint"] }), slice(2),
    ]);
    expect(s.phases.find(p => p.id === 5)!.verify).toEqual(["npm run lint"]);
  });

  it("분해 후에도 assertRunnable 을 통과한다 (검증 없는 phase·순환·중복 id 가 없다)", () => {
    const s = makeState();
    applyDecomposition(s, s.phases.find(p => p.id === 3)!, [slice(1), slice(2), slice(3)]);
    expect(() => assertRunnable(s)).not.toThrow();
  });

  it("원본의 max_attempts 와 옵트아웃 플래그를 물려받는다", () => {
    const s = makeState();
    const origin = s.phases.find(p => p.id === 3)!;
    origin.allow_verify_file_changes = true;
    origin.allow_claude_md_changes = true;
    applyDecomposition(s, origin, [slice(1), slice(2)]);
    for (const p of s.phases.filter(x => x.split_group?.origin_id === 3)) {
      expect(p.max_attempts).toBe(3);
      expect(p.allow_verify_file_changes).toBe(true);
      expect(p.allow_claude_md_changes).toBe(true);
    }
  });

  it("원본의 세션 이력은 마지막 조각에 보존한다 (분해 세션 기록·비용이 사라지면 안 된다)", () => {
    const s = makeState();
    const origin = s.phases.find(p => p.id === 3)!;
    origin.sessions = [
      { session_id: "dec1", result: "done", at: "t", kind: "decompose", cost_usd: 0.5 },
    ];
    applyDecomposition(s, origin, [slice(1), slice(2)]);
    const last = s.phases.find(p => p.id === 3)!;
    expect(last.sessions).toHaveLength(1);
    expect(last.sessions[0]!.kind).toBe("decompose");
    expect(last.sessions[0]!.cost_usd).toBe(0.5);
  });

  it("새로 만든 조각들은 시도 기록이 비어 있다", () => {
    const s = makeState();
    applyDecomposition(s, s.phases.find(p => p.id === 3)!, [slice(1), slice(2)]);
    for (const p of s.phases.filter(x => x.split_group?.origin_id === 3)) {
      expect(p.status).toBe("pending");
      expect(p.attempts).toBe(0);
    }
    // 새로 삽입된 조각(원본 id 가 아닌 것)만 시도 기록이 비어 있다.
    expect(s.phases.find(p => p.id === 5)!.sessions).toEqual([]);
  });

  it("결과가 STATE 스키마를 그대로 통과한다 (저장 가능한 상태여야 한다)", () => {
    const s = makeState();
    applyDecomposition(s, s.phases.find(p => p.id === 3)!, [slice(1), slice(2), slice(3)]);
    expect(() => StateSchema.parse(s)).not.toThrow();
  });
});

// 인라인 리뷰 코멘트 — 조각 PR 의 "읽는 순서"를 Files changed 의 코드 위에 붙인다.
//
// **실측이 이 파일의 설계를 결정했다** (GHE 3.19, PR #5 왕복):
//   · diff 에 없는 줄을 주면 422 `line must be part of the diff` — 그리고 리뷰 하나에 코멘트를
//     묶어 보내므로 **앵커 하나만 틀려도 코멘트 전체가 거부된다**. 그래서 앵커는 세션의 추측이
//     아니라 diff 에서 뽑은 값만 쓴다(하나라도 추측이 섞이면 전부 잃는다).
//   · `subject_type:"file"` 은 422 `Field is not defined on DraftPullRequestReviewComment` —
//     리뷰 API 로는 파일 단위 코멘트를 못 붙인다. 그래서 붙일 곳이 없는 파일은 인라인을
//     포기하고 본문에 남긴다.
//   · `side:"LEFT"` + 삭제된 줄은 통과한다 — 삭제만 있는 파일의 앵커로 쓸 수 있다.
import { describe, it, expect } from "vitest";
import {
  parseDiffAnchors, planReviewOrder, buildReviewPayload,
  type DiffAnchor,
} from "../src/inlinereview.js";

// `git diff -U0` 실측 출력 형태. 헤더 3줄(diff/index/---/+++) 뒤에 @@ hunk 가 온다.
function fileDiff(path: string, hunks: string[], opts: { oldPath?: string } = {}): string {
  const oldSide = opts.oldPath === undefined ? `a/${path}` : opts.oldPath;
  const newSide = path === "/dev/null" ? "/dev/null" : `b/${path}`;
  return [
    `diff --git a/${path} b/${path}`,
    `index 1111111..2222222 100644`,
    `--- ${oldSide}`,
    `+++ ${newSide}`,
    ...hunks,
  ].join("\n");
}

describe("parseDiffAnchors — diff 에서 코멘트 가능 지점을 뽑는다", () => {
  it("추가가 있는 hunk 는 새 쪽 시작 줄에 RIGHT 로 붙인다 (PR #5 실측 헤더)", () => {
    const out = fileDiff("src/cli.ts", ["@@ -193 +193,5 @@ export function formatStatus() {", "-old", "+new"]);
    expect(parseDiffAnchors(out)).toEqual([{ path: "src/cli.ts", line: 193, side: "RIGHT" }]);
  });

  it("삭제 0개인 순수 추가 hunk 도 새 쪽 시작 줄이다 (PR #5 실측 헤더)", () => {
    const out = fileDiff("test/cli.test.ts", ["@@ -26,0 +27,30 @@ describe(\"formatStatus\", () => {", "+x"]);
    expect(parseDiffAnchors(out)).toEqual([{ path: "test/cli.test.ts", line: 27, side: "RIGHT" }]);
  });

  it("카운트가 생략된 헤더는 1개로 읽는다 (@@ -1 +1 @@)", () => {
    const out = fileDiff("a.ts", ["@@ -1 +1 @@", "-x", "+y"]);
    expect(parseDiffAnchors(out)).toEqual([{ path: "a.ts", line: 1, side: "RIGHT" }]);
  });

  it("삭제만 있는 파일은 옛 쪽 줄에 LEFT 로 붙인다 (붙일 새 줄이 없다 — 실측으로 통과 확인)", () => {
    const out = fileDiff("a.ts", ["@@ -10,5 +9,0 @@", "-x"]);
    expect(parseDiffAnchors(out)).toEqual([{ path: "a.ts", line: 10, side: "LEFT" }]);
  });

  it("삭제 1줄이라 옛 카운트가 생략된 헤더도 LEFT 로 붙인다 (@@ -5 +4,0 @@)", () => {
    const out = fileDiff("a.ts", ["@@ -5 +4,0 @@", "-x"]);
    expect(parseDiffAnchors(out)).toEqual([{ path: "a.ts", line: 5, side: "LEFT" }]);
  });

  it("내용 줄이 hunk 헤더처럼 보여도 헤더로 읽지 않는다 (내용에는 항상 +/- 접두가 붙는다)", () => {
    const out = fileDiff("a.ts", ["@@ -1,2 +1,0 @@", "-@@ -1 +1,900 @@", "-x"]);
    expect(parseDiffAnchors(out)).toEqual([{ path: "a.ts", line: 1, side: "LEFT" }]);
  });

  it("삭제 hunk 가 먼저 나와도 추가하는 hunk 를 앵커로 고른다 (리뷰어를 새 코드에 내려놓는다)", () => {
    const out = fileDiff("a.ts", [
      "@@ -10,3 +9,0 @@", "-gone",
      "@@ -40,0 +38,4 @@", "+added",
    ]);
    expect(parseDiffAnchors(out)).toEqual([{ path: "a.ts", line: 38, side: "RIGHT" }]);
  });

  it("추가 hunk 가 여러 개면 첫 번째를 쓴다", () => {
    const out = fileDiff("a.ts", ["@@ -5,0 +6,2 @@", "+a", "@@ -50,0 +60,2 @@", "+b"]);
    expect(parseDiffAnchors(out)).toEqual([{ path: "a.ts", line: 6, side: "RIGHT" }]);
  });

  it("삭제 hunk 가 여러 개면 첫 번째를 쓴다 (뒤 hunk 가 앵커를 밀어내지 않는다)", () => {
    const out = fileDiff("a.ts", ["@@ -10,2 +9,0 @@", "-x", "@@ -80,3 +77,0 @@", "-y"]);
    expect(parseDiffAnchors(out)).toEqual([{ path: "a.ts", line: 10, side: "LEFT" }]);
  });

  it("내용까지 바뀐 이름변경은 새 경로에 붙인다 (옛 경로는 GitHub 이 받지 않는다)", () => {
    const out = [
      `diff --git a/old.ts b/new.ts`,
      `similarity index 80%`,
      `rename from old.ts`,
      `rename to new.ts`,
      `--- a/old.ts`,
      `+++ b/new.ts`,
      `@@ -3,0 +4,2 @@`,
      `+x`,
    ].join("\n");
    expect(parseDiffAnchors(out)).toEqual([{ path: "new.ts", line: 4, side: "RIGHT" }]);
  });

  it("파일이 여러 개면 각각 앵커를 낸다", () => {
    const out = [
      fileDiff("a.ts", ["@@ -1 +1,2 @@", "+a"]),
      fileDiff("b.ts", ["@@ -7,2 +8,0 @@", "-b"]),
    ].join("\n");
    expect(parseDiffAnchors(out)).toEqual([
      { path: "a.ts", line: 1, side: "RIGHT" },
      { path: "b.ts", line: 7, side: "LEFT" },
    ]);
  });

  it("새로 만든 파일도 RIGHT 로 붙는다 (--- /dev/null)", () => {
    const out = fileDiff("new.ts", ["@@ -0,0 +1,9 @@", "+x"], { oldPath: "/dev/null" });
    expect(parseDiffAnchors(out)).toEqual([{ path: "new.ts", line: 1, side: "RIGHT" }]);
  });

  it("삭제된 파일은 옛 경로에 LEFT 로 붙는다 (+++ /dev/null 이라 새 쪽에 경로가 없다)", () => {
    const out = [
      `diff --git a/gone.ts b/gone.ts`,
      `deleted file mode 100644`,
      `index 1111111..0000000`,
      `--- a/gone.ts`,
      `+++ /dev/null`,
      `@@ -1,12 +0,0 @@`,
      `-x`,
    ].join("\n");
    expect(parseDiffAnchors(out)).toEqual([{ path: "gone.ts", line: 1, side: "LEFT" }]);
  });

  it("바이너리 파일은 앵커가 없다 (hunk 가 없어 붙일 줄이 존재하지 않는다)", () => {
    const out = [
      `diff --git a/logo.png b/logo.png`,
      `index 1111111..2222222 100644`,
      `Binary files a/logo.png and b/logo.png differ`,
    ].join("\n");
    expect(parseDiffAnchors(out)).toEqual([]);
  });

  it("내용 변경 없는 이름변경은 앵커가 없다", () => {
    const out = [
      `diff --git a/old.ts b/new.ts`,
      `similarity index 100%`,
      `rename from old.ts`,
      `rename to new.ts`,
    ].join("\n");
    expect(parseDiffAnchors(out)).toEqual([]);
  });

  it("추가도 삭제도 0인 헤더는 앵커로 쓰지 않는다 (붙이면 422 로 리뷰 전체가 날아간다)", () => {
    const out = fileDiff("a.ts", ["@@ -0,0 +0,0 @@"]);
    expect(parseDiffAnchors(out)).toEqual([]);
  });

  it("git 이 인용한 경로는 앵커를 만들지 않는다 (경로 오인 대신 본문 강등이 안전하다)", () => {
    const out = [
      `diff --git "a/a\\tb.ts" "b/a\\tb.ts"`,
      `--- "a/a\\tb.ts"`,
      `+++ "b/a\\tb.ts"`,
      `@@ -1 +1,2 @@`,
      `+x`,
    ].join("\n");
    expect(parseDiffAnchors(out)).toEqual([]);
  });

  it("diff 내용이 diff 처럼 보여도 헤더로 오인하지 않는다", () => {
    // `-- a/x` 라는 줄이 삭제되면 출력에 `-` 접두가 붙어 `--- a/x` 가 되고, `++ b/x` 가
    // 추가되면 `+++ b/x` 가 된다 — 둘 다 파일 헤더와 글자 그대로 구별할 수 없다. (`@@` 로
    // 시작하는 줄은 위조할 수 없다: 내용 줄에는 항상 `+`/`-` 접두가 붙는다.)
    //
    // 첫 파일은 hunk 를 **삭제만** 있는 것으로 둔다 — 추가 hunk 가 있으면 앵커가 이미 잠겨
    // 위조가 우연히 막힌다. 잠기지 않은 상태가 진짜 노출 조건이다.
    const out = [
      fileDiff("real.ts", ["@@ -5,2 +4,0 @@", "--- a/spoofed.ts", "-gone"]),
      fileDiff("two.ts", ["@@ -9,0 +10 @@", "+++ b/spoofed.ts"]),
    ].join("\n");
    expect(parseDiffAnchors(out)).toEqual([
      { path: "real.ts", line: 5, side: "LEFT" },
      { path: "two.ts", line: 10, side: "RIGHT" },
    ]);
  });

  it("hunk 가 시작된 뒤의 경로 헤더는 무시한다 (계약)", () => {
    // 위 테스트의 위조 헤더는 **지금은** 결과를 바꾸지 못한다: 오염된 경로가 쓰이려면 뒤따르는
    // hunk 가 처리돼야 하는데, 추가가 있는 hunk 는 즉시 앵커를 잠그고 삭제만 있는 hunk 의 내용
    // 줄은 전부 `-` 접두라 `+++` 를 위조할 수 없다. 즉 오늘의 안전은 `locked` 와 "새 경로 우선"
    // 이라는 **다른 두 불변식에 얹혀 있다** — 그 둘 중 하나만 바뀌면 diff 에 없는 파일에
    // 코멘트가 붙어 422 로 리뷰 전체가 날아간다.
    //
    // 그래서 git 이 오늘 내지는 않는 형태를 직접 만들어 계약 자체를 못박는다: "경로 헤더는
    // hunk 시작 전에만 읽는다". 이 입력이 인위적이라는 점을 숨기지 않는다 — 관측된 사례가
    // 아니라 구조를 고정하는 테스트다.
    const craftedNewSide = [
      `diff --git a/real.ts b/real.ts`,
      `--- a/real.ts`,
      `+++ b/real.ts`,
      `@@ -5,2 +4,0 @@`,
      `+++ b/spoofed.ts`,
      `@@ -40,0 +38,2 @@`,
      `+added`,
    ].join("\n");
    expect(parseDiffAnchors(craftedNewSide)).toEqual([{ path: "real.ts", line: 38, side: "RIGHT" }]);

    // 옛 경로(`--- `)가 실제로 쓰이는 것은 삭제된 파일(`+++ /dev/null`)뿐이므로 그 형태로도
    // 따로 못박는다 — 새 경로 쪽만 덮으면 이 분기는 검증되지 않는다.
    const craftedOldSide = [
      `diff --git a/gone.ts b/gone.ts`,
      `--- a/gone.ts`,
      `+++ /dev/null`,
      `@@ -1,2 +0,0 @@`,
      `--- a/spoofed.ts`,
      `@@ -50,0 +48,2 @@`,
      `+added`,
    ].join("\n");
    expect(parseDiffAnchors(craftedOldSide)).toEqual([{ path: "gone.ts", line: 48, side: "RIGHT" }]);
  });

  it("경로가 빈 헤더는 앵커를 만들지 않는다 (빈 경로 코멘트는 리뷰 전체를 422 로 만든다)", () => {
    const out = [`diff --git a/x b/x`, `--- a/`, `+++ b/`, `@@ -1 +1,2 @@`, `+x`].join("\n");
    expect(parseDiffAnchors(out)).toEqual([]);
  });

  it("빈 출력은 빈 목록이다", () => {
    expect(parseDiffAnchors("")).toEqual([]);
  });

  it("실제 git diff -U0 출력에서 앵커를 뽑는다 (PR #5 에서 그대로 캡처)", () => {
    // 합성 fixture 가 형식을 잘못 가정했을 수 있으므로 실제 출력으로 한 번 못박는다.
    // 본문에 백틱·${} 가 있어 템플릿 리터럴을 쓸 수 없다 — 배열로 조립한다.
    const real = [
      "diff --git a/plugins/feature-workflow/harness/src/cli.ts b/plugins/feature-workflow/harness/src/cli.ts",
      "index f8fa87c..96f9079 100644",
      "--- a/plugins/feature-workflow/harness/src/cli.ts",
      "+++ b/plugins/feature-workflow/harness/src/cli.ts",
      "@@ -193 +193,5 @@ export function formatStatus(state: State): string {",
      "-      const lines = [`${STATUS_ICON[p.status]} Phase ${p.id}: ${p.title}`];",
      "+      // pr-slicing: 조각으로 분해된 phase 는 조각 번호를 덧붙인다.",
      "+      const splitPart = p.split_group ? ` (조각 ${p.split_group.index}/${p.split_group.total})` : \"\";",
      "+      const lines = [`${STATUS_ICON[p.status]} Phase ${p.id}: ${p.title}${splitPart}`];",
      "diff --git a/plugins/feature-workflow/harness/test/cli.test.ts b/plugins/feature-workflow/harness/test/cli.test.ts",
      "index 3333333..4444444 100644",
      "--- a/plugins/feature-workflow/harness/test/cli.test.ts",
      "+++ b/plugins/feature-workflow/harness/test/cli.test.ts",
      "@@ -26,0 +27,30 @@ describe(\"formatStatus\", () => {",
      "+  it(\"split_group 이 있으면 조각 표기를 낸다\", () => {",
      "+  });",
    ].join("\n");
    expect(parseDiffAnchors(real)).toEqual([
      { path: "plugins/feature-workflow/harness/src/cli.ts", line: 193, side: "RIGHT" },
      { path: "plugins/feature-workflow/harness/test/cli.test.ts", line: 27, side: "RIGHT" },
    ]);
  });

  it("헤더 없이 hunk 만 있는 깨진 입력은 앵커를 만들지 않는다", () => {
    expect(parseDiffAnchors("@@ -1 +1,2 @@\n+x\n")).toEqual([]);
  });
});

const anchor = (path: string, line = 10, side: DiffAnchor["side"] = "RIGHT"): DiffAnchor =>
  ({ path, line, side });

describe("planReviewOrder — 순서는 본문, 위치와 이유는 인라인", () => {
  it("앵커가 있으면 인라인 코멘트를 만들고 본문에서는 그 항목을 뺀다", () => {
    const plan = planReviewOrder(
      ["src/a.ts — 새 필드 정의가 여기 있다", "test/a.test.ts — 그 검증이 여기 있다"],
      [anchor("src/a.ts", 12), anchor("test/a.test.ts", 30)],
    );
    expect(plan.comments).toEqual([
      {
        path: "src/a.ts", line: 12, side: "RIGHT",
        body: "**1/2 — 여기부터 읽으세요**\n\n새 필드 정의가 여기 있다",
      },
      {
        path: "test/a.test.ts", line: 30, side: "RIGHT",
        body: "**2/2**\n\n그 검증이 여기 있다",
      },
    ]);
    // 이유는 코드 위에 있고 순서도 코멘트의 `N/M` 이 말해준다 — 본문에 또 적지 않는다.
    expect(plan.bodyLines).toEqual([]);
  });

  it("앵커가 없는 항목은 본문에 이유까지 그대로 남긴다 (정보가 사라지지 않는다)", () => {
    const plan = planReviewOrder(["docs/x.md — 배경 설명"], []);
    expect(plan.comments).toEqual([]);
    expect(plan.bodyLines).toEqual(["1. docs/x.md — 배경 설명"]);
  });

  it("섞여 있어도 번호는 전체 순서를 유지한다 (인라인 간 항목이 본문에서 사라지지 않는다)", () => {
    const plan = planReviewOrder(
      ["docs/x.md — 배경", "src/a.ts — 본체", "logo.png — 아이콘 교체"],
      [anchor("src/a.ts", 5)],
    );
    expect(plan.comments).toHaveLength(1);
    expect(plan.comments[0]!.body).toBe("**2/3**\n\n본체");
    // 인라인으로 간 2번은 빠지고, 못 간 항목만 **전체 기준 번호를 유지한 채** 남는다 —
    // 남은 번호 자체가 "몇 번째로 볼 것인가" 라는 정보다.
    expect(plan.bodyLines).toEqual([
      "1. docs/x.md — 배경",
      "3. logo.png — 아이콘 교체",
    ]);
  });

  it("삭제만 있는 파일의 LEFT 앵커를 그대로 쓴다", () => {
    const plan = planReviewOrder(["src/old.ts — 이 경로가 사라진다"], [anchor("src/old.ts", 40, "LEFT")]);
    expect(plan.comments[0]).toEqual({
      path: "src/old.ts", line: 40, side: "LEFT",
      body: "**1/1 — 여기부터 읽으세요**\n\n이 경로가 사라진다",
    });
  });

  it("em dash 가 없어도 첫 토큰을 경로로 읽는다", () => {
    const plan = planReviewOrder(["src/a.ts 여기가 핵심이다"], [anchor("src/a.ts", 3)]);
    expect(plan.comments[0]!.path).toBe("src/a.ts");
    expect(plan.comments[0]!.body).toBe("**1/1 — 여기부터 읽으세요**\n\n여기가 핵심이다");
  });

  it("경로 뒤 콜론과 ./ 접두를 흡수한다", () => {
    const plan = planReviewOrder(["./src/a.ts: 이유"], [anchor("src/a.ts", 3)]);
    expect(plan.comments).toHaveLength(1);
    expect(plan.comments[0]!.path).toBe("src/a.ts");
    expect(plan.bodyLines).toEqual([]);
  });

  it("백틱으로 감싼 경로를 흡수한다 (세션은 마크다운으로 쓴다)", () => {
    const plan = planReviewOrder(["`src/a.ts` — 이유"], [anchor("src/a.ts", 3)]);
    expect(plan.comments).toHaveLength(1);
    expect(plan.comments[0]!.path).toBe("src/a.ts");
    expect(plan.bodyLines).toEqual([]);
  });

  it("세션이 짧게 쓴 경로도 유일하게 대응되면 붙인다", () => {
    const plan = planReviewOrder(["cli.ts — 조립부"], [anchor("plugins/fw/harness/src/cli.ts", 9)]);
    expect(plan.comments[0]!.path).toBe("plugins/fw/harness/src/cli.ts");
  });

  it("짧은 경로가 여러 파일에 걸리면 붙이지 않는다 (엉뚱한 파일에 박히는 것보다 본문이 낫다)", () => {
    const plan = planReviewOrder(
      ["cli.ts — 조립부"],
      [anchor("src/cli.ts", 9), anchor("test/cli.ts", 4)],
    );
    expect(plan.comments).toEqual([]);
    expect(plan.bodyLines).toEqual(["1. cli.ts — 조립부"]);
  });

  it("같은 경로의 앵커가 둘이면 어느 쪽인지 모르므로 붙이지 않는다", () => {
    const plan = planReviewOrder(["src/a.ts — 이유"], [anchor("src/a.ts", 3), anchor("src/a.ts", 90)]);
    expect(plan.comments).toEqual([]);
    expect(plan.bodyLines).toEqual(["1. src/a.ts — 이유"]);
  });

  it("경로 조각이 세그먼트 경계에 맞지 않으면 대응시키지 않는다", () => {
    const plan = planReviewOrder(["li.ts — 조립부"], [anchor("src/cli.ts", 9)]);
    expect(plan.comments).toEqual([]);
  });

  it("이유가 없으면 인라인을 만들지 않는다 (할 말이 없는 코멘트를 남기지 않는다)", () => {
    const plan = planReviewOrder(["src/a.ts"], [anchor("src/a.ts", 3)]);
    expect(plan.comments).toEqual([]);
    expect(plan.bodyLines).toEqual(["1. src/a.ts"]);
  });

  it("항목의 개행을 접는다 (목록 구조를 깨서 다음 항목을 위조하는 것을 막는다)", () => {
    const plan = planReviewOrder(["src/a.ts — 첫 줄\n2. 위조된 항목"], [anchor("src/a.ts", 3)]);
    expect(plan.comments[0]!.body).toBe("**1/1 — 여기부터 읽으세요**\n\n첫 줄 2. 위조된 항목");
    expect(plan.bodyLines).toEqual([]);
  });

  it("빈 항목은 번호에서도 빠진다", () => {
    const plan = planReviewOrder(["  ", "src/a.ts — 이유"], [anchor("src/a.ts", 3)]);
    expect(plan.comments[0]!.body).toBe("**1/1 — 여기부터 읽으세요**\n\n이유");
    expect(plan.bodyLines).toEqual([]);
  });

  it("항목이 없으면 둘 다 비어 있다", () => {
    expect(planReviewOrder([], [anchor("src/a.ts")])).toEqual({ comments: [], bodyLines: [] });
  });

  it("두 항목이 같은 파일을 지목하면 둘 다 붙인다 (이유가 각각 다르다)", () => {
    const plan = planReviewOrder(
      ["src/a.ts — 앞쪽 변경", "src/a.ts — 뒤쪽 변경"],
      [anchor("src/a.ts", 3)],
    );
    expect(plan.comments.map(c => c.body)).toEqual([
      "**1/2 — 여기부터 읽으세요**\n\n앞쪽 변경",
      "**2/2**\n\n뒤쪽 변경",
    ]);
  });
});

describe("buildReviewPayload — gh api --input 으로 보낼 JSON", () => {
  const comments = [{ path: "src/a.ts", line: 3, side: "RIGHT" as const, body: "왜" }];
  const payload = (
    cs: readonly { path: string; line: number; side: "RIGHT" | "LEFT"; body: string }[] = comments,
  ): { event: string; body: string; comments: Record<string, unknown>[] } =>
    JSON.parse(buildReviewPayload({ comments: cs, intro: "안내", sentinel: "[fw-harness]" }));

  it("event 는 COMMENT 다 (APPROVE/REQUEST_CHANGES 는 사람의 판정이다)", () => {
    expect(payload().event).toBe("COMMENT");
  });

  it("코멘트와 안내문을 싣는다", () => {
    const p = payload();
    expect(p.body).toContain("안내");
    expect(p.comments[0]).toMatchObject({ path: "src/a.ts", line: 3, side: "RIGHT" });
    expect(p.comments[0]!.body).toContain("왜");
  });

  it("모든 본문이 센티널로 시작한다 (하네스가 자기 코멘트를 지시로 되읽는 고리를 끊는다)", () => {
    const p = payload([...comments, { path: "b.ts", line: 9, side: "LEFT", body: "왜2" }]);
    expect(p.body.startsWith("[fw-harness]\n")).toBe(true);
    for (const c of p.comments) {
      expect(String(c.body).startsWith("[fw-harness]\n")).toBe(true);
    }
  });

  it("세션이 쓴 @fw 가 섞여도 센티널이 앞에 있어 트리거로 읽히지 않는다", () => {
    const p = payload([{ path: "a.ts", line: 1, side: "RIGHT", body: "@fw 이걸 고쳐라" }]);
    // isTriggerComment 는 trimStart().startsWith(센티널) 로 판정한다 — 첫 줄이어야 한다.
    expect(String(p.comments[0]!.body).trimStart().startsWith("[fw-harness]")).toBe(true);
  });

  it("실측으로 거부된 필드를 싣지 않는다 (subject_type / position)", () => {
    const p = payload();
    expect(p.comments[0]).not.toHaveProperty("subject_type");
    expect(p.comments[0]).not.toHaveProperty("position");
  });

  it("여러 코멘트를 하나의 리뷰로 묶는다 (알림 1회 · 전부-아니면-전무)", () => {
    expect(payload([...comments, { path: "b.ts", line: 9, side: "LEFT", body: "왜2" }]).comments)
      .toHaveLength(2);
  });
});

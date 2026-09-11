import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractSection, readPlanContext, appendDecisionRow, nextDecisionId, appendDecisionToPlan, type DecisionRow } from "../src/plan.js";

describe("extractSection", () => {
  it("정확히 일치하는 제목의 절을 추출한다", () => {
    const md = `# 제목\n\n## 용어\n\n| 용어 | 정의 |\n|---|---|\n| isolate | 격리 |\n\n## 다음 절\n무관한 내용\n`;
    expect(extractSection(md, "용어")).toBe("| 용어 | 정의 |\n|---|---|\n| isolate | 격리 |");
  });

  it("제목이 없으면 null", () => {
    const md = `# 제목\n\n## 다른 절\n내용\n`;
    expect(extractSection(md, "핵심 결정")).toBeNull();
  });

  it("절 내용이 비어 있으면 null (헤딩 바로 다음이 또 헤딩)", () => {
    const md = `## 핵심 결정\n## 다음 절\n내용\n`;
    expect(extractSection(md, "핵심 결정")).toBeNull();
  });

  // §28 요구: "## 핵심 결정 사항", "## 핵심 결정 사항 / 제약", "## 핵심 결정" 등을 관대하게 매치
  it.each([
    ["## 핵심 결정 사항", "핵심 결정"],
    ["## 핵심 결정 사항 / 제약", "핵심 결정"],
    ["## 핵심 결정", "핵심 결정"],
    ["## 용어", "용어"],
    ["## 용어 / 글로서리", "용어"],
  ])("제목 변형 '%s' 를 keyword '%s' 로 관대하게 매치한다", (headingLine, keyword) => {
    const md = `${headingLine}\n본문 내용\n`;
    expect(extractSection(md, keyword)).toBe("본문 내용");
  });

  it("무관한 제목(최종 결정)은 매치하지 않는다 — 접두 매칭이지 부분 포함 매칭이 아니다", () => {
    const md = `## 최종 결정\n엉뚱한 내용\n`;
    expect(extractSection(md, "핵심 결정")).toBeNull();
  });

  it("다음 같은 레벨 제목에서 절이 끝난다 (더 깊은 하위 제목은 포함)", () => {
    const md = [
      "## 핵심 결정",
      "결정 A",
      "### 하위 결정",
      "결정 A의 세부사항",
      "## 용어",
      "용어 내용",
    ].join("\n");
    const section = extractSection(md, "핵심 결정");
    expect(section).toContain("결정 A");
    expect(section).toContain("### 하위 결정");
    expect(section).toContain("결정 A의 세부사항");
    expect(section).not.toContain("용어 내용");
  });

  it("더 상위 레벨 제목에서도 절이 끝난다", () => {
    const md = ["## 핵심 결정", "결정 내용", "# 다음 최상위 절", "무관한 내용"].join("\n");
    const section = extractSection(md, "핵심 결정");
    expect(section).toBe("결정 내용");
  });

  it("문서 끝까지 다음 제목이 없으면 끝까지 추출한다", () => {
    const md = ["## 핵심 결정", "결정 내용 1", "결정 내용 2"].join("\n");
    expect(extractSection(md, "핵심 결정")).toBe("결정 내용 1\n결정 내용 2");
  });
});

describe("readPlanContext — §30 P2: 방어가 정상 경로를 막지 않는다", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-plan-test-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("PLAN.md 가 없는 워크플로우 → 예외 없이 {decisions:null, glossary:null}, diagnostics.planFound=false", () => {
    expect(() => readPlanContext(dir)).not.toThrow();
    const ctx = readPlanContext(dir);
    expect(ctx.decisions).toBeNull();
    expect(ctx.glossary).toBeNull();
    expect(ctx.diagnostics).toEqual({
      planFound: false,
      decisionsHeading: null,
      glossaryHeading: null,
      decisionsChars: 0,
      glossaryChars: 0,
    });
  });

  it("§핵심 결정/§용어 절이 없는 기존 산문 PLAN → 예외 없이 동작, nulls, diagnostics 는 planFound=true·헤딩 null", () => {
    fs.writeFileSync(
      path.join(dir, "PLAN.md"),
      "# 마이그레이션 플랜\n\n이건 그냥 산문으로 쓰인 오래된 PLAN 이다. 결정이나 용어 절이 없다.\n",
    );
    expect(() => readPlanContext(dir)).not.toThrow();
    const ctx = readPlanContext(dir);
    expect(ctx.decisions).toBeNull();
    expect(ctx.glossary).toBeNull();
    expect(ctx.acceptance).toBeNull(); // §42
    expect(ctx.architecture).toBeNull(); // §44
    expect(ctx.diagnostics).toEqual({
      planFound: true,
      decisionsHeading: null,
      glossaryHeading: null,
      acceptanceHeading: null,
      architectureHeading: null,
      decisionsChars: 0,
      glossaryChars: 0,
      acceptanceChars: 0,
      architectureChars: 0,
    });
  });

  it("절이 있는 새 형식 PLAN → 결정/용어가 추출된다", () => {
    fs.writeFileSync(
      path.join(dir, "PLAN.md"),
      [
        "# 플랜",
        "",
        "## 핵심 결정 사항",
        "",
        "> 표 형식 유지 — 하네스가 파싱한다.",
        "",
        "| ID | 결정 | 상태 |",
        "|----|------|------|",
        "| D1 | 브랜치 전략은 사용자에게 위임 | accepted |",
        "",
        "## 용어",
        "",
        "| 용어 | 정의 |",
        "|------|------|",
        "| isolate | fw/<workflow> 브랜치로 격리 |",
      ].join("\n"),
    );
    const ctx = readPlanContext(dir);
    expect(ctx.decisions).toContain("D1");
    expect(ctx.decisions).toContain("브랜치 전략은 사용자에게 위임");
    expect(ctx.glossary).toContain("isolate");
  });

  it("절 안의 인용 블록(> ...)은 제거된다", () => {
    fs.writeFileSync(
      path.join(dir, "PLAN.md"),
      [
        "## 핵심 결정 사항",
        "",
        "> 표 형식 유지 — 하네스가 파싱해 무인 세션에 주입한다.",
        "",
        "| ID | 결정 |",
        "|----|------|",
        "| D1 | 결정 내용 |",
      ].join("\n"),
    );
    const ctx = readPlanContext(dir);
    expect(ctx.decisions).not.toContain("표 형식 유지");
    expect(ctx.decisions).toContain("D1");
  });

  it("절이 인용 블록만으로 이루어져 있으면 제거 후 빈 내용이 되어 null", () => {
    fs.writeFileSync(
      path.join(dir, "PLAN.md"),
      ["## 핵심 결정 사항", "", "> 여기엔 지시문만 있다", "> 두 번째 줄", "", "## 용어", "내용"].join("\n"),
    );
    const ctx = readPlanContext(dir);
    expect(ctx.decisions).toBeNull();
    expect(ctx.glossary).toBe("내용");
  });

  it("절 길이가 4000자를 넘으면 잘라내고 잘렸음을 표시한다", () => {
    const huge = "x".repeat(5000);
    fs.writeFileSync(path.join(dir, "PLAN.md"), `## 핵심 결정 사항\n${huge}\n`);
    const ctx = readPlanContext(dir);
    expect(ctx.decisions).not.toBeNull();
    expect(ctx.decisions!.length).toBeLessThan(5000);
    expect(ctx.decisions).toContain("이하 생략");
  });

  it("결정 절만 있고 용어 절은 없어도 예외 없이 동작 (부분 누락 허용)", () => {
    fs.writeFileSync(path.join(dir, "PLAN.md"), "## 핵심 결정 사항\n결정만 있음\n");
    const ctx = readPlanContext(dir);
    expect(ctx.decisions).toBe("결정만 있음");
    expect(ctx.glossary).toBeNull();
  });
});

const SAMPLE_ROW: DecisionRow = {
  id: "D6",
  decision: "새 결정",
  rationale: "테스트 근거",
  status: "accepted",
  date: "2026-08-27",
};

describe("nextDecisionId", () => {
  it("절이 없으면 D1", () => {
    expect(nextDecisionId("# 제목\n내용\n")).toBe("D1");
  });

  it("기존 D<n> 최댓값 + 1을 반환한다", () => {
    const md = [
      "## 핵심 결정 사항",
      "| ID | 결정 | 근거 | 상태 | 날짜 |",
      "|----|------|------|------|------|",
      "| D1 | a | b | accepted | 2026-08-26 |",
      "| D2 | c | d | accepted | 2026-08-26 |",
    ].join("\n");
    expect(nextDecisionId(md)).toBe("D3");
  });

  it("번호가 순서대로가 아니어도 최댓값 기준(D2 supersedes 참조 포함)", () => {
    const md = [
      "## 핵심 결정 사항",
      "| ID | 결정 | 근거 | 상태 | 날짜 |",
      "|----|------|------|------|------|",
      "| D1 | a | b | superseded by D7 | 2026-08-26 |",
      "| D7 | c | d | accepted | 2026-08-27 |",
    ].join("\n");
    expect(nextDecisionId(md)).toBe("D8");
  });

  it("절은 있지만 표가 비어 있으면(D<n> 없음) D1", () => {
    const md = "## 핵심 결정 사항\n산문으로만 쓰인 절\n";
    expect(nextDecisionId(md)).toBe("D1");
  });

  it("실전 PLAN(D1~D5) 에서 D6을 계산한다", () => {
    const md = [
      "## 핵심 결정 사항",
      "",
      "> 표 형식 유지",
      "",
      "| ID | 결정 | 근거 | 상태 | 날짜 |",
      "|----|------|------|------|------|",
      "| D1 | ... | ... | accepted | 2026-08-26 |",
      "| D2 | ... | ... | accepted | 2026-08-26 |",
      "| D3 | ... | ... | accepted | 2026-08-26 |",
      "| D4 | ... | ... | accepted | 2026-08-26 |",
      "| D5 | ... | ... | accepted | 2026-08-27 |",
    ].join("\n");
    expect(nextDecisionId(md)).toBe("D6");
  });
});

describe("appendDecisionRow — 순수 함수, append-only", () => {
  it("표가 있으면 마지막 데이터 행 다음에 새 행을 삽입하고 기존 줄은 그대로 둔다", () => {
    const md = [
      "# 플랜",
      "",
      "## 핵심 결정 사항",
      "",
      "| ID | 결정 | 근거 | 상태 | 날짜 |",
      "|----|------|------|------|------|",
      "| D1 | 기존 결정 | 기존 근거 | accepted | 2026-08-26 |",
      "",
      "## 용어",
      "내용",
    ].join("\n");
    const next = appendDecisionRow(md, SAMPLE_ROW);
    const lines = next.split("\n");
    // 기존 행이 바이트 그대로 남아 있다
    expect(lines).toContain("| D1 | 기존 결정 | 기존 근거 | accepted | 2026-08-26 |");
    expect(next).toContain("| D6 | 새 결정 | 테스트 근거 | accepted | 2026-08-27 |");
    // 새 행은 D1 바로 다음, "## 용어" 절 앞에 온다
    const d1Idx = lines.indexOf("| D1 | 기존 결정 | 기존 근거 | accepted | 2026-08-26 |");
    const d6Idx = lines.findIndex(l => l.includes("D6"));
    const glossaryIdx = lines.indexOf("## 용어");
    expect(d6Idx).toBe(d1Idx + 1);
    expect(d6Idx).toBeLessThan(glossaryIdx);
    // 용어 절 내용은 무변경
    expect(next).toContain("## 용어\n내용");
  });

  it("절이 없으면 §28 형식(헤더+구분선)으로 새 절을 문서 끝에 만들어 붙인다", () => {
    const md = "# 플랜\n\n산문만 있는 오래된 PLAN\n";
    const next = appendDecisionRow(md, SAMPLE_ROW);
    expect(next).toContain("## 핵심 결정 사항");
    expect(next).toContain("| ID | 결정 | 근거 | 상태 | 날짜 |");
    expect(next).toContain("|----|------|------|------|------|");
    expect(next).toContain("| D6 | 새 결정 | 테스트 근거 | accepted | 2026-08-27 |");
    // 기존 내용은 그대로 접두사로 남아 있다
    expect(next.startsWith("# 플랜\n\n산문만 있는 오래된 PLAN")).toBe(true);
  });

  it("절은 있지만 표가 없는 산문 절 — 원본을 그대로 반환한다(보수적 선택, §30 P2)", () => {
    const md = "## 핵심 결정 사항\n\n- 결정 A: 이렇게 했다\n- 결정 B: 저렇게 했다\n\n## 용어\n내용\n";
    const next = appendDecisionRow(md, SAMPLE_ROW);
    expect(next).toBe(md);
  });

  it("표는 있지만 열 개수가 다르면(구 형식) 원본을 그대로 반환한다", () => {
    const md = [
      "## 핵심 결정 사항",
      "| ID | 결정 | 상태 |",
      "|----|------|------|",
      "| D1 | 옛 형식 | accepted |",
    ].join("\n");
    const next = appendDecisionRow(md, SAMPLE_ROW);
    expect(next).toBe(md);
  });

  it("셀 안의 개행/파이프 문자를 이스케이프해 표를 깨뜨리지 않는다", () => {
    const md = [
      "## 핵심 결정 사항",
      "| ID | 결정 | 근거 | 상태 | 날짜 |",
      "|----|------|------|------|------|",
      "| D1 | 기존 | 기존 | accepted | 2026-08-26 |",
    ].join("\n");
    const row: DecisionRow = {
      id: "D6",
      decision: "A안 | B안 중 A안\n(줄바꿈 포함)",
      rationale: "근거",
      status: "accepted",
      date: "2026-08-27",
    };
    const next = appendDecisionRow(md, row);
    const newLines = next.split("\n");
    // 원래 있던 줄 수(4) + 새 행 1줄 = 5줄이어야 한다(개행이 새 줄을 만들지 않았음을 확인)
    expect(newLines.length).toBe(5);
    expect(next).toContain("A안 \\| B안 중 A안 (줄바꿈 포함)");
  });
});

describe("appendDecisionToPlan — 파일 I/O, §30 P2 정상 경로 회귀", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-plan-append-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("PLAN.md 가 없으면 아무것도 쓰지 않고 false", () => {
    expect(appendDecisionToPlan(dir, SAMPLE_ROW)).toBe(false);
    expect(fs.existsSync(path.join(dir, "PLAN.md"))).toBe(false);
  });

  it("기존 D1~D5 표에 D6을 append하고, 기존 행은 바이트 단위로 무변경", () => {
    const original = [
      "# 플랜",
      "",
      "## 핵심 결정 사항",
      "",
      "> 표 형식 유지",
      "",
      "| ID | 결정 | 근거 | 상태 | 날짜 |",
      "|----|------|------|------|------|",
      "| D1 | 결정1 | 근거1 | accepted | 2026-08-26 |",
      "| D2 | 결정2 | 근거2 | accepted | 2026-08-26 |",
      "| D3 | 결정3 | 근거3 | accepted | 2026-08-26 |",
      "| D4 | 결정4 | 근거4 | accepted | 2026-08-26 |",
      "| D5 | 결정5 | 근거5 | accepted | 2026-08-27 |",
      "",
      "## 용어",
      "내용",
      "",
    ].join("\n");
    const planPath = path.join(dir, "PLAN.md");
    fs.writeFileSync(planPath, original);

    const ok = appendDecisionToPlan(dir, { ...SAMPLE_ROW, id: "D6" });
    expect(ok).toBe(true);

    const after = fs.readFileSync(planPath, "utf-8");
    // 기존 5행이 각각 바이트 그대로 존재
    for (const line of [
      "| D1 | 결정1 | 근거1 | accepted | 2026-08-26 |",
      "| D2 | 결정2 | 근거2 | accepted | 2026-08-26 |",
      "| D3 | 결정3 | 근거3 | accepted | 2026-08-26 |",
      "| D4 | 결정4 | 근거4 | accepted | 2026-08-26 |",
      "| D5 | 결정5 | 근거5 | accepted | 2026-08-27 |",
    ]) {
      expect(after).toContain(line);
    }
    expect(after).toContain("| D6 | 새 결정 | 테스트 근거 | accepted | 2026-08-27 |");
    // 원본 전체가 접두사로 그대로 남아 있는지(새 행 삽입 지점 이전까지) 확인
    expect(after.indexOf("| D5 |")).toBeLessThan(after.indexOf("| D6 |"));
    expect(after.indexOf("| D6 |")).toBeLessThan(after.indexOf("## 용어"));
  });

  it("여러 번 append하면 ID가 증가하고 중복이 없다", () => {
    fs.writeFileSync(
      path.join(dir, "PLAN.md"),
      ["## 핵심 결정 사항", "| ID | 결정 | 근거 | 상태 | 날짜 |", "|----|------|------|------|------|", "| D1 | x | y | accepted | 2026-08-26 |"].join("\n"),
    );
    const planPath = path.join(dir, "PLAN.md");

    const id2 = nextDecisionId(fs.readFileSync(planPath, "utf-8"));
    expect(appendDecisionToPlan(dir, { ...SAMPLE_ROW, id: id2 })).toBe(true);

    const id3 = nextDecisionId(fs.readFileSync(planPath, "utf-8"));
    expect(appendDecisionToPlan(dir, { ...SAMPLE_ROW, id: id3 })).toBe(true);

    expect(id2).toBe("D2");
    expect(id3).toBe("D3");
    const finalContent = fs.readFileSync(planPath, "utf-8");
    expect((finalContent.match(/\| D2 \|/g) ?? []).length).toBe(1);
    expect((finalContent.match(/\| D3 \|/g) ?? []).length).toBe(1);
  });

  it("§핵심 결정 절이 없는 PLAN → 절을 만들어 붙이고 true", () => {
    fs.writeFileSync(path.join(dir, "PLAN.md"), "# 플랜\n산문만 있음\n");
    expect(appendDecisionToPlan(dir, SAMPLE_ROW)).toBe(true);
    const after = fs.readFileSync(path.join(dir, "PLAN.md"), "utf-8");
    expect(after).toContain("## 핵심 결정 사항");
    expect(after).toContain("D6");
  });

  it("열 개수가 다른 커스텀 표 → 손대지 않고 false", () => {
    const original = ["## 핵심 결정 사항", "| ID | 결정 | 상태 |", "|----|------|------|", "| D1 | 옛 형식 | accepted |"].join("\n");
    fs.writeFileSync(path.join(dir, "PLAN.md"), original);
    expect(appendDecisionToPlan(dir, SAMPLE_ROW)).toBe(false);
    expect(fs.readFileSync(path.join(dir, "PLAN.md"), "utf-8")).toBe(original);
  });

  it("산문 §핵심 결정 절 → 손대지 않고 false (§30 P2 보수적 선택)", () => {
    const original = "## 핵심 결정 사항\n- 결정 A\n- 결정 B\n";
    fs.writeFileSync(path.join(dir, "PLAN.md"), original);
    expect(appendDecisionToPlan(dir, SAMPLE_ROW)).toBe(false);
    expect(fs.readFileSync(path.join(dir, "PLAN.md"), "utf-8")).toBe(original);
  });
});

// §31 I6 — 감사자가 실측한 8종 제목 형태 회귀. 대조군(정상 ATX)을 포함해 전부 표로 확인한다.
describe("§31 I6 — 제목 형태 관용 매칭 (감사자 실측 8종)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-plan-i6-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writePlan(body: string): void {
    fs.writeFileSync(path.join(dir, "PLAN.md"), body);
  }

  it("대조군 — '## 핵심 결정 사항' 은 그대로 주입된다", () => {
    writePlan("## 핵심 결정 사항\n\n| ID | 결정 |\n|----|------|\n| D1 | 대조군 결정 |\n");
    const ctx = readPlanContext(dir);
    expect(ctx.decisions).toContain("대조군 결정");
    expect(ctx.diagnostics!.decisionsHeading).toBe("## 핵심 결정 사항");
  });

  it("setext 헤딩('핵심 결정 사항' + '-----') 이 이제 인식된다", () => {
    writePlan("핵심 결정 사항\n-----\n\n| ID | 결정 |\n|----|------|\n| D1 | setext 결정 |\n");
    const ctx = readPlanContext(dir);
    expect(ctx.decisions).toContain("setext 결정");
    expect(ctx.diagnostics!.decisionsHeading).toBe("핵심 결정 사항");
  });

  it("'## §핵심 결정 사항' — § 접두 장식이 벗겨져 매치된다 (설계 문서·cli.ts 표기)", () => {
    writePlan("## §핵심 결정 사항\n\n| ID | 결정 |\n|----|------|\n| D1 | 섹션 기호 결정 |\n");
    const ctx = readPlanContext(dir);
    expect(ctx.decisions).toContain("섹션 기호 결정");
  });

  it("'## 1. 핵심 결정 사항' — 번호 접두가 벗겨져 매치된다", () => {
    writePlan("## 1. 핵심 결정 사항\n\n| ID | 결정 |\n|----|------|\n| D1 | 번호 접두 결정 |\n");
    const ctx = readPlanContext(dir);
    expect(ctx.decisions).toContain("번호 접두 결정");
  });

  it("'## 📌 핵심 결정 사항' — 이모지 접두가 벗겨져 매치된다", () => {
    writePlan("## 📌 핵심 결정 사항\n\n| ID | 결정 |\n|----|------|\n| D1 | 이모지 결정 |\n");
    const ctx = readPlanContext(dir);
    expect(ctx.decisions).toContain("이모지 결정");
  });

  it("'## 결정 사항' — 어순이 다른 동의어도 화이트리스트로 매치된다", () => {
    writePlan("## 결정 사항\n\n| ID | 결정 |\n|----|------|\n| D1 | 결정사항 동의어 |\n");
    const ctx = readPlanContext(dir);
    expect(ctx.decisions).toContain("결정사항 동의어");
  });

  it("'## 주요 결정' — 어순이 다른 동의어도 화이트리스트로 매치된다", () => {
    writePlan("## 주요 결정\n\n| ID | 결정 |\n|----|------|\n| D1 | 주요결정 동의어 |\n");
    const ctx = readPlanContext(dir);
    expect(ctx.decisions).toContain("주요결정 동의어");
  });

  it("'## 결정 배경' 은 의도적으로 매치하지 않는다 — NOTES 성격 배경 설명이지 결정 표가 아니다(§30 P2 판단)", () => {
    writePlan("## 결정 배경\n\n왜 이렇게 했는지에 대한 산문 설명.\n");
    const ctx = readPlanContext(dir);
    expect(ctx.decisions).toBeNull();
    expect(ctx.diagnostics!.decisionsHeading).toBeNull();
  });

  it("무관한 '## 최종 결정' 은 여전히 매치하지 않는다 (과도한 완화 방지 회귀)", () => {
    writePlan("## 최종 결정\n\n엉뚱한 내용\n");
    expect(readPlanContext(dir).decisions).toBeNull();
  });

  it("구버전 h3 절이 앞서고 진짜 h2 절이 뒤에 오면 h2(얕은 레벨)를 고른다 — 구버전 주입 금지", () => {
    writePlan(
      [
        "### 핵심 결정 요약(구버전)",
        "이 절은 구버전이며 무효다. 옛 결정 X 를 따르라.",
        "",
        "## 핵심 결정 사항",
        "",
        "| ID | 결정 |",
        "|----|------|",
        "| D1 | 최신 결정 |",
      ].join("\n"),
    );
    const ctx = readPlanContext(dir);
    expect(ctx.decisions).toContain("최신 결정");
    expect(ctx.decisions).not.toContain("옛 결정 X");
    expect(ctx.diagnostics!.decisionsHeading).toBe("## 핵심 결정 사항");
  });

  it("절 안 코드펜스의 '## 예시 헤딩' 은 헤딩으로 오인되지 않는다 — 절이 조기 종료되지 않는다", () => {
    writePlan(
      [
        "## 핵심 결정 사항",
        "",
        "아래는 PLAN 형식 예시다:",
        "",
        "```md",
        "## 예시 헤딩",
        "이건 문서 안의 예시일 뿐 실제 헤딩이 아니다.",
        "```",
        "",
        "| ID | 결정 |",
        "|----|------|",
        "| D1 | 진짜 결정 |",
        "",
        "## 용어",
        "무관한 절",
      ].join("\n"),
    );
    const ctx = readPlanContext(dir);
    // 펜스 뒤에 오는 진짜 표까지 절 안에 포함돼야 한다(조기 종료 없음)
    expect(ctx.decisions).toContain("진짜 결정");
    // 펜스 안의 "## 예시 헤딩" 텍스트는 절 안에 남아 있어도 되지만(원문 보존), 다음 절(용어)
    // 내용이 새어 들어오면 안 된다 — 절 경계는 펜스 뒤의 실제 "## 용어" 에서 끊겨야 한다.
    expect(ctx.decisions).not.toContain("무관한 절");
    // 펜스가 정상적으로 닫혀 있으므로 여는/닫는 펜스 개수가 짝수(둘 다 포함)여야 한다.
    const fenceCount = (ctx.decisions!.match(/```/g) ?? []).length;
    expect(fenceCount).toBe(2);
  });

  it("절 끝까지 닫히지 않은 코드펜스는 프롬프트에 닫는 줄이 합성되어 나간다(미종결 펜스가 새지 않음)", () => {
    writePlan(
      ["## 핵심 결정 사항", "", "| ID | 결정 |", "|----|------|", "| D1 | 실결정 |", "", "```", "닫히지 않은 펜스 내용"].join(
        "\n",
      ),
    );
    const ctx = readPlanContext(dir);
    const fenceCount = (ctx.decisions!.match(/```/g) ?? []).length;
    expect(fenceCount % 2).toBe(0); // 홀수(미종결)면 안 된다
  });
});

// §32 I-6 — 접두 매칭 화이트리스트가 "결정 배경"/"최종 결정"은 걸러내지만(§31 I6 이 이미
// 확보) 같은 별칭으로 "시작"하면서 폐기/이력/지침/사람 목록을 가리키는 꼬리표가 붙은 제목은
// 걸러내지 못했다(감사 실측 5종). 부정 후행 검사가 이 5종을 제외하는지 확인한다.
describe("§32 I-6 — 절 추출 완화 과잉 교정: 폐기/이력/지침/사람 목록 제외", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-plan-i6b-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writePlan(body: string): void {
    fs.writeFileSync(path.join(dir, "PLAN.md"), body);
  }

  it.each([
    ["## 핵심 결정 배경(폐기)", "폐기된 초안 결정"],
    ["## 주요 결정권자 목록", "홍길동"],
    ["## 결정 사항 변경 이력", "옛 결정 변경 기록"],
  ])("'%s' 는 결정 표로 주입되지 않는다(오탐이었던 5종 중)", (headingLine, content) => {
    writePlan(`${headingLine}\n\n${content}\n`);
    const ctx = readPlanContext(dir);
    expect(ctx.decisions).toBeNull();
    expect(ctx.diagnostics!.decisionsHeading).toBeNull();
  });

  it.each([
    ["## 용어 사용 지침", "작성 지침 산문"],
    ["## 용어 정리 TODO", "미완성 TODO 내용"],
  ])("'%s' 는 용어 정의로 주입되지 않는다(오탐이었던 5종 중)", (headingLine, content) => {
    writePlan(`${headingLine}\n\n${content}\n`);
    const ctx = readPlanContext(dir);
    expect(ctx.glossary).toBeNull();
    expect(ctx.diagnostics!.glossaryHeading).toBeNull();
  });

  // 회귀: "갱신"/날짜 접미가 붙은 정당한 제목까지 과잉 차단하면 안 된다(§30 P2).
  it("'## 핵심 결정 사항 (2026-08 갱신)' 은 배제되지 않고 여전히 주입된다(과잉 차단 방지 회귀)", () => {
    writePlan("## 핵심 결정 사항 (2026-08 갱신)\n\n| ID | 결정 |\n|----|------|\n| D1 | 갱신된 결정 |\n");
    const ctx = readPlanContext(dir);
    expect(ctx.decisions).toContain("갱신된 결정");
  });

  // §32 I-6-3 — h2(초안-폐기) 가 앞서고 h3(확정) 이 뒤에 오면, 배제 토큰이 h2 를 걸러내
  // h3(유일한 남은 후보)가 선택되어야 한다. §31 I6-3 이 만들었던 "얕은 레벨 우선"의 반대
  // 방향 사고(구버전을 다시 만듦)가 해소됐는지 확인한다.
  it("h2 '(초안 — 폐기)' 가 앞서고 h3 '(확정)' 이 뒤에 오면 폐기 h2 가 아니라 확정 h3 를 고른다", () => {
    writePlan(
      [
        "## 핵심 결정 사항 (초안 — 폐기)",
        "",
        "| ID | 결정 |",
        "|----|------|",
        "| D1 | 폐기된-초안 |",
        "",
        "## 상세",
        "",
        "### 핵심 결정 사항 (확정)",
        "",
        "| ID | 결정 |",
        "|----|------|",
        "| D9 | 확정본 |",
      ].join("\n"),
    );
    const ctx = readPlanContext(dir);
    expect(ctx.decisions).toContain("확정본");
    expect(ctx.decisions).not.toContain("폐기된-초안");
    expect(ctx.diagnostics!.decisionsHeading).toBe("### 핵심 결정 사항 (확정)");
  });

  // §32 I-6 요구사항: 후보가 2개 이상이면 diagnostics 에 candidateCount/candidateHeadings 로
  // "다른 후보가 있었다"는 사실을 남긴다(§30 P4 — 골랐다는 사실보다 그 자체가 정보다).
  it("배제되지 않는 후보가 2개 이상이면 decisionsCandidateCount/decisionsCandidateHeadings 로 보고한다", () => {
    writePlan(
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
    const ctx = readPlanContext(dir);
    // 하나만 골라 주입한다(둘 다 섞어 넣지 않는다) — 어느 쪽이든 유효한 선택.
    expect(ctx.decisions).not.toBeNull();
    expect(ctx.diagnostics!.decisionsCandidateCount).toBe(2);
    expect(ctx.diagnostics!.decisionsCandidateHeadings).toEqual([
      "## 핵심 결정 사항",
      "## 주요 결정",
    ]);
  });

  it("후보가 하나뿐이면 candidateCount/candidateHeadings 가 채워지지 않는다(정상 경로엔 노이즈 없음)", () => {
    writePlan("## 핵심 결정 사항\n\n| ID | 결정 |\n|----|------|\n| D1 | 유일 결정 |\n");
    const ctx = readPlanContext(dir);
    expect(ctx.diagnostics!.decisionsCandidateCount).toBeUndefined();
    expect(ctx.diagnostics!.decisionsCandidateHeadings).toBeUndefined();
  });
});

// §31 m2~m6 — PLAN writer 결함.
describe("§31 m2 — appendDecisionRow 는 원본 줄바꿈 방식(CRLF/LF)을 보존한다", () => {
  it("CRLF 원본에 append 하면 결과도 CRLF 이고 기존 줄은 바이트 그대로 남는다", () => {
    const original = [
      "# 플랜",
      "",
      "## 핵심 결정 사항",
      "",
      "| ID | 결정 | 근거 | 상태 | 날짜 |",
      "|----|------|------|------|------|",
      "| D1 | 기존 결정 | 기존 근거 | accepted | 2026-08-26 |",
    ].join("\r\n");
    const next = appendDecisionRow(original, SAMPLE_ROW);
    // 원본에 CRLF 가 있었으므로 결과 전체가 CRLF 여야 한다 — LF 로 재작성되면 안 된다.
    expect(next.includes("\r\n")).toBe(true);
    const crlfCount = (next.match(/\r\n/g) ?? []).length;
    const lfOnlyCount = (next.replace(/\r\n/g, "").match(/\n/g) ?? []).length;
    expect(lfOnlyCount).toBe(0); // 모든 개행이 CRLF — LF 단독 줄바꿈이 하나도 없어야 한다
    expect(crlfCount).toBeGreaterThan(0);
    expect(next).toContain("| D1 | 기존 결정 | 기존 근거 | accepted | 2026-08-26 |");
    expect(next).toContain("| D6 | 새 결정 | 테스트 근거 | accepted | 2026-08-27 |");
  });

  it("LF 원본은 그대로 LF 로 유지된다 (회귀 — CRLF 보존이 LF 케이스를 깨지 않음)", () => {
    const original = [
      "## 핵심 결정 사항",
      "| ID | 결정 | 근거 | 상태 | 날짜 |",
      "|----|------|------|------|------|",
      "| D1 | a | b | accepted | 2026-08-26 |",
    ].join("\n");
    const next = appendDecisionRow(original, SAMPLE_ROW);
    expect(next.includes("\r\n")).toBe(false);
    expect(next).toContain("| D6 | 새 결정 | 테스트 근거 | accepted | 2026-08-27 |");
  });
});

describe("§31 m3 — sanitizeCell 이스케이프 교정 (홀수 백슬래시+파이프)", () => {
  // GFM 표 셀 이스케이프를 역으로 풀어 "렌더링됐을 때 원문이 그대로 보이는가" 를 검증한다.
  // (\\ -> \, \| -> |, 그 외 문자는 그대로) — sanitizeCell 은 export 되어 있지 않으므로
  // appendDecisionRow 의 출력으로 간접 검증한다.
  function gfmUnescape(s: string): string {
    let out = "";
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "\\" && (s[i + 1] === "\\" || s[i + 1] === "|")) {
        out += s[i + 1];
        i++;
      } else {
        out += s[i];
      }
    }
    return out;
  }

  // GFM 표는 파이프 앞의 백슬래시 개수가 짝수(0 포함)면 그 파이프를 "구분자"로, 홀수면
  // "이스케이프된 리터럴"로 읽는다. 순진하게 매 "|" 마다 분할하면(이스케이프를 모르는 분할)
  // 셀 내용에 포함된 이스케이프된 파이프까지 새 열로 쪼개버려 검증 자체가 틀린다.
  function splitTableRowRespectingEscapes(line: string): string[] {
    const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
    const cells: string[] = [];
    let current = "";
    let backslashRun = 0;
    for (const ch of inner) {
      if (ch === "\\") {
        current += ch;
        backslashRun++;
        continue;
      }
      if (ch === "|" && backslashRun % 2 === 0) {
        cells.push(current);
        current = "";
        backslashRun = 0;
        continue;
      }
      current += ch;
      backslashRun = 0;
    }
    cells.push(current);
    return cells.map(c => c.trim());
  }

  it("원문에 이미 '\\|'(홀수 백슬래시+파이프) 가 있으면 표 열이 늘어나지 않고 원문이 복원된다", () => {
    const md = [
      "## 핵심 결정 사항",
      "| ID | 결정 | 근거 | 상태 | 날짜 |",
      "|----|------|------|------|------|",
      "| D1 | 기존 | 기존 | accepted | 2026-08-26 |",
    ].join("\n");
    const row: DecisionRow = {
      id: "D6",
      decision: String.raw`a \| b`, // 문자 그대로: a, 공백, \, |, 공백, b (백슬래시 1개)
      rationale: "근거",
      status: "accepted",
      date: "2026-08-27",
    };
    const next = appendDecisionRow(md, row);
    const newLine = next.split("\n").find(l => l.includes("D6"))!;
    // 이스케이프를 존중해 분할하면 여전히 5칸이어야 한다 — 깨지면(§31 m3 버그) 열이 늘어난다.
    const cells = splitTableRowRespectingEscapes(newLine);
    expect(cells.length).toBe(5);
    expect(gfmUnescape(cells[1]!)).toBe(String.raw`a \| b`);
  });

  it("원문에 백슬래시 없이 파이프만 있으면(기존 동작) 여전히 한 번만 이스케이프된다", () => {
    const md = [
      "## 핵심 결정 사항",
      "| ID | 결정 | 근거 | 상태 | 날짜 |",
      "|----|------|------|------|------|",
      "| D1 | 기존 | 기존 | accepted | 2026-08-26 |",
    ].join("\n");
    const row: DecisionRow = {
      id: "D6",
      decision: "A안 | B안 중 A안\n(줄바꿈 포함)",
      rationale: "근거",
      status: "accepted",
      date: "2026-08-27",
    };
    const next = appendDecisionRow(md, row);
    expect(next).toContain("A안 \\| B안 중 A안 (줄바꿈 포함)");
  });

  it("원문에 백슬래시만 있어도(파이프 없음) 렌더링 시 원문 그대로 복원된다", () => {
    const md = [
      "## 핵심 결정 사항",
      "| ID | 결정 | 근거 | 상태 | 날짜 |",
      "|----|------|------|------|------|",
      "| D1 | 기존 | 기존 | accepted | 2026-08-26 |",
    ].join("\n");
    const row: DecisionRow = {
      id: "D6",
      decision: String.raw`C:\Users\foo`,
      rationale: "근거",
      status: "accepted",
      date: "2026-08-27",
    };
    const next = appendDecisionRow(md, row);
    const newLine = next.split("\n").find(l => l.includes("D6"))!;
    const cells = splitTableRowRespectingEscapes(newLine);
    expect(cells.length).toBe(5);
    expect(gfmUnescape(cells[1]!)).toBe(String.raw`C:\Users\foo`);
  });
});

describe("§31 m4 — nextDecisionId 는 ID 열만 스캔한다 (자유 텍스트 오염 차단)", () => {
  it("결정/근거 칸의 'D9999' 는 다음 ID 계산을 오염시키지 않는다", () => {
    const md = [
      "## 핵심 결정 사항",
      "| ID | 결정 | 근거 | 상태 | 날짜 |",
      "|----|------|------|------|------|",
      "| D1 | a | b | accepted | 2026-08-26 |",
      "| D2 | 세션 질문에 D9999 라는 텍스트가 섞여 있음 | 근거 | accepted | 2026-08-27 |",
    ].join("\n");
    expect(nextDecisionId(md)).toBe("D3");
  });

  // SURVIVED M53(§32 감사) — 위 테스트는 "D9999" 가 다른 산문에 섞여 있는 경우만 다룬다.
  // ID 열 한정을 "cells[0] 만 본다" 대신 "모든 셀을 같은 정규식으로 검사한다"로 되돌리는
  // 뮤턴트는, 다른 셀이 자유 산문일 때는 정확 일치(`^D(\d+)$`)에 걸리지 않아 위 테스트를
  // 통과해버린다(직접 뮤턴트를 만들어 확인). 이 뮤턴트를 죽이려면 ID 열이 "아닌" 칸이 그
  // 자체로 정확히 "D<n>" 형태인 경우가 필요하다 — 예: 결정 칸에 다른 결정 ID 를 참조 문구
  // 없이 그대로 적은 경우.
  it("SURVIVED M53 — 결정 칸이 정확히 다른 'D<n>' 형태여도(참조 문구 없이) ID 열이 아니면 무시된다", () => {
    const md = [
      "## 핵심 결정 사항",
      "| ID | 결정 | 근거 | 상태 | 날짜 |",
      "|----|------|------|------|------|",
      "| D1 | D50 | 근거 | accepted | 2026-08-26 |",
    ].join("\n");
    // ID 열(cells[0])은 "D1" 뿐이다 — "결정" 칸의 "D50" 은 무시되어야 D2 가 된다.
    // ID 열 한정이 풀리면(뮤턴트) "결정" 칸의 "D50" 도 정확 일치로 잡혀 D51 이 나온다.
    expect(nextDecisionId(md)).toBe("D2");
  });

  it("비정상적으로 긴 ID 문자열(D 뒤 20자리 숫자)이 있어도 폭주하지 않는다", () => {
    const md = [
      "## 핵심 결정 사항",
      "| ID | 결정 | 근거 | 상태 | 날짜 |",
      "|----|------|------|------|------|",
      "| D1 | a | b | accepted | 2026-08-26 |",
      "| D99999999999999999999 | 비정상 ID | 근거 | accepted | 2026-08-27 |",
    ].join("\n");
    expect(nextDecisionId(md)).toBe("D2");
  });
});

describe("§31 m5 — findDecisionTable 은 코드펜스 안의 예시 표를 진짜 표로 오인하지 않는다", () => {
  it("절 안에 예시 표(코드펜스)가 먼저 나오고 진짜 표가 뒤에 있으면 진짜 표에 append 된다", () => {
    const md = [
      "## 핵심 결정 사항",
      "",
      "형식 예시:",
      "```",
      "| ID | 결정 |",
      "|----|------|",
      "| D999 | 예시일 뿐, 진짜 데이터 아님 |",
      "```",
      "",
      "| ID | 결정 | 근거 | 상태 | 날짜 |",
      "|----|------|------|------|------|",
      "| D1 | 진짜 결정 | 근거 | accepted | 2026-08-26 |",
    ].join("\n");
    const next = appendDecisionRow(md, SAMPLE_ROW);
    // 예시 표(코드펜스 안)는 무변경 — D999 예시 행 바로 다음에 D6 이 끼어들면 안 된다.
    const fenceBlock = next.slice(next.indexOf("```"), next.indexOf("```", next.indexOf("```") + 3) + 3);
    expect(fenceBlock).not.toContain("D6");
    // 진짜 표에는 append 되어야 한다.
    expect(next).toContain("| D1 | 진짜 결정 | 근거 | accepted | 2026-08-26 |\n| D6 |");
  });
});

describe("§31 m6 — 미치환 템플릿/빈 행 필터링", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-plan-m6-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("'{{ }}' 미치환 템플릿 행만 있으면 절 전체가 null 이다", () => {
    fs.writeFileSync(
      path.join(dir, "PLAN.md"),
      [
        "## 핵심 결정 사항",
        "",
        "| ID | 결정 | 근거 | 상태 | 날짜 |",
        "|----|------|------|------|------|",
        "| {{ID}} | {{ 결정 }} | {{ 근거 }} | {{ 상태 }} | {{ 날짜 }} |",
      ].join("\n"),
    );
    const ctx = readPlanContext(dir);
    expect(ctx.decisions).toBeNull();
    expect(ctx.diagnostics!.decisionsHeading).not.toBeNull(); // 헤딩은 찾았다 — 내용만 없다
    expect(ctx.diagnostics!.decisionsChars).toBe(0);
  });

  it("ID만 채워진 빈 스켈레톤 행('| D2 | | | | |')만 있으면 절 전체가 null 이다", () => {
    fs.writeFileSync(
      path.join(dir, "PLAN.md"),
      ["## 핵심 결정 사항", "", "| ID | 결정 | 근거 | 상태 | 날짜 |", "|----|------|------|------|------|", "| D2 | | | | |"].join(
        "\n",
      ),
    );
    const ctx = readPlanContext(dir);
    expect(ctx.decisions).toBeNull();
  });

  it("실제 데이터 행과 플레이스홀더 행이 섞여 있으면 실제 행만 주입된다", () => {
    fs.writeFileSync(
      path.join(dir, "PLAN.md"),
      [
        "## 핵심 결정 사항",
        "",
        "| ID | 결정 | 근거 | 상태 | 날짜 |",
        "|----|------|------|------|------|",
        "| D1 | 실제 결정 | 실제 근거 | accepted | 2026-08-26 |",
        "| D2 | | | | |",
      ].join("\n"),
    );
    const ctx = readPlanContext(dir);
    expect(ctx.decisions).toContain("실제 결정");
    expect(ctx.decisions).not.toContain("D2");
  });
});

// §42 — §검증 기준 절. 하네스는 "무엇을 검증할지" 를 정의하지 않고 **운반**만 한다.
describe("readPlanContext — §검증 기준 (§42)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-plan-acc-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (md: string): void => fs.writeFileSync(path.join(dir, "PLAN.md"), md);

  it("§검증 기준 절을 읽어 acceptance 로 반환한다", () => {
    write("# P\n\n## 검증 기준\n\n- Kafka 직렬화 결과가 바뀌지 않는다\n- Feign 요청 헤더가 동일하다\n");
    const ctx = readPlanContext(dir);
    expect(ctx.acceptance).toContain("Kafka 직렬화 결과가 바뀌지 않는다");
    expect(ctx.acceptance).toContain("Feign 요청 헤더가 동일하다");
    expect(ctx.diagnostics?.acceptanceChars).toBeGreaterThan(0);
  });

  it.each([
    ["완료 조건", "## 완료 조건"],
    ["인수 기준", "## 인수 기준"],
    ["합격 기준", "## 합격 기준"],
    ["Acceptance Criteria", "## Acceptance Criteria"],
    ["Definition of Done", "## Definition of Done"],
    ["장식 섞인 제목", "## 📌 검증 기준 및 범위"],
  ])("표기 변형 '%s' 도 같은 절로 인식한다", (_label, heading) => {
    write(`# P\n\n${heading}\n\n- 기존 테스트가 전부 통과한다\n`);
    expect(readPlanContext(dir).acceptance).toContain("기존 테스트가 전부 통과한다");
  });

  it("절이 없으면 조용히 null (하위호환 — §30 P2)", () => {
    write("# P\n\n산문만 있는 예전 PLAN.\n");
    const ctx = readPlanContext(dir);
    expect(ctx.acceptance).toBeNull();
    expect(ctx.diagnostics?.acceptanceHeading).toBeNull();
  });

  it("무관한 절을 검증 기준으로 오인하지 않는다", () => {
    write("# P\n\n## 검증 방법론 배경\n\n산문.\n");
    expect(readPlanContext(dir).acceptance).toBeNull();
  });
});

// §44 — §개발 방향 절. 개발 고수의 산출물이며 특히 "진입 경로"(어디부터 읽을 것인가)를 담는다.
describe("readPlanContext — §개발 방향 (§44)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-plan-arch-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const write = (md: string): void => fs.writeFileSync(path.join(dir, "PLAN.md"), md);

  it("§개발 방향 절을 architecture 로 반환한다", () => {
    write("# P\n\n## 개발 방향\n\n- 진입 경로: src/kafka/Producer.java 부터\n- 전체 스캔 금지\n");
    const ctx = readPlanContext(dir);
    expect(ctx.architecture).toContain("src/kafka/Producer.java");
    expect(ctx.diagnostics?.architectureChars).toBeGreaterThan(0);
  });

  it.each([
    ["구현 방향", "## 구현 방향"],
    ["아키텍처", "## 아키텍처"],
    ["진입 경로", "## 진입 경로"],
    ["Architecture", "## Architecture"],
  ])("표기 변형 '%s' 도 인식한다", (_l, heading) => {
    write(`# P\n\n${heading}\n\n- 레이어드 구조 유지\n`);
    expect(readPlanContext(dir).architecture).toContain("레이어드 구조 유지");
  });

  it("절이 없으면 null (하위호환)", () => {
    write("# P\n\n산문.\n");
    expect(readPlanContext(dir).architecture).toBeNull();
  });
});

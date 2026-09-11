// 조각 브랜치 이름 규칙 전용 테스트 (docs/pr-slicing Phase 1).
//
// 조각 브랜치는 통합 브랜치 이름에서 파생된다(PLAN D3/D12): `<통합브랜치>-<순번>`.
// **슬래시로 파생할 수 없다** — git 은 ref 를 파일/디렉토리로 저장하므로 `feature/X` 가
// 브랜치로 존재하면 `feature/X/1` 을 만들 수 없다(D/F 충돌, 실측 확인):
//   fatal: cannot lock ref 'refs/heads/feature/PROJ-123/1':
//          'refs/heads/feature/PROJ-123' exists; cannot create 'refs/heads/feature/PROJ-123/1'
// 그래서 이 파일의 핵심 계약은 "결과에 슬래시가 새로 생기지 않는다" 와 "git ref 로 유효하지
// 않은 이름을 만들지 않는다" 두 가지다.
//
// 통합 브랜치 이름은 사람이 STATE.json 에 직접 적을 수 있으므로(하네스가 만든 이름만 오는 게
// 아니다) 입력 검증이 심층 방어가 아니라 실제 필요다.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sliceBranchName, isValidGitBranchName } from "../src/branch.js";

describe("sliceBranchName", () => {
  it("통합 브랜치 이름에 순번을 하이픈으로 붙인다", () => {
    expect(sliceBranchName("feature/PROJ-123", 1)).toBe("feature/PROJ-123-1");
    expect(sliceBranchName("feature/PROJ-123", 12)).toBe("feature/PROJ-123-12");
  });

  it("사용자가 정한 접두를 그대로 따라간다 (feature/ 를 강제하지 않는다)", () => {
    expect(sliceBranchName("topic/order-migration", 3)).toBe("topic/order-migration-3");
    expect(sliceBranchName("my-branch", 2)).toBe("my-branch-2");
  });

  it("결과에 슬래시가 새로 생기지 않는다 (git D/F 충돌 방지)", () => {
    const integration = "feature/PROJ-123";
    const slice = sliceBranchName(integration, 1);
    const countSlashes = (s: string) => [...s].filter(c => c === "/").length;
    expect(countSlashes(slice)).toBe(countSlashes(integration));
  });

  // 아래 세 테스트의 기대 메시지를 못박는 이유: `toThrow()` 만 쓰면 함수가 아예 존재하지 않을
  // 때 나는 TypeError 로도 통과해버려(실측) 구현 전에 초록이 된다.
  it("순번이 양의 정수가 아니면 거부한다", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => sliceBranchName("feature/x", bad), `거부해야 함: ${bad}`).toThrow(/조각 순번/);
    }
  });

  it("통합 브랜치 이름이 비어 있으면 거부한다", () => {
    expect(() => sliceBranchName("", 1)).toThrow(/통합 브랜치/);
    expect(() => sliceBranchName("   ", 1)).toThrow(/통합 브랜치/);
  });

  it("git ref 로 유효하지 않은 통합 브랜치 이름은 거부한다", () => {
    for (const bad of [
      "feature/has space",
      "feature/dot..dot",
      "feature/tilde~1",
      "feature/caret^1",
      "feature/colon:x",
      "feature/question?",
      "feature/star*",
      "feature/bracket[",
      "feature/back\\slash",
      "feature/ctrlchar",
      "feature/x.lock",
      "feature/at@{1}",
      "/feature/leading",
      "feature/trailing/",
      "feature//double",
      "feature/.hidden",
      "feature/ends.",
      "feature/prev@{-1}",
    ]) {
      expect(() => sliceBranchName(bad, 1), `거부해야 함: ${JSON.stringify(bad)}`).toThrow(
        /브랜치 이름/,
      );
    }
  });
});

/** `refs/heads/<이름>` 은 통과시키지만 `git branch`/`git checkout -B` 로는 **만들 수 없는**
 *  이름. 선행 하이픈은 git CLI 가 옵션으로 파싱해 `--` 를 붙여도 거부한다(아래 테스트가 실측
 *  으로 증명한다). 하네스는 실제로 만들 수 있는 이름만 유효로 봐야 하므로 이 부류만 의도적으로
 *  check-ref-format 보다 엄격하다. */
const DOCUMENTED_DIVERGENCES = ["-x", "-", "--force"];

describe("isValidGitBranchName", () => {
  it("정상적인 브랜치 이름을 통과시킨다", () => {
    for (const ok of ["main", "develop", "feature/PROJ-123", "feature/PROJ-123-1", "a/b/c", "x_y.z"]) {
      expect(isValidGitBranchName(ok), `통과해야 함: ${ok}`).toBe(true);
    }
  });

  // 개발 렌즈 검토 확정 결함(하): docstring 이 "check-ref-format 과 일치" 를 선언해 두고
  // 이 부류에는 그 선언한 구멍이 남아 있었다. 하네스가 통과시킨 이름으로 git 이 실패하면
  // 무인 주행 중 "이름은 유효하다고 봤는데 브랜치 생성이 실패" 하는 형태로 터진다.
  it("선행 하이픈 이름은 거부한다 (git CLI 가 옵션으로 파싱해 만들 수 없다)", () => {
    for (const bad of ["-x", "-", "--force"]) {
      expect(isValidGitBranchName(bad), `거부해야 함: ${bad}`).toBe(false);
    }
  });

  it("선행 하이픈 거부의 근거 — git 이 실제로 그 브랜치를 만들지 못한다", () => {
    // 이 divergence 는 주장이 아니라 실측으로 정당화되어야 한다. check-ref-format 은 통과시키는데
    // `checkout -B` 는 거부한다는 사실 자체를 못박는다 — git 이 나중에 이를 허용하게 바뀌면
    // 이 테스트가 깨져서 우리 판정을 다시 검토하게 된다.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-hyphen-"));
    execFileSync("git", ["init", "-q", "."], { cwd: dir, stdio: "pipe" });
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "i"], { cwd: dir, stdio: "pipe" });
    // check-ref-format 은 통과
    expect(() =>
      execFileSync("git", ["check-ref-format", "refs/heads/-x"], { cwd: dir, stdio: "pipe" }),
    ).not.toThrow();
    // 그런데 실제 브랜치 생성은 거부
    expect(() => execFileSync("git", ["checkout", "-B", "-x"], { cwd: dir, stdio: "pipe" })).toThrow();
    expect(() => execFileSync("git", ["branch", "--", "-x"], { cwd: dir, stdio: "pipe" })).toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("git check-ref-format refs/heads/<이름> 과 판정이 일치한다", () => {
    // 자체 정규식이 git 의 실제 규칙과 어긋나면 "하네스는 통과시켰는데 git 이 거부" 하는
    // 사고가 무인 주행 중에 난다. 실제 git 으로 대조해 규칙 표류를 못박는다.
    //
    // 기준을 `--branch` 모드로 두지 않는 이유: 그 모드는 `@{-1}`(이전 브랜치) 같은 단축
    // 표기를 확장해서 받아들이므로 순수한 이름 검증기가 아니다 — `refs/heads/<이름>` 이
    // "브랜치 ref 로 유효한가" 의 정확한 기준이다.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-refname-"));
    const gitAccepts = (name: string): boolean => {
      try {
        execFileSync("git", ["check-ref-format", `refs/heads/${name}`], { cwd: dir, stdio: "pipe" });
        return true;
      } catch {
        return false;
      }
    };
    const names = [
      "main", "develop", "feature/PROJ-123", "feature/PROJ-123-1", "a/b/c", "x_y.z",
      // `@` 한 글자는 git 이 실제로 브랜치로 만들어준다(실측) — 하네스가 git 보다 좁게 막지
      // 않는다는 계약을 이 항목이 못박는다.
      "@",
      "feature/has space", "feature/dot..dot", "feature/tilde~1", "feature/caret^1",
      "feature/colon:x", "feature/question?", "feature/star*", "feature/bracket[",
      "feature/back\\slash", "feature/x.lock", "feature/at@{1}", "feature/prev@{-1}",
      "/feature/leading", "feature/trailing/", "feature//double", "feature/.hidden",
      "feature/ends.", "",
      // 평가 렌즈 검토 확정 결함(하): 18개 규칙 중 DEL(\x7f) 만 음성 사례가 없어서 정규식
      // 문자군에서 \x7f 를 지워도 이 테스트가 초록이었다(뮤테이션 생존).
      "feature/del\x7fchar",
    ];
    for (const name of names) {
      expect(isValidGitBranchName(name), `불일치: ${JSON.stringify(name)}`).toBe(gitAccepts(name));
    }
    // 의도적 divergence 는 parity 대상에서 제외하되, "git 은 통과시키는데 우리는 거부한다" 는
    // 방향까지 못박는다 — 그래야 divergence 가 슬그머니 양방향으로 벌어지지 않는다.
    for (const name of DOCUMENTED_DIVERGENCES) {
      expect(isValidGitBranchName(name), `거부해야 함: ${name}`).toBe(false);
    }
    expect(gitAccepts("-x"), "git 은 -x 를 ref 이름으로는 통과시킨다").toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

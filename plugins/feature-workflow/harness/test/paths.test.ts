import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  realpathOrClimb,
  unquoteGitPath,
  normalizeRepoRelative,
  unwrapShC,
  displayPath,
  truncateForDisplay,
} from "../src/paths.js";

// git 이 core.quotePath 로 경로를 감쌀 때 실제로 내보내는 8진 이스케이프 문자열을 만든다
// (테스트 스스로 인코딩해 하드코딩된 8진수가 맞는지 별도로 신뢰할 필요가 없게 한다).
function quoteAsGit(s: string): string {
  const bytes = Buffer.from(s, "utf8");
  let out = "";
  for (const b of bytes) {
    if (b === 0x5c) out += "\\\\";
    else if (b === 0x22) out += '\\"';
    else if (b < 0x20 || b >= 0x7f) out += `\\${b.toString(8).padStart(3, "0")}`;
    else out += String.fromCharCode(b);
  }
  return `"${out}"`;
}

describe("realpathOrClimb", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fw-paths-")));
  });

  it("존재하는 경로는 fs.realpathSync 와 동일하다", () => {
    expect(realpathOrClimb(dir)).toBe(fs.realpathSync(dir));
  });

  it("아직 존재하지 않는 하위 경로는 존재하는 조상까지만 realpath 해석하고 나머지는 그대로 이어붙인다", () => {
    const notYetExists = path.join(dir, "docs", "wf1", "STATE.json");
    const result = realpathOrClimb(notYetExists);
    expect(result).toBe(path.join(fs.realpathSync(dir), "docs", "wf1", "STATE.json"));
  });

  it("symlink 를 실제 대상 경로로 해석한다", () => {
    const target = path.join(dir, "real");
    fs.mkdirSync(target);
    const link = path.join(dir, "link");
    fs.symlinkSync(target, link);
    expect(realpathOrClimb(link)).toBe(fs.realpathSync(target));
  });

  it("symlink 경유 + 아직 없는 하위 경로도 존재하는 조상(symlink 대상)까지만 해석한다", () => {
    const target = path.join(dir, "real");
    fs.mkdirSync(target);
    const link = path.join(dir, "link");
    fs.symlinkSync(target, link);
    const notYetExists = path.join(link, "docs", "wf1");
    expect(realpathOrClimb(notYetExists)).toBe(path.join(fs.realpathSync(target), "docs", "wf1"));
  });

  it("여러 단계가 존재하지 않아도 존재하는 최상위 조상 하나까지 정확히 거슬러 올라간다", () => {
    const deep = path.join(dir, "a", "b", "c", "d");
    expect(realpathOrClimb(deep)).toBe(path.join(fs.realpathSync(dir), "a", "b", "c", "d"));
  });
});

describe("unquoteGitPath", () => {
  it("따옴표로 감싸이지 않은 입력은 그대로 반환한다(idempotent)", () => {
    expect(unquoteGitPath("scripts/check.sh")).toBe("scripts/check.sh");
    expect(unquoteGitPath("")).toBe("");
  });

  it("8진 이스케이프로 감싼 한글 경로를 바이트 단위로 모아 올바르게 복원한다", () => {
    const original = "scripts/한글.sh";
    const quoted = quoteAsGit(original);
    expect(unquoteGitPath(quoted)).toBe(original);
  });

  it("여러 멀티바이트 문자가 섞여도 깨지지 않는다(문자 단위 디코드였다면 mojibake)", () => {
    const original = "docs/한글피처/STATE.json";
    expect(unquoteGitPath(quoteAsGit(original))).toBe(original);
  });

  it("이스케이프된 백슬래시/큰따옴표를 해석한다", () => {
    const original = 'weird\\path"name.txt';
    expect(unquoteGitPath(quoteAsGit(original))).toBe(original);
  });

  it("니모닉 이스케이프(\\t, \\n)를 해석한다", () => {
    expect(unquoteGitPath('"a\\tb"')).toBe("a\tb");
    expect(unquoteGitPath('"a\\nb"')).toBe("a\nb");
  });

  it("실제 git 실측 예시(§29 감사 원문)를 그대로 복원한다", () => {
    // 감사 원문: "scripts/\355\225\234\352\270\200.sh" → "scripts/한글.sh"
    expect(unquoteGitPath('"scripts/\\355\\225\\234\\352\\270\\200.sh"')).toBe("scripts/한글.sh");
  });
});

describe("normalizeRepoRelative", () => {
  it("선행 './' 를 제거한다", () => {
    expect(normalizeRepoRelative("./scripts/check.sh")).toBe("scripts/check.sh");
  });

  it("중복/후행/선행 슬래시를 정리한다", () => {
    expect(normalizeRepoRelative("scripts//check.sh")).toBe("scripts/check.sh");
    expect(normalizeRepoRelative("scripts/check.sh/")).toBe("scripts/check.sh");
    expect(normalizeRepoRelative("/package.json")).toBe("package.json");
  });

  it("빈 문자열은 빈 문자열로 남는다", () => {
    expect(normalizeRepoRelative("")).toBe("");
    expect(normalizeRepoRelative("   ")).toBe("");
  });

  it("NFC/NFD 로 다르게 표현된 동일 문자를 같은 문자열로 정규화한다(macOS 파일명 정규화 편차)", () => {
    const nfc = "한글".normalize("NFC");
    const nfd = "한글".normalize("NFD");
    expect(nfc).not.toBe(nfd); // 전제 확인 — 실제로 바이트가 다른 두 표기
    expect(normalizeRepoRelative(`docs/${nfc}/STATE.json`)).toBe(
      normalizeRepoRelative(`docs/${nfd}/STATE.json`),
    );
  });

  it("caseInsensitive:true 를 명시하면 플랫폼과 무관하게 대소문자를 무시한다", () => {
    expect(normalizeRepoRelative("Package.json", { caseInsensitive: true })).toBe(
      normalizeRepoRelative("package.json", { caseInsensitive: true }),
    );
  });

  it("caseInsensitive:false 를 명시하면 대소문자를 구분한다", () => {
    expect(normalizeRepoRelative("Package.json", { caseInsensitive: false })).not.toBe(
      normalizeRepoRelative("package.json", { caseInsensitive: false }),
    );
  });

  it("옵션 미지정 시 현재 플랫폼 기본값을 따른다 (darwin=대소문자 무시, 그 외=구분)", () => {
    const a = normalizeRepoRelative("Package.json");
    const b = normalizeRepoRelative("package.json");
    if (process.platform === "darwin") {
      expect(a).toBe(b);
    } else {
      expect(a).not.toBe(b);
    }
  });

  it("basename 만 있는 경로와 하위 경로는 정규화 후에도 서로 다르게 유지된다(오탐 방지 전제)", () => {
    expect(normalizeRepoRelative("package.json")).not.toBe(
      normalizeRepoRelative("packages/foo/package.json"),
    );
  });

  // §z-parse D4/D6/D8/D10 — trim 옵션. 기본값 true 는 위 기존 테스트 전부가 이미 고정한다(옵션을
  // 넘기지 않아도 기존 동작 그대로). 여기서는 옵션을 명시했을 때의 동작 자체를 못박는다.
  describe("trim 옵션 (§z-parse D4/D6/D8/D10)", () => {
    it("trim 옵션을 명시하지 않으면 기본값 true — 선행/후행 공백류(개행 포함)를 제거한다", () => {
      expect(normalizeRepoRelative("\n  scripts/check.sh  \n")).toBe("scripts/check.sh");
    });

    it("trim:true 를 명시해도 기본값과 동일하게 선행/후행 개행을 제거한다", () => {
      expect(normalizeRepoRelative("\nweird-name.txt\n", { trim: true })).toBe("weird-name.txt");
    });

    it("trim:false 면 선행/후행 개행이 실제 파일명의 일부로 보존된다", () => {
      expect(
        normalizeRepoRelative("\nweird-name.txt\n", { trim: false, caseInsensitive: false }),
      ).toBe("\nweird-name.txt\n");
    });

    it("trim:false 라도 슬래시 정리·NFC 정규화 등 나머지 정규화는 그대로 적용된다", () => {
      const nfc = "한글".normalize("NFC");
      const nfd = "한글".normalize("NFD");
      expect(
        normalizeRepoRelative(`\n./docs/${nfc}/STATE.json\n`, { trim: false, caseInsensitive: false }),
      ).toBe(
        normalizeRepoRelative(`\n./docs/${nfd}/STATE.json\n`, { trim: false, caseInsensitive: false }),
      );
      // 선행 "./" 는 trim 과 무관하게 항상 제거된다(개행 앞의 "./" 이므로 posix.normalize 가 처리) —
      // 다만 맨 앞의 개행 자체는 trim:false 이므로 보존된다.
      expect(normalizeRepoRelative("./docs/STATE.json\n", { trim: false, caseInsensitive: false })).toBe(
        "docs/STATE.json\n",
      );
    });

    it("trim:false + 빈 문자열은 빈 문자열, trim:false + 공백만 있는 문자열은 그 공백을 그대로 보존한다", () => {
      expect(normalizeRepoRelative("", { trim: false })).toBe("");
      expect(normalizeRepoRelative("   ", { trim: false })).toBe("   ");
    });
  });
});

describe("displayPath (§z-parse P4/D1 — 가역 표시용 이스케이프)", () => {
  it("일반 경로는 JSON 문자열 리터럴로 감싼다", () => {
    expect(displayPath("package.json")).toBe('"package.json"');
  });

  it("개행·탭 등 제어문자를 표준 이스케이프로 표기한다(가시적이고 한 줄을 유지)", () => {
    const withControlChars = "weird\nname\t.txt";
    const displayed = displayPath(withControlChars);
    expect(displayed).not.toContain("\n");
    expect(displayed).not.toContain("\t");
    expect(displayed).toBe('"weird\\nname\\t.txt"');
  });

  it("가역적이다 — JSON.parse 로 원본을 정확히 복원할 수 있다", () => {
    const originals = ["package.json", "weird\nname.txt", 'file"with"quote.txt', "한글파일.txt", ""];
    for (const original of originals) {
      expect(JSON.parse(displayPath(original))).toBe(original);
    }
  });

  it("큰따옴표를 이스케이프해 JSON 문법을 깨지 않는다", () => {
    expect(displayPath('a"b')).toBe('"a\\"b"');
  });
});

describe("truncateForDisplay (§z-parse D7 전용 — 임의 길이 원문 절단)", () => {
  it("199자(상한 미만)는 그대로 반환한다(절단 표기 없음)", () => {
    const text = "a".repeat(199);
    expect(truncateForDisplay(text, 200)).toBe(text);
  });

  it("정확히 200자(상한과 동일)는 그대로 반환한다(절단 표기 없음) — 경계는 '초과'만 자른다", () => {
    const text = "a".repeat(200);
    expect(truncateForDisplay(text, 200)).toBe(text);
  });

  it("201자(상한 초과)는 200자로 자르고 잘림과 원본 길이를 표기한다", () => {
    const text = "a".repeat(201);
    const result = truncateForDisplay(text, 200);
    expect(result.startsWith("a".repeat(200))).toBe(true);
    expect(result).not.toBe(text);
    expect(result).toContain("201");
  });

  it("limit 인자를 생략하면 기본값 200을 쓴다", () => {
    expect(truncateForDisplay("a".repeat(200))).toBe("a".repeat(200));
    expect(truncateForDisplay("a".repeat(201))).not.toBe("a".repeat(201));
  });
});

// §32 m-3 — 감사 실측: `bash -lc 'exit 0'`/`sh -ec 'exit 0'`/`/bin/bash -c 'exit 0'` 를
// unwrapShC 가 못 벗겨 verifylint.ts 가 이슈 0건으로 놓쳤다(항상 exit 0). 이 함수는
// verifylint.ts(린트)와 gate.ts(verifyReferencedFiles, 위조 가드)양쪽이 공유하므로 — 직접
// 단위 테스트로 형태 인식을 못박는다.
describe("unwrapShC — §32 m-3: 절대경로·zsh/ksh·-lc/-ec 클러스터 인식", () => {
  it("기존 회귀: 'bash -c \\'...\\'' (단순 -c) 는 그대로 벗겨진다", () => {
    expect(unwrapShC("bash -c 'npm test'")).toEqual({ inner: "npm test", pipefailForced: false });
  });

  it("기존 회귀: 'sh -c \"...\"' (큰따옴표) 는 그대로 벗겨진다", () => {
    expect(unwrapShC('sh -c "npm test"')).toEqual({ inner: "npm test", pipefailForced: false });
  });

  it("기존 회귀: 'bash -o pipefail -c ...' 는 pipefailForced:true 로 벗겨진다", () => {
    expect(unwrapShC("bash -o pipefail -c 'npm test | tee out.log'")).toEqual({
      inner: "npm test | tee out.log",
      pipefailForced: true,
    });
  });

  it("'bash -lc' (로그인 셸 + -c 클러스터) 를 벗긴다", () => {
    expect(unwrapShC("bash -lc 'exit 0'")).toEqual({ inner: "exit 0", pipefailForced: false });
  });

  it("'sh -ec' (errexit + -c 클러스터) 를 벗긴다", () => {
    expect(unwrapShC("sh -ec 'exit 0'")).toEqual({ inner: "exit 0", pipefailForced: false });
  });

  it("'/bin/bash -c' (절대경로 접두) 를 벗긴다", () => {
    expect(unwrapShC("/bin/bash -c 'exit 0'")).toEqual({ inner: "exit 0", pipefailForced: false });
  });

  it("'/usr/bin/env sh -c' 처럼 여러 단계 절대경로가 섞여도 shell 토큰 앞의 경로만 벗긴다", () => {
    // env 자체는 셸이 아니므로 이 함수의 대상이 아니다 — sh 토큰 자체에 경로 접두가 없으면
    // 여전히 그 토큰부터 매치를 시도한다(전체 문자열이 `^...sh ...` 로 시작해야 하므로 이
    // 경우는 매치되지 않는 것이 맞다 — env 언래핑은 verifylint.ts 의 별도 책임이다).
    expect(unwrapShC("/usr/bin/env sh -c 'exit 0'")).toBeNull();
  });

  it("'zsh -c'/'ksh -c' 도 인식한다", () => {
    expect(unwrapShC("zsh -c 'exit 0'")).toEqual({ inner: "exit 0", pipefailForced: false });
    expect(unwrapShC("ksh -c 'exit 0'")).toEqual({ inner: "exit 0", pipefailForced: false });
  });

  it("무관한 문자열은 여전히 null이다(과잉 매칭 없음)", () => {
    expect(unwrapShC("npm test")).toBeNull();
    expect(unwrapShC("gitsh -c 'exit 0'")).toBeNull(); // 셸 이름이 아닌 단어에 끼워 맞추지 않는다
  });
});

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runGate, verifyReferencedFiles, normalizeRepoPath, normalizeGitSourcePath } from "../src/gate.js";
import { defaultChangedFiles } from "../src/branch.js";

describe("runGate", () => {
  it("모두 exit 0 이면 passed", async () => {
    const r = await runGate({ commands: ["true", "echo ok"], cwd: "/tmp" });
    expect(r.passed).toBe(true);
    expect(r.results).toHaveLength(2);
    expect(r.results[1].output).toContain("ok");
  });

  it("실패 명령에서 중단하고 passed=false", async () => {
    const r = await runGate({ commands: ["false", "echo never"], cwd: "/tmp" });
    expect(r.passed).toBe(false);
    expect(r.results).toHaveLength(1); // 첫 실패에서 중단
    expect(r.results[0].exitCode).not.toBe(0);
  });

  it("존재하지 않는 명령은 fatal=true", async () => {
    const r = await runGate({ commands: ["definitely-not-a-command-xyz-9999"], cwd: "/tmp" });
    expect(r.passed).toBe(false);
    expect(r.results[0].fatal).toBe(true);
  });

  it("빈 명령 배열은 통과로 취급하지 않고 throw 한다", async () => {
    await expect(runGate({ commands: [], cwd: "/tmp" })).rejects.toThrow(/검증 명령/);
  });

  it("logFile 지정 시 로그를 남긴다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-gate-"));
    const logFile = path.join(dir, "logs", "phase-1.log");
    await runGate({ commands: ["echo logged"], cwd: "/tmp", logFile });
    expect(fs.readFileSync(logFile, "utf-8")).toContain("logged");
  });

  it("cwd 를 실제로 적용한다", async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fw-gate-cwd-")));
    const r = await runGate({ commands: ["pwd"], cwd: dir });
    expect(r.results[0].output.trim()).toBe(dir);
  });

  it(
    "타임아웃 시 SIGTERM 으로 종료하고 timedOut=true, passed=false, 빠르게 반환한다",
    async () => {
      const start = Date.now();
      const r = await runGate({ commands: ["sleep 30"], cwd: "/tmp", timeoutMs: 500 });
      const elapsed = Date.now() - start;
      expect(r.passed).toBe(false);
      expect(r.results[0].timedOut).toBe(true);
      // SIGTERM 만으로 즉시 종료되면 SIGKILL 에스컬레이션(5초)보다 훨씬 먼저 끝난다
      expect(elapsed).toBeLessThan(4500);
    },
    10000,
  );

  it(
    "stdin 을 ignore 하여 입력 대기 명령이 즉시 실패한다 (행 방지)",
    async () => {
      const start = Date.now();
      // `&&` 로 연결해야 read 가 EOF 로 실패했을 때 뒤의 echo 가 실행되지 않아 전체 exit code 에 반영된다
      const r = await runGate({ commands: ["read -r line && echo got=$line"], cwd: "/tmp" });
      const elapsed = Date.now() - start;
      expect(r.passed).toBe(false);
      // 기본 타임아웃(30분)까지 가지 않고 stdin EOF 로 즉시 실패해야 한다
      expect(elapsed).toBeLessThan(3000);
    },
    10000,
  );

  it("실행 권한 없는 스크립트(exit 126) 는 fatal=true", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-gate-126-"));
    const scriptPath = path.join(dir, "noperm.sh");
    fs.writeFileSync(scriptPath, "#!/bin/sh\necho hi\n");
    fs.chmodSync(scriptPath, 0o000);
    const r = await runGate({ commands: [scriptPath], cwd: dir });
    expect(r.results[0].exitCode).toBe(126);
    expect(r.results[0].fatal).toBe(true);
  });

  it("사용자 스크립트가 메시지 없이 exit 127 을 반환하면 fatal=false (오탐 방지)", async () => {
    const r = await runGate({ commands: ["exit 127"], cwd: "/tmp" });
    expect(r.results[0].exitCode).toBe(127);
    expect(r.results[0].fatal).toBe(false);
  });

  it("시그널로 종료되면 signal 을 기록한다", async () => {
    const r = await runGate({ commands: ["kill -9 $$"], cwd: "/tmp" });
    expect(r.results[0].signal).toBe("SIGKILL");
  });

  it("멀티바이트 대량 출력이 청크 경계에서 깨지지 않는다 (utf8 라운드트립)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-gate-utf8-"));
    const scriptPath = path.join(dir, "big.js");
    // 한글 3바이트 문자 * 60000 = UTF-8 기준 약 180KB — 청크 경계에서 잘리기 쉬운 크기
    fs.writeFileSync(scriptPath, "process.stdout.write('가'.repeat(60000));");
    const r = await runGate({ commands: [`node ${scriptPath}`], cwd: dir });
    expect(r.results[0].output).not.toContain("�");
    expect(r.results[0].output.length).toBeGreaterThanOrEqual(60000);
  });

  it(
    "복합 명령(&&)도 타임아웃 시 그룹 전체가 종료된다 — 손자 프로세스 탈출 방지",
    async () => {
      const start = Date.now();
      const r = await runGate({ commands: ["sleep 30 && echo x"], cwd: "/tmp", timeoutMs: 700 });
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(2000);
      expect(r.results[0].timedOut).toBe(true);
      expect(r.passed).toBe(false);
    },
    10000,
  );

  it(
    "래퍼 스크립트(내부에서 sleep) 도 타임아웃 시 그룹 전체가 종료된다",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-gate-wrapper-"));
      const scriptPath = path.join(dir, "build.sh");
      fs.writeFileSync(scriptPath, "#!/bin/sh\necho start\nsleep 30\necho end\n");
      fs.chmodSync(scriptPath, 0o755);
      const start = Date.now();
      const r = await runGate({ commands: [scriptPath], cwd: dir, timeoutMs: 700 });
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(2000);
      expect(r.results[0].timedOut).toBe(true);
    },
    10000,
  );

  it(
    "timedOut 이면 exitCode 가 0 이어도 passed=false 로 판정한다 (고아가 파이프를 쥐고 있어도)",
    async () => {
      // 셸은 백그라운드로 sleep 을 던져놓고 곧바로 exit 0 으로 끝나지만, 같은 프로세스 그룹의
      // 고아 sleep 이 stdout 파이프를 쥐고 있어 close 이벤트가 타임아웃 전까지 오지 않는다
      const r = await runGate({ commands: ["(sleep 5 &) ; true"], cwd: "/tmp", timeoutMs: 700 });
      expect(r.results[0].timedOut).toBe(true);
      expect(r.passed).toBe(false);
    },
    10000,
  );

  it("로그 쓰기 실패(읽기 전용 디렉터리) 시에도 GateResult 를 정상 반환한다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-gate-rolog-"));
    fs.chmodSync(dir, 0o500); // 쓰기 금지 (읽기+실행만) — logs/ 하위 디렉터리 생성이 실패해야 함
    const logFile = path.join(dir, "logs", "phase-1.log");
    try {
      const r = await runGate({ commands: ["echo ok"], cwd: "/tmp", logFile });
      expect(r.passed).toBe(true);
      expect(fs.existsSync(logFile)).toBe(false);
    } finally {
      fs.chmodSync(dir, 0o700); // 정리 가능하도록 권한 복원
    }
  });
});

describe("verifyReferencedFiles (§24 감사 S1 — 게이트 위조 차단의 전제)", () => {
  it("./ 로 시작하는 첫 토큰은 그 경로 자체를 참조 대상으로 뽑는다", () => {
    expect(verifyReferencedFiles(["./scripts/check.sh arg1"])).toEqual(["./scripts/check.sh"]);
  });

  it("npm/pnpm/yarn 은 package.json 을 참조 대상으로 본다", () => {
    expect(verifyReferencedFiles(["npm test"])).toEqual(["package.json"]);
    expect(verifyReferencedFiles(["pnpm run build"])).toEqual(["package.json"]);
    expect(verifyReferencedFiles(["yarn test"])).toEqual(["package.json"]);
  });

  it("gradle/gradlew(./gradlew 포함) 는 gradle 빌드 설정 파일들을 참조 대상으로 본다", () => {
    const expected = expect.arrayContaining([
      "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "gradle.properties",
    ]);
    expect(verifyReferencedFiles(["./gradlew build"])).toEqual(expected);
    expect(verifyReferencedFiles(["gradle build"])).toEqual(expected);
    // "./gradlew" 자신도 함께 포함된다 (첫 토큰이 "./" 로 시작하는 규칙과 중복 적용)
    expect(verifyReferencedFiles(["./gradlew build"])).toEqual(expect.arrayContaining(["./gradlew"]));
  });

  it("make 는 Makefile/makefile 을 참조 대상으로 본다", () => {
    expect(verifyReferencedFiles(["make test"])).toEqual(expect.arrayContaining(["Makefile", "makefile"]));
  });

  it("pytest/python 은 파이썬 프로젝트 설정 파일들을 참조 대상으로 본다", () => {
    const expected = expect.arrayContaining(["pyproject.toml", "setup.cfg", "tox.ini", "conftest.py"]);
    expect(verifyReferencedFiles(["pytest -q"])).toEqual(expected);
    expect(verifyReferencedFiles(["python -m pytest"])).toEqual(expected);
  });

  it("cargo 는 Cargo.toml 을 참조 대상으로 본다", () => {
    expect(verifyReferencedFiles(["cargo test"])).toEqual(["Cargo.toml"]);
  });

  it("go 는 go.mod 를 참조 대상으로 본다", () => {
    expect(verifyReferencedFiles(["go test ./..."])).toEqual(["go.mod"]);
  });

  it("명령 어디든 .sh/.py/.js/.ts 로 끝나는 토큰이 있으면 그 경로를 뽑는다", () => {
    expect(verifyReferencedFiles(["bash scripts/check.sh"])).toEqual(["scripts/check.sh"]);
    expect(verifyReferencedFiles(["node scripts/build.js"])).toEqual(["scripts/build.js"]);
    expect(verifyReferencedFiles(["python3 tools/verify.py"])).toEqual(
      expect.arrayContaining(["tools/verify.py", "pyproject.toml", "setup.cfg", "tox.ini", "conftest.py"]),
    );
  });

  it("여러 명령을 합쳐 중복 없이 반환한다", () => {
    const out = verifyReferencedFiles(["npm test", "npm run lint"]);
    expect(out).toEqual(["package.json"]);
  });

  it("어떤 패턴에도 안 걸리면 빈 배열이다 (예: 'true', 'echo ok')", () => {
    expect(verifyReferencedFiles(["true", "echo ok"])).toEqual([]);
  });

  it("빈 배열/빈 문자열 명령은 무시한다", () => {
    expect(verifyReferencedFiles([])).toEqual([]);
    expect(verifyReferencedFiles(["  "])).toEqual([]);
  });

  describe("§29 MI-8: §26 C3 가 '기타 미탐' 으로 남겨둔 3형태 + bash -c 재귀", () => {
    it("'cd <dir> && <cmd>' 는 <dir>/ 접두를 붙인 설정 파일을 참조 대상으로 본다 (모노레포)", () => {
      expect(verifyReferencedFiles(["cd sub && npm test"])).toEqual(["sub/package.json"]);
    });

    it("'cd' 체이닝이 중첩돼도 접두가 누적된다", () => {
      expect(verifyReferencedFiles(["cd a && cd b && npm test"])).toEqual(["a/b/package.json"]);
    });

    it("'npx vitest run' 은 vitest 설정 파일을 참조 대상으로 본다", () => {
      const out = verifyReferencedFiles(["npx vitest run"]);
      expect(out).toEqual(expect.arrayContaining(["vitest.config.ts", "vitest.config.js"]));
      expect(out.length).toBeGreaterThan(0);
    });

    it("'npx jest' 도 jest 설정 파일을 참조 대상으로 본다", () => {
      expect(verifyReferencedFiles(["npx jest"])).toEqual(
        expect.arrayContaining(["jest.config.ts", "jest.config.js"]),
      );
    });

    it("매핑에 없는 npx 도구는 과잉 가드하지 않고 빈 배열로 남긴다 (오탐 방지)", () => {
      expect(verifyReferencedFiles(["npx some-unknown-tool run"])).toEqual([]);
    });

    it("'docker compose ...' 는 compose 파일들을 참조 대상으로 본다", () => {
      const out = verifyReferencedFiles(["docker compose run --rm test"]);
      expect(out).toEqual(
        expect.arrayContaining(["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]),
      );
    });

    it("'docker-compose ...' (하이픈 결합형)도 동일하게 인식한다", () => {
      expect(verifyReferencedFiles(["docker-compose run test"])).toEqual(
        expect.arrayContaining(["docker-compose.yml"]),
      );
    });

    it("'bash -c \\'<cmd>\\'' 는 내부 명령을 재귀 분석한다", () => {
      expect(verifyReferencedFiles(["bash -c 'npm test'"])).toEqual(["package.json"]);
    });

    it("'sh -c \"<cmd>\"' (큰따옴표)도 재귀 분석한다", () => {
      expect(verifyReferencedFiles(['sh -c "npm test"'])).toEqual(["package.json"]);
    });

    it("'cd <dir> && bash -c ...' 조합도 접두가 재귀적으로 적용된다", () => {
      expect(verifyReferencedFiles(["cd sub && bash -c 'npm test'"])).toEqual(["sub/package.json"]);
    });

    it("과잉 가드 방지: 'cd -' 나 세미콜론 체이닝처럼 애매한 형태는 그냥 놓친다(오탐보다 미탐이 안전한 방향)", () => {
      // "cd -" 뒤에 "&&" 가 없으면 그냥 인식하지 않는다 — 억지로 잘못된 접두를 만들지 않는다
      expect(verifyReferencedFiles(["cd -"])).toEqual([]);
      // 세미콜론 체이닝은 "cd" 규칙이 "&&" 만 인식하므로 걸리지 않는다(및 npm 도 못 뽑음) — 이건
      // §26 기존 동작에서도 이미 못 뽑던 형태로, 이번 변경이 새로 과잉 가드하지 않는지만 확인한다
      expect(verifyReferencedFiles(["cd sub; npm test"])).toEqual([]);
    });
  });
});

describe("normalizeRepoPath (§26 C3 — verifyReferencedFiles 의 './' 출력과 git diff 출력을 같은 형태로 비교하기 위한 정규화)", () => {
  it("선행 './' 를 제거한다", () => {
    expect(normalizeRepoPath("./scripts/check.sh")).toBe("scripts/check.sh");
    expect(normalizeRepoPath("./gradlew")).toBe("gradlew");
  });

  it("이미 './' 가 없는 경로는 그대로 둔다", () => {
    expect(normalizeRepoPath("scripts/check.sh")).toBe("scripts/check.sh");
    expect(normalizeRepoPath("package.json")).toBe("package.json");
  });

  it("중복 슬래시/후행 슬래시를 정리한다", () => {
    expect(normalizeRepoPath("scripts//check.sh")).toBe("scripts/check.sh");
    expect(normalizeRepoPath("scripts/check.sh/")).toBe("scripts/check.sh");
  });

  it("선행 슬래시(절대경로처럼 보이는 표기)를 제거해 리포-상대 경로로 맞춘다", () => {
    expect(normalizeRepoPath("/package.json")).toBe("package.json");
  });

  it("정규화 후 서로 다른 표기의 './' 유무만 다른 두 경로는 동일하게 취급된다", () => {
    expect(normalizeRepoPath("./scripts/check.sh")).toBe(normalizeRepoPath("scripts/check.sh"));
    expect(normalizeRepoPath("./gradlew")).toBe(normalizeRepoPath("gradlew"));
  });

  it("basename 만 있는 경로와 하위 경로는 정규화 후에도 서로 다르게 유지된다 (I7 — 모노레포 오탐 방지 전제)", () => {
    expect(normalizeRepoPath("package.json")).not.toBe(normalizeRepoPath("packages/foo/package.json"));
  });

  describe("§29 MI-7: 비ASCII 경로(quotePath/NFC/대소문자) 위조 미탐 재현", () => {
    it("core.quotePath 8진 이스케이프로 감싸인 한글 경로를 언이스케이프한 뒤 일반 경로와 동일 취급한다", () => {
      // 감사 실측 원문: git diff --name-only 가 "scripts/\355\225\234\352\270\200.sh" 를 낸다
      expect(normalizeRepoPath('"scripts/\\355\\225\\234\\352\\270\\200.sh"')).toBe(
        normalizeRepoPath("scripts/한글.sh"),
      );
    });

    it("NFC/NFD 로 다르게 표현된 동일 한글 경로를 같은 문자열로 정규화한다", () => {
      const nfc = "scripts/한글.sh".normalize("NFC");
      const nfd = "scripts/한글.sh".normalize("NFD");
      expect(nfc).not.toBe(nfd); // 전제 확인
      expect(normalizeRepoPath(nfc)).toBe(normalizeRepoPath(nfd));
    });

    it("현재 플랫폼 기본 대소문자 규칙을 따른다 (darwin=무시, 그 외=구분)", () => {
      const a = normalizeRepoPath("Package.json");
      const b = normalizeRepoPath("package.json");
      if (process.platform === "darwin") {
        expect(a).toBe(b);
      } else {
        expect(a).not.toBe(b);
      }
    });
  });
});

// §z-parse P5/P10/D4/D10: gate.ts 의 normalizeRepoPath 를 git-출처 전용(unquote·trim 모두 생략)과
// 비-git 출처용(기존 유지, 위 describe)으로 분리한 신규 변형. -z 전환으로 branch.ts 의
// defaultChangedFiles(changed) 가 더 이상 core.quotePath 로 감싸이지 않는 raw 파일명을 그대로
// 반환하므로, unquoteGitPath 를 걸면 우연히 큰따옴표로 시작·끝나는 실제 파일명을 quotePath
// 이스케이프로 오인해 손상시킨다(P5) — 그리고 trim() 을 걸면 개행으로 시작·끝나는 실제 파일명의
// 경계 공백이 조용히 잘려나간다(D4/D10).
describe("normalizeGitSourcePath (§z-parse P5/P10/D4/D10) — git-출처 전용, unquote·trim 모두 생략", () => {
  it("빈 문자열은 빈 문자열로 남긴다 (바깥쪽 trim 제거 후에도 조기 반환 유지, D10)", () => {
    expect(normalizeGitSourcePath("")).toBe("");
  });

  it("선행 './'·중복 슬래시 정리 등 unquote/trim 과 무관한 정규화는 normalizeRepoPath 와 동일하게 적용된다", () => {
    expect(normalizeGitSourcePath("./scripts/check.sh")).toBe("scripts/check.sh");
    expect(normalizeGitSourcePath("scripts//check.sh")).toBe("scripts/check.sh");
    expect(normalizeGitSourcePath("scripts/check.sh/")).toBe("scripts/check.sh");
  });

  it("큰따옴표로 시작·끝나는 실제 파일명을 quotePath 이스케이프로 오인해 unquote 하지 않는다 (P5 핵심 케이스)", () => {
    // -z 는 quotePath 이스케이프를 적용하지 않으므로 이런 raw 파일명이 그대로 올 수 있다. 비-git
    // 출처 변형(normalizeRepoPath)이라면 unquoteGitPath 가 이를 8진 이스케이프로 잘못 해석해
    // 손상시켰을 형태다 — git-출처 변형은 그 처리를 아예 생략해야 한다.
    const raw = '"weird-file".txt';
    expect(normalizeGitSourcePath(raw)).toBe(raw);
  });

  it("선행·후행 개행이 trim 되지 않고 그대로 보존된다 (D4/D10)", () => {
    const leading = "\nleading.txt";
    const trailing = "trailing.txt\n";
    expect(normalizeGitSourcePath(leading)).toBe(leading);
    expect(normalizeGitSourcePath(trailing)).toBe(trailing);
  });

  it("normalizeRepoPath(비-git 출처)와 달리 선행·후행 개행을 지우지 않는다는 점에서 서로 다르게 동작한다", () => {
    const withNewline = "\nleading.txt";
    expect(normalizeRepoPath(withNewline)).not.toBe(withNewline); // 비-git: trim 됨
    expect(normalizeGitSourcePath(withNewline)).toBe(withNewline); // git-출처: trim 안 됨
  });

  describe("[NUL-z] 실제 git 이 낸 -z 원문을 normalizeGitSourcePath 에 통과 (E11)", () => {
    let gitDir: string;
    let head0: string;

    function initGitDir(): void {
      gitDir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-gate-nulz-"));
      execFileSync("git", ["init", "-q"], { cwd: gitDir });
      execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: gitDir });
      execFileSync("git", ["config", "user.name", "t"], { cwd: gitDir });
      fs.writeFileSync(path.join(gitDir, "a.txt"), "1");
      execFileSync("git", ["add", "."], { cwd: gitDir });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: gitDir });
      head0 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: gitDir }).toString().trim();
    }

    it("[NUL-z] 개행·따옴표·비ASCII 파일명이 defaultChangedFiles(-z 파싱)를 거쳐 normalizeGitSourcePath 에 원문 그대로 통과한다", async () => {
      initGitDir();
      const leadingNewline = "\nleading.txt";
      const trailingNewline = "trailing.txt\n";
      const withQuote = 'file"with"quote.txt';
      const withUnicode = "한글파일.txt";
      fs.writeFileSync(path.join(gitDir, leadingNewline), "1");
      fs.writeFileSync(path.join(gitDir, trailingNewline), "1");
      fs.writeFileSync(path.join(gitDir, withQuote), "1");
      fs.writeFileSync(path.join(gitDir, withUnicode), "1");
      execFileSync("git", ["add", "-A"], { cwd: gitDir });
      execFileSync("git", ["commit", "-q", "-m", "add weird files"], { cwd: gitDir });

      // defaultChangedFiles 는 실제 git 프로세스(`git diff --name-only -z`)가 낸 raw NUL-분리
      // 필드를 trim 없이 그대로 반환한다(branch.ts, D8) — 이 배열의 각 원소가 orchestrator.ts/
      // prloop.ts 의 비교 지점에서 normalizeGitSourcePath 로 정규화되는 실제 changed 값이다.
      const result = await defaultChangedFiles(gitDir, head0);
      if (!result.ok) throw new Error("expected ok:true");
      expect(result.files).toContain(leadingNewline);
      expect(result.files).toContain(trailingNewline);
      expect(result.files).toContain(withQuote);
      expect(result.files).toContain(withUnicode);

      // 순수 함수이므로 함수 호출 깊이가 아니라 원문이 실제 git 산출물인지가 요점(E11) — 이
      // raw 원문들을 normalizeGitSourcePath 에 통과시켜도 unquote/trim 손상 없이 원문 그대로임을
      // 확인한다.
      for (const raw of [leadingNewline, trailingNewline, withQuote, withUnicode]) {
        expect(normalizeGitSourcePath(raw)).toBe(raw);
      }
    });

    // §tamper-gap E3(반드시 사람이 diff 로 확인): 이 pin 테스트는 이전 사이클(z-parse)에서
    // "defaultChangedFiles 는 rename 에 대해 NEW 경로만 반환한다(NEW-only 유지)" 를 "올바른
    // 동작"으로 못박고 있었다 — 그 결함(P1, rename OLD 미탐)을 이번 사이클이 정확히 고치므로
    // assertion 을 반전한다(OLD 경로도 포함되어야 한다). --no-renames 채택으로 rename 은
    // D(OLD 삭제)+A(NEW 추가) 로 분해되어 --name-only 가 둘 다 자연히 낸다(D5).
    it("[NUL-z] rename(git mv) 된 파일의 OLD/NEW 경로가 모두 changed 에 포함된다 (P1 해소, 반전된 pin)", async () => {
      initGitDir();
      const oldName = "\nold-name.txt";
      fs.writeFileSync(path.join(gitDir, oldName), "1");
      execFileSync("git", ["add", "-A"], { cwd: gitDir });
      execFileSync("git", ["commit", "-q", "-m", "add rename source"], { cwd: gitDir });
      const head1 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: gitDir }).toString().trim();
      const newName = 'new"name".txt';
      execFileSync("git", ["mv", oldName, newName], { cwd: gitDir });
      execFileSync("git", ["commit", "-q", "-m", "rename"], { cwd: gitDir });

      const result = await defaultChangedFiles(gitDir, head1);
      if (!result.ok) throw new Error("expected ok:true");
      // 반전된 단언: OLD 경로도 이제 포함된다 (구 pin: NEW 만 있었다).
      expect(result.files).toContain(oldName);
      expect(result.files).toContain(newName);
      expect(normalizeGitSourcePath(newName)).toBe(newName);
      expect(normalizeGitSourcePath(oldName)).toBe(oldName);
    });
  });
});

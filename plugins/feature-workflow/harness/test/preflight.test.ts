import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  preflight, defaultGitExec, defaultGhExec, parseRemoteHost, parsePorcelainZ,
  REASONS, type PreflightDeps, type CliExecResult, type PorcelainReason,
} from "../src/preflight.js";
import { StateSchema, type State } from "../src/state.js";
import { displayPath, truncateForDisplay } from "../src/paths.js";
import {
  record1, record2, recordUntracked, toZStdout,
} from "./helpers/porcelain-v2.js";

function makeState(overrides: Partial<State> = {}): State {
  return StateSchema.parse({
    schema_version: 1,
    workflow: "wf",
    repo_root: "/tmp/does-not-matter",
    branch_strategy: "isolate",
    allow_push: false,
    verify_default: ["npm test"],
    status: "running",
    pending_question: null,
    answers: [],
    phases: [
      { id: 1, title: "p1", status: "pending", depends_on: [], verify: [], attempts: 0, max_attempts: 2, sessions: [] },
    ],
    ...overrides,
  });
}

const ok = (stdout = ""): CliExecResult => ({ ok: true, stdout, stderr: "" });
const fail = (stderr = "boom"): CliExecResult => ({ ok: false, stdout: "", stderr });

describe("preflight", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-preflight-"));
  });

  it("repo_root 가 존재하지 않으면 문제로 보고한다", async () => {
    const state = makeState({ repo_root: path.join(dir, "does-not-exist") });
    const deps: PreflightDeps = { git: async () => ok() };
    const result = await preflight(state, deps);
    expect(result.ok).toBe(false);
    expect(result.problems.some(p => p.includes("존재하지 않습니다"))).toBe(true);
    expect(result.currentBranch).toBeNull();
  });

  it("repo_root 가 디렉토리가 아니면 문제로 보고한다", async () => {
    const file = path.join(dir, "not-a-dir");
    fs.writeFileSync(file, "x");
    const state = makeState({ repo_root: file });
    const deps: PreflightDeps = { git: async () => ok() };
    const result = await preflight(state, deps);
    expect(result.ok).toBe(false);
    expect(result.problems.some(p => p.includes("디렉토리가 아닙니다"))).toBe(true);
  });

  it("git 저장소가 아니면 문제로 보고한다", async () => {
    const state = makeState({ repo_root: dir });
    const deps: PreflightDeps = { git: async () => fail("fatal: not a git repository") };
    const result = await preflight(state, deps);
    expect(result.ok).toBe(false);
    expect(result.problems.some(p => p.includes("git 저장소가 아닙니다"))).toBe(true);
    expect(result.currentBranch).toBeNull();
  });

  it("워킹트리가 더러우면 문제로 보고한다", async () => {
    const state = makeState({ repo_root: dir });
    const deps: PreflightDeps = {
      git: async (args) => {
        if (args[0] === "rev-parse" && args[1] === "--git-dir") return ok(".git");
        // porcelain v2: 공용 빌더 헬퍼로 정형 레코드를 만든다(D2) — 파싱 자체가 관심사가 아니다.
        if (args[0] === "status") return ok(toZStdout([record1("dirty-file.txt")]));
        if (args[0] === "rev-parse" && args.includes("HEAD")) return ok("main");
        return ok();
      },
    };
    const result = await preflight(state, deps);
    expect(result.ok).toBe(false);
    expect(result.problems.some(p => p.includes("커밋되지 않은 변경"))).toBe(true);
    // 브랜치는 그래도 확인해 currentBranch 를 채운다 (다른 문제와 독립적으로 계속 진행)
    expect(result.currentBranch).toBe("main");
  });

  it("현재 브랜치 확인에 실패하면 문제로 보고하고 currentBranch 는 null 로 남는다", async () => {
    const state = makeState({ repo_root: dir });
    const deps: PreflightDeps = {
      git: async (args) => {
        if (args[0] === "rev-parse" && args[1] === "--git-dir") return ok(".git");
        if (args[0] === "status") return ok("");
        if (args[0] === "rev-parse" && args.includes("HEAD")) return fail("detached weirdness");
        return ok();
      },
    };
    const result = await preflight(state, deps);
    expect(result.ok).toBe(false);
    expect(result.problems.some(p => p.includes("현재 브랜치를 확인할 수 없습니다"))).toBe(true);
    expect(result.currentBranch).toBeNull();
  });

  it("모든 검사를 통과하면 ok:true 와 currentBranch 를 반환한다", async () => {
    const state = makeState({ repo_root: dir });
    const deps: PreflightDeps = {
      git: async (args) => {
        if (args[0] === "rev-parse" && args[1] === "--git-dir") return ok(".git");
        if (args[0] === "status") return ok("");
        if (args[0] === "rev-parse" && args.includes("HEAD")) return ok("feature/x\n");
        return ok();
      },
    };
    const result = await preflight(state, deps);
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.currentBranch).toBe("feature/x");
  });

  it("pr_mode 면 gh auth status 실패를 문제로 보고한다", async () => {
    const state = makeState({ repo_root: dir, pr_mode: true, allow_push: true });
    const deps: PreflightDeps = {
      git: async (args) => {
        if (args[0] === "rev-parse" && args[1] === "--git-dir") return ok(".git");
        if (args[0] === "status") return ok("");
        if (args[0] === "rev-parse" && args.includes("HEAD")) return ok("main");
        return ok();
      },
      gh: async () => fail("not logged in"),
    };
    const result = await preflight(state, deps);
    expect(result.ok).toBe(false);
    expect(result.problems.some(p => p.includes("gh auth status"))).toBe(true);
  });

  it("pr_mode 면 gh auth status 성공 시 문제 없음", async () => {
    const state = makeState({ repo_root: dir, pr_mode: true, allow_push: true });
    const deps: PreflightDeps = {
      git: async (args) => {
        if (args[0] === "rev-parse" && args[1] === "--git-dir") return ok(".git");
        if (args[0] === "status") return ok("");
        if (args[0] === "rev-parse" && args.includes("HEAD")) return ok("main");
        return ok();
      },
      gh: async () => ok("logged in"),
    };
    const result = await preflight(state, deps);
    expect(result.ok).toBe(true);
  });

  it("pr_mode 가 아니면 gh 를 호출하지 않는다", async () => {
    const state = makeState({ repo_root: dir, pr_mode: false });
    let ghCalled = false;
    const deps: PreflightDeps = {
      git: async (args) => {
        if (args[0] === "rev-parse" && args[1] === "--git-dir") return ok(".git");
        if (args[0] === "status") return ok("");
        if (args[0] === "rev-parse" && args.includes("HEAD")) return ok("main");
        return ok();
      },
      gh: async () => {
        ghCalled = true;
        return ok();
      },
    };
    const result = await preflight(state, deps);
    expect(result.ok).toBe(true);
    expect(ghCalled).toBe(false);
  });

  describe("defaultGitExec/defaultGhExec — 실제 CLI (스텁 없이)", () => {
    it("실제 git 저장소에서 깨끗한 워킹트리는 통과한다", async () => {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      fs.writeFileSync(path.join(dir, ".gitignore"), "logs/\ndocs/*/logs/\n");
      execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
      fs.writeFileSync(path.join(dir, "a.txt"), "1");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });

      const state = makeState({ repo_root: dir });
      const result = await preflight(state, { git: defaultGitExec });
      expect(result.ok).toBe(true);
      expect(result.currentBranch).toBeTruthy();
    });

    it("실제 git 저장소에서 더러운 워킹트리는 문제로 보고한다", async () => {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      fs.writeFileSync(path.join(dir, ".gitignore"), "logs/\ndocs/*/logs/\n");
      execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
      fs.writeFileSync(path.join(dir, "a.txt"), "1");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
      fs.writeFileSync(path.join(dir, "a.txt"), "2 (uncommitted)");

      const state = makeState({ repo_root: dir });
      const result = await preflight(state, { git: defaultGitExec });
      expect(result.ok).toBe(false);
      expect(result.problems.some(p => p.includes("커밋되지 않은 변경"))).toBe(true);
    });

    it("실제 non-git 디렉토리는 문제로 보고한다", async () => {
      const state = makeState({ repo_root: dir });
      const result = await preflight(state, { git: defaultGitExec });
      expect(result.ok).toBe(false);
      expect(result.problems.some(p => p.includes("git 저장소가 아닙니다"))).toBe(true);
    });

    it("defaultGhExec 는 gh 실행 결과를 ok/stdout/stderr 로 반환한다 (형식만 검증)", async () => {
      // 실제 CI/개발 환경의 gh 인증 상태에 의존하지 않고, 호출 자체가 예외 없이 결과 형태를
      // 돌려주는지만 확인한다.
      const result = await defaultGhExec(["--version"], dir);
      expect(typeof result.ok).toBe("boolean");
      expect(typeof result.stdout).toBe("string");
      expect(typeof result.stderr).toBe("string");
    });
  });

  describe("§26 C1: workflowDir 서브트리는 워킹트리 청결 검사에서 제외한다 (재개 경로 자충수 수정)", () => {
    it("실제 git 리포: docs/wf/STATE.json 을 커밋한 뒤 saveState 로 다시 고쳐도(=workflowDir 하위만 dirty) ok:true", async () => {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      fs.writeFileSync(path.join(dir, ".gitignore"), "logs/\ndocs/*/logs/\n");
      execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
      const workflowDir = path.join(dir, "docs", "wf");
      fs.mkdirSync(workflowDir, { recursive: true });
      fs.writeFileSync(path.join(workflowDir, "STATE.json"), "{}\n");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });

      // saveState() 흉내 — 매 attempt/phase 마다 STATE.json 을 다시 쓴다
      fs.writeFileSync(path.join(workflowDir, "STATE.json"), '{"changed":true}\n');
      // .fw.lock/logs/ 도 workflowDir 하위에 생긴다 (untracked) — 함께 제외되는지 확인
      fs.writeFileSync(path.join(workflowDir, ".fw.lock"), "12345");
      fs.mkdirSync(path.join(workflowDir, "logs"));
      fs.writeFileSync(path.join(workflowDir, "logs", "run-1.log"), "log");

      const state = makeState({ repo_root: dir });
      const result = await preflight(state, { git: defaultGitExec }, workflowDir);
      expect(result.ok).toBe(true);
      expect(result.problems).toEqual([]);
    });

    it("실제 git 리포: workflowDir 밖 파일이 dirty 면 여전히 ok:false (방어는 유지)", async () => {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      fs.writeFileSync(path.join(dir, ".gitignore"), "logs/\ndocs/*/logs/\n");
      execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
      const workflowDir = path.join(dir, "docs", "wf");
      fs.mkdirSync(workflowDir, { recursive: true });
      fs.writeFileSync(path.join(workflowDir, "STATE.json"), "{}\n");
      fs.writeFileSync(path.join(dir, "src.txt"), "1");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });

      // workflowDir 밖 파일을 사람이 고침 — 이건 여전히 걸려야 한다
      fs.writeFileSync(path.join(dir, "src.txt"), "2 (uncommitted, unrelated)");
      // workflowDir 안도 같이 dirty — 이것만으로는 막히지 않아야 하지만, 밖의 변경 때문에 결국 ok:false
      fs.writeFileSync(path.join(workflowDir, "STATE.json"), '{"changed":true}\n');

      const state = makeState({ repo_root: dir });
      const result = await preflight(state, { git: defaultGitExec }, workflowDir);
      expect(result.ok).toBe(false);
      expect(result.problems.some(p => p.includes("커밋되지 않은 변경"))).toBe(true);
    });

    it("workflowDir 이 없으면(미지정) 기존처럼 리포 전체를 검사한다 (하위호환)", async () => {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      fs.writeFileSync(path.join(dir, ".gitignore"), "logs/\ndocs/*/logs/\n");
      execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
      fs.writeFileSync(path.join(dir, "a.txt"), "1");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
      fs.writeFileSync(path.join(dir, "a.txt"), "2 (uncommitted)");

      const state = makeState({ repo_root: dir });
      const result = await preflight(state, { git: defaultGitExec }); // workflowDir 없이 호출
      expect(result.ok).toBe(false);
    });

    it("workflowDir 이 repo_root 밖이면 필터링하지 않고 전체를 검사한다", async () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "fw-preflight-outside-"));
      const deps: PreflightDeps = {
        git: async args => {
          if (args[0] === "rev-parse" && args[1] === "--git-dir") return ok(".git");
          if (args[0] === "status") return ok(toZStdout([record1("some-file.txt")]));
          if (args[0] === "rev-parse" && args.includes("HEAD")) return ok("main");
          return ok();
        },
      };
      const state = makeState({ repo_root: dir });
      const result = await preflight(state, deps, outside);
      expect(result.ok).toBe(false);
      expect(result.problems.some(p => p.includes("커밋되지 않은 변경"))).toBe(true);
    });

    it("스텁 기반: workflowDir 하위 항목만 있는 --porcelain 출력은 걸러지고 ok:true", async () => {
      const workflowDir = path.join(dir, "docs", "wf");
      const deps: PreflightDeps = {
        git: async args => {
          if (args[0] === "rev-parse" && args[1] === "--git-dir") return ok(".git");
          if (args[0] === "status") {
            return ok(toZStdout([
              record1("docs/wf/STATE.json"),
              recordUntracked("docs/wf/.fw.lock"),
              recordUntracked("docs/wf/logs/run-1.log"),
            ]));
          }
          if (args[0] === "rev-parse" && args.includes("HEAD")) return ok("main");
          return ok();
        },
      };
      const state = makeState({ repo_root: dir });
      const result = await preflight(state, deps, workflowDir);
      expect(result.ok).toBe(true);
    });

    it("스텁 기반: workflowDir 밖 항목이 섞여 있으면 ok:false", async () => {
      const workflowDir = path.join(dir, "docs", "wf");
      const deps: PreflightDeps = {
        git: async args => {
          if (args[0] === "rev-parse" && args[1] === "--git-dir") return ok(".git");
          if (args[0] === "status") {
            return ok(toZStdout([record1("docs/wf/STATE.json"), record1("src/index.ts")]));
          }
          if (args[0] === "rev-parse" && args.includes("HEAD")) return ok("main");
          return ok();
        },
      };
      const state = makeState({ repo_root: dir });
      const result = await preflight(state, deps, workflowDir);
      expect(result.ok).toBe(false);
    });

    it("복구 안내 메시지에 git stash 를 언급하지 않는다 (STATE 손실 방지)", async () => {
      const state = makeState({ repo_root: dir });
      const deps: PreflightDeps = {
        git: async (args) => {
          if (args[0] === "rev-parse" && args[1] === "--git-dir") return ok(".git");
          if (args[0] === "status") return ok(toZStdout([record1("dirty-file.txt")]));
          if (args[0] === "rev-parse" && args.includes("HEAD")) return ok("main");
          return ok();
        },
      };
      const result = await preflight(state, deps);
      expect(result.ok).toBe(false);
      expect(result.problems.some(p => p.includes("stash"))).toBe(false);
    });
  });

  describe("§29 MI-4: 적대적 재감사 8케이스(A~H) 재현 — 실제 git 리포 픽스처", () => {
    it("A: docs/ 에 tracked 형제가 있고 workflowDir 만 untracked 이면 ok:true", async () => {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      fs.writeFileSync(path.join(dir, ".gitignore"), "logs/\ndocs/*/logs/\n");
      execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
      fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
      fs.writeFileSync(path.join(dir, "docs", "other-tracked.md"), "existing\n");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });

      const workflowDir = path.join(dir, "docs", "wf1");
      fs.mkdirSync(workflowDir, { recursive: true });
      fs.writeFileSync(path.join(workflowDir, "STATE.json"), "{}\n");

      const state = makeState({ repo_root: dir });
      const result = await preflight(state, { git: defaultGitExec }, workflowDir);
      expect(result.ok).toBe(true);
    });

    it("B: docs/ 전체가 untracked 라 git 이 디렉토리로 축약해도(--untracked-files=all 로 펼침) ok:true", async () => {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      fs.writeFileSync(path.join(dir, ".gitignore"), "logs/\ndocs/*/logs/\n");
      execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
      fs.writeFileSync(path.join(dir, "a.txt"), "1");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });

      // docs/ 자체가 이 리포에 한 번도 등장한 적 없다 — 기본 --porcelain 이면 git 이 "?? docs/" 로
      // 축약해 워크플로우 하위 파일명이 안 보이는 케이스(가장 흔한 첫 fw run 시나리오).
      const workflowDir = path.join(dir, "docs", "wf1");
      fs.mkdirSync(workflowDir, { recursive: true });
      fs.writeFileSync(path.join(workflowDir, "STATE.json"), "{}\n");

      // 기본 --porcelain(펼치지 않음)이 실제로 축약한다는 전제를 먼저 확인해둔다 — 이 전제가
      // 깨지면(git 버전 차이 등) 아래 preflight 검증의 의미가 없어진다.
      const rawPorcelain = execFileSync("git", ["status", "--porcelain"], { cwd: dir }).toString();
      expect(rawPorcelain.trim()).toBe("?? docs/");

      const state = makeState({ repo_root: dir });
      const result = await preflight(state, { git: defaultGitExec }, workflowDir);
      expect(result.ok).toBe(true);
    });

    it("D: repo_root 가 realpath 형태로 저장되고 workflowDir 은 symlink 를 경유해도 ok:true", async () => {
      const realDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fw-preflight-real-")));
      const symlinkDir = path.join(os.tmpdir(), `fw-preflight-symlink-${process.pid}-${Date.now()}`);
      fs.symlinkSync(realDir, symlinkDir);
      try {
        execFileSync("git", ["init", "-q"], { cwd: realDir });
      fs.writeFileSync(path.join(realDir, ".gitignore"), "logs/\ndocs/*/logs/\n");
        execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: realDir });
        execFileSync("git", ["config", "user.name", "t"], { cwd: realDir });
        fs.writeFileSync(path.join(realDir, "a.txt"), "1");
        execFileSync("git", ["add", "."], { cwd: realDir });
        execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: realDir });

        // workflowDir 은 symlink 를 경유한 경로로 구성한다(예: macOS `/tmp` → `/private/tmp` 처럼
        // cli.ts 가 path.resolve 만으로 만든 workflowDir 이 symlink 를 포함하는 상황을 흉내낸다).
        const workflowDirViaSymlink = path.join(symlinkDir, "docs", "wf1");
        fs.mkdirSync(workflowDirViaSymlink, { recursive: true });
        fs.writeFileSync(path.join(workflowDirViaSymlink, "STATE.json"), "{}\n");

        const state = makeState({ repo_root: realDir }); // repo_root 는 이미 realpath 형태
        const result = await preflight(state, { git: defaultGitExec }, workflowDirViaSymlink);
        expect(result.ok).toBe(true);
      } finally {
        fs.unlinkSync(symlinkDir);
      }
    });

    it("E: workflowDir 이름이 한글이면(core.quotePath 8진 이스케이프) 그래도 ok:true", async () => {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      fs.writeFileSync(path.join(dir, ".gitignore"), "logs/\ndocs/*/logs/\n");
      execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
      fs.writeFileSync(path.join(dir, "a.txt"), "1");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });

      const workflowDir = path.join(dir, "docs", "한글피처");
      fs.mkdirSync(workflowDir, { recursive: true });
      fs.writeFileSync(path.join(workflowDir, "STATE.json"), "{}\n");

      // v1(-z 없음) 텍스트에서는 quotePath 가 실제로 이스케이프를 발동한다는 전제를 먼저 확인해둔다
      // (§z-parse 이전 결함의 원인).
      const rawStatus = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: dir,
      }).toString();
      expect(rawStatus).toContain("\\");
      expect(rawStatus).not.toContain("한글피처");

      // §z-parse Phase 3: preflight.ts 가 실제로 호출하는 -z 형태는 quotePath 이스케이프가 없어
      // 원문 그대로 나온다는 것도 함께 확인해둔다(Phase 0 실측, 이 테스트가 통과하는 실제 근거).
      const rawStatusZ = execFileSync("git", ["status", "--porcelain", "--untracked-files=all", "-z"], {
        cwd: dir,
      }).toString();
      expect(rawStatusZ).not.toContain("\\");
      expect(rawStatusZ).toContain("한글피처");

      const state = makeState({ repo_root: dir });
      const result = await preflight(state, { git: defaultGitExec }, workflowDir);
      expect(result.ok).toBe(true);
    });

    it("F: workflowDir 자체가 symlink 여도(심볼릭 링크 노드 자신 + 실제 대상 디렉토리 양쪽을 후보로) ok:true", async () => {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      fs.writeFileSync(path.join(dir, ".gitignore"), "logs/\ndocs/*/logs/\n");
      execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
      fs.writeFileSync(path.join(dir, "a.txt"), "1");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });

      const realWfDir = path.join(dir, "real", "wf1");
      fs.mkdirSync(realWfDir, { recursive: true });
      fs.writeFileSync(path.join(realWfDir, "STATE.json"), "{}\n");
      const linkWfDir = path.join(dir, "link-wf1");
      fs.symlinkSync(realWfDir, linkWfDir);

      // symlink 노드 자신과 실제 대상 디렉토리 양쪽이 별도의 untracked 엔트리로 보인다는 전제를
      // 먼저 확인해둔다(git 이 symlink 를 디렉토리처럼 "따라 들어가" 하나로 합치지 않는다는 것).
      const rawStatus = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: dir,
      }).toString();
      expect(rawStatus).toContain("link-wf1");
      expect(rawStatus).toContain("real/wf1/STATE.json");

      const state = makeState({ repo_root: dir });
      const result = await preflight(state, { git: defaultGitExec }, linkWfDir);
      expect(result.ok).toBe(true);
    });

    it("G: workflowDir 밖 변경(README.md)은 여전히 ok:false — 방어 유지", async () => {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      fs.writeFileSync(path.join(dir, ".gitignore"), "logs/\ndocs/*/logs/\n");
      execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
      fs.writeFileSync(path.join(dir, "README.md"), "1");
      const workflowDir = path.join(dir, "docs", "wf1");
      fs.mkdirSync(workflowDir, { recursive: true });
      fs.writeFileSync(path.join(workflowDir, "STATE.json"), "{}\n");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });

      fs.writeFileSync(path.join(dir, "README.md"), "2 (uncommitted, unrelated)");

      const state = makeState({ repo_root: dir });
      const result = await preflight(state, { git: defaultGitExec }, workflowDir);
      expect(result.ok).toBe(false);
    });

    it("H: workflowDir 이름의 접두 형제 디렉토리(docs/wf1-notes) 변경은 오탐 없이 여전히 ok:false", async () => {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      fs.writeFileSync(path.join(dir, ".gitignore"), "logs/\ndocs/*/logs/\n");
      execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
      const workflowDir = path.join(dir, "docs", "wf1");
      fs.mkdirSync(workflowDir, { recursive: true });
      fs.writeFileSync(path.join(workflowDir, "STATE.json"), "{}\n");
      const siblingDir = path.join(dir, "docs", "wf1-notes");
      fs.mkdirSync(siblingDir, { recursive: true });
      fs.writeFileSync(path.join(siblingDir, "x.md"), "1");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });

      fs.writeFileSync(path.join(siblingDir, "x.md"), "2 (uncommitted, sibling prefix collision)");
      // workflowDir 안도 함께 dirty — 이것만으로는 막히지 않아야 하지만 형제 변경 때문에 결국 ok:false
      fs.writeFileSync(path.join(workflowDir, "STATE.json"), '{"changed":true}\n');

      const state = makeState({ repo_root: dir });
      const result = await preflight(state, { git: defaultGitExec }, workflowDir);
      expect(result.ok).toBe(false);
      expect(result.problems.some(p => p.includes("커밋되지 않은 변경"))).toBe(true);
    });
  });

  describe("§29 MI-5: git mv 로 workflowDir 안으로 옮긴 rename 은 OLD 가 밖이면 여전히 dirty", () => {
    it("실제 git 리포: production 파일을 git mv 로 workflowDir 안으로 옮기면 ok:false (mutation 재현 방지)", async () => {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      fs.writeFileSync(path.join(dir, ".gitignore"), "logs/\ndocs/*/logs/\n");
      execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
      const workflowDir = path.join(dir, "docs", "wf1");
      fs.mkdirSync(workflowDir, { recursive: true });
      fs.writeFileSync(path.join(workflowDir, "STATE.json"), "{}\n");
      fs.writeFileSync(path.join(dir, "src.ts"), "export const x = 1;\n");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });

      // 세션이 production 파일을 워크플로우 산출물 디렉토리 안으로 git mv — rename 의 NEW 쪽만
      // 보면 "워크플로우 산출물뿐" 으로 오판해 원본 파일 실종이 청결 검사를 통과해버렸다(실측).
      execFileSync("git", ["mv", "src.ts", path.join("docs", "wf1", "src.ts")], { cwd: dir });

      const state = makeState({ repo_root: dir });
      const result = await preflight(state, { git: defaultGitExec }, workflowDir);
      expect(result.ok).toBe(false);
      expect(result.problems.some(p => p.includes("커밋되지 않은 변경"))).toBe(true);
    });

    it("스텁: rename OLD 가 workflowDir 밖이면 NEW 가 안이어도 ok:false", async () => {
      const workflowDir = path.join(dir, "docs", "wf1");
      const deps: PreflightDeps = {
        git: async args => {
          if (args[0] === "rev-parse" && args[1] === "--git-dir") return ok(".git");
          // porcelain v2: 2 레코드는 [헤더+NEW경로, OLD경로] 순서로 두 NUL 필드를 낸다(record2).
          if (args[0] === "status") return ok(toZStdout([record2("docs/wf1/src.ts", "src.ts")]));
          if (args[0] === "rev-parse" && args.includes("HEAD")) return ok("main");
          return ok();
        },
      };
      const state = makeState({ repo_root: dir });
      const result = await preflight(state, deps, workflowDir);
      expect(result.ok).toBe(false);
    });

    it("스텁: rename OLD·NEW 둘 다 workflowDir 안이면 ok:true (오탐 방지 — 워크플로우 산출물끼리의 rename)", async () => {
      const workflowDir = path.join(dir, "docs", "wf1");
      const deps: PreflightDeps = {
        git: async args => {
          if (args[0] === "rev-parse" && args[1] === "--git-dir") return ok(".git");
          if (args[0] === "status") return ok(toZStdout([record2("docs/wf1/STATE.json", "docs/wf1/old.json")]));
          if (args[0] === "rev-parse" && args.includes("HEAD")) return ok("main");
          return ok();
        },
      };
      const state = makeState({ repo_root: dir });
      const result = await preflight(state, deps, workflowDir);
      expect(result.ok).toBe(true);
    });
  });

  describe("§26 M4: parseRemoteHost — origin URL 에서 호스트 추출", () => {
    it("SSH scp-like 형태를 파싱한다 (git@host:owner/repo.git)", () => {
      expect(parseRemoteHost("git@ghe.example.com:example/AI-Assistant.git")).toBe("ghe.example.com");
    });

    it("SSH scp-like 형태 — github.com", () => {
      expect(parseRemoteHost("git@github.com:foo/bar.git")).toBe("github.com");
    });

    it("ssh:// 형태 + 포트를 파싱한다", () => {
      expect(parseRemoteHost("ssh://git@ghe.example.com:22/example/AI-Assistant.git")).toBe("ghe.example.com");
    });

    it("https:// 형태를 파싱한다", () => {
      expect(parseRemoteHost("https://ghe.example.com/example/AI-Assistant.git")).toBe("ghe.example.com");
    });

    it("https:// + 포트를 파싱한다", () => {
      expect(parseRemoteHost("https://ghe.example.com:8443/example/AI-Assistant.git")).toBe("ghe.example.com");
    });

    it("https:// + 사용자정보(userinfo)를 파싱한다", () => {
      expect(parseRemoteHost("https://user:pass@ghe.example.com/example/AI-Assistant.git")).toBe(
        "ghe.example.com",
      );
    });

    it("대문자 호스트는 소문자로 정규화한다", () => {
      expect(parseRemoteHost("https://GHE.EXAMPLE.COM/example/repo.git")).toBe("ghe.example.com");
    });

    it("빈 문자열/알 수 없는 형태는 null 을 반환한다", () => {
      expect(parseRemoteHost("")).toBeNull();
      expect(parseRemoteHost("   ")).toBeNull();
      expect(parseRemoteHost("not a url at all")).toBeNull();
    });

    // §41 m-1: scp-like 분기의 `.toLowerCase()` 가 mutation SURVIVED — URL 분기(위 "대문자 호스트는
    // 소문자로 정규화한다")만 있으면 scp-like 분기의 소문자화가 지워져도 테스트가 안 걸린다. 두
    // 분기를 독립적으로 못박는다.
    it("scp-like 형태의 대문자 호스트도 소문자로 정규화한다 (§41 m-1, URL 분기와 별도 회귀)", () => {
      expect(parseRemoteHost("git@GHE.EXAMPLE.COM:example/AI-Assistant.git")).toBe("ghe.example.com");
    });

    describe("§41 m-2: 호스트 형태 검증 — 판정 불가면 거부(§30 P3), 정당한 호스트는 통과(§30 P2)", () => {
      it.each([
        ["javascript:alert(1)", "스킴 오인 — opaque URI(호스트 없음)를 scp-like 로 재해석하지 않는다"],
        ["data:text/html,x", "스킴 오인 — data URI"],
        ["git@:noowner/r", "host 없이 user@ 만 남은 잔재('git@')"],
        ["git@ho st:o/r", "호스트에 공백 포함"],
        ["https://*/x", "와일드카드 단독"],
        ["https://*.evil.com/x", "와일드카드 서브도메인"],
      ])("거부: %s (%s)", (input) => {
        expect(parseRemoteHost(input)).toBeNull();
      });

      it.each([
        ["https://2130706433/x", "127.0.0.1", "IPv4 정수 표기 — WHATWG 파서가 정규화한 dotted-decimal 은 유효한 호스트다(쓰레기 아님)"],
        ["https://192.168.1.1/o/r", "192.168.1.1", "IPv4 dotted-decimal"],
        ["https://[::1]:8443/o/r.git", "[::1]", "IPv6 리터럴 + 포트"],
        ["ssh://git@[::1]:22/o/r.git", "[::1]", "IPv6 리터럴 — ssh:// + userinfo + 포트"],
        ["https://xn--fsq.example/o/r", "xn--fsq.example", "IDN/punycode 라벨"],
        ["git@gitlab:owner/repo.git", "gitlab", "사내 단일 라벨 호스트(도메인 없음)"],
        ["git@git-server.corp:o/r.git", "git-server.corp", "하이픈 포함 호스트"],
      ])("통과: %s → %s (%s)", (input, expected) => {
        expect(parseRemoteHost(input)).toBe(expected);
      });
    });
  });

  describe("§26 M4: pr_mode gh auth 검사가 origin 호스트를 지정한다", () => {
    it("origin 이 GHE 를 가리키면 gh auth status 에 --hostname 을 붙인다", async () => {
      const state = makeState({ repo_root: dir, pr_mode: true, allow_push: true });
      let ghArgs: string[] | null = null;
      const deps: PreflightDeps = {
        git: async (args) => {
          if (args[0] === "rev-parse" && args[1] === "--git-dir") return ok(".git");
          if (args[0] === "status") return ok("");
          if (args[0] === "rev-parse" && args.includes("HEAD")) return ok("main");
          if (args[0] === "remote" && args[1] === "get-url" && args[2] === "origin") {
            return ok("git@ghe.example.com:example/AI-Assistant.git\n");
          }
          return ok();
        },
        gh: async (args) => {
          ghArgs = args;
          return ok("logged in");
        },
      };
      const result = await preflight(state, deps);
      expect(result.ok).toBe(true);
      expect(ghArgs).toEqual(["auth", "status", "--hostname", "ghe.example.com"]);
    });

    it("GHE 호스트에 인증이 없으면 어느 호스트인지 명시한 문제 메시지를 보고한다", async () => {
      const state = makeState({ repo_root: dir, pr_mode: true, allow_push: true });
      const deps: PreflightDeps = {
        git: async (args) => {
          if (args[0] === "rev-parse" && args[1] === "--git-dir") return ok(".git");
          if (args[0] === "status") return ok("");
          if (args[0] === "rev-parse" && args.includes("HEAD")) return ok("main");
          if (args[0] === "remote" && args[1] === "get-url" && args[2] === "origin") {
            return ok("https://ghe.example.com/example/AI-Assistant.git\n");
          }
          return ok();
        },
        // github.com 에는 로그인돼 있어도(호스트 미지정 호출이면 통과해버리는 게 버그였다)
        // ghe.example.com 에는 인증이 없는 상황을 흉내낸다 — --hostname 이 실제로 전달되는지도
        // 이 스텁이 검증한다(호스트 없이 불렀다면 ok() 를 반환해 이 테스트가 실패한다).
        gh: async (args) => {
          if (args.includes("--hostname") && args[args.indexOf("--hostname") + 1] === "ghe.example.com") {
            return fail("not logged into ghe.example.com");
          }
          return ok("logged in to github.com");
        },
      };
      const result = await preflight(state, deps);
      expect(result.ok).toBe(false);
      expect(result.problems.some(p => p.includes("ghe.example.com"))).toBe(true);
      expect(result.problems.some(p => p.includes("gh auth login --hostname ghe.example.com"))).toBe(true);
    });

    it("origin 리모트가 없거나 호스트를 못 뽑으면 호스트 없이 호출하는 기존 동작으로 퇴화한다", async () => {
      const state = makeState({ repo_root: dir, pr_mode: true, allow_push: true });
      let ghArgs: string[] | null = null;
      const deps: PreflightDeps = {
        git: async (args) => {
          if (args[0] === "rev-parse" && args[1] === "--git-dir") return ok(".git");
          if (args[0] === "status") return ok("");
          if (args[0] === "rev-parse" && args.includes("HEAD")) return ok("main");
          if (args[0] === "remote" && args[1] === "get-url" && args[2] === "origin") {
            return fail("fatal: No such remote 'origin'");
          }
          return ok();
        },
        gh: async (args) => {
          ghArgs = args;
          return ok("logged in");
        },
      };
      const result = await preflight(state, deps);
      expect(result.ok).toBe(true);
      expect(ghArgs).toEqual(["auth", "status"]);
      expect(result.originHost).toBeNull();
    });
  });

  // §37 sandbox-trial 막힘 1 후속 — 3차 무인 주행이 `sandbox.enabled:true` 만 켠 채(network 설정
  // 없이) origin 으로 나가는 아웃바운드 연결이 조용히 거부되는 것을 재현 가능하게 관측했다
  // (docs/sandbox-trial/NOTES.md "막힘 1"). preflight() 가 origin 호스트를 pr_mode 와 무관하게
  // (샌드박스가 켜져 있으면) 구해 반환하는지, 그리고 필요 없을 때는 git 을 아예 호출하지
  // 않는지(§30 P2 회귀 — "sandbox 미설정 → 기존 동작 그대로")를 검증한다.
  describe("§37 sandbox-trial 막힘 1 후속: originHost — sandbox 활성 시에도 pr_mode 와 무관하게 구한다", () => {
    it("pr_mode:false 라도 sandbox.enabled:true 면 origin 호스트를 구해 반환한다", async () => {
      const state = makeState({ repo_root: dir, pr_mode: false, sandbox: { enabled: true } });
      const deps: PreflightDeps = {
        git: async (args) => {
          if (args[0] === "rev-parse" && args[1] === "--git-dir") return ok(".git");
          if (args[0] === "status") return ok("");
          if (args[0] === "rev-parse" && args.includes("HEAD")) return ok("main");
          if (args[0] === "remote" && args[1] === "get-url" && args[2] === "origin") {
            return ok("https://ghe.example.com/DolphaGo/AI-Assistant.git\n");
          }
          return ok();
        },
      };
      const result = await preflight(state, deps);
      expect(result.ok).toBe(true);
      expect(result.originHost).toBe("ghe.example.com");
    });

    it("pr_mode:false 이고 sandbox 도 미설정이면 git remote get-url 자체를 호출하지 않는다 (§30 P2 회귀)", async () => {
      const state = makeState({ repo_root: dir, pr_mode: false });
      let remoteCalled = false;
      const deps: PreflightDeps = {
        git: async (args) => {
          if (args[0] === "rev-parse" && args[1] === "--git-dir") return ok(".git");
          if (args[0] === "status") return ok("");
          if (args[0] === "rev-parse" && args.includes("HEAD")) return ok("main");
          if (args[0] === "remote") { remoteCalled = true; return ok("https://example.com/x.git"); }
          return ok();
        },
      };
      const result = await preflight(state, deps);
      expect(result.ok).toBe(true);
      expect(remoteCalled).toBe(false);
      expect(result.originHost).toBeNull();
    });

    it("pr_mode:false 이고 sandbox.enabled:false 를 명시해도 git remote get-url 을 호출하지 않는다", async () => {
      const state = makeState({ repo_root: dir, pr_mode: false, sandbox: { enabled: false } });
      let remoteCalled = false;
      const deps: PreflightDeps = {
        git: async (args) => {
          if (args[0] === "rev-parse" && args[1] === "--git-dir") return ok(".git");
          if (args[0] === "status") return ok("");
          if (args[0] === "rev-parse" && args.includes("HEAD")) return ok("main");
          if (args[0] === "remote") { remoteCalled = true; return ok("https://example.com/x.git"); }
          return ok();
        },
      };
      const result = await preflight(state, deps);
      expect(remoteCalled).toBe(false);
      expect(result.originHost).toBeNull();
    });

    it("sandbox 활성 상태에서 origin 이 없거나 파싱 불가하면 예외 없이 originHost:null 로 degrade 한다", async () => {
      const state = makeState({ repo_root: dir, pr_mode: false, sandbox: { enabled: true } });
      const deps: PreflightDeps = {
        git: async (args) => {
          if (args[0] === "rev-parse" && args[1] === "--git-dir") return ok(".git");
          if (args[0] === "status") return ok("");
          if (args[0] === "rev-parse" && args.includes("HEAD")) return ok("main");
          if (args[0] === "remote" && args[1] === "get-url" && args[2] === "origin") {
            return fail("fatal: No such remote 'origin'");
          }
          return ok();
        },
      };
      const result = await preflight(state, deps);
      expect(result.ok).toBe(true);
      expect(result.originHost).toBeNull();
    });

    it("pr_mode:true 와 sandbox.enabled:true 가 동시에 있어도 git remote get-url 은 한 번만 호출한다 (공유)", async () => {
      const state = makeState({
        repo_root: dir, pr_mode: true, allow_push: true, sandbox: { enabled: true },
      });
      let remoteCallCount = 0;
      const deps: PreflightDeps = {
        git: async (args) => {
          if (args[0] === "rev-parse" && args[1] === "--git-dir") return ok(".git");
          if (args[0] === "status") return ok("");
          if (args[0] === "rev-parse" && args.includes("HEAD")) return ok("main");
          if (args[0] === "remote" && args[1] === "get-url" && args[2] === "origin") {
            remoteCallCount++;
            return ok("git@ghe.example.com:example/AI-Assistant.git\n");
          }
          return ok();
        },
        gh: async () => ok("logged in"),
      };
      const result = await preflight(state, deps);
      expect(result.ok).toBe(true);
      expect(remoteCallCount).toBe(1);
      expect(result.originHost).toBe("ghe.example.com");
    });
  });

  describe("§26 C2/I4: detached HEAD 를 명시적으로 감지한다", () => {
    it("rev-parse --abbrev-ref HEAD 가 'HEAD' 를 반환하면 detached:true, currentBranch:null 로 보고한다", async () => {
      const state = makeState({ repo_root: dir });
      const deps: PreflightDeps = {
        git: async (args) => {
          if (args[0] === "rev-parse" && args[1] === "--git-dir") return ok(".git");
          if (args[0] === "status") return ok("");
          if (args[0] === "rev-parse" && args.includes("HEAD")) return ok("HEAD\n"); // detached 시 git 의 실제 출력
          return ok();
        },
      };
      const result = await preflight(state, deps);
      expect(result.ok).toBe(true); // detached 자체는 프리플라이트 실패 사유가 아니다(전략별 판단은 orchestrator)
      expect(result.detached).toBe(true);
      expect(result.currentBranch).toBeNull();
    });

    it("일반 브랜치에서는 detached:false", async () => {
      const state = makeState({ repo_root: dir });
      const deps: PreflightDeps = {
        git: async (args) => {
          if (args[0] === "rev-parse" && args[1] === "--git-dir") return ok(".git");
          if (args[0] === "status") return ok("");
          if (args[0] === "rev-parse" && args.includes("HEAD")) return ok("main");
          return ok();
        },
      };
      const result = await preflight(state, deps);
      expect(result.detached).toBe(false);
      expect(result.currentBranch).toBe("main");
    });
  });

  // §36 C-2 — 감사 실측: `preflight.ts:271-281`(로그 보호 게이트) 자체를 통째로 지우거나
  // (L4) `&& !state.allow_untracked_logs` 탈출구를 지워도(L5) 기존 1116개 테스트가 전부
  // 통과했다. 원인은 f054425 가 테스트에 넣은 것이 픽스처 `.gitignore` 25곳뿐이라 정상 트래픽만
  // 지켰고 "방어가 실제로 존재한다"는 단언이 하나도 없었기 때문이다(§30 P2 체크리스트의 반쪽만
  // 이행). 아래는 checkIgnoreGit 스텁의 exitCode(0=ignored/1=not-ignored/128=unknown 판정 불가)
  // × allow_untracked_logs(true/false) 조합을 직접 단언한다. 각 테스트는 L4/L5 mutant 를 실제로
  // 만들어 실패하는지 확인한 뒤 커밋했다(구현 보고서에 mutant diff 와 실행 결과를 남긴다).
  describe("§36 C-2: 로그 보호 게이트 자체에 대한 회귀 테스트 (mutation 방지, checkIgnoreGit × allow_untracked_logs)", () => {
    // rev-parse/status/branch 는 항상 통과시키는 최소 스텁 — 이 describe 의 관심사는 오직
    // 로그 보호 게이트 하나이므로 다른 검사는 항상 ok 로 고정한다.
    function baseGitDeps(): PreflightDeps["git"] {
      return async (args) => {
        if (args[0] === "rev-parse" && args[1] === "--git-dir") return ok(".git");
        if (args[0] === "status") return ok("");
        if (args[0] === "rev-parse" && args.includes("HEAD")) return ok("main");
        return ok();
      };
    }
    function checkIgnoreGitReturning(exitCode: number): PreflightDeps["checkIgnoreGit"] {
      return async () => ({ exitCode, stderr: "" });
    }
    const workflowDirFor = (d: string) => path.join(d, "docs", "wf");

    it("checkIgnoreGit exit 0(ignored) + allow_untracked_logs 미설정 → ok:true, problems 에 로그 관련 항목 없음", async () => {
      const state = makeState({ repo_root: dir });
      const deps: PreflightDeps = { git: baseGitDeps(), checkIgnoreGit: checkIgnoreGitReturning(0) };
      const result = await preflight(state, deps, workflowDirFor(dir));
      expect(result.ok).toBe(true);
      expect(result.problems).toEqual([]);
      expect(result.warnings).toEqual([]);
    });

    it("checkIgnoreGit exit 1(not-ignored) + allow_untracked_logs 미설정 → ok:false, problems 에 무시 안내가 담긴다", async () => {
      const state = makeState({ repo_root: dir });
      const deps: PreflightDeps = { git: baseGitDeps(), checkIgnoreGit: checkIgnoreGitReturning(1) };
      const result = await preflight(state, deps, workflowDirFor(dir));
      expect(result.ok).toBe(false);
      expect(result.problems.some(p => p.includes("git 에 무시되지 않습니다"))).toBe(true);
      expect(result.warnings).toEqual([]);
    });

    it("checkIgnoreGit exit 1(not-ignored) + allow_untracked_logs:false(명시) → ok:false (옵트아웃 값 자체가 아니라 truthy 여부가 기준)", async () => {
      const state = makeState({ repo_root: dir, allow_untracked_logs: false });
      const deps: PreflightDeps = { git: baseGitDeps(), checkIgnoreGit: checkIgnoreGitReturning(1) };
      const result = await preflight(state, deps, workflowDirFor(dir));
      expect(result.ok).toBe(false);
    });

    it("checkIgnoreGit exit 1(not-ignored) + allow_untracked_logs:true → ok:true (탈출구가 실제로 작동), warnings 에 옵트아웃 사실이 남는다 (§36 I-3)", async () => {
      const state = makeState({ repo_root: dir, allow_untracked_logs: true });
      const deps: PreflightDeps = { git: baseGitDeps(), checkIgnoreGit: checkIgnoreGitReturning(1) };
      const result = await preflight(state, deps, workflowDirFor(dir));
      expect(result.ok).toBe(true);
      expect(result.problems).toEqual([]);
      expect(result.warnings.length).toBe(1);
      expect(result.warnings[0]).toContain("allow_untracked_logs: true");
    });

    it("checkIgnoreGit exit 128(저장소 아님 등, 판정 불가) + allow_untracked_logs 미설정 → ok:true (§30 P2: 진단 불가를 차단으로 바꾸지 않는다)", async () => {
      const state = makeState({ repo_root: dir });
      const deps: PreflightDeps = { git: baseGitDeps(), checkIgnoreGit: checkIgnoreGitReturning(128) };
      const result = await preflight(state, deps, workflowDirFor(dir));
      expect(result.ok).toBe(true);
      expect(result.problems).toEqual([]);
    });

    it("workflowDir 을 넘기지 않으면 로그 보호 게이트 자체를 건너뛴다(§26 이전부터의 기존 계약)", async () => {
      const state = makeState({ repo_root: dir });
      let checkIgnoreCalled = false;
      const deps: PreflightDeps = {
        git: baseGitDeps(),
        checkIgnoreGit: async () => {
          checkIgnoreCalled = true;
          return { exitCode: 1, stderr: "" };
        },
      };
      const result = await preflight(state, deps); // workflowDir 없이 호출
      expect(result.ok).toBe(true);
      expect(checkIgnoreCalled).toBe(false);
    });
  });

  // §z-parse Phase 3 — porcelain -z 전환. [NUL-z] 태그는 개행·따옴표·비ASCII 파일명을 실제 임시 git
  // 저장소에 생성해 검증하는 통합 테스트에 붙인다(P3/P9 필수 요건, E8 고정 태그, 게이트
  // `test:nulz` 가 이 태그로 필터링한다).
  describe("§z-parse Phase 3: [NUL-z] 실제 git 리포 통합 테스트 (-z 전환, P3/P9/D6/D9)", () => {
    function initRepo(repoDir: string) {
      execFileSync("git", ["init", "-q"], { cwd: repoDir });
      fs.writeFileSync(path.join(repoDir, ".gitignore"), "logs/\ndocs/*/logs/\n");
      execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: repoDir });
      execFileSync("git", ["config", "user.name", "t"], { cwd: repoDir });
    }

    it("[NUL-z] 개행·따옴표·비ASCII 파일명이 workflowDir 안에 있으면 -z 파싱이 깨지지 않고 ok:true", async () => {
      initRepo(dir);
      fs.writeFileSync(path.join(dir, "a.txt"), "1");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });

      const workflowDir = path.join(dir, "docs", "wf1");
      fs.mkdirSync(workflowDir, { recursive: true });
      fs.writeFileSync(path.join(workflowDir, "STATE.json"), "{}\n");
      fs.writeFileSync(path.join(workflowDir, "weird\nname.txt"), "1");
      fs.writeFileSync(path.join(workflowDir, 'file"with"quote.txt'), "1");
      fs.writeFileSync(path.join(workflowDir, "한글파일.txt"), "1");

      const state = makeState({ repo_root: dir });
      const result = await preflight(state, { git: defaultGitExec }, workflowDir);
      expect(result.ok).toBe(true);
      expect(result.problems).toEqual([]);
    });

    it("[NUL-z] 개행·따옴표·비ASCII 파일명이 workflowDir 밖에 있으면 -z 파싱이 깨지지 않고 ok:false", async () => {
      initRepo(dir);
      fs.writeFileSync(path.join(dir, "a.txt"), "1");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });

      const workflowDir = path.join(dir, "docs", "wf1");
      fs.mkdirSync(workflowDir, { recursive: true });
      fs.writeFileSync(path.join(workflowDir, "STATE.json"), "{}\n");
      fs.writeFileSync(path.join(dir, "weird\nname-outside.txt"), "1");
      fs.writeFileSync(path.join(dir, 'file"with"quote-outside.txt'), "1");
      fs.writeFileSync(path.join(dir, "한글파일-밖.txt"), "1");

      const state = makeState({ repo_root: dir });
      const result = await preflight(state, { git: defaultGitExec }, workflowDir);
      expect(result.ok).toBe(false);
      expect(result.problems.some(p => p.includes("커밋되지 않은 변경"))).toBe(true);
    });

    // D6 회귀 지점 전용: isPathInsideAnyCandidate 가 p 에 trim:false 를 걸지 않으면(=여전히 trim
    // 되면), 후행 개행이 있는 "다른" 파일이 workflowDir 후보 문자열과 trim 후 정확히 같아져
    // (norm === c) "워크플로우 산출물 자기 자신"으로 오인되고 실제 변경이 청결 검사에서 빠진다.
    // isPathInsideAnyCandidate 는 접두사 매칭(startsWith)도 쓰므로 후행 공백만으로는 "안/밖" 판정이
    // 잘 갈리지 않는다 — 정확히 후보 문자열과 "같아지는" 이 시나리오만이 trim 옵션을 판별한다.
    it("[NUL-z] workflowDir 이름 + 후행 개행인 '다른' 파일은 trim 없이 정확히 별개로 판별되어 ok:false (D6 회귀)", async () => {
      initRepo(dir);
      fs.mkdirSync(path.join(dir, "docs", "wf1"), { recursive: true });
      fs.writeFileSync(path.join(dir, "docs", "wf1", "STATE.json"), "{}\n");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });

      // "docs/wf1"(디렉토리, workflowDir)과 이름이 같지만 끝에 개행이 붙은 "docs/wf1\n"(파일) —
      // 서로 다른 파일시스템 엔트리다. trim 이 걸리면 이 파일의 정규화 경로가 후행 개행을 잃고
      // workflowDir 후보 문자열과 정확히 같아진다.
      fs.writeFileSync(path.join(dir, "docs", "wf1\n"), "unrelated file, not the workflowDir itself\n");

      const state = makeState({ repo_root: dir });
      const result = await preflight(state, { git: defaultGitExec }, path.join(dir, "docs", "wf1"));
      expect(result.ok).toBe(false);
      expect(result.problems.some(p => p.includes("커밋되지 않은 변경"))).toBe(true);
    });

    // P7/D9: rename(R)/copy(C) 레코드는 XY 두 글자 중 하나라도 R 또는 C 면 2필드(NEW, OLD 순)로
    // 소비해야 한다. NEW/OLD 를 전부 workflowDir 안에 둬서, R-only 로 후퇴하면(D9 이전 회귀) C
    // 레코드의 OLD 필드가 다음 레코드의 상태줄로 오인되며 필드 정렬이 밀려 엉뚱한 경로가 "밖"으로
    // 튀어나오게 설계했다(정상 구현은 ok:true, R-only 회귀는 필드 밀림으로 ok:false 가 된다).
    it("[NUL-z] rename(R) 레코드가 -z 로 정확히 파싱되어 OLD 가 workflowDir 밖이면 ok:false", async () => {
      initRepo(dir);
      const workflowDir = path.join(dir, "docs", "wf1");
      fs.mkdirSync(workflowDir, { recursive: true });
      fs.writeFileSync(path.join(workflowDir, "STATE.json"), "{}\n");
      fs.writeFileSync(path.join(dir, "개행\n포함.ts"), "export const x = 1;\n");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });

      execFileSync("git", ["mv", "개행\n포함.ts", path.join("docs", "wf1", "개행\n포함.ts")], { cwd: dir });

      const state = makeState({ repo_root: dir });
      const result = await preflight(state, { git: defaultGitExec }, workflowDir);
      expect(result.ok).toBe(false); // OLD(개행\n포함.ts, workflowDir 밖)가 여전히 걸린다(MI-5 유지)
    });

    it("[NUL-z] status.renames=copies 의 C 레코드가 -z 로 2필드(NEW,OLD)로 정확히 파싱된다 (D9, R-only 회귀 방지)", async () => {
      initRepo(dir);
      execFileSync("git", ["config", "status.renames", "copies"], { cwd: dir });
      const workflowDir = path.join(dir, "docs", "wf1");
      fs.mkdirSync(workflowDir, { recursive: true });
      fs.writeFileSync(path.join(workflowDir, "STATE.json"), "{}\n");
      fs.writeFileSync(path.join(workflowDir, "keep-original.txt"), "hello world\n");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });

      // NOTES.md Phase 0 실측: 순수 미수정 원본은 복사 소스 후보 풀에 들지 않는다 — rename 으로
      // 원본을 diff 에 등장시켜야 status.renames=copies 가 실제로 C 를 낸다. NEW(copy)·OLD(원본)·
      // rename 의 NEW·OLD 모두 workflowDir 안에 있다.
      execFileSync("git", ["mv", "keep-original.txt", "renamed-original.txt"], { cwd: workflowDir });
      fs.writeFileSync(path.join(workflowDir, "copy-of-original.txt"), "hello world\n");
      execFileSync("git", ["add", "."], { cwd: dir });

      // 전제 확인: 이 픽스처가 실제로 C 상태코드를 낸다(반증되면 이 테스트 자체가 무의미해진다).
      const rawZ = execFileSync(
        "git", ["status", "--porcelain", "--untracked-files=all", "-z"], { cwd: dir },
      ).toString();
      expect(rawZ).toContain("C ");

      const state = makeState({ repo_root: dir });
      const result = await preflight(state, { git: defaultGitExec }, workflowDir);
      // 정상 구현: C/R 레코드 전부 NEW·OLD 둘 다 workflowDir 안 → ok:true. R-only 회귀라면 C 의 OLD
      // 필드가 다음 레코드의 상태줄로 오인돼 필드가 밀리고, 그 결과 생기는 조각난 경로가 candidates
      // 밖으로 튀어나와 ok:false 가 된다(§검증기준 회귀 감지 근거).
      expect(result.ok).toBe(true);
      expect(result.problems).toEqual([]);
    });

    // §porcelain-v2 Phase 2(D6/D7) — u(병합충돌) 레코드 정상 경로의 실물 검증. 스텁이 아니라
    // 실제 git 으로 진짜 merge conflict 를 일으켜, 헤더 검증기 가정(mode 8진 6자리, hash 40자,
    // sub N... 폼)이 실물과 맞는지 확인하고, u 레코드가 fail-closed(위조 탐지 신뢰 불가) 로
    // 잘못 잡히지 않고 "정상적으로 dirty" 로만 판정되는지 확인한다.
    it("[NUL-z] 실제 merge conflict(UU·DU 최소 2조합)가 u 레코드로 정상 파싱되어 dirty 로만 판정된다 (D6/D7)", async () => {
      initRepo(dir);
      fs.writeFileSync(path.join(dir, "a.txt"), "base-a\n");
      fs.writeFileSync(path.join(dir, "b.txt"), "base-b\n");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
      const baseBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir })
        .toString()
        .trim();

      execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd: dir });
      fs.writeFileSync(path.join(dir, "a.txt"), "feature-a\n");
      fs.writeFileSync(path.join(dir, "b.txt"), "feature-b\n");
      execFileSync("git", ["commit", "-q", "-am", "feature changes"], { cwd: dir });

      execFileSync("git", ["checkout", "-q", baseBranch], { cwd: dir });
      // a.txt: 양쪽에서 서로 다르게 수정 → 병합 시 UU(양쪽 수정)
      fs.writeFileSync(path.join(dir, "a.txt"), "base-a-changed\n");
      execFileSync("git", ["commit", "-q", "-am", "base changes a"], { cwd: dir });
      // b.txt: 우리(base) 쪽에서 삭제, feature 쪽에서 수정 → 병합 시 DU(우리 쪽이 삭제)
      execFileSync("git", ["rm", "-q", "b.txt"], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "base deletes b"], { cwd: dir });

      try {
        execFileSync("git", ["merge", "--no-ff", "-q", "-m", "merge feature", "feature"], { cwd: dir });
      } catch {
        // 병합 충돌은 git 이 non-zero exit 로 알린다 — 이 테스트가 의도한 상태다.
      }

      // 전제 확인: 이 픽스처가 실제로 u UU/u DU 레코드를 낸다(반증되면 이 테스트 자체가 무의미).
      const rawZ = execFileSync(
        "git", ["status", "--porcelain=v2", "--untracked-files=all", "-z"], { cwd: dir },
      ).toString();
      expect(rawZ).toContain("u UU ");
      expect(rawZ).toContain("u DU ");

      const state = makeState({ repo_root: dir });
      const result = await preflight(state, { git: defaultGitExec });
      // 병합 충돌 상태라 워킹트리는 dirty 다(정상 판정) — 그러나 u 레코드 자체가 구조 이상으로
      // fail-closed 되지는 않아야 한다. 이것이 D6 헤더 검증기 가정의 실물 확정 대상이다.
      expect(result.ok).toBe(false);
      expect(result.problems.some(p => p.includes("커밋되지 않은 변경"))).toBe(true);
      expect(result.problems.some(p => p.includes("위조 탐지"))).toBe(false);
    });
  });

  // §z-parse D3/D7 — 기형 -z 필드 개수(정상 git 은 내지 않는 입력)는 fail-closed 로 정지한다.
  // 정상 git 이 실제로 내는 입력이 아니므로 스텁으로 재현한다(P3 의 "실제 git 저장소" 요건은
  // 정상 출력 파싱에 대한 것이지, git 이 내지 않는 기형 입력 재현까지 요구하지 않는다).
  describe("§porcelain-v2 D3/D8: 기형 -z 레코드는 fail-closed 로 정지한다", () => {
    // 이 describe 블록의 기형 레코드 리터럴은 의도적으로 헬퍼(record1/record2/...)를 쓰지 않고
    // 손으로 이어붙인다(D2 경계② — 기형이 의도임이 리터럴로 보여야 한다). HASH40 은 유효한
    // hash 문자군(16진 40자)을 만족시키는 임의값이다.
    const HASH40 = "a".repeat(40);

    it("rename/copy('2') 헤더 뒤 origPath 필드가 아예 없으면(스트림 끝) stream_ended 로 ok:false", async () => {
      const workflowDir = path.join(dir, "docs", "wf1");
      // 유효한 '2' 헤더(9 고정 토큰 + path) 뒤에 origPath NUL 필드가 없다 — 스트림이 거기서 끝난다.
      const malformed = `2 R. N... 100644 100644 100644 ${HASH40} ${HASH40} R100 docs/wf1/src.ts`;
      const deps: PreflightDeps = {
        git: async args => {
          if (args[0] === "rev-parse" && args[1] === "--git-dir") return ok(".git");
          if (args[0] === "status") return ok(malformed); // NUL 없이 끝 — fields[i+1] === undefined
          if (args[0] === "rev-parse" && args.includes("HEAD")) return ok("main");
          return ok();
        },
      };
      const state = makeState({ repo_root: dir });
      const result = await preflight(state, deps, workflowDir);
      expect(result.ok).toBe(false);
      expect(result.problems.some(p => p.includes("stream_ended"))).toBe(true);
      expect(result.problems.some(p => p.includes("위조 탐지"))).toBe(true);
      expect(result.problems.some(p => p.includes("fw retry"))).toBe(true);
      // D7 — 문제 레코드 원문이 표시용 가역 표기(JSON 리터럴)로 담겨 사람이 원인을 재구성할 수 있다.
      expect(result.problems.some(p => p.includes(displayPath(malformed)))).toBe(true);
    });

    it("200자를 넘는 기형 레코드는 잘리고 잘렸다는 사실이 표기된다 (D7 200자 상한)", async () => {
      const longPath = "x".repeat(250);
      const malformed = `2 R. N... 100644 100644 100644 ${HASH40} ${HASH40} R100 ${longPath}`;
      const workflowDir = path.join(dir, "docs", "wf1");
      const deps: PreflightDeps = {
        git: async args => {
          if (args[0] === "rev-parse" && args[1] === "--git-dir") return ok(".git");
          if (args[0] === "status") return ok(malformed);
          if (args[0] === "rev-parse" && args.includes("HEAD")) return ok("main");
          return ok();
        },
      };
      const state = makeState({ repo_root: dir });
      const result = await preflight(state, deps, workflowDir);
      expect(result.ok).toBe(false);
      expect(result.problems.some(p => p.includes("stream_ended"))).toBe(true);
      expect(result.problems.some(p => p.includes("truncated"))).toBe(true);
      expect(result.problems.some(p => p.includes(truncateForDisplay(displayPath(malformed))))).toBe(true);
    });

    // P1 교체 테스트 — 옛 v1 한계 테스트(구 1121~1136행, "(한계 기록용) 중간 필드 누락은 다음
    // 레코드 상태줄을 OLD 로 오인해 감지되지 않는다 — v1 -z 인코딩의 구조적 한계")를 대체한다.
    // 그 테스트가 실측 문서화했던 결함 클래스(rename 레코드의 OLD 누락 + 다음 레코드 상태줄이
    // 바로 이어짐)를 v2 형식으로 그대로 재현해, 이제는 fail-closed(mid_field_missing) 로 잡힘을
    // 증명한다 — 이것이 이 이행의 존재 이유(v1 D9 P7 유지 결정의 대가가 v2 에서 해소됨)를
    // 실측하는 핵심 수용 기준이다(PLAN.md P1).
    it("mid_field_missing: rename('2') OLD 누락 + 다음 레코드 상태줄이 바로 이어지면 fail-closed 로 잡힌다 (P1)", async () => {
      const workflowDir = path.join(dir, "docs", "wf1");
      // OLD 필드 없이(2 레코드가 origPath 를 소비해야 할 자리에) 다음 레코드의 완전한 유효
      // 헤더('1' 타입, 8 고정 토큰 + path)가 바로 이어진다 — v1 이었다면 이 필드를 OLD 로
      // 오인해 조용히 계속 진행했을 기형이다.
      const renameHeader = `2 R. N... 100644 100644 100644 ${HASH40} ${HASH40} R100 docs/wf1/src.ts`;
      const nextRecord = `1 .M N... 100644 100644 100644 ${HASH40} ${HASH40} docs/wf1/unrelated.ts`;
      const deps: PreflightDeps = {
        git: async args => {
          if (args[0] === "rev-parse" && args[1] === "--git-dir") return ok(".git");
          if (args[0] === "status") return ok([renameHeader, nextRecord, ""].join("\0"));
          if (args[0] === "rev-parse" && args.includes("HEAD")) return ok("main");
          return ok();
        },
      };
      const state = makeState({ repo_root: dir });
      const result = await preflight(state, deps, workflowDir);
      expect(result.ok).toBe(false);
      expect(result.problems.some(p => p.includes("mid_field_missing"))).toBe(true);
      expect(result.problems.some(p => p.includes("위조 탐지"))).toBe(true);
      expect(result.problems.some(p => p.includes("fw retry"))).toBe(true);
      // D9 — 두 증거(원본 rename 레코드 + OLD 로 오인될 뻔한 다음 레코드 원문) 둘 다 D7 형식
      // (displayPath + truncateForDisplay)으로 병렬 보존된다.
      expect(result.problems.some(p => p.includes(displayPath(renameHeader)))).toBe(true);
      expect(result.problems.some(p => p.includes("다음 레코드 원문:"))).toBe(true);
      expect(result.problems.some(p => p.includes(displayPath(nextRecord)))).toBe(true);
    });
  });

  // D1→D10(정정) — 구식 git(2.11 미만)은 `--porcelain=v2` 자체를 인식하지 못해 `!statusCheck.ok`
  // 분기(parsePorcelainZ 도달 이전)로 떨어진다. 버전 프로브는 이 분기 한 곳에만 지연 호출된다
  // (P5 — 전제 진단이지 위조 탐지가 아니므로 fail-open). E5: 세 분기(파싱 불가/2.11 미만/2.11
  // 이상인데 커맨드 실패) + 정상 경로 스폰 0회 회귀, 총 4건을 명시적으로 못박는다 — D1→D10 두 번
  // 정정된 지점이라 회귀 위험이 가장 크다.
  describe("§porcelain-v2 D10/P5/E5: git 버전 가드 — !statusCheck.ok 분기 한정 지연 호출", () => {
    it("버전 문자열을 파싱할 수 없으면 힌트 없이 기존 메시지 그대로 (fail-open)", async () => {
      const deps: PreflightDeps = {
        git: async args => {
          if (args[0] === "rev-parse" && args[1] === "--git-dir") return ok(".git");
          if (args[0] === "status") return fail("fatal: unrecognized option '--porcelain=v2'");
          if (args[0] === "--version") return ok("not a version string at all");
          if (args[0] === "rev-parse" && args.includes("HEAD")) return ok("main");
          return ok();
        },
      };
      const state = makeState({ repo_root: dir });
      const result = await preflight(state, deps);
      expect(result.ok).toBe(false);
      expect(result.problems.some(p => p.includes("워킹트리 상태 확인(git status)에 실패했습니다"))).toBe(true);
      expect(result.problems.some(p => p.includes("감지 — 이 하네스는 2.11+ 필요"))).toBe(false);
    });

    it("버전이 파싱되고 2.11 미만이면 힌트가 덧붙는다", async () => {
      const deps: PreflightDeps = {
        git: async args => {
          if (args[0] === "rev-parse" && args[1] === "--git-dir") return ok(".git");
          if (args[0] === "status") return fail("fatal: unrecognized option '--porcelain=v2'");
          if (args[0] === "--version") return ok("git version 2.10.1\n");
          if (args[0] === "rev-parse" && args.includes("HEAD")) return ok("main");
          return ok();
        },
      };
      const state = makeState({ repo_root: dir });
      const result = await preflight(state, deps);
      expect(result.ok).toBe(false);
      expect(result.problems.some(p => p.includes("git 2.10 감지 — 이 하네스는 2.11+ 필요"))).toBe(true);
    });

    it("버전이 파싱되고 2.11 이상인데 커맨드 자체가 실패하면(버전과 무관) 힌트가 없다", async () => {
      const deps: PreflightDeps = {
        git: async args => {
          if (args[0] === "rev-parse" && args[1] === "--git-dir") return ok(".git");
          if (args[0] === "status") return fail("fatal: some unrelated failure");
          if (args[0] === "--version") return ok("git version 2.40.0\n");
          if (args[0] === "rev-parse" && args.includes("HEAD")) return ok("main");
          return ok();
        },
      };
      const state = makeState({ repo_root: dir });
      const result = await preflight(state, deps);
      expect(result.ok).toBe(false);
      expect(result.problems.some(p => p.includes("감지 — 이 하네스는 2.11+ 필요"))).toBe(false);
    });

    it("정상 경로(파싱 성공)에서는 git --version 을 한 번도 호출하지 않는다 (스폰 0회 회귀)", async () => {
      let versionCalls = 0;
      const deps: PreflightDeps = {
        git: async args => {
          if (args[0] === "rev-parse" && args[1] === "--git-dir") return ok(".git");
          if (args[0] === "status") return ok("");
          if (args[0] === "--version") {
            versionCalls++;
            return ok("git version 2.40.0\n");
          }
          if (args[0] === "rev-parse" && args.includes("HEAD")) return ok("main");
          return ok();
        },
      };
      const state = makeState({ repo_root: dir });
      const result = await preflight(state, deps);
      expect(result.ok).toBe(true);
      expect(versionCalls).toBe(0);
    });
  });

  // E3/E6/E14 — 하나의 픽스처 테이블(카테고리 → 최소 기형 입력)을 파서 단위 직접 테스트(9건,
  // E3)와 exhaustiveness 메타 테스트(E6, 동적 검사)가 공유한다. 새 카테고리가 REASONS 에 추가되고
  // 이 표에 반영되지 않으면 메타 테스트가 실패한다.
  describe("§porcelain-v2 E3/E6/E14: reason 카테고리 9종 — 픽스처 테이블 기반 단위+exhaustiveness 테스트", () => {
    const HASH40 = "a".repeat(40);
    const VALID_1_HEADER = `1 .M N... 100644 100644 100644 ${HASH40} ${HASH40} valid-next-record.txt`;

    const FIXTURES: { reason: PorcelainReason; fields: string[] }[] = [
      { reason: "unknown_type", fields: ["X unknown-type-record.txt"] },
      { reason: "xy_invalid", fields: [`1 Z. N... 100644 100644 100644 ${HASH40} ${HASH40} bad-xy.txt`] },
      { reason: "mode_invalid", fields: [`1 .M N... 999999 100644 100644 ${HASH40} ${HASH40} bad-mode.txt`] },
      { reason: "hash_invalid", fields: [`1 .M N... 100644 100644 100644 abcdef0123 ${HASH40} bad-hash.txt`] },
      { reason: "sub_invalid", fields: [`1 .M X... 100644 100644 100644 ${HASH40} ${HASH40} bad-sub.txt`] },
      { reason: "score_invalid", fields: [`2 R. N... 100644 100644 100644 ${HASH40} ${HASH40} 100 bad-score.txt`] },
      { reason: "token_shortage", fields: ["1 .M N... 100644 100644 100644"] },
      {
        reason: "stream_ended",
        fields: [`2 R. N... 100644 100644 100644 ${HASH40} ${HASH40} R100 no-origpath.txt`],
      },
      {
        reason: "mid_field_missing",
        fields: [
          `2 R. N... 100644 100644 100644 ${HASH40} ${HASH40} R100 mid-field-missing.txt`,
          VALID_1_HEADER,
        ],
      },
    ];

    it("테스트 A: 픽스처 테이블의 9개 입력 각각이 parsePorcelainZ 에서 정확히 그 reason 을 반환한다 (E3)", () => {
      for (const { reason, fields } of FIXTURES) {
        const result = parsePorcelainZ(fields.join("\0"));
        expect(result.ok, `reason=${reason} 입력이 ok:true 를 반환함(기대: false)`).toBe(false);
        if (!result.ok) {
          expect(result.reason, `입력 ${JSON.stringify(fields)}`).toBe(reason);
        }
      }
    });

    it("테스트 B(exhaustiveness 메타테스트): 픽스처 테이블의 키 집합이 REASONS 전체와 정확히 일치한다 (E6/E14)", () => {
      const tableReasons = new Set(FIXTURES.map(f => f.reason));
      expect(tableReasons.size).toBe(FIXTURES.length); // 테이블 안에 중복 키 없음
      expect([...tableReasons].sort()).toEqual([...REASONS].sort());
    });

    it("preflight() 경유 시 카테고리는 snake_case 토큰 그대로 노출되고, 카테고리별 한국어 설명구 사전은 없다 (D8/D11)", async () => {
      for (const { reason, fields } of FIXTURES) {
        const deps: PreflightDeps = {
          git: async args => {
            if (args[0] === "rev-parse" && args[1] === "--git-dir") return ok(".git");
            if (args[0] === "status") return ok(fields.join("\0"));
            if (args[0] === "rev-parse" && args.includes("HEAD")) return ok("main");
            return ok();
          },
        };
        const state = makeState({ repo_root: dir });
        const result = await preflight(state, deps);
        expect(result.ok).toBe(false);
        // 공용 템플릿 하나 — "예상과 다른 필드 구조(<카테고리>)" 형태로만 카테고리가 등장한다.
        // 카테고리별 한국어 설명구가 따로 있다면 이 정형 패턴 검사가 실패한다.
        expect(result.problems.some(p => p.includes(`필드 구조(${reason})`)), `reason=${reason}`).toBe(true);
      }
    });
  });
});

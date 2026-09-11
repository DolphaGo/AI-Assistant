import { describe, it, expect } from "vitest";
import { lintVerifyCommands } from "../src/verifylint.js";

function errorsOf(command: string) {
  return lintVerifyCommands([command]).filter(i => i.severity === "error");
}

function issuesOf(command: string) {
  return lintVerifyCommands([command]);
}

// §31 I1 — 실제 셸에서는 exit code 가 정상 전파되는데(실측: `npm test`→`false` 치환 후 exit 1)
// 린트가 `fw run` 시작 자체를 거부하던 4종. 전부 error 가 없어야 한다(경고는 있어도 무방).
describe("§31 I1: 오탐 해소 — 정당한 pipefail/조건부 verify 는 더 이상 시작을 거부하지 않는다", () => {
  it("`set -eo pipefail && ... | tee ...` (조합형 플래그) 는 error 가 없다", () => {
    expect(errorsOf("set -eo pipefail && npm test | tee out.log")).toEqual([]);
  });

  it("`set -euo pipefail && ... | tee ...` (조합형 플래그, e+u+o) 는 error 가 없다", () => {
    expect(errorsOf("set -euo pipefail && npm test | tee out.log")).toEqual([]);
  });

  it("`bash -o pipefail -c '... | tee ...'` (호출 시점 플래그) 는 error 가 없다", () => {
    expect(errorsOf("bash -o pipefail -c 'npm test | tee out.log'")).toEqual([]);
  });

  it("`bash -eo pipefail -c '... | tee ...'` (호출 시점 조합형 플래그) 는 error 가 없다", () => {
    expect(errorsOf("bash -eo pipefail -c 'npm test | tee out.log'")).toEqual([]);
  });

  it("`if [ -f package.json ]; then npm test; fi` (조건이 아니라 본문에 실제 검증) 는 error 가 없다 (warn 은 가능)", () => {
    expect(errorsOf("if [ -f package.json ]; then npm test; fi")).toEqual([]);
  });

  // 회귀 방지: doctor.test.ts 가 지키는 "본문이 trivial 하면 여전히 error" 계약을 이 파일에서도
  // 명시적으로 재확인한다(다른 에이전트 소유 파일을 건드리지 않고, 동일 계약을 이 파일에서 별도 검증).
  it("회귀: `if npm test; then echo ok; fi` (조건에 실제 검증, 본문은 trivial) 는 여전히 error 다", () => {
    expect(errorsOf("if npm test; then echo ok; fi").length).toBeGreaterThan(0);
  });
});

// §31 I2 — 실제 셸에서 exit 0 으로 끝나는데(실측) 전부 시작을 허용하던 11종. 전부 error 가
// 있어야 한다(=`fw run` 시작을 거부해야 한다).
describe("§31 I2: 미탐 차단 — 완전 우회 패턴은 이제 시작을 거부한다", () => {
  it.each([
    "exit 0",
    "#npm test",
    "bash -c 'exit 0'",
    "bash -c 'echo done'",
    "npm test || /usr/bin/true",
    "npm test || sleep 0",
    "npm test || cd .",
    "npm test || printf ''",
    "npm test | cat",
    "( npm test; exit 0 )",
    "npm test & # bg",
  ])("%s 는 error 다", command => {
    expect(errorsOf(command).length).toBeGreaterThan(0);
  });
});

// §30 P2 정상 경로 회귀 — 실제로 널리 쓰이는 명령은 계속 통과해야 한다(§31 감사가 실측한
// 83종 중 대표 표본). error 가 있으면 안 된다(경고는 허용).
describe("§30 P2: 정상 verify 명령은 계속 허용된다 (error 없음)", () => {
  it.each([
    "./gradlew test",
    "mvn -B test",
    "pytest -x -q",
    "go test ./...",
    "cargo test --all-features",
    "make test",
    "mix test",
    "dotnet test --no-build",
    "bazel test //...",
    "bundle exec rake test",
    "tox -e py312",
    "npm ci && npm test",
    "pnpm -r test",
    "npx vitest run",
    "docker compose run --rm test",
    "cd frontend && npm test",
    "timeout 600 npm test",
    "env CI=true npm test",
    "grep -q '^- 2026' NOTES.md",
    "git --version",
    "npm test",
    "./gradlew build",
    "npm run test --if-present", // 알려진 미탐 — 이번 라운드 범위 밖(문서화된 한계, 회귀 방지)
  ])("%s 는 error 가 없다", command => {
    expect(errorsOf(command)).toEqual([]);
  });

  it("`npx jest --passWithNoTests` 는 warn 만 있고 error 는 없다", () => {
    const issues = issuesOf("npx jest --passWithNoTests");
    expect(issues.some(i => i.severity === "error")).toBe(false);
    expect(issues.some(i => i.severity === "warn")).toBe(true);
  });

  // §31 지시사항의 명시적 경고: 이 항목을 error 로 승격하면 오탐이다 — tail/head 는 CI 로그를
  // 자르는 매우 흔한 관용구라 warn 유지가 맞다(코드 주석 참고: pipe-cat-without-pipefail 은
  // `cat` 에만 한정하고 head/tail 은 일부러 error 로 올리지 않았다).
  it("`pytest -q | tail -20` 은 error 로 승격하지 않는다 (warn 유지 — §31 명시 지침)", () => {
    const issues = issuesOf("pytest -q | tail -20");
    expect(issues.some(i => i.severity === "error")).toBe(false);
    expect(issues.some(i => i.severity === "warn")).toBe(true);
  });
});

// 기존 회귀 계약 재확인 (doctor.test.ts 가 이미 지키는 것과 동일한 계약을 이 파일에서도
// 별도로 검증 — doctor.test.ts 는 다른 에이전트 소유라 건드리지 않는다).
describe("회귀: 기존 계약 유지", () => {
  it("`npm test || exit 1` 은 실패를 올바르게 전파하므로 issue 가 전혀 없다", () => {
    expect(issuesOf("npm test || exit 1")).toEqual([]);
  });

  it("pipefail 이 파이프보다 뒤에 있으면(가드 안 걸림) 여전히 error 다", () => {
    expect(errorsOf("npm test | tee build.log && set -o pipefail").length).toBeGreaterThan(0);
  });

  it("`set -o pipefail && ... | tee ...` (단일 -o, 회귀) 는 여전히 error 가 없다", () => {
    expect(errorsOf("set -o pipefail && npm test | tee build.log")).toEqual([]);
  });

  it("else 가 있는 if/then/fi 는 판단 유보로 error 로 잡지 않는다", () => {
    expect(errorsOf("if npm test; then echo ok; else exit 1; fi")).toEqual([]);
  });
});

// §31 I2 판정 불가 `||` 절 — error 로 단정하지 않고 warn 으로 남긴다(§30 P2).
describe("§31 I2: 판정 불가한 `||` 절은 warn 에 그친다", () => {
  it("`npm test || some-unknown-cleanup.sh` 는 error 없이 warn 만 남는다", () => {
    const issues = issuesOf("npm test || some-unknown-cleanup.sh");
    expect(issues.some(i => i.severity === "error")).toBe(false);
    expect(issues.some(i => i.severity === "warn")).toBe(true);
  });
});

// §32 m-1 — 감사 실측: `PIPEFAIL_SET_RE` 가 `(?:^|&&)` 만 인정해 `set -o pipefail` 앞에 다른
// 문장이 하나라도 있으면 탈출구가 안 먹었다(전부 실제 셸에서 exit 7 정상 전파).
describe("§32 m-1: 린트 오탐 3종 — pipefail 가드가 첫 문장이 아니어도 인식된다", () => {
  it.each([
    "set +e; npm test; rc=$?; docker compose down; exit $rc",
    "export CI=true; set -o pipefail; npm test | tee out.log",
    "cd app; set -o pipefail; npm test | tee out.log",
  ])("%s 는 error 가 없다", command => {
    expect(errorsOf(command)).toEqual([]);
  });

  // 회귀: 기존에 통과하던 "set 이 첫 문장" 형태도 계속 통과해야 한다.
  it("회귀: `set -o pipefail; npm test | tee log` (set 이 첫 문장) 는 여전히 error 가 없다", () => {
    expect(errorsOf("set -o pipefail; npm test | tee log")).toEqual([]);
  });

  it("`set +e; npm test; rc=$?; docker compose down; exit $rc` 는 error 없이 warn(rc 캡처 관용구)만 남는다", () => {
    const issues = issuesOf("set +e; npm test; rc=$?; docker compose down; exit $rc");
    expect(issues.some(i => i.severity === "error")).toBe(false);
    expect(issues.some(i => i.severity === "warn")).toBe(true);
  });

  // 회귀: 종료 코드를 보존하지 않는 `set +e` 는 여전히 error 다.
  it("회귀: 단순 `set +e; npm test` (rc 보존 관용구 없음) 는 여전히 error 다", () => {
    expect(errorsOf("set +e; npm test").length).toBeGreaterThan(0);
  });
});

// §32 m-2 — 실측: dash(`/bin/sh`)에서 `set -o pipefail` 은 `set: Illegal option -o pipefail`로
// 하드 실패(exit 2)한다. 린트가 제시하는 해결책 중 `bash -o pipefail -c '...'` 를 먼저 권해야
// 한다(gate.ts 의 runGate 가 `/bin/sh` 로 spawn 하므로).
describe("§32 m-2: 거부 메시지가 `bash -o pipefail -c` 를 먼저 권한다", () => {
  it("`| tee` 오탐 메시지는 `bash -o pipefail -c` 가 `set -o pipefail` 보다 먼저 나온다", () => {
    const issues = issuesOf("npm test | tee out.log");
    const msg = issues.find(i => i.severity === "error")!.reason;
    expect(msg.indexOf("bash -o pipefail -c")).toBeGreaterThanOrEqual(0);
    expect(msg.indexOf("bash -o pipefail -c")).toBeLessThan(msg.indexOf("set -o pipefail"));
  });

  it("`| cat` 오탐 메시지도 `bash -o pipefail -c` 가 먼저 나온다", () => {
    const issues = issuesOf("npm test | cat");
    const msg = issues.find(i => i.severity === "error")!.reason;
    expect(msg.indexOf("bash -o pipefail -c")).toBeGreaterThanOrEqual(0);
    expect(msg.indexOf("bash -o pipefail -c")).toBeLessThan(msg.indexOf("set -o pipefail"));
  });
});

// §32 m-3 — 린트 미탐 잔여(전부 실제로 항상 exit 0).
describe("§32 m-3: 린트 미탐 잔여가 이제 error 로 잡힌다", () => {
  it.each([
    "{ exit 0; }",
    "{ true; }",
    "npm test || (exit 0)",
    "npm test || command true",
    "bash -lc 'exit 0'",
    "sh -ec 'exit 0'",
    "/bin/bash -c 'exit 0'",
    "true && true",
    "env true",
    "eval 'exit 0'",
  ])("%s 는 error 다", command => {
    expect(errorsOf(command).length).toBeGreaterThan(0);
  });

  // §30 P2 회귀 — 감사자가 명시한 정당한 형태는 계속 통과해야 한다.
  it("회귀: `env CI=true npm test` 는 error 가 없다(env 뒤에 실제 검증 명령이 남는다)", () => {
    expect(errorsOf("env CI=true npm test")).toEqual([]);
  });

  it("회귀: `eval 'npm test'` 처럼 실제 검증 명령을 감싼 eval 은 error 가 없다", () => {
    expect(errorsOf("eval 'npm test'")).toEqual([]);
  });

  it("회귀: `npm test || exit 1` (괄호/command 무관 실패 전파) 는 여전히 이슈가 없다", () => {
    expect(issuesOf("npm test || exit 1")).toEqual([]);
  });

  it("회귀: `npm test || (exit 1)` (괄호로 감싼 실패 전파) 도 이슈가 없다", () => {
    expect(issuesOf("npm test || (exit 1)")).toEqual([]);
  });
});

// SURVIVED M53 — nextDecisionId 는 plan.ts 소관이라 이 파일 범위 밖이다(plan.test.ts 에 있음).

// SURVIVED M41 — stripTrailingComment 의 인용부호 인식. 인용 안의 "#" 을 주석으로 오인하면
// 그 뒤에 이어지는 진짜 명령까지 통째로 잘려나간다. 실측 확인(직접 뮤턴트를 만들어 검증):
// 인용부호 바로 다음 글자인 "#"(예: `--grep '#tag'`)은 "공백 뒤에만 주석으로 본다"는 기존
// 앵커 하나만으로도 이미 보호되어 인용 인식 유무와 무관하게 안전하다 — 이 뮤턴트를 실제로
// 죽이려면 "공백 뒤에 오는 #이 인용 안에 있는" 경우가 필요하다: `echo "TODO: #later" &&
// npm test` — 인용을 무시하면 " #later" 앞의 공백 때문에 거기서 잘려 "&& npm test" 전체가
// 사라지고, 잘린 core("echo \"TODO: ")가 echo-only 로 오인되어 거짓 error 가 뜬다.
describe("SURVIVED M41 — stripTrailingComment 는 인용부호 안의 '#' 을 주석으로 오인하지 않는다", () => {
  it("큰따옴표 안에서 공백 뒤에 오는 '#' 은 주석이 아니다 — 뒤의 실제 검증 명령이 살아남는다", () => {
    // 인용 인식이 없으면(뮤턴트) `"TODO: ` 뒤가 comment 로 잘려 "&& npm test" 가 사라지고
    // 남은 core 가 echo-only 로 오인되어 거짓 error 가 뜬다(직접 뮤턴트를 만들어 확인: echo-only
    // error 발생). 인용을 지키면 전체가 보존되어 echo 뒤에 실제 검증(npm test)이 이어지므로
    // isEchoOnly 가 false 가 되고 이슈가 전혀 없어야 한다.
    expect(issuesOf('echo "TODO: #later" && npm test')).toEqual([]);
  });

  it("작은따옴표 안에서 공백 뒤에 오는 '#' 도 마찬가지로 주석이 아니다", () => {
    expect(issuesOf("echo 'note: #later' && npm test")).toEqual([]);
  });

  it("회귀: 인용 밖의 진짜 주석은 여전히 제거된다(인용 인식이 주석 제거 자체를 막지 않음)", () => {
    expect(errorsOf("npm test # this is a real trailing comment that mentions exit 0")).toEqual([]);
  });

  it("회귀: `npm test -- --grep '#tag'` (인용 바로 뒤 #, 공백 없음) 는 그대로 검증 명령으로 인식된다", () => {
    expect(errorsOf("npm test -- --grep '#tag'")).toEqual([]);
  });
});

// SURVIVED E1 — isBalancedWrapping 이 실제로 depth 를 추적해 "문자열 전체를 감싼 단일 그룹"과
// "우연히 첫/마지막 글자만 괄호인, 실제로는 && 로 이어진 두 그룹"을 구분하는지. 항상 true 를
// 반환하는 뮤턴트로 직접 검증했다: 뮤턴트는 "(true) && exit 0)" 의 바깥 괄호를 무조건 벗겨
// "true) && exit 0" 을 만들고, 이 문자열이 "&& exit 0" 로 끝나 trailing-exit-zero 규칙에
// 걸려 거짓 error 를 낸다. 올바른 구현은 depth 가 "(true)" 에서 이미 0 으로 돌아가(전체를
// 감싼 게 아님을 감지) 벗기지 않으므로 원본이 그대로 남아 이슈가 없다.
describe("SURVIVED E1 — isBalancedWrapping 은 불균형/거짓 감싸기를 실제로 거부한다", () => {
  it("첫/끝 글자만 괄호이고 중간에 독립된 그룹이 이미 닫힌 문자열은 벗겨지지 않는다(거짓 error 방지)", () => {
    // "(true) && exit 0)" — 첫 글자 '(', 마지막 글자 ')' 라 얼핏 "전체가 하나의 그룹"처럼
    // 보이지만 실제로는 "(true)" 에서 이미 depth 가 0 으로 돌아온 뒤 "&& exit 0)" 가 이어진
    // 것이다. 벗기면(뮤턴트) "true) && exit 0" 이 되어 trailing-exit-zero 에 거짓 매치된다.
    expect(errorsOf("(true) && exit 0)")).toEqual([]);
  });

  it("중괄호 버전도 동일하게 거부한다", () => {
    expect(errorsOf("{ true; } && exit 0}")).toEqual([]);
  });

  it("회귀: 진짜로 전체를 감싼 단일 그룹은 여전히 벗겨져 안쪽 규칙이 적용된다", () => {
    // "(exit 0)" 는 진짜로 전체가 하나의 그룹이므로 벗겨져 "exit 0" 이 남아야 하고, 이는
    // standalone-exit-zero 에 걸려야 한다 — isBalancedWrapping 을 과하게 보수적으로 고쳐
    // 정당한 그룹 벗기기까지 막으면 안 된다(§30 P2).
    expect(errorsOf("(exit 0)").length).toBeGreaterThan(0);
  });
});

#!/usr/bin/env node
// [D13/P10 범위 보완] test:nulz(G3) 게이트를 vitest 단독 실행 대신 이 스크립트로 감싼다.
//
// 이유(D13 — 사용자 확정): `vitest run <files...> -t 'NUL-z'`는 대상 5개 파일에서
// `-t` 매칭이 0건이어도(파일은 존재하고 전부 skipped) exit 0을 낸다 — `--passWithNoTests`
// (기본 false)는 "테스트 파일 자체가 없음"(No test files found) 케이스에만 적용되고,
// "파일은 있으나 -t 매칭 0건"인 이번 시나리오(예: [NUL-z] 태그가 전부 삭제/치환된 경우)
// 에는 적용되지 않음을 실측으로 확인했다(docs/z-parse/NOTES.md "게이트 자체 검증(P14)").
// G3의 존재 이유가 삭제·스텁 감지(E7)인데 삭제를 감지 못 하면 완료 기준 자체가 거짓
// 약속이 된다 — 그래서 vitest exit code에 의존하지 않고, `--reporter=json`으로 받은
// 리포트의 실제 매칭·실패 테스트 수를 이 스크립트가 직접 판정한다.
//
// 판정 규칙(D13 확정 문구 그대로):
//   1) 매칭된(스킵되지 않은) 테스트 수가 0이면 비영 종료.
//   2) 매칭된 테스트 중 실패가 있으면 비영 종료.
//   그 외에는 exit 0.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HARNESS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

const FILES = [
  "test/preflight.test.ts",
  "test/branch.test.ts",
  "test/gate.test.ts",
  "test/orchestrator.test.ts",
  "test/prloop.test.ts",
];
const PATTERN = "NUL-z";

const vitestBin = join(HARNESS_DIR, "node_modules", ".bin", "vitest");
const tmpDir = mkdtempSync(join(tmpdir(), "check-nulz-"));
const outputFile = join(tmpDir, "report.json");

function fail(message, exitCode = 1) {
  console.error(`[check-nulz] ${message}`);
  rmSync(tmpDir, { recursive: true, force: true });
  process.exit(exitCode);
}

const result = spawnSync(
  vitestBin,
  ["run", ...FILES, "-t", PATTERN, "--reporter=json", `--outputFile=${outputFile}`],
  { cwd: HARNESS_DIR, stdio: ["ignore", "inherit", "inherit"] },
);

if (result.error) {
  fail(`vitest 프로세스를 실행할 수 없습니다: ${result.error.message}`);
}
if (typeof result.status === "number" && result.status !== 0) {
  // vitest 자신이 이미 비영으로 종료했다(예: 파싱 에러, "No test files found").
  // 이 경우는 vitest 의 판정을 그대로 존중해 통과시킨다(§검증 기준 §1 G3 — 이 스크립트는
  // vitest 의 exit code 를 대체하는 것이 아니라 "exit 0인데 실은 매칭 0건" 인 맹점만 보강한다).
  fail(`vitest 프로세스가 비영 종료(exit ${result.status})했습니다 — 원본 실패를 그대로 반영합니다.`, result.status);
}

let report;
try {
  report = JSON.parse(readFileSync(outputFile, "utf8"));
} catch (err) {
  fail(`vitest JSON 리포트를 읽거나 파싱할 수 없습니다: ${err instanceof Error ? err.message : String(err)}`);
}
rmSync(tmpDir, { recursive: true, force: true });

const { numPassedTests, numFailedTests, numTotalTests } = report;
const matched = numPassedTests + numFailedTests;

if (matched === 0) {
  console.error(
    `[check-nulz] '-t ${PATTERN}' 매칭 테스트가 0건입니다(전체 ${numTotalTests}건 중 매칭 0건, ` +
      `모두 skip 처리됨) — [NUL-z] 태그가 삭제되었거나 테스트가 스텁화되었을 위험이 있습니다. ` +
      `대상 파일: ${FILES.join(", ")}`,
  );
  process.exit(1);
}
if (numFailedTests > 0) {
  console.error(`[check-nulz] '-t ${PATTERN}' 매칭 테스트 중 ${numFailedTests}건 실패(매칭 ${matched}건 중).`);
  process.exit(1);
}

console.log(
  `[check-nulz] 통과 — 매칭 ${matched}건(전체 ${numTotalTests}건 중), 실패 0건, 대상 ${FILES.length}개 파일.`,
);
process.exit(0);

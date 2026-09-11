import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// package.json 은 컴파일 결과(dist/index.js)와 소스(src/index.ts) 양쪽에서 항상 harness 루트의
// 부모 디렉토리다 (tsconfig.json 의 rootDir:"src"/outDir:"dist" 가 서로 대칭이라 "한 단계 위"라는
// 상대 경로가 두 실행 경로 모두에서 동일하게 유지된다). 버전을 여기 하드코딩하면(예전의
// HARNESS_VERSION 상수) package.json 과 따로 놀아 조용히 stale 해질 수 있어, 매번 읽는다(§21 —
// `fw --version` 은 설치 확인용이라 정확해야 한다).
const packageJsonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");

export function getVersion(): string {
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as { version: string };
  return pkg.version;
}

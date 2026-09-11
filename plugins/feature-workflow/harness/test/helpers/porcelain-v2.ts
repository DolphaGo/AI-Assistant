// 공용 v2 레코드 빌더 헬퍼(PLAN.md D2) — `git status --porcelain=v2 -z` 형식 스텁을 손으로
// 문자열을 이어붙이며 만들 때 생기는 오탈자(=의도치 않은 기형)를 막기 위한 정형 빌더 집합이다.
//
// 이 헬퍼는 test/preflight.test.ts 와 test/orchestrator.test.ts(makeGitStub) 가 공유한다 —
// 파싱과 무관한 테스트(브랜치 판정·gh 인증·workflowDir 멤버십 등)의 git status 스텁 용도다.
//
// **경계(D2) — 이 헬퍼를 쓰지 않는 곳**:
//   ①파서 계약 자체를 검증하는 [NUL-z] 실제 git 통합 테스트는 실제 git 이 낸 원문을 그대로 쓴다.
//   ②P1/D3~D5 의 기형(malformed) 레코드 테스트는 "기형이 의도"임이 리터럴로 보여야 하므로 이
//     헬퍼가 아니라 손 리터럴로 작성한다 — 정형만 만드는 빌더로는애초에 기형을 표현할 수 없다.
//
// 기본값은 preflight.ts 의 헤더 검증기(mode 8진 6자리, hash 16진 40자, sub N... 폼, XY 개별
// 문자집합/u 7조합)를 항상 통과하는 값으로 고정했다 — 필요한 필드만 override 하면 된다.

const DEFAULT_MODE = "100644";
const DEFAULT_HASH = "a".repeat(40);
const DEFAULT_SUB = "N...";

export interface OrdinaryOverrides {
  /** 기본 ".M"(워크트리만 수정, 스테이지 안 됨) — v2 는 '해당 쪽 무변경'을 '.'으로 표기한다. */
  xy?: string;
  sub?: string;
  mode?: string;
  hash?: string;
}

/** 타입 '1'(ordinary changed) 레코드 한 줄. */
export function record1(path: string, overrides: OrdinaryOverrides = {}): string {
  const xy = overrides.xy ?? ".M";
  const sub = overrides.sub ?? DEFAULT_SUB;
  const mode = overrides.mode ?? DEFAULT_MODE;
  const hash = overrides.hash ?? DEFAULT_HASH;
  return `1 ${xy} ${sub} ${mode} ${mode} ${mode} ${hash} ${hash} ${path}`;
}

export interface RenameOverrides extends OrdinaryOverrides {
  /** 기본 "R100"(rename, 유사도 100%). */
  score?: string;
}

/**
 * 타입 '2'(rename/copy) 레코드 — [헤더+NEW경로, OLD경로] 두 NUL 필드를 배열로 반환한다.
 * `toZStdout` 에 그대로 스프레드해서 넣으면(배열 안에 배열) 두 필드로 펼쳐진다.
 */
export function record2(newPath: string, oldPath: string, overrides: RenameOverrides = {}): [string, string] {
  const xy = overrides.xy ?? "R.";
  const sub = overrides.sub ?? DEFAULT_SUB;
  const mode = overrides.mode ?? DEFAULT_MODE;
  const hash = overrides.hash ?? DEFAULT_HASH;
  const score = overrides.score ?? "R100";
  return [`2 ${xy} ${sub} ${mode} ${mode} ${mode} ${hash} ${hash} ${score} ${newPath}`, oldPath];
}

export interface UnmergedOverrides {
  /** 기본 "UU"(양쪽 수정) — 7조합(DD/AU/UD/UA/DU/AA/UU) 중 하나여야 통과한다. */
  xy?: string;
  sub?: string;
  mode?: string;
  hash?: string;
}

/** 타입 'u'(unmerged/병합충돌) 레코드 한 줄. */
export function recordU(path: string, overrides: UnmergedOverrides = {}): string {
  const xy = overrides.xy ?? "UU";
  const sub = overrides.sub ?? DEFAULT_SUB;
  const mode = overrides.mode ?? DEFAULT_MODE;
  const hash = overrides.hash ?? DEFAULT_HASH;
  return `u ${xy} ${sub} ${mode} ${mode} ${mode} ${mode} ${hash} ${hash} ${hash} ${path}`;
}

/** 타입 '?'(untracked) 레코드 한 줄. */
export function recordUntracked(path: string): string {
  return `? ${path}`;
}

/** 타입 '!'(ignored) 레코드 한 줄. */
export function recordIgnored(path: string): string {
  return `! ${path}`;
}

/**
 * 레코드(문자열 또는 record2 가 반환한 2필드 튜플)들을 NUL 로 이어붙여 `git status ... -z` 가
 * 내는 stdout 형태로 만든다(트레일링 NUL 포함 — 실제 git 출력과 동일).
 */
export function toZStdout(records: Array<string | readonly [string, string]>): string {
  const fields: string[] = [];
  for (const r of records) {
    if (typeof r === "string") fields.push(r);
    else fields.push(...r);
  }
  return fields.length > 0 ? `${fields.join("\0")}\0` : "";
}

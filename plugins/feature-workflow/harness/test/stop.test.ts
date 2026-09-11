import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  stopFilePath, isStopRequested, requestStop, consumeStopFile,
  consumeStopFileDetailed, stopFileProblem,
} from "../src/stop.js";

// §27 O3 / §2 D16: 정지 신호는 시그널이 아니라 <workflowDir>/STOP 파일이다. nohup 실행은 PID 를
// 모르니, 여러 워크플로우를 개별 정지할 수 있고 프로세스가 죽어도 남는 파일로 의도를 남긴다.

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-stop-"));
});

describe("stopFilePath", () => {
  it("<workflowDir>/STOP 경로를 반환한다", () => {
    expect(stopFilePath(dir)).toBe(path.join(dir, "STOP"));
  });
});

describe("isStopRequested / requestStop", () => {
  it("STOP 파일이 없으면 false 다 (§30 P2 — 정상 경로에서 오탐 없음)", () => {
    expect(isStopRequested(dir)).toBe(false);
  });
  it("requestStop 이 STOP 파일을 만들면 isStopRequested 가 true 로 바뀐다", () => {
    requestStop(dir, "2026-08-27T00:00:00.000Z");
    expect(isStopRequested(dir)).toBe(true);
  });
  it("STOP 파일 내용에 요청 시각이 남는다 (감사 흔적)", () => {
    requestStop(dir, "2026-08-27T00:00:00.000Z");
    const content = fs.readFileSync(stopFilePath(dir), "utf-8");
    expect(content).toContain("2026-08-27T00:00:00.000Z");
  });
});

describe("consumeStopFile", () => {
  it("STOP 파일이 있으면 지우고 true 를 반환한다", () => {
    requestStop(dir, "t");
    expect(consumeStopFile(dir)).toBe(true);
    expect(fs.existsSync(stopFilePath(dir))).toBe(false);
  });
  it("STOP 파일이 없으면 false 를 반환하고 아무 것도 하지 않는다", () => {
    expect(consumeStopFile(dir)).toBe(false);
  });
  it("소비 후에는 isStopRequested 도 false 로 돌아온다", () => {
    requestStop(dir, "t");
    consumeStopFile(dir);
    expect(isStopRequested(dir)).toBe(false);
  });

  // §31 I7 — unlinkSync 가 던질 수 있는 두 실제 상황(STOP 이 디렉토리, 워크플로우 디렉토리가
  // 읽기 전용)에서 예전엔 EPERM/EACCES 가 그대로 fw run 밖으로 전파돼 STATE 조차 못 남기고
  // 죽었다. 이제는 무보호 unlink 를 try/catch 로 감싸 false 로 흡수한다 — "정지 안 됨"이지
  // "크래시"가 아니다. false 를 반환해도 STOP 이 여전히 존재하므로(isStopRequested 로 확인)
  // 다음 체크포인트에서 halted 로 정지할 기회가 남는다는 게 이 계약의 핵심이다.

  it("STOP 이 파일이 아니라 디렉토리면 unlink 가 실패해도 throw 하지 않고 false 를 반환한다", () => {
    fs.mkdirSync(stopFilePath(dir));
    expect(() => consumeStopFile(dir)).not.toThrow();
    expect(consumeStopFile(dir)).toBe(false);
    // 지우지 못했으므로 STOP(디렉토리)은 여전히 존재 — 정지 의도가 사라지지 않았다.
    expect(fs.existsSync(stopFilePath(dir))).toBe(true);
    expect(isStopRequested(dir)).toBe(true);
    fs.rmdirSync(stopFilePath(dir));
  });

  // root 는 파일 권한 검사를 우회하므로(unlink 가 실제로 성공해버림) 이 테스트는 root 로 도는
  // CI 컨테이너에서는 전제 자체가 성립하지 않는다 — 건너뛴다.
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  it.skipIf(isRoot)("워크플로우 디렉토리가 읽기 전용이면 unlink 가 실패해도 throw 하지 않고 false 를 반환한다", () => {
    requestStop(dir, "t");
    fs.chmodSync(dir, 0o555);
    try {
      expect(() => consumeStopFile(dir)).not.toThrow();
      expect(consumeStopFile(dir)).toBe(false);
      expect(isStopRequested(dir)).toBe(true);
    } finally {
      fs.chmodSync(dir, 0o755); // 정리(rmSync 가 지울 수 있어야 한다)
    }
  });
});

// §32 I-5: §31 I7 이 unlink 실패를 `false` 로만 흡수해 "왜" 실패했는지(errno)가 사라졌다 —
// 감사자 실측(`mkdir STOP`): fw run 을 몇 번을 다시 돌려도 매번 같은 이유로 halted 되는데 그
// 이유가 STATE 어디에도 안 남아 "재실행하세요" 안내가 영원히 풀리지 않는 루프처럼 보였다.
// consumeStopFileDetailed 는 그 사유를 반환한다 — consumeStopFile(boolean) 은 하위호환을 위해
// 그대로 두고 내부에서 이 함수를 호출한다.
describe("consumeStopFileDetailed — §32 I-5: 실패 사유를 반환한다", () => {
  it("STOP 이 없으면 { consumed: false } 다 (failure 없음)", () => {
    expect(consumeStopFileDetailed(dir)).toEqual({ consumed: false });
  });

  it("STOP 이 있으면 지우고 { consumed: true } 를 반환한다", () => {
    requestStop(dir, "t");
    expect(consumeStopFileDetailed(dir)).toEqual({ consumed: true });
    expect(fs.existsSync(stopFilePath(dir))).toBe(false);
  });

  it("STOP 이 디렉토리면 { consumed: false, failure } 를 반환하고 사유가 담긴다 (throw 하지 않음)", () => {
    fs.mkdirSync(stopFilePath(dir));
    const result = consumeStopFileDetailed(dir);
    expect(result.consumed).toBe(false);
    expect(result.failure).toBeDefined();
    expect(result.failure).toMatch(/STOP 파일 삭제 실패/);
    // 지우지 못했으므로 STOP(디렉토리)은 여전히 존재한다 — 정지 의도가 사라지지 않았다.
    expect(fs.existsSync(stopFilePath(dir))).toBe(true);
    fs.rmdirSync(stopFilePath(dir));
  });

  it("consumeStopFile(boolean 하위호환)은 여전히 boolean 만 반환하고 계속 작동한다 (회귀)", () => {
    requestStop(dir, "t");
    expect(consumeStopFile(dir)).toBe(true);
    expect(consumeStopFile(dir)).toBe(false); // 이미 소비됨
  });
});

// §32 I-5: checkHaltpoint(halt.ts)와 `fw doctor`(doctor.ts)가 공유하는 non-destructive 진단 —
// STOP 을 실제로 지워보지 않고 "다음 fw run 이 소비할 수 있는 상태인가"만 확인한다.
describe("stopFileProblem — §32 I-5: STOP 을 건드리지 않는 진단", () => {
  it("STOP 이 없으면 null 이다 (§30 P2 정상 경로)", () => {
    expect(stopFileProblem(dir)).toBeNull();
  });

  it("STOP 이 정상 파일이고 디렉토리가 쓰기 가능하면 null 이다 (§30 P2 정상 경로 — 가장 흔한 fw stop 사용)", () => {
    requestStop(dir, "t");
    expect(stopFileProblem(dir)).toBeNull();
    // 진단만 하고 건드리지 않는다 — STOP 이 여전히 존재해야 한다.
    expect(fs.existsSync(stopFilePath(dir))).toBe(true);
  });

  it("STOP 이 디렉토리면(mkdir STOP) 문제 사유 문자열을 반환한다", () => {
    fs.mkdirSync(stopFilePath(dir));
    const problem = stopFileProblem(dir);
    expect(problem).not.toBeNull();
    expect(problem).toMatch(/STOP 파일 삭제 실패/);
    // 진단만 하고 건드리지 않는다 — 디렉토리가 그대로 남아 있어야 한다(부작용 없음).
    expect(fs.existsSync(stopFilePath(dir))).toBe(true);
    fs.rmdirSync(stopFilePath(dir));
  });

  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  it.skipIf(isRoot)("워크플로우 디렉토리가 읽기 전용이면 문제 사유를 반환한다", () => {
    requestStop(dir, "t");
    fs.chmodSync(dir, 0o555);
    try {
      const problem = stopFileProblem(dir);
      expect(problem).not.toBeNull();
      expect(problem).toMatch(/STOP 파일 삭제 실패/);
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });
});

describe("requestStop — §31 I7: 없는 디렉토리에 조용히 성공한 척하지 않는다", () => {
  it("워크플로우 디렉토리가 없으면 명확한 메시지와 함께 throw 한다 (raw ENOENT 아님)", () => {
    const missing = path.join(dir, "no-such-workflow");
    expect(() => requestStop(missing, "t")).toThrow(/워크플로우 디렉토리가 없습니다/);
    expect(fs.existsSync(missing)).toBe(false); // 대신 디렉토리를 만들어버리지도 않는다
  });

  it("정상 디렉토리에는 예전처럼 STOP 파일을 만든다 (§30 P2 정상 경로 회귀)", () => {
    expect(() => requestStop(dir, "2026-08-27T00:00:00.000Z")).not.toThrow();
    expect(isStopRequested(dir)).toBe(true);
  });
});

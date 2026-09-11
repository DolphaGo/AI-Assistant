import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireLock, lockPath, peekLiveLock } from "../src/lock.js";

const NOW = "2026-08-27T00:00:00.000Z";

describe("acquireLock", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-lock-"));
  });

  it("락 파일을 만들고 pid/startedAt 을 기록한다", () => {
    acquireLock(dir, () => NOW);
    const raw = JSON.parse(fs.readFileSync(lockPath(dir), "utf-8"));
    expect(raw.pid).toBe(process.pid);
    expect(raw.startedAt).toBe(NOW);
  });

  it("해제 함수를 호출하면 락 파일이 삭제된다", () => {
    const release = acquireLock(dir, () => NOW);
    expect(fs.existsSync(lockPath(dir))).toBe(true);
    release();
    expect(fs.existsSync(lockPath(dir))).toBe(false);
  });

  it("살아있는 pid 가 이미 잡고 있으면 두 번째 획득은 throw 한다", () => {
    // 자기 자신의 pid 로 살아있는 프로세스를 시뮬레이션한다
    fs.writeFileSync(
      lockPath(dir),
      JSON.stringify({ pid: process.pid, startedAt: "2026-08-26T12:00:00.000Z" }),
    );
    expect(() => acquireLock(dir, () => NOW)).toThrow();
    try {
      acquireLock(dir, () => NOW);
      expect.unreachable();
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain(String(process.pid));
      expect(message).toContain("2026-08-26T12:00:00.000Z");
      expect(message).toMatch(/이미.*실행 중/);
    }
  });

  it("죽은 pid(존재할 수 없는 큰 수) 면 stale lock 으로 간주하고 인수한다", () => {
    fs.writeFileSync(
      lockPath(dir),
      JSON.stringify({ pid: 999999, startedAt: "2026-08-26T12:00:00.000Z" }),
    );
    expect(() => acquireLock(dir, () => NOW)).not.toThrow();
    const raw = JSON.parse(fs.readFileSync(lockPath(dir), "utf-8"));
    expect(raw.pid).toBe(process.pid);
    expect(raw.startedAt).toBe(NOW);
  });

  it("깨진 JSON 이면 stale 로 간주하고 인수한다", () => {
    fs.writeFileSync(lockPath(dir), "{ not valid json");
    expect(() => acquireLock(dir, () => NOW)).not.toThrow();
    const raw = JSON.parse(fs.readFileSync(lockPath(dir), "utf-8"));
    expect(raw.pid).toBe(process.pid);
  });

  it("락 파일이 아예 없으면 바로 획득한다", () => {
    expect(fs.existsSync(lockPath(dir))).toBe(false);
    expect(() => acquireLock(dir, () => NOW)).not.toThrow();
  });

  it("해제 시 자기 pid 가 아닌 락(다른 프로세스가 이미 인수한 경우)은 지우지 않는다", () => {
    const release = acquireLock(dir, () => NOW);
    // 해제 전에 다른 프로세스가 stale lock 을 인수했다고 가정 (락 파일을 다른 pid 로 덮어씀)
    fs.writeFileSync(
      lockPath(dir),
      JSON.stringify({ pid: 424242, startedAt: "2026-08-27T01:00:00.000Z" }),
    );
    release();
    expect(fs.existsSync(lockPath(dir))).toBe(true);
    const raw = JSON.parse(fs.readFileSync(lockPath(dir), "utf-8"));
    expect(raw.pid).toBe(424242);
  });

  it("lockPath 는 workflowDir/.fw.lock 을 가리킨다", () => {
    expect(lockPath(dir)).toBe(path.join(dir, ".fw.lock"));
  });

  // §25 과제4 (TOCTOU): read → check → write 순서는 진짜 동시 실행을 못 막는다.
  // fs.openSync(file, "wx") 배타 생성으로 바꾼 뒤에도, "파일이 이미 있으면 배타 생성
  // 자체가 OS 수준에서 실패하고, 그 실패를 계기로 liveness 판정 경로를 탄다" 는 것을
  // 직접 확인한다 — 애플리케이션 레벨 read-then-write 체크가 아니라 OS 원자성에
  // 의존해야 진짜 동시 프로세스 경합을 막을 수 있다.
  it("이미 락 파일이 있으면 wx 배타 생성 자체가 EEXIST 로 실패해 liveness 판정으로 넘어간다", () => {
    fs.writeFileSync(
      lockPath(dir),
      JSON.stringify({ pid: process.pid, startedAt: "2026-08-26T12:00:00.000Z" }),
    );
    // wx 배타 생성은 파일이 이미 있으므로 그 자체로 실패한다(원자적 실패 — TOCTOU 창이 없다)
    expect(() => fs.openSync(lockPath(dir), "wx")).toThrow(
      expect.objectContaining({ code: "EEXIST" }),
    );
    // 그 실패 이후 acquireLock 은 liveness 를 판정해, 살아있으면 여전히 명확히 거부한다
    expect(() => acquireLock(dir, () => NOW)).toThrow(/이미.*실행 중/);
  });

  it("연속으로 두 번 획득을 시도하면 두 번째는 (같은 프로세스라도) 살아있는 락으로 인식되어 throw 한다", () => {
    const release = acquireLock(dir, () => NOW);
    expect(() => acquireLock(dir, () => NOW)).toThrow(/이미.*실행 중/);
    release();
    // 해제 후에는 다시 배타 생성으로 정상 획득된다
    expect(() => acquireLock(dir, () => NOW)).not.toThrow();
  });
});

describe("peekLiveLock — answer/retry 의 경고용 조회 (락을 잡지 않고 관측만)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-lock-peek-"));
  });

  it("락 파일이 없으면 null", () => {
    expect(peekLiveLock(dir)).toBeNull();
  });

  it("살아있는 pid 의 락이면 정보를 반환한다", () => {
    fs.writeFileSync(
      lockPath(dir),
      JSON.stringify({ pid: process.pid, startedAt: "2026-08-26T12:00:00.000Z" }),
    );
    expect(peekLiveLock(dir)).toEqual({ pid: process.pid, startedAt: "2026-08-26T12:00:00.000Z" });
  });

  it("죽은 pid 의 락이면 null (stale)", () => {
    fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: 999999, startedAt: "t" }));
    expect(peekLiveLock(dir)).toBeNull();
  });

  it("깨진 JSON 이면 null", () => {
    fs.writeFileSync(lockPath(dir), "{ not valid json");
    expect(peekLiveLock(dir)).toBeNull();
  });

  it("조회만 하고 락을 획득/변형하지 않는다", () => {
    fs.writeFileSync(
      lockPath(dir),
      JSON.stringify({ pid: process.pid, startedAt: "2026-08-26T12:00:00.000Z" }),
    );
    const before = fs.readFileSync(lockPath(dir), "utf-8");
    peekLiveLock(dir);
    const after = fs.readFileSync(lockPath(dir), "utf-8");
    expect(after).toBe(before);
  });
});

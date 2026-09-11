import fs from "node:fs";
import path from "node:path";

export interface LockInfo {
  pid: number;
  startedAt: string;
}

export function lockPath(workflowDir: string): string {
  return path.join(workflowDir, ".fw.lock");
}

// pid 가 살아있는 프로세스를 가리키는지 확인한다. signal 0 은 실제로 신호를 보내지
// 않고 권한/존재 여부만 검사한다 — 표준적인 "살아있나" 체크 관용구.
// ESRCH(없음) 는 죽음, EPERM(권한 없음=다른 사용자 소유지만 살아있음) 은 삶으로 취급한다.
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLock(file: string): LockInfo | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return null; // 파일 없음 — 락 없음
  }
  try {
    const json = JSON.parse(raw);
    if (typeof json?.pid === "number" && typeof json?.startedAt === "string") {
      return { pid: json.pid, startedAt: json.startedAt };
    }
    return null; // 스키마 불일치 — 깨진 락으로 간주(stale 취급)
  } catch {
    return null; // JSON 파싱 실패 — 깨진 락으로 간주(stale 취급)
  }
}

function liveLockError(file: string, existing: LockInfo): Error {
  return new Error(
    `다른 fw run 이 이미 이 워크플로우를 실행 중입니다 ` +
      `(PID ${existing.pid}, 시작 시각 ${existing.startedAt}). ` +
      `해당 프로세스를 종료한 뒤 다시 시도하거나, 프로세스가 실제로 죽었다면 ` +
      `${file} 을 직접 삭제하세요.`,
  );
}

/**
 * <workflowDir>/.fw.lock 을 획득한다.
 * 이미 살아있는 프로세스가 잡고 있으면 throw. 파일이 없거나, 파싱 불가하거나,
 * 기록된 pid 가 죽어있으면 stale lock 으로 간주하고 인수(덮어쓰기)한다.
 *
 * §25 과제4 (TOCTOU): read → check → write 순서로 구현하면, 두 프로세스가 거의 동시에
 * readLock 을 통과한 뒤 둘 다 writeFileSync 로 이기는 경합이 가능하다(진짜 동시 실행을 못 막음).
 * 그 대신 `fs.openSync(file, "wx")`(O_CREAT|O_EXCL, 파일이 이미 있으면 EEXIST 로 실패)로
 * 획득 자체를 원자적으로 시도한다 — 파일 생성 성공이 곧 락 획득이다. 실패(EEXIST)하면 그때
 * 기존 락을 읽어 liveness 를 판정하고, 죽어있으면(stale) 삭제 후 배타 생성을 1회만 재시도한다
 * (재시도까지 실패하면 그 사이 다른 프로세스가 먼저 인수한 것 — 그 락을 존중한다).
 * 반환값은 해제 함수 — 호출하면 락 파일을 삭제한다(자기 pid 일 때만, 남의 락을 지우지 않기 위해).
 */
export function acquireLock(workflowDir: string, now: () => string): () => void {
  const file = lockPath(workflowDir);
  const info: LockInfo = { pid: process.pid, startedAt: now() };
  const payload = JSON.stringify(info, null, 2) + "\n";

  // 배타 생성 시도 — 성공하면 그 자체가 원자적 획득이다(파일 쓰기도 이 안에서 함께 끝내
  // tmp+rename 같은 별도 원자화 단계를 두지 않는다: rename 은 대상이 있으면 조용히 덮어써서
  // 배타성을 깨뜨리므로 여기선 쓸 수 없다).
  const tryCreate = (): boolean => {
    let fd: number;
    try {
      fd = fs.openSync(file, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
    try {
      fs.writeFileSync(fd, payload);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  };

  if (!tryCreate()) {
    const existing = readLock(file);
    if (existing && isProcessAlive(existing.pid)) {
      throw liveLockError(file, existing);
    }
    // stale(죽은 pid) 또는 손상된 락 — 지우고 배타 생성을 1회만 재시도
    try {
      fs.unlinkSync(file);
    } catch {
      // 이미 삭제됐을 수 있음 — 무시하고 재시도
    }
    if (!tryCreate()) {
      // 그 사이 다른 프로세스가 먼저 인수했다 — 그 락을 존중한다
      const raced = readLock(file);
      if (raced && isProcessAlive(raced.pid)) {
        throw liveLockError(file, raced);
      }
      throw new Error(`락 파일(${file}) 을 획득할 수 없습니다 — 다시 시도하세요.`);
    }
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = readLock(file);
    // 자기 pid 일 때만 삭제 — 그 사이 다른 프로세스가 stale lock 을 인수했다면 그 락을 지우지 않는다
    if (current && current.pid === process.pid) {
      try {
        fs.unlinkSync(file);
      } catch {
        // 이미 삭제됐거나 접근 불가 — 무인 주행을 막지 않는다
      }
    }
  };
}

/**
 * 락을 잡지 않고 "현재 살아있는 프로세스가 이 워크플로우를 실행 중인가"만 관측한다.
 * `fw answer`/`fw retry` 가 실행 중인 워크플로우에 개입할 때 경고를 띄우기 위한 용도 —
 * 차단하지는 않는다(사용자가 의도적으로 개입하는 경우가 있다).
 */
export function peekLiveLock(workflowDir: string): LockInfo | null {
  const existing = readLock(lockPath(workflowDir));
  return existing && isProcessAlive(existing.pid) ? existing : null;
}

import fs from "node:fs";
import path from "node:path";

// §27 O3 / §2 D16: 정지 신호를 시그널이 아니라 파일로 둔다. 하네스는 `nohup`/백그라운드로
// 도는 경우가 많아 PID 를 모른다 — 파일은 워크플로우별로 개별 정지할 수 있고, 무엇보다
// **프로세스가 죽어도 의도(정지하라)가 파일시스템에 남는다**. `<workflowDir>/.fw.lock` 이 이미
// 같은 디렉토리에서 같은 방식(파일 존재 = 상태)으로 쓰이고 있어 일관적이다.
//
// 여기 함수들은 순수하게 fs 만 건드리는 형태로 분리한다(orchestrator.ts 의 체크포인트 헬퍼가
// 이 모듈을 가져다 쓰고, cli.ts 의 `fw stop` 커맨드도 그대로 재사용한다) — 테스트 가능성과
// 재사용을 동시에 얻기 위함이다.

export function stopFilePath(workflowDir: string): string {
  return path.join(workflowDir, "STOP");
}

/** STOP 파일이 있는지만 확인한다(부작용 없음) — 체크포인트에서 반복 호출된다. */
export function isStopRequested(workflowDir: string): boolean {
  return fs.existsSync(stopFilePath(workflowDir));
}

/**
 * STOP 파일을 만든다(`fw stop` 커맨드가 호출). 내용은 요청 시각(감사 흔적) — 값 자체를 아무도
 * 파싱하지 않지만, 사람이 파일을 열어봤을 때 "언제 정지를 요청했는지" 알 수 있어야 한다.
 *
 * §31 I7 — workflowDir 이 없으면 `fs.writeFileSync` 가 raw `ENOENT: ... open '.../STOP'` 를
 * 던진다. cli.ts 의 `guard()` 가 이걸 잡아 exit 1 로 바꾸긴 하지만 메시지가 사람에게 무의미
 * 하다("STOP 이 뭔데 왜 못 열어?"). 조용히 성공한 척(예: 디렉토리를 대신 만들어버리는 것)하는
 * 것도 안 된다 — 사용자가 워크플로우 경로를 잘못 입력한 걸 못 알아챈다. 그래서 여기서 먼저
 * 존재 여부를 확인해 **명확한 사유가 담긴 에러**를 던진다 — 여전히 throw 하므로 guard() 의
 * "죽지 않지만 실패를 숨기지 않는다" 계약은 그대로 유지된다.
 */
export function requestStop(workflowDir: string, at: string): void {
  if (!fs.existsSync(workflowDir) || !fs.statSync(workflowDir).isDirectory()) {
    throw new Error(
      `워크플로우 디렉토리가 없습니다: ${workflowDir} — fw stop 은 이미 init 된 워크플로우 디렉토리에만 쓸 수 있습니다.`,
    );
  }
  fs.writeFileSync(stopFilePath(workflowDir), `${at}\n`);
}

/**
 * consumeStopFile 의 상세 결과. §32 I-5 — §31 I7 수정은 unlink 실패를 `false` 로만 흡수해
 * "소비 안 됨"과 "크래시"는 구분했지만, **왜** 소비가 안 됐는지(errno)는 그 자리에서 버려졌다.
 * 감사자 실측: `mkdir STOP` 을 하면 `fw run` 을 몇 번을 다시 돌려도 매번 같은 이유로 다시
 * halted 되는데, 그 이유가 STATE 어디에도 남지 않아 "재실행하세요" 안내를 따라도 영원히
 * 풀리지 않는 루프가 된다. `failure` 에 실제 unlink 가 던진 errno 기반 사유를 담아, 이 정보를
 * 필요로 하는 호출부(현재는 checkHaltpoint 가 §32 I-4 방식대로 별도 non-destructive 진단인
 * `stopFileProblem` 을 쓴다 — 이 타입은 실제 소비 시도 지점, 즉 향후 orchestrator.ts 배선용)가
 * 조립할 수 있게 한다.
 */
export interface ConsumeStopFileResult {
  consumed: boolean;
  failure?: string;
}

/**
 * STOP 파일이 있으면 지우고 `{ consumed: true }`, 없으면 `{ consumed: false }`. 실패하면
 * `{ consumed: false, failure: "<errno 기반 사유>" }`. `fw run` 시작 시 호출된다 — 소비(삭제)는
 * "이번엔 새로 돌리겠다"는 명시적 의사표시이므로 조용히 지우지 않고 호출부가 로그를 남긴다.
 *
 * §31 I7 — 예전엔 `unlinkSync` 를 무보호로 호출해 STOP 이 디렉토리(EPERM/EISDIR)이거나
 * 워크플로우 디렉토리가 읽기 전용(EACCES)이면 그대로 throw 했다. 호출부(orchestrator.ts, 다른
 * 에이전트 소유)의 첫 줄이라 STATE 를 저장하기도 전에 `fw run` 전체가 죽었다 — `mkdir STOP`
 * 한 번이면 사람이 손으로 지울 때까지 fw run 이 영구히 막히는 자충수였다(§30 P2).
 *
 * §32 I-5 — 그런데 그 수정이 "소비 실패"를 조용한 무음으로 바꿔버렸다: unlink 가 왜 실패했는지
 * (errno)가 catch 에서 버려져, 사용자는 "왜 계속 halted 되는지" 알 방법이 없었다(수정 전
 * EPERM throw 는 최소한 원인이 메시지에 있었다 — 진단 가능한 실패를 진단 불가능한 무음 루프로
 * 바꾼 셈). 여기서는 "소비 안 됨" 이라는 결과는 그대로 유지하되(무인 주행을 막지 않는다는
 * §31 I7 의 계약은 지킨다) 실패 사유를 함께 반환한다.
 *
 * 정지 의도 자체를 잃는 건 아니다 — unlink 가 실패했다는 건 파일이 여전히 그 자리에 있다는
 * 뜻이고, `isStopRequested` 는 여전히 true 를 보고하므로(existsSync 는 무해) 다음
 * 체크포인트(halt.ts 의 checkHaltpoint)에서 halted 로 정지할 기회가 남는다.
 */
export function consumeStopFileDetailed(workflowDir: string): ConsumeStopFileResult {
  const file = stopFilePath(workflowDir);
  if (!fs.existsSync(file)) return { consumed: false };
  try {
    fs.unlinkSync(file);
    return { consumed: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
    return {
      consumed: false,
      failure:
        `STOP 파일 삭제 실패: ${code} — STOP(${file}) 이 디렉토리이거나 특수 파일이거나, ` +
        "워크플로우 디렉토리에 쓰기 권한이 없을 수 있습니다. 직접 지운 뒤(또는 권한을 " +
        "수정한 뒤) 다시 실행하세요.",
    };
  }
}

/**
 * 하위호환 wrapper — 기존 호출부(orchestrator.ts, 다른 에이전트 소유)의 `if (consumeStopFile(dir))`
 * 가 계속 컴파일·동작하도록 boolean 만 반환한다. 실패 사유가 필요한 새 호출부는
 * `consumeStopFileDetailed` 를 직접 쓴다.
 */
export function consumeStopFile(workflowDir: string): boolean {
  return consumeStopFileDetailed(workflowDir).consumed;
}

/**
 * STOP 파일을 **건드리지 않고**(부작용 없이) "다음 `fw run` 이 이 STOP 을 정상적으로 소비할 수
 * 있는가"만 진단한다. §32 I-5 — checkHaltpoint(halt.ts)와 `fw doctor` 양쪽이 이 함수를 공유한다.
 * 소비(삭제) 자체는 `fw run` 시작 시점(orchestrator.ts, consumeStopFileDetailed)의 몫이다 —
 * 체크포인트나 doctor 가 실제로 지워보면(부작용) 정지 신호를 조기에 없애버리거나 doctor
 * 실행만으로 상태가 바뀌는 부작용이 생긴다. 그래서 여기서는 `lstat`/`access` 로만 판정한다.
 *
 * 반환: null = STOP 이 없거나(정상) 일반 파일 + 디렉토리 쓰기 가능(정상 — 다음 `fw run` 이 소비
 * 가능). string = 비정상 — 다음 `fw run` 도 소비에 실패해 같은 사유로 다시 halted 될 것으로
 * 예상된다(`mkdir STOP` 시나리오, 감사자 실측).
 */
export function stopFileProblem(workflowDir: string): string | null {
  const file = stopFilePath(workflowDir);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return null; // 없음 — 문제 아님
  }
  if (!stat.isFile()) {
    return (
      "STOP 파일 삭제 실패: EPERM — STOP 이 디렉토리이거나 특수 파일입니다. " +
      "직접 지운 뒤 다시 실행하세요."
    );
  }
  try {
    fs.accessSync(workflowDir, fs.constants.W_OK);
  } catch {
    return (
      "STOP 파일 삭제 실패: EACCES — 워크플로우 디렉토리에 쓰기 권한이 없습니다. " +
      "권한을 수정하거나 STOP 파일을 직접 지운 뒤 다시 실행하세요."
    );
  }
  return null;
}

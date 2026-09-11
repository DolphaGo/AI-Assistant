import { describe, it, expect, vi } from "vitest";

// 실제 osascript/notify-send 실행을 차단 — 테스트를 돌릴 때마다 실제 알림(+사운드)이 뜨는 것을
// 막는다. vi.mock 은 호이스팅되므로 아래 import 보다 먼저 적용된다. §27 O4 로 notify-send 경로가
// 추가돼도 이 mock 이 execFile 자체를 완전히 대체하므로 새 경로도 그대로 mock 을 탄다.
vi.mock("node:child_process", () => ({
  // §65 후속으로 options 인자(timeout)가 끼면서 콜백은 3번째 또는 4번째로 온다 — 마지막
  // 함수 인자를 콜백으로 취급해 두 형태 모두 지원한다.
  execFile: vi.fn((...fnArgs: unknown[]) => {
    const cb = fnArgs.filter(a => typeof a === "function").at(-1) as ((err: unknown) => void) | undefined;
    cb?.(null);
  }),
}));

import { execFile } from "node:child_process";
import { buildOsaScript, formatNotificationBanner, notifier } from "../src/notify.js";

// process.platform 은 configurable:true 로 정의돼 있어 defineProperty 로 안전하게 오버라이드/
// 복원할 수 있다(Node 자체 동작 — 실측 확인됨). 실제 실행 플랫폼과 무관하게 darwin/linux/win32
// 세 분기를 전부 테스트하기 위한 헬퍼.
function withPlatform(platform: NodeJS.Platform, fn: () => void): void {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...original, value: platform });
  try {
    fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

describe("buildOsaScript", () => {
  it("따옴표를 안전하게 이스케이프한다", () => {
    const s = buildOsaScript('제목 "x"', '메시지 "y"');
    expect(s).toBe(
      'display notification "메시지 \\"y\\"" with title "제목 \\"x\\"" sound name "Glass"',
    );
  });

  it("제어 문자를 \\uXXXX 로 이스케이프하지 않는다 (AppleScript 에 \\u 문법 없음)", () => {
    const s = buildOsaScript("title", "a\bb\fcd");
    expect(s).not.toMatch(/\\u00/);
    expect(s).not.toMatch(/\\b/);
    expect(s).not.toMatch(/\\f/);
  });

  it("짝 잃은 서로게이트(이모지 절단 시뮬레이션)를 서로게이트 이스케이프 없이 제거한다", () => {
    const s = buildOsaScript("title", "질문 \uD83D");
    expect(s).not.toMatch(/\\u/i);
  });

  it("정상 이모지 쌍과 한글은 보존한다", () => {
    const s = buildOsaScript("알림", "✅ 완료 🎉");
    expect(s).toContain("✅");
    expect(s).toContain("완료");
    expect(s).toContain("🎉");
  });
});

// §27 O4 — 배너 생성을 순수 함수로 분리해 부수효과(console.error) 없이 내용을 테스트한다.
describe("formatNotificationBanner", () => {
  it("제목/메시지를 위아래 동일한 구분선 사이에 배치한다", () => {
    const banner = formatNotificationBanner("fw BLOCKED", "Phase 2: 이 설정을 어느 파일에 둘까요?");
    const lines = banner.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(lines[3]);
    expect(lines[0]).toMatch(/^═+$/);
    expect(lines[1]).toContain("fw BLOCKED");
    expect(lines[2]).toBe("Phase 2: 이 설정을 어느 파일에 둘까요?");
  });

  it("긴 제목/메시지도 자르지 않고 그대로 보존한다", () => {
    const longMsg = "x".repeat(300);
    const banner = formatNotificationBanner("fw FAILED", longMsg);
    expect(banner).toContain(longMsg);
  });

  it("순수 함수 — 같은 입력에는 항상 같은 출력, 부수효과 없음", () => {
    expect(formatNotificationBanner("a", "b")).toBe(formatNotificationBanner("a", "b"));
  });
});

describe("notifier", () => {
  it("호출해도 throw 하지 않는다 (알림 실패는 무시)", () => {
    expect(() => notifier("fw test", "hello")).not.toThrow();
  });

  // §27 O4-1: 플랫폼 무관하게 항상 stderr 배너를 찍는다 — 알림이 조용히 사라지지 않는다는
  // 계약의 핵심. console.error 를 캡처해 테스트 출력이 배너로 지저분해지지 않게 한다.
  it("플랫폼 무관하게 항상 stderr 에 배너를 찍는다 (마지막 방어선)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      notifier("fw BLOCKED", "Phase 2: 질문");
      const expectedBanner = formatNotificationBanner("fw BLOCKED", "Phase 2: 질문");
      expect(spy.mock.calls.some(call => call[0] === expectedBanner)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it.runIf(process.platform === "darwin")(
    "darwin: osascript 를 호출하되 mock 이라 실제 알림은 뜨지 않는다",
    () => {
      vi.mocked(execFile).mockClear();
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        notifier("fw mock", "no real popup");
        expect(execFile).toHaveBeenCalledTimes(1);
        expect(vi.mocked(execFile).mock.calls[0]![0]).toBe("osascript");
        // §65 후속 — 알림 도구가 매달려도 자식 핸들이 프로세스 종료를 못 막게 timeout 필수
        expect(vi.mocked(execFile).mock.calls[0]![2]).toMatchObject({ timeout: 10_000 });
      } finally {
        spy.mockRestore();
      }
    },
  );

  // §27 O4-2: linux → notify-send(있으면). execFile 자체가 파일 최상단 vi.mock 으로 완전히
  // 대체돼 있으므로 이 테스트는 실제 실행 플랫폼과 무관하게 안전하다 — 진짜 notify-send 프로세스는
  // 절대 뜨지 않는다(호출 카운트/인자로 증명).
  it("linux: notify-send 를 호출한다 (mock — 실제 알림 없음)", () => {
    vi.mocked(execFile).mockClear();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      withPlatform("linux", () => {
        notifier("fw BLOCKED", "질문 있음");
      });
      expect(execFile).toHaveBeenCalledTimes(1);
      const call = vi.mocked(execFile).mock.calls[0]!;
      expect(call[0]).toBe("notify-send");
      expect(call[1]).toEqual(["fw BLOCKED", "질문 있음"]);
      // §65 후속 — darwin 경로와 동일하게 timeout 필수
      expect(call[2]).toMatchObject({ timeout: 10_000 });
    } finally {
      spy.mockRestore();
    }
  });

  // §27 O4-2: notify-send 가 없는 환경(ENOENT)에서도 에러를 내지 않는다 — 배너만으로 계약이
  // 이미 충족되므로 "없다고 에러 내지 마라"는 요구사항을 실측한다.
  it("linux + notify-send 부재(ENOENT): throw 하지 않고 배너로 대체된다", () => {
    vi.mocked(execFile).mockClear();
    // execFile 은 오버로드가 여러 개라(콜백 인자 개수별) mockImplementationOnce 에 정확한
    // 시그니처를 맞추기보다 any 로 캐스팅한다 — 이 mock 자체가 노드의 실제 실행 로직을 대체하는
    // 테스트 전용 스텁이라 타입 엄격성보다 표현력이 우선이다.
    (vi.mocked(execFile).mockImplementationOnce as any)((...fnArgs: unknown[]) => {
      const err = Object.assign(new Error("spawn notify-send ENOENT"), { code: "ENOENT" });
      const cb = fnArgs.filter(a => typeof a === "function").at(-1) as ((err: unknown) => void) | undefined;
      cb?.(err);
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      withPlatform("linux", () => {
        expect(() => notifier("fw BLOCKED", "질문 있음")).not.toThrow();
      });
      expect(execFile).toHaveBeenCalledTimes(1);
      // 배너(1회) + notify-send 실패 디버깅 로그(1회) 둘 다 stderr 로 갔는지 확인 — 조용히
      // 삼켜지지 않고 흔적이 남는다.
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      spy.mockRestore();
    }
  });

  // §27 O4-2: darwin/linux 이외(win32 등)는 네이티브 알림을 아예 시도하지 않고 배너만 출력한다.
  it("darwin/linux 이외 플랫폼: 네이티브 알림 시도 없이 배너만 출력한다", () => {
    vi.mocked(execFile).mockClear();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      withPlatform("win32", () => {
        notifier("fw FAILED", "오류 발생");
      });
      expect(execFile).not.toHaveBeenCalled();
      expect(spy).toHaveBeenCalledWith(formatNotificationBanner("fw FAILED", "오류 발생"));
    } finally {
      spy.mockRestore();
    }
  });

  // 테스트 스위트 전체에 걸쳐 실제 알림이 0회 떴는지를 mock 호출 횟수/인자로 증명한다 —
  // execFile 은 모듈 최상단에서 완전히 mock 됐으므로 darwin/linux 어느 분기를 타도 실제 프로세스
  // (osascript/notify-send)는 절대 spawn 되지 않는다.
  it("모든 플랫폼 분기에서 execFile 호출은 mock 뿐 — 실제 알림 스폰 0회", () => {
    vi.mocked(execFile).mockClear();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      withPlatform("darwin", () => notifier("fw test", "1"));
      withPlatform("linux", () => notifier("fw test", "2"));
      withPlatform("win32", () => notifier("fw test", "3"));
      // darwin+linux 만 execFile 을 부른다 — win32 는 안 부르므로 정확히 2회.
      expect(execFile).toHaveBeenCalledTimes(2);
      for (const call of vi.mocked(execFile).mock.calls) {
        expect(["osascript", "notify-send"]).toContain(call[0]);
      }
    } finally {
      spy.mockRestore();
    }
  });
});

// §61 — 알림 본문은 세션 요약이 원문으로 나가는 유일한 무마스킹 표시면이었다(pr-comment-mask
// 합의 실측). 원격 채널 확장 대비 단일 지점(notifier)에서 마스킹한다.
describe("notifier 마스킹 — §61", () => {
  it("본문의 비밀이 배너/네이티브 알림 양쪽에서 마스킹된다", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      notifier("fw BLOCKED", "검증 실패: 토큰 ghp_AAAABBBBCCCCDDDDEEEE 노출");
      const banner = errSpy.mock.calls.map(c => String(c[0])).join("\n");
      expect(banner).not.toContain("ghp_AAAABBBBCCCCDDDDEEEE");
      expect(banner).toContain("***MASKED***");
      // 네이티브 알림(mock 된 execFile) 인자도 마스킹된 본문이어야 한다
      const ef = vi.mocked(execFile);
      if (ef.mock.calls.length > 0) {
        const osaArg = String((ef.mock.calls.at(-1)! as unknown[])[1]);
        expect(osaArg).not.toContain("ghp_AAAABBBBCCCCDDDDEEEE");
      }
    } finally {
      errSpy.mockRestore();
    }
  });
});

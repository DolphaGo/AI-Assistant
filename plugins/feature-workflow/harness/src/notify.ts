import { execFile } from "node:child_process";
import { maskSecrets } from "./session.js";

export type Notifier = (title: string, message: string) => void;

function sanitize(text: string): string {
  return text
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "") // 짝 잃은 high surrogate 제거
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "") // 짝 잃은 low surrogate 제거
    .replace(/[\x00-\x1F\x7F]/g, " "); // C0 제어문자+DEL → 공백 (AppleScript 에 \u 문법 없음)
}

export function buildOsaScript(title: string, message: string): string {
  // JSON.stringify 는 큰따옴표/역슬래시를 이스케이프한 큰따옴표 문자열을 만들며
  // AppleScript 문자열 리터럴과 호환되지만, 제어 문자와 짝 잃은 서로게이트는 \uXXXX 로
  // 이스케이프하는데 AppleScript 는 이 문법을 모르므로 sanitize 로 먼저 제거한다
  const safeTitle = sanitize(title);
  const safeMessage = sanitize(message);
  return `display notification ${JSON.stringify(safeMessage)} with title ${JSON.stringify(safeTitle)} sound name "Glass"`;
}

// §27 O4 — 알림 폴백. 실측 문제: 기존 macNotifier 는 `if (process.platform !== "darwin") return;`
// 로 즉시 리턴해 Linux/CI/원격에서 BLOCKED 알림이 조용히 사라졌다 — 무인 주행 중 "질문이 생겨
// 멈췄다"를 아무도 모르면 다음 아침까지 방치된다. 배너는 플랫폼과 무관하게 항상 stderr 에 찍는
// **마지막 방어선**이다 — 네이티브 알림(osascript/notify-send)이 실패하거나 애초에 없는
// 플랫폼이어도 터미널/로그를 보는 사람은 이 배너를 볼 수 있다.
const BANNER_BAR = "═".repeat(44);

/** stderr 배너를 순수 문자열로 만든다 — 부수효과(console.error 호출) 없이 내용만 테스트하기 위해 분리. */
export function formatNotificationBanner(title: string, message: string): string {
  return [BANNER_BAR, `⏸  ${title}`, message, BANNER_BAR].join("\n");
}

function printBanner(title: string, message: string): void {
  console.error(formatNotificationBanner(title, message));
}

// §65 후속 — 하네스의 자식 프로세스 실행 지점 전수 조사에서 여기만 timeout 이 없었다.
// fire-and-forget 이라 주행을 막지는 않지만, 알림 도구가 매달리면 자식 핸들이 이벤트 루프를
// 붙잡아 프로세스 종료를 막는다. 타임아웃 시 err 콜백이 기존 실패 경로로 합류한다(새 경로 없음).
const NOTIFY_TIMEOUT_MS = 10_000;

function notifyDarwin(title: string, message: string): void {
  execFile("osascript", ["-e", buildOsaScript(title, message)], { timeout: NOTIFY_TIMEOUT_MS }, (err) => {
    // 알림 실패는 무인 주행을 막지 않는다 — 던지지는 않되 디버깅 흔적은 남긴다
    if (err) console.error(`[fw notify] osascript 알림 실패 (무시하고 계속, 배너로 대체됨): ${err.message}`);
  });
}

// linux 는 notify-send 가 설치돼 있으면 그걸 쓰고, 없으면(ENOENT 등) 에러를 내지 않는다 —
// 배너만으로 이미 §27 O4 의 "조용히 사라지지 않는다" 계약은 충족된다.
function notifyLinux(title: string, message: string): void {
  execFile("notify-send", [sanitize(title), sanitize(message)], { timeout: NOTIFY_TIMEOUT_MS }, (err) => {
    if (err) console.error(`[fw notify] notify-send 알림 실패 (무시하고 계속, 배너로 대체됨): ${err.message}`);
  });
}

// §27 O4 이후 이 함수는 더 이상 macOS 전용이 아니다(배너는 모든 플랫폼, 네이티브 알림은
// darwin/linux). 구 이름 macNotifier 는 오해를 부르므로 notifier 로 개명했다.
export const notifier: Notifier = (title, rawMessage) => {
  // §61 — 알림 본문은 세션 요약(신뢰 경계 밖 텍스트)을 그대로 담는 유일한 무마스킹 표시면이었다
  // (pr-comment-mask 합의가 실측 지적: fixFailureSummary/result.summary/guardOutcome.problem 이
  // 원문으로 전달). 지금은 로컬 채널(stderr/osascript/notify-send)뿐이라 실해가 낮지만, 이
  // Notifier 가 원격 채널(Slack webhook 등)로 확장되는 순간 §47 급 유출 표면이 된다 — 표시
  // 계약을 맞춰 단일 지점(여기)에서 마스킹한다. title 은 하네스가 만드는 고정 문구라 제외.
  const message = maskSecrets(rawMessage);
  // 1. 플랫폼 무관 항상 stderr 배너 — 마지막 방어선(§27 O4-1)
  printBanner(title, message);
  // 2. 플랫폼별 네이티브 알림 — 실패해도 무해화(§27 O4-3), 그 외 플랫폼(win32 등)은 배너만(O4-2)
  if (process.platform === "darwin") {
    notifyDarwin(title, message);
  } else if (process.platform === "linux") {
    notifyLinux(title, message);
  }
};

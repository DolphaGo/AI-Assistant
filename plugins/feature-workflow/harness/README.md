# fw — feature-workflow 무인 하네스

feature-workflow skill의 워크플로우(PLAN/STATE.json/NOTES 3종)를
무인으로 끝까지 실행하는 오케스트레이터. 설계: `../../../specs/2026-08-26-feature-workflow-harness-design.md`

## 설치 (최초 1회)

리포 루트에서:

    npm run fw:install

(`npm install`(`prepare` 스크립트가 자동으로 `npm run build` 를 돌린다) 후 `npm link` 까지 한 번에
끝난다 — `dist/` 는 git 에 커밋하지 않는다. 빌드 산출물을 커밋하면 diff 노이즈·머지 충돌·stale
위험이 커지기 때문에, 대신 설치 시점에 항상 새로 빌드한다.)

`fw --version` 으로 설치가 됐는지 확인한다.

### 전제조건

| 항목 | 요구 사항 | 확인 방법 |
|---|---|---|
| Node.js | ≥ 22.12.0 | `node -v` |
| Harness Agent SDK 인증 | `claude setup-token` 실행 완료 또는 `ANTHROPIC_API_KEY` 환경변수 | `claude setup-token` 또는 `echo $ANTHROPIC_API_KEY` |
| `gh` 인증 (PR 모드만) | `gh auth login` 완료 | `gh auth status` |
| OS | macOS (알림 사용) | `fw run` 은 완료/BLOCKED/FAILED 시 macOS 알림(`osascript`)을 띄운다 — 다른 OS 에서도 동작은 하지만 알림은 무음이다 |

## 사용 흐름

1. 대상 리포에서 Claude Code 로 `/feature-workflow:start` → PLAN/NOTES/STATE.json 생성 (유인, phase 별 `next_steps` 포함)
2. `fw run docs/<workflow>` → 무인 자율 주행 (phase 세션 spawn → 하네스가 검증 직접 판정 → 반복)
3. macOS 알림:
   - `fw BLOCKED` → `fw status <dir>` 로 질문 확인 → `fw answer <dir> "<답>"` → `fw run <dir>` 재개
   - `fw FAILED` → `fw log <dir>` 로 세션 이력·비용·검증 로그 경로를 한눈에 확인, 필요 시
     `fw retry <dir> <phaseId>` 후 `fw run`
   - `fw 완료 ✅` → `git log` 로 phase 별 커밋 리뷰, `VERIFY.md` 확인, `fw log <dir>` 로 밤새
     서사(세션 이력·비용) 재구성

## 브랜치 안전 (§19)

`fw run` 은 phase 세션을 띄우기 전에 두 단계를 거친다.

**1. 프리플라이트.** repo_root 가 존재하는 디렉토리인지, git 저장소인지, 워킹트리가 깨끗한지
(`git status --porcelain` 이 비어있는지), `pr_mode` 면 `gh auth status` 가 성공하는지 확인한다.
하나라도 걸리면 세션을 한 번도 실행하지 않고 FAILED 로 정지 + 알림한다 — 메시지에 무엇이
문제였고 어떻게 고치면 되는지가 함께 담긴다(예: "워킹트리에 커밋되지 않은 변경이 있습니다.
커밋하거나 stash 한 뒤 다시 실행하세요"). 워킹트리를 깨끗하게 요구하는 이유는, 세션이 만드는
커밋과 사람이 이미 만들어둔 변경이 섞이면 커밋 게이트·verify 대상 파일 위조 검사(diff 기준)가
오염되기 때문이다.

**2. 브랜치 격리.** 프리플라이트를 통과하면 STATE.json 의 `branch_strategy` 로 어느 브랜치에서
작업할지 정한다.

| `branch_strategy` | 현재 브랜치 == `base_branch` 일 때 | 다른 브랜치일 때 |
|---|---|---|
| `"isolate"` (기본, 권장) | `feature/<workflow>` 브랜치를 만들어(이미 있으면 체크아웃만) 그 위에서 실행 | 그대로 진행 |
| `"current"` | 경고 로그만 남기고 그대로 진행 (그 브랜치에 직접 커밋이 쌓인다) | 그대로 진행 |
| `"require-topic"` | 세션을 띄우지 않고 즉시 FAILED (토픽 브랜치를 만들거나 전략을 바꿔야 함) | 그대로 진행 |

**"우리 main 에 붙여도 되나?"** — 기본값(`isolate`)에서는 **예, 자동으로 격리된다.** main
(또는 STATE.json 에 설정한 `base_branch`)에서 `fw run` 을 그냥 돌려도 세션은 `feature/<workflow>`
브랜치 위에서 커밋하고, main 은 건드리지 않는다. `branch_strategy` 를 `"current"` 로 바꾸면
(사용자가 이미 토픽 브랜치를 만들어둔 경우를 위한 옵트인이다) 이 보장이 사라진다 — 그 때는
현재 체크아웃된 브랜치가 base_branch 와 같아도 그대로 커밋이 쌓이니 주의.

하위호환: 이 기능 이전에 만들어진 STATE.json 은 `branch_strategy: "topic"` 을 쓰고 있을 수
있다 — `"isolate"` 의 별칭으로 그대로 로드되고 동일하게 동작한다.

**workflow 이름 규칙.** `workflow` 는 그대로 `feature/<workflow>` git 브랜치 이름이 된다. 유니코드
문자(한글 포함)는 git 이 허용하므로 그대로 쓸 수 있다 — 다음만 금지된다: 공백/제어문자,
메타문자 `~^:?*[\`, 연속된 `..`, `@{`, 선행·후행 `.`, 후행 `.lock`, 단독 `@`, 예약어 `HEAD`,
그리고 `/`(fw 고유 제약 — `docs/<workflow>` 디렉토리명과 1:1 대응을 위해).

## PR 모드 (v2)

STATE.json 에 `"pr_mode": true, "allow_push": true` 를 넣으면 phase 검증 통과 후
PR 을 만들고 리뷰 왕복을 자율로 돈다 (`allow_push` 가 false 면 `fw run` 이 시작을 거부한다 —
PR 브랜치로 fix 커밋을 push 해야 성립하기 때문).

**`trusted_comment_authors` 를 채우거나, 코멘트 처리를 명시적으로 끄거나 둘 중 하나를 선택해야
한다.** `@fw`/`/fw fix` 마커는 "나에게 한 말인가"만 정할 뿐 "말할 자격이 있는가"는 정하지 않는다
— 사내 GHE 에서는 리포 읽기 권한자 누구나 코멘트를 달 수 있다. STATE.json 의
`trusted_comment_authors` 배열(로그인, 대소문자 무시)에 없는 작성자의 트리거 코멘트는
무시된다(fail-closed). 기본값(`pr_comment_mode: "trusted"`)에서 `trusted_comment_authors` 가
비어 있으면 **`fw run`/`fw doctor` 가 시작을 거부한다** — 채우지 않은 채로 두면 PR 을 만들고
`@fw` 를 달아도 밤새 아무 일도 안 일어나는 무음 무력화(§26 I6)가 되기 때문이다.

**"PR 만 만들고 코멘트는 처리하지 않겠다"는 사용도 정당하다.** 이 경우
`"pr_comment_mode": "off"` 를 STATE.json 에 명시하면 `trusted_comment_authors` 가 비어 있어도
시작을 거부하지 않는다 — "실수로 방치"(기본값 `"trusted"` + 빈 배열 → 거부)와 "의도적
옵트아웃"(`"off"`)을 STATE 만 보고 구분하기 위한 필드다(§29 MI-10).

| `pr_comment_mode` | `trusted_comment_authors` 빈 배열일 때 |
|---|---|
| `"trusted"` (기본, 생략 가능) | `fw run`/`fw doctor` 시작 거부 |
| `"off"` | 통과 — 코멘트를 폴링/처리하지 않는다 |

1. phase 검증 통과 → `gh pr create` (헤드 브랜치 `fw/phase-<id>`, base 는 `base_branch`, 기본 `main`)
2. 폴링(기본 60초, `poll_interval_ms`) — **`@fw` 또는 `/fw fix` 마커가 있는 코멘트만** 읽는다
   → 마커가 있으면 fix 세션이 반영·커밋·push → 코멘트에 `[fw-harness]` 로 시작하는 답글로 보고
3. approve 감지 → 전역 status 가 `awaiting_merge` 로 정지 + 알림 (**머지는 사람이 한다** — `gh pr merge`/`close`
   는 하네스 권한에서 차단되어 있다)
4. 사람이 머지 → `fw run <dir>` 재실행 → merged 감지 → 다음 phase 로 진행 (PR 재생성 없음)

PR 당 fix 세션 실행 횟수에는 `max_fix_sessions`(기본 10) 상한이 있다. 초과하면 무기한 폴링에
유료 세션이 무한히 붙는 것을 막기 위해 전역 status 가 `failed` 로 정지한다.

### 코멘트 규약 (중요)
PR 코멘트는 신뢰 경계 밖 입력이다 — 팀원 잡담이 섞이고 프롬프트 인젝션도 가능하다.
그래서 하네스는 **명시 마커(`@fw`, `/fw fix`, 대소문자 무시)가 있는 코멘트만** 지시로 인정하고,
그 내용도 "데이터"로 인용해 세션에 넘긴다. 코드블록·인라인 코드·인용문(`>`)·HTML 주석·
`<details>` 접힘 블록 안에 있는 마커는 예시/인용으로 보고 무시한다. 봇 코멘트와 하네스
자신이 단 답글(첫 줄이 `[fw-harness]` 센티널)도 무시한다 (무한 루프 방지).

작성자가 `trusted_comment_authors` 에 없으면 마커가 있어도 무시된다(§24 감사 T1 — 마커만으로는
신원을 통제할 수 없다).

범위 밖 요구(자격증명·다른 리포·권한 변경·머지)는 세션이 `blocked` 로 되돌리고 사람에게 알린다.
`gh pr merge`/`close`/`reopen`, `gh api` 의 쓰기 메서드·GraphQL mutation·`/merge` 경로는
권한 정책에서 차단된다 (`gh api -X PUT .../merge` 로 우회하는 것도 막는다).

폴링 중 Ctrl-C 로 중단해도 STATE.json 의 `phase.pr` 로 재개된다 (PR 재생성 없음).

## 명령

| 명령 | 역할 |
|---|---|
| `fw run <dir>` | 자율 주행 시작/재개 |
| `fw stop <dir>` | 킬 스위치 — `STOP` 파일을 만들어 **다음 체크포인트에서** 정지 (§27 O3, 아래 절 참조) |
| `fw status <dir>` | 현황 + BLOCKED 질문 출력 |
| `fw answer <dir> "<답>"` | 질문에 답 기록 |
| `fw retry <dir> <phaseId>` | failed phase 를 pending 으로 되살림 |
| `fw init <dir> [--repo <path>]` | 스켈레톤 STATE.json 생성 |
| `fw doctor <dir> [--no-run]` | 게이트 신뢰성 점검 (§18, 아래 절 참조) |
| `fw log <dir> [--last N]` | STATE 요약 + phase 별 세션 이력·비용 + 최근 실행 로그 목록 출력 (§20, 아래 절 참조) |
| `fw report <dir>` | 완주/진행 중 워크플로우의 attempts·세션·비용 등 판단 재료를 집계해 출력 (§34 T2, 아래 절 참조) |
| `fw --version` | 설치된 버전 출력 |

**`<dir>` 은 워크플로우 이름만 써도 된다 (§69).** `fw run writing-training` 은
`fw run docs/writing-training` 과 같다 — 단독 이름이면 `docs/<이름>` 으로 자동 해석된다
(현재 디렉토리에 `<이름>/STATE.json` 이 있으면 그쪽 우선 — docs 안에서 실행하는 경우).
경로 구분자를 포함하거나 절대경로면 기존 그대로 해석되므로 docs 밖 커스텀 위치도 여전히 가능하다.
`fw init <이름>` 도 같은 규칙이라 docs/<이름> 에 생성된다.

`fw run` 종료 코드: 0 = 완료 또는 승인 대기(정상 정지 — 사람이 머지할 차례), 1 = BLOCKED/FAILED.

## 게이트 신뢰성 점검 — `fw doctor` (§18)

이 도구의 전체 가치는 verify 명령의 exit code 한 점에 걸려 있다. `npm test || true` / `echo ok` /
`... | tee log` 처럼 항상 exit 0 이 되는 명령을 넣으면 게이트가 무엇을 해도 통과해버리고, 그동안
이 실수를 막는 건 README·SKILL·start.md 의 산문 경고뿐이었다. `fw doctor` 는 그 경고를 코드
검사로 바꾼다.

    fw doctor docs/<workflow>          # 정적 검사 + 프리플라이트 + STATE 불변식 + verify 1회 실행
    fw doctor docs/<workflow> --no-run # 위와 동일하되 verify 명령은 실행하지 않음(부작용 회피)

점검 항목:
1. **프리플라이트** — repo_root/git 저장소 여부/워킹트리 청결/(pr_mode 면) gh 인증 (§19 와 동일 검사 재사용)
2. **STATE 불변식** — `assertRunnable` 이 검사하는 것(phase 구성/의존성 순환/검증 명령 존재 등)과 동일
3. **verify 명령 정적 검사** — `|| true`/`|| :`, `; true`/`; :`, 단독 `true`/`:`, `echo` 만으로 구성된
   명령, `| tee`, `--exit-zero` 류는 **error**(게이트를 구조적으로 무력화). 파이프 사용, `&&` 없이
   여러 명령을 나열하는 것은 **warn**(판정이 흐려질 수 있음).
4. **verify 실측** — 각 verify 명령을 현재 워킹트리에서 실제로 1회 실행해 지금 통과/실패하는지 보여준다.
   빌드 도구를 직접 실행하므로 대상 리포에 부작용(캐시 생성 등)이 남을 수 있다 — `--no-run` 으로
   건너뛸 수 있다. 락은 잡지 않는다(다른 `fw run` 과 동시에 verify 를 실행하면 리소스가 겹칠 수 있으니
   주의).

문제가 있으면(정적 검사 error, 프리플라이트/STATE 불변식 위반, verify 실측 실패) exit 1, 아니면 exit 0.
각 문제 줄에는 해결 방법이 함께 나온다.

**`fw run` 과의 관계 (§26 I5 잔여, 승격 완료)**: `fw doctor` 의 정적 검사(error 판정)는 이제
`fw run`/`assertRunnable` 이 시작 시점에 그대로 물려받아 실행 자체를 거부한다 — 옵트인 진단에
머물던 시절에는 `npm test || true` 처럼 항상 exit 0 인 명령이 `fw doctor` 에서도 "ok" 로 나오는
동안 `fw run` 은 그걸 전혀 보지 않아 게이트가 밤새 전부 "통과"하고 워크플로우가 `done` 이 될 수
있었다(§29 MI-11). 이제 그런 명령은 `fw run` 시작 자체가 거부된다(세션은 한 번도 spawn 되지
않는다 — 유료 비용 없음). `warn`(파이프·`;` 나열 등)은 판정을 흐릴 수 있지만 항상 무력화를 뜻하지는
않으므로 시작을 막지 않는다. 이미 `done` 인 phase 는 다시 실행되지 않으므로 그 phase 의 verify
명령이 나빠도 재개를 막지 않는다. `fw doctor` 는 여전히 유효하다 — 실측 실행·프리플라이트·STATE
불변식까지 한 번에 보여주는 것은 `fw run` 이 하지 않는 사전 점검이다.

## 실행 로그 관측 — `fw log` (§20)

`fw run` 은 지금까지 `deps.log` 를 `console.log` 로만 배선해, 터미널을 닫으면 밤새 돌린 실행의
서사가 그대로 소실됐다(설계 §9 가 약속했던 로그 파일화 미구현). 이제 `fw run` 은 시작할 때
`docs/<workflow>/logs/run-<ISO타임스탬프>.log`(콜론은 파일명에 못 쓰므로 `-` 로 치환, 예:
`run-2026-08-27T01-23-45.log`)를 만들어 콘솔에 찍는 모든 줄에 `[HH:mm:ss]` 접두를 붙여 append
하고, 종료(정상/예외/시그널 무관) 시 그 경로를 콘솔에 알려준다. 로그 파일 쓰기 실패는
무해화된다 — 판정/실행을 막지 않고 최초 실패 시 콘솔에 한 번만 경고한다(게이트 로그와 동일한
"로그는 부산물" 원칙).

    fw log docs/<workflow>            # STATE 요약 + phase 별 세션 이력·비용 + 최근 run 로그 목록
    fw log docs/<workflow> --last 50  # 위에 더해 가장 최근 run 로그 파일의 마지막 50줄

출력에는 workflow/status/총 비용, phase 별 상태·시도·세션 비용·PR 번호, phase 별 세션을
`kind`(phase/fix/verify)와 함께 시간순으로(결과·비용·summary 앞 200자), BLOCKED 질문(있으면),
`logs/` 의 최근 run 로그 파일 목록(최대 5개)이 포함된다. **`docs/<workflow>/logs/` 는 커밋
대상이 아니다** — verify 명령 출력과 run 로그 모두 토큰/시크릿이 무마스킹으로 섞일 수 있어
리포 루트 `.gitignore` 에 등록돼 있다.

## 결과 지표 — `fw report` (§34 T2)

`fw run` 이 "게이트가 통과했다"는 알아도 "잘 돌아갔는가"는 알려주지 않는다. `fw report` 는
STATE.json 에 이미 있는 값(`phases[].sessions[]`, `attempts`, `answers`, `pending_question`)을
집계해 사람이 판단할 재료를 보여준다 — **점수판이 아니다**: attempts/비용이 적을수록 좋다는
뜻이 아니고(재시도 0회는 게이트가 무의미하다는 뜻일 수도 있다), "잘/나쁘다" 판정도 하지 않는다.

    fw report docs/<workflow>

출력에는 workflow/status·완주 여부·총 비용, 세션 종류(`kind`: phase/fix/verify)별 건수·비용
(해당 종류 세션이 하나도 없어도 "0건" 으로 명시해 "없었다"와 "집계 누락"을 구분한다), phase 별
시도/세션 수/비용, BLOCKED 질문과 답변 이력, 그리고 **데이터로 낼 수 없는 지표**(예: 회송
사유 분포 — `fixContext` 로 세션에 전달되지만 STATE 에 영속되지 않는다)가 무엇인지가
명시적으로 포함된다. `running`/`blocked`/`failed` 등 미완주 워크플로우도 리포트가 나온다 —
밤새 돌다 멈춘 것을 아침에 보는 게 주 용도이기 때문이다.

## 안전장치

- **프리플라이트 + 브랜치 격리 (§19)**: repo_root·git 저장소 여부·워킹트리 청결·(pr_mode 면)
  gh 인증을 시작 전에 확인하고, `branch_strategy` 로 base_branch 에 직접 커밋이 쌓이지 않게 한다
  (위 "브랜치 안전" 절 참조).
- 세션의 "done" 주장을 믿지 않는다 — 검증 명령은 하네스가 직접 실행해 exit code 판정 (타임아웃·프로세스 그룹 종료 포함)
- `canUseTool` 건별 권한: repo 밖 쓰기·`.git`/`.claude` 쓰기·STATE.json 쓰기·rm -rf·복합/백그라운드/리다이렉션 명령·(미허용 시) git push 차단. `settingSources:[]` 로 대상 리포 설정을 로드하지 않아 canUseTool 이 유일 권한 게이트
- 세션이 보고한 커밋 SHA 가 실제 git 에 존재하는지 기계적으로 검증 (커밋 없음/거짓 SHA 는 재시도로 회송 — 구 HANDOFF.md mtime 게이트를 대체)
- STATE.json 은 하네스 단일 작성자 — 세션은 읽기 전용
- verify 명령은 실패 시 non-zero exit 해야 함 (`true`/`echo`/`|| true`/`| tee` 는 게이트 무력화) —
  이 규칙 위반은 `fw run` 시작 자체를 거부한다(§18/§26 I5 잔여 승격, 아래 절 참조).
  `fw doctor <dir>` 로 전체 phase 의 검증 명령을 한 번에 미리 점검할 수 있다
- **verify 대상 파일 위조 차단 (§24 감사 S1)**: `package.json`/`gradlew`/`build.gradle`/`Makefile`/`scripts/*.sh`
  등 verify 명령이 실행하는 파일 자체는 repo 내부라 세션이 고칠 수 있다. 게이트를 돌리기 전, 그 파일들이
  이번 phase "런" 시작 이후 변경됐는지(`git diff` 기준) 확인해 변경됐으면 회송한다. 기준점은 attempt 마다
  다시 잡지 않고 phase 런 전체에 고정한다(`phase.verify_guard_baseline_sha`, `fw retry` 시에만 초기화) —
  그렇지 않으면 1차 시도에서 위조당해 회송된 뒤 되돌리지 않고 방치한 채 2차 시도에서 무관한 파일만
  커밋해도 통과해버리는 "attempt 간 위조 세탁"이 가능해진다. 빌드 설정 자체를 고치는 phase 는
  `phase.allow_verify_file_changes: true` 로 옵트아웃할 수 있다(사용 시각이 STATE 에 기록된다).
- **PR 코멘트 작성자 allowlist (§24 감사 T1)**: `trusted_comment_authors` 에 없는 작성자의 `@fw` 코멘트는
  fail-closed 로 무시된다. `pr_comment_mode`(기본 `"trusted"`)가 `"trusted"`인데 목록이 비어 있으면
  `fw run`/`fw doctor` 가 시작을 거부한다 — 코멘트 처리를 아예 원치 않으면 `"off"` 로 명시적
  옵트아웃한다 (위 PR 모드 절 참조, §29 MI-10).
- **확산 가능한 셸 문법은 거부 (§29 CR-1)**: `$'...'`(ANSI-C 인용)·`$VAR`·`` ` ``·`{a,b}`·`~` 처럼
  셸이 나중에 펼치는 문법은 판정 시점에 값을 알 수 없으므로, 인자 값을 파싱해 허용 판정하는
  명령군(`git push`/`branch`/`checkout`/`switch`/`stash`, 모든 `gh`)에서 **거부**한다. 실제로
  `gh api ... -f body=$'@~/.aws/credentials'` 로 자격증명을 PR 코멘트에 유출하는 것이 성립했다.
  파서를 정확히 흉내내는 경쟁은 두 번 졌기 때문에 **모르는 문법은 거부**로 계약을 바꿨다.
  readonly 명령(`grep -r "$PATTERN"` 등)은 값으로 판정하지 않으므로 면제된다.

## 샌드박스 — SDK 네이티브 실행 격리 (§37 T1, 옵트인)

**권한 검사와 샌드박스는 다른 것을 막는다.** 위 "안전장치" 절의 `canUseTool` 은 세션이 하네스에게
**요청**한 도구 호출(예: `Bash("npm run typecheck")`)을 검사해 allow/deny 를 판정한다. 그런데
`npm run <script>` 는 하네스가 본 문자열이 아니라 **`package.json` 안에 적힌 셸 문자열을 실제로
실행**한다 — §36 C-1 이 이걸로 `npm run typecheck --prefix /tmp/evil`(다른 `package.json` 을 읽어
임의 코드 실행)을 E2E 로 증명했다. `decideBash` 는 Bash **문자열**만 보는데 그 문자열이 실행을
위임하는 **파일 내용**은 볼 수 없다 — 검사 지점과 실행 지점이 다르면 권한 검사는 원리적으로
막지 못한다(`.GIT/hooks/pre-commit` 도 같은 축 — 허용된 쓰기 하나 뒤에 git 이 나중에 실행한다).

샌드박스는 **실행 자체**를 커널에서 막으므로(macOS Seatbelt/Linux bubblewrap/Windows 네이티브)
이 축을 통째로 덮는다. `@anthropic-ai/claude-agent-sdk` 가 `Options.sandbox` 로 이를 네이티브
지원한다 — 이 하네스는 STATE.json 의 `sandbox` 절로 그 설정을 노출한다.

```jsonc
// STATE.json
{
  "sandbox": {
    "enabled": true,            // 기본 false(옵트인) — 미설정 시 기존 비샌드박스 동작과 완전히 동일
    // "failIfUnavailable" 은 넣어도 무시된다 — 항상 true 로 강제된다(샌드박스가 없는데
    // 있다고 믿고 도는 것이 최악이므로, §30 P3 fail-closed).
    // 여기 적으면(빈 배열 포함) 정확히 이 목록만 쓰인다. 아예 생략하면(또는 allowedDomains 만
    // 빼면) origin 리모트 호스트가 자동으로 하나 채워진다 — 아래 "origin 호스트는 …" 절 참조.
    "network": { "allowedDomains": ["github.com", "api.github.com", "api.anthropic.com"] },
    "filesystem": {
      "denyRead": ["~/.ssh", "~/.aws"]
      // "allowRead": 빌드 캐시(~/.gradle, ~/.npm 등)가 필요하면 추가 — 미검증, 실전 주행으로 확인할 것
    },
    "credentials": {
      // deny 가 아니라 mask 를 우선한다(§37 S4) — deny 는 도구 자체를 깨뜨려 사용자가 샌드박스를
      // 통째로 끄게 만든다(그게 더 나쁘다). gh/npm/docker/netrc 가 대표 사례 — 아래 항목은
      // 설계 근거는 있으나 실제로 세션을 띄워 검증하지는 않았다(미검증).
      "files": [
        { "path": "~/.config/gh/hosts.yml", "mode": "mask", "injectHosts": ["github.com", "api.github.com"] },
        { "path": "~/.npmrc", "mode": "mask", "injectHosts": ["registry.npmjs.org"] }
      ]
    }
  }
}
```

- **기본은 비활성 — 옵트인.** `sandbox` 자체가 없거나 `enabled` 가 없으면 `Options.sandbox` 는
  아예 만들어지지 않는다(기존 동작 그대로). §30 P2("방어가 정상 경로를 막는다")가 이 하네스
  개발 세션 최대 결함원이었고, 샌드박스가 정상 작업(빌드 캐시 접근 등)을 막는지에 대한 실측
  데이터가 아직 없기 때문이다 — 다음 단계는 실전 주행으로 그 데이터를 만드는 것이다.
- **`failIfUnavailable` 은 항상 강제로 `true`.** STATE.json 에 `false` 를 적어도 무시된다 —
  샌드박스 의존성(예: Linux 의 `bubblewrap`)이 없는데 조용히 비샌드박스로 도는 것이 "샌드박스
  켰다"는 거짓 확신보다 낫다.
- **관측** — `fw status` 가 활성/비활성을 보여주고, `fw doctor` 의 `[샌드박스]` 절이 켜짐 여부와
  플랫폼 지원 힌트(darwin/linux/win32 만 SDK 문서가 언급 — 실제 동작 여부는 세션을 띄워야
  확인된다)를 보여준다. 꺼짐은 **문제(exit 1)로 만들지 않는다** — 옵트인이 기본값이므로 켜지
  않은 것 자체는 정상이다(§30 P2). 세션을 띄울 때마다 런로그에도 `샌드박스: 활성/비활성` 한
  줄이 남는다.
- **위 STATE.json 예시는 제안이지 검증된 프로파일이 아니다.** 실제로 세션을 sandbox 켠 채로
  돌려본 적이 없다(이번 라운드는 배선까지 — 유료 세션을 발생시키지 않기 위해서다) — 다음
  단계에서 실전 주행으로 무엇이 막히는지 확인한 뒤 넓혀야 한다.

### origin 호스트는 network.allowedDomains 에 자동으로 포함된다 (실측 근거 있음)

`sandbox.enabled: true` 만 켜고(network 설정 없이) 실제 세션 1개를 처음으로 돌려본 3차 무인
주행(sandbox-trial)이 **재현 가능한 네트워크 막힘 1건**을 남겼다: `git maintenance run
--task=prefetch` 가 이 리포의 `origin`(예: `ghe.example.com:443`)으로 나가는 아웃바운드
연결을 시도하다 `CONNECT tunnel failed, response 403` 으로 거부됐다(세션은 우회하지 않고
`docs/sandbox-trial/NOTES.md` "막힘 1"에 그대로 기록했다). 이 하네스는 **어차피 그 호스트로
push/PR 을 한다** — origin 은 세션이 정당하게 쓰는 통로이지 새로 여는 구멍이 아니다. 그래서
`fw run`/`fw doctor` 가 `git remote get-url origin` 으로 호스트를 구해(§26 M4
`parseRemoteHost` 재사용), 사용자가 `network.allowedDomains` 를 **명시하지 않은 경우에만**
그 호스트 하나를 자동으로 채워 넣는다.

- **사용자 설정이 있으면 절대 덧붙이지 않는다.** `network.allowedDomains` 를 적었다면(빈 배열
  포함) 그 목록을 정확히 존중한다 — 특히 `network.strictAllowlist: true` 와 함께 쓰이면
  "정확히 이 목록만" 이라는 의도적 선택이므로, 하네스가 항목을 몰래 추가하면 그 의도를 깨뜨린다
  (§30 P2). `network` 절 자체를 생략했거나 `allowedDomains` 필드만 빠졌으면(예:
  `strictAllowlist` 만 적은 경우) 자동 포함 대상이다.
- **긴장은 여전히 남아 있다(§29 CR-1).** 세션이 이 호스트로 정당한 push/PR 요청 대신 자격증명이
  섞인 요청을 보낼 수도 있다(`gh api ... -f body=@~/.aws/credentials` 류). 이 자동 포함은 그
  경로를 막지 않는다 — 그건 `canUseTool`/`credentials.files` 소관이다. 여기서 답하는 질문은
  오직 "이 호스트로의 네트워크 연결 자체를 허용할 것인가" 이고, 답은 "허용한다, 하네스가 이미
  그 호스트로 push/PR 을 하기 때문" 이다.
- **origin 이 없거나(로컬 전용 리포) `git remote get-url` 실패·호스트 파싱 불가면 예외 없이
  degrade** 한다 — 기존 동작 그대로 진행된다. sandbox 도 pr_mode 도 아니면 이 `git remote
  get-url` 호출 자체가 일어나지 않는다(관련 없는 사용자에게 새 프로세스 호출을 추가하지 않는다).
- **관측** — `fw doctor` 의 `[샌드박스]` 절이 실제로 적용된 `network.allowedDomains` 를 보여주고,
  자동으로 포함된 호스트에는 `(자동: git origin)` 표시를 붙여 사용자가 적은 항목과 구분한다.
  런로그의 `샌드박스: 활성 ...` 한 줄에도 같은 표시가 남는다.

## 멈출 수단 — 상한과 킬 스위치 (§27)

무인 주행의 전제는 "언제든 멈출 수 있다" 다. 이전에는 PR 폴링 루프에 시간 상한이 없어 리뷰어가
응답하지 않는 PR 을 며칠이고 폴링했고, 비용을 집계는 하면서 그걸 읽고 멈추는 곳이 없었다.

```bash
fw stop docs/my-feature
```

- **`STOP` 파일 방식**(시그널이 아니라 파일): `nohup` 으로 띄운 밤샘 실행은 PID 를 모르고, 파일은
  프로세스가 죽어도 의도가 남으며 워크플로우별로 개별 정지할 수 있다. `fw run` 이 시작 시
  **소비(삭제)** 하므로 따로 지울 필요가 없다. `.gitignore` 에 `docs/*/STOP` 로 등록됨.
- **체크포인트는 "새 걸음 떼기 직전"에만**: ①phase attempt 진입 전 ②fix 세션 실행 전 ③PR 폴링
  sleep 후. 돌고 있는 세션을 중간에 죽이면 커밋이 반쯤 된 상태가 남는다.
- **STATE 상한** — 둘 다 미설정(기본)이면 무제한:

| 필드 | 뜻 |
|---|---|
| `max_cost_usd` | 누적 세션 비용(USD) 상한 |
| `max_runtime_ms` | 이 `fw run` 의 벽시계 시간 상한 |

- **`halted` 는 `blocked` 와 다르다.** blocked 는 사람의 답변이 필요하고(`fw answer`), halted 는
  **그냥 이어서 `fw run` 하면 재개**된다. `fw status`/`fw log`/`fw doctor` 가 `⏸` 와 정지 사유를
  보여주고, 상한이 설정돼 있으면 `총 비용: $3.20 / $10.00` 처럼 대비로 표시한다.

## 알림과 권한 감사 (§27 O4/O1)

- **알림은 사라지지 않는다**: BLOCKED/완료/FAILED 는 **플랫폼 무관하게 stderr 배너**로 항상 찍히고,
  그 위에 macOS `osascript` / Linux `notify-send` 를 얹는다. 예전에는 macOS 가 아니면 조용히
  사라졌다(원격·CI 실행에서 치명적).
- **권한 감사 로그**: 세션의 도구 허가/거부가 실행 로그에 남는다 — 거부는 전문
  (`🔒 DENY Bash: ... — 사유`), 허용은 세션 종료 시 요약(`🔓 ALLOW 요약: Bash×34, Edit×12`).
  GitHub 토큰·`Authorization:`·API 키는 마스킹된다. §29 CR-1 에서 유출이 실제로 성립했는데
  **무엇이 실행됐는지 재구성할 수 없었던 것**이 이 기능의 직접적 계기다.

## PLAN 의 결정·용어를 세션에 주입 (§28)

하네스가 `PLAN.md` 의 **§핵심 결정 사항**·**§용어** 절을 파싱해 무인 세션 프롬프트에 그대로 박아
넣고, 작업 시작 전 그것과 충돌하는지 점검하라고 지시한다.

"PLAN.md 를 읽어라" 는 **요청**이고 세션이 건너뛰거나 읽고 잊을 수 있으며, 안 읽어도 아무 신호가
없다(감지되지 않는 실패). 주입은 **집행**이다 — 하네스가 verify 를 직접 돌려 exit code 로 판정하는
것과 같은 이동이다. 덧붙여 하네스가 무엇을 줄지 고를 수 있어, 템플릿의 작성자용 지침(인용 블록)은
제거하고 작업자에게 필요한 것만 전달한다.

**그래서 §핵심 결정과 §용어는 산문이 아니라 표로 써야 한다** — 파싱 대상이다. 절이 없는 기존
산문 PLAN 은 그대로 동작한다(주입만 생략).

## 개발

    npm test          # vitest (전체)
    npm run typecheck # tsc (src + test)
    npm run build     # dist/ 생성

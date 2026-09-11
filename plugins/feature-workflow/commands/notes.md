---
name: notes
description: 현재 진행 상태를 NOTES.md 에 갱신하고 STATE.json 의 phase status/next_steps 를 채운 뒤 commit. phase 종료 시점에 호출
aliases: [fw-notes]
---

# /feature-workflow:notes

현재까지 작업한 결과를 NOTES.md 와 STATE.json 에 반영한다. phase 종료 직후, 또는 세션을 종료하기 전에 호출.
(구 HANDOFF.md 문서 체계는 폐기되었고, 레거시 워크플로우는 2026-08-27 에 전부 3종 체계로 이관 완료됐다.)

## 사용법

```
/feature-workflow:notes
/fw-notes
```

## 동작

1. `git log --oneline` 으로 최근 commit 확인
2. 진행 중인 워크플로우 디렉토리 탐지 (`docs/<workflow>/`)
3. 사용자에게 짧게 묻기:
   - 어떤 phase 가 끝났나? (자동 추정 가능하면 추정값 제시)
   - 다음 phase 의 상세 작업 단계는 무엇인가?
   - 발견된 트러블슈팅 / 결정 사항?
4. `NOTES.md` 갱신:
   - 모듈 이관 맵에 새 행 추가 (해당하면)
   - 알려진 리스크 / 트러블슈팅 메모 / 결정 배경 추가
   - **phase 상태 표는 적지 않는다** — 그건 STATE.json 소관, 현황은 `fw status` 로 본다
5. `STATE.json` 갱신:
   - 방금 끝난 phase 의 `status` 를 `"done"` 으로
   - 다음 phase 의 `next_steps`(상세 작업 단계 목록)를 채운다 — 다음 세션이 컨텍스트
     0 으로 이어받을 유일한 자리이므로 비워두지 않는다
   - JSON 유효성 주의 (스키마 strict — 오타 키는 로드 거부)
   - **phase 를 새로 추가했으면 PLAN.md 의 phase 표에도 같은 행을 추가한다** — PLAN 표와
     STATE `phases` 는 항상 같은 목록이어야 한다 (한쪽만 늘리면 PLAN 이 초기 계획에 멈춘다)
6. `git add docs/<workflow>/ && git commit -m "docs(<workflow>): notes + state update after phase-N"`
7. 사용자에게 push 의사 묻기

## 갱신 가이드

- **STATE.json 의 `next_steps`**: 다음 세션이 컨텍스트 0 으로 이어받을 수 있게 구체적으로. "이관 대상 파일 목록 / 패키지 매핑 / 검증 명령" 모두 명시.
- **NOTES.md 트러블슈팅 메모**: 다음 phase 에서 같은 함정을 피하게 하는 게 목적. 짧게 문제+해결.

## 안티 패턴

- "잘 됐어요" 같은 모호한 메모
- 검증 결과 안 적기
- 다음 phase `next_steps` 를 "Phase 6.x 진행" 한 줄로만 적기 (구체적이지 않음)
- STATE.json phase status 갱신 빼먹기 (유인/무인 전환 시 이미 끝낸 phase 를 다시 실행하게 된다)

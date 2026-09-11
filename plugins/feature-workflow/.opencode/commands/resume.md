---
name: resume
description: 기존 워크플로우의 다음 phase 를 이어받아 실행. PLAN + STATE(next_steps) 를 읽고 진행
aliases: [fw-resume, workflow-resume]
---

# /feature-workflow:resume

진행 중인 워크플로우의 다음 phase 를 시작한다. 새 세션이 시작되었거나 다른 AI 가 이어받을 때 사용.

## 사용법

```
/feature-workflow:resume                    # 자동 탐지
/feature-workflow:resume <작업 이름>          # 명시적 지정
/fw-resume migration
```

## 동작

1. `docs/` 아래에서 워크플로우 디렉토리를 탐색
   - 여러 개면 사용자에게 어떤 것인지 물음
2. `cat docs/<workflow>/PLAN.md docs/<workflow>/NOTES.md` 로 컨텍스트 흡수
   (phase 현황·다음 작업 단계는 `fw status docs/<workflow>` 또는 STATE.json 의 해당
   phase `next_steps` — STATE.json 이 진실 소스)
3. PLAN.md 의 관련 결정 + STATE.json 의 해당 phase `next_steps` 를 사용자에게 짧게 요약 출력
   (`next_steps` 가 비어 있으면 PLAN.md 의 해당 phase 항목을 요약)
4. 사용자 확인 받음 → `next_steps`(또는 PLAN 의 해당 항목)를 그대로 실행
5. phase 완료 후:
   - 변경 규모가 중형 이상이면 `/feature-workflow:review` 로 고수 검토 (렌즈 분리 병렬
     검토관 — 확정 결함만 교정 후 진행. 소형이면 생략 가능)
   - 검증 명령 실행
   - 의미 단위로 commit 분리
   - **STATE.json 의 이 phase status 를 "done" 으로, 다음 phase 의 `next_steps` 를 상세 작업 단계로 갱신** (유인 모드는 세션이 직접 — 빼먹으면 `fw run` 이 재실행하거나 다음 세션이 단계 없이 시작)
   - NOTES.md 갱신
   - `/feature-workflow:notes` 로 NOTES + STATE 현황 갱신 commit
6. 사용자에게 다음 phase 진행 의사 묻기

## 갱신 항목 (필수)

- `STATE.json`: 이 phase `status` → `"done"`, 다음 phase 의 `next_steps`(상세 작업 단계) 채우기
- `NOTES.md`: 방금 완료한 phase 의 이관 메모 / 리스크 / 트러블슈팅 추가

## 안티 패턴

- PLAN.md + STATE(next_steps) 안 읽고 추측으로 진행
- 검증 안 하고 commit
- STATE/NOTES 갱신 빼먹기
- **STATE.json phase status 갱신 빼먹기** (유인/무인 전환 시 이미 끝낸 phase 를 다시 실행하게 된다)
- phase 여러 개를 한 번에 진행 (사용자 동의 없이)

---
name: notes
description: 확인한 사실·출처·검증·검수를 NOTES에 기록하고 단계 상태와 next_steps 갱신
aliases: [fw-notes]
---

# /feature-workflow:notes

## 공통 근거 규칙

먼저 [feature-workflow 스킬](../skills/feature-workflow/SKILL.md)을 읽고 적용한다.
사실은 원천·출처로 확인하고, NOTES의 사실·검증·미확정·검수 절에 기록한다.
PLAN/NOTES/STATE는 현재 원천을 대신하지 않는다. 기록된 상태와 현재 상태를 대조한다.
하네스 실행 중 STATE는 읽기 전용이다. 이미 받은 승인과 권한은 반복해서 묻지 않는다.

## 동작

1. 현재 PLAN·NOTES·STATE와 Git 상태·관련 실행 결과를 읽는다. 확인 가능한 것을 사용자에게 되묻지 않는다.
2. NOTES의 확인한 사실 표에 사실 ID·조건·원문 식별자·출처·확인 방법을 기록한다.
   추론과 판정은 사실 표 밖에서 해당 ID를 연결하고, 출처 없는 주장은 미확정으로 남긴다.
3. 검증 절에는 실제 실행 명령·출력 요지·종료 코드·범위를, 검수 절에는 방식·판정·지적·해소 여부를 남긴다.
   실행 계획을 실행 결과로 쓰지 않는다. 비밀값과 민감한 원문 로그는 기록하지 않는다.
4. 충돌·미확정·이관 맵·리스크·트러블슈팅을 갱신한다. 사용자 결정은 PLAN의 핵심 결정 표에 즉시 기록한다.
5. 검증과 대조가 끝난 범위만 완료 처리한다. 유인 실행에서는 STATE를 갱신하고 다음 작업을 구체화한다.
   무인 실행에서는 STATE는 하네스가 쓴다. PLAN과 STATE phase 목록은 일치시킨다.
6. 별도 ledger/output/review/DECISIONS 파일이나 NOTES 내 phase 상태 표를 만들지 않는다.
7. 커밋 권한이 있으면 변경을 대조한 뒤 의미 단위로 커밋한다. push·PR 권한을 이 명령 호출로 확대하지 않는다.

템플릿: [NOTES](../templates/NOTES.md).

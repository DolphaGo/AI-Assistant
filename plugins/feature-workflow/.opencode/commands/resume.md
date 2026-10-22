---
name: resume
description: 기록과 현재 원천을 대조하고 다음 phase를 이어받아 실행
aliases: [fw-resume, workflow-resume]
---

# /feature-workflow:resume

## 공통 근거 규칙

먼저 [feature-workflow 스킬](../skills/feature-workflow/SKILL.md)을 읽고 적용한다.
사실은 원천·출처로 확인하고, NOTES의 사실·검증·미확정·검수 절에 기록한다.
PLAN/NOTES/STATE는 현재 원천을 대신하지 않는다. 기록된 상태와 현재 상태를 대조한다.
하네스 실행 중 STATE는 읽기 전용이다. 이미 받은 승인과 권한은 반복해서 묻지 않는다.

## 사용법

`/feature-workflow:resume <작업 이름>` 또는 `/fw-resume <작업 이름>`.

## 동작

1. 사용자 맥락에서 워크플로우를 선택하고 PLAN·NOTES·STATE의 next_steps를 읽는다.
   후보가 여러 개이고 선택 근거가 없을 때만 묻는다.
2. Git 작업이면 저장소·브랜치·git status·현재 커밋을 확인하고 관련 소스·설정·실행 결과와 기록을 대조한다.
   과거 done이나 검증 기록을 현재 동작의 확정 근거로 삼지 않는다.
3. 현재 목표와 충돌하는 낡은 next_steps는 원인과 출처를 NOTES에 기록한다.
   사용자 결정 변경이 필요하면 확인하고, 독립적인 승인 범위 작업은 계속한다.
4. 승인된 다음 단계를 실행한다. 새 사실은 먼저 원천과 함께 NOTES에 기록한다.
5. 변경에 맞는 검증을 실행하고 실제 명령·결과·범위를 NOTES에 적는다.
   기능 검증과 사실 대조를 구분하고, 검수 지적을 교정한 뒤 완료 여부를 판단한다.
6. 유인 실행에서는 STATE의 phase 상태·next_steps를 갱신한다. phase 목록 변경은 PLAN에도 반영한다.
   무인 실행에서는 결과를 NOTES와 하네스 출력으로 전달하고 STATE를 수정하지 않는다.
7. 커밋·push·PR은 사용자 승인 범위를 따른다. phase마다 기계적으로 재승인을 요구하지 않는다.

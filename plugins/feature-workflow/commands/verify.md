---
name: verify
description: NOTES의 근거·검증과 실제 산출물을 대조하고 검수 결과를 NOTES에 기록
aliases: [fw-verify]
---

# /feature-workflow:verify

## 공통 근거 규칙

먼저 [feature-workflow 스킬](../skills/feature-workflow/SKILL.md)을 읽고 적용한다.
사실은 원천·출처로 확인하고, NOTES의 사실·검증·미확정·검수 절에 기록한다.
PLAN/NOTES/STATE는 현재 원천을 대신하지 않는다. 기록된 상태와 현재 상태를 대조한다.
하네스 실행 중 STATE는 읽기 전용이다. 이미 받은 승인과 권한은 반복해서 묻지 않는다.

## 동작

1. 구현 기준이 된 확정 PLAN의 식별자·완료 기준·결정, NOTES의 사실/검증 ID, 실제 산출물의 절대 경로를 검수 입력으로 모은다.
   확정 후 PLAN이 바뀌었는지 확인하고, 결과에 맞춘 기준 완화를 지적한다. verify 동안 PLAN을 수정하지 않는다.
2. 스킬의 [검수 지시서](../skills/feature-workflow/references/reviewer-instructions.md)와
   [공통 기준](../skills/feature-workflow/references/failure-modes-common.md)에 따라
   새 컨텍스트 검수자 1명에게 원천과 대조하도록 맡긴다. 한 번에 1명만 실행한다.
3. 사실마다 근거 대응·출처·조건·범위·원문·미확정·충돌을 점검한다.
   기능 검증은 별도 테스트·실행 결과로 확인한다. 이관 작업은 PLAN/NOTES의 이관 맵에 따라
   원본과 목적지 존재 여부 및 diff도 대조한다. PROGRESS 파일은 요구하지 않는다.
4. 검수자는 파일을 고치거나 새 사실을 만들지 않는다. 작성자가 지적된 원천만 추가 확인하고 교정한다.
5. PASS / REWRITE / RECOLLECT와 지적·해소 여부를 NOTES에 기록한다.
   표준 2라운드, 외부 공유·의사결정 근거 3라운드 상한. 같은 주장+같은 기준으로 두 번 실패하면 확정을 중단한다.
6. 독립 검수 불가 시 작성 흐름을 멈추고 원천과 자체 대조한다. `독립 검수 아님 (자체 대조)`라고 표시한다.
7. 남은 오류·미검증 범위를 밝히고 필요한 후속 작업을 STATE에 남긴다(무인 실행이면 하네스에 전달).
   PLAN 변경이 필요하면 먼저 NOTES에 verify 결과와 작성 주체가 명시된 피드백·변경 제안·수용/보류 판단을 남긴다.
   그 뒤 스킬 §3.1에 따라 개정 이력을 기록하고 재확정한다. 개정 기준의 구현·verify를 다시 수행한다.

별도 검수 보고서 파일을 만들지 않는다. `fw verify`의 하네스 검수도 NOTES에 누적된다.

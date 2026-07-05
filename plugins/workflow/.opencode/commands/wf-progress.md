---
name: wf-progress
description: cycle progress, command result, verification evidence, blocker, next step을 기록한다.
aliases: [wfprogress]
---

# WF Progress

strict workflow cycle 중간과 이후에 사용한다.

## Steps

1. `.agent/`가 있고 git tracked이며 `HANDOFF.md`, `PROGRESS.md`, `DOCS.md`를 포함하는지 확인한다. 가능하면 `templates/agent/`에서 초기화한다.
2. `.agent/PROGRESS.md`에 dated cycle entry를 append한다.
3. 아래를 기록한다.
   - current plan step
   - 변경한 file 또는 area
   - 실행한 command와 result
   - behavior change의 red/green evidence, 또는 docs/manifests/packaging 작업의 structural check evidence
   - skip한 test 또는 check와 이유
   - blocker 또는 plan drift
   - next step
4. work가 plan과 달라졌으면 멈추고 revised direction을 사용자에게 확인한다.
5. 사용자가 방향을 교정하면 추가 수정 전에 멈춘다. 현재 변경, 되돌릴 범위, 다음 선택지를 짧게 설명하고 확인받는다.
6. bug, test failure, unexpected behavior가 나오면 `systematic-debugging`으로 전환한다.
   - consistent reproduction
   - error와 recent change 확인
   - component boundary evidence 수집
   - 하나의 hypothesis 제시
   - 가장 작은 change로 test
   - symptom이 아니라 root cause fix

긴 narrative log보다 짧고 evidence-rich한 entry를 선호한다.

---
name: wf-resume
description: 작업을 이어가기 전에 .agent state에서 context를 복원한다.
aliases: [wfresume]
---

# WF Resume

resumed task 시작 시점이나 agent switch 이후 사용한다.

## Steps

1. 있으면 `.agent/HANDOFF.md`를 먼저 읽는다.
2. `.agent/PROGRESS.md`에서 최근 cycle evidence를 읽는다.
3. `.agent/DOCS.md`에서 confirmed decision과 vocabulary를 읽는다.
4. handoff를 current git status와 관련 file에 대조한다.
5. 아래를 말한다.
   - confirmed state
   - stale일 수 있는 state
   - verification이 필요한 state
   - next recommended action
6. state file이 없으면 가능할 때 `templates/agent/`에서 `.agent/`를 초기화한다. repo가 다르게 말하지 않는 한 `.agent/`는 tracked 상태로 유지하고 `/wf-plan`으로 이어간다.
7. resumed context는 작업 크기에 맞게 유지한다. 작은 verification과 next step이면 충분한데 큰 plan을 다시 만들지 않는다.

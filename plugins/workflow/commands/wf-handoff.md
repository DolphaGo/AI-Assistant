---
name: wf-handoff
description: 다른 에이전트가 재탐색 없이 이어갈 수 있도록 현재 상태를 .agent/HANDOFF.md에 압축한다.
aliases: [wfhandoff]
---

# WF Handoff

작업을 멈추거나 agent를 바꾸거나 handoff가 필요할 때 사용한다.

## Steps

1. `.agent/PROGRESS.md`, `.agent/DOCS.md`, git status, latest relevant diff를 읽는다.
2. `.agent/HANDOFF.md`를 compact current-state document로 다시 작성한다.
3. 아래를 포함한다.
   - objective
   - current status
   - latest plan
   - completed work
   - fresh verification evidence와 exact command
   - 실행하지 않은 check와 이유
   - review finding과 unresolved quality risk
   - artifact reference: plan, ADR, commit, diff, PR, docs의 path 또는 URL. 내용을 복사하지 않는다.
   - open blocker 또는 question
   - next recommended step
   - 가장 중요할 가능성이 높은 file
4. stale history, duplicated artifact content, unresolved speculation은 다음 step에 영향을 주지 않는 한 제외한다.
5. API key, password, token, cookie, private chat content, 불필요한 PII를 포함한 secret과 private data를 제거한다.

다음 에이전트는 `HANDOFF.md`를 먼저 읽고 바로 이어갈 수 있어야 한다.

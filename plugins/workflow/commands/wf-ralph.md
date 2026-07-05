---
name: wf-ralph
description: objective가 끝나거나 사용자 확인이 필요할 때까지 strict workflow cycle을 계속 진행한다.
aliases: [wfralph]
---

# WF Ralph

사용자가 objective 완료까지 계속 진행하기를 원할 때 사용한다.

## Loop

반복한다.

1. `.agent/` state가 있으면 `/wf-resume`.
2. ambiguity, domain term, decision dependency, completion criteria가 해소될 때까지 `/wf-plan`.
3. 가장 작은 scoped change를 개발한다. code behavior change에는 `test-driven-development`, docs/manifests/packaging에는 structural check를 사용한다.
4. test하고 `/wf-progress`로 evidence를 기록한다.
5. bug나 unexpected failure가 나오면 plan 또는 implementation을 바꾸기 전에 `systematic-debugging`을 사용한다.
6. `/wf-review`를 실행한다. `verification-before-completion`과 조건부 `requesting-code-review`를 포함한다.
7. feedback을 반영하거나 plan을 업데이트한다.
8. term, decision, reusable workflow fact가 crystallize되면 `/wf-docs`를 실행한다.
9. objective가 complete되거나 escalation이 필요할 때만 멈춘다.

## Stop And Ask

아래 상황에서는 멈추고 사용자에게 묻는다.

- requirement, wording, success criteria가 애매하다.
- domain language가 overloaded이거나 `CONTEXT.md`와 충돌한다.
- implementation이 plan과 달라졌다.
- 사용자가 범위, 톤, 방향, 강도를 교정했다.
- blocker가 반복된다.
- risky 또는 destructive action이 필요하다.
- verification failure가 plan 변경을 요구한다.
- quality review가 design 또는 scope issue를 찾았다.
- fresh verification이 completion claim을 뒷받침하지 못한다.

stop 또는 completion 시 `.agent/HANDOFF.md`를 업데이트한다.

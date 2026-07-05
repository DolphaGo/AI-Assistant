---
name: wf-plan
description: 애매함을 해소하고 scope, success criteria, risk, 다음 workflow plan을 정리한다.
aliases: [wfplan]
---

# WF Plan

구현 전 또는 현재 plan이 더 이상 맞지 않을 때 사용한다.

## Steps

1. `.agent/`가 있고 git에서 ignore되지 않으며 `HANDOFF.md`, `PROGRESS.md`, `DOCS.md`를 포함하는지 확인한다. 가능하면 `templates/agent/`에서 초기화한다.
2. 있으면 `.agent/HANDOFF.md`, `.agent/PROGRESS.md`, `.agent/DOCS.md`를 읽는다.
3. 있으면 `CONTEXT.md`, `CONTEXT-MAP.md`, 관련 `docs/adr/` 파일을 읽는다.
4. requirement, wording, domain term, success criteria, constraint, risk의 ambiguity를 찾는다.
5. code나 docs를 inspect해서 답할 수 있는 질문이면 먼저 확인하고 묻는다.
6. 구현에 영향을 주는 ambiguity는 한 번에 하나씩 묻는다. 유용할 때는 추천 답안을 함께 제시한다.
7. 사용자가 shared understanding을 확인하기 전에는 plan을 실행하지 않는다.
8. 계획은 작업 크기에 맞춰 유지한다.
   - 작고 위험도가 낮은 작업은 compact objective, scope, verification, next step이면 충분하다.
   - 긴 작업, 위험한 작업, 공유 작업, ralph-mode 작업은 혼란을 줄일 때 Objective ID, Plan Version, 완료 기준(Definition of Done), 상세 stop condition을 추가한다.
9. `writing-plans` discipline에 맞춰 `.agent/PROGRESS.md`를 작성하거나 업데이트한다.
   - objective
   - Spec Snapshot: 사용자에게 보이거나 workflow상 반드시 참이어야 하는 behavior
   - scope와 non-goal
   - assumption
   - success criteria
   - 변경 예상 file 또는 area
   - Task Breakdown: verification이 붙은 bite-sized implementation step
   - planned verification
   - expected verification result
   - risk note
   - stop condition
   - next development step
10. code behavior change는 `test-driven-development` red/green path를 계획한다. docs, manifest, packaging-only 작업은 edit 전 실패하고 edit 후 통과하는 structural check를 계획한다.
11. term이 해결되면 `.agent/DOCS.md`에 기록한다. `CONTEXT.md`로 승격하기 전에는 묻는다.
12. 되돌리기 어려운 trade-off가 해결되면 ADR을 제안하고, `docs/adr/` 생성 또는 수정 전에는 묻는다.
13. planning 이후 user requirement가 바뀌면 Spec Delta를 append한다. 무엇이 왜 바뀌었고 어떤 task나 success criteria가 영향을 받는지 기록한다.

사용자가 plan 승인 후 계속 진행하라고 명시하지 않았다면 `/wf-plan` 중에는 구현하지 않는다.

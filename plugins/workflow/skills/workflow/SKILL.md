---
name: workflow
description: Use when a task needs repo-local agent continuity, handoff/progress/docs state, ambiguity gating, strict plan-develop-test-review-feedback loops, plan drift escalation, or ralph-style autonomous continuation until the objective is complete.
---

# Workflow

에이전트가 바뀌거나 작업이 길어져도 같은 맥락으로 이어서 일해야 할 때 이 프로토콜을 적용한다.

## 비례적 엄격함

workflow의 엄격함은 작업 크기와 위험도에 맞춘다. 이 workflow는 판단을 보호하기 위한 장치이지, 체크리스트를 채우기 위한 의식이 아니다.

필수 가드레일:

- 구현에 영향을 주는 애매함이 있으면 사용자에게 묻는다.
- 승인된 계획과 실제 진행이 달라지면 멈추고 상황, 선택지, 추천 방향을 설명한다.
- 완료를 주장하기 전에 fresh verification을 실행하고 결과를 읽는다.
- 다른 에이전트가 이어받을 가능성이 있으면 간결한 handoff를 남긴다.
- tracked 파일에는 secret과 private data를 남기지 않는다.

선택 구조:

- Objective ID, Plan Version, 완료 기준(Definition of Done), 상세 위험도(Risk Profile), ADR 후보, 독립 리뷰는 긴 작업, 위험한 작업, 공유 작업, ralph-mode 작업에서 혼란을 줄일 때 사용한다.
- 작고 위험도가 낮은 작업에서는 계획, progress entry, handoff를 짧게 유지한다. 다음 에이전트가 실제로 필요한 상태만 기록한다.

## 상태 파일

repo-local `.agent/` 파일을 사용한다.

- `.agent/HANDOFF.md`: 다음 에이전트가 바로 이어받기 위한 현재 상태.
- `.agent/PROGRESS.md`: 계획, 개발, 테스트, 리뷰, 피드백, blocker, 계획 변경의 cycle log.
- `.agent/DOCS.md`: 확정된 결정, glossary term, 재사용 가능한 workflow 지식.

handoff와 progress가 branch 전환, agent 전환, fresh checkout 이후에도 남도록 `.agent/`는 기본적으로 git tracked 상태로 둔다. 파일이 없고 `templates/agent/`가 있으면 그 템플릿으로 초기화한다.

`.agent/` 밖에 남길 수 있는 durable project knowledge:

- `CONTEXT.md`: project glossary와 domain language. 사용자가 project-doc 수정을 명시하지 않았다면 생성 또는 수정 전에 묻는다.
- `CONTEXT-MAP.md`: repo가 여러 domain context를 쓰는 경우의 context map.
- `docs/adr/NNNN-slug.md`: 되돌리기 어렵고, 맥락 없이는 놀랍고, 실제 trade-off가 있었던 architecture decision. 사용자가 project-doc 수정을 명시하지 않았다면 생성 또는 수정 전에 묻는다.

term이나 decision이 충분히 확정되었을 때만 durable docs를 lazily 생성한다.

## 양보할 수 없는 규칙

- requirement, phrase, success criterion, plan step이 애매하고 구현에 영향을 주면 구현 전에 사용자에게 묻는다.
- 실제 진행이 승인된 계획과 달라지면 계속 진행하지 말고 상황, 선택지, 추천 방향을 설명한다.
- 사용자가 범위, 톤, 방향, 강도를 교정하면 즉시 멈춘다. 현재까지 바뀐 내용, 되돌릴 범위, 다음 선택지를 설명하고 확인받기 전에는 추가 수정하지 않는다.
- scope를 조용히 넓히지 않는다. 필요하면 explicit non-goal을 계획에 기록한다.
- 느낌이 아니라 evidence를 기록한다: 실행한 command, test result, review finding, skipped check, skip reason.
- `HANDOFF.md`는 compact하고 최신 상태로 유지한다. 자세한 history는 `PROGRESS.md`에 둔다.
- spec, plan, ADR, commit, diff, PR, docs에 이미 있는 내용을 중복 복사하지 않는다. 대신 path나 URL을 참조한다.
- tracked `.agent/` 파일에서 API key, password, token, cookie, private chat content, 불필요한 PII를 포함한 secret과 private data를 제거한다.

## Grilling 규칙

계획을 세우거나 구현을 바꾸기 전에 shared understanding이 생길 때까지 애매함을 질문으로 해소한다.

- 한 번에 하나의 질문만 하고 사용자의 답을 기다린다.
- 유용할 때는 추천 답안을 함께 제시한다.
- 결정 간 dependency를 순서대로 따라간다. unresolved branch를 건너뛰지 않는다.
- codebase나 기존 docs를 읽어서 답할 수 있는 질문은 먼저 inspect하고 묻는다.
- 사용자가 shared understanding을 확인하기 전에는 계획을 실행하지 않는다.

## Domain Docs 규칙

결정이 명확해질수록 project language를 정리한다.

- 사용자가 모호하거나 여러 뜻으로 쓰는 term을 사용하면 precise canonical term을 제안한다.
- term이 `CONTEXT.md`와 충돌하면 충돌을 설명하고 어떤 의미가 맞는지 묻는다.
- domain relationship을 concrete scenario와 edge case로 stress-test한다.
- 가능하면 behavior claim을 code와 대조한다.
- term이 해결되면 먼저 `.agent/DOCS.md`에 기록하고, `CONTEXT.md`로 승격하기 전에는 묻는다. `CONTEXT.md`는 glossary만 담는다: implementation detail, spec, scratch note는 넣지 않는다.
- ADR은 decision이 되돌리기 어렵고, 맥락 없이는 놀랍고, 실제 trade-off가 있었을 때만 제안한다. `docs/adr/` 생성 또는 수정 전에는 묻는다.

## Superpowers 규칙

사용자-facing command를 늘리지 않고 아래 discipline을 workflow 안에 접는다.

- `writing-plans`: fresh agent가 실행할 수 있는 계획을 작성한다. exact file, bite-sized step, verification command, expected result, stop condition을 포함한다.
- `test-driven-development`: code behavior가 바뀌면 구현 전 failing test를 작성하거나 식별한다. docs, manifest, packaging-only 작업은 편집 전 실패하고 편집 후 통과하는 structural check를 세운다.
- `systematic-debugging`: bug, failing test, unexpected behavior가 나오면 추측하지 않는다. 재현, 최근 변경 확인, boundary evidence 수집, 하나의 hypothesis, 최소 테스트, root cause fix 순서로 진행한다.
- `verification-before-completion`: 완료를 주장하기 전에 fresh verification을 실행하고 output을 읽고 evidence를 기록한다.
- `requesting-code-review`: substantial work, risky change, shared behavior change, ralph-mode cycle에서는 가능하고 비례적일 때 independent review pass나 subagent를 사용한다.

## Spec-Driven Planning

가벼운 Spec Kit 스타일 분리를 사용한다.

- Spec Snapshot: 사용자에게 보이거나 workflow상 반드시 참이어야 하는 behavior.
- Technical Plan: spec을 만족하기 위해 repo가 어떻게 바뀌는지.
- Task Breakdown: task를 작게 나누고 각 task마다 verification을 둔다.
- Spec Delta: requirement가 바뀌면 history를 조용히 덮어쓰지 말고 무엇이 왜 바뀌었는지 기록한다.

success criteria, non-goal, task boundary가 애매한 상태에서는 spec에서 implementation으로 넘어가지 않는다.

## Risk And Security Gate

review 중 Risk Profile을 부여한다. 아래를 건드리면 security-relevant change로 표시한다.

- authentication, authorization, permission, user identity
- payment, billing, financial data, data deletion
- secret, credential, token, cookie, environment variable, log
- external input, parsing, upload/download, network call, shell execution
- dependency, package installation, CI, deployment, generated artifact
- database migration, data model change, cross-tenant boundary

security-relevant change에는 사용 가능한 local check를 실행한다: test, linter, Semgrep, CodeQL, dependency audit, targeted grep 등. 실행할 수 없거나 skip하면 이유를 기록한다.

## Strict Loop

작업은 cycle로 진행한다.

1. Plan: ambiguity를 해소하고 Spec Snapshot, scope, success criteria, task breakdown, verification, risk, stop condition을 정한다.
2. Develop: 가장 작은 scoped change를 만든다. behavior change에는 TDD를 사용한다.
3. Test: planned verification을 실행하고 결과를 기록한다.
4. Debug: verification이 예상 밖으로 실패하면 code를 바꾸기 전에 systematic debugging을 적용한다.
5. Review: plan 대비 quality를 평가한다. 가능하고 가치가 있으면 independent review pass나 subagent를 사용한다.
6. Feedback: finding, blocker, user decision을 기록한다.
7. Completion gate: 완료를 주장하기 전에 fresh verification을 실행한다.
8. Plan update: plan을 수정하거나 objective complete로 표시한다.

## Ralph Mode

Ralph mode는 objective가 완료될 때까지 strict loop를 반복한다. 아래 상황에서는 사용자 확인을 위해 멈춘다.

- completion criteria가 불명확하다.
- requirement나 phrase가 애매하다.
- implementation이 plan과 달라졌다.
- 사용자가 범위, 톤, 방향, 강도를 교정했다.
- 같은 blocker가 반복된다.
- risky 또는 destructive action이 필요하다.
- review나 verification 결과 plan 변경이 필요하다.
- fresh verification을 실행할 수 없거나 completion claim을 뒷받침하지 못한다.

## Command Mapping

- `/wf-resume`: `.agent/` state를 읽고 context를 복원한다.
- `/wf-plan`: ambiguity를 해소하고 다음 plan을 작성한다.
- `/wf-progress`: progress와 cycle evidence를 업데이트한다.
- `/wf-review`: quality evaluation을 실행하고 기록한다.
- `/wf-docs`: confirmed knowledge를 docs로 승격한다.
- `/wf-handoff`: 다음 에이전트를 위해 현재 상태를 압축한다.
- `/wf-ralph`: 완료 또는 escalation이 필요할 때까지 strict loop cycle을 실행한다.

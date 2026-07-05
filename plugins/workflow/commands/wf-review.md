---
name: wf-review
description: plan 대비 구현 품질을 test, diff review, 필요시 independent review pass로 평가한다.
aliases: [wfreview]
---

# WF Review

development와 verification 이후 사용한다.

## Steps

1. `.agent/PROGRESS.md`와 current diff를 읽는다.
2. implementation을 latest plan과 success criteria에 대조한다.
3. planned verification을 실행하거나 결과를 요약한다.
4. 리뷰를 의식처럼 키우지 않는다. low-risk work는 concise requirements check와 fresh verification이면 충분하다.
5. 아래 항목을 확인한다.
   - unmet requirement
   - scope creep
   - missing test 또는 weak evidence
   - risky change
   - unclear user-facing behavior
   - docs 또는 handoff update 필요 여부
6. Risk Profile을 부여한다.
   - Low: docs, copy, isolated metadata처럼 execution impact가 없는 변경.
   - Medium: behavior, workflow, CI, dependency, shared code 변경.
   - High: auth, permission, payment, secret, external input, shell execution, migration, data deletion, deployment, cross-tenant boundary 변경.
7. Medium 또는 High risk에는 targeted verification을 실행한다. High risk에는 test, linter, Semgrep, CodeQL, dependency audit, targeted grep 등 가능한 local check로 security gate를 추가한다. 불가능하면 이유를 기록한다.
8. `verification-before-completion`을 적용한다. fresh verification output 없이는 completion claim을 하지 않는다.
9. substantial work, risky change, shared behavior change, ralph-mode cycle에는 `requesting-code-review` discipline을 사용한다. 가능하고 비례적일 때 independent review pass나 subagent를 선호한다.
10. finding을 `.agent/PROGRESS.md`에 기록한다.

finding 때문에 plan을 바꿔야 하면 계속 진행하기 전에 멈추고 사용자에게 묻는다.

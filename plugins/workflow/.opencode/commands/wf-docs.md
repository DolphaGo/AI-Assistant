---
name: wf-docs
description: 확정된 decision, term, reusable workflow knowledge를 .agent/DOCS.md에 정리한다.
aliases: [wfdocs]
---

# WF Docs

decision, term, reusable knowledge가 안정화되었을 때 사용한다.

## Steps

1. `.agent/PROGRESS.md`, 기존 `.agent/DOCS.md`, `CONTEXT.md`, `CONTEXT-MAP.md`, 관련 `docs/adr/` 파일이 있으면 읽는다.
2. confirmed knowledge만 추출한다.
   - decision과 rationale
   - project-specific vocabulary와 canonical term
   - recurring command
   - constraint와 non-goal
   - known risk와 mitigation
3. transient log, speculation, unresolved question은 복사하지 않는다.
4. local workflow를 위해 `.agent/DOCS.md`에 concise entry를 작성한다. crystallized term은 promotion 전에 먼저 여기에 기록한다.
5. 사용자가 project-doc update를 명시하지 않았다면 domain term을 `CONTEXT.md`로 승격하기 전에 묻는다.
   - term을 한두 문장으로 정의한다.
   - 유용하면 피해야 할 synonym을 `_Avoid_`로 적는다.
   - implementation detail과 generic programming concept는 제외한다.
6. 아래 조건이 모두 참일 때만 `docs/adr/` ADR을 제안한다.
   - decision이 되돌리기 어렵다.
   - 맥락 없이는 decision이 놀랍다.
   - 실제 alternative가 있었고 trade-off가 있었다.
7. 사용자가 project-doc update를 명시하지 않았다면 ADR file 생성 또는 수정 전에 묻는다.
8. ADR은 짧게 유지한다. optional section이 실제 가치를 주지 않으면 title과 한두 문장으로 충분하다.

`.agent/`는 tracked이므로 `.agent/DOCS.md`는 concise하게 유지하고 secret이나 private operational detail을 피한다.

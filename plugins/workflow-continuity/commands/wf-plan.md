---
name: wf-plan
description: Clarify ambiguity, define scope, success criteria, risks, and the next strict workflow plan.
aliases: [wfplan]
---

# WF Plan

Use this command before implementation or whenever the current plan no longer fits.

## Steps

1. Ensure `.agent/` exists, is not ignored by git, and has `HANDOFF.md`, `PROGRESS.md`, and `DOCS.md`. Initialize from `templates/agent/` when available.
2. Read `.agent/HANDOFF.md`, `.agent/PROGRESS.md`, and `.agent/DOCS.md` if present.
3. Read `CONTEXT.md`, `CONTEXT-MAP.md`, and relevant `docs/adr/` files if they exist.
4. Identify ambiguities in requirements, wording, domain terms, success criteria, constraints, and risk.
5. If a question can be answered by inspecting code or docs, inspect first instead of asking.
6. Ask one question at a time when ambiguity affects implementation. Include a recommended answer when useful.
7. Do not enact the plan until the user confirms shared understanding.
8. Write or update `.agent/PROGRESS.md` using `writing-plans` discipline:
   - objective;
   - scope and non-goals;
   - assumptions;
   - success criteria;
   - exact files or areas expected to change;
   - bite-sized implementation steps;
   - planned verification;
   - expected verification results;
   - risk notes;
   - stop conditions;
   - next development steps.
9. For code behavior changes, plan the `test-driven-development` red/green path. For docs, manifests, or packaging-only work, plan a structural check that fails before the edit and passes after it.
10. When a term is resolved, record it in `.agent/DOCS.md`. Ask before promoting it to `CONTEXT.md`.
11. When a hard-to-reverse trade-off is resolved, offer an ADR and ask before creating or modifying `docs/adr/`.

Do not implement during `/wf-plan` unless the user explicitly asks to continue after approving the plan.

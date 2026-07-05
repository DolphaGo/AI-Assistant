---
name: wf-ralph
description: Continue strict workflow cycles until the objective is complete or user confirmation is required.
aliases: [wfralph]
---

# WF Ralph

Use this command when the user wants the agent to keep going until the objective is complete.

## Loop

Repeat:

1. `/wf-resume` if `.agent/` state exists.
2. `/wf-plan` until ambiguity, domain terms, decision dependencies, and completion criteria are resolved.
3. Develop the smallest scoped change, using `test-driven-development` for code behavior changes and structural checks for docs/manifests/packaging.
4. Test and record evidence with `/wf-progress`.
5. If a bug or unexpected failure appears, use `systematic-debugging` before changing the plan or implementation.
6. Run `/wf-review`, including `verification-before-completion` and conditional `requesting-code-review`.
7. Apply feedback or update the plan.
8. Run `/wf-docs` whenever a term, decision, or reusable workflow fact crystallizes.
9. Stop only when the objective is complete or escalation is required.

## Stop And Ask

Stop and ask the user when:

- requirements, wording, or success criteria are ambiguous;
- domain language is overloaded or conflicts with `CONTEXT.md`;
- implementation diverges from the plan;
- a blocker repeats;
- a risky or destructive action is required;
- verification fails in a way that changes the plan;
- quality review finds a design or scope issue.
- fresh verification cannot support the completion claim.

On stop or completion, update `.agent/HANDOFF.md`.

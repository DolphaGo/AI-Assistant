---
name: workflow-continuity
description: Use when a task needs repo-local agent continuity, handoff/progress/docs state, ambiguity gating, strict plan-develop-test-review-feedback loops, plan drift escalation, or ralph-style autonomous continuation until the objective is complete.
---

# Workflow Continuity

Apply this protocol when work must survive agent switches or long running execution.

## State Files

Use repo-local `.agent/` files:

- `.agent/HANDOFF.md`: current state for the next agent.
- `.agent/PROGRESS.md`: cycle log of plans, development, tests, reviews, feedback, blockers, and plan updates.
- `.agent/DOCS.md`: confirmed decisions, glossary terms, and reusable workflow knowledge.

Keep `.agent/` git tracked by default so handoffs and progress survive branch switches, agent switches, and fresh checkouts. Initialize missing files from `templates/agent/` when available.

Durable project knowledge may also be written outside `.agent/`:

- `CONTEXT.md`: project glossary and domain language. Ask before creating or modifying it unless the user explicitly requested project-doc updates.
- `CONTEXT-MAP.md`: map of multiple domain contexts, when the repo already uses multiple contexts.
- `docs/adr/NNNN-slug.md`: architectural decisions that are hard to reverse, surprising without context, and the result of a real trade-off. Ask before creating or modifying ADRs unless the user explicitly requested project-doc updates.

Create durable docs lazily, only when a term or decision has crystallized.

## Non-Negotiable Rules

- If a requirement, phrase, success criterion, or plan step is ambiguous, stop and ask the user before implementing.
- If actual progress diverges from the approved plan, stop and explain the situation, options, and recommended path before continuing.
- Do not silently expand scope. Record explicit non-goals in the plan when useful.
- Record evidence, not vibes: commands run, test results, review findings, skipped checks, and reasons.
- Keep `HANDOFF.md` compact and current. Keep detailed history in `PROGRESS.md`.
- Do not duplicate content already captured in specs, plans, ADRs, commits, diffs, or PRs. Reference artifact paths or URLs instead.
- Redact secrets and private data from tracked `.agent/` files, including API keys, passwords, tokens, cookies, private chat content, and unnecessary PII.

## Grilling Discipline

Before planning or changing implementation, grill the plan until there is shared understanding:

- Ask one question at a time and wait for the user's answer.
- For each question, include the recommended answer when useful.
- Walk dependencies between decisions in order; do not skip unresolved branches.
- If a question can be answered by reading the codebase or existing docs, inspect those first instead of asking.
- Do not enact the plan until the user confirms the shared understanding.

## Domain Docs Discipline

Build project language as decisions become clear:

- If the user uses a vague or overloaded term, propose a precise canonical term.
- If the term conflicts with `CONTEXT.md`, call out the conflict and ask which meaning is correct.
- Stress-test domain relationships with concrete scenarios and edge cases.
- Cross-check claims about behavior against the code when feasible.
- When a term is resolved, write it to `.agent/DOCS.md` immediately and ask before promoting it to `CONTEXT.md`. Keep `CONTEXT.md` a glossary only: no implementation details, no specs, no scratch notes.
- Offer an ADR only when the decision is hard to reverse, surprising without context, and the result of a real trade-off. Ask before creating or modifying `docs/adr/`.

## Superpowers Disciplines

Fold these disciplines into the workflow without adding more user-facing commands:

- `writing-plans`: plans must be executable by a fresh agent. Include exact files, bite-sized steps, verification commands, expected results, and stop conditions.
- `test-driven-development`: when code behavior changes, write or identify a failing test before implementation. For docs, manifests, or packaging-only work, establish a failing structural check before editing.
- `systematic-debugging`: when a bug, failing test, or unexpected behavior appears, do not guess. Reproduce, inspect recent changes, gather evidence, form one hypothesis, test it minimally, then fix the root cause.
- `verification-before-completion`: before claiming completion, run fresh verification, read the output, and record the evidence.
- `requesting-code-review`: after substantial work, risky changes, shared behavior changes, or ralph-mode cycles, run an independent review pass or subagent when available and proportionate.

## Spec-Driven Planning

Use a lightweight Spec Kit-style separation:

- Spec Snapshot: what user-visible or workflow behavior must be true.
- Technical Plan: how the repo will change to satisfy the spec.
- Task Breakdown: small implementation tasks with verification per task.
- Spec Delta: when requirements change, record what changed and why instead of silently rewriting history.

Do not proceed from spec to implementation while success criteria, non-goals, or task boundaries are ambiguous.

## Risk And Security Gate

During review, assign a Risk Profile. Mark the change as security-relevant if it touches:

- authentication, authorization, permissions, or user identity;
- payments, billing, financial data, or data deletion;
- secrets, credentials, tokens, cookies, environment variables, or logs;
- external input, parsing, upload/download, network calls, or shell execution;
- dependencies, package installation, CI, deployment, or generated artifacts;
- database migrations, data model changes, or cross-tenant boundaries.

For security-relevant changes, run available local checks such as tests, linters, Semgrep, CodeQL, dependency audit, or targeted grep. If a check is unavailable or skipped, record why.

## Strict Loop

Run work in cycles:

1. Plan: clarify ambiguity, create a Spec Snapshot, define scope, success criteria, task breakdown, verification, risks, and stop conditions.
2. Develop: make the smallest scoped change, using TDD for behavior changes.
3. Test: run the planned verification and record results.
4. Debug: if verification fails unexpectedly, use systematic debugging before changing code.
5. Review: evaluate quality against the plan; use independent review passes or subagents when available and worthwhile.
6. Feedback: capture findings, blockers, and user decisions.
7. Completion gate: run fresh verification before claiming completion.
8. Plan update: revise the plan or mark the objective complete.

## Ralph Mode

Ralph mode repeats the strict loop until the objective is complete. Stop for user confirmation when:

- completion criteria are unclear;
- a requirement or phrase is ambiguous;
- the implementation diverges from the plan;
- the same blocker repeats;
- a risky/destructive action is needed;
- review or verification shows the plan must change.
- fresh verification cannot be run or does not support the completion claim.

## Command Mapping

- `/wf-resume`: read `.agent/` state and restore context.
- `/wf-plan`: clarify and write the next plan.
- `/wf-progress`: update progress and cycle evidence.
- `/wf-review`: run and record quality evaluation.
- `/wf-docs`: promote confirmed knowledge to docs.
- `/wf-handoff`: compress current state for the next agent.
- `/wf-ralph`: run strict loop cycles until done or escalation is required.

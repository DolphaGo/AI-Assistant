---
name: wf-progress
description: Record cycle progress, commands run, verification evidence, blockers, and next steps.
aliases: [wfprogress]
---

# WF Progress

Use this command during and after each strict workflow cycle.

## Steps

1. Ensure `.agent/` exists, is tracked by git, and has `HANDOFF.md`, `PROGRESS.md`, and `DOCS.md`. Initialize from `templates/agent/` when available.
2. Append a dated cycle entry to `.agent/PROGRESS.md`.
3. Record:
   - current plan step;
   - files or areas changed;
   - commands run and results;
   - red/green evidence for behavior changes, or structural check evidence for docs/manifests/packaging;
   - tests or checks skipped, with reasons;
   - blockers or plan drift;
   - next step.
4. If work diverged from the plan, stop and ask the user to confirm the revised direction.
5. If a bug, test failure, or unexpected behavior appears, switch to `systematic-debugging`:
   - reproduce consistently;
   - inspect errors and recent changes;
   - gather evidence at component boundaries;
   - state one hypothesis;
   - test the smallest change;
   - fix the root cause, not the symptom.

Prefer short evidence-rich entries over long narrative logs.

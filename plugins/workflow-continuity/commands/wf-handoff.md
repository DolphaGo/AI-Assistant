---
name: wf-handoff
description: Compress current state into .agent/HANDOFF.md so another agent can continue without rediscovery.
aliases: [wfhandoff]
---

# WF Handoff

Use this command before stopping, switching agents, or handing off work.

## Steps

1. Read `.agent/PROGRESS.md`, `.agent/DOCS.md`, git status, and the latest relevant diff.
2. Rewrite `.agent/HANDOFF.md` as a compact current-state document.
3. Include:
   - objective;
   - current status;
   - latest plan;
   - completed work;
   - fresh verification evidence and exact commands;
   - checks not run and why;
   - review findings and unresolved quality risks;
   - open blockers or questions;
   - next recommended step;
   - files most likely to matter.
4. Exclude stale history and unresolved speculation unless it affects the next step.

The next agent should be able to read `HANDOFF.md` first and continue immediately.

---
name: wf-resume
description: Restore context from .agent state before continuing a task.
aliases: [wfresume]
---

# WF Resume

Use this command at the start of a resumed task or after an agent switch.

## Steps

1. Read `.agent/HANDOFF.md` first if it exists.
2. Read `.agent/PROGRESS.md` for recent cycle evidence.
3. Read `.agent/DOCS.md` for confirmed decisions and vocabulary.
4. Compare the handoff with current git status and relevant files.
5. State:
   - what is confirmed;
   - what may be stale;
   - what needs verification;
   - the next recommended action.
6. If state files are missing, initialize `.agent/` and continue with `/wf-plan`.

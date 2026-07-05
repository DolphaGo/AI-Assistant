---
name: wf-review
description: Evaluate implementation quality against the plan using tests, diff review, and independent review passes when useful.
aliases: [wfreview]
---

# WF Review

Use this command after development and verification.

## Steps

1. Read `.agent/PROGRESS.md` and the current diff.
2. Compare the implementation against the latest plan and success criteria.
3. Run or summarize planned verification.
4. Check for:
   - unmet requirements;
   - scope creep;
   - missing tests or weak evidence;
   - risky changes;
   - unclear user-facing behavior;
   - docs or handoff updates needed.
5. Apply `verification-before-completion`: no completion claim is allowed without fresh verification output.
6. Use `requesting-code-review` discipline for substantial work, risky changes, shared behavior changes, or ralph-mode cycles. Prefer independent review passes or subagents when available and proportionate.
7. Record findings in `.agent/PROGRESS.md`.

If findings require changing the plan, stop and ask the user before continuing.

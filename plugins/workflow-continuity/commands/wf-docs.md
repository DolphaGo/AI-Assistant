---
name: wf-docs
description: Promote confirmed decisions, terms, and reusable workflow knowledge into .agent/DOCS.md.
aliases: [wfdocs]
---

# WF Docs

Use this command when a decision, term, or reusable piece of knowledge has become stable.

## Steps

1. Read `.agent/PROGRESS.md`, existing `.agent/DOCS.md`, `CONTEXT.md`, `CONTEXT-MAP.md`, and relevant `docs/adr/` files if present.
2. Extract only confirmed knowledge:
   - decisions and rationale;
   - project-specific vocabulary and canonical terms;
   - recurring commands;
   - constraints and non-goals;
   - known risks and mitigations.
3. Do not copy transient logs, speculation, or unresolved questions.
4. Update `.agent/DOCS.md` with concise entries for local workflow continuity.
5. Record crystallized terms in `.agent/DOCS.md` first.
6. Ask before promoting domain terms to `CONTEXT.md` unless the user explicitly requested project-doc updates:
   - define what the term is in one or two sentences;
   - list avoided synonyms with `_Avoid_` when useful;
   - exclude implementation details and generic programming concepts.
7. Offer an ADR in `docs/adr/` only when all are true:
   - the decision is hard to reverse;
   - the decision is surprising without context;
   - real alternatives existed and a trade-off was made.
8. Ask before creating or modifying ADR files unless the user explicitly requested project-doc updates.
9. Keep ADRs short: title plus one to three sentences is enough unless optional sections add real value.

Because `.agent/` is tracked, keep `.agent/DOCS.md` concise and avoid secrets or private operational details.

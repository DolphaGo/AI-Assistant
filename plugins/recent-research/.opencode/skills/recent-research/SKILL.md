---
name: recent-research
description: Research recent public signals for a topic using a bundled deterministic evidence collector plus the host's web search when available. Use when the user asks for recent market, product, competitor, hiring, community, GitHub, Hacker News, or Reddit signals; wants a concise current brief; or needs source-grounded evidence before a meeting, build decision, product comparison, or trend check.
---

# Recent Research

## Overview

Use this skill to produce a concise, evidence-grounded brief about what changed recently around a topic. The bundled script collects public signals from low-friction sources without API keys, while the hosting agent may add native web-search evidence for current news or pages.

## Operating Contract

Default to a 30-day window unless the user asks for another range.

Do not answer from memory for recent claims. Run the bundled collector and use host web search when available.

Keep the final answer short and source-grounded:

- Start with `Recent Research: <topic>`.
- State the date window and sources checked.
- Give 3-6 strongest signals, each tied to a source label.
- Separate evidence from inference with phrases like "This suggests" or "My read".
- Include gaps when sources are thin, unavailable, or single-source.
- Avoid raw URL dumps in prose. Use readable source labels and retain URLs in the evidence artifact or concise links when useful.

## Workflow

1. Resolve the topic and date window from the user's request.
2. If the user asks whether the skill is set up or a source looks broken, run diagnostics first:

```bash
python3 scripts/research.py doctor
```

3. Run the collector from this skill directory:

```bash
python3 scripts/research.py "<topic>" --days 30 --emit brief
```

For explicit comparisons, use either natural `A vs B` phrasing or repeated `--compare` flags:

```bash
python3 scripts/research.py "Codex vs Cursor" --days 30 --emit brief
python3 scripts/research.py --compare Codex --compare Cursor --days 30 --emit brief
```

Use `--emit markdown` for raw evidence, `--emit json` for structured data, and `--mock` only for validation or demos. Use `--save-dir <dir>` or `--output <file>` when the user asks for a reusable artifact.

4. If host web search is available and the topic is current, supplement with 2-4 targeted searches:
   - official site or docs for product/company claims
   - recent news for launches, incidents, or pricing
   - specific competitor names when the user asks for comparison
5. Read `references/output-contract.md` before synthesizing the final brief.
6. Mention saved artifact paths only when the user asked for a file or when the artifact is materially useful.

## Collector Capabilities

The script currently supports:

- GitHub repository and issue signals through public GitHub search.
- Hacker News story and comment signals through the public Algolia API.
- Reddit public search when Reddit allows unauthenticated JSON access.
- Source diagnostics through `doctor`.
- Structured comparison mode for `A vs B`, `A versus B`, and repeated `--compare` values.
- Artifact saving through `--save-dir` and `--output`.
- Brief, Markdown, and JSON output.
- A mock mode for deterministic validation without network access.

## Failure Handling

If a source fails, keep going and report the failure under gaps. Do not convert partial source failure into a failed research task unless every source fails and host web search is unavailable.

If evidence is weak, say so directly and provide the best next verification step.

Use `doctor` results to distinguish local/source availability problems from topic-specific thin evidence.

## Examples

- "Use recent-research on Codex vs Cursor this month."
- "최근 30일 동안 Linear MCP 관련 시그널 봐줘."
- "Before my meeting, brief me on recent GitHub and community activity for OpenTelemetry."
- "Compare recent developer chatter around Supabase and Neon."
- "Compare Codex, Cursor, and Claude Code recent community signals."
- "Run recent-research doctor and tell me which sources are available."

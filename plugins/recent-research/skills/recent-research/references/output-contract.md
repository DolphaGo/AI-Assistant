# Output Contract

Use this reference after running `scripts/research.py` and any host web search.

## Brief Shape

```markdown
Recent Research: <topic>

Window: <date range>
Sources checked: <source labels>

Strongest signals:
1. <signal> - source: <label>
2. <signal> - source: <label>
3. <signal> - source: <label>

My read:
<short inference, clearly separated from facts>

Gaps:
- <missing source, thin evidence, or failed source>
```

## Comparison Shape

```markdown
Recent Research Comparison: <A> vs <B>

Window: <date range>

Entity snapshot:
- <A>: <source labels>
  Top signal: <signal>
- <B>: <source labels>
  Top signal: <signal>

Side-by-side signals:

<A>:
- <signal> - <source>, <date>

<B>:
- <signal> - <source>, <date>

My read:
<short inference, clearly separated from facts>

Gaps:
- <entity>: <missing source, thin evidence, or failed source>
```

The script's `--emit brief` output already follows this scaffold. Treat it as evidence-ready draft material, then add host web-search findings and human-readable synthesis.

## HTML Artifacts

Use `--emit html --save` when the user asks for a shareable report. The HTML is self-contained and wraps the brief scaffold in a readable page. Treat the HTML as an artifact, not as extra evidence.

## Query Plans

Use `--show-plan` before collection when a topic has ambiguous names, renamed projects, handles, or source-specific spelling. Use `--plan` with JSON when the model or user has already resolved better source queries. The final brief may mention the query plan only when it materially affects confidence or explains a gap.

## Rules

- Prefer 3-6 high-signal findings over a long list.
- Tie every factual claim to a source label from the collector output or host web search.
- Distinguish evidence from interpretation.
- Report source failures and thin evidence plainly.
- Do not invent engagement counts, dates, URLs, handles, or repository names.
- Treat `news` items as public headline signals; verify important claims with primary sources before presenting them as settled facts.
- Do not end with a raw URL dump. Use concise links only when the host renders them cleanly.
- Mention `doctor` output only when diagnosing source availability. Do not include diagnostics in an ordinary topic brief unless a source failure affects confidence.
- For comparisons, avoid declaring a winner unless both collector evidence and host web search support the claim.
- When saving artifacts, mention the saved path only when the user asked for an artifact or needs to open the file.
- Do not present planned queries as evidence. Only collected signals and host web-search results are evidence.

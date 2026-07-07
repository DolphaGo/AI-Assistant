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

## Rules

- Prefer 3-6 high-signal findings over a long list.
- Tie every factual claim to a source label from the collector output or host web search.
- Distinguish evidence from interpretation.
- Report source failures and thin evidence plainly.
- Do not invent engagement counts, dates, URLs, handles, or repository names.
- Do not end with a raw URL dump. Use concise links only when the host renders them cleanly.
- Mention `doctor` output only when diagnosing source availability. Do not include diagnostics in an ordinary topic brief unless a source failure affects confidence.
- For comparisons, avoid declaring a winner unless both collector evidence and host web search support the claim.

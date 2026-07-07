#!/usr/bin/env python3
"""Collect recent public signals for the recent-research skill.

The script intentionally uses only Python's standard library and public,
low-friction endpoints. It is a deterministic evidence collector, not a final
research writer.
"""

from __future__ import annotations

import argparse
import datetime as dt
import email.utils
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Optional, Union

USER_AGENT = "AI-Assistant recent-research/1.0"
DEFAULT_SOURCES = ("github", "hackernews", "reddit", "news")
COMPARISON_SPLIT_RE = re.compile(r"\s+(?:vs\.?|versus)\s+", re.IGNORECASE)


@dataclass
class Signal:
    source: str
    title: str
    url: str
    date: str
    author: str = ""
    score: int = 0
    comments: int = 0
    snippet: str = ""


@dataclass
class SourceStatus:
    source: str
    status: str
    detail: str
    count: int = 0
    latency_ms: int = 0
    query: str = ""


def utc_today() -> dt.date:
    return dt.datetime.now(dt.timezone.utc).date()


def since_date(days: int) -> dt.date:
    return utc_today() - dt.timedelta(days=days)


def clean_text(value: Any, max_len: int = 260) -> str:
    if value is None:
        return ""
    text = re.sub(r"<[^>]+>", " ", str(value))
    text = html.unescape(text)
    text = " ".join(text.replace("\n", " ").split())
    if len(text) <= max_len:
        return text
    return text[: max_len - 1].rstrip() + "..."


def fetch_json(url: str, params: dict[str, Union[str, int]], timeout: int) -> Any:
    query = urllib.parse.urlencode(params)
    request = urllib.request.Request(
        f"{url}?{query}",
        headers={
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = response.read()
    return json.loads(payload.decode("utf-8"))


def fetch_text(url: str, params: dict[str, Union[str, int]], timeout: int) -> str:
    query = urllib.parse.urlencode(params)
    request = urllib.request.Request(
        f"{url}?{query}",
        headers={
            "Accept": "application/rss+xml, application/xml, text/xml",
            "User-Agent": USER_AGENT,
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = response.read()
    return payload.decode("utf-8", errors="replace")


def slugify(value: str) -> str:
    slug = []
    previous_dash = False
    for char in value.lower():
        if char.isalnum():
            slug.append(char)
            previous_dash = False
        elif not previous_dash:
            slug.append("-")
            previous_dash = True
    normalized = "".join(slug).strip("-")
    return normalized or "recent-research"


def describe_error(exc: BaseException) -> str:
    if isinstance(exc, urllib.error.HTTPError):
        return f"HTTP {exc.code}: {clean_text(exc.reason, 120)}"
    if isinstance(exc, urllib.error.URLError):
        return f"URL error: {clean_text(exc.reason, 160)}"
    return clean_text(exc, 180)


def normalize_comparison_entities(topic: Optional[str], compare_values: Optional[list[str]]) -> list[str]:
    entities: list[str] = []
    for value in compare_values or []:
        for item in value.split(","):
            cleaned = clean_text(item, 80).strip()
            if cleaned:
                entities.append(cleaned)
    if not entities and topic:
        parts = [part.strip() for part in COMPARISON_SPLIT_RE.split(topic) if part.strip()]
        if len(parts) >= 2:
            entities.extend(parts)

    deduped: list[str] = []
    seen = set()
    for entity in entities:
        key = entity.casefold()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(entity)
    return deduped


def load_plan(raw_plan: Optional[str]) -> dict[str, Any]:
    if not raw_plan:
        return {}
    candidate = Path(raw_plan).expanduser()
    if candidate.exists():
        raw_text = candidate.read_text(encoding="utf-8")
    else:
        raw_text = raw_plan
    try:
        payload = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"--plan must be a JSON string or path to a JSON file: {exc}") from exc
    if not isinstance(payload, dict):
        raise SystemExit("--plan must decode to a JSON object")
    return payload


def source_query_overrides(args: argparse.Namespace) -> dict[str, str]:
    candidates = {
        "github": args.github_query,
        "hackernews": args.hackernews_query,
        "reddit": args.reddit_query,
        "news": args.news_query,
    }
    return {source: value.strip() for source, value in candidates.items() if value and value.strip()}


def plan_queries(topic: str, plan: dict[str, Any], overrides: dict[str, str]) -> dict[str, str]:
    queries = {source: topic for source in DEFAULT_SOURCES}
    plan_queries_value = plan.get("queries", {})
    if plan_queries_value:
        if not isinstance(plan_queries_value, dict):
            raise SystemExit("--plan field 'queries' must be an object")
        for source, value in plan_queries_value.items():
            if source in queries and isinstance(value, str) and value.strip():
                queries[source] = value.strip()
    queries.update(overrides)
    return queries


def entity_plan(entity: str, plan: dict[str, Any]) -> dict[str, Any]:
    entities = plan.get("entities", {})
    if not isinstance(entities, dict):
        return {}
    value = entities.get(entity) or entities.get(entity.casefold())
    if value is None:
        for key, candidate in entities.items():
            if isinstance(key, str) and key.casefold() == entity.casefold():
                value = candidate
                break
    if isinstance(value, dict):
        return value
    return {}


def build_plan(topic: str, plan: dict[str, Any], overrides: dict[str, str]) -> dict[str, Any]:
    return {
        "topic": topic,
        "queries": plan_queries(topic, plan, overrides),
        "notes": plan.get("notes", []) if isinstance(plan.get("notes", []), list) else [],
    }


def build_comparison_plan(entities: list[str], plan: dict[str, Any], overrides: dict[str, str]) -> dict[str, Any]:
    return {
        "topic": " vs ".join(entities),
        "comparison": True,
        "entities": [
            build_plan(entity, entity_plan(entity, plan), overrides)
            for entity in entities
        ],
    }


def github_signals(query: str, days: int, limit: int, timeout: int) -> tuple[list[Signal], SourceStatus]:
    since = since_date(days).isoformat()
    signals: list[Signal] = []

    repo_data = fetch_json(
        "https://api.github.com/search/repositories",
        {
            "q": f"{query} pushed:>={since}",
            "sort": "updated",
            "order": "desc",
            "per_page": max(1, min(limit, 10)),
        },
        timeout,
    )
    for item in repo_data.get("items", [])[:limit]:
        signals.append(
            Signal(
                source="github",
                title=clean_text(item.get("full_name") or item.get("name")),
                url=item.get("html_url") or "",
                date=(item.get("pushed_at") or item.get("updated_at") or "")[:10],
                author=(item.get("owner") or {}).get("login", ""),
                score=int(item.get("stargazers_count") or 0),
                snippet=clean_text(item.get("description")),
            )
        )

    issue_budget = max(1, limit - len(signals))
    issue_data = fetch_json(
        "https://api.github.com/search/issues",
        {
            "q": f"{query} updated:>={since}",
            "sort": "updated",
            "order": "desc",
            "per_page": max(1, min(issue_budget, 10)),
        },
        timeout,
    )
    for item in issue_data.get("items", [])[:issue_budget]:
        signals.append(
            Signal(
                source="github",
                title=clean_text(item.get("title")),
                url=item.get("html_url") or "",
                date=(item.get("updated_at") or item.get("created_at") or "")[:10],
                author=(item.get("user") or {}).get("login", ""),
                comments=int(item.get("comments") or 0),
                snippet=clean_text(item.get("body")),
            )
        )

    return signals[:limit], SourceStatus("github", "ok", "public GitHub search", len(signals[:limit]), query=query)


def hackernews_signals(query: str, days: int, limit: int, timeout: int) -> tuple[list[Signal], SourceStatus]:
    min_ts = int(time.mktime(since_date(days).timetuple()))
    data = fetch_json(
        "https://hn.algolia.com/api/v1/search_by_date",
        {
            "query": query,
            "tags": "story,comment",
            "numericFilters": f"created_at_i>{min_ts}",
            "hitsPerPage": max(1, min(limit, 20)),
        },
        timeout,
    )
    signals: list[Signal] = []
    for item in data.get("hits", [])[:limit]:
        object_id = item.get("objectID") or ""
        title = item.get("title") or item.get("story_title") or item.get("comment_text") or "Hacker News item"
        item_url = item.get("url") or item.get("story_url") or f"https://news.ycombinator.com/item?id={object_id}"
        signals.append(
            Signal(
                source="hackernews",
                title=clean_text(title),
                url=item_url,
                date=(item.get("created_at") or "")[:10],
                author=item.get("author") or "",
                score=int(item.get("points") or 0),
                comments=int(item.get("num_comments") or 0),
                snippet=clean_text(item.get("comment_text") or item.get("story_text")),
            )
        )
    return signals, SourceStatus("hackernews", "ok", "public Algolia API", len(signals), query=query)


def reddit_signals(query: str, days: int, limit: int, timeout: int) -> tuple[list[Signal], SourceStatus]:
    data = fetch_json(
        "https://www.reddit.com/search.json",
        {
            "q": query,
            "sort": "new",
            "t": "month" if days <= 31 else "year",
            "limit": max(1, min(limit, 25)),
        },
        timeout,
    )
    cutoff = dt.datetime.combine(since_date(days), dt.time.min, tzinfo=dt.timezone.utc).timestamp()
    signals: list[Signal] = []
    for child in data.get("data", {}).get("children", []):
        item = child.get("data", {})
        created = float(item.get("created_utc") or 0)
        if created and created < cutoff:
            continue
        permalink = item.get("permalink") or ""
        signals.append(
            Signal(
                source="reddit",
                title=clean_text(item.get("title")),
                url=f"https://www.reddit.com{permalink}" if permalink else item.get("url") or "",
                date=dt.datetime.fromtimestamp(created, dt.timezone.utc).date().isoformat() if created else "",
                author=item.get("author") or "",
                score=int(item.get("score") or 0),
                comments=int(item.get("num_comments") or 0),
                snippet=clean_text(item.get("selftext")),
            )
        )
        if len(signals) >= limit:
            break
    return signals, SourceStatus("reddit", "ok", "public Reddit search JSON", len(signals), query=query)


def news_signals(query: str, days: int, limit: int, timeout: int) -> tuple[list[Signal], SourceStatus]:
    text = fetch_text(
        "https://news.google.com/rss/search",
        {
            "q": f"{query} when:{days}d",
            "hl": "en-US",
            "gl": "US",
            "ceid": "US:en",
        },
        timeout,
    )
    root = ET.fromstring(text)
    signals: list[Signal] = []
    for item in root.findall(".//item")[:limit]:
        title = clean_text(item.findtext("title"))
        link = item.findtext("link") or ""
        published = item.findtext("pubDate") or ""
        parsed_date = ""
        if published:
            try:
                parsed_date = email.utils.parsedate_to_datetime(published).date().isoformat()
            except (TypeError, ValueError, AttributeError):
                parsed_date = ""
        source = item.findtext("source") or ""
        signals.append(
            Signal(
                source="news",
                title=title,
                url=link,
                date=parsed_date,
                author=clean_text(source, 80),
                snippet=clean_text(item.findtext("description")),
            )
        )
    return signals, SourceStatus("news", "ok", "Google News RSS", len(signals), query=query)


def mock_signals(topic: str, days: int, limit: int) -> tuple[list[Signal], list[SourceStatus]]:
    today = utc_today().isoformat()
    samples = [
        Signal(
            source="github",
            title=f"{topic} example/repo",
            url="https://github.com/example/repo",
            date=today,
            author="example",
            score=128,
            snippet="Mock repository activity for validation.",
        ),
        Signal(
            source="hackernews",
            title=f"{topic} discussion on Hacker News",
            url="https://news.ycombinator.com/item?id=1",
            date=today,
            author="hn-user",
            score=42,
            comments=17,
            snippet="Mock discussion signal for validation.",
        ),
        Signal(
            source="reddit",
            title=f"{topic} community thread",
            url="https://www.reddit.com/r/example/comments/1/mock/",
            date=today,
            author="reddit-user",
            score=91,
            comments=23,
            snippet="Mock community signal for validation.",
        ),
        Signal(
            source="news",
            title=f"{topic} recent news item",
            url="https://news.example.com/mock",
            date=today,
            author="Example News",
            snippet="Mock news signal for validation.",
        ),
    ][:limit]
    counts = {source: 0 for source in DEFAULT_SOURCES}
    for sample in samples:
        counts[sample.source] += 1
    statuses = [
        SourceStatus(source, "ok", "mock", counts[source], query=topic)
        for source in DEFAULT_SOURCES
    ]
    return samples, statuses


def collect(
    topic: str,
    days: int,
    sources: list[str],
    limit: int,
    timeout: int,
    mock: bool,
    query_plan: dict[str, Any],
) -> dict[str, Any]:
    if mock:
        signals, statuses = mock_signals(topic, days, limit)
        for status in statuses:
            status.query = query_plan["queries"].get(status.source, topic)
    else:
        signals = []
        statuses = []
        collectors = {
            "github": github_signals,
            "hackernews": hackernews_signals,
            "reddit": reddit_signals,
            "news": news_signals,
        }
        for source in sources:
            collector = collectors[source]
            query = query_plan["queries"].get(source, topic)
            started = time.monotonic()
            try:
                source_signals, status = collector(query, days, limit, timeout)
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError, ET.ParseError, OSError) as exc:
                latency_ms = int((time.monotonic() - started) * 1000)
                statuses.append(SourceStatus(source, "failed", describe_error(exc), 0, latency_ms, query))
                continue
            status.latency_ms = int((time.monotonic() - started) * 1000)
            signals.extend(source_signals)
            statuses.append(status)

    ranked = sorted(
        signals,
        key=lambda item: (item.score + item.comments * 2, item.date, item.title),
        reverse=True,
    )
    return {
        "topic": topic,
        "window_days": days,
        "since": since_date(days).isoformat(),
        "generated_at": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "plan": query_plan,
        "sources": [asdict(status) for status in statuses],
        "signals": [asdict(signal) for signal in ranked[:limit]],
    }


def collect_comparison(
    entities: list[str],
    days: int,
    sources: list[str],
    limit: int,
    timeout: int,
    mock: bool,
    comparison_plan: dict[str, Any],
) -> dict[str, Any]:
    reports = [
        {
            "entity": entity_plan_value["topic"],
            "report": collect(entity_plan_value["topic"], days, sources, limit, timeout, mock, entity_plan_value),
        }
        for entity_plan_value in comparison_plan["entities"]
    ]
    return {
        "topic": " vs ".join(entities),
        "comparison": True,
        "window_days": days,
        "since": since_date(days).isoformat(),
        "generated_at": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "plan": comparison_plan,
        "entities": reports,
    }


def source_labels(report: dict[str, Any]) -> str:
    labels = []
    for source in report["sources"]:
        label = f"{source['source']}:{source['status']}"
        if "count" in source:
            label += f"/{source['count']}"
        labels.append(label)
    return ", ".join(labels) if labels else "none"


def render_markdown(report: dict[str, Any]) -> str:
    if report.get("comparison"):
        return render_comparison_markdown(report)

    lines = [
        f"Recent Research Evidence: {report['topic']}",
        "",
        f"Window: {report['since']} to {utc_today().isoformat()} ({report['window_days']} days)",
        f"Generated: {report['generated_at']}",
        "",
        "Sources checked:",
    ]
    for source in report["sources"]:
        latency = f", {source['latency_ms']}ms" if source.get("latency_ms") else ""
        query = f", query: {source['query']}" if source.get("query") else ""
        lines.append(
            f"- {source['source']}: {source['status']} ({source['count']} items{latency}{query}) - {source['detail']}"
        )

    lines.extend(["", "Signals:"])
    if not report["signals"]:
        lines.append("- No signals found from the collector sources.")
    for index, signal in enumerate(report["signals"], start=1):
        metrics = []
        if signal["score"]:
            metrics.append(f"score {signal['score']}")
        if signal["comments"]:
            metrics.append(f"{signal['comments']} comments")
        metric_text = f" [{', '.join(metrics)}]" if metrics else ""
        lines.append(
            f"{index}. [{signal['source']}] {signal['title']} ({signal['date'] or 'unknown date'}){metric_text}"
        )
        if signal["author"]:
            lines.append(f"   - author: {signal['author']}")
        if signal["snippet"]:
            lines.append(f"   - snippet: {signal['snippet']}")
        if signal["url"]:
            lines.append(f"   - url: {signal['url']}")
    return "\n".join(lines) + "\n"


def render_brief(report: dict[str, Any]) -> str:
    if report.get("comparison"):
        return render_comparison_brief(report)

    today = utc_today().isoformat()
    lines = [
        f"Recent Research: {report['topic']}",
        "",
        f"Window: {report['since']} to {today} ({report['window_days']} days)",
        f"Sources checked: {source_labels(report)}",
        "",
        "Strongest signals:",
    ]
    if not report["signals"]:
        lines.append("1. No collector signals found in this run.")
    for index, signal in enumerate(report["signals"][:6], start=1):
        metrics = []
        if signal["score"]:
            metrics.append(f"score {signal['score']}")
        if signal["comments"]:
            metrics.append(f"{signal['comments']} comments")
        metric_text = f" ({', '.join(metrics)})" if metrics else ""
        lines.append(
            f"{index}. {signal['title']} - source: {signal['source']}, date: {signal['date'] or 'unknown'}{metric_text}"
        )
        if signal["snippet"]:
            lines.append(f"   Evidence: {signal['snippet']}")
        if signal["url"]:
            lines.append(f"   URL: {signal['url']}")

    gaps = [
        f"{source['source']} failed: {source['detail']}"
        for source in report["sources"]
        if source["status"] != "ok"
    ]
    empty_sources = [
        f"{source['source']} returned no items"
        for source in report["sources"]
        if source["status"] == "ok" and source["count"] == 0
    ]
    lines.extend(["", "My read:", "- Treat this as an evidence scaffold. Add host web-search findings before making current-news or market claims."])
    lines.extend(["", "Gaps:"])
    for gap in gaps + empty_sources:
        lines.append(f"- {gap}")
    if not gaps and not empty_sources:
        lines.append("- No collector source failures. Still verify important claims with host web search or primary sources.")
    return "\n".join(lines) + "\n"


def entity_top_signal(report: dict[str, Any]) -> str:
    signals = report.get("signals", [])
    if not signals:
        return "No collector signals found."
    signal = signals[0]
    metrics = []
    if signal["score"]:
        metrics.append(f"score {signal['score']}")
    if signal["comments"]:
        metrics.append(f"{signal['comments']} comments")
    metric_text = f" ({', '.join(metrics)})" if metrics else ""
    return f"{signal['title']} - {signal['source']}, {signal['date'] or 'unknown'}{metric_text}"


def entity_gaps(report: dict[str, Any]) -> list[str]:
    gaps = [
        f"{source['source']} failed: {source['detail']}"
        for source in report["sources"]
        if source["status"] != "ok"
    ]
    gaps.extend(
        f"{source['source']} returned no items"
        for source in report["sources"]
        if source["status"] == "ok" and source["count"] == 0
    )
    return gaps


def render_comparison_brief(report: dict[str, Any]) -> str:
    today = utc_today().isoformat()
    lines = [
        f"Recent Research Comparison: {report['topic']}",
        "",
        f"Window: {report['since']} to {today} ({report['window_days']} days)",
        "",
        "Entity snapshot:",
    ]
    for entity in report["entities"]:
        entity_report = entity["report"]
        lines.append(f"- {entity['entity']}: {source_labels(entity_report)}")
        lines.append(f"  Top signal: {entity_top_signal(entity_report)}")

    lines.extend(["", "Side-by-side signals:"])
    for entity in report["entities"]:
        entity_report = entity["report"]
        lines.append("")
        lines.append(f"{entity['entity']}:")
        if not entity_report["signals"]:
            lines.append("- No collector signals found.")
            continue
        for signal in entity_report["signals"][:3]:
            metrics = []
            if signal["score"]:
                metrics.append(f"score {signal['score']}")
            if signal["comments"]:
                metrics.append(f"{signal['comments']} comments")
            metric_text = f" ({', '.join(metrics)})" if metrics else ""
            lines.append(f"- {signal['title']} - {signal['source']}, {signal['date'] or 'unknown'}{metric_text}")
            if signal["snippet"]:
                lines.append(f"  Evidence: {signal['snippet']}")
            if signal["url"]:
                lines.append(f"  URL: {signal['url']}")

    lines.extend(["", "My read:", "- Treat this as a comparison evidence scaffold. Use host web search before making a winner claim."])
    lines.extend(["", "Gaps:"])
    any_gap = False
    for entity in report["entities"]:
        gaps = entity_gaps(entity["report"])
        for gap in gaps:
            any_gap = True
            lines.append(f"- {entity['entity']}: {gap}")
    if not any_gap:
        lines.append("- No collector source failures. Still verify important claims with host web search or primary sources.")
    return "\n".join(lines) + "\n"


def render_comparison_markdown(report: dict[str, Any]) -> str:
    lines = [
        f"Recent Research Comparison Evidence: {report['topic']}",
        "",
        f"Window: {report['since']} to {utc_today().isoformat()} ({report['window_days']} days)",
        f"Generated: {report['generated_at']}",
    ]
    for entity in report["entities"]:
        lines.extend(["", f"## {entity['entity']}", ""])
        lines.append(render_markdown(entity["report"]).rstrip())
    return "\n".join(lines) + "\n"


def render_output(report: dict[str, Any], emit: str) -> str:
    if emit == "json":
        return json.dumps(report, indent=2, ensure_ascii=False, sort_keys=True) + "\n"
    if emit == "html":
        return render_html(report)
    if emit == "brief":
        return render_brief(report)
    return render_markdown(report)


def render_html(report: dict[str, Any]) -> str:
    title = html.escape(report["topic"])
    body = html.escape(render_brief(report))
    generated = html.escape(report.get("generated_at", dt.datetime.now(dt.timezone.utc).isoformat()))
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Recent Research - {title}</title>
  <style>
    :root {{
      color-scheme: light dark;
      --bg: #f8fafc;
      --fg: #0f172a;
      --muted: #64748b;
      --panel: #ffffff;
      --border: #dbe3ef;
      --accent: #2563eb;
    }}
    @media (prefers-color-scheme: dark) {{
      :root {{
        --bg: #0b1020;
        --fg: #e5e7eb;
        --muted: #94a3b8;
        --panel: #111827;
        --border: #243044;
        --accent: #60a5fa;
      }}
    }}
    body {{
      margin: 0;
      background: var(--bg);
      color: var(--fg);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.55;
    }}
    main {{
      max-width: 920px;
      margin: 0 auto;
      padding: 40px 20px;
    }}
    .meta {{
      color: var(--muted);
      font-size: 13px;
      margin-bottom: 16px;
    }}
    pre {{
      white-space: pre-wrap;
      word-break: break-word;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 20px;
      font: 14px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }}
    .brand {{
      color: var(--accent);
      font-weight: 700;
      letter-spacing: 0;
    }}
  </style>
</head>
<body>
  <main>
    <div class="brand">Recent Research</div>
    <div class="meta">Generated {generated}</div>
    <pre>{body}</pre>
  </main>
</body>
</html>
"""


def default_save_dir() -> str:
    return os.environ.get("RECENT_RESEARCH_DIR") or "~/Documents/RecentResearch"


def save_output(
    content: str,
    topic: str,
    emit: str,
    save_dir: Optional[str],
    output: Optional[str],
    save_default: bool,
) -> Optional[Path]:
    if output:
        path = Path(output).expanduser().resolve()
    elif save_dir or save_default:
        extension = "json" if emit == "json" else "html" if emit == "html" else "md"
        filename = f"{slugify(topic)}-{utc_today().isoformat()}.{extension}"
        path = Path(save_dir or default_save_dir()).expanduser().resolve() / filename
    else:
        return None
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def run_doctor(sources: list[str], timeout: int, emit: str) -> int:
    probes = {
        "github": ("https://api.github.com/search/repositories", {"q": "opentelemetry", "per_page": 1}),
        "hackernews": ("https://hn.algolia.com/api/v1/search_by_date", {"query": "python", "hitsPerPage": 1}),
        "reddit": ("https://www.reddit.com/search.json", {"q": "python", "sort": "new", "t": "month", "limit": 1}),
        "news": ("https://news.google.com/rss/search", {"q": "python when:30d", "hl": "en-US", "gl": "US", "ceid": "US:en"}),
    }
    statuses: list[SourceStatus] = []
    for source in sources:
        started = time.monotonic()
        url, params = probes[source]
        try:
            if source == "news":
                root = ET.fromstring(fetch_text(url, params, timeout))
                count = len(root.findall(".//item"))
            else:
                data = fetch_json(url, params, timeout)
                count = len(data.get("items", data.get("hits", [])))
            if source == "reddit":
                count = len(data.get("data", {}).get("children", []))
            status = SourceStatus(source, "ok", "probe succeeded", count)
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError, ET.ParseError, OSError) as exc:
            status = SourceStatus(source, "failed", describe_error(exc), 0)
        status.latency_ms = int((time.monotonic() - started) * 1000)
        statuses.append(status)

    payload = {
        "generated_at": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "sources": [asdict(status) for status in statuses],
    }
    if emit == "json":
        print(json.dumps(payload, indent=2, ensure_ascii=False, sort_keys=True))
    else:
        print("Recent Research Doctor")
        print("")
        for status in statuses:
            print(
                f"- {status.source}: {status.status} ({status.count} items, {status.latency_ms}ms) - {status.detail}"
            )
    return 0


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Collect recent public signals for a topic.")
    parser.add_argument("topic", nargs="?", help="Research topic, or 'doctor' to probe sources")
    parser.add_argument("--compare", action="append", help="Entity to compare. Repeat or comma-separate.")
    parser.add_argument("--plan", help="JSON query plan string or path to a JSON plan file")
    parser.add_argument("--show-plan", action="store_true", help="Print the resolved query plan and exit")
    parser.add_argument("--github-query", help="Override the GitHub search query")
    parser.add_argument("--hackernews-query", "--hn-query", dest="hackernews_query", help="Override the Hacker News search query")
    parser.add_argument("--reddit-query", help="Override the Reddit search query")
    parser.add_argument("--news-query", help="Override the news RSS search query")
    parser.add_argument("--days", type=int, default=30, help="Lookback window in days")
    parser.add_argument("--limit", type=int, default=8, help="Maximum signals to return")
    parser.add_argument("--timeout", type=int, default=12, help="HTTP timeout per source")
    parser.add_argument("--source", action="append", choices=DEFAULT_SOURCES, help="Source to include")
    parser.add_argument("--emit", choices=("markdown", "json", "brief", "html"), default="markdown", help="Output format")
    parser.add_argument("--save", action="store_true", help="Save output to RECENT_RESEARCH_DIR or ~/Documents/RecentResearch")
    parser.add_argument("--save-dir", help="Directory to save the rendered output")
    parser.add_argument("--output", help="Exact file path to save the rendered output")
    parser.add_argument("--mock", action="store_true", help="Use deterministic mock evidence")
    return parser.parse_args(argv)


def main(argv: Optional[list[str]] = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    sources = args.source or list(DEFAULT_SOURCES)
    plan_doc = load_plan(args.plan)
    overrides = source_query_overrides(args)
    if args.topic == "doctor":
        return run_doctor(sources, args.timeout, args.emit)
    if not args.topic:
        comparison_entities = normalize_comparison_entities(None, args.compare)
        if len(comparison_entities) < 2:
            raise SystemExit("topic is required unless running 'doctor' or at least two --compare values")
    else:
        comparison_entities = normalize_comparison_entities(args.topic, args.compare)
    if args.days < 1:
        raise SystemExit("--days must be at least 1")
    if args.limit < 1:
        raise SystemExit("--limit must be at least 1")
    if comparison_entities:
        if len(comparison_entities) < 2:
            raise SystemExit("comparison mode requires at least two entities")
        resolved_plan = build_comparison_plan(comparison_entities, plan_doc, overrides)
        if args.show_plan:
            print(json.dumps(resolved_plan, indent=2, ensure_ascii=False, sort_keys=True))
            return 0
        report = collect_comparison(comparison_entities, args.days, sources, args.limit, args.timeout, args.mock, resolved_plan)
    else:
        resolved_plan = build_plan(args.topic, plan_doc, overrides)
        if args.show_plan:
            print(json.dumps(resolved_plan, indent=2, ensure_ascii=False, sort_keys=True))
            return 0
        report = collect(args.topic, args.days, sources, args.limit, args.timeout, args.mock, resolved_plan)
    content = render_output(report, args.emit)
    saved_path = save_output(content, report["topic"], args.emit, args.save_dir, args.output, args.save)
    print(content, end="")
    if saved_path:
        print(f"[recent-research] Saved output to {saved_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

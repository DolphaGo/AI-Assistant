---
layout: default
title: "Universal Open Market Package"
nav_order: 12
---

# Universal Open Market Package

This repository now has two layers:

1. The repository root is a marketplace/catalog repository.
2. `plugins/ai-assistant/` is the installable plugin package.

## Marketplace Files

- `marketplace.json`: neutral catalog metadata for humans, docs, and simple marketplace tooling.
- `.agents/plugins/marketplace.json`: Codex repo-scoped marketplace catalog.

## Plugin Package

`plugins/ai-assistant/` contains platform-specific entry points around the same workflows:

- Claude Code: `.claude-plugin/plugin.json`, `commands/*.md`, `skills/*/SKILL.md`
- Codex: `.codex-plugin/plugin.json`, `skills/*/SKILL.md`
- OpenCode: `.opencode/skills/*/SKILL.md`, `.opencode/commands/*.md`, `opencode.json`

The canonical skill shape is:

```text
skills/
└── skill-name/
    └── SKILL.md
```

That shape works for Codex plugins and follows the Open Agent Skills convention. OpenCode keeps a duplicate adapter under `.opencode/skills` because its project-local discovery looks there directly.

## Validation

Run:

```bash
npm run validate
```

This checks the original tutorial examples and the universal package manifests.

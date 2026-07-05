---
layout: default
title: "Universal Open Market Package"
nav_order: 12
---

# Universal Open Market Package

This repository now has two layers:

1. The repository root is a marketplace/catalog repository.
2. Each folder under `plugins/` is an installable plugin package.

## Marketplace Files

- `marketplace.json`: neutral catalog metadata for humans, docs, and simple marketplace tooling.
- `.agents/plugins/marketplace.json`: Codex repo-scoped marketplace catalog.

## Plugin Package

Each plugin package contains platform-specific entry points around the same workflows:

- Claude Code: `.claude-plugin/plugin.json`, `commands/*.md`, `skills/*/SKILL.md`
- Codex: `.codex-plugin/plugin.json`, `skills/*/SKILL.md`
- OpenCode: `.opencode/skills/*/SKILL.md`, `.opencode/commands/*.md`, `opencode.json`

Current packages:

- `plugins/hello-world/`: starter skills and utility commands.
- `plugins/workflow-continuity/`: strict workflow continuity commands for `.agent/` state, planning, progress, review, docs, handoff, resume, and ralph-style completion loops.

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

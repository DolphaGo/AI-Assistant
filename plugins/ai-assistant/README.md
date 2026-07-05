# AI-Assistant Universal Plugin

AI-Assistant is a small assistant plugin package for Claude Code, Codex, and OpenCode.

## Contents

- `skills/`: Open Agent Skills compatible `SKILL.md` folders for Codex and Claude.
- `commands/`: Claude Code slash command prompts.
- `.opencode/skills/`: OpenCode project-local skill layout.
- `.opencode/commands/`: OpenCode project-local command layout.
- `.claude-plugin/plugin.json`: Claude Code plugin manifest.
- `.codex-plugin/plugin.json`: Codex plugin manifest.
- `opencode.json`: OpenCode command config adapter.

## Claude Code

Install this folder as a Claude Code plugin:

```bash
mkdir -p ~/.claude/plugins
cp -R plugins/ai-assistant ~/.claude/plugins/ai-assistant
```

Then restart Claude Code or run `/reload-plugins`.

## Codex

The repository-level marketplace is defined at `.agents/plugins/marketplace.json`.
From this repository, restart Codex and install `ai-assistant` from the `AI-Assistant Marketplace` source.

For a personal marketplace, copy this plugin folder under `~/.codex/plugins/ai-assistant` and point `~/.agents/plugins/marketplace.json` at that folder.

## OpenCode

Copy the OpenCode adapter directories into a project or global OpenCode config:

```bash
mkdir -p .opencode
cp -R plugins/ai-assistant/.opencode/skills .opencode/skills
cp -R plugins/ai-assistant/.opencode/commands .opencode/commands
cp plugins/ai-assistant/opencode.json opencode.json
```

OpenCode also reads `.agents/skills`, so the canonical `skills/*/SKILL.md` files can be copied to `.agents/skills` when you prefer the shared agent-skill location.

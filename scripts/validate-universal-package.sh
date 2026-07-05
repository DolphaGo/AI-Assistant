#!/bin/bash

set -e

MARKETPLACE=".agents/plugins/marketplace.json"
ROOT_MARKETPLACE="marketplace.json"

echo ""
echo "📦 Validating universal plugin package..."

for file in "$ROOT_MARKETPLACE" "$MARKETPLACE"; do
  if [ ! -f "$file" ]; then
    echo "✗ Missing required file: $file"
    exit 1
  fi
  python3 -m json.tool "$file" >/dev/null
done

python3 - "$ROOT_MARKETPLACE" "$MARKETPLACE" <<'PY'
import json
import pathlib
import sys

root_catalog = json.load(open(sys.argv[1]))
codex_catalog = json.load(open(sys.argv[2]))
plugin_dirs = sorted(p.name for p in pathlib.Path("plugins").iterdir() if p.is_dir())
root_entries = sorted(plugin["name"] for plugin in root_catalog["plugins"])
codex_entries = sorted(plugin["name"] for plugin in codex_catalog["plugins"])

if root_entries != plugin_dirs:
    raise SystemExit(f"Root marketplace plugins {root_entries} do not match plugin dirs {plugin_dirs}")
if codex_entries != plugin_dirs:
    raise SystemExit(f"Codex marketplace plugins {codex_entries} do not match plugin dirs {plugin_dirs}")

for plugin in root_catalog["plugins"]:
    expected = f"./plugins/{plugin['name']}"
    if plugin.get("path") != expected:
        raise SystemExit(f"Root marketplace path mismatch for {plugin['name']}: expected {expected}, got {plugin.get('path')}")

for plugin in codex_catalog["plugins"]:
    expected = f"./plugins/{plugin['name']}"
    actual = plugin.get("source", {}).get("path")
    if actual != expected:
        raise SystemExit(f"Codex marketplace path mismatch for {plugin['name']}: expected {expected}, got {actual}")
PY

for plugin_dir in plugins/*; do
  [ -d "$plugin_dir" ] || continue
  plugin_name=$(basename "$plugin_dir")

  for file in \
    "$plugin_dir/.claude-plugin/plugin.json" \
    "$plugin_dir/.codex-plugin/plugin.json" \
    "$plugin_dir/opencode.json"; do
    if [ ! -f "$file" ]; then
      echo "✗ Missing required file: $file"
      exit 1
    fi
    python3 -m json.tool "$file" >/dev/null
  done

  codex_name=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["name"])' "$plugin_dir/.codex-plugin/plugin.json")
  if [ "$codex_name" != "$plugin_name" ]; then
    echo "✗ Plugin name mismatch in $plugin_dir/.codex-plugin/plugin.json: expected '$plugin_name', got '$codex_name'"
    exit 1
  fi

  for skill_dir in "$plugin_dir"/skills/*; do
    [ -d "$skill_dir" ] || continue
    skill_file="$skill_dir/SKILL.md"
    skill_name=$(basename "$skill_dir")

    if [ ! -f "$skill_file" ]; then
      echo "✗ Missing skill file: $skill_file"
      exit 1
    fi

    frontmatter_name=$(sed -n '/^---$/,/^---$/p' "$skill_file" | grep "^name:" | cut -d: -f2- | xargs)
    if [ "$frontmatter_name" != "$skill_name" ]; then
      echo "✗ Skill name mismatch in $skill_file: expected '$skill_name', got '$frontmatter_name'"
      exit 1
    fi
  done

  if [ ! -d "$plugin_dir/.opencode/skills" ] || [ ! -d "$plugin_dir/.opencode/commands" ]; then
    echo "✗ Missing OpenCode adapter directories in $plugin_dir"
    exit 1
  fi

  for command_file in "$plugin_dir"/commands/*.md; do
    [ -f "$command_file" ] || continue
    command_name=$(basename "$command_file" .md)
    frontmatter_name=$(sed -n '/^---$/,/^---$/p' "$command_file" | grep "^name:" | cut -d: -f2- | xargs)

    if [ "$frontmatter_name" != "$command_name" ]; then
      echo "✗ Command name mismatch in $command_file: expected '$command_name', got '$frontmatter_name'"
      exit 1
    fi

    opencode_command_file="$plugin_dir/.opencode/commands/$command_name.md"
    if [ ! -f "$opencode_command_file" ]; then
      echo "✗ Missing OpenCode command adapter: $opencode_command_file"
      exit 1
    fi

    if ! cmp -s "$command_file" "$opencode_command_file"; then
      echo "✗ OpenCode command adapter drift: $opencode_command_file differs from $command_file"
      exit 1
    fi
  done

  for skill_dir in "$plugin_dir"/skills/*; do
    [ -d "$skill_dir" ] || continue
    skill_name=$(basename "$skill_dir")
    skill_file="$skill_dir/SKILL.md"
    opencode_skill_file="$plugin_dir/.opencode/skills/$skill_name/SKILL.md"

    if [ ! -f "$opencode_skill_file" ]; then
      echo "✗ Missing OpenCode skill adapter: $opencode_skill_file"
      exit 1
    fi

    if ! cmp -s "$skill_file" "$opencode_skill_file"; then
      echo "✗ OpenCode skill adapter drift: $opencode_skill_file differs from $skill_file"
      exit 1
    fi
  done
done

echo "✓ Universal package validation passed"

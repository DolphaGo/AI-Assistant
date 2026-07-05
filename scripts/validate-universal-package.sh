#!/bin/bash

set -e

PLUGIN_DIR="plugins/ai-assistant"
MARKETPLACE=".agents/plugins/marketplace.json"
ROOT_MARKETPLACE="marketplace.json"

echo ""
echo "📦 Validating universal plugin package..."

for file in \
  "$ROOT_MARKETPLACE" \
  "$MARKETPLACE" \
  "$PLUGIN_DIR/.claude-plugin/plugin.json" \
  "$PLUGIN_DIR/.codex-plugin/plugin.json" \
  "$PLUGIN_DIR/opencode.json"; do
  if [ ! -f "$file" ]; then
    echo "✗ Missing required file: $file"
    exit 1
  fi
  python3 -m json.tool "$file" >/dev/null
done

for skill_dir in "$PLUGIN_DIR"/skills/*; do
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

if [ ! -d "$PLUGIN_DIR/.opencode/skills" ] || [ ! -d "$PLUGIN_DIR/.opencode/commands" ]; then
  echo "✗ Missing OpenCode adapter directories"
  exit 1
fi

echo "✓ Universal package validation passed"

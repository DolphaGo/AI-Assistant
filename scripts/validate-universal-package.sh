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

    while IFS= read -r resource_file; do
      relative_resource=${resource_file#"$skill_dir/"}
      opencode_resource="$plugin_dir/.opencode/skills/$skill_name/$relative_resource"

      if [ ! -f "$opencode_resource" ]; then
        echo "✗ Missing OpenCode skill resource adapter: $opencode_resource"
        exit 1
      fi

      if ! cmp -s "$resource_file" "$opencode_resource"; then
        echo "✗ OpenCode skill resource adapter drift: $opencode_resource differs from $resource_file"
        exit 1
      fi
    done < <(find "$skill_dir" -type f \
      ! -name "SKILL.md" \
      ! -path "$skill_dir/agents/*" \
      | sort)
  done
done

if [ -f "plugins/recent-research/skills/recent-research/scripts/research.py" ]; then
  recent_tmp=$(mktemp -d)
  if ! recent_output=$(python3 plugins/recent-research/skills/recent-research/scripts/research.py \
    "validator smoke" \
    --mock \
    --emit brief \
    --save-dir "$recent_tmp" 2>"$recent_tmp/stderr"); then
    cat "$recent_tmp/stderr"
    rm -rf "$recent_tmp"
    exit 1
  fi

  if ! grep -q "Recent Research: validator smoke" <<<"$recent_output"; then
    echo "✗ Recent Research smoke output missing brief title"
    rm -rf "$recent_tmp"
    exit 1
  fi

  if ! grep -q "Next checks:" <<<"$recent_output"; then
    echo "✗ Recent Research smoke output missing next checks"
    rm -rf "$recent_tmp"
    exit 1
  fi

  if ! find "$recent_tmp" -type f -name "validator-smoke-*.md" | grep -q .; then
    echo "✗ Recent Research smoke did not save a markdown artifact"
    rm -rf "$recent_tmp"
    exit 1
  fi

  recent_compare_output=$(python3 plugins/recent-research/skills/recent-research/scripts/research.py \
    "validator left vs validator right" \
    --mock \
    --emit brief \
    --limit 1)

  if ! grep -q "Recent Research Comparison: validator left vs validator right" <<<"$recent_compare_output"; then
    echo "✗ Recent Research comparison smoke output missing comparison title"
    rm -rf "$recent_tmp"
    exit 1
  fi

  if ! RECENT_RESEARCH_DIR="$recent_tmp/html" python3 plugins/recent-research/skills/recent-research/scripts/research.py \
    "validator html" \
    --mock \
    --emit html \
    --save >/dev/null 2>"$recent_tmp/html-stderr"; then
    cat "$recent_tmp/html-stderr"
    rm -rf "$recent_tmp"
    exit 1
  fi

  if ! find "$recent_tmp/html" -type f -name "validator-html-*.html" | grep -q .; then
    echo "✗ Recent Research HTML smoke did not save an HTML artifact"
    rm -rf "$recent_tmp"
    exit 1
  fi

  recent_plan_output=$(python3 plugins/recent-research/skills/recent-research/scripts/research.py \
    "validator plan" \
    --show-plan \
    --github-query "validator github")

  if ! grep -q '"github": "validator github"' <<<"$recent_plan_output"; then
    echo "✗ Recent Research query plan smoke output missing GitHub override"
    rm -rf "$recent_tmp"
    exit 1
  fi

  recent_json_output=$(python3 plugins/recent-research/skills/recent-research/scripts/research.py \
    "validator json" \
    --mock \
    --emit json)

  if ! python3 -c 'import json,sys; data=json.load(sys.stdin); assert "deduped_count" in data; assert data["ranking"] == "source-balanced"' <<<"$recent_json_output"; then
    echo "✗ Recent Research JSON output missing dedupe or ranking metadata"
    rm -rf "$recent_tmp"
    exit 1
  fi

  if ! python3 - <<'PY'
import importlib.util
import sys
from pathlib import Path

path = Path("plugins/recent-research/skills/recent-research/scripts/research.py")
spec = importlib.util.spec_from_file_location("recent_research", path)
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules[spec.name] = module
spec.loader.exec_module(module)
signals = [
    module.Signal("news", "Same Title", "https://example.com/a?utm_source=x", "2026-01-01"),
    module.Signal("reddit", "Same Title", "https://example.com/a", "2026-01-01"),
    module.Signal("github", "Different Title", "https://example.com/b", "2026-01-01"),
]
deduped, dropped = module.dedupe_signals(signals)
assert len(deduped) == 2
assert dropped == 1
ranked = module.rank_signals([
    module.Signal("github", "Repo 1", "https://example.com/repo1", "2026-01-01", score=100),
    module.Signal("github", "Repo 2", "https://example.com/repo2", "2026-01-01", score=90),
    module.Signal("news", "News 1", "https://example.com/news1", "2026-01-01"),
], 2)
assert [signal.source for signal in ranked] == ["github", "news"]
PY
  then
    echo "✗ Recent Research ranking/dedupe smoke failed"
    rm -rf "$recent_tmp"
    exit 1
  fi

  recent_npm_output=$(npm run -s recent-research -- \
    "validator npm" \
    --mock \
    --emit brief)

  if ! grep -q "Recent Research: validator npm" <<<"$recent_npm_output"; then
    echo "✗ Recent Research npm entrypoint smoke output missing brief title"
    rm -rf "$recent_tmp"
    exit 1
  fi

  rm -rf "$recent_tmp"
fi

echo "✓ Universal package validation passed"

#!/bin/bash

set -e

# 색상 정의
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

CLAUDE_DIR="$HOME/.claude"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGINS_SOURCE_DIR="$REPO_DIR/plugins"

echo -e "${BLUE}════════════════════════════════════════${NC}"
echo -e "${BLUE}   AI-Assistant Marketplace Uninstaller${NC}"
echo -e "${BLUE}════════════════════════════════════════${NC}"
echo ""

# 확인 메시지
echo -e "${YELLOW}This will remove AI-Assistant marketplace plugins from Claude Code.${NC}"
echo -e "${YELLOW}Your repository files will NOT be deleted.${NC}"
echo ""
read -p "Are you sure you want to uninstall? (y/n): " -n 1 -r
echo

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}Uninstallation cancelled${NC}"
    exit 0
fi

# 제거
echo ""
echo -e "${BLUE}🗑  Removing plugin...${NC}"

removed=false
for plugin_source_dir in "$PLUGINS_SOURCE_DIR"/*; do
    [ -d "$plugin_source_dir" ] || continue
    plugin_name="$(basename "$plugin_source_dir")"
    plugin_dir="$CLAUDE_DIR/plugins/$plugin_name"

    if [ ! -L "$plugin_dir" ] && [ ! -d "$plugin_dir" ]; then
        echo -e "${YELLOW}⚠ $plugin_name is not installed${NC}"
        continue
    fi

    if rm -rf "$plugin_dir"; then
        echo -e "${GREEN}✓ Removed $plugin_name${NC}"
        removed=true
    else
        echo -e "${RED}✗ Failed to remove $plugin_name${NC}"
        exit 1
    fi
done

if [ "$removed" = false ]; then
    echo -e "${YELLOW}No AI-Assistant marketplace plugins were installed${NC}"
fi

echo ""
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo -e "${GREEN}✓ Uninstallation complete!${NC}"
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo ""
echo -e "${YELLOW}To reinstall, run:${NC} ./install.sh"
echo ""

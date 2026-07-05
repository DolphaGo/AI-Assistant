#!/bin/bash

set -e

# 색상 정의
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

CLAUDE_DIR="$HOME/.claude"
PLUGIN_DIR="$CLAUDE_DIR/plugins/ai-assistant"

echo -e "${BLUE}════════════════════════════════════════${NC}"
echo -e "${BLUE}   AI-Assistant Plugin Uninstaller${NC}"
echo -e "${BLUE}════════════════════════════════════════${NC}"
echo ""

# 설치 확인
if [ ! -L "$PLUGIN_DIR" ] && [ ! -d "$PLUGIN_DIR" ]; then
    echo -e "${YELLOW}⚠ AI-Assistant is not installed${NC}"
    exit 0
fi

# 확인 메시지
echo -e "${YELLOW}This will remove the AI-Assistant plugin.${NC}"
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

if rm -rf "$PLUGIN_DIR"; then
    echo -e "${GREEN}✓ Plugin removed successfully${NC}"
else
    echo -e "${RED}✗ Failed to remove plugin${NC}"
    exit 1
fi

echo ""
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo -e "${GREEN}✓ Uninstallation complete!${NC}"
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo ""
echo -e "${YELLOW}To reinstall, run:${NC} ./install.sh"
echo ""

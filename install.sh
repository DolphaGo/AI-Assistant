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
echo -e "${BLUE}   AI-Assistant Marketplace Installer${NC}"
echo -e "${BLUE}════════════════════════════════════════${NC}"
echo ""

# 1. validate.sh 실행
echo -e "${BLUE}🔍 Step 1/4: Validating files...${NC}"
if [ -f "$REPO_DIR/validate.sh" ] && [ -f "$REPO_DIR/scripts/validate-universal-package.sh" ]; then
    cd "$REPO_DIR"
    if ! ./validate.sh || ! ./scripts/validate-universal-package.sh; then
        echo -e "${RED}✗ Validation failed. Please fix the errors and try again.${NC}"
        exit 1
    fi
else
    echo -e "${RED}✗ Validation scripts not found${NC}"
    exit 1
fi
echo ""

# 2. Claude Code 설치 확인
echo -e "${BLUE}🔍 Step 2/4: Checking Claude Code installation...${NC}"
if [ ! -d "$CLAUDE_DIR" ]; then
    echo -e "${RED}✗ Claude Code not found${NC}"
    echo -e "${YELLOW}Please install Claude Code first:${NC}"
    echo -e "  https://claude.ai/code"
    exit 1
fi
echo -e "${GREEN}✓ Claude Code found${NC}"
echo ""

# 3. plugins 디렉토리 생성
echo -e "${BLUE}🔍 Step 3/4: Preparing plugin directory...${NC}"
mkdir -p "$CLAUDE_DIR/plugins"
echo -e "${GREEN}✓ Plugin directory ready${NC}"
echo ""

# 4. 심볼릭 링크 생성
echo -e "${BLUE}🔗 Step 4/4: Creating symbolic links...${NC}"

for plugin_source_dir in "$PLUGINS_SOURCE_DIR"/*; do
    [ -d "$plugin_source_dir" ] || continue
    plugin_name="$(basename "$plugin_source_dir")"
    plugin_dir="$CLAUDE_DIR/plugins/$plugin_name"

    if [ -L "$plugin_dir" ] || [ -d "$plugin_dir" ]; then
        echo -e "${YELLOW}⚠ Existing installation found at: $plugin_dir${NC}"
        read -p "Do you want to update $plugin_name? (y/n): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            echo -e "${YELLOW}Skipping $plugin_name${NC}"
            continue
        fi
        echo -e "${YELLOW}Removing old installation for $plugin_name...${NC}"
        rm -rf "$plugin_dir"
    fi

    if ln -s "$plugin_source_dir" "$plugin_dir"; then
        echo -e "${GREEN}✓ Symbolic link created: $plugin_dir → $plugin_source_dir${NC}"
    else
        echo -e "${RED}✗ Failed to create symbolic link for $plugin_name${NC}"
        echo -e "${YELLOW}Try running with appropriate permissions${NC}"
        exit 1
    fi
done
echo ""

# 5. 설치 완료 메시지
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo -e "${GREEN}✓ Installation complete!${NC}"
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo ""
echo -e "${BLUE}📚 Available skills and commands:${NC}"
echo ""

for plugin_source_dir in "$PLUGINS_SOURCE_DIR"/*; do
    [ -d "$plugin_source_dir" ] || continue
    plugin_name="$(basename "$plugin_source_dir")"
    echo -e "${YELLOW}$plugin_name:${NC}"
    if [ -d "$plugin_source_dir/skills" ]; then
        find "$plugin_source_dir/skills" -name "SKILL.md" -type f -exec dirname {} \; | xargs -n 1 basename | sed 's/^/  skill: /' || true
    fi
    if [ -d "$plugin_source_dir/commands" ]; then
        find "$plugin_source_dir/commands" -name "*.md" -type f -exec basename {} .md \; | sed 's/^/  command: /' || true
    fi
    echo ""
done

echo -e "${BLUE}📖 Next steps:${NC}"
echo "  1. Restart Claude Code (if running)"
echo "  2. Try: /hello-world:status-check"
echo "  3. Try: /wf-plan"
echo "  4. Explore your installed skills and commands"
echo ""

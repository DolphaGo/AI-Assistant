# Hello World Universal Plugin

Hello World는 Claude Code, Codex, OpenCode에서 함께 사용할 수 있는 입문용 플러그인 패키지입니다.

## Contents

- `skills/`: Codex와 Claude에서 사용하는 Open Agent Skills 호환 `SKILL.md` 폴더입니다.
- `commands/`: Claude Code slash command prompt입니다.
- `.opencode/skills/`: OpenCode project-local skill layout입니다.
- `.opencode/commands/`: OpenCode project-local command layout입니다.
- `.claude-plugin/plugin.json`: Claude Code plugin manifest입니다.
- `.codex-plugin/plugin.json`: Codex plugin manifest입니다.
- `opencode.json`: OpenCode command config adapter입니다.

## Claude Code

이 폴더를 Claude Code 플러그인으로 설치합니다.

```bash
mkdir -p ~/.claude/plugins
cp -R plugins/hello-world ~/.claude/plugins/hello-world
```

그다음 Claude Code를 재시작하거나 `/reload-plugins`를 실행합니다.

## Codex

저장소 단위 마켓플레이스는 `.agents/plugins/marketplace.json`에 정의되어 있습니다.
이 저장소에서 Codex를 재시작한 뒤 `AI-Assistant Marketplace` source에서 `hello-world`를 설치합니다.

개인 마켓플레이스로 쓰려면 이 플러그인 폴더를 `~/.codex/plugins/hello-world` 아래에 복사하고, `~/.agents/plugins/marketplace.json`이 그 폴더를 가리키게 설정합니다.

## OpenCode

OpenCode adapter 디렉토리를 프로젝트 또는 global OpenCode config로 복사합니다.

```bash
mkdir -p .opencode
cp -R plugins/hello-world/.opencode/skills .opencode/skills
cp -R plugins/hello-world/.opencode/commands .opencode/commands
cp plugins/hello-world/opencode.json opencode.json
```

OpenCode는 `.agents/skills`도 읽습니다. 여러 agent가 공유하는 skill 위치를 선호한다면 표준 `skills/*/SKILL.md` 파일을 `.agents/skills`로 복사해서 사용할 수 있습니다.

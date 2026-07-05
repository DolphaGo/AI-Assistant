---
layout: default
title: "Universal Open Market Package"
nav_order: 12
---

# Universal Open Market Package

이 저장소는 두 계층으로 구성됩니다.

1. 저장소 루트는 마켓플레이스/catalog 저장소입니다.
2. `plugins/` 아래의 각 폴더는 설치 가능한 플러그인 패키지입니다.

## Marketplace Files

- `marketplace.json`: 사람, 문서, 간단한 마켓플레이스 도구가 함께 볼 수 있는 범용 catalog 메타데이터입니다.
- `.agents/plugins/marketplace.json`: Codex가 이 저장소 안에서 사용하는 repo-scoped 마켓플레이스 catalog입니다.

## Plugin Package

각 플러그인 패키지는 같은 workflow를 여러 플랫폼에서 사용할 수 있도록 플랫폼별 entry point를 포함합니다.

- Claude Code: `.claude-plugin/plugin.json`, `commands/*.md`, `skills/*/SKILL.md`
- Codex: `.codex-plugin/plugin.json`, `skills/*/SKILL.md`
- OpenCode: `.opencode/skills/*/SKILL.md`, `.opencode/commands/*.md`, `opencode.json`

현재 패키지:

- `plugins/hello-world/`: 입문용 skills와 utility commands를 모은 예제 플러그인입니다.
- `plugins/workflow/`: `.agent/` 상태, plan, progress, review, docs, handoff, resume, ralph-style completion loop를 다루는 workflow 플러그인입니다.

표준 skill 구조는 다음과 같습니다.

```text
skills/
└── skill-name/
    └── SKILL.md
```

이 구조는 Codex 플러그인에서 동작하며 Open Agent Skills 관례를 따릅니다. OpenCode는 project-local discovery에서 `.opencode/skills`를 직접 보기 때문에 같은 내용을 `.opencode/skills` 아래 adapter로 한 번 더 둡니다.

## Validation

다음 명령을 실행합니다.

```bash
npm run validate
```

이 명령은 기존 튜토리얼 예제와 범용 패키지 manifest를 함께 검증합니다.

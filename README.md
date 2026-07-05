# AI-Assistant

Claude Code를 위한 플러그인 예제 및 학습 가이드입니다.

## 📚 학습 가이드

이 저장소는 Claude Code 플러그인을 만드는 방법을 단계별로 배울 수 있는 튜토리얼을 포함합니다.

### 온라인 문서

[https://dolphago.github.io/AI-Assistant/](https://dolphago.github.io/AI-Assistant/)

### 로컬에서 보기

```bash
cd docs
bundle exec jekyll serve
```

## 🎯 무엇을 배우나요?

### 핵심 개념
먼저 Skills와 Plugins 시스템의 전체 그림을 이해하세요:
- Skills vs Plugins
- Skills가 있는 위치와 범위
- Frontmatter 필드 이해
- 네임스페이스와 우선순위
- Plugin 배포 방법

### 기초 실습
각 단계는 **하나의 핵심 개념**에 집중합니다.

**Step 1: 첫 번째 Skill (10분)**
- 개인 Skill 만들기 (`~/.claude/skills/`)
- Skill 파일 구조 (`skills/<name>/SKILL.md`)
- Frontmatter와 description 작성
- 첫 번째 Skill 실행

**Step 2: Git Skill (10분)**
- Git 명령어를 실행하는 Skill
- Claude에게 명령어 실행 지침 작성
- 출력 형식 지정
- 에러 처리 (사전 확인)

**Step 3: 수동 Skill (10분)**
- `disable-model-invocation` 사용
- 사용자만 실행 가능한 Skill
- 위험한 작업 제어
- 수동 실행 패턴

**Step 4: 환경 변수와 API (15분)**
- 환경 변수가 필요한 이유
- 환경 변수 설정 방법
- API 호출 기본
- 토큰 안전하게 관리하기

**Step 5: 검색 Skill (10분)**
- Claude Code의 내장 도구 이해
- Grep 도구 사용
- 도구 사용 지침 작성
- 검색 결과 포맷팅

**Step 6: 플러그인 배포 (10분)**
- Git 저장소로 공유
- plugin.json 작성
- 팀원 설치 가이드
- 업데이트 방법

### 고급 개념
복잡한 통합과 자동화를 위한 고급 기능들:

**고급 1: MCP 서버 (20분)**
- Model Context Protocol 이해
- 외부 시스템 연결
- 데이터베이스, API 통합

**고급 2: Hooks (15분)**
- 이벤트 기반 자동화
- 워크플로우 자동화
- Pre/Post 도구 실행

**고급 3: Channels (15분)**
- 외부 이벤트 수신
- Webhook 통합
- 실시간 알림

**고급 4: Scheduled Tasks (15분)**
- 정기 작업 예약
- Cron 표현식
- 자동 리포트 생성

**고급 5: Headless 모드 (20분)**
- 프로그래밍 방식 실행
- CI/CD 통합
- 배치 처리

**고급 6: Sub-agents (20분)**
- 작업 위임
- 전문화된 에이전트
- 병렬 처리

**고급 7: Agent Teams (20분)**
- 여러 세션 조율
- 대규모 작업 분산
- 협업 패턴

**고급 8: Troubleshooting (15분)**
- 일반적인 문제 해결
- 디버깅 도구
- 성능 최적화

## 📦 설치

이 저장소를 플러그인으로 직접 사용하려면:

```bash
git clone https://github.com/DolphaGo/AI-Assistant.git
cd AI-Assistant
./install.sh
```

변경사항 적용:

```bash
# Claude 내에서
/reload-plugins

# 또는 재시작 (Ctrl+D 후)
claude
```

## 🧩 범용 오픈마켓 패키지

Claude Code, Codex, OpenCode에서 재사용할 수 있는 배포용 플러그인 패키지는 `plugins/` 아래에 있습니다.

- Marketplace: `.agents/plugins/marketplace.json`
- Hello World: `plugins/hello-world/`
- Workflow Continuity: `plugins/workflow-continuity/`

자세한 구조는 [Universal Open Market Package](docs/universal-openmarket.md)를 참고하세요.

## 🗂️ 디렉토리 구조

```
ai-assistant/
├── .claude-plugin/
│   └── plugin.json       # 플러그인 메타데이터
├── .agents/
│   └── plugins/
│       └── marketplace.json  # Codex repo-scoped marketplace
├── marketplace.json      # 범용 catalog 메타데이터
├── plugins/
│   ├── hello-world/          # Claude/Codex/OpenCode 배포용 예제 플러그인 패키지
│   └── workflow-continuity/  # 작업 연속성 workflow 플러그인 패키지
├── skills/
│   └── examples/         # 예제 skills
├── templates/            # Skill 템플릿
└── docs/                 # Jekyll 문서
    ├── step-00-before-start.md    # 시작하기 전에
    ├── step-01-first-skill.md     # 첫 번째 Skill
    ├── step-02-git-skill.md       # Git Skill
    ├── step-03-command.md         # 수동 Skill
    ├── step-04-jira-skill.md      # 환경 변수와 API
    ├── step-05-search-tool.md     # 검색 Skill
    └── step-06-publish.md         # 플러그인 배포
```

## 🚀 빠른 시작

### 예제 Skill 사용

```bash
# Claude 재시작 후
/hello-world:status-check
/hello-world:api-tester
/wf-plan
/wf-ralph
```

### Workflow Continuity 사용 흐름

`workflow-continuity`는 작업 상태를 repo-local `.agent/`에 남깁니다. `.agent/`는 기본적으로 git에 포함해 다음 에이전트와 체크아웃에서도 같은 상태를 이어받습니다.

```text
시작: /wf-resume → /wf-plan
진행: 개발 → /wf-progress → 테스트 → /wf-review
정리: /wf-docs → /wf-handoff
자동 반복: /wf-ralph
```

- `/wf-plan`: 애매함을 질문으로 해소하고 검증 가능한 계획을 만듭니다.
- `/wf-progress`: 변경, 검증, blocker, 다음 단계를 기록합니다.
- `/wf-review`: 완료 주장 전에 검증 결과와 품질을 확인합니다.
- `/wf-docs`: 확정된 지식은 `.agent/DOCS.md`에 기록하고, `CONTEXT.md`/ADR 승격은 사용자 확인 후 진행합니다.
- `/wf-handoff`: 다음 에이전트가 바로 이어받을 수 있게 현재 상태를 압축합니다.
- `/wf-ralph`: 목표 완료까지 strict loop를 반복하되 애매함, 계획 이탈, 위험 작업, 검증 실패에서는 멈추고 확인받습니다.

### 자신의 Skill 만들기

```bash
# 템플릿 복사
cp templates/skill-template.md skills/my-skill/SKILL.md

# 편집
vim skills/my-skill/SKILL.md

# 변경사항 적용
/reload-plugins
```

## 📖 핵심 개념

### Skill 구조

```
skills/
└── skill-name/         ← 디렉토리 이름 = skill 이름
    └── SKILL.md        ← 파일명은 대문자 필수
```

### SKILL.md 형식

```markdown
---
description: Claude가 언제 사용할지 판단하는 설명
disable-model-invocation: true  # 선택 (수동 실행 전용)
---

Claude에게 주는 지침...
```

### 네임스페이스

- 플러그인 skill: `/플러그인이름:skill이름`
- 개인 skill (`~/.claude/skills/`): `/skill이름`

### 학습 진행 방식

이 튜토리얼은 **점진적 학습**을 위해 설계되었습니다:
- 각 단계는 하나의 핵심 개념에 집중
- 이전 단계의 지식 위에 새 개념 추가
- 단순한 예제로 시작해서 점차 확장

## 🤝 기여

Pull Request 환영합니다!

1. Fork
2. 브랜치 생성 (`git checkout -b feature/my-skill`)
3. 커밋 (`git commit -m "feat: add my-skill"`)
4. 푸시 (`git push origin feature/my-skill`)
5. PR 생성

## 📄 라이선스

MIT

## 🔗 관련 링크

- [Claude Code 공식 문서](https://code.claude.com/docs)
- [Claude Code Skills 가이드](https://code.claude.com/docs/ko/skills)
- [플러그인 만들기](https://code.claude.com/docs/ko/plugins)

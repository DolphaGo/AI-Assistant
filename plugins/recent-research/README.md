# recent-research 사용 가이드

`recent-research`는 최근 공개 시그널을 수집해 짧은 근거 기반 리서치 브리프를 만드는 제품형 스킬 패키지입니다. 단순 검색 결과를 길게 나열하는 대신, 소스 상태, 강한 시그널, 빈틈, 다음 검증 항목을 함께 보여주는 것을 목표로 합니다.

## 바로 사용할 수 있나요?

현재 패키지는 바로 가져와서 사용할 수 있는 수준입니다.

- Claude Code용 매니페스트: `.claude-plugin/plugin.json`
- Codex용 매니페스트: `.codex-plugin/plugin.json`
- OpenCode용 설정: `opencode.json`, `.opencode/`
- 스킬 본문: `skills/recent-research/SKILL.md`
- 실행 스크립트: `skills/recent-research/scripts/research.py`

`npm run validate` 기준으로 패키지 구조, OpenCode 복사본 불일치 검사, 기본 실행 검사가 통과해야 합니다.

## 참고한 프로젝트

이 스킬은 [mvanhorn/last30days-skill](https://github.com/mvanhorn/last30days-skill)의 제품 방향을 참고했습니다. 해당 프로젝트는 `/last30days` 명령으로 Reddit, X, YouTube, Hacker News, Polymarket, web 같은 여러 공개 시그널을 탐색하고 근거 기반 요약을 만드는 AI agent skill입니다.

`recent-research`는 원본을 복제한 것이 아니라, 다음 방향만 참고해 이 저장소의 범용 플러그인 구조에 맞게 별도로 구현했습니다.

- 최근 기간의 공개 시그널을 먼저 수집한 뒤 요약한다.
- 단일 검색 결과보다 여러 소스의 반응을 함께 본다.
- 근거, 해석, 빈틈을 분리해 리서치 결과를 작성한다.
- 스킬로 import해서 반복 사용할 수 있게 패키징한다.

현재 구현은 API 키 없이 바로 동작하는 GitHub, Hacker News, Reddit, Google News RSS 중심의 경량 collector입니다. X, YouTube, Polymarket 같은 인증 또는 별도 설정이 필요한 소스는 아직 포함하지 않았습니다.

## 어떤 기능을 하나요?

- GitHub 저장소와 이슈 활동을 조회합니다.
- Hacker News 글과 댓글 시그널을 조회합니다.
- Reddit 공개 검색 결과를 조회합니다.
- Google News RSS로 최근 뉴스 헤드라인을 조회합니다.
- `A vs B` 형식의 비교 리포트를 만듭니다.
- 소스별 query override와 JSON plan을 지원합니다.
- `brief`, `markdown`, `json`, `html` 출력 형식을 지원합니다.
- `--save`, `--save-dir`, `--output`으로 결과 파일을 저장합니다.
- `doctor`로 소스 접근 가능 여부를 점검합니다.
- `next_checks`로 답변 전에 확인해야 할 후속 검증 항목을 제공합니다.

## 기본 사용법

Skill 명령으로 사용할 때:

```bash
/recent-research OpenTelemetry
/recent-research Codex vs Cursor
/recent-research Supabase vs Neon 최근 개발자 반응
```

스크립트를 직접 실행할 때:

```bash
npm run recent-research -- "OpenTelemetry" --days 30 --emit brief

cd plugins/recent-research/skills/recent-research
python3 scripts/research.py "OpenTelemetry" --days 30 --emit brief
```

소스 상태를 진단할 때:

```bash
python3 scripts/research.py doctor
```

## 비교 리서치

다음 두 방식 모두 지원합니다.

```bash
python3 scripts/research.py "Codex vs Cursor" --days 30 --emit brief
python3 scripts/research.py --compare Codex --compare Cursor --days 30 --emit brief
```

비교 결과는 대상별 소스 상태, 대표 시그널, 빈틈, 다음 검증 항목을 분리해서 보여줍니다.

## 출력 형식

```bash
python3 scripts/research.py "OpenTelemetry" --emit brief
python3 scripts/research.py "OpenTelemetry" --emit markdown
python3 scripts/research.py "OpenTelemetry" --emit json
python3 scripts/research.py "OpenTelemetry" --emit html
```

- `brief`: 사람이 바로 읽기 좋은 짧은 브리프
- `markdown`: 근거 목록을 더 자세히 담은 마크다운
- `json`: 자동화나 후처리에 쓰기 좋은 구조화 데이터
- `html`: 공유 가능한 단일 HTML 리포트

## 파일 저장

기본 저장 위치는 `RECENT_RESEARCH_DIR`이 있으면 그 경로를 쓰고, 없으면 `~/Documents/RecentResearch`를 씁니다.

```bash
python3 scripts/research.py "OpenTelemetry" --emit html --save
python3 scripts/research.py "OpenTelemetry" --emit markdown --save-dir /tmp/research
python3 scripts/research.py "OpenTelemetry" --emit json --output /tmp/opentelemetry.json
```

## 쿼리 튜닝

기본 쿼리가 너무 넓거나 소스마다 이름이 다를 때는 소스별 덮어쓰기를 사용합니다.

```bash
python3 scripts/research.py "OpenTelemetry" --show-plan
python3 scripts/research.py "OpenTelemetry" \
  --github-query "open-telemetry opentelemetry" \
  --hn-query "OpenTelemetry" \
  --reddit-query "OpenTelemetry" \
  --news-query "OpenTelemetry"
```

JSON 계획 파일도 사용할 수 있습니다.

```json
{
  "queries": {
    "github": "open-telemetry opentelemetry",
    "hackernews": "OpenTelemetry",
    "reddit": "OpenTelemetry",
    "news": "OpenTelemetry"
  },
  "notes": ["GitHub에서는 공식 org와 프로젝트 표기를 우선 확인한다."]
}
```

```bash
python3 scripts/research.py "OpenTelemetry" --plan /tmp/recent-research-plan.json
```

## 결과 해석 기준

이 Skill의 결과는 최종 결론이 아니라 근거 스캐폴드입니다.

- `Sources checked`에서 어떤 소스가 성공했는지 먼저 봅니다.
- `Deduped`가 표시되면 URL 또는 제목 기준으로 중복 후보가 제거된 것입니다.
- `Strongest signals`는 최근 공개 반응의 후보 근거입니다.
- `My read`는 근거에서 나온 해석이므로 사실과 구분해서 봅니다.
- `Gaps`는 소스 실패, 빈 결과, 얇은 증거를 보여줍니다.
- `Next checks`는 더 강한 주장이나 추천 전에 확인해야 할 최소 후속 작업입니다.

뉴스, Reddit, Hacker News 시그널은 공개 헤드라인과 커뮤니티 반응에 가깝습니다. 중요한 주장은 공식 문서, 릴리스 노트, 회사 블로그, GitHub 원문 같은 1차 출처로 다시 확인해야 합니다.

## 검증

패키지를 수정한 뒤에는 저장소 루트에서 검증합니다.

```bash
npm run validate
```

개별 스크립트만 빠르게 확인할 때:

```bash
python3 -m py_compile plugins/recent-research/skills/recent-research/scripts/research.py
python3 plugins/recent-research/skills/recent-research/scripts/research.py "validator smoke" --mock --emit brief
```

## 아직 개선하면 좋은 점

- 소스별 요청 제한과 실패 원인을 더 세분화해서 표시하기
- 실제 가져오기 후 Claude Code, Codex, OpenCode 각각에서 끝까지 실행한 검증 기록 남기기
- 공식 문서나 릴리스 노트를 우선 조회하는 1차 출처 수집기 추가하기

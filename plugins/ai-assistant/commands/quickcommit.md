---
name: quickcommit
description: 스테이징부터 커밋까지 한 번에 처리하는 빠른 커밋
aliases: [qc, qcommit]
---

# Quick Commit Command

## 목적
변경사항을 빠르게 스테이징하고 의미있는 커밋 메시지를 자동 생성하여 커밋하는 command입니다. 반복적인 git 명령어 입력을 줄여줍니다.

## 사용법
```
/quickcommit [메시지]
/qc [메시지]
```

## 파라미터
- `메시지` (선택): 커밋 메시지. 생략 시 변경 내용 기반 자동 생성

## 동작 방식

### 1. 변경사항 분석
- `git status`로 변경된 파일 확인
- 파일 타입별 분류 (코드, 설정, 문서)
- 변경 규모 판단 (라인 수)

### 2. 자동 메시지 생성 (메시지 미제공 시)
```
변경 패턴 분석:
- 새 파일 추가 → "feat: {파일명} 추가"
- 파일 수정 → "fix: {파일명} 버그 수정" 또는 "refactor: {파일명} 개선"
- 파일 삭제 → "chore: {파일명} 제거"
- 문서 변경 → "docs: {파일명} 문서 업데이트"
- 설정 변경 → "chore: {설정명} 설정 업데이트"
```

### 3. 스테이징 및 커밋
```bash
git add -A
git commit -m "생성된 메시지"
```

### 4. 확인 메시지 출력
```
✓ 커밋 완료: abc1234
  3 files changed, 45 insertions(+), 12 deletions(-)
```

## 예제

### 기본 사용 (자동 메시지)
```
/quickcommit
```
**실행:**
```bash
# 변경사항 분석
git status --short
# M  src/auth.js
# A  src/utils.js
# ?? README.md

# 자동 생성된 메시지로 커밋
git add -A
git commit -m "feat: auth 및 utils 모듈 구현"
```
**출력:**
```
✓ 커밋 완료: a1b2c3d
  파일: 3개 변경
  추가: 45줄, 삭제: 12줄
  메시지: feat: auth 및 utils 모듈 구현
```

### 메시지 직접 지정
```
/qc fix: 로그인 버그 수정
```
**출력:**
```
✓ 커밋 완료: d4e5f6g
  파일: 1개 변경
  추가: 5줄, 삭제: 3줄
  메시지: fix: 로그인 버그 수정
```

### 타입별 자동 감지
```
# 케이스 1: 새 기능
변경: src/payment.js (new)
→ "feat: payment 모듈 추가"

# 케이스 2: 문서
변경: README.md, docs/api.md
→ "docs: 문서 업데이트"

# 케이스 3: 설정
변경: package.json, .eslintrc
→ "chore: 프로젝트 설정 업데이트"

# 케이스 4: 혼합
변경: src/*.js, test/*.js
→ "feat: 기능 구현 및 테스트 추가"
```

## 커밋 메시지 컨벤션

### Conventional Commits 자동 적용
```
feat: 새로운 기능
fix: 버그 수정
docs: 문서 변경
style: 코드 포맷팅 (기능 변경 없음)
refactor: 코드 리팩토링
test: 테스트 추가/수정
chore: 빌드, 설정 변경
```

### 스코프 자동 추가
```
파일 경로에서 스코프 추출:
- src/auth/login.js → feat(auth): ...
- components/Button.tsx → feat(Button): ...
- docs/api/users.md → docs(api): ...
```

## 스마트 기능

### 1. 변경 규모에 따른 메시지
```javascript
// 작은 변경 (< 10줄)
"fix: 사소한 버그 수정"

// 중간 변경 (10-100줄)
"feat: 기능 구현"

// 큰 변경 (> 100줄)
"feat: 주요 기능 대폭 개선"
```

### 2. 파일 패턴 인식
```javascript
// 테스트 파일 감지
*.test.js, *.spec.js → "test: ..."

// 스타일 파일
*.css, *.scss → "style: ..."

// 설정 파일
package.json, tsconfig.json → "chore: ..."
```

### 3. 안전 장치
```bash
# 변경사항 없으면 경고
if [ -z "$(git status --short)" ]; then
  echo "❌ 커밋할 변경사항이 없습니다"
  exit 1
fi

# 대량 변경 경고 (>50 files)
file_count=$(git status --short | wc -l)
if [ $file_count -gt 50 ]; then
  echo "⚠️  변경 파일이 많습니다 ($file_count개). 계속하시겠습니까? (y/N)"
  read -r confirm
  [ "$confirm" != "y" ] && exit 1
fi
```

## 에러 처리
- **변경사항 없음**: `❌ 커밋할 파일이 없습니다`
- **충돌 발생**: `❌ 병합 충돌이 있습니다. 먼저 해결하세요`
- **커밋 실패**: `❌ 커밋에 실패했습니다: {에러 메시지}`
- **대량 변경**: `⚠️  50개 이상 파일 변경. 확인 필요`

## 고급 옵션

### Dry-run 모드
```
/quickcommit --dry-run
```
실제 커밋 없이 메시지만 미리보기

### 대화형 모드
```
/quickcommit -i
```
파일별로 스테이징 여부 선택

### Amend 모드
```
/quickcommit --amend
```
마지막 커밋에 변경사항 추가

## 관련 Commands
- `/commit`: 표준 git commit (수동 메시지)
- `/snapshot`: 임시 저장 (WIP 커밋)
- `/undo`: 마지막 커밋 취소

## 주의사항
- **민감 정보**: .env, credentials 등 자동 제외 (.gitignore 확인)
- **pre-commit hook**: 린트/테스트 실패 시 커밋 차단될 수 있음
- **리뷰 필요**: 중요 변경은 자동 메시지보다 수동 작성 권장
- **브랜치 확인**: main/master 직접 커밋 경고

## 구현 예시

```bash
#!/bin/bash
# quickcommit.sh

set -e

# 변경사항 확인
if [ -z "$(git status --short)" ]; then
  echo "❌ 변경사항이 없습니다"
  exit 1
fi

# 메시지 생성
if [ -z "$1" ]; then
  # 자동 메시지 생성 로직
  changed_files=$(git status --short | awk '{print $2}')
  
  # 파일 타입 분석
  if echo "$changed_files" | grep -q "\.md$"; then
    msg_type="docs"
  elif echo "$changed_files" | grep -q "\.test\|\.spec"; then
    msg_type="test"
  elif echo "$changed_files" | grep -q "package\.json\|\.config"; then
    msg_type="chore"
  else
    msg_type="feat"
  fi
  
  message="$msg_type: 변경사항 커밋"
else
  message="$1"
fi

# 커밋 실행
git add -A
commit_hash=$(git commit -m "$message" | grep -o '[0-9a-f]\{7\}' | head -1)

# 결과 출력
echo "✓ 커밋 완료: $commit_hash"
git show --stat $commit_hash | tail -n 1
```

## 확장 아이디어
- AI로 diff 분석하여 더 정확한 메시지 생성
- 팀 커밋 컨벤션 자동 적용
- Jira 티켓 번호 자동 추가
- Emoji 컨벤션 지원 (✨ feat, 🐛 fix)

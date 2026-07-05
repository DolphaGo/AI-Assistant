---
name: cleanup
description: 프로젝트 정리 자동화 - 임시파일, node_modules, 캐시 제거
aliases: [clean, clear]
---

# Cleanup Command

## 목적
개발 중 쌓인 불필요한 파일들을 안전하게 제거하여 프로젝트를 깔끔하게 유지합니다. 디스크 공간 확보와 빌드 이슈 해결에 유용합니다.

## 사용법
```
/cleanup [옵션]
/clean [옵션]
```

## 옵션
- `--all, -a`: 모든 정리 작업 수행 (의존성 재설치 포함)
- `--deps, -d`: node_modules, package-lock.json 제거 후 재설치
- `--cache, -c`: 빌드 캐시 및 임시 파일만 제거
- `--dry-run`: 실제 삭제 없이 대상 파일만 표시
- `--force, -f`: 확인 없이 바로 실행

## 정리 대상

### 1. 빌드 결과물
```
dist/
build/
out/
.next/
.nuxt/
target/
```

### 2. 캐시 디렉토리
```
.cache/
.parcel-cache/
.webpack/
.turbo/
.vite/
node_modules/.cache/
```

### 3. 임시 파일
```
*.log
*.tmp
.DS_Store
Thumbs.db
.env.local
coverage/
```

### 4. 의존성 (옵션)
```
node_modules/
package-lock.json
yarn.lock
pnpm-lock.yaml
```

## 동작 방식

### 1. 프로젝트 타입 감지
```bash
# Node.js 프로젝트
if [ -f "package.json" ]; then
  targets="node_modules/ dist/ build/ .next/"
fi

# Java 프로젝트
if [ -f "pom.xml" ] || [ -f "build.gradle" ]; then
  targets="target/ build/ .gradle/"
fi

# Python 프로젝트
if [ -f "requirements.txt" ] || [ -f "setup.py" ]; then
  targets="__pycache__/ *.pyc .pytest_cache/ .venv/"
fi
```

### 2. 안전성 체크
```bash
# Git 저장소 확인
if [ ! -d ".git" ]; then
  echo "⚠️  Git 저장소가 아닙니다. 계속하시겠습니까?"
fi

# 중요 파일 보호
protected_files=("package.json" "tsconfig.json" ".env")
for file in "${protected_files[@]}"; do
  if [ ! -f "$file" ]; then
    echo "⚠️  $file이 없습니다. 잘못된 디렉토리일 수 있습니다."
  fi
done
```

### 3. 삭제 실행
```bash
# 용량 계산
before_size=$(du -sh . | awk '{print $1}')

# 삭제
rm -rf $targets

# 결과
after_size=$(du -sh . | awk '{print $1}')
echo "✓ 정리 완료: $before_size → $after_size"
```

### 4. 재설치 (--deps 옵션)
```bash
# 패키지 매니저 감지
if [ -f "pnpm-lock.yaml" ]; then
  pnpm install
elif [ -f "yarn.lock" ]; then
  yarn install
else
  npm install
fi
```

## 예제

### 기본 정리 (캐시만)
```
/cleanup
```
**출력:**
```
🧹 프로젝트 정리 중...

삭제 대상:
  .cache/           12 MB
  dist/             45 MB
  .next/            23 MB
  *.log              2 MB
                    ─────
  총 82 MB

정말 삭제하시겠습니까? (y/N): y

✓ 82 MB 정리 완료
  디스크: 1.2 GB → 1.12 GB
```

### 전체 정리 (의존성 포함)
```
/cleanup --all
```
**실행:**
```bash
1. node_modules/ 제거      (234 MB)
2. package-lock.json 삭제
3. 캐시 정리               (82 MB)
4. npm install 실행...
   
✓ 완료: 316 MB 정리 후 재설치
```

### Dry-run (미리보기)
```
/cleanup --dry-run
```
**출력:**
```
🔍 삭제 대상 파일 (실제 삭제 안 됨):

node_modules/        234 MB
.cache/               12 MB
dist/                 45 MB
build/                23 MB
*.log                  2 MB

총 316 MB가 삭제될 예정입니다.
```

## 언어/프레임워크별 정리

### JavaScript/TypeScript
```bash
rm -rf node_modules/ dist/ build/ .next/ .nuxt/
rm -rf .cache/ .parcel-cache/ .turbo/
rm -f *.log npm-debug.log* yarn-error.log*
rm -rf coverage/ .nyc_output/
```

### Python
```bash
find . -type d -name "__pycache__" -exec rm -rf {} +
find . -type f -name "*.pyc" -delete
rm -rf .pytest_cache/ .mypy_cache/ .tox/
rm -rf build/ dist/ *.egg-info/
rm -rf .venv/ venv/
```

### Java
```bash
mvn clean  # Maven
gradle clean  # Gradle
rm -rf target/ build/ out/
rm -rf .gradle/ .m2/repository/
```

### Go
```bash
go clean -cache -testcache -modcache
rm -rf vendor/
```

### Rust
```bash
cargo clean
rm -rf target/
```

## 스마트 기능

### 1. 용량 분석
```bash
# 큰 디렉토리 찾기
du -sh */ | sort -hr | head -10
```

### 2. 오래된 파일 제거
```bash
# 30일 이상 된 로그 파일
find . -name "*.log" -mtime +30 -delete
```

### 3. 캐시 검증
```bash
# 손상된 node_modules 감지
if ! npm ls > /dev/null 2>&1; then
  echo "⚠️  의존성 트리가 손상되었습니다. 재설치를 권장합니다."
fi
```

## 에러 처리
- **권한 없음**: `❌ 삭제 권한이 없습니다: {파일}`
- **파일 사용 중**: `❌ 파일이 사용 중입니다: {파일}`
- **디스크 부족**: `⚠️  디스크 공간이 부족합니다`
- **재설치 실패**: `❌ npm install 실패: {에러}`

## 안전 장치

### 1. 보호 목록
```bash
# 절대 삭제하면 안 되는 파일/폴더
protected=(
  ".git"
  "src"
  "package.json"
  "README.md"
  ".env"
)
```

### 2. 백업 옵션
```bash
# 삭제 전 백업 생성
/cleanup --backup

# node_modules를 node_modules.backup으로 이동
mv node_modules node_modules.backup
```

### 3. 확인 프롬프트
```bash
echo "다음 항목을 삭제합니다:"
echo "  - node_modules/ (234 MB)"
echo "  - dist/ (45 MB)"
echo ""
read -p "계속하시겠습니까? (y/N): " confirm
[ "$confirm" != "y" ] && exit 0
```

## 성능 팁

### 병렬 삭제
```bash
# 여러 디렉토리 동시 삭제
(rm -rf node_modules &)
(rm -rf .cache &)
(rm -rf dist &)
wait
```

### 점진적 삭제 (대용량)
```bash
# node_modules가 너무 큰 경우
find node_modules -type f -delete  # 파일 먼저
find node_modules -type d -delete  # 디렉토리 나중
```

## 관련 Commands
- `/install`: 의존성 재설치
- `/rebuild`: 빌드 재실행
- `/reset`: Git 상태 리셋

## 주의사항
- ⚠️ **의존성 삭제**: `node_modules` 삭제 시 재설치 필요 (시간 소요)
- ⚠️ **환경 변수**: `.env.local` 삭제 시 재설정 필요
- ⚠️ **빌드 결과물**: 배포된 파일 확인 후 삭제
- ⚠️ **Git 무시**: `.gitignore`된 파일만 대상으로 권장

## 구현 예시

```bash
#!/bin/bash
# cleanup.sh

set -e

# 옵션 파싱
DRY_RUN=false
ALL=false
DEPS=false
CACHE=false
FORCE=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run) DRY_RUN=true ;;
    -a|--all) ALL=true ;;
    -d|--deps) DEPS=true ;;
    -c|--cache) CACHE=true ;;
    -f|--force) FORCE=true ;;
  esac
  shift
done

# 정리 대상 수집
targets=()

if [ "$ALL" = true ] || [ "$CACHE" = true ]; then
  targets+=("dist" "build" ".cache" ".next" "*.log")
fi

if [ "$ALL" = true ] || [ "$DEPS" = true ]; then
  targets+=("node_modules" "package-lock.json")
fi

# 용량 계산
total_size=0
for target in "${targets[@]}"; do
  if [ -e "$target" ]; then
    size=$(du -sh "$target" 2>/dev/null | awk '{print $1}')
    echo "  $target  $size"
    total_size=$((total_size + $(du -sk "$target" | awk '{print $1}')))
  fi
done

echo "총 $((total_size / 1024)) MB"

# Dry-run 체크
if [ "$DRY_RUN" = true ]; then
  echo "🔍 미리보기 모드 (실제 삭제 안 됨)"
  exit 0
fi

# 확인 프롬프트
if [ "$FORCE" != true ]; then
  read -p "삭제하시겠습니까? (y/N): " confirm
  [ "$confirm" != "y" ] && exit 0
fi

# 삭제 실행
for target in "${targets[@]}"; do
  rm -rf "$target" 2>/dev/null || true
done

# 재설치
if [ "$DEPS" = true ]; then
  echo "📦 의존성 재설치 중..."
  npm install
fi

echo "✓ 정리 완료"
```

## 확장 아이디어
- Monorepo 지원 (모든 패키지 일괄 정리)
- 사용자 정의 정리 규칙 (.cleanuprc)
- 정리 전후 벤치마크 비교
- CI/CD 파이프라인 통합

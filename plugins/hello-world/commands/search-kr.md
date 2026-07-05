---
name: search-kr
description: 한국어 코드베이스 검색 최적화 - 한글 변수명, 주석, 문서 검색
aliases: [검색, 찾기, search]
---

# Search KR Command

## 목적
한국어가 포함된 코드베이스에서 효율적으로 검색할 수 있도록 최적화된 command입니다. 한글 변수명, 주석, 문서를 빠르게 찾습니다.

## 사용법
```
/search-kr <검색어> [옵션]
/검색 <검색어>
```

## 파라미터
- `검색어` (필수): 찾을 한글/영문 키워드

## 옵션
- `--type, -t <타입>`: 파일 타입 필터 (js, py, md 등)
- `--path, -p <경로>`: 검색 경로 지정
- `--case, -c`: 대소문자 구분
- `--exact, -e`: 정확히 일치하는 것만
- `--context, -C <줄수>`: 전후 컨텍스트 표시 (기본: 2)

## 검색 대상

### 1. 한글 변수명
```javascript
const 사용자이름 = "김철수";
let 총합계 = 0;
function 로그인처리() { }
```

### 2. 한글 주석
```javascript
// 로그인 실패 시 에러 처리
/* 
 * TODO: 권한 체크 로직 추가 필요
 * 담당자: 김개발
 */
```

### 3. 한글 문서
```markdown
# API 문서
## 사용자 인증
- 로그인
- 회원가입
```

### 4. 혼합 코드
```javascript
const user = {
  이름: "홍길동",  // 사용자 이름
  나이: 30         // 만 나이
};
```

## 동작 방식

### 1. 인코딩 자동 처리
```bash
# UTF-8 인코딩 확인 및 변환
file --mime-encoding <파일>

# EUC-KR 감지 시 자동 변환
iconv -f EUC-KR -t UTF-8 <파일>
```

### 2. 스마트 검색
```bash
# 기본: ripgrep 사용 (빠름)
rg "검색어" --type js

# 한글 정규식 지원
rg "[가-힣]+" src/

# 다중 검색어 (OR)
rg "로그인|회원가입|인증"

# 컨텍스트 포함
rg "에러" -C 3
```

### 3. 결과 포맷팅
```
📁 src/auth.js
  12: const 로그인상태 = false;  // 초기 상태
  34: // 사용자 인증 로직
  35: function 인증확인() {
  
📁 docs/api.md
  45: ## 로그인 API
  46: 사용자 인증을 처리합니다.

🔍 총 2개 파일에서 5건 발견
```

## 예제

### 기본 검색
```
/search-kr 로그인
```
**출력:**
```
🔍 "로그인" 검색 중...

📁 src/auth.js:12
  11: // 사용자 로그인 처리
  12: function 로그인(이메일, 비밀번호) {
  13:   // 인증 로직

📁 README.md:45
  44: ### 로그인 기능
  45: 이메일과 비밀번호로 로그인합니다.
  46: 

✓ 2개 파일, 5건 발견 (0.12s)
```

### 파일 타입 필터
```
/search-kr 에러 --type js
```
JavaScript 파일에서만 "에러" 검색

### 경로 지정
```
/search-kr 주석 --path src/components
```
components 디렉토리에서만 검색

### 컨텍스트 확장
```
/search-kr TODO -C 5
```
TODO 주변 5줄씩 표시

## 고급 기능

### 1. 한글 초성 검색
```bash
# "ㄱㄴㄷ" → "가나다", "공난도" 등 매칭
search-kr --chosung "ㄹㄱㅇ"  # 로그인
```

### 2. 자동완성/오타 교정
```bash
# "로근인" → "로그인" 제안
검색어: 로근인
제안: 로그인으로 검색하시겠습니까?
```

### 3. 통계 및 분석
```
📊 한글 사용 통계:
  - 한글 변수명: 45개
  - 한글 주석: 123개
  - 한글 문서: 12개
  - 혼합 코드: 78개
```

### 4. 정규식 패턴
```bash
# 한글 변수명 찾기
/search-kr "const [가-힣]+ ="

# 한글 TODO 찾기
/search-kr "TODO.*[가-힣]+"

# 이메일 패턴
/search-kr "[가-힣]+@[a-z]+\.com"
```

## 특수 검색

### 코드 내 한글 문자열
```javascript
// 이런 패턴 찾기
const message = "로그인에 실패했습니다";
throw new Error("권한이 없습니다");
console.log("처리 완료");
```

### 한글 파일명
```bash
# 한글 파일명 검색
find . -name "*한글*"
find . -name "*[가-힣]*"
```

### Git 커밋 메시지
```bash
# 커밋 메시지에서 검색
git log --all --grep="로그인"
git log --all --author="김개발"
```

## 성능 최적화

### 1. 빠른 도구 사용
```bash
# ripgrep (가장 빠름)
rg "검색어"

# ag (the silver searcher)
ag "검색어"

# grep (기본)
grep -r "검색어"
```

### 2. 제외 패턴
```bash
# node_modules, dist 제외
rg "검색어" \
  --glob '!node_modules/' \
  --glob '!dist/' \
  --glob '!*.min.js'
```

### 3. 파일 크기 제한
```bash
# 1MB 이하만 검색
rg "검색어" --max-filesize 1M
```

## 결과 필터링

### 파일 타입별
```bash
JavaScript: --type js,jsx,ts,tsx
Python: --type py
Markdown: --type md
전체: (옵션 없음)
```

### 빈도순 정렬
```bash
# 가장 많이 나온 파일부터
rg "검색어" --count | sort -rn
```

### 유니크 결과
```bash
# 중복 제거
rg "검색어" | sort -u
```

## 에러 처리
- **인코딩 오류**: `⚠️  인코딩 문제 발견: {파일}. UTF-8 변환을 시도합니다`
- **검색어 없음**: `❌ 검색어를 입력하세요`
- **결과 없음**: `ℹ️  "{검색어}"와 일치하는 결과가 없습니다`
- **권한 없음**: `❌ 접근 권한이 없습니다: {경로}`

## 한국어 특화 기능

### 1. 혼용 검색
```bash
# "login" 또는 "로그인" 모두 검색
/search-kr "login|로그인"
```

### 2. 번역 힌트
```bash
# 영어 → 한글 변환 제안
검색: authentication
제안: "인증", "로그인" 도 함께 검색하시겠습니까?
```

### 3. 관련어 검색
```bash
# "로그인" 검색 시 관련어 제안
관련 검색어:
  - 인증
  - 로그아웃  
  - 회원가입
  - 세션
```

## 출력 옵션

### 파일명만
```
/search-kr 로그인 --files-only
```
**출력:**
```
src/auth.js
src/login.js
docs/auth.md
```

### 카운트만
```
/search-kr TODO --count
```
**출력:**
```
src/: 12건
test/: 3건
docs/: 5건
총 20건
```

### JSON 형식
```
/search-kr 에러 --json
```
**출력:**
```json
{
  "query": "에러",
  "results": [
    {
      "file": "src/auth.js",
      "line": 12,
      "content": "에러 처리 로직"
    }
  ]
}
```

## 관련 Commands
- `/grep`: 기본 grep 검색
- `/find`: 파일명으로 찾기
- `/replace`: 검색 후 치환

## 주의사항
- **인코딩**: UTF-8이 아닌 파일은 자동 변환 시도
- **성능**: 큰 프로젝트에서는 경로 지정 권장
- **정규식**: 특수문자 이스케이프 필요
- **민감정보**: 검색 결과에 비밀번호 등 포함 가능성 주의

## 구현 예시

```bash
#!/bin/bash
# search-kr.sh

QUERY="$1"
TYPE=""
PATH="."
CONTEXT=2

# 옵션 파싱
shift
while [[ $# -gt 0 ]]; do
  case $1 in
    -t|--type) TYPE="$2"; shift 2 ;;
    -p|--path) PATH="$2"; shift 2 ;;
    -C|--context) CONTEXT="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# 검색어 확인
if [ -z "$QUERY" ]; then
  echo "❌ 검색어를 입력하세요"
  exit 1
fi

# ripgrep 사용
echo "🔍 \"$QUERY\" 검색 중..."

RG_CMD="rg '$QUERY' $PATH -C $CONTEXT --color always"

if [ -n "$TYPE" ]; then
  RG_CMD="$RG_CMD --type $TYPE"
fi

# 실행
eval $RG_CMD

# 결과 통계
count=$(eval "rg '$QUERY' $PATH --count 2>/dev/null" | wc -l)
echo ""
echo "✓ $count개 파일에서 발견"
```

## 확장 아이디어
- 검색 히스토리 저장
- 자주 쓰는 검색 패턴 북마크
- 검색 결과를 파일로 export
- 웹 UI로 시각화
- AI 기반 의미 검색 (semantic search)

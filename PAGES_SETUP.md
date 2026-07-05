# Pages 배포 가이드 (가장 간단한 방법)

## ✅ 추천: 브랜치 기반 자동 배포

GitHub Pages에서 가장 간단한 방법입니다.

### 1단계: Pages 설정

```
저장소 → Settings → Pages
```

### 2단계: Source 설정

```
Source: Deploy from a branch

Branch: main
Directory: /docs

[Save] 클릭
```

### 3단계: 완료!

- Jekyll 자동 빌드
- 몇 분 후 사이트 오픈
- main 브랜치 푸시할 때마다 자동 업데이트

### 사이트 URL

```
https://username.github.io/AI-Assistant/
```

---

## 🎉 끝!

CI/CD 파이프라인도 필요 없고, 로컬 빌드도 필요 없습니다.

단순히:
1. Settings → Pages → Source 설정
2. Branch: **main**, Directory: **/docs**
3. 저장하면 자동 배포!

---

## 로컬 미리보기 (선택사항)

배포 전에 로컬에서 확인하고 싶다면:

```bash
cd docs

# 처음 한 번만
gem install bundler jekyll
bundle install

# 로컬 서버 실행
bundle exec jekyll serve

# 브라우저에서 열기
open http://localhost:4000/AI-Assistant/
```

---

## 문제 해결

### 404 에러

**원인:** baseurl 설정 확인

**확인:**
```yaml
# docs/_config.yml
baseurl: /AI-Assistant
url: https://username.github.io
```

### 스타일 안 보임

**원인:** 테마 로딩 실패

**확인:**
```yaml
# docs/_config.yml
remote_theme: just-the-docs/just-the-docs
```

### 빌드 실패

**확인:**
- Settings → Pages에서 에러 메시지 확인
- `_config.yml` 문법 오류 체크

---

## 장점

✅ **간단함**: 설정 2분
✅ **자동화**: 푸시하면 자동 배포
✅ **Jekyll 자동**: 별도 빌드 불필요
✅ **유지보수**: 관리할 것 없음

끝!

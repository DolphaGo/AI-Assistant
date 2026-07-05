---
name: api-tester
description: REST API 엔드포인트 자동 테스트 및 검증
trigger: api test, api 테스트, endpoint test
---

# API Tester Skill

## 목적
REST API 엔드포인트를 자동으로 테스트하고 응답을 검증합니다. 여러 시나리오를 빠르게 확인하고 문제를 발견할 수 있습니다.

## 사용 시점
- 새로운 API 엔드포인트 개발 후 테스트
- API 수정 후 회귀 테스트
- 외부 API 통합 검증
- API 문서와 실제 동작 비교

## 실행 단계

### 1단계: 테스트 대상 파악
- API 엔드포인트 URL 확인
- HTTP 메서드 (GET, POST, PUT, DELETE)
- 필요한 헤더 및 인증 정보

### 2단계: 테스트 케이스 생성
- 정상 시나리오 (200 OK)
- 에러 시나리오 (400, 401, 404, 500)
- 경계값 테스트
- 유효성 검증

### 3단계: 실행 및 검증
- curl 또는 httpie로 요청 전송
- 응답 코드 확인
- 응답 본문 검증
- 응답 시간 측정

### 4단계: 결과 리포트
- 성공/실패 요약
- 문제점 상세 설명
- 개선 제안

## 출력 형식
```
🧪 API 테스트 시작

✅ GET /api/users - 200 OK (142ms)
   - 응답: { "users": [...] }
   - 검증: ✓ 배열 형식
   - 검증: ✓ user 객체 구조 올바름

❌ POST /api/users - 500 Internal Server Error (1203ms)
   - 에러: {"error": "Database connection failed"}
   - 문제: 타임아웃 발생

📊 요약
- 전체: 5개
- 성공: 4개
- 실패: 1개
- 평균 응답시간: 312ms
```

## 예제

### 기본 GET 테스트
```bash
# 입력
사용자: /api-tester https://api.example.com/users

# 실행
curl -X GET https://api.example.com/users \
  -H "Content-Type: application/json" \
  -w "\nTime: %{time_total}s\nStatus: %{http_code}\n"
```

### 인증 포함 POST 테스트
```bash
# 입력
사용자: /api-tester POST https://api.example.com/users --auth

# 실행
curl -X POST https://api.example.com/users \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name": "Test User", "email": "test@example.com"}' \
  -w "\nTime: %{time_total}s\nStatus: %{http_code}\n"
```

## 구현 기능

### 자동 검증
- HTTP 상태 코드 확인
- JSON 스키마 검증
- 응답 시간 체크
- 필수 필드 존재 확인

### 테스트 시나리오
```yaml
scenarios:
  - name: "정상 생성"
    method: POST
    data: {"name": "User1"}
    expect: 201
    
  - name: "중복 방지"
    method: POST
    data: {"name": "User1"}
    expect: 409
    
  - name: "필수값 누락"
    method: POST
    data: {}
    expect: 400
```

## 주의사항
- **프로덕션 환경**: 테스트 전 환경 확인 필수
- **인증 토큰**: 민감한 정보 하드코딩 금지
- **Rate Limiting**: API 제한 고려하여 요청 간격 조절
- **롤백**: 생성/수정 테스트 후 데이터 정리

## 관련 도구
- `Bash`: curl/httpie 실행
- `Read`: API 스펙 파일 읽기
- `Grep`: 로그에서 에러 패턴 검색

## 고급 기능

### 부하 테스트
```bash
# 동시 요청 100개
for i in {1..100}; do
  curl -X GET https://api.example.com/health &
done
wait
```

### 응답 검증 스크립트
```javascript
// response-validator.js
const response = JSON.parse(process.argv[2]);
if (!response.data || !Array.isArray(response.data)) {
  throw new Error('Invalid response structure');
}
```

## 확장 아이디어
- OpenAPI 스펙 자동 파싱
- Postman 컬렉션 import
- 성능 모니터링 대시보드
- 자동 회귀 테스트 스크립트 생성

---
name: status-check
description: 기본 skill 구조 데모 - 인사와 현재 작업 디렉토리, Git 상태, 최근 커밋 확인
---

# Status Check Skill

## 목적
Claude Code skill의 기본 구조를 보여주는 예제입니다. 간단한 인사와 함께 프로젝트 상태를 확인합니다.

## 사용 시점
- skill 개발을 처음 시작할 때 참고용
- 기본적인 도구 사용법 학습
- 프로젝트 상태 빠른 확인

## 실행 단계

### 1단계: 인사
사용자에게 인사하고 현재 작업 디렉토리를 확인합니다.

### 2단계: 프로젝트 정보 수집
- Git 상태 확인
- 최근 커밋 조회
- package.json 읽기 (있는 경우)

### 3단계: 요약 출력
수집한 정보를 정리하여 사용자에게 보고합니다.

## 출력 형식
```
👋 안녕하세요!

📁 프로젝트: {프로젝트명}
🌿 브랜치: {현재 브랜치}
📝 최근 커밋: {커밋 메시지}
✨ 상태: {clean/modified}
```

## 예제

### 입력
```
사용자: /status-check
```

### 출력
```
👋 안녕하세요!

📁 프로젝트: ai-assistant
🌿 브랜치: main
📝 최근 커밋: feat: uninstall.sh 제거 스크립트 구현
✨ 상태: clean

무엇을 도와드릴까요?
```

## 구현 코드

```markdown
1. Bash로 현재 디렉토리 확인
   command: pwd

2. Git 브랜치와 상태 확인
   command: git branch --show-current && git status --short

3. 최근 커밋 조회
   command: git log -1 --oneline

4. (선택) package.json 읽기
   tool: Read
   path: ./package.json
```

## 주의사항
- Git 저장소가 아닌 경우 graceful하게 처리
- package.json이 없어도 에러 없이 진행
- 간단하고 빠르게 실행되도록 유지

## 관련 도구
- `Bash`: 명령 실행
- `Read`: 파일 읽기
- `Grep`: 파일 검색 (고급 기능)

## 확장 아이디어
- 언어별 프로젝트 구조 감지
- 의존성 업데이트 확인
- 미완료 TODO 카운트

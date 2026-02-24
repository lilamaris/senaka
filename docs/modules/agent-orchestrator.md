# agent-orchestrator

## 관련 TODO
- `docs/todo/TODO-mvp-minimum-modules.md`
- `docs/todo/TODO-foundation-architecture.md`

## 기능 설명
사용자 목표를 받아 Agent Loop를 실행하는 핵심 오케스트레이터.

## 모듈 구성
- `runtime/session-manager`: 세션 생성/복구/종료
- `runtime/goal-manager`: 목표 분해, 성공 기준 관리
- `runtime/loop-engine`: step 실행, 중단/재개, 최대 반복 제한
- `runtime/policy-gates`: 위험 명령 승인, 사용자 개입 지점

## 모듈 간 흐름
1. 세션 시작
2. 목표/제약 로드
3. 모델 라우팅(Worker/Main)
4. 도구 실행 및 증거 반영
5. 완료 판정 후 결과 반환

## 사용 방법
- CLI(현재): `npm run chat -- --session <id>`, `npm run chat:turn -- --session <id> --message "..."`
- CLI(계획): `hostctl run --goal "..."`
- WebUI(계획): 목표 입력 후 `Run`으로 동일 루프 실행

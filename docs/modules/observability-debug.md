# observability-debug

## 관련 TODO
- `docs/todo/TODO-mvp-minimum-modules.md`
- `docs/todo/TODO-observability-operations.md`

## 기능 설명
실행 과정의 투명성 확보를 위한 이벤트/로그/트레이싱/디버깅 모듈.

## 모듈 구성
- `src/runtime/agent-loop.ts`: worker/main/token/tool/ask 이벤트 발행
- `src/cli/agent-tui.ts`: 실시간 이벤트 로그와 stream 패널 렌더링
- `src/runtime/session-store.ts`: 세션 단위 메시지 히스토리 저장

## 노출 정책
- think 토큰(가능한 엔진에서) 메타데이터 표시
- 도구 호출 입력/출력, exit code 표시
- 사용자 관측 우선 원칙: 숨김 최소화, 정책 기반 마스킹만 적용

## 사용 방법
- CLI(TUI): `npm run agent:tui`
- CLI(단일 실행): `npm run agent:run -- --agent <id> --goal "<목표>"`
- WebUI trace 패널은 아직 미구현

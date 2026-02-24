# tooling-shell-mcp

## 관련 TODO
- `docs/todo/TODO-mvp-minimum-modules.md`
- `docs/todo/TODO-tooling-mcp.md`

## 기능 설명
shell 기반 도구 호출과 MCP 호환 도구 호출을 단일 인터페이스로 제공.

## 모듈 구성
- `src/runtime/agent-loop.ts`
  - worker `call_tool` 액션 파싱
  - shell 명령 실행(`exec`) + timeout/buffer 제한
  - 위험 키워드 차단 및 파이프 개수 제한
- `data/worker/SYSTEM.md`
  - worker tool 호출 JSON 스키마와 안전 규칙

## 인터페이스 정책
- 입력 스펙: `{"action":"call_tool","tool":"shell","args":{"cmd":"..."},"reason":"..."}`
- 출력 표준화: `exitCode`, `stdout`, `stderr`
- 실패도 증거로 보존

## 사용 방법
- `npm run agent:run -- --agent <id> --goal "<목표>"`
- `npm run agent:tui`
- MCP 어댑터는 아직 미구현(문서상 목표만 유지)

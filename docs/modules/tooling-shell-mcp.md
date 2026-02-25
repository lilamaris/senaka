# tooling-shell-mcp

## 관련 TODO
- `docs/todo/TODO-mvp-minimum-modules.md`
- `docs/todo/TODO-tooling-mcp.md`
- `docs/todo/TODO-sandbox-group-workspace.md`

## 기능 설명
shell 기반 도구 호출과 MCP 호환 도구 호출을 단일 인터페이스로 제공.

## 모듈 구성
- `src/runtime/agent-loop/run-loop.ts`
  - worker `call_tool` 액션 파싱
  - planning/decision 맥락과 함께 tool 결과를 증거로 누적
- `src/runtime/agent-loop/llm.ts`
  - 샌드박스 실행기 호출 + timeout/buffer 제한
  - 명령 실행 전 안전성 정책 게이트 호출
- `src/runtime/agent-loop/command-safety.ts`
  - 토큰/세그먼트 단위 파싱 기반 안전성 검증
  - 금지 실행 파일/`git push` 차단
  - 파이프 개수(`|`) 제한
- `src/runtime/sandbox-executor.ts`
  - `local`/`docker` 실행 모드
  - 그룹별 도커 컨테이너/워크스페이스 재사용
- `data/worker/SYSTEM.md`
  - worker tool 호출 JSON 스키마와 안전 규칙

## 인터페이스 정책
- 입력 스펙: `{"action":"call_tool","tool":"shell","args":{"cmd":"..."},"reason":"..."}`
- 출력 표준화: `exitCode`, `stdout`, `stderr`
- 실패도 증거로 보존
- 안전성 정책:
  - 단순 문자열 `includes`가 아닌 토큰/세그먼트 파싱 기반으로 명령 검증
  - `TOOL_MAX_PIPES`를 초과하는 파이프라인 차단
  - 금지 실행 파일(`rm`, `dd`, `mkfs`, `shutdown`, `reboot`, `kill` 등)과 `git push` 차단

## 사용 방법
- `npm run agent:run -- --agent <id> --goal "<목표>"`
- 그룹 워크스페이스: `npm run agent:run -- --agent <id> --group <group-id> --goal "<목표>"`
- `npm run agent:tui`
- MCP 어댑터는 아직 미구현(문서상 목표만 유지)

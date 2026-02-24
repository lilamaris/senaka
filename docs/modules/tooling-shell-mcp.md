# tooling-shell-mcp

## 기능 설명
shell 기반 도구 호출과 MCP 호환 도구 호출을 단일 인터페이스로 제공.

## 모듈 구성
- `tools/shell-adapter`: 리눅스 CLI 얇은 래퍼/직접 실행
- `tools/mcp-adapter`: MCP tool API 호환 브리지
- `tools/spec-lite`: 모델 친화적 간소 스펙(짧은 필드, 명확한 에러)
- `tools/sandbox-policy`: 허용/차단/승인 정책

## 인터페이스 정책
- 입력 스펙 최소화: `tool`, `args`, `timeout`
- 출력 표준화: `exit_code`, `stdout`, `stderr`, `duration_ms`
- 실패도 증거로 보존

## 사용 방법
- CLI: `hostctl tool run shell -- ls -la`
- MCP: `hostctl tool run mcp --name <tool>`

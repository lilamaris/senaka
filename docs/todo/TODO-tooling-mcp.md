# TODO Tooling & MCP

## 목표
shell 도구와 MCP 도구를 일관된 호출 모델로 통합.

## TODO
- [ ] 공통 ToolResult 스키마 확정(`exit_code`, `stdout`, `stderr`, `duration_ms`, `error`)
- [ ] shell 어댑터 구현(타임아웃/종료코드/출력 크기 제한)
- [ ] 명령 화이트리스트/블랙리스트 및 승인 정책 구현
- [ ] MCP 호출 어댑터 구현 및 프로토콜 호환성 테스트
- [ ] 도구 스펙 간소 포맷(JSON 최소 필드) 설계
- [ ] 도구 실패 결과를 증거 저장소에 보존하도록 연결
- [ ] 로컬 LLM별 도구 호출 성공률 측정 스크립트 작성

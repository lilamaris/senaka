# TODO MVP Minimum Modules

## 목적
사용자가 제안한 시스템 구성을 MVP로 달성하기 위한 최소 구현 모듈을 확정하고, 구현 순서를 고정.

## MVP 정의(완료 조건)
- 채팅 세션에서 목표를 입력하면 에이전트 루프가 실행된다.
- 최소 1개 이상의 shell 도구 호출을 수행하고 stdout/stderr를 증거로 저장한다.
- Worker가 수집한 증거를 Main이 최종 요약 보고로 반환한다.
- 실행 단계/도구 결과/오류를 사용자가 CLI에서 실시간 관측할 수 있다.
- MCP 호환 호출을 위한 최소 어댑터 인터페이스가 존재한다(기본 호출 성공/실패 처리).

## 최소 구현 모듈(필수)
1. Agent Orchestrator (`runtime/session-manager`, `runtime/loop-engine`)
2. Model Routing & Context Budget (`models/role-router`, `models/context-budgeter`)
3. API Provider Abstraction (`src/llm/provider`, `src/llm/providers/*`, `src/runtime/chat-turn`)
4. Tooling Layer - Shell First (`tools/shell-adapter`, `tools/spec-lite`)
5. Evidence Pipeline (`evidence/collector`, `evidence/normalizer`, `evidence/store`)
6. Main Reporter (`runtime/final-reporter`)
7. Observability Core (`observability/event-bus`, `observability/live-stream`)
8. CLI Control Surface (`interfaces/cli`)
9. MCP Compatibility Shim (`tools/mcp-adapter` 최소 구현)

## 후순위 모듈(MVP 이후)
- WebUI 전체 기능
- 고급 추론 메타 노출(모델별 think token 상세 시각화)
- 다중 사용자 접근 제어
- 고급 증거 충돌 해결/리플레이 자동화
- 벤치마크 자동화 및 품질 대시보드

## 구현 순서(권장)
1. 세션/루프 상태머신 + CLI 최소 명령(`chat`, `run`)
2. shell 도구 호출 + ToolResult 표준화
3. 증거 수집/저장 + 단계별 이벤트 스트림
4. main/worker 분리 실행 + 최종 요약 보고
5. MCP 최소 어댑터 연결
6. 운영 안정화(재시도/중단/재개/로그 보존)

## 추적 체크리스트
- [ ] 단일 세션 생성/종료/재개 동작
- [ ] 루프 단계별 상태 전이 로그
- [ ] shell 도구 호출 성공/실패 핸들링
- [ ] stdout/stderr 증거 저장 및 조회
- [ ] worker 증거 -> main 보고 흐름 검증
- [ ] CLI 실시간 trace 출력
- [ ] MCP 어댑터 기본 호출 경로 검증

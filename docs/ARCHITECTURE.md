# ARCHITECTURE

로컬 LLM 기반 호스트 운영 시스템(24/7 접근 가능) 구현을 위한 구조 정의 문서입니다.

## 목표
- 최소 맥락 주입으로 안정적인 에이전트 루프 운용
- Worker(증거 수집) / Main(최종 요약) 분리 가능 구조
- 증거 수집이 불필요한 요청은 planning 단계에서 바로 판단/응답으로 전이
- 모델 컨텍스트 초과 전에 대화 compaction으로 실행 안정성 확보
- CLI/WebUI 양쪽 제어 표면 지원
- 도구 호출의 단순화(특히 stdout/stderr 중심 증거 모델)
- MCP tool API 호환성 확보
- 사용자 관측 가능성(think 토큰, 호출 결과, 로그) 극대화

## 디렉터리 루트 제안
- `runtime/`
  - 세션, 상태머신, 에이전트 루프, 라우팅
- `models/`
  - 모델 프로파일(로컬 가중치/양자화별 설정), 역할 분리(main/worker)
- `tools/`
  - shell 래퍼, 직접 명령 실행 어댑터, MCP 브리지
- `evidence/`
  - stdout/stderr 기반 증거 정규화, 저장, 인덱싱
- `observability/`
  - trace/event/log, think-token/도구 호출 노출 이벤트
- `interfaces/cli/`
  - codex/claude-cli 유사 UX
- `interfaces/webui/`
  - 향후 계획(세션/실행 상태/증거/디버깅 뷰)
- `docs/`
  - 아키텍처, 모듈, TODO, 운영 가이드

## 현재 코드 구조(실제 구현)
- `src/runtime/`
  - `agent-loop.ts`, `chat-service.ts`, `session-store.ts`
- `src/models/`
  - `profile-registry.ts`, `role-router.ts`
- `src/llm/`
  - `openai-compatible.ts`
- `src/cli/`
  - `chat.ts`, `chat-turn.ts`, `models-list.ts`, `agent-run.ts`, `agent-tui.ts`
- `data/worker/SYSTEM.md`
  - worker JSON 액션 프로토콜 프롬프트

## 모듈 문서 라우팅
- 에이전트 루프/오케스트레이션: `docs/modules/agent-orchestrator.md`
- 모델 역할 분리 및 컨텍스트 정책: `docs/modules/model-routing-context.md`
- API Provider 추상 계층/채팅 턴: `docs/modules/api-provider-llm.md`
- 도구 실행 계층(shell/MCP): `docs/modules/tooling-shell-mcp.md`
- 도커 샌드박스/그룹 워크스페이스: `docs/modules/sandbox-group-workspace.md`
- 증거 수집/검증 파이프라인: `docs/modules/evidence-pipeline.md`
- 관측/디버깅/투명성: `docs/modules/observability-debug.md`
- 사용자 인터페이스(CLI/WebUI): `docs/modules/interfaces-cli-webui.md`

## MVP 최소 구현 모듈
- 기준 문서: `docs/todo/TODO-mvp-minimum-modules.md`
- 필수 모듈: Orchestrator, Model Routing, Shell Tooling, Evidence Pipeline, Main Reporter, Observability Core, CLI, MCP Shim
- 원칙: WebUI/고급 기능은 MVP 이후로 분리하여 핵심 실행 경로를 먼저 완성

## 모듈 간 흐름(요약)
1. 사용자 목표 입력(CLI/WebUI)
2. Agent Orchestrator가 루프 시작 및 역할 모델 선택
3. `PlanIntent` 단계에서 `AcquireEvidence`/`AssessSufficiency`/즉시 최종 보고 중 다음 전이를 결정
4. `ContextGuard` 단계가 필요 시 세션을 compaction하여 컨텍스트 여유를 복구
5. `AcquireEvidence`에서 Worker 모델이 도구 호출로 증거 수집(stdout/stderr 중심)
6. `AssessSufficiency`에서 Main 모델이 `finalize/continue` 판단
7. `ForcedSynthesis`(예외 경로) 또는 최종 보고 생성 후 종료
8. Observability가 planning/compaction/worker/main 전 과정을 사용자에게 노출

## CLI / WebUI 사용 개요
- CLI
  - 현재 구현: `npm run chat -- --session <id>`, `npm run chat:turn -- --session <id> --message "..."`
  - 현재 구현: `npm run models:list`, `npm run agent:run -- --agent <id> --goal "<목표>"`
  - 현재 구현: `npm run agent:tui` (로그/입력 기반 TUI)
  - 현재 구현: planning 이벤트(`planning-start`, `planning-result`)와 context compaction 이벤트를 실시간 출력
  - 현재 구현: worker `ask` 액션 발생 시 `agent:run`/`agent:tui`에서 YES/NO 사용자 확인 입력 지원
  - 계획: 단계별 실행 로그/증거 출력, 수동 개입(재시도/중단) 확장
- WebUI
  - 현재 미구현(향후 계획)
  - 계획: 실행 타임라인, 도구 호출 상세, think-token/summary 노출

## TODO 문서 라우팅
- 전체 인덱스: `docs/todo/README.md`
- MVP 최소 구현 모듈: `docs/todo/TODO-mvp-minimum-modules.md`
- Provider 추상 계층/채팅 턴: `docs/todo/TODO-provider-abstraction-chat-turn.md`
- 기반 아키텍처: `docs/todo/TODO-foundation-architecture.md`
- 모델/컨텍스트 설계: `docs/todo/TODO-model-routing-context.md`
- 도구/MCP 호환: `docs/todo/TODO-tooling-mcp.md`
- 샌드박스/그룹 워크스페이스: `docs/todo/TODO-sandbox-group-workspace.md`
- 증거/검증 파이프라인: `docs/todo/TODO-evidence-validation.md`
- 관측/디버깅/운영: `docs/todo/TODO-observability-operations.md`
- 인터페이스(CLI/WebUI): `docs/todo/TODO-interfaces-cli-webui.md`

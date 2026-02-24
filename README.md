# Senaka

로컬 LLM 기반의 24/7 호스트 운영 시스템을 목표로 하는 프로젝트입니다.

이 시스템은 채팅 세션 기반 운영을 기본으로 하며, 다음 특성을 중심으로 설계됩니다.
- 최소 맥락 주입(minimal context injection)
- 증거 기반 목표 달성(agent loop + evidence)
- 모델 역할 분리 유연성(main-only 또는 main+worker)
- shell/MCP 도구 호출 호환
- 내부 동작의 높은 관측 가능성(디버깅 친화)
- CLI 우선 제어 표면

## 프로젝트 목적
- 사용자의 목표를 자연어로 받아, 로컬 실행 가능한 도구를 통해 증거를 수집하고, 검증된 결과를 보고하는 호스트 시스템 구현
- 로컬 LLM 가중치/양자화 성능 편차를 고려한 단순하고 견고한 툴 인터페이스 제공
- 시스템 내부 상태, 도구 호출 결과(stdout/stderr), 실행 흐름이 사용자에게 최대한 투명하게 보이는 운영 환경 제공

## 현재 가능한 기능
현재 리포지토리는 문서 + 최소 실행 코드가 함께 존재합니다.

- 아키텍처 라우팅
  - `AGENTS.md` -> `docs/ARCHITECTURE.md` -> `docs/modules/*.md`
- 기능 모듈 정의
  - 오케스트레이터, 모델 라우팅/컨텍스트, 도구(shell/MCP), 증거 파이프라인, 관측성, 인터페이스(CLI)
- 목적별 실행 TODO 분리
  - `docs/todo/` 하위에 영역별 TODO 문서 제공
  - `docs/todo/TODO-mvp-minimum-modules.md`에 MVP 최소 구현 기준 정의
- 최소 LLM 통신 경로 구현
  - 환경설정 로더: `src/config/env.ts`
  - OpenAI 호환 provider: `src/llm/openai-compatible.ts`
  - 모델 레지스트리(서버/모델/에이전트): `config/model-profiles.json`, `src/models/profile-registry.ts`
  - 역할 라우팅(agent 블럭 기반): `src/models/role-router.ts`
  - Agent loop: `src/runtime/agent-loop.ts`, `src/cli/agent-run.ts`
  - 세션 저장소: `src/runtime/session-store.ts`
  - chat turn 실행: `src/runtime/chat-service.ts`
  - CLI 엔트리: `src/cli/chat.ts`, `src/cli/chat-turn.ts`, `src/cli/models-list.ts`

## 문서 네비게이션
- 라우팅 엔트리: `AGENTS.md`
- 아키텍처 개요: `docs/ARCHITECTURE.md`
- 기능 모듈 상세: `docs/modules/`
- 구현 TODO 인덱스: `docs/todo/README.md`
- MVP 최소 구현 기준: `docs/todo/TODO-mvp-minimum-modules.md`
- Provider 관련 모듈 문서: `docs/modules/api-provider-llm.md`

## 사용 방법 (현재)
### 1) 문서 기반 구현 흐름

1. `AGENTS.md`에서 문서 탐색 시작
2. `docs/ARCHITECTURE.md`에서 전체 구조 및 모듈 경로 확인
3. `docs/todo/TODO-mvp-minimum-modules.md`에서 MVP 범위와 우선순위 확인
4. 해당 기능의 `docs/modules/*.md`에서 관련 TODO 링크 확인
5. `docs/todo/TODO-*.md`의 작업 항목 기준으로 구현 진행

### 2) OpenAI 호환 provider로 chat turn 실행
필수 환경변수(.env):
- `OPENAI_BASE_URL`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`

선택 환경변수:
- `SYSTEM_PROMPT`
- `SESSION_DIR` (기본값: `./data/sessions`)
- `WORKER_OPENAI_MODEL` (worker 후보 모델명)
- `MODEL_PROFILES_PATH` (기본값: `./config/model-profiles.json`)

실행 예시:
```bash
npm install
cp .env.example .env
npm run build
npm run chat -- --session default
npm run chat:turn -- --session default --message "안녕하세요"
```

참고:
- 현재는 `/chat/completions` 단일 경로를 사용합니다.
- 인터랙티브 CLI에서 `/show`, `/reset`, `/exit` 명령을 지원합니다.

### 2.5) Agent loop(main/worker 분리) 실행
실행 예시:
```bash
npm run models:list
npm run agent:run -- --session default --agent default --goal "현재 세션에서 의사결정 리스크를 정리해줘"
npm run agent:tui
```

`agent:run` 사용자 확인:
- worker가 `ask` 액션을 반환하면 CLI가 `answer(YES/NO)>` 프롬프트를 띄우고 같은 루프를 이어서 진행

Worker 프로토콜:
- 시스템 프롬프트 파일: `data/worker/SYSTEM.md`
- worker 응답은 JSON 단일 객체 강제
- 액션:
  - `call_tool`: shell 명령 실행 후 stdout/stderr를 worker 문맥으로 재주입
  - `ask`: YES/NO 질문으로 사용자에게 확인 후 같은 evidence 세션 계속 진행
  - `finalize`: main 모델에 의미 있는 증거 요약 전달 후 finalize/continue 결정

모드:
- `main-worker`: worker(증거 수집) + main(최종 요약)
- `single-main`: 단일 모델로 루프 실행

TUI 명령:
- `/agent <ID>`
- `/mode main-worker|single-main|auto`
- `/steps <N>|auto`
- `/stream on|off|auto`
- `/session <ID>`
- `/clear`
- `/exit`

스트리밍:
- `agent:run`, `agent:tui`는 기본적으로 chat completion 스트리밍을 사용합니다.
- 비활성화: `npm run agent:run -- --agent default --goal "<목표>" --no-stream`
- `agent:tui`에서는 생성 중 토큰이 `WORKER STREAM`, `MAIN STREAM` 섹션에 무절단으로 실시간 표시됩니다.
- `<think>...</think>`가 포함된 경우 `THINK PHASE`와 `FINAL RESPONSE` 단락으로 분리해서 표시합니다.
- 각 실행 턴은 `TURN N START/END` 구분선으로 명확히 분리됩니다.

## 구현 마일스톤
### M1. Foundation Runtime
- 세션/루프 상태머신
- 단일 모델 모드 + 분리 모델 모드 토대
- 런타임 디렉터리 골격 생성

### M2. Model Routing & Context Budget
- 모델 프로파일 레지스트리
- main-only / main+worker 라우터
- 최소 주입 컨텍스트 정책

### M2.5. Provider Abstraction & Chat Runtime
- OpenAI-compatible 이외 provider 확장
- streaming/tool-call 정규화
- 재시도/백오프/에러 분류

### M3. Tooling Layer (Shell + MCP)
- 공통 ToolResult 스키마
- shell 어댑터 및 정책 게이트
- MCP 호환 호출 어댑터

### M4. Evidence Pipeline
- stdout/stderr 기반 증거 정규화
- 검증 규칙 엔진
- append-only 증거 저장소

### M5. Observability & Debug
- 이벤트 버스/트레이스 저장
- 실시간 스트리밍(CLI/WebUI 공용)
- 최소 마스킹 기반 투명 노출

### M6. Interfaces
- CLI(`chat`, `run`, `trace`, `tool`, `evidence`)
- WebUI(향후 계획)
- 공통 세션/이벤트 모델 완성

## 문서 진화 원칙
이 프로젝트는 구현 진행에 따라 문서가 함께 진화해야 합니다.

다음 문서는 기능 구현 시 반드시 동기화 대상입니다.
- `README.md`
- `AGENTS.md`
- `docs/ARCHITECTURE.md`
- `docs/modules/*.md`

동기화 규칙:
- 새 기능 추가 시: 모듈 문서 + 아키텍처 라우팅 + README 반영
- 기능 흐름 변경 시: 관련 MODULE 문서의 흐름/사용법 갱신
- 사용자 진입점 변경(CLI/WebUI) 시: README 사용 방법 및 ARCHITECTURE 사용 개요 동시 갱신
- TODO 완료/재계획 시: `docs/todo/` 문서 상태 업데이트

## 다음 구현 진입점
- `docs/todo/TODO-foundation-architecture.md`
- `docs/todo/TODO-model-routing-context.md`
- `docs/todo/TODO-tooling-mcp.md`

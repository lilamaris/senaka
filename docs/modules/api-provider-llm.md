# api-provider-llm

## 관련 TODO
- `docs/todo/TODO-mvp-minimum-modules.md`
- `docs/todo/TODO-provider-abstraction-chat-turn.md`

## 기능 설명
OpenAI API 스펙(`/chat/completions`) 기반으로 LM Studio(OpenAI 호환 포함)와 통신하며 채팅 턴을 실행하는 모듈.

## 모듈 구성
- `src/config/env.ts`
  - `.env` 기반 설정 로더
- `src/core/api/chat-completion.ts`
  - 런타임이 의존하는 고정 API 포트(ChatCompletionApi/Adapter)
- `src/adapter/api/index.ts`
  - provider별 구현체 선택 팩토리
- `src/adapter/api/openai.ts`
  - OpenAI/OpenAI-compatible 구현체
- `src/llm/openai-compatible.ts`
  - 기존 호출 경로 호환 래퍼
- `config/model-profiles.json`
  - API 서버/모델/에이전트(main-worker/single-main) 설정 관리
- `src/models/profile-registry.ts`
  - 후보 해석 및 프로파일 선택
- `src/runtime/session-store.ts`
  - 세션 생성/복구/저장
- `src/runtime/chat-service.ts`
  - 사용자 턴 실행 및 응답 저장
- `data/worker/SYSTEM.md`
  - worker 모델 JSON 액션 프로토콜 정의
- `src/cli/chat.ts`
  - 지속 세션 인터랙티브 CLI
- `src/cli/chat-turn.ts`
  - 단일 턴 CLI

## 모듈 간 흐름
1. CLI에서 session id와 입력을 수신
2. `session-store`가 기존 히스토리를 복구
3. `chat-service`가 `CHAT_MODEL_ID` 또는 `CHAT_AGENT_ID` 기준으로 main 모델 후보를 해석
4. `chat-service`가 user 턴을 저장
5. provider가 `/chat/completions` 호출
6. assistant 응답을 세션에 저장

## 확장 포인트
- 핵심 기능은 `src/core/api/chat-completion.ts` 인터페이스에만 의존
- 신규 provider(LM Studio/OpenAI/Claude Code)는 `src/adapter/api/*` 구현체 추가로 확장
- 런타임(`chat-service`, `agent-loop`)은 adapter 팩토리로 구현체를 주입받아 사용

## 사용 방법
- 환경변수
  - `MODEL_PROFILES_PATH` (default: `./config/model-profiles.json`)
  - `CHAT_AGENT_ID` (default: `default`)
  - `CHAT_MODEL_ID` (optional, 지정 시 `CHAT_AGENT_ID`보다 우선)
  - 모델 프로파일이 참조하는 서버 env
    - 기본 샘플 기준: `OPENAI_BASE_URL`, `OPENAI_API_KEY`
  - `OPENAI_MODEL` (legacy helper 경로 사용 시만 필요)
  - `SYSTEM_PROMPT` (optional)
  - `SESSION_DIR` (optional, default: `./data/sessions`)
- 실행
  - `npm run chat -- --session default`
  - `npm run chat:turn -- --session default --message "안녕"`
  - `npm run models:list`
  - `npm run agent:run -- --agent default --goal "..."` 

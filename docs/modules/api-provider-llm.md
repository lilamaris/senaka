# api-provider-llm

## 관련 TODO
- `docs/todo/TODO-mvp-minimum-modules.md`
- `docs/todo/TODO-provider-abstraction-chat-turn.md`

## 기능 설명
OpenAI API 스펙(`/chat/completions`) 기반으로 LM Studio(OpenAI 호환 포함)와 통신하며 채팅 턴을 실행하는 모듈.

## 모듈 구성
- `src/config/env.ts`
  - `.env` 기반 설정 로더
- `src/llm/openai-compatible.ts`
  - OpenAI 호환 API 어댑터
- `config/model-profiles.json`
  - API 서버/모델/에이전트(main-worker/single-main) 설정 관리
- `src/models/profile-registry.ts`
  - 후보 해석 및 프로파일 선택
- `src/runtime/session-store.ts`
  - 세션 생성/복구/저장
- `src/runtime/chat-service.ts`
  - 사용자 턴 실행 및 응답 저장
- `src/cli/chat.ts`
  - 지속 세션 인터랙티브 CLI
- `src/cli/chat-turn.ts`
  - 단일 턴 CLI

## 모듈 간 흐름
1. CLI에서 session id와 입력을 수신
2. `session-store`가 기존 히스토리를 복구
3. `chat-service`가 user 턴을 저장
4. provider가 `/chat/completions` 호출
5. assistant 응답을 세션에 저장

## 사용 방법
- 환경변수
  - `OPENAI_API_KEY`
  - `OPENAI_BASE_URL` (예: `http://127.0.0.1:1234/v1`)
  - `OPENAI_MODEL` (LM Studio에서 로드된 모델명)
  - `SYSTEM_PROMPT` (optional)
  - `SESSION_DIR` (optional, default: `./data/sessions`)
- 실행
  - `npm run chat -- --session default`
  - `npm run chat:turn -- --session default --message "안녕"`
  - `npm run models:list`
  - `npm run agent:run -- --agent default --goal "..."` 

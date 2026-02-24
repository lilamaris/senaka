# agent-orchestrator

## 관련 TODO
- `docs/todo/TODO-mvp-minimum-modules.md`
- `docs/todo/TODO-foundation-architecture.md`

## 기능 설명
사용자 목표를 받아 Agent Loop를 실행하는 핵심 오케스트레이터.

## 모듈 구성
- `src/runtime/agent-loop.ts`: worker/main 루프 실행, step 제어, 완료 판정
- `src/runtime/session-store.ts`: 세션 생성/복구/저장
- `src/models/role-router.ts`: agent 설정 기반 모드/모델 라우팅
- `src/cli/agent-run.ts`, `src/cli/agent-tui.ts`: 루프 실행 진입점과 사용자 개입 처리

## 모듈 간 흐름
1. 세션 시작
2. 목표/제약 로드
3. 모델 라우팅(Worker/Main)
4. 도구 실행 및 증거 반영
5. 완료 판정 후 결과 반환

## 사용 방법
- CLI(현재): `npm run chat -- --session <id>`, `npm run chat:turn -- --session <id> --message "..."`
- CLI(현재): `npm run agent:run -- --session <id> --agent <agent-id> --goal "<목표>"`
- `agent:run`에서 worker가 `ask`를 요청하면 `answer(YES/NO)>` 프롬프트로 응답
- CLI(TUI): `npm run agent:tui` 후 `/agent <id>`로 전환
- 옵션 override: `--mode single-main|main-worker`, `--max-steps <n>`, `--no-stream`
- WebUI(계획): 목표 입력 후 `Run`으로 동일 루프 실행

## 현재 구현 상태
- `src/runtime/agent-loop.ts`
  - worker 액션 루프(`call_tool`, `ask`, `finalize`) 기반 증거 수집
  - `call_tool` 시 shell 명령 실행 결과(stdout/stderr/exit code)를 worker에 재주입
  - `ask` 시 사용자 YES/NO 응답을 받아 동일 세션에서 증거 수집 계속 진행
  - `finalize` 시 main 모델이 증거 요약으로 충분성 판단 후 `finalize/continue` 결정
  - OpenAI compatible SSE 스트리밍 토큰 이벤트(worker/main) 발행
- 세션 로그에 worker tool/guidance 및 ask 질의/응답을 메시지로 저장
- `src/cli/agent-tui.ts`
  - Codex/OpenClaw 스타일의 로그+입력 기반 TUI 루프
  - 실행 중 step 이벤트 + 생성 토큰(worker/main) 실시간 출력

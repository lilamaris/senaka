# agent-orchestrator

## 관련 TODO
- `docs/todo/TODO-mvp-minimum-modules.md`
- `docs/todo/TODO-foundation-architecture.md`

## 기능 설명
사용자 목표를 받아 Agent Loop를 실행하는 핵심 오케스트레이터.

## 용어
- `Evidence Loop`(증거 수집 루프): worker가 도구/질문으로 증거를 모으고, main이 계속/종료를 판정하는 반복 실행 구간
- 상태 머신 일반 명칭:
  - `PlanIntent`: 요청 성격 분석 및 초기 전이 결정
  - `ContextGuard`: 컨텍스트 초과 전 대화 compaction
  - `AcquireEvidence`: worker 중심 증거 수집
  - `AssessSufficiency`: main의 `finalize/continue` 판단
  - `ForcedSynthesis`: 제한 초과/검증 실패 시 강제 최종화
  - `Done`: 세션 저장 및 결과 반환 완료

## 모듈 구성
- `src/runtime/agent-loop.ts`: agent loop 호환 엔트리(export)
- `src/runtime/agent-loop/run-loop.ts`: 상태 머신 기반 루프 본체
- `src/runtime/agent-loop/llm.ts`: worker/main LLM 호출, 샌드박스 명령 실행
- `src/runtime/agent-loop/helpers.ts`: 파싱/검증/프롬프트 빌더
- `src/runtime/agent-loop/types.ts`: 이벤트/액션/결과 타입
- `src/runtime/session-store.ts`: 세션 생성/복구/저장
- `src/models/role-router.ts`: agent 설정 기반 모드/모델 라우팅
- `src/cli/agent-run.ts`, `src/cli/agent-tui.ts`: 루프 실행 진입점과 사용자 개입 처리

## 모듈 간 흐름
1. 세션 시작
2. 목표/제약 로드
3. 모델 라우팅(Worker/Main)
4. `PlanIntent`에서 `AcquireEvidence`/`AssessSufficiency`/즉시 보고 경로 선택
5. 필요 시 `ContextGuard`가 세션 compaction 수행 후 원래 상태 복귀
6. 도구 실행 및 증거 반영
7. 완료 판정 후 결과 반환

## 사용 방법
- CLI(현재): `npm run chat -- --session <id>`, `npm run chat:turn -- --session <id> --message "..."`
- CLI(현재): `npm run agent:run -- --session <id> --agent <agent-id> --goal "<목표>"`
- `agent:run`에서 worker가 `ask`를 요청하면 `answer(YES/NO)>` 프롬프트로 응답
- CLI(TUI): `npm run agent:tui` 후 `/agent <id>`로 전환
- 옵션 override: `--mode single-main|main-worker`, `--max-steps <n>`, `--no-stream`
- WebUI(계획): 목표 입력 후 `Run`으로 동일 루프 실행

## 현재 구현 상태
- `src/runtime/agent-loop.ts`
  - planning 단계(`planning-start`, `planning-result`) 기반 초기 전이 결정
  - worker 액션 루프(`call_tool`, `ask`, `finalize`) 기반 증거 수집
  - 컨텍스트 길이 임계치 초과 시 세션 compaction(`context-guard`) 수행
  - 상태 머신 일반 명칭(`PlanIntent`, `ContextGuard`, `AcquireEvidence`, `AssessSufficiency`, `ForcedSynthesis`, `Done`) 적용
  - worker/main JSON 출력 스키마 검증 + 자동 재시도(repair prompt)
  - worker 응답 길이(최대 토큰 추정) 검증 + 초과 시 재생성
  - worker 검증 재시도 한도 초과 시 루프 종료 대신 `ForcedSynthesis`로 폴백
  - worker completion 요청 시 think bypass primer(`<think></think>`) 옵션 지원
  - `DEBUG_LLM_REQUESTS=true` 시 worker/main 요청 payload 요약과 think bypass 주입 여부 로그 출력
  - main 결정 단계에서도 think bypass 옵션 지원, 결정/최종응답 실패 시 폴백 응답 보장
  - `call_tool` 시 shell 명령 실행 결과(stdout/stderr/exit code)를 worker에 재주입
  - `ask` 시 사용자 YES/NO 응답을 받아 동일 세션에서 증거 수집 계속 진행
  - `finalize` 시 main 모델이 증거 + planning 문맥으로 충분성 판단 후 `finalize/continue` 결정
  - `AssessSufficiency`에서 `forced_synthesis_enable_think` 정책을 내려 `ForcedSynthesis` 단계의 think 활성 여부를 제어 가능
  - main finalize 응답이 JSON 형태면 plain text 최종 답변으로 재작성
  - OpenAI compatible SSE 스트리밍 토큰 이벤트(worker/main) 발행
- 세션 로그에 worker tool/guidance 및 ask 질의/응답을 메시지로 저장
- 세션 로그에 planning/compaction 요약 기록 저장
- `src/cli/agent-tui.ts`
  - Codex/OpenClaw 스타일의 로그+입력 기반 TUI 루프
  - 실행 중 planning/compaction/step 이벤트 + 생성 토큰(worker/main) 실시간 출력

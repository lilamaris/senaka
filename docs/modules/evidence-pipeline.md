# evidence-pipeline

## 관련 TODO
- `docs/todo/TODO-mvp-minimum-modules.md`
- `docs/todo/TODO-evidence-validation.md`

## 기능 설명
도구 실행 결과를 증거 단위로 수집/정규화/검증하여 루프 판정에 반영.

## 모듈 구성
- `src/runtime/agent-loop/run-loop.ts`
  - tool 결과를 `tool_result` 증거로 요약/보관
  - 사용자 응답을 `user_answer` 증거로 보관
  - main 판단 피드백을 `main_guidance` 증거로 보관
  - planning 단계의 `evidence_goals`/`guidance`를 초기 증거 문맥에 반영
  - main decision 입력 시 planning 요약 + 증거 요약을 병합
- `src/runtime/session-store.ts`
  - 세션 메시지 append-only 저장(JSON 파일)

## 판정 흐름
1. raw 결과 수집
2. worker/main 전달용 요약 정규화
3. main 모델이 `finalize/continue` 판단
4. `continue`면 guidance를 다시 worker 컨텍스트에 반영
5. 최종 `finalize` 응답을 세션에 저장

## 컨텍스트 압축(관련)
- `ContextGuard`가 트리거되면 오래된 메시지를 요약 문서로 압축
- 압축 문서에는 목표/실행 명령/결과/질의응답/가이드라인/실패 로그가 포함
- 압축 후에도 최신 메시지 일부는 유지해 직전 문맥 단절을 완화

## 사용 방법
- CLI: `npm run agent:run -- --session <id> --agent <id> --goal "..."`
- TUI: `npm run agent:tui`에서 tool/ask/main 이벤트 로그 확인

# interfaces-cli-webui

## 관련 TODO
- `docs/todo/TODO-mvp-minimum-modules.md`
- `docs/todo/TODO-interfaces-cli-webui.md`

## 기능 설명
CLI와 WebUI가 동일 런타임을 공유하도록 하여 운영 일관성 확보.

## 모듈 구성
- `src/cli/*.ts`: 명령 진입점, 스트리밍 출력, 수동 제어(현재 구현)
  - `agent-tui.ts`: interactive 실행 루프 + 상태 흐름 선형 로그 렌더
- `interfaces/webui`: 세션 대시보드, 증거/로그/설정 UI(계획)
- `interfaces/shared-client`: 공통 API/이벤트 구독 클라이언트(계획)

## UX 원칙
- CLI 우선 완전 기능 제공
- WebUI는 디버깅 가시성과 탐색성 강화
- 양쪽 모두 같은 세션 ID/이벤트 모델 사용

## 사용 방법
- CLI(현재): `npm run chat -- --session <id>`, `npm run chat:turn -- --session <id> --message "..."`
- CLI(현재): `npm run agent:run -- --session <id> --agent <agent-id> --group <group-id> --goal "<목표>"`
- CLI(현재): `npm run agent:tui`
- WebUI(향후): 계획 단계

## WebUI 상태
- WebUI 구현은 현재 리포지토리에서 제거됨
- 재도입 시 CLI 런타임 공유 원칙을 유지해야 함

## 현재 CLI TUI 기능
- `npm run agent:tui`로 목표 기반 agent loop 실행
- planning 단계 및 전이 결과(`planning-start`, `planning-result`) 표시
- context compaction 시작/완료(`compaction-start`, `compaction-complete`) 표시
- agent 설정 전환(`/agent <id>`)
- 그룹 워크스페이스 전환(`/group <id>`)
- worker/main 분리 모드 override(`/mode main-worker|single-main|auto`)
- 루프 최대 step override(`/steps N|auto`)
- 스트리밍 override(`/stream on|off|auto`)
- 세션 전환(`/session ID`)
- 상태 머신 단계(`PlanIntent`~`Done`)를 위→아래 선형 로그로 출력
- `worker-token` raw JSON 스트림을 숨기고, 도구 호출/결과는 구조화 로그로 출력
- main 스트림은 `main(<phase>)>` 단일 라인을 갱신하며 `<think>` 블록은 숨김 길이 메타로 축약 표시
- 턴 간 구분선(`TURN N START/END`)으로 실행 경계 표시
- blessed 기반 레이아웃으로 입력 영역(회색 배경 + 상/하 패딩)과 로그 영역을 분리해 resize 시 줄 중첩 없이 안정적으로 재렌더

## 현재 CLI 단일 실행 기능
- `agent:run`은 worker `ask` 액션 발생 시 `answer(YES/NO)>`로 사용자 응답 수집
- `agent:run`은 planning/compaction 이벤트를 표준 출력에 로그로 표시
- 실행 종료 후 모델/step/증거 요약과 최종 응답 출력

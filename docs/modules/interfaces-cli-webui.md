# interfaces-cli-webui

## 관련 TODO
- `docs/todo/TODO-mvp-minimum-modules.md`
- `docs/todo/TODO-interfaces-cli-webui.md`

## 기능 설명
CLI와 WebUI가 동일 런타임을 공유하도록 하여 운영 일관성 확보.

## 모듈 구성
- `interfaces/cli`: 명령 진입점, 스트리밍 출력, 수동 제어
- `interfaces/webui`: 세션 대시보드, 증거/로그/설정 UI
- `interfaces/shared-client`: 공통 API/이벤트 구독 클라이언트

## UX 원칙
- CLI 우선 완전 기능 제공
- WebUI는 디버깅 가시성과 탐색성 강화
- 양쪽 모두 같은 세션 ID/이벤트 모델 사용

## 사용 방법
- CLI(현재): `npm run chat -- --session <id>`, `npm run chat:turn -- --session <id> --message "..."`
- WebUI(향후): 계획 단계

## WebUI 상태
- WebUI 구현은 현재 리포지토리에서 제거됨
- 재도입 시 CLI 런타임 공유 원칙을 유지해야 함

## 현재 CLI TUI 기능
- `npm run agent:tui`로 목표 기반 agent loop 실행
- agent 설정 전환(`/agent <id>`)
- worker/main 분리 모드 override(`/mode main-worker|single-main|auto`)
- 루프 최대 step override(`/steps N|auto`)
- 스트리밍 override(`/stream on|off|auto`)
- 세션 전환(`/session ID`)
- worker/main 토큰 생성 스트리밍 무절단 실시간 확인(`WORKER STREAM`, `MAIN STREAM`)
- think 모델 출력은 `THINK PHASE` / `FINAL RESPONSE` 단락 분리
- 턴 간 구분선(`TURN N START/END`)으로 실행 경계 표시

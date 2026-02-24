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
- WebUI(현재): `npm run webui:install`, `npm run webui:dev` 후 `http://localhost:4173`

## 현재 WebUI 디버그 기능
- 세션 목록/업데이트 시간/메시지 수 조회
- 세션 선택 및 신규 세션 열기
- 세션 스레드 원문 조회(system/user/assistant)
- 사용자 턴 전송 및 응답 누적 저장
- 세션 리셋

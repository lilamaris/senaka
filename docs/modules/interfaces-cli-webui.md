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
- WebUI(계획): `/sessions`, `/session/:id`, `/settings/models`

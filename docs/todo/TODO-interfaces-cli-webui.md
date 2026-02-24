# TODO Interfaces CLI & WebUI

## 목표
CLI와 WebUI 모두에서 동일 기능을 투명하게 제공.

## TODO
- [ ] CLI 명령 체계 설계(`chat`, `run`, `trace`, `tool`, `evidence`)
- [x] CLI TUI 1차 구현(`agent:tui`, step 로그 스트림, 모드/세션 제어)
- [ ] CLI 스트리밍 출력 포맷(단계/증거/오류) 표준화
- [ ] WebUI 정보 구조 설계(세션 목록, 스레드 뷰, 턴 전송, 리셋)
- [ ] WebUI 타임라인/증거 패널/설정 고도화
- [ ] CLI/WebUI 공통 API 및 이벤트 구독 클라이언트 정의
- [ ] 사용자 수동 개입 UX(승인/중단/재시도) 통일
- [ ] 실행 이력 비교 화면(세션 간 diff) 요구사항 정의
- [ ] 접근 제어(단일 사용자/다중 사용자) 범위 결정

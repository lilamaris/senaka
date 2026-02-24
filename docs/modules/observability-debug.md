# observability-debug

## 기능 설명
실행 과정의 투명성 확보를 위한 이벤트/로그/트레이싱/디버깅 모듈.

## 모듈 구성
- `observability/event-bus`: 모든 실행 이벤트 발행
- `observability/trace-store`: step/tool/model 추적
- `observability/redaction-policy`: 비밀값 마스킹 규칙(최소화)
- `observability/live-stream`: CLI/WebUI 실시간 출력

## 노출 정책
- think 토큰(가능한 엔진에서) 메타데이터 표시
- 도구 호출 입력/출력, duration, exit code 표시
- 사용자 관측 우선 원칙: 숨김 최소화, 정책 기반 마스킹만 적용

## 사용 방법
- CLI: `hostctl trace watch --session <id>`
- WebUI: Timeline/Trace 패널로 전체 단계 재생

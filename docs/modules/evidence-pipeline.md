# evidence-pipeline

## 기능 설명
도구 실행 결과를 증거 단위로 수집/정규화/검증하여 루프 판정에 반영.

## 모듈 구성
- `evidence/collector`: raw 결과 수집(stdout/stderr)
- `evidence/normalizer`: 타입/출처/타임스탬프 표준화
- `evidence/verifier`: 목표 충족 증거 판정 규칙
- `evidence/store`: 세션별 append-only 저장소

## 판정 흐름
1. raw 결과 수집
2. 정규화
3. 검증 규칙 적용
4. 성공/불충분/충돌 상태 라벨링
5. Main 모델에 보고용 컨텍스트 전달

## 사용 방법
- CLI: `hostctl evidence tail --session <id>`
- WebUI: Evidence 탭에서 step별 원문/정규화 결과 확인

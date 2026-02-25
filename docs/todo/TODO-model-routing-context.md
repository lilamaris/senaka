# TODO Model Routing & Context

## 목표
시스템 프롬프트 압박을 줄이면서도 목표 달성 정확도를 유지.

## TODO
- [x] 모델 레지스트리 스키마 정의(`servers`, `models`, `agents`)
- [x] 역할 라우터 1차 구현(`main-worker`, `single-main`)
- [ ] 최소 주입 컨텍스트 정책 수립(필수 규칙/직전 증거/현재 목표)
- [x] 모델 `contextLength` 연동 및 컨텍스트 초과 시 대화 compaction 트리거 연결
- [ ] 장기 컨텍스트 요약/리하이드레이션 규칙 고도화(요약 품질/재주입 정책)
- [x] 저사양/고속 worker 후보 설정(`extraBody` 기반 provider 옵션, 예: `think: false`)
- [ ] 실패 패턴 기반 프롬프트 자동 경량화 규칙 작성
- [ ] 모델별 품질 벤치마크 시나리오(정확도/토큰비용/지연) 준비

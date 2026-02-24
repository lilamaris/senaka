# TODO Foundation Architecture

## 목표
24/7 운용 가능한 로컬 LLM 호스트 시스템의 런타임 골격 확정.

## TODO
- [ ] 런타임 디렉터리 골격(`runtime`, `models`, `tools`, `evidence`, `observability`, `interfaces`) 생성
- [ ] 세션 상태 모델 정의(`created`, `running`, `blocked`, `completed`, `failed`)
- [x] 에이전트 루프 기본 흐름 구현(worker 증거 수집 -> main 요약)
- [ ] 에이전트 루프 상태머신(재시도/중단/재개) 고도화
- [ ] 위험 작업 승인 게이트 정책 정의
- [ ] 단일 main 모델 모드와 main+worker 모드 전환 규칙 설계
- [ ] 24/7 데몬 실행/재기동 전략(systemd/pm2 등) 결정
- [ ] 장애 복구(프로세스 재시작 시 세션 복구) 시나리오 테스트 케이스 작성

# TODO Sandbox Group Workspace

## 목표
도구 실행 경로를 도커 샌드박스화하고, 그룹 단위 영구 워크스페이스를 운영 가능 상태로 만든다.

## 구현 TODO
- [x] 샌드박스 실행기 추가(`src/runtime/sandbox-executor.ts`)
- [x] `local`/`docker` 실행 모드 환경변수 도입
- [x] 그룹 ID 기반 컨테이너/워크스페이스 매핑
- [x] 컨테이너 자동 생성/재사용 로직 구현
- [x] `agent-loop` 도구 실행 경로를 샌드박스 실행기로 교체
- [x] CLI/TUI에서 그룹 지정 인자 추가(`--group`, `/group`)
- [x] tool 이벤트에 runner/group 정보 노출
- [ ] 그룹별 실행 감사 로그 저장소(`tool_runs`) 추가
- [ ] 컨테이너/워크스페이스 TTL 정리 배치 구현
- [ ] 네트워크 allowlist 정책(그룹/도구별) 추가
- [ ] seccomp/AppArmor 커스텀 프로파일 적용

## 검증 TODO
- [ ] 그룹 A/B 각각 파일 생성 후 재시작 시 보존 확인
- [ ] 동일 그룹에서 세션 변경 시 워크스페이스 공유 확인
- [ ] 도커 모드에서 메모리/CPU/PID 제한 적용 확인
- [ ] 네트워크 차단 정책(`--network none`) 동작 확인

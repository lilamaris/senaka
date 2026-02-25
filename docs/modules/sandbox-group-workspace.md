# sandbox-group-workspace

## 관련 TODO
- `docs/todo/TODO-mvp-minimum-modules.md`
- `docs/todo/TODO-sandbox-group-workspace.md`
- `docs/todo/TODO-tooling-mcp.md`

## 기능 설명
도구 호출을 그룹 단위 도커 샌드박스에서 실행하고, 그룹별 워크스페이스를 영구 보존한다.

## 모듈 구성
- `src/runtime/sandbox-executor.ts`
  - `local`/`docker` 실행 모드 분기
  - `group_id -> container + host workspace` 매핑
  - 컨테이너 자동 생성/재시작/재사용
- `src/runtime/agent-loop.ts`
  - worker `call_tool` 실행 시 샌드박스 실행기 호출
  - `workspaceGroupId` 전달 및 이벤트(`runner`, `workspaceGroupId`) 기록
- `src/cli/agent-run.ts`
  - `--group <id>`로 그룹 워크스페이스 지정
- `src/cli/agent-tui.ts`
  - `/group <id>` 명령으로 런타임 그룹 전환

## 인터페이스 정책
- 입력:
  - 기본 그룹: 세션 ID
  - 명시 그룹: `--group` 또는 `/group`
- 출력:
  - `tool-result` 이벤트에 `runner(local|docker)`, `workspaceGroupId` 포함
  - 증거 요약에도 runner/group 정보를 포함

## Docker 하드닝 기본값
- read-only root filesystem
- `/workspace`만 영구 RW 바인드 마운트
- `--cap-drop ALL`
- `--security-opt no-new-privileges`
- `--network none` (기본 차단)
- `--memory`, `--cpus`, `--pids-limit` 제한
- `tmpfs`(`/tmp`, `/run`) 최소 권한

## 운영 메모
- 그룹별 상태는 `DOCKER_WORKSPACE_ROOT/<group_id>`에 유지
- 미사용 그룹 컨테이너는 stop 가능, 워크스페이스는 유지
- 프로덕션에서는 컨테이너 TTL 정리 작업(cron/worker) 추가 권장

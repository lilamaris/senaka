# model-routing-context

## 관련 TODO
- `docs/todo/TODO-mvp-minimum-modules.md`
- `docs/todo/TODO-model-routing-context.md`

## 기능 설명
로컬 LLM 성능 편차를 고려해 모델 역할과 컨텍스트 주입량을 제어.

## 모듈 구성
- `models/profile-registry`: 모델/양자화별 capability 매핑
- `models/role-router`: main-only vs main+worker 결정
- `models/context-budgeter`: 최소 맥락 주입 규칙
- `models/prompt-kernel`: 시스템 프롬프트 압박 완화용 핵심 지시 집합

## 핵심 원칙
- 최소 정보로 단계 수행(필수 제약 + 직전 증거 + 현재 목표)
- 장기 문맥은 요약/인덱스화하여 필요 시 재주입
- 저성능 모델에서는 도구 스키마와 출력 형식을 더 단순화

## 사용 방법
- 레지스트리 관리: `config/model-profiles.json`
- 후보 확인: `npm run models:list`
- 실행 전략: `npm run agent:run -- --agent <agent-id> --goal "<목표>"`
- 필요 시 override: `--mode single-main|main-worker`, `--max-steps <n>`, `--no-stream`

## 현재 구현 상태
- `src/models/profile-registry.ts`로 `servers/models/agents` 로드
- `src/models/role-router.ts`로 agent 블럭 기반 `main-worker`, `single-main` 라우팅
- worker 후보에 `extraBody`를 넣어 `think: false` 같은 provider 옵션 전달 가능

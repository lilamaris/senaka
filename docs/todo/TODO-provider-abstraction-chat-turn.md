# TODO Provider Abstraction & Chat Turn

## 목표
OpenAI API 호환 provider(LM Studio 포함)로 지속형 chat turn 실행 기반을 확보.

## TODO
- [x] `.env` 기반 설정 로더 구성(`OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL`)
- [x] OpenAI 호환 provider 구현(`/chat/completions`)
- [x] 세션 파일 저장소 기반 채팅 히스토리 지속화
- [x] runtime chat turn 구성(user -> assistant 저장)
- [x] CLI 진입점(`chat`, `chat:turn`) 제공
- [ ] 다중 provider 타입 확장(예: vendor별 프로파일)
- [ ] 스트리밍 응답 처리
- [ ] tool call 필드 정규화(향후 에이전트 루프 연계)
- [ ] 재시도/백오프/에러 분류 정책 도입

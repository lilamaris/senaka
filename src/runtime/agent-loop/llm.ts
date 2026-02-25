import { readFile } from "node:fs/promises";
import { resolveChatCompletionApi } from "../../adapter/api/index.js";
import type { AppConfig } from "../../config/env.js";
import type { ChatCompletionApi, CompletionRequest } from "../../core/api/chat-completion.js";
import { runInSandbox } from "../sandbox-executor.js";
import {
  buildMainPlanningMessages,
  buildMainDecisionMessages,
  buildMainFinalAnswerMessages,
  buildStructuredRepairPrompt,
  fallbackFinalAnswer,
  looksLikeStructuredOutput,
  parseMainDecision,
  parsePlanningResult,
  parseWorkerAction,
  stripThinkBlocks,
  summarizePlanningContext,
  tryExtractAnswerField,
  validateCommandSafety,
  validateWorkerReplyTokenLimit,
} from "./helpers.js";
import type { MainDecision, PlanningResult, ToolResult, WorkerAction } from "./types.js";
import type { ChatMessage } from "../../types/chat.js";
import type { ResolvedModelCandidate } from "../../types/model.js";

/**
 * 파일 목적:
 * - agent loop에서 사용하는 LLM 호출(worker/main)과 도구 실행(shell sandbox)을 한곳에 모은다.
 *
 * 주요 의존성:
 * - adapter/api: provider별 chat completion API 해석
 * - helpers.ts: JSON 파싱/검증/수리 프롬프트/출력 정규화
 * - sandbox-executor.ts: 실제 셸 명령 실행
 *
 * 역의존성:
 * - src/runtime/agent-loop/run-loop.ts
 *
 * 모듈 흐름:
 * 1) worker/main 요청 생성
 * 2) 구조화 출력 검증 실패 시 repair prompt로 재시도
 * 3) 성공 시 파싱 결과 반환, 실패 시 상위 루프에서 폴백 처리
 */
const WORKER_SYSTEM_PROMPT_PATH = "data/worker/SYSTEM.md";
const MAIN_PLANNING_RETRY_LIMIT = 2;
const MAIN_DECISION_RETRY_LIMIT = 2;
const MAIN_FINAL_ANSWER_RETRY_LIMIT = 2;
// 샘플링 정책: worker/main-decision은 안정성 중심, final-report는 표현력 중심
const WORKER_SAMPLING = { temperature: 0.7, topP: 1.0 } as const;
const MAIN_PLANNING_SAMPLING = { temperature: 0.7, topP: 1.0 } as const;
const MAIN_DECISION_SAMPLING = { temperature: 0.7, topP: 1.0 } as const;
const MAIN_FINAL_REPORT_SAMPLING = { temperature: 1.0, topP: 0.95 } as const;

/**
 * 구조화 출력(JSON 스키마) 검증 실패를 일반 오류와 구분하기 위한 내부 오류 타입.
 */
class StructuredValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StructuredValidationError";
  }
}

/**
 * 단일 chat completion 호출 추상화.
 * - 0번째 시도에서만 stream 사용 가능
 * - 이후 재시도는 deterministic한 복구를 위해 complete 호출
 */
async function requestChatReply(params: {
  api: ChatCompletionApi;
  messages: ChatMessage[];
  attempt: number;
  streamOnFirstAttempt: boolean;
  request: Omit<CompletionRequest, "messages">;
  onToken?: (token: string) => void;
}): Promise<string> {
  const payload: CompletionRequest = {
    ...params.request,
    messages: params.messages,
  };
  const reply =
    params.attempt === 0 && params.streamOnFirstAttempt
      ? await params.api.stream(payload, { onToken: params.onToken })
      : await params.api.complete(payload);
  return reply.content;
}

/**
 * "구조화 출력 + 자동 수리 재시도" 공통 템플릿.
 * worker action / main decision에서 동일 패턴이 반복되어 공통화했다.
 */
async function requestStructuredWithRepair<T>(params: {
  api: ChatCompletionApi;
  baseMessages: ChatMessage[];
  retryLimit: number;
  streamOnFirstAttempt: boolean;
  requestForAttempt: (messages: ChatMessage[], attempt: number) => Omit<CompletionRequest, "messages">;
  parse: (rawContent: string) => T;
  repairKind: "worker-action" | "main-decision" | "planning";
  onToken?: (token: string) => void;
}): Promise<T> {
  let messages = params.baseMessages;

  for (let attempt = 0; attempt <= params.retryLimit; attempt += 1) {
    const content = await requestChatReply({
      api: params.api,
      messages,
      attempt,
      streamOnFirstAttempt: params.streamOnFirstAttempt,
      request: params.requestForAttempt(messages, attempt),
      onToken: params.onToken,
    });

    try {
      return params.parse(content);
    } catch (error) {
      const reason = (error as Error).message;
      if (attempt >= params.retryLimit) {
        throw new StructuredValidationError(reason);
      }
      // 이전 잘못된 답변을 assistant 메시지로 포함해 모델이 자기 출력 오류를 교정하게 한다.
      messages = [
        ...params.baseMessages,
        { role: "assistant", content },
        buildStructuredRepairPrompt(params.repairKind, reason),
      ];
    }
  }

  throw new Error("structured completion retries exhausted");
}

/**
 * worker가 요청한 셸 명령을 sandbox에서 실행한다.
 * 실행 전 validateCommandSafety로 기본 안전장치를 적용한다.
 */
export async function runShellCommand(config: AppConfig, cmd: string, workspaceGroupId: string): Promise<ToolResult> {
  validateCommandSafety(cmd, config.toolMaxPipes);
  return runInSandbox(cmd, workspaceGroupId, {
    mode: config.toolSandboxMode,
    timeoutMs: config.toolTimeoutMs,
    maxBufferBytes: config.toolMaxBufferBytes,
    shellPath: config.toolShellPath,
    dockerShellPath: config.dockerShellPath,
    dockerImage: config.dockerSandboxImage,
    dockerWorkspaceRoot: config.dockerWorkspaceRoot,
    dockerContainerPrefix: config.dockerContainerPrefix,
    dockerNetwork: config.dockerNetwork,
    dockerMemory: config.dockerMemory,
    dockerCpus: config.dockerCpus,
    dockerPidsLimit: config.dockerPidsLimit,
  });
}

/**
 * worker 시스템 프롬프트 파일 로더.
 */
export async function loadWorkerSystemPrompt(): Promise<string> {
  const raw = await readFile(WORKER_SYSTEM_PROMPT_PATH, "utf-8");
  return raw.trim();
}

/**
 * 루프 시작 전 planning 단계를 수행한다.
 * 사용자 목적과 기존 대화 맥락을 바탕으로 다음 상태 전이를 결정한다.
 */
export async function askMainForPlanning(params: {
  config: AppConfig;
  allowStreaming: boolean;
  goal: string;
  sessionContext: string[];
  onToken?: (token: string) => void;
  mainModel: ResolvedModelCandidate;
}): Promise<PlanningResult> {
  const baseMessages = buildMainPlanningMessages(params.goal, params.sessionContext);
  const mainApi = resolveChatCompletionApi(params.mainModel);

  return requestStructuredWithRepair({
    api: mainApi,
    baseMessages,
    retryLimit: MAIN_PLANNING_RETRY_LIMIT,
    streamOnFirstAttempt: params.allowStreaming,
    requestForAttempt: (_messages, _attempt) => ({
      disableThinkingHack: params.config.mainDecisionDisableThinkingHack,
      thinkBypassTag: params.config.mainDecisionThinkBypassTag,
      ...MAIN_PLANNING_SAMPLING,
      debugEnabled: params.config.debugLlmRequests,
      debugTag: "main-planning",
    }),
    parse: parsePlanningResult,
    repairKind: "planning",
    onToken: params.onToken,
  });
}

/**
 * main 모델에게 "continue/finalize 결정"을 요청한다.
 * 응답은 JSON 스키마로 강제하며, 실패 시 자동 수리 프롬프트로 재시도한다.
 */
export async function askMainForDecision(params: {
  config: AppConfig;
  allowStreaming: boolean;
  goal: string;
  evidenceSummary: string[];
  onToken?: (token: string) => void;
  forceFinalize: boolean;
  enableThinkOverride?: boolean;
  mainModel: ResolvedModelCandidate;
}): Promise<MainDecision> {
  const baseMessages = buildMainDecisionMessages(params.goal, params.evidenceSummary, params.forceFinalize);
  const mainApi = resolveChatCompletionApi(params.mainModel);
  const disableThinkingHack =
    typeof params.enableThinkOverride === "boolean"
      ? !params.enableThinkOverride
      : params.config.mainDecisionDisableThinkingHack;
  return requestStructuredWithRepair({
    api: mainApi,
    baseMessages,
    retryLimit: MAIN_DECISION_RETRY_LIMIT,
    streamOnFirstAttempt: params.allowStreaming,
    requestForAttempt: (_messages, _attempt) => ({
      disableThinkingHack,
      thinkBypassTag: params.config.mainDecisionThinkBypassTag,
      ...MAIN_DECISION_SAMPLING,
      debugEnabled: params.config.debugLlmRequests,
      debugTag: "main-decision",
    }),
    parse: parseMainDecision,
    repairKind: "main-decision",
    onToken: params.onToken,
  });
}

/**
 * worker 모델에게 다음 액션(call_tool/ask/finalize)을 요청한다.
 * 응답 길이, JSON 스키마, 명령 안전성까지 한 번에 검증한다.
 */
export async function askWorkerForAction(params: {
  config: AppConfig;
  step: number;
  maxRetries: number;
  allowStreaming: boolean;
  model: ResolvedModelCandidate;
  workerMessages: ChatMessage[];
  onToken?: (token: string) => void;
}): Promise<WorkerAction> {
  const workerApi = resolveChatCompletionApi(params.model);
  const baseMessages = params.workerMessages;
  try {
    return await requestStructuredWithRepair({
      api: workerApi,
      baseMessages,
      retryLimit: params.maxRetries,
      streamOnFirstAttempt: params.allowStreaming,
      requestForAttempt: (_messages, attempt) => ({
        disableThinkingHack: params.config.workerDisableThinkingHack,
        thinkBypassTag: params.config.workerThinkBypassTag,
        maxTokens: params.config.workerMaxResponseTokens,
        ...WORKER_SAMPLING,
        debugEnabled: params.config.debugLlmRequests,
        debugTag: `worker-action-step-${params.step}-attempt-${attempt}`,
      }),
      parse: (rawContent) => {
        // 일부 모델이 <think> 블록을 섞어 반환하므로 파싱 전에 제거한다.
        const cleaned = stripThinkBlocks(rawContent);
        validateWorkerReplyTokenLimit(cleaned, params.config.workerMaxResponseTokens);
        const parsed = parseWorkerAction(cleaned);
        if (parsed.action === "call_tool") {
          validateCommandSafety(parsed.args.cmd, params.config.toolMaxPipes);
        }
        return parsed;
      },
      repairKind: "worker-action",
      onToken: params.onToken,
    });
  } catch (error) {
    if (error instanceof StructuredValidationError) {
      throw new Error(`worker action schema validation failed at step ${params.step}: ${error.message}`);
    }
    throw error;
  }
}

/**
 * 최종 사용자 리포트를 생성한다.
 * - stream=true면 첫 시도에서 토큰 스트리밍
 * - 구조화 출력(JSON/코드블록)일 경우 plain text로 재작성 재시도
 */
export async function askMainForFinalAnswer(params: {
  config: AppConfig;
  goal: string;
  evidenceSummary: string[];
  decisionContext?: string;
  planning?: PlanningResult;
  draft?: string;
  allowStreaming: boolean;
  onToken?: (token: string) => void;
  enableThinkOverride?: boolean;
  mainModel: ResolvedModelCandidate;
}): Promise<string> {
  const planningContext = summarizePlanningContext(params.planning);
  const mergedDecisionContext = [planningContext, params.decisionContext].filter(Boolean).join("\n");
  const mainApi = resolveChatCompletionApi(params.mainModel);
  const baseMessages = buildMainFinalAnswerMessages(
    params.goal,
    params.evidenceSummary,
    mergedDecisionContext || undefined,
    params.draft,
  );
  let messages = baseMessages;
  const disableThinkingHack =
    typeof params.enableThinkOverride === "boolean" ? !params.enableThinkOverride : undefined;

  for (let attempt = 0; attempt <= MAIN_FINAL_ANSWER_RETRY_LIMIT; attempt += 1) {
    const content = await requestChatReply({
      api: mainApi,
      messages,
      attempt,
      streamOnFirstAttempt: params.allowStreaming,
      request: {
        ...MAIN_FINAL_REPORT_SAMPLING,
        ...(typeof disableThinkingHack === "boolean"
          ? {
              disableThinkingHack,
              thinkBypassTag: params.config.mainDecisionThinkBypassTag,
            }
          : {}),
        debugEnabled: params.config.debugLlmRequests,
        debugTag: `main-final-answer-attempt-${attempt}`,
      },
      onToken: params.onToken,
    });
    const direct = content.trim();
    const extracted = tryExtractAnswerField(direct);
    const candidate = (extracted || direct).trim();

    if (candidate && !looksLikeStructuredOutput(candidate)) {
      return candidate;
    }

    if (attempt >= MAIN_FINAL_ANSWER_RETRY_LIMIT) {
      break;
    }

    // "최종 응답은 자연어 텍스트만" 규칙을 다시 강조해 포맷 오류를 교정한다.
    messages = [
      ...baseMessages,
      { role: "assistant", content },
      {
        role: "user",
        content:
          "Invalid format: your answer still looks structured. Re-write in plain natural language only with no JSON/code blocks.",
      },
    ];
  }

  return fallbackFinalAnswer(params.goal, params.evidenceSummary);
}

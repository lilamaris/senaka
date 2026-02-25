import { readFile } from "node:fs/promises";
import { resolveChatCompletionApi } from "../../adapter/api/index.js";
import type { AppConfig } from "../../config/env.js";
import { runInSandbox } from "../sandbox-executor.js";
import {
  buildMainDecisionMessages,
  buildMainFinalAnswerMessages,
  buildStructuredRepairPrompt,
  fallbackFinalAnswer,
  looksLikeStructuredOutput,
  parseMainDecision,
  parseWorkerAction,
  stripThinkBlocks,
  tryExtractAnswerField,
  validateCommandSafety,
  validateWorkerReplyTokenLimit,
} from "./helpers.js";
import type { MainDecision, ToolResult, WorkerAction } from "./types.js";
import type { ChatMessage } from "../../types/chat.js";
import type { ResolvedModelCandidate } from "../../types/model.js";

const WORKER_SYSTEM_PROMPT_PATH = "data/worker/SYSTEM.md";
const MAX_MAIN_DECISION_RETRIES = 2;
const MAX_FINAL_ANSWER_RETRIES = 2;

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

export async function loadWorkerSystemPrompt(): Promise<string> {
  const raw = await readFile(WORKER_SYSTEM_PROMPT_PATH, "utf-8");
  return raw.trim();
}

export async function askMainForDecision(params: {
  config: AppConfig;
  routedStream: boolean;
  goal: string;
  evidenceSummary: string[];
  onToken?: (token: string) => void;
  forceFinalize: boolean;
  mainModel: ResolvedModelCandidate;
}): Promise<MainDecision> {
  const baseMessages = buildMainDecisionMessages(params.goal, params.evidenceSummary, params.forceFinalize);
  const mainApi = resolveChatCompletionApi(params.mainModel);
  let messages = baseMessages;

  for (let attempt = 0; attempt <= MAX_MAIN_DECISION_RETRIES; attempt += 1) {
    const reply =
      attempt === 0 && params.routedStream
        ? await mainApi.stream(
            {
              messages,
              disableThinkingHack: params.config.mainDecisionDisableThinkingHack,
              thinkBypassTag: params.config.mainDecisionThinkBypassTag,
              debugEnabled: params.config.debugLlmRequests,
              debugTag: "main-decision",
            },
            { onToken: params.onToken },
          )
        : await mainApi.complete({
            messages,
            disableThinkingHack: params.config.mainDecisionDisableThinkingHack,
            thinkBypassTag: params.config.mainDecisionThinkBypassTag,
            debugEnabled: params.config.debugLlmRequests,
            debugTag: "main-decision",
          });

    try {
      return parseMainDecision(reply.content);
    } catch (error) {
      if (attempt >= MAX_MAIN_DECISION_RETRIES) {
        throw error;
      }
      const reason = (error as Error).message;
      messages = [
        ...baseMessages,
        { role: "assistant", content: reply.content },
        buildStructuredRepairPrompt("main-decision", reason),
      ];
    }
  }

  throw new Error("main decision retries exhausted");
}

export async function askWorkerForAction(params: {
  config: AppConfig;
  step: number;
  maxRetries: number;
  routedStream: boolean;
  model: ResolvedModelCandidate;
  workerMessages: ChatMessage[];
  onToken?: (token: string) => void;
}): Promise<WorkerAction> {
  const workerApi = resolveChatCompletionApi(params.model);
  const baseMessages = params.workerMessages;
  let messages = baseMessages;

  for (let attempt = 0; attempt <= params.maxRetries; attempt += 1) {
    const reply =
      attempt === 0 && params.routedStream
        ? await workerApi.stream(
            {
              messages,
              disableThinkingHack: params.config.workerDisableThinkingHack,
              thinkBypassTag: params.config.workerThinkBypassTag,
              maxTokens: params.config.workerMaxResponseTokens,
              debugEnabled: params.config.debugLlmRequests,
              debugTag: `worker-action-step-${params.step}-attempt-${attempt}`,
            },
            { onToken: params.onToken },
          )
        : await workerApi.complete({
            messages,
            disableThinkingHack: params.config.workerDisableThinkingHack,
            thinkBypassTag: params.config.workerThinkBypassTag,
            maxTokens: params.config.workerMaxResponseTokens,
            debugEnabled: params.config.debugLlmRequests,
            debugTag: `worker-action-step-${params.step}-attempt-${attempt}`,
          });

    try {
      const cleaned = stripThinkBlocks(reply.content);
      validateWorkerReplyTokenLimit(cleaned, params.config.workerMaxResponseTokens);
      const parsed = parseWorkerAction(cleaned);
      if (parsed.action === "call_tool") {
        validateCommandSafety(parsed.args.cmd, params.config.toolMaxPipes);
      }
      return parsed;
    } catch (error) {
      if (attempt >= params.maxRetries) {
        throw new Error(`worker action schema validation failed at step ${params.step}: ${(error as Error).message}`);
      }

      const reason = (error as Error).message;
      messages = [
        ...baseMessages,
        { role: "assistant", content: reply.content },
        buildStructuredRepairPrompt("worker-action", reason),
      ];
    }
  }

  throw new Error(`worker action retries exhausted at step ${params.step}`);
}

export async function askMainForFinalAnswer(params: {
  config: AppConfig;
  goal: string;
  evidenceSummary: string[];
  decisionContext?: string;
  draft?: string;
  mainModel: ResolvedModelCandidate;
}): Promise<string> {
  const mainApi = resolveChatCompletionApi(params.mainModel);
  const baseMessages = buildMainFinalAnswerMessages(
    params.goal,
    params.evidenceSummary,
    params.decisionContext,
    params.draft,
  );
  let messages = baseMessages;

  for (let attempt = 0; attempt <= MAX_FINAL_ANSWER_RETRIES; attempt += 1) {
    const reply = await mainApi.complete({
      messages,
      debugEnabled: params.config.debugLlmRequests,
      debugTag: "main-final-answer",
    });
    const direct = reply.content.trim();
    const extracted = tryExtractAnswerField(direct);
    const candidate = (extracted || direct).trim();

    if (candidate && !looksLikeStructuredOutput(candidate)) {
      return candidate;
    }

    if (attempt >= MAX_FINAL_ANSWER_RETRIES) {
      break;
    }

    messages = [
      ...baseMessages,
      { role: "assistant", content: reply.content },
      {
        role: "user",
        content:
          "Invalid format: your answer still looks structured. Re-write in plain natural language only with no JSON/code blocks.",
      },
    ];
  }

  return fallbackFinalAnswer(params.goal, params.evidenceSummary);
}

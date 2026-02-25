import { resolveChatCompletionApi } from "../adapter/api/index.js";
import type { AppConfig } from "../config/env.js";
import type { ChatCompletionResponse, ChatMessage } from "../types/chat.js";
import type { ResolvedModelCandidate } from "../types/model.js";

export interface StreamHandlers {
  onToken?: (token: string) => void;
}

function defaultCandidate(config: AppConfig): ResolvedModelCandidate {
  return {
    id: "default",
    provider: "openai-compatible",
    baseUrl: config.openaiBaseUrl,
    apiKey: config.openaiApiKey,
    model: config.openaiModel,
    temperature: 0.2,
  };
}

export async function createChatCompletion(
  config: AppConfig,
  messages: ChatMessage[],
): Promise<ChatCompletionResponse> {
  return createChatCompletionByCandidate(defaultCandidate(config), messages);
}

export async function createChatCompletionByCandidate(
  candidate: ResolvedModelCandidate,
  messages: ChatMessage[],
): Promise<ChatCompletionResponse> {
  const api = resolveChatCompletionApi(candidate);
  return api.complete({ messages });
}

export async function streamChatCompletionByCandidate(
  candidate: ResolvedModelCandidate,
  messages: ChatMessage[],
  handlers?: StreamHandlers,
): Promise<ChatCompletionResponse> {
  const api = resolveChatCompletionApi(candidate);
  return api.stream({ messages }, { onToken: handlers?.onToken });
}

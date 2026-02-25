import type { ChatCompletionResponse, ChatMessage } from "../../types/chat.js";
import type { ProviderType, ResolvedModelCandidate } from "../../types/model.js";

export interface CompletionRequest {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  extraBody?: Record<string, unknown>;
}

export interface StreamHandler {
  onToken?: (token: string) => void;
}

export interface ChatCompletionApi {
  complete(request: CompletionRequest): Promise<ChatCompletionResponse>;
  stream(request: CompletionRequest, handlers?: StreamHandler): Promise<ChatCompletionResponse>;
}

export interface ChatCompletionAdapter {
  readonly provider: ProviderType;
  create(candidate: ResolvedModelCandidate): ChatCompletionApi;
}

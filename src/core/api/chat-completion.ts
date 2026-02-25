import type { ChatCompletionResponse, ChatMessage } from "../../types/chat.js";
import type { ProviderType, ResolvedModelCandidate } from "../../types/model.js";
import type { ModelLoadOption } from "../model/type.js";

export interface CompletionRequest extends ModelLoadOption {
  messages: ChatMessage[];
  debugEnabled?: boolean;
  debugTag?: string;
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

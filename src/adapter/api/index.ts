import type { ChatCompletionApi } from "../../core/api/chat-completion.js";
import type { ResolvedModelCandidate } from "../../types/model.js";
import { OpenAIAdapter, OpenAICompatibleAdapter } from "./openai.js";

const openaiCompatible = new OpenAICompatibleAdapter();
const openai = new OpenAIAdapter();

export function resolveChatCompletionApi(candidate: ResolvedModelCandidate): ChatCompletionApi {
  if (candidate.provider === "openai-compatible") {
    return openaiCompatible.create(candidate);
  }

  if (candidate.provider === "openai") {
    return openai.create(candidate);
  }

  if (candidate.provider === "claude-code") {
    throw new Error("Provider not implemented yet: claude-code");
  }

  throw new Error(`Unsupported provider: ${(candidate as { provider?: string }).provider ?? "<unknown>"}`);
}

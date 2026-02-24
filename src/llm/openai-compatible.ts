import type { AppConfig } from "../config/env.js";
import type { ChatCompletionResponse, ChatMessage } from "../types/chat.js";
import type { ResolvedModelCandidate } from "../types/model.js";

interface OpenAICompatibleChoice {
  message?: {
    role?: string;
    content?: string;
  };
}

interface OpenAICompatibleResponse {
  choices?: OpenAICompatibleChoice[];
}

export async function createChatCompletion(
  config: AppConfig,
  messages: ChatMessage[],
): Promise<ChatCompletionResponse> {
  return createChatCompletionByCandidate(
    {
      id: "default",
      provider: "openai-compatible",
      baseUrl: config.openaiBaseUrl,
      apiKey: config.openaiApiKey,
      model: config.openaiModel,
      temperature: 0.2,
    },
    messages,
  );
}

export async function createChatCompletionByCandidate(
  candidate: ResolvedModelCandidate,
  messages: ChatMessage[],
): Promise<ChatCompletionResponse> {
  const endpoint = `${candidate.baseUrl.replace(/\/$/, "")}/chat/completions`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${candidate.apiKey}`,
    },
    body: JSON.stringify({
      model: candidate.model,
      messages,
      temperature: candidate.temperature ?? 0.2,
      ...(candidate.maxTokens ? { max_tokens: candidate.maxTokens } : {}),
      ...(candidate.extraBody ?? {}),
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`LLM request failed (${response.status}): ${errorBody}`);
  }

  const data = (await response.json()) as OpenAICompatibleResponse;
  const content = data.choices?.[0]?.message?.content?.trim();

  if (!content) {
    throw new Error("LLM response did not contain assistant content");
  }

  return { content, raw: data };
}

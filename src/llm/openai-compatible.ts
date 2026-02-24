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

interface OpenAIStreamDelta {
  content?: string;
}

interface OpenAIStreamChoice {
  delta?: OpenAIStreamDelta;
  message?: {
    content?: string;
  };
}

interface OpenAIStreamChunk {
  choices?: OpenAIStreamChoice[];
}

export interface StreamHandlers {
  onToken?: (token: string) => void;
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

function extractChunkToken(chunk: OpenAIStreamChunk): string {
  const choice = chunk.choices?.[0];
  return choice?.delta?.content ?? choice?.message?.content ?? "";
}

async function readSSEStream(response: Response, handlers?: StreamHandlers): Promise<string> {
  if (!response.body) {
    throw new Error("stream response body is unavailable");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let done = false;
  let pending = "";
  let fullText = "";

  while (!done) {
    const result = await reader.read();
    done = result.done;
    pending += decoder.decode(result.value ?? new Uint8Array(), { stream: !done });

    let idx = pending.indexOf("\n");
    while (idx >= 0) {
      const line = pending.slice(0, idx).trim();
      pending = pending.slice(idx + 1);

      if (line.startsWith("data:")) {
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          break;
        }

        try {
          const parsed = JSON.parse(payload) as OpenAIStreamChunk;
          const token = extractChunkToken(parsed);
          if (token) {
            fullText += token;
            handlers?.onToken?.(token);
          }
        } catch {
          // Ignore non-JSON keepalive chunks.
        }
      }

      idx = pending.indexOf("\n");
    }
  }

  return fullText.trim();
}

export async function streamChatCompletionByCandidate(
  candidate: ResolvedModelCandidate,
  messages: ChatMessage[],
  handlers?: StreamHandlers,
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
      stream: true,
      temperature: candidate.temperature ?? 0.2,
      ...(candidate.maxTokens ? { max_tokens: candidate.maxTokens } : {}),
      ...(candidate.extraBody ?? {}),
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`LLM stream request failed (${response.status}): ${errorBody}`);
  }

  const content = await readSSEStream(response, handlers);
  if (!content) {
    throw new Error("LLM stream did not contain assistant content");
  }

  return { content, raw: { streamed: true } };
}

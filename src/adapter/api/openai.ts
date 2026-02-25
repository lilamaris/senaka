import type {
  ChatCompletionAdapter,
  ChatCompletionApi,
  CompletionRequest,
  StreamHandler,
} from "../../core/api/chat-completion.js";
import type { ChatCompletionResponse, ChatMessage } from "../../types/chat.js";
import type { ResolvedModelCandidate } from "../../types/model.js";

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

function toEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/chat/completions`;
}

function applyThinkingBypassHack(messages: ChatMessage[], tag: string): ChatMessage[] {
  const idx = messages.findIndex((message) => message.role === "user");
  if (idx < 0) {
    return messages;
  }

  const assistantPrimer: ChatMessage = {
    role: "assistant",
    content: tag,
  };

  return [...messages.slice(0, idx + 1), assistantPrimer, ...messages.slice(idx + 1)];
}

function toRequestBody(candidate: ResolvedModelCandidate, request: CompletionRequest, stream: boolean): Record<string, unknown> {
  const messages =
    request.disableThinkingHack === true
      ? applyThinkingBypassHack(request.messages, request.thinkBypassTag?.trim() || "<think></think>")
      : request.messages;

  return {
    model: candidate.model,
    messages,
    ...(stream ? { stream: true } : {}),
    temperature: request.temperature ?? candidate.temperature ?? 0.2,
    ...(request.maxTokens ?? candidate.maxTokens ? { max_tokens: request.maxTokens ?? candidate.maxTokens } : {}),
    ...(request.topP !== undefined ? { top_p: request.topP } : {}),
    ...(request.minP !== undefined ? { min_p: request.minP } : {}),
    ...(request.topK !== undefined ? { top_k: request.topK } : {}),
    ...(candidate.extraBody ?? {}),
    ...(request.extraBody ?? {}),
  };
}

function extractChunkToken(chunk: OpenAIStreamChunk): string {
  const choice = chunk.choices?.[0];
  return choice?.delta?.content ?? choice?.message?.content ?? "";
}

async function readSSEStream(response: Response, handlers?: StreamHandler): Promise<string> {
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

class OpenAIChatCompletionApi implements ChatCompletionApi {
  constructor(private readonly candidate: ResolvedModelCandidate) {}

  async complete(request: CompletionRequest): Promise<ChatCompletionResponse> {
    const response = await fetch(toEndpoint(this.candidate.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.candidate.apiKey}`,
      },
      body: JSON.stringify(toRequestBody(this.candidate, request, false)),
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

  async stream(request: CompletionRequest, handlers?: StreamHandler): Promise<ChatCompletionResponse> {
    const response = await fetch(toEndpoint(this.candidate.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.candidate.apiKey}`,
      },
      body: JSON.stringify(toRequestBody(this.candidate, request, true)),
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
}

export class OpenAICompatibleAdapter implements ChatCompletionAdapter {
  readonly provider = "openai-compatible" as const;

  create(candidate: ResolvedModelCandidate): ChatCompletionApi {
    return new OpenAIChatCompletionApi(candidate);
  }
}

export class OpenAIAdapter implements ChatCompletionAdapter {
  readonly provider = "openai" as const;

  create(candidate: ResolvedModelCandidate): ChatCompletionApi {
    return new OpenAIChatCompletionApi(candidate);
  }
}

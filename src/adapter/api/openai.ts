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

function applyThinkingPrefill(messages: ChatMessage[], tag: string): ChatMessage[] {
  const idx = [...messages]
    .map((message, i) => ({ role: message.role, i }))
    .reverse()
    .find((entry) => entry.role === "user")?.i;
  if (idx === undefined) {
    return messages;
  }

  const assistantPrimer: ChatMessage = {
    role: "assistant",
    content: tag,
  };

  return [
    ...messages.slice(0, idx + 1),
    assistantPrimer,
    ...messages.slice(idx + 1),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function applyThinkingCompatibilityFields(
  baseExtraBody: Record<string, unknown>,
  enableThinking: boolean | undefined,
): Record<string, unknown> {
  if (typeof enableThinking !== "boolean") {
    return baseExtraBody;
  }

  const nestedExtraBody = isRecord(baseExtraBody.extra_body) ? baseExtraBody.extra_body : {};
  return {
    ...baseExtraBody,
    enable_thinking: enableThinking,
    extra_body: {
      ...nestedExtraBody,
      enable_thinking: enableThinking,
    },
  };
}

function toRequestBody(
  candidate: ResolvedModelCandidate,
  request: CompletionRequest,
  stream: boolean,
): Record<string, unknown> {
  const enableThinking = request.enableThinking;
  const messages =
    enableThinking === false
      ? applyThinkingPrefill(
          request.messages,
          request.thinkingPrefillTag?.trim() || "<think></think>",
        )
      : request.messages;
  const mergedExtraBody = {
    ...(candidate.extraBody ?? {}),
    ...(request.extraBody ?? {}),
  };
  const compatibleExtraBody = applyThinkingCompatibilityFields(
    mergedExtraBody,
    enableThinking,
  );

  return {
    model: candidate.model,
    messages,
    ...(stream ? { stream: true } : {}),
    temperature: request.temperature ?? candidate.temperature ?? 0.2,
    ...((request.maxTokens ?? candidate.maxTokens)
      ? { max_tokens: request.maxTokens ?? candidate.maxTokens }
      : {}),
    ...(request.topP !== undefined ? { top_p: request.topP } : {}),
    ...(request.minP !== undefined ? { min_p: request.minP } : {}),
    ...(request.topK !== undefined ? { top_k: request.topK } : {}),
    ...(typeof enableThinking === "boolean"
      ? { enable_thinking: enableThinking }
      : {}),
    ...compatibleExtraBody,
  };
}

function detectThinkingPrefillInjection(messages: ChatMessage[], tag: string): boolean {
  const userIdx = [...messages]
    .map((message, i) => ({ role: message.role, i }))
    .reverse()
    .find((entry) => entry.role === "user")?.i;
  if (userIdx === undefined || userIdx + 1 >= messages.length) {
    return false;
  }
  const next = messages[userIdx + 1];
  return next.role === "assistant" && next.content === tag;
}

function toOneLine(value: string, maxLen = 220): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLen) {
    return compact;
  }
  return `${compact.slice(0, maxLen)}...`;
}

function debugLogRequest(params: {
  candidate: ResolvedModelCandidate;
  request: CompletionRequest;
  body: Record<string, unknown>;
  stream: boolean;
}): void {
  const enabled = params.request.debugEnabled === true;
  if (!enabled) {
    return;
  }

  const tag = params.request.thinkingPrefillTag?.trim() || "<think></think>";
  const bodyMessages = (params.body.messages as ChatMessage[]) ?? [];
  const injected = detectThinkingPrefillInjection(bodyMessages, tag);
  const roleSeq = bodyMessages.map((m) => m.role).join(">");
  const preview = bodyMessages
    .slice(0, 3)
    .map((m, i) => `${i}:${m.role}:${toOneLine(m.content, 80)}`)
    .join(" | ");
  const maxTokens =
    typeof params.body.max_tokens === "number"
      ? String(params.body.max_tokens)
      : "<unset>";

  process.stderr.write(
    [
      "[llm-debug]",
      `tag=${params.request.debugTag ?? "unknown"}`,
      `provider=${params.candidate.provider}`,
      `model=${params.candidate.model}`,
      `stream=${params.stream}`,
      `enableThinking=${typeof params.request.enableThinking === "boolean" ? params.request.enableThinking : "<unset>"}`,
      `thinkingPrefillInjected=${injected}`,
      `max_tokens=${maxTokens}`,
      `roleSeq=${roleSeq}`,
      `preview=${preview}`,
    ].join(" ") + "\n",
  );
}

function extractChunkToken(chunk: OpenAIStreamChunk): string {
  const choice = chunk.choices?.[0];
  return choice?.delta?.content ?? choice?.message?.content ?? "";
}

async function readSSEStream(
  response: Response,
  handlers?: StreamHandler,
): Promise<string> {
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
    pending += decoder.decode(result.value ?? new Uint8Array(), {
      stream: !done,
    });

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

async function postChatCompletion(
  candidate: ResolvedModelCandidate,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(toEndpoint(candidate.baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${candidate.apiKey}`,
    },
    body: JSON.stringify(body),
  });
}

async function requestOpenAIResponse(
  candidate: ResolvedModelCandidate,
  body: Record<string, unknown>,
  errorPrefix: string,
): Promise<Response> {
  const response = await postChatCompletion(candidate, body);
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`${errorPrefix} (${response.status}): ${errorBody}`);
  }
  return response;
}

class OpenAIChatCompletionApi implements ChatCompletionApi {
  constructor(private readonly candidate: ResolvedModelCandidate) {}

  async complete(request: CompletionRequest): Promise<ChatCompletionResponse> {
    const body = toRequestBody(this.candidate, request, false);
    debugLogRequest({
      candidate: this.candidate,
      request,
      body,
      stream: false,
    });
    const response = await requestOpenAIResponse(
      this.candidate,
      body,
      "LLM request failed",
    );
    const data = (await response.json()) as OpenAICompatibleResponse;
    const content = data.choices?.[0]?.message?.content?.trim();

    if (!content) {
      throw new Error("LLM response did not contain assistant content");
    }

    return { content, raw: data };
  }

  async stream(
    request: CompletionRequest,
    handlers?: StreamHandler,
  ): Promise<ChatCompletionResponse> {
    const body = toRequestBody(this.candidate, request, true);
    debugLogRequest({ candidate: this.candidate, request, body, stream: true });
    const response = await requestOpenAIResponse(
      this.candidate,
      body,
      "LLM stream request failed",
    );
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

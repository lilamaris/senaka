import type { AppConfig, ChatMessage } from './types';

interface CompletionResponse {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string;
    };
  }>;
}

export async function createCompletion(config: AppConfig, messages: ChatMessage[]): Promise<string> {
  const response = await fetch(`${config.openaiBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.openaiApiKey}`
    },
    body: JSON.stringify({
      model: config.openaiModel,
      messages,
      temperature: 0.2
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LLM request failed (${response.status}): ${body}`);
  }

  const payload = (await response.json()) as CompletionResponse;
  const content = payload.choices?.[0]?.message?.content?.trim();

  if (!content) {
    throw new Error('LLM response did not contain assistant content');
  }

  return content;
}

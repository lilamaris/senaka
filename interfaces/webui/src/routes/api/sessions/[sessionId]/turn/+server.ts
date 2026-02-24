import { json } from '@sveltejs/kit';
import { loadConfig } from '$lib/server/config';
import { createCompletion } from '$lib/server/llm';
import { loadOrCreateSession, saveSession } from '$lib/server/session-store';

export async function POST({ params, request }) {
  try {
    const payload = (await request.json()) as { message?: string };
    const message = payload.message?.trim();

    if (!message) {
      return new Response('message is required', { status: 400 });
    }

    const config = loadConfig();
    const session = await loadOrCreateSession(config.sessionDir, params.sessionId, config.systemPrompt);

    session.messages.push({ role: 'user', content: message });
    await saveSession(config.sessionDir, session);

    const reply = await createCompletion(config, session.messages);
    session.messages.push({ role: 'assistant', content: reply });
    await saveSession(config.sessionDir, session);

    return json({ session });
  } catch (error) {
    return new Response((error as Error).message, { status: 500 });
  }
}

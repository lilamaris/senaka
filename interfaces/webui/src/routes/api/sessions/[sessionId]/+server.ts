import { json } from '@sveltejs/kit';
import { loadConfig } from '$lib/server/config';
import { loadOrCreateSession, resetSession, saveSession } from '$lib/server/session-store';

export async function GET({ params }) {
  try {
    const config = loadConfig();
    const session = await loadOrCreateSession(config.sessionDir, params.sessionId, config.systemPrompt);
    return json({ session });
  } catch (error) {
    return new Response((error as Error).message, { status: 500 });
  }
}

export async function DELETE({ params }) {
  try {
    const config = loadConfig();
    const session = await resetSession(config.sessionDir, params.sessionId, config.systemPrompt);
    await saveSession(config.sessionDir, session);
    return json({ session });
  } catch (error) {
    return new Response((error as Error).message, { status: 500 });
  }
}

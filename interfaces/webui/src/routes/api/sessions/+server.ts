import { json } from '@sveltejs/kit';
import { loadConfig } from '$lib/server/config';
import { listSessions } from '$lib/server/session-store';

export async function GET() {
  try {
    const config = loadConfig();
    const sessions = await listSessions(config.sessionDir);
    return json({ sessions });
  } catch (error) {
    return new Response((error as Error).message, { status: 500 });
  }
}

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChatMessage, ChatSession } from './types';

function nowIso(): string {
  return new Date().toISOString();
}

function filePath(sessionDir: string, sessionId: string): string {
  return path.join(sessionDir, `${sessionId}.json`);
}

function normalizeSessionId(input: string): string {
  const normalized = input.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
  return normalized || 'default';
}

export async function listSessions(sessionDir: string): Promise<Array<{ id: string; updatedAt: string; messageCount: number }>> {
  await mkdir(sessionDir, { recursive: true });
  const files = await readdir(sessionDir);
  const rows: Array<{ id: string; updatedAt: string; messageCount: number }> = [];

  for (const file of files) {
    if (!file.endsWith('.json')) {
      continue;
    }

    try {
      const raw = await readFile(path.join(sessionDir, file), 'utf-8');
      const session = JSON.parse(raw) as ChatSession;
      rows.push({
        id: session.id,
        updatedAt: session.updatedAt,
        messageCount: session.messages.length
      });
    } catch {
      // Ignore malformed session files.
    }
  }

  return rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function loadOrCreateSession(sessionDir: string, sessionId: string, systemPrompt?: string): Promise<ChatSession> {
  await mkdir(sessionDir, { recursive: true });
  const id = normalizeSessionId(sessionId);
  const target = filePath(sessionDir, id);

  try {
    const raw = await readFile(target, 'utf-8');
    return JSON.parse(raw) as ChatSession;
  } catch {
    const messages: ChatMessage[] = systemPrompt ? [{ role: 'system', content: systemPrompt }] : [];
    const session: ChatSession = {
      id,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      messages
    };

    await saveSession(sessionDir, session);
    return session;
  }
}

export async function saveSession(sessionDir: string, session: ChatSession): Promise<void> {
  await mkdir(sessionDir, { recursive: true });
  session.updatedAt = nowIso();
  await writeFile(filePath(sessionDir, session.id), JSON.stringify(session, null, 2), 'utf-8');
}

export async function resetSession(sessionDir: string, sessionId: string, systemPrompt?: string): Promise<ChatSession> {
  const session: ChatSession = {
    id: normalizeSessionId(sessionId),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    messages: systemPrompt ? [{ role: 'system', content: systemPrompt }] : []
  };

  await saveSession(sessionDir, session);
  return session;
}

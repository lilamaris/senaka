import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChatMessage, ChatSession } from "../types/chat.js";

function nowIso(): string {
  return new Date().toISOString();
}

function sessionFile(sessionDir: string, sessionId: string): string {
  return path.join(sessionDir, `${sessionId}.json`);
}

export async function loadOrCreateSession(
  sessionDir: string,
  sessionId: string,
  systemPrompt?: string,
): Promise<ChatSession> {
  await mkdir(sessionDir, { recursive: true });
  const file = sessionFile(sessionDir, sessionId);

  try {
    const raw = await readFile(file, "utf-8");
    return JSON.parse(raw) as ChatSession;
  } catch {
    const initialMessages: ChatMessage[] = [];
    if (systemPrompt) {
      initialMessages.push({ role: "system", content: systemPrompt });
    }

    const session: ChatSession = {
      id: sessionId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      messages: initialMessages,
    };

    await saveSession(sessionDir, session);
    return session;
  }
}

export async function saveSession(sessionDir: string, session: ChatSession): Promise<void> {
  await mkdir(sessionDir, { recursive: true });
  session.updatedAt = nowIso();
  const file = sessionFile(sessionDir, session.id);
  await writeFile(file, JSON.stringify(session, null, 2), "utf-8");
}

export async function resetSession(
  sessionDir: string,
  sessionId: string,
  systemPrompt?: string,
): Promise<ChatSession> {
  const session: ChatSession = {
    id: sessionId,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    messages: systemPrompt ? [{ role: "system", content: systemPrompt }] : [],
  };

  await saveSession(sessionDir, session);
  return session;
}

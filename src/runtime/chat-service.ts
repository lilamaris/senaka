import type { AppConfig } from "../config/env.js";
import { createChatCompletion } from "../llm/openai-compatible.js";
import type { ChatSession } from "../types/chat.js";
import { saveSession } from "./session-store.js";

export async function runTurn(
  config: AppConfig,
  session: ChatSession,
  userMessage: string,
): Promise<string> {
  session.messages.push({ role: "user", content: userMessage });
  await saveSession(config.sessionDir, session);

  const completion = await createChatCompletion(config, session.messages);

  session.messages.push({ role: "assistant", content: completion.content });
  await saveSession(config.sessionDir, session);

  return completion.content;
}

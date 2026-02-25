import type { ChatRole } from "../core/agent/type.js";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatSession {
  id: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

export interface ChatCompletionResponse {
  content: string;
  raw: unknown;
}

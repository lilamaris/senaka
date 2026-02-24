export type ChatRole = 'system' | 'user' | 'assistant';

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

export interface AppConfig {
  openaiBaseUrl: string;
  openaiApiKey: string;
  openaiModel: string;
  systemPrompt?: string;
  sessionDir: string;
}

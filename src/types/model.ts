import type { ChatMessage } from "./chat.js";

export type ProviderType = "openai-compatible";

export interface ModelCandidate {
  id: string;
  provider: ProviderType;
  baseUrl?: string;
  baseUrlEnv?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  model?: string;
  modelEnv?: string;
  temperature?: number;
  maxTokens?: number;
  extraBody?: Record<string, unknown>;
  description?: string;
}

export interface ModelProfile {
  candidateIds: string[];
}

export interface ModelRegistry {
  candidates: ModelCandidate[];
  profiles: {
    main: ModelProfile;
    worker: ModelProfile;
    single: ModelProfile;
  };
}

export interface ResolvedModelCandidate {
  id: string;
  provider: ProviderType;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  extraBody?: Record<string, unknown>;
  description?: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
}

import type { ChatMessage } from "./chat.js";

export type ProviderType = "openai-compatible" | "openai" | "claude-code";
export type AgentMode = "main-worker" | "single-main";

export interface ApiServer {
  id: string;
  provider: ProviderType;
  baseUrl?: string;
  baseUrlEnv?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  description?: string;
}

export interface ModelDefinition {
  id: string;
  serverId: string;
  model?: string;
  modelEnv?: string;
  modelFallbackEnvs?: string[];
  contextLength?: number;
  temperature?: number;
  maxTokens?: number;
  extraBody?: Record<string, unknown>;
  description?: string;
}

export interface AgentDefinition {
  mode: AgentMode;
  mainModelId: string;
  workerModelId?: string;
  maxSteps?: number;
  stream?: boolean;
  description?: string;
}

export interface ModelRegistry {
  servers: ApiServer[];
  models: ModelDefinition[];
  agents: Record<string, AgentDefinition>;
}

export interface ResolvedModelCandidate {
  id: string;
  provider: ProviderType;
  baseUrl: string;
  apiKey: string;
  model: string;
  contextLength?: number;
  temperature?: number;
  maxTokens?: number;
  extraBody?: Record<string, unknown>;
  description?: string;
}

export interface ResolvedAgentConfig {
  id: string;
  mode: AgentMode;
  maxSteps: number;
  stream: boolean;
  main: ResolvedModelCandidate;
  worker: ResolvedModelCandidate;
  description?: string;
}

export interface AgentRunOverride {
  mode?: AgentMode;
  maxSteps?: number;
  stream?: boolean;
}

export interface ChatRequest {
  messages: ChatMessage[];
}

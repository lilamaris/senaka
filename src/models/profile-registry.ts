import { readFile } from "node:fs/promises";
import type {
  AgentDefinition,
  ApiServer,
  ModelDefinition,
  ModelRegistry,
  ResolvedModelCandidate,
} from "../types/model.js";

function resolveValue(name: string, direct?: string, envKey?: string): string {
  const envValue = envKey ? process.env[envKey] : undefined;
  const value = direct ?? envValue;

  if (!value || !value.trim()) {
    throw new Error(`Missing ${name}${envKey ? ` (or env ${envKey})` : ""}`);
  }

  return value.trim();
}

function resolveModelName(model: ModelDefinition): string {
  if (model.model && model.model.trim()) {
    return model.model.trim();
  }

  if (model.modelEnv) {
    const direct = process.env[model.modelEnv];
    if (direct && direct.trim()) {
      return direct.trim();
    }
  }

  for (const fallbackEnv of model.modelFallbackEnvs ?? []) {
    const value = process.env[fallbackEnv];
    if (value && value.trim()) {
      return value.trim();
    }
  }

  const fallbackHint =
    model.modelFallbackEnvs && model.modelFallbackEnvs.length > 0
      ? ` or envs ${model.modelFallbackEnvs.join(", ")}`
      : "";

  throw new Error(
    `Missing model(${model.id}).model (or env ${model.modelEnv ?? "<unset>"}${fallbackHint})`,
  );
}

function resolveServerEndpoint(server: ApiServer): { provider: ApiServer["provider"]; baseUrl: string; apiKey: string } {
  return {
    provider: server.provider,
    baseUrl: resolveValue(`server(${server.id}).baseUrl`, server.baseUrl, server.baseUrlEnv),
    apiKey: resolveValue(`server(${server.id}).apiKey`, server.apiKey, server.apiKeyEnv),
  };
}

export async function loadModelRegistry(pathname: string): Promise<ModelRegistry> {
  const raw = await readFile(pathname, "utf-8");
  const parsed = JSON.parse(raw) as ModelRegistry;

  if (!Array.isArray(parsed.servers) || parsed.servers.length === 0) {
    throw new Error("model registry must include at least one server");
  }

  if (!Array.isArray(parsed.models) || parsed.models.length === 0) {
    throw new Error("model registry must include at least one model");
  }

  if (!parsed.agents || Object.keys(parsed.agents).length === 0) {
    throw new Error("model registry must include at least one agent config");
  }

  return parsed;
}

export function getAgentDefinition(registry: ModelRegistry, agentId: string): AgentDefinition {
  const agent = registry.agents[agentId];
  if (!agent) {
    throw new Error(`agent config not found: ${agentId}`);
  }
  return agent;
}

export function resolveModelCandidateById(registry: ModelRegistry, modelId: string): ResolvedModelCandidate {
  const model = registry.models.find((m) => m.id === modelId);
  if (!model) {
    throw new Error(`model not found: ${modelId}`);
  }

  const server = registry.servers.find((s) => s.id === model.serverId);
  if (!server) {
    throw new Error(`server not found for model ${modelId}: ${model.serverId}`);
  }

  const endpoint = resolveServerEndpoint(server);

  return {
    id: model.id,
    provider: endpoint.provider,
    baseUrl: endpoint.baseUrl,
    apiKey: endpoint.apiKey,
    model: resolveModelName(model),
    contextLength: model.contextLength,
    temperature: model.temperature,
    maxTokens: model.maxTokens,
    extraBody: model.extraBody,
    description: model.description,
  };
}

export function listServers(registry: ModelRegistry): ApiServer[] {
  return registry.servers;
}

export function listModels(registry: ModelRegistry): Array<ModelDefinition & { modelRef: string }> {
  return registry.models.map((model) => ({
    ...model,
    modelRef:
      model.model ??
      (model.modelEnv
        ? `$${model.modelEnv}${model.modelFallbackEnvs?.length ? `|${model.modelFallbackEnvs.map((env) => `$${env}`).join("|")}` : ""}`
        : "<unset>"),
  }));
}

export function listAgents(registry: ModelRegistry): Array<{ id: string; value: AgentDefinition }> {
  return Object.entries(registry.agents).map(([id, value]) => ({ id, value }));
}

import { readFile } from "node:fs/promises";
import type { ModelCandidate, ModelRegistry, ResolvedModelCandidate } from "../types/model.js";

function resolveValue(name: string, direct?: string, envKey?: string): string {
  const envValue = envKey ? process.env[envKey] : undefined;
  const value = direct ?? envValue;

  if (!value || !value.trim()) {
    throw new Error(`Model candidate missing ${name}${envKey ? ` (or env ${envKey})` : ""}`);
  }

  return value.trim();
}

function resolveCandidate(candidate: ModelCandidate): ResolvedModelCandidate {
  return {
    id: candidate.id,
    provider: candidate.provider,
    baseUrl: resolveValue("baseUrl", candidate.baseUrl, candidate.baseUrlEnv),
    apiKey: resolveValue("apiKey", candidate.apiKey, candidate.apiKeyEnv),
    model: resolveValue("model", candidate.model, candidate.modelEnv),
    temperature: candidate.temperature,
    maxTokens: candidate.maxTokens,
    extraBody: candidate.extraBody,
    description: candidate.description,
  };
}

export async function loadModelRegistry(pathname: string): Promise<ModelRegistry> {
  const raw = await readFile(pathname, "utf-8");
  const parsed = JSON.parse(raw) as ModelRegistry;

  if (!parsed.candidates || parsed.candidates.length === 0) {
    throw new Error("model registry must include at least one candidate");
  }

  if (!parsed.profiles?.main || !parsed.profiles?.worker || !parsed.profiles?.single) {
    throw new Error("model registry must include profiles.main/worker/single");
  }

  return parsed;
}

export function pickCandidateFromProfile(
  registry: ModelRegistry,
  profileName: "main" | "worker" | "single",
): ResolvedModelCandidate {
  const profile = registry.profiles[profileName];
  for (const id of profile.candidateIds) {
    const candidate = registry.candidates.find((c) => c.id === id);
    if (!candidate) {
      continue;
    }

    try {
      return resolveCandidate(candidate);
    } catch {
      continue;
    }
  }

  throw new Error(`No usable candidate in profile: ${profileName}`);
}

export function listCandidates(registry: ModelRegistry): Array<{
  id: string;
  provider: string;
  modelRef: string;
  note: string;
}> {
  return registry.candidates.map((candidate) => ({
    id: candidate.id,
    provider: candidate.provider,
    modelRef: candidate.model ?? (candidate.modelEnv ? `$${candidate.modelEnv}` : "<unset>"),
    note: candidate.description ?? "",
  }));
}

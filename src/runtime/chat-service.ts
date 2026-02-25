import type { AppConfig } from "../config/env.js";
import { resolveChatCompletionApi } from "../adapter/api/index.js";
import type { ChatSession } from "../types/chat.js";
import { saveSession } from "./session-store.js";
import type { ResolvedModelCandidate } from "../types/model.js";
import { loadModelRegistry, resolveModelCandidateById } from "../models/profile-registry.js";
import { routeAgentModels } from "../models/role-router.js";

/**
 * 파일 목적:
 * - 단일 chat turn 실행 경로를 제공한다.
 *
 * 주요 의존성:
 * - profile-registry/role-router: 채팅용 모델 후보 해석
 * - adapter/api: provider 호출
 * - session-store: 턴 전후 세션 저장
 *
 * 역의존성:
 * - src/cli/chat.ts, src/cli/chat-turn.ts
 */

function resolveLegacyChatCandidate(config: AppConfig): ResolvedModelCandidate | undefined {
  if (!config.openaiBaseUrl || !config.openaiApiKey || !config.openaiModel) {
    return undefined;
  }
  return {
    id: "legacy-openai-env",
    provider: "openai-compatible",
    baseUrl: config.openaiBaseUrl,
    apiKey: config.openaiApiKey,
    model: config.openaiModel,
    temperature: 0.2,
    description: "Legacy fallback candidate from OPENAI_* env",
  };
}

async function resolveChatCandidate(config: AppConfig): Promise<ResolvedModelCandidate> {
  const legacy = resolveLegacyChatCandidate(config);

  let registry;
  try {
    registry = await loadModelRegistry(config.modelProfilesPath);
  } catch (error) {
    if (legacy) {
      return legacy;
    }
    throw new Error(
      `failed to load model registry (${config.modelProfilesPath}) and no legacy OPENAI_* fallback is configured: ${(error as Error).message}`,
    );
  }

  if (config.chatModelId) {
    return resolveModelCandidateById(registry, config.chatModelId);
  }

  const preferredAgentId = config.chatAgentId.trim() || "default";
  try {
    return routeAgentModels(registry, preferredAgentId).main;
  } catch (error) {
    const firstAgentId = Object.keys(registry.agents)[0];
    if (firstAgentId) {
      return routeAgentModels(registry, firstAgentId).main;
    }
    if (legacy) {
      return legacy;
    }
    throw new Error(`failed to resolve chat agent (${preferredAgentId}): ${(error as Error).message}`);
  }
}

export async function runTurn(
  config: AppConfig,
  session: ChatSession,
  userMessage: string,
): Promise<string> {
  session.messages.push({ role: "user", content: userMessage });
  await saveSession(config.sessionDir, session);

  const candidate = await resolveChatCandidate(config);
  const completion = await resolveChatCompletionApi(candidate).complete({ messages: session.messages });

  session.messages.push({ role: "assistant", content: completion.content });
  await saveSession(config.sessionDir, session);

  return completion.content;
}

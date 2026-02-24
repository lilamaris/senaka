import { getAgentDefinition, resolveModelCandidateById } from "./profile-registry.js";
import type { AgentRunOverride, ModelRegistry, ResolvedAgentConfig } from "../types/model.js";

export function routeAgentModels(
  registry: ModelRegistry,
  agentId: string,
  override?: AgentRunOverride,
): ResolvedAgentConfig {
  const agent = getAgentDefinition(registry, agentId);
  const mode = override?.mode ?? agent.mode;
  const maxSteps = override?.maxSteps ?? agent.maxSteps ?? 3;
  const stream = override?.stream ?? agent.stream ?? true;

  const main = resolveModelCandidateById(registry, agent.mainModelId);
  const worker =
    mode === "single-main"
      ? main
      : resolveModelCandidateById(registry, agent.workerModelId ?? agent.mainModelId);

  return {
    id: agentId,
    mode,
    maxSteps,
    stream,
    main,
    worker,
    description: agent.description,
  };
}

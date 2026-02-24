import { pickCandidateFromProfile } from "./profile-registry.js";
import type { ModelRegistry, ResolvedModelCandidate } from "../types/model.js";

export type AgentMode = "main-worker" | "single-main";

export interface RoutedModels {
  mode: AgentMode;
  main: ResolvedModelCandidate;
  worker: ResolvedModelCandidate;
}

export function routeModels(registry: ModelRegistry, mode: AgentMode): RoutedModels {
  if (mode === "single-main") {
    const single = pickCandidateFromProfile(registry, "single");
    return {
      mode,
      main: single,
      worker: single,
    };
  }

  return {
    mode,
    main: pickCandidateFromProfile(registry, "main"),
    worker: pickCandidateFromProfile(registry, "worker"),
  };
}

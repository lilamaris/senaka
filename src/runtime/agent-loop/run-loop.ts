import type { ChatSession } from "../../types/chat.js";
import type { AppConfig } from "../../config/env.js";
import { routeAgentModels } from "../../models/role-router.js";
import { loadModelRegistry } from "../../models/profile-registry.js";
import { summarizeEvidenceForMain } from "./helpers.js";
import { loadWorkerSystemPrompt } from "./llm.js";
import type { AgentLoopOptions, AgentRunResult } from "./types.js";
import { computeCompactionPlan, handleContextCompaction, resolveContextLimitTokens } from "./context-guard.js";
import { handleForceFinalizeTurn, handleMainDecisionTurn, handlePlanningTurn, handleWorkerTurn } from "./stages.js";
import { LoopState, appendSessionEntries, type LoopRuntime } from "./loop-state.js";

/**
 * 파일 목적:
 * - agent loop 상태 머신의 메인 오케스트레이터를 담당한다.
 *
 * 주요 의존성:
 * - context-guard.ts: compaction 계획/실행
 * - stages.ts: 상태별 세부 핸들러
 * - loop-state.ts: 공통 상태/세션 유틸
 *
 * 역의존성:
 * - src/runtime/agent-loop.ts (공개 엔트리 재-export)
 * - src/cli/agent-run.ts, src/cli/agent-tui.ts
 *
 * 모듈 흐름:
 * 1) 모델 라우팅/런타임 초기화
 * 2) 상태 전이 루프 실행(PlanIntent -> ... -> Done)
 * 3) 최종 응답 세션 저장 및 실행 요약 반환
 */
export async function runAgentLoop(
  config: AppConfig,
  session: ChatSession,
  goal: string,
  agentId: string,
  options?: AgentLoopOptions,
): Promise<AgentRunResult> {
  const registry = await loadModelRegistry(config.modelProfilesPath);
  const routed = routeAgentModels(registry, agentId, {
    mode: options?.mode,
    maxSteps: options?.maxSteps,
    stream: options?.stream,
  });

  const workerSystemPrompt = await loadWorkerSystemPrompt();
  const workspaceGroupId = options?.workspaceGroupId?.trim() || session.id;
  const contextLimitTokens = resolveContextLimitTokens(routed);
  const runtime: LoopRuntime = {
    workerValidationFailureStreak: 0,
    evidence: [],
    guidance: "",
    recentUserAnswer: "",
    finalAnswer: "",
    steps: 0,
    step: 1,
    resumeStateAfterCompaction: LoopState.PlanIntent,
  };
  let state: LoopState = LoopState.PlanIntent;
  const deps = {
    config,
    session,
    goal,
    routed,
    contextLimitTokens,
    options,
    workerSystemPrompt,
    workspaceGroupId,
  };

  options?.onEvent?.({ type: "start", agentId, mode: routed.mode, goal });
  await appendSessionEntries(config, session, [{ role: "user", content: `[AGENT_GOAL:${agentId}] ${goal}` }]);

  while (state !== LoopState.Done) {
    const plan = computeCompactionPlan(session, deps.contextLimitTokens);
    if (state !== LoopState.ContextGuard && plan.shouldCompact && plan.signature !== runtime.lastCompactionSignature) {
      runtime.resumeStateAfterCompaction = state;
      state = LoopState.ContextGuard;
      continue;
    }

    if (state === LoopState.ContextGuard) {
      state = await handleContextCompaction(deps, runtime);
      continue;
    }

    if (state === LoopState.PlanIntent) {
      state = await handlePlanningTurn(deps, runtime);
      continue;
    }

    if (state === LoopState.AcquireEvidence) {
      state = await handleWorkerTurn(deps, runtime);
      continue;
    }

    if (state === LoopState.AssessSufficiency) {
      state = await handleMainDecisionTurn(deps, runtime);
      continue;
    }

    if (state === LoopState.ForcedSynthesis) {
      state = await handleForceFinalizeTurn(deps, runtime);
    }
  }

  await appendSessionEntries(config, session, [{ role: "assistant", content: runtime.finalAnswer }]);
  options?.onEvent?.({ type: "complete", steps: runtime.steps, evidenceCount: runtime.evidence.length });

  return {
    agentId,
    mode: routed.mode,
    maxSteps: routed.maxSteps,
    stream: routed.stream,
    summary: runtime.finalAnswer,
    evidence: summarizeEvidenceForMain(runtime.evidence),
    steps: runtime.steps,
    workerModel: routed.worker.model,
    mainModel: routed.main.model,
  };
}

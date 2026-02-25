import type { ChatSession } from "../../types/chat.js";
import type { AppConfig } from "../../config/env.js";
import { routeAgentModels } from "../../models/role-router.js";
import { loadModelRegistry } from "../../models/profile-registry.js";
import { saveSession } from "../session-store.js";
import {
  fallbackFinalAnswer,
  summarizeDecisionContext,
  summarizeEvidenceForMain,
  summarizeToolResult,
  buildWorkerMessages,
} from "./helpers.js";
import { askMainForDecision, askMainForFinalAnswer, askWorkerForAction, loadWorkerSystemPrompt, runShellCommand } from "./llm.js";
import type { AgentLoopOptions, AgentRunResult, EvidenceItem, MainDecision, ToolResult, WorkerAction } from "./types.js";

enum LoopState {
  WorkerTurn = "worker-turn",
  MainDecision = "main-decision",
  ForceFinalize = "force-finalize",
  Complete = "complete",
}

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
  const evidence: EvidenceItem[] = [];
  let guidance = "";
  let recentUserAnswer = "";
  let lastTool: ToolResult | undefined;
  let finalAnswer = "";
  let steps = 0;
  let state: LoopState = LoopState.WorkerTurn;
  let step = 1;
  let pendingMainDecision: MainDecision | undefined;

  options?.onEvent?.({ type: "start", agentId, mode: routed.mode, goal });
  session.messages.push({ role: "user", content: `[AGENT_GOAL:${agentId}] ${goal}` });
  await saveSession(config.sessionDir, session);

  while (state !== LoopState.Complete) {
    if (state === LoopState.WorkerTurn) {
      if (step > routed.maxSteps) {
        state = LoopState.ForceFinalize;
        continue;
      }

      steps = step;
      options?.onEvent?.({ type: "worker-start", step });

      const workerMessages = buildWorkerMessages({
        workerSystemPrompt,
        goal,
        step,
        evidence,
        guidance,
        lastTool,
        recentUserAnswer,
      });

      let action: WorkerAction;
      try {
        action = await askWorkerForAction({
          config,
          step,
          maxRetries: config.workerActionMaxRetries,
          routedStream: routed.stream,
          model: routed.worker,
          workerMessages,
          onToken: (token) => options?.onEvent?.({ type: "worker-token", step, token }),
        });
      } catch (error) {
        const reason = (error as Error).message;
        const fallbackGuidance = `Worker validation failed at step ${step}. Proceed to main finalization using collected evidence. ${reason}`;
        options?.onEvent?.({ type: "worker-action", step, action: "finalize", detail: fallbackGuidance });
        evidence.push({ kind: "main_guidance", summary: fallbackGuidance });
        session.messages.push({ role: "system", content: `[WORKER_VALIDATION_FAIL_${step}] ${reason}` });
        await saveSession(config.sessionDir, session);
        state = LoopState.ForceFinalize;
        continue;
      }

      if (action.action === "call_tool") {
        options?.onEvent?.({ type: "worker-action", step, action: "call_tool", detail: action.reason });
        options?.onEvent?.({ type: "tool-start", step, cmd: action.args.cmd });

        const result = await runShellCommand(config, action.args.cmd, workspaceGroupId);
        lastTool = result;

        evidence.push({
          kind: "tool_result",
          summary: summarizeToolResult(result),
          detail: [
            `cmd: ${result.cmd}`,
            `exit: ${result.exitCode}`,
            "stdout:",
            result.stdout || "<empty>",
            "stderr:",
            result.stderr || "<empty>",
          ].join("\n"),
        });

        session.messages.push({ role: "system", content: `[WORKER_TOOL_${step}] ${result.cmd}` });
        session.messages.push({ role: "system", content: `[WORKER_TOOL_RESULT_${step}] exit=${result.exitCode}` });
        options?.onEvent?.({
          type: "tool-result",
          step,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          runner: result.runner,
          workspaceGroupId: result.workspaceGroupId,
        });
        await saveSession(config.sessionDir, session);
        step += 1;
        continue;
      }

      if (action.action === "ask") {
        options?.onEvent?.({ type: "worker-action", step, action: "ask", detail: action.question });
        options?.onEvent?.({ type: "ask", step, question: action.question });

        if (!options?.askUser) {
          throw new Error(`worker asked user input but askUser callback is not configured: ${action.question}`);
        }

        const answer = (await options.askUser(action.question)).trim();
        recentUserAnswer = answer;
        evidence.push({ kind: "user_answer", summary: `Q: ${action.question} / A: ${answer}` });
        session.messages.push({ role: "user", content: `[WORKER_ASK_${step}] ${action.question}` });
        session.messages.push({ role: "user", content: `[WORKER_ASK_ANSWER_${step}] ${answer}` });
        options?.onEvent?.({ type: "ask-answer", step, answer });
        await saveSession(config.sessionDir, session);
        step += 1;
        continue;
      }

      options?.onEvent?.({ type: "worker-action", step, action: "finalize", detail: "worker requested finalize" });
      state = LoopState.MainDecision;
      continue;
    }

    if (state === LoopState.MainDecision) {
      options?.onEvent?.({ type: "main-start", evidenceCount: evidence.length });
      const evidenceSummary = summarizeEvidenceForMain(evidence);

      try {
        pendingMainDecision = await askMainForDecision({
          config,
          routedStream: routed.stream,
          goal,
          evidenceSummary,
          onToken: (token) => options?.onEvent?.({ type: "main-token", token }),
          forceFinalize: false,
          mainModel: routed.main,
        });
      } catch (error) {
        const reason = (error as Error).message;
        guidance = `Main decision failed at step ${step}. Continue evidence loop with safer minimal actions. ${reason}`;
        evidence.push({ kind: "main_guidance", summary: guidance });
        session.messages.push({ role: "system", content: `[MAIN_DECISION_FAIL_${step}] ${reason}` });
        await saveSession(config.sessionDir, session);
        options?.onEvent?.({ type: "main-decision", decision: "continue", guidance });
        step += 1;
        state = LoopState.WorkerTurn;
        continue;
      }

      options?.onEvent?.({
        type: "main-decision",
        decision: pendingMainDecision.decision,
        guidance: pendingMainDecision.guidance,
      });

      if (pendingMainDecision.decision === "continue") {
        guidance = pendingMainDecision.guidance?.trim() || "Gather more concrete evidence and retry finalize.";
        evidence.push({ kind: "main_guidance", summary: guidance });
        session.messages.push({ role: "system", content: `[MAIN_GUIDANCE_${step}] ${guidance}` });
        await saveSession(config.sessionDir, session);
        step += 1;
        state = LoopState.WorkerTurn;
        continue;
      }

      const draft = pendingMainDecision.answer?.trim();
      const decisionContext = summarizeDecisionContext(pendingMainDecision);
      try {
        finalAnswer = await askMainForFinalAnswer({
          config,
          goal,
          evidenceSummary,
          decisionContext,
          draft,
          mainModel: routed.main,
        });
      } catch (error) {
        finalAnswer = fallbackFinalAnswer(goal, evidenceSummary);
        const reason = (error as Error).message;
        session.messages.push({ role: "system", content: `[MAIN_FINAL_ANSWER_FAIL_${step}] ${reason}` });
        await saveSession(config.sessionDir, session);
      }
      state = LoopState.Complete;
      continue;
    }

    if (state === LoopState.ForceFinalize) {
      options?.onEvent?.({ type: "main-start", evidenceCount: evidence.length });
      const finalEvidence = summarizeEvidenceForMain(evidence);

      try {
        const decision = await askMainForDecision({
          config,
          routedStream: routed.stream,
          goal,
          evidenceSummary: finalEvidence,
          onToken: (token) => options?.onEvent?.({ type: "main-token", token }),
          forceFinalize: true,
          mainModel: routed.main,
        });
        const fallbackDraft = decision.answer?.trim();
        const decisionContext = summarizeDecisionContext(decision);
        finalAnswer = await askMainForFinalAnswer({
          config,
          goal,
          evidenceSummary: finalEvidence,
          decisionContext,
          draft: fallbackDraft,
          mainModel: routed.main,
        });
        options?.onEvent?.({ type: "main-decision", decision: "finalize" });
      } catch (error) {
        const reason = (error as Error).message;
        finalAnswer = fallbackFinalAnswer(goal, finalEvidence);
        session.messages.push({ role: "system", content: `[MAIN_FORCE_FINALIZE_FAIL] ${reason}` });
        await saveSession(config.sessionDir, session);
        options?.onEvent?.({ type: "main-decision", decision: "finalize", guidance: `fallback finalize: ${reason}` });
      }

      state = LoopState.Complete;
      continue;
    }
  }

  session.messages.push({ role: "assistant", content: finalAnswer });
  await saveSession(config.sessionDir, session);
  options?.onEvent?.({ type: "complete", steps, evidenceCount: evidence.length });

  return {
    agentId,
    mode: routed.mode,
    maxSteps: routed.maxSteps,
    stream: routed.stream,
    summary: finalAnswer,
    evidence: summarizeEvidenceForMain(evidence),
    steps,
    workerModel: routed.worker.model,
    mainModel: routed.main.model,
  };
}

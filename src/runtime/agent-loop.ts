import type { ChatMessage, ChatSession } from "../types/chat.js";
import type { AppConfig } from "../config/env.js";
import type { AgentMode, AgentRunOverride } from "../types/model.js";
import { routeAgentModels } from "../models/role-router.js";
import { loadModelRegistry } from "../models/profile-registry.js";
import { createChatCompletionByCandidate, streamChatCompletionByCandidate } from "../llm/openai-compatible.js";
import { saveSession } from "./session-store.js";

interface WorkerStep {
  step_summary: string;
  evidence: string[];
  done: boolean;
  next_focus: string;
}

export type AgentLoopEvent =
  | { type: "start"; agentId: string; mode: AgentMode; goal: string }
  | { type: "worker-start"; step: number }
  | { type: "worker-token"; step: number; token: string }
  | { type: "worker-step"; step: number; stepSummary: string; evidence: string[]; done: boolean; nextFocus: string }
  | { type: "main-start"; evidenceCount: number }
  | { type: "main-token"; token: string }
  | { type: "complete"; steps: number; evidenceCount: number };

export interface AgentLoopOptions extends AgentRunOverride {
  onEvent?: (event: AgentLoopEvent) => void;
}

export interface AgentRunResult {
  agentId: string;
  mode: AgentMode;
  maxSteps: number;
  stream: boolean;
  summary: string;
  evidence: string[];
  steps: number;
  workerModel: string;
  mainModel: string;
}

function extractJsonObject(input: string): string {
  const start = input.indexOf("{");
  const end = input.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("worker response did not include JSON object");
  }
  return input.slice(start, end + 1);
}

function parseWorkerStep(raw: string): WorkerStep {
  const normalized = extractJsonObject(raw);
  const parsed = JSON.parse(normalized) as Partial<WorkerStep>;

  const evidence = Array.isArray(parsed.evidence)
    ? parsed.evidence.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : [];

  return {
    step_summary: typeof parsed.step_summary === "string" ? parsed.step_summary : "",
    evidence,
    done: Boolean(parsed.done),
    next_focus: typeof parsed.next_focus === "string" ? parsed.next_focus : "",
  };
}

function workerPrompt(goal: string, evidence: string[], step: number): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "You are a fast worker model for evidence collection. Return only JSON with keys: step_summary, evidence(array), done(boolean), next_focus(string). Keep evidence concrete and short.",
    },
    {
      role: "user",
      content: [
        `Goal: ${goal}`,
        `Step: ${step}`,
        `Known evidence: ${evidence.length > 0 ? evidence.join(" | ") : "none"}`,
        "Collect additional evidence from the given context and infer what is still missing.",
      ].join("\n"),
    },
  ];
}

function mainPrompt(goal: string, evidence: string[]): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "You are the main reporting model. Produce a final concise response that explicitly references evidence quality and limitations.",
    },
    {
      role: "user",
      content: [
        `Goal: ${goal}`,
        "Evidence:",
        ...(evidence.length > 0 ? evidence.map((item, i) => `${i + 1}. ${item}`) : ["none"]),
        "Return: final answer + short evidence bullets + unresolved risks.",
      ].join("\n"),
    },
  ];
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

  const evidence: string[] = [];
  options?.onEvent?.({ type: "start", agentId, mode: routed.mode, goal });

  session.messages.push({ role: "user", content: `[AGENT_GOAL:${agentId}] ${goal}` });
  await saveSession(config.sessionDir, session);

  let steps = 0;
  for (let step = 1; step <= routed.maxSteps; step += 1) {
    steps = step;
    options?.onEvent?.({ type: "worker-start", step });

    const workerReply = routed.stream
      ? await streamChatCompletionByCandidate(routed.worker, workerPrompt(goal, evidence, step), {
          onToken: (token) => options?.onEvent?.({ type: "worker-token", step, token }),
        })
      : await createChatCompletionByCandidate(routed.worker, workerPrompt(goal, evidence, step));

    const worker = parseWorkerStep(workerReply.content);
    options?.onEvent?.({
      type: "worker-step",
      step,
      stepSummary: worker.step_summary,
      evidence: worker.evidence,
      done: worker.done,
      nextFocus: worker.next_focus,
    });

    if (worker.step_summary.trim()) {
      session.messages.push({ role: "system", content: `[WORKER_STEP_${step}] ${worker.step_summary}` });
    }

    if (worker.evidence.length > 0) {
      evidence.push(...worker.evidence);
      session.messages.push({ role: "system", content: `[WORKER_EVIDENCE_${step}] ${worker.evidence.join(" | ")}` });
    }

    if (worker.next_focus.trim()) {
      session.messages.push({ role: "system", content: `[WORKER_NEXT_${step}] ${worker.next_focus}` });
    }

    await saveSession(config.sessionDir, session);

    if (worker.done) {
      break;
    }
  }

  options?.onEvent?.({ type: "main-start", evidenceCount: evidence.length });
  const mainReply = routed.stream
    ? await streamChatCompletionByCandidate(routed.main, mainPrompt(goal, evidence), {
        onToken: (token) => options?.onEvent?.({ type: "main-token", token }),
      })
    : await createChatCompletionByCandidate(routed.main, mainPrompt(goal, evidence));

  session.messages.push({ role: "assistant", content: mainReply.content });
  await saveSession(config.sessionDir, session);
  options?.onEvent?.({ type: "complete", steps, evidenceCount: evidence.length });

  return {
    agentId,
    mode: routed.mode,
    maxSteps: routed.maxSteps,
    stream: routed.stream,
    summary: mainReply.content,
    evidence,
    steps,
    workerModel: routed.worker.model,
    mainModel: routed.main.model,
  };
}

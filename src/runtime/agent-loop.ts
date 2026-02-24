import type { ChatMessage, ChatSession } from "../types/chat.js";
import type { AppConfig } from "../config/env.js";
import type { AgentMode } from "../models/role-router.js";
import { routeModels } from "../models/role-router.js";
import { loadModelRegistry } from "../models/profile-registry.js";
import { createChatCompletionByCandidate } from "../llm/openai-compatible.js";
import { saveSession } from "./session-store.js";

interface WorkerStep {
  step_summary: string;
  evidence: string[];
  done: boolean;
  next_focus: string;
}

export interface AgentRunResult {
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
  mode: AgentMode,
  maxSteps: number,
): Promise<AgentRunResult> {
  const registry = await loadModelRegistry(config.modelProfilesPath);
  const routed = routeModels(registry, mode);
  const evidence: string[] = [];

  session.messages.push({ role: "user", content: `[AGENT_GOAL] ${goal}` });
  await saveSession(config.sessionDir, session);

  let steps = 0;
  for (let step = 1; step <= maxSteps; step += 1) {
    steps = step;
    const workerReply = await createChatCompletionByCandidate(routed.worker, workerPrompt(goal, evidence, step));
    const worker = parseWorkerStep(workerReply.content);

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

  const mainReply = await createChatCompletionByCandidate(routed.main, mainPrompt(goal, evidence));
  session.messages.push({ role: "assistant", content: mainReply.content });
  await saveSession(config.sessionDir, session);

  return {
    summary: mainReply.content,
    evidence,
    steps,
    workerModel: routed.worker.model,
    mainModel: routed.main.model,
  };
}

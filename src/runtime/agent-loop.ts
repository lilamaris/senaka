import { readFile } from "node:fs/promises";
import type { ChatMessage, ChatSession } from "../types/chat.js";
import type { AppConfig } from "../config/env.js";
import type { AgentMode, AgentRunOverride } from "../types/model.js";
import { routeAgentModels } from "../models/role-router.js";
import { loadModelRegistry } from "../models/profile-registry.js";
import { createChatCompletionByCandidate, streamChatCompletionByCandidate } from "../llm/openai-compatible.js";
import { saveSession } from "./session-store.js";
import { runInSandbox } from "./sandbox-executor.js";
const WORKER_SYSTEM_PROMPT_PATH = "data/worker/SYSTEM.md";

interface WorkerToolCall {
  action: "call_tool";
  tool: "shell";
  args: { cmd: string };
  reason: string;
}

interface WorkerAsk {
  action: "ask";
  question: string;
}

interface WorkerFinalize {
  action: "finalize";
}

type WorkerAction = WorkerToolCall | WorkerAsk | WorkerFinalize;

interface EvidenceItem {
  kind: "tool_result" | "user_answer" | "main_guidance";
  summary: string;
  detail?: string;
}

interface ToolResult {
  cmd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  runner: "local" | "docker";
  workspaceGroupId: string;
}

interface MainDecision {
  decision: "finalize" | "continue";
  answer?: string;
  guidance?: string;
  summary_evidence?: string[];
  needed_evidence?: string[];
}

export type AgentLoopEvent =
  | { type: "start"; agentId: string; mode: AgentMode; goal: string }
  | { type: "worker-start"; step: number }
  | { type: "worker-token"; step: number; token: string }
  | { type: "worker-action"; step: number; action: WorkerAction["action"]; detail: string }
  | { type: "tool-start"; step: number; cmd: string }
  | {
      type: "tool-result";
      step: number;
      exitCode: number;
      stdout: string;
      stderr: string;
      runner: "local" | "docker";
      workspaceGroupId: string;
    }
  | { type: "ask"; step: number; question: string }
  | { type: "ask-answer"; step: number; answer: string }
  | { type: "main-start"; evidenceCount: number }
  | { type: "main-token"; token: string }
  | { type: "main-decision"; decision: "finalize" | "continue"; guidance?: string }
  | { type: "complete"; steps: number; evidenceCount: number };

export interface AgentLoopOptions extends AgentRunOverride {
  onEvent?: (event: AgentLoopEvent) => void;
  askUser?: (question: string) => Promise<string>;
  workspaceGroupId?: string;
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
    throw new Error("response did not include JSON object");
  }
  return input.slice(start, end + 1);
}

function summarizeToolResult(result: ToolResult): string {
  const stdoutLine = result.stdout.split("\n").find((line) => line.trim().length > 0) ?? "";
  const stderrLine = result.stderr.split("\n").find((line) => line.trim().length > 0) ?? "";
  return `runner=${result.runner} group=${result.workspaceGroupId} cmd=${result.cmd} exit=${result.exitCode} stdout=${stdoutLine || "<empty>"} stderr=${stderrLine || "<empty>"}`;
}

function parseWorkerAction(raw: string): WorkerAction {
  const parsed = JSON.parse(extractJsonObject(raw)) as Record<string, unknown>;
  const action = parsed.action;

  if (action === "call_tool") {
    if (parsed.tool !== "shell") {
      throw new Error("worker call_tool.tool must be 'shell'");
    }

    const args = parsed.args as Record<string, unknown> | undefined;
    const cmd = typeof args?.cmd === "string" ? args.cmd.trim() : "";
    const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";

    if (!cmd) {
      throw new Error("worker call_tool requires args.cmd");
    }

    if (!reason) {
      throw new Error("worker call_tool requires reason");
    }

    return {
      action: "call_tool",
      tool: "shell",
      args: { cmd },
      reason,
    };
  }

  if (action === "ask") {
    const question = typeof parsed.question === "string" ? parsed.question.trim() : "";
    if (!question) {
      throw new Error("worker ask requires question");
    }

    return {
      action: "ask",
      question,
    };
  }

  if (action === "finalize") {
    return { action: "finalize" };
  }

  throw new Error("worker action must be one of: call_tool, ask, finalize");
}

function parseMainDecision(raw: string): MainDecision {
  const parsed = JSON.parse(extractJsonObject(raw)) as Record<string, unknown>;
  const decision = parsed.decision;

  if (decision !== "finalize" && decision !== "continue") {
    throw new Error("main decision must be finalize or continue");
  }

  const answer = typeof parsed.answer === "string" ? parsed.answer.trim() : undefined;
  const guidance = typeof parsed.guidance === "string" ? parsed.guidance.trim() : undefined;
  const summaryEvidence = Array.isArray(parsed.summary_evidence)
    ? parsed.summary_evidence.filter((v): v is string => typeof v === "string")
    : undefined;
  const neededEvidence = Array.isArray(parsed.needed_evidence)
    ? parsed.needed_evidence.filter((v): v is string => typeof v === "string")
    : undefined;

  return {
    decision,
    answer,
    guidance,
    summary_evidence: summaryEvidence,
    needed_evidence: neededEvidence,
  };
}

function validateCommandSafety(cmd: string): void {
  const lowered = cmd.toLowerCase();
  const denied = [" rm ", "delete", " drop ", "wipe", "shutdown", "reboot", "mkfs", " dd ", " kill ", "pkill", "git push"];

  for (const keyword of denied) {
    if (lowered.includes(keyword.trim())) {
      throw new Error(`unsafe command blocked: ${keyword.trim()}`);
    }
  }

  const pipeCount = (cmd.match(/\|/g) ?? []).length;
  if (pipeCount > 1) {
    throw new Error("worker command can include at most one pipe");
  }
}

async function runShellCommand(config: AppConfig, cmd: string, workspaceGroupId: string): Promise<ToolResult> {
  validateCommandSafety(cmd);
  return runInSandbox(cmd, workspaceGroupId, {
    mode: config.toolSandboxMode,
    timeoutMs: config.toolTimeoutMs,
    maxBufferBytes: config.toolMaxBufferBytes,
    shellPath: config.toolShellPath,
    dockerImage: config.dockerSandboxImage,
    dockerWorkspaceRoot: config.dockerWorkspaceRoot,
    dockerContainerPrefix: config.dockerContainerPrefix,
    dockerNetwork: config.dockerNetwork,
    dockerMemory: config.dockerMemory,
    dockerCpus: config.dockerCpus,
    dockerPidsLimit: config.dockerPidsLimit,
  });
}

async function loadWorkerSystemPrompt(): Promise<string> {
  const raw = await readFile(WORKER_SYSTEM_PROMPT_PATH, "utf-8");
  return raw.trim();
}

function buildWorkerMessages(params: {
  workerSystemPrompt: string;
  goal: string;
  step: number;
  evidence: EvidenceItem[];
  guidance?: string;
  lastTool?: ToolResult;
  recentUserAnswer?: string;
}): ChatMessage[] {
  const evidenceSummary =
    params.evidence.length > 0
      ? params.evidence
          .slice(-12)
          .map((item, idx) => `${idx + 1}. [${item.kind}] ${item.summary}`)
          .join("\n")
      : "none";

  const lastToolBlock = params.lastTool
    ? [
        `Last command: ${params.lastTool.cmd}`,
        `Last exit code: ${params.lastTool.exitCode}`,
        "Last stdout:",
        params.lastTool.stdout || "<empty>",
        "Last stderr:",
        params.lastTool.stderr || "<empty>",
      ].join("\n")
    : "No previous tool result.";

  const guidanceBlock = params.guidance ? `Main guidance: ${params.guidance}` : "Main guidance: none";
  const askAnswerBlock = params.recentUserAnswer ? `Latest user answer: ${params.recentUserAnswer}` : "Latest user answer: none";

  return [
    {
      role: "system",
      content: params.workerSystemPrompt,
    },
    {
      role: "user",
      content: [
        `Goal: ${params.goal}`,
        `Step: ${params.step}`,
        guidanceBlock,
        askAnswerBlock,
        "Current evidence summary:",
        evidenceSummary,
        "",
        "Tool context:",
        lastToolBlock,
      ].join("\n"),
    },
  ];
}

function summarizeEvidenceForMain(evidence: EvidenceItem[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const item of evidence) {
    const key = `${item.kind}:${item.summary}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(`[${item.kind}] ${item.summary}`);
    if (out.length >= 12) {
      break;
    }
  }

  return out;
}

function buildMainDecisionMessages(goal: string, evidenceSummary: string[], forceFinalize: boolean): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are the main reviewer for an agent loop.",
        "Output EXACTLY one JSON object.",
        "Use only one of these shapes:",
        "{\"decision\":\"finalize\",\"answer\":\"...\",\"summary_evidence\":[\"...\"]}",
        "{\"decision\":\"continue\",\"guidance\":\"...\",\"needed_evidence\":[\"...\"]}",
        "If evidence is insufficient, choose continue with concrete guidance.",
        forceFinalize ? "You MUST choose finalize in this call." : "",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `Goal: ${goal}`,
        "Meaningful evidence summary:",
        ...(evidenceSummary.length > 0 ? evidenceSummary.map((e, i) => `${i + 1}. ${e}`) : ["none"]),
      ].join("\n"),
    },
  ];
}

async function askMainForDecision(params: {
  routedStream: boolean;
  goal: string;
  evidenceSummary: string[];
  onToken?: (token: string) => void;
  forceFinalize: boolean;
  mainModel: Parameters<typeof createChatCompletionByCandidate>[0];
}): Promise<MainDecision> {
  const messages = buildMainDecisionMessages(params.goal, params.evidenceSummary, params.forceFinalize);
  const reply = params.routedStream
    ? await streamChatCompletionByCandidate(params.mainModel, messages, { onToken: params.onToken })
    : await createChatCompletionByCandidate(params.mainModel, messages);

  return parseMainDecision(reply.content);
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

  options?.onEvent?.({ type: "start", agentId, mode: routed.mode, goal });

  session.messages.push({ role: "user", content: `[AGENT_GOAL:${agentId}] ${goal}` });
  await saveSession(config.sessionDir, session);

  let steps = 0;

  for (let step = 1; step <= routed.maxSteps; step += 1) {
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

    const workerReply = routed.stream
      ? await streamChatCompletionByCandidate(routed.worker, workerMessages, {
          onToken: (token) => options?.onEvent?.({ type: "worker-token", step, token }),
        })
      : await createChatCompletionByCandidate(routed.worker, workerMessages);

    const action = parseWorkerAction(workerReply.content);

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

      evidence.push({
        kind: "user_answer",
        summary: `Q: ${action.question} / A: ${answer}`,
      });

      session.messages.push({ role: "user", content: `[WORKER_ASK_${step}] ${action.question}` });
      session.messages.push({ role: "user", content: `[WORKER_ASK_ANSWER_${step}] ${answer}` });
      options?.onEvent?.({ type: "ask-answer", step, answer });

      await saveSession(config.sessionDir, session);
      continue;
    }

    options?.onEvent?.({ type: "worker-action", step, action: "finalize", detail: "worker requested finalize" });
    options?.onEvent?.({ type: "main-start", evidenceCount: evidence.length });

    const evidenceSummary = summarizeEvidenceForMain(evidence);
    const decision = await askMainForDecision({
      routedStream: routed.stream,
      goal,
      evidenceSummary,
      onToken: (token) => options?.onEvent?.({ type: "main-token", token }),
      forceFinalize: false,
      mainModel: routed.main,
    });

    options?.onEvent?.({ type: "main-decision", decision: decision.decision, guidance: decision.guidance });

    if (decision.decision === "finalize") {
      finalAnswer = decision.answer?.trim() || "main model finalized without explicit answer";
      break;
    }

    guidance = decision.guidance?.trim() || "Gather more concrete evidence and retry finalize.";
    evidence.push({
      kind: "main_guidance",
      summary: guidance,
    });

    session.messages.push({ role: "system", content: `[MAIN_GUIDANCE_${step}] ${guidance}` });
    await saveSession(config.sessionDir, session);
  }

  if (!finalAnswer) {
    options?.onEvent?.({ type: "main-start", evidenceCount: evidence.length });

    const decision = await askMainForDecision({
      routedStream: routed.stream,
      goal,
      evidenceSummary: summarizeEvidenceForMain(evidence),
      onToken: (token) => options?.onEvent?.({ type: "main-token", token }),
      forceFinalize: true,
      mainModel: routed.main,
    });

    finalAnswer = decision.answer?.trim() || "finalize fallback completed without answer";
    options?.onEvent?.({ type: "main-decision", decision: "finalize" });
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

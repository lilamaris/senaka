import type { ChatMessage } from "../../types/chat.js";
import type { EvidenceItem, MainDecision, PlanningResult, ToolResult, WorkerAction } from "./types.js";

export function extractJsonObject(input: string): string {
  const start = input.indexOf("{");
  const end = input.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("response did not include JSON object");
  }
  return input.slice(start, end + 1);
}

export function parseWorkerAction(raw: string): WorkerAction {
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

export function parseMainDecision(raw: string): MainDecision {
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
  const forcedSynthesisEnableThink =
    typeof parsed.forced_synthesis_enable_think === "boolean" ? parsed.forced_synthesis_enable_think : undefined;

  return {
    decision,
    answer,
    guidance,
    summary_evidence: summaryEvidence,
    needed_evidence: neededEvidence,
    forced_synthesis_enable_think: forcedSynthesisEnableThink,
  };
}

export function parsePlanningResult(raw: string): PlanningResult {
  const parsed = JSON.parse(extractJsonObject(raw)) as Record<string, unknown>;
  const next = parsed.next;
  if (next !== "collect_evidence" && next !== "main_decision" && next !== "final_report") {
    throw new Error("planning next must be collect_evidence, main_decision, or final_report");
  }

  const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
  if (!reason) {
    throw new Error("planning requires reason");
  }

  const evidenceGoals = Array.isArray(parsed.evidence_goals)
    ? parsed.evidence_goals.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : undefined;
  const guidance = typeof parsed.guidance === "string" ? parsed.guidance.trim() : undefined;
  const answerHint = typeof parsed.answer_hint === "string" ? parsed.answer_hint.trim() : undefined;

  return {
    next,
    reason,
    evidence_goals: evidenceGoals,
    guidance,
    answer_hint: answerHint,
  };
}

export function buildStructuredRepairPrompt(
  kind: "worker-action" | "main-decision" | "planning",
  error: string,
): ChatMessage {
  if (kind === "worker-action") {
    const lengthHint = /too long|token/i.test(error)
      ? [
          "Your response is too long.",
          "Shorten reason to one short sentence.",
          "Keep command compact and avoid unnecessary pipes/flags.",
        ]
      : [];
    const policyHint = /unsafe command blocked|pipe/i.test(error)
      ? [
          "Your command violated tool policy.",
          "Use a safe read-only command and reduce command complexity.",
        ]
      : [];
    const thinkHint = /think|token/i.test(error)
      ? [
          "Do NOT output <think> tags or hidden reasoning.",
          "Output the JSON object immediately.",
        ]
      : [];
    return {
      role: "user",
      content: [
        `Your previous output was invalid: ${error}`,
        "Re-output EXACTLY one valid JSON object for worker action.",
        "No code block, no explanation, no extra text.",
        ...lengthHint,
        ...policyHint,
        ...thinkHint,
      ].join("\n"),
    };
  }

  if (kind === "planning") {
    return {
      role: "user",
      content: [
        `Your previous output was invalid: ${error}`,
        "Re-output EXACTLY one valid JSON object.",
        "Shape:",
        "{\"next\":\"collect_evidence|main_decision|final_report\",\"reason\":\"...\",\"evidence_goals\":[\"...\"],\"guidance\":\"...\",\"answer_hint\":\"...\"}",
        "No code block, no explanation, no extra text.",
      ].join("\n"),
    };
  }

  return {
    role: "user",
    content: [
      `Your previous output was invalid: ${error}`,
      "Re-output EXACTLY one valid JSON object with decision finalize|continue.",
      "No code block, no explanation, no extra text.",
    ].join("\n"),
  };
}

export function summarizeToolResult(result: ToolResult): string {
  const stdoutLine = result.stdout.split("\n").find((line) => line.trim().length > 0) ?? "";
  const stderrLine = result.stderr.split("\n").find((line) => line.trim().length > 0) ?? "";
  return `runner=${result.runner} group=${result.workspaceGroupId} cmd=${result.cmd} exit=${result.exitCode} stdout=${stdoutLine || "<empty>"} stderr=${stderrLine || "<empty>"}`;
}

export function summarizeEvidenceForMain(evidence: EvidenceItem[]): string[] {
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

export function looksLikeStructuredOutput(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return true;
  }
  if (trimmed.startsWith("```")) {
    return true;
  }
  return /"decision"\s*:|"action"\s*:|"answer"\s*:/.test(trimmed);
}

export function tryExtractAnswerField(text: string): string | undefined {
  try {
    const parsed = JSON.parse(extractJsonObject(text)) as Record<string, unknown>;
    for (const key of ["answer", "final_answer", "response", "final"]) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}

export function fallbackFinalAnswer(goal: string, evidenceSummary: string[]): string {
  return [
    `Goal: ${goal}`,
    "Final status: evidence gathered but final narrative formatting was unstable.",
    "Key evidence:",
    ...(evidenceSummary.length > 0 ? evidenceSummary.map((e, i) => `${i + 1}. ${e}`) : ["1. none"]),
  ].join("\n");
}

export function summarizeDecisionContext(decision: MainDecision): string {
  const parts: string[] = [];
  if (decision.answer?.trim()) {
    parts.push(`decision_answer: ${decision.answer.trim()}`);
  }
  if (decision.guidance?.trim()) {
    parts.push(`decision_guidance: ${decision.guidance.trim()}`);
  }
  if (decision.summary_evidence && decision.summary_evidence.length > 0) {
    parts.push(
      `decision_summary_evidence: ${decision.summary_evidence.map((v, i) => `${i + 1}. ${v}`).join(" | ")}`,
    );
  }
  if (decision.needed_evidence && decision.needed_evidence.length > 0) {
    parts.push(`decision_needed_evidence: ${decision.needed_evidence.map((v, i) => `${i + 1}. ${v}`).join(" | ")}`);
  }
  if (typeof decision.forced_synthesis_enable_think === "boolean") {
    parts.push(`decision_forced_synthesis_enable_think: ${decision.forced_synthesis_enable_think}`);
  }
  return parts.join("\n");
}

export function estimateTokenCount(text: string): number {
  const compact = text.trim();
  if (!compact) {
    return 0;
  }
  return Math.ceil(compact.length / 4);
}

export function stripThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

export function validateWorkerReplyTokenLimit(raw: string, maxTokens: number): void {
  const estimated = estimateTokenCount(stripThinkBlocks(raw));
  if (estimated > maxTokens) {
    throw new Error(`worker response too long: estimated tokens=${estimated}, limit=${maxTokens}`);
  }
}

export function validateCommandSafety(cmd: string, maxPipes: number): void {
  const lowered = cmd.toLowerCase();
  const denied = [" rm ", "delete", " drop ", "wipe", "shutdown", "reboot", "mkfs", " dd ", " kill ", "pkill", "git push"];

  for (const keyword of denied) {
    if (lowered.includes(keyword.trim())) {
      throw new Error(`unsafe command blocked: ${keyword.trim()}`);
    }
  }

  const pipeCount = (cmd.match(/\|/g) ?? []).length;
  if (pipeCount > maxPipes) {
    throw new Error(`worker command can include at most ${maxPipes} pipe(s)`);
  }
}

export function buildWorkerMessages(params: {
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

export function buildMainPlanningMessages(goal: string, sessionContext: string[]): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are planning the first transition of an Evidence Loop.",
        "Output EXACTLY one JSON object.",
        "Use shape:",
        "{\"next\":\"collect_evidence|main_decision|final_report\",\"reason\":\"...\",\"evidence_goals\":[\"...\"],\"guidance\":\"...\",\"answer_hint\":\"...\"}",
        "Rules:",
        "- choose collect_evidence when external verification/tool execution is needed.",
        "- choose main_decision when existing context may be enough but requires sufficiency check.",
        "- choose final_report when user asks simple explanation/formatting that needs no new evidence.",
        "- keep reason concise and concrete.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `Goal: ${goal}`,
        "Recent session context:",
        ...(sessionContext.length > 0 ? sessionContext.map((line, i) => `${i + 1}. ${line}`) : ["none"]),
      ].join("\n"),
    },
  ];
}

export function buildMainDecisionMessages(goal: string, evidenceSummary: string[], forceFinalize: boolean): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are the main reviewer for an agent loop.",
        "Output EXACTLY one JSON object.",
        "Use only one of these shapes:",
        "{\"decision\":\"finalize\",\"answer\":\"...\",\"summary_evidence\":[\"...\"],\"forced_synthesis_enable_think\":true|false}",
        "{\"decision\":\"continue\",\"guidance\":\"...\",\"needed_evidence\":[\"...\"],\"forced_synthesis_enable_think\":true|false}",
        "forced_synthesis_enable_think is optional but recommended.",
        "If true, ForcedSynthesis stage may enable model thinking.",
        "If false, ForcedSynthesis stage may suppress model thinking.",
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

export function summarizePlanningContext(plan?: PlanningResult): string | undefined {
  if (!plan) {
    return undefined;
  }

  const parts = [
    `plan_next: ${plan.next}`,
    `plan_reason: ${plan.reason}`,
    plan.guidance ? `plan_guidance: ${plan.guidance}` : "",
    plan.answer_hint ? `plan_answer_hint: ${plan.answer_hint}` : "",
    plan.evidence_goals && plan.evidence_goals.length > 0
      ? `plan_evidence_goals: ${plan.evidence_goals.map((value, idx) => `${idx + 1}. ${value}`).join(" | ")}`
      : "",
  ].filter(Boolean);

  return parts.join("\n");
}

export function buildMainFinalAnswerMessages(
  goal: string,
  evidenceSummary: string[],
  decisionContext?: string,
  draft?: string,
): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are the final reporter for the Evidence Loop.",
        "Return plain text only.",
        "Do NOT output JSON, code blocks, XML, or key-value schemas.",
        "Write a concise final answer grounded in the evidence and decision context.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `Goal: ${goal}`,
        "Evidence summary:",
        ...(evidenceSummary.length > 0 ? evidenceSummary.map((e, i) => `${i + 1}. ${e}`) : ["none"]),
        decisionContext ? `Decision context:\n${decisionContext}` : "",
        draft ? `Draft answer (may be malformed): ${draft}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    },
  ];
}

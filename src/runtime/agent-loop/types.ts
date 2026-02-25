import type { AgentMode, AgentRunOverride } from "../../types/model.js";

export interface WorkerToolCall {
  action: "call_tool";
  tool: "shell";
  args: { cmd: string };
  reason: string;
}

export interface WorkerAsk {
  action: "ask";
  question: string;
}

export interface WorkerFinalize {
  action: "finalize";
}

export type WorkerAction = WorkerToolCall | WorkerAsk | WorkerFinalize;

export interface EvidenceItem {
  kind: "tool_result" | "user_answer" | "main_guidance";
  summary: string;
  detail?: string;
}

export interface ToolResult {
  cmd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  runner: "local" | "docker";
  workspaceGroupId: string;
}

export interface MainDecision {
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

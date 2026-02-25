import type { AgentMode, AgentRunOverride } from "../../types/model.js";

/**
 * 파일 목적:
 * - agent loop의 액션/증거/이벤트 계약(타입)을 단일 소스로 정의한다.
 *
 * 주요 의존성:
 * - ../../types/model.ts 의 AgentMode/override 타입
 *
 * 역의존성:
 * - run-loop.ts, llm.ts, CLI 렌더러(agent-run.ts, agent-tui.ts)
 *
 * 모듈 흐름:
 * - WorkerAction -> loop 분기
 * - EvidenceItem -> main 판단 입력
 * - AgentLoopEvent -> CLI 실시간 관측
 */
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

/**
 * 런타임 이벤트 스트림 계약.
 * UI는 이 유니온 타입만 구독하면 루프 진행 상태를 재현할 수 있다.
 */
export type AgentLoopEvent =
  | { type: "start"; agentId: string; mode: AgentMode; goal: string }
  | {
      type: "compaction-start";
      estimatedTokens: number;
      triggerTokens: number;
      targetTokens: number;
      contextLimitTokens: number;
      messageCount: number;
    }
  | {
      type: "compaction-complete";
      beforeTokens: number;
      afterTokens: number;
      beforeMessages: number;
      afterMessages: number;
    }
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
  | { type: "final-answer"; answer: string }
  | { type: "complete"; steps: number; evidenceCount: number };

/**
 * runAgentLoop 실행 옵션.
 * onEvent/askUser는 CLI(WebUI 예정 포함)와의 인터랙션 지점이다.
 */
export interface AgentLoopOptions extends AgentRunOverride {
  onEvent?: (event: AgentLoopEvent) => void;
  askUser?: (question: string) => Promise<string>;
  workspaceGroupId?: string;
}

/**
 * 루프 최종 결과 요약.
 * 이벤트 로그와 별개로 "최종 상태 스냅샷"을 제공한다.
 */
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

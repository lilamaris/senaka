import { saveSession } from "../session-store.js";
import type { ChatSession } from "../../types/chat.js";
import type { AppConfig } from "../../config/env.js";
import type { ResolvedAgentConfig } from "../../types/model.js";
import type { AgentLoopOptions, EvidenceItem, PlanningResult, ToolResult } from "./types.js";
import { summarizeEvidenceForMain } from "./helpers.js";

/**
 * 파일 목적:
 * - agent loop 상태 머신의 공통 상태 타입/유틸을 제공한다.
 *
 * 주요 의존성:
 * - session-store: 세션 저장
 * - helpers: 증거 요약 유틸
 *
 * 역의존성:
 * - run-loop.ts, stages.ts, context-guard.ts
 *
 * 모듈 흐름:
 * 1) LoopState/LoopRuntime/LoopDependencies 정의
 * 2) 세션 append 저장 유틸 제공
 * 3) 상태 이벤트/의사결정 요약 유틸 제공
 */
export enum LoopState {
  PlanIntent = "plan-intent",
  ContextGuard = "context-guard",
  AcquireEvidence = "acquire-evidence",
  AssessSufficiency = "assess-sufficiency",
  ForcedSynthesis = "forced-synthesis",
  Done = "done",
}

/**
 * 루프 동안 계속 변하는 가변 상태 묶음.
 */
export interface LoopRuntime {
  planning?: PlanningResult;
  forcedSynthesisEnableThink?: boolean;
  forcedSynthesisReason?: string;
  workerValidationFailureStreak: number;
  evidence: EvidenceItem[];
  guidance: string;
  recentUserAnswer: string;
  lastTool?: ToolResult;
  finalAnswer: string;
  steps: number;
  step: number;
  resumeStateAfterCompaction: LoopState;
  lastCompactionSignature?: string;
}

/**
 * 루프 동안 거의 고정인 의존성 묶음.
 */
export interface LoopDependencies {
  config: AppConfig;
  session: ChatSession;
  goal: string;
  routed: ResolvedAgentConfig;
  contextLimitTokens: number;
  options?: AgentLoopOptions;
  workerSystemPrompt: string;
  workspaceGroupId: string;
}

export type SessionEntry = ChatSession["messages"][number];

/**
 * 세션 메시지 append + 저장을 원자적으로 처리한다.
 */
export async function appendSessionEntries(config: AppConfig, session: ChatSession, entries: SessionEntry[]): Promise<void> {
  session.messages.push(...entries);
  await saveSession(config.sessionDir, session);
}

/**
 * 시스템 로그 메시지를 세션에 남기는 축약 함수.
 */
export async function appendSystemEntry(config: AppConfig, session: ChatSession, content: string): Promise<void> {
  await appendSessionEntries(config, session, [{ role: "system", content }]);
}

/**
 * 상태 진입 요약 이벤트를 공통 형식으로 발행한다.
 */
export function emitLoopState(
  deps: LoopDependencies,
  runtime: LoopRuntime,
  state: Exclude<LoopState, LoopState.Done>,
  summary: string,
): void {
  deps.options?.onEvent?.({
    type: "loop-state",
    state,
    step: runtime.step,
    evidenceCount: runtime.evidence.length,
    summary,
  });
}

export function clipText(value: string, limit: number): string {
  const compact = value.trim();
  if (compact.length <= limit) {
    return compact;
  }
  return `${compact.slice(0, limit)} ...[truncated]`;
}

function summarizePlanningForDecision(plan?: PlanningResult): string[] {
  if (!plan) {
    return [];
  }

  const out = [`[planning] next=${plan.next} reason=${plan.reason}`];
  if (plan.guidance?.trim()) {
    out.push(`[planning] guidance=${plan.guidance.trim()}`);
  }
  if (plan.evidence_goals && plan.evidence_goals.length > 0) {
    out.push(`[planning] evidence_goals=${plan.evidence_goals.map((goal, idx) => `${idx + 1}. ${goal}`).join(" | ")}`);
  }
  return out;
}

export function summarizeDecisionEvidence(runtime: LoopRuntime): string[] {
  const planningSummary = summarizePlanningForDecision(runtime.planning);
  const evidenceSummary = summarizeEvidenceForMain(runtime.evidence);
  return [...planningSummary, ...evidenceSummary];
}

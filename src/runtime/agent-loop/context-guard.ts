import { saveSession } from "../session-store.js";
import type { ChatSession } from "../../types/chat.js";
import type { ResolvedAgentConfig } from "../../types/model.js";
import { estimateTokenCount } from "./helpers.js";
import { clipText } from "./loop-state.js";
import type { LoopDependencies, LoopRuntime, SessionEntry } from "./loop-state.js";
import { LoopState, emitLoopState } from "./loop-state.js";

/**
 * 파일 목적:
 * - 컨텍스트 길이 가드와 세션 compaction 전략을 제공한다.
 *
 * 주요 의존성:
 * - session-store: compaction 후 세션 저장
 * - helpers.estimateTokenCount: 토큰 근사 계산
 *
 * 역의존성:
 * - run-loop.ts, stages.ts
 *
 * 모듈 흐름:
 * 1) contextLength 기반 compaction 계획 계산
 * 2) 요약 문서 생성 + 최근 대화 유지
 * 3) 목표 토큰 이하로 압축 후 세션 저장
 */
const DEFAULT_CONTEXT_LENGTH = 8192;
const COMPACTION_TRIGGER_RATIO = 0.85;
const COMPACTION_TARGET_RATIO = 0.55;
const COMPACTION_MIN_MESSAGES = 24;
const COMPACTION_MAX_RECENT_MESSAGES = 24;
const COMPACTION_MIN_RECENT_MESSAGES = 6;
const COMPACTION_CLIP_CHARS = 700;
const COMPACTION_MARKER = "[SESSION_COMPACTION]";

export interface CompactionPlan {
  shouldCompact: boolean;
  estimatedTokens: number;
  triggerTokens: number;
  targetTokens: number;
  signature: string;
}

/**
 * worker/main 모델 중 더 작은 컨텍스트 한도를 루프 기준으로 사용한다.
 */
export function resolveContextLimitTokens(routed: ResolvedAgentConfig): number {
  const candidates = [routed.main.contextLength, routed.worker.contextLength]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0)
    .map((value) => Math.floor(value));
  if (candidates.length === 0) {
    return DEFAULT_CONTEXT_LENGTH;
  }
  return Math.min(...candidates);
}

function estimateSessionTokens(messages: SessionEntry[]): number {
  return messages.reduce((sum, message) => sum + estimateTokenCount(message.content) + 6, 0);
}

function stripLoopTagPrefix(content: string): string {
  const idx = content.indexOf("]");
  if (idx < 0) {
    return content.trim();
  }
  return content.slice(idx + 1).trim();
}

function isLoopTaggedSystemMessage(message: SessionEntry): boolean {
  return message.role === "system" && /^\[(WORKER_|MAIN_|SESSION_COMPACTION)/.test(message.content);
}

function extractLatestByPrefix(messages: SessionEntry[], prefix: string, limit: number): string[] {
  const matched = messages
    .filter((message) => message.content.startsWith(prefix))
    .map((message) => stripLoopTagPrefix(message.content));
  return matched.slice(-limit);
}

function buildCompactionSummaryDocument(goal: string, runtime: LoopRuntime, messages: SessionEntry[]): string {
  const goals = extractLatestByPrefix(messages, "[AGENT_GOAL:", 3);
  const commands = extractLatestByPrefix(messages, "[WORKER_TOOL_", 8).filter((line) => !line.startsWith("exit="));
  const results = extractLatestByPrefix(messages, "[WORKER_TOOL_RESULT_", 8);
  const asks = extractLatestByPrefix(messages, "[WORKER_ASK_", 5);
  const answers = extractLatestByPrefix(messages, "[WORKER_ASK_ANSWER_", 5);
  const guidances = extractLatestByPrefix(messages, "[MAIN_GUIDANCE_", 6);
  const failures = messages
    .filter((message) => message.role === "system" && message.content.includes("_FAIL"))
    .map((message) => stripLoopTagPrefix(message.content))
    .slice(-5);
  const latestAssistant = [...messages]
    .reverse()
    .find((message) => message.role === "assistant" && message.content.trim().length > 0)?.content;

  return [
    `${COMPACTION_MARKER} 자동 생성 요약`,
    `- 생성 시각: ${new Date().toISOString()}`,
    `- 현재 목표: ${goal}`,
    `- 누적 루프 step: ${runtime.step}`,
    `- 누적 evidence 개수: ${runtime.evidence.length}`,
    `- 최근 목표 기록: ${goals.length > 0 ? goals.map((line) => clipText(line, 180)).join(" | ") : "없음"}`,
    `- 최근 실행 명령: ${commands.length > 0 ? commands.map((line) => clipText(line, 180)).join(" | ") : "없음"}`,
    `- 최근 명령 결과: ${results.length > 0 ? results.map((line) => clipText(line, 120)).join(" | ") : "없음"}`,
    `- 사용자 확인 질문: ${asks.length > 0 ? asks.map((line) => clipText(line, 180)).join(" | ") : "없음"}`,
    `- 사용자 답변: ${answers.length > 0 ? answers.map((line) => clipText(line, 120)).join(" | ") : "없음"}`,
    `- main guidance: ${guidances.length > 0 ? guidances.map((line) => clipText(line, 180)).join(" | ") : "없음"}`,
    `- 실패 로그 요약: ${failures.length > 0 ? failures.map((line) => clipText(line, 180)).join(" | ") : "없음"}`,
    `- 최근 assistant 응답: ${latestAssistant ? clipText(latestAssistant, 260) : "없음"}`,
  ].join("\n");
}

function dedupeMessages(messages: SessionEntry[]): SessionEntry[] {
  const seen = new Set<string>();
  const out: SessionEntry[] = [];
  for (const message of messages) {
    const key = `${message.role}:${message.content}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(message);
  }
  return out;
}

export function computeCompactionPlan(session: ChatSession, contextLimitTokens: number): CompactionPlan {
  const estimatedTokens = estimateSessionTokens(session.messages);
  const triggerTokens = Math.floor(contextLimitTokens * COMPACTION_TRIGGER_RATIO);
  const targetTokens = Math.floor(contextLimitTokens * COMPACTION_TARGET_RATIO);
  const tail = session.messages[session.messages.length - 1];
  const signature = `${estimatedTokens}:${session.messages.length}:${tail?.role ?? "none"}:${tail?.content.length ?? 0}`;

  return {
    shouldCompact: session.messages.length >= COMPACTION_MIN_MESSAGES && estimatedTokens >= triggerTokens,
    estimatedTokens,
    triggerTokens,
    targetTokens,
    signature,
  };
}

function buildCompactedSessionMessages(
  session: ChatSession,
  summaryDoc: string,
  targetTokens: number,
): SessionEntry[] {
  const nonCompactionMessages = session.messages.filter(
    (message) => !(message.role === "system" && message.content.startsWith(COMPACTION_MARKER)),
  );
  const baseSystem = nonCompactionMessages.find(
    (message) => message.role === "system" && !isLoopTaggedSystemMessage(message),
  );

  let recent = nonCompactionMessages.slice(-COMPACTION_MAX_RECENT_MESSAGES).map((message) => ({
    role: message.role,
    content: message.content.trim(),
  }));

  const base: SessionEntry[] = [];
  if (baseSystem) {
    base.push(baseSystem);
  }
  base.push({ role: "system", content: summaryDoc });

  const rebuild = (): SessionEntry[] => dedupeMessages([...base, ...recent]);

  let compacted = rebuild();
  while (estimateSessionTokens(compacted) > targetTokens && recent.length > COMPACTION_MIN_RECENT_MESSAGES) {
    recent = recent.slice(1);
    compacted = rebuild();
  }

  if (estimateSessionTokens(compacted) > targetTokens) {
    recent = recent.map((message) => ({ ...message, content: clipText(message.content, COMPACTION_CLIP_CHARS) }));
    compacted = rebuild();
  }

  while (estimateSessionTokens(compacted) > targetTokens && recent.length > 1) {
    recent = recent.slice(1);
    compacted = rebuild();
  }

  return compacted;
}

/**
 * planning 단계 입력으로 사용할 최근 세션 요약을 생성한다.
 */
export function summarizeSessionForPlanning(messages: SessionEntry[]): string[] {
  const filtered = messages.filter((message) => {
    if (!message.content.trim()) {
      return false;
    }
    if (message.role === "system" && message.content.startsWith(COMPACTION_MARKER)) {
      return false;
    }
    return true;
  });

  const recent = filtered.slice(-16);
  return recent.map((message) => {
    const content = isLoopTaggedSystemMessage(message) ? stripLoopTagPrefix(message.content) : message.content.trim();
    return `${message.role}: ${clipText(content, 220)}`;
  });
}

/**
 * 컨텍스트 초과 시 세션 전체를 압축한다.
 */
export async function handleContextCompaction(deps: LoopDependencies, runtime: LoopRuntime): Promise<LoopState> {
  emitLoopState(
    deps,
    runtime,
    LoopState.ContextGuard,
    `context tokens are near limit (${deps.contextLimitTokens}); compacting session history`,
  );
  const plan = computeCompactionPlan(deps.session, deps.contextLimitTokens);
  if (!plan.shouldCompact) {
    runtime.lastCompactionSignature = undefined;
    return runtime.resumeStateAfterCompaction;
  }

  deps.options?.onEvent?.({
    type: "compaction-start",
    estimatedTokens: plan.estimatedTokens,
    triggerTokens: plan.triggerTokens,
    targetTokens: plan.targetTokens,
    contextLimitTokens: deps.contextLimitTokens,
    messageCount: deps.session.messages.length,
  });

  const summaryDoc = buildCompactionSummaryDocument(deps.goal, runtime, deps.session.messages);
  const compactedMessages = buildCompactedSessionMessages(deps.session, summaryDoc, plan.targetTokens);
  const beforeMessages = deps.session.messages.length;
  const beforeTokens = plan.estimatedTokens;

  deps.session.messages = compactedMessages;
  await saveSession(deps.config.sessionDir, deps.session);

  const afterTokens = estimateSessionTokens(deps.session.messages);
  runtime.lastCompactionSignature = computeCompactionPlan(deps.session, deps.contextLimitTokens).signature;

  deps.options?.onEvent?.({
    type: "compaction-complete",
    beforeTokens,
    afterTokens,
    beforeMessages,
    afterMessages: deps.session.messages.length,
  });

  return runtime.resumeStateAfterCompaction;
}

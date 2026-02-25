import type { ChatSession } from "../../types/chat.js";
import type { AppConfig } from "../../config/env.js";
import { routeAgentModels } from "../../models/role-router.js";
import { loadModelRegistry } from "../../models/profile-registry.js";
import type { ResolvedAgentConfig } from "../../types/model.js";
import { saveSession } from "../session-store.js";
import {
  fallbackFinalAnswer,
  estimateTokenCount,
  summarizeDecisionContext,
  summarizeEvidenceForMain,
  summarizeToolResult,
  buildWorkerMessages,
} from "./helpers.js";
import {
  askMainForDecision,
  askMainForFinalAnswer,
  askMainForPlanning,
  askWorkerForAction,
  loadWorkerSystemPrompt,
  runShellCommand,
} from "./llm.js";
import type { AgentLoopOptions, AgentRunResult, EvidenceItem, MainDecision, PlanningResult, ToolResult, WorkerAction } from "./types.js";

/**
 * 파일 목적:
 * - 에이전트 상태 머신(증거 수집 -> 메인 판단 -> 최종 응답)을 실제로 실행한다.
 *
 * 주요 의존성:
 * - models/*: 에이전트별 모델 라우팅/프로파일 해석
 * - llm.ts: worker/main 호출 및 샌드박스 명령 실행
 * - helpers.ts: 프롬프트/요약/폴백 유틸리티
 * - session-store.ts: 루프 중간 상태를 세션에 지속 저장
 *
 * 역의존성(이 파일을 사용하는 곳):
 * - src/runtime/agent-loop.ts (공개 엔트리 재-export)
 * - src/cli/agent-run.ts, src/cli/agent-tui.ts (CLI 실행 진입점)
 *
 * 모듈 흐름:
 * 1) 모델 라우팅과 초기 컨텍스트 준비
 * 2) planning 단계에서 초기 전이(수집/판단/바로 보고) 결정
 * 3) worker가 증거를 수집(call_tool/ask/finalize)
 * 4) main이 continue/finalize 의사결정
 * 5) finalize 시 최종 리포트 생성 후 세션/이벤트로 반환
 */
enum LoopState {
  PlanIntent = "plan-intent",
  ContextGuard = "context-guard",
  AcquireEvidence = "acquire-evidence",
  AssessSufficiency = "assess-sufficiency",
  ForcedSynthesis = "forced-synthesis",
  Done = "done",
}

const DEFAULT_CONTEXT_LENGTH = 8192;
const COMPACTION_TRIGGER_RATIO = 0.85;
const COMPACTION_TARGET_RATIO = 0.55;
const COMPACTION_MIN_MESSAGES = 24;
const COMPACTION_MAX_RECENT_MESSAGES = 24;
const COMPACTION_MIN_RECENT_MESSAGES = 6;
const COMPACTION_CLIP_CHARS = 700;
const COMPACTION_MARKER = "[SESSION_COMPACTION]";

/**
 * 루프 동안 계속 변하는 가변 상태 묶음.
 * 분기 함수들(handle*)에서 공통으로 읽고 갱신한다.
 */
interface LoopRuntime {
  planning?: PlanningResult;
  forcedSynthesisEnableThink?: boolean;
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
 * 매 호출마다 인자를 길게 넘기지 않도록 한 컨테이너다.
 */
interface LoopDependencies {
  config: AppConfig;
  session: ChatSession;
  goal: string;
  routed: ResolvedAgentConfig;
  contextLimitTokens: number;
  options?: AgentLoopOptions;
  workerSystemPrompt: string;
  workspaceGroupId: string;
}

type SessionEntry = ChatSession["messages"][number];

interface CompactionPlan {
  shouldCompact: boolean;
  estimatedTokens: number;
  triggerTokens: number;
  targetTokens: number;
  signature: string;
}

/**
 * 세션 메시지 append + 저장을 원자적으로 처리한다.
 * 이벤트 로그/재개 복구 관점에서 "push만 하고 저장하지 않는" 상태를 피하기 위한 헬퍼.
 */
async function appendSessionEntries(config: AppConfig, session: ChatSession, entries: SessionEntry[]): Promise<void> {
  session.messages.push(...entries);
  await saveSession(config.sessionDir, session);
}

/**
 * 시스템 로그 메시지를 세션에 남기는 축약 함수.
 */
async function appendSystemEntry(config: AppConfig, session: ChatSession, content: string): Promise<void> {
  await appendSessionEntries(config, session, [{ role: "system", content }]);
}

/**
 * worker/main 모델 중 더 작은 컨텍스트 한도를 루프 기준으로 사용한다.
 * 둘 중 하나라도 작은 모델이 있으면 그 모델을 기준으로 조기 압축해 안전 여유를 확보한다.
 */
function resolveContextLimitTokens(routed: ResolvedAgentConfig): number {
  const candidates = [routed.main.contextLength, routed.worker.contextLength]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0)
    .map((value) => Math.floor(value));
  if (candidates.length === 0) {
    return DEFAULT_CONTEXT_LENGTH;
  }
  return Math.min(...candidates);
}

/**
 * 메시지 배열을 단순 토큰 추정치로 환산한다.
 * 정확 토크나이저 대신 char/4 근사치를 사용해 모델 독립적으로 빠르게 계산한다.
 */
function estimateSessionTokens(messages: SessionEntry[]): number {
  return messages.reduce((sum, message) => sum + estimateTokenCount(message.content) + 6, 0);
}

function clipText(value: string, limit: number): string {
  const compact = value.trim();
  if (compact.length <= limit) {
    return compact;
  }
  return `${compact.slice(0, limit)} ...[truncated]`;
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

/**
 * 압축 요약 문서를 생성한다.
 * 맥락 손실을 줄이기 위해 목적/실행/질의응답/가이드라인/최근 결론을 분리해 기록한다.
 */
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

function computeCompactionPlan(session: ChatSession, contextLimitTokens: number): CompactionPlan {
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

function summarizeSessionForPlanning(messages: SessionEntry[]): string[] {
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

function summarizeDecisionEvidence(runtime: LoopRuntime): string[] {
  const planningSummary = summarizePlanningForDecision(runtime.planning);
  const evidenceSummary = summarizeEvidenceForMain(runtime.evidence);
  return [...planningSummary, ...evidenceSummary];
}

/**
 * 컨텍스트 초과 시 세션 전체를 압축한다.
 * 요약 문서를 보존하고 최근 메시지 일부만 남겨 모델 입력 여유를 복구한다.
 */
async function handleContextCompaction(deps: LoopDependencies, runtime: LoopRuntime): Promise<LoopState> {
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

/**
 * 루프 시작 planning 단계.
 * 사용자 요청의 성격을 먼저 분류해 증거 수집이 필요한지 여부를 결정한다.
 */
async function handlePlanningTurn(deps: LoopDependencies, runtime: LoopRuntime): Promise<LoopState> {
  deps.options?.onEvent?.({ type: "planning-start", goal: deps.goal });

  let planning: PlanningResult;
  try {
    planning = await askMainForPlanning({
      config: deps.config,
      allowStreaming: deps.routed.stream,
      goal: deps.goal,
      sessionContext: summarizeSessionForPlanning(deps.session.messages),
      onToken: (token) => deps.options?.onEvent?.({ type: "main-token", token }),
      mainModel: deps.routed.main,
    });
  } catch (error) {
    const reason = (error as Error).message;
    planning = {
      next: "collect_evidence",
      reason: `planning failed: ${reason}`,
      guidance: "Collect concrete evidence with safe read-only commands before finalize.",
    };
    await appendSystemEntry(deps.config, deps.session, `[PLANNING_FAIL] ${reason}`);
  }

  runtime.planning = planning;
  if (planning.guidance?.trim()) {
    runtime.guidance = planning.guidance.trim();
  }
  if (planning.evidence_goals && planning.evidence_goals.length > 0) {
    runtime.evidence.push({
      kind: "main_guidance",
      summary: `planning goals: ${planning.evidence_goals.map((goal, idx) => `${idx + 1}. ${goal}`).join(" | ")}`,
    });
  }

  deps.options?.onEvent?.({
    type: "planning-result",
    next: planning.next,
    reason: planning.reason,
    evidenceGoals: planning.evidence_goals ?? [],
    guidance: planning.guidance,
  });
  await appendSystemEntry(
    deps.config,
    deps.session,
    `[PLANNING_RESULT] next=${planning.next} reason=${clipText(planning.reason, 220)}`,
  );

  if (planning.next === "collect_evidence") {
    return LoopState.AcquireEvidence;
  }

  if (planning.next === "main_decision") {
    return LoopState.AssessSufficiency;
  }

  const evidenceSummary = summarizeDecisionEvidence(runtime);
  try {
    runtime.finalAnswer = await askMainForFinalAnswer({
      config: deps.config,
      goal: deps.goal,
      evidenceSummary,
      planning: runtime.planning,
      draft: planning.answer_hint?.trim(),
      allowStreaming: deps.routed.stream,
      onToken: (token) => deps.options?.onEvent?.({ type: "main-token", token }),
      mainModel: deps.routed.main,
    });
  } catch (error) {
    const reason = (error as Error).message;
    runtime.finalAnswer = fallbackFinalAnswer(deps.goal, evidenceSummary);
    await appendSystemEntry(deps.config, deps.session, `[PLANNING_FINAL_REPORT_FAIL] ${reason}`);
  }

  deps.options?.onEvent?.({ type: "final-answer", answer: runtime.finalAnswer });
  return LoopState.Done;
}

/**
 * main 의사결정 결과를 바탕으로 최종 사용자 응답을 생성한다.
 * 실패 시에도 사용자에게 응답이 없지 않도록 fallbackFinalAnswer를 반환한다.
 */
async function buildFinalAnswerFromDecision(params: {
  deps: LoopDependencies;
  runtime: LoopRuntime;
  decision: MainDecision;
  evidenceSummary: string[];
}): Promise<string> {
  const draft = params.decision.answer?.trim();
  const decisionContext = summarizeDecisionContext(params.decision);

  try {
    return await askMainForFinalAnswer({
      config: params.deps.config,
      goal: params.deps.goal,
      evidenceSummary: params.evidenceSummary,
      decisionContext,
      planning: params.runtime.planning,
      draft,
      allowStreaming: params.deps.routed.stream,
      onToken: (token) => params.deps.options?.onEvent?.({ type: "main-token", token }),
      mainModel: params.deps.routed.main,
    });
  } catch (error) {
    const reason = (error as Error).message;
    await appendSystemEntry(
      params.deps.config,
      params.deps.session,
      `[MAIN_FINAL_ANSWER_FAIL_${params.runtime.step}] ${reason}`,
    );
    return fallbackFinalAnswer(params.deps.goal, params.evidenceSummary);
  }
}

/**
 * worker 한 턴을 처리한다.
 * - call_tool: 명령 실행 후 증거 누적
 * - ask: 사용자 YES/NO 응답을 증거로 누적
 * - finalize: main 판단 단계로 전이
 */
async function handleWorkerTurn(deps: LoopDependencies, runtime: LoopRuntime): Promise<LoopState> {
  if (runtime.step > deps.routed.maxSteps) {
    return LoopState.ForcedSynthesis;
  }

  runtime.steps = runtime.step;
  deps.options?.onEvent?.({ type: "worker-start", step: runtime.step });

  const workerMessages = buildWorkerMessages({
    workerSystemPrompt: deps.workerSystemPrompt,
    goal: deps.goal,
    step: runtime.step,
    evidence: runtime.evidence,
    guidance: runtime.guidance,
    lastTool: runtime.lastTool,
    recentUserAnswer: runtime.recentUserAnswer,
  });

  let action: WorkerAction;
  try {
    action = await askWorkerForAction({
      config: deps.config,
      step: runtime.step,
      maxRetries: deps.config.workerActionMaxRetries,
      allowStreaming: deps.routed.stream,
      model: deps.routed.worker,
      workerMessages,
      onToken: (token) => deps.options?.onEvent?.({ type: "worker-token", step: runtime.step, token }),
    });
  } catch (error) {
    const reason = (error as Error).message;
    const fallbackGuidance = `Worker validation failed at step ${runtime.step}. Proceed to main finalization using collected evidence. ${reason}`;
    deps.options?.onEvent?.({ type: "worker-action", step: runtime.step, action: "finalize", detail: fallbackGuidance });
    runtime.evidence.push({ kind: "main_guidance", summary: fallbackGuidance });
    await appendSystemEntry(deps.config, deps.session, `[WORKER_VALIDATION_FAIL_${runtime.step}] ${reason}`);
    return LoopState.ForcedSynthesis;
  }

  // 분기 1) worker가 셸 증거 수집을 요청한 경우
  if (action.action === "call_tool") {
    deps.options?.onEvent?.({ type: "worker-action", step: runtime.step, action: "call_tool", detail: action.reason });
    deps.options?.onEvent?.({ type: "tool-start", step: runtime.step, cmd: action.args.cmd });

    const result = await runShellCommand(deps.config, action.args.cmd, deps.workspaceGroupId);
    runtime.lastTool = result;

    runtime.evidence.push({
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

    deps.options?.onEvent?.({
      type: "tool-result",
      step: runtime.step,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      runner: result.runner,
      workspaceGroupId: result.workspaceGroupId,
    });

    await appendSessionEntries(deps.config, deps.session, [
      { role: "system", content: `[WORKER_TOOL_${runtime.step}] ${result.cmd}` },
      { role: "system", content: `[WORKER_TOOL_RESULT_${runtime.step}] exit=${result.exitCode}` },
    ]);
    runtime.step += 1;
    return LoopState.AcquireEvidence;
  }

  // 분기 2) worker가 사용자에게 YES/NO 확인을 요청한 경우
  if (action.action === "ask") {
    deps.options?.onEvent?.({ type: "worker-action", step: runtime.step, action: "ask", detail: action.question });
    deps.options?.onEvent?.({ type: "ask", step: runtime.step, question: action.question });

    if (!deps.options?.askUser) {
      throw new Error(`worker asked user input but askUser callback is not configured: ${action.question}`);
    }

    const answer = (await deps.options.askUser(action.question)).trim();
    runtime.recentUserAnswer = answer;
    runtime.evidence.push({ kind: "user_answer", summary: `Q: ${action.question} / A: ${answer}` });
    deps.options?.onEvent?.({ type: "ask-answer", step: runtime.step, answer });

    await appendSessionEntries(deps.config, deps.session, [
      { role: "user", content: `[WORKER_ASK_${runtime.step}] ${action.question}` },
      { role: "user", content: `[WORKER_ASK_ANSWER_${runtime.step}] ${answer}` },
    ]);
    runtime.step += 1;
    return LoopState.AcquireEvidence;
  }

  // 분기 3) worker가 수집 완료를 선언한 경우(main 판단 단계로 이동)
  deps.options?.onEvent?.({
    type: "worker-action",
    step: runtime.step,
    action: "finalize",
    detail: "worker requested finalize",
  });
  return LoopState.AssessSufficiency;
}

/**
 * main decision 턴을 처리한다.
 * - continue: guidance를 worker에 되돌려 추가 증거 수집
 * - finalize: 최종 리포트 생성으로 종료
 */
async function handleMainDecisionTurn(deps: LoopDependencies, runtime: LoopRuntime): Promise<LoopState> {
  deps.options?.onEvent?.({ type: "main-start", evidenceCount: runtime.evidence.length });
  const evidenceSummary = summarizeDecisionEvidence(runtime);

  let decision: MainDecision;
  try {
    decision = await askMainForDecision({
      config: deps.config,
      allowStreaming: deps.routed.stream,
      goal: deps.goal,
      evidenceSummary,
      onToken: (token) => deps.options?.onEvent?.({ type: "main-token", token }),
      forceFinalize: false,
      mainModel: deps.routed.main,
    });
  } catch (error) {
    const reason = (error as Error).message;
    // main 판정 자체가 깨져도 루프를 중단하지 않고, 안전한 추가 수집으로 복구한다.
    runtime.guidance = `Main decision failed at step ${runtime.step}. Continue evidence loop with safer minimal actions. ${reason}`;
    runtime.evidence.push({ kind: "main_guidance", summary: runtime.guidance });
    await appendSystemEntry(deps.config, deps.session, `[MAIN_DECISION_FAIL_${runtime.step}] ${reason}`);
    deps.options?.onEvent?.({ type: "main-decision", decision: "continue", guidance: runtime.guidance });
    runtime.step += 1;
    return LoopState.AcquireEvidence;
  }

  deps.options?.onEvent?.({
    type: "main-decision",
    decision: decision.decision,
    guidance: decision.guidance,
  });
  if (typeof decision.forced_synthesis_enable_think === "boolean") {
    runtime.forcedSynthesisEnableThink = decision.forced_synthesis_enable_think;
  }

  if (decision.decision === "continue") {
    // guidance가 비어 있는 모델 응답도 발생할 수 있어 최소 기본 문구를 강제한다.
    runtime.guidance = decision.guidance?.trim() || "Gather more concrete evidence and retry finalize.";
    runtime.evidence.push({ kind: "main_guidance", summary: runtime.guidance });
    await appendSystemEntry(deps.config, deps.session, `[MAIN_GUIDANCE_${runtime.step}] ${runtime.guidance}`);
    runtime.step += 1;
    return LoopState.AcquireEvidence;
  }

  runtime.finalAnswer = await buildFinalAnswerFromDecision({
    deps,
    runtime,
    decision,
    evidenceSummary,
  });
  deps.options?.onEvent?.({ type: "final-answer", answer: runtime.finalAnswer });
  return LoopState.Done;
}

/**
 * max step 초과나 worker 검증 실패 시 강제 최종화 경로.
 * 의도는 "실패하더라도 사용자에게 최종 결과를 반환"하는 데 있다.
 */
async function handleForceFinalizeTurn(deps: LoopDependencies, runtime: LoopRuntime): Promise<LoopState> {
  deps.options?.onEvent?.({ type: "main-start", evidenceCount: runtime.evidence.length });
  const evidenceSummary = summarizeDecisionEvidence(runtime);

  try {
    const decision = await askMainForDecision({
      config: deps.config,
      allowStreaming: deps.routed.stream,
      goal: deps.goal,
      evidenceSummary,
      onToken: (token) => deps.options?.onEvent?.({ type: "main-token", token }),
      forceFinalize: true,
      enableThinkOverride: runtime.forcedSynthesisEnableThink,
      mainModel: deps.routed.main,
    });
    runtime.finalAnswer = await askMainForFinalAnswer({
      config: deps.config,
      goal: deps.goal,
      evidenceSummary,
      decisionContext: summarizeDecisionContext(decision),
      planning: runtime.planning,
      draft: decision.answer?.trim(),
      allowStreaming: deps.routed.stream,
      onToken: (token) => deps.options?.onEvent?.({ type: "main-token", token }),
      enableThinkOverride: runtime.forcedSynthesisEnableThink,
      mainModel: deps.routed.main,
    });
    deps.options?.onEvent?.({ type: "main-decision", decision: "finalize" });
    deps.options?.onEvent?.({ type: "final-answer", answer: runtime.finalAnswer });
  } catch (error) {
    const reason = (error as Error).message;
    runtime.finalAnswer = fallbackFinalAnswer(deps.goal, evidenceSummary);
    await appendSystemEntry(deps.config, deps.session, `[MAIN_FORCE_FINALIZE_FAIL] ${reason}`);
    deps.options?.onEvent?.({ type: "main-decision", decision: "finalize", guidance: `fallback finalize: ${reason}` });
    deps.options?.onEvent?.({ type: "final-answer", answer: runtime.finalAnswer });
  }

  return LoopState.Done;
}

/**
 * 에이전트 루프 메인 엔트리.
 * 상태 머신을 순환하며 이벤트를 발행하고, 최종적으로 세션/응답을 확정한다.
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
    evidence: [],
    guidance: "",
    recentUserAnswer: "",
    finalAnswer: "",
    steps: 0,
    step: 1,
    resumeStateAfterCompaction: LoopState.PlanIntent,
  };
  let state: LoopState = LoopState.PlanIntent;
  const deps: LoopDependencies = {
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

    // 상태별 핸들러를 분리해 루프 본체는 "전이 제어"만 담당한다.
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

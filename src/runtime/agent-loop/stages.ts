import { askMainForDecision, askMainForFinalAnswer, askMainForPlanning, askWorkerForAction, runShellCommand } from "./llm.js";
import { fallbackFinalAnswer, summarizeDecisionContext, summarizeToolResult, buildWorkerMessages } from "./helpers.js";
import type { MainDecision, WorkerAction } from "./types.js";
import {
  LoopState,
  appendSessionEntries,
  appendSystemEntry,
  clipText,
  emitLoopState,
  summarizeDecisionEvidence,
  type LoopDependencies,
  type LoopRuntime,
} from "./loop-state.js";
import { summarizeSessionForPlanning } from "./context-guard.js";

/**
 * 파일 목적:
 * - 상태 머신의 주요 단계 핸들러(planning/worker/main/finalize)를 제공한다.
 *
 * 주요 의존성:
 * - llm.ts: worker/main 호출과 tool 실행
 * - helpers.ts: 프롬프트/요약/폴백 유틸
 * - loop-state.ts: 공통 상태/세션 append 유틸
 * - context-guard.ts: planning 입력용 세션 요약
 *
 * 역의존성:
 * - src/runtime/agent-loop/run-loop.ts
 *
 * 모듈 흐름:
 * 1) Planning: 초기 전이 결정
 * 2) AcquireEvidence: worker 액션 처리
 * 3) AssessSufficiency: main의 continue/finalize 판단
 * 4) ForcedSynthesis: 예외 경로 강제 최종화
 */

/**
 * main 의사결정 결과를 바탕으로 최종 사용자 응답을 생성한다.
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
    params.deps.options?.onEvent?.({ type: "main-start", phase: "final-report", evidenceCount: params.runtime.evidence.length });
    return await askMainForFinalAnswer({
      config: params.deps.config,
      goal: params.deps.goal,
      evidenceSummary: params.evidenceSummary,
      decisionContext,
      planning: params.runtime.planning,
      draft,
      allowStreaming: params.deps.routed.stream,
      onToken: (token) => params.deps.options?.onEvent?.({ type: "main-token", phase: "final-report", token }),
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
 * 루프 시작 planning 단계를 처리한다.
 */
export async function handlePlanningTurn(deps: LoopDependencies, runtime: LoopRuntime): Promise<LoopState> {
  emitLoopState(
    deps,
    runtime,
    LoopState.PlanIntent,
    `planning user intent and selecting next transition from goal="${clipText(deps.goal, 120)}"`,
  );
  deps.options?.onEvent?.({ type: "planning-start", goal: deps.goal });

  let planning;
  try {
    deps.options?.onEvent?.({ type: "main-start", phase: "planning", evidenceCount: runtime.evidence.length });
    planning = await askMainForPlanning({
      config: deps.config,
      allowStreaming: deps.routed.stream,
      goal: deps.goal,
      sessionContext: summarizeSessionForPlanning(deps.session.messages),
      onToken: (token) => deps.options?.onEvent?.({ type: "main-token", phase: "planning", token }),
      mainModel: deps.routed.main,
    });
  } catch (error) {
    const reason = (error as Error).message;
    planning = {
      next: "collect_evidence" as const,
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
    deps.options?.onEvent?.({ type: "main-start", phase: "final-report", evidenceCount: runtime.evidence.length });
    runtime.finalAnswer = await askMainForFinalAnswer({
      config: deps.config,
      goal: deps.goal,
      evidenceSummary,
      planning: runtime.planning,
      draft: planning.answer_hint?.trim(),
      allowStreaming: deps.routed.stream,
      onToken: (token) => deps.options?.onEvent?.({ type: "main-token", phase: "final-report", token }),
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
 * worker 한 턴을 처리한다.
 */
export async function handleWorkerTurn(deps: LoopDependencies, runtime: LoopRuntime): Promise<LoopState> {
  emitLoopState(
    deps,
    runtime,
    LoopState.AcquireEvidence,
    `worker evidence loop step=${runtime.step} (max=${deps.routed.maxSteps})`,
  );
  if (runtime.step > deps.routed.maxSteps) {
    runtime.forcedSynthesisReason = `max step reached: step=${runtime.step}, maxSteps=${deps.routed.maxSteps}`;
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
    runtime.forcedSynthesisReason = `worker validation failed at step ${runtime.step}: ${reason}`;
    await appendSystemEntry(deps.config, deps.session, `[WORKER_VALIDATION_FAIL_${runtime.step}] ${reason}`);
    return LoopState.ForcedSynthesis;
  }

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
 */
export async function handleMainDecisionTurn(deps: LoopDependencies, runtime: LoopRuntime): Promise<LoopState> {
  emitLoopState(
    deps,
    runtime,
    LoopState.AssessSufficiency,
    `assessing evidence sufficiency (evidence=${runtime.evidence.length}) to finalize or continue`,
  );
  deps.options?.onEvent?.({ type: "main-start", phase: "assess-sufficiency", evidenceCount: runtime.evidence.length });
  const evidenceSummary = summarizeDecisionEvidence(runtime);

  let decision: MainDecision;
  try {
    decision = await askMainForDecision({
      config: deps.config,
      allowStreaming: deps.routed.stream,
      goal: deps.goal,
      evidenceSummary,
      onToken: (token) => deps.options?.onEvent?.({ type: "main-token", phase: "assess-sufficiency", token }),
      forceFinalize: false,
      mainModel: deps.routed.main,
    });
  } catch (error) {
    const reason = (error as Error).message;
    runtime.guidance = `Main decision failed at step ${runtime.step}. Continue evidence loop with safer minimal actions. ${reason}`;
    runtime.evidence.push({ kind: "main_guidance", summary: runtime.guidance });
    await appendSystemEntry(deps.config, deps.session, `[MAIN_DECISION_FAIL_${runtime.step}] ${reason}`);
    deps.options?.onEvent?.({ type: "main-decision", phase: "assess-sufficiency", decision: "continue", guidance: runtime.guidance });
    runtime.step += 1;
    return LoopState.AcquireEvidence;
  }

  deps.options?.onEvent?.({
    type: "main-decision",
    phase: "assess-sufficiency",
    decision: decision.decision,
    guidance: decision.guidance,
  });
  if (typeof decision.forced_synthesis_enable_think === "boolean") {
    runtime.forcedSynthesisEnableThink = decision.forced_synthesis_enable_think;
  }

  if (decision.decision === "continue") {
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
 * max step 초과/worker 검증 실패 시 강제 최종화 경로를 처리한다.
 */
export async function handleForceFinalizeTurn(deps: LoopDependencies, runtime: LoopRuntime): Promise<LoopState> {
  emitLoopState(
    deps,
    runtime,
    LoopState.ForcedSynthesis,
    runtime.forcedSynthesisReason?.trim() || "forced synthesis path triggered; skip more evidence and produce final answer",
  );
  deps.options?.onEvent?.({ type: "main-start", phase: "forced-synthesis", evidenceCount: runtime.evidence.length });
  const evidenceSummary = summarizeDecisionEvidence(runtime);

  try {
    const decision = await askMainForDecision({
      config: deps.config,
      allowStreaming: deps.routed.stream,
      goal: deps.goal,
      evidenceSummary,
      onToken: (token) => deps.options?.onEvent?.({ type: "main-token", phase: "forced-synthesis", token }),
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
      onToken: (token) => deps.options?.onEvent?.({ type: "main-token", phase: "forced-synthesis", token }),
      enableThinkOverride: runtime.forcedSynthesisEnableThink,
      mainModel: deps.routed.main,
    });
    deps.options?.onEvent?.({ type: "main-decision", phase: "forced-synthesis", decision: "finalize" });
    deps.options?.onEvent?.({ type: "final-answer", answer: runtime.finalAnswer });
  } catch (error) {
    const reason = (error as Error).message;
    runtime.finalAnswer = fallbackFinalAnswer(deps.goal, evidenceSummary);
    await appendSystemEntry(deps.config, deps.session, `[MAIN_FORCE_FINALIZE_FAIL] ${reason}`);
    deps.options?.onEvent?.({
      type: "main-decision",
      phase: "forced-synthesis",
      decision: "finalize",
      guidance: `fallback finalize: ${reason}`,
    });
    deps.options?.onEvent?.({ type: "final-answer", answer: runtime.finalAnswer });
  }

  return LoopState.Done;
}

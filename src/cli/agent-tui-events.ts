import type { AgentLoopEvent } from "../runtime/agent-loop.js";
import {
  ANSI_BLUE,
  ANSI_BOLD,
  ANSI_CYAN,
  ANSI_GRAY,
  ANSI_GREEN,
  ANSI_RED,
  ANSI_WHITE,
  ANSI_YELLOW,
  appendToken,
  firstNonEmptyLine,
  paint,
  pushLine,
  trimOneLine,
  viewFromFinalAnswer,
  type TuiState,
} from "./agent-tui-view.js";

/**
 * 파일 목적:
 * - agent loop 이벤트를 TUI 상태로 투영하는 리듀서 역할을 담당한다.
 *
 * 주요 의존성:
 * - agent-tui-view.ts의 상태/렌더/유틸
 *
 * 역의존성:
 * - src/cli/agent-tui.ts
 */
export type TuiRenderHint = "immediate" | "throttled";

export function onTuiEvent(
  state: TuiState,
  event: AgentLoopEvent,
): TuiRenderHint {
  let hint: TuiRenderHint = "immediate";
  if (event.type === "start") {
    state.turn += 1;
    state.toolTraceByStep = {};
    pushLine(
      state,
      paint(`=== TURN ${state.turn} START ===`, ANSI_BOLD, ANSI_CYAN),
    );
    pushLine(
      state,
      paint(
        `run start: agent=${event.agentId} mode=${event.mode} goal=${trimOneLine(event.goal, 220)}`,
        ANSI_CYAN,
      ),
    );
  } else if (event.type === "loop-state") {
    pushLine(
      state,
      paint(
        `state ${event.state}: step=${event.step} evidence=${event.evidenceCount} :: ${trimOneLine(event.summary, 220)}`,
        ANSI_BLUE,
      ),
    );
  } else if (event.type === "planning-start") {
    pushLine(
      state,
      paint(`planning start: ${trimOneLine(event.goal, 220)}`, ANSI_BLUE),
    );
  } else if (event.type === "planning-result") {
    pushLine(
      state,
      paint(
        `planning result: next=${event.next} reason=${trimOneLine(event.reason, 220)}${event.guidance ? ` guidance=${trimOneLine(event.guidance, 140)}` : ""}`,
        ANSI_CYAN,
      ),
    );
    if (event.evidenceGoals.length > 0) {
      pushLine(
        state,
        paint(
          `planning goals: ${event.evidenceGoals.map((goal) => trimOneLine(goal, 100)).join(" | ")}`,
          ANSI_CYAN,
        ),
      );
    }
  } else if (event.type === "compaction-start") {
    pushLine(
      state,
      paint(
        `context compaction start: tokens=${event.estimatedTokens}/${event.contextLimitTokens}, trigger=${event.triggerTokens}, target=${event.targetTokens}, messages=${event.messageCount}`,
        ANSI_YELLOW,
      ),
    );
  } else if (event.type === "compaction-complete") {
    pushLine(
      state,
      paint(
        `context compaction complete: tokens ${event.beforeTokens} -> ${event.afterTokens}, messages ${event.beforeMessages} -> ${event.afterMessages}`,
        ANSI_GREEN,
      ),
    );
  } else if (event.type === "worker-start") {
    pushLine(state, paint(`worker step ${event.step} started`, ANSI_BLUE));
  } else if (event.type === "worker-token") {
    state.workerView = appendToken(state.workerView, event.token);
    hint = "throttled";
  } else if (event.type === "worker-action") {
    if (event.action === "call_tool") {
      state.toolTraceByStep[event.step] = {
        ...(state.toolTraceByStep[event.step] ?? {}),
        reason: event.detail,
      };
    } else {
      pushLine(
        state,
        `worker action(${event.step}): ${event.action} :: ${event.detail}`,
      );
    }
  } else if (event.type === "tool-start") {
    state.toolTraceByStep[event.step] = {
      ...(state.toolTraceByStep[event.step] ?? {}),
      cmd: event.cmd,
    };
  } else if (event.type === "tool-result") {
    const trace = state.toolTraceByStep[event.step] ?? {};
    pushLine(
      state,
      paint(`• ${trimOneLine(trace.reason ?? "<missing reason>")}`, ANSI_WHITE),
    );
    pushLine(
      state,
      paint(`└ ${trimOneLine(trace.cmd ?? "<missing cmd>", 260)}`, ANSI_WHITE),
    );
    pushLine(
      state,
      paint(
        `  stdout: ${trimOneLine(firstNonEmptyLine(event.stdout), 240)}`,
        ANSI_GRAY,
      ),
    );
    if (event.stderr.trim()) {
      pushLine(
        state,
        paint(
          `  stderr: ${trimOneLine(firstNonEmptyLine(event.stderr), 240)}`,
          ANSI_GRAY,
        ),
      );
    }
    pushLine(
      state,
      paint(
        `  result: exit=${event.exitCode} runner=${event.runner} group=${event.workspaceGroupId}`,
        event.exitCode === 0 ? ANSI_GREEN : ANSI_RED,
      ),
    );
  } else if (event.type === "ask") {
    pushLine(
      state,
      paint(`worker ask(${event.step}): ${event.question}`, ANSI_YELLOW),
    );
  } else if (event.type === "ask-answer") {
    pushLine(
      state,
      paint(`ask answer(${event.step}): ${event.answer}`, ANSI_GREEN),
    );
  } else if (event.type === "main-start") {
    state.activeMainPhase = event.phase;
    pushLine(
      state,
      paint(
        `main[${event.phase}] started with evidence=${event.evidenceCount}`,
        ANSI_BLUE,
      ),
    );
  } else if (event.type === "main-token") {
    state.activeMainPhase = event.phase;
    state.mainViews[event.phase] = appendToken(
      state.mainViews[event.phase],
      event.token,
    );
    hint = "throttled";
  } else if (event.type === "main-decision") {
    pushLine(
      state,
      paint(
        `main decision[${event.phase}]: ${event.decision}${event.guidance ? ` :: ${trimOneLine(event.guidance, 220)}` : ""}`,
        event.decision === "finalize" ? ANSI_GREEN : ANSI_YELLOW,
      ),
    );
  } else if (event.type === "final-answer") {
    state.mainViews[state.activeMainPhase] = viewFromFinalAnswer(
      event.answer,
      state.mainViews[state.activeMainPhase],
    );
    pushLine(
      state,
      paint(
        `main final report ready[${state.activeMainPhase}] (${event.answer.length} chars)`,
        ANSI_GREEN,
      ),
    );
  } else if (event.type === "complete") {
    pushLine(
      state,
      paint(
        `run complete: steps=${event.steps}, evidence=${event.evidenceCount}`,
        ANSI_GREEN,
      ),
    );
    pushLine(
      state,
      paint(`=== TURN ${state.turn} END ===`, ANSI_BOLD, ANSI_CYAN),
    );
  }

  return hint;
}

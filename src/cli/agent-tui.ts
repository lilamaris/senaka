import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadConfig } from "../config/env.js";
import { runAgentLoop, type AgentLoopEvent } from "../runtime/agent-loop.js";
import { loadOrCreateSession } from "../runtime/session-store.js";
import type { AgentMode } from "../types/model.js";

interface StreamView {
  raw: string;
  think: string;
  final: string;
  phase: "idle" | "thinking" | "final";
}

interface TuiState {
  sessionId: string;
  agentId: string;
  groupId?: string;
  modeOverride?: AgentMode;
  maxStepsOverride?: number;
  streamOverride?: boolean;
  busy: boolean;
  turn: number;
  lines: string[];
  workerView: StreamView;
  mainView: StreamView;
  toolTraceByStep: Record<number, { reason?: string; cmd?: string }>;
}

const ANSI_GRAY = "\x1b[90m";
const ANSI_CYAN = "\x1b[36m";
const ANSI_BLUE = "\x1b[34m";
const ANSI_GREEN = "\x1b[32m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_RED = "\x1b[31m";
const ANSI_BOLD = "\x1b[1m";
const ANSI_BG_USER = "\x1b[48;5;24m";
const ANSI_WHITE = "\x1b[97m";
const ANSI_RESET = "\x1b[0m";

function now(): string {
  return new Date().toISOString().slice(11, 19);
}

function createView(): StreamView {
  return { raw: "", think: "", final: "", phase: "idle" };
}

function viewFromFinalAnswer(answer: string): StreamView {
  const clean = answer.trim();
  if (!clean) {
    return createView();
  }
  return { raw: clean, think: "", final: clean, phase: "final" };
}

function parseThinkBlocks(raw: string): StreamView {
  const startTag = "<think>";
  const endTag = "</think>";
  const start = raw.indexOf(startTag);

  if (start < 0) {
    return { raw, think: "", final: raw, phase: raw.trim() ? "final" : "idle" };
  }

  const end = raw.indexOf(endTag, start + startTag.length);
  if (end < 0) {
    return { raw, think: raw.slice(start + startTag.length), final: "", phase: "thinking" };
  }

  return {
    raw,
    think: raw.slice(start + startTag.length, end),
    final: raw.slice(end + endTag.length),
    phase: "final",
  };
}

function appendToken(view: StreamView, token: string): StreamView {
  return parseThinkBlocks(view.raw + token);
}

function wrapLine(text: string, width: number): string[] {
  if (width <= 8) {
    return [text];
  }
  const out: string[] = [];
  let remain = text;
  while (remain.length > width) {
    out.push(remain.slice(0, width));
    remain = remain.slice(width);
  }
  out.push(remain);
  return out;
}

function wrapParagraphs(text: string, width: number): string[] {
  const out: string[] = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (!line) {
      out.push("");
      continue;
    }
    out.push(...wrapLine(line, width));
  }
  return out;
}

function paint(text: string, ...styles: string[]): string {
  return `${styles.join("")}${text}${ANSI_RESET}`;
}

function paintFullWidthLine(text: string, width: number, ...styles: string[]): string {
  const target = Math.max(1, width);
  const sliced = text.length > target ? text.slice(0, target) : text;
  return paint(sliced.padEnd(target, " "), ...styles);
}

function trimOneLine(text: string, maxLen = 180): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= maxLen) {
    return one || "<empty>";
  }
  return `${one.slice(0, maxLen)}...`;
}

function firstNonEmptyLine(text: string): string {
  const line = text
    .split("\n")
    .map((value) => value.trim())
    .find((value) => value.length > 0);
  return line ?? "<empty>";
}

function pushRawLine(state: TuiState, text: string): void {
  state.lines.push(text);
  if (state.lines.length > 350) {
    state.lines = state.lines.slice(-350);
  }
}

function pushLine(state: TuiState, text: string): void {
  pushRawLine(state, `[${now()}] ${text}`);
}

function pushSpacer(state: TuiState): void {
  pushRawLine(state, "");
}

function separator(char: string, width: number): string {
  return char.repeat(Math.max(40, width));
}

function renderStreamSection(title: string, view: StreamView, width: number, grayThink = false): string[] {
  const out: string[] = [paint(`[${title}]`, ANSI_BOLD, ANSI_CYAN)];
  const bodyWidth = Math.max(40, width - 4);

  if (!view.raw.trim()) {
    out.push("(no output yet)");
    return out;
  }

  if (view.think.trim().length > 0 || view.raw.includes("<think>")) {
    out.push("THINK PHASE:");
    const thinkLines = wrapParagraphs(view.think || "(thinking...)", bodyWidth);
    out.push(...(grayThink ? thinkLines.map((line) => `${ANSI_GRAY}${line}${ANSI_RESET}`) : thinkLines));
    out.push("");
    out.push("FINAL RESPONSE:");
    out.push(...wrapParagraphs(view.final || "(waiting final response)", bodyWidth));
    return out;
  }

  out.push("RESPONSE:");
  out.push(...wrapParagraphs(view.final || view.raw, bodyWidth));
  return out;
}

function render(state: TuiState): void {
  const width = output.columns || 100;
  const topSep = separator("=", width);
  const midSep = separator("-", width);

  output.write("\x1b[2J\x1b[H");
  output.write(paint("Senaka Agent TUI", ANSI_BOLD, ANSI_CYAN) + "\n");
  output.write(
    paint(
      `session=${state.sessionId} group=${state.groupId ?? state.sessionId} agent=${state.agentId} modeOverride=${state.modeOverride ?? "<agent>"} maxStepsOverride=${state.maxStepsOverride ?? "<agent>"} streamOverride=${state.streamOverride === undefined ? "<agent>" : state.streamOverride} busy=${state.busy} turn=${state.turn}`,
      ANSI_BLUE,
    ) + "\n",
  );
  output.write(paint(topSep, ANSI_BLUE) + "\n");

  for (const line of state.lines.slice(-80)) {
    output.write(line + "\n");
  }

  output.write(paint(midSep, ANSI_BLUE) + "\n");
  for (const line of renderStreamSection("WORKER STREAM", state.workerView, width)) {
    output.write(line + "\n");
  }

  output.write(paint(midSep, ANSI_BLUE) + "\n");
  for (const line of renderStreamSection("MAIN STREAM", state.mainView, width, true)) {
    output.write(line + "\n");
  }

  output.write(paint(topSep, ANSI_BLUE) + "\n");
  output.write(
    "Commands: /agent ID, /group ID, /mode main-worker|single-main|auto, /steps N|auto, /stream on|off|auto, /session ID, /clear, /exit\n",
  );
  output.write("Type any goal and press Enter to run a turn.\n\n");
}

function onEvent(state: TuiState, event: AgentLoopEvent): void {
  if (event.type === "start") {
    state.turn += 1;
    state.toolTraceByStep = {};
    pushLine(state, paint(`=== TURN ${state.turn} START ===`, ANSI_BOLD, ANSI_CYAN));
    pushLine(
      state,
      paint(`run start: agent=${event.agentId} mode=${event.mode} goal=${trimOneLine(event.goal, 220)}`, ANSI_CYAN),
    );
  } else if (event.type === "planning-start") {
    pushLine(state, paint(`planning start: ${trimOneLine(event.goal, 220)}`, ANSI_BLUE));
  } else if (event.type === "planning-result") {
    pushLine(
      state,
      paint(
        `planning result: next=${event.next} reason=${trimOneLine(event.reason, 220)}${event.guidance ? ` guidance=${trimOneLine(event.guidance, 140)}` : ""}`,
        ANSI_CYAN,
      ),
    );
    if (event.evidenceGoals.length > 0) {
      pushLine(state, paint(`planning goals: ${event.evidenceGoals.map((goal) => trimOneLine(goal, 100)).join(" | ")}`, ANSI_CYAN));
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
  } else if (event.type === "worker-action") {
    if (event.action === "call_tool") {
      state.toolTraceByStep[event.step] = { ...(state.toolTraceByStep[event.step] ?? {}), reason: event.detail };
    } else {
      pushLine(state, `worker action(${event.step}): ${event.action} :: ${event.detail}`);
    }
  } else if (event.type === "tool-start") {
    state.toolTraceByStep[event.step] = { ...(state.toolTraceByStep[event.step] ?? {}), cmd: event.cmd };
  } else if (event.type === "tool-result") {
    const trace = state.toolTraceByStep[event.step] ?? {};
    pushLine(state, paint(`Evidence Loop step ${event.step}`, ANSI_BOLD, ANSI_YELLOW));
    pushLine(state, paint(`  reason: ${trimOneLine(trace.reason ?? "<missing reason>")}`, ANSI_YELLOW));
    pushLine(state, paint(`  cmd   : ${trimOneLine(trace.cmd ?? "<missing cmd>", 260)}`, ANSI_WHITE));
    pushLine(
      state,
      paint(
        `  result: exit=${event.exitCode} runner=${event.runner} group=${event.workspaceGroupId}`,
        event.exitCode === 0 ? ANSI_GREEN : ANSI_RED,
      ),
    );
    pushLine(state, `  stdout: ${trimOneLine(firstNonEmptyLine(event.stdout), 240)}`);
    if (event.stderr.trim()) {
      pushLine(state, paint(`  stderr: ${trimOneLine(firstNonEmptyLine(event.stderr), 240)}`, ANSI_RED));
    }
  } else if (event.type === "ask") {
    pushLine(state, paint(`worker ask(${event.step}): ${event.question}`, ANSI_YELLOW));
  } else if (event.type === "ask-answer") {
    pushLine(state, paint(`ask answer(${event.step}): ${event.answer}`, ANSI_GREEN));
  } else if (event.type === "main-start") {
    pushLine(state, paint(`main synthesis started with evidence=${event.evidenceCount}`, ANSI_BLUE));
  } else if (event.type === "main-token") {
    state.mainView = appendToken(state.mainView, event.token);
  } else if (event.type === "main-decision") {
    pushLine(
      state,
      paint(
        `main decision: ${event.decision}${event.guidance ? ` :: ${trimOneLine(event.guidance, 220)}` : ""}`,
        event.decision === "finalize" ? ANSI_GREEN : ANSI_YELLOW,
      ),
    );
  } else if (event.type === "final-answer") {
    state.mainView = viewFromFinalAnswer(event.answer);
    pushLine(state, paint(`main final report ready (${event.answer.length} chars)`, ANSI_GREEN));
  } else if (event.type === "complete") {
    pushLine(state, paint(`run complete: steps=${event.steps}, evidence=${event.evidenceCount}`, ANSI_GREEN));
    pushLine(state, paint(`=== TURN ${state.turn} END ===`, ANSI_BOLD, ANSI_CYAN));
  }

  render(state);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const state: TuiState = {
    sessionId: "default",
    agentId: "default",
    groupId: undefined,
    modeOverride: undefined,
    maxStepsOverride: undefined,
    streamOverride: undefined,
    busy: false,
    turn: 0,
    lines: [],
    workerView: createView(),
    mainView: createView(),
    toolTraceByStep: {},
  };

  const rl = readline.createInterface({ input, output });

  pushLine(state, "TUI ready");
  pushLine(state, `model config: ${config.modelProfilesPath}`);

  while (true) {
    render(state);
    const line = (await rl.question("goal> ")).trim();

    if (!line) {
      continue;
    }

    if (line === "/exit") {
      break;
    }

    if (line === "/clear") {
      state.lines = [];
      state.workerView = createView();
      state.mainView = createView();
      continue;
    }

    if (line.startsWith("/agent ")) {
      const value = line.slice(7).trim();
      if (value) {
        state.agentId = value;
        pushLine(state, `agent set to ${state.agentId}`);
      }
      continue;
    }

    if (line.startsWith("/group ")) {
      const value = line.slice(7).trim();
      if (value) {
        state.groupId = value;
        pushLine(state, `group set to ${state.groupId}`);
      }
      continue;
    }

    if (line.startsWith("/mode ")) {
      const value = line.slice(6).trim();
      if (value === "auto") {
        state.modeOverride = undefined;
        pushLine(state, "mode override cleared");
      } else {
        state.modeOverride = value === "single-main" ? "single-main" : "main-worker";
        pushLine(state, `mode override set to ${state.modeOverride}`);
      }
      continue;
    }

    if (line.startsWith("/steps ")) {
      const valueRaw = line.slice(7).trim();
      if (valueRaw === "auto") {
        state.maxStepsOverride = undefined;
        pushLine(state, "maxSteps override cleared");
      } else {
        const value = Number(valueRaw);
        if (Number.isFinite(value) && value > 0) {
          state.maxStepsOverride = Math.floor(value);
          pushLine(state, `maxSteps override set to ${state.maxStepsOverride}`);
        } else {
          pushLine(state, "invalid steps value");
        }
      }
      continue;
    }

    if (line.startsWith("/stream ")) {
      const value = line.slice(8).trim();
      if (value === "auto") {
        state.streamOverride = undefined;
        pushLine(state, "stream override cleared");
      } else if (value === "on") {
        state.streamOverride = true;
        pushLine(state, "stream override set to true");
      } else if (value === "off") {
        state.streamOverride = false;
        pushLine(state, "stream override set to false");
      } else {
        pushLine(state, "invalid stream value (on|off|auto)");
      }
      continue;
    }

    if (line.startsWith("/session ")) {
      const value = line.slice(9).trim();
      if (value) {
        state.sessionId = value;
        pushLine(state, `session set to ${state.sessionId}`);
      }
      continue;
    }

    state.busy = true;
    state.workerView = createView();
    state.mainView = createView();
    const fullWidth = Math.max(40, output.columns || 100);
    const contentWidth = Math.max(20, fullWidth - 2);
    pushSpacer(state);
    pushRawLine(state, paintFullWidthLine("", fullWidth, ANSI_BG_USER));
    pushRawLine(state, paintFullWidthLine(" USER GOAL ", fullWidth, ANSI_BG_USER, ANSI_WHITE, ANSI_BOLD));
    for (const wrapped of wrapParagraphs(line, contentWidth)) {
      pushRawLine(state, paintFullWidthLine(` ${wrapped}`, fullWidth, ANSI_BG_USER, ANSI_WHITE));
    }
    pushRawLine(state, paintFullWidthLine("", fullWidth, ANSI_BG_USER));
    pushSpacer(state);
    render(state);

    try {
      const session = await loadOrCreateSession(config.sessionDir, state.sessionId, config.systemPrompt);
      const result = await runAgentLoop(config, session, line, state.agentId, {
        mode: state.modeOverride,
        maxSteps: state.maxStepsOverride,
        stream: state.streamOverride,
        workspaceGroupId: state.groupId,
        onEvent: (event) => onEvent(state, event),
        askUser: async (question) => {
          pushLine(state, `ASK REQUIRED: ${question}`);
          render(state);
          const answer = (await rl.question("ask(YES/NO)> ")).trim();
          return answer;
        },
      });

      pushLine(state, `resolved mode: ${result.mode}, maxSteps: ${result.maxSteps}, stream: ${result.stream}`);
      pushLine(state, `worker model: ${result.workerModel}`);
      pushLine(state, `main model: ${result.mainModel}`);
      pushLine(state, `final: ${result.summary.replace(/\s+/g, " ").slice(0, 280)}`);
    } catch (error) {
      pushLine(state, `error: ${(error as Error).message}`);
    } finally {
      state.busy = false;
    }
  }

  rl.close();
}

main().catch((error) => {
  process.stderr.write(`fatal> ${(error as Error).message}\n`);
  process.exit(1);
});

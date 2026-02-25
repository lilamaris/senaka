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
}

const ANSI_GRAY = "\x1b[90m";
const ANSI_RESET = "\x1b[0m";

function now(): string {
  return new Date().toISOString().slice(11, 19);
}

function createView(): StreamView {
  return { raw: "", think: "", final: "", phase: "idle" };
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

function pushLine(state: TuiState, text: string): void {
  state.lines.push(`[${now()}] ${text}`);
  if (state.lines.length > 350) {
    state.lines = state.lines.slice(-350);
  }
}

function separator(char: string, width: number): string {
  return char.repeat(Math.max(40, width));
}

function renderStreamSection(title: string, view: StreamView, width: number, grayThink = false): string[] {
  const out: string[] = [`[${title}]`];
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
  output.write("Senaka Agent TUI\n");
  output.write(
    `session=${state.sessionId} group=${state.groupId ?? state.sessionId} agent=${state.agentId} modeOverride=${state.modeOverride ?? "<agent>"} maxStepsOverride=${state.maxStepsOverride ?? "<agent>"} streamOverride=${state.streamOverride === undefined ? "<agent>" : state.streamOverride} busy=${state.busy} turn=${state.turn}\n`,
  );
  output.write(topSep + "\n");

  for (const line of state.lines.slice(-80)) {
    output.write(line + "\n");
  }

  output.write(midSep + "\n");
  for (const line of renderStreamSection("WORKER STREAM", state.workerView, width)) {
    output.write(line + "\n");
  }

  output.write(midSep + "\n");
  for (const line of renderStreamSection("MAIN STREAM", state.mainView, width, true)) {
    output.write(line + "\n");
  }

  output.write(topSep + "\n");
  output.write(
    "Commands: /agent ID, /group ID, /mode main-worker|single-main|auto, /steps N|auto, /stream on|off|auto, /session ID, /clear, /exit\n",
  );
  output.write("Type any goal and press Enter to run a turn.\n\n");
}

function onEvent(state: TuiState, event: AgentLoopEvent): void {
  if (event.type === "start") {
    state.turn += 1;
    pushLine(state, `================ TURN ${state.turn} START ================`);
    pushLine(state, `run start: agent=${event.agentId} mode=${event.mode} goal=${event.goal}`);
  } else if (event.type === "worker-start") {
    pushLine(state, `worker step ${event.step} started`);
  } else if (event.type === "worker-token") {
    state.workerView = appendToken(state.workerView, event.token);
  } else if (event.type === "worker-action") {
    pushLine(state, `worker action(${event.step}): ${event.action} :: ${event.detail}`);
  } else if (event.type === "tool-start") {
    pushLine(state, `tool start(${event.step}): ${event.cmd}`);
  } else if (event.type === "tool-result") {
    pushLine(
      state,
      `tool result(${event.step}): exit=${event.exitCode}, runner=${event.runner}, group=${event.workspaceGroupId}`,
    );
    if (event.stdout.trim()) {
      pushLine(state, `tool stdout(${event.step}): ${event.stdout.split("\n")[0]}`);
    }
    if (event.stderr.trim()) {
      pushLine(state, `tool stderr(${event.step}): ${event.stderr.split("\n")[0]}`);
    }
  } else if (event.type === "ask") {
    pushLine(state, `worker ask(${event.step}): ${event.question}`);
  } else if (event.type === "ask-answer") {
    pushLine(state, `ask answer(${event.step}): ${event.answer}`);
  } else if (event.type === "main-start") {
    pushLine(state, `main synthesis started with evidence=${event.evidenceCount}`);
  } else if (event.type === "main-token") {
    state.mainView = appendToken(state.mainView, event.token);
  } else if (event.type === "main-decision") {
    pushLine(state, `main decision: ${event.decision}${event.guidance ? ` :: ${event.guidance}` : ""}`);
  } else if (event.type === "complete") {
    pushLine(state, `run complete: steps=${event.steps}, evidence=${event.evidenceCount}`);
    pushLine(state, `================= TURN ${state.turn} END =================`);
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

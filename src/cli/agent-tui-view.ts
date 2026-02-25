import { stdout as output } from "node:process";
import type { AgentLoopEvent } from "../runtime/agent-loop.js";
import type { AgentMode } from "../types/model.js";

/**
 * 파일 목적:
 * - agent TUI의 상태 타입, 렌더링, 텍스트 유틸을 모아 제공한다.
 *
 * 주요 의존성:
 * - runtime/agent-loop 이벤트 타입
 *
 * 역의존성:
 * - src/cli/agent-tui.ts, src/cli/agent-tui-events.ts
 */
export interface StreamView {
  raw: string;
  think: string;
  final: string;
  phase: "idle" | "thinking" | "final";
}

export type MainPhase = Extract<
  AgentLoopEvent,
  { type: "main-token" }
>["phase"];

export interface TuiState {
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
  mainViews: Record<MainPhase, StreamView>;
  activeMainPhase: MainPhase;
  toolTraceByStep: Record<number, { reason?: string; cmd?: string }>;
}

export const ANSI_GRAY = "\x1b[90m";
export const ANSI_CYAN = "\x1b[36m";
export const ANSI_BLUE = "\x1b[34m";
export const ANSI_GREEN = "\x1b[32m";
export const ANSI_YELLOW = "\x1b[33m";
export const ANSI_RED = "\x1b[31m";
export const ANSI_BOLD = "\x1b[1m";
export const ANSI_BG_USER = "\x1b[48;5;24m";
export const ANSI_WHITE = "\x1b[97m";
export const ANSI_RESET = "\x1b[0m";

const MAIN_PHASE_ORDER: MainPhase[] = [
  "planning",
  "assess-sufficiency",
  "forced-synthesis",
  "final-report",
];
const MAIN_PHASE_LABEL: Record<MainPhase, string> = {
  planning: "MAIN STREAM / PLAN INTENT",
  "assess-sufficiency": "MAIN STREAM / ASSESS SUFFICIENCY",
  "forced-synthesis": "MAIN STREAM / FORCED SYNTHESIS",
  "final-report": "MAIN STREAM / FINAL REPORT",
};
const THINK_FOLD_LINES_DEFAULT = 44;
const THINK_FOLD_LINES_FORCED = 20;
const rendererState: {
  initialized: boolean;
  lastFrame: string[];
} = {
  initialized: false,
  lastFrame: [],
};

function now(): string {
  return new Date().toISOString().slice(11, 19);
}

export function createView(): StreamView {
  return { raw: "", think: "", final: "", phase: "idle" };
}

export function createMainViews(): Record<MainPhase, StreamView> {
  return {
    planning: createView(),
    "assess-sufficiency": createView(),
    "forced-synthesis": createView(),
    "final-report": createView(),
  };
}

export function createInitialState(): TuiState {
  return {
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
    mainViews: createMainViews(),
    activeMainPhase: "planning",
    toolTraceByStep: {},
  };
}

export function viewFromFinalAnswer(
  answer: string,
  previous?: StreamView,
): StreamView {
  const clean = answer.trim();
  if (!clean) {
    return previous ?? createView();
  }
  const parsed = parseThinkBlocks(clean);
  if (parsed.think.trim().length > 0 || clean.includes("<think>")) {
    return parsed;
  }

  const previousHasThink = Boolean(
    previous &&
      (previous.think.trim().length > 0 || previous.raw.includes("<think>")),
  );
  if (previousHasThink) {
    const think = previous?.think ?? "";
    return {
      raw: `<think>${think}</think>${clean}`,
      think,
      final: clean,
      phase: "final",
    };
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
    return {
      raw,
      think: raw.slice(start + startTag.length),
      final: "",
      phase: "thinking",
    };
  }

  return {
    raw,
    think: raw.slice(start + startTag.length, end),
    final: raw.slice(end + endTag.length),
    phase: "final",
  };
}

export function appendToken(view: StreamView, token: string): StreamView {
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

export function wrapParagraphs(text: string, width: number): string[] {
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

export function paint(text: string, ...styles: string[]): string {
  return `${styles.join("")}${text}${ANSI_RESET}`;
}

export function paintFullWidthLine(
  text: string,
  width: number,
  ...styles: string[]
): string {
  const target = Math.max(1, width);
  const sliced = text.length > target ? text.slice(0, target) : text;
  return paint(sliced.padEnd(target, " "), ...styles);
}

export function trimOneLine(text: string, maxLen = 180): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= maxLen) {
    return one || "<empty>";
  }
  return `${one.slice(0, maxLen)}...`;
}

export function firstNonEmptyLine(text: string): string {
  const line = text
    .split("\n")
    .map((value) => value.trim())
    .find((value) => value.length > 0);
  return line ?? "<empty>";
}

export function pushRawLine(state: TuiState, text: string): void {
  state.lines.push(text);
  if (state.lines.length > 350) {
    state.lines = state.lines.slice(-350);
  }
}

export function pushLine(state: TuiState, text: string): void {
  pushRawLine(state, `${text}`);
}

export function pushSpacer(state: TuiState): void {
  pushRawLine(state, "");
}

function separator(char: string, width: number): string {
  return char.repeat(Math.max(40, width));
}

function foldMiddleLines(lines: string[], maxLines: number): string[] {
  if (lines.length <= maxLines || maxLines < 7) {
    return lines;
  }
  const head = Math.max(3, Math.floor(maxLines * 0.25));
  const tail = Math.max(3, maxLines - head - 1);
  const hidden = lines.length - head - tail;
  return [
    ...lines.slice(0, head),
    `... (${hidden} lines folded) ...`,
    ...lines.slice(-tail),
  ];
}

function renderStreamSection(
  title: string,
  view: StreamView,
  width: number,
  options?: {
    grayThink?: boolean;
    thinkLineLimit?: number;
  },
): string[] {
  const out: string[] = [paint(`[${title}]`, ANSI_BOLD, ANSI_CYAN)];
  const bodyWidth = Math.max(40, width - 4);

  if (!view.raw.trim()) {
    out.push("(no output yet)");
    return out;
  }

  if (view.think.trim().length > 0 || view.raw.includes("<think>")) {
    out.push("THINK PHASE:");
    const thinkLines = wrapParagraphs(view.think || "(thinking...)", bodyWidth);
    const foldedThinkLines =
      typeof options?.thinkLineLimit === "number"
        ? foldMiddleLines(thinkLines, options.thinkLineLimit)
        : thinkLines;
    out.push(
      ...(options?.grayThink
        ? foldedThinkLines.map((line) => `${ANSI_GRAY}${line}${ANSI_RESET}`)
        : foldedThinkLines),
    );
    out.push("");
    out.push("FINAL RESPONSE:");
    out.push(
      ...wrapParagraphs(view.final || "(waiting final response)", bodyWidth),
    );
    return out;
  }

  out.push("RESPONSE:");
  out.push(...wrapParagraphs(view.final || view.raw, bodyWidth));
  return out;
}

function hasRenderableStream(view: StreamView): boolean {
  return (
    view.raw.trim().length > 0 ||
    view.final.trim().length > 0 ||
    view.think.trim().length > 0
  );
}

function renderMainSections(state: TuiState, width: number): string[] {
  const out: string[] = [];
  const visiblePhases = MAIN_PHASE_ORDER.filter(
    (phase) =>
      phase === state.activeMainPhase ||
      hasRenderableStream(state.mainViews[phase]),
  );

  if (visiblePhases.length === 0) {
    return renderStreamSection("MAIN STREAM", createView(), width, {
      grayThink: true,
      thinkLineLimit: THINK_FOLD_LINES_DEFAULT,
    });
  }

  for (const [index, phase] of visiblePhases.entries()) {
    if (index > 0) {
      out.push(paint(separator("─", Math.max(40, width - 4)), ANSI_GRAY));
    }
    out.push(
      ...renderStreamSection(
        MAIN_PHASE_LABEL[phase],
        state.mainViews[phase],
        width,
        {
          grayThink: true,
          thinkLineLimit:
            phase === "forced-synthesis"
              ? THINK_FOLD_LINES_FORCED
              : THINK_FOLD_LINES_DEFAULT,
        },
      ),
    );
  }

  return out;
}

export function render(state: TuiState): void {
  const lines = buildFrameLines(state);
  const prev = rendererState.lastFrame;
  const maxLines = Math.max(prev.length, lines.length);

  if (!rendererState.initialized) {
    output.write("\x1b[?25l\x1b[2J");
    rendererState.initialized = true;
  }

  for (let idx = 0; idx < maxLines; idx += 1) {
    const next = lines[idx] ?? "";
    const prevLine = prev[idx] ?? "";
    if (next === prevLine) {
      continue;
    }
    output.write(`\x1b[${idx + 1};1H\x1b[2K${next}`);
  }

  rendererState.lastFrame = lines;
  output.write(`\x1b[${lines.length + 1};1H`);
}

export function teardownRender(): void {
  if (!rendererState.initialized) {
    return;
  }
  const row = rendererState.lastFrame.length + 2;
  output.write(`\x1b[${row};1H\x1b[?25h`);
  rendererState.initialized = false;
  rendererState.lastFrame = [];
}

function buildFrameLines(state: TuiState): string[] {
  const width = output.columns || 100;
  const topSep = separator("─", width);
  const midSep = separator("─", width);
  const out: string[] = [];

  out.push(paint("Senaka Agent TUI", ANSI_BOLD, ANSI_CYAN));
  out.push(
    paint(
      `session=${state.sessionId} group=${state.groupId ?? state.sessionId} agent=${state.agentId} modeOverride=${state.modeOverride ?? "<agent>"} maxStepsOverride=${state.maxStepsOverride ?? "<agent>"} streamOverride=${state.streamOverride === undefined ? "<agent>" : state.streamOverride} busy=${state.busy} turn=${state.turn}`,
      ANSI_BLUE,
    ),
  );
  out.push(paint(topSep, ANSI_BLUE));

  for (const line of state.lines.slice(-80)) {
    out.push(line);
  }

  out.push(paint(midSep, ANSI_BLUE));
  for (const line of renderStreamSection(
    "WORKER STREAM",
    state.workerView,
    width,
  )) {
    out.push(line);
  }

  out.push(paint(midSep, ANSI_BLUE));
  for (const line of renderMainSections(state, width)) {
    out.push(line);
  }

  out.push(paint(topSep, ANSI_BLUE));
  out.push(
    "Commands: /agent ID, /group ID, /mode main-worker|single-main|auto, /steps N|auto, /stream on|off|auto, /session ID, /clear, /exit",
  );
  out.push("Type any goal and press Enter to run a turn.");
  out.push("");
  return out;
}

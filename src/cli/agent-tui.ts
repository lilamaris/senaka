import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadConfig } from "../config/env.js";
import { runAgentLoop, type AgentLoopEvent } from "../runtime/agent-loop.js";
import { loadOrCreateSession } from "../runtime/session-store.js";
import type { AgentMode } from "../types/model.js";

/**
 * 파일 목적:
 * - agent loop를 선형 로그 스트림 형태로 실행하는 TUI 엔트리포인트.
 *
 * 주요 의존성:
 * - runtime/agent-loop: 상태 머신 실행
 * - runtime/session-store: 세션 로드/저장
 *
 * 역의존성:
 * - package.json `npm run agent:tui`
 *
 * 모듈 흐름:
 * 1) 사용자 입력(goal/명령) 수신
 * 2) 이벤트를 상태머신 순서대로 위→아래로 누적 출력
 * 3) worker raw JSON 토큰은 숨기고 구조화 로그만 노출
 */
interface TuiState {
  sessionId: string;
  agentId: string;
  groupId?: string;
  modeOverride?: AgentMode;
  maxStepsOverride?: number;
  streamOverride?: boolean;
  turn: number;
  toolTraceByStep: Record<number, { reason?: string; cmd?: string }>;
}

interface MainStreamState {
  active: boolean;
  phase?: string;
  seenTokens: boolean;
}

const ANSI_GRAY = "\x1b[90m";
const ANSI_CYAN = "\x1b[36m";
const ANSI_BLUE = "\x1b[34m";
const ANSI_GREEN = "\x1b[32m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_RED = "\x1b[31m";
const ANSI_BOLD = "\x1b[1m";
const ANSI_RESET = "\x1b[0m";

function now(): string {
  return new Date().toISOString().slice(11, 19);
}

function paint(text: string, ...styles: string[]): string {
  return `${styles.join("")}${text}${ANSI_RESET}`;
}

function logLine(text: string): void {
  output.write(`[${now()}] ${text}\n`);
}

function trimOneLine(text: string, maxLen = 220): string {
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

function flushMainStream(stream: MainStreamState): void {
  if (stream.active) {
    output.write("\n");
    stream.active = false;
    stream.phase = undefined;
  }
}

function handleLoopEvent(state: TuiState, stream: MainStreamState, event: AgentLoopEvent): void {
  if (event.type === "start") {
    stream.seenTokens = false;
    state.turn += 1;
    state.toolTraceByStep = {};
    logLine(paint(`──────── TURN ${state.turn} START ────────`, ANSI_BOLD, ANSI_CYAN));
    logLine(paint(`run start: agent=${event.agentId} mode=${event.mode} goal=${trimOneLine(event.goal, 260)}`, ANSI_CYAN));
    return;
  }

  if (event.type === "loop-state") {
    flushMainStream(stream);
    logLine(paint(`state ${event.state}: step=${event.step} evidence=${event.evidenceCount}`, ANSI_BLUE));
    logLine(paint(`  summary: ${trimOneLine(event.summary, 260)}`, ANSI_GRAY));
    return;
  }

  if (event.type === "planning-start") {
    flushMainStream(stream);
    logLine(paint(`planning start: ${trimOneLine(event.goal, 260)}`, ANSI_BLUE));
    return;
  }

  if (event.type === "planning-result") {
    flushMainStream(stream);
    logLine(
      paint(
        `planning result: next=${event.next} reason=${trimOneLine(event.reason, 220)}${event.guidance ? ` guidance=${trimOneLine(event.guidance, 120)}` : ""}`,
        ANSI_CYAN,
      ),
    );
    if (event.evidenceGoals.length > 0) {
      logLine(paint(`planning goals: ${event.evidenceGoals.map((goal) => trimOneLine(goal, 90)).join(" | ")}`, ANSI_CYAN));
    }
    return;
  }

  if (event.type === "compaction-start") {
    flushMainStream(stream);
    logLine(
      paint(
        `context compaction start: tokens=${event.estimatedTokens}/${event.contextLimitTokens}, trigger=${event.triggerTokens}, target=${event.targetTokens}, messages=${event.messageCount}`,
        ANSI_YELLOW,
      ),
    );
    return;
  }

  if (event.type === "compaction-complete") {
    flushMainStream(stream);
    logLine(
      paint(
        `context compaction complete: tokens ${event.beforeTokens} -> ${event.afterTokens}, messages ${event.beforeMessages} -> ${event.afterMessages}`,
        ANSI_GREEN,
      ),
    );
    return;
  }

  if (event.type === "worker-start") {
    flushMainStream(stream);
    logLine(paint(`worker step ${event.step} started`, ANSI_BLUE));
    return;
  }

  // worker model raw JSON 토큰 스트림은 출력하지 않는다.
  if (event.type === "worker-token") {
    return;
  }

  if (event.type === "worker-action") {
    flushMainStream(stream);
    if (event.action === "call_tool") {
      state.toolTraceByStep[event.step] = { ...(state.toolTraceByStep[event.step] ?? {}), reason: event.detail };
    } else {
      logLine(`worker action(${event.step}): ${event.action} :: ${trimOneLine(event.detail, 260)}`);
    }
    return;
  }

  if (event.type === "tool-start") {
    state.toolTraceByStep[event.step] = { ...(state.toolTraceByStep[event.step] ?? {}), cmd: event.cmd };
    return;
  }

  if (event.type === "tool-result") {
    flushMainStream(stream);
    const trace = state.toolTraceByStep[event.step] ?? {};
    logLine(paint(`Evidence Loop step ${event.step}`, ANSI_BOLD, ANSI_YELLOW));
    logLine(paint(`  reason: ${trimOneLine(trace.reason ?? "<missing reason>", 260)}`, ANSI_YELLOW));
    logLine(`  cmd   : ${trimOneLine(trace.cmd ?? "<missing cmd>", 320)}`);
    logLine(
      paint(
        `  result: exit=${event.exitCode} runner=${event.runner} group=${event.workspaceGroupId}`,
        event.exitCode === 0 ? ANSI_GREEN : ANSI_RED,
      ),
    );
    logLine(`  stdout: ${trimOneLine(firstNonEmptyLine(event.stdout), 300)}`);
    if (event.stderr.trim()) {
      logLine(paint(`  stderr: ${trimOneLine(firstNonEmptyLine(event.stderr), 300)}`, ANSI_RED));
    }
    return;
  }

  if (event.type === "ask") {
    flushMainStream(stream);
    logLine(paint(`worker ask(${event.step}): ${event.question}`, ANSI_YELLOW));
    return;
  }

  if (event.type === "ask-answer") {
    flushMainStream(stream);
    logLine(paint(`ask answer(${event.step}): ${event.answer}`, ANSI_GREEN));
    return;
  }

  if (event.type === "main-start") {
    flushMainStream(stream);
    logLine(paint(`main[${event.phase}] started with evidence=${event.evidenceCount}`, ANSI_BLUE));
    return;
  }

  if (event.type === "main-token") {
    if (!stream.active || stream.phase !== event.phase) {
      flushMainStream(stream);
      output.write(`[${now()}] main(${event.phase})> `);
      stream.active = true;
      stream.phase = event.phase;
    }
    stream.seenTokens = true;
    output.write(event.token);
    return;
  }

  if (event.type === "main-decision") {
    flushMainStream(stream);
    logLine(
      paint(
        `main decision[${event.phase}]: ${event.decision}${event.guidance ? ` :: ${trimOneLine(event.guidance, 240)}` : ""}`,
        event.decision === "finalize" ? ANSI_GREEN : ANSI_YELLOW,
      ),
    );
    return;
  }

  if (event.type === "final-answer") {
    flushMainStream(stream);
    if (!stream.seenTokens) {
      logLine(paint("final answer:", ANSI_BOLD, ANSI_GREEN));
      output.write(event.answer.trim() + "\n");
    } else {
      logLine(paint(`main final report ready (${event.answer.length} chars)`, ANSI_GREEN));
    }
    return;
  }

  if (event.type === "complete") {
    flushMainStream(stream);
    logLine(paint(`run complete: steps=${event.steps}, evidence=${event.evidenceCount}`, ANSI_GREEN));
    logLine(paint(`──────── TURN ${state.turn} END ────────`, ANSI_BOLD, ANSI_CYAN));
  }
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
    turn: 0,
    toolTraceByStep: {},
  };

  const rl = readline.createInterface({ input, output });
  const mainStream: MainStreamState = { active: false, phase: undefined, seenTokens: false };

  output.write(paint("Senaka Agent TUI (Linear Flow)", ANSI_BOLD, ANSI_CYAN) + "\n");
  output.write(
    "Commands: /agent ID, /group ID, /mode main-worker|single-main|auto, /steps N|auto, /stream on|off|auto, /session ID, /clear, /exit\n\n",
  );
  logLine(`model config: ${config.modelProfilesPath}`);

  while (true) {
    const line = (await rl.question("goal> ")).trim();
    if (!line) {
      continue;
    }

    if (line === "/exit") {
      flushMainStream(mainStream);
      break;
    }

    if (line === "/clear") {
      flushMainStream(mainStream);
      output.write("\x1b[2J\x1b[H");
      output.write(paint("Senaka Agent TUI (Linear Flow)", ANSI_BOLD, ANSI_CYAN) + "\n");
      logLine("screen cleared");
      continue;
    }

    if (line.startsWith("/agent ")) {
      const value = line.slice(7).trim();
      if (value) {
        state.agentId = value;
        logLine(`agent set to ${state.agentId}`);
      }
      continue;
    }

    if (line.startsWith("/group ")) {
      const value = line.slice(7).trim();
      if (value) {
        state.groupId = value;
        logLine(`group set to ${state.groupId}`);
      }
      continue;
    }

    if (line.startsWith("/mode ")) {
      const value = line.slice(6).trim();
      if (value === "auto") {
        state.modeOverride = undefined;
        logLine("mode override cleared");
      } else {
        state.modeOverride = value === "single-main" ? "single-main" : "main-worker";
        logLine(`mode override set to ${state.modeOverride}`);
      }
      continue;
    }

    if (line.startsWith("/steps ")) {
      const valueRaw = line.slice(7).trim();
      if (valueRaw === "auto") {
        state.maxStepsOverride = undefined;
        logLine("maxSteps override cleared");
      } else {
        const value = Number(valueRaw);
        if (Number.isFinite(value) && value > 0) {
          state.maxStepsOverride = Math.floor(value);
          logLine(`maxSteps override set to ${state.maxStepsOverride}`);
        } else {
          logLine("invalid steps value");
        }
      }
      continue;
    }

    if (line.startsWith("/stream ")) {
      const value = line.slice(8).trim();
      if (value === "auto") {
        state.streamOverride = undefined;
        logLine("stream override cleared");
      } else if (value === "on") {
        state.streamOverride = true;
        logLine("stream override set to true");
      } else if (value === "off") {
        state.streamOverride = false;
        logLine("stream override set to false");
      } else {
        logLine("invalid stream value (on|off|auto)");
      }
      continue;
    }

    if (line.startsWith("/session ")) {
      const value = line.slice(9).trim();
      if (value) {
        state.sessionId = value;
        logLine(`session set to ${state.sessionId}`);
      }
      continue;
    }

    mainStream.seenTokens = false;
    flushMainStream(mainStream);
    logLine(paint(`user goal: ${trimOneLine(line, 300)}`, ANSI_BOLD));

    try {
      const session = await loadOrCreateSession(config.sessionDir, state.sessionId, config.systemPrompt);
      const result = await runAgentLoop(config, session, line, state.agentId, {
        mode: state.modeOverride,
        maxSteps: state.maxStepsOverride,
        stream: state.streamOverride,
        workspaceGroupId: state.groupId,
        onEvent: (event) => handleLoopEvent(state, mainStream, event),
        askUser: async (question) => {
          flushMainStream(mainStream);
          logLine(paint(`ASK REQUIRED: ${question}`, ANSI_YELLOW));
          const answer = (await rl.question("ask(YES/NO)> ")).trim();
          return answer;
        },
      });

      flushMainStream(mainStream);
      logLine(`resolved mode: ${result.mode}, maxSteps: ${result.maxSteps}, stream: ${result.stream}`);
      logLine(`worker model: ${result.workerModel}`);
      logLine(`main model: ${result.mainModel}`);
      logLine(`final: ${trimOneLine(result.summary, 300)}`);
      output.write("\n");
    } catch (error) {
      flushMainStream(mainStream);
      logLine(paint(`error: ${(error as Error).message}`, ANSI_RED));
      output.write("\n");
    }
  }

  rl.close();
}

main().catch((error) => {
  process.stderr.write(`fatal> ${(error as Error).message}\n`);
  process.exit(1);
});

import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadConfig } from "../config/env.js";
import { runAgentLoop } from "../runtime/agent-loop.js";
import { loadOrCreateSession } from "../runtime/session-store.js";
import { onTuiEvent } from "./agent-tui-events.js";
import {
  ANSI_BG_USER,
  ANSI_BOLD,
  ANSI_WHITE,
  createInitialState,
  createMainViews,
  createView,
  paintFullWidthLine,
  pushLine,
  pushRawLine,
  pushSpacer,
  render,
  teardownRender,
  trimOneLine,
  wrapParagraphs,
} from "./agent-tui-view.js";

/**
 * 파일 목적:
 * - interactive TUI 실행 루프를 담당한다.
 *
 * 주요 의존성:
 * - agent-tui-view.ts: 화면 렌더링/상태 유틸
 * - agent-tui-events.ts: 이벤트 -> 상태 리듀서
 *
 * 역의존성:
 * - package.json `npm run agent:tui`
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const state = createInitialState();
  const rl = readline.createInterface({ input, output });
  const TOKEN_RENDER_THROTTLE_MS = 33;
  let lastRenderMs = 0;
  let pendingRenderTimer: NodeJS.Timeout | undefined;

  const flushRender = (): void => {
    if (pendingRenderTimer) {
      clearTimeout(pendingRenderTimer);
      pendingRenderTimer = undefined;
    }
    render(state);
    lastRenderMs = Date.now();
  };

  const scheduleThrottledRender = (): void => {
    const elapsed = Date.now() - lastRenderMs;
    if (elapsed >= TOKEN_RENDER_THROTTLE_MS) {
      flushRender();
      return;
    }
    if (pendingRenderTimer) {
      return;
    }
    pendingRenderTimer = setTimeout(() => {
      pendingRenderTimer = undefined;
      render(state);
      lastRenderMs = Date.now();
    }, TOKEN_RENDER_THROTTLE_MS - elapsed);
  };

  pushLine(state, "TUI ready");
  pushLine(state, `model config: ${config.modelProfilesPath}`);

  while (true) {
    flushRender();
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
      state.mainViews = createMainViews();
      state.activeMainPhase = "planning";
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
    state.mainViews = createMainViews();
    state.activeMainPhase = "planning";
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
    flushRender();

    try {
      const session = await loadOrCreateSession(config.sessionDir, state.sessionId, config.systemPrompt);
      const result = await runAgentLoop(config, session, line, state.agentId, {
        mode: state.modeOverride,
        maxSteps: state.maxStepsOverride,
        stream: state.streamOverride,
        workspaceGroupId: state.groupId,
        onEvent: (event) => {
          const hint = onTuiEvent(state, event);
          if (hint === "throttled") {
            scheduleThrottledRender();
            return;
          }
          flushRender();
        },
        askUser: async (question) => {
          pushLine(state, `ASK REQUIRED: ${question}`);
          flushRender();
          const answer = (await rl.question("ask(YES/NO)> ")).trim();
          return answer;
        },
      });

      pushLine(state, `resolved mode: ${result.mode}, maxSteps: ${result.maxSteps}, stream: ${result.stream}`);
      pushLine(state, `worker model: ${result.workerModel}`);
      pushLine(state, `main model: ${result.mainModel}`);
      pushLine(state, `final: ${trimOneLine(result.summary, 280)}`);
      flushRender();
    } catch (error) {
      pushLine(state, `error: ${(error as Error).message}`);
      flushRender();
    } finally {
      state.busy = false;
      flushRender();
    }
  }

  rl.close();
  teardownRender();
}

main().catch((error) => {
  teardownRender();
  process.stderr.write(`fatal> ${(error as Error).message}\n`);
  process.exit(1);
});

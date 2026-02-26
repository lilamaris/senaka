import blessed from "blessed";
import { loadConfig } from "../config/env.js";
import { runAgentLoop, type AgentLoopEvent } from "../runtime/agent-loop.js";
import {
  parseMainDecision,
  parsePlanningResult,
  stripThinkBlocks,
} from "../runtime/agent-loop/helpers.js";
import { loadOrCreateSession } from "../runtime/session-store.js";
import type { AgentMode } from "../types/model.js";

/**
 * 파일 목적:
 * - agent loop 상태 머신을 인터랙티브 TUI로 관찰/제어한다.
 * - 수동 ANSI 커서 렌더링 대신 blessed 레이아웃을 사용해 resize 안정성을 확보한다.
 *
 * 주요 의존성:
 * - runtime/agent-loop: 상태 머신 실행 및 이벤트 스트림 수신
 * - runtime/session-store: 세션 로드/저장
 * - blessed: 화면 분할/입력/스크롤 렌더링
 *
 * 역의존성:
 * - package.json `npm run agent:tui`
 *
 * 모듈 흐름:
 * 1) 사용자 입력(goal/명령) 수신
 * 2) 루프 이벤트를 위->아래 선형 로그로 누적
 * 3) main 토큰 스트림은 phase별 단일 줄로 갱신
 * 4) ask 이벤트 시 입력 프롬프트를 answer 모드로 전환
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
  lineIndex?: number;
  visibleText: string;
  carryText: string;
  inThink: boolean;
  hiddenThinkChars: number;
  captureThinkPreview: boolean;
  thinkPreviewLineCarry: string;
  thinkPreviewTotalLines: number;
  thinkPreviewHead: string[];
  thinkPreviewTail: string[];
  seenTokens: boolean;
}

interface UiParts {
  screen: blessed.Widgets.Screen;
  header: blessed.Widgets.BoxElement;
  logBox: blessed.Widgets.BoxElement;
  inputPane: blessed.Widgets.BoxElement;
  promptLabel: blessed.Widgets.TextElement;
  inputBox: blessed.Widgets.TextboxElement;
}

interface LoadingIndicator {
  label: string;
  lineIndex: number;
  frame: number;
  receivedChars: number;
  timer: NodeJS.Timeout;
}

type PromptMode = "goal" | "answer";

const MAX_LOG_LINES = 2400;
const RENDER_THROTTLE_MS = 33;
const OPEN_THINK_TAG = "<think>";
const CLOSE_THINK_TAG = "</think>";
const LOADING_SPINNER_FRAMES = ["|", "/", "-", "\\"] as const;
const LOADING_SPINNER_INTERVAL_MS = 120;

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

function escapeTagText(text: string): string {
  return blessed.escape(text);
}

/**
 * 문자열의 suffix 중에서 기준 문자열(prefix)의 접두와 일치하는 최대 길이를 반환한다.
 * main-token에서 `<think>`/`</think>` 태그가 토큰 경계에서 잘리는 경우를 복구하기 위해 사용한다.
 */
function longestSuffixPrefix(text: string, prefix: string): number {
  const max = Math.min(text.length, prefix.length - 1);
  for (let len = max; len > 0; len -= 1) {
    if (text.slice(-len) === prefix.slice(0, len)) {
      return len;
    }
  }
  return 0;
}

/**
 * blessed 기반 TUI 실행기.
 * 화면 레이아웃/입력 상태/이벤트 로그/스트림 라인 갱신을 단일 객체에서 관리한다.
 */
class AgentTuiApp {
  private readonly config = loadConfig();

  private readonly state: TuiState = {
    sessionId: "default",
    agentId: "default",
    groupId: undefined,
    modeOverride: undefined,
    maxStepsOverride: undefined,
    streamOverride: undefined,
    turn: 0,
    toolTraceByStep: {},
  };

  private readonly mainStream: MainStreamState = {
    active: false,
    phase: undefined,
    lineIndex: undefined,
    visibleText: "",
    carryText: "",
    inThink: false,
    hiddenThinkChars: 0,
    captureThinkPreview: false,
    thinkPreviewLineCarry: "",
    thinkPreviewTotalLines: 0,
    thinkPreviewHead: [],
    thinkPreviewTail: [],
    seenTokens: false,
  };

  private readonly ui: UiParts;
  private readonly logLines: string[] = [];

  private renderTimer: NodeJS.Timeout | undefined;
  private running = false;
  private promptMode: PromptMode = "goal";
  private currentStateLabel = "SYSTEM";
  private currentLoopState: string | undefined;
  private forcedSynthesisEnableThinkHint: boolean | undefined;
  private structuredMainRawByPhase: Record<string, string> = {};
  private loadingIndicators: Record<string, LoadingIndicator> = {};
  private pendingAnswerResolver: ((answer: string) => void) | undefined;
  private doneResolver: (() => void) | undefined;

  constructor() {
    this.ui = this.createUi();
    this.bindUiEvents();
    this.resetLog();
    this.ui.inputBox.focus();
    this.requestRender(true);
  }

  /**
   * 앱 생명주기 진입점.
   * `/exit` 또는 `Ctrl+C`가 호출될 때 resolve 된다.
   */
  run(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.doneResolver = resolve;
    });
  }

  /**
   * 화면 파편화를 막기 위해 스마트 diff 렌더링을 사용하는 blessed 구성.
   * - 상단: 상태 헤더
   * - 중단: 스크롤 가능한 로그
   * - 하단: 패딩 포함 입력 영역(회색 배경)
   */
  private createUi(): UiParts {
    const screen = blessed.screen({
      smartCSR: true,
      fullUnicode: true,
      title: "Senaka Agent TUI",
      dockBorders: true,
    });

    const header = blessed.box({
      parent: screen,
      top: 0,
      left: 0,
      width: "100%",
      height: 1,
      tags: true,
      style: { fg: "white", bg: "blue" },
    });

    const logBox = blessed.box({
      parent: screen,
      top: 1,
      left: 0,
      width: "100%",
      bottom: 3,
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      mouse: true,
      keys: true,
      vi: true,
      scrollbar: {
        ch: " ",
        track: { bg: "black" },
        style: { bg: "white" },
      },
      style: { fg: "white", bg: "black" },
    });

    const inputPane = blessed.box({
      parent: screen,
      bottom: 0,
      left: 0,
      width: "100%",
      height: 3,
      style: { bg: "gray" },
    });

    const promptLabel = blessed.text({
      parent: inputPane,
      top: 1,
      left: 2,
      content: "goal>",
      style: { fg: "white", bg: "gray", bold: true },
    });

    const inputBox = blessed.textbox({
      parent: inputPane,
      inputOnFocus: true,
      keys: true,
      mouse: true,
      top: 1,
      left: 9,
      right: 2,
      height: 1,
      style: { fg: "white", bg: "gray" },
    });

    return { screen, header, logBox, inputPane, promptLabel, inputBox };
  }

  /**
   * 키 입력, submit, resize 등 UI 이벤트를 연결한다.
   * resize에서는 새 줄을 추가하지 않고 동일 레이아웃을 재렌더링만 수행한다.
   */
  private bindUiEvents(): void {
    this.ui.screen.key(["C-c"], () => this.shutdown());

    this.ui.screen.on("resize", () => {
      this.requestRender(true);
    });

    this.ui.inputBox.key("enter", () => {
      this.ui.inputBox.submit();
    });

    this.ui.inputBox.on("submit", (value) => {
      const raw =
        typeof value === "string" ? value : this.ui.inputBox.getValue();
      this.ui.inputBox.clearValue();
      this.ui.inputBox.focus();
      void this.handleSubmittedLine(raw);
    });
  }

  /**
   * 입력 라인 처리 중심점.
   * - answer 대기중이면 ask 응답으로 처리
   * - 명령(`/...`)이면 설정 변경
   * - 일반 텍스트면 goal 실행
   */
  private async handleSubmittedLine(raw: string): Promise<void> {
    const line = raw.trim();
    if (!line) {
      this.requestRender(true);
      return;
    }

    if (this.pendingAnswerResolver) {
      const resolve = this.pendingAnswerResolver;
      this.pendingAnswerResolver = undefined;
      this.setPromptMode("goal");
      this.appendLog(`ask answer: ${line}`, "green-fg");
      resolve(line);
      this.requestRender(true);
      return;
    }

    if (this.running) {
      this.appendLog(
        "run in progress: answer 요청을 기다리거나 완료까지 대기하세요.",
        "yellow-fg",
      );
      this.requestRender(true);
      return;
    }

    if (line === "/exit") {
      this.shutdown();
      return;
    }

    if (line === "/clear") {
      this.resetLog();
      this.requestRender(true);
      return;
    }

    if (line.startsWith("/agent ")) {
      const value = line.slice(7).trim();
      if (value) {
        this.state.agentId = value;
        this.appendLog(`agent set to ${this.state.agentId}`, "cyan-fg");
      }
      this.requestRender(true);
      return;
    }

    if (line.startsWith("/group ")) {
      const value = line.slice(7).trim();
      if (value) {
        this.state.groupId = value;
        this.appendLog(`group set to ${this.state.groupId}`, "cyan-fg");
      }
      this.requestRender(true);
      return;
    }

    if (line.startsWith("/mode ")) {
      const value = line.slice(6).trim();
      if (value === "auto") {
        this.state.modeOverride = undefined;
        this.appendLog("mode override cleared", "cyan-fg");
      } else if (value === "main-worker" || value === "single-main") {
        this.state.modeOverride = value;
        this.appendLog(
          `mode override set to ${this.state.modeOverride}`,
          "cyan-fg",
        );
      } else {
        this.appendLog("invalid mode (main-worker|single-main|auto)", "red-fg");
      }
      this.requestRender(true);
      return;
    }

    if (line.startsWith("/steps ")) {
      const valueRaw = line.slice(7).trim();
      if (valueRaw === "auto") {
        this.state.maxStepsOverride = undefined;
        this.appendLog("maxSteps override cleared", "cyan-fg");
      } else {
        const value = Number(valueRaw);
        if (Number.isFinite(value) && value > 0) {
          this.state.maxStepsOverride = Math.floor(value);
          this.appendLog(
            `maxSteps override set to ${this.state.maxStepsOverride}`,
            "cyan-fg",
          );
        } else {
          this.appendLog("invalid steps value", "red-fg");
        }
      }
      this.requestRender(true);
      return;
    }

    if (line.startsWith("/stream ")) {
      const value = line.slice(8).trim();
      if (value === "auto") {
        this.state.streamOverride = undefined;
        this.appendLog("stream override cleared", "cyan-fg");
      } else if (value === "on") {
        this.state.streamOverride = true;
        this.appendLog("stream override set to true", "cyan-fg");
      } else if (value === "off") {
        this.state.streamOverride = false;
        this.appendLog("stream override set to false", "cyan-fg");
      } else {
        this.appendLog("invalid stream value (on|off|auto)", "red-fg");
      }
      this.requestRender(true);
      return;
    }

    if (line.startsWith("/session ")) {
      const value = line.slice(9).trim();
      if (value) {
        this.state.sessionId = value;
        this.appendLog(`session set to ${this.state.sessionId}`, "cyan-fg");
      }
      this.requestRender(true);
      return;
    }

    await this.runGoal(line);
  }

  /**
   * 사용자 goal 하나를 실행한다.
   * runAgentLoop의 onEvent/askUser를 연결해 TUI 로그와 입력 프롬프트를 동기화한다.
   */
  private async runGoal(goal: string): Promise<void> {
    this.running = true;
    this.currentStateLabel = "INPUT";
    this.currentLoopState = undefined;
    this.forcedSynthesisEnableThinkHint = undefined;
    this.mainStream.seenTokens = false;
    this.stopAllLoadingIndicators();
    this.flushMainStream();
    this.appendLog(`user goal: ${trimOneLine(goal, 300)}`, "white-fg", true);
    this.requestRender(true);

    try {
      const session = await loadOrCreateSession(
        this.config.sessionDir,
        this.state.sessionId,
        this.config.systemPrompt,
      );
      const result = await runAgentLoop(
        this.config,
        session,
        goal,
        this.state.agentId,
        {
          mode: this.state.modeOverride,
          maxSteps: this.state.maxStepsOverride,
          stream: this.state.streamOverride,
          workspaceGroupId: this.state.groupId,
          onEvent: (event) => this.handleLoopEvent(event),
          askUser: (question) => this.waitForAnswer(question),
        },
      );

      this.flushMainStream();
      this.appendLog(
        `resolved mode: ${result.mode}, maxSteps: ${result.maxSteps}, stream: ${result.stream}`,
        "green-fg",
      );
      this.appendLog(`worker model: ${result.workerModel}`, "gray-fg");
      this.appendLog(`main model: ${result.mainModel}`, "gray-fg");
      this.appendLog(`final: ${trimOneLine(result.summary, 300)}`, "green-fg");
      this.appendLine("");
      this.requestRender(true);
    } catch (error) {
      this.stopAllLoadingIndicators();
      this.flushMainStream();
      this.appendLog(`error: ${(error as Error).message}`, "red-fg", true);
      this.appendLine("");
      this.requestRender(true);
    } finally {
      this.stopAllLoadingIndicators();
      this.running = false;
      this.setPromptMode("goal");
      this.requestRender(true);
    }
  }

  /**
   * worker ask 액션에 대한 사용자 응답 대기.
   * 입력창 라벨을 `answer>`로 전환하고 다음 submit 시 resolve 한다.
   */
  private waitForAnswer(question: string): Promise<string> {
    this.flushMainStream();
    this.appendLog(`ASK REQUIRED: ${question}`, "yellow-fg", true);
    this.setPromptMode("answer");
    this.requestRender(true);

    return new Promise<string>((resolve) => {
      this.pendingAnswerResolver = (answer) => resolve(answer.trim());
    });
  }

  /**
   * agent loop 이벤트를 TUI 로그로 투영한다.
   * main-token은 final-report 단계만 실시간 표시하고,
   * 구조화(JSON) 단계는 파싱 결과 이벤트만 구조화 로그로 출력한다.
   */
  private handleLoopEvent(event: AgentLoopEvent): void {
    if (event.type === "main-token") {
      this.handleMainToken(event.phase, event.token);
      return;
    }

    this.flushMainStream();

    if (event.type === "start") {
      this.mainStream.seenTokens = false;
      this.structuredMainRawByPhase = {};
      this.stopAllLoadingIndicators();
      this.currentLoopState = undefined;
      this.forcedSynthesisEnableThinkHint = undefined;
      this.state.turn += 1;
      this.state.toolTraceByStep = {};
      this.currentStateLabel = "RUN";
      this.appendLine("");
      this.appendLine(
        `{bold}{cyan-fg}${this.buildTurnBanner(`TURN ${this.state.turn} START`)}{/cyan-fg}{/bold}`,
      );
      this.appendLine("");
      this.appendLog(
        `run start: agent=${event.agentId} mode=${event.mode} goal=${trimOneLine(event.goal, 260)}`,
        "cyan-fg",
      );
      this.requestRender(true);
      return;
    }

    if (event.type === "loop-state") {
      this.currentLoopState = event.state;
      this.enterStateSection(
        event.state,
        `step=${event.step} evidence=${event.evidenceCount}`,
      );
      this.appendLog(`summary: ${trimOneLine(event.summary, 260)}`, "gray-fg");
      this.requestRender(true);
      return;
    }

    if (event.type === "planning-start") {
      this.startLoadingIndicator("planning", "planning generating");
      this.appendLine(
        `{blue-fg}planning start:{/} ${trimOneLine(event.goal, 260)}`,
      );
      this.requestRender(true);
      return;
    }

    if (event.type === "planning-result") {
      this.stopLoadingIndicator("planning", "{gray-fg}planning generating complete{/}");
      const raw = this.consumeStructuredRaw("planning");
      const parsed = this.tryParsePlanningRaw(raw);
      const next = parsed?.next ?? event.next;
      const reason = parsed?.reason ?? event.reason;
      const guidance = parsed?.guidance ?? event.guidance;
      const evidenceGoals = parsed?.evidenceGoals ?? event.evidenceGoals;
      this.appendLog("Planning Result", "cyan-fg", true);
      this.appendLog(`next  : ${next}`, "cyan-fg");
      this.appendLog(`reason: ${trimOneLine(reason, 220)}`, "cyan-fg");
      if (guidance) {
        this.appendLog(`guide : ${trimOneLine(guidance, 180)}`, "cyan-fg");
      }
      if (evidenceGoals.length > 0) {
        this.appendLog(
          `goals : ${evidenceGoals.map((goal) => trimOneLine(goal, 90)).join(" | ")}`,
          "cyan-fg",
        );
      }
      this.requestRender(true);
      return;
    }

    if (event.type === "compaction-start") {
      this.appendLog(
        `context compaction start: tokens=${event.estimatedTokens}/${event.contextLimitTokens}, trigger=${event.triggerTokens}, target=${event.targetTokens}, messages=${event.messageCount}`,
        "yellow-fg",
      );
      this.requestRender(true);
      return;
    }

    if (event.type === "compaction-complete") {
      this.appendLog(
        `context compaction complete: tokens ${event.beforeTokens} -> ${event.afterTokens}, messages ${event.beforeMessages} -> ${event.afterMessages}`,
        "green-fg",
      );
      this.requestRender(true);
      return;
    }

    if (event.type === "worker-start") {
      this.appendLine("");
      this.startLoadingIndicator("worker-action", "worker generating action");
      this.requestRender(true);
      return;
    }

    if (event.type === "worker-token") {
      // worker raw JSON 스트림은 의도적으로 숨겨 UI 노이즈를 줄인다.
      this.appendLoadingIndicatorToken("worker-action", event.token);
      this.requestRender(false);
      return;
    }

    if (event.type === "worker-action") {
      this.stopLoadingIndicator("worker-action");
      if (event.action === "call_tool") {
        this.state.toolTraceByStep[event.step] = {
          ...(this.state.toolTraceByStep[event.step] ?? {}),
          reason: event.detail,
        };
      } else {
        this.appendLog(
          `worker action: ${event.action} :: ${trimOneLine(event.detail, 260)}`,
          "gray-fg",
        );
      }
      this.requestRender(true);
      return;
    }

    if (event.type === "worker-validation-failed") {
      this.stopLoadingIndicator("worker-action");
      this.appendLog(
        `worker validation failed (${event.consecutiveFailures}/${event.maxFailures})`,
        "yellow-fg",
      );
      this.appendLog(`reason: ${trimOneLine(event.reason, 300)}`, "gray-fg");
      if (event.switchedToAssess) {
        this.appendLog("switching to assess sufficiency with current evidence", "yellow-fg");
      }
      this.requestRender(true);
      return;
    }

    if (event.type === "tool-start") {
      this.state.toolTraceByStep[event.step] = {
        ...(this.state.toolTraceByStep[event.step] ?? {}),
        cmd: event.cmd,
      };
      return;
    }

    if (event.type === "tool-result") {
      const trace = this.state.toolTraceByStep[event.step] ?? {};
      const reason = event.reason ?? trace.reason ?? "<missing reason>";
      const cmd = event.cmd ?? trace.cmd ?? "<missing cmd>";
      this.appendLog(
        `reason: ${trimOneLine(reason, 260)}`,
        "yellow-fg",
      );
      this.appendLog(
        `cmd   : ${trimOneLine(cmd, 320)}`,
        "white-fg",
      );
      this.appendLog(
        `result: exit=${event.exitCode} runner=${event.runner} group=${event.workspaceGroupId}`,
        "gray-fg",
      );
      this.appendLog(
        `\tstdout: ${trimOneLine(firstNonEmptyLine(event.stdout), 300)}`,
        "gray-fg",
      );
      if (event.stderr.trim()) {
        this.appendLog(
          `\tstderr: ${trimOneLine(firstNonEmptyLine(event.stderr), 300)}`,
          "gray-fg",
        );
      }
      this.requestRender(true);
      return;
    }

    if (event.type === "ask") {
      this.appendLog(`worker ask: ${event.question}`, "gray-fg");
      this.requestRender(true);
      return;
    }

    if (event.type === "ask-answer") {
      this.appendLog(`ask answer: ${event.answer}`, "gray-fg");
      this.requestRender(true);
      return;
    }

    if (event.type === "main-start") {
      if (this.shouldHideStructuredMainTokens(event.phase)) {
        this.resetStructuredRaw(event.phase);
        const key = event.phase === "planning" ? "planning" : `main-${event.phase}`;
        const label =
          event.phase === "planning"
            ? "planning generating"
            : `main ${event.phase} generating`;
        this.startLoadingIndicator(key, label, event.phase !== "planning");
        this.appendLog(
          `main[${event.phase}] started with evidence=${event.evidenceCount} (structured parsing)`,
          "blue-fg",
        );
      } else {
        this.appendLog(
          `main[${event.phase}] started with evidence=${event.evidenceCount}`,
          "blue-fg",
        );
      }
      this.requestRender(true);
      return;
    }

    if (event.type === "main-decision") {
      this.stopLoadingIndicator(`main-${event.phase}`);
      const raw = this.consumeStructuredRaw(event.phase);
      const parsed = this.tryParseDecisionRaw(raw);
      if (typeof parsed?.forcedSynthesisEnableThink === "boolean") {
        this.forcedSynthesisEnableThinkHint = parsed.forcedSynthesisEnableThink;
      }
      const decision = parsed?.decision ?? event.decision;
      const guidance = parsed?.guidance ?? event.guidance;
      this.appendLog(
        `Main Decision (${event.phase})`,
        decision === "finalize" ? "green-fg" : "yellow-fg",
        true,
      );
      this.appendLog(
        `decision: ${decision}`,
        decision === "finalize" ? "green-fg" : "yellow-fg",
      );
      if (guidance) {
        this.appendLog(`guide   : ${trimOneLine(guidance, 240)}`, "yellow-fg");
      }
      if (parsed?.neededEvidence && parsed.neededEvidence.length > 0) {
        this.appendLog(
          `needed  : ${parsed.neededEvidence.map((value) => trimOneLine(value, 90)).join(" | ")}`,
          "yellow-fg",
        );
      }
      if (parsed?.summaryEvidence && parsed.summaryEvidence.length > 0) {
        this.appendLog(
          `summary : ${parsed.summaryEvidence.map((value) => trimOneLine(value, 90)).join(" | ")}`,
          "green-fg",
        );
      }
      if (typeof parsed?.forcedSynthesisEnableThink === "boolean") {
        this.appendLog(
          `think   : forced_synthesis_enable_think=${parsed.forcedSynthesisEnableThink}`,
          "gray-fg",
        );
      }
      this.requestRender(true);
      return;
    }

    if (event.type === "final-answer") {
      if (!this.mainStream.seenTokens) {
        this.appendLog("final answer:", "green-fg", true);
        this.appendLine(escapeTagText(event.answer.trim()));
      } else {
        this.appendLog(
          `main final report ready (${event.answer.length} chars)`,
          "green-fg",
        );
      }
      this.requestRender(true);
      return;
    }

    if (event.type === "complete") {
      this.stopAllLoadingIndicators();
      this.currentStateLabel = "DONE";
      this.appendLog(
        `run complete: steps=${event.steps}, evidence=${event.evidenceCount}`,
        "green-fg",
      );
      this.appendLine("");
      this.appendLine(
        `{bold}{cyan-fg}${this.buildTurnBanner(`TURN ${this.state.turn} END`)}{/cyan-fg}{/bold}`,
      );
      this.appendLine("");
      this.requestRender(true);
    }
  }

  /**
   * main 스트리밍 토큰을 phase별 단일 로그 라인으로 누적 렌더링한다.
   * `<think>` 블록은 숨기고 길이만 회색 메타 정보로 표시해 가독성을 유지한다.
   */
  private handleMainToken(phase: string, token: string): void {
    if (this.shouldHideStructuredMainTokens(phase)) {
      const key = phase === "planning" ? "planning" : `main-${phase}`;
      const label =
        phase === "planning" ? "planning generating" : `main ${phase} generating`;
      this.startLoadingIndicator(key, label, false);
      this.appendLoadingIndicatorToken(key, token);
      this.appendStructuredRaw(phase, token);
      this.requestRender(false);
      return;
    }

    if (!this.mainStream.active || this.mainStream.phase !== phase) {
      this.startMainStream(phase);
    }

    this.mainStream.seenTokens = true;
    this.consumeMainToken(token);
    this.renderMainStreamLine();
    this.requestRender(false);
  }

  private shouldHideStructuredMainTokens(phase: string): boolean {
    return phase !== "final-report";
  }

  private resetStructuredRaw(phase: string): void {
    this.structuredMainRawByPhase[phase] = "";
  }

  private appendStructuredRaw(phase: string, token: string): void {
    this.structuredMainRawByPhase[phase] =
      `${this.structuredMainRawByPhase[phase] ?? ""}${token}`;
  }

  private consumeStructuredRaw(phase: string): string {
    const value = this.structuredMainRawByPhase[phase] ?? "";
    delete this.structuredMainRawByPhase[phase];
    return value;
  }

  private tryParsePlanningRaw(
    raw: string,
  ):
    | {
        next: string;
        reason: string;
        guidance?: string;
        evidenceGoals: string[];
      }
    | undefined {
    const cleaned = stripThinkBlocks(raw);
    if (!cleaned.trim()) {
      return undefined;
    }
    try {
      const parsed = parsePlanningResult(cleaned);
      return {
        next: parsed.next,
        reason: parsed.reason,
        guidance: parsed.guidance,
        evidenceGoals: parsed.evidence_goals ?? [],
      };
    } catch {
      return undefined;
    }
  }

  private tryParseDecisionRaw(raw: string):
    | {
        decision: "finalize" | "continue";
        guidance?: string;
        summaryEvidence?: string[];
        neededEvidence?: string[];
        forcedSynthesisEnableThink?: boolean;
      }
    | undefined {
    const cleaned = stripThinkBlocks(raw);
    if (!cleaned.trim()) {
      return undefined;
    }
    try {
      const parsed = parseMainDecision(cleaned);
      return {
        decision: parsed.decision,
        guidance: parsed.guidance,
        summaryEvidence: parsed.summary_evidence,
        neededEvidence: parsed.needed_evidence,
        forcedSynthesisEnableThink: parsed.forced_synthesis_enable_think,
      };
    } catch {
      return undefined;
    }
  }

  private startLoadingIndicator(
    key: string,
    label: string,
    replace = true,
  ): void {
    if (this.loadingIndicators[key] && !replace) {
      return;
    }

    this.stopLoadingIndicator(key);
    const lineIndex = this.appendLine("", false);
    const indicator: LoadingIndicator = {
      label,
      lineIndex,
      frame: 0,
      receivedChars: 0,
      timer: setInterval(() => {
        const current = this.loadingIndicators[key];
        if (!current) {
          return;
        }
        current.frame = (current.frame + 1) % LOADING_SPINNER_FRAMES.length;
        this.renderLoadingIndicator(key);
        this.requestRender(false);
      }, LOADING_SPINNER_INTERVAL_MS),
    };
    this.loadingIndicators[key] = indicator;
    this.renderLoadingIndicator(key);
  }

  private stopLoadingIndicator(key: string, completedMessage?: string): void {
    const indicator = this.loadingIndicators[key];
    if (!indicator) {
      return;
    }

    clearInterval(indicator.timer);
    if (indicator.lineIndex >= 0 && indicator.lineIndex < this.logLines.length) {
      this.logLines[indicator.lineIndex] = completedMessage ?? "";
    }
    delete this.loadingIndicators[key];
  }

  private stopAllLoadingIndicators(): void {
    const keys = Object.keys(this.loadingIndicators);
    for (const key of keys) {
      this.stopLoadingIndicator(key);
    }
  }

  private renderLoadingIndicator(key: string): void {
    const indicator = this.loadingIndicators[key];
    if (!indicator) {
      return;
    }
    if (indicator.lineIndex < 0 || indicator.lineIndex >= this.logLines.length) {
      return;
    }
    const frame = LOADING_SPINNER_FRAMES[indicator.frame % LOADING_SPINNER_FRAMES.length];
    const estTokens = Math.ceil(indicator.receivedChars / 4);
    this.logLines[indicator.lineIndex] =
      `{blue-fg}${escapeTagText(indicator.label)} ${frame}{/} {gray-fg}(tokens~${estTokens}){/}`;
  }

  private appendLoadingIndicatorToken(key: string, token: string): void {
    const indicator = this.loadingIndicators[key];
    if (!indicator || !token) {
      return;
    }
    indicator.receivedChars += token.length;
  }

  private consumeThinkPreviewChunk(chunk: string): void {
    if (!chunk) {
      return;
    }
    const merged = `${this.mainStream.thinkPreviewLineCarry}${chunk}`;
    const lines = merged.split(/\r?\n/);
    this.mainStream.thinkPreviewLineCarry = lines.pop() ?? "";
    for (const line of lines) {
      this.pushThinkPreviewLine(line);
    }
  }

  private flushThinkPreviewTailLine(): void {
    const tail = this.mainStream.thinkPreviewLineCarry;
    if (tail.trim()) {
      this.pushThinkPreviewLine(tail);
    }
    this.mainStream.thinkPreviewLineCarry = "";
  }

  private pushThinkPreviewLine(line: string): void {
    const normalized = line.trim();
    if (!normalized) {
      return;
    }
    const clipped = trimOneLine(normalized, 80);
    this.mainStream.thinkPreviewTotalLines += 1;
    if (this.mainStream.thinkPreviewHead.length < 3) {
      this.mainStream.thinkPreviewHead.push(clipped);
    }
    this.mainStream.thinkPreviewTail.push(clipped);
    if (this.mainStream.thinkPreviewTail.length > 3) {
      this.mainStream.thinkPreviewTail.shift();
    }
  }

  private formatThinkPreviewMeta(): string {
    const total = this.mainStream.thinkPreviewTotalLines;
    if (total === 0) {
      return "";
    }
    const head = this.mainStream.thinkPreviewHead.join(" / ");
    const tail = this.mainStream.thinkPreviewTail.join(" / ");
    if (total <= 3) {
      return `lines=${total}: ${escapeTagText(head)}`;
    }
    if (total <= 6) {
      const merged = Array.from(
        new Set([
          ...this.mainStream.thinkPreviewHead,
          ...this.mainStream.thinkPreviewTail,
        ]),
      );
      return `lines=${total}: ${escapeTagText(merged.join(" / "))}`;
    }
    return `first3=${escapeTagText(head)} ... truncated(${total - 6} lines) ... last3=${escapeTagText(tail)}`;
  }

  /**
   * phase 전환 시 새로운 main 스트림 로그 라인을 생성한다.
   */
  private startMainStream(phase: string): void {
    this.flushMainStream();
    this.mainStream.active = true;
    this.mainStream.phase = phase;
    this.mainStream.lineIndex = this.appendLine("", false);
    this.mainStream.visibleText = "";
    this.mainStream.carryText = "";
    this.mainStream.inThink = false;
    this.mainStream.hiddenThinkChars = 0;
    this.mainStream.captureThinkPreview =
      phase === "final-report" &&
      this.currentLoopState === "forced-synthesis" &&
      this.forcedSynthesisEnableThinkHint === true;
    this.mainStream.thinkPreviewLineCarry = "";
    this.mainStream.thinkPreviewTotalLines = 0;
    this.mainStream.thinkPreviewHead = [];
    this.mainStream.thinkPreviewTail = [];
    this.renderMainStreamLine();
  }

  /**
   * 토큰 경계에서 태그가 분리되어도 안정적으로 처리하도록 carry 버퍼를 사용한다.
   * - think 내부 텍스트는 누적 길이만 저장
   * - think 외부 텍스트만 visibleText에 누적
   */
  private consumeMainToken(token: string): void {
    let input = `${this.mainStream.carryText}${token}`;
    this.mainStream.carryText = "";

    while (input.length > 0) {
      if (this.mainStream.inThink) {
        const closeIdx = input.indexOf(CLOSE_THINK_TAG);
        if (closeIdx >= 0) {
          if (this.mainStream.captureThinkPreview && closeIdx > 0) {
            this.consumeThinkPreviewChunk(input.slice(0, closeIdx));
          }
          this.mainStream.hiddenThinkChars += closeIdx;
          input = input.slice(closeIdx + CLOSE_THINK_TAG.length);
          this.mainStream.inThink = false;
          continue;
        }

        const partial = longestSuffixPrefix(input, CLOSE_THINK_TAG);
        const consumeLen = input.length - partial;
        if (this.mainStream.captureThinkPreview && consumeLen > 0) {
          this.consumeThinkPreviewChunk(input.slice(0, consumeLen));
        }
        this.mainStream.hiddenThinkChars += consumeLen;
        this.mainStream.carryText = input.slice(consumeLen);
        break;
      }

      const openIdx = input.indexOf(OPEN_THINK_TAG);
      if (openIdx >= 0) {
        this.mainStream.visibleText += input.slice(0, openIdx);
        input = input.slice(openIdx + OPEN_THINK_TAG.length);
        this.mainStream.inThink = true;
        continue;
      }

      const partial = longestSuffixPrefix(input, OPEN_THINK_TAG);
      const consumeLen = input.length - partial;
      this.mainStream.visibleText += input.slice(0, consumeLen);
      this.mainStream.carryText = input.slice(consumeLen);
      break;
    }
  }

  /**
   * main 스트림 종료 시 carry 버퍼를 정리하고 상태를 초기화한다.
   * partial 태그 잔여 문자열은 일반 텍스트/숨김 길이로 안전하게 반영한다.
   */
  private flushMainStream(): void {
    if (!this.mainStream.active) {
      return;
    }

    if (this.mainStream.carryText) {
      if (this.mainStream.inThink) {
        if (this.mainStream.captureThinkPreview) {
          this.consumeThinkPreviewChunk(this.mainStream.carryText);
        }
        this.mainStream.hiddenThinkChars += this.mainStream.carryText.length;
      } else {
        this.mainStream.visibleText += this.mainStream.carryText;
      }
      this.mainStream.carryText = "";
    }

    if (this.mainStream.captureThinkPreview) {
      this.flushThinkPreviewTailLine();
    }

    this.renderMainStreamLine();
    this.mainStream.active = false;
    this.mainStream.phase = undefined;
    this.mainStream.lineIndex = undefined;
    this.mainStream.visibleText = "";
    this.mainStream.inThink = false;
    this.mainStream.hiddenThinkChars = 0;
    this.mainStream.captureThinkPreview = false;
    this.mainStream.thinkPreviewLineCarry = "";
    this.mainStream.thinkPreviewTotalLines = 0;
    this.mainStream.thinkPreviewHead = [];
    this.mainStream.thinkPreviewTail = [];
  }

  /**
   * main 스트림 라인을 실제 로그 버퍼의 해당 인덱스에 반영한다.
   * think 토큰은 회색 메타 텍스트(`[think 숨김 ...]`)로 축약 표시한다.
   */
  private renderMainStreamLine(): void {
    const lineIndex = this.mainStream.lineIndex;
    if (
      lineIndex === undefined ||
      lineIndex < 0 ||
      lineIndex >= this.logLines.length
    ) {
      return;
    }

    const prefix = `{blue-fg}main(${escapeTagText(this.mainStream.phase ?? "unknown")})>{/} `;
    const visible = escapeTagText(this.mainStream.visibleText);
    const previewMeta = this.mainStream.captureThinkPreview
      ? this.formatThinkPreviewMeta()
      : "";
    const thinkMeta =
      this.mainStream.hiddenThinkChars > 0 || this.mainStream.inThink
        ? ` {gray-fg}[think 숨김 ${this.mainStream.hiddenThinkChars}${this.mainStream.inThink ? ", 진행중" : ""} chars${previewMeta ? `, ${previewMeta}` : ""}]{/}`
        : "";

    this.logLines[lineIndex] = `${prefix}${visible}${thinkMeta}`;
  }

  /**
   * 입력 프롬프트 모드(goal/answer)를 전환하고 라벨을 갱신한다.
   */
  private setPromptMode(mode: PromptMode): void {
    this.promptMode = mode;
    this.ui.promptLabel.setContent(mode === "answer" ? "answer>" : "goal>");
    this.requestRender(true);
  }

  /**
   * 로그 초기화 후 기본 안내 라인을 재구성한다.
   */
  private resetLog(): void {
    this.stopAllLoadingIndicators();
    this.logLines.length = 0;
    this.currentStateLabel = "SYSTEM";
    this.appendLog("Senaka Agent TUI (Blessed Layout)", "cyan-fg", true);
    this.appendLog(
      "Commands: /agent ID, /group ID, /mode main-worker|single-main|auto, /steps N|auto, /stream on|off|auto, /session ID, /clear, /exit",
      "white-fg",
    );
    this.appendLog(`model config: ${this.config.modelProfilesPath}`, "gray-fg");
    this.appendLine(`{gray-fg}${this.fullWidthDivider()}{/}`);
  }

  /**
   * 상태 헤더 텍스트를 구성한다.
   * 실행 중/대기 중 상태와 현재 override 값을 한 줄에서 확인할 수 있게 유지한다.
   */
  private buildHeader(): string {
    const status = this.running
      ? "RUNNING"
      : this.promptMode === "answer"
        ? "WAIT_ANSWER"
        : "IDLE";
    const mode = this.state.modeOverride ?? "auto";
    const steps = this.state.maxStepsOverride?.toString() ?? "auto";
    const stream =
      this.state.streamOverride === undefined
        ? "auto"
        : this.state.streamOverride
          ? "on"
          : "off";

    return [
      " Senaka Agent TUI",
      `status=${status}`,
      `session=${this.state.sessionId}`,
      `agent=${this.state.agentId}`,
      `group=${this.state.groupId ?? "-"}`,
      `mode=${mode}`,
      `steps=${steps}`,
      `stream=${stream}`,
    ].join("  │  ");
  }

  private normalizeStateLabel(raw: string): string {
    return raw.trim().replace(/-/g, "_").toUpperCase() || "UNKNOWN";
  }

  /**
   * 상태 전이 시 구분선/패딩을 넣어 섹션을 명확히 분리한다.
   */
  private enterStateSection(state: string, summary: string): void {
    const normalized = this.normalizeStateLabel(state);
    if (this.currentStateLabel === normalized) {
      return;
    }

    this.currentStateLabel = normalized;
    this.appendLine("");
    this.appendLine(`{gray-fg}${this.fullWidthDivider()}{/}`);
    this.appendLine(`{bold}{cyan-fg}${normalized}{/cyan-fg}{/bold}`);
    this.appendLine(`{gray-fg}${escapeTagText(summary)}{/}`);
    this.appendLine(`{gray-fg}${this.fullWidthDivider()}{/}`);
    this.appendLine("");
  }

  /**
   * 현재 log 영역 기준 폭으로 구분선을 생성한다.
   */
  private fullWidthDivider(char = "─"): string {
    const screenWidth =
      typeof this.ui.screen.width === "number" ? this.ui.screen.width : 80;
    const len = Math.max(24, Math.floor(screenWidth) - 1);
    return char.repeat(len);
  }

  /**
   * 턴 시작/종료 배너를 현재 터미널 폭에 맞춰 생성한다.
   */
  private buildTurnBanner(label: string): string {
    const clean = label.trim();
    const minEdge = 4;
    const lineWidth = this.fullWidthDivider().length;
    const bodyLen = clean.length + 2; // 공백 패딩 2칸
    const remain = Math.max(minEdge * 2, lineWidth - bodyLen);
    const left = Math.max(minEdge, Math.floor(remain / 2));
    const right = Math.max(minEdge, remain - left);
    return `${"─".repeat(left)} ${clean} ${"─".repeat(right)}`;
  }

  /**
   * 선택 스타일과 상태 배지를 적용한 로그 라인을 추가한다.
   */
  private appendLog(text: string, colorTag?: string, bold = false): number {
    const escaped = escapeTagText(text);
    let body = escaped;
    if (colorTag) {
      body = `{${colorTag}}${body}{/}`;
    }
    if (bold) {
      body = `{bold}${body}{/bold}`;
    }
    return this.appendLine(body);
  }

  /**
   * 원시 라인을 로그 버퍼에 추가한다.
   * 메모리/렌더 안정성을 위해 최대 라인 수를 넘으면 상단부터 버린다.
   */
  private appendLine(line: string, requestRender = false): number {
    this.enforceLineCapacity();
    this.logLines.push(line);
    const index = this.logLines.length - 1;
    if (requestRender) {
      this.requestRender(true);
    }
    return index;
  }

  /**
   * 로그 버퍼 상한을 관리하고, 활성 스트림 라인 인덱스를 동기화한다.
   */
  private enforceLineCapacity(): void {
    if (this.logLines.length < MAX_LOG_LINES) {
      return;
    }

    const removed = this.logLines.length - MAX_LOG_LINES + 1;
    this.logLines.splice(0, removed);

    if (this.mainStream.lineIndex !== undefined) {
      this.mainStream.lineIndex -= removed;
      if (this.mainStream.lineIndex < 0) {
        this.mainStream.lineIndex = undefined;
      }
    }

    for (const [key, indicator] of Object.entries(this.loadingIndicators)) {
      indicator.lineIndex -= removed;
      if (indicator.lineIndex < 0) {
        this.stopLoadingIndicator(key);
      }
    }
  }

  /**
   * 렌더 요청을 스로틀링한다.
   * 토큰 고속 스트리밍 시에도 33ms 단위로만 실제 렌더를 수행해 플리커링을 줄인다.
   */
  private requestRender(immediate: boolean): void {
    if (immediate) {
      if (this.renderTimer) {
        clearTimeout(this.renderTimer);
        this.renderTimer = undefined;
      }
      this.render();
      return;
    }

    if (this.renderTimer) {
      return;
    }

    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      this.render();
    }, RENDER_THROTTLE_MS);
  }

  /**
   * 현재 상태를 실제 화면으로 반영한다.
   */
  private render(): void {
    this.ui.header.setContent(this.buildHeader());
    this.ui.logBox.setContent(this.logLines.join("\n"));
    this.ui.logBox.setScrollPerc(100);
    this.ui.screen.render();
  }

  /**
   * 안전 종료 루틴.
   * pending ask가 있으면 빈 응답으로 종료시켜 루프가 매달리지 않게 정리한다.
   */
  private shutdown(): void {
    this.stopAllLoadingIndicators();
    this.flushMainStream();

    if (this.pendingAnswerResolver) {
      const resolve = this.pendingAnswerResolver;
      this.pendingAnswerResolver = undefined;
      resolve("NO");
    }

    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }

    this.ui.screen.destroy();
    this.doneResolver?.();
  }
}

async function main(): Promise<void> {
  const app = new AgentTuiApp();
  await app.run();
}

main().catch((error) => {
  process.stderr.write(`fatal> ${(error as Error).message}\n`);
  process.exit(1);
});

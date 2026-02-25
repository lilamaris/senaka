import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadConfig } from "../config/env.js";
import { runAgentLoop, type AgentLoopEvent } from "../runtime/agent-loop.js";
import { loadOrCreateSession } from "../runtime/session-store.js";
import type { AgentMode } from "../types/model.js";

/**
 * 파일 목적:
 * - 단일 goal을 실행하는 비대화형 CLI 엔트리포인트.
 *
 * 주요 의존성:
 * - runtime/agent-loop: 상태 머신 실행
 * - runtime/session-store: 세션 로드/생성
 *
 * 역의존성:
 * - package.json의 `npm run agent:run` 스크립트
 *
 * 모듈 흐름:
 * 1) 인자 파싱
 * 2) 세션 복구
 * 3) 루프 실행 + 이벤트 스트림 출력
 * 4) 최종 summary/evidence 출력
 */
interface Args {
  sessionId: string;
  goal: string;
  agentId: string;
  groupId?: string;
  mode?: AgentMode;
  maxSteps?: number;
  stream?: boolean;
}

/**
 * CLI 인자를 런타임 실행 옵션으로 변환한다.
 */
function parseArgs(argv: string[]): Args {
  const sessionIdx = argv.indexOf("--session");
  const goalIdx = argv.indexOf("--goal");
  const agentIdx = argv.indexOf("--agent");
  const groupIdx = argv.indexOf("--group");
  const modeIdx = argv.indexOf("--mode");
  const maxIdx = argv.indexOf("--max-steps");
  const noStream = argv.includes("--no-stream");

  const sessionId = sessionIdx >= 0 && argv[sessionIdx + 1] ? argv[sessionIdx + 1] : "default";
  const goal = goalIdx >= 0 && argv[goalIdx + 1] ? argv[goalIdx + 1] : "";
  const agentId = agentIdx >= 0 && argv[agentIdx + 1] ? argv[agentIdx + 1] : "default";
  const groupId = groupIdx >= 0 && argv[groupIdx + 1] ? argv[groupIdx + 1] : undefined;

  if (!goal.trim()) {
    throw new Error("--goal is required");
  }

  const modeRaw = modeIdx >= 0 && argv[modeIdx + 1] ? argv[modeIdx + 1] : undefined;
  const mode = modeRaw ? (modeRaw === "single-main" ? "single-main" : "main-worker") : undefined;

  const maxRaw = maxIdx >= 0 && argv[maxIdx + 1] ? argv[maxIdx + 1] : undefined;
  const maxSteps = maxRaw && Number.isFinite(Number(maxRaw)) ? Math.max(1, Number(maxRaw)) : undefined;

  return { sessionId, goal, agentId, groupId, mode, maxSteps, stream: noStream ? false : undefined };
}

/**
 * CLI 실행 메인 함수.
 * main-token 이벤트를 별도 스트림으로 출력해 final report 생성 중 진행 상황을 보여준다.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const args = parseArgs(process.argv.slice(2));
  const session = await loadOrCreateSession(config.sessionDir, args.sessionId, config.systemPrompt);
  const rl = createInterface({ input, output });
  let mainStreaming = false;
  let mainStreamingPhase: string | undefined;

  /**
   * 루프 이벤트를 CLI 출력으로 투영한다.
   * 현재는 main-token/final-answer 중심으로만 처리해 로그 노이즈를 줄인다.
   */
  const renderEvent = (event: AgentLoopEvent): void => {
    if (event.type === "planning-start") {
      process.stdout.write(`planning(start)> goal=${event.goal}\n`);
      return;
    }

    if (event.type === "planning-result") {
      process.stdout.write(
        `planning(result)> next=${event.next} reason=${event.reason}${event.guidance ? ` guidance=${event.guidance}` : ""}\n`,
      );
      if (event.evidenceGoals.length > 0) {
        process.stdout.write(`planning(goals)> ${event.evidenceGoals.join(" | ")}\n`);
      }
      return;
    }

    if (event.type === "compaction-start") {
      process.stdout.write(
        `\ncontext-compaction(start)> tokens=${event.estimatedTokens}/${event.contextLimitTokens} trigger=${event.triggerTokens} target=${event.targetTokens} messages=${event.messageCount}\n`,
      );
      return;
    }

    if (event.type === "compaction-complete") {
      process.stdout.write(
        `context-compaction(done)> tokens=${event.beforeTokens}->${event.afterTokens} messages=${event.beforeMessages}->${event.afterMessages}\n`,
      );
      return;
    }

    if (event.type === "main-token") {
      if (!mainStreaming || mainStreamingPhase !== event.phase) {
        if (mainStreaming) {
          process.stdout.write("\n");
        }
        process.stdout.write(`\nmain(${event.phase})> `);
        mainStreaming = true;
        mainStreamingPhase = event.phase;
      }
      process.stdout.write(event.token);
      return;
    }

    if (event.type === "final-answer" && mainStreaming) {
      process.stdout.write("\n");
      mainStreaming = false;
      mainStreamingPhase = undefined;
    }
  };

  process.stdout.write(`agent profile: ${args.agentId}\n`);
  process.stdout.write(`workspace group: ${args.groupId ?? session.id}\n`);
  process.stdout.write(`session: ${session.id}\n`);
  try {
    const result = await runAgentLoop(config, session, args.goal, args.agentId, {
      mode: args.mode,
      maxSteps: args.maxSteps,
      stream: args.stream,
      workspaceGroupId: args.groupId,
      onEvent: renderEvent,
      askUser: async (question) => {
        // 스트리밍 출력 중 사용자 입력 프롬프트가 섞이면 가독성이 크게 떨어져 개행 정리 후 질문한다.
        if (mainStreaming) {
          process.stdout.write("\n");
          mainStreaming = false;
          mainStreamingPhase = undefined;
        }
        process.stdout.write(`ask> ${question}\n`);
        return (await rl.question("answer(YES/NO)> ")).trim();
      },
    });

    if (mainStreaming) {
      process.stdout.write("\n");
      mainStreaming = false;
      mainStreamingPhase = undefined;
    }

    process.stdout.write(`resolved mode: ${result.mode}\n`);
    process.stdout.write(`resolved maxSteps: ${result.maxSteps}\n`);
    process.stdout.write(`resolved stream: ${result.stream}\n`);
    process.stdout.write(`worker model: ${result.workerModel}\n`);
    process.stdout.write(`main model: ${result.mainModel}\n`);
    process.stdout.write(`steps: ${result.steps}\n`);

    if (result.evidence.length > 0) {
      process.stdout.write("evidence:\n");
      for (const item of result.evidence) {
        process.stdout.write(`- ${item}\n`);
      }
    }

    process.stdout.write("\nfinal:\n");
    process.stdout.write(result.summary + "\n");
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  process.stderr.write(`fatal> ${(error as Error).message}\n`);
  process.exit(1);
});

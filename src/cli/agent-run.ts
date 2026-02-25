import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadConfig } from "../config/env.js";
import { runAgentLoop } from "../runtime/agent-loop.js";
import { loadOrCreateSession } from "../runtime/session-store.js";
import type { AgentMode } from "../types/model.js";

interface Args {
  sessionId: string;
  goal: string;
  agentId: string;
  groupId?: string;
  mode?: AgentMode;
  maxSteps?: number;
  stream?: boolean;
}

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

async function main(): Promise<void> {
  const config = loadConfig();
  const args = parseArgs(process.argv.slice(2));
  const session = await loadOrCreateSession(config.sessionDir, args.sessionId, config.systemPrompt);
  const rl = createInterface({ input, output });

  process.stdout.write(`agent profile: ${args.agentId}\n`);
  process.stdout.write(`workspace group: ${args.groupId ?? session.id}\n`);
  process.stdout.write(`session: ${session.id}\n`);
  try {
    const result = await runAgentLoop(config, session, args.goal, args.agentId, {
      mode: args.mode,
      maxSteps: args.maxSteps,
      stream: args.stream,
      workspaceGroupId: args.groupId,
      askUser: async (question) => {
        process.stdout.write(`ask> ${question}\n`);
        return (await rl.question("answer(YES/NO)> ")).trim();
      },
    });

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

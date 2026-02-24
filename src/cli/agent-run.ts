import { loadConfig } from "../config/env.js";
import { runAgentLoop } from "../runtime/agent-loop.js";
import { loadOrCreateSession } from "../runtime/session-store.js";
import type { AgentMode } from "../models/role-router.js";

interface Args {
  sessionId: string;
  goal: string;
  mode: AgentMode;
  maxSteps: number;
}

function parseArgs(argv: string[]): Args {
  const sessionIdx = argv.indexOf("--session");
  const goalIdx = argv.indexOf("--goal");
  const modeIdx = argv.indexOf("--mode");
  const maxIdx = argv.indexOf("--max-steps");

  const sessionId = sessionIdx >= 0 && argv[sessionIdx + 1] ? argv[sessionIdx + 1] : "default";
  const goal = goalIdx >= 0 && argv[goalIdx + 1] ? argv[goalIdx + 1] : "";
  const modeRaw = modeIdx >= 0 && argv[modeIdx + 1] ? argv[modeIdx + 1] : "main-worker";
  const maxRaw = maxIdx >= 0 && argv[maxIdx + 1] ? argv[maxIdx + 1] : "3";

  if (!goal.trim()) {
    throw new Error("--goal is required");
  }

  const mode = modeRaw === "single-main" ? "single-main" : "main-worker";
  const maxSteps = Number.isFinite(Number(maxRaw)) ? Math.max(1, Number(maxRaw)) : 3;

  return { sessionId, goal, mode, maxSteps };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const args = parseArgs(process.argv.slice(2));
  const session = await loadOrCreateSession(config.sessionDir, args.sessionId, config.systemPrompt);

  process.stdout.write(`agent mode: ${args.mode}\n`);
  process.stdout.write(`session: ${session.id}\n`);

  const result = await runAgentLoop(config, session, args.goal, args.mode, args.maxSteps);

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
}

main().catch((error) => {
  process.stderr.write(`fatal> ${(error as Error).message}\n`);
  process.exit(1);
});

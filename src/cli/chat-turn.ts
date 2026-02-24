import { loadConfig } from "../config/env.js";
import { runTurn } from "../runtime/chat-service.js";
import { loadOrCreateSession } from "../runtime/session-store.js";

function parseArgs(argv: string[]): { sessionId: string; message: string } {
  const sessionIdx = argv.indexOf("--session");
  const msgIdx = argv.indexOf("--message");

  const sessionId = sessionIdx >= 0 && argv[sessionIdx + 1] ? argv[sessionIdx + 1] : "default";
  const message = msgIdx >= 0 && argv[msgIdx + 1] ? argv[msgIdx + 1] : "";

  if (!message.trim()) {
    throw new Error("--message is required");
  }

  return { sessionId, message };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const { sessionId, message } = parseArgs(process.argv.slice(2));

  const session = await loadOrCreateSession(config.sessionDir, sessionId, config.systemPrompt);
  const answer = await runTurn(config, session, message);

  process.stdout.write(answer + "\n");
}

main().catch((error) => {
  process.stderr.write(`fatal> ${(error as Error).message}\n`);
  process.exit(1);
});

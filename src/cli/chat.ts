import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadConfig } from "../config/env.js";
import { runTurn } from "../runtime/chat-service.js";
import { loadOrCreateSession, resetSession, saveSession } from "../runtime/session-store.js";

function parseArgs(argv: string[]): { sessionId: string } {
  const sessionIdx = argv.indexOf("--session");
  if (sessionIdx >= 0 && argv[sessionIdx + 1]) {
    return { sessionId: argv[sessionIdx + 1] };
  }
  return { sessionId: "default" };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const { sessionId } = parseArgs(process.argv.slice(2));

  let session = await loadOrCreateSession(config.sessionDir, sessionId, config.systemPrompt);

  const rl = readline.createInterface({ input, output });

  output.write(`session: ${session.id}\n`);
  output.write("commands: /exit, /reset, /show\n\n");

  while (true) {
    const line = (await rl.question("you> ")).trim();

    if (!line) {
      continue;
    }

    if (line === "/exit") {
      break;
    }

    if (line === "/reset") {
      session = await resetSession(config.sessionDir, session.id, config.systemPrompt);
      output.write("session reset complete\n");
      continue;
    }

    if (line === "/show") {
      output.write(JSON.stringify(session.messages, null, 2) + "\n");
      continue;
    }

    try {
      const answer = await runTurn(config, session, line);
      output.write(`assistant> ${answer}\n\n`);
    } catch (error) {
      output.write(`error> ${(error as Error).message}\n\n`);
      await saveSession(config.sessionDir, session);
    }
  }

  rl.close();
}

main().catch((error) => {
  process.stderr.write(`fatal> ${(error as Error).message}\n`);
  process.exit(1);
});

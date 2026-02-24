import { loadConfig } from "../config/env.js";
import { listCandidates, loadModelRegistry } from "../models/profile-registry.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const registry = await loadModelRegistry(config.modelProfilesPath);

  process.stdout.write(`model profiles file: ${config.modelProfilesPath}\n\n`);

  process.stdout.write("profiles:\n");
  process.stdout.write(`- main: ${registry.profiles.main.candidateIds.join(", ")}\n`);
  process.stdout.write(`- worker: ${registry.profiles.worker.candidateIds.join(", ")}\n`);
  process.stdout.write(`- single: ${registry.profiles.single.candidateIds.join(", ")}\n\n`);

  process.stdout.write("candidates:\n");
  for (const row of listCandidates(registry)) {
    process.stdout.write(`- ${row.id} [${row.provider}] model=${row.modelRef}`);
    if (row.note) {
      process.stdout.write(` :: ${row.note}`);
    }
    process.stdout.write("\n");
  }
}

main().catch((error) => {
  process.stderr.write(`fatal> ${(error as Error).message}\n`);
  process.exit(1);
});

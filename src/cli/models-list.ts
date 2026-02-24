import { loadConfig } from "../config/env.js";
import { listAgents, listModels, listServers, loadModelRegistry } from "../models/profile-registry.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const registry = await loadModelRegistry(config.modelProfilesPath);

  process.stdout.write(`model config file: ${config.modelProfilesPath}\n\n`);

  process.stdout.write("servers:\n");
  for (const server of listServers(registry)) {
    process.stdout.write(`- ${server.id} [${server.provider}]`);
    if (server.description) {
      process.stdout.write(` :: ${server.description}`);
    }
    process.stdout.write("\n");
  }

  process.stdout.write("\nmodels:\n");
  for (const model of listModels(registry)) {
    process.stdout.write(`- ${model.id} server=${model.serverId} model=${model.modelRef}`);
    if (model.description) {
      process.stdout.write(` :: ${model.description}`);
    }
    process.stdout.write("\n");
  }

  process.stdout.write("\nagents:\n");
  for (const agent of listAgents(registry)) {
    process.stdout.write(`- ${agent.id} mode=${agent.value.mode} main=${agent.value.mainModelId}`);
    if (agent.value.workerModelId) {
      process.stdout.write(` worker=${agent.value.workerModelId}`);
    }
    if (typeof agent.value.maxSteps === "number") {
      process.stdout.write(` maxSteps=${agent.value.maxSteps}`);
    }
    if (typeof agent.value.stream === "boolean") {
      process.stdout.write(` stream=${agent.value.stream}`);
    }
    if (agent.value.description) {
      process.stdout.write(` :: ${agent.value.description}`);
    }
    process.stdout.write("\n");
  }
}

main().catch((error) => {
  process.stderr.write(`fatal> ${(error as Error).message}\n`);
  process.exit(1);
});

import { config as loadDotenv } from "dotenv";

loadDotenv();

function getNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || !raw.trim()) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw || !raw.trim()) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function getBooleanEnvAliases(names: string[], fallback: boolean): boolean {
  for (const name of names) {
    const raw = process.env[name];
    if (!raw || !raw.trim()) {
      continue;
    }
    const normalized = raw.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return fallback;
}

function getStringEnvAliases(names: string[], fallback: string): string {
  for (const name of names) {
    const raw = process.env[name];
    if (raw && raw.trim()) {
      return raw.trim();
    }
  }
  return fallback;
}

export interface AppConfig {
  openaiBaseUrl?: string;
  openaiApiKey?: string;
  openaiModel?: string;
  systemPrompt?: string;
  sessionDir: string;
  modelProfilesPath: string;
  chatAgentId: string;
  chatModelId?: string;
  toolSandboxMode: "local" | "docker";
  toolShellPath: string;
  dockerShellPath: string;
  toolTimeoutMs: number;
  toolMaxBufferBytes: number;
  toolMaxPipes: number;
  dockerSandboxImage: string;
  dockerWorkspaceRoot: string;
  dockerContainerPrefix: string;
  dockerNetwork: string;
  dockerMemory: string;
  dockerCpus: string;
  dockerPidsLimit: number;
  dockerRequiredTools: string[];
  dockerWorkspaceInitCommand?: string;
  workerEnableThinking: boolean;
  workerThinkingPrefillTag: string;
  workerMaxResponseTokens: number;
  workerActionMaxRetries: number;
  debugLlmRequests: boolean;
  mainDecisionEnableThinking: boolean;
  mainDecisionThinkingPrefillTag: string;
}

export function loadConfig(): AppConfig {
  const dockerRequiredToolsRaw =
    process.env.DOCKER_REQUIRED_TOOLS?.trim() ||
    "sh,ls,cat,echo,grep,sed,awk,find,head,tail,wc,pwd,rg,jq,git,python3";
  const dockerRequiredTools = dockerRequiredToolsRaw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return {
    openaiBaseUrl: process.env.OPENAI_BASE_URL?.trim() || undefined,
    openaiApiKey: process.env.OPENAI_API_KEY?.trim() || undefined,
    openaiModel: process.env.OPENAI_MODEL?.trim() || undefined,
    systemPrompt: process.env.SYSTEM_PROMPT?.trim() || undefined,
    sessionDir: process.env.SESSION_DIR?.trim() || "./data/sessions",
    modelProfilesPath: process.env.MODEL_PROFILES_PATH?.trim() || "./config/model-profiles.json",
    chatAgentId: process.env.CHAT_AGENT_ID?.trim() || "default",
    chatModelId: process.env.CHAT_MODEL_ID?.trim() || undefined,
    toolSandboxMode: process.env.TOOL_SANDBOX_MODE === "docker" ? "docker" : "local",
    toolShellPath: process.env.TOOL_SHELL_PATH?.trim() || "/bin/zsh",
    dockerShellPath: process.env.DOCKER_SHELL_PATH?.trim() || "/bin/sh",
    toolTimeoutMs: getNumberEnv("TOOL_TIMEOUT_MS", 20_000),
    toolMaxBufferBytes: getNumberEnv("TOOL_MAX_BUFFER_BYTES", 1024 * 1024),
    toolMaxPipes: Math.floor(getNumberEnv("TOOL_MAX_PIPES", 2)),
    dockerSandboxImage: process.env.DOCKER_SANDBOX_IMAGE?.trim() || "senaka-sandbox:bookworm",
    dockerWorkspaceRoot: process.env.DOCKER_WORKSPACE_ROOT?.trim() || "./data/workspaces",
    dockerContainerPrefix: process.env.DOCKER_CONTAINER_PREFIX?.trim() || "senaka-ws",
    dockerNetwork: process.env.DOCKER_NETWORK?.trim() || "none",
    dockerMemory: process.env.DOCKER_MEMORY?.trim() || "512m",
    dockerCpus: process.env.DOCKER_CPUS?.trim() || "1.0",
    dockerPidsLimit: Math.floor(getNumberEnv("DOCKER_PIDS_LIMIT", 256)),
    dockerRequiredTools,
    dockerWorkspaceInitCommand: process.env.DOCKER_WORKSPACE_INIT_COMMAND?.trim() || undefined,
    workerEnableThinking: getBooleanEnvAliases(
      ["WORKER_ENABLE_THINKING"],
      !getBooleanEnv("WORKER_DISABLE_THINKING_HACK", true),
    ),
    workerThinkingPrefillTag: getStringEnvAliases(
      ["WORKER_THINKING_PREFILL", "WORKER_THINK_BYPASS_TAG"],
      "<think></think>",
    ),
    workerMaxResponseTokens: Math.floor(getNumberEnv("WORKER_MAX_RESPONSE_TOKENS", 256)),
    workerActionMaxRetries: Math.floor(getNumberEnv("WORKER_ACTION_MAX_RETRIES", 6)),
    debugLlmRequests: getBooleanEnv("DEBUG_LLM_REQUESTS", false),
    mainDecisionEnableThinking: getBooleanEnvAliases(
      ["MAIN_DECISION_ENABLE_THINKING"],
      !getBooleanEnv("MAIN_DECISION_DISABLE_THINKING_HACK", true),
    ),
    mainDecisionThinkingPrefillTag: getStringEnvAliases(
      ["MAIN_DECISION_THINKING_PREFILL", "MAIN_DECISION_THINK_BYPASS_TAG"],
      "<think></think>",
    ),
  };
}

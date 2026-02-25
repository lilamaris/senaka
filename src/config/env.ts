import { config as loadDotenv } from "dotenv";

loadDotenv();

const required = ["OPENAI_BASE_URL", "OPENAI_API_KEY", "OPENAI_MODEL"] as const;

function getEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value || !value.trim()) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

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

export interface AppConfig {
  openaiBaseUrl: string;
  openaiApiKey: string;
  openaiModel: string;
  systemPrompt?: string;
  sessionDir: string;
  modelProfilesPath: string;
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
  workerDisableThinkingHack: boolean;
  workerThinkBypassTag: string;
  workerMaxResponseTokens: number;
  workerActionMaxRetries: number;
  debugLlmRequests: boolean;
  mainDecisionDisableThinkingHack: boolean;
  mainDecisionThinkBypassTag: string;
}

export function loadConfig(): AppConfig {
  for (const key of required) {
    if (!process.env[key] || !String(process.env[key]).trim()) {
      throw new Error(`Missing required env var: ${key}`);
    }
  }

  return {
    openaiBaseUrl: getEnv("OPENAI_BASE_URL"),
    openaiApiKey: getEnv("OPENAI_API_KEY"),
    openaiModel: getEnv("OPENAI_MODEL"),
    systemPrompt: process.env.SYSTEM_PROMPT?.trim() || undefined,
    sessionDir: process.env.SESSION_DIR?.trim() || "./data/sessions",
    modelProfilesPath: process.env.MODEL_PROFILES_PATH?.trim() || "./config/model-profiles.json",
    toolSandboxMode: process.env.TOOL_SANDBOX_MODE === "docker" ? "docker" : "local",
    toolShellPath: process.env.TOOL_SHELL_PATH?.trim() || "/bin/zsh",
    dockerShellPath: process.env.DOCKER_SHELL_PATH?.trim() || "/bin/sh",
    toolTimeoutMs: getNumberEnv("TOOL_TIMEOUT_MS", 20_000),
    toolMaxBufferBytes: getNumberEnv("TOOL_MAX_BUFFER_BYTES", 1024 * 1024),
    toolMaxPipes: Math.floor(getNumberEnv("TOOL_MAX_PIPES", 2)),
    dockerSandboxImage: process.env.DOCKER_SANDBOX_IMAGE?.trim() || "node:22-bookworm-slim",
    dockerWorkspaceRoot: process.env.DOCKER_WORKSPACE_ROOT?.trim() || "./data/workspaces",
    dockerContainerPrefix: process.env.DOCKER_CONTAINER_PREFIX?.trim() || "senaka-ws",
    dockerNetwork: process.env.DOCKER_NETWORK?.trim() || "none",
    dockerMemory: process.env.DOCKER_MEMORY?.trim() || "512m",
    dockerCpus: process.env.DOCKER_CPUS?.trim() || "1.0",
    dockerPidsLimit: Math.floor(getNumberEnv("DOCKER_PIDS_LIMIT", 256)),
    workerDisableThinkingHack: getBooleanEnv("WORKER_DISABLE_THINKING_HACK", true),
    workerThinkBypassTag: process.env.WORKER_THINK_BYPASS_TAG?.trim() || "<think></think>",
    workerMaxResponseTokens: Math.floor(getNumberEnv("WORKER_MAX_RESPONSE_TOKENS", 256)),
    workerActionMaxRetries: Math.floor(getNumberEnv("WORKER_ACTION_MAX_RETRIES", 6)),
    debugLlmRequests: getBooleanEnv("DEBUG_LLM_REQUESTS", false),
    mainDecisionDisableThinkingHack: getBooleanEnv("MAIN_DECISION_DISABLE_THINKING_HACK", true),
    mainDecisionThinkBypassTag: process.env.MAIN_DECISION_THINK_BYPASS_TAG?.trim() || "<think></think>",
  };
}

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

export interface AppConfig {
  openaiBaseUrl: string;
  openaiApiKey: string;
  openaiModel: string;
  systemPrompt?: string;
  sessionDir: string;
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
  };
}

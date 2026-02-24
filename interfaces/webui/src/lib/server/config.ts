import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from './types';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../../../');
const rootEnvPath = path.join(repoRoot, '.env');

function hydrateEnvFromRootFile(): void {
  try {
    const raw = readFileSync(rootEnvPath, 'utf-8');
    const lines = raw.split(/\r?\n/);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      const idx = trimmed.indexOf('=');
      if (idx < 0) {
        continue;
      }

      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env file is optional; missing keys are validated below.
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export function loadConfig(): AppConfig {
  hydrateEnvFromRootFile();
  const sessionDir = process.env.SESSION_DIR?.trim() || path.join(repoRoot, 'data/sessions');

  return {
    openaiBaseUrl: required('OPENAI_BASE_URL').replace(/\/$/, ''),
    openaiApiKey: required('OPENAI_API_KEY'),
    openaiModel: required('OPENAI_MODEL'),
    systemPrompt: process.env.SYSTEM_PROMPT?.trim() || undefined,
    sessionDir
  };
}

export interface ModelLoadOption {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  minP?: number;
  topK?: number;
  extraBody?: Record<string, unknown>;
  disableThinkingHack?: boolean;
  thinkBypassTag?: string;
}

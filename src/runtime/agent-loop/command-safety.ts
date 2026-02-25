/**
 * 파일 목적:
 * - worker shell 명령의 안전성 검증을 담당한다.
 *
 * 주요 의존성:
 * - 없음(순수 문자열 파싱 유틸)
 *
 * 역의존성:
 * - src/runtime/agent-loop/llm.ts
 *
 * 모듈 흐름:
 * 1) shell 문자열을 토큰/세그먼트 단위로 파싱
 * 2) 파이프 개수 제한 검증
 * 3) 금지 명령(실행 파일/하위 명령) 차단
 */

const FORBIDDEN_EXECUTABLES = new Set([
  "rm",
  "dd",
  "mkfs",
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "kill",
  "pkill",
  "del",
  "erase",
]);

const WRAPPER_EXECUTABLES = new Set(["sudo", "command", "nohup", "time"]);

interface ParsedSegment {
  raw: string;
  tokens: string[];
}

function basenameToken(token: string): string {
  const normalized = token.replace(/\\/g, "/");
  const parts = normalized.split("/");
  return (parts[parts.length - 1] || "").trim().toLowerCase();
}

function tokenizeShellWords(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const pushCurrent = (): void => {
    const value = current.trim();
    if (value) {
      tokens.push(value);
    }
    current = "";
  };

  for (let idx = 0; idx < input.length; idx += 1) {
    const ch = input[idx];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      pushCurrent();
      continue;
    }

    current += ch;
  }

  pushCurrent();
  return tokens;
}

function splitSegments(cmd: string): ParsedSegment[] {
  const segments: ParsedSegment[] = [];
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let current = "";

  const pushSegment = (): void => {
    const raw = current.trim();
    current = "";
    if (!raw) {
      return;
    }
    segments.push({ raw, tokens: tokenizeShellWords(raw) });
  };

  for (let idx = 0; idx < cmd.length; idx += 1) {
    const ch = cmd[idx];
    const next = cmd[idx + 1];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      current += ch;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      }
      current += ch;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }

    const isDoubleOp = (ch === "&" && next === "&") || (ch === "|" && next === "|");
    const isSingleSeparator = ch === ";" || ch === "\n" || ch === "\r" || ch === "|" || ch === "&";
    if (isDoubleOp) {
      pushSegment();
      idx += 1;
      continue;
    }
    if (isSingleSeparator) {
      pushSegment();
      continue;
    }

    current += ch;
  }

  pushSegment();
  return segments;
}

function countPipes(cmd: string): number {
  let pipes = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let idx = 0; idx < cmd.length; idx += 1) {
    const ch = cmd[idx];
    const next = cmd[idx + 1];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (ch === "|" && next !== "|") {
      pipes += 1;
    }
  }

  return pipes;
}

function extractExecutableInfo(tokens: string[]): { executable?: string; argIndex: number } {
  let idx = 0;

  // KEY=VALUE prefix는 실제 실행 파일이 아니므로 건너뛴다.
  while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[idx])) {
    idx += 1;
  }

  while (idx < tokens.length) {
    const token = tokens[idx];
    const executable = basenameToken(token);

    if (WRAPPER_EXECUTABLES.has(executable)) {
      idx += 1;
      continue;
    }
    if (executable === "env") {
      idx += 1;
      while (idx < tokens.length && (tokens[idx].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[idx]))) {
        idx += 1;
      }
      continue;
    }

    return { executable, argIndex: idx + 1 };
  }

  return { executable: undefined, argIndex: idx };
}

function findFirstSubcommand(tokens: string[], startIndex: number): string | undefined {
  for (let idx = startIndex; idx < tokens.length; idx += 1) {
    const token = tokens[idx].trim();
    if (!token || token.startsWith("-")) {
      continue;
    }
    return basenameToken(token);
  }
  return undefined;
}

/**
 * worker shell 명령 안전성 검증.
 * - 파이프 수 제한
 * - 금지 실행 파일/하위 명령 차단
 */
export function validateCommandSafety(cmd: string, maxPipes: number): void {
  const trimmed = cmd.trim();
  if (!trimmed) {
    throw new Error("unsafe command blocked: empty command");
  }

  const pipeCount = countPipes(trimmed);
  if (pipeCount > maxPipes) {
    throw new Error(`worker command can include at most ${maxPipes} pipe(s)`);
  }

  const segments = splitSegments(trimmed);
  for (const segment of segments) {
    const { executable, argIndex } = extractExecutableInfo(segment.tokens);
    if (!executable) {
      continue;
    }

    if (FORBIDDEN_EXECUTABLES.has(executable)) {
      throw new Error(`unsafe command blocked: ${executable}`);
    }

    if (executable === "git") {
      const sub = findFirstSubcommand(segment.tokens, argIndex);
      if (sub === "push") {
        throw new Error("unsafe command blocked: git push");
      }
    }
  }
}

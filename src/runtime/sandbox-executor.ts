import { exec, execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export interface SandboxExecutorOptions {
  mode: "local" | "docker";
  timeoutMs: number;
  maxBufferBytes: number;
  shellPath: string;
  dockerShellPath: string;
  dockerImage: string;
  dockerWorkspaceRoot: string;
  dockerContainerPrefix: string;
  dockerNetwork: string;
  dockerMemory: string;
  dockerCpus: string;
  dockerPidsLimit: number;
  dockerRequiredTools: string[];
  dockerWorkspaceInitCommand?: string;
}

export interface SandboxCommandResult {
  cmd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  runner: "local" | "docker";
  workspaceGroupId: string;
}

interface DockerWorkspace {
  groupId: string;
  containerName: string;
  hostWorkspacePath: string;
}

function sanitizeGroupId(groupId: string): string {
  const raw = groupId.trim().toLowerCase() || "default";
  const cleaned = raw
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  return cleaned || "default";
}

function containerNameFor(prefix: string, groupId: string): string {
  const sanitized = sanitizeGroupId(groupId);
  const trimmedPrefix = prefix.trim() || "senaka-ws";
  return `${trimmedPrefix}-${sanitized}`;
}

function toSingleQuotedShell(text: string): string {
  return `'${text.replace(/'/g, `'\"'\"'`)}'`;
}

function sanitizeToolName(tool: string): string | undefined {
  const trimmed = tool.trim();
  if (!trimmed) {
    return undefined;
  }
  return /^[a-zA-Z0-9._+-]+$/.test(trimmed) ? trimmed : undefined;
}

async function verifyDockerTools(
  opts: SandboxExecutorOptions,
  containerName: string,
): Promise<void> {
  const tools = opts.dockerRequiredTools
    .map(sanitizeToolName)
    .filter((value): value is string => !!value);
  if (tools.length === 0) {
    return;
  }

  const toolArgs = tools.map((tool) => toSingleQuotedShell(tool)).join(" ");
  const checkScript = [
    "missing=''",
    `for cmd in ${toolArgs}; do`,
    '  command -v "$cmd" >/dev/null 2>&1 || missing="$missing $cmd"',
    "done",
    'if [ -n "$missing" ]; then',
    '  echo "$missing"',
    "  exit 2",
    "fi",
  ].join("\n");

  try {
    await execFileAsync(
      "docker",
      [
        "exec",
        "-i",
        "-w",
        "/workspace",
        containerName,
        opts.dockerShellPath,
        "-lc",
        checkScript,
      ],
      { timeout: 20_000, maxBuffer: 256 * 1024 },
    );
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message: string };
    const missing = (err.stdout || err.stderr || "")
      .trim()
      .replace(/\s+/g, ", ");
    throw new Error(
      `docker sandbox image is missing required tools (${missing || "unknown"}). image=${opts.dockerImage}`,
    );
  }
}

async function runDockerWorkspaceInit(
  opts: SandboxExecutorOptions,
  containerName: string,
): Promise<void> {
  const initCommand = opts.dockerWorkspaceInitCommand?.trim();
  if (!initCommand) {
    return;
  }

  const marker = "/workspace/.senaka/init.done";
  const initScript = [
    "set -e",
    `if [ ! -f ${toSingleQuotedShell(marker)} ]; then`,
    `  mkdir -p ${toSingleQuotedShell(path.posix.dirname(marker))}`,
    `  ${initCommand}`,
    `  touch ${toSingleQuotedShell(marker)}`,
    "fi",
  ].join("\n");

  await execFileAsync(
    "docker",
    [
      "exec",
      "-i",
      "-w",
      "/workspace",
      containerName,
      opts.dockerShellPath,
      "-lc",
      initScript,
    ],
    { timeout: 60_000, maxBuffer: 1024 * 1024 },
  );
}

async function dockerContainerExists(containerName: string): Promise<boolean> {
  try {
    await execFileAsync("docker", ["inspect", containerName], {
      timeout: 10_000,
      maxBuffer: 256 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

async function dockerContainerRunning(containerName: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["inspect", "-f", "{{.State.Running}}", containerName],
      {
        timeout: 10_000,
        maxBuffer: 256 * 1024,
      },
    );
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

async function ensureDockerWorkspace(
  opts: SandboxExecutorOptions,
  rawGroupId: string,
): Promise<DockerWorkspace> {
  const groupId = sanitizeGroupId(rawGroupId);
  const containerName = containerNameFor(opts.dockerContainerPrefix, groupId);
  const hostWorkspacePath = path.resolve(opts.dockerWorkspaceRoot, groupId);
  await mkdir(hostWorkspacePath, { recursive: true });

  const exists = await dockerContainerExists(containerName);
  if (!exists) {
    const runArgs = [
      "run",
      "-d",
      "--name",
      containerName,
      "--restart",
      "unless-stopped",
      "--read-only",
      "--security-opt",
      "no-new-privileges",
      "--cap-drop",
      "ALL",
      "--network",
      opts.dockerNetwork,
      "--memory",
      opts.dockerMemory,
      "--cpus",
      opts.dockerCpus,
      "--pids-limit",
      String(opts.dockerPidsLimit),
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=64m",
      "--tmpfs",
      "/run:rw,noexec,nosuid,size=16m",
      "-v",
      `${hostWorkspacePath}:/workspace`,
      "-w",
      "/workspace",
      opts.dockerImage,
      "sleep",
      "infinity",
    ];
    await execFileAsync("docker", runArgs, {
      timeout: 30_000,
      maxBuffer: 512 * 1024,
    });
  } else {
    const running = await dockerContainerRunning(containerName);
    if (!running) {
      await execFileAsync("docker", ["start", containerName], {
        timeout: 20_000,
        maxBuffer: 256 * 1024,
      });
    }
  }

  await verifyDockerTools(opts, containerName);
  await runDockerWorkspaceInit(opts, containerName);

  return { groupId, containerName, hostWorkspacePath };
}

function normalizeText(value: string, maxLen: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLen) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLen)}\n...[truncated ${trimmed.length - maxLen} chars]`;
}

export async function runInSandbox(
  cmd: string,
  rawGroupId: string,
  options: SandboxExecutorOptions,
): Promise<SandboxCommandResult> {
  const workspaceGroupId = sanitizeGroupId(rawGroupId);
  if (options.mode === "local") {
    try {
      const { stdout, stderr } = await execAsync(cmd, {
        timeout: options.timeoutMs,
        maxBuffer: options.maxBufferBytes,
        shell: options.shellPath,
      });
      return {
        cmd,
        exitCode: 0,
        stdout: normalizeText(stdout, 12_000),
        stderr: normalizeText(stderr, 12_000),
        runner: "local",
        workspaceGroupId,
      };
    } catch (error) {
      const err = error as {
        code?: number;
        stdout?: string;
        stderr?: string;
        message: string;
      };
      return {
        cmd,
        exitCode: typeof err.code === "number" ? err.code : 1,
        stdout: normalizeText(err.stdout ?? "", 12_000),
        stderr: normalizeText(err.stderr ?? err.message, 12_000),
        runner: "local",
        workspaceGroupId,
      };
    }
  }

  try {
    const workspace = await ensureDockerWorkspace(options, rawGroupId);
    const { stdout, stderr } = await execFileAsync(
      "docker",
      [
        "exec",
        "-i",
        "-w",
        "/workspace",
        workspace.containerName,
        options.dockerShellPath,
        "-lc",
        cmd,
      ],
      {
        timeout: options.timeoutMs,
        maxBuffer: options.maxBufferBytes,
      },
    );
    return {
      cmd,
      exitCode: 0,
      stdout: normalizeText(stdout, 12_000),
      stderr: normalizeText(stderr, 12_000),
      runner: "docker",
      workspaceGroupId: workspace.groupId,
    };
  } catch (error) {
    const err = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
      message: string;
    };
    return {
      cmd,
      exitCode: typeof err.code === "number" ? err.code : 1,
      stdout: normalizeText(err.stdout ?? "", 12_000),
      stderr: normalizeText(err.stderr ?? err.message, 12_000),
      runner: "docker",
      workspaceGroupId,
    };
  }
}

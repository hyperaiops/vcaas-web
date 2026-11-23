// Local agent transport (PI_RUNTIME_MODE=local, development only).
//
// Spawns the local `pi` binary in RPC mode against the workspace directory on
// the local disk, using the same JSONL protocol as the production PiWorker
// bridge: inbound JSON objects become one stdin line; each stdout line is one
// event frame. The LiteLLM API key is written to a private 0600 file and
// passed by path only — never in argv or the regular child environment.
import "server-only";
import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { mkdtemp, mkdir, writeFile, rm, stat, lstat, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { getWorkspace } from "@/app/lib/db";
import { BridgeLifecycleError } from "./runtime";
import { inspectSession, latestSession, stillRecent, type LocalSession } from "./local-sessions";

const KILL_GRACE_MS = 5_000;

function badConfig(message: string): never {
  throw new BridgeLifecycleError(500, "BAD_CONFIG", message);
}

export class LocalPiTransport {
  private child: ChildProcess;
  private tempDir: string;
  private stopped: Promise<void>;
  private termination?: Promise<void>;
  private buffer = "";
  private decoder = new StringDecoder("utf8");

  private constructor(child: ChildProcess, tempDir: string, readonly cwd: string, readonly sessionDir: string) {
    this.child = child;
    this.tempDir = tempDir;
    // A failed Pi startup can close stdin while an RPC is being written.
    child.stdin?.on("error", () => {});
    this.stopped = new Promise((resolve) => {
      const finish = async () => {
        await rm(tempDir, { recursive: true, force: true });
        resolve();
      };
      child.once("close", () => void finish());
      child.once("error", () => void finish());
    });
  }

  static async spawn(workspaceId: string, signal?: AbortSignal): Promise<LocalPiTransport> {
    signal?.throwIfAborted();
    if (process.env.NODE_ENV === "production") {
      badConfig("Local agent mode is forbidden in production.");
    }
    const bin = process.env.PI_BIN || "pi";
    const baseURL = process.env.PI_LITELLM_BASE_URL;
    const apiKey = process.env.PI_LITELLM_API_KEY;
    const model = process.env.PI_LITELLM_MODEL ?? "glm-5.3-flash";
    if (!baseURL || !apiKey) {
      badConfig("PI_LITELLM_BASE_URL and PI_LITELLM_API_KEY are required for the local agent.");
    }
    const workspace = getWorkspace(workspaceId);
    if (!workspace) badConfig(`Unknown workspace: ${workspaceId}`);
    const root = await realpath(workspace.rootPath).catch(() => null);
    if (!root || !(await stat(root).catch(() => null))?.isDirectory()) {
      badConfig(`Workspace directory is unavailable: ${workspaceId}`);
    }
    const configuredRoot = process.env.PI_LOCAL_SESSION_ROOT ?? path.join(homedir(), ".pi", "agent", "sessions");
    const sessionRoot = path.resolve(configuredRoot.startsWith("~/") ? path.join(homedir(), configuredRoot.slice(2)) : configuredRoot);
    const encodedCwd = `--${root.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    const sessionDir = path.join(sessionRoot, encodedCwd);
    const recent = await latestSession(sessionDir, root);
    // Older Pi sessions can be rewritten during migration; require an explicit restore.
    const resume = recent?.version === 3 && await stillRecent(recent, root) ? recent.file : null;
    signal?.throwIfAborted();

    const tempDir = await mkdtemp(path.join(tmpdir(), "pi-agent-key-"));
    const keyPath = path.join(tempDir, "api-key");
    const agentDir = path.join(tempDir, "agent");
    try {
      await mkdir(agentDir, { mode: 0o700 });
      await writeFile(keyPath, apiKey, { mode: 0o600 });
      await writeFile(path.join(agentDir, "models.json"), JSON.stringify({
        providers: { litellm: {
          baseUrl: baseURL,
          api: "openai-completions",
          apiKey: '!cat "$PI_LITELLM_API_KEY_FILE"',
          authHeader: true,
          models: [{ id: model, reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 16384 }],
        } },
      }), { mode: 0o600 });

      // The child reads the key from the file path only; strip the raw key and
      // the server-side auth secrets from the inherited environment.
      const env = { ...process.env };
      delete env.PI_LITELLM_API_KEY;
      delete env.AUTH_CLIENT_SECRET;
      delete env.AUTH_SESSION_KEY;
      delete env.PI_CODING_AGENT_DIR;
      delete env.PI_CODING_AGENT_SESSION_DIR;
      const child = spawn(/* turbopackIgnore: true */ bin, [
        "--mode", "rpc",
        "--session-dir", sessionDir,
        ...(resume ? ["--session", resume] : []),
        "--provider", "litellm",
        "--model", model,
      ], {
        cwd: root,
        env: {
          ...env,
          HOME: tempDir,
          PI_CODING_AGENT_DIR: agentDir,
          PI_LITELLM_BASE_URL: baseURL,
          PI_LITELLM_MODEL: model,
          PI_LITELLM_API_KEY_FILE: keyPath,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const transport = new LocalPiTransport(child, tempDir, root, sessionDir);
      child.once("spawn", () => {
        if (signal?.aborted) void transport.terminate();
      });
      signal?.addEventListener("abort", () => void transport.terminate(), { once: true });
      return transport;
    } catch (err) {
      await rm(tempDir, { recursive: true, force: true });
      if (err instanceof BridgeLifecycleError) throw err;
      badConfig(`Failed to start the local agent (${bin}). Check PI_BIN and the pi installation.`);
    }
  }

  recentSession(exclude?: string | null): Promise<LocalSession | null> {
    return latestSession(this.sessionDir, this.cwd, exclude);
  }

  canRestore(session: LocalSession): Promise<boolean> {
    return stillRecent(session, this.cwd);
  }

  async refreshSession(session: LocalSession): Promise<LocalSession | null> {
    const current = await inspectSession(session.file, this.cwd);
    return current && current.dev === session.dev && current.ino === session.ino ? current : null;
  }

  async isPersisted(file: unknown): Promise<boolean> {
    if (typeof file !== "string" || path.dirname(file) !== this.sessionDir) return false;
    return (await lstat(file).catch(() => null))?.isFile() ?? false;
  }

  onMessage(listener: (frame: string) => void): void {
    this.child.stdout!.on("data", (chunk: Buffer) => {
      this.buffer += this.decoder.write(chunk);
      let index = this.buffer.indexOf("\n");
      while (index >= 0) {
        let line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line.length > 0) listener(line);
        index = this.buffer.indexOf("\n");
      }
    });
  }

  onStderr(listener: (line: string) => void): void {
    this.child.stderr!.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (line.length > 0) listener(line);
      }
    });
  }

  onClose(listener: () => void): void {
    void this.stopped.then(listener);
  }

  send(frame: string): void {
    if (!this.child.stdin?.writable) {
      throw new BridgeLifecycleError(503, "AGENT_CLOSED", "Local agent is not running.");
    }
    this.child.stdin.write(frame + "\n");
  }

  terminate(): Promise<void> {
    return this.termination ??= this.stop();
  }

  private async stop(): Promise<void> {
    try { this.child.stdin?.end(); } catch { /* already closed */ }
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      await this.stopped;
      return;
    }
    try { this.child.kill("SIGINT"); } catch { /* already gone */ }
    const killer = setTimeout(() => {
      try { this.child.kill("SIGKILL"); } catch { /* already gone */ }
    }, KILL_GRACE_MS);
    killer.unref?.();
    await this.stopped;
    clearTimeout(killer);
  }
}

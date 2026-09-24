import { spawn } from "node:child_process";
import { getWorkspace } from "@/app/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The pi CLI runs against a workspace managed by SQLite. The active workspace
// id comes from the request body; we resolve its on-disk root from the DB.
// PI_WORKSPACE_ROOT remains as a fallback for environments without a DB.
const PI_WORKSPACE_ROOT = process.env.PI_WORKSPACE_ROOT;
const PI_BIN = process.env.PI_BIN ?? "pi";

const SYSTEM_PROMPT = [
  "You are PI, a coding agent embedded in a WebContainer IDE.",
  "The user describes changes; you apply them directly to the project in the",
  "current working directory using your tools (write, edit, bash).",
  "Keep replies short: one or two sentences summarizing what you changed.",
].join(" ");

type PiEvent = {
  type: string;
  assistantMessageEvent?: { type: string; contentIndex?: number; delta?: string };
};

/** Runs `pi -p --mode json` and streams assistant text deltas. */
function streamPi(prompt: string, abort: AbortSignal, cwd: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const child = spawn(
        PI_BIN,
        ["-p", "--mode", "json", "--no-session", "--append-system-prompt", SYSTEM_PROMPT, prompt],
        { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
      );

      // Kill the pi process if the client disconnects (e.g. page reload,
      // HMR remount) — otherwise it keeps running until the LLM finishes.
      abort.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });

      let buffer = "";
      let closed = false;
      const close = () => {
        if (!closed) {
          closed = true;
          controller.close();
        }
      };
      // Both "error" and "close" can fire for the same failure — enqueue only
      // while the stream is still open.
      const send = (text: string) => {
        if (!closed) controller.enqueue(encoder.encode(text));
      };

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        // pi emits one JSON event per line.
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          let event: PiEvent;
          try {
            event = JSON.parse(line) as PiEvent;
          } catch {
            continue;
          }
          if (
            event.type === "message_update" &&
            event.assistantMessageEvent?.type === "text_delta" &&
            typeof event.assistantMessageEvent.delta === "string"
          ) {
            send(event.assistantMessageEvent.delta);
          }
        }
      });

      child.on("error", (error) => {
        send(`\n[pi failed to start: ${error.message}]`);
        close();
      });

      child.on("close", (code) => {
        if (code !== 0) {
          send(`\n[pi exited with code ${code}]`);
        }
        close();
      });
    },
  });
}

export async function POST(request: Request) {
  let message = "";
  let workspaceId: string | null = null;
  try {
    const body = await request.json();
    message = typeof body?.message === "string" ? body.message : "";
    workspaceId = typeof body?.workspaceId === "string" ? body.workspaceId : null;
  } catch {
    message = "";
  }

  if (!message.trim()) {
    return new Response(
      "Hi! I'm PI. Describe the change you want and I'll edit the project files directly.",
      { headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }

  // Resolve the on-disk root for the selected workspace. Falls back to the
  // PI_WORKSPACE_ROOT env var when no workspace is selected (or unknown).
  let cwd = PI_WORKSPACE_ROOT ?? process.cwd();
  if (workspaceId) {
    const workspace = getWorkspace(workspaceId);
    if (workspace) cwd = workspace.rootPath;
  }

  return new Response(streamPi(message, request.signal, cwd), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

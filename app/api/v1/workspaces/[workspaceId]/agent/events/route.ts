// GET /api/v1/workspaces/[workspaceId]/agent/events
//
// Server-Sent Events stream of agent JSONL frames. The server holds the ws to
// the agent (opened by /agent/start) and fans each outbound Pi event out to
// every SSE subscriber here. Each frame is sent as one `data:` line (the raw
// JSON object, like the bridge itself emits). The browser parses
// message_update/text_delta deltas.

import { subscribe, ensureAgentSession, finishPrompt } from "@/app/lib/bridge/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ workspaceId: string }> };

export async function GET(_request: Request, { params }: Context) {
  const { workspaceId } = await params;
  // Make sure the server-side ws is open before streaming events.
  try {
    await ensureAgentSession(workspaceId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Agent unavailable: ${message}`, { status: 503 });
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (frame: string) => {
        // SSE: one event per frame. Splitting on newlines is unnecessary because
        // Pi JSONL frames are single-line JSON objects.
        try {
          controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
        } catch {
          // controller closed (client disconnected).
        }
      };
      const unsubscribe = subscribe(workspaceId, send);

      // Keep-alive comment so proxies don't drop an idle stream while the
      // agent runs a long tool call.
      const keepalive = setInterval(() => {
        try { controller.enqueue(encoder.encode(`: keepalive\n\n`)); } catch { /* closed */ }
      }, 15000);

      _request.signal.addEventListener("abort", () => {
        clearInterval(keepalive);
        unsubscribe();
        finishPrompt(workspaceId);
        try { controller.close(); } catch { /* already closed */ }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

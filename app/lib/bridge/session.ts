// Per-workspace agent session: holds a long-lived `ws` connection from this
// Next.js server to the PiWorker bridge's public /v1/rpc endpoint over the
// ingress-nginx port-forward, and bridges it to the browser over HTTP (POST
// prompts in, SSE event stream out).
//
// Why a server-side ws: the bridge is reachable only through a localhost
// port-forward of ingress-nginx (kubectl port-forward 8443:443). Browsers can't
// do the split TCP-target/SNI trick the `ws` + tls.createConnection method
// needs, so the server owns the WebSocket and proxies for the browser.
//
// Session model: one server-side ws per workspace id. Browser POSTs prompt
// commands here; the server forwards them as Pi JSONL frames. Agent stdout
// JSONL frames are buffered per workspace and drained by the SSE route. When
// the last SSE subscriber drops and no prompt is in flight, the ws is closed.

import "server-only";
import { randomUUID } from "node:crypto";
import tls from "node:tls";
import WebSocket from "ws";
import { ensurePiWorker } from "@/app/lib/bridge/k8s";

// When running OUTSIDE the cluster, the agent's public Ingress host is
// unreachable by DNS, so the server connects through a `kubectl port-forward`
// of ingress-nginx (localhost:8443) and splits TCP target (127.0.0.1:8443)
// from TLS SNI/Host (the agent's real host) via tls.createConnection. Set
// PI_INGRESS_FORWARD_HOST / PI_INGRESS_FORWARD_PORT to enable that mode.
// When unset (the in-cluster case), the server connects to the wss:// endpoint
// directly like a normal client — no SNI trick needed.
const FORWARD_HOST = process.env.PI_INGRESS_FORWARD_HOST ?? "";
const FORWARD_PORT = Number(process.env.PI_INGRESS_FORWARD_PORT ?? "0");
const USE_FORWARD = FORWARD_HOST !== "" && FORWARD_PORT > 0;

// One session per workspace: the ws to the agent + the SSE subscribers draining
// its frames. Buffering lets a late SSE subscriber catch the current response.
type Session = {
  ws: WebSocket | null;
  connecting: Promise<void> | null;
  endpoint: string;     // wss://pw-<host>.<domain>/v1/rpc (for SNI)
  token: string;
  // Outbound frames (agent → browser), fanned out to all SSE subscribers.
  outbound: string[];   // buffered frames not yet drained by any SSE client
  subscribers: Set<(frame: string) => void>;
  // Tracks an in-flight prompt so we know when the session is safe to idle-close.
  busy: boolean;
  idleTimer: NodeJS.Timeout | null;
};

const sessions = new Map<string, Session>();
const IDLE_TIMEOUT_MS = Number(process.env.PI_AGENT_IDLE_TIMEOUT_MS ?? "120_000");

export type AgentConnect = {
  endpoint: string;
  token: string;
};

/** Ensure the agent ws for a workspace is open; return its endpoint + token. */
export async function ensureAgentSession(workspaceId: string): Promise<AgentConnect> {
  let sess = sessions.get(workspaceId);
  if (sess && (sess.ws?.readyState === WebSocket.OPEN || sess.ws?.readyState === WebSocket.CONNECTING)) {
    if (sess.idleTimer) { clearTimeout(sess.idleTimer); sess.idleTimer = null; }
    return { endpoint: sess.endpoint, token: sess.token };
  }
  // (Re)start the session: ask k8s for the endpoint+token, then open the ws.
  const handle = await ensurePiWorker(workspaceId);
  sess = {
    ws: null,
    connecting: null,
    endpoint: handle.endpoint,
    token: handle.token,
    outbound: [],
    subscribers: new Set(),
    busy: false,
    idleTimer: null,
  };
  sessions.set(workspaceId, sess);
  sess.connecting = openWebSocket(workspaceId, sess, handle);
  await sess.connecting;
  return { endpoint: handle.endpoint, token: handle.token };
}

/** Send a Pi `prompt` command to the agent; the response streams to SSE subscribers. */
export async function sendPrompt(workspaceId: string, message: string): Promise<void> {
  const sess = sessions.get(workspaceId);
  if (!sess?.ws || sess.ws.readyState !== WebSocket.OPEN) {
    throw new Error("Agent session is not open. POST /agent/start first.");
  }
  if (sess.idleTimer) { clearTimeout(sess.idleTimer); sess.idleTimer = null; }
  sess.busy = true;
  const cmd = JSON.stringify({ id: `req-${randomUUID()}`, type: "prompt", message });
  sess.ws.send(cmd);
}

/** Subscribe to outbound agent frames. Returns an unsubscribe fn. */
export function subscribe(
  workspaceId: string,
  onFrame: (frame: string) => void,
): () => void {
  const sess = sessions.get(workspaceId);
  if (!sess) return () => {};
  if (sess.idleTimer) { clearTimeout(sess.idleTimer); sess.idleTimer = null; }
  sess.subscribers.add(onFrame);
  // Flush any buffered frames to the new subscriber.
  for (const frame of sess.outbound) onFrame(frame);
  return () => {
    sess.subscribers.delete(onFrame);
    if (sess.subscribers.size === 0) scheduleIdle(workspaceId, sess);
  };
}

/** Mark a prompt stream complete (called by the SSE route when the browser
 *  signals it's done, or on session close). */
export function finishPrompt(workspaceId: string): void {
  const sess = sessions.get(workspaceId);
  if (!sess) return;
  sess.busy = false;
  if (sess.subscribers.size === 0) scheduleIdle(workspaceId, sess);
}

// Open the ws to the bridge /v1/rpc. Outside the cluster this goes through the
// ingress port-forward with a split TCP-target/SNI connection; inside the
// cluster it connects to the wss:// endpoint directly.
//
// A freshly reconciled PiWorker can report Ready=True a moment before the
// ingress-nginx backend is routable, so the first ws connect can get a transient
// 502/503 from nginx. We retry the connect with backoff for up to WS_CONNECT_TIMEOUT_MS
// so a cold start doesn't surface as a hard error to the browser.
const WS_CONNECT_TIMEOUT_MS = Number(process.env.PI_WS_CONNECT_TIMEOUT_MS ?? "60_000");
const WS_CONNECT_BASE_DELAY_MS = 500;

function openWebSocket(workspaceId: string, sess: Session, handle: AgentConnect): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL(handle.endpoint); // wss://pw-<host>.<domain>/v1/rpc
    const host = url.host;                // pw-<host>.<domain> (SNI + Host)
    const path = `${url.pathname}?token=${encodeURIComponent(handle.token)}`;
    const wsUrl = `wss://${host}${path}`;

    const forwardOpts: WebSocket.ClientOptions = USE_FORWARD
      ? {
          createConnection: () =>
            tls.connect({
              host: FORWARD_HOST,    // TCP target: literal IP, no DNS
              port: FORWARD_PORT,
              servername: host,      // TLS SNI: what nginx routes on
              rejectUnauthorized: false, // port-forward has no valid cert
            }),
        }
      : {}; // in-cluster: connect to wss://host directly, normal TLS + DNS

    const deadline = Date.now() + WS_CONNECT_TIMEOUT_MS;
    let attempt = 0;

    const tryConnect = () => {
      const ws = new WebSocket(wsUrl, forwardOpts);
      sess.ws = ws;
      let settled = false;

      ws.on("open", () => { settled = true; resolve(); });
      ws.on("error", (err) => {
        if (settled) return;
        settled = true;
        console.error(`[agent:${workspaceId}] ws connect error (attempt ${attempt + 1}):`, err.message);
        // Tear down this ws so a retry starts clean.
        try { ws.removeAllListeners(); ws.close(); } catch { /* ignore */ }
        if (Date.now() > deadline) {
          reject(err);
          return;
        }
        // Backoff: 500ms, 1s, 2s, 4s, … capped at 8s. Absorbs the cold-start
        // window where nginx returns 503 before the pod is routable.
        const delay = Math.min(WS_CONNECT_BASE_DELAY_MS * 2 ** attempt, 8000);
        attempt++;
        setTimeout(() => { if (sessions.get(workspaceId) === sess) tryConnect(); else reject(new Error("session closed")); }, delay);
      });
      ws.on("message", (data) => {
        const frame = data.toString();
        // Fan out to SSE subscribers; buffer if none yet.
        if (sess.subscribers.size > 0) {
          for (const sub of sess.subscribers) sub(frame);
        } else {
          sess.outbound.push(frame);
        }
      });
      ws.on("close", () => {
        if (!settled) return; // connect-phase close handled by error/retry
        console.error(`[agent:${workspaceId}] ws closed`);
        const s = sessions.get(workspaceId);
        if (s) s.ws = null;
      });
    };

    tryConnect();
  });
}

function scheduleIdle(workspaceId: string, sess: Session): void {
  if (sess.busy || sess.subscribers.size > 0 || sess.idleTimer) return;
  sess.idleTimer = setTimeout(() => {
    closeSession(workspaceId, "idle timeout");
  }, IDLE_TIMEOUT_MS);
}

/** Close and drop a workspace's agent session. */
export function closeSession(workspaceId: string, reason = "manual"): void {
  const sess = sessions.get(workspaceId);
  if (!sess) return;
  if (sess.idleTimer) { clearTimeout(sess.idleTimer); sess.idleTimer = null; }
  try { sess.ws?.close(); } catch { /* ignore */ }
  sessions.delete(workspaceId);
  console.error(`[agent:${workspaceId}] session closed (${reason})`);
}

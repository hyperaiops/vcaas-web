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
// Per-workspace "establishing" lock: the in-flight ensureAgentSession promise.
// Without this, two concurrent /agent/start calls (React StrictMode double
// mount in dev, or a fast remount) both observe no session, both call
// ensurePiWorker, and both open a ws — the bridge is MaxSessions=1, so the
// second gets a 409 "agent busy" and the first ws is stranded with its slot
// never released. The lock makes concurrent callers await the same connect.
const establishing = new Map<string, Promise<AgentConnect>>();
const IDLE_TIMEOUT_MS = Number(process.env.PI_AGENT_IDLE_TIMEOUT_MS ?? "600_000"); // 10 min

export type AgentConnect = {
  endpoint: string;
  token: string;
};

/** Ensure the agent ws for a workspace is open; return its endpoint + token.
 *  Handles three cases:
 *   - ws open or mid-(re)connect: join the in-flight connect, return.
 *   - session exists but ws dropped (null) and no reconnect in flight: re-request
 *     the CR on the SAME session object (preserving live SSE subscribers) and
 *     reopen the ws. Never replaces an entry that still has subscribers.
 *   - no session at all: create one fresh.
 *  In all recovery cases the PiWorker CR is re-requested (recreated if it was
 *  deleted) so a recycled CR's stale endpoint/token never gets reused. */
export async function ensureAgentSession(workspaceId: string): Promise<AgentConnect> {
  let sess = sessions.get(workspaceId);
  // Already open, or mid-(re)connect (including a reconnect scheduled after a
  // drop): join the in-flight connect rather than starting a parallel one that
  // would overwrite the session entry and strand the first ws.
  if (sess && (sess.ws?.readyState === WebSocket.OPEN || sess.ws?.readyState === WebSocket.CONNECTING || sess.connecting)) {
    if (sess.idleTimer) { clearTimeout(sess.idleTimer); sess.idleTimer = null; }
    if (sess.connecting) await sess.connecting.catch(() => { /* surfaced by caller if still not open */ });
    return { endpoint: sess.endpoint, token: sess.token };
  }
  // Another caller is already establishing this session (concurrent
  // /agent/start). Join it instead of racing a second connect.
  const inFlight = establishing.get(workspaceId);
  if (inFlight) return inFlight;

  const establish = (async () => {
    // Re-read under async boundary: a racing caller may have just set it.
    let s = sessions.get(workspaceId);
    if (s && (s.ws?.readyState === WebSocket.OPEN || s.ws?.readyState === WebSocket.CONNECTING || s.connecting)) {
      if (s.connecting) await s.connecting.catch(() => { /* surfaced below */ });
      return { endpoint: s.endpoint, token: s.token };
    }
    // Re-request the CR (recreate if deleted → fresh endpoint + token). A dropped
    // ws may mean the CR was recycled, so we never trust the old handle here.
    const handle = await ensurePiWorker(workspaceId);
    if (s) {
      // Recover on the existing entry so SSE subscribers already draining it keep
      // working once the ws reopens. Close any lingering ws first so the bridge
      // releases its MaxSessions slot — orphaning it (dropping the reference
      // without close) would keep the slot held and 409 every later connect.
      if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
      if (s.ws && s.ws.readyState !== WebSocket.CLOSED) {
        try { s.ws.removeAllListeners(); s.ws.close(); } catch { /* ignore */ }
      }
      s.ws = null;
      s.outbound = [];
      s.endpoint = handle.endpoint;
      s.token = handle.token;
    } else {
      s = {
        ws: null,
        connecting: null,
        endpoint: handle.endpoint,
        token: handle.token,
        outbound: [],
        subscribers: new Set(),
        busy: false,
        idleTimer: null,
      };
      sessions.set(workspaceId, s);
    }
    s.connecting = openWebSocket(workspaceId, s, handle);
    await s.connecting;
    return { endpoint: handle.endpoint, token: handle.token };
  })();

  establishing.set(workspaceId, establish);
  try {
    return await establish;
  } finally {
    // Only clear if ours is still the registered one (a newer call may have
    // replaced it after an error/retry cycle).
    if (establishing.get(workspaceId) === establish) establishing.delete(workspaceId);
  }
}

/** Send a Pi `prompt` command to the agent; the response streams to SSE subscribers.
 *  Self-healing: if the ws isn't open yet (cold start / mid-(re)connect / dropped
 *  mid-session), this re-ensures the session and waits for the connect to finish
 *  rather than surfacing "not open" to the user. The long-lived session is the
 *  point — prompts should keep working without the browser having to re-POST start. */
export async function sendPrompt(workspaceId: string, message: string): Promise<void> {
  let sess = sessions.get(workspaceId);
  // Still connecting from a recent /agent/start or /events? Wait for that
  // attempt instead of racing a second one.
  if (sess?.connecting) {
    await sess.connecting.catch(() => { /* surfaced below if still not open */ });
    sess = sessions.get(workspaceId);
  }
  // No session, or the ws dropped (s.ws === null) after the connect succeeded?
  // Re-establish transparently — this is the reconnect path for a long-lived
  // session whose ws died between prompts.
  if (!sess || !sess.ws || sess.ws.readyState !== WebSocket.OPEN) {
    await ensureAgentSession(workspaceId).catch((err) => {
      throw new Error(`Agent session is not open: ${err instanceof Error ? err.message : String(err)}`);
    });
    sess = sessions.get(workspaceId);
  }
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
const WS_CONNECT_TIMEOUT_MS = Number(process.env.PI_WS_CONNECT_TIMEOUT_MS ?? "180_000"); // 3 min
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
      // `opened` is true only after a successful handshake. It gates the close
      // handler's reconnect path so a connect-phase failure (e.g. bridge 409
      // "agent busy", nginx 503) does NOT also trigger scheduleReconnect — that
      // would race this same tryConnect's own backoff retry and open a second
      // ws against the bridge's MaxSessions=1, leaking the slot and cascading
      // 409s. Connect-phase errors are handled solely by the error handler's
      // own retry below.
      let opened = false;

      ws.on("open", () => { opened = true; resolve(); });
      ws.on("error", (err) => {
        if (opened) {
          // An error after open (the ws is being torn down). The close handler
          // owns the post-open reconnect; don't double-handle here.
          return;
        }
        console.error(`[agent:${workspaceId}] ws connect error (attempt ${attempt + 1}):`, err.message);
        // Tear down this ws so a retry starts clean.
        try { ws.removeAllListeners(); ws.close(); } catch { /* ignore */ }
        if (Date.now() > deadline) {
          reject(err);
          return;
        }
        // Backoff: 500ms, 1s, 2s, 4s, … capped at 8s. Absorbs the cold-start
        // window where nginx returns 503, and the bridge's transient 409
        // "agent busy" while a previous ws is being released.
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
        if (!opened) return; // connect-phase close handled by error/retry
        console.error(`[agent:${workspaceId}] ws closed`);
        const s = sessions.get(workspaceId);
        if (!s) return;
        s.ws = null;
        s.connecting = null;
        // Auto-reconnect a long-lived session: if a browser (or any SSE
        // subscriber) is still attached, the ws dropped mid-use, so re-establish
        // it right away rather than waiting for the next prompt to notice.
        // scheduleReconnect is a no-op if the session was already closing on
        // purpose (closeSession deletes it first). It re-requests the PiWorker
        // CR (re-creating it if it was deleted) so a stale endpoint/token from
        // a garbage-collected CR doesn't doom the reconnect.
        if (s.subscribers.size > 0 || s.busy) scheduleReconnect(workspaceId, s);
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

// Re-establish a dropped long-lived ws while the session is still in use (has
// SSE subscribers or an in-flight prompt). Idempotent: a reconnect already in
// flight (sess.connecting) is not replaced. Subscribers stay attached across
// the outage, so once the ws reopens the stream resumes transparently — the
// browser never sees "not open". The agent's turn in flight when the drop
// happened is lost (pi aborts on socket close), but the next prompt works.
//
// Unlike a fresh connect, each retry re-requests the PiWorker CR via
// ensurePiWorker — if the CR was deleted (e.g. its Pod was evicted and the
// operator garbage-collected it, or an explicit stop raced with the drop),
// this recreates it and waits for Ready, then opens the ws against a fresh
// endpoint + token. The cached handle from the original openWebSocket is
// deliberately discarded: its endpoint/token may point at a now-defunct CR.
const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_TIMEOUT_MS = Number(process.env.PI_WS_CONNECT_TIMEOUT_MS ?? "180_000"); // 3 min

async function scheduleReconnect(workspaceId: string, sess: Session): Promise<void> {
  if (sess.connecting) return; // already reconnecting
  const deadline = Date.now() + RECONNECT_TIMEOUT_MS;
  let attempt = 0;
  const tryReconnect = async () => {
    if (sessions.get(workspaceId) !== sess) return; // session closed on purpose
    // Re-request the CR (create if missing, wait Ready, read fresh endpoint+token).
    // This is the key difference from the initial connect: a dropped ws may mean
    // the CR was recycled, so we can't trust the old handle.
    let handle: AgentConnect;
    try {
      handle = await ensurePiWorker(workspaceId);
    } catch (err) {
      const s = sessions.get(workspaceId);
      if (!s) return; // closed
      if (Date.now() > deadline) {
        console.error(`[agent:${workspaceId}] reconnect: CR ensure failed:`, err instanceof Error ? err.message : err);
        return; // next prompt will retry via sendPrompt's ensureAgentSession
      }
      const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** attempt, 8000);
      attempt++;
      setTimeout(() => void tryReconnect(), delay);
      return;
    }
    const s = sessions.get(workspaceId);
    if (!s || s !== sess) return; // closed / replaced
    // Refresh endpoint/token in case the CR was recreated with different values.
    s.endpoint = handle.endpoint;
    s.token = handle.token;
    s.connecting = openWebSocket(workspaceId, s, handle);
    await s.connecting
      .then(() => {
        const cur = sessions.get(workspaceId);
        if (cur) cur.connecting = null;
      })
      .catch(() => {
        const cur = sessions.get(workspaceId);
        if (!cur) return; // closed
        cur.connecting = null;
        if (Date.now() > deadline) {
          console.error(`[agent:${workspaceId}] reconnect attempts exhausted; will retry on next prompt`);
          return;
        }
        const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** attempt, 8000);
        attempt++;
        setTimeout(() => void tryReconnect(), delay);
      });
  };
  void tryReconnect();
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

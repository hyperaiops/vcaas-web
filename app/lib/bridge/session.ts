// Single-process workspace lifecycle. Leases are registered before any agent
// operation; shutdown fences the generation synchronously, then drains it before
// teardown. The transport depends on PI_RUNTIME_MODE:
//   prod  — WebSocket to the workspace PiWorker over the in-cluster Service.
//   local — spawned local `pi --mode rpc` process (development only).
import "server-only";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { ensurePiWorker, deletePiWorker } from "@/app/lib/bridge/k8s";
import { LocalPiTransport } from "@/app/lib/bridge/local";
import { runtimeMode, BridgeLifecycleError } from "@/app/lib/bridge/runtime";
import { projectTranscript } from "@/app/lib/bridge/transcript";
import type { LocalSession } from "@/app/lib/bridge/local-sessions";

export { BridgeLifecycleError };

const GRACE_MS = 30_000;
const FRESH_MS = 300_000;
const TOMBSTONE_MS = 900_000; // exceeds the full accepted issuedAt window, including skew
const CAPACITY = 10_000;
const CONNECT_MS = Number(process.env.PI_WS_CONNECT_TIMEOUT_MS ?? "180000");
export type AgentConnect = { endpoint: string; token: string };
export type AgentLease = { clientId: string; issuedAt: number };

type Transport =
  | { kind: "ws"; socket: WebSocket }
  | { kind: "local"; pi: LocalPiTransport };

type Lease = { issuedAt: number; released: boolean; expires: number; subscribers: Set<(frame: string) => void>; timer?: ReturnType<typeof setTimeout> };
type TurnPhase = "running" | "retrying" | "compacting" | "stopping" | "uncertain" | "done" | "stopped" | "failed";
type Activity = { id: string; name: string; status: "running" | "done" | "failed" };
type Turn = {
  id: string; clientId: string; promptId: string; phase: TurnPhase; text: string; activities: Activity[];
  truncated: boolean; sent: boolean; accepted: boolean; started: boolean; settled: boolean;
  cancelRequested: boolean; aborted: boolean; failed: boolean; pendingAborts: Set<string>; epoch: number; abortEpoch: number;
  timer?: ReturnType<typeof setTimeout>;
};
type PendingRpc = { command: string; resolve: (data: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type Generation = {
  controller: AbortController; connecting: Promise<AgentConnect> | null; transport: Transport | null;
  handle: AgentConnect | null; busy: boolean; turn: Turn | null; sequence: number;
  revision: string; switching: boolean; switchUncertain: boolean; restoreCandidate: LocalSession | null;
  cancelled: Map<string, number>; completed: Map<string, Turn>; recent: Map<string, number>;
  pendingRpc: Map<string, PendingRpc>;
};
type Workspace = { leases: Map<string, Lease>; generation: Generation | null; cleanup: Promise<void> | null; dirty: boolean; fenced: boolean; retry?: ReturnType<typeof setTimeout> };
const workspaces = new Map<string, Workspace>();
function error(status: number, code: string, message: string): never { throw new BridgeLifecycleError(status, code, message); }
function sweep() {
  const now = Date.now();
  for (const [id, w] of workspaces) {
    for (const [key, l] of w.leases) if (l.released && l.expires <= now) w.leases.delete(key);
    if (!w.fenced && !w.dirty && !w.cleanup && !w.generation && !w.leases.size) workspaces.delete(id);
  }
}
function workspace(id: string) {
  sweep();
  let w = workspaces.get(id);
  if (!w) {
    if (workspaces.size >= CAPACITY) error(503, "LEASE_CAPACITY", "Lifecycle capacity reached; retry later");
    w = { leases: new Map(), generation: null, cleanup: null, dirty: false, fenced: false };
    workspaces.set(id, w);
  }
  return w;
}
function validate(input: AgentLease) {
  if (!input || typeof input.clientId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.clientId) || !Number.isSafeInteger(input.issuedAt)) error(400, "BAD_LEASE", "Expected UUID clientId and integer issuedAt");
}
function fresh(input: AgentLease) {
  if (Math.abs(Date.now() - input.issuedAt) > FRESH_MS) error(410, "LEASE_EXPIRED", "Lease issuance is outside the freshness window");
}
function live(w: Workspace, id: string): Lease {
  const l = w.leases.get(id);
  if (!l || l.released || w.fenced) error(410, "LEASE_RELEASED", "Lease is no longer active");
  return l;
}
function current(w: Workspace, g: Generation) { return w.generation === g && !g.controller.signal.aborted && !w.fenced; }
function check(w: Workspace, g: Generation) { if (!current(w, g)) error(410, "LEASE_RELEASED", "Agent generation was released"); }
function arm(id: string, w: Workspace, clientId: string, l: Lease) {
  if (l.timer || l.released || l.subscribers.size) return;
  l.timer = setTimeout(() => {
    l.timer = undefined;
    if (workspaces.get(id) !== w || l.released || l.subscribers.size) return;
    release(w, l);
    if (![...w.leases.values()].some(x => !x.released)) void shutdown(id, w).catch(() => {});
  }, GRACE_MS);
  l.timer.unref?.();
}
function release(w: Workspace, l: Lease) {
  if (l.released) return;
  l.released = true; l.expires = Date.now() + TOMBSTONE_MS;
  if (l.timer) clearTimeout(l.timer);
  l.timer = undefined; l.subscribers.clear();
}
function teardownTransport(t: Transport | null): Promise<void> {
  if (!t) return Promise.resolve();
  if (t.kind === "ws") {
    t.socket.close();
    return Promise.resolve();
  }
  return t.pi.terminate();
}
async function teardown(id: string): Promise<void> {
  if (runtimeMode() === "prod") await deletePiWorker(id);
}
function shutdown(id: string, w: Workspace): Promise<void> {
  if (w.cleanup) return w.cleanup;
  if (w.retry) { clearTimeout(w.retry); w.retry = undefined; }
  const g = w.generation;
  w.generation = null; w.dirty = true;
  if (g) {
    g.controller.abort();
    rejectPendingRpc(g);
    if (g.turn) clearTurnTimer(g.turn);
    g.busy = false;
  }
  const operation = (async () => {
    await g?.connecting?.catch(() => {});
    await teardownTransport(g?.transport ?? null);
    await teardown(id);
    w.dirty = false;
  })();
  w.cleanup = operation;
  void operation.then(() => {
    if (w.cleanup === operation) w.cleanup = null;
  }, () => {
    if (w.cleanup === operation) w.cleanup = null;
    console.error(`[agent:${id}] cleanup failed; retrying in 5 seconds`);
    if (!w.retry) {
      w.retry = setTimeout(() => { w.retry = undefined; void shutdown(id, w).catch(() => {}); }, 5000);
      w.retry.unref?.();
    }
  });
  return operation;
}
export async function ensureAgentSession(id: string, input: AgentLease): Promise<AgentConnect> {
  validate(input);
  runtimeMode(); // fail fast on invalid/forbidden configuration, before any state changes
  const w = workspace(id);
  let l = w.leases.get(input.clientId);
  if (l?.released || w.fenced) error(410, "LEASE_RELEASED", "Lease was released");
  if (l && l.issuedAt !== input.issuedAt) error(400, "BAD_LEASE", "Lease issuance cannot change");
  if (!l) {
    fresh(input);
    if (w.dirty && !w.cleanup) error(503, "CLEANUP_PENDING", "Agent cleanup must succeed before starting");
    if (w.leases.size >= CAPACITY) error(503, "LEASE_CAPACITY", "Lease capacity reached; retry later");
    l = { issuedAt: input.issuedAt, released: false, expires: 0, subscribers: new Set() };
    w.leases.set(input.clientId, l);
  }
  // Register first so a stop arriving while deletion drains can tombstone this
  // acquisition. Never publish a new generation across the cleanup boundary.
  if (w.cleanup) {
    try { await w.cleanup; }
    catch {
      release(w, l);
      error(503, "CLEANUP_PENDING", "Agent cleanup must succeed before starting");
    }
  }
  live(w, input.clientId);
  if (w.dirty) { release(w, l); error(503, "CLEANUP_PENDING", "Agent cleanup must succeed before starting"); }
  if (!w.generation) w.generation = { controller: new AbortController(), connecting: null, transport: null, handle: null, busy: false, turn: null, sequence: 0, revision: randomUUID(), switching: false, switchUncertain: false, restoreCandidate: null, cancelled: new Map(), completed: new Map(), recent: new Map(), pendingRpc: new Map() };
  try {
    const handle = await connect(id, w, w.generation);
    live(w, input.clientId);
    arm(id, w, input.clientId, l);
    return handle;
  } catch (err) {
    if (!l.released) {
      release(w, l);
      if (![...w.leases.values()].some(x => !x.released)) await shutdown(id, w).catch(() => {});
    }
    throw err;
  }
}
export async function releaseAgentLease(id: string, input: AgentLease): Promise<void> {
  validate(input);
  const w = workspace(id);
  let l = w.leases.get(input.clientId);
  if (l && l.issuedAt !== input.issuedAt) error(400, "BAD_LEASE", "Lease issuance cannot change");
  if (!l) {
    fresh(input);
    if (w.leases.size >= CAPACITY) error(503, "LEASE_CAPACITY", "Lease capacity reached; retry later");
    l = { issuedAt: input.issuedAt, released: false, expires: 0, subscribers: new Set() };
    w.leases.set(input.clientId, l);
  }
  release(w, l);
  if (![...w.leases.values()].some(x => !x.released)) await shutdown(id, w);
}
export async function forceShutdown(id: string): Promise<void> {
  const w = workspace(id); w.fenced = true;
  for (const l of w.leases.values()) release(w, l);
  await shutdown(id, w);
}
function snapshot(g: Generation, clientId: string): string {
  const t = g.turn?.clientId === clientId ? g.turn : g.completed.get(clientId);
  return JSON.stringify({
    type: "turn_snapshot", version: 1, sequence: g.sequence, busy: g.busy,
    revision: g.revision, switching: g.switching, uncertain: g.switchUncertain,
    ...(t ? { turn: { id: t.id, text: t.text, phase: t.phase, activities: t.activities, truncated: t.truncated } } : {}),
  });
}
function publishSnapshot(w: Workspace, g: Generation) {
  g.sequence++;
  for (const [clientId, lease] of w.leases) {
    if (!lease.released) for (const send of lease.subscribers) send(snapshot(g, clientId));
  }
}
function publishTurn(w: Workspace, g: Generation, t: Turn, event: object) {
  if (g.turn !== t) return;
  const frame = JSON.stringify({ type: "turn_event", version: 1, sequence: ++g.sequence, turnId: t.id, event });
  const lease = w.leases.get(t.clientId);
  if (lease && !lease.released) for (const send of lease.subscribers) send(frame);
}
function setPhase(w: Workspace, g: Generation, t: Turn, phase: TurnPhase) {
  if (g.turn !== t || t.phase === phase) return;
  t.phase = phase;
  publishTurn(w, g, t, { kind: "phase", phase });
}
function clearTurnTimer(t: Turn) {
  if (t.timer) clearTimeout(t.timer);
  t.timer = undefined;
}
function markUncertain(w: Workspace, g: Generation, t: Turn) {
  if (g.turn !== t || !g.busy) return;
  clearTurnTimer(t);
  setPhase(w, g, t, "uncertain");
}
function watchTurn(w: Workspace, g: Generation, t: Turn) {
  clearTurnTimer(t);
  t.timer = setTimeout(() => markUncertain(w, g, t), 30_000);
  t.timer.unref?.();
}
function rememberTurn(g: Generation, t: Turn) {
  g.completed.delete(t.clientId);
  g.completed.set(t.clientId, t);
  if (g.completed.size > 8) g.completed.delete(g.completed.keys().next().value!);
  for (const [key, expiry] of g.recent) if (expiry <= Date.now()) g.recent.delete(key);
  g.recent.set(`${t.clientId}:${t.id}`, Date.now() + TOMBSTONE_MS);
  if (g.recent.size > 256) g.recent.delete(g.recent.keys().next().value!);
}
function finishTurn(w: Workspace, g: Generation, t: Turn) {
  if (g.turn !== t || !g.busy || !t.settled || t.pendingAborts.size) return;
  clearTurnTimer(t);
  t.phase = t.aborted ? "stopped" : t.failed ? "failed" : "done";
  g.busy = false;
  rememberTurn(g, t);
  publishSnapshot(w, g);
}
function sendFrame(w: Workspace, g: Generation, t: Turn, value: object) {
  const transport = g.transport;
  if (!transport) throw new BridgeLifecycleError(503, "AGENT_CLOSED", "Agent is not connected");
  const frame = JSON.stringify(value);
  if (transport.kind === "ws") {
    transport.socket.send(frame, err => {
      if (err && current(w, g) && g.transport === transport && g.turn === t) markUncertain(w, g, t);
    });
  } else {
    transport.pi.send(frame);
  }
}
function requestAbort(w: Workspace, g: Generation, t: Turn) {
  if (!g.busy || g.turn !== t || t.settled || t.pendingAborts.size || !(t.accepted || t.started)) return;
  const id = `abort-${randomUUID()}`;
  t.abortEpoch = t.epoch;
  t.pendingAborts.add(id);
  try {
    sendFrame(w, g, t, { id, type: "abort" });
    watchTurn(w, g, t);
  } catch {
    t.pendingAborts.delete(id);
    markUncertain(w, g, t);
  }
}
function newTurn(clientId: string, turnId: string): Turn {
  return {
    id: turnId, clientId, promptId: `req-${randomUUID()}`, phase: "running", text: "", activities: [],
    truncated: false, sent: false, accepted: false, started: false, settled: false,
    cancelRequested: false, aborted: false, failed: false, pendingAborts: new Set(), epoch: 0, abortEpoch: 0,
  };
}
export async function sendPrompt(id: string, clientId: string, message: string, turnId: string = randomUUID(), revision?: string): Promise<void> {
  const w = workspaces.get(id);
  if (!w) error(410, "LEASE_RELEASED", "Unknown lease");
  live(w, clientId);
  const g = w.generation;
  if (!g) error(410, "LEASE_RELEASED", "Agent was released");
  if (runtimeMode() === "local" && revision !== g.revision) error(409, "SESSION_CHANGED", "Agent session changed");
  if (g.turn?.id === turnId && g.turn.clientId === clientId) return;
  const recentKey = `${clientId}:${turnId}`;
  const recentExpiry = g.recent.get(recentKey);
  if (recentExpiry && recentExpiry > Date.now()) return;
  if (recentExpiry) g.recent.delete(recentKey);
  if (g.busy) error(409, "AGENT_BUSY", "Agent is already processing a request");
  const t = newTurn(clientId, turnId);
  g.completed.delete(clientId);
  g.turn = t;
  g.busy = true;
  publishSnapshot(w, g);
  const key = `${clientId}:${turnId}`;
  const expiry = g.cancelled.get(key);
  g.cancelled.delete(key);
  if (expiry && expiry > Date.now()) {
    t.cancelRequested = true; t.aborted = true; t.settled = true;
    finishTurn(w, g, t);
    return;
  }
  try {
    await connect(id, w, g);
    live(w, clientId); check(w, g);
    if (runtimeMode() === "local" && revision !== g.revision) error(409, "SESSION_CHANGED", "Agent session changed");
    if (g.turn !== t || !g.busy) return;
    if (t.cancelRequested) {
      t.aborted = true; t.settled = true;
      finishTurn(w, g, t);
      return;
    }
    t.sent = true;
    sendFrame(w, g, t, { id: t.promptId, type: "prompt", message });
    watchTurn(w, g, t);
  } catch (err) {
    if (current(w, g) && g.turn === t && g.busy) {
      if (t.sent) markUncertain(w, g, t);
      else { t.failed = true; t.settled = true; finishTurn(w, g, t); }
    }
    throw err;
  }
}
export async function cancelTurn(id: string, clientId: string, turnId: string, revision?: string): Promise<void> {
  const w = workspaces.get(id);
  if (!w) error(410, "LEASE_RELEASED", "Unknown lease");
  live(w, clientId);
  const g = w.generation;
  if (!g) error(410, "LEASE_RELEASED", "Agent was released");
  if (runtimeMode() === "local" && revision !== g.revision) error(409, "SESSION_CHANGED", "Agent session changed");
  if (g.switching || g.switchUncertain) error(409, "AGENT_BUSY", "Agent session is changing");
  const t = g.turn;
  if (!t || t.id !== turnId) {
    if ((g.recent.get(`${clientId}:${turnId}`) ?? 0) > Date.now()) return;
    if (g.busy) error(409, "AGENT_BUSY", "Another request is active");
    for (const [key, expiry] of g.cancelled) if (expiry <= Date.now()) g.cancelled.delete(key);
    if (g.cancelled.size >= 256) error(503, "AGENT_CAPACITY", "Too many pending cancellation requests");
    g.cancelled.set(`${clientId}:${turnId}`, Date.now() + FRESH_MS);
    const stopped = newTurn(clientId, turnId);
    stopped.cancelRequested = true; stopped.aborted = true; stopped.settled = true; stopped.phase = "stopped";
    g.turn = stopped;
    rememberTurn(g, stopped);
    publishSnapshot(w, g);
    return;
  }
  if (t.clientId !== clientId) error(403, "TURN_NOT_OWNED", "The request belongs to another page");
  if (!g.busy) return;
  if (t.phase === "uncertain") error(503, "AGENT_STATE_UNKNOWN", "Agent state is unknown");
  if (t.cancelRequested) return;
  t.cancelRequested = true;
  setPhase(w, g, t, "stopping");
  if (!t.sent) { t.aborted = true; t.settled = true; finishTurn(w, g, t); return; }
  requestAbort(w, g, t);
}
function rejectPendingRpc(g: Generation) {
  for (const pending of g.pendingRpc.values()) {
    clearTimeout(pending.timer);
    pending.reject(new BridgeLifecycleError(503, "AGENT_CLOSED", "Agent connection closed."));
  }
  g.pendingRpc.clear();
}

function requestLocalRpc(g: Generation, command: "get_state" | "get_entries" | "new_session" | "switch_session", sessionPath?: string): Promise<unknown> {
  const transport = g.transport;
  if (!transport || transport.kind !== "local") error(503, "AGENT_CLOSED", "Local agent is not connected.");
  if (g.pendingRpc.size >= 32) error(503, "AGENT_CAPACITY", "Too many session requests.");
  const id = `rpc-${randomUUID()}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      g.pendingRpc.delete(id);
      reject(new BridgeLifecycleError(503, "AGENT_TIMEOUT", "Agent session request timed out."));
    }, command === "get_state" ? 30_000 : 15_000);
    timer.unref?.();
    g.pendingRpc.set(id, { command, resolve, reject, timer });
    try {
      transport.pi.send(JSON.stringify({ id, type: command, ...(sessionPath ? { sessionPath } : {}) }));
    } catch {
      clearTimeout(timer);
      g.pendingRpc.delete(id);
      reject(new BridgeLifecycleError(503, "AGENT_CLOSED", "Agent connection closed."));
    }
  });
}

export async function getCurrentTranscript(id: string, clientId: string) {
  const w = workspaces.get(id);
  if (!w) error(410, "LEASE_RELEASED", "Unknown lease");
  live(w, clientId);
  const g = w.generation;
  if (!g) error(410, "LEASE_RELEASED", "Agent was released");
  if (runtimeMode() !== "local") return { apiVersion: "v1", supported: false as const };
  if (g.busy) error(409, "AGENT_BUSY", "Agent is already processing a request");
  const sequence = g.sequence;
  const transport = g.transport;
  if (!transport || transport.kind !== "local") error(503, "AGENT_CLOSED", "Local agent is not connected.");
  const data = await requestLocalRpc(g, "get_entries");
  const candidate = g.restoreCandidate;
  const canRestore = candidate ? await transport.pi.canRestore(candidate) : false;
  live(w, clientId);
  check(w, g);
  if (g.transport !== transport) error(503, "AGENT_CLOSED", "Agent connection changed while loading");
  if (g.busy || g.sequence !== sequence) error(409, "AGENT_BUSY", "Agent session changed while loading");
  return { apiVersion: "v1", supported: true as const, sequence, revision: g.revision, canRestore,
    restoreNeedsMigration: canRestore && candidate?.version !== 3, messages: projectTranscript(data) };
}

export async function changeAgentSession(id: string, clientId: string, revision: string, action: "new" | "restore", confirmMigration = false) {
  const w = workspaces.get(id);
  if (!w) error(410, "LEASE_RELEASED", "Unknown lease");
  live(w, clientId);
  const g = w.generation;
  if (!g) error(410, "LEASE_RELEASED", "Agent was released");
  const transport = g.transport;
  if (runtimeMode() !== "local" || !transport || transport.kind !== "local") error(501, "SESSION_UNSUPPORTED", "Session switching is unavailable");
  if (revision !== g.revision) error(409, "SESSION_CHANGED", "Agent session changed");
  if (g.busy || g.switchUncertain) error(409, "AGENT_BUSY", "Agent is already processing a request");

  g.busy = true;
  g.switching = true;
  g.revision = randomUUID();
  publishSnapshot(w, g);
  let sent = false;
  try {
    const state = await requestLocalRpc(g, "get_state") as { sessionFile?: unknown; messageCount?: unknown };
    check(w, g); live(w, clientId);
    const entries = await requestLocalRpc(g, "get_entries");
    check(w, g); live(w, clientId);
    const persisted = await transport.pi.isPersisted(state?.sessionFile);
    check(w, g); live(w, clientId);
    if (!persisted && ((typeof state?.messageCount === "number" && state.messageCount > 0) ||
        projectTranscript(entries).some((message) => message.role === "user"))) {
      error(409, "SESSION_NOT_SAVED", "Current session has unpersisted messages");
    }
    const candidate = action === "new" ? await transport.pi.recentSession() : g.restoreCandidate;
    check(w, g); live(w, clientId);
    if (action === "restore") {
      if (!candidate || !(await transport.pi.canRestore(candidate))) error(409, "SESSION_EXPIRED", "No recent session is available");
      check(w, g); live(w, clientId);
      if (candidate.version < 3 && !confirmMigration) error(409, "SESSION_MIGRATION_REQUIRED", "Old session requires confirmation");
    }
    sent = true;
    const result = await requestLocalRpc(g, action === "new" ? "new_session" : "switch_session", action === "restore" ? candidate!.file : undefined) as { cancelled?: unknown };
    check(w, g); live(w, clientId);
    if (typeof result?.cancelled !== "boolean") throw new Error("Invalid session response");
    if (!result.cancelled) {
      g.restoreCandidate = action === "new" && candidate ? await transport.pi.refreshSession(candidate) : null;
      check(w, g); live(w, clientId);
      g.turn = null;
      g.completed.clear();
    }
    return { apiVersion: "v1", cancelled: result.cancelled };
  } catch (err) {
    if (current(w, g) && sent) {
      g.switchUncertain = true;
      throw new BridgeLifecycleError(503, "AGENT_STATE_UNKNOWN", "Session state is unknown");
    }
    throw err;
  } finally {
    if (current(w, g)) {
      g.switching = false;
      if (!g.switchUncertain) g.busy = false;
      publishSnapshot(w, g);
    }
  }
}

export function subscribe(id: string, clientId: string, onFrame: (frame: string) => void): (() => void) | null {
  const w = workspaces.get(id), l = w?.leases.get(clientId);
  if (!w || !l || l.released || w.fenced || !w.generation) return null;
  if (l.timer) clearTimeout(l.timer);
  l.timer = undefined; l.subscribers.add(onFrame);
  onFrame(snapshot(w.generation, clientId));
  return () => { l.subscribers.delete(onFrame); arm(id, w, clientId, l); };
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new BridgeLifecycleError(410, "LEASE_RELEASED", "Generation cancelled")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
function isConnected(g: Generation): boolean {
  if (!g.handle || !g.transport) return false;
  return g.transport.kind === "ws" ? g.transport.socket.readyState === WebSocket.OPEN : true;
}
function connect(id: string, w: Workspace, g: Generation): Promise<AgentConnect> {
  check(w, g);
  if (g.connecting) return g.connecting;
  if (isConnected(g)) return Promise.resolve(g.handle!);
  const task = (async () => {
    const mode = runtimeMode();
    const deadline = Date.now() + CONNECT_MS;
    let attempt = 0;
    while (true) {
      check(w, g);
      try {
        if (mode === "prod") {
          const handle = await ensurePiWorker(id, g.controller.signal);
          check(w, g);
          await openWebSocket(id, w, g, handle);
          check(w, g); g.handle = handle;
          return handle;
        }
        const handle = await openLocal(id, w, g);
        check(w, g); g.handle = handle;
        return handle;
      } catch (err) {
        check(w, g);
        if (mode === "local" || Date.now() >= deadline) throw err;
        await pause(Math.min(500 * 2 ** attempt++, 8000), g.controller.signal);
      }
    }
  })();
  g.connecting = task;
  void task.then(() => { if (g.connecting === task) g.connecting = null; }, () => { if (g.connecting === task) g.connecting = null; });
  return task;
}

/** Normalize Pi events before exposing them to the owner of the active turn. */
function deliver(w: Workspace, g: Generation, frame: string): void {
  let event: Record<string, unknown>;
  try { event = JSON.parse(frame) as Record<string, unknown>; } catch { return; }
  if (!event || typeof event !== "object") return;
  if (event.type === "response" && typeof event.id === "string") {
    const pending = g.pendingRpc.get(event.id);
    if (pending && event.command === pending.command) {
      g.pendingRpc.delete(event.id);
      clearTimeout(pending.timer);
      if (event.success === true) pending.resolve(event.data);
      else pending.reject(new BridgeLifecycleError(503, "AGENT_RPC_FAILED", "Agent request failed."));
      return;
    }
  }
  if (g.switching || g.switchUncertain) return;
  const t = g.turn;
  if (!t || !g.busy || !t.sent) return;
  if (event.type === "response" && event.command === "prompt" && event.id === t.promptId) {
    if (event.success !== true) {
      t.failed = true; t.settled = true;
      finishTurn(w, g, t);
    } else {
      t.accepted = true;
      if (!t.started) watchTurn(w, g, t);
      else if (!t.pendingAborts.size) clearTurnTimer(t);
      if (t.phase === "uncertain") setPhase(w, g, t, t.cancelRequested ? "stopping" : "running");
      if (t.cancelRequested) requestAbort(w, g, t);
    }
    return;
  }
  if (event.type === "response" && event.command === "abort" && typeof event.id === "string" && t.pendingAborts.has(event.id)) {
    t.pendingAborts.delete(event.id);
    clearTurnTimer(t);
    if (event.success !== true && !t.settled) markUncertain(w, g, t);
    else if (!t.settled && t.cancelRequested && t.epoch > t.abortEpoch) requestAbort(w, g, t);
    else if (!t.settled) watchTurn(w, g, t);
    finishTurn(w, g, t);
    return;
  }
  if (event.type === "agent_start") {
    t.started = true;
    t.epoch++;
    if (!t.pendingAborts.size) clearTurnTimer(t);
    setPhase(w, g, t, t.cancelRequested ? "stopping" : "running");
    if (t.cancelRequested) requestAbort(w, g, t);
    return;
  }
  if (event.type === "agent_settled") {
    t.settled = true;
    finishTurn(w, g, t);
    return;
  }
  if (event.type === "message_end" || event.type === "turn_end") {
    const message = event.message as { stopReason?: unknown } | undefined;
    if (message?.stopReason === "aborted") t.aborted = true;
    if (message?.stopReason === "error") t.failed = true;
  }
  if (event.type === "auto_retry_start" || event.type === "compaction_start") {
    if (!t.pendingAborts.size) clearTurnTimer(t);
    if (event.type === "auto_retry_start") t.epoch++;
    if (!t.cancelRequested) setPhase(w, g, t, event.type === "auto_retry_start" ? "retrying" : "compacting");
    if (t.cancelRequested && event.type === "auto_retry_start") requestAbort(w, g, t);
    return;
  }
  if (event.type === "auto_retry_end" || event.type === "compaction_end") {
    if (event.type === "compaction_end") t.epoch++;
    if (event.aborted === true) t.aborted = true;
    if (event.type === "auto_retry_end" && typeof event.success === "boolean") t.failed = !event.success;
    if (event.type === "compaction_end" && typeof event.errorMessage === "string" && event.aborted !== true) t.failed = true;
    if (!t.cancelRequested) setPhase(w, g, t, "running");
    else requestAbort(w, g, t);
    return;
  }
  if (event.type === "agent_end") {
    if (event.willRetry === true && !t.cancelRequested) setPhase(w, g, t, "retrying");
    watchTurn(w, g, t);
    return;
  }
  if (event.type === "message_update") {
    const update = event.assistantMessageEvent as { type?: unknown; delta?: unknown } | undefined;
    if (update?.type !== "text_delta" || typeof update.delta !== "string") return;
    const available = Math.max(0, 262_144 - t.text.length);
    const delta = update.delta.slice(0, available);
    if (delta) { t.text += delta; publishTurn(w, g, t, { kind: "text", delta }); }
    if (delta.length !== update.delta.length) t.truncated = true;
    return;
  }
  if (event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end") {
    const toolCallId = event.toolCallId;
    if (typeof toolCallId !== "string" || toolCallId.length > 200) return;
    const index = t.activities.findIndex((activity) => activity.id === toolCallId);
    if (index < 0 && event.type !== "tool_execution_start") return;
    if (index < 0 && t.activities.length >= 100) { t.truncated = true; return; }
    const name = typeof event.toolName === "string" && ["read", "write", "edit", "bash", "grep", "find", "ls"].includes(event.toolName)
      ? event.toolName : "other";
    const activity: Activity = {
      id: toolCallId,
      name: index < 0 ? name : t.activities[index].name,
      status: event.type === "tool_execution_end" ? event.isError === true ? "failed" : "done" : "running",
    };
    if (index < 0) t.activities.push(activity); else t.activities[index] = activity;
    publishTurn(w, g, t, { kind: "activity", activity });
  }
}

async function openLocal(id: string, w: Workspace, g: Generation): Promise<AgentConnect> {
  const pi = await LocalPiTransport.spawn(id, g.controller.signal);
  const transport: Transport = { kind: "local", pi };
  g.transport = transport;
  pi.onMessage(frame => { if (current(w, g) && g.transport === transport) deliver(w, g, frame); });
  pi.onStderr(line => console.error(`[agent:${id}] ${line}`));
  pi.onClose(() => {
    if (!current(w, g) || g.transport !== transport) return;
    g.transport = null;
    rejectPendingRpc(g);
    g.revision = randomUUID();
    if (g.switching) { g.switching = false; g.switchUncertain = true; g.busy = true; }
    else if (g.busy && g.turn) markUncertain(w, g, g.turn);
    else if (!g.busy) { g.busy = true; g.switching = true; }
    publishSnapshot(w, g);
    if ([...w.leases.values()].some(l => !l.released && l.subscribers.size)) {
      void Promise.resolve().then(() => { if (current(w, g)) return connect(id, w, g); }).catch(() => {});
    }
  });
  try {
    const state = await requestLocalRpc(g, "get_state") as { sessionFile?: unknown; model?: unknown };
    check(w, g);
    if (g.transport !== transport) throw new Error("Agent connection closed");
    if (!state?.model || typeof state.model !== "object") throw new Error("Agent model unavailable");
    const active = typeof state.sessionFile === "string" ? state.sessionFile : null;
    g.restoreCandidate = await pi.recentSession(active);
    check(w, g);
    if (g.transport !== transport) throw new Error("Agent connection closed");
    if (g.switching && !g.switchUncertain) {
      g.switching = false;
      g.busy = false;
      publishSnapshot(w, g);
    }
  } catch {
    if (g.transport === transport) g.transport = null;
    await pi.terminate();
    error(503, "AGENT_START_FAILED", "Local agent failed to start.");
  }
  return { endpoint: "local:pi", token: "" };
}

function openWebSocket(id: string, w: Workspace, g: Generation, handle: AgentConnect): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL(handle.endpoint); url.searchParams.set("token", handle.token);
    const ws = new WebSocket(url.toString());
    const transport: Transport = { kind: "ws", socket: ws };
    g.transport = transport;
    let opened = false;
    const signal = g.controller.signal;
    const abort = () => { if (g.transport === transport) g.transport = null; clearTimeout(timeout); ws.close(); reject(new BridgeLifecycleError(410, "LEASE_RELEASED", "Generation cancelled")); };
    signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => { if (g.transport === transport) g.transport = null; signal.removeEventListener("abort", abort); ws.close(); reject(new Error("Agent WebSocket handshake timed out")); }, CONNECT_MS);
    const valid = () => current(w, g) && g.transport === transport;
    ws.on("open", () => {
      clearTimeout(timeout);
      if (!valid()) { ws.close(); reject(new BridgeLifecycleError(410, "LEASE_RELEASED", "Generation cancelled")); return; }
      opened = true; resolve();
    });
    ws.on("message", data => {
      if (!valid()) return;
      deliver(w, g, data.toString());
    });
    ws.on("error", err => { if (!opened) { if (g.transport === transport) g.transport = null; clearTimeout(timeout); signal.removeEventListener("abort", abort); ws.close(); reject(err); } else if (valid() && g.turn && g.busy) markUncertain(w, g, g.turn); });
    ws.on("close", () => {
      clearTimeout(timeout); signal.removeEventListener("abort", abort);
      if (!opened) { reject(new Error("Agent WebSocket closed before handshake")); return; }
      if (!valid()) return;
      g.transport = null;
      if (g.turn && g.busy) markUncertain(w, g, g.turn);
      if ([...w.leases.values()].some(l => !l.released && l.subscribers.size)) {
        // A microtask lets the previous connection's single-flight settle first.
        void Promise.resolve().then(() => { if (current(w, g)) return connect(id, w, g); }).catch(() => {});
      }
    });
  });
}

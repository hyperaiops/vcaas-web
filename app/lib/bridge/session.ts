// Single-process workspace lifecycle. Leases are registered before any Kubernetes
// operation; shutdown fences the generation synchronously, then drains it before delete.
import "server-only";
import { randomUUID } from "node:crypto";
import tls from "node:tls";
import WebSocket from "ws";
import { ensurePiWorker, deletePiWorker } from "@/app/lib/bridge/k8s";

const GRACE_MS = 30_000;
const FRESH_MS = 300_000;
const TOMBSTONE_MS = 900_000; // exceeds the full accepted issuedAt window, including skew
const CAPACITY = 10_000;
const FORWARD_HOST = process.env.PI_INGRESS_FORWARD_HOST ?? "";
const FORWARD_PORT = Number(process.env.PI_INGRESS_FORWARD_PORT ?? "0");
const CONNECT_MS = Number(process.env.PI_WS_CONNECT_TIMEOUT_MS ?? "180000");
export type AgentConnect = { endpoint: string; token: string };
export type AgentLease = { clientId: string; issuedAt: number };
export class BridgeLifecycleError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
type Lease = { issuedAt: number; released: boolean; expires: number; subscribers: Set<(frame: string) => void>; timer?: ReturnType<typeof setTimeout> };
type Generation = { controller: AbortController; connecting: Promise<AgentConnect> | null; ws: WebSocket | null; handle: AgentConnect | null; busy: boolean; outbound: string[] };
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
function shutdown(id: string, w: Workspace): Promise<void> {
  if (w.cleanup) return w.cleanup;
  if (w.retry) { clearTimeout(w.retry); w.retry = undefined; }
  const g = w.generation;
  w.generation = null; w.dirty = true;
  if (g) { g.controller.abort(); g.busy = false; g.ws?.close(); }
  const operation = (async () => {
    await g?.connecting?.catch(() => {});
    await deletePiWorker(id);
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
  if (!w.generation) w.generation = { controller: new AbortController(), connecting: null, ws: null, handle: null, busy: false, outbound: [] };
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
export async function sendPrompt(id: string, clientId: string, message: string): Promise<void> {
  const w = workspaces.get(id);
  if (!w) error(410, "LEASE_RELEASED", "Unknown lease");
  live(w, clientId);
  const g = w.generation;
  if (!g) error(410, "LEASE_RELEASED", "Agent was released");
  await connect(id, w, g);
  live(w, clientId); check(w, g);
  g.busy = true;
  const socket = g.ws!;
  try { socket.send(JSON.stringify({ id: `req-${randomUUID()}`, type: "prompt", message }), err => { if (err && current(w, g) && g.ws === socket) g.busy = false; }); }
  catch (err) { g.busy = false; throw err; }
}
export function subscribe(id: string, clientId: string, onFrame: (frame: string) => void): (() => void) | null {
  const w = workspaces.get(id), l = w?.leases.get(clientId);
  if (!w || !l || l.released || w.fenced || !w.generation) return null;
  if (l.timer) clearTimeout(l.timer);
  l.timer = undefined; l.subscribers.add(onFrame);
  for (const frame of w.generation.outbound) onFrame(frame);
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
function connect(id: string, w: Workspace, g: Generation): Promise<AgentConnect> {
  check(w, g);
  if (g.connecting) return g.connecting;
  if (g.ws?.readyState === WebSocket.OPEN && g.handle) return Promise.resolve(g.handle);
  const task = (async () => {
    const deadline = Date.now() + CONNECT_MS;
    let attempt = 0;
    while (true) {
      check(w, g);
      try {
        const handle = await ensurePiWorker(id, g.controller.signal);
        check(w, g);
        await open(id, w, g, handle);
        check(w, g); g.handle = handle;
        return handle;
      } catch (err) {
        check(w, g);
        if (Date.now() >= deadline) throw err;
        await pause(Math.min(500 * 2 ** attempt++, 8000), g.controller.signal);
      }
    }
  })();
  g.connecting = task;
  void task.then(() => { if (g.connecting === task) g.connecting = null; }, () => { if (g.connecting === task) g.connecting = null; });
  return task;
}
function open(id: string, w: Workspace, g: Generation, handle: AgentConnect): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL(handle.endpoint); url.searchParams.set("token", handle.token);
    const options: WebSocket.ClientOptions = FORWARD_HOST && FORWARD_PORT > 0 && url.protocol === "wss:" ? {
      createConnection: () => tls.connect({ host: FORWARD_HOST, port: FORWARD_PORT, servername: url.hostname, rejectUnauthorized: false }),
    } : {};
    const ws = new WebSocket(url.toString(), options); g.ws = ws;
    let opened = false;
    const signal = g.controller.signal;
    const abort = () => { if (g.ws === ws) g.ws = null; clearTimeout(timeout); ws.close(); reject(new BridgeLifecycleError(410, "LEASE_RELEASED", "Generation cancelled")); };
    signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => { if (g.ws === ws) g.ws = null; signal.removeEventListener("abort", abort); ws.close(); reject(new Error("Agent WebSocket handshake timed out")); }, CONNECT_MS);
    const valid = () => current(w, g) && g.ws === ws;
    ws.on("open", () => {
      clearTimeout(timeout);
      if (!valid()) { ws.close(); reject(new BridgeLifecycleError(410, "LEASE_RELEASED", "Generation cancelled")); return; }
      opened = true; resolve();
    });
    ws.on("message", data => {
      if (!valid()) return;
      const frame = data.toString();
      try { const event = JSON.parse(frame); if (event.type === "agent_end" && !event.willRetry) g.busy = false; } catch { /* non-JSON bridge diagnostics */ }
      const subscribers = [...w.leases.values()].filter(l => !l.released).flatMap(l => [...l.subscribers]);
      if (subscribers.length) for (const fn of subscribers) fn(frame);
      else { g.outbound.push(frame); if (g.outbound.length > 1000) g.outbound.shift(); }
    });
    ws.on("error", err => { if (!opened) { if (g.ws === ws) g.ws = null; clearTimeout(timeout); signal.removeEventListener("abort", abort); ws.close(); reject(err); } else if (valid()) g.busy = false; });
    ws.on("close", () => {
      clearTimeout(timeout); signal.removeEventListener("abort", abort);
      if (!opened) { reject(new Error("Agent WebSocket closed before handshake")); return; }
      if (!valid()) return;
      g.ws = null; g.busy = false;
      if ([...w.leases.values()].some(l => !l.released && l.subscribers.size)) {
        // A microtask lets the previous connection's single-flight settle first.
        void Promise.resolve().then(() => { if (current(w, g)) return connect(id, w, g); }).catch(() => {});
      }
    });
  });
}

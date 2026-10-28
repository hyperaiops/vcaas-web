import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import ts from "typescript";

type Lease = { clientId: string; issuedAt: number };
type Handle = { endpoint: string; token: string };
type Session = {
  ensureAgentSession(id: string, lease: Lease): Promise<Handle>;
  releaseAgentLease(id: string, lease: Lease): Promise<void>;
  forceShutdown(id: string): Promise<void>;
  sendPrompt(id: string, clientId: string, message: string): Promise<void>;
  subscribe(id: string, clientId: string, callback: (frame: string) => void): (() => void) | null;
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const handle = { endpoint: "ws://agent.test/v1/rpc", token: "secret" };
const lease = (n = 1, issuedAt = 0): Lease => ({ clientId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, issuedAt });
// Flush a bounded number of promise jobs; no sleeps or real time are involved.
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
function harness(options: { ensure?: (signal: AbortSignal) => Promise<Handle>; remove?: () => Promise<void>; manualOpen?: boolean } = {}) {
  let now = 0;
  let ensureCalls = 0;
  let deleteCalls = 0;
  const signals: AbortSignal[] = [];
  const order: string[] = [];
  const timers = new Map<object, { at: number; fn: () => void }>();
  const sockets: Socket[] = [];
  class Socket extends EventEmitter {
    static OPEN = 1;
    readyState = 0;
    sent: string[] = [];
    constructor(public url: string) {
      super(); sockets.push(this); order.push("socket");
      if (!options.manualOpen) queueMicrotask(() => this.open());
    }
    open() { this.readyState = 1; this.emit("open"); }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.emit("close"); }
    send(frame: string, callback?: (error?: Error) => void) { this.sent.push(frame); callback?.(); }
    frame(value: unknown) { this.emit("message", Buffer.from(JSON.stringify(value))); }
  }
  const source = readFileSync(new URL("../app/lib/bridge/session.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const exports = {} as Session;
  const modules: Record<string, unknown> = {
    "server-only": {}, "node:crypto": { randomUUID: () => "request-id" }, "node:tls": {}, ws: Socket,
    "@/app/lib/bridge/k8s": {
      ensurePiWorker: async (_id: string, signal: AbortSignal) => {
        ensureCalls++; signals.push(signal); order.push("ensure");
        return options.ensure ? options.ensure(signal) : handle;
      },
      deletePiWorker: async () => { deleteCalls++; order.push("delete"); await options.remove?.(); },
    },
  };
  runInNewContext(code, {
    exports, process: { env: {} }, Buffer, URL, AbortController,
    Date: { now: () => now }, console: { error() {} },
    setTimeout(fn: () => void, ms: number) { const key = { unref() {} }; timers.set(key, { at: now + ms, fn }); return key; },
    clearTimeout(key: object) { timers.delete(key); },
    require(name: string) { assert.ok(name in modules, `Unexpected import ${name}`); return modules[name]; },
  });
  return {
    session: exports, sockets, signals, order,
    get ensures() { return ensureCalls; }, get deletes() { return deleteCalls; },
    async advance(ms: number) {
      const end = now + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
      }
      now = end; await flush();
    },
  };
}

test("stop before start tombstones the lease with 410 and never provisions", async () => {
  const h = harness();
  await h.session.releaseAgentLease("project", lease());
  await assert.rejects(h.session.ensureAgentSession("project", lease()), { status: 410, code: "LEASE_RELEASED" });
  assert.equal(h.ensures, 0);
  assert.equal(h.sockets.length, 0);
});

test("stop during deferred ensure aborts and drains provisioning before deletion, without opening a socket", async () => {
  const provision = deferred<Handle>();
  const h = harness({ ensure: () => provision.promise });
  const start = h.session.ensureAgentSession("project", lease());
  const rejected = assert.rejects(start, { status: 410, code: "LEASE_RELEASED" });
  let stopped = false;
  const stop = h.session.releaseAgentLease("project", lease()).then(() => { stopped = true; });
  await flush();
  assert.equal(h.signals[0].aborted, true);
  assert.equal(h.deletes, 0);
  assert.equal(stopped, false);
  provision.resolve(handle);
  await Promise.all([rejected, stop]);
  assert.equal(h.deletes, 1);
  assert.equal(h.sockets.length, 0);
  assert.deepEqual(h.order, ["ensure", "delete"]);
});

test("multiple leases share one generation and only the final release deletes it", async () => {
  const h = harness();
  await Promise.all([h.session.ensureAgentSession("project", lease(1)), h.session.ensureAgentSession("project", lease(2))]);
  assert.equal(h.ensures, 1);
  assert.equal(h.sockets.length, 1);
  await h.session.releaseAgentLease("project", lease(1));
  assert.equal(h.deletes, 0);
  assert.equal(h.sockets[0].readyState, 1);
  await h.session.sendPrompt("project", lease(2).clientId, "still here");
  await h.session.releaseAgentLease("project", lease(2));
  assert.equal(h.deletes, 1);
  assert.equal(h.sockets[0].readyState, 3);
});

test("subscriber-free grace expires at exactly 30 seconds even while the agent is busy", async () => {
  const h = harness();
  await h.session.ensureAgentSession("project", lease());
  const unsubscribe = h.session.subscribe("project", lease().clientId, () => {});
  assert.ok(unsubscribe);
  await h.advance(60_000);
  assert.equal(h.deletes, 0, "a live subscriber suppresses grace cleanup");
  await h.session.sendPrompt("project", lease().clientId, "long running task");
  assert.equal(JSON.parse(h.sockets[0].sent[0]).type, "prompt");
  unsubscribe();
  await h.advance(29_999);
  assert.equal(h.deletes, 0);
  await h.advance(1);
  assert.equal(h.deletes, 1);
  await assert.rejects(h.session.sendPrompt("project", lease().clientId, "late"), { status: 410 });
});

test("duplicate concurrent and completed starts are idempotent and cannot change lease issuance", async () => {
  const provision = deferred<Handle>();
  const h = harness({ ensure: () => provision.promise });
  const starts = Array.from({ length: 5 }, () => h.session.ensureAgentSession("project", lease()));
  assert.equal(h.ensures, 1);
  provision.resolve(handle);
  await Promise.all(starts);
  await h.session.ensureAgentSession("project", lease());
  assert.equal(h.ensures, 1);
  assert.equal(h.sockets.length, 1);
  await assert.rejects(h.session.ensureAgentSession("project", lease(1, 1)), { status: 400, code: "BAD_LEASE" });
});

test("reconnect is single-flight and stale socket events cannot deliver frames or disrupt the replacement", async () => {
  const h = harness();
  await h.session.ensureAgentSession("project", lease());
  const frames: string[] = [];
  h.session.subscribe("project", lease().clientId, frame => frames.push(frame));
  const old = h.sockets[0];
  old.close();
  const start = h.session.ensureAgentSession("project", lease());
  const prompt = h.session.sendPrompt("project", lease().clientId, "reconnect");
  await Promise.all([start, prompt]);
  assert.equal(h.ensures, 2);
  assert.equal(h.sockets.length, 2);
  old.frame({ type: "agent_end" });
  old.emit("close");
  old.emit("error", new Error("stale"));
  h.sockets[1].frame({ type: "text_delta", delta: "fresh" });
  await flush();
  assert.deepEqual(frames.map(frame => JSON.parse(frame)), [{ type: "text_delta", delta: "fresh" }]);
  assert.equal(h.ensures, 2);
  assert.equal(h.sockets[1].sent.length, 1);
  assert.equal(h.sockets[1].readyState, 1);
});

test("force shutdown fences all existing and future leases and ignores late socket events", async () => {
  const h = harness();
  await h.session.ensureAgentSession("project", lease());
  const frames: string[] = [];
  h.session.subscribe("project", lease().clientId, frame => frames.push(frame));
  await h.session.forceShutdown("project");
  h.sockets[0].frame({ type: "text_delta", delta: "late" });
  await assert.rejects(h.session.ensureAgentSession("project", lease(2)), { status: 410 });
  await assert.rejects(h.session.sendPrompt("project", lease().clientId, "late"), { status: 410 });
  assert.equal(h.session.subscribe("project", lease().clientId, () => {}), null);
  await flush();
  assert.equal(h.deletes, 1);
  assert.equal(h.ensures, 1);
  assert.deepEqual(frames, []);
});

test("start-stop-start waits for deferred deletion before provisioning the replacement", async () => {
  const deletion = deferred<void>();
  const h = harness({ remove: () => deletion.promise });
  await h.session.ensureAgentSession("project", lease());
  const stop = h.session.releaseAgentLease("project", lease());
  let settled = false;
  const start = h.session.ensureAgentSession("project", lease(2)).then(() => { settled = true; });
  await h.advance(30_000);
  assert.equal(settled, false, "queued leases do not expire before connection succeeds");
  assert.equal(h.ensures, 1);
  assert.equal(h.sockets.length, 1);
  deletion.resolve();
  await Promise.all([stop, start]);
  assert.equal(h.ensures, 2);
  assert.equal(h.sockets.length, 2);
  assert.deepEqual(h.order, ["ensure", "socket", "delete", "ensure", "socket"]);
});

for (const mode of ["release", "force"] as const) {
  test(`${mode} while a new start waits for deletion rejects it with 410 and creates no generation`, async () => {
    const deletion = deferred<void>();
    const h = harness({ remove: () => deletion.promise });
    await h.session.ensureAgentSession("project", lease());
    const stop = h.session.releaseAgentLease("project", lease());
    const start = h.session.ensureAgentSession("project", lease(2));
    const rejected = assert.rejects(start, { status: 410, code: "LEASE_RELEASED" });
    await flush();
    const release = mode === "force" ? h.session.forceShutdown("project") : h.session.releaseAgentLease("project", lease(2));
    await flush();
    assert.equal(h.ensures, 1);
    assert.equal(h.deletes, 1);
    deletion.resolve();
    await Promise.all([stop, release, rejected]);
    assert.equal(h.ensures, 1);
    assert.equal(h.sockets.length, 1);
    assert.equal(h.session.subscribe("project", lease(2).clientId, () => {}), null);
    await assert.rejects(h.session.ensureAgentSession("project", lease(2)), { status: 410 });
  });
}

test("deferred deletion failure rejects waiting starts with 503 and blocks dirty restarts", async () => {
  const deletion = deferred<void>();
  const h = harness({ remove: () => deletion.promise });
  await h.session.ensureAgentSession("project", lease());
  const stop = h.session.releaseAgentLease("project", lease());
  const stopRejected = assert.rejects(stop, /delete failed/);
  const start = h.session.ensureAgentSession("project", lease(2));
  const startRejected = assert.rejects(start, { status: 503, code: "CLEANUP_PENDING" });
  await flush();
  assert.equal(h.ensures, 1);
  deletion.reject(new Error("delete failed"));
  await Promise.all([stopRejected, startRejected]);
  await assert.rejects(h.session.ensureAgentSession("project", lease(2)), { status: 410 });
  await assert.rejects(h.session.ensureAgentSession("project", lease(3)), { status: 503, code: "CLEANUP_PENDING" });
  assert.equal(h.ensures, 1);
  assert.equal(h.sockets.length, 1);
  assert.equal(h.deletes, 1);
});

test("successful manual cleanup cancels an older retry before a new generation starts", async () => {
  let attempts = 0;
  const h = harness({ remove: async () => { if (++attempts === 1) throw new Error("temporary deletion failure"); } });
  await h.session.ensureAgentSession("project", lease());
  await assert.rejects(h.session.releaseAgentLease("project", lease()), /temporary deletion failure/);
  await h.session.releaseAgentLease("project", lease());
  await h.session.ensureAgentSession("project", lease(2));
  h.session.subscribe("project", lease(2).clientId, () => {});
  await h.advance(5000);
  assert.equal(h.deletes, 2, "the cancelled retry must not delete the replacement generation");
  assert.equal(h.sockets[1].readyState, 1);
  await h.session.sendPrompt("project", lease(2).clientId, "replacement survives");
  assert.equal(h.sockets[1].sent.length, 1);
});

test("failed cleanup blocks new starts until the five-second retry succeeds", async () => {
  let attempts = 0;
  const retry = deferred<void>();
  const h = harness({ remove: async () => { if (++attempts === 1) throw new Error("delete unavailable"); await retry.promise; } });
  await h.session.ensureAgentSession("project", lease());
  await assert.rejects(h.session.releaseAgentLease("project", lease()), /delete unavailable/);
  await assert.rejects(h.session.ensureAgentSession("project", lease(2)), { status: 503, code: "CLEANUP_PENDING" });
  await h.advance(4999);
  assert.equal(h.deletes, 1);
  await h.advance(1);
  assert.equal(h.deletes, 2);
  let waiting = true;
  const start = h.session.ensureAgentSession("project", lease(2)).then(() => { waiting = false; });
  await flush();
  assert.equal(waiting, true);
  assert.equal(h.ensures, 1);
  retry.resolve(); await start;
  assert.equal(waiting, false);
  assert.equal(h.ensures, 2);
  assert.equal(h.sockets.length, 2);
});

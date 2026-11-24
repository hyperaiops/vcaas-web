import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { guardedEventStream } from "../app/lib/auth/event-stream";
import { LocalPiTransport } from "../app/lib/bridge/local";
import { ensureAgentSession, releaseAgentLease, subscribe } from "../app/lib/bridge/session";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function harness(authorized: () => boolean | Promise<boolean> = () => true, initial = "snapshot") {
  const abort = new AbortController();
  let send!: (frame: string) => void;
  let release!: () => void;
  let unsubscribed = 0;
  const stream = guardedEventStream(abort.signal, authorized, (onFrame, onRelease) => {
    send = onFrame;
    release = onRelease;
    send(initial);
    return () => { unsubscribed++; };
  });
  return { stream, abort, send, release, unsubscribed: () => unsubscribed };
}
const decode = (value: Uint8Array | undefined) => value && new TextDecoder().decode(value);

test("subscribes synchronously and serializes async authorization in frame order", async () => {
  const gate = deferred<boolean>();
  let active = 0, maxActive = 0, checks = 0;
  const h = harness(async () => {
    checks++;
    maxActive = Math.max(maxActive, ++active);
    if (checks === 1) await gate.promise;
    active--;
    return true;
  });
  h.send("second");
  h.send("third");
  const reader = h.stream.getReader();
  const first = reader.read(), second = reader.read(), third = reader.read();
  await tick();
  assert.equal(checks, 1);
  gate.resolve(true);
  assert.deepEqual((await Promise.all([first, second, third])).map((v) => decode(v.value)), [
    "data: snapshot\n\n", "data: second\n\n", "data: third\n\n",
  ]);
  assert.equal(checks, 3);
  assert.equal(maxActive, 1);
  await reader.cancel();
  assert.equal(h.unsubscribed(), 1);
});

test("heartbeats are ordered and reauthorized, and revocation closes the stream", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let allowed = true, checks = 0;
  const h = harness(async () => { checks++; return allowed; });
  const reader = h.stream.getReader();
  h.send("event");
  t.mock.timers.tick(15_000);
  assert.equal(decode((await reader.read()).value), "data: snapshot\n\n");
  assert.equal(decode((await reader.read()).value), "data: event\n\n");
  assert.equal(decode((await reader.read()).value), ": keepalive\n\n");
  allowed = false;
  t.mock.timers.tick(15_000);
  assert.equal((await reader.read()).done, true);
  assert.equal(checks, 4);
  assert.equal(h.unsubscribed(), 1);
});

test("abort, release and authorization errors discard queued frames", async () => {
  for (const reason of ["abort", "release", "error"] as const) {
    const gate = deferred<boolean>();
    const h = harness(() => gate.promise);
    h.send("secret");
    const reader = h.stream.getReader();
    const read = reader.read();
    await tick();
    if (reason === "abort") h.abort.abort();
    if (reason === "release") h.release();
    if (reason === "error") gate.reject(new Error("database unavailable"));
    assert.equal((await read).done, true, reason);
    if (reason !== "error") gate.resolve(true);
    await tick();
    assert.equal((await reader.read()).done, true, reason);
    assert.equal(h.unsubscribed(), 1, reason);
  }
});

test("slow readers and slow authorization cannot grow the queue indefinitely", async () => {
  const gate = deferred<boolean>();
  const h = harness(() => gate.promise);
  const reader = h.stream.getReader();
  const read = reader.read();
  await tick();
  for (let i = 0; i < 1024; i++) h.send("event");
  assert.equal((await read).done, true);
  assert.equal(h.unsubscribed(), 1);
  gate.resolve(true);
  await tick();
  assert.equal((await reader.read()).done, true);

  const bytes = harness();
  bytes.send("x".repeat(4 * 1024 * 1024));
  assert.equal((await bytes.stream.getReader().read()).done, true);
  assert.equal(bytes.unsubscribed(), 1);
});

test("unknown, aborted and synchronously released subscriptions close safely", async () => {
  let called = false;
  const unknown = guardedEventStream(new AbortController().signal, () => true, () => { called = true; return null; });
  assert.equal(called, true);
  assert.equal((await unknown.getReader().read()).done, true);
  const abort = new AbortController();
  abort.abort();
  called = false;
  const aborted = guardedEventStream(abort.signal, () => true, () => { called = true; return () => {}; });
  assert.equal(called, false);
  assert.equal((await aborted.getReader().read()).done, true);
  let unsubscribed = 0;
  const released = guardedEventStream(new AbortController().signal, () => true, (send, close) => {
    send("snapshot");
    close();
    return () => { unsubscribed++; };
  });
  assert.equal((await released.getReader().read()).done, true);
  assert.equal(unsubscribed, 1);
});

test("lease release notifies active subscribers immediately and safely", async (t) => {
  const previousMode = process.env.PI_RUNTIME_MODE;
  process.env.PI_RUNTIME_MODE = "local";
  t.after(() => {
    if (previousMode === undefined) delete process.env.PI_RUNTIME_MODE;
    else process.env.PI_RUNTIME_MODE = previousMode;
  });
  let onMessage: (frame: string) => void = () => {};
  const fake = {
    cwd: "/tmp",
    onMessage(callback: typeof onMessage) { onMessage = callback; },
    onStderr() {}, onClose() {},
    send(frame: string) {
      const request = JSON.parse(frame);
      queueMicrotask(() => onMessage(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data: { model: {}, sessionId: "session" } })));
    },
    recentSession: async () => null,
    terminate: async () => {},
  } as unknown as LocalPiTransport;
  t.mock.method(LocalPiTransport, "spawn", async () => fake);
  const id = randomUUID(), lease = { clientId: randomUUID(), issuedAt: Date.now() };
  assert.equal(subscribe(id, lease.clientId, () => {}), null);
  await ensureAgentSession(id, lease);
  let snapshots = 0, releases = 0;
  const unsubscribed = subscribe(id, lease.clientId, () => { snapshots++; }, () => { throw new Error("ignore"); });
  const active = subscribe(id, lease.clientId, () => { snapshots++; }, () => { releases++; });
  const removed = subscribe(id, lease.clientId, () => { snapshots++; }, () => { assert.fail("removed subscriber notified"); });
  assert.ok(unsubscribed && active && removed);
  assert.equal(snapshots, 3);
  const gate = deferred<boolean>();
  let streamSubscribed = false;
  const stream = guardedEventStream(new AbortController().signal, () => gate.promise, (send, close) => {
    const unsubscribe = subscribe(id, lease.clientId, send, close);
    streamSubscribed = unsubscribe !== null;
    return unsubscribe;
  });
  assert.equal(streamSubscribed, true);
  const reader = stream.getReader();
  const read = reader.read();
  await tick();
  removed();
  await releaseAgentLease(id, lease);
  assert.equal((await read).done, true);
  gate.resolve(true);
  assert.equal(releases, 1);
  assert.equal(subscribe(id, lease.clientId, () => {}), null);
  active();
  unsubscribed();
  await releaseAgentLease(id, lease);
  assert.equal(releases, 1);
});

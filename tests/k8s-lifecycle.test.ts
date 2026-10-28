import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const ready = { metadata: { labels: { "app.kubernetes.io/managed-by": "webcontainer" } }, status: { conditions: [{ type: "Ready", status: "True" }], serviceName: "agent", bearerTokenSecretRef: { name: "bearer" } } };
const terminating = { ...ready, metadata: { ...ready.metadata, deletionTimestamp: "2026-10-25T00:00:00Z" } };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
function load(options: { states?: (object | null)[]; create?: () => Promise<void>; onSleep?: () => void; realTimers?: boolean; deleteError?: object } = {}) {
  const calls: string[] = [];
  let index = 0;
  let now = 0;
  const states = options.states ?? [ready];
  const custom = {
    async getNamespacedCustomObject() {
      calls.push("get");
      const body = states[Math.min(index++, states.length - 1)];
      if (!body) throw { statusCode: 404 };
      return { body };
    },
    async createNamespacedCustomObject() { calls.push("create"); await options.create?.(); },
    async deleteNamespacedCustomObject() { calls.push("delete"); if (options.deleteError) throw options.deleteError; },
  };
  const core = { async readNamespacedSecret() { calls.push("secret"); return { body: { data: { token: Buffer.from("token").toString("base64") } } }; } };
  class KubeConfig {
    loadFromDefault() { calls.push("init"); }
    makeApiClient(kind: string) { return kind === "custom" ? custom : core; }
  }
  const modules: Record<string, unknown> = {
    "server-only": {},
    "@kubernetes/client-node": { KubeConfig, CustomObjectsApi: "custom", CoreV1Api: "core" },
    "@/app/lib/db": { getWorkspace: () => ({}) },
    "@/app/lib/workspace/types": { isValidWorkspaceId: () => true },
  };
  const source = readFileSync(new URL("../app/lib/bridge/k8s.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {} as { ensurePiWorker(id: string, signal?: AbortSignal): Promise<{ endpoint: string }>; deletePiWorker(id: string): Promise<void> };
  runInNewContext(code, {
    exports, Buffer, process: { env: { PI_LITELLM_API_KEY: "key", PI_LITELLM_BASE_URL: "http://llm", PI_CONNECTION_MODE: "service", PI_READY_TIMEOUT_MS: "2000" } },
    Date: { now: () => now },
    setTimeout: options.realTimers ? setTimeout : (fn: () => void, ms: number) => { now += ms; queueMicrotask(() => { options.onSleep?.(); fn(); }); return 1; },
    clearTimeout,
    require: (name: string) => { if (!(name in modules)) throw new Error(`Unexpected import ${name}`); return modules[name]; },
  });
  return { ...exports, calls };
}

test("pre-aborted ensure never initializes Kubernetes", async () => {
  const c = load();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(c.ensurePiWorker("project", controller.signal), { name: "AbortError" });
  assert.deepEqual(c.calls, []);
});

test("abort drains an issued create before rejecting, with no readiness reads", async () => {
  const issued = deferred();
  const creation = deferred();
  const c = load({ states: [null], create: () => { issued.resolve(); return creation.promise; } });
  const controller = new AbortController();
  const pending = c.ensurePiWorker("project", controller.signal);
  await issued.promise;
  controller.abort();
  let settled = false;
  const checked = assert.rejects(pending, { name: "AbortError" }).then(() => { settled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  creation.resolve();
  await checked;
  assert.deepEqual(c.calls, ["init", "get", "create"]);
});

test("abort interrupts the readiness polling timer", async () => {
  const c = load({ states: [{ ...ready, status: {} }], realTimers: true });
  const controller = new AbortController();
  const pending = c.ensurePiWorker("project", controller.signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.deepEqual(c.calls, ["init", "get", "get"]);
});

test("terminating Ready workers must disappear before recreation", async () => {
  const c = load({ states: [terminating, terminating, null, ready] });
  assert.equal((await c.ensurePiWorker("project")).endpoint, "ws://agent.default.svc:8080/v1/rpc");
  assert.deepEqual(c.calls, ["init", "get", "get", "get", "create", "get", "secret"]);
});

test("termination encountered during readiness polling also waits for absence", async () => {
  const c = load({ states: [ready, terminating, null, ready] });
  await c.ensurePiWorker("project");
  assert.deepEqual(c.calls, ["init", "get", "get", "get", "create", "get", "secret"]);
});

test("abort while waiting for termination never recreates", async () => {
  const controller = new AbortController();
  const c = load({ states: [terminating], onSleep: () => controller.abort() });
  await assert.rejects(c.ensurePiWorker("project", controller.signal), { name: "AbortError" });
  assert.equal(c.calls.includes("create"), false);
});

test("delete waits through finalization and succeeds only after absence", async () => {
  const c = load({ states: [ready, terminating, terminating, null] });
  await c.deletePiWorker("project");
  assert.deepEqual(c.calls, ["init", "get", "delete", "get", "get", "get"]);
});

test("stuck deletion and recreation report timeout", async () => {
  const c = load({ states: [terminating] });
  await assert.rejects(c.deletePiWorker("project"), { code: "RECONCILE_TIMEOUT" });
  const e = load({ states: [terminating] });
  await assert.rejects(e.ensurePiWorker("project"), { code: "RECONCILE_TIMEOUT" });
  assert.equal(e.calls.includes("create"), false);
});

test("delete is idempotent on absent resources and a delete 404 still confirms absence", async () => {
  const absent = load({ states: [null] });
  await absent.deletePiWorker("project");
  assert.deepEqual(absent.calls, ["init", "get"]);
  const raced = load({ states: [ready, null], deleteError: { statusCode: 404 } });
  await raced.deletePiWorker("project");
  assert.deepEqual(raced.calls, ["init", "get", "delete", "get"]);
});

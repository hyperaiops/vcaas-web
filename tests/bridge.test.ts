import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Isolate module-level env, clients and timers without touching kubeconfig or a cluster.
function load(file: string, env: Record<string, string | undefined>, modules: Record<string, unknown>, autoTimers = true) {
  const source = readFileSync(new URL(`../app/lib/bridge/${file}.ts`, import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const exports: Record<string, (...args: never[]) => unknown> = {};
  let now = 0;
  runInNewContext(code, {
    exports, process: { env }, Buffer, URL, AbortController, console: { error() {} },
    Date: { now: () => now },
    setTimeout: (fn: () => void, ms: number) => { if (autoTimers) { now += ms; queueMicrotask(fn); } return 1; },
    clearTimeout() {},
    require: (name: string) => {
      if (name === "server-only") return {};
      if (!(name in modules)) throw new Error(`Unexpected import ${name}`);
      return modules[name];
    },
  });
  return exports;
}

const ready = { conditions: [{ type: "Ready", status: "True" }], serviceName: "pw-project", bearerTokenSecretRef: { name: "bearer", key: "custom" } };
function worker(status: object = ready, managed = true) {
  return { metadata: { labels: { "app.kubernetes.io/managed-by": managed ? "webcontainer" : "other" } }, status };
}
function client(states: object[], env: Record<string, string | undefined> = {}, exists = true) {
  let gets = 0;
  let apiCalls = 0;
  const reads: unknown[][] = [];
  const custom = { async getNamespacedCustomObject() { return { body: states[Math.min(gets++, states.length - 1)] }; } };
  const core = { async readNamespacedSecret(...args: unknown[]) { reads.push(args); return { body: { data: { custom: Buffer.from(" bearer-token \n").toString("base64"), token: Buffer.from("fallback").toString("base64") } } }; } };
  class KubeConfig {
    loadFromDefault() { apiCalls++; }
    makeApiClient(kind: string) { return kind === "custom" ? custom : core; }
  }
  const mod = load("k8s", { PI_LITELLM_API_KEY: "test", PI_LITELLM_BASE_URL: "http://test", ...env }, {
    "@kubernetes/client-node": { KubeConfig, CustomObjectsApi: "custom", CoreV1Api: "core" },
    "@/app/lib/db": { getWorkspace: () => exists ? {} : null },
    "@/app/lib/workspace/types": { isValidWorkspaceId: (id: string) => id === "project" },
  });
  return { ensure: () => mod.ensurePiWorker("project" as never) as Promise<{ endpoint: string; token: string }>, gets: () => gets, apiCalls: () => apiCalls, reads };
}

test("service succeeds without public endpoint and reads the referenced bearer key", async () => {
  const c = client([worker()], { PI_CONNECTION_MODE: "service", PI_NAMESPACE: "agents" });
  const handle = await c.ensure();
  assert.equal(handle.endpoint, "ws://pw-project.agents.svc:8080/v1/rpc");
  assert.equal(handle.token, "bearer-token");
  assert.deepEqual(c.reads, [["bearer", "agents"]]);
});

test("service waits separately for Ready, serviceName, and bearer ref without endpoint fallback", async () => {
  const c = client([
    worker(),
    worker({ ...ready, conditions: [], endpoint: "wss://public/v1/rpc" }),
    worker({ ...ready, serviceName: undefined, endpoint: "wss://public/v1/rpc" }),
    worker({ ...ready, bearerTokenSecretRef: undefined }),
    worker(),
  ], { PI_CONNECTION_MODE: "service" });
  assert.equal((await c.ensure()).endpoint, "ws://pw-project.default.svc:8080/v1/rpc");
  assert.equal(c.gets(), 5);
  assert.equal(c.reads.length, 1);
});

test("each missing service prerequisite reaches the finite default readiness timeout", async () => {
  for (const status of [{ ...ready, conditions: [] }, { ...ready, serviceName: undefined }, { ...ready, bearerTokenSecretRef: undefined }]) {
    const c = client([worker(status)], { PI_CONNECTION_MODE: "service" });
    await assert.rejects(c.ensure(), { code: "RECONCILE_TIMEOUT" });
    assert.ok(c.gets() > 300 && c.gets() < 310);
    assert.equal(c.reads.length, 0);
  }
});

test("invalid modes and namespaces reject before Kubernetes initialization", async () => {
  for (const env of [{ PI_CONNECTION_MODE: "ingress" }, { PI_CONNECTION_MODE: "" }, { PI_CONNECTION_MODE: "service", PI_NAMESPACE: "bad.namespace" }]) {
    const c = client([worker()], env);
    await assert.rejects(c.ensure(), { code: "BAD_CONFIG" });
    assert.equal(c.apiCalls(), 0);
  }
});

test("invalid Service labels, unmanaged workers, and missing workspaces are rejected", async () => {
  for (const serviceName of ["bad.name", "UPPER", "-bad", "bad-", "a".repeat(64), "bad:8080"]) {
    const c = client([worker({ ...ready, serviceName })], { PI_CONNECTION_MODE: "service" });
    await assert.rejects(c.ensure(), { code: "BAD_CONFIG" });
    assert.equal(c.reads.length, 0);
  }
  for (const mode of ["service", "endpoint"]) {
    await assert.rejects(client([worker({ ...ready, endpoint: "wss://public/v1/rpc" }, false)], { PI_CONNECTION_MODE: mode }).ensure(), { code: "BAD_CONFIG" });
  }
  const missing = client([worker()], {}, false);
  await assert.rejects(missing.ensure(), { code: "UNKNOWN_WORKSPACE" });
  assert.equal(missing.apiCalls(), 0);
});

test("default and explicit endpoint modes preserve public URL and Secret key fallback", async () => {
  for (const env of [{}, { PI_CONNECTION_MODE: "endpoint" }]) {
    const c = client([worker({ ...ready, endpoint: "wss://public:8443/custom?x=1", bearerTokenSecretRef: { name: "bearer" } })], env);
    const handle = await c.ensure();
    assert.equal(handle.endpoint, "wss://public:8443/custom?x=1");
    assert.equal(handle.token, "fallback");
  }
  await assert.rejects(client([worker()], { PI_READY_TIMEOUT_MS: "1" }).ensure(), { code: "RECONCILE_TIMEOUT" });
});

test("ws bypasses configured TLS forward; wss keeps forwarding with hostname-only SNI", async () => {
  for (const protocol of ["ws", "wss"]) {
    const sockets: { url: string; options: { createConnection?: () => unknown } }[] = [];
    const tlsCalls: unknown[] = [];
    class Socket extends EventEmitter {
      static OPEN = 1;
      static CONNECTING = 0;
      static CLOSED = 3;
      readyState = 1;
      constructor(url: string, options: { createConnection?: () => unknown }) {
        super(); sockets.push({ url, options }); queueMicrotask(() => this.emit("open"));
      }
      close() {}
    }
    const endpoint = `${protocol}://agent.test:8080/custom/rpc?keep=a%2Bb&token=old&token=duplicate`;
    const token = "a +/&?=#中文";
    const mod = load("session", { PI_INGRESS_FORWARD_HOST: "127.0.0.1", PI_INGRESS_FORWARD_PORT: "8443" }, {
      "node:crypto": { randomUUID: () => "id" }, "node:tls": { connect: (options: unknown) => { tlsCalls.push(options); } },
      ws: Socket, "@/app/lib/bridge/k8s": { ensurePiWorker: async () => ({ endpoint, token }), deletePiWorker: async () => {} },
    }, false);
    const lease = { clientId: "00000000-0000-4000-8000-000000000001", issuedAt: 0 };
    await mod.ensureAgentSession("project" as never, lease as never);
    const url = new URL(sockets[0].url);
    assert.equal(url.protocol, `${protocol}:`);
    assert.equal(url.host, "agent.test:8080");
    assert.equal(url.pathname, "/custom/rpc");
    assert.equal(url.searchParams.get("keep"), "a+b");
    assert.deepEqual(url.searchParams.getAll("token"), [token]);
    if (protocol === "ws") assert.equal(sockets[0].options.createConnection, undefined);
    else {
      sockets[0].options.createConnection!();
      assert.equal(JSON.stringify(tlsCalls), JSON.stringify([{ host: "127.0.0.1", port: 8443, servername: "agent.test", rejectUnauthorized: false }]));
    }
    await mod.releaseAgentLease("project" as never, lease as never);
  }
});

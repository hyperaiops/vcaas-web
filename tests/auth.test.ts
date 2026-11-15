import "./setup";
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { generateKeyPairSync, sign } from "node:crypto";
import Database from "better-sqlite3";
import { getDb, createWorkspace, getOwnedWorkspace, listWorkspaces, deleteWorkspace } from "../app/lib/db";
import { createSession, sessionUser, revokeSession, saveLogin, consumeLogin } from "../app/lib/auth/store";
import { safeReturnTo } from "../app/lib/auth/oidc";
import { SESSION_COOKIE, TRANSACTION_COOKIE } from "../app/lib/auth/config";
import { checkOrigin } from "../app/lib/auth/access";
import { guardedEventStream } from "../app/lib/auth/event-stream";
import { assertManagedPiWorker } from "../app/lib/bridge/k8s";
import * as collection from "../app/api/v1/workspaces/route";
import * as manifest from "../app/api/v1/workspaces/[workspaceId]/route";
import * as tree from "../app/api/v1/workspaces/[workspaceId]/tree/route";
import * as snapshot from "../app/api/v1/workspaces/[workspaceId]/snapshot/route";
import * as files from "../app/api/v1/workspaces/[workspaceId]/files/[...path]/route";
import * as start from "../app/api/v1/workspaces/[workspaceId]/agent/start/route";
import * as stop from "../app/api/v1/workspaces/[workspaceId]/agent/stop/route";
import * as prompt from "../app/api/v1/workspaces/[workspaceId]/agent/prompt/route";
import * as cancel from "../app/api/v1/workspaces/[workspaceId]/agent/cancel/route";
import * as events from "../app/api/v1/workspaces/[workspaceId]/agent/events/route";
import * as legacy from "../app/api/chat/route";
import * as callback from "../app/auth/callback/route";
import * as login from "../app/auth/login/route";
import * as logout from "../app/auth/logout/route";
import { proxy } from "../proxy";

const root = mkdtempSync(path.join(tmpdir(), "pi-auth-test-"));
process.env.WORKSPACE_DB_PATH = path.join(root, "db.sqlite");
process.env.WORKSPACE_FILES_ROOT = path.join(root, "workspaces");
process.env.TEMPLATE_DIR = path.join(root, "template");
process.env.AUTH_ORIGIN = "https://console.test";
process.env.AUTH_ISSUER = "https://identity.test/oidc";
process.env.AUTH_CLIENT_ID = "test-client";
process.env.AUTH_CLIENT_SECRET = "test-only-not-a-real-secret";
process.env.AUTH_SESSION_KEY = "12".repeat(32);
// Agent routes require an explicit runtime mode; route tests never connect to a cluster.
process.env.PI_RUNTIME_MODE = "prod";
mkdirSync(process.env.TEMPLATE_DIR);
writeFileSync(path.join(process.env.TEMPLATE_DIR, "index.txt"), "template");
const old = new Database(process.env.WORKSPACE_DB_PATH);
old.exec(`CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision TEXT);
  INSERT INTO workspaces VALUES ('legacy', 'Legacy', '/missing', 'now', 'now', NULL)`);
old.close();

// Exercise handlers with Next's own request-scoped cookie storage, not a global user mock.
const require = createRequire(import.meta.url);
const { workAsyncStorage } = require("next/dist/server/app-render/work-async-storage.external.js");
const { workUnitAsyncStorage } = require("next/dist/server/app-render/work-unit-async-storage.external.js");
const { RequestCookies } = require("next/dist/compiled/@edge-runtime/cookies");
function context<T>(token: string | null, fn: () => T, cookie = SESSION_COOKIE): T {
  return workAsyncStorage.run({ route: "/test", isStaticGeneration: false }, () =>
    workUnitAsyncStorage.run({ type: "request", phase: "render", cookies: new RequestCookies(new Headers(token ? { cookie: `${cookie}=${token}` } : {})) }, fn));
}
const expiry = () => Math.floor(Date.now() / 1000) + 3600;
const a = createSession("a", "Alice", "id-token-a", expiry());
const b = createSession("b", "Bob", "id-token-b", expiry());
const ownerA = sessionUser(a.token)!;
const ownerB = sessionUser(b.token)!;
const workspaceRoot = path.join(process.env.WORKSPACE_FILES_ROOT, "project-a");
mkdirSync(workspaceRoot, { recursive: true });
writeFileSync(path.join(workspaceRoot, "index.txt"), "private A");
createWorkspace({ id: "project-a", name: "A", rootPath: workspaceRoot, ownerId: ownerA.id });
const params = { params: Promise.resolve({ workspaceId: "project-a" }) };
const request = (method = "GET", body?: unknown, origin = "https://console.test") => new Request("https://console.test/api/test", {
  method, headers: { origin, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
});

test("migrates existing DB without claiming legacy projects; owner queries isolate users", () => {
  assert.equal(listWorkspaces(ownerA.id).length, 1);
  assert.equal(listWorkspaces(ownerB.id).length, 0);
  assert.equal(getOwnedWorkspace("project-a", ownerB.id), null);
  assert.equal(getOwnedWorkspace("legacy", ownerA.id), null);
  assert.ok(getDb().prepare("SELECT * FROM workspaces WHERE id = 'legacy'").get());
});

test("sessions are opaque, hashed, encrypted, expire, and revoke immediately", () => {
  const session = createSession("temporary", "Temp", "sensitive-id-token", expiry());
  const row = getDb().prepare("SELECT token_hash, id_token FROM auth_sessions WHERE user_id = ?").get(sessionUser(session.token)!.id) as { token_hash: string; id_token: string };
  assert.notEqual(row.token_hash, session.token);
  assert.ok(!row.id_token.includes("sensitive-id-token"));
  assert.equal(revokeSession(session.token), "sensitive-id-token");
  assert.equal(sessionUser(session.token), null);
  const expired = createSession("expired", "Expired", "token", 1);
  assert.equal(sessionUser(expired.token), null);
  assert.equal(sessionUser("tampered"), null);
});

test("login transactions are single-use and expire", () => {
  const value = { state: "s", nonce: "n", verifier: "v", returnTo: "/" };
  const token = saveLogin(value);
  assert.deepEqual(consumeLogin(token), value);
  assert.equal(consumeLogin(token), null);
  const expired = saveLogin(value);
  getDb().prepare("UPDATE auth_transactions SET expires_at = 0").run();
  assert.equal(consumeLogin(expired), null);
});

test("returnTo and mutation origin reject external redirects and cross-site requests", () => {
  for (const value of ["https://evil.test", "//evil.test", "/\\evil.test", "/auth/login", "/\n/evil.test"]) assert.equal(safeReturnTo(value), "/");
  assert.equal(safeReturnTo("/workspaces/a?tab=code"), "/workspaces/a?tab=code");
  assert.equal(checkOrigin(request("POST", {}, "https://evil.test"))?.status, 403);
  assert.equal(checkOrigin(request("POST", {})), null);
});

test("all workspace routes deny unauthenticated and other-user requests before side effects", async () => {
  const routes = [
    () => manifest.GET(request(), params), () => manifest.DELETE(request("DELETE"), params),
    () => tree.GET(request(), params), () => snapshot.GET(request(), params), () => snapshot.POST(request("POST"), params),
    () => files.PUT(request("PUT", { contents: "attacker" }), { params: Promise.resolve({ workspaceId: "project-a", path: ["index.txt"] }) }),
    () => start.POST(request("POST"), params), () => stop.POST(request("POST"), params),
    () => prompt.POST(request("POST", { message: "attack" }), params), () => cancel.POST(request("POST"), params), () => events.GET(request(), params),
    () => legacy.POST(request("POST", { workspaceId: "project-a", message: "attack" })),
  ];
  for (const route of routes) {
    assert.equal((await context(null, route)).status, 401);
    assert.equal((await context(b.token, route)).status, 404);
  }
  assert.equal((await context(null, () => collection.GET())).status, 401);
  assert.equal(readFileSync(path.join(workspaceRoot, "index.txt"), "utf8"), "private A");
  assert.equal((await context(a.token, () => manifest.DELETE(request("DELETE", undefined, "https://evil.test"), params))).status, 403);
});

test("agent lease routes validate bodies only after authentication and ownership", async () => {
  const clientId = "7cb3f030-39f2-4f88-a430-dad82674a073";
  for (const body of [{}, { clientId }, { clientId: "bad", issuedAt: Date.now() },
    { clientId, issuedAt: "123" }, { clientId, issuedAt: 1.5 }, null, []]) {
    for (const route of [start.POST, stop.POST]) {
      const response = await context(a.token, () => route(request("POST", body), params));
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, "INVALID_AGENT_LEASE");
    }
  }
  assert.equal((await context(a.token, () => prompt.POST(request("POST", { message: "hello" }), params))).status, 400);
  const turnId = "0d9a8059-0a3f-45c6-80cb-e1f20d282dd3";
  assert.equal((await context(a.token, () => cancel.POST(request("POST", { clientId }), params))).status, 400);
  const emptyPrompt = await context(a.token, () => prompt.POST(request("POST", { clientId, turnId, message: "  " }), params));
  assert.equal(emptyPrompt.status, 400);
  assert.equal((await emptyPrompt.json()).error.code, "EMPTY_PROMPT");
  for (const route of [start.POST, stop.POST, prompt.POST, cancel.POST]) {
    assert.equal((await context(a.token, () => route(request("POST", { clientId, turnId, issuedAt: Date.now(), message: "hello" }, "https://evil.test"), params))).status, 403);
  }
});

test("events rejects malformed IDs and ends unknown lease reconnects without starting an agent", async () => {
  assert.equal((await context(a.token, () => events.GET(request(), params))).status, 400);
  const malformed = new Request("https://console.test/api/test?clientId=not-a-uuid");
  assert.equal((await context(a.token, () => events.GET(malformed, params))).status, 400);
  const unknown = new Request("https://console.test/api/test?clientId=7cb3f030-39f2-4f88-a430-dad82674a073");
  assert.equal((await context(null, () => events.GET(unknown, params))).status, 401);
  assert.equal((await context(b.token, () => events.GET(unknown, params))).status, 404);
  const response = await context(a.token, () => events.GET(unknown, params));
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
});

test("released page routes cannot restart, prompt, or reconnect and stop stays idempotent", async () => {
  const lease = { clientId: "fb27391b-c206-418c-8062-dadad70812fd", issuedAt: Date.now() };
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal((await context(a.token, () => stop.POST(request("POST", lease), params))).status, 200);
  }
  const restarted = await context(a.token, () => start.POST(request("POST", lease), params));
  assert.equal(restarted.status, 410);
  assert.equal((await restarted.json()).error.code, "LEASE_RELEASED");
  const turnId = "0d9a8059-0a3f-45c6-80cb-e1f20d282dd3";
  const sent = await context(a.token, () => prompt.POST(request("POST", { clientId: lease.clientId, turnId, message: "hello" }), params));
  assert.equal(sent.status, 410);
  assert.equal((await context(a.token, () => cancel.POST(request("POST", { clientId: lease.clientId, turnId }), params))).status, 410);
  const reconnect = new Request(`https://console.test/api/test?clientId=${lease.clientId}`);
  assert.equal((await context(a.token, () => events.GET(reconnect, params))).status, 204);
  const expired = await context(a.token, () => start.POST(request("POST", {
    clientId: "f2d2ae75-fd4c-4e42-8672-8572adb31116", issuedAt: 0,
  }), params));
  assert.equal(expired.status, 410);
  assert.equal((await expired.json()).error.code, "LEASE_EXPIRED");
});

test("Chinese API messages preserve authentication and ownership error codes", async () => {
  const unauthenticated = await context(null, () => collection.GET());
  assert.equal(unauthenticated.status, 401);
  assert.deepEqual((await unauthenticated.json()).error, { code: "UNAUTHENTICATED", message: "请先登录。" });
  const forbidden = await context(b.token, () => manifest.GET(request(), params));
  assert.equal(forbidden.status, 404);
  assert.deepEqual((await forbidden.json()).error, { code: "WORKSPACE_NOT_FOUND", message: "未找到该工作区。" });
});

test("creation never adopts or deletes another project's existing directory", async () => {
  const response = await context(b.token, () => collection.POST(request("POST", { name: "steal", id: "project-a" })));
  assert.equal(response.status, 409);
  assert.equal(readFileSync(path.join(workspaceRoot, "index.txt"), "utf8"), "private A");
  mkdirSync(path.join(process.env.WORKSPACE_FILES_ROOT!, "orphan"));
  assert.equal((await context(b.token, () => collection.POST(request("POST", { name: "orphan", id: "orphan" })))).status, 409);
  assert.ok(existsSync(path.join(process.env.WORKSPACE_FILES_ROOT!, "orphan")));
  const created = await context(b.token, () => collection.POST(request("POST", { name: "B" })));
  assert.equal(created.status, 201);
  assert.equal(listWorkspaces(ownerB.id).length, 1);
  assert.equal(listWorkspaces(ownerA.id).length, 1);
});

test("deleted project IDs cannot inherit a previous owner's agent session", async () => {
  const created = await context(a.token, () => collection.POST(request("POST", { name: "Disposable", id: "disposable" })));
  assert.equal(created.status, 201);
  assert.equal(deleteWorkspace("disposable", ownerB.id), false);
  assert.equal(deleteWorkspace("disposable", ownerA.id), true);
  rmSync(path.join(process.env.WORKSPACE_FILES_ROOT!, "disposable"), { recursive: true });
  const reused = await context(b.token, () => collection.POST(request("POST", { name: "Reuse", id: "disposable" })));
  assert.equal(reused.status, 409);
  assert.ok(!existsSync(path.join(process.env.WORKSPACE_FILES_ROOT!, "disposable")));
});

test("owners can read/write, and conditional requests cannot bypass ownership", async () => {
  const response = await context(a.token, () => tree.GET(request(), params));
  assert.equal(response.status, 200);
  const etag = response.headers.get("etag")!;
  const conditional = new Request("https://console.test/api/test", { headers: { "if-none-match": etag } });
  assert.equal((await context(b.token, () => tree.GET(conditional, params))).status, 404);
  assert.equal((await context(a.token, () => tree.GET(conditional, params))).status, 304);
  const written = await context(a.token, () => files.PUT(request("PUT", { contents: "owner change" }), {
    params: Promise.resolve({ workspaceId: "project-a", path: ["index.txt"] }),
  }));
  assert.equal(written.status, 200);
  assert.equal(readFileSync(path.join(workspaceRoot, "index.txt"), "utf8"), "owner change");
});

test("SSE stops before delivering another frame after session revocation", async () => {
  const session = createSession("sse", "SSE", "token", expiry());
  let send: (frame: string) => void = () => {};
  let unsubscribed = false;
  const stream = guardedEventStream(new AbortController().signal, () => !!sessionUser(session.token), (callback) => {
    send = callback;
    return () => { unsubscribed = true; };
  });
  const reader = stream.getReader();
  send('{"type":"hello"}');
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: {"type":"hello"}\n\n');
  revokeSession(session.token);
  send('{"type":"private"}');
  assert.equal((await reader.read()).done, true);
  assert.equal(unsubscribed, true);
});

test("idle SSE closes on the authorization heartbeat and on cancellation", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let valid = true;
  let unsubscribed = false;
  const stream = guardedEventStream(new AbortController().signal, () => valid, () => () => { unsubscribed = true; });
  const reader = stream.getReader();
  valid = false;
  t.mock.timers.tick(15000);
  assert.equal((await reader.read()).done, true);
  assert.equal(unsubscribed, true);
  let canceled = false;
  const other = guardedEventStream(new AbortController().signal, () => true, () => () => { canceled = true; });
  await other.cancel();
  assert.equal(canceled, true);
});

test("agent operations refuse unrelated PiWorkers with colliding names", () => {
  assert.throws(() => assertManagedPiWorker({}));
  assert.throws(() => assertManagedPiWorker({ metadata: { labels: { "app.kubernetes.io/managed-by": "other-app" } } }));
  assert.doesNotThrow(() => assertManagedPiWorker({ metadata: { labels: { "app.kubernetes.io/managed-by": "webcontainer" } } }));
});

test("legacy public snapshot entry point always returns 404", () => {
  assert.equal(proxy().status, 404);
});

const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...key.publicKey.export({ format: "jwk" }), kid: "test", alg: "RS256", use: "sig" };
let changes: Record<string, unknown> = {};
let signingKey = key.privateKey;
let tokenAlgorithm = "RS256";
const originalFetch = globalThis.fetch;
let exchangedVerifier = "";
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.endsWith("/.well-known/openid-configuration")) return Response.json({
    issuer: process.env.AUTH_ISSUER, authorization_endpoint: "https://identity.test/oidc/auth",
    token_endpoint: "https://identity.test/oidc/token", jwks_uri: "https://identity.test/jwks",
    end_session_endpoint: "https://identity.test/oidc/session/end", response_types_supported: ["code"],
    subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
  });
  if (url === "https://identity.test/jwks") return Response.json({ keys: [jwk] });
  if (url === "https://identity.test/oidc/token") {
    exchangedVerifier = new URLSearchParams(String(init?.body)).get("code_verifier") ?? "";
    const header = Buffer.from(JSON.stringify({ alg: tokenAlgorithm, kid: "test" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iss: process.env.AUTH_ISSUER, aud: "test-client", sub: "oidc-user", exp: expiry(), iat: Math.floor(Date.now() / 1000), nonce: "test-nonce", ...changes })).toString("base64url");
    const data = `${header}.${payload}`;
    const signature = sign("RSA-SHA256", Buffer.from(data), signingKey).toString("base64url");
    return Response.json({ access_token: "access-token", token_type: "Bearer", id_token: `${data}.${signature}` });
  }
  throw new Error(`Unexpected network request: ${url}`);
};

function callbackRequest(state = "test-state") {
  const token = saveLogin({ state: "test-state", nonce: "test-nonce", verifier: "a".repeat(43), returnTo: "/workspaces/project-a" });
  return { token, run: () => context(token, () => callback.GET(new Request(`https://console.test/auth/callback?code=test-code&state=${state}`)), TRANSACTION_COOKIE) };
}

test("login creates a bound S256 authorization request without exposing the verifier", async () => {
  const response = await context(null, () => login.GET(new Request("https://console.test/auth/login?returnTo=//evil.test")));
  assert.equal(response.status, 307);
  const target = new URL(response.headers.get("location")!);
  assert.equal(target.origin, "https://identity.test");
  assert.equal(target.searchParams.get("code_challenge_method"), "S256");
  assert.equal(target.searchParams.get("redirect_uri"), "https://console.test/auth/callback");
  assert.equal(target.searchParams.get("response_type"), "code");
  assert.equal(target.searchParams.get("ui_locales"), "zh-CN");
  assert.ok(target.searchParams.get("state"));
  assert.ok(target.searchParams.get("nonce"));
  assert.equal(target.searchParams.get("client_secret"), null);
  const token = response.headers.get("set-cookie")!.match(/__Host-pi-login=([^;]+)/)![1];
  const transaction = consumeLogin(token)!;
  assert.equal(transaction.state, target.searchParams.get("state"));
  assert.equal(transaction.returnTo, "/");
  assert.notEqual(transaction.verifier, target.searchParams.get("code_challenge"));
});

test("OIDC callback validates signed tokens, PKCE verifier, secure cookies, and replay", async () => {
  const transaction = callbackRequest();
  const response = await transaction.run();
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "https://console.test/workspaces/project-a");
  assert.equal(exchangedVerifier, "a".repeat(43));
  const cookie = response.headers.get("set-cookie")!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=lax/i);
  assert.equal((await transaction.run()).status, 400);
});

test("OIDC callback rejects state, nonce, audience, issuer, expiration, and wrong signature", async () => {
  const stateMismatch = await callbackRequest("wrong-state").run();
  assert.equal(stateMismatch.status, 400);
  assert.equal(stateMismatch.headers.get("x-auth-reason"), "STATE_MISMATCH");
  for (const invalid of [{ nonce: "wrong" }, { aud: "wrong" }, { iss: "https://evil.test" }, { exp: 1 }]) {
    changes = invalid;
    assert.equal((await callbackRequest().run()).status, 400, JSON.stringify(invalid));
  }
  changes = {};
  signingKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  assert.equal((await callbackRequest().run()).status, 400);
  signingKey = key.privateKey;
});

test("callback identifies a rejected HS256 token instead of silently accepting a downgrade", async () => {
  tokenAlgorithm = "HS256";
  try {
    const response = await callbackRequest().run();
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("x-auth-reason"), "JWT_ALGORITHM_MISMATCH");
    const text = await response.text();
    assert.match(text, /预期算法：RS256；实际算法：HS256/);
  } finally { tokenAlgorithm = "RS256"; }
});

test("callback diagnostics distinguish missing cookies and expired attempts without leaking codes", async (t) => {
  const logs = t.mock.method(console, "warn", () => {});
  const missing = await context(null, () => callback.GET(new Request("https://console.test/auth/callback?code=do-not-log-code&state=do-not-log-state")));
  assert.equal(missing.status, 400);
  assert.equal(missing.headers.get("x-auth-error"), "LOGIN_COOKIE_MISSING");
  const missingText = await missing.text();
  assert.match(missingText, /登录失败或已过期/);
  assert.match(missingText, /错误编号：/);
  assert.ok(!missingText.includes("do-not-log-code"));
  const expired = await context("unknown-transaction", () => callback.GET(new Request("https://console.test/auth/callback?code=do-not-log-code")), TRANSACTION_COOKIE);
  assert.equal(expired.headers.get("x-auth-error"), "LOGIN_TRANSACTION_EXPIRED");
  const logged = JSON.stringify(logs.mock.calls.map(call => call.arguments));
  assert.ok(!logged.includes("do-not-log-code"));
  assert.ok(!logged.includes("do-not-log-state"));
  assert.ok(!logged.includes("unknown-transaction"));
});

test("logout revokes sessions and redirects to provider with fixed return URL", async () => {
  const session = createSession("logout", "Logout", "test-id-token", expiry());
  const response = await context(session.token, () => logout.POST(request("POST")));
  assert.equal(response.status, 303);
  assert.equal(sessionUser(session.token), null);
  const target = new URL(response.headers.get("location")!);
  assert.equal(target.origin, "https://identity.test");
  assert.equal(target.searchParams.get("post_logout_redirect_uri"), "https://console.test/");
});

after(() => {
  globalThis.fetch = originalFetch;
  getDb().close();
  rmSync(root, { recursive: true, force: true });
});

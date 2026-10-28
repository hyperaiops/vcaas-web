import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

function inspect(origin: string, mode: "development" | "production" | "test", issuer = "https://identity.test/oidc", allowHttpLocalhost = false) {
  const result = spawnSync(process.execPath, [
    "--conditions=react-server", "--import", "tsx", "--input-type=module", "-e",
    `import { authConfig, cookieOptions, SESSION_COOKIE } from './app/lib/auth/config.ts';
     try {
       const config = authConfig();
       console.log(JSON.stringify({ allowed: true, callback: config.callback, secure: cookieOptions.secure, cookie: SESSION_COOKIE }));
     } catch { console.log(JSON.stringify({ allowed: false })); }`,
  ], {
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: mode, AUTH_ORIGIN: origin, AUTH_ISSUER: issuer,
      AUTH_ALLOW_HTTP_LOCALHOST: String(allowHttpLocalhost),
      AUTH_CLIENT_SECRET: "test-only", AUTH_SESSION_KEY: "12".repeat(32) },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("local HTTP development uses a localhost callback and non-Host cookies", () => {
  const result = inspect("http://localhost:3000", "development");
  assert.equal(result.allowed, true);
  assert.equal(result.callback, "http://localhost:3000/auth/callback");
  assert.equal(result.secure, false);
  assert.equal(result.cookie, "pi-session-dev");
});

test("production localhost HTTP is allowed only by explicit debugging opt-in", () => {
  const debug = inspect("http://localhost:3000", "production", "https://identity.test/oidc", true);
  assert.equal(debug.allowed, true);
  assert.equal(debug.callback, "http://localhost:3000/auth/callback");
  assert.equal(debug.secure, false);
  assert.equal(debug.cookie, "pi-session-dev");
  assert.equal(inspect("http://untrusted.test", "production", "https://identity.test/oidc", true).allowed, false);
  assert.equal(inspect("http://localhost.evil.test", "production", "https://identity.test/oidc", true).allowed, false);
  assert.equal(inspect("http://localhost:3000", "production", "http://identity.test/oidc", true).allowed, false);
});

test("production and non-loopback development still require HTTPS", () => {
  assert.equal(inspect("http://localhost:3000", "production").allowed, false);
  assert.equal(inspect("http://untrusted.test", "development").allowed, false);
  assert.equal(inspect("http://localhost:3000", "development", "http://identity.test/oidc").allowed, false);
  const production = inspect("https://console.test", "production");
  assert.equal(production.allowed, true);
  assert.equal(production.secure, true);
  assert.equal(production.cookie, "__Host-pi-session");
});

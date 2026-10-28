import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const script = path.resolve("scripts/sync-k8s-secret.mjs");

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-secret-script-"));
  const envFile = path.join(directory, ".env.local");
  const capture = path.join(directory, "capture.json");
  writeFileSync(envFile, [
    "PI_LITELLM_BASE_URL= http://example.test:4000",
    "PI_LITELLM_API_KEY=fixture-api-key",
    "AUTH_CLIENT_SECRET='fixture-client-secret'",
    `AUTH_SESSION_KEY=${"ab".repeat(32)}`,
    "AUTH_ORIGIN=http://localhost:3000",
    "UNRELATED_SECRET=must-not-upload",
  ].join("\n"), { mode: 0o600 });
  writeFileSync(path.join(directory, "kubectl"), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('get')) {
  if (process.env.FIXTURE_EXISTING === '1') process.stdout.write('Opaque\\t123\\twebcontainer');
} else if (args.includes('create') || args.includes('patch')) {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  fs.writeFileSync(process.env.FIXTURE_CAPTURE, JSON.stringify({args,input}));
  if (process.env.FIXTURE_FAILURE === '1') {
    process.stderr.write('server rejected fixture-client-secret fixture-api-key');
    process.exitCode = 1;
  } else process.stdout.write('secret/webcontainer-env');
} else process.exitCode = 1;
`, { mode: 0o700 });
  return {
    run(args: string[] = [], extra: Record<string, string> = {}) {
      return spawnSync(process.execPath, [script, "--context", "fixture", "--env-file", envFile, ...args], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}`, FIXTURE_CAPTURE: capture,
          PI_LITELLM_API_KEY: "wrong-process-value", ...extra },
      });
    },
    captured() { return JSON.parse(readFileSync(capture, "utf8")); },
    cleanup() { rmSync(directory, { recursive: true, force: true }); },
  };
}

test("Secret script uploads only four file values, handles whitespace, and never prints credentials", () => {
  const f = fixture();
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    const { args, input } = f.captured();
    assert.equal(input.metadata.namespace, "agents");
    assert.equal(input.metadata.name, "webcontainer-env");
    assert.deepEqual(Object.keys(input.stringData).sort(), ["AUTH_CLIENT_SECRET", "AUTH_SESSION_KEY", "PI_LITELLM_API_KEY", "PI_LITELLM_BASE_URL"]);
    assert.equal(input.stringData.PI_LITELLM_BASE_URL, "http://example.test:4000");
    assert.equal(input.stringData.PI_LITELLM_API_KEY, "fixture-api-key");
    assert.equal(input.stringData.AUTH_CLIENT_SECRET, "fixture-client-secret");
    assert.equal(input.stringData.UNRELATED_SECRET, undefined);
    for (const value of Object.values(input.stringData) as string[]) {
      assert.ok(!result.stdout.includes(value));
      assert.ok(!result.stderr.includes(value));
      assert.ok(!args.join(" ").includes(value));
    }
  } finally { f.cleanup(); }
});

test("existing Secrets require explicit update, which uses an optimistic merge patch over stdin", () => {
  const f = fixture();
  try {
    const rejected = f.run([], { FIXTURE_EXISTING: "1" });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /--update/);
    const updated = f.run(["--update"], { FIXTURE_EXISTING: "1" });
    assert.equal(updated.status, 0, updated.stderr);
    const { args, input } = f.captured();
    assert.ok(args.includes("patch"));
    assert.ok(args.includes("--patch-file=/dev/stdin"));
    assert.equal(input.metadata.resourceVersion, "123");
    assert.ok(!("data" in input));
  } finally { f.cleanup(); }
});

test("dry-run uses server validation; failed kubectl output cannot expose submitted values", () => {
  const f = fixture();
  try {
    assert.equal(f.run(["--dry-run"]).status, 0);
    assert.ok(f.captured().args.includes("--dry-run=server"));
    const failed = f.run([], { FIXTURE_FAILURE: "1" });
    assert.equal(failed.status, 1);
    assert.ok(!failed.stderr.includes("fixture-client-secret"));
    assert.ok(!failed.stderr.includes("fixture-api-key"));
  } finally { f.cleanup(); }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
// Resolve tsx's existing esbuild dependency without adding a package dependency.
const { build } = createRequire(require.resolve("tsx"))("esbuild") as {
  build(options: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
};
type TestBundler = {
  onResolve(options: { filter: RegExp }, callback: () => { path: string; namespace: string }): void;
  onLoad(options: { filter: RegExp; namespace: string }, callback: () => { contents: string }): void;
};
const here = path.dirname(fileURLToPath(import.meta.url));
const chrome = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

test("AgentPanel browser lease lifecycle", { timeout: 60_000 }, async (t) => {
  try { await access(chrome); } catch { t.skip("Set CHROME_BIN to an installed Chromium browser"); return; }
  const bundle = await build({
    entryPoints: [path.join(here, "agent-panel.browser.jsx")],
    bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
    conditions: ["browser"],
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [{ name: "mock-auth-fetch", setup(builder: TestBundler) {
      builder.onResolve({ filter: /app\/lib\/auth\/client$/ }, () => ({ path: "mock-auth", namespace: "test" }));
      builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: "export const authenticatedFetch = (...args) => window.fetch(...args);" }));
    } }],
  });
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", req.url === "/test.js" ? "text/javascript" : "text/html");
    res.end(req.url === "/test.js" ? bundle.outputFiles[0].text : '<!doctype html><div id="root"></div><pre id="result">PENDING</pre><script src="/test.js"></script>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const profile = await mkdtemp(path.join(tmpdir(), "agent-panel-chrome-"));
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(chrome, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-background-networking", `--user-data-dir=${profile}`, "--dump-dom", "--virtual-time-budget=10000", `http://127.0.0.1:${address.port}`]);
      let stdout = "";
      child.stdout.on("data", (data) => { stdout += data; });
      child.stderr.resume();
      const timer = setTimeout(() => { child.kill(); reject(new Error("Chrome lifecycle harness timed out")); }, 45_000);
      child.on("error", reject);
      child.on("close", (code) => { clearTimeout(timer); if (code === 0) resolve(stdout); else reject(new Error(`Chrome exited ${code}`)); });
    });
    assert.match(output, /PASS: actual React StrictMode/, output);
    assert.doesNotMatch(output, /FAIL:|PENDING/);
    t.diagnostic(output.match(/PASS:[^<]+/)?.[0] ?? "Browser assertions passed");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(profile, { recursive: true, force: true });
  }
});

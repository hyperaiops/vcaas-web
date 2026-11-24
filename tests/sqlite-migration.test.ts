import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync as Database } from "node:sqlite";

type Scenario = "fresh" | "legacy" | "current";
const issuer = "https://issuer.example.test/oidc";
const sessionKey = "42".repeat(32);
const activeToken = "existing-browser-session";
const activeIdToken = "existing-encrypted-id-token";
const existingLogin = "existing-browser-login";
const expiredToken = "expired-browser-session";
const expiredLogin = "expired-browser-login";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

// Seed exactly the on-disk pre-Prisma formats, independently of application code.
function seedDatabase(file: string, scenario: Exclude<Scenario, "fresh">): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  try {
    db.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision TEXT
        ${scenario === "current" ? ", owner_id TEXT" : ""}
      );
      CREATE TABLE auth_users (
        id TEXT PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL,
        name TEXT NOT NULL, UNIQUE(issuer, subject)
      );
      CREATE TABLE auth_sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES auth_users(id),
        expires_at INTEGER NOT NULL, id_token TEXT NOT NULL
      );
      CREATE TABLE auth_transactions (
        token_hash TEXT PRIMARY KEY, state TEXT NOT NULL, nonce TEXT NOT NULL,
        verifier TEXT NOT NULL, return_to TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
    `);
    const created = "2022-02-03T04:05:06.007Z";
    const updated = "2023-03-04T05:06:07.008Z";
    db.prepare(`INSERT INTO workspaces (id, name, root_path, created_at, updated_at, revision)
      VALUES (?, ?, ?, ?, ?, ?)`).run("old-workspace", "Old", "/old/root", created, updated, "old-revision");
    if (scenario === "current") {
      db.exec("CREATE INDEX workspaces_owner ON workspaces(owner_id); CREATE TABLE workspace_ids (id TEXT PRIMARY KEY)");
      db.prepare("INSERT INTO workspace_ids VALUES (?), (?)").run("old-workspace", "deleted-workspace");
      db.prepare("UPDATE workspaces SET owner_id = ? WHERE id = ?").run("existing-owner", "old-workspace");
    }
    const iv = Buffer.alloc(12, 7);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(sessionKey, "hex"), iv);
    const data = Buffer.concat([cipher.update(activeIdToken, "utf8"), cipher.final()]);
    const encrypted = Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
    db.prepare("INSERT INTO auth_users VALUES (?, ?, ?, ?)").run("existing-user", issuer, "subject", "Existing User");
    const insertSession = db.prepare("INSERT INTO auth_sessions VALUES (?, ?, ?, ?)");
    insertSession.run(digest(activeToken), "existing-user", Date.now() + 3_600_000, encrypted);
    insertSession.run(digest(expiredToken), "existing-user", Date.now() - 10_000, encrypted);
    const insertLogin = db.prepare("INSERT INTO auth_transactions VALUES (?, ?, ?, ?, ?, ?)");
    insertLogin.run(digest(existingLogin), "old-state", "old-nonce", "old-verifier", "/old", Date.now() + 600_000);
    insertLogin.run(digest(expiredLogin), "expired", "expired", "expired", "/", Date.now() - 10_000);
  } finally {
    db.close();
  }
}

async function runScenario(scenario: Scenario, file: string): Promise<void> {
  if (scenario !== "fresh") seedDatabase(file, scenario);

  // Import only after the child process has received its disposable DB path.
  const db = await import("../app/lib/db");
  const auth = await import("../app/lib/auth/store");
  const prisma = await db.getPrisma();
  try {
    const raw = new Database(file, { readOnly: true });
    try {
      const columns = raw.prepare("PRAGMA table_info(workspaces)").all() as { name: string }[];
      assert.ok(columns.some((column) => column.name === "owner_id"));
      const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
      for (const name of ["workspaces", "workspace_ids", "auth_users", "auth_sessions", "auth_transactions"]) {
        assert.ok(tables.some((table) => table.name === name), `missing ${name}`);
      }
    } finally {
      raw.close();
    }

    if (scenario === "fresh") {
      assert.deepEqual(await db.listWorkspaces("owner-a"), []);
      assert.equal(await db.workspaceIdUsed("old-workspace"), false);
    } else {
      const old = {
        id: "old-workspace", name: "Old", rootPath: "/old/root",
        createdAt: "2022-02-03T04:05:06.007Z", updatedAt: "2023-03-04T05:06:07.008Z",
        revision: "old-revision",
      };
      assert.deepEqual(await db.getWorkspace("old-workspace"), old);
      assert.deepEqual(await db.getWorkspaceByRoot("/old/root"), old);
      assert.equal(await db.workspaceIdUsed("old-workspace"), true);
      assert.deepEqual(await db.getOwnedWorkspace("old-workspace", "existing-owner"), scenario === "current" ? old : null);
      assert.deepEqual(await db.listWorkspaces("existing-owner"), scenario === "current" ? [old] : []);
      if (scenario === "current") assert.equal(await db.workspaceIdUsed("deleted-workspace"), true);
      assert.deepEqual(await auth.sessionUser(activeToken), { id: "existing-user", name: "Existing User" });
      assert.equal(await auth.sessionUser(expiredToken), null);
      assert.deepEqual(await auth.consumeLogin(existingLogin), {
        state: "old-state", nonce: "old-nonce", verifier: "old-verifier", returnTo: "/old",
      });
      assert.equal(await auth.consumeLogin(existingLogin), null);
      assert.equal(await auth.consumeLogin(expiredLogin), null);
      const additional = await auth.createSession("subject", "Updated User", "additional-id-token", Math.floor(Date.now() / 1000) + 3600);
      assert.deepEqual(await auth.sessionUser(additional.token), { id: "existing-user", name: "Updated User" });
      assert.deepEqual(await auth.sessionUser(activeToken), { id: "existing-user", name: "Updated User" });
      assert.equal(await auth.revokeSession(additional.token), "additional-id-token");
      assert.equal(await auth.revokeSession(activeToken), activeIdToken);
      assert.equal(await auth.sessionUser(activeToken), null);
      assert.equal(await auth.revokeSession(activeToken), null);
    }

    const created = await db.createWorkspace({ id: "new-workspace", name: "New", rootPath: "/new/root", ownerId: "owner-a" });
    assert.equal(created.id, "new-workspace");
    assert.equal(created.name, "New");
    assert.equal(created.rootPath, "/new/root");
    assert.equal(created.revision, null);
    assert.ok(Number.isFinite(Date.parse(created.createdAt)));
    assert.equal(created.updatedAt, created.createdAt);
    assert.deepEqual(await db.getWorkspace("new-workspace"), created);
    assert.deepEqual(await db.getOwnedWorkspace("new-workspace", "owner-a"), created);
    assert.equal(await db.getOwnedWorkspace("new-workspace", "owner-b"), null);
    assert.deepEqual(await db.listWorkspaces("owner-a"), [created]);
    assert.deepEqual(await db.listWorkspaces("owner-b"), []);

    await db.updateWorkspaceRevision("new-workspace", "unauthorized", "owner-b");
    assert.equal((await db.getWorkspace("new-workspace"))?.revision, null);
    await db.updateWorkspaceRevision("new-workspace", "new-revision", "owner-a");
    assert.equal((await db.getWorkspace("new-workspace"))?.revision, "new-revision");
    const existsError = (error: unknown) => error instanceof db.WorkspaceError && error.code === "WORKSPACE_EXISTS";
    await assert.rejects(db.createWorkspace({ id: "new-workspace", name: "Duplicate", rootPath: "/other/root", ownerId: "owner-a" }), existsError);
    await assert.rejects(db.createWorkspace({ id: "unused-id", name: "Duplicate", rootPath: "/new/root", ownerId: "owner-a" }), existsError);
    assert.equal(await db.workspaceIdUsed("unused-id"), false, "failed creation must roll back its ID reservation");
    assert.equal(await db.deleteWorkspace("new-workspace", "owner-b"), false);
    assert.equal(await db.deleteWorkspace("new-workspace", "owner-a"), true);
    assert.equal(await db.getWorkspace("new-workspace"), null);
    assert.equal(await db.workspaceIdUsed("new-workspace"), true);
    await assert.rejects(db.createWorkspace({ id: "new-workspace", name: "Reused", rootPath: "/new/root", ownerId: "owner-a" }), existsError);
    if (scenario === "current") {
      await assert.rejects(db.createWorkspace({ id: "deleted-workspace", name: "Reused", rootPath: "/deleted/root", ownerId: "owner-a" }), existsError);
    }
    const races = await Promise.allSettled([
      db.createWorkspace({ id: "race-id", name: "One", rootPath: "/race/one", ownerId: "owner-a" }),
      db.createWorkspace({ id: "race-id", name: "Two", rootPath: "/race/two", ownerId: "owner-a" }),
    ]);
    assert.equal(races.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = races.find((result) => result.status === "rejected");
    assert.ok(rejected && rejected.status === "rejected" && existsError(rejected.reason));
    const pathRaces = await Promise.allSettled([
      db.createWorkspace({ id: "path-race-a", name: "One", rootPath: "/race/shared", ownerId: "owner-a" }),
      db.createWorkspace({ id: "path-race-b", name: "Two", rootPath: "/race/shared", ownerId: "owner-a" }),
    ]);
    assert.equal(pathRaces.filter((result) => result.status === "fulfilled").length, 1);
    const failedIndex = pathRaces.findIndex((result) => result.status === "rejected");
    assert.notEqual(failedIndex, -1);
    const pathRejected = pathRaces[failedIndex];
    assert.ok(pathRejected.status === "rejected" && existsError(pathRejected.reason));
    assert.equal(await db.workspaceIdUsed(failedIndex === 0 ? "path-race-a" : "path-race-b"), false);

    const login = { state: "new-state", nonce: "new-nonce", verifier: "new-verifier", returnTo: "/return" };
    const loginToken = await auth.saveLogin(login);
    const consumed = await Promise.all([auth.consumeLogin(loginToken), auth.consumeLogin(loginToken)]);
    assert.equal(consumed.filter((value) => value !== null).length, 1);
    assert.deepEqual(consumed.find((value) => value !== null), login);

    const session = await auth.createSession("new-subject", "New User", "new-id-token", Math.floor(Date.now() / 1000) + 3600);
    assert.deepEqual((await auth.sessionUser(session.token))?.name, "New User");
    const rawAuth = new Database(file, { readOnly: true });
    try {
      const stored = rawAuth.prepare("SELECT token_hash, id_token FROM auth_sessions WHERE token_hash = ?").get(digest(session.token)) as { token_hash: string; id_token: string } | undefined;
      assert.ok(stored);
      assert.notEqual(stored.token_hash, session.token);
      assert.notEqual(stored.id_token, "new-id-token");
    } finally {
      rawAuth.close();
    }
    const revoked = await Promise.all([auth.revokeSession(session.token), auth.revokeSession(session.token)]);
    assert.deepEqual(revoked.filter((value) => value !== null), ["new-id-token"]);
    assert.equal(await auth.sessionUser(session.token), null);
    const expired = await auth.createSession("expired-subject", "Expired", "expired-id-token", Math.floor(Date.now() / 1000) - 1);
    assert.equal(await auth.sessionUser(expired.token), null);
  } finally {
    await prisma.$disconnect();
  }
}

async function verifyRestart(scenario: Scenario): Promise<void> {
  const db = await import("../app/lib/db");
  const prisma = await db.getPrisma();
  try {
    assert.equal(await db.workspaceIdUsed("new-workspace"), true);
    assert.equal(await db.getWorkspace("new-workspace"), null);
    assert.ok(await db.getOwnedWorkspace("race-id", "owner-a"));
    if (scenario !== "fresh") {
      assert.equal((await db.getWorkspace("old-workspace"))?.revision, "old-revision");
      assert.equal(await db.workspaceIdUsed("old-workspace"), true);
    }
    if (scenario === "current") {
      assert.equal(await db.workspaceIdUsed("deleted-workspace"), true);
      assert.equal((await db.getOwnedWorkspace("old-workspace", "existing-owner"))?.name, "Old");
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (process.env.SQLITE_MIGRATION_TEST_CHILD === "1") {
  const scenario = process.env.SQLITE_MIGRATION_TEST_SCENARIO as Scenario;
  const file = process.env.SQLITE_MIGRATION_TEST_ABSOLUTE_PATH!;
  const run = process.env.SQLITE_MIGRATION_TEST_RESTART === "1" ? verifyRestart(scenario) : runScenario(scenario, file);
  run.catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  for (const scenario of ["fresh", "legacy", "current"] as const) {
    test(`SQLite ${scenario} migration preserves workspaces and authentication`, () => {
      const temp = mkdtempSync(path.join(tmpdir(), "workspace-sqlite-test-"));
      try {
        const file = path.join(temp, "nested", "workspace.db");
        // Keep even the default DB path inside the temporary directory; never alter parent cwd/env.
        const dbPath = scenario === "legacy" ? path.relative(temp, file) : file;
        const loader = createRequire(import.meta.url).resolve("tsx");
        for (const restart of [false, true]) {
          const result = spawnSync(process.execPath, ["--conditions=react-server", "--import", loader, fileURLToPath(import.meta.url)], {
            cwd: temp,
            env: {
              ...process.env,
              SQLITE_MIGRATION_TEST_CHILD: "1",
              SQLITE_MIGRATION_TEST_SCENARIO: scenario,
              SQLITE_MIGRATION_TEST_ABSOLUTE_PATH: file,
              SQLITE_MIGRATION_TEST_RESTART: restart ? "1" : "0",
              WORKSPACE_DB_PATH: dbPath,
              DATABASE_URL: `file:${path.join(temp, "unexpected.db")}`,
              AUTH_ORIGIN: "https://app.example.test",
              AUTH_ISSUER: issuer,
              AUTH_CLIENT_SECRET: "test-client-secret",
              AUTH_SESSION_KEY: sessionKey,
            },
            encoding: "utf8",
            timeout: 30_000,
          });
          assert.ifError(result.error);
          assert.equal(result.status, 0, `${scenario}${restart ? " restart" : ""} child failed:\n${result.stdout}\n${result.stderr}`);
        }
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    });
  }
}

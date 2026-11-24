import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { DatabaseSync as Database } from "node:sqlite";
import { getPrisma } from "../app/lib/db";
import { consumeLogin, createSession, revokeSession, saveLogin, sessionUser } from "../app/lib/auth/store";

const dir = mkdtempSync(path.join(tmpdir(), "auth-store-"));
const file = path.join(dir, "workspaces.db");
process.env.WORKSPACE_DB_PATH = file;
process.env.AUTH_CLIENT_SECRET = "test-secret";
process.env.AUTH_SESSION_KEY = "12".repeat(32);
process.env.AUTH_ORIGIN = "https://example.test";
process.env.AUTH_ISSUER = "https://issuer.example.test";
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

after(async () => {
  const db = await getPrisma();
  await db.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

test("login transactions are hashed, expire and can only be consumed once", async () => {
  const transaction = { state: "state", nonce: "nonce", verifier: "verifier", returnTo: "/workspaces" };
  const token = await saveLogin(transaction);
  const db = await getPrisma();
  const stored = await db.authTransaction.findUniqueOrThrow({
    where: { tokenHash: tokenHash(token) }, select: { tokenHash: true },
  });
  assert.notEqual(stored.tokenHash, token);
  const results = await Promise.all(Array.from({ length: 8 }, () => consumeLogin(token)));
  assert.deepEqual(results.filter((result) => result !== null), [transaction]);
  assert.equal(await consumeLogin(token), null);

  const expired = await saveLogin(transaction);
  await db.authTransaction.update({
    where: { tokenHash: tokenHash(expired) }, data: { expiresAt: BigInt(Date.now() - 1) }, select: { tokenHash: true },
  });
  assert.equal(await consumeLogin(expired), null);
  assert.equal(await db.authTransaction.findUnique({ where: { tokenHash: tokenHash(expired) } }), null);

  const distant = await saveLogin(transaction);
  await db.authTransaction.update({ where: { tokenHash: tokenHash(distant) }, data: { expiresAt: BigInt("9223372036854775807") }, select: { tokenHash: true } });
  assert.deepEqual(await consumeLogin(distant), transaction);
});

test("sessions retain user identity, encrypt ID tokens and revoke once", async () => {
  const db = await getPrisma();
  const first = await createSession("subject", "Original", "id-token-one", Math.floor(Date.now() / 1000) + 3600);
  const firstUser = await sessionUser(first.token);
  assert.equal(firstUser?.name, "Original");
  const row = await db.authSession.findUniqueOrThrow({
    where: { tokenHash: tokenHash(first.token) }, select: { tokenHash: true, idToken: true },
  });
  assert.notEqual(row.tokenHash, first.token);
  assert.notEqual(row.idToken, "id-token-one");
  // Cast the existing INTEGER column before Prisma decodes it as a 32-bit value.
  const expiry = await db.$queryRaw<{ expiresAt: string }[]>`
    SELECT CAST(expires_at AS TEXT) AS expiresAt FROM auth_sessions WHERE token_hash = ${tokenHash(first.token)}
  `;
  assert.equal(BigInt(expiry[0].expiresAt), BigInt(first.expiresAt));

  const second = await createSession("subject", "Renamed", "id-token-two", Math.floor(Date.now() / 1000) + 3600);
  assert.deepEqual(await sessionUser(second.token), { id: firstUser?.id, name: "Renamed" });
  assert.deepEqual(await sessionUser(first.token), { id: firstUser?.id, name: "Renamed" });
  process.env.AUTH_ISSUER = "https://another-issuer.example.test";
  try {
    assert.equal(await sessionUser(first.token), null);
  } finally {
    process.env.AUTH_ISSUER = "https://issuer.example.test";
  }
  const results = await Promise.all(Array.from({ length: 8 }, () => revokeSession(first.token)));
  assert.deepEqual(results.filter((result) => result !== null), ["id-token-one"]);
  assert.equal(await sessionUser(first.token), null);
  assert.equal(await revokeSession(first.token), null);
  await db.authSession.update({
    where: { tokenHash: tokenHash(second.token) }, data: { expiresAt: BigInt(Date.now() - 1) }, select: { tokenHash: true },
  });
  assert.equal(await sessionUser(second.token), null);
  assert.equal(await revokeSession(second.token), "id-token-two");
});

test("session creation rolls back cleanup and user upsert if session insertion fails", async () => {
  const db = await getPrisma();
  const existing = await createSession("existing", "Existing", "existing-token", Math.floor(Date.now() / 1000) + 3600);
  await db.authSession.update({ where: { tokenHash: tokenHash(existing.token) }, data: { expiresAt: BigInt(1) } });
  const sqlite = new Database(file);
  try {
    sqlite.exec("CREATE TRIGGER reject_test_session BEFORE INSERT ON auth_sessions BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    await assert.rejects(createSession("new-subject", "New", "new-token", Math.floor(Date.now() / 1000) + 3600));
    assert.notEqual(await db.authSession.findUnique({ where: { tokenHash: tokenHash(existing.token) } }), null);
    assert.equal(await db.authUser.findFirst({ where: { subject: "new-subject" } }), null);
  } finally {
    sqlite.exec("DROP TRIGGER IF EXISTS reject_test_session");
    sqlite.close();
  }
});

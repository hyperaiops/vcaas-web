import "server-only";
import { createHash, randomBytes, randomUUID, createCipheriv, createDecipheriv } from "node:crypto";
import { getPrisma } from "../db";
import { authConfig } from "./config";

export type User = { id: string; name: string };
export type LoginTransaction = { state: string; nonce: string; verifier: string; returnTo: string };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const randomToken = () => randomBytes(32).toString("base64url");

function encrypt(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", authConfig().encryptionKey, iv);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
}

function decrypt(value: string): string {
  const data = Buffer.from(value, "base64url");
  const cipher = createDecipheriv("aes-256-gcm", authConfig().encryptionKey, data.subarray(0, 12));
  cipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString("utf8");
}

export async function saveLogin(transaction: LoginTransaction): Promise<string> {
  const db = await getPrisma();
  await db.authTransaction.deleteMany({ where: { expiresAt: { lte: BigInt(Date.now()) } } });
  const token = randomToken();
  // Legacy SQLite columns are declared INTEGER. Prisma's native SQLite engine
  // decodes returned INTEGER values as 32-bit even when the model uses BigInt.
  // Do not return the millisecond timestamp from this write.
  await db.authTransaction.create({
    data: { tokenHash: hash(token), ...transaction, expiresAt: BigInt(Date.now() + 600_000) },
    select: { tokenHash: true },
  });
  return token;
}

export async function consumeLogin(token: string): Promise<LoginTransaction | null> {
  const db = await getPrisma();
  // Deleting and returning in one statement guarantees that only one callback can consume the token.
  // Return the integer as text so even an out-of-range 64-bit timestamp is compared without precision loss.
  const rows = await db.$queryRaw<{ state: string; nonce: string; verifier: string; return_to: string; expires_at: string }[]>`
    DELETE FROM auth_transactions WHERE token_hash = ${hash(token)}
    RETURNING state, nonce, verifier, return_to, CAST(expires_at AS TEXT) AS expires_at
  `;
  const row = rows[0];
  if (!row || BigInt(row.expires_at) <= BigInt(Date.now())) return null;
  return { state: row.state, nonce: row.nonce, verifier: row.verifier, returnTo: row.return_to };
}

export async function createSession(subject: string, name: string, idToken: string, tokenExpiry: number): Promise<{ token: string; expiresAt: number }> {
  const db = await getPrisma();
  const issuer = authConfig().issuer;
  const token = randomToken();
  const expiresAt = Math.floor(Math.min(Date.now() + 8 * 60 * 60_000, tokenExpiry * 1000));
  if (!Number.isFinite(tokenExpiry) || !Number.isSafeInteger(expiresAt)) {
    throw new Error("Invalid session expiration");
  }
  const encrypted = encrypt(idToken);
  await db.$transaction(async (tx) => {
    await tx.authSession.deleteMany({ where: { expiresAt: { lte: BigInt(Date.now()) } } });
    const user = await tx.authUser.upsert({
      where: { issuer_subject: { issuer, subject } },
      create: { id: randomUUID(), issuer, subject, name },
      update: { name },
      select: { id: true },
    });
    await tx.authSession.create({
      data: { tokenHash: hash(token), userId: user.id, expiresAt: BigInt(expiresAt), idToken: encrypted },
      select: { tokenHash: true },
    });
  });
  return { token, expiresAt };
}

export async function sessionUser(token: string): Promise<User | null> {
  const db = await getPrisma();
  const session = await db.authSession.findFirst({
    where: { tokenHash: hash(token), expiresAt: { gt: BigInt(Date.now()) }, user: { issuer: authConfig().issuer } },
    select: { user: { select: { id: true, name: true } } },
  });
  return session?.user ?? null;
}

export async function revokeSession(token: string): Promise<string | null> {
  const db = await getPrisma();
  const rows = await db.$queryRaw<{ id_token: string }[]>`
    DELETE FROM auth_sessions WHERE token_hash = ${hash(token)} RETURNING id_token
  `;
  const row = rows[0];
  if (!row) return null;
  try { return decrypt(row.id_token); } catch { return null; }
}

import "server-only";
import { createHash, randomBytes, randomUUID, createCipheriv, createDecipheriv } from "node:crypto";
import { getDb } from "../db";
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

export function saveLogin(transaction: LoginTransaction): string {
  const db = getDb();
  db.prepare("DELETE FROM auth_transactions WHERE expires_at <= ?").run(Date.now());
  const token = randomToken();
  db.prepare("INSERT INTO auth_transactions VALUES (?, ?, ?, ?, ?, ?)").run(
    hash(token), transaction.state, transaction.nonce, transaction.verifier, transaction.returnTo, Date.now() + 600_000,
  );
  return token;
}

export function consumeLogin(token: string): LoginTransaction | null {
  const row = getDb().prepare("DELETE FROM auth_transactions WHERE token_hash = ? RETURNING *").get(hash(token)) as
    { state: string; nonce: string; verifier: string; return_to: string; expires_at: number } | undefined;
  if (!row || row.expires_at <= Date.now()) return null;
  return { state: row.state, nonce: row.nonce, verifier: row.verifier, returnTo: row.return_to };
}

export function createSession(subject: string, name: string, idToken: string, tokenExpiry: number) {
  const db = getDb();
  const issuer = authConfig().issuer;
  const token = randomToken();
  const expiresAt = Math.min(Date.now() + 8 * 60 * 60_000, tokenExpiry * 1000);
  const encrypted = encrypt(idToken);
  db.transaction(() => {
    db.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(Date.now());
    db.prepare(`INSERT INTO auth_users (id, issuer, subject, name) VALUES (?, ?, ?, ?)
      ON CONFLICT(issuer, subject) DO UPDATE SET name = excluded.name`).run(randomUUID(), issuer, subject, name);
    const user = db.prepare("SELECT id FROM auth_users WHERE issuer = ? AND subject = ?").get(issuer, subject) as { id: string };
    db.prepare("INSERT INTO auth_sessions VALUES (?, ?, ?, ?)").run(hash(token), user.id, expiresAt, encrypted);
  })();
  return { token, expiresAt };
}

export function sessionUser(token: string): User | null {
  const user = getDb().prepare(`SELECT u.id, u.name FROM auth_sessions s JOIN auth_users u ON s.user_id = u.id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.issuer = ?`).get(hash(token), Date.now(), authConfig().issuer) as User | undefined;
  return user ?? null;
}

export function revokeSession(token: string): string | null {
  const row = getDb().prepare("DELETE FROM auth_sessions WHERE token_hash = ? RETURNING id_token").get(hash(token)) as { id_token: string } | undefined;
  if (!row) return null;
  try { return decrypt(row.id_token); } catch { return null; }
}

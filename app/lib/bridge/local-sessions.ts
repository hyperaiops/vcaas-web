import "server-only";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_HEADER_BYTES = 1024 * 1024;
export type LocalSession = { file: string; version: number; dev: number; ino: number; mtime: number };

/** Inspect only a bounded header; never expose session paths or contents to clients. */
export async function inspectSession(file: string, cwd: string, now = Date.now()): Promise<LocalSession | null> {
  let handle;
  try {
    const entry = await lstat(file);
    if (!entry.isFile()) return null;
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    const age = now - info.mtimeMs;
    if (!info.isFile() || entry.dev !== info.dev || entry.ino !== info.ino || age < 0 || age > DAY_MS) return null;
    const buffer = Buffer.alloc(MAX_HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const end = buffer.subarray(0, bytesRead).indexOf(10);
    if (end < 0) return null;
    const header: unknown = JSON.parse(buffer.subarray(0, end).toString("utf8"));
    if (!header || typeof header !== "object" || !("type" in header) || header.type !== "session" ||
        !("id" in header) || typeof header.id !== "string" || !("cwd" in header) ||
        typeof header.cwd !== "string" || path.resolve(header.cwd) !== cwd) return null;
    const version = "version" in header && typeof header.version === "number" ? header.version : 1;
    if (!Number.isInteger(version) || version < 1 || version > 3) return null;
    return { file, version, dev: info.dev, ino: info.ino, mtime: info.mtimeMs };
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/** Pi chooses the newest session by filesystem mtime, scoped to its cwd. */
export async function latestSession(dir: string, cwd: string, exclude?: string | null): Promise<LocalSession | null> {
  let names: string[];
  try { names = await readdir(dir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let latest: LocalSession | null = null;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const file = path.join(dir, name);
    if (file === exclude) continue;
    const session = await inspectSession(file, cwd);
    if (session && (!latest || session.mtime > latest.mtime ||
        (session.mtime === latest.mtime && session.file < latest.file))) latest = session;
  }
  return latest;
}

export async function stillRecent(session: LocalSession, cwd: string): Promise<boolean> {
  const current = await inspectSession(session.file, cwd);
  return !!current && current.dev === session.dev && current.ino === session.ino &&
    current.version === session.version && current.mtime === session.mtime;
}

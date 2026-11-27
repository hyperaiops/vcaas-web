// Server-only SQLite layer for workspace metadata.
//
// SQLite is the index: it stores workspace rows (id, name, root path,
// timestamps, last computed revision). The actual files for each workspace
// live on disk under {WORKSPACE_FILES_ROOT}/{id}/ and are walked at request
// time by the tree builder — same model as the Go API, generalised to many
// workspaces.
//
// This server-only module initializes the existing SQLite schema and uses
// Prisma for application queries. Workspace files remain on disk.

import "server-only";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";
import { isValidWorkspaceId, type WorkspaceRow } from "./workspace/types";
import type { ApiMessageArgs, ApiMessageKey } from "./i18n/api-messages";

export type NewWorkspace = {
  id?: string;
  name: string;
  rootPath: string;
  ownerId: string;
};

let prismaInstance: Promise<PrismaClient> | null = null;

function dbPath(): string {
  return path.resolve(/* turbopackIgnore: true */ process.env.WORKSPACE_DB_PATH ?? path.join(process.cwd(), ".data", "workspaces.db"));
}

export function getPrisma(): Promise<PrismaClient> {
  if (prismaInstance) return prismaInstance;
  const file = dbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  // Prisma's SQLite connector expects an existing file. Opening in append mode
  // creates a new empty database without truncating an existing one.
  fs.closeSync(fs.openSync(/* turbopackIgnore: true */ file, "a"));
  const prisma = new PrismaClient({ datasources: { db: { url: pathToFileURL(file).href } } });
  const initializing = (async () => {
    await prisma.$connect();
    await prisma.$queryRaw`PRAGMA journal_mode = WAL`;
    await prisma.$executeRaw`PRAGMA foreign_keys = ON`;
    await prisma.$queryRaw`PRAGMA busy_timeout = 5000`;
    await migrate(prisma);
    return prisma;
  })().catch(async (error: unknown) => {
    if (prismaInstance === initializing) prismaInstance = null;
    await prisma.$disconnect().catch(() => {});
    throw error;
  });
  prismaInstance = initializing;
  return initializing;
}

async function migrate(db: PrismaClient): Promise<void> {
  // Retain the previous idempotent bootstrap for both new and legacy databases.
  // Prisma raw queries execute one SQL statement at a time.
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision TEXT
    )`;
    const columns = await tx.$queryRaw<{ name: string }[]>`PRAGMA table_info(workspaces)`;
    if (!columns.some((column) => column.name === "owner_id")) {
      await tx.$executeRaw`ALTER TABLE workspaces ADD COLUMN owner_id TEXT`;
    }
    await tx.$executeRaw`CREATE INDEX IF NOT EXISTS workspaces_owner ON workspaces(owner_id)`;
    await tx.$executeRaw`CREATE TABLE IF NOT EXISTS workspace_ids (id TEXT PRIMARY KEY)`;
    await tx.$executeRaw`INSERT OR IGNORE INTO workspace_ids SELECT id FROM workspaces`;
    await tx.$executeRaw`CREATE TABLE IF NOT EXISTS auth_users (
      id TEXT PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL,
      name TEXT NOT NULL, UNIQUE(issuer, subject)
    )`;
    await tx.$executeRaw`CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES auth_users(id),
      expires_at INTEGER NOT NULL, id_token TEXT NOT NULL
    )`;
    await tx.$executeRaw`CREATE TABLE IF NOT EXISTS auth_transactions (
      token_hash TEXT PRIMARY KEY, state TEXT NOT NULL, nonce TEXT NOT NULL,
      verifier TEXT NOT NULL, return_to TEXT NOT NULL, expires_at INTEGER NOT NULL
    )`;
  });
}

const workspaceFields = {
  id: true,
  name: true,
  rootPath: true,
  createdAt: true,
  updatedAt: true,
  revision: true,
} as const;

export async function listWorkspaces(ownerId: string): Promise<WorkspaceRow[]> {
  return (await getPrisma()).workspace.findMany({
    where: { ownerId }, select: workspaceFields, orderBy: { createdAt: "asc" },
  });
}

export async function getWorkspace(id: string): Promise<WorkspaceRow | null> {
  return (await getPrisma()).workspace.findUnique({ where: { id }, select: workspaceFields });
}

export async function getOwnedWorkspace(id: string, ownerId: string): Promise<WorkspaceRow | null> {
  return (await getPrisma()).workspace.findFirst({ where: { id, ownerId }, select: workspaceFields });
}

export async function getWorkspaceByRoot(rootPath: string): Promise<WorkspaceRow | null> {
  return (await getPrisma()).workspace.findUnique({ where: { rootPath }, select: workspaceFields });
}

// Never recycle a project identity: lingering agent sessions/CRs use this ID too.
export async function workspaceIdUsed(id: string): Promise<boolean> {
  return !!(await (await getPrisma()).workspaceId.findUnique({ where: { id }, select: { id: true } }));
}

export async function createWorkspace({ id, name, rootPath, ownerId }: NewWorkspace): Promise<WorkspaceRow> {
  const workspaceId = id ?? generateId(name);
  if (!isValidWorkspaceId(workspaceId)) {
    throw new WorkspaceError("INVALID_WORKSPACE_ID", "工作区 ID 只能包含小写字母、数字和连字符。", { messageKey: "workspace.invalidId" });
  }
  const db = await getPrisma();
  if (await workspaceIdUsed(workspaceId)) {
    throw new WorkspaceError("WORKSPACE_EXISTS", "该 ID 的工作区已存在。", { messageKey: "workspace.exists" });
  }
  if (await db.workspace.findUnique({ where: { rootPath }, select: { id: true } })) {
    throw new WorkspaceError("WORKSPACE_EXISTS", "该目录已被其他工作区使用。", { messageKey: "workspace.rootPathInUse" });
  }
  const now = new Date().toISOString();
  try {
    return await db.$transaction(async (tx) => {
      await tx.workspaceId.create({ data: { id: workspaceId } });
      return tx.workspace.create({
        data: { id: workspaceId, name, rootPath, createdAt: now, updatedAt: now, revision: null, ownerId },
        select: workspaceFields,
      });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new WorkspaceError("WORKSPACE_EXISTS", "该 ID 或目录的工作区已存在。", { messageKey: "workspace.idOrRootPathInUse" });
    }
    throw error;
  }
}

export async function updateWorkspaceRevision(id: string, revision: string, ownerId: string): Promise<void> {
  await (await getPrisma()).workspace.updateMany({
    where: { id, ownerId }, data: { revision, updatedAt: new Date().toISOString() },
  });
}

export async function deleteWorkspace(id: string, ownerId: string): Promise<boolean> {
  const result = await (await getPrisma()).workspace.deleteMany({ where: { id, ownerId } });
  return result.count > 0;
}

function generateId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = slug || "workspace";
  // Deterministic suffix (Math.random is fine here — this only runs on a
  // server request, not in a build/prerender).
  const suffix = crypto.randomBytes(3).toString("hex");
  return `${base}-${suffix}`;
}

export class WorkspaceError extends Error {
  code: string;
  messageKey?: ApiMessageKey;
  args?: ApiMessageArgs;
  constructor(code: string, message: string, localization?: { messageKey: ApiMessageKey; args?: ApiMessageArgs }) {
    super(message);
    this.code = code;
    this.name = "WorkspaceError";
    if (localization) {
      this.messageKey = localization.messageKey;
      this.args = localization.args;
    }
  }
}

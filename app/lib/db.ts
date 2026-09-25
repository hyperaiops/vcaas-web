// Server-only SQLite layer for workspace metadata.
//
// SQLite is the index: it stores workspace rows (id, name, root path,
// timestamps, last computed revision). The actual files for each workspace
// live on disk under {WORKSPACE_FILES_ROOT}/{id}/ and are walked at request
// time by the tree builder — same model as the Go API, generalised to many
// workspaces.
//
// This module imports `better-sqlite3`, a native Node addon, so it must only
// ever be imported from Route Handlers (Node runtime). Importing it from a
// Client Component would pull the native addon into the browser bundle.

import "server-only";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { isValidWorkspaceId, type WorkspaceRow } from "./workspace/types";

export type NewWorkspace = {
  id?: string;
  name: string;
  rootPath: string;
};

let dbInstance: DatabaseType | null = null;

function dbPath(): string {
  return process.env.WORKSPACE_DB_PATH ?? path.join(process.cwd(), ".data", "workspaces.db");
}

function getDb(): DatabaseType {
  if (dbInstance) return dbInstance;
  const file = dbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  migrate(db);
  dbInstance = db;
  return db;
}

function migrate(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      root_path   TEXT NOT NULL UNIQUE,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      revision    TEXT
    );
  `);
}

function rowToWorkspace(row: unknown): WorkspaceRow {
  const r = row as Record<string, unknown>;
  return {
    id: r.id as string,
    name: r.name as string,
    rootPath: r.root_path as string,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    revision: (r.revision as string | null) ?? null,
  };
}

export function listWorkspaces(): WorkspaceRow[] {
  const db = getDb();
  return (
    db
      .prepare("SELECT id, name, root_path, created_at, updated_at, revision FROM workspaces ORDER BY created_at ASC")
      .all() as unknown[]
  ).map(rowToWorkspace);
}

export function getWorkspace(id: string): WorkspaceRow | null {
  const db = getDb();
  const row = db
    .prepare("SELECT id, name, root_path, created_at, updated_at, revision FROM workspaces WHERE id = ?")
    .get(id);
  return row ? rowToWorkspace(row) : null;
}

export function getWorkspaceByRoot(rootPath: string): WorkspaceRow | null {
  const db = getDb();
  const row = db
    .prepare("SELECT id, name, root_path, created_at, updated_at, revision FROM workspaces WHERE root_path = ?")
    .get(rootPath);
  return row ? rowToWorkspace(row) : null;
}

export function createWorkspace({ id, name, rootPath }: NewWorkspace): WorkspaceRow {
  const workspaceId = id ?? generateId(name);
  if (!isValidWorkspaceId(workspaceId)) {
    throw new WorkspaceError("INVALID_WORKSPACE_ID", "Workspace ID must contain only lowercase letters, digits, and hyphens.");
  }
  const db = getDb();
  if (db.prepare("SELECT 1 FROM workspaces WHERE id = ?").get(workspaceId)) {
    throw new WorkspaceError("WORKSPACE_EXISTS", "A workspace with that ID already exists.");
  }
  if (db.prepare("SELECT 1 FROM workspaces WHERE root_path = ?").get(rootPath)) {
    throw new WorkspaceError("WORKSPACE_EXISTS", "A workspace already uses that directory.");
  }
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO workspaces (id, name, root_path, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, NULL)",
  ).run(workspaceId, name, rootPath, now, now);
  return getWorkspace(workspaceId)!;
}

export function updateWorkspaceRevision(id: string, revision: string): void {
  const db = getDb();
  db.prepare("UPDATE workspaces SET revision = ?, updated_at = ? WHERE id = ?").run(
    revision,
    new Date().toISOString(),
    id,
  );
}

export function deleteWorkspace(id: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
  return result.changes > 0;
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
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "WorkspaceError";
  }
}

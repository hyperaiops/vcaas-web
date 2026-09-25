// Shared workspace types used by both the server (Route Handlers) and the
// client (workspace switcher / preview). Keep this free of Node-only imports
// so it is safe to import from client components.

export type TreeNode = {
  kind: "directory";
  children: Record<string, TreeNode>;
} | {
  kind: "file";
  encoding: "utf-8" | "base64";
  contents: string;
};

export type TreeResponse = {
  apiVersion: "v1";
  workspaceId: string;
  revision: string;
  root: TreeNode;
};

export type MountSource = {
  status: "ready" | "unavailable" | "pending" | "failed";
  href?: string;
  mediaType?: string;
  sizeBytes?: number;
  sha256?: string;
  format?: string;
};

export type WorkspaceManifest = {
  apiVersion: "v1";
  workspace: { id: string; revision: string };
  defaultMountSource: "tree" | "snapshot";
  mountSources: { tree: MountSource; snapshot: MountSource };
};

export type WorkspaceRow = {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
  revision: string | null;
};

export type WorkspaceLimits = {
  maxFiles: number;
  maxDepth: number;
  maxFileBytes: number;
  maxTotalBytes: number;
};

export const DEFAULT_LIMITS: WorkspaceLimits = {
  maxFiles: 10_000,
  maxDepth: 32,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
};

// Mirrors Go's httpapi.ValidWorkspaceID: lowercase letters, digits, hyphens;
// 1..64 chars; no leading/trailing hyphen.
export function isValidWorkspaceId(value: string): boolean {
  if (!value || value.length > 64) return false;
  if (!/^[a-z0-9-]+$/.test(value)) return false;
  return !value.startsWith("-") && !value.endsWith("-");
}

// Public workspace summary returned by GET /api/v1/workspaces and consumed by
// the dashboard. Safe to import from client components.
export type WorkspaceSummary = {
  id: string;
  name: string;
  revision: string | null;
  createdAt: string;
  updatedAt: string;
};


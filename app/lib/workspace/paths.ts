// Server-only path-safety + ignore rules for workspace file access.
//
// Used by the tree builder and the file-write route to guarantee that a
// client-supplied path can never escape the workspace root and that writes
// never land in generated/dependency directories.

import "server-only";
import path from "node:path";
import fs from "node:fs/promises";

const IGNORED_NAMES = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "out",
  ".DS_Store",
]);

// Same rule as the Go tree builder: ignore .env and .env.* overrides, but
// ALLOW .env.local so non-secret local config is available inside the app.
export function isIgnoredName(name: string): boolean {
  if (IGNORED_NAMES.has(name)) return true;
  if (name === ".env") return true;
  if (name.startsWith(".env.") && name !== ".env.local") return true;
  return false;
}

export class WorkspacePathError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "WorkspacePathError";
  }
}

// Resolve a client-supplied relative path to an absolute file path inside the
// workspace root, enforcing traversal/symlink/directory/ignored-name safety.
// Returns the absolute path, or throws WorkspacePathError on any violation.
//
// `segments` are the path parts (e.g. from a catch-all [...path] param).
export async function resolveSafeFilePath(
  rootPath: string,
  segments: string[],
): Promise<string> {
  if (!segments.length) {
    throw new WorkspacePathError("INVALID_PATH", "A file path is required.");
  }

  // Reject unsafe segments BEFORE joining so encoded separators (`%2f`) that
  // decode into a single segment can't sneak a traversal past the join.
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new WorkspacePathError("INVALID_PATH", "Path segments must not be empty, '.', or '..'.");
    }
    if (segment.includes("/") || segment.includes("\\") || segment.includes("\0")) {
      throw new WorkspacePathError("INVALID_PATH", "Path segments must not contain path separators.");
    }
    if (isIgnoredName(segment)) {
      throw new WorkspacePathError("PATH_IGNORED", `Writing to "${segment}" is not allowed.`);
    }
  }

  const resolved = path.normalize(path.join(rootPath, ...segments));
  // Must stay within rootPath.
  const rootWithSep = rootPath.endsWith(path.sep) ? rootPath : rootPath + path.sep;
  if (resolved !== rootPath && !resolved.startsWith(rootWithSep)) {
    throw new WorkspacePathError("PATH_OUTSIDE_WORKSPACE", "The path is outside the workspace.");
  }

  let info;
  try {
    info = await fs.lstat(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // New file — allowed (parent must exist; created below if needed).
      return resolved;
    }
    throw new WorkspacePathError("INVALID_PATH", `Unable to inspect the target: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (info.isSymbolicLink()) {
    throw new WorkspacePathError("PATH_UNSAFE", "Writing to symbolic links is not allowed.");
  }
  if (info.isDirectory()) {
    throw new WorkspacePathError("PATH_IS_DIRECTORY", "The path is a directory.");
  }
  return resolved;
}

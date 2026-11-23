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
  // PiWorker agent runtime state. The PiWorker bridge mounts the workspace at
  // /workspace and runs Pi with --agent-dir=/workspace/.pi/agent so session
  // state survives pod restarts. It also symlinks image-baked provider
  // extensions (e.g. litellm) into .pi/agent/extensions/<name>. That state is
  // agent-internal — it's never part of the user's app, and the extensions
  // symlink would otherwise trip the builder's symlink check (snapshot 422
  // WORKSPACE_INVALID). Excluded from the revision/tree/snapshot entirely.
  ".pi",
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
    throw new WorkspacePathError("INVALID_PATH", "必须提供文件路径。");
  }

  // Reject unsafe segments BEFORE joining so encoded separators (`%2f`) that
  // decode into a single segment can't sneak a traversal past the join.
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new WorkspacePathError("INVALID_PATH", "路径片段不能为空，也不能是“.”或“..”。");
    }
    if (segment.includes("/") || segment.includes("\\") || segment.includes("\0")) {
      throw new WorkspacePathError("INVALID_PATH", "路径片段不能包含路径分隔符。");
    }
    if (isIgnoredName(segment)) {
      throw new WorkspacePathError("PATH_IGNORED", `不允许写入“${segment}”。`);
    }
  }

  const resolved = path.normalize(path.join(rootPath, ...segments));
  // Must stay within rootPath.
  const rootWithSep = rootPath.endsWith(path.sep) ? rootPath : rootPath + path.sep;
  if (resolved !== rootPath && !resolved.startsWith(rootWithSep)) {
    throw new WorkspacePathError("PATH_OUTSIDE_WORKSPACE", "该路径超出了工作区范围。");
  }

  let current = rootPath;
  for (let i = 0; i < segments.length; i++) {
    current = path.join(current, segments[i]);
    let info;
    try {
      info = await fs.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw new WorkspacePathError("INVALID_PATH", "无法检查目标路径。");
    }
    if (info.isSymbolicLink()) {
      throw new WorkspacePathError("PATH_UNSAFE", "不允许写入符号链接。");
    }
    if (i < segments.length - 1 && !info.isDirectory()) {
      throw new WorkspacePathError("INVALID_PATH", "文件路径的父级必须是目录。");
    }
    if (i === segments.length - 1 && info.isDirectory()) {
      throw new WorkspacePathError("PATH_IS_DIRECTORY", "该路径是一个目录。");
    }
  }
  return resolved;
}

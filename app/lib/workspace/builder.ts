// Port of Go internal/workspace/tree.go.
//
// Walks a workspace directory on disk and builds a JSON-serialisable tree
// (the `tree` mount source), computing a content-derived revision (sha256)
// that the manifest/snapshot endpoints use for caching and change detection.
//
// Rules preserved exactly from the Go implementation:
//  - ignored names: .git, node_modules, .next, dist, build, out, .DS_Store,
//    .env, and .env.* overrides EXCEPT .env.local.
//  - reject symlinks and non-regular files.
//  - enforce MaxDepth / MaxFileBytes / MaxFiles / MaxTotalBytes.
//  - utf-8 files (no NUL bytes) → encoding "utf-8"; otherwise "base64".
//  - empty directories serialise children: {} (never omitted).
//  - revision feed: "D\0{path}\0" for dirs, "F\0{path}\0{len}\0{contents}".

import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { Stats } from "node:fs";
import type { TreeNode, WorkspaceLimits } from "./types";
import { DEFAULT_LIMITS } from "./types";
import { isIgnoredName } from "./paths";

export type BuiltTree = {
  root: TreeNode;
  revision: string;
  fileCount: number;
  sizeBytes: number;
};

type WalkState = {
  hash: crypto.Hash;
  files: number;
  total: number;
  limits: WorkspaceLimits;
};

export class WorkspaceTreeError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "WorkspaceTreeError";
  }
}

export async function buildTree(
  root: string,
  limits: WorkspaceLimits = DEFAULT_LIMITS,
): Promise<BuiltTree> {
  const absolute = path.resolve(root);
  try {
    const stat = await fs.stat(absolute);
    if (!stat.isDirectory()) {
      throw new WorkspaceTreeError("WORKSPACE_INVALID", "Workspace root is not a directory.");
    }
  } catch (error) {
    throw new WorkspaceTreeError(
      "WORKSPACE_INVALID",
      `Unable to inspect workspace root: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const state: WalkState = { hash: crypto.createHash("sha256"), files: 0, total: 0, limits };
  const node = await walk(absolute, "", 0, state);
  return {
    root: node,
    revision: state.hash.digest("hex"),
    fileCount: state.files,
    sizeBytes: state.total,
  };
}

async function walk(
  absoluteRoot: string,
  relative: string,
  depth: number,
  state: WalkState,
): Promise<TreeNode> {
  if (depth > state.limits.maxDepth) {
    throw new WorkspaceTreeError("WORKSPACE_INVALID", `Workspace exceeds maximum directory depth of ${state.limits.maxDepth}.`);
  }
  const dir = relative ? path.join(absoluteRoot, relative) : absoluteRoot;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    throw new WorkspaceTreeError("WORKSPACE_INVALID", `Unable to read workspace directory: ${error instanceof Error ? error.message : String(error)}`);
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const children: Record<string, TreeNode> = {};
  for (const entry of entries) {
    const name = entry.name;
    if (isIgnoredName(name)) continue;
    if (name === "." || name === ".." || /[\\/]\x00/.test(name) || name.includes("\0")) {
      throw new WorkspaceTreeError("WORKSPACE_INVALID", "Workspace contains an unsafe entry name.");
    }
    const childRelative = relative ? `${relative}/${name}` : name;
    const childAbsolute = path.join(absoluteRoot, childRelative);
    let info: Stats;
    try {
      info = await fs.lstat(childAbsolute);
    } catch (error) {
      throw new WorkspaceTreeError("WORKSPACE_INVALID", `Unable to inspect workspace entry: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (info.isSymbolicLink()) {
      throw new WorkspaceTreeError("WORKSPACE_INVALID", `Workspace contains an unsupported symbolic link "${childRelative}".`);
    }
    if (info.isDirectory()) {
      state.hash.update(`D\x00${childRelative}\x00`);
      children[name] = await walk(absoluteRoot, childRelative, depth + 1, state);
      continue;
    }
    if (!info.isFile()) {
      throw new WorkspaceTreeError("WORKSPACE_INVALID", `Workspace contains an unsupported file type "${childRelative}".`);
    }
    if (info.size > state.limits.maxFileBytes) {
      throw new WorkspaceTreeError("WORKSPACE_INVALID", `File "${childRelative}" exceeds maximum file size.`);
    }
    state.files += 1;
    if (state.files > state.limits.maxFiles) {
      throw new WorkspaceTreeError("WORKSPACE_INVALID", "Workspace exceeds maximum file count.");
    }
    state.total += info.size;
    if (state.total > state.limits.maxTotalBytes) {
      throw new WorkspaceTreeError("WORKSPACE_INVALID", "Workspace exceeds maximum total size.");
    }
    let contents: Buffer;
    try {
      contents = await fs.readFile(childAbsolute);
    } catch (error) {
      throw new WorkspaceTreeError("WORKSPACE_INVALID", `Unable to read workspace file: ${error instanceof Error ? error.message : String(error)}`);
    }
    state.hash.update(`F\x00${childRelative}\x00${contents.length}\x00`);
    state.hash.update(contents);
    // Detect valid UTF-8 with no NUL bytes → text; otherwise base64.
    if (isValidUtf8(contents) && !contents.includes(0)) {
      children[name] = { kind: "file", encoding: "utf-8", contents: contents.toString("utf8") };
    } else {
      children[name] = { kind: "file", encoding: "base64", contents: contents.toString("base64") };
    }
  }
  return { kind: "directory", children };
}

// Node's Buffer.isUtf8 (Node 18+) detects valid UTF-8 byte sequences.
function isValidUtf8(buffer: Buffer): boolean {
  if (typeof (Buffer as unknown as { isUtf8?: (b: Buffer) => boolean }).isUtf8 === "function") {
    return (Buffer as unknown as { isUtf8: (b: Buffer) => boolean }).isUtf8(buffer);
  }
  try {
    // TextDecoder with fatal option throws on invalid UTF-8.
    new TextDecoder("utf8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

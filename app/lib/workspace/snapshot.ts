// Port of Go internal/workspace/snapshot.go + generator.go.
//
// Builds a binary WebContainer snapshot (webcontainer-snapshot-v1) from a
// workspace tree and caches it on disk keyed by revision. Unlike the Go
// version (which shelled out to tools/snapshot/build-snapshot.mjs), we import
// `@webcontainer/snapshot` directly and run it in-process — no Node
// subprocess, no separate tool package.
//
// Two stages:
//  1. generateSnapshot(tree): materialise the JSON tree into a temp staging
//     directory, then call @webcontainer/snapshot's snapshot(stagingDir) to
//     get the binary blob. (Materialisation is ported from the Go tool's
//     materializeTree in build-snapshot.mjs.)
//  2. publishSnapshot / findSnapshot: atomic write the blob to
//     {SNAPSHOT_DIRECTORY}/{revision}.snapshot and serve it back on GET.

import "server-only";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { TreeNode } from "./types";
import { WorkspaceTreeError } from "./builder";

export const SNAPSHOT_FORMAT = "webcontainer-snapshot-v1";
export const DEFAULT_MAX_SNAPSHOT_BYTES = 100 * 1024 * 1024; // 100 MiB

export type FoundSnapshot = {
  path: string;
  size: number;
  sha256: string;
  buffer: Buffer;
};

function snapshotDirectory(): string {
  return process.env.SNAPSHOT_DIRECTORY ?? path.join(process.cwd(), ".data", ".snapshots");
}

function snapshotPath(directory: string, revision: string): string {
  return path.join(directory, `${revision}.snapshot`);
}

export async function findSnapshot(revision: string): Promise<FoundSnapshot | null> {
  const directory = snapshotDirectory();
  const artifact = snapshotPath(directory, revision);
  try {
    const data = await fs.readFile(artifact);
    const sha256 = createHash("sha256").update(data).digest("hex");
    return { path: artifact, size: data.byteLength, sha256, buffer: data };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new WorkspaceTreeError("SNAPSHOT_LOOKUP_FAILED", "无法检查工作区快照。", { messageKey: "snapshot.lookupFailed" });
  }
}

export async function publishSnapshot(revision: string, contents: Buffer): Promise<{ sha256: string }> {
  const directory = snapshotDirectory();
  await fs.mkdir(directory, { recursive: true });
  const artifact = snapshotPath(directory, revision);
  const sha256 = createHash("sha256").update(contents).digest("hex");
  // Atomic write: temp file in the same dir, then rename.
  const suffix = `.${process.pid}.${crypto.randomUUID()}.tmp`;
  const tmpArtifact = `${artifact}${suffix}`;
  const tmpMetadata = `${artifact}.json${suffix}`;
  try {
    await fs.writeFile(tmpArtifact, contents);
    const metadata = JSON.stringify(
      { revision, format: SNAPSHOT_FORMAT, sizeBytes: contents.byteLength, sha256 },
      null,
      2,
    );
    await fs.writeFile(tmpMetadata, `${metadata}\n`);
    await fs.rename(tmpArtifact, artifact);
    await fs.rename(tmpMetadata, `${artifact}.json`);
    return { sha256 };
  } finally {
    await fs.rm(tmpArtifact, { force: true });
    await fs.rm(tmpMetadata, { force: true });
  }
}

// Materialise a JSON tree into a real directory on disk so
// @webcontainer/snapshot can walk it. Ported from materializeTree in
// build-snapshot.mjs.
async function materializeTree(root: TreeNode, directory: string): Promise<void> {
  if (!root || root.kind !== "directory" || !root.children) {
    throw new WorkspaceTreeError("WORKSPACE_INVALID", "文件树的根目录无效。", { messageKey: "tree.invalidRoot" });
  }
  for (const [name, node] of Object.entries(root.children)) {
    assertSafeName(name);
    const target = path.join(directory, name);
    if (node.kind === "directory") {
      await fs.mkdir(target, { recursive: false });
      await materializeTree(node, target);
      continue;
    }
    if (node.kind !== "file" || typeof node.contents !== "string") {
      throw new WorkspaceTreeError("WORKSPACE_INVALID", "文件树包含无效的文件节点。", { messageKey: "tree.invalidFileNode" });
    }
    if (node.encoding === "utf-8") {
      await fs.writeFile(target, node.contents, "utf8");
    } else if (node.encoding === "base64") {
      const data = Buffer.from(node.contents, "base64");
      if (data.toString("base64") !== node.contents) {
        throw new WorkspaceTreeError("WORKSPACE_INVALID", "文件树包含无效的 base64 内容。", { messageKey: "tree.invalidBase64" });
      }
      await fs.writeFile(target, data);
    } else {
      throw new WorkspaceTreeError("WORKSPACE_INVALID", "文件树包含不支持的文件编码。", { messageKey: "tree.unsupportedEncoding" });
    }
  }
}

function assertSafeName(name: string): void {
  if (!name || name === "." || name === ".." || /[\\/\0]/.test(name)) {
    throw new WorkspaceTreeError("WORKSPACE_INVALID", "文件树包含不安全的文件或目录名称。", { messageKey: "tree.unsafeName" });
  }
}

export class SnapshotTooLargeError extends Error {
  constructor() {
    super("生成的快照超过大小上限。");
    this.name = "SnapshotTooLargeError";
  }
}

// Generate a binary snapshot blob from a built tree, in-process.
// Returns the raw buffer suitable for WebContainer.mount().
export async function generateSnapshot(
  tree: { revision: string; root: TreeNode },
  maxBytes = DEFAULT_MAX_SNAPSHOT_BYTES,
): Promise<Buffer> {
  const stagingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "webcontainer-snapshot-"));
  try {
    await materializeTree(tree.root, stagingDirectory);
    const { snapshot } = await import("@webcontainer/snapshot");
    const contents = (await snapshot(stagingDirectory)) as Buffer;
    if (contents.byteLength > maxBytes) {
      throw new SnapshotTooLargeError();
    }
    return contents;
  } finally {
    await fs.rm(stagingDirectory, { recursive: true, force: true });
  }
}

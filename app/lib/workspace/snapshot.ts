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
    throw new WorkspaceTreeError("SNAPSHOT_LOOKUP_FAILED", `Unable to inspect the workspace snapshot: ${error instanceof Error ? error.message : String(error)}`);
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

// Publish a workspace-id-keyed copy under public/snapshots/{id}.snapshot so
// the dev server serves it as a bare static URL (GET /snapshots/{id}.snapshot),
// bypassing the API route entirely. One file per workspace, overwritten on
// every generation.
//
// Dev-only: `next dev` reads public/ from disk per request, so runtime writes
// show up; `next start` (production) only serves public/ files baked at build
// time, so this copy is unreachable there. The .data/.snapshots/{revision}
// cache remains the source of truth for the API route.
export async function publishPublicSnapshot(workspaceId: string, contents: Buffer): Promise<void> {
  const directory = path.join(process.cwd(), "public", "snapshots");
  await fs.mkdir(directory, { recursive: true });
  const artifact = path.join(directory, `${workspaceId}.snapshot`);
  // Atomic write: temp file in the same dir, then rename.
  const suffix = `.${process.pid}.${crypto.randomUUID()}.tmp`;
  const tmpArtifact = `${artifact}${suffix}`;
  try {
    await fs.writeFile(tmpArtifact, contents);
    await fs.rename(tmpArtifact, artifact);
  } finally {
    await fs.rm(tmpArtifact, { force: true });
  }
}

// Materialise a JSON tree into a real directory on disk so
// @webcontainer/snapshot can walk it. Ported from materializeTree in
// build-snapshot.mjs.
async function materializeTree(root: TreeNode, directory: string): Promise<void> {
  if (!root || root.kind !== "directory" || !root.children) {
    throw new WorkspaceTreeError("WORKSPACE_INVALID", "The tree returned an invalid root directory.");
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
      throw new WorkspaceTreeError("WORKSPACE_INVALID", "The tree returned an invalid file node.");
    }
    if (node.encoding === "utf-8") {
      await fs.writeFile(target, node.contents, "utf8");
    } else if (node.encoding === "base64") {
      const data = Buffer.from(node.contents, "base64");
      if (data.toString("base64") !== node.contents) {
        throw new WorkspaceTreeError("WORKSPACE_INVALID", "The tree returned invalid base64 contents.");
      }
      await fs.writeFile(target, data);
    } else {
      throw new WorkspaceTreeError("WORKSPACE_INVALID", "The tree returned an unsupported file encoding.");
    }
  }
}

function assertSafeName(name: string): void {
  if (!name || name === "." || name === ".." || /[\\/\0]/.test(name)) {
    throw new WorkspaceTreeError("WORKSPACE_INVALID", "The tree returned an unsafe entry name.");
  }
}

export class SnapshotTooLargeError extends Error {
  constructor() {
    super("Generated snapshot exceeds maximum size.");
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

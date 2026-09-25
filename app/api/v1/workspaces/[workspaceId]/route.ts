import fs from "node:fs/promises";
import { resolveWorkspaceTree } from "@/app/lib/workspace/resolver";
import { jsonResponse, errorResponse } from "@/app/lib/workspace/api-helpers";
import { findSnapshot, SNAPSHOT_FORMAT } from "@/app/lib/workspace/snapshot";
import { getWorkspace, deleteWorkspace } from "@/app/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ workspaceId: string }> };

export async function GET(_request: Request, { params }: Context) {
  const { workspaceId } = await params;
  const resolved = await resolveWorkspaceTree(workspaceId);
  if (!resolved.ok) return resolved.response;
  const { workspace, tree } = resolved;

  const snapshot = await findSnapshot(tree.revision);
  const base = `/api/v1/workspaces/${workspace.id}`;
  const snapshotStatus = snapshot ? "ready" : "unavailable";
  const snapshotSource: Record<string, unknown> = { status: snapshotStatus };
  if (snapshot) {
    snapshotSource.href = `${base}/snapshot`;
    snapshotSource.mediaType = "application/vnd.webcontainer.snapshot";
    snapshotSource.format = SNAPSHOT_FORMAT;
    snapshotSource.sizeBytes = snapshot.size;
    snapshotSource.sha256 = snapshot.sha256;
  }

  return jsonResponse({
    apiVersion: "v1",
    workspace: { id: workspace.id, revision: tree.revision },
    defaultMountSource: snapshot ? "snapshot" : "tree",
    mountSources: {
      tree: { status: "ready", href: `${base}/tree`, mediaType: "application/vnd.webcontainer.tree+json", sizeBytes: tree.sizeBytes },
      snapshot: snapshotSource,
    },
  });
}

// DELETE — remove a workspace: its on-disk files first, then the DB row.
// Deleting files before the row means a crash between the two leaves an
// orphaned DB row (re-deletable) rather than orphaned files referencing nothing.
export async function DELETE(_request: Request, { params }: Context) {
  const { workspaceId } = await params;
  const workspace = getWorkspace(workspaceId);
  if (!workspace) {
    return errorResponse(404, "WORKSPACE_NOT_FOUND", "The requested workspace does not exist.");
  }
  try {
    await fs.rm(workspace.rootPath, { recursive: true, force: true });
  } catch (error) {
    return errorResponse(500, "WORKSPACE_DELETE_FAILED", `Unable to remove workspace files: ${error instanceof Error ? error.message : String(error)}`);
  }
  deleteWorkspace(workspaceId);
  return jsonResponse({ apiVersion: "v1", deleted: workspaceId });
}


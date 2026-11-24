import fs from "node:fs/promises";
import { resolveWorkspaceTree } from "@/app/lib/workspace/resolver";
import { jsonResponse, errorResponse } from "@/app/lib/workspace/api-helpers";
import { findSnapshot, SNAPSHOT_FORMAT } from "@/app/lib/workspace/snapshot";
import { deleteWorkspace } from "@/app/lib/db";
import { requireOwnedWorkspace } from "@/app/lib/auth/access";
import { forceShutdown } from "@/app/lib/bridge/session";
import { getWorkspaceLimits } from "@/app/lib/workspace/limits";

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
    limits: getWorkspaceLimits(),
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
  const auth = await requireOwnedWorkspace(workspaceId, _request);
  if (!auth.ok) return auth.response;
  const { workspace } = auth;
  try {
    await forceShutdown(workspaceId);
  } catch {
    return errorResponse(503, "WORKSPACE_AGENT_SHUTDOWN_FAILED", "无法停止工作区智能助手，请稍后重试删除。");
  }
  try {
    await fs.rm(workspace.rootPath, { recursive: true, force: true });
  } catch {
    return errorResponse(500, "WORKSPACE_DELETE_FAILED", "无法删除工作区文件。");
  }
  await deleteWorkspace(workspaceId, auth.user.id);
  return jsonResponse({ apiVersion: "v1", deleted: workspaceId });
}


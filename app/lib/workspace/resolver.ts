// Shared resolver for the per-workspace GET endpoints (manifest, tree,
// snapshot). Builds the tree for the workspace, updates the stored revision,
// and returns it — or an error Response if the workspace doesn't exist or
// its files can't be represented.

import { buildTree, WorkspaceTreeError, type BuiltTree } from "./builder";
import { updateWorkspaceRevision } from "../db";
import { requireOwnedWorkspace } from "../auth/access";
import { errorResponse } from "./api-helpers";
import type { WorkspaceLimits, WorkspaceRow } from "./types";

export type ResolveResult =
  | { ok: true; workspace: WorkspaceRow; tree: BuiltTree }
  | { ok: false; response: Response };

export async function resolveWorkspaceTree(
  workspaceId: string,
  limits?: WorkspaceLimits,
): Promise<ResolveResult> {
  const auth = await requireOwnedWorkspace(workspaceId);
  if (!auth.ok) return auth;
  const { workspace } = auth;
  try {
    const tree = await buildTree(workspace.rootPath, limits);
    if (workspace.revision !== tree.revision) {
      updateWorkspaceRevision(workspace.id, tree.revision, auth.user.id);
    }
    return { ok: true, workspace, tree };
  } catch (error) {
    if (error instanceof WorkspaceTreeError) {
      return { ok: false, response: errorResponse(422, error.code, error.message) };
    }
    return { ok: false, response: errorResponse(500, "WORKSPACE_INVALID", "无法检查工作区。") };
  }
}

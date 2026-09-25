import { resolveWorkspaceTree } from "@/app/lib/workspace/resolver";
import { quoteETag, jsonResponse, errorResponse } from "@/app/lib/workspace/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ workspaceId: string }> };

export async function GET(request: Request, { params }: Context) {
  const { workspaceId } = await params;
  const resolved = await resolveWorkspaceTree(workspaceId);
  if (!resolved.ok) return resolved.response;
  const { workspace, tree } = resolved;

  const etag = quoteETag(tree.revision);
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag } });
  }
  return jsonResponse(
    { apiVersion: "v1", workspaceId: workspace.id, revision: tree.revision, root: tree.root },
    200,
    { etag },
  );
}

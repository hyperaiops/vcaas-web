// Release only this page's lease; the session manager shuts down the last lease.
import { requireOwnedWorkspace } from "@/app/lib/auth/access";
import { releaseAgentLease } from "@/app/lib/bridge/session";
import { jsonResponse, errorResponse } from "@/app/lib/workspace/api-helpers";
import { agentError, parseLease, readAgentBody } from "../lease";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ workspaceId: string }> };

export async function POST(request: Request, { params }: Context) {
  const { workspaceId } = await params;
  const auth = await requireOwnedWorkspace(workspaceId, request);
  if (!auth.ok) return auth.response;
  const lease = parseLease(await readAgentBody(request));
  if (!lease) return errorResponse(400, "INVALID_AGENT_LEASE", "请提供有效的页面租约。");
  try {
    await releaseAgentLease(workspaceId, lease);
    return jsonResponse({ apiVersion: "v1", stopped: workspaceId });
  } catch (error) {
    return agentError(error, 500, "AGENT_STOP_FAILED", "无法停止工作区智能助手。");
  }
}

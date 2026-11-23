// POST /api/v1/workspaces/[workspaceId]/agent/cancel
// Request a Pi RPC abort for this page's active turn without releasing its lease.

import { requireOwnedWorkspace } from "@/app/lib/auth/access";
import { cancelTurn } from "@/app/lib/bridge/session";
import { agentError, isClientId, readAgentBody } from "../lease";
import { jsonResponse, errorResponse } from "@/app/lib/workspace/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ workspaceId: string }> };

export async function POST(request: Request, { params }: Context) {
  const { workspaceId } = await params;
  const auth = await requireOwnedWorkspace(workspaceId, request);
  if (!auth.ok) return auth.response;
  const body = await readAgentBody(request);
  if (!isClientId(body.clientId)) return errorResponse(400, "INVALID_AGENT_LEASE", "请提供有效的页面租约。");
  if (!isClientId(body.turnId)) return errorResponse(400, "INVALID_AGENT_TURN", "请提供有效的任务编号。");
  try {
    await cancelTurn(workspaceId, body.clientId, body.turnId, typeof body.revision === "string" ? body.revision : undefined);
    return jsonResponse({ apiVersion: "v1", requested: true });
  } catch (error) {
    return agentError(error, 503, "AGENT_CANCEL_FAILED", "无法确认停止请求，请稍后重试。");
  }
}

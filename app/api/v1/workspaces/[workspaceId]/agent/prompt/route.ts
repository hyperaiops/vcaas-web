// POST /api/v1/workspaces/[workspaceId]/agent/prompt
//
// Forwards a user message to the agent as a Pi `prompt` RPC command over the
// server-side ws. The assistant's streamed response is read from the sibling
// `events` SSE route. Body: { clientId, turnId, message, revision }.

import { requireOwnedWorkspace } from "@/app/lib/auth/access";
import { sendPrompt } from "@/app/lib/bridge/session";
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
  if (!isClientId(body.clientId)) return errorResponse(400, "INVALID_AGENT_LEASE", "请提供有效的页面租约。", { messageKey: "agent.invalidLease" });
  if (!isClientId(body.turnId)) return errorResponse(400, "INVALID_AGENT_TURN", "页面版本已更新，请刷新后重试。", { messageKey: "agent.staleTurn" });
  const message = typeof body.message === "string" ? body.message : "";
  if (!message.trim()) {
    return errorResponse(400, "EMPTY_PROMPT", "请输入消息。", { messageKey: "agent.emptyPrompt" });
  }
  try {
    await sendPrompt(workspaceId, body.clientId, message, body.turnId, typeof body.revision === "string" ? body.revision : undefined);
    return jsonResponse({ apiVersion: "v1", sent: true });
  } catch (error) {
    return agentError(error, 503, "AGENT_SEND_FAILED", "无法发送消息给智能助手，请稍后重试。", "agent.sendFailed");
  }
}

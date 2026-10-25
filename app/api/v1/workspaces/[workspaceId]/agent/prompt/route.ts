// POST /api/v1/workspaces/[workspaceId]/agent/prompt
//
// Forwards a user message to the agent as a Pi `prompt` RPC command over the
// server-side ws. The assistant's streamed response is read from the sibling
// `events` SSE route. Body: { message: string }.

import { requireOwnedWorkspace } from "@/app/lib/auth/access";
import { sendPrompt } from "@/app/lib/bridge/session";
import { jsonResponse, errorResponse } from "@/app/lib/workspace/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ workspaceId: string }> };

export async function POST(request: Request, { params }: Context) {
  const { workspaceId } = await params;
  const auth = await requireOwnedWorkspace(workspaceId, request);
  if (!auth.ok) return auth.response;
  let message = "";
  try {
    const body = await request.json();
    message = typeof body?.message === "string" ? body.message : "";
  } catch {
    message = "";
  }
  if (!message.trim()) {
    return errorResponse(400, "EMPTY_PROMPT", "请输入消息。");
  }
  try {
    await sendPrompt(workspaceId, message);
    return jsonResponse({ apiVersion: "v1", sent: true });
  } catch {
    return errorResponse(503, "AGENT_SEND_FAILED", "无法发送消息给智能助手，请稍后重试。");
  }
}

// POST /api/v1/workspaces/[workspaceId]/agent/start
//
// Ensures a PiWorker CR is Ready and opens a server-side WebSocket from this
// Next.js server to the agent's selected Service or public /v1/rpc endpoint.
// Credentials remain server-side; the browser POSTs prompts and reads an SSE
// event stream rather than connecting to the agent directly.

import { requireOwnedWorkspace } from "@/app/lib/auth/access";
import { ensureAgentSession } from "@/app/lib/bridge/session";
import { agentError, parseLease, readAgentBody } from "../lease";
import { jsonResponse, errorResponse } from "@/app/lib/workspace/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ workspaceId: string }> };

export async function POST(_request: Request, { params }: Context) {
  const { workspaceId } = await params;
  const auth = await requireOwnedWorkspace(workspaceId, _request);
  if (!auth.ok) return auth.response;
  const lease = parseLease(await readAgentBody(_request));
  if (!lease) return errorResponse(400, "INVALID_AGENT_LEASE", "请提供有效的页面租约。");
  try {
    await ensureAgentSession(workspaceId, lease);
    return jsonResponse({ apiVersion: "v1", connected: true });
  } catch (error) {
    return agentError(error, 503, "AGENT_START_FAILED", "无法启动工作区智能助手。");
  }
}

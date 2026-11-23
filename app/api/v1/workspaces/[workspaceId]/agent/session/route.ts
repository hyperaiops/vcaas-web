import { requireOwnedWorkspace } from "@/app/lib/auth/access";
import { changeAgentSession, getCurrentTranscript } from "@/app/lib/bridge/session";
import { jsonResponse, errorResponse } from "@/app/lib/workspace/api-helpers";
import { agentError, isClientId, readAgentBody } from "../lease";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ workspaceId: string }> };

export async function GET(request: Request, { params }: Context) {
  const { workspaceId } = await params;
  const auth = await requireOwnedWorkspace(workspaceId, request);
  if (!auth.ok) return auth.response;
  const clientId = new URL(request.url).searchParams.get("clientId");
  if (!isClientId(clientId)) return errorResponse(400, "INVALID_AGENT_LEASE", "请提供有效的页面租约。");
  try {
    return jsonResponse(await getCurrentTranscript(workspaceId, clientId));
  } catch (error) {
    return agentError(error, 503, "AGENT_HISTORY_FAILED", "无法读取编程助手会话。");
  }
}

export async function POST(request: Request, { params }: Context) {
  const { workspaceId } = await params;
  const auth = await requireOwnedWorkspace(workspaceId, request);
  if (!auth.ok) return auth.response;
  const body = await readAgentBody(request);
  if (!isClientId(body.clientId)) return errorResponse(400, "INVALID_AGENT_LEASE", "请提供有效的页面租约。");
  if (!isClientId(body.revision) || (body.action !== "new" && body.action !== "restore")) {
    return errorResponse(400, "INVALID_SESSION_ACTION", "请刷新页面后重试。");
  }
  try {
    return jsonResponse(await changeAgentSession(workspaceId, body.clientId, body.revision, body.action, body.confirmMigration === true));
  } catch (error) {
    return agentError(error, 503, "AGENT_SESSION_FAILED", "无法切换编程助手会话。");
  }
}

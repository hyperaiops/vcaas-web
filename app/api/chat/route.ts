import { requireUser, requireOwnedWorkspace } from "@/app/lib/auth/access";
import { errorResponse } from "@/app/lib/workspace/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Running a coding CLI inside the web server would expose other users' files
// and the server's environment. Use the isolated per-workspace PiWorker instead.
export async function POST(request: Request) {
  const auth = await requireUser(request);
  if (!auth.ok) return auth.response;
  let workspaceId: string;
  try {
    const body = await request.json();
    if (typeof body?.workspaceId !== "string") throw new Error("缺少工作区");
    workspaceId = body.workspaceId;
  } catch {
    return errorResponse(400, "WORKSPACE_REQUIRED", "必须提供 workspaceId。", { messageKey: "request.workspaceIdRequired" });
  }
  const access = await requireOwnedWorkspace(workspaceId, request);
  if (!access.ok) return access.response;
  return errorResponse(410, "LEGACY_CHAT_DISABLED", "请使用工作区智能助手的消息和事件接口。", { messageKey: "request.legacyChatDisabled" });
}

// POST /api/v1/workspaces/[workspaceId]/agent/start
//
// Ensures a PiWorker CR is Ready and opens a server-side WebSocket from this
// Next.js server to the agent's public /v1/rpc over the ingress-nginx
// port-forward. Credentials remain server-side (the browser doesn't connect
// directly — it POSTs prompts and reads an SSE event stream instead, because
// browsers can't do the split TCP-target/SNI trick the server-side ws uses).

import { requireOwnedWorkspace } from "@/app/lib/auth/access";
import { ensureAgentSession } from "@/app/lib/bridge/session";
import { K8sClientError } from "@/app/lib/bridge/k8s";
import { jsonResponse, errorResponse } from "@/app/lib/workspace/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ workspaceId: string }> };

export async function POST(_request: Request, { params }: Context) {
  const { workspaceId } = await params;
  const auth = await requireOwnedWorkspace(workspaceId, _request);
  if (!auth.ok) return auth.response;
  try {
    await ensureAgentSession(workspaceId);
    return jsonResponse({ apiVersion: "v1", connected: true });
  } catch (error) {
    const isK8s = error instanceof K8sClientError;
    const message = "无法启动工作区智能助手。";
    const status =
      !isK8s ? 500 :
      (error as K8sClientError).code === "RECONCILE_TIMEOUT" ? 503 :
      400;
    return errorResponse(status, "AGENT_START_FAILED", message);
  }
}

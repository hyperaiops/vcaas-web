// POST /api/v1/workspaces/[workspaceId]/agent/start
//
// Ensures a PiWorker CR is Ready and opens a server-side WebSocket from this
// Next.js server to the agent's public /v1/rpc over the ingress-nginx
// port-forward. Returns { endpoint, token } (the browser doesn't connect
// directly — it POSTs prompts and reads an SSE event stream instead, because
// browsers can't do the split TCP-target/SNI trick the server-side ws uses).

import { ensureAgentSession } from "@/app/lib/bridge/session";
import { K8sClientError } from "@/app/lib/bridge/k8s";
import { jsonResponse, errorResponse } from "@/app/lib/workspace/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ workspaceId: string }> };

export async function POST(_request: Request, { params }: Context) {
  const { workspaceId } = await params;
  try {
    const handle = await ensureAgentSession(workspaceId);
    return jsonResponse({ apiVersion: "v1", endpoint: handle.endpoint, token: handle.token });
  } catch (error) {
    const isK8s = error instanceof K8sClientError;
    const message = error instanceof Error ? error.message : String(error);
    const status =
      !isK8s ? 500 :
      (error as K8sClientError).code === "RECONCILE_TIMEOUT" ? 503 :
      400;
    return errorResponse(status, "AGENT_START_FAILED", message);
  }
}

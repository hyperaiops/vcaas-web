// POST /api/v1/workspaces/[workspaceId]/agent/stop
//
// Drops the server-side agent WebSocket session for this workspace and deletes
// its PiWorker CR. The operator's ownerRef + finalizer garbage-collect the
// managed Deployment / Service / Ingress / bearer-token Secret; the per-CR
// LiteLLM Secret we own is also deleted. Idempotent.

import { closeSession } from "@/app/lib/bridge/session";
import { deletePiWorker } from "@/app/lib/bridge/k8s";
import { jsonResponse, errorResponse } from "@/app/lib/workspace/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ workspaceId: string }> };

export async function POST(_request: Request, { params }: Context) {
  const { workspaceId } = await params;
  try {
    closeSession(workspaceId, "user left workspace");
    await deletePiWorker(workspaceId);
    return jsonResponse({ apiVersion: "v1", stopped: workspaceId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(500, "AGENT_STOP_FAILED", message);
  }
}

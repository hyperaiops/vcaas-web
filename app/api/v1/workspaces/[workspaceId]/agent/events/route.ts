import { cookies } from "next/headers";
import { subscribe } from "@/app/lib/bridge/session";
import { isClientId } from "../lease";
import { errorResponse } from "@/app/lib/workspace/api-helpers";
import { requireOwnedWorkspace } from "@/app/lib/auth/access";
import { SESSION_COOKIE } from "@/app/lib/auth/config";
import { guardedEventStream } from "@/app/lib/auth/event-stream";
import { sessionUser } from "@/app/lib/auth/store";
import { getOwnedWorkspace } from "@/app/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ workspaceId: string }> };

export async function GET(request: Request, { params }: Context) {
  const { workspaceId } = await params;
  const auth = await requireOwnedWorkspace(workspaceId, request);
  if (!auth.ok) return auth.response;
  const clientId = new URL(request.url).searchParams.get("clientId");
  if (!isClientId(clientId)) return errorResponse(400, "INVALID_AGENT_LEASE", "请提供有效的页面租约。");
  const token = (await cookies()).get(SESSION_COOKIE)!.value;
  const authorized = () => sessionUser(token)?.id === auth.user.id && !!getOwnedWorkspace(workspaceId, auth.user.id);
  let subscribed = false;
  const stream = guardedEventStream(request.signal, authorized, (send) => {
    const unsubscribe = subscribe(workspaceId, clientId, send);
    subscribed = unsubscribe !== null;
    return unsubscribe ?? (() => {});
  });
  // ReadableStream.start runs synchronously. Unknown/released leases must not
  // open an SSE response, which would cause EventSource to reconnect forever.
  if (!subscribed) {
    await stream.cancel();
    return new Response(null, { status: 204, headers: { "cache-control": "private, no-store" } });
  }
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "private, no-store, no-transform",
      connection: "keep-alive",
    },
  });
}

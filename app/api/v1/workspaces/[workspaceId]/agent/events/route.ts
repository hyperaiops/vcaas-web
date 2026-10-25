import { cookies } from "next/headers";
import { subscribe, ensureAgentSession } from "@/app/lib/bridge/session";
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
  const token = (await cookies()).get(SESSION_COOKIE)!.value;
  const authorized = () => sessionUser(token)?.id === auth.user.id && !!getOwnedWorkspace(workspaceId, auth.user.id);
  try {
    await ensureAgentSession(workspaceId);
  } catch {
    return new Response("智能助手暂时不可用", { status: 503 });
  }
  const stream = guardedEventStream(request.signal, authorized, (send) => subscribe(workspaceId, send));
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "private, no-store, no-transform",
      connection: "keep-alive",
    },
  });
}

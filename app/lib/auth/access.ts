import "server-only";
import { cookies } from "next/headers";
import { getOwnedWorkspace } from "../db";
import { errorResponse } from "../workspace/api-helpers";
import { authConfig, SESSION_COOKIE } from "./config";
import { sessionUser } from "./store";

export async function currentUser() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? await sessionUser(token) : null;
}

export function checkOrigin(request: Request): Response | null {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return null;
  if (request.headers.get("origin") !== authConfig().origin) {
    return errorResponse(403, "INVALID_ORIGIN", "请求来源不受信任，请从本站页面重新操作。");
  }
  return null;
}

export async function requireUser(request?: Request) {
  const user = await currentUser();
  if (!user) return { ok: false as const, response: errorResponse(401, "UNAUTHENTICATED", "请先登录。") };
  const rejected = request ? checkOrigin(request) : null;
  if (rejected) return { ok: false as const, response: rejected };
  return { ok: true as const, user };
}

export async function requireOwnedWorkspace(workspaceId: string, request?: Request) {
  const auth = await requireUser(request);
  if (!auth.ok) return auth;
  const workspace = await getOwnedWorkspace(workspaceId, auth.user.id);
  if (!workspace) return { ok: false as const, response: errorResponse(404, "WORKSPACE_NOT_FOUND", "未找到该工作区。") };
  return { ...auth, workspace };
}

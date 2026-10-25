import fs from "node:fs/promises";
import path from "node:path";
import { requireOwnedWorkspace } from "@/app/lib/auth/access";
import { resolveSafeFilePath, WorkspacePathError } from "@/app/lib/workspace/paths";
import { jsonResponse, errorResponse } from "@/app/lib/workspace/api-helpers";
import { DEFAULT_LIMITS } from "@/app/lib/workspace/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ workspaceId: string; path: string[] }> };

// PUT /api/v1/workspaces/[id]/files/[...path] — write a utf-8 file's contents
// to disk inside the workspace, with strict path safety. Binary files cannot
// be written through this endpoint (the editor only edits utf-8).
export async function PUT(request: Request, { params }: Context) {
  const { workspaceId, path: segments } = await params;
  const auth = await requireOwnedWorkspace(workspaceId, request);
  if (!auth.ok) return auth.response;
  const { workspace } = auth;

  let contents = "";
  try {
    const body = await request.json();
    if (typeof body?.contents !== "string") {
      return errorResponse(400, "INVALID_REQUEST", "请求正文必须包含字符串类型的 contents 字段。");
    }
    contents = body.contents;
  } catch {
    return errorResponse(400, "INVALID_REQUEST", "请求正文必须是有效的 JSON。");
  }

  // Size guard: refuse writes larger than the per-file limit.
  const maxBytes = DEFAULT_LIMITS.maxFileBytes;
  if (Buffer.byteLength(contents, "utf8") > maxBytes) {
    return errorResponse(413, "FILE_TOO_LARGE", `文件内容超过 ${maxBytes} 字节的大小限制。`);
  }

  let resolved: string;
  try {
    resolved = await resolveSafeFilePath(workspace.rootPath, segments);
  } catch (error) {
    if (error instanceof WorkspacePathError) {
      return errorResponse(400, error.code, error.message);
    }
    return errorResponse(500, "INVALID_PATH", "无法解析文件路径。");
  }

  try {
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, contents, "utf8");
  } catch {
    return errorResponse(500, "WRITE_FAILED", "无法写入文件。");
  }

  const relative = path.relative(workspace.rootPath, resolved);
  return jsonResponse({ apiVersion: "v1", ok: true, path: relative.split(path.sep).join("/") });
}

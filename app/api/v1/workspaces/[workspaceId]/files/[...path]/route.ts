import fs from "node:fs/promises";
import path from "node:path";
import { requireOwnedWorkspace } from "@/app/lib/auth/access";
import { resolveSafeFilePath, WorkspacePathError } from "@/app/lib/workspace/paths";
import { jsonResponse, errorResponse } from "@/app/lib/workspace/api-helpers";
import { getWorkspaceLimits } from "@/app/lib/workspace/limits";
import { buildTree, WorkspaceTreeError } from "@/app/lib/workspace/builder";
import { withWorkspaceWriteSlot } from "@/app/lib/workspace/write-slot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ workspaceId: string; path: string[] }> };

// PUT /api/v1/workspaces/[id]/files/[...path] — write editor JSON or raw
// attachment bytes to disk inside the workspace, with strict path safety.
async function readBytes(request: Request, maxBytes: number): Promise<Buffer | null> {
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      void reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size);
}
export async function PUT(request: Request, { params }: Context) {
  const { workspaceId, path: segments } = await params;
  const auth = await requireOwnedWorkspace(workspaceId, request);
  if (!auth.ok) return auth.response;
  const { workspace } = auth;

  const limits = getWorkspaceLimits();
  const maxBytes = limits.maxFileBytes;
  let contents: string | Buffer;
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/octet-stream") {
    let bytes: Buffer | null;
    try {
      bytes = await readBytes(request, maxBytes);
    } catch {
      return errorResponse(400, "INVALID_REQUEST", "无法读取上传的文件。", { messageKey: "request.uploadUnreadable" });
    }
    if (bytes === null) {
      return errorResponse(413, "FILE_TOO_LARGE", `文件内容超过 ${maxBytes} 字节的大小限制。`, {
        messageKey: "file.tooLarge",
        args: { maxBytes },
      });
    }
    contents = bytes;
  } else {
    try {
      const body = await request.json();
      if (typeof body?.contents !== "string") {
        return errorResponse(400, "INVALID_REQUEST", "请求正文必须包含字符串类型的 contents 字段。", { messageKey: "request.contentsRequired" });
      }
      contents = body.contents;
    } catch {
      return errorResponse(400, "INVALID_REQUEST", "请求正文必须是有效的 JSON。", { messageKey: "request.invalidJson" });
    }
    if (Buffer.byteLength(contents, "utf8") > maxBytes) {
      return errorResponse(413, "FILE_TOO_LARGE", `文件内容超过 ${maxBytes} 字节的大小限制。`, {
        messageKey: "file.tooLarge",
        args: { maxBytes },
      });
    }
  }

  return withWorkspaceWriteSlot(workspaceId, async () => {
    let resolved: string;
    try {
      resolved = await resolveSafeFilePath(workspace.rootPath, segments);
    } catch (error) {
      if (error instanceof WorkspacePathError) {
        return errorResponse(400, error.code, error.message,
          error.messageKey ? { messageKey: error.messageKey, args: error.args } : undefined);
      }
      return errorResponse(500, "INVALID_PATH", "无法解析文件路径。", { messageKey: "file.pathUnresolvable" });
    }

    if (segments[0] === ".attachments") {
      try {
        const tree = await buildTree(workspace.rootPath, limits);
        const existing = await fs.stat(resolved).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        const size = typeof contents === "string" ? Buffer.byteLength(contents, "utf8") : contents.byteLength;
        if (tree.sizeBytes - (existing?.size ?? 0) + size > limits.maxTotalBytes) {
          return errorResponse(413, "WORKSPACE_TOTAL_TOO_LARGE", `上传后工作区总大小将超过 ${limits.maxTotalBytes} 字节的上限。`, {
            messageKey: "file.workspaceTotalTooLarge",
            args: { maxTotalBytes: limits.maxTotalBytes },
          });
        }
        if (!existing && tree.fileCount >= limits.maxFiles) {
          return errorResponse(413, "WORKSPACE_FILE_COUNT_LIMIT", `工作区文件数量已达到 ${limits.maxFiles} 的上限。`, {
            messageKey: "file.workspaceFileCountLimit",
            args: { maxFiles: limits.maxFiles },
          });
        }
      } catch (error) {
        if (error instanceof WorkspaceTreeError) {
          return errorResponse(422, error.code, error.message,
            error.messageKey ? { messageKey: error.messageKey, args: error.args } : undefined);
        }
        return errorResponse(500, "WRITE_FAILED", "无法检查工作区大小。", { messageKey: "file.workspaceSizeCheckFailed" });
      }
    }

    try {
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, contents);
    } catch {
      return errorResponse(500, "WRITE_FAILED", "无法写入文件。", { messageKey: "file.writeFailed" });
    }

    const relative = path.relative(workspace.rootPath, resolved);
    return jsonResponse({ apiVersion: "v1", ok: true, path: relative.split(path.sep).join("/") });
  });
}

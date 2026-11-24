import path from "node:path";
import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { jsonResponse, errorResponse } from "@/app/lib/workspace/api-helpers";
import { listWorkspaces, createWorkspace, workspaceIdUsed, WorkspaceError } from "@/app/lib/db";
import { requireUser } from "@/app/lib/auth/access";
import { isValidWorkspaceId, type WorkspaceRow } from "@/app/lib/workspace/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function publicWorkspace(row: WorkspaceRow) {
  return { id: row.id, name: row.name, revision: row.revision, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

export async function GET() {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  return jsonResponse({ apiVersion: "v1", workspaces: (await listWorkspaces(auth.user.id)).map(publicWorkspace) });
}

const SKIP_NAMES = new Set(["node_modules", ".next", "out", ".git", "tsconfig.tsbuildinfo", "package-lock.json"]);

export async function POST(request: Request) {
  const auth = await requireUser(request);
  if (!auth.ok) return auth.response;
  let body: { name?: unknown; id?: unknown };
  try { body = await request.json(); } catch {
    return errorResponse(400, "INVALID_REQUEST", "请求正文必须是有效的 JSON。");
  }
  if (!body || typeof body !== "object") return errorResponse(400, "INVALID_REQUEST", "请求正文必须是一个对象。");
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!name) return errorResponse(400, "INVALID_REQUEST", "必须提供非空的 name 字段。");
  if (id && !isValidWorkspaceId(id)) return errorResponse(400, "INVALID_WORKSPACE_ID", "工作区 ID 只能包含小写字母、数字和连字符。");
  // These are runtime volumes; the template is shipped explicitly by Docker.
  const root = path.resolve(/* turbopackIgnore: true */ process.env.WORKSPACE_FILES_ROOT ?? path.join(process.cwd(), ".data", "workspaces"));
  const src = path.resolve(/* turbopackIgnore: true */ process.env.TEMPLATE_DIR ?? path.join(process.cwd(), "template"));
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "") || "workspace";
  await fs.mkdir(root, { recursive: true });
  for (let attempt = 0; attempt < 10; attempt++) {
    const finalId = id || `${slug}-${randomBytes(6).toString("hex")}`;
    if (await workspaceIdUsed(finalId)) {
      if (!id) continue;
      return errorResponse(409, "WORKSPACE_EXISTS", "该 ID 的工作区已存在。");
    }
    const workspacePath = path.join(/* turbopackIgnore: true */ root, finalId);
    try {
      // Non-recursive mkdir reserves this exact directory. Never adopt an existing one.
      await fs.mkdir(workspacePath, { mode: 0o755 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        if (!id) continue;
        return errorResponse(409, "WORKSPACE_EXISTS", "该 ID 的工作区已存在。");
      }
      return errorResponse(500, "WORKSPACE_CREATE_FAILED", "无法创建工作区目录。");
    }
    try {
      await fs.cp(src, workspacePath, {
        recursive: true,
        filter: (source) => source === src || !SKIP_NAMES.has(path.basename(source)),
      });
      const row = await createWorkspace({ id: finalId, name, rootPath: workspacePath, ownerId: auth.user.id });
      return jsonResponse({ apiVersion: "v1", workspace: publicWorkspace(row) }, 201);
    } catch (error) {
      // Only remove the directory reserved by this request, never an existing project.
      await fs.rm(workspacePath, { recursive: true, force: true });
      if (error instanceof WorkspaceError) return errorResponse(409, error.code, error.message);
      return errorResponse(500, "WORKSPACE_CREATE_FAILED", "无法初始化工作区。");
    }
  }
  return errorResponse(409, "WORKSPACE_EXISTS", "无法分配工作区 ID。");
}

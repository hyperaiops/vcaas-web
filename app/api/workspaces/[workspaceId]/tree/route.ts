import { NextRequest } from "next/server";
import { proxyWorkspace } from "@/app/lib/workspace-proxy";

type Context = { params: Promise<{ workspaceId: string }> };

export async function GET(request: NextRequest, { params }: Context) {
  const { workspaceId } = await params;
  return proxyWorkspace(request, [workspaceId, "tree"]);
}

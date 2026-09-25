import { jsonResponse } from "@/app/lib/workspace/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return jsonResponse({ status: "ok" });
}

import { errorResponse } from "@/app/lib/workspace/api-helpers";

export function isClientId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export async function readAgentBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    return body !== null && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function parseLease(body: Record<string, unknown>) {
  if (!isClientId(body.clientId) || typeof body.issuedAt !== "number" || !Number.isSafeInteger(body.issuedAt)) return null;
  // Request freshness and replay protection are enforced by the session manager.
  return { clientId: body.clientId, issuedAt: body.issuedAt };
}

export function agentError(error: unknown, fallbackStatus: number, code: string, message: string) {
  if (error !== null && typeof error === "object" && "status" in error &&
      typeof error.status === "number" && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599) {
    return errorResponse(error.status, "code" in error && typeof error.code === "string" ? error.code : code, message);
  }
  return errorResponse(fallbackStatus, code, message);
}

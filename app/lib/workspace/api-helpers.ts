// Shared helpers for workspace Route Handlers: error responses, JSON
// responses, and ETag handling. Mirrors the Go httpapi writeJSON / apiError /
// quoteETag helpers.

export function quoteETag(value: string): string {
  return `"${value}"`;
}

export function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  const h = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "private, max-age=0, must-revalidate" });
  if (headers) {
    for (const [key, value] of new Headers(headers)) h.set(key, value);
  }
  return new Response(JSON.stringify(body), { status, headers: h });
}

export function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, status);
}

export const SNAPSHOT_HEADERS = {
  contentType: "application/vnd.webcontainer.snapshot",
  format: "webcontainer-snapshot-v1",
};

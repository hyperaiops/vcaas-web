// Shared helpers for workspace Route Handlers: error responses, JSON
// responses, and ETag handling. Mirrors the Go httpapi writeJSON / apiError /
// quoteETag helpers.

import type { ApiMessageArgs, ApiMessageKey } from "@/app/lib/i18n/api-messages";

export function quoteETag(value: string): string {
  return `"${value}"`;
}

export function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  const h = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" });
  if (headers) {
    for (const [key, value] of new Headers(headers)) h.set(key, value);
  }
  return new Response(JSON.stringify(body), { status, headers: h });
}

// Optional localization metadata for API errors. `message` remains the
// pre-rendered zh-CN text (backwards compatible); `messageKey` + `args` let
// clients re-localize without parsing the message. Args only ever carry
// values already present in `message` (numeric limits, workspace-relative
// paths) — never secrets or absolute server paths.
export type ErrorLocalization = {
  messageKey: ApiMessageKey;
  args?: ApiMessageArgs;
};

export function errorResponse(status: number, code: string, message: string, localization?: ErrorLocalization): Response {
  return jsonResponse({ error: { code, message, ...(localization ?? {}) } }, status);
}

export const SNAPSHOT_HEADERS = {
  contentType: "application/vnd.webcontainer.snapshot",
  format: "webcontainer-snapshot-v1",
};

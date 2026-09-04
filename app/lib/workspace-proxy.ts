import { NextRequest } from "next/server";

const BACKEND = process.env.WEBCONTAINER_API_BASE_URL ?? "http://localhost:8080";

const FORWARDED_HEADERS = [
  "content-type",
  "content-length",
  "etag",
  "x-content-sha256",
  "x-workspace-revision",
  "x-webcontainer-snapshot-format",
  "cache-control",
];

function backendURL(segments: string[]): URL {
  const path = `/v1/workspaces/${segments.map(encodeURIComponent).join("/")}`;
  return new URL(path, BACKEND);
}

/**
 * Proxies the browser-facing /api/workspaces/* routes to the Go
 * Workspace API (default http://localhost:8080).
 *
 * The frontend requests stable latest representations only:
 * `/api/workspaces/{id}`, `/api/workspaces/{id}/tree`, or
 * `/api/workspaces/{id}/snapshot`.
 */
export async function proxyWorkspace(
  request: NextRequest,
  segments: string[],
): Promise<Response> {
  try {
    if (segments.length < 1 || segments.length > 2 || (segments.length === 2 && !["tree", "snapshot"].includes(segments[1]))) {
      return Response.json(
        { error: { code: "WORKSPACE_ROUTE_NOT_FOUND", message: "The requested workspace route does not exist." } },
        { status: 404 },
      );
    }

    const headers = new Headers();
    const etag = request.headers.get("if-none-match");
    if (etag) headers.set("if-none-match", etag);

    const upstream = await fetch(backendURL(segments), {
      headers,
      cache: "no-store",
    });

    const responseHeaders = new Headers();
    for (const header of FORWARDED_HEADERS) {
      const value = upstream.headers.get(header);
      if (value) responseHeaders.set(header, value);
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "The workspace API is unavailable.";
    return Response.json(
      { error: { code: "WORKSPACE_API_UNAVAILABLE", message } },
      { status: 502 },
    );
  }
}

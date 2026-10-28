// Legacy public snapshots bypass workspace authorization. Never serve them.
export function proxy() {
  return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
}

export const config = { matcher: "/snapshots/:path*" };

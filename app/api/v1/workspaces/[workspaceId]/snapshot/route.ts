import { resolveWorkspaceTree } from "@/app/lib/workspace/resolver";
import { quoteETag, errorResponse } from "@/app/lib/workspace/api-helpers";
import {
  findSnapshot,
  publishSnapshot,
  publishPublicSnapshot,
  generateSnapshot,
  SNAPSHOT_FORMAT,
  SnapshotTooLargeError,
} from "@/app/lib/workspace/snapshot";
import { withGenerationSlot, GenerationInProgressError } from "@/app/lib/workspace/generation-slot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ workspaceId: string }> };

const SNAPSHOT_MEDIA_TYPE = "application/vnd.webcontainer.snapshot";

function snapshotHeaders(workspaceId: string, revision: string, sha256: string, size: number, cacheControl: string): Headers {
  return new Headers({
    "content-type": SNAPSHOT_MEDIA_TYPE,
    "content-disposition": `attachment; filename="${workspaceId}.snapshot"`,
    "content-length": String(size),
    etag: quoteETag(sha256),
    "x-workspace-revision": revision,
    "x-content-sha256": sha256,
    "x-webcontainer-snapshot-format": SNAPSHOT_FORMAT,
    "cache-control": cacheControl,
  });
}

// GET — serve a previously generated snapshot from the on-disk cache.
export async function GET(request: Request, { params }: Context) {
  const { workspaceId } = await params;
  const resolved = await resolveWorkspaceTree(workspaceId);
  if (!resolved.ok) return resolved.response;
  const { workspace, tree } = resolved;

  const snapshot = await findSnapshot(tree.revision);
  if (!snapshot) {
    return errorResponse(404, "SNAPSHOT_NOT_AVAILABLE", "A snapshot is not available for the current workspace.");
  }
  if (request.headers.get("if-none-match") === quoteETag(snapshot.sha256)) {
    return new Response(null, { status: 304, headers: { etag: quoteETag(snapshot.sha256) } });
  }
  return new Response(new Uint8Array(snapshot.buffer), {
    status: 200,
    headers: snapshotHeaders(workspace.id, tree.revision, snapshot.sha256, snapshot.size, "private, max-age=0, must-revalidate"),
  });
}

// POST — generate a fresh snapshot in-process, publish it to the cache, and
// return the blob. Re-checks the revision after generation (like the Go
// API) so a workspace that changed mid-generation is retried up to 3 times.
export async function POST(request: Request, { params }: Context) {
  const { workspaceId } = await params;
  try {
    const result = await withGenerationSlot(workspaceId, async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const resolved = await resolveWorkspaceTree(workspaceId);
        if (!resolved.ok) return resolved.response;
        const { workspace, tree } = resolved;

        let contents: Buffer;
        try {
          contents = await generateSnapshot(tree);
        } catch (error) {
          if (error instanceof SnapshotTooLargeError) {
            return errorResponse(413, "SNAPSHOT_TOO_LARGE", "The generated snapshot exceeds the maximum size.");
          }
          return errorResponse(500, "SNAPSHOT_GENERATION_FAILED", `Unable to generate the workspace snapshot: ${error instanceof Error ? error.message : String(error)}`);
        }

        // Re-build to detect a change during generation; if the revision
        // moved, retry (the cached tree is stale).
        const current = await resolveWorkspaceTree(workspaceId);
        if (!current.ok) return current.response;
        if (current.tree.revision !== tree.revision) continue;

        const { sha256 } = await publishSnapshot(tree.revision, contents);
        // Also publish a workspace-id-keyed copy under public/snapshots/ so the
        // dev server can serve it as a bare static URL. Best-effort: a failure
        // here must not break the API response (the revision cache is already
        // published and the API route still serves the blob).
        try {
          await publishPublicSnapshot(workspace.id, contents);
        } catch {
          // Ignore — public URL is a dev-only convenience, not required for mount.
        }
        return new Response(new Uint8Array(contents), {
          status: 200,
          headers: snapshotHeaders(workspace.id, tree.revision, sha256, contents.byteLength, "no-store"),
        });
      }
      return errorResponse(409, "WORKSPACE_CHANGED_DURING_SNAPSHOT", "The workspace changed repeatedly during snapshot generation.");
    });
    return result;
  } catch (error) {
    if (error instanceof GenerationInProgressError) {
      return new Response(
        JSON.stringify({ error: { code: "SNAPSHOT_GENERATION_IN_PROGRESS", message: error.message } }),
        { status: 409, headers: { "content-type": "application/json", "retry-after": "1" } },
      );
    }
    return errorResponse(500, "SNAPSHOT_GENERATION_FAILED", "Unable to generate the workspace snapshot.");
  }
}

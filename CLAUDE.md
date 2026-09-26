@AGENTS.md

# PI Agent — Web IDE (webcontainer)

A browser-based Web IDE: chat with a coding agent on the left, build and preview
a real Next.js app inside a WebContainer on the right. Multiple workspaces are
managed in SQLite; each workspace is a scaffolded Next.js app mounted into the
WebContainer preview.

## Stack

- **Next.js 16.3.4** (app router) + React 19 + Tailwind v4 + TypeScript.
- **better-sqlite3** for workspace metadata (synchronous, Node-only native module).
- **@webcontainer/api** boots the in-browser container; **@webcontainer/snapshot**
  builds binary mount blobs in-process. **@xterm/xterm** for the terminal.
- This is a **Node runtime** app — all API routes and server libs use the Node
  runtime (no Edge). `server-only` guards prevent server libs from leaking into
  client bundles.

## Architecture

### Two pages
- `/` (`app/page.tsx`) — **workspace dashboard**: card grid, create/delete, open.
- `/workspaces/[id]` (`app/workspaces/[id]/page.tsx`) — **editor**: `AgentPanel`
  (chat) + `WebContainerPreview` (terminal + iframe preview). Reads the workspace
  id from the URL. Back link returns to `/`.

### Workspace model (SQLite index + disk files)
SQLite is the **metadata index only**; the actual files for each workspace live
on disk under `{WORKSPACE_FILES_ROOT}/{id}/` and are walked at request time.

- `app/lib/db.ts` — opens `workspaces.db`, schema + CRUD (`listWorkspaces`,
  `getWorkspace`, `createWorkspace`, `updateWorkspaceRevision`,
  `deleteWorkspace`, `getWorkspaceByRoot`). Singleton `getDb()`.
- `app/lib/workspace/types.ts` — shared types (`WorkspaceSummary`, `TreeNode`,
  `TreeResponse`, `WorkspaceManifest`, `WorkspaceLimits`, `DEFAULT_LIMITS`) +
  `isValidWorkspaceId`. Safe to import from client components.
- `app/lib/workspace/builder.ts` — `buildTree(root, limits)`: walks a workspace
  dir, computes a content-derived sha256 **revision**, serializes a JSON tree
  (utf-8 or base64 file encoding). Ports the original Go `tree.go`.
- `app/lib/workspace/snapshot.ts` — `generateSnapshot` (in-process via
  `@webcontainer/snapshot`, no subprocess), `publishSnapshot` / `findSnapshot`
  (on-disk cache keyed by revision, format `webcontainer-snapshot-v1`).
- `app/lib/workspace/generation-slot.ts` — per-workspace mutex (one snapshot
  generation at a time → 409 `SNAPSHOT_GENERATION_IN_PROGRESS`).
- `app/lib/workspace/resolver.ts` — `resolveWorkspaceTree`: builds the tree,
  persists the revision, returns a discriminated `ok` result or error Response.
- `app/lib/workspace/api-helpers.ts` — `jsonResponse`, `errorResponse`,
  `quoteETag`.

### PI agent (per-workspace PiWorker CR)
- `app/lib/bridge/k8s.ts` — Kubernetes client for the `PiWorker` CRD
  (`ubi.pi.dev/v1alpha1`, plural `piworkers`). `ensurePiWorker(id)` first creates
  a per-CR LiteLLM Secret (`pw-<id>-litellm`, key `api-key`) holding the key from
  `PI_LITELLM_API_KEY`, then creates the CR (named after the workspace id, in
  `PI_NAMESPACE`) referencing it, polls until `.status.conditions[Ready]==True`
  and `.status.endpoint` is populated, reads the auto-generated bearer token
  from the Secret named in `.status.bearerTokenSecretRef`, and returns
  `{ endpoint, token }`. `deletePiWorker(id)` deletes the CR and its per-CR
  LiteLLM Secret; the operator's ownerRef + finalizer garbage-collect the
  managed Deployment/Service/Ingress/bearer-token Secret. Runs in-cluster or via
  kubeconfig (`KubeConfig.loadFromDefault`); env-driven (`PI_NAMESPACE`,
  `PI_LITELLM_API_KEY`, `PI_LITELLM_BASE_URL`, `PI_LITELLM_MODEL`,
  `PI_INGRESS_*`, `PI_BRIDGE_ALLOWED_ORIGIN`). Server-only.
- The operator is the **PiWorker** repo
  (`/Users/yuan-feng.xueubisoft.com/GolandProjects/PiWorker`); each `PiWorker` CR
  reconciles into a pod running the Go `cmd/bridge` (which runs `pi --mode rpc`)
  behind an authenticated, per-instance Ingress. The bridge accepts the bearer
  token via the `Authorization` header **or** a `?token=` query param (added so
  browser `WebSocket`, which cannot set headers, can authenticate).

### API routes (all under `app/api/`, `runtime = "nodejs"`, `dynamic = "force-dynamic"`)
- `GET /api/healthz` — liveness.
- `GET/POST /api/v1/workspaces` — list / create (scaffolds from `template/`).
- `GET/DELETE /api/v1/workspaces/[id]` — manifest / delete.
- `GET /api/v1/workspaces/[id]/tree` — JSON tree (+ ETag / `If-None-Match` → 304).
- `GET/POST /api/v1/workspaces/[id]/snapshot` — serve cached / generate.
- `POST /api/v1/workspaces/[id]/agent/start` — ensures a `PiWorker` CR is Ready
  for the workspace and returns `{ endpoint, token }` so the browser can open
  the agent's `wss://...<ingress-domain>/v1/rpc` WebSocket.
- `POST /api/v1/workspaces/[id]/agent/stop` — deletes the workspace's `PiWorker`
  CR (idempotent); the operator garbage-collects the agent resources.
- `POST /api/chat` — (legacy) streams the external `pi` CLI (`PI_BIN`) against the
  selected workspace's root (resolved from the request `workspaceId` via the DB;
  falls back to `PI_WORKSPACE_ROOT`). Unused since the AgentPanel moved to the
  long-lived bridge WebSocket.

### Frontend
- `app/components/WebContainerPreview.tsx` — boots the singleton WebContainer,
  fetches the manifest, mounts tree or snapshot, runs `pnpm install` + `pnpm dev`
  inside the container, renders an xterm terminal + iframe preview. Takes
  `workspaceId` as a prop. Never SSR (`next/dynamic`, `ssr: false`).
- `app/components/AgentPanel.tsx` — chat UI; on mount POSTs to
  `/api/v1/workspaces/[id]/agent/start` then opens a long-lived WebSocket to the
  agent's public `/v1/rpc` (returned endpoint, `?token=` auth). One Pi RPC
  `prompt` command per user message; assistant `text_delta` events stream into
  the current agent message. Closing the socket on unmount also POSTs
  `/agent/stop` to delete the `PiWorker` CR.
- `app/components/WorkspaceCard.tsx` — dashboard card.
- `app/lib/webcontainer-tree.ts` — `toFileSystemTree`: converts the tree API
  response into `@webcontainer/api`'s `FileSystemTree` for `wc.mount()`.

## Key conventions & gotchas

- **Path alias**: `@/*` → `./*` (e.g. `@/app/lib/db`). The `template/` dir is a
  separate scaffolded Next.js app and is **excluded from the host tsconfig** —
  don't import from it into the host app.
- **Server-only libs**: `app/lib/db.ts` and `app/lib/workspace/*.ts` import
  `server-only` + Node natives. Only import them from Route Handlers or server
  components, never from client components. Client-safe types live in
  `app/lib/workspace/types.ts`.
- **`better-sqlite3` is native**: it must be built after install
  (`pnpm rebuild better-sqlite3`). Build scripts need `pnpm approve-builds`.
- **WebContainer singleton**: `WebContainer.boot()` can only run once per page.
  `WebContainerPreview` keeps the boot promise in a module-level variable; the
  component re-mounts the workspace on prop change without re-booting.
- **COOP/COEP**: `next.config.ts` sets `Cross-Origin-Embedder-Policy:
  require-corp` and `Cross-Origin-Opener-Policy: same-origin` on all routes —
  required for WebContainer's `SharedArrayBuffer`. Don't remove these.
- **Ignored file rules** (in `builder.ts`, ported from Go): skips `.git`,
  `node_modules`, `.next`, `dist`, `build`, `out`, `.DS_Store`, `.env`, and
  `.env.*` overrides — **but keeps `.env.local`** so non-secret local config is
  available inside the mounted app. Rejects symlinks and non-regular files.
- **Snapshot contract**: the preview checks the `x-webcontainer-snapshot-format`
  header (`webcontainer-snapshot-v1`) before mounting a snapshot. Preserve the
  exact response headers (`ETag`, `X-Content-SHA256`, `X-Workspace-Revision`,
  `Content-Disposition`, `Cache-Control`) when touching snapshot routes — the
  frontend depends on them.
- **Hydration**: `app/layout.tsx` uses `suppressHydrationWarning` on `<html>`/
  `<body>` because browser extensions (Grammarly, etc.) inject attributes that
  mismatch SSR. Keep it.

## Data & env

- `.data/` (gitignored) holds `workspaces.db`, scaffolded workspace files, and
  the snapshot cache. Wiped on a fresh clone — workspaces are recreated from
  `template/` via the dashboard.
- `template/` (committed) is the scaffold source for new workspaces.
- Env vars (see `.env.example`): `WORKSPACE_DB_PATH`, `WORKSPACE_FILES_ROOT`,
  `SNAPSHOT_DIRECTORY`, `TEMPLATE_DIR`, optional `PI_BIN` / `PI_WORKSPACE_ROOT`.

## Commands

```bash
pnpm dev      # start dev server (http://localhost:3000)
pnpm build    # production build
pnpm start    # run the production build
pnpm lint     # eslint
npx tsc --noEmit   # typecheck
npx next typegen   # regenerate route types (after adding routes)
```

After changing dependencies: `pnpm rebuild better-sqlite3` if the native module
needs rebuilding.

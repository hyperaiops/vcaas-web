"use client";

import { useCallback, useEffect, useState } from "react";
import WorkspaceCard from "./components/WorkspaceCard";
import type { WorkspaceSummary } from "@/app/lib/workspace/types";

export default function Home() {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refreshWorkspaces = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/workspaces", { cache: "no-store" });
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const data = (await res.json()) as { workspaces: WorkspaceSummary[] };
      setWorkspaces(data.workspaces);
      return data.workspaces;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load workspaces.");
      setWorkspaces([]);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshWorkspaces();
  }, [refreshWorkspaces]);

  async function createWorkspace(event: React.FormEvent) {
    event.preventDefault();
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message ?? `Failed (${res.status})`);
      }
      setNewName("");
      await refreshWorkspaces();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create workspace.");
    } finally {
      setCreating(false);
    }
  }

  async function deleteWorkspace(id: string) {
    setDeletingId(id);
    setError(null);
    try {
      const res = await fetch(`/api/v1/workspaces/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message ?? `Failed (${res.status})`);
      }
      await refreshWorkspaces();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete workspace.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-neutral-50">
      {/* Title bar */}
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-neutral-300 bg-white px-4">
        <div className="flex h-5 w-5 items-center justify-center rounded bg-blue-600 text-[10px] font-bold text-white">
          PI
        </div>
        <span className="text-[13px] font-medium text-neutral-800">Vibe Coding Gallery</span>
        <span className="text-[13px] text-neutral-400">— Workspaces</span>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-4 py-8">
          <div className="flex items-end justify-between gap-4">
            <div>
              <h1 className="text-lg font-semibold text-neutral-800">Workspaces</h1>
              <p className="mt-0.5 text-xs text-neutral-500">
                Create a workspace, then open it to edit and preview in a WebContainer.
              </p>
            </div>
            <form onSubmit={createWorkspace} className="flex items-center gap-2">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="New workspace name…"
                className="w-48 rounded border border-neutral-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              />
              <button
                type="submit"
                disabled={creating || !newName.trim()}
                className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {creating ? "Creating…" : "Create"}
              </button>
            </form>
          </div>

          {error && (
            <p className="mt-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>
          )}

          {loading ? (
            <div className="mt-10 flex items-center justify-center text-sm text-neutral-400">
              <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-neutral-300 border-t-blue-600" />
              Loading workspaces…
            </div>
          ) : workspaces.length === 0 ? (
            <div className="mt-10 flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-neutral-300 bg-white py-16 text-center">
              <p className="text-sm font-medium text-neutral-600">No workspaces yet</p>
              <p className="max-w-sm text-xs text-neutral-400">
                Create your first workspace above. It&apos;s scaffolded from a template and ready to run.
              </p>
            </div>
          ) : (
            <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {workspaces.map((w) => (
                <WorkspaceCard
                  key={w.id}
                  workspace={w}
                  onDelete={deleteWorkspace}
                  deleting={deletingId === w.id}
                />
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

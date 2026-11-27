"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import WorkspaceCard from "./WorkspaceCard";
import UserMenu from "./UserMenu";
import { authenticatedFetch } from "@/app/lib/auth/client";
import { useMessages } from "@/app/lib/i18n/context";
import type { WorkspaceSummary } from "@/app/lib/workspace/types";

export default function WorkspaceDashboard({ userName, canLogout = true }: { userName: string; canLogout?: boolean }) {
  const m = useMessages();
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const creatingRef = useRef(false);
  const formId = useId();

  function openCreateDialog() {
    if (creatingRef.current) return;
    setNewName("");
    setCreateError(null);
    dialogRef.current?.showModal();
    nameRef.current?.focus();
  }

  function closeCreateDialog() {
    if (creatingRef.current) return;
    dialogRef.current?.close();
    setNewName("");
    setCreateError(null);
  }

  const refreshWorkspaces = useCallback(async () => {
    try {
      const res = await authenticatedFetch("/api/v1/workspaces", { cache: "no-store" });
      if (!res.ok) throw new Error(m.dashboard.requestFailed({ status: String(res.status) }));
      const data = (await res.json()) as { workspaces: WorkspaceSummary[] };
      setWorkspaces(data.workspaces);
      return data.workspaces;
    } catch (err) {
      console.error("Workspace load failed", err);
      setError(m.dashboard.loadFailed);
      setWorkspaces([]);
      return [];
    } finally {
      setLoading(false);
    }
  }, [m.dashboard]);

  useEffect(() => {
    const timer = setTimeout(() => void refreshWorkspaces(), 0);
    return () => clearTimeout(timer);
  }, [refreshWorkspaces]);

  async function createWorkspace(event: React.FormEvent) {
    event.preventDefault();
    const name = newName.trim();
    if (!name || creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    setCreateError(null);
    setError(null);
    try {
      const res = await authenticatedFetch("/api/v1/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        throw new Error(m.dashboard.requestFailed({ status: String(res.status) }));
      }
      dialogRef.current?.close();
      setNewName("");
      await refreshWorkspaces();
    } catch (err) {
      console.error("Workspace creation failed", err);
      setCreateError(m.dashboard.createFailed);
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }

  async function deleteWorkspace(id: string) {
    setDeletingId(id);
    setError(null);
    try {
      const res = await authenticatedFetch(`/api/v1/workspaces/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) {
        throw new Error(m.dashboard.requestFailed({ status: String(res.status) }));
      }
      await refreshWorkspaces();
    } catch (err) {
      console.error("Workspace deletion failed", err);
      setError(m.dashboard.deleteFailed);
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-[var(--brand-paper)] text-[var(--brand-ink)]">
      {/* Title bar */}
      <header className="shrink-0 border-b border-[var(--brand-line)]">
        <div className="mx-auto flex min-h-18 max-w-[1440px] items-center gap-2 px-5 sm:px-[6.1%]">
          <span className="brand-mark" aria-hidden="true">{'</>'}</span>
          <span className="whitespace-nowrap text-xl font-extrabold tracking-tight sm:text-2xl">{m.common.brandName}<span className="text-[var(--brand-purple)]">.</span></span>
          <span className="ml-3 hidden border-l border-[var(--brand-line)] pl-4 text-sm text-[var(--brand-muted)] sm:inline">{m.dashboard.myWorkspaces}</span>
          <UserMenu name={userName} canLogout={canLogout} />
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1440px] px-5 pb-16 pt-10 sm:px-[6.1%] sm:pt-14">
          <div className="flex flex-col items-stretch gap-6 border-b border-[var(--brand-line)] pb-8 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="mb-3 flex items-center gap-2 text-sm font-semibold tracking-wide text-[#697557]"><span className="h-2 w-2 rounded-full bg-[#799b39]" aria-hidden="true" />{m.dashboard.heroTagline}</p>
              <h1 className="text-3xl font-extrabold tracking-tight sm:text-5xl">{m.dashboard.myWorkspaces}<span className="text-[var(--brand-purple)]">.</span></h1>
              <p className="mt-3 max-w-xl text-sm leading-relaxed text-[var(--brand-muted)] sm:text-base">
{m.dashboard.heroDescription}
              </p>
            </div>
            <button
              type="button"
              onClick={openCreateDialog}
              disabled={creating}
              className="brand-button min-h-12 shrink-0 self-start px-5 py-2.5 text-sm sm:self-auto"
            >
              <span className="text-lg leading-none" aria-hidden="true">＋</span>{m.dashboard.newWorkspace} <span aria-hidden="true">↗</span>
            </button>
          </div>

          {error && (
            <p className="mt-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>
          )}

          {loading ? (
            <div className="mt-10 flex items-center justify-center text-sm text-[var(--brand-muted)]">
              <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-[#d9dccf] border-t-[var(--brand-purple)] motion-reduce:animate-none" />
              {m.dashboard.loading}
            </div>
          ) : workspaces.length === 0 ? (
            <div className="mt-8 flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-[#bcc2ad] bg-white/70 px-6 py-16 text-center">
              <span className="grid h-12 w-12 place-items-center rounded-xl bg-[var(--brand-lime)] text-2xl" aria-hidden="true">✳</span>
              <p className="text-lg font-bold text-[var(--brand-ink)]">{m.dashboard.emptyTitle}</p>
              <p className="max-w-sm text-sm text-[var(--brand-muted)]">
{m.dashboard.emptyBody}
              </p>
            </div>
          ) : (
            <div className="mt-8 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
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

      <dialog
        ref={dialogRef}
        aria-labelledby={`${formId}-title`}
        aria-describedby={`${formId}-description`}
        aria-modal="true"
        onCancel={(event) => {
          event.preventDefault();
          closeCreateDialog();
        }}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
            closeCreateDialog();
          }
        }}
        className="m-auto max-h-[calc(100dvh_-_2rem)] w-[calc(100%_-_2rem)] max-w-md overflow-y-auto rounded-xl border border-[var(--brand-ink)] bg-[var(--brand-paper)] p-0 text-[var(--brand-ink)] shadow-[7px_7px_0_#d4fa73] backdrop:bg-[#20211e]/50 backdrop:backdrop-blur-sm"
      >
        <form onSubmit={createWorkspace} aria-busy={creating}>
          <div className="flex items-start justify-between gap-4 border-b border-[var(--brand-line)] bg-[#eff5d9] px-6 py-5">
            <div>
              <p className="text-sm text-neutral-600">{m.dashboard.dialogTagline}</p>
              <h2 id={`${formId}-title`} className="mt-1 text-xl font-semibold">{m.dashboard.dialogTitle}</h2>
            </div>
            <button
              type="button"
              aria-label={m.dashboard.dialogClose}
              onClick={closeCreateDialog}
              disabled={creating}
              className="rounded-lg p-2 text-neutral-500 hover:bg-white hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
            </button>
          </div>
          <div className="px-6 py-6">
            <p id={`${formId}-description`} className="mb-5 text-sm leading-relaxed text-neutral-600">{m.dashboard.dialogDescription}</p>
            <label htmlFor={`${formId}-name`} className="block text-sm font-medium text-neutral-800">{m.dashboard.nameLabel}</label>
            <input
              ref={nameRef}
              id={`${formId}-name`}
              name="name"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault();
              }}
              aria-describedby={createError ? `${formId}-hint ${formId}-error` : `${formId}-hint`}
              placeholder={m.dashboard.namePlaceholder}
              required
              disabled={creating}
              className="mt-2 w-full rounded-md border border-[#b6b8ac] bg-white px-3 py-2.5 text-base focus:border-[var(--brand-purple)] disabled:bg-neutral-100 disabled:text-neutral-500"
            />
            <p id={`${formId}-hint`} className="mt-2 text-sm text-neutral-500">{m.dashboard.nameHint}</p>
            {createError && <p id={`${formId}-error`} role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{createError}</p>}
          </div>
          <div className="flex justify-end gap-3 border-t border-[var(--brand-line)] bg-[var(--brand-soft)] px-6 py-4">
            <button type="button" onClick={closeCreateDialog} disabled={creating} className="rounded-md border border-[#b6b8ac] bg-white px-4 py-2.5 text-sm font-medium text-[var(--brand-ink)] hover:bg-[#eceee3] disabled:cursor-not-allowed disabled:opacity-50">{m.dashboard.cancel}</button>
            <button type="submit" disabled={creating || !newName.trim()} className="brand-button px-4 py-2.5 text-sm">
              {creating && <span aria-hidden="true" className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white motion-reduce:animate-none" />}
              {creating ? m.dashboard.creating : m.dashboard.createSubmit}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}

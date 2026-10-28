"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import WorkspaceCard from "./WorkspaceCard";
import UserMenu from "./UserMenu";
import { authenticatedFetch } from "@/app/lib/auth/client";
import type { WorkspaceSummary } from "@/app/lib/workspace/types";

export default function WorkspaceDashboard({ userName }: { userName: string }) {
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
      if (!res.ok) throw new Error(`请求失败（${res.status}）`);
      const data = (await res.json()) as { workspaces: WorkspaceSummary[] };
      setWorkspaces(data.workspaces);
      return data.workspaces;
    } catch (err) {
      console.error("Workspace load failed", err);
      setError("工作区加载失败，请稍后重试。");
      setWorkspaces([]);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

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
        throw new Error(`请求失败（${res.status}）`);
      }
      dialogRef.current?.close();
      setNewName("");
      await refreshWorkspaces();
    } catch (err) {
      console.error("Workspace creation failed", err);
      setCreateError("工作区创建失败，请稍后重试。你的名称已保留。");
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
        throw new Error(`请求失败（${res.status}）`);
      }
      await refreshWorkspaces();
    } catch (err) {
      console.error("Workspace deletion failed", err);
      setError("工作区删除失败，请稍后重试。");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-neutral-50">
      {/* Title bar */}
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-neutral-300 bg-white px-4">
        <div className="flex h-5 w-5 items-center justify-center rounded bg-blue-600 text-[10px] font-bold text-white">
          随
        </div>
        <span className="text-[13px] font-medium text-neutral-800">随心一码</span>
        <span className="text-[13px] text-neutral-400">— 工作区</span>
        <UserMenu name={userName} />
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-4 py-8">
          <div className="flex flex-col items-stretch gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h1 className="text-lg font-semibold text-neutral-800">工作区</h1>
              <p className="mt-0.5 text-[13px] text-neutral-500">
                创建工作区，即可在 WebContainer 中编辑代码并实时预览。
              </p>
            </div>
            <button
              type="button"
              onClick={openCreateDialog}
              disabled={creating}
              className="inline-flex shrink-0 items-center justify-center gap-2 self-start rounded-lg bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span aria-hidden="true">＋</span>新建工作区
            </button>
          </div>

          {error && (
            <p className="mt-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>
          )}

          {loading ? (
            <div className="mt-10 flex items-center justify-center text-sm text-neutral-400">
              <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-neutral-300 border-t-blue-600" />
              正在加载工作区…
            </div>
          ) : workspaces.length === 0 ? (
            <div className="mt-10 flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-neutral-300 bg-white py-16 text-center">
              <p className="text-sm font-medium text-neutral-600">还没有工作区</p>
              <p className="max-w-sm text-[13px] text-neutral-400">
                点击“新建工作区”，系统会自动为你准备可运行的项目模板。
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
        className="m-auto max-h-[calc(100dvh_-_2rem)] w-[calc(100%_-_2rem)] max-w-md overflow-y-auto rounded-2xl border border-neutral-200 bg-white p-0 text-neutral-800 shadow-2xl backdrop:bg-black/40 backdrop:backdrop-blur-sm"
      >
        <form onSubmit={createWorkspace} aria-busy={creating}>
          <div className="flex items-start justify-between gap-4 border-b border-neutral-200 bg-lime-50 px-6 py-5">
            <div>
              <p className="text-sm text-neutral-600">新的灵感，从这里开始</p>
              <h2 id={`${formId}-title`} className="mt-1 text-xl font-semibold">新建工作区</h2>
            </div>
            <button
              type="button"
              aria-label="关闭新建工作区"
              onClick={closeCreateDialog}
              disabled={creating}
              className="rounded-lg p-2 text-neutral-500 hover:bg-white hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
            </button>
          </div>
          <div className="px-6 py-6">
            <p id={`${formId}-description`} className="mb-5 text-sm leading-relaxed text-neutral-600">给你的创意起个名字。系统会准备好项目模板，创建后就能和 AI 一起编程。</p>
            <label htmlFor={`${formId}-name`} className="block text-sm font-medium text-neutral-800">工作区名称</label>
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
              placeholder="例如：我的个人主页"
              required
              disabled={creating}
              className="mt-2 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2.5 text-base outline-none focus:border-lime-600 focus:ring-2 focus:ring-lime-100 disabled:bg-neutral-100 disabled:text-neutral-500"
            />
            <p id={`${formId}-hint`} className="mt-2 text-sm text-neutral-500">用一个容易辨认的名称，方便下次继续创作。</p>
            {createError && <p id={`${formId}-error`} role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{createError}</p>}
          </div>
          <div className="flex justify-end gap-3 border-t border-neutral-200 bg-neutral-50 px-6 py-4">
            <button type="button" onClick={closeCreateDialog} disabled={creating} className="rounded-lg border border-neutral-300 bg-white px-4 py-2.5 text-sm font-medium text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50">取消</button>
            <button type="submit" disabled={creating || !newName.trim()} className="inline-flex items-center justify-center gap-2 rounded-lg bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50">
              {creating && <span aria-hidden="true" className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white motion-reduce:animate-none" />}
              {creating ? "正在创建…" : "创建工作区"}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}

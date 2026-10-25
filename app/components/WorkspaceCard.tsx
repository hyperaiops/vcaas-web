"use client";

import Link from "next/link";
import type { WorkspaceSummary } from "@/app/lib/workspace/types";

type Props = {
  workspace: WorkspaceSummary;
  onDelete: (id: string) => Promise<void>;
  deleting?: boolean;
};

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("zh-CN", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export default function WorkspaceCard({ workspace, onDelete, deleting }: Props) {
  async function handleDelete() {
    if (deleting) return;
    const ok = window.confirm(
      `确定删除「${workspace.name}」吗？\n\n此操作将永久删除工作区文件和缓存快照，且无法撤销。`,
    );
    if (!ok) return;
    await onDelete(workspace.id);
  }

  return (
    <div className="group flex flex-col rounded-lg border border-neutral-200 bg-white p-4 shadow-sm transition hover:border-blue-300 hover:shadow">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-neutral-800">{workspace.name}</h3>
          <p className="mt-0.5 truncate font-mono text-[13px] text-neutral-400">{workspace.id}</p>
        </div>
        <span
          className={`mt-1 h-2 w-2 shrink-0 rounded-full ${workspace.revision ? "bg-emerald-500" : "bg-neutral-300"}`}
          title={workspace.revision ? "已有文件" : "暂无文件"}
        />
      </div>

      <dl className="mt-3 space-y-1 text-[13px] text-neutral-500">
        <div className="flex justify-between gap-2">
          <dt className="text-neutral-400">状态</dt>
          <dd className="truncate">{workspace.revision ? "已就绪" : "暂无文件"}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-neutral-400">创建时间</dt>
          <dd className="truncate">{formatDate(workspace.createdAt)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-neutral-400">更新时间</dt>
          <dd className="truncate">{formatDate(workspace.updatedAt)}</dd>
        </div>
      </dl>

      <div className="mt-4 flex items-center gap-2">
        <Link
          href={`/workspaces/${encodeURIComponent(workspace.id)}`}
          className="flex-1 rounded bg-blue-600 px-3 py-1.5 text-center text-[13px] font-medium text-white hover:bg-blue-700"
        >
          打开工作区
        </Link>
        <button
          type="button"
          onClick={handleDelete}
          disabled={deleting}
          className="rounded border border-red-300 px-3 py-1.5 text-[13px] font-medium text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {deleting ? "正在删除…" : "删除"}
        </button>
      </div>
    </div>
  );
}

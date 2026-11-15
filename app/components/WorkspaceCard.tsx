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
    <div className="group flex flex-col rounded-xl border border-[#d5d8ca] bg-white p-5 shadow-[4px_4px_0_#e6ebdb] transition-[border-color,box-shadow] hover:border-[#8c9877] hover:shadow-[5px_5px_0_#d4fa73] motion-reduce:transition-none">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="mb-4 inline-grid h-10 w-10 place-items-center rounded-lg bg-[#eff5d9] text-lg text-[#526a36]" aria-hidden="true">✳</span>
          <h3 className="truncate text-lg font-bold tracking-tight text-[var(--brand-ink)]">{workspace.name}</h3>
          <p className="mt-1 truncate font-mono text-xs text-[#81877a]">{workspace.id}</p>
        </div>
        <span
          className={`mt-1 h-2 w-2 shrink-0 rounded-full ${workspace.revision ? "bg-[#799b39]" : "bg-neutral-300"}`}
          title={workspace.revision ? "已有文件" : "暂无文件"}
        />
      </div>

      <dl className="mt-5 space-y-1.5 border-t border-[#ebede5] pt-4 text-[13px] text-[var(--brand-muted)]">
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

      <div className="mt-5 flex items-center gap-3">
        <Link
          href={`/workspaces/${encodeURIComponent(workspace.id)}`}
          className="brand-button min-h-10 flex-1 px-3 py-2 text-center text-[13px]"
        >
          打开工作区 <span aria-hidden="true">↗</span>
        </Link>
        <button
          type="button"
          onClick={handleDelete}
          disabled={deleting}
          className="min-h-10 rounded-md border border-[#e8c9c5] px-3 py-2 text-[13px] font-medium text-[#a34a42] hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {deleting ? "正在删除…" : "删除"}
        </button>
      </div>
    </div>
  );
}

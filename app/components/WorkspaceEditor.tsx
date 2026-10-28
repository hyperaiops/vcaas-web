"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import dynamic from "next/dynamic";
import AgentPanel from "@/app/components/AgentPanel";
import UserMenu from "./UserMenu";
import { authenticatedFetch } from "@/app/lib/auth/client";

// WebContainer only runs in the browser — never SSR it. This component now
// owns the Preview | Code tab toggle and renders the code editor itself.
const WebContainerPreview = dynamic(
  () => import("@/app/components/WebContainerPreview"),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-sm text-neutral-500">
        正在加载 WebContainer…
      </div>
    ),
  },
);

export default function WorkspaceEditor({ userName }: { userName: string }) {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const workspaceId = params?.id ?? null;

  const [isDesktop, setIsDesktop] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "missing">("loading");

  useEffect(() => {
    const check = () => setIsDesktop(window.innerWidth >= 1024);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // Verify the workspace exists before rendering the editor; redirect to the
  // dashboard if it was deleted or the id is bogus.
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await authenticatedFetch(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}`, { cache: "no-store" });
        if (cancelled) return;
        if (res.status === 404) {
          setStatus("missing");
          router.replace("/");
          return;
        }
        if (!res.ok) throw new Error(`请求失败（${res.status}）`);
        setStatus("ready");
      } catch {
        if (!cancelled) setStatus("missing");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, router]);

  if (!workspaceId || status === "missing") {
    return (
      <div className="flex h-dvh items-center justify-center text-sm text-neutral-500">
        未找到工作区。 <Link href="/" className="ml-1 text-blue-600 underline">返回工作区列表</Link>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Title bar */}
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-neutral-300 bg-white px-3">
        <Link
          href="/"
          className="flex items-center gap-1 rounded px-1.5 py-1 text-[13px] font-medium text-neutral-600 hover:bg-neutral-100"
          title="返回工作区列表"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
            <path d="M7.5 2.5L4 6L7.5 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          返回
        </Link>
        <div className="mx-1 h-4 w-px bg-neutral-300" />
        <div className="flex h-5 w-5 items-center justify-center rounded bg-blue-600 text-[10px] font-bold text-white">
          随
        </div>
        <span className="text-[13px] font-medium text-neutral-800">随心一码</span>
        <span className="hidden text-[13px] text-neutral-400 md:inline">— 在线开发环境</span>
        <span className="ml-auto hidden max-w-[12rem] truncate font-mono text-[13px] text-neutral-400 md:inline" title={workspaceId}>
          {workspaceId}
        </span>
        <UserMenu name={userName} />
      </header>

      {status === "loading" ? (
        <div className="flex flex-1 items-center justify-center text-sm text-neutral-400">
          <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-neutral-300 border-t-blue-600" />
          正在加载工作区…
        </div>
      ) : (
        /* Fixed layout: 1/3 chat (left), 2/3 preview (right); stacked on mobile */
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <section
            className="min-h-[40dvh] lg:min-h-0"
            style={isDesktop ? { width: "33.33%" } : undefined}
          >
            <AgentPanel workspaceId={workspaceId} />
          </section>

          {/* Visual divider — fixed, not draggable */}
          <div
            role="separator"
            aria-orientation="vertical"
            className="hidden w-1 shrink-0 bg-neutral-300 lg:block"
          />

          <section className="min-h-0 flex-1 border-t border-neutral-300 lg:border-t-0">
            <WebContainerPreview workspaceId={workspaceId} />
          </section>
        </div>
      )}
    </div>
  );
}

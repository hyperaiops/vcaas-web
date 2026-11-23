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

export default function WorkspaceEditor({ userName, canLogout = true }: { userName: string; canLogout?: boolean }) {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const workspaceId = params?.id ?? null;

  const [isDesktop, setIsDesktop] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "missing">("loading");
  const [maxFileBytes, setMaxFileBytes] = useState<number | null>(null);

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
        const manifest = await res.json();
        if (cancelled) return;
        const limit = manifest?.limits?.maxFileBytes;
        setMaxFileBytes(Number.isSafeInteger(limit) && limit > 0 ? limit : null);
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
      <div className="flex h-dvh items-center justify-center bg-[var(--brand-paper)] text-sm text-[var(--brand-muted)]">
        未找到工作区。 <Link href="/" className="ml-1 text-[var(--brand-purple)] underline">返回工作区列表</Link>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-[var(--brand-paper)] text-[var(--brand-ink)]">
      {/* Title bar */}
      <header className="flex min-h-16 shrink-0 items-center gap-2 border-b border-[var(--brand-line)] px-3 sm:gap-3 sm:px-5">
        <Link
          href="/"
          className="flex min-h-9 items-center gap-1 rounded-md border border-transparent px-2 text-[13px] font-medium text-[var(--brand-muted)] hover:border-[#d4d8ca] hover:bg-[#eceee3]"
          title="返回工作区列表"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
            <path d="M7.5 2.5L4 6L7.5 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          返回
        </Link>
        <div className="h-6 w-px bg-[var(--brand-line)]" />
        <span className="brand-mark" aria-hidden="true">{'</>'}</span>
        <span className="whitespace-nowrap text-base font-extrabold tracking-tight sm:text-lg">随心一码<span className="text-[var(--brand-purple)]">.</span></span>
        <span className="hidden text-[13px] text-[var(--brand-muted)] md:inline">创作空间</span>
        <span className="hidden text-[13px] text-[var(--brand-muted)] md:inline" title={workspaceId}>
          {workspaceId}
        </span>
        <UserMenu name={userName} canLogout={canLogout} />
      </header>

      {status === "loading" ? (
        <div className="flex flex-1 items-center justify-center text-sm text-neutral-400">
          <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-[#d9dccf] border-t-[var(--brand-purple)] motion-reduce:animate-none" />
          正在加载工作区…
        </div>
      ) : (
        /* Desktop: 1/3 chat and 2/3 preview; mobile: equal stacked panels. */
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <section
            className="min-h-0 min-w-0 flex-1 overflow-hidden lg:flex-none"
            style={isDesktop ? { width: "33.33%" } : undefined}
          >
            <AgentPanel workspaceId={workspaceId} maxFileBytes={maxFileBytes} />
          </section>

          {/* Visual divider — fixed, not draggable */}
          <div
            role="separator"
            aria-orientation="vertical"
            className="hidden w-1 shrink-0 bg-[#e1e7d4] lg:block"
          />

          <section className="min-h-0 min-w-0 flex-1 border-t border-[var(--brand-line)] lg:border-t-0">
            <WebContainerPreview workspaceId={workspaceId} />
          </section>
        </div>
      )}
    </div>
  );
}

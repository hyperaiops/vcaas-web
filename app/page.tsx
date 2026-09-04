"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import AgentPanel from "./components/AgentPanel";

// WebContainer only runs in the browser — never SSR it.
const WebContainerPreview = dynamic(
  () => import("./components/WebContainerPreview"),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-sm text-neutral-500">
        Loading WebContainer…
      </div>
    ),
  },
);

export default function Home() {
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    const check = () => setIsDesktop(window.innerWidth >= 1024);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Title bar */}
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-neutral-300 bg-white px-3">
        <div className="flex h-5 w-5 items-center justify-center rounded bg-blue-600 text-[10px] font-bold text-white">
          PI
        </div>
        <span className="text-[13px] font-medium text-neutral-800">
          PI Agent
        </span>
        <span className="text-[13px] text-neutral-400">— Web IDE</span>
      </header>

      {/* Fixed layout: 1/3 chat (left), 2/3 preview (right); stacked on mobile */}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <section
          className="min-h-[40dvh] lg:min-h-0"
          style={isDesktop ? { width: "33.33%" } : undefined}
        >
          <AgentPanel />
        </section>

        {/* Visual divider — fixed, not draggable */}
        <div
          role="separator"
          aria-orientation="vertical"
          className="hidden w-1 shrink-0 bg-neutral-300 lg:block"
        />

        <section className="min-h-0 flex-1 border-t border-neutral-300 lg:border-t-0">
          <WebContainerPreview />
        </section>
      </div>
    </div>
  );
}

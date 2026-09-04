"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

const MIN_PANEL_PX = 280;

export default function Home() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [leftWidth, setLeftWidth] = useState(33.33); // percentage — default 1/3 left, 2/3 right
  const [dragging, setDragging] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    const check = () => setIsDesktop(window.innerWidth >= 1024);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  useEffect(() => {
    if (!dragging) return;

    const onMouseMove = (e: MouseEvent) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const percent = (x / rect.width) * 100;
      const minPercent = (MIN_PANEL_PX / rect.width) * 100;
      const maxPercent = 100 - minPercent;
      setLeftWidth(Math.min(maxPercent, Math.max(minPercent, percent)));
    };

    const onMouseUp = () => setDragging(false);

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, [dragging]);

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

      {/* Desktop: resizable split; Mobile: stacked */}
      <div
        ref={containerRef}
        className={`flex min-h-0 flex-1 flex-col lg:flex-row ${dragging ? "select-none" : ""}`}
      >
        <section
          className="min-h-[40dvh] lg:min-h-0"
          style={isDesktop ? { width: `${leftWidth}%` } : undefined}
        >
          <AgentPanel />
        </section>

        {/* Drag handle — desktop only */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panels"
          onMouseDown={onMouseDown}
          className={`hidden w-1 shrink-0 cursor-col-resize bg-neutral-300 transition-colors hover:bg-blue-500 lg:block ${dragging ? "bg-blue-600" : ""}`}
        />

        <section className="min-h-0 flex-1 border-t border-neutral-300 lg:border-t-0">
          <WebContainerPreview />
        </section>
      </div>
    </div>
  );
}

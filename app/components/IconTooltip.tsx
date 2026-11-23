import type { ReactNode } from "react";

export default function IconTooltip({ label, children, align = "right", placement = "bottom", className = "" }: {
  label: string;
  children: ReactNode;
  align?: "left" | "right";
  placement?: "top" | "bottom";
  className?: string;
}) {
  return (
    <span className={`group relative inline-flex shrink-0 ${className}`}>
      {children}
      <span role="tooltip" aria-hidden="true" className={`pointer-events-none invisible absolute z-50 w-max max-w-48 rounded-md border border-[var(--brand-line)] bg-[var(--brand-ink)] px-2 py-1 text-xs font-normal text-white shadow-md group-hover:visible group-focus-within:visible ${placement === "top" ? "bottom-full mb-1" : "top-full mt-1"} ${align === "left" ? "left-0" : "right-0"}`}>
        {label}
      </span>
    </span>
  );
}

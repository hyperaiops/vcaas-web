"use client";

import Link from "next/link";
import { useMessages } from "@/app/lib/i18n/context";

export default function NotFound() {
  const m = useMessages();
  return (
    <main className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto bg-[var(--brand-paper)] px-6 py-12">
      <div className="max-w-md text-center">
        <span className="brand-mark mx-auto" aria-hidden="true">{'</>'}</span>
        <p className="mt-5 font-mono text-sm text-[var(--brand-purple)]">{m.notFound.code}</p>
        <h1 className="mt-3 text-3xl font-extrabold text-[var(--brand-ink)]">{m.notFound.title}<span className="text-[var(--brand-purple)]">.</span></h1>
        <p className="mt-4 text-base leading-relaxed text-[var(--brand-muted)]">{m.notFound.body}</p>
        <Link href="/" className="brand-button mt-7 px-5 py-3 text-base">{m.common.backToHome} <span aria-hidden="true">↗</span></Link>
      </div>
    </main>
  );
}

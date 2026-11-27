"use client";

import Link from "next/link";
import { useMessages } from "@/app/lib/i18n/context";

export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const m = useMessages();
  return (
    <main className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto bg-[var(--brand-paper)] px-6 py-12">
      <div className="max-w-md text-center" role="alert">
        <span className="brand-mark mx-auto" aria-hidden="true">{'</>'}</span>
        <h1 className="mt-5 text-3xl font-extrabold text-[var(--brand-ink)]">{m.errorPage.title}<span className="text-[var(--brand-purple)]">.</span></h1>
        <p className="mt-4 text-base leading-relaxed text-[var(--brand-muted)]">{m.errorPage.body}</p>
        {error.digest && <p className="mt-3 break-all text-sm text-neutral-500">{m.errorPage.digestLabel}{error.digest}</p>}
        <div className="mt-7 flex items-center justify-center gap-4">
          <button type="button" onClick={retry} className="brand-button px-5 py-3 text-base">{m.errorPage.reload}</button>
          <Link href="/" className="rounded-md border border-[#b6b8ac] px-5 py-3 text-base text-[var(--brand-ink)] hover:bg-[#eceee3]">{m.common.backToHome}</Link>
        </div>
      </div>
    </main>
  );
}

"use client";

import Link from "next/link";

export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <main className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto bg-[var(--brand-paper)] px-6 py-12">
      <div className="max-w-md text-center" role="alert">
        <span className="brand-mark mx-auto" aria-hidden="true">{'</>'}</span>
        <h1 className="mt-5 text-3xl font-extrabold text-[var(--brand-ink)]">页面暂时遇到了一点问题<span className="text-[var(--brand-purple)]">.</span></h1>
        <p className="mt-4 text-base leading-relaxed text-[var(--brand-muted)]">别担心，请稍后重试。如果问题持续出现，可以将错误编号提供给管理员。</p>
        {error.digest && <p className="mt-3 break-all text-sm text-neutral-500">错误编号：{error.digest}</p>}
        <div className="mt-7 flex items-center justify-center gap-4">
          <button type="button" onClick={retry} className="brand-button px-5 py-3 text-base">重新加载</button>
          <Link href="/" className="rounded-md border border-[#b6b8ac] px-5 py-3 text-base text-[var(--brand-ink)] hover:bg-[#eceee3]">返回首页</Link>
        </div>
      </div>
    </main>
  );
}

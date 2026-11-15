import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto bg-[var(--brand-paper)] px-6 py-12">
      <div className="max-w-md text-center">
        <span className="brand-mark mx-auto" aria-hidden="true">{'</>'}</span>
        <p className="mt-5 font-mono text-sm text-[var(--brand-purple)]">404 / 页面未找到</p>
        <h1 className="mt-3 text-3xl font-extrabold text-[var(--brand-ink)]">这个页面走丢了<span className="text-[var(--brand-purple)]">.</span></h1>
        <p className="mt-4 text-base leading-relaxed text-[var(--brand-muted)]">页面可能已被移动、删除，或当前账号无法访问。回到首页，继续实现你的创意吧。</p>
        <Link href="/" className="brand-button mt-7 px-5 py-3 text-base">返回首页 <span aria-hidden="true">↗</span></Link>
      </div>
    </main>
  );
}

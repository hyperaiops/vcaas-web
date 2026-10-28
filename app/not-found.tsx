import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto bg-neutral-50 px-6 py-12">
      <div className="max-w-md text-center">
        <p className="font-mono text-sm text-neutral-500">404</p>
        <h1 className="mt-3 text-2xl font-semibold text-neutral-800">这个页面走丢了</h1>
        <p className="mt-4 text-base leading-relaxed text-neutral-600">页面可能已被移动、删除，或当前账号无法访问。回到首页，继续实现你的创意吧。</p>
        <Link href="/" className="mt-7 inline-block rounded-lg bg-neutral-900 px-5 py-3 text-base font-medium text-white hover:bg-neutral-700">返回首页</Link>
      </div>
    </main>
  );
}

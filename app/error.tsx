"use client";

import Link from "next/link";

export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <main className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto bg-neutral-50 px-6 py-12">
      <div className="max-w-md text-center" role="alert">
        <h1 className="text-2xl font-semibold text-neutral-800">页面暂时遇到了一点问题</h1>
        <p className="mt-4 text-base leading-relaxed text-neutral-600">别担心，请稍后重试。如果问题持续出现，可以将错误编号提供给管理员。</p>
        {error.digest && <p className="mt-3 break-all text-sm text-neutral-500">错误编号：{error.digest}</p>}
        <div className="mt-7 flex items-center justify-center gap-4">
          <button type="button" onClick={retry} className="rounded-lg bg-neutral-900 px-5 py-3 text-base font-medium text-white hover:bg-neutral-700">重新加载</button>
          <Link href="/" className="rounded-lg border border-neutral-300 px-5 py-3 text-base text-neutral-700 hover:bg-neutral-100">返回首页</Link>
        </div>
      </div>
    </main>
  );
}

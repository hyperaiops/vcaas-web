import type { Metadata } from "next";
import "./globals.css";
import { LocaleDetector } from "@/app/lib/i18n/detector";

export const metadata: Metadata = {
  title: "随心一码 — 免费编程，让想法发生",
  description: "今天你 vibe 了吗？和 AI 一起编程，把脑海里的想法变成自己的作品。随心一码，让每个想法都有一个开始。",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" className="h-full antialiased" suppressHydrationWarning>
      <body className="flex h-dvh flex-col overflow-hidden" suppressHydrationWarning>
        <LocaleDetector />
        {children}
      </body>
    </html>
  );
}

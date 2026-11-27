"use client";

import LanguageSwitcher from "./LanguageSwitcher";
import { useMessages } from "@/app/lib/i18n/context";

export default function UserMenu({ name, canLogout = true }: { name: string; canLogout?: boolean }) {
  const m = useMessages();
  return (
    <div className="ml-auto flex min-w-0 items-center gap-2 text-[13px] text-[var(--brand-muted)] sm:gap-3">
      <span className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#ede9fb] font-bold text-[#6254aa] sm:flex" aria-hidden="true">✳</span>
      <span className="min-w-0 max-w-24 truncate font-medium sm:max-w-40">{name}</span>
      <LanguageSwitcher />
      {canLogout && (
        <form action="/auth/logout" method="post" className="shrink-0 whitespace-nowrap">
          <button className="rounded-md border border-[#d4d8ca] px-2.5 py-1.5 hover:bg-[#eceee3]" type="submit">{m.userMenu.logout}</button>
        </form>
      )}
    </div>
  );
}

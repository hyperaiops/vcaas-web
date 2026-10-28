export default function UserMenu({ name }: { name: string }) {
  return (
    <div className="ml-auto flex min-w-0 items-center gap-3 text-[13px] text-neutral-600">
      <span className="min-w-0 max-w-40 truncate">{name}</span>
      <form action="/auth/logout" method="post" className="shrink-0 whitespace-nowrap">
        <button className="rounded px-2 py-1 hover:bg-neutral-100" type="submit">退出登录</button>
      </form>
    </div>
  );
}

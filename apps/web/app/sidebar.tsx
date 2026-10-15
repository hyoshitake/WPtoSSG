'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const menus = [
  { href: '/', label: '変換器', path: 'M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4' },
  { href: '/list', label: '一覧', path: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01' },
  { href: '/edit', label: '編集', path: 'm16 3 5 5M4 20l4-1L21 6a2.12 2.12 0 0 0-3-3L5 16l-1 4Z' },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="fixed inset-y-0 left-0 z-40 w-20 border-r border-slate-800 bg-slate-950">
      <nav aria-label="メインメニュー" className="flex flex-col items-center gap-4 py-8">
        {menus.map(({ href, label, path }) => {
          const selected = href === '/' ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);

          return (
            <Link
              key={href}
              href={href}
              aria-label={label}
              aria-current={selected ? 'page' : undefined}
              className={`sidebar-link relative flex h-12 w-12 items-center justify-center rounded-xl transition-colors focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-300 ${
                selected
                  ? 'bg-cyan-400'
                  : 'hover:bg-slate-800'
              }`}
            >
              <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d={path} />
              </svg>
              <span aria-hidden="true" className="sidebar-tooltip pointer-events-none absolute left-full ml-3 whitespace-nowrap rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-50 shadow-lg">
                {label}
              </span>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}

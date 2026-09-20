import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'WPtoSSG Job Console',
  description: 'WPtoSSG のジョブ作成、進捗監視、診断結果確認用コンソール',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja" className="h-full antialiased">
      <body className="min-h-full bg-slate-950 text-slate-50">{children}</body>
    </html>
  );
}

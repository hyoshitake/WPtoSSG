import Link from 'next/link';
import { SiteBrowser } from '../site-browser';
export default async function SitePage({ params }: { params: Promise<{ siteKey: string }> }) {
  const { siteKey } = await params;
  return <main className="mx-auto max-w-7xl px-8 py-10"><Link className="text-cyan-300 underline" href="/sites">一覧に戻る</Link><h1 className="my-6 text-3xl font-semibold">サイト詳細</h1><SiteBrowser key={siteKey} siteKey={siteKey} /></main>;
}

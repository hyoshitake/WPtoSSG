import Link from 'next/link';
export default async function EditPage({ searchParams }: { searchParams: Promise<{ siteKey?: string }> }) {
  const { siteKey } = await searchParams;
  return (
    <main className="mx-auto max-w-7xl px-8 py-10">
      <h1 className="text-3xl font-semibold">編集</h1>
      {siteKey && <p className="mt-4">対象サイト: {siteKey} · <Link className="text-cyan-300 underline" href={`/sites/${encodeURIComponent(siteKey)}`}>サイト詳細へ</Link></p>}
      <p className="mt-4 text-slate-300">AI編集は未実装のため、現在は利用できません。</p>
      <button disabled className="mt-4 rounded bg-slate-800 px-4 py-2 text-slate-500">編集を開始（準備中）</button>
    </main>
  );
}

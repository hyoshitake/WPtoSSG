'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { SavedSite, SiteDetail, SiteVersion } from '@wptossg/shared';

const date = (value: string) => new Date(value).toLocaleString('ja-JP');
function Result({ version }: { version: SiteVersion }) {
  return <span>成功 {version.report.successCount} / 失敗 {version.report.failedCount} / 警告 {version.report.warnings} · risk: {version.diagnostic?.riskLevel ?? '未診断'}</span>;
}
function Artifact({ version }: { version: SiteVersion }) {
  const location = version.artifactLocation;
  if (!location) return <p className="text-amber-300">成果物を利用できません（保存場所不明）。</p>;
  if (version.artifactBackend === 'google-drive' && location.startsWith('https://drive.google.com/drive/folders/')) {
    return <a className="text-cyan-300 underline" href={location} target="_blank" rel="noreferrer">Drive で成果物を開く</a>;
  }
  return <p>ローカル成果物: <code className="break-all">{location}</code><span className="block text-sm text-slate-400">Worker の保存先から取得してください。ブラウザからのダウンロードは利用できません。</span></p>;
}
export function SiteBrowser({ siteKey }: { siteKey?: string }) {
  const [data, setData] = useState<SavedSite[] | SiteDetail>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch(siteKey ? `/api/sites/${encodeURIComponent(siteKey)}` : '/api/sites', { signal: controller.signal, cache: 'no-store' })
      .then(async response => { const body = await response.json(); if (!response.ok) throw new Error(body.error); return body; })
      .then(body => setData(siteKey ? body : body.sites))
      .catch(e => { if (!controller.signal.aborted) setError(e.message || '取得に失敗しました。'); });
    return () => controller.abort();
  }, [siteKey, attempt]);
  if (error) return <div role="alert"><p>{error}</p><button className="mt-4 rounded bg-slate-700 px-4 py-2" onClick={() => { setError(''); setData(undefined); setAttempt(v => v + 1); }}>再試行</button></div>;
  if (!data) return <p role="status">読み込み中…</p>;
  if (Array.isArray(data)) return data.length === 0 ? <p>保存済みのサイトはありません。<Link className="text-cyan-300 underline" href="/">変換器でサイトを生成</Link>してください。</p> : (
    <table className="w-full text-left"><caption className="pb-4 text-left text-slate-400">最終保存日時の新しい順 · 保存に成功した最新版を表示</caption>
      <thead><tr className="border-b border-slate-700">{['サイト名 / 元URL', '最終保存日時', '処理結果 / 診断', '操作'].map(t => <th key={t} className="p-4">{t}</th>)}</tr></thead>
      <tbody>{data.map(site => <tr key={site.siteKey} className="border-b border-slate-800">
        <td className="p-4"><Link className="text-cyan-300 underline" href={`/sites/${encodeURIComponent(site.siteKey)}`}>{site.name}</Link><p className="mt-1 break-all text-sm text-slate-400">{site.siteUrl}</p></td>
        <td className="p-4 whitespace-nowrap">{date(site.latest.savedAt)}</td><td className="p-4"><Result version={site.latest} /></td>
        <td className="p-4"><Link className="text-cyan-300 underline" href={`/edit?siteKey=${encodeURIComponent(site.siteKey)}`}>編集（準備中）</Link></td>
      </tr>)}</tbody>
    </table>
  );
  return <div className="space-y-8">
    <div><h2 className="text-2xl font-semibold">{data.name}</h2><p className="mt-2">元URL: <a className="text-cyan-300 underline" href={data.siteUrl} target="_blank" rel="noreferrer">{data.siteUrl}</a></p>
      <p className="my-2">最終保存: {date(data.latest.savedAt)} · <Result version={data.latest} /></p><Artifact version={data.latest} />
      <Link className="mt-4 inline-block text-cyan-300 underline" href={`/edit?siteKey=${encodeURIComponent(data.siteKey)}`}>このサイトを編集（AI編集は準備中）</Link>
    </div>
    <h2 className="text-xl font-semibold">保存履歴</h2>
    {data.versions.map(version => <article key={version.id} className="space-y-3 rounded-xl border border-slate-700 p-5">
      <h3 className="font-semibold">{date(version.savedAt)} · {version.source === 'ai-edit' ? 'AI編集' : '変換'}</h3>
      <p>版: {version.id} / ジョブ: {version.jobId}</p><p><Result version={version} /></p><Artifact version={version} />
      <h4 className="font-semibold">診断理由・根拠</h4>
      {version.diagnostic ? <><p>risk_level: {version.diagnostic.riskLevel}</p><ul className="list-disc pl-6">{version.diagnostic.reasons.map((reason, i) => <li key={i}>{reason}</li>)}</ul>
        {version.diagnostic.evidence.length ? <ul className="space-y-2">{version.diagnostic.evidence.map((e, i) => <li key={i} className="break-all"><code>{e.type}: {e.location}</code>{e.details && <pre className="whitespace-pre-wrap text-sm text-slate-400">{JSON.stringify(e.details, null, 2)}</pre>}</li>)}</ul> : <p>診断シグナルは検出されませんでした。</p>}</> : <p>診断結果はありません。</p>}
    </article>)}
  </div>;
}

'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { JOB_EVENT_TYPES, type EditDraft, type SavedSite, type JobEvent } from '@wptossg/shared';

const button='rounded bg-cyan-700 px-4 py-2 font-medium disabled:opacity-40';
async function jsonRequest(url: string, init?: RequestInit) {
  const response=await fetch(url,{cache:'no-store',...init});
  const body=await response.json();
  if(!response.ok) throw new Error(body.error ?? '操作に失敗しました。');
  return body;
}
export function EditDashboard({initialSiteKey}:{initialSiteKey?:string}) {
  const [sites,setSites]=useState<SavedSite[]>([]);
  const [siteKey,setSiteKey]=useState(initialSiteKey ?? '');
  const [instruction,setInstruction]=useState('');
  const [draft,setDraft]=useState<EditDraft>();
  const [events,setEvents]=useState<JobEvent[]>([]);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [reviewed,setReviewed]=useState(false);
  const [previewReady,setPreviewReady]=useState(false);
  const [loadAttempt,setLoadAttempt]=useState(0);
  const cursor=useRef('');
  const activeSite=sites.find(s=>s.siteKey===siteKey);
  const processing=!!draft && ['queued','generating','saving'].includes(draft.status);
  useEffect(()=> {
    const controller=new AbortController();
    jsonRequest('/api/sites',{signal:controller.signal}).then(body=>setSites(body.sites)).catch(e=>{if(!controller.signal.aborted)setError(e.message);});
    return ()=>controller.abort();
  },[loadAttempt]);
  // Keep the draft addressable after refresh; immutable IDs are scoped to the selected site.
  useEffect(()=> {
    const stored=sessionStorage.getItem(`edit:${siteKey}`);
    if(!stored)return;
    let cancelled=false;
    jsonRequest(`/api/edits/${encodeURIComponent(stored)}`).then(body=>{if(!cancelled){setDraft(body.edit);setEvents(body.events ?? []);}}).catch(()=>{});
    return ()=>{cancelled=true;};
  },[siteKey]);
  useEffect(()=> {
    if(!draft || !processing)return;
    let cancelled=false;
    const refresh=()=>jsonRequest(`/api/edits/${draft.id}`).then(body=>{
      if(!cancelled) {setDraft(body.edit);setEvents(body.events ?? []); if(body.edit.status==='saved')setLoadAttempt(n=>n+1);}
    }).catch(e=>{if(!cancelled)setError(e.message);});
    const timer=setInterval(()=>void refresh(),2000);
    const source=new EventSource(`/api/jobs/${draft.id}/events${cursor.current?`?lastEventId=${encodeURIComponent(cursor.current)}`:''}`);
    for(const type of JOB_EVENT_TYPES)source.addEventListener(type,event=> {
      const message=event as MessageEvent<string>;
      cursor.current=message.lastEventId;
      try { const item=JSON.parse(message.data) as JobEvent; setEvents(previous=>[...previous.slice(-49),item]); } catch {}
      void refresh();
      // The stream can replay generation completion when a save starts.
      // The server closes on the terminal event for the current operation.
    });
    return ()=>{cancelled=true;clearInterval(timer);source.close();};
  },[draft?.id,processing]); // eslint-disable-line react-hooks/exhaustive-deps
  const run=async (action:'generate'|'save'|'discard'|'reload')=> {
    setBusy(true);setError('');
    try {
      if(action==='reload') {
        setDraft(undefined);setEvents([]);setReviewed(false);setPreviewReady(false);cursor.current='';
        sessionStorage.removeItem(`edit:${siteKey}`);setLoadAttempt(n=>n+1);return;
      }
      const body=action==='generate'?await jsonRequest('/api/edits',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({siteKey,instruction,parentDraftId:draft?.status==='ready'?draft.id:draft?.status==='failed'?draft.parentDraftId:undefined})}):
        await jsonRequest(`/api/edits/${draft!.id}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})});
      setDraft(body.edit);
      sessionStorage.setItem(`edit:${siteKey}`,body.edit.id);
      if(action==='generate') {cursor.current='';setEvents([]);setReviewed(false);setPreviewReady(false);}
      if(action==='save')setLoadAttempt(n=>n+1);
    } catch(e) {setError(e instanceof Error?e.message:'操作に失敗しました。');}
    finally {setBusy(false);}
  };
  const previewUrl=draft?.previewUrl && typeof window!=='undefined' && new URL(draft.previewUrl).origin!==window.location.origin?draft.previewUrl:undefined;
  return <div className="mt-6 min-w-[960px] space-y-6">
    <p className="text-slate-300">修正案をプレビューしてから保存します。保存すると旧版は履歴に残ります。</p>
    <div className="flex items-center gap-4"><label htmlFor="edit-site">編集するサイト</label>
      <select id="edit-site" className="min-w-72 rounded border border-slate-600 bg-slate-900 p-2" value={siteKey} disabled={busy||processing} onChange={e=>{setSiteKey(e.target.value);setDraft(undefined);setEvents([]);setReviewed(false);setPreviewReady(false);cursor.current='';}}>
        <option value="">サイトを選択</option>{sites.map(s=><option key={s.siteKey} value={s.siteKey}>{s.name}</option>)}
      </select>{siteKey&&<Link className="text-cyan-300 underline" href={`/list/${encodeURIComponent(siteKey)}`}>一覧・保存履歴</Link>}
      <button className={button} disabled={busy||processing} onClick={()=>void run('reload')}>currentを再読み込み</button>
    </div>
    {activeSite&&<p className="text-sm text-slate-400">元URL: {activeSite.siteUrl} · 最新版: {activeSite.latest.id}</p>}
    <label className="block" htmlFor="edit-instruction">AIへの修正指示</label>
    <textarea id="edit-instruction" className="block min-h-28 w-full rounded border border-slate-600 bg-slate-900 p-3" maxLength={4000} value={instruction} disabled={busy||processing} onChange={e=>setInstruction(e.target.value)} placeholder="例: トップページの見出しを「地域とともに歩む」に変更し、背景色を淡い青にしてください。" />
    <button className={button} disabled={busy||processing||!activeSite||!instruction.trim()||draft?.status==='saving'} onClick={()=>void run('generate')}>{draft?.status==='ready'?'この案への追加指示で再生成':'修正案を生成'}</button>
    {error&&<div role="alert" className="rounded border border-red-700 p-4"><p>{error}</p><button className="mt-2 underline" onClick={()=>setLoadAttempt(n=>n+1)}>サイト一覧の再取得</button></div>}
    {draft&&<section className="space-y-4 rounded-xl border border-slate-700 p-5" aria-label="修正案">
      <p role="status">状態: {draft.status} · {draft.stage}</p><p className="text-sm text-slate-400">基準版: {draft.baseVersionId}</p>
      {draft.error&&<p role="alert" className="text-red-300">{draft.error}</p>}
      {draft.summary&&<p className="whitespace-pre-wrap">{draft.summary}</p>}
      {draft.usage&&<p className="text-sm text-slate-400">使用モデル: {draft.usage.model} · 入力 {draft.usage.inputTokens.toLocaleString()} / 出力 {draft.usage.outputTokens.toLocaleString()} tokens · {draft.usage.inputMode==='inline'?'ソース直接送信':'必要なファイルのみ取得'}</p>}
      {draft.changes&&<div><h2 className="font-semibold">基準版からの変更ファイル</h2><ul className="mt-2 list-disc pl-6">{draft.changes.map(c=><li key={c.path}>{c.action}: <code>{c.path}</code></li>)}</ul></div>}
      {draft.previewUrl&&draft.status!=='discarded'&&<div>
        <h2 className="mb-3 font-semibold">プレビュー</h2>
        {previewUrl?<iframe key={previewUrl} title="編集したサイトのプレビュー" src={previewUrl} sandbox="allow-scripts" referrerPolicy="no-referrer" className="h-[650px] w-full rounded border border-slate-600 bg-white" onLoad={()=>setPreviewReady(true)} />:<p role="alert">管理画面と異なるオリジンのプレビュー配信を設定してください。</p>}
      </div>}
      {draft.diagnostic&&<details><summary>診断: risk_level {draft.diagnostic.riskLevel} · 理由と根拠</summary><ul className="list-disc pl-6">{draft.diagnostic.reasons.map((r,i)=><li key={i}>{r}</li>)}</ul><pre className="overflow-auto whitespace-pre-wrap text-sm">{JSON.stringify(draft.diagnostic.evidence,null,2)}</pre></details>}
      {draft.status==='ready'&&<label className="flex items-center gap-2"><input type="checkbox" checked={reviewed} disabled={!previewReady} onChange={e=>setReviewed(e.target.checked)} />変更概要・変更ファイル・プレビューを確認しました</label>}
      <div className="flex gap-3">
        {(draft.status==='ready'||draft.status==='failed'&&draft.previewUrl)&&<button className={button} disabled={busy||!previewReady||draft.status==='ready'&&!reviewed} onClick={()=>void run('save')}>{draft.status==='failed'?'保存を再試行':'確認した案を保存'}</button>}
        {draft.status==='saving'&&<button className={button} disabled={busy} onClick={()=>void run('save')}>保存状態を再確認・再試行</button>}
        {['ready','failed','queued'].includes(draft.status)&&<button className="rounded border border-slate-500 px-4 py-2 disabled:opacity-40" disabled={busy||processing} onClick={()=>void run('discard')}>この案を破棄</button>}
      </div>
      {draft.status==='saved'&&<p className="text-emerald-300">保存しました。<Link className="underline" href={`/list/${encodeURIComponent(siteKey)}`}>最新版と履歴を確認</Link></p>}
    </section>}
    {events.length>0&&<details open={processing}><summary>進捗・警告</summary><ol className="mt-3 space-y-1 text-sm text-slate-400">{events.map((e,i)=><li key={`${e.id}-${i}`}>{e.stage}: {e.message}</li>)}</ol></details>}
  </div>;
}

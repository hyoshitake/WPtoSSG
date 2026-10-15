import path from 'node:path';
import { load } from 'cheerio';
import { chromium } from 'playwright';
import { createEmptySiteGraph, createGraphNode, createGraphEdge, pageUrlToRelativePath, type EditFile, type SiteGraph, type DiagnosticResult } from '@wptossg/shared';
import { runDiagnostic } from './diagnostic.js';
import { mimeFor, safeFile } from './editArtifacts.js';

export function routeMap(files: EditFile[]): Record<string,string> {
  const manifest = files.find(f=>f.relativePath === 'public-routes.json');
  if (!manifest) return {};
  const routes: unknown = JSON.parse(Buffer.from(manifest.content,'base64').toString('utf8'));
  if (!routes || typeof routes !== 'object' || Array.isArray(routes)) throw new Error('配信マニフェストが不正です。');
  return Object.fromEntries(Object.entries(routes).filter(([,v])=>typeof v === 'string'));
}
export function resolveEditFile(files: EditFile[], siteUrl: string, rawPath: string): EditFile | undefined {
  const domain = new URL(siteUrl).hostname;
  const name = rawPath.replace(/^\/+/, '');
  const routes = routeMap(files);
  const mapped = Object.entries(routes).find(([k,v])=>v.replace(/^\//,'') === name && /\.html?$/.test(k))?.[0];
  const asset = routes[name]?.replace(/^\//,'');
  const candidates = [mapped, asset, name, pageUrlToRelativePath(new URL(`/${name}`,siteUrl).href), `${domain}/${name}index.html`];
  if (!name) candidates.unshift('index.html');
  return candidates.map(p=>files.find(f=>f.relativePath===p)).find(Boolean);
}
export function analyzeEdit(files: EditFile[], siteUrl: string, jobId: string): {files: EditFile[];graph: SiteGraph;diagnostic: DiagnosticResult;pages: {url:string;status:'success';snapshotPath:string}[];warnings:string[]} {
  const host = new URL(siteUrl).hostname;
  const originals = new Map(files.map(f=>[safeFile(f.relativePath),f]));
  if (!originals.has('index.html')) throw new Error('入口のindex.htmlは削除できません。');
  const routes = routeMap(files);
  const graph = createEmptySiteGraph(siteUrl);
  const pages: {url:string;status:'success';snapshotPath:string}[] = [];
  const diagnosticPages: {url:string;html:string}[] = [];
  const warnings: string[] = [];
  const node = (url: string,kind: 'page'|'asset'|'external') => {
    const value = {...createGraphNode(url,kind),status:'success' as const};
    const current = graph.nodes.find(n=>n.id===value.id);
    if (current) return current;
    graph.nodes.push(value); return value;
  };
  // New pages get stable public paths using the same host/path.html layout.
  for (const file of files.filter(f=>/\.html?$/i.test(f.relativePath))) {
    if (file.relativePath === 'index.html') continue;
    if (!file.relativePath.startsWith(`${host}/`)) throw new Error('HTMLは既存のホスト名配下に追加してください。');
    if (!routes[file.relativePath]) routes[file.relativePath] = `/${file.relativePath.slice(host.length+1).replace(/\.html?$/i,'').replace(/(^|\/)index$/,'$1')}`;
  }
  for (const key of Object.keys(routes)) if (/\.html?$/i.test(key) && !originals.has(key)) delete routes[key];
  const fileUrl = (name: string) => new URL(routes[name] ?? `/${name}`,siteUrl).href;
  const reference = (from: string, raw: string, type: 'links_to'|'loads_asset', sourcePath: string) => {
    if (!raw || raw.startsWith('#') || /^(data:|mailto:|tel:|javascript:|blob:)/i.test(raw)) return;
    let url: URL; try { url = new URL(raw,fileUrl(sourcePath)); } catch { throw new Error(`不正な参照: ${sourcePath}`); }
    if (!['http:','https:'].includes(url.protocol)) return;
    if (url.hostname !== host) { node(url.href,'external'); graph.edges.push(createGraphEdge(from,url.href,'references')); return; }
    const disk = !raw.startsWith('/') && !/^https?:/i.test(raw) ? path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath),raw.split(/[?#]/)[0]!)) : undefined;
    const target = disk && originals.get(disk) || resolveEditFile(files,siteUrl,url.pathname);
    // Existing missing references are warnings; added broken references fail in the pipeline comparison.
    if (!target) { warnings.push(`${sourcePath}: ${raw}`); return; }
    const targetUrl = /\.html?$/i.test(target.relativePath) ? fileUrl(target.relativePath) : new URL(`/${target.relativePath}`,siteUrl).href;
    node(targetUrl,type==='links_to'?'page':'asset'); graph.edges.push(createGraphEdge(from,targetUrl,type));
  };
  for (const file of files) {
    if (/\.html?$/i.test(file.relativePath)) {
      const html = Buffer.from(file.content,'base64').toString('utf8'); const url = file.relativePath==='index.html'?new URL('/',siteUrl).href:fileUrl(file.relativePath);
      node(url,'page');
      const $ = load(html);
      $('form').each((index,element)=> {
        const source=node(url,'page');
        const form=createGraphNode(url,'form',{selector:`form:nth-of-type(${index+1})`,action:$(element).attr('action') ?? ''});
        form.id=`${source.id}:form:${index}`; form.status='success';
        graph.nodes.push(form);
        graph.edges.push({id:`${source.id}:has_form:${form.id}`,from:source.id,to:form.id,type:'has_form'});
      });
      $('[href], [src], [poster], [action]').each((_,el) => {
        for (const attr of ['href','src','poster','action']) { const raw = $(el).attr(attr); if (raw && attr!=='action') reference(url,raw,el.tagName==='a'?'links_to':'loads_asset',file.relativePath); }
      });
      $('[srcset]').each((_,el)=> { const value=$(el).attr('srcset')!; if (!value.includes('data:')) for(const part of value.split(',')) reference(url,part.trim().split(/\s+/)[0]!,'loads_asset',file.relativePath); });
      $('meta[http-equiv="refresh"]').each((_,el)=> { const match=$(el).attr('content')?.match(/url=(.*)$/i); if(match) reference(url,match[1]!,'links_to',file.relativePath); });
      $('style, [style]').each((_,el)=> { const css=$(el).attr('style') ?? $(el).text(); for (const match of css.matchAll(/url\(\s*['"]?([^)'"\s]+)['"]?\s*\)/gi)) reference(url,match[1]!,'loads_asset',file.relativePath); });
      diagnosticPages.push({url,html}); pages.push({url,status:'success',snapshotPath:file.relativePath});
    } else if (/\.css$/i.test(file.relativePath)) {
      const url = new URL(`/${file.relativePath}`,siteUrl).href; node(url,'asset');
      const css=Buffer.from(file.content,'base64').toString('utf8');
      for(const match of css.matchAll(/url\(\s*['"]?([^)'"\s]+)['"]?\s*\)/gi)) reference(url,match[1]!,'loads_asset',file.relativePath);
      for(const match of css.matchAll(/@import\s+['"]([^'"]+)['"]/gi)) reference(url,match[1]!,'loads_asset',file.relativePath);
    }
  }
  if (pages.length < 2 || pages.length > 100) throw new Error('編集後のサイトは1〜99ページ（入口を除く）にしてください。');
  const diagnostic = runDiagnostic(jobId,{siteUrl,pages:diagnosticPages}).diagnostic;
  graph.edges=[...new Map(graph.edges.map(edge=>[edge.id,edge])).values()];
  const generated = new Map(files.map(f=>[f.relativePath,f]));
  for(const [relativePath,data] of [['graph.json',graph],['public-routes.json',routes]] as const) generated.set(relativePath,{relativePath,mimeType:'application/json',content:Buffer.from(JSON.stringify(data,null,2)).toString('base64')});
  return {files:[...generated.values()],graph,diagnostic,pages,warnings:[...new Set(warnings)]};
}
export function addDiagnosticToGraph(graph: SiteGraph, diagnostic: DiagnosticResult): void {
  for (const evidence of diagnostic.evidence.filter(e=>e.type==='api')) {
    const api={...createGraphNode(evidence.location,'api',{source:'edit-diagnostic'}),status:'success' as const};
    if(!graph.nodes.some(node=>node.id===api.id)) graph.nodes.push(api);
    const source=String(evidence.details?.['discoveredOn'] ?? graph.siteUrl);
    const page=graph.nodes.find(node=>node.id===createGraphNode(source).id);
    if(page && !graph.edges.some(edge=>edge.from===page.id && edge.to===api.id && edge.type==='calls_api')) graph.edges.push(createGraphEdge(source,evidence.location,'calls_api'));
  }
}
/** Render in worker, serving only this draft from memory; external requests never reach the network. */
export async function renderEdit(files: EditFile[], siteUrl: string, pagePaths: string[]): Promise<DiagnosticResult> {
  const browser = await chromium.launch({headless:true,args:['--no-sandbox']});
  const rendered: {url:string;html:string}[]=[];
  const api = new Set<string>();
  try {
    const context = await browser.newContext({serviceWorkers:'block'});
    await context.routeWebSocket('**/*',socket=>socket.close());
    await context.route('**/*',async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== new URL(siteUrl).hostname) { await route.abort(); return; }
      if (['fetch','xhr'].includes(route.request().resourceType())) api.add(url.origin+url.pathname);
      const file = files.find(f=>f.relativePath===url.pathname.slice(1)) ?? resolveEditFile(files,siteUrl,url.pathname);
      if (!file) { await route.fulfill({status:404,body:'Not found'}); return; }
      await route.fulfill({status:200,contentType:file.mimeType || mimeFor(file.relativePath),body:Buffer.from(file.content,'base64')});
    });
    const page = await context.newPage();
    for(const name of pagePaths.filter(name=>name!=='index.html')) {
      const url = new URL(`/${name}`,siteUrl).href;
      await page.goto(url,{waitUntil:'load',timeout:15000});
      rendered.push({url,html:await page.content()});
    }
    await context.close();
  } finally { await browser.close(); }
  const diagnostic=runDiagnostic('render-edit',{siteUrl,pages:rendered}).diagnostic;
  if(api.size) {
    diagnostic.evidence.push(...[...api].map(location=>({type:'api' as const,location,details:{source:'worker-render'}})));
    diagnostic.reasons.push(`${api.size} same-domain fetch/XHR endpoint(s) observed during edit rendering`);
    if(diagnostic.riskLevel==='low') diagnostic.riskLevel='medium';
  }
  return diagnostic;
}

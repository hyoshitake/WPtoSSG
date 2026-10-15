import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { applyProposal, generateEdit } from '../apps/worker/dist/openaiEdit.js';
import { analyzeEdit } from '../apps/worker/dist/editValidation.js';
import { safeFile, publishEditArtifacts, prepareEditPublication } from '../apps/worker/dist/editArtifacts.js';
import { readEditPreview } from '../apps/worker/dist/editPreview.js';
import { runEditJob } from '../apps/worker/dist/editPipeline.js';
import { rotateAndWriteLocal, writeFilesToLocalFolder } from '../apps/worker/dist/localOutput.js';
import { recordSavedSite, getSavedSite, pool } from '../packages/shared/dist/site-store.js';
import { insertEdit, getEdit, updateEdit, withSiteLock, listEditEvents } from '../packages/shared/dist/edit-store.js';

const file=(name,text)=>({relativePath:name,content:Buffer.from(text).toString('base64'),mimeType:name.endsWith('.css')?'text/css':name.endsWith('.json')?'application/json':'text/html'});
const proposal=(oldText,newText)=>({summary:'見出しを変更',patches:[{path:'edit.example/index.html',action:'replace',oldText,newText}]});
const files=[file('index.html','<meta http-equiv="refresh" content="0; url=edit.example/index.html">'),
  file('edit.example/index.html','<h1>Before</h1><link rel="stylesheet" href="../assets/main.css"><a href="https://external.example/x">External</a>'),
  file('assets/main.css','h1 { color: blue; }'),file('public-routes.json',JSON.stringify({'edit.example/index.html':'/'}))];
for(const name of ['../bad','/absolute','a/../b','a\\b','a%2fb','a//b'])assert.throws(()=>safeFile(name));
assert.throws(()=>applyProposal(files,proposal('missing','After')));
assert.throws(()=>applyProposal(files,{summary:'bad',patches:[{path:'evil.js',action:'add',oldText:'',newText:'alert(1)'}]}));
const result=applyProposal(files,proposal('Before','After'));
assert.match(Buffer.from(result.files[1].content,'base64').toString(),/After/);
const analyzed=analyzeEdit(result.files,'https://edit.example/',randomUUID());
assert.equal(analyzed.warnings.length,0);
assert(analyzed.graph.nodes.some(n=>n.kind==='external'));
assert(analyzed.graph.edges.some(e=>e.type==='loads_asset'));
const add=applyProposal(files,{summary:'追加',patches:[{path:'edit.example/new.html',action:'add',oldText:'',newText:'<h1>New</h1>'},
  {path:'edit.example/index.html',action:'replace',oldText:'Before',newText:'Before</h1><a href="/new">New</a><h1>'}]});
const added=analyzeEdit(add.files,'https://edit.example/',randomUUID());
assert.equal(added.warnings.length,0);assert(added.graph.nodes.some(n=>n.url==='https://edit.example/new'));
const keyBefore=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='test-only';
const fake=async()=>Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(proposal('Before','After'))}]}],usage:{input_tokens:123,output_tokens:45}});
const direct=await generateEdit(files,'見出し変更','https://edit.example/',fake);
assert.equal(direct.usage.inputMode,'inline');assert.equal(direct.usage.inputTokens,123);
await assert.rejects(generateEdit(files,'test','https://edit.example/',async()=>new Response('',{status:429})),/上限/);
let call=0;
const large=files.map(f=>f.relativePath==='edit.example/index.html'?file(f.relativePath,Buffer.from(f.content,'base64').toString()+' '.repeat(13000)):f);
const ondemand=await generateEdit(large,'変更','https://edit.example/',async(_url,init)=> {
  const request=JSON.parse(init.body);assert.notEqual(request.model,'auto');
  if(call++===0)return Response.json({status:'completed',output:[{type:'function_call',name:'read_site_file',call_id:'c1',arguments:JSON.stringify({path:'edit.example/index.html'})}],usage:{input_tokens:30,output_tokens:5}});
  assert(request.input.some(i=>i.type==='function_call_output'&&i.output.includes('Before')));return fake();
});
assert.equal(ondemand.usage.inputMode,'on-demand');assert.equal(ondemand.usage.inputTokens,153);
console.log('AI adapter, patch validation, graph and token usage: passed');

if(!process.env.DATABASE_URL)throw new Error('Use a migrated test database via DATABASE_URL');
const connection=new pg.Client({connectionString:process.env.DATABASE_URL});await connection.connect();
const root=await mkdtemp(path.join(os.tmpdir(),'wptossg-edit-'));
const oldOutput=process.env.LOCAL_OUTPUT_DIR;process.env.LOCAL_OUTPUT_DIR=root;
const siteKey=`edit-test-${randomUUID()}`;const originalId=randomUUID();
const originalFetch=globalThis.fetch;const draftIds=[];
const events=[];
const reporter={saveJob:async()=>{},publish:async event=>events.push(event)};
const draft=async(parentDraftId)=> {
  const id=randomUUID();draftIds.push(id);const now=new Date().toISOString();
  const value={id,siteKey,siteUrl:'https://edit.example/',baseVersionId:originalId,sourceJobId:originalId,parentDraftId,instruction:'見出しを変更',status:'queued',stage:'LOAD_BASE',createdAt:now,updatedAt:now};
  await insertEdit(value);return value;
};
try {
  const storage=await rotateAndWriteLocal(originalId,{siteKey,files:files.map(f=>({...f,content:Buffer.from(f.content,'base64')}))});
  const report={id:originalId,jobId:originalId,generatedAt:new Date().toISOString(),successCount:1,failedCount:0,warnings:0,pages:[],failures:[],
    stageBreakdown:[{stage:'ROTATE_AND_UPLOAD',successCount:3,failedCount:0}],storage:{backend:'local',currentFolderId:storage.currentFolderId,currentLocation:storage.currentFolderId}};
  await writeFilesToLocalFolder(storage.currentFolderId,[{relativePath:'report.json',content:Buffer.from(JSON.stringify(report)),mimeType:'application/json'}]);
  await recordSavedSite({id:originalId,siteUrl:'https://edit.example/',status:'completed',report},siteKey);
  const first=await draft();globalThis.fetch=fake;
  await runEditJob({kind:'ai-edit',jobId:first.id,siteKey,action:'generate'},reporter);
  let ready=await getEdit(first.id);
  assert.equal(ready.status,'ready',ready.error);assert(ready.graph.edges.length>0);assert.equal(ready.diagnostic.riskLevel,'low');
  assert.match(await readFile(path.join(storage.currentFolderId,'edit.example/index.html'),'utf8'),/Before/);
  assert.equal(await readEditPreview(first.id,'0'.repeat(48),''),undefined);
  const preview=await readEditPreview(first.id,ready.previewToken,'');assert(preview);
  assert.match(preview.body.toString(),new RegExp(`/edit-preview/${first.id}/`));
  const css=await readEditPreview(first.id,ready.previewToken,'assets/main.css');assert.match(css.body.toString(),/blue/);
  assert.equal(await readEditPreview(first.id,ready.previewToken,'../report.json'),undefined);
  if(process.env.TEST_PREVIEW_ORIGIN) {
    const url=`${process.env.TEST_PREVIEW_ORIGIN}/edit-preview/${first.id}/${ready.previewToken}/edit.example/index.html`;
    const response=await originalFetch(url);assert.equal(response.status,200);
    const csp=response.headers.get('content-security-policy');assert(csp.includes('sandbox allow-scripts'));assert(!csp.includes('allow-same-origin'));assert(csp.includes("connect-src 'none'"));
    assert.equal(response.headers.get('referrer-policy'),'no-referrer');assert.equal(response.headers.get('x-content-type-options'),'nosniff');
    assert.match(await response.text(),/After/);
  }
  const next=await draft(first.id);
  globalThis.fetch=async()=>Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({summary:'色変更',patches:[{path:'assets/main.css',action:'replace',oldText:'blue',newText:'red'}]})}]}],usage:{input_tokens:20,output_tokens:10}});
  await runEditJob({kind:'ai-edit',jobId:next.id,siteKey,action:'generate'},reporter);
  const regenerated=await getEdit(next.id);assert.equal(regenerated.status,'ready',regenerated.error);
  assert(regenerated.changes.some(c=>c.path==='edit.example/index.html'));assert(regenerated.changes.some(c=>c.path==='assets/main.css'));
  // Save the original proposal; a later generated draft must then conflict.
  ready.status='saving';await updateEdit(ready);
  await runEditJob({kind:'ai-edit',jobId:first.id,siteKey,action:'save'},reporter);
  ready=await getEdit(first.id);assert.equal(ready.status,'saved',ready.error);
  assert.match(await readFile(path.join(storage.currentFolderId,'edit.example/index.html'),'utf8'),/After/);
  assert.match(await readFile(path.join(ready.publication.archive,'edit.example/index.html'),'utf8'),/Before/);
  assert.equal((await getSavedSite(siteKey)).latest.id,first.id);
  await Promise.all([runEditJob({kind:'ai-edit',jobId:first.id,siteKey,action:'save'},reporter),runEditJob({kind:'ai-edit',jobId:first.id,siteKey,action:'save'},reporter)]);
  assert.equal((await readdir(path.join(root,'sites',siteKey,'archive'))).length,1);
  regenerated.status='saving';await updateEdit(regenerated);
  await runEditJob({kind:'ai-edit',jobId:next.id,siteKey,action:'save'},reporter);
  assert.match((await getEdit(next.id)).error,/更新/);assert.equal((await getSavedSite(siteKey)).versions.length,2);
  assert((await listEditEvents(first.id)).some(e=>e.type==='diagnostic_ready'));
  // A publication intent must block a conversion until recovery is complete.
  regenerated.publication={backend:'local',siteFolder:'unused',pending:'unused',current:'unused',phase:'prepared'};
  await updateEdit(regenerated);
  await assert.rejects(withSiteLock(siteKey,async()=>{}),/未完了/);
  delete regenerated.publication;await updateEdit(regenerated);
  // Local restart: current was already archived before phase was committed to DB.
  const recover=await draft();recover.status='saving';recover.files=ready.files;recover.report=ready.report;
  const folder=path.join(root,'recovery');await mkdir(folder,{recursive:true});
  recover.publication={backend:'local',siteFolder:folder,pending:path.join(folder,'pending'),current:path.join(folder,'current'),previous:path.join(folder,'current'),archive:path.join(folder,'archive','old'),phase:'prepared'};
  await mkdir(recover.publication.archive,{recursive:true});await updateEdit(recover);
  await publishEditArtifacts(recover);assert.equal(recover.publication.phase,'published');
  await publishEditArtifacts(recover);assert.equal(await readFile(path.join(folder,'current','.wptossg-edit-version'),'utf8'),recover.id);
  // Drive pointer failure: the old generation stays published and retry reuses IDs.
  const driveEdit=await draft();driveEdit.status='saving';driveEdit.files=ready.files;driveEdit.report=structuredClone(ready.report);
  const entries=new Map([
    ['root',{id:'root',name:'root',mimeType:'application/vnd.google-apps.folder',parents:[]}],
    ['sites',{id:'sites',name:'sites',mimeType:'application/vnd.google-apps.folder',parents:['root']}],
    ['site',{id:'site',name:siteKey,mimeType:'application/vnd.google-apps.folder',parents:['sites'],appProperties:{publishedFolderId:'old'}}],
    ['old',{id:'old',name:'current',mimeType:'application/vnd.google-apps.folder',parents:['site']}]
  ]);
  let failSwitch=true,creates=0;
  const drive={files:{
    list:async({q})=> {
      const parent=q.match(/^'([^']+)' in parents/)[1];const name=q.match(/name\s*=\s*'([^']+)'/)?.[1];
      return {data:{files:[...entries.values()].filter(e=>e.parents.includes(parent)&&!e.trashed&&(!name||e.name===name))}};
    },
    create:async({requestBody})=>{const id=`file-${++creates}`;entries.set(id,{...requestBody,id});return {data:{id}};},
    get:async({fileId})=>({data:entries.get(fileId)}),
    update:async({fileId,requestBody={},addParents,removeParents})=> {
      if(fileId==='site'&&requestBody.appProperties?.publishedFolderId!=='old'&&failSwitch){failSwitch=false;throw new Error('injected pointer failure');}
      const entry=entries.get(fileId);Object.assign(entry,requestBody);
      if(removeParents)entry.parents=entry.parents.filter(p=>p!==removeParents);
      if(addParents&&!entry.parents.includes(addParents))entry.parents.push(addParents);
      return {data:entry};
    }
  }};
  const rootBefore=process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID='root';
  try {
    const driveSite={...await getSavedSite(siteKey),latest:{...ready,artifactBackend:'google-drive',report:{storage:{currentFolderId:'old'}}}};
    await prepareEditPublication(driveEdit,driveSite,drive);
    await assert.rejects(publishEditArtifacts(driveEdit,drive),/injected/);
    assert.equal(entries.get('site').appProperties.publishedFolderId,'old');
    assert.equal(entries.get('old').name,driveEdit.publication.archiveName);
    const count=creates;await publishEditArtifacts(driveEdit,drive);await publishEditArtifacts(driveEdit,drive);
    assert.equal(creates,count);assert.equal(entries.get('site').appProperties.publishedFolderId,driveEdit.publication.pending);
    assert.equal(driveEdit.publication.phase,'published');
  } finally {if(rootBefore===undefined)delete process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;else process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID=rootBefore;}
  console.log('Draft generation, rendering, preview, regeneration, save, duplicate save, stale base, locking, recovery: passed');
} finally {
  globalThis.fetch=originalFetch;
  if(keyBefore===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=keyBefore;
  if(oldOutput===undefined)delete process.env.LOCAL_OUTPUT_DIR;else process.env.LOCAL_OUTPUT_DIR=oldOutput;
  await connection.query('DELETE FROM edit_job_events WHERE job_id=ANY($1::text[])',[draftIds]);
  await connection.query('DELETE FROM site_edits WHERE site_key=$1',[siteKey]);
  await connection.query('DELETE FROM site_versions WHERE site_key=$1',[siteKey]);
  await connection.query('DELETE FROM saved_sites WHERE site_key=$1',[siteKey]);
  await connection.end();await pool().end();await rm(root,{recursive:true,force:true});
}

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { recordSavedSite, pool } from '../packages/shared/dist/site-store.js';
import { insertEdit, getEdit } from '../packages/shared/dist/edit-store.js';
import { jobStateKey, jobEventsKey } from '../packages/shared/dist/index.js';
const base=process.env.TEST_APP_URL ?? 'http://web:3100';
const id=randomUUID(),original=randomUUID(),siteKey=`api-edit-${id}`,now=new Date().toISOString();
const redis=new Redis(process.env.REDIS_URL);
const report={id:original,jobId:original,generatedAt:now,successCount:1,failedCount:0,warnings:0,pages:[],failures:[],stageBreakdown:[],storage:{backend:'local',currentFolderId:'/unused',currentLocation:'/unused'}};
const request=(url,body,headers={})=>fetch(`${base}${url}`,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
try {
  await recordSavedSite({id:original,siteUrl:'https://api-edit.example/',status:'completed',report},siteKey);
  await insertEdit({id,siteKey,siteUrl:'https://api-edit.example/',baseVersionId:'stale',sourceJobId:original,instruction:'変更',status:'ready',stage:'PREVIEW_READY',createdAt:now,updatedAt:now,
    previewToken:'0'.repeat(48),previewUrl:`${base}/edit-preview/private`,files:[{relativePath:'private.html',content:'c2VjcmV0',mimeType:'text/html'}],graph:{nodes:[],edges:[]},diagnostic:{riskLevel:'low',reasons:[],evidence:[]},report});
  let response=await fetch(`${base}/api/edits/${id}`);assert.equal(response.status,200);
  const json=await response.json();assert.equal(json.edit.files,undefined);assert.equal(json.edit.previewToken,undefined);assert.equal(json.edit.publication,undefined);assert.equal(json.edit.previewUrl,undefined);
  response=await request('/api/edits',{siteKey,instruction:''});assert.equal(response.status,400);
  response=await request(`/api/edits/${id}`,{action:'discard'},{Origin:'https://untrusted.example'});assert.equal(response.status,403);assert.equal((await getEdit(id)).status,'ready');
  response=await request(`/api/edits/${id}`,{action:'save'});assert.equal(response.status,409);assert.match((await response.json()).error,/更新/);
  response=await request(`/api/edits/${id}`,{action:'discard'});assert.equal(response.status,200);assert.equal((await getEdit(id)).status,'discarded');assert.equal((await getEdit(id)).files,undefined);
  // A save SSE connection must replay past generation completion and reach the current operation.
  await redis.set(jobStateKey(id),JSON.stringify({id,operationId:'save-1',siteUrl:'https://api-edit.example/',status:'running',currentStage:'SAVE',createdAt:now,updatedAt:now,percent:50}));
  const event=(stage,type,operationId)=>({id:'placeholder',jobId:id,stage,type,message:type,timestamp:now,details:{operationId}});
  const old=await redis.xadd(jobEventsKey(id),'*','event',JSON.stringify(event('PREVIEW_READY','completed','gen-1')));
  const progress=await redis.xadd(jobEventsKey(id),'*','event',JSON.stringify(event('SAVE','stage_progress','save-1')));
  await redis.xadd(jobEventsKey(id),'*','event',JSON.stringify(event('FINALIZE','completed','save-1')));
  response=await fetch(`${base}/api/jobs/${id}/events`);const text=await response.text();assert(text.includes('save-1'));assert(text.includes('gen-1'));
  response=await fetch(`${base}/api/jobs/${id}/events`,{headers:{'Last-Event-ID':progress}});const replay=await response.text();assert(!replay.includes('gen-1'));assert(replay.includes('save-1'));assert(!replay.includes('event: stage_progress'));
  console.log('Edit API: private fields, origin rejection, stale save, discard, SSE operation replay and Last-Event-ID: passed');
} finally {
  await redis.del(jobStateKey(id),jobEventsKey(id));await redis.quit();
  await pool().query('DELETE FROM edit_job_events WHERE job_id=$1',[id]);
  await pool().query('DELETE FROM site_edits WHERE id=$1',[id]);
  await pool().query('DELETE FROM site_versions WHERE site_key=$1',[siteKey]);
  await pool().query('DELETE FROM saved_sites WHERE site_key=$1',[siteKey]);await pool().end();
}

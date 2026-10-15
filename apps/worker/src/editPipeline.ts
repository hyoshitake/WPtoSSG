import { randomBytes } from 'node:crypto';
import { getSavedSite } from '@wptossg/shared/site-store';
import { getEdit, updateEdit, recordEditEvent, withSiteLock, commitEditVersion } from '@wptossg/shared/edit-store';
import { createJobEvent, type EditJobData, type Job, type JobEvent, type StoredEdit, type SiteVersion, type JobReport } from '@wptossg/shared';
import type { JobReporter } from './redisJobReporter.js';
import { readBaseFiles, prepareEditPublication, publishEditArtifacts } from './editArtifacts.js';
import { generateEdit, applyProposal, changedFiles } from './openaiEdit.js';
import { analyzeEdit, renderEdit, addDiagnosticToGraph } from './editValidation.js';

export async function runEditJob(data: EditJobData, reporter: JobReporter): Promise<Job> {
  const initial = await getEdit(data.jobId);
  if (!initial) throw new Error('編集ジョブがありません。');
  let edit: StoredEdit = initial;
  const snapshot = (): Job => ({operationId:data.operationId,id:edit!.id,siteUrl:edit!.siteUrl,status:edit!.status==='failed'?'failed':
    ['ready','saved','discarded'].includes(edit!.status)?'completed':'running', currentStage:edit!.stage,
    createdAt:edit!.createdAt,updatedAt:edit!.updatedAt,percent:['ready','saved'].includes(edit!.status)?100:35,
    report:edit!.report,diagnostic:edit!.diagnostic,graph:edit!.graph});
  const emit = async (type: JobEvent['type'], message: string, details?: Record<string,unknown>) => {
    const event=createJobEvent({jobId:edit!.id,stage:edit!.stage,type,message,details:{...details,operationId:data.operationId}});
    await recordEditEvent(event);
    await reporter.saveJob(snapshot()); await reporter.publish(event);
  };
  const stage = async (name: StoredEdit['stage'],message: string) => {
    edit!.stage=name; await updateEdit(edit!); await emit('stage_progress',message);
  };
  const fail = async (error: unknown): Promise<void> => {
    // Never overwrite a concurrent worker's state after failing to acquire the lock.
    const latest=await getEdit(data.jobId);
    if(latest?.status==='saved' || latest?.status==='discarded' || latest?.status==='ready' && data.action==='generate') return;
    edit=latest ?? edit;
    edit.error=error instanceof Error ? error.message.slice(0,500) : '編集に失敗しました。';
    // Publication intent survives failures. Retrying save uses exactly the same generation IDs.
    edit.status='failed';
    edit.report ??= {id:edit.id,jobId:edit.id,generatedAt:new Date().toISOString(),successCount:0,failedCount:1,warnings:0,pages:[],stageBreakdown:[],failures:[]};
    edit.report.failures=[{stage:edit.stage,target:edit.siteUrl,reason:edit.error}];
    edit.report.failedCount=1;
    edit.report.stageBreakdown=edit.report.stageBreakdown.filter(stage=>stage.stage!==edit.stage);
    edit.report.stageBreakdown.push({stage:edit.stage,successCount:0,failedCount:1});
    edit.files=(edit.files ?? []).filter(file=>file.relativePath!=='report.json');
    edit.files.push({relativePath:'report.json',mimeType:'application/json',content:Buffer.from(JSON.stringify(edit.report,null,2)).toString('base64')});
    await updateEdit(edit);
    await emit('failed',edit.error);
  };
  try {
    await withSiteLock(edit.siteKey,async () => {
      try {
      edit = (await getEdit(data.jobId))!;
      if (data.action === 'save' && edit.status==='saved' || data.action==='generate' && edit.status==='ready') {
        await emit('completed','処理済みです。'); return;
      }
      if (data.action === 'generate' && edit.status !== 'queued') throw new Error('生成が中断されたか、処理済みです。新しい指示で再生成してください。');
      if (data.action === 'save' && edit.status !== 'saving') throw new Error('保存可能な修正案ではありません。');
      const site=await getSavedSite(edit.siteKey);
      if (!site) throw new Error('対象サイトがありません。');
      if (site.latest.id !== edit.baseVersionId && site.latest.id !== edit.id) throw new Error('currentが更新されています。サイトを再読み込みして再生成してください。');
      if (data.action==='generate') {
        edit.status='generating'; await stage('LOAD_BASE','基準版の成果物を読み込み中');
        let files;
        let parentChanges: StoredEdit['changes'];
        if (edit.parentDraftId) {
          const parent=await getEdit(edit.parentDraftId);
          if (!parent?.files || parent.status!=='ready' || parent.baseVersionId!==edit.baseVersionId || parent.siteKey!==edit.siteKey) throw new Error('再指示の元の案が利用できません。');
          files=parent.files;
          parentChanges=parent.changes;
        } else {
          files=await readBaseFiles(site);
          const reportFile=files.find(f=>f.relativePath==='report.json');
          if (!reportFile || (JSON.parse(Buffer.from(reportFile.content,'base64').toString()) as JobReport).jobId !== site.latest.jobId) throw new Error('一覧とcurrentの版が一致しません。メタデータを補完するか再変換してください。');
        }
        await stage('GENERATE','OpenAIで修正案を生成中');
        const generated=await generateEdit(files,edit.instruction,edit.siteUrl,fetch,
          async details=>emit('warning','AIのファイル参照を修正中です。',{...details}));
        const proposal=applyProposal(files,generated.proposal);
        edit.summary=generated.proposal.summary; edit.usage=generated.usage;
        await stage('VALIDATE','参照・Graph・診断とレンダリングを検証中');
        const baseline=analyzeEdit(files,edit.siteUrl,edit.id);
        const validated=analyzeEdit(proposal.files,edit.siteUrl,edit.id);
        const existingMissing=new Set(baseline.warnings);
        const missing=validated.warnings.filter(w=>!existingMissing.has(w));
        if(missing.length) throw new Error(`新しい欠損参照があります: ${missing.slice(0,3).join(' / ')}`);
        edit.files=validated.files;
        const cumulative=new Map((parentChanges ?? []).map(change=>[change.path,change]));
        edit.graph=validated.graph;
        const runtime=await renderEdit(edit.files,edit.siteUrl,validated.pages.map(p=>p.snapshotPath));
        const diagnostic=validated.diagnostic;
        diagnostic.reasons=[...new Set([...diagnostic.reasons,...runtime.reasons])];
        diagnostic.evidence=[...diagnostic.evidence,...runtime.evidence];
        if(runtime.riskLevel==='high' || diagnostic.riskLevel==='high') diagnostic.riskLevel='high';
        else if(runtime.riskLevel==='medium' || diagnostic.riskLevel==='medium') diagnostic.riskLevel='medium';
        edit.diagnostic=diagnostic;
        addDiagnosticToGraph(edit.graph,diagnostic);
        edit.files=edit.files.filter(file=>file.relativePath!=='graph.json');
        edit.files.push({relativePath:'graph.json',mimeType:'application/json',content:Buffer.from(JSON.stringify(edit.graph,null,2)).toString('base64')});
        edit.report={id:edit.id,jobId:edit.id,generatedAt:new Date().toISOString(),successCount:validated.pages.length-1,failedCount:0,
          warnings:validated.warnings.length,pages:validated.pages,diagnostic,
          stageBreakdown:[{stage:'GENERATE',successCount:proposal.changes.length,failedCount:0},{stage:'VALIDATE',successCount:validated.pages.length,failedCount:0}],failures:[]};
        edit.files=edit.files.filter(f=>f.relativePath!=='report.json');
        edit.files.push({relativePath:'report.json',mimeType:'application/json',content:Buffer.from(JSON.stringify(edit.report,null,2)).toString('base64')});
        for(const change of changedFiles(files,edit.files)) {
          const previous=cumulative.get(change.path);
          const beforeHash=previous ? previous.beforeHash : change.beforeHash;
          if(beforeHash===change.afterHash) cumulative.delete(change.path);
          else cumulative.set(change.path,{path:change.path,action:!beforeHash?'add':!change.afterHash?'delete':'modify',beforeHash,afterHash:change.afterHash});
        }
        edit.changes=[...cumulative.values()];
        edit.previewToken=randomBytes(24).toString('hex');
        const origin=new URL(process.env['PREVIEW_PUBLIC_ORIGIN'] ?? 'http://localhost:4001').origin;
        edit.previewUrl=`${origin}/edit-preview/${edit.id}/${edit.previewToken}/`;
        for (const warning of validated.warnings.slice(0,20)) await emit('warning','基準版から存在する欠損参照',{reference:warning});
        await emit('diagnostic_ready','編集後の診断が完了しました。',{diagnostic});
        edit.status='ready'; await stage('PREVIEW_READY','プレビューの準備ができました。currentは変更されていません。');
        await emit('completed','修正案を確認して保存してください。');
      } else {
        if(!edit.files || !edit.report || !edit.graph || !edit.diagnostic) throw new Error('検証済みの修正案がありません。');
        edit.report.failedCount=0; edit.report.failures=[];
        edit.report.stageBreakdown=edit.report.stageBreakdown.filter(s=>s.stage!=='SAVE');
        edit.report.stageBreakdown.push({stage:'SAVE',successCount:edit.files.length,failedCount:0});
        await stage('SAVE','新版を準備して保存中');
        await prepareEditPublication(edit,site);
        await publishEditArtifacts(edit);
        const plan=edit.publication!;
        const version: SiteVersion={id:edit.id,siteKey:edit.siteKey,jobId:edit.id,source:'ai-edit',sourceJobId:edit.sourceJobId,
          baseVersionId:edit.baseVersionId,editJobId:edit.id,draftId:edit.id,savedAt:new Date().toISOString(),report:edit.report,
          graph:edit.graph,diagnostic:edit.diagnostic,artifactBackend:plan.backend,artifactLocation:edit.report.storage?.currentLocation};
        edit.stage='FINALIZE'; edit.error=undefined;
        const archive=plan.backend==='local'?plan.archive:plan.archive && `https://drive.google.com/drive/folders/${plan.archive}`;
        await commitEditVersion(edit,version,archive);
        await emit('completed','編集版を保存し、旧版をarchiveへ退避しました。',{versionId:version.id});
      }
      } catch (error) { await fail(error); }
    },data.jobId);
  } catch(error) {
    await fail(error);
  }
  return snapshot();
}

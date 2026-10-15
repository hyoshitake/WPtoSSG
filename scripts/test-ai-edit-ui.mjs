import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base=process.env.TEST_APP_URL ?? 'http://web:3100';
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1440,height:1200}});
const id='11111111-1111-4111-8111-111111111111';
const key='ui-edit-test';
const now=new Date().toISOString();
let current;
const requests=[];
const draft=()=>({id,siteKey:key,siteUrl:'https://edit.example/',baseVersionId:'base-1',sourceJobId:'base-1',createdAt:now,updatedAt:now,
  instruction:'見出しを変更',status:'ready',stage:'PREVIEW_READY',summary:'見出しを変更しました',changes:[{path:'edit.example/index.html',action:'modify'}],
  previewUrl:`http://preview.example/edit-preview/${id}/token/`,diagnostic:{riskLevel:'medium',reasons:['form exists'],evidence:[{type:'selector',location:'https://edit.example/',details:{selector:'form'}}]}});
try {
  await page.route('**/api/sites',route=>route.fulfill({json:{sites:[{siteKey:key,name:'テストサイト',siteUrl:'https://edit.example/',latest:{id:'base-1'}}]}}));
  await page.route('**/api/edits',async route=> {
    requests.push(route.request().postDataJSON());current=draft();
    await route.fulfill({status:202,json:{edit:current}});
  });
  await page.route('**/api/edits/*',async route=> {
    if(route.request().method()==='POST') {
      const body=route.request().postDataJSON();requests.push(body);
      current={...current,status:body.action==='save'?'saved':'discarded',stage:'FINALIZE'};
    }
    await route.fulfill({json:{edit:current,events:[]}});
  });
  await page.route('http://preview.example/**',route=>route.fulfill({contentType:'text/html',headers:{'Content-Security-Policy':'sandbox allow-scripts'},body:'<h1>Edited</h1><a href="next">Next</a>'}));
  await page.goto(`${base}/edit?siteKey=${key}`);
  await page.getByLabel('AIへの修正指示').fill('見出しを変更');
  await page.getByRole('button',{name:'修正案を生成',exact:true}).click();
  await page.getByText('見出しを変更しました').waitFor();
  assert.equal(requests[0].siteKey,key);assert.equal(requests[0].instruction,'見出しを変更');
  const preview=page.frameLocator('iframe[title="編集したサイトのプレビュー"]');
  await preview.getByText('Edited',{exact:true}).waitFor();
  const iframe=await page.locator('iframe').elementHandle();const frame=await iframe.contentFrame();
  assert.equal(await frame.evaluate(()=>{try { return parent.document.title; }catch {return 'isolated';}}),'isolated');
  assert.equal(await page.locator('iframe').getAttribute('sandbox'),'allow-scripts');
  assert(await page.getByRole('button',{name:'確認した案を保存'}).isDisabled());
  await page.getByLabel('変更概要・変更ファイル・プレビューを確認しました').check();
  await page.getByRole('button',{name:'確認した案を保存'}).click();
  await page.getByText('保存しました。',{exact:false}).waitFor();assert.equal(requests.at(-1).action,'save');
  // Restore a ready draft and verify that an additional instruction carries its parent ID.
  current=draft();await page.reload();
  await page.getByRole('button',{name:'この案への追加指示で再生成'}).waitFor();
  await page.getByLabel('AIへの修正指示').fill('さらに色を変更');
  await page.getByRole('button',{name:'この案への追加指示で再生成'}).click();
  await page.getByText('見出しを変更しました').waitFor();assert.equal(requests.at(-1).parentDraftId,id);
  await page.getByRole('button',{name:'この案を破棄'}).click();
  await page.getByText('状態: discarded',{exact:false}).waitFor();assert.equal(requests.at(-1).action,'discard');
  console.log('Edit UI: site selection, instructions, sandbox isolation, review gate, save, regeneration, discard: passed');
} finally {await browser.close();}

import assert from 'node:assert/strict';
import { generateEdit, applyProposal } from '../apps/worker/dist/openaiEdit.js';
const file=(relativePath,text)=>({relativePath,content:Buffer.from(text).toString('base64'),mimeType:'text/plain'});
const files=[file('example.com/index.html','<h1>Before</h1>'+' '.repeat(13000)),file('assets/app.js','console.log("context")'),
  file('public-routes.json','{"example.com/index.html":"/"}'),file('assets/logo.png','binary-image')];
const patch={summary:'見出しを変更',patches:[{path:'example.com/index.html',action:'replace',oldText:'Before',newText:'After'}]};
const call=(id,path)=>({type:'function_call',name:'read_site_file',call_id:id,arguments:JSON.stringify({path})});
const final=()=>Response.json({status:'completed',usage:{input_tokens:10,output_tokens:5},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(patch)}]}]});
const previous=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='test-only';
try {
  let round=0;const warnings=[];
  const generated=await generateEdit(files,'見出しを変更','https://example.com/',async(_url,init)=> {
    const request=JSON.parse(init.body);
    if(round++===0) {
      const manifest=JSON.parse(request.input[0].content).files;
      assert.equal(manifest.find(f=>f.path==='assets/app.js').readable,true);
      assert.equal(manifest.find(f=>f.path==='assets/app.js').editable,false);
      assert.equal(manifest.find(f=>f.path==='assets/logo.png').readable,false);
      return Response.json({status:'completed',output:[call('missing','/wrong/index.html'),call('binary','assets/logo.png'),
        {type:'function_call',name:'read_site_file',call_id:'invalid',arguments:'bad json'},
        call('traversal','../secret.txt'),call('js','assets/app.js'),call('json','public-routes.json'),call('html','example.com/index.html')]});
    }
    const outputs=new Map(request.input.filter(i=>i.type==='function_call_output').map(i=>[i.call_id,i.output]));
    assert.equal(JSON.parse(outputs.get('missing')).error,'not_found');
    assert.equal(JSON.parse(outputs.get('binary')).error,'unsupported_type');
    assert.equal(JSON.parse(outputs.get('invalid')).error,'invalid_arguments');
    assert.equal(JSON.parse(outputs.get('traversal')).error,'not_found');
    assert.match(outputs.get('js'),/context/);assert.match(outputs.get('json'),/example.com/);assert.match(outputs.get('html'),/Before/);
    return final();
  },async warning=>warnings.push(warning));
  assert.equal(round,2);assert.equal(warnings.length,4);assert.equal(warnings[3].requestedPath,undefined);
  assert.equal(generated.usage.inputMode,'on-demand');
  assert.equal(applyProposal(files,generated.proposal).changes.length,1);
  assert.throws(()=>applyProposal(files,{summary:'bad',patches:[{path:'assets/app.js',action:'replace',oldText:'context',newText:'changed'}]}),/編集対象/);
  // A missing read must never count as having read the real HTML source.
  round=0;
  await assert.rejects(generateEdit(files,'変更','https://example.com/',async()=>round++===0?
    Response.json({status:'completed',output:[call('missing','wrong.html')]}):final()),/確認していない/);
  // Repeated invalid reads terminate within the existing tool-round cap.
  let attempts=0;
  await assert.rejects(generateEdit(files,'変更','https://example.com/',async()=> {
    attempts++;return Response.json({status:'completed',output:[call(`missing-${attempts}`,'wrong.html')]});
  }),/回数/);
  assert.equal(attempts,12);
  const huge=[...files,file('assets/huge.css',' '.repeat(201*1024))];
  await assert.rejects(generateEdit(huge,'変更','https://example.com/',async()=>Response.json({status:'completed',output:[call('huge','assets/huge.css')]})),/200 KiB/);
  console.log('Source reads: manifest capabilities, JS/JSON context, invalid paths/arguments, binary rejection, recovery, read enforcement and bounds passed');
} finally { if(previous===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=previous; }

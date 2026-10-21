'use strict';
// Run: node tests/save-switch.cjs
// Local behavior tests. The DOM and storage transport are controlled doubles;
// native iPad share UI and IndexedDB itself require a device/browser check.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

function environment(){
  const listeners=new Map();
  const doc={activeElement:null,addEventListener(k,f){listeners.set(k,f);},removeEventListener(k,f){if(listeners.get(k)===f)listeners.delete(k);}};
  class Element{
    constructor(tag){this.tagName=tag;this.children=[];this.disabled=false;this.textContent='';this.attributes={};this.parentNode=null;this.isConnected=false;}
    appendChild(e){e.parentNode=this;e.isConnected=this.isConnected;this.children.push(e);return e;}
    remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(e=>e!==this);this.isConnected=false;}
    setAttribute(k,v){this.attributes[k]=v;}
    focus(){doc.activeElement=this;}
    click(){if(!this.disabled&&this.onclick)return this.onclick();}
  }
  doc.createElement=tag=>new Element(tag);doc.body=new Element('body');doc.body.isConnected=true;
  const elements=()=>{const all=[];function walk(e){all.push(e);e.children.forEach(walk);}walk(doc.body);return all;};
  doc.getElementById=id=>elements().find(e=>e.id===id)||null;
  const writes=[],store=new Map(),toasts=[];
  const c=vm.createContext({document:doc,navigator:{userAgent:'iPad'},window:{innerHeight:1024},location:{protocol:'https:',hostname:'example.test',port:''},localStorage:{getItem(){return null;}},console:{warn(){},error(){}},File,URL,setTimeout,clearTimeout});
  for(const name of ['core.js','storage.js','file-backup.js','import-export.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../js',name),'utf8'),c,{filename:name});
  c.showToast=(text,error)=>toasts.push({text,error});
  c.renderPage=()=>{};c.rebuildSearchIndex=()=>{};c.showErrors=()=>{};c.showProgress=()=>{};c.updateProgress=()=>{};
  c.localRequest=async(url,method,data)=>{
    if(method==='POST'){
      if(c.failWrite&&c.failWrite(data))throw new Error('模拟保存失败');
      const copy=JSON.parse(JSON.stringify(data));writes.push(copy);store.set('current',copy);if(copy.db.length)store.set(copy.id,copy);return {ok:true};
    }
    return {records:[...store].filter(([k])=>k!=='current').map(([,v])=>v),current:store.get('current')};
  };
  const picture='data:image/png;base64,dGVzdA==';
  c.db=[{'条码':'12345678','商品名称':'旧单商品','数量':10,'实际数量':7,__feisuImages:[{data:picture}]}];
  c.columns=['条码','商品名称','数量','实际数量'];c.currentImportFileName='旧单';c.inventorySessionId='history:100:old';c.sourceQtyColumn='数量';c.unknownBarcodes={'99999999':2};
  const original=JSON.stringify(c.db);
  return {c,doc,writes,store,toasts,original,listeners,buttons:()=>elements().filter(e=>e.tagName==='button'),button(label){const b=this.buttons().find(e=>e.textContent===label);assert.ok(b,'missing button '+label);return b;},start(){c.isProcessing=true;return c.applyImportResult({rows:[{'条码':'87654321','商品名称':'新单商品','数量':4,'实际数量':''}],columns:['条码','商品名称','数量','实际数量'],errors:[]},'新单');}};
}
async function waitFor(fn){for(let i=0;i<50;i++){if(fn())return;await new Promise(r=>setImmediate(r));}throw Error('Expected state did not appear');}
async function dialog(e){await waitFor(()=>e.doc.getElementById('inventorySwitchDialog'));}
function assertOldRetained(e){const old=e.store.get('history:100:old');assert.ok(old);assert.equal(JSON.stringify(old.db),e.original);assert.equal(old.unknownBarcodes['99999999'],2);}
const tests=[];function test(name,work){tests.push({name,work});}

test('直接打开新单：无文件备份仍可换单，旧数量和图片保留',async()=>{
  const e=environment();let shares=0;e.c.navigator.canShare=()=>true;e.c.navigator.share=async()=>{shares++;};
  const task=e.start();await dialog(e);
  assert.deepEqual(e.buttons().map(b=>b.textContent),['打开新单','另存备份','继续当前盘点']);
  assert.equal(e.button('打开新单').disabled,false);
  e.button('打开新单').click();await task;
  assert.equal(e.c.currentImportFileName,'新单');assert.equal(e.store.get('current').currentImportFileName,'新单');
  assert.equal(shares,0);assertOldRetained(e);assert.equal(e.c.isProcessing,false);assert.equal(e.listeners.size,0);
});
test('继续当前盘点：取消导入，当前内存和已存记录不变',async()=>{
  const e=environment(),task=e.start();await dialog(e);e.button('继续当前盘点').click();await task;
  assert.equal(JSON.stringify(e.c.db),e.original);assert.equal(e.c.currentImportFileName,'旧单');
  assert.equal(e.writes.length,1);assertOldRetained(e);assert.equal(e.c.isProcessing,false);
});
test('文件分享取消：不换单、不误报保存，仍可直接换单',async()=>{
  const e=environment();e.c.navigator.canShare=()=>true;e.c.navigator.share=async()=>{const x=new Error('cancel');x.name='AbortError';throw x;};
  const task=e.start();await dialog(e);await e.button('另存备份').click();
  assert.equal(e.c.currentImportFileName,'旧单');assert.equal(e.button('打开新单').disabled,false);
  assert.match(e.doc.getElementById('inventorySwitchDialog').children[0].children.find(el=>el.attributes.role==='status').textContent,/已取消/);
  e.button('打开新单').click();await task;assertOldRetained(e);
});
test('文件分享失败：恢复备份按钮，主操作保持可用',async()=>{
  const e=environment();e.c.navigator.canShare=()=>true;e.c.navigator.share=async()=>{throw new Error('分享不可用');};
  const task=e.start();await dialog(e);await e.button('另存备份').click();
  assert.equal(e.button('另存备份').disabled,false);assert.equal(e.button('打开新单').disabled,false);
  e.button('打开新单').click();await task;assertOldRetained(e);
});
test('系统分享一直不返回：不锁住换单，晚到回调无副作用',async()=>{
  const e=environment();let finish;e.c.navigator.canShare=()=>true;e.c.navigator.share=()=>new Promise(r=>{finish=r;});
  const task=e.start();await dialog(e);const backupTask=e.button('另存备份').click();
  assert.equal(e.button('打开新单').disabled,false);e.button('打开新单').click();await task;
  assert.equal(e.c.currentImportFileName,'新单');assertOldRetained(e);finish();await backupTask;
  assert.equal(e.doc.getElementById('inventorySwitchDialog'),null);assert.equal(e.c.currentImportFileName,'新单');
});
test('自动保存失败：不弹成功提示、不替换旧单',async()=>{
  const e=environment();e.c.failWrite=()=>true;await e.start();
  assert.equal(JSON.stringify(e.c.db),e.original);assert.equal(e.c.currentImportFileName,'旧单');
  assert.equal(e.doc.getElementById('inventorySwitchDialog'),null);assert.equal(e.writes.length,0);
  assert.ok(e.toasts.some(t=>t.error&&t.text.includes('保存失败')));assert.equal(e.c.isProcessing,false);
});
test('新单保存失败：旧单仍为当前，历史备份仍在',async()=>{
  const e=environment();e.c.failWrite=d=>d.currentImportFileName==='新单';const task=e.start();await dialog(e);e.button('打开新单').click();await task;
  assert.equal(JSON.stringify(e.c.db),e.original);assert.equal(e.store.get('current').currentImportFileName,'旧单');
  assertOldRetained(e);assert.equal(e.c.isProcessing,false);assert.ok(e.toasts.some(t=>t.error));
});
test('首次导入空盘点：无需弹窗，直接保存并打开',async()=>{
  const e=environment();e.c.db=[];await e.start();assert.equal(e.c.currentImportFileName,'新单');
  assert.equal(e.doc.getElementById('inventorySwitchDialog'),null);assert.equal(e.c.isProcessing,false);
});
test('另存文件：数量、图片和未知条码都在备份中',async()=>{
  const e=environment();let received;e.c.navigator.canShare=()=>true;e.c.navigator.share=async({files})=>{received=files[0];};
  await e.c.backupCurrentInventory();const data=JSON.parse(await received.text());
  assert.equal(data.format,'FEISU-inventory-backup');assert.equal(data.schema,1);assert.equal(JSON.stringify(data.session.db),e.original);
  assert.equal(data.session.unknownBarcodes['99999999'],2);assert.equal(e.c.currentImportFileName,'旧单');
});
test('下载兜底：不支持文件分享时仍可发起下载',async()=>{
  const e=environment();e.c.setTimeout=()=>0;let clicks=0;
  const create=e.doc.createElement;e.doc.createElement=tag=>{const el=create(tag);if(tag==='a')el.click=()=>{clicks++;assert.match(el.download,/\.json$/);};return el;};
  e.c.navigator.canShare=()=>{throw Error('unsupported');};
  assert.equal(await e.c.sendInventoryBackup(e.c.makeInventoryBackup()),'download');assert.equal(clicks,1);
});
test('恢复文件备份：用恢复文案，旧盘点留存，图片数量不变',async()=>{
  const e=environment(),data={format:'FEISU-inventory-backup',schema:1,session:JSON.parse(JSON.stringify(e.c.sessionSnapshot()))};data.session.currentImportFileName='文件里的盘点';
  const input={files:[new File([JSON.stringify(data)],'恢复.json')],value:'selected'};
  const task=e.c.restoreFileBackup(input);await dialog(e);assert.ok(e.button('恢复备份'));assert.equal(input.value,'');
  e.button('恢复备份').click();await task;assert.equal(e.c.currentImportFileName,'文件里的盘点');assert.equal(JSON.stringify(e.c.db),e.original);assertOldRetained(e);assert.equal(e.c.isProcessing,false);
});
test('取消恢复文件：保持当前盘点',async()=>{
  const e=environment(),data={format:'FEISU-inventory-backup',schema:1,session:JSON.parse(JSON.stringify(e.c.sessionSnapshot()))};data.session.currentImportFileName='不会打开';
  const task=e.c.restoreFileBackup({files:[new File([JSON.stringify(data)],'恢复.json')],value:'selected'});await dialog(e);e.button('继续当前盘点').click();await task;
  assert.equal(e.c.currentImportFileName,'旧单');assert.equal(JSON.stringify(e.c.db),e.original);assert.equal(e.c.isProcessing,false);
});
test('历史满50份：浏览器裁剪保留刚保存的老单，淘汰最久未保存的记录',async()=>{
  const e=environment(),records=new Map();
  for(let i=1;i<=50;i++){const id='history:'+i+':test';records.set(id,{id,savedAt:i,db:[{}],columns:[]});}
  e.c.openInventoryDb=async()=>({close(){},transaction(){
    const tx={};
    tx.objectStore=()=>({put(d,k){records.set(k,JSON.parse(JSON.stringify(d)));},delete(k){records.delete(k);},openCursor(){
      const req={},entries=[...records],tick=i=>setImmediate(()=>{
        const pair=entries[i];req.result=pair?{key:pair[0],value:pair[1],continue(){tick(i+1);}}:null;
        req.onsuccess();if(!pair)setImmediate(()=>tx.oncomplete());
      });tick(0);return req;
    }});return tx;
  }});
  await e.c.browserRequest('/api/session','POST',{id:'history:1:test',savedAt:1000,db:[{'实际数量':7}],columns:['实际数量']});
  await e.c.browserRequest('/api/session','POST',{id:'history:51:test',savedAt:1001,db:[{}],columns:[]});
  assert.equal([...records.keys()].filter(k=>k.startsWith('history:')).length,50);
  assert.equal(records.get('history:1:test').db[0]['实际数量'],7);assert.equal(records.has('history:2:test'),false);
});
test('历史满50份：电脑真实文件裁剪同样保留刚保存的老单',async()=>{
  const fsp=require('node:fs/promises'),os=require('node:os');
  const tmp=await fsp.mkdtemp(path.join(os.tmpdir(),'feisu-history-test-'));
  try{
    await fsp.copyFile(path.join(__dirname,'../local-server.cjs'),path.join(tmp,'server.cjs'));
    const dir=path.join(tmp,'飞速盘点历史记录');await fsp.mkdir(dir);
    for(let i=1;i<=51;i++){const id='history:'+i+':test';await fsp.writeFile(path.join(dir,id.replaceAll(':','_')+'.json'),JSON.stringify({id,savedAt:i===1?1000:i,db:[{'实际数量':7}],columns:['实际数量']}));}
    const app=require(path.join(tmp,'server.cjs'));await app.trim('history:51:test');const kept=await app.records();
    assert.equal(kept.length,50);assert.ok(kept.some(d=>d.id==='history:1:test'));assert.equal(kept.some(d=>d.id==='history:2:test'),false);
  }finally{await fsp.rm(tmp,{recursive:true,force:true});}
});
test('Escape取消、Tab留在弹窗内，关闭后清理键盘监听',async()=>{
  const e=environment(),task=e.start();await dialog(e);let prevented=0;
  e.listeners.get('keydown')({key:'Tab',preventDefault(){prevented++;},stopPropagation(){}});assert.equal(e.doc.activeElement,e.button('打开新单'));
  e.listeners.get('keydown')({key:'Escape',preventDefault(){prevented++;},stopPropagation(){}});await task;
  assert.equal(prevented,2);assert.equal(e.c.currentImportFileName,'旧单');assert.equal(e.listeners.size,0);
});
(async()=>{let failed=0;for(const {name,work}of tests){try{await work();console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name+'\n'+e.stack);}}console.log(`${tests.length-failed}/${tests.length} passed`);process.exitCode=failed?1:0;})();

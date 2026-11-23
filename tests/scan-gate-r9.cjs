'use strict';
/* v5.0.3 回归：摄像头识别走严格匹配（不再跳到别的商品）；连扫计数模式。 */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');

function env(rows){
  const calls={toast:[],notFound:[],jump:[],stop:[],render:0,beep:[]};
  const c=vm.createContext({
    console:{info(){},warn(){},error(){}},navigator:{userAgent:'node-test'},
    document:{getElementById(){return null;},querySelector(){return null;},addEventListener(){}},window:{},
    localStorage:{getItem(){return null;},setItem(){}},
    Map,Set,JSON,Date,Math,Number,String,Array,Object,
    setTimeout(){return 0;},clearTimeout(){}
  });
  for(const f of ['core.js','search.js','table.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/'+f),'utf8'),c,{filename:f});
  c.db=rows;c.columns=['条码','商品名称','数量','实际数量','实际价格','差异','盘点状态'];
  c.pageSize=500;c.currentPage=0;c.currentInventoryFilter='all';c.unknownBarcodes={};
  Object.assign(c,{
    showToast(m){calls.toast.push(m);},
    showBarcodeNotFoundToast(code){calls.notFound.push(code);},
    playBeep(ok,code){calls.beep.push([ok,code]);},
    renderPage(){calls.render++;},
    renderDashboard(){},
    jumpToRowAndFocusQty(i){calls.jump.push(i);return true;},
    stopScanningAndJump(i){calls.stop.push(i);},
    scheduleAutoSave(){},
    filteredRowIndexes(){return c.db.map(function(_,i){return i;});}
  });
  c.__calls=calls;
  return c;
}
const rows=()=>[
  {'条码':'7501234567890','商品名称':'A 商品','数量':10,'实际数量':''},
  {'条码':'7509876543210','商品名称':'B 商品','数量':20,'实际数量':''},
  {'条码':'1111111111111','商品名称':'750123 前缀商品','数量':5,'实际数量':''}
];

test('camera scan never falls back to a name/price substring hit',()=>{
  const c=env(rows());
  assert.equal(c.handleBarcode('750123',true),false,'a 6-digit fragment must not jump to a row');
  assert.equal(c.__calls.notFound.length,1);
  assert.equal(c.__calls.jump.length,0);
  assert.equal(c.__calls.stop.length,0);
});

test('the same fuzzy text still works from the manual input box',()=>{
  const c=env(rows());
  assert.equal(c.handleBarcode('750123',false),true,'manual typing keeps fuzzy lookup');
  assert.deepEqual(c.__calls.jump,[2]);
});

test('a unique 8+ digit fragment inside a barcode column is accepted',()=>{
  const c=env(rows());
  assert.equal(c.handleBarcode('12345678',true),true);
  assert.deepEqual(c.__calls.jump,[0]);
});

test('an ambiguous fragment is rejected instead of guessing',()=>{
  const c=env([
    {'条码':'7501234567890','商品名称':'A','实际数量':''},
    {'条码':'0012345678999','商品名称':'B','实际数量':''}
  ]);
  assert.equal(c.handleBarcode('12345678',true),false);
  assert.equal(c.__calls.jump.length,0);
  assert.equal(c.__calls.notFound.length,1);
});

test('exact barcode still jumps and stops the camera in the default mode',()=>{
  const c=env(rows());
  assert.equal(c.handleBarcode('7501234567890',true),true);
  assert.deepEqual(c.__calls.stop,[0]);
  assert.deepEqual(c.__calls.jump,[0]);
});

test('continuous mode increments once and keeps the camera open',()=>{
  const c=env(rows());c.scanCountMode=true;c.scanSessionCount=0;
  assert.equal(c.handleBarcode('7501234567890',true),true);
  assert.equal(c.db[0]['实际数量'],1);
  assert.equal(c.scanSessionCount,1);
  assert.equal(c.__calls.stop.length,0,'camera must stay open');
  assert.equal(c.__calls.jump.length,0,'no row jump while counting');
  assert.equal(c.__calls.render,0,'no full table rebuild');
});

test('repeat within the cooldown is ignored, not treated as a new item',()=>{
  const c=env(rows());c.scanCountMode=true;
  c.handleBarcode('7501234567890',true);
  c.handleBarcode('7501234567',true);          /* 同一行的另一种读法 */
  assert.equal(c.db[0]['实际数量'],1);
  c.handleBarcode('7509876543210',true);
  assert.equal(c.db[1]['实际数量'],1,'a different barcode still counts');
  assert.equal(c.scanSessionCount,2);
});

test('continuous mode still hands non-exact matches to manual confirmation',()=>{
  const c=env(rows());c.scanCountMode=true;
  /* 唯一条码片段（非精确相等）→ 计数模式下不直接 +1，而是跳行人工确认 */
  assert.equal(c.handleBarcode('12345678',true),true);
  assert.equal(c.db[0]['实际数量'],'');
  assert.deepEqual(c.__calls.stop,[0]);
});

test('import keeps an already counted 实际数量 so a saved sheet can be resumed',()=>{
  const c=vm.createContext({console:{warn(){},info(){}},window:{},XLSX:null,ExcelJS:null,Math,Number,String,Object,Array,JSON,Date,setTimeout,clearTimeout,
    navigator:{userAgent:'node-test'},document:{getElementById(){return null;},querySelector(){return null;}},localStorage:{getItem(){return null;},setItem(){}},Map,Set});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/core.js'),'utf8'),c,{filename:'core.js'});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/import-export.js'),'utf8'),c,{filename:'import-export.js'});
  const built=c.buildImportedRow({'条码':'7501234567890','商品名称':'A','数量':10,'实际数量':7},new Set());
  assert.equal(built.row['实际数量'],7);
  const blank=c.buildImportedRow({'条码':'7501234567890','商品名称':'A','数量':10,'实际数量':''},new Set());
  assert.equal(blank.row['实际数量'],'');
});

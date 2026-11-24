'use strict';
/* v5.1 回归：供应商单据的“条形码CODIGO DE BARRA”列 + Code 128 编型号（字母/连字符） */
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
  c.db=rows;c.columns=Object.keys(rows[0]||{});
  c.pageSize=500;c.currentPage=0;c.currentInventoryFilter='all';c.unknownBarcodes={};
  Object.assign(c,{
    showToast(m){calls.toast.push(m);},
    showBarcodeNotFoundToast(code){calls.notFound.push(code);},
    playBeep(ok,code){calls.beep.push([ok,code]);},
    renderPage(){calls.render++;},renderDashboard(){},
    jumpToRowAndFocusQty(i){calls.jump.push(i);return true;},
    stopScanningAndJump(i){calls.stop.push(i);},
    scheduleAutoSave(){},
    filteredRowIndexes(){return c.db.map(function(_,i){return i;});}
  });
  c.__calls=calls;c.rebuildSearchIndex();
  return c;
}
const BAR='条形码CODIGO DE BARRA', MODEL='产品型号CODIGO';
const sheet=()=>[
  {[MODEL]:'VX-2316BT',[BAR]:'',产品名称:'Radio Bluetooth',数量:5,实际数量:''},
  {[MODEL]:'EAR-i64BT',[BAR]:'',产品名称:'Audifonos',数量:10,实际数量:''},
  {[MODEL]:'LED-936',[BAR]:'6901234567890',产品名称:'Luces',数量:20,实际数量:''}
];

test('供应商的“条形码CODIGO DE BARRA”列能被识别为条码列',()=>{
  const c=env(sheet());
  assert.equal(c.barcodeColumnKeys().length,1);
  assert.equal(c.barcodeColumnKeys()[0],BAR);
  assert.equal(c.modelColumnKeys().length,1);
  assert.equal(c.modelColumnKeys()[0],MODEL);
});

test('条码列空着时，用型号列精确匹配 Code 128 的内容',()=>{
  const c=env(sheet());
  assert.equal(c.handleBarcode('VX-2316BT',true),true);
  assert.deepEqual(c.__calls.jump,[0]);
});

test('字母码忽略大小写，但仍要求全等',()=>{
  const c=env(sheet());
  assert.equal(c.findStrictBarcodeRow('vx-2316bt'),0,'case-insensitive');
  assert.equal(c.findStrictBarcodeRow('VX-2316'),-1,'partial must not match');
  assert.equal(c.findStrictBarcodeRow('VX-2316BTX'),-1);
});

test('该行已有真条码时，不许用型号兜底',()=>{
  const c=env(sheet());
  assert.equal(c.findStrictBarcodeRow('LED-936'),-1,'row 3 has a real barcode');
  assert.equal(c.handleBarcode('LED-936',true),false);
  assert.equal(c.handleBarcode('6901234567890',true),true,'the real barcode still works');
  assert.deepEqual(c.__calls.jump,[2]);
});

test('连扫计数：型号兜底属于精确命中，可以 +1（片段匹配才禁止计数）',()=>{
  const c=env(sheet());c.scanCountMode=true;
  assert.equal(c.handleBarcode('VX-2316BT',true),true);
  assert.equal(c.db[0]['实际数量'],1,'exact model match counts');
  assert.equal(c.__calls.stop.length,0,'camera stays open');
  assert.equal(c.__calls.jump.length,0);
});

test('扫到的值在表里根本不存在时，仍然明确报不存在',()=>{
  const c=env(sheet());
  assert.equal(c.handleBarcode('ZZ-9999',true),false);
  assert.equal(c.__calls.notFound.length,1);
  assert.equal(c.__calls.jump.length,0);
});

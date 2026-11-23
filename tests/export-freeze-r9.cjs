'use strict';
/* v5.0.3 回归：导出的 xlsx 必须真的带冻结窗格（xlsx-js-style 的 ws['!freeze'] 会被忽略）。 */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ExcelJS=require('../vendor/exceljs-4.4.0.min.js');

function context(){
  const xlsxContext=vm.createContext({console,Date,Uint8Array,ArrayBuffer,TextDecoder,TextEncoder});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../vendor/xlsx-js-style-1.2.0.min.js'),'utf8'),xlsxContext);
  let captured=null;
  const c=vm.createContext({
    console:{info(){},warn(){},error(){}},window:{},document:{createElement(){return {click(){},remove(){},style:{}};},body:{appendChild(){}},getElementById(){return null;}},
    navigator:{userAgent:'node-test'},localStorage:{getItem(){return null;},setItem(){}},
    ExcelJS,XLSX:xlsxContext.XLSX,Blob,Uint8Array,ArrayBuffer,Date,JSON,Math,Number,String,Array,Object,Map,Set,
    setTimeout(){return 0;},clearTimeout(){},
    URL:{createObjectURL(b){captured=b;return 'blob:test';},revokeObjectURL(){}},
    showToast(){},btoa:v=>Buffer.from(v,'binary').toString('base64'),atob:v=>Buffer.from(v,'base64').toString('binary')
  });
  for(const f of ['core.js','images.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/'+f),'utf8'),c,{filename:f});
  c.db=[{'条码':'7501234567890','商品名称':'A','数量':10,'实际数量':3},{'条码':'7509876543210','商品名称':'B','数量':4,'实际数量':''}];
  c.columns=['条码','商品名称','数量','实际数量'];
  c.getRowPictures=()=>[];
  Object.defineProperty(c,'capturedBlob',{get(){return captured;}});
  return c;
}

test('export writes a workbook whose header rows are really frozen',async()=>{
  const c=context();
  const aoa=[['飞速盘点'],['条码','商品名称','数量','实际数量'],['7501234567890','A',10,3]];
  const ws=c.XLSX.utils.aoa_to_sheet(aoa);
  ws['!freeze']={xSplit:0,ySplit:2,topLeftCell:'A3',activePane:'bottomLeft',state:'frozen'};
  const wbIn=c.XLSX.utils.book_new();
  c.XLSX.utils.book_append_sheet(wbIn,ws,'盘点结果');
  await c.writeWorkbookWithImages(wbIn,'盘点.xlsx');
  const blobBytes=new Uint8Array(await c.capturedBlob.arrayBuffer());
  assert.ok(blobBytes.length>1000,'workbook bytes captured');
  const wb=new ExcelJS.Workbook();
  await wb.xlsx.load(blobBytes);
  const views=wb.worksheets[0].views||[];
  assert.equal(views.length>0,true,'sheet has a view');
  assert.equal(views[0].state,'frozen','freeze state survives the round trip');
  assert.equal(views[0].ySplit,2,'first two rows stay visible');
});

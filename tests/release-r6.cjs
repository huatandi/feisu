'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ExcelJS=require('../vendor/exceljs-4.4.0.min.js');
const xlsxContext=vm.createContext({console,Date,Uint8Array,ArrayBuffer,TextDecoder,TextEncoder});vm.runInContext(fs.readFileSync(path.join(__dirname,'../vendor/xlsx-js-style-1.2.0.min.js'),'utf8'),xlsxContext);const XLSX=xlsxContext.XLSX;
const root=path.join(__dirname,'..');
function code(c,n){vm.runInContext(fs.readFileSync(path.join(root,'js',n+'.js'),'utf8'),c,{filename:n});}
function camera(){
 const elements={video:{style:{},srcObject:null},scanUI:{style:{}},scanFrame:{style:{}},enhanceBadge:{classList:{toggle(){}}}};
 const timers=new Map();let timer=0,decoderCalls=0;
 class Reader{reset(){this.stopped=true;}async decodeFromStream(stream){decoderCalls++;elements.video.srcObject=stream;}}
 const c=vm.createContext({window:{},navigator:{mediaDevices:{enumerateDevices:async()=>[]}},localStorage:{getItem(){return '';},setItem(){}},console:{info(){},error(){}},setTimeout(fn){timers.set(++timer,fn);return timer;},clearTimeout(id){timers.delete(id);},document:{getElementById(id){return elements[id]||null;}},Map,Uint32Array,Date});
 code(c,'scanner');Object.assign(c,{scanning:false,reader:null,cameraTrack:null,isIPad:false,enhanceMode:false,showToast(){},consecutiveFailures:0,ZXing:{BrowserMultiFormatReader:Reader,DecodeHintType:{},BarcodeFormat:{}},resetQuaggaRecovery(){}});
 return {c,elements,timers,get decoderCalls(){return decoderCalls;}};
}
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function stream(){const track={stopped:false,stop(){this.stopped=true;}};return {track,getTracks(){return [track];},getVideoTracks(){return [track];}};}
test('camera permission resolves after stop: release stream before attaching decoder',async()=>{
 const e=camera(),pending=deferred(),s=stream();e.c.navigator.mediaDevices.getUserMedia=()=>pending.promise;
 const start=e.c.startScanning();e.c.stopScanning();pending.resolve(s);await start;
 assert.equal(s.track.stopped,true);assert.equal(e.decoderCalls,0);assert.equal(e.elements.video.srcObject,null);assert.equal(e.c.scanning,false);
});
test('old camera request rejection cannot stop a new scan session',async()=>{
 const e=camera(),pending=deferred();e.c.navigator.mediaDevices.getUserMedia=()=>pending.promise;
 const start=e.c.startScanning();e.c.stopScanning();e.c.scannerRecoveryEpoch++;e.c.scanning=true;
 const newReader={reset(){throw Error('must not reset current reader');}};e.c.reader=newReader;
 pending.reject(Error('old request rejected'));await start;assert.equal(e.c.scanning,true);assert.equal(e.c.reader,newReader);
});
test('closing scan during delayed camera enumeration cannot schedule restart',async()=>{
 const e=camera(),pending=deferred();e.c.scanning=true;e.c.navigator.mediaDevices.enumerateDevices=()=>pending.promise;
 const cycle=e.c.cycleCamera();e.c.stopScanning();pending.resolve([{kind:'videoinput',deviceId:'one'},{kind:'videoinput',deviceId:'two'}]);await cycle;
 assert.equal(e.c.cameraRestartTimer,null);assert.equal(e.c.scanning,false);assert.equal(e.c.cameraSwitching,false);
});
test('closing scan cancels a queued lens switch restart',async()=>{
 const e=camera();e.c.scanning=true;e.c.navigator.mediaDevices.enumerateDevices=async()=>[{kind:'videoinput',deviceId:'one'},{kind:'videoinput',deviceId:'two'}];
 await e.c.cycleCamera();assert.ok(e.c.cameraRestartTimer);e.c.stopScanning();for(const fn of e.timers.values())fn();assert.equal(e.c.scanning,false);assert.equal(e.c.cameraRestartTimer,null);
});
function imports(primary=true){const c=vm.createContext({window:{ExcelJS,...(primary?{XLSX}:{})},ExcelJS,...(primary?{XLSX}:{}),console,Date,Uint8Array,ArrayBuffer});code(c,'import-export');return c;}
test('columns first populated after row 30 are retained',()=>{
 const c=imports(),aoa=[['条码','名称']];for(let n=0;n<40;n++)aoa.push(['5901234123457','商品']);aoa[40][3]='后段备注';
 const p=c.sourceRowsFromArray(aoa,0);assert.equal(p.headers.length,4);assert.equal(p.rows.at(-1)[p.headers[3]],'后段备注');
});
for(const primary of [true,false])test((primary?'XLSX':'ExcelJS')+' preserves numeric barcode zero format without converting quantity to text',async()=>{
 const wb=new ExcelJS.Workbook(),s=wb.addWorksheet('商品');s.addRow(['条码','名称','数量']);s.addRow([12345678905,'商品',7]);s.getCell('A2').numFmt='0000000000000';
 const c=imports(primary),r=await c.parseExcelWithFallback(await wb.xlsx.writeBuffer(),'xlsx');assert.equal(r.parsed.rows[0]['条码'],'0012345678905');assert.equal(r.parsed.rows[0]['数量'],7);
});
test('non-A worksheet origin preserves barcode formatting and image-column mapping',async()=>{
 const wb=new ExcelJS.Workbook(),s=wb.addWorksheet('商品');s.getCell('C4').value='条码';s.getCell('D4').value='名称';s.getCell('C5').value=123;s.getCell('C5').numFmt='00000000';s.getCell('D5').value='测试';
 const c=imports(),r=await c.parseExcelWithFallback(await wb.xlsx.writeBuffer(),'xlsx');assert.equal(r.parsed.sourceColumnOffset,2);assert.equal(r.parsed.rows[0]['条码'],'00000123');assert.equal(r.parsed.sourceRowNumbers[0],4);
 const pixel='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lJkAAAAASUVORK5CYII=';
 const id=wb.addImage({base64:pixel,extension:'png'});s.addImage(id,{tl:{col:3,row:4},ext:{width:1,height:1}});
 c.btoa=v=>Buffer.from(v,'binary').toString('base64');code(c,'images');await c.importEmbeddedImages(await wb.xlsx.writeBuffer(),r.parsed,0);
 assert.equal(r.parsed.rows[0].__feisuImages['名称'][0].extension,'png');
});
test('all local HTML dependencies exist; all project JS compiles; no merge markers remain',()=>{
 const {execFileSync}=require('node:child_process');const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
 for(const match of html.matchAll(/(?:src|href)="\.\/([^"?]+)(?:\?[^"]*)?"/g))assert.ok(fs.existsSync(path.join(root,match[1])),match[1]);
 for(const dir of ['js','tests'])for(const f of fs.readdirSync(path.join(root,dir))){if(!/\.(js|cjs)$/.test(f))continue;const p=path.join(root,dir,f);assert.doesNotMatch(fs.readFileSync(p,'utf8'),/^(?:<{7}|={7}|>{7})(?: |$)/m,p);execFileSync(process.execPath,['--check',p]);}
 assert.match(html,/v5\.0\.3 · 框内识别版 R9/);assert.match(fs.readFileSync(path.join(root,'js/core.js'),'utf8'),/v5\.0\.3 · R9/);
});

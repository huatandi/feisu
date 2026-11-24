'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function env(){let wall=10000,work=0,spent=20,fail=false;const draws=[];const ctx={drawImage(...a){draws.push(a);}};const c=vm.createContext({window:{},document:{getElementById(){return null;},createElement(){return {width:0,height:0,getContext(){return ctx;}};}},navigator:{},localStorage:{getItem(){return '';},setItem(){}},console:{info(){}},performance:{now(){return work;}},Date:{now(){return wall;}},setTimeout(){},clearTimeout(){},Map,Uint32Array});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/scanner.js'),'utf8'),c);Object.assign(c,{enhanceMode:false,scanning:true,cameraTrack:null,VERSION:'R8',getFrameROI(){return {x:300,y:300,w:1000,h:300};},ZXing:{DecodeHintType:{TRY_HARDER:'harder'},BinaryBitmap:class{constructor(b){this.b=b;}},HybridBinarizer:class{constructor(s){this.s=s;}},HTMLCanvasElementLuminanceSource:class{constructor(canvas){this.canvas=canvas;}}}});
 const video={videoWidth:1920,videoHeight:1080},target={__scannerHints:new Map(),reader:{setHints(h){this.hints=h;}},decode(){work+=spent;return 'full';},decodeBitmap(bitmap){work+=spent;if(fail)throw Error('not found');return 'roi';}};
 c.installPrimaryROIDecoder(target,video,{});return {c,target,video,draws,advance(ms){wall+=ms;},cost(ms){spent=ms;},fail(){fail=true;}};
}
test('primary decoder crops before decoding and reuses a native-resolution canvas',()=>{
 const e=env();assert.equal(e.target.decode(e.video),'roi');assert.equal(e.draws.length,1);const a=e.draws[0];assert.equal(a[3],a[7]);assert.equal(a[4],a[8]);assert.ok(a[3]*a[4]<1920*1080);const d=e.c.scannerDiagnostics();assert.equal(d.roiFrames,1);assert.equal(d.fullFrames,0);assert.equal(d.meanDecodeMs,20);
});
test('no periodic full-frame pass while the ROI is available (it would decode pixels nobody sees)',()=>{
 const e=env();assert.equal(e.target.decode(e.video),'roi');e.advance(3500);assert.equal(e.target.decode(e.video),'roi');e.advance(5000);assert.equal(e.target.decode(e.video),'roi');
 assert.equal(e.c.scannerDiagnostics().fullFrames,0);
});
test('slow failed decodes increase the retry wait and still record their cost',()=>{
 const e=env();e.cost(150);e.fail();assert.throws(()=>e.target.decode(e.video));assert.ok(e.target.timeBetweenDecodingAttempts>=278);assert.equal(e.c.scannerDiagnostics().meanDecodeMs,150);
});
test('primary path keeps TRY_HARDER off (15 rows) and preserves other hints',()=>{
 const e=env();e.target.__scannerHints.set('formats','oneD');
 e.c.configurePrimaryScanHints(e.target);
 assert.equal(e.target.reader.hints.has('harder'),false,'full-row scanning measured 3.8x slower on device');
 assert.equal(e.target.reader.hints.get('formats'),'oneD');
 e.c.enhanceMode=true;e.c.configurePrimaryScanHints(e.target);assert.equal(e.target.reader.hints.has('harder'),false);
 e.c.enhanceMode=false;e.c.configurePrimaryScanHints(e.target);assert.equal(e.target.reader.hints.has('harder'),false);
});
test('full-frame path still invalidates the ZXing capture cache when no ROI is available',()=>{
 const e=env();let reset=0;e.c.getFrameROI=()=>null;e.target.captureCanvas={width:1280,height:720};e.target._destroyCaptureCanvas=()=>reset++;
 assert.equal(e.target.decode(e.video),'full');assert.equal(reset,1);
});
test('diagnostics contain measured timings and actual camera settings without barcode data',()=>{
 const e=env();e.c.cameraTrack={getSettings(){return {width:1920,height:1080,frameRate:18,deviceId:'DO-NOT-COPY',torch:false};}};e.target.decode(e.video);e.advance(1000);const d=e.c.scannerDiagnostics();assert.equal(d.camera.width,1920);assert.equal(d.camera.fps,18);assert.equal(d.primaryTimeShare,2);assert.doesNotMatch(JSON.stringify(d),/DO-NOT-COPY/);
});

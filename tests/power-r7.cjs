'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function environment(){let now=10000;const saved=new Map(),timers=new Map();let id=0;const ui={style:{},classList:{toggle(){}}};const c=vm.createContext({console:{info(){},error(){}},window:{},document:{hidden:false,getElementById(k){return k==='scanUI'?ui:null;}},navigator:{mediaDevices:{}},localStorage:{getItem(k){return saved.get(k)||null;},setItem(k,v){saved.set(k,v);}},Date:{now(){return now;}},setTimeout(fn){timers.set(++id,fn);return id;},clearTimeout(id){timers.delete(id);},Map,Uint32Array});vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/scanner.js'),'utf8'),c);Object.assign(c,{scanning:true,scanStartedAt:0,scannerRecoveryLastSuccess:0,enhanceMode:false,cameraTrack:null,reader:null,showToast(){},consecutiveFailures:0,requestStallFocus(){},getFrameROI(){return {x:0,y:0,w:100,h:50};}});return {c,saved,timers,advance(n){now+=n;},video:{readyState:2,currentTime:1}};}
const pending=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
test('default balanced profile retains 1080p and continuous focus; saving and enhancement remain available',()=>{
 const {c}=environment(),p=c.cameraConstraints().video;assert.equal(p.width.ideal,1920);assert.equal(p.height.ideal,1080);assert.equal(p.frameRate.ideal,18);assert.equal(p.advanced[0].focusMode,'continuous');assert.equal(c.scannerPowerProfile().retry,110);c.scannerPowerSave=true;assert.equal(c.cameraConstraints().video.width.ideal,1280);assert.equal(c.cameraConstraints().video.frameRate.ideal,15);
 c.enhanceMode=true;const h=c.cameraConstraints().video;assert.equal(h.width.ideal,1920);assert.equal(h.frameRate.ideal,24);assert.equal(c.scannerPowerProfile().saving,false);
});
test('unsupported frame-rate cap retries without the cap instead of failing to open camera',async()=>{
 const {c}=environment();let calls=0;c.navigator.mediaDevices.getUserMedia=async a=>{calls++;if(calls===1){assert.equal(a.video.frameRate.max,24);const e=Error('fixed FPS');e.name='OverconstrainedError';throw e;}assert.equal(a.video.frameRate.max,undefined);return {ok:true};};assert.equal((await c.getScannerCameraStream()).ok,true);assert.equal(calls,2);
});
test('a pending recovery prevents every other engine from running concurrently',async()=>{
 const e=environment(),wait=pending(),calls=[];e.c.tryEnhancedDecode=async()=>{calls.push('decode');return wait.promise;};e.c.tryQuaggaRecovery=async()=>calls.push('quagga');e.c.trySheetFragmentAssist=async()=>calls.push('fragment');
 const work=e.c.launchSupplementalRecovery(e.video,{});e.advance(2000);e.video.currentTime++;await e.c.launchSupplementalRecovery(e.video,{});assert.deepEqual(calls,['decode']);wait.resolve(null);await work;assert.equal(e.c.scannerRecoveryJob,null);
});
test('same frame and cooldown do not create extra recovery work',async()=>{
 const e=environment();let count=0;e.c.tryEnhancedDecode=async()=>{count++;return null;};e.c.tryQuaggaRecovery=async()=>{count++;return null;};
 await e.c.launchSupplementalRecovery(e.video,{});e.advance(1100);await e.c.launchSupplementalRecovery(e.video,{});assert.equal(count,1);
 e.video.currentTime++;await e.c.launchSupplementalRecovery(e.video,{});assert.equal(count,2);e.advance(500);e.video.currentTime++;await e.c.launchSupplementalRecovery(e.video,{});assert.equal(count,2);
});
test('recovery rotation preserves close-in-time Quagga pairs and fragment triples',async()=>{
 const e=environment(),calls=[];e.c.scannerPowerSave=true;e.c.tryEnhancedDecode=async()=>{calls.push('decode');return null;};e.c.tryQuaggaRecovery=async()=>{calls.push('quagga');return null;};e.c.trySheetFragmentAssist=async()=>{calls.push('fragment');};
 for(let i=0;i<6;i++){await e.c.launchSupplementalRecovery(e.video,{});e.advance(1000);e.video.currentTime++;}
 assert.deepEqual(calls,['decode','quagga','quagga','fragment','fragment','fragment']);
});
test('hung WASM loader cannot block local rotated fallback',async()=>{
 const e=environment();e.c.getEnhancedDetector=()=>new Promise(()=>{});e.c.tryLocalTiltRecovery=()=> '5901234123457';assert.equal(await e.c.tryEnhancedDecode(e.video,{}),'5901234123457');assert.equal(e.c.enhancedDecodeBusy,false);
});
test('one native recovery tick performs one detection, not raw+contrast+rotation together',async()=>{
 const e=environment();let calls=0;e.c.enhancedDetector={async detect(){calls++;return [];}};e.c.captureROI=()=>({});e.c.tryTiltRecovery=async()=>{calls++;return null;};
 for(let i=0;i<3;i++){await e.c.tryEnhancedDecode(e.video,{});assert.equal(calls,i+1);}
});
test('old recovery result cannot affect a newer camera session',async()=>{
 const e=environment(),wait=pending();let accepts=0;e.c.tryEnhancedDecode=()=>wait.promise;e.c.acceptDecodedBarcode=()=>accepts++;const work=e.c.launchSupplementalRecovery(e.video,{});e.c.scannerRecoveryEpoch++;wait.resolve('5901234123457');await work;assert.equal(accepts,0);
});
test('background transition cancels queued lens restart even when scanning=false',()=>{
 const e=environment();e.c.scanning=false;e.c.cameraSwitching=true;e.c.cameraRestartTimer=e.c.setTimeout(()=>{throw Error('must be cancelled');});assert.equal(e.c.stopScannerForBackground(),true);assert.equal(e.c.cameraRestartTimer,null);assert.equal(e.c.cameraSwitching,false);assert.equal(e.timers.size,0);
});
test('return from enhancement to balanced mode without altering count cooldown',()=>{
 const e=environment();e.c.SCAN_INCREMENT_COOLDOWN=650;e.c.enhanceMode=true;e.c.scannerPowerSave=true;e.c.toggleScannerPower();assert.equal(e.c.enhanceMode,false);assert.equal(e.c.scannerPowerSave,false);assert.equal(e.saved.get('sanfei_scanner_power'),'0');assert.equal(e.c.SCAN_INCREMENT_COOLDOWN,650);
});

test('scan line keeps moving in power-saving mode and uses transform animation',()=>{
 const css=fs.readFileSync(path.join(__dirname,'../css/app.css'),'utf8');
 assert.match(css,/@keyframes scanLineMove[^\n]*translate3d/);
 assert.doesNotMatch(css,/(?:\.scan-line|scanner-saving \.scan-line)\s*\{[^}]*animation\s*:\s*none/);
 assert.match(css,/animation: scanLineMove 1\.2s infinite/);
});

test('balanced recovery preserves Quagga double-check and three fragment observations within their evidence windows',async()=>{
 const e=environment(),quaggaTimes=[],fragmentTimes=[];e.c.tryEnhancedDecode=async()=>null;e.c.tryQuaggaRecovery=async()=>{quaggaTimes.push(e.c.Date.now());return null;};e.c.trySheetFragmentAssist=async()=>{fragmentTimes.push(e.c.Date.now());};
 for(let i=0;i<9;i++){await e.c.launchSupplementalRecovery(e.video,{});e.advance(650);e.video.currentTime++;}
 assert.equal(quaggaTimes.length,2);assert.ok(quaggaTimes[1]-quaggaTimes[0]<2500);assert.equal(fragmentTimes.length,3);assert.ok(fragmentTimes[1]-fragmentTimes[0]<1800);assert.ok(fragmentTimes[2]-fragmentTimes[1]<1800);
});

'use strict';
/* R8.1 视场对齐回归：预览画面与取景框必须是同一个矩形，
   竖屏里加宽左右、压低上下，而不是把 16:9 画面裁成竖条。 */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');

function layoutEnv(opt){
  opt=opt||{};
  const w=opt.w||390,h=opt.h||772;
  const props={};
  const ui={style:{setProperty(k,v){props[k]=v;}}};
  const video={videoWidth:opt.vw||1920,videoHeight:opt.vh||1080,parentElement:{clientWidth:w,clientHeight:h}};
  const frame={};
  const c=vm.createContext({
    console:{info(){}},
    window:{},
    document:{getElementById(id){return id==='video'?video:id==='scanFrame'?frame:id==='scanUI'?ui:null;}},
    navigator:{},localStorage:{getItem(){return '';},setItem(){}},
    performance:{now(){return 0;}},Date:{now(){return 0;}},
    setTimeout(){return 0;},clearTimeout(){},Map,Uint32Array
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/scanner.js'),'utf8'),c);
  return {c,props,video,native:{w,h}};
}
const num=(props,key)=>parseFloat(String(props[key]||'0'));

test('preview width fills the phone screen instead of a cropped vertical strip',()=>{
  const e=layoutEnv(),box=e.c.scanViewLayout(),w=num(e.props,'--scan-view-w'),h=num(e.props,'--scan-view-h');
  assert.equal(box.w,w);assert.ok(w>=e.native.w*0.94,'frame keeps at least 94% of the viewport width');
  assert.ok(Math.abs(w/h-1920/1080)<0.02,'height follows the real stream aspect, no squeezing');
  assert.ok(h<260,'portrait screens get a shorter window, not a narrower one');
});

test('frame centre stays inside the usable band between the hint and the tool buttons',()=>{
  const e=layoutEnv(),box=e.c.scanViewLayout(),centre=num(e.props,'--scan-view-center');
  assert.equal(box.center,centre);
  assert.ok(centre-box.h/2>=40,'top of the window clears the "keep steady" hint');
  assert.ok(centre+box.h/2<=e.native.h-40,'bottom of the window clears the scan controls');
});

test('tablet / landscape viewport shrinks to the available height instead of overflowing',()=>{
  const e=layoutEnv({w:1024,h:520}),box=e.c.scanViewLayout();
  assert.ok(box.w<=1024&&box.h<=520-46);
  assert.ok(Math.abs(box.w/box.h-16/9)<0.02);
});

test('a portrait camera track still gets a horizontal window (cover crops the sides, not the frame)',()=>{
  const e=layoutEnv({vw:720,vh:1280}),box=e.c.scanViewLayout();
  assert.ok(box.aspect>=1.5,'a portrait stream must not turn the aiming window into a portrait slot');
});

test('layout recomputes when the camera resolution changes after a power-profile switch',()=>{
  const e=layoutEnv();
  e.c.scanViewLayout();const before=num(e.props,'--scan-view-h');
  e.video.videoWidth=1280;e.video.videoHeight=720;
  e.c.scanViewLayout();const after=num(e.props,'--scan-view-h');
  assert.equal(before,after,'16:9 -> 16:9 keeps the same geometry');
  e.video.videoWidth=640;e.video.videoHeight=480;
  e.c.scanViewLayout();
  assert.ok(Math.abs(num(e.props,'--scan-view-w')/num(e.props,'--scan-view-h')-640/480)<0.02,'4:3 stream gets a 4:3 window');
});

test('scan line travel follows the new window height',()=>{
  const e=layoutEnv(),box=e.c.scanViewLayout();
  assert.equal(num(e.props,'--scan-line-travel'),Math.round(box.h-26));
});

/* --- decode-side consequence: the frame IS the ROI, so the old periodic
       full-frame pass would decode exactly the same pixels twice. --- */
function decoderEnv(roi){
  const ctx={drawImage(){}};let wall=10000;
  const c=vm.createContext({
    window:{},document:{getElementById(){return null;},createElement(){return {width:0,height:0,getContext(){return ctx;}};}},
    navigator:{},localStorage:{getItem(){return '';},setItem(){}},console:{info(){}},
    performance:{now(){return 0;}},Date:{now(){return wall;}},setTimeout(){},clearTimeout(){},
    Map,Uint32Array
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/scanner.js'),'utf8'),c);
  Object.assign(c,{enhanceMode:false,scanning:true,cameraTrack:null,VERSION:'R8.1',getFrameROI(){return roi;},ZXing:{DecodeHintType:{TRY_HARDER:'harder'},BinaryBitmap:class{constructor(b){this.b=b;}},HybridBinarizer:class{constructor(s){this.s=s;}},HTMLCanvasElementLuminanceSource:class{constructor(x){this.canvas=x;}}}});
  const video={videoWidth:1920,videoHeight:1080},target={__scannerHints:new Map(),reader:{setHints(){}},decode(){return 'full';},decodeBitmap(){return 'roi';}};
  c.installPrimaryROIDecoder(target,video,{});
  return {c,target,video,advance(ms){wall+=ms;}};
}

test('full-width frame skips the redundant periodic full-frame decode',()=>{
  const e=decoderEnv({x:0,y:0,w:1920,h:1080});
  assert.equal(e.target.decode(e.video),'roi');
  e.advance(6000);
  assert.equal(e.target.decode(e.video),'roi');
  assert.equal(e.c.scannerDiagnostics().fullFrames,0,'no second pass over the same pixels');
  assert.equal(e.c.scannerDiagnostics().roiFrames,2);
});

test('no periodic full-frame pass even for a narrow ROI',()=>{
  const e=decoderEnv({x:300,y:300,w:400,h:300});
  assert.equal(e.target.decode(e.video),'roi');
  e.advance(6000);
  assert.equal(e.target.decode(e.video),'roi');
  assert.equal(e.c.scannerDiagnostics().fullFrames,0);
});

test('iPad 视口下取景框收窄到 620px 以内',()=>{
  const e=layoutEnv({w:1024,h:900});
  const box=e.c.scanViewLayout();
  assert.ok(box.w<=620,'tablet aiming window must be capped');
  assert.ok(box.w>=400,'but still usable');
});

test('竖屏流时视频元素按覆盖尺寸放大（高于取景框），用于消除黑边',()=>{
  const e=layoutEnv({vw:1080,vh:1920});
  e.c.scanViewLayout();
  const fh=parseFloat(e.props['--scan-view-h']), vh=parseFloat(e.props['--scan-video-h']);
  assert.ok(vh>fh*1.5,'video element must be taller than the frame for a portrait stream');
  assert.equal(parseFloat(e.props['--scan-video-w']),parseFloat(e.props['--scan-view-w']),'width stays with the frame');
});

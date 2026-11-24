'use strict';
/* v5.1 回归：解码格式分级 + 分段 ROI 覆盖 */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');

function env(){
  const seen=[],draws=[];
  const ctx={drawImage(){draws.push({sx:arguments[1],sy:arguments[2],sw:arguments[3],sh:arguments[4],dw:arguments[7],dh:arguments[8]});}};
  const c=vm.createContext({
    window:{},document:{getElementById(){return null;},createElement(){return {width:0,height:0,getContext(){return ctx;}};}},
    navigator:{},localStorage:{getItem(){return '';},setItem(){}},console:{info(){}},
    performance:{now(){return 0;}},Date:{now(){return 10000;}},setTimeout(){},clearTimeout(){},Map,Uint32Array
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/scanner.js'),'utf8'),c);
  Object.assign(c,{
    enhanceMode:false,scanning:true,cameraTrack:null,VERSION:'R16',
    getFrameROI(){return {x:0,y:656,w:1080,h:607};},      /* 竖屏：可见框 1080x607 */
    ZXing:{
      DecodeHintType:{TRY_HARDER:'harder',POSSIBLE_FORMATS:'formats'},
      BarcodeFormat:{EAN_13:'EAN_13',EAN_8:'EAN_8',UPC_A:'UPC_A',UPC_E:'UPC_E',CODE_39:'CODE_39',CODE_93:'CODE_93',CODE_128:'CODE_128',ITF:'ITF',CODABAR:'CODABAR'},
      BinaryBitmap:class{constructor(b){this.b=b;}},HybridBinarizer:class{constructor(s){this.s=s;}},
      HTMLCanvasElementLuminanceSource:class{constructor(x){this.canvas=x;}}
    }
  });
  const video={videoWidth:1080,videoHeight:1920};
  const target={__scannerHints:new Map([['x',1]]),reader:{hints:null,setHints(h){this.hints=h;const f=h&&h.get('formats');if(f)seen.push(f);}},decode(){return 'full';},decodeBitmap(){return 'roi';}};
  c.installPrimaryROIDecoder(target,video,{});
  return {c,target,video,seen,draws};
}

test('前两次用“常用 5 种”格式，每第 3 次才升到全 9 种',()=>{
  const e=env();
  for(let i=0;i<6;i++) e.target.decode(e.video);
  const lens=e.seen.map(f=>f.length);
  assert.equal(lens.length>=6,true,'formats must be re-applied on every attempt');
  assert.equal(lens[0],5,'first attempt = cheap set');
  assert.equal(lens[1],5);
  assert.equal(lens[2],9,'third attempt = every format');
  assert.equal(lens[3],5);
});

test('常用集合包含 Code 128 与 EAN-13（供应商条码 + 零售包装）',()=>{
  const e=env();
  e.target.decode(e.video);
  const fm=e.seen[0];
  assert.ok(fm.indexOf('CODE_128')>=0);
  assert.ok(fm.indexOf('EAN_13')>=0);
  assert.ok(fm.indexOf('CODABAR')<0,'Codabar is not on the fast path');
});

test('分段 ROI 轮换并覆盖框的上下不同位置',()=>{
  const e=env();
  for(let i=0;i<4;i++) e.target.decode(e.video);
  const tops=e.draws.map(d=>d.sy), bottoms=e.draws.map(d=>d.sy+d.sh);
  assert.equal(new Set(tops).size>=2,true,'bands must differ');
  assert.ok(Math.min.apply(null,tops)<=660,'covers the top of the frame');
  assert.ok(Math.max.apply(null,bottoms)>=1250,'covers the bottom of the frame');
});

test('段内宽度封顶 800，且保持段本身的宽高比',()=>{
  const e=env();
  e.target.decode(e.video);
  const d=e.draws[0];
  assert.ok(d.dw<=800,'width capped');
  assert.ok(Math.abs(d.dw/d.dh - d.sw/d.sh) < 0.05,'no distortion');
});

'use strict';
var enhancedDetector=null,enhancedDetectorPromise=null,enhancedDecodeBusy=false,lastEnhancedAttempt=0,focusResetTimer=null,currentZoom=1;
var cameraDevices=[],selectedCameraId=localStorage.getItem('sanfei_camera_id')||'',cameraSwitching=false,cameraRestartTimer=null;
var scanStartedAt=0,qualityUpgradeTimer=null,detectorWarmTimer=null,highQualityApplied=false;
var focusKickTimers=[];
var scannerPowerSave=false;
try{scannerPowerSave=localStorage.getItem('sanfei_scanner_power')==='1';}catch(e){}
var scannerRecoveryJob=null,scannerRecoveryLastAt=0,scannerRecoveryMisses=0,scannerSuccessCount=0;
function scannerRecoveryGap(){var p=scannerPowerProfile(),g=p.recoveryGap;
  if(scannerRecoveryMisses>=10)g*=5;else if(scannerRecoveryMisses>=6)g*=3;else if(scannerRecoveryMisses>=3)g*=2;
  return Math.min(g,5000);}
var scannerRecoveryPhase=0,scannerRecoveryFrameTime=null,scannerEnhancedPhase=0,scannerRecoveryStarts=0;
var scannerProfilePending=Promise.resolve();
var scannerPrimaryStats=null;
function scannerClock(){return typeof performance!=='undefined'&&performance.now?performance.now():Date.now();}
/* v5.0.4：主路径一律开启 TRY_HARDER。
   真机反馈“条码一倾斜就不识别”，根因就是 R8 为省电去掉了它：
   ZXing 没有 TRY_HARDER 时只取中间一行，条码倾斜后中线切不到完整码就必失败。
   现在主路径只解框内小区域（约 0.6–0.9 MP），开 TRY_HARDER 的代价可接受；
   整幅补扫（若发生）则不开，避免回到 R8 之前的整屏高开销。 */
function configurePrimaryScanHints(target){
  if(!target||!target.__scannerHints||!target.reader||typeof target.reader.setHints!=='function')return;
  /* 不启用 TRY_HARDER：zxing 的 OneDReader 在无此提示时取 15 行（每 h/32 一行，覆盖中部约 44%），
     启用后会扫到 height 行（真机实测单次 35ms→134ms，识别率无改善）。
     行覆盖不足的问题改用“分段解码”解决：每次只解框内的一个横向条带，行距更密且像素更少。 */
  target.__scannerHints.delete(ZXing.DecodeHintType.TRY_HARDER);
  target.reader.setHints(target.__scannerHints);target.__scannerHarder=false;
}
var SCAN_ROI_MAX_WIDTH=800,SCAN_ROI_MAX_WIDTH_HI=1000,SCAN_MAX_WIDTH_WIDE=620,scanBandIndex=0;
/* 段序：中→上→中→下（条码多数居中，中心权重加倍）。段高约框高的 42%，带重叠避免切断条码。 */
var SCAN_BANDS=[1,0,2,1],SCAN_BAND_COUNT=3;   /* v5.1.6：中心→上→下→中心 */
function primaryBandROI(v,f){
  var r=getFrameROI(v,f);
  if(!r)return null;
  var padX=Math.round(r.w*.02);
  var y0=r.y,h0=r.h;
  var band=SCAN_BANDS[scanBandIndex++%SCAN_BANDS.length];
  var bh=Math.max(64,Math.round(h0*.62));   /* v5.1.6：56%→62%，行距更密 */
  if(h0<=bh*1.2){                                  /* 框本来就很矮：不值得切 */
    var xw=Math.max(0,r.x-padX);
    return {x:xw,y:y0,w:Math.min(v.videoWidth,r.x+r.w+padX)-xw,h:h0,band:-1};
  }
  var centers=[y0+Math.round(h0*.2),y0+Math.round(h0*.5),y0+Math.round(h0*.8)];
  var y=Math.max(0,Math.min(v.videoHeight-bh,centers[band]-Math.round(bh/2)));
  var x=Math.max(0,r.x-padX);
  return {x:x,y:y,w:Math.min(v.videoWidth,r.x+r.w+padX)-x,h:bh,band:band};
}
function primaryBarcodeROI(v,f){
  var r=getFrameROI(v,f);if(!r)return null;
  var px=Math.round(r.w*.06),py=Math.round(r.h*.25),x=Math.max(0,r.x-px),y=Math.max(0,r.y-py);
  return {x:x,y:y,w:Math.min(v.videoWidth,r.x+r.w+px)-x,h:Math.min(v.videoHeight,r.y+r.h+py)-y};
}
function installPrimaryROIDecoder(target,v,f){
  if(!target||typeof target.decode!=='function'||typeof target.decodeBitmap!=='function'||typeof document.createElement!=='function')return;
  var base=target.decode.bind(target),canvas=document.createElement('canvas'),ctx=canvas.getContext('2d',{willReadFrequently:true}),lastWide=Date.now();
  var stats={startedAt:0,stoppedAt:0,frames:0,roiFrames:0,fullFrames:0,totalMs:0,maxMs:0,pixels:0,lastMs:0,lastScope:''};scannerPrimaryStats=stats;
  target.decode=function(source){
    if(source!==v)return base(source);
    if(!stats.startedAt)stats.startedAt=Date.now();
    var started=scannerClock(),r=primaryBandROI(v,f),p=scannerPowerProfile(),wideGap=enhanceMode?2000:p.saving?5000:3500;
    /* v5.0.4：框内区域＝预览可见区域（竖屏轨道下也只占传感器 31%，见真机诊断 roiShare）。
       此时“整幅补扫”解的是用户看不见的像素，而且一次 2MP 解码在 iPhone 上要 110ms。
       只有在 ROI 缺失（拿不到取景框）时才退回整幅。 */
    var full=!r,pixels=0,restoreHints=null;
    try{
      if(full){if(target.captureCanvas&&(target.captureCanvas.width!==v.videoWidth||target.captureCanvas.height!==v.videoHeight)&&typeof target._destroyCaptureCanvas==='function')target._destroyCaptureCanvas();lastWide=Date.now();stats.fullFrames++;pixels=v.videoWidth*v.videoHeight;stats.lastScope='full';if(!enhanceMode&&target.__scannerHints&&target.reader&&typeof target.reader.setHints==='function'){var harderHints=new Map(target.__scannerHints);harderHints.set(ZXing.DecodeHintType.TRY_HARDER,true);restoreHints=target.__scannerHints;target.reader.setHints(harderHints);}return base(source);}
      /* v5.0.6：单次成本 ≈ (getImageData+灰度转换) + 15行×9格式×宽度，两条都与“宽度”成正比。
         真机 1080 宽段实测 34.5ms；段内宽压到 ≤800 后像素约 45%、行宽降 26%，
         条码占框 60% 时仍有 ~4.5 px/模块（可靠下限约 2）。缩小时用双线性，避免窄条锯齿。 */
      /* v5.1.2 精度升级：每第 8 次不缩小、开 TRY_HARDER、全格式。
         难读的条码（磨损/低对比/更远）走这一档，常规则保持便宜。 */
      /* v5.1.3：精度档改为“每第 12 次 + 上限 1000 + 全格式”，不再用原生宽度与 TRY_HARDER。
         实测精度档 171ms 是 maxDecodeMs 的来源，且拉高 meanDecodeMs。 */
      /* v5.1.6：每第 4 次走“硬档”——全格式 + TRY_HARDER + 宽度上限 1000。
         用一点耗电换难读条码的命中率（用户已确认接受）。 */
      var hard=(stats.frames%4===3);
      var scale=Math.min(1,(hard?SCAN_ROI_MAX_WIDTH_HI:SCAN_ROI_MAX_WIDTH)/r.w);
      var cw=Math.max(1,Math.round(r.w*scale)),ch=Math.max(1,Math.round(r.h*scale));
      if(canvas.width!==cw||canvas.height!==ch){canvas.width=cw;canvas.height=ch;}
      ctx.imageSmoothingEnabled=scale<1;
      if('imageSmoothingQuality' in ctx)ctx.imageSmoothingQuality='high';
      ctx.drawImage(v,r.x,r.y,r.w,r.h,0,0,cw,ch);
      stats.roiFrames++;pixels=cw*ch;stats.lastScope='roi';stats.band=r.band===undefined?-1:r.band;stats.scale=Math.round(scale*100)/100;
      /* v5.1 格式分级：现场基本只有 Code 128（供应商）和 EAN-13（零售包装）。
         9 种码制全部参与 15 行匹配，大半算力花在不会出现的码制上。
         常规尝试只给常用 5 种，每第 3 次给全 9 种兜底。 */
      try{
        if(target.reader&&typeof target.reader.setHints==='function'&&target.__scannerHints&&typeof ZXing!=='undefined'&&ZXing&&ZXing.BarcodeFormat){
          var bf=ZXing.BarcodeFormat,hintBase=target.__scannerHints,
              fm=[bf.EAN_13,bf.EAN_8,bf.UPC_A,bf.UPC_E,bf.CODE_128];
          if(hard)fm=[bf.EAN_13,bf.EAN_8,bf.UPC_A,bf.UPC_E,bf.CODE_39,bf.CODE_93,bf.CODE_128,bf.ITF,bf.CODABAR];
          var fmtHints=new Map(hintBase);
          fmtHints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS,fm);
          if(hard)fmtHints.set(ZXing.DecodeHintType.TRY_HARDER,true);
          target.reader.setHints(fmtHints);restoreHints=hintBase;
          if(hard)stats.hardFrames=(stats.hardFrames||0)+1; else stats.fastFrames=(stats.fastFrames||0)+1;
          if(useFull)stats.fullFormatFrames=(stats.fullFormatFrames||0)+1;
          else stats.fastFrames=(stats.fastFrames||0)+1;
        }
      }catch(e){}
      /* ---- 优先：交给后台线程解码（主线程不再被 30–100ms 的解码卡住） ---- */
      var wk=ensureDecodeWorker();
      if(wk){
        if(scanWorkerResult){var wr=scanWorkerResult;scanWorkerResult=null;stats.workerHits=(stats.workerHits||0)+1;return wr;}
        if(scanWorkerBusy&&Date.now()-scanWorkerSentAt>1500){scanWorkerBusy=false;scanWorkerFails+=2;}
        if(!scanWorkerBusy){
          try{
            var idata=ctx.getImageData(0,0,cw,ch);
            scanWorkerBusy=true;scanWorkerSentAt=Date.now();scanWorkerSeq++;
            wk.postMessage({id:scanWorkerSeq,w:cw,h:ch,buf:idata.data.buffer,
              formats:(typeof fm!=='undefined'&&fm)?fm:null,harder:!!hard},[idata.data.buffer]);
            stats.workerFrames=(stats.workerFrames||0)+1;
          }catch(e){scanDecodeWorker=null;scanWorkerBusy=false;}
        }
        /* 本轮还没有结果：按“未命中”处理，让 ZXing 继续轮询，下一轮来取 */
        throw new ZXing.NotFoundException();
      }
      var lumSrc=new ZXing.HTMLCanvasElementLuminanceSource(canvas);
      if(hard){try{if(stretchContrast(lumSrc))stats.contrastFrames=(stats.contrastFrames||0)+1;}catch(e){}}
      var bitmap=new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(lumSrc));
      try{
        return target.decodeBitmap(bitmap);
      }catch(err){
        /* 硬档兜底：换个二值化算法再试一次（同一块像素，不额外采集） */
        if(hard&&ZXing.GlobalHistogramBinarizer){
          try{return target.decodeBitmap(new ZXing.BinaryBitmap(new ZXing.GlobalHistogramBinarizer(lumSrc)));}catch(e2){}
        }
        throw err;
      }
    }finally{
      if(restoreHints)target.reader.setHints(restoreHints);
      var ms=Math.max(0,scannerClock()-started);stats.frames++;stats.totalMs+=ms;stats.maxMs=Math.max(stats.maxMs,ms);stats.lastMs=ms;stats.pixels+=pixels;
      /* v5.1.1 自愈：每 20 次解码复核一次取景几何（元数据晚到 / 屏幕旋转后都能纠正） */
      if(stats.frames%20===0&&typeof scanViewLayout==='function'){try{scanViewLayout();}catch(e){}}
      // Adapt the wait to observed synchronous work; do not confuse requested FPS with CPU load.
      var duty=enhanceMode ? .65 : p.saving ? .30 : .50;   /* v5.1.6：提高占空，换识别率 */
      target.timeBetweenDecodingAttempts=Math.max(p.retry,Math.ceil(ms*(1/duty-1)));
    }
  };
  configurePrimaryScanHints(target);
}
function scanViewDiagnostics(){
  try{
    var v=document.getElementById('video'),f=document.getElementById('scanFrame');
    if(!v||!f||!v.videoWidth||!v.videoHeight)return null;
    var r=getFrameROI(v,f);
    return {readyState:v.readyState,frameY:(scanViewBox?Math.round(scanViewBox.center-scanViewBox.h/2):null),elemW:(function(){try{var b=v.getBoundingClientRect();return Math.round(b.width)+'x'+Math.round(b.height);}catch(e){return null;}})(),frameW:scanViewBox?scanViewBox.w:null,frameH:scanViewBox?scanViewBox.h:null,sensorW:v.videoWidth,sensorH:v.videoHeight,roiW:r?r.w:null,roiH:r?r.h:null,roiShare:r?Math.round(r.w*r.h/(v.videoWidth*v.videoHeight)*1000)/10:null};
  }catch(e){return null;}
}
function scannerDiagnostics(){
  var p=scannerPowerProfile(),settings=cameraTrack&&cameraTrack.getSettings?cameraTrack.getSettings():{},s=scannerPrimaryStats,view=scanViewDiagnostics(),seconds=s&&s.startedAt?Math.max(.001,((s.stoppedAt||Date.now())-s.startedAt)/1000):0;
  return {version:typeof VERSION==='undefined'?'R27':VERSION,mode:p.mode,running:scanning,camera:{width:settings.width||null,height:settings.height||null,fps:settings.frameRate||null,torch:settings.torch===true,focus:settings.focusMode||'system'},view:view,seconds:Math.round(seconds),frames:s?s.frames:0,decodeFps:s&&seconds>=1?Math.round(s.frames/seconds*10)/10:0,meanInputPixels:s&&s.frames?Math.round(s.pixels/s.frames):0,roiFrames:s?s.roiFrames:0,fullFrames:s?s.fullFrames:0,meanDecodeMs:s&&s.frames?Math.round(s.totalMs/s.frames*10)/10:0,maxDecodeMs:s?Math.round(s.maxMs*10)/10:0,primaryTimeShare:s&&seconds?Math.round(s.totalMs/(seconds*1000)*1000)/10:0,recoveryStarts:scannerRecoveryStarts,successes:scannerSuccessCount,lastSuccessAgoMs:scannerRecoveryLastSuccess?Date.now()-scannerRecoveryLastSuccess:null,band:s?s.band:null,roiScale:s?s.scale:null,recoveryGapMs:scannerRecoveryGap(),columns:(typeof barcodeColumnKeys==='function'?{barcode:barcodeColumnKeys(),model:(typeof modelColumnKeys==='function'?modelColumnKeys():[])}:null),stagedFormats:s?{fast:s.fastFrames||0,hard:s.hardFrames||0,contrast:s.contrastFrames||0}:null,worker:s?{frames:s.workerFrames||0,hits:s.workerHits||0,on:!!scanDecodeWorker}:null};
}
async function copyScannerDiagnostics(){
  var d=scannerDiagnostics(),text=JSON.stringify(d,null,2)+'\n主识别计时占比不是电量或整机 CPU 测量；不含条码和商品数据。';
  try{if(!navigator.clipboard||!navigator.clipboard.writeText)throw Error('clipboard unavailable');await navigator.clipboard.writeText(text);showToast('扫描诊断已复制，可粘贴发给我；不含条码数据');}
  catch(e){showToast(text,false,true);}
}
function scannerPowerProfile(){
  var tablet=(typeof window!=='undefined'&&window.innerWidth>=700);
  if(enhanceMode)return tablet
    ? {mode:'enhanced',saving:false,width:1280,height:720,fps:24,maxFps:30,retry:80,recoveryGap:500,recoveryAge:600}
    : {mode:'enhanced',saving:false,width:1920,height:1080,fps:24,maxFps:30,retry:80,recoveryGap:500,recoveryAge:600};
  if(scannerPowerSave)return {mode:'saving',saving:true,width:1280,height:720,fps:15,maxFps:20,retry:180,recoveryGap:1000,recoveryAge:1200};
  /* v5.1.2：平板屏大 → 框映射到整个传感器，1920x1080 等于每次解 2MP。
     改请求 720p：像素降 56%，条码仍有足够模块像素。 */
  if(tablet)return {mode:'balanced',saving:false,width:1280,height:720,fps:20,maxFps:24,retry:90,recoveryGap:650,recoveryAge:850};
  return {mode:'balanced',saving:false,width:1920,height:1080,fps:18,maxFps:24,retry:90,recoveryGap:650,recoveryAge:850};
}
function updateScanPowerUI(){
  var profile=scannerPowerProfile(),button=document.getElementById('scanPowerBtn'),ui=document.getElementById('scanUI');
  if(button){button.textContent=enhanceMode?'✨ 增强中':scannerPowerSave?'🔋 省电':'⚖️ 均衡';button.title=enhanceMode?'点击返回均衡模式':scannerPowerSave?'点击切换均衡模式':'点击切换省电模式';button.classList.toggle('active',profile.saving);button.setAttribute('aria-pressed',String(profile.saving));}
  if(ui&&ui.classList)ui.classList.toggle('scanner-saving',profile.saving);
  if(reader){reader.timeBetweenDecodingAttempts=profile.retry;configurePrimaryScanHints(reader);}
}
function applyScannerPowerProfile(){
  updateScanPowerUI();var track=cameraTrack,token=scannerRecoveryEpoch;
  if(!scanning||!track)return Promise.resolve(false);
  scannerProfilePending=scannerProfilePending.catch(function(){}).then(async function(){
    if(!scanning||track!==cameraTrack||token!==scannerRecoveryEpoch)return false;
    var p=scannerPowerProfile();
    try{await track.applyConstraints({width:{ideal:p.width},height:{ideal:p.height},frameRate:{ideal:p.fps,max:p.maxFps}});scanViewLayout();return true;}
    catch(e){console.info('[Camera] power profile unsupported',e&&e.name);return false;}
  });
  return scannerProfilePending;
}
function toggleScannerPower(){
  if(enhanceMode){scannerPowerSave=false;toggleEnhanceMode();}else{scannerPowerSave=!scannerPowerSave;applyScannerPowerProfile();}
  try{localStorage.setItem('sanfei_scanner_power',scannerPowerSave?'1':'0');}catch(e){}
  showToast(scannerPowerSave?'省电模式已开启：保留自动对焦；小条码可开启增强':'已恢复均衡模式：保留高清画面与自动对焦');
}
function stopScannerForBackground(){
  if(scanning||cameraSwitching||cameraRestartTimer){stopScanning(true);return true;}
  return false;
}
function stopScanningAndJump(i){pendingJump=i;stopScanning(true);var p=Math.floor(i/pageSize);if(p!==currentPage){currentPage=p;renderPage();}setTimeout(function(){jumpToRowAndFocusQty(i);pendingJump=null;},150);}
function cap(t,n){try{var c=t&&t.getCapabilities?t.getCapabilities():null;return c&&c[n];}catch(e){return null;}}
function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
async function safeApply(t,a){if(!t||!a.length)return false;try{await t.applyConstraints({advanced:a});return true;}catch(e){console.info('[Camera] constraint skipped',e&&e.name);return false;}}
async function applyCameraTuning(t){if(!t||!t.getCapabilities)return;var c=t.getCapabilities(),s=t.getSettings?t.getSettings():{},a=[];if(c.focusMode&&Array.from(c.focusMode).includes('continuous'))a.push({focusMode:'continuous'});if(c.exposureMode&&Array.from(c.exposureMode).includes('continuous'))a.push({exposureMode:'continuous'});if(c.whiteBalanceMode&&Array.from(c.whiteBalanceMode).includes('continuous'))a.push({whiteBalanceMode:'continuous'});await safeApply(t,a);if(!scanning||t!==cameraTrack)return;scheduleFocusKick();primeCameraFocus(t).catch(function(){});requestBarcodeFocus().catch(function(){});if(c.zoom){currentZoom=clamp(Number(s.zoom)||Number(c.zoom.min)||1,c.zoom.min,c.zoom.max);updateZoomUI(c.zoom);}}
function updateZoomUI(c){var l=document.getElementById('zoomLabel'),m=document.getElementById('zoomOutBtn'),p=document.getElementById('zoomInBtn'),ok=!!c;[l,m,p].forEach(function(x){if(x)x.hidden=!ok;});if(l)l.textContent=currentZoom.toFixed(1)+'×';if(m)m.disabled=!ok||currentZoom<=c.min+.01;if(p)p.disabled=!ok||currentZoom>=c.max-.01;}
async function changeCameraZoom(d){var c=cap(cameraTrack,'zoom');if(!c){showToast('当前浏览器不支持相机变焦',true);return;}var n=clamp(currentZoom+d*Math.max(Number(c.step)||.1,.2),c.min,c.max);if(await safeApply(cameraTrack,[{zoom:n}])){currentZoom=n;updateZoomUI(c);}}
async function requestFocusReset(event){if(!cameraTrack)return;if(await requestBarcodeFocus(event)){showToast("🎯 已请求条码区域对焦，请保持约半秒");return;}if(!scanning||!cameraTrack)return;var m=cap(cameraTrack,'focusMode');if(m&&Array.from(m).includes('continuous')){await safeApply(cameraTrack,[{focusMode:'continuous'}]);showToast('🎯 正在连续对焦，请保持约半秒');}else showToast('此设备由系统自动对焦');}
function kickContinuousFocus(){if(!cameraTrack)return;var a=[],fm=cap(cameraTrack,'focusMode'),em=cap(cameraTrack,'exposureMode');if(fm&&Array.from(fm).includes('continuous'))a.push({focusMode:'continuous'});if(em&&Array.from(em).includes('continuous'))a.push({exposureMode:'continuous'});if(a.length)safeApply(cameraTrack,a);}
/* v5.1.10：开镜时 iOS 的自动对焦要从无穷远“扫”到 10–20cm，肉眼就是先糊 1–2 秒。
   两步缓解：
   a) 先切 single-shot 强制它立刻做一轮完整 AF，再切回 continuous（比干等它自己收敛快）；
   b) 开镜后 200/500/900/1500ms 各“催”一次（重新 apply 约束会触发新一轮 AF）。 */
async function primeCameraFocus(t){
  if(!t||!t.getCapabilities)return;
  var fm=cap(t,'focusMode');if(!fm)return;
  var list=Array.from(fm);
  if(list.indexOf('single-shot')>=0){await safeApply(t,[{focusMode:'single-shot'}]);}
  if(list.indexOf('continuous')>=0){await safeApply(t,[{focusMode:'continuous'}]);}
  [200,500,900,1500].forEach(function(ms){
    setTimeout(function(){if(scanning&&t===cameraTrack)kickContinuousFocus();},ms);
  });
}
function scheduleFocusKick(){focusKickTimers.forEach(clearTimeout);focusKickTimers=[80,320,700,1300].map(function(ms){return setTimeout(function(){if(scanning)kickContinuousFocus();},ms);});}
function setupCameraControls(t){cameraTrack=t||null;var b=document.getElementById('torchBtn'),tc=cap(t,'torch');if(b){b.hidden=!tc;b.classList.remove('active');b.textContent='🔦 补光';b.onclick=async function(e){e.stopPropagation();var on=!b.classList.contains('active');if(await safeApply(cameraTrack,[{torch:on}])){b.classList.toggle('active',on);b.textContent=on?'🔦 关补光':'🔦 补光';}};}var m=document.getElementById('zoomOutBtn'),p=document.getElementById('zoomInBtn'),cycle=document.getElementById('cameraCycleBtn');if(m)m.onclick=function(e){e.stopPropagation();changeCameraZoom(-1);};if(p)p.onclick=function(e){e.stopPropagation();changeCameraZoom(1);};if(cycle)cycle.onclick=function(e){e.stopPropagation();cycleCamera();};updateZoomUI(cap(t,'zoom'));refreshCameraDevices();detectorWarmTimer=setTimeout(function(){if(scanning&&enhanceMode)getEnhancedDetector();},1200);updateScanPowerUI();var box=document.querySelector('#scanUI .relative');if(box&&!box.dataset.focusBound){box.dataset.focusBound='1';box.addEventListener('click',function(e){if(!e.target.closest('button'))requestFocusReset(e);});}}
function cameraConstraints(){var p=scannerPowerProfile(),video={width:{ideal:p.width,min:640},height:{ideal:p.height,min:480},frameRate:{ideal:p.fps,max:p.maxFps},aspectRatio:{ideal:16/9},advanced:[{focusMode:'continuous'},{exposureMode:'continuous'},{whiteBalanceMode:'continuous'}]};if(selectedCameraId)video.deviceId={ideal:selectedCameraId};else video.facingMode={ideal:'environment'};return {video:video,audio:false};}
async function getScannerCameraStream(){
  var constraints=cameraConstraints();
  try{return await navigator.mediaDevices.getUserMedia(constraints);}
  catch(e){
    if(scannerPowerProfile().mode==='enhanced'||!e||e.name!=='OverconstrainedError')throw e;
    // Some cameras expose only fixed frame rates: preserve scanning rather than fail to open.
    delete constraints.video.frameRate.max;delete constraints.video.width.min;delete constraints.video.height.min;
    return await navigator.mediaDevices.getUserMedia(constraints);
  }
}
async function refreshCameraDevices(){try{var all=await navigator.mediaDevices.enumerateDevices();cameraDevices=all.filter(function(d){return d.kind==='videoinput';});var b=document.getElementById('cameraCycleBtn');if(b){var active=cameraTrack&&cameraTrack.getSettings?cameraTrack.getSettings().deviceId:selectedCameraId;var i=cameraDevices.findIndex(function(d){return d.deviceId===active;});b.hidden=cameraDevices.length<2;b.textContent='📷 镜头 '+(Math.max(0,i)+1)+'/'+cameraDevices.length;}}catch(e){cameraDevices=[];}}
async function cycleCamera(){
  if(!scanning||cameraSwitching)return;
  cameraSwitching=true;var token=scannerRecoveryEpoch;
  await refreshCameraDevices();
  if(!scanning||token!==scannerRecoveryEpoch){cameraSwitching=false;return;}
  if(cameraDevices.length<2){cameraSwitching=false;showToast('只检测到一个可用摄像头');return;}
  var active=cameraTrack&&cameraTrack.getSettings?cameraTrack.getSettings().deviceId:selectedCameraId;
  var i=cameraDevices.findIndex(function(d){return d.deviceId===active;});
  selectedCameraId=cameraDevices[(i+1+cameraDevices.length)%cameraDevices.length].deviceId;
  try{localStorage.setItem('sanfei_camera_id',selectedCameraId);}catch(e){}
  stopScanning(true);cameraSwitching=true;var restartToken=scannerRecoveryEpoch;
  cameraRestartTimer=setTimeout(function(){
    cameraRestartTimer=null;cameraSwitching=false;
    if(restartToken===scannerRecoveryEpoch&&!scanning)startScanning();
  },180);
}
function releaseCameraSession(sessionReader,stream,video){
  if(stream)stream.getTracks().forEach(function(t){t.stop();});
  if(!sessionReader)return;
  // An old session must never detach a newer session's visible stream.
  if(video&&video.srcObject!==stream)sessionReader.videoElement=null;
  try{sessionReader.reset();}catch(e){}
}
/* R9 视场对齐：预览画面 = 取景框 = 解码 ROI。
   旧版把 16:9 的摄像头画面用 object-cover 撑满竖屏容器，横向视场只剩中间约 28%，
   框里看到的画面和框本身的宽度不是一回事，用户必须把手机贴得很近才能让条码进框。
   现在由同一个计算函数同时给 <video> 和 .scan-frame 设置宽高与纵向位置：
   宽度取满屏宽的约 97%，高度按真实视频流比例，竖屏里上下留黑，而不是压缩左右。 */
var scanViewAspect=16/9,scanViewBox=null;
function scanViewHost(v){
  /* 视频现在包在 .scan-viewport 里，布局必须相对 .scan-stage 量，不能取 parentElement。 */
  if(typeof document.querySelector==='function'){var st=document.querySelector('#scanUI .scan-stage');if(st)return st;}
  if(v&&v.parentElement&&v.parentElement.parentElement)return v.parentElement.parentElement;
  return (v&&v.parentElement)||null;
}
function scanViewInsets(host){
  /* 用真实 DOM 量上下两条固定浮层，而不是写死像素：320 宽的机器上工具条会折成 3–4 行。 */
  var top=46,bottom=Math.min(128,Math.round(((host&&host.clientHeight)||700)*0.22));
  try{
    if(host&&typeof document.querySelector==='function'){
      var hr=host.getBoundingClientRect(),g=document.querySelector('.focus-guide'),c=document.querySelector('.scan-controls');
      if(g){var gr=g.getBoundingClientRect();if(gr.height>0)top=Math.max(28,Math.round(gr.bottom-hr.top+8));}
      if(c){var cr=c.getBoundingClientRect();if(cr.height>0)bottom=Math.max(56,Math.round(hr.bottom-cr.top+8));}
    }
  }catch(e){}
  return {top:top,bottom:bottom};
}
function scanViewLayout(){
  var v=document.getElementById('video'),f=document.getElementById('scanFrame'),ui=document.getElementById('scanUI');
  if(!v||!f||!ui||!ui.style)return null;
  var host=scanViewHost(v);
  var availW=(host&&host.clientWidth)||window.innerWidth||0,availH=(host&&host.clientHeight)||window.innerHeight||0;
  if(!(availW>90)||!(availH>140))return null;
  var vw=v.videoWidth||0,vh=v.videoHeight||0,rawAr=vw>0&&vh>0?vw/vh:scanViewAspect;
  if(!isFinite(rawAr)||rawAr<=0)rawAr=16/9;
  var ar=rawAr;   /* ar 之后会被归一化成“框”的形状；rawAr 保留真实流比例 */
  if(!isFinite(ar)||ar<=0)ar=16/9;
  /* 竖屏/方屏视频流不改横向框：object-fit:cover 会裁掉上下，横向仍是传感器全宽——
     条码最需要的正是水平分辨率。 */
  if(ar<1)ar=16/9;else if(ar<1.2)ar=1.2;else if(ar>3)ar=3;
  scanViewAspect=ar;
  var padX=Math.max(6,Math.round(availW*0.015));       /* 只留窄安全边，左右尽量吃满 */
  var w=Math.min(availW-padX*2,1200);
  if(availW>=700)w=Math.min(w,SCAN_MAX_WIDTH_WIDE);   /* v5.1.1：iPad 上框太大，收窄到 620 */
  var insets=scanViewInsets(host);
  var bandTop=insets.top,bandBottom=Math.max(bandTop+120,availH-insets.bottom);
  var bandH=bandBottom-bandTop,h=w/ar;
  if(h>bandH){h=bandH;w=h*ar;}                         /* 横屏/平板按可用高度回退，绝不超出屏幕 */
  /* v5.1.3：整体上移，最多 72px（约 2cm），让框更接近视线中心 */
  var shiftUp=(availW>=700)
    ? Math.min(160,Math.round(availH*0.11))   /* v5.1.5：平板按 11% 上移，最多 160px */
    : Math.min(56,Math.round(availH*0.045));  /* 手机保持轻微上移 */
  var center=Math.max(bandTop+Math.round(h/2)+4,Math.round(bandTop+bandH/2)-shiftUp);
  ui.style.setProperty('--scan-view-w',Math.round(w)+'px');
  ui.style.setProperty('--scan-view-h',Math.round(h)+'px');
  ui.style.setProperty('--scan-view-center',center+'px');
  ui.style.setProperty('--scan-line-travel',Math.max(12,Math.round(h-26))+'px');
  /* 覆盖尺寸：视频元素比框大，多出来的部分由 .scan-viewport 裁掉 */
  var coverW=w,coverH=h;
  if(rawAr>=w/h){coverH=h;coverW=Math.round(h*rawAr);}else{coverW=w;coverH=Math.round(w/rawAr);}
  ui.style.setProperty('--scan-video-w',coverW+'px');
  ui.style.setProperty('--scan-video-h',coverH+'px');
  /* 双保险：直接写内联样式。某些 iOS 版本上自定义属性在 <video> 上不生效，
     元素会退回“与框同尺寸”，此时 object-fit:cover 又会裁掉两侧 → 画面被放大、
     条码必须拿远才能进框（用户报的“框内有黑罩/要放远”）。 */
  if(v&&v.style){v.style.width=coverW+'px';v.style.height=coverH+'px';v.style.objectFit='cover';v.style.webkitObjectFit='cover';}
  scanViewBox={w:Math.round(w),h:Math.round(h),center:center,aspect:ar};
  return scanViewBox;
}
var scanBootTimer=null;
function updateScanBoot(){
  var v=document.getElementById('video'),b=document.getElementById('scanBoot');
  if(!b)return false;
  var ready=!!v&&v.readyState>=2&&v.videoWidth>0;
  b.hidden=ready;
  if(!ready)b.textContent=v&&v.videoWidth>0?'📷 画面准备中…请稍候':'📷 正在启动摄像头…';
  return ready;
}
function kickVideoPlayback(v){
  if(!v||typeof v.play!=='function')return;
  try{var pr=v.play();if(pr&&pr.then)pr.catch(function(){});}catch(e){}
}/* v5.1.4 预览：把“取景框对应的那一块传感器画面”画进 canvas。
   这样显示的就是解码用的同一块像素，不存在 object-fit / 元素缩放差异。 */
/* v5.1.9：把 ZXing 识别挪到 Web Worker，主线程只负责“画一帧 + 取出像素 + 发过去”。
   解码不再占用主线程，相机预览不卡；识别能力不变（同一份 ZXing、同样 hints）。
   取结果的方式：worker 算完先暂存，下一次 ZXing 轮询时直接返回 —— 对外契约不变。 */
var scanDecodeWorker=null,scanWorkerTried=false,scanWorkerBusy=false,scanWorkerSeq=0,
    scanWorkerSentAt=0,scanWorkerFails=0,scanWorkerResult=null,scanWorkerUnsupported=false;
function ensureDecodeWorker(){
  if(scanWorkerTried)return scanDecodeWorker;
  scanWorkerTried=true;
  if(typeof Worker!=='function')return null;
  try{
    scanDecodeWorker=new Worker('js/decode-worker.js');
    scanDecodeWorker.onmessage=function(ev){
      scanWorkerBusy=false;
      var d=(ev&&ev.data)||{};
      if(d.unsupported){scanWorkerUnsupported=true;scanDecodeWorker=null;return;}
      if(d.text){
        scanWorkerFails=0;
        scanWorkerResult={
          getText:function(){return d.text;},
          getBarcodeFormat:function(){return d.format;},
          getResultMetadata:function(){return null;},
          getResultPoints:function(){return null;},
          getTimestamp:function(){return Date.now();}
        };
      }else if(d.error){
        scanWorkerFails++;
        if(scanWorkerFails>=30)scanDecodeWorker=null;   /* 连续失败 → 永久退回主线程 */
      }
    };
    scanDecodeWorker.onerror=function(){scanDecodeWorker=null;scanWorkerBusy=false;};
  }catch(e){scanDecodeWorker=null;}
  return scanDecodeWorker;
}
var scanPreviewRAF=null,scanPreviewLast=0;
/* v5.1.7：低对比条码（打印浅、磨损、反光）靠“灰度满幅拉伸”救回来。
   做法：取这块 ROI 的灰度矩阵，按 min..max 线性映射到 0..255，
   再交给自适应二值化（HybridBinarizer）——黑白不分明时这一下差别很大。
   只在硬档（每第 4 次）执行，避免拖慢日常。 */
function stretchContrast(src){
  var m=src&&src.getMatrix&&src.getMatrix();
  if(!m||!m.luminances||!m.width)return false;
  var L=m.luminances,n=m.width*m.height,i,v,min=255,max=0;
  for(i=0;i<n;i+=3){v=L[i];if(v<min)min=v;if(v>max)max=v;}   /* 抽样 1/3，够准且快 */
  if(max-min<20)return false;          /* 几乎纯色，拉伸也没意义 */
  if(min<=10&&max>=245)return false;   /* 已经满幅，不必再动 */
  var span=max-min,lut=new Uint8Array(256);
  for(i=0;i<256;i++){v=Math.round((i-min)*255/span);lut[i]=v<0?0:(v>255?255:v);}
  for(i=0;i<n;i++)L[i]=lut[L[i]];
  return true;
}
/* v5.1.8：停止/重开扫描时清空取景画布。
   否则上一次成功扫到的条码画面会残留在框里，重新打开时看起来像“卡住”。 */
function clearScanPreview(){
  var cv=document.getElementById('scanCanvas');
  if(!cv)return;
  try{
    var ctx=cv.getContext('2d');
    if(cv.width<1||cv.height<1){cv.width=2;cv.height=2;}
    ctx.fillStyle='#000';
    ctx.fillRect(0,0,cv.width,cv.height);
  }catch(e){}
}
function stopScanPreview(){
  if(scanPreviewRAF){cancelAnimationFrame(scanPreviewRAF);scanPreviewRAF=null;}
}
/* v5.1.11：给用户一个“正在对焦”的明确提示（AF 是硬件行为，无法瞬间清晰，
   但至少让人知道系统在干活，而不是以为卡了）。 */
var focusHintEl=null,focusHintSharp=0,sharpCanvas=null;
/* 在 160x90 的小图上算相邻像素灰度差；糊的画面差很小，对上焦会突然变大。 */
function measureSharpness(){
  try{
    var v=document.getElementById('video');
    if(!v||!v.videoWidth||v.readyState<2)return null;
    if(!sharpCanvas){sharpCanvas=document.createElement('canvas');sharpCanvas.width=160;sharpCanvas.height=90;}
    var c=sharpCanvas.getContext('2d',{willReadFrequently:true});
    c.drawImage(v,0,0,160,90);
    var d=c.getImageData(0,0,160,90).data,sum=0,n=0;
    for(var y=1;y<89;y++){
      for(var x=1;x<159;x++){
        var i=(y*160+x)*4,g=d[i];
        sum+=Math.abs(g-d[i-4])+Math.abs(g-d[i-640]);n+=2;
      }
    }
    return n?sum/n:null;
  }catch(e){return null;}
}
function updateFocusHint(sharp){
  if(!focusHintEl){
    focusHintEl=document.getElementById('focusHint');
    if(!focusHintEl)return;
  }
  focusHintSharp=sharp?focusHintSharp+1:0;
  var show=!sharp&&focusHintSharp<6;
  if(focusHintEl.hidden===show){focusHintEl.hidden=!show;}
}
function drawScanPreview(){
  var v=document.getElementById('video'),cv=document.getElementById('scanCanvas'),f=document.getElementById('scanFrame');
  if(!v||!cv)return;
  if(!v.videoWidth||!v.videoHeight){clearScanPreview();return;}
  if(!f)return;
  var w=scanViewBox?scanViewBox.w:0,h=scanViewBox?scanViewBox.h:0;
  if(!w||!h)return;
  var dpr=Math.min(2,(typeof window!=='undefined'&&window.devicePixelRatio)||1);
  var cw=Math.round(w*dpr),ch=Math.round(h*dpr);
  if(cv.width!==cw||cv.height!==ch){cv.width=cw;cv.height=ch;}
  var ctx=cv.getContext('2d');
  var r=getFrameROI(v,f);
  if(!r||!r.w||!r.h){ctx.drawImage(v,0,0,v.videoWidth,v.videoHeight,0,0,cw,ch);return;}
  ctx.imageSmoothingEnabled=true;
  if('imageSmoothingQuality' in ctx)ctx.imageSmoothingQuality='high';
  ctx.drawImage(v,r.x,r.y,r.w,r.h,0,0,cw,ch);
}
function startScanPreview(){
  if(typeof requestAnimationFrame!=='function')return;
  stopScanPreview();
  clearScanPreview();   /* 先擦掉上一张，避免残影 */
  scanPreviewLast=0;
  (function loop(ts){
    if(!scanning){scanPreviewRAF=null;return;}
    if(!scanPreviewLast||ts-scanPreviewLast>=45){   /* 约 22fps，够看且省电 */
      scanPreviewLast=ts;
      try{drawScanPreview();}catch(e){}
      scanPreviewFrames=(scanPreviewFrames||0)+1;
      if(scanPreviewFrames%6===0){                    /* 约 250ms 判一次清晰度 */
        var sh=measureSharpness();
        if(sh!==null)updateFocusHint(sh>=14);
      }
    }
    scanPreviewRAF=requestAnimationFrame(loop);
  })(0);
}
function bindScanViewport(v){
  if(!v||typeof v.addEventListener!=='function'||v.__scanViewBound)return;
  v.__scanViewBound=true;
  v.addEventListener('loadedmetadata',scanViewLayout);
  v.addEventListener('playing',function(){updateScanBoot();scanViewLayout();});
  v.addEventListener('canplay',updateScanBoot);
  v.addEventListener('loadeddata',updateScanBoot);
  v.addEventListener('resize',scanViewLayout);  /* applyConstraints 换分辨率后会触发 */
  v.addEventListener('playing',scanViewLayout);
}
if(typeof window!=='undefined'&&window&&typeof window.addEventListener==='function'){
  var scanViewResizeTimer=null;
  window.addEventListener('resize',function(){if(scanViewResizeTimer)clearTimeout(scanViewResizeTimer);scanViewResizeTimer=setTimeout(function(){scanViewResizeTimer=null;if(scanning)scanViewLayout();},120);});
  window.addEventListener('orientationchange',function(){if(scanning)scanViewLayout();});
}
async function startScanning(){var sessionToken=scannerRecoveryEpoch,sessionReader=null,sessionStream=null;if(scanning){showToast('扫描器已在运行');return;}var f=document.getElementById('scanFrame'),v=document.getElementById('video');if(f)f.style.top='';document.getElementById('scanUI').style.display='flex';updateScanBoot();scanSessionCount=0;if(typeof updateScanCountLabel==='function')updateScanCountLabel();bindScanViewport(v);scanViewLayout();scanning=true;startScanPreview();consecutiveFailures=0;if(reader){try{await reader.reset();}catch(e){}reader=null;}var badge=document.getElementById('enhanceBadge');if(badge)badge.classList.toggle('hidden',!enhanceMode);try{var h=new Map();if(enhanceMode)h.set(ZXing.DecodeHintType.TRY_HARDER,true);h.set(ZXing.DecodeHintType.ALSO_INVERTED,true);h.set(ZXing.DecodeHintType.POSSIBLE_FORMATS,[ZXing.BarcodeFormat.EAN_13,ZXing.BarcodeFormat.EAN_8,ZXing.BarcodeFormat.UPC_A,ZXing.BarcodeFormat.UPC_E,ZXing.BarcodeFormat.CODE_39,ZXing.BarcodeFormat.CODE_93,ZXing.BarcodeFormat.CODE_128,ZXing.BarcodeFormat.ITF,ZXing.BarcodeFormat.CODABAR]);sessionReader=new ZXing.BrowserMultiFormatReader(h);sessionReader.__scannerHints=h;sessionReader.__scannerHarder=!!enhanceMode;reader=sessionReader;installPrimaryROIDecoder(sessionReader,v,f);reader.timeBetweenDecodingAttempts=scannerPowerProfile().retry;updateScanPowerUI();kickVideoPlayback(v);if(scanBootTimer)clearTimeout(scanBootTimer);scanBootTimer=setTimeout(function(){scanBootTimer=null;if(scanning){scanViewLayout();if(!updateScanBoot())kickVideoPlayback(v);}},1500);sessionStream=await getScannerCameraStream();if(!scanning||sessionToken!==scannerRecoveryEpoch){releaseCameraSession(sessionReader,sessionStream,v);return;}await sessionReader.decodeFromStream(sessionStream,'video',async function(r){if(!scanning||sessionToken!==scannerRecoveryEpoch)return;if(r&&r.getText){acceptDecodedBarcode(r.getText(),r.getBarcodeFormat?String(r.getBarcodeFormat()):'ZXing-JS');return;}consecutiveFailures++;launchSupplementalRecovery(v,f).catch(function(e){console.info('[Scanner] recovery skipped',e&&e.name);});});if(!scanning||sessionToken!==scannerRecoveryEpoch){releaseCameraSession(sessionReader,sessionStream,v);return;}var t=v&&v.srcObject&&v.srcObject.getVideoTracks()[0];if(t){setupCameraControls(t);await applyScannerPowerProfile();scanViewLayout();setTimeout(scanViewLayout,300);setTimeout(scanViewLayout,900);await applyCameraTuning(t);if(!scanning||sessionToken!==scannerRecoveryEpoch){releaseCameraSession(sessionReader,sessionStream,v);return;}console.info('[Camera] settings',t.getSettings?t.getSettings():{});}showToast('极速扫码已启动'+(enhanceMode?' · WASM增强':' · 自动对焦'));}catch(e){releaseCameraSession(sessionReader,sessionStream,v);if(sessionToken!==scannerRecoveryEpoch)return;console.error('相机错误:',e);var msg=e&&e.name==='NotAllowedError'?'摄像头权限被拒绝':e&&e.name==='NotFoundError'?'未找到后置摄像头':'无法启动摄像头';showToast(msg+'，请检查权限与 HTTPS',true);stopScanning(true);}}
function acceptDecodedBarcode(v,f){if(!scanning)return;scannerSuccessCount++;scannerRecoveryMisses=0;scannerRecoveryLastSuccess=Date.now();scannerRecoveryFocusRequested=false;scannerRecoveryPhase=0;var s=String(v||'').trim();if(!s)return;console.info('[Scanner] decoded:',{code:s,format:f,length:s.length});handleBarcode(s,true);consecutiveFailures=0;}
function stopScanning(){lastScanStopAt=Date.now();stopScanPreview();clearScanPreview();if(scannerPrimaryStats&&scannerPrimaryStats.startedAt)scannerPrimaryStats.stoppedAt=Date.now();resetScannerRecovery();scanning=false;if(cameraRestartTimer){clearTimeout(cameraRestartTimer);cameraRestartTimer=null;}cameraSwitching=false;focusKickTimers.forEach(clearTimeout);focusKickTimers=[];if(focusResetTimer){clearTimeout(focusResetTimer);focusResetTimer=null;}if(qualityUpgradeTimer){clearTimeout(qualityUpgradeTimer);qualityUpgradeTimer=null;}if(detectorWarmTimer){clearTimeout(detectorWarmTimer);detectorWarmTimer=null;}if(reader){try{reader.reset();}catch(e){}reader=null;}var v=document.getElementById('video');if(v&&v.srcObject){v.srcObject.getTracks().forEach(function(t){t.stop();});v.srcObject=null;}document.getElementById('scanUI').style.display='none';cameraTrack=null;consecutiveFailures=0;enhancedDecodeBusy=false;highQualityApplied=false;}
function toggleEnhanceMode(){enhanceMode=!enhanceMode;var b=document.getElementById('scanEnhanceBtn'),g=document.getElementById('enhanceBadge');if(b){b.classList.toggle('active',enhanceMode);b.textContent=enhanceMode?'✨ 增强开':'✨ 增强';}if(g)g.classList.toggle('hidden',!enhanceMode);applyScannerPowerProfile();showToast(enhanceMode?'增强模式已开启：ROI + WASM 后备':'增强模式已关闭');}
function getFrameROI(v,f){if(!v||!f||!v.videoWidth||!v.videoHeight)return null;var vw=v.videoWidth,vh=v.videoHeight,vr=v.getBoundingClientRect(),fr=f.getBoundingClientRect();if(!vr.width||!vr.height||!fr.width||!fr.height)return null;var va=vw/vh,ba=vr.width/vr.height,rw,rh,ox=0,oy=0;if(va>ba){rh=vr.height;rw=rh*va;ox=(rw-vr.width)/2;}else{rw=vr.width;rh=rw/va;oy=(rh-vr.height)/2;}var sx=vw/rw,sy=vh/rh,x=clamp(Math.floor((fr.left-vr.left+ox)*sx),0,vw-1),y=clamp(Math.floor((fr.top-vr.top+oy)*sy),0,vh-1),w=Math.min(vw-x,Math.floor(fr.width*sx)),h=Math.min(vh-y,Math.floor(fr.height*sy));return w>20&&h>20?{x:x,y:y,w:w,h:h}:null;}
function captureROI(v,r,binary){var z=Math.min(1.6,1600/Math.max(r.w,1)),c=document.createElement('canvas');c.width=Math.round(r.w*z);c.height=Math.round(r.h*z);var x=c.getContext('2d',{willReadFrequently:!!binary});x.imageSmoothingEnabled=false;x.drawImage(v,r.x,r.y,r.w,r.h,0,0,c.width,c.height);if(binary==='local'){enhanceLocalBarcodeContrast(c);return c;}if(binary){var im=x.getImageData(0,0,c.width,c.height),d=im.data,lo=255,hi=0;for(var i=0;i<d.length;i+=4){var g=.299*d[i]+.587*d[i+1]+.114*d[i+2];d[i]=d[i+1]=d[i+2]=g;lo=Math.min(lo,g);hi=Math.max(hi,g);}var q=lo+(hi-lo)*.52;for(var j=0;j<d.length;j+=4){var a=d[j]>q?255:0;d[j]=d[j+1]=d[j+2]=a;}x.putImageData(im,0,0);}return c;}
async function getEnhancedDetector(){if(enhancedDetector)return enhancedDetector;if(enhancedDetectorPromise)return enhancedDetectorPromise;enhancedDetectorPromise=(async function(){var f=['ean_13','ean_8','upc_a','upc_e','code_39','code_93','code_128','itf','codabar'];try{if('BarcodeDetector'in globalThis){var s=BarcodeDetector.getSupportedFormats?await BarcodeDetector.getSupportedFormats():f,u=f.filter(function(x){return s.includes(x);});if(u.length)return new BarcodeDetector({formats:u});}}catch(e){}try{var m=await import('https://esm.sh/barcode-detector@3.2.2/ponyfill');return new m.BarcodeDetector({formats:f});}catch(e){console.info('[Scanner] WASM unavailable; ZXing-JS remains active');return null;}})();enhancedDetector=await enhancedDetectorPromise;return enhancedDetector;}
async function tryEnhancedDecode(v,f){
  if(!scanning||enhancedDecodeBusy||!v||v.readyState<2)return null;
  enhancedDecodeBusy=true;var token=scannerRecoveryEpoch;
  try{
    var r=getFrameROI(v,f);if(!r)return null;requestStallFocus();
    // Never await a network module here: unavailable WASM must not hold the scheduler.
    if(!enhancedDetector){getEnhancedDetector().catch(function(){});return tryLocalTiltRecovery(v,r,token);}
    var phase=scannerEnhancedPhase++%3;
    if(phase===2)return await tryTiltRecovery(v,r,enhancedDetector,token);
    var codes=await enhancedDetector.detect(captureROI(v,r,phase===1?'local':false));
    return scanning&&token===scannerRecoveryEpoch&&codes&&codes.length&&codes[0].rawValue?String(codes[0].rawValue):null;
  }catch(e){return null;}finally{if(token===scannerRecoveryEpoch)enhancedDecodeBusy=false;}
}

/* Adaptive scheduler: fast first response, expensive recovery only after a stall. */
var startScanningEnergyBase=startScanning,lastScanStopAt=0;
startScanning=function(){
  /* v5.1.10：一次点击就必须出画面。
     以前只要 scanning 还是 true 就只弹一句“扫描器已在运行”——上一次扫描没清干净时，
     用户点了没反应，得再点一次。现在会检查相机是否真的活着，死了就先复位再开。 */
  if(scanning){
    var v0=document.getElementById('video');
    var liveTracks=v0&&v0.srcObject&&v0.srcObject.getVideoTracks?v0.srcObject.getVideoTracks().filter(function(t){return t.readyState==='live';}).length:0;
    if(liveTracks){showToast('扫描器已在运行');return Promise.resolve();}
    try{stopScanning();}catch(e){}
  }
  resetScannerRecovery();scannerPrimaryStats=null;scannerRecoveryStarts=0;scanStartedAt=Date.now();highQualityApplied=false;
  /* 上一次 stop 刚关掉轨道时立刻要相机，iOS 会抛 NotReadableError；等一小会儿再要 */
  var wait=lastScanStopAt?Math.max(0,Math.min(350,350-(Date.now()-lastScanStopAt))):0;
  var run=function(){var p=startScanningEnergyBase();return (p&&p.then)?p.then(function(r){return r;},function(err){if(scanning){try{stopScanning();}catch(e){}}throw err;}):p;};
  if(wait>0)return new Promise(function(res){setTimeout(function(){res(run());},wait);});
  return run();
};

/* v5.0.0: bounded recovery, after unchanged native/WASM ROI attempts fail. */
var scannerRecoveryEpoch=0,scannerRecoveryAngle=0,scannerRecoveryLastTiltAt=0;
var scannerRecoveryFocusRequested=false,scannerRecoveryFocusBusy=false;
var scannerRecoveryLastSuccess=0;
function resetScannerRecovery(){if(typeof resetQuaggaRecovery==='function')resetQuaggaRecovery();if(typeof fragmentLastFrameTime!=='undefined')fragmentLastFrameTime=null;if(typeof fragmentEvidence!=='undefined')fragmentEvidence=null;if(typeof closeFragmentPanel==='function')closeFragmentPanel();scannerRecoveryEpoch++;scannerRecoveryLastAt=0;scannerRecoveryPhase=0;scannerRecoveryFrameTime=null;scannerEnhancedPhase=0;localTiltLastAt=0;localTiltAngle=0;scannerRecoveryAngle=0;scannerRecoveryLastTiltAt=0;scannerRecoveryFocusRequested=false;scannerRecoveryFocusBusy=false;scannerRecoveryLastSuccess=Date.now();}
function barcodeFocusPoint(v,f,event){
  if(!v||!v.videoWidth||!v.videoHeight)return null;
  var vr=v.getBoundingClientRect();if(!vr.width||!vr.height)return null;
  var scale=Math.max(vr.width/v.videoWidth,vr.height/v.videoHeight);
  var ox=(v.videoWidth*scale-vr.width)/2,oy=(v.videoHeight*scale-vr.height)/2;
  var fr=f?f.getBoundingClientRect():vr;
  var px=event&&Number.isFinite(event.clientX)?event.clientX:fr.left+fr.width/2;
  var py=event&&Number.isFinite(event.clientY)?event.clientY:fr.top+fr.height/2;
  return {x:clamp((px-vr.left+ox)/(v.videoWidth*scale),0,1),y:clamp((py-vr.top+oy)/(v.videoHeight*scale),0,1)};
}
async function requestBarcodeFocus(event){
  var t=cameraTrack,token=scannerRecoveryEpoch;
  if(!scanning||!t||scannerRecoveryFocusBusy)return false;
  var supported=navigator.mediaDevices&&navigator.mediaDevices.getSupportedConstraints?navigator.mediaDevices.getSupportedConstraints():{};
  // Try a browser-advertised constraint, then verify actual camera settings.
  if(!supported.pointsOfInterest&&!cap(t,'pointsOfInterest'))return false;
  var point=barcodeFocusPoint(document.getElementById('video'),document.getElementById('scanFrame'),event);
  if(!point)return false;
  scannerRecoveryFocusBusy=true;
  try{
    var constraint={pointsOfInterest:[point]},m=cap(t,'focusMode');
    if(m&&Array.from(m).includes('continuous'))constraint.focusMode='continuous';
    var ok=await safeApply(t,[constraint]);
    if(token!==scannerRecoveryEpoch||!scanning||t!==cameraTrack)return false;
    // The browser may silently ignore optional constraints; do not claim support.
    var after=t.getSettings?t.getSettings():{},points=after.pointsOfInterest;
    return !!(ok&&points&&points.length&&Math.abs(points[0].x-point.x)<.05&&Math.abs(points[0].y-point.y)<.05);
  }catch(e){return false;}finally{if(token===scannerRecoveryEpoch)scannerRecoveryFocusBusy=false;}
}
async function launchSupplementalRecovery(v,f){
  var now=Date.now(),p=scannerPowerProfile();
  if(!scanning||scannerRecoveryJob||!v||v.readyState<2||(typeof document.hidden==='boolean'&&document.hidden))return;
  if(now-Math.max(scanStartedAt,scannerRecoveryLastSuccess)<p.recoveryAge||now-scannerRecoveryLastAt<scannerRecoveryGap())return;
  if(Number.isFinite(v.currentTime)&&v.currentTime===scannerRecoveryFrameTime)return;
  var r=getFrameROI(v,f);if(!r)return;
  var token=scannerRecoveryEpoch,sequence=p.saving?['decode','quagga','quagga','fragment','fragment','fragment']:['decode','quagga','decode','quagga','fragment','decode','fragment','decode','fragment'];
  var kind=sequence[scannerRecoveryPhase++%sequence.length],job={epoch:token,kind:kind};
  scannerRecoveryJob=job;scannerRecoveryStarts++;scannerRecoveryLastAt=now;scannerRecoveryFrameTime=v.currentTime;
  requestStallFocus();
  try{
    var code=null;
    if(kind==='decode')code=await tryEnhancedDecode(v,f);
    else if(kind==='quagga'&&typeof tryQuaggaRecovery==='function')code=await tryQuaggaRecovery(v,r,token);
    else if(kind==='fragment'&&typeof trySheetFragmentAssist==='function')await trySheetFragmentAssist(v,r,token);
    if(code&&scanning&&token===scannerRecoveryEpoch)acceptDecodedBarcode(code,'recovery '+kind);else if(!code)scannerRecoveryMisses++;
  }finally{if(scannerRecoveryJob===job)scannerRecoveryJob=null;}
}
function requestStallFocus(){if(scanning&&!scannerRecoveryFocusRequested&&Date.now()-Math.max(scanStartedAt,scannerRecoveryLastSuccess)>=1200){scannerRecoveryFocusRequested=true;requestBarcodeFocus().catch(function(){});}}
function expandedBarcodeROI(v,r){
  var padX=Math.round(r.w*.12),padY=Math.round(r.w*.35);
  var x=Math.max(0,r.x-padX),y=Math.max(0,r.y-padY);
  return {x:x,y:y,w:Math.min(v.videoWidth,r.x+r.w+padX)-x,h:Math.min(v.videoHeight,r.y+r.h+padY)-y};
}
function rotateBarcodeCanvas(source,degrees){
  var a=degrees*Math.PI/180,cos=Math.abs(Math.cos(a)),sin=Math.abs(Math.sin(a));
  var w=Math.ceil(source.width*cos+source.height*sin),h=Math.ceil(source.width*sin+source.height*cos);
  var scale=Math.min(1,1600/Math.max(w,h)),c=document.createElement('canvas');
  c.width=Math.max(1,Math.ceil(w*scale));c.height=Math.max(1,Math.ceil(h*scale));
  var ctx=c.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,c.width,c.height);
  ctx.translate(c.width/2,c.height/2);ctx.scale(scale,scale);ctx.rotate(a);ctx.imageSmoothingEnabled=false;
  ctx.drawImage(source,-source.width/2,-source.height/2);return c;
}
async function tryTiltRecovery(v,r,detector,token){
  var now=Date.now(),stalled=now-Math.max(scanStartedAt,scannerRecoveryLastSuccess);
  if(!scanning||token!==scannerRecoveryEpoch||stalled<250)return null;
  requestStallFocus();
  if(now-scannerRecoveryLastTiltAt<220)return null;
  scannerRecoveryLastTiltAt=now;
  // One extra decode per recovery tick, padded ROI preserves tilted barcode ends.
  var angles=[-12,12,-24,24,-36,36,-45,45,0,90],angle=angles[scannerRecoveryAngle++%angles.length];
  var image=captureROI(v,expandedBarcodeROI(v,r),false);
  var codes=await detector.detect(angle?rotateBarcodeCanvas(image,angle):image);
  if(!scanning||token!==scannerRecoveryEpoch)return null;
  return codes&&codes.length&&codes[0].rawValue?String(codes[0].rawValue):null;
}

/* Stable boundary for a future Capacitor/VisionKit/ML Kit implementation. */
window.ScannerAdapter={
  start:startScanning,
  stop:stopScanning,
  setTorch:async function(on){return safeApply(cameraTrack,[{torch:!!on}]);},
  setZoom:async function(value){var c=cap(cameraTrack,'zoom');if(!c)return false;var next=clamp(Number(value)||1,c.min,c.max),ok=await safeApply(cameraTrack,[{zoom:next}]);if(ok){currentZoom=next;updateZoomUI(c);}return ok;},
  cycleCamera:cycleCamera,
  getStatus:function(){return {running:scanning,engine:enhancedDetector?'native-or-wasm+zxing-js':'zxing-js',cameraCount:cameraDevices.length,powerSaving:scannerPowerProfile().saving,diagnostics:scannerDiagnostics()};}
};

/* Tile-local contrast keeps faint bars under uneven packaging glare. No guessed digits. */
function enhanceLocalBarcodeContrast(canvas){
  var ctx=canvas.getContext('2d',{willReadFrequently:true}),im=ctx.getImageData(0,0,canvas.width,canvas.height),d=im.data,w=canvas.width,h=canvas.height,tile=48;
  for(var y=0;y<h;y+=tile)for(var x=0;x<w;x+=tile){
    var hist=new Uint32Array(256),count=0,xx,yy,i,g;
    for(yy=y;yy<Math.min(h,y+tile);yy++)for(xx=x;xx<Math.min(w,x+tile);xx++){i=(yy*w+xx)*4;g=Math.round(.299*d[i]+.587*d[i+1]+.114*d[i+2]);hist[g]++;count++;}
    var low=0,high=255,sum=0;for(var k=0;k<256;k++){sum+=hist[k];if(sum>=count*.04){low=k;break;}}
    sum=0;for(var k=255;k>=0;k--){sum+=hist[k];if(sum>=count*.04){high=k;break;}}
    if(high-low<24)continue;
    for(yy=y;yy<Math.min(h,y+tile);yy++)for(xx=x;xx<Math.min(w,x+tile);xx++){i=(yy*w+xx)*4;g=.299*d[i]+.587*d[i+1]+.114*d[i+2];d[i]=d[i+1]=d[i+2]=clamp((g-low)*255/(high-low),0,255);}
  }
  ctx.putImageData(im,0,0);
}

/* The bundled JS reader also handles rotated crops when native/WASM is unavailable. */
var localTiltReader=null,localTiltHarder=null,localTiltLastAt=0,localTiltAngle=0;
function tryLocalTiltRecovery(v,r,token){
  if(!scanning||token!==scannerRecoveryEpoch||Date.now()-localTiltLastAt<250)return null;
  localTiltLastAt=Date.now();
  try{
    if(!localTiltReader||localTiltHarder!==!!enhanceMode){var hints=new Map();if(enhanceMode)hints.set(ZXing.DecodeHintType.TRY_HARDER,true);localTiltHarder=!!enhanceMode;hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS,[ZXing.BarcodeFormat.EAN_13,ZXing.BarcodeFormat.EAN_8,ZXing.BarcodeFormat.UPC_A,ZXing.BarcodeFormat.UPC_E,ZXing.BarcodeFormat.CODE_39,ZXing.BarcodeFormat.CODE_93,ZXing.BarcodeFormat.CODE_128,ZXing.BarcodeFormat.ITF,ZXing.BarcodeFormat.CODABAR]);localTiltReader=new ZXing.BrowserMultiFormatReader(hints);}
    var step=localTiltAngle++,angles=[0,-12,12,-24,24,-36,36,-45,45,90];
    var image=captureROI(v,expandedBarcodeROI(v,r),step%2?'local':false),angle=angles[step%angles.length];
    var canvas=angle?rotateBarcodeCanvas(image,angle):image;
    var bitmap=new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(new ZXing.HTMLCanvasElementLuminanceSource(canvas)));
    var result=localTiltReader.decodeBitmap(bitmap);
    return scanning&&token===scannerRecoveryEpoch&&result?result.getText():null;
  }catch(e){return null;}
}

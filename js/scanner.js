'use strict';
var enhancedDetector=null,enhancedDetectorPromise=null,enhancedDecodeBusy=false,lastEnhancedAttempt=0,focusResetTimer=null,currentZoom=1;
var cameraDevices=[],selectedCameraId=localStorage.getItem('sanfei_camera_id')||'',cameraSwitching=false,cameraRestartTimer=null;
var scanStartedAt=0,qualityUpgradeTimer=null,detectorWarmTimer=null,highQualityApplied=false;
var focusKickTimers=[];
var scannerPowerSave=false;
try{scannerPowerSave=localStorage.getItem('sanfei_scanner_power')==='1';}catch(e){}
var scannerRecoveryJob=null,scannerRecoveryLastAt=0,scannerRecoveryPhase=0,scannerRecoveryFrameTime=null,scannerEnhancedPhase=0,scannerRecoveryStarts=0;
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
  target.__scannerHints.set(ZXing.DecodeHintType.TRY_HARDER,true);
  target.reader.setHints(target.__scannerHints);target.__scannerHarder=true;
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
    var started=scannerClock(),r=primaryBarcodeROI(v,f),p=scannerPowerProfile(),wideGap=enhanceMode?2000:p.saving?5000:3500;
    /* v5.0.4：框内区域＝预览可见区域（竖屏轨道下也只占传感器 31%，见真机诊断 roiShare）。
       此时“整幅补扫”解的是用户看不见的像素，而且一次 2MP 解码在 iPhone 上要 110ms。
       只有在 ROI 缺失（拿不到取景框）时才退回整幅。 */
    var full=!r,pixels=0,restoreHints=null;
    try{
      if(full){if(target.captureCanvas&&(target.captureCanvas.width!==v.videoWidth||target.captureCanvas.height!==v.videoHeight)&&typeof target._destroyCaptureCanvas==='function')target._destroyCaptureCanvas();lastWide=Date.now();stats.fullFrames++;pixels=v.videoWidth*v.videoHeight;stats.lastScope='full';if(!enhanceMode&&target.__scannerHints&&target.reader&&typeof target.reader.setHints==='function'){var harderHints=new Map(target.__scannerHints);harderHints.set(ZXing.DecodeHintType.TRY_HARDER,true);restoreHints=target.__scannerHints;target.reader.setHints(harderHints);}return base(source);}
      // Keep source pixels: crop before luminance extraction, without shrinking narrow bars.
      if(canvas.width!==r.w||canvas.height!==r.h){canvas.width=r.w;canvas.height=r.h;}
      ctx.imageSmoothingEnabled=false;ctx.drawImage(v,r.x,r.y,r.w,r.h,0,0,canvas.width,canvas.height);
      stats.roiFrames++;pixels=canvas.width*canvas.height;stats.lastScope='roi';
      return target.decodeBitmap(new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(new ZXing.HTMLCanvasElementLuminanceSource(canvas))));
    }finally{
      if(restoreHints)target.reader.setHints(restoreHints);
      var ms=Math.max(0,scannerClock()-started);stats.frames++;stats.totalMs+=ms;stats.maxMs=Math.max(stats.maxMs,ms);stats.lastMs=ms;stats.pixels+=pixels;
      // Adapt the wait to observed synchronous work; do not confuse requested FPS with CPU load.
      var duty=enhanceMode ? .5 : p.saving ? .22 : .35;
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
    return {readyState:v.readyState,frameW:scanViewBox?scanViewBox.w:null,frameH:scanViewBox?scanViewBox.h:null,sensorW:v.videoWidth,sensorH:v.videoHeight,roiW:r?r.w:null,roiH:r?r.h:null,roiShare:r?Math.round(r.w*r.h/(v.videoWidth*v.videoHeight)*1000)/10:null};
  }catch(e){return null;}
}
function scannerDiagnostics(){
  var p=scannerPowerProfile(),settings=cameraTrack&&cameraTrack.getSettings?cameraTrack.getSettings():{},s=scannerPrimaryStats,view=scanViewDiagnostics(),seconds=s&&s.startedAt?Math.max(.001,((s.stoppedAt||Date.now())-s.startedAt)/1000):0;
  return {version:typeof VERSION==='undefined'?'R10':VERSION,mode:p.mode,running:scanning,camera:{width:settings.width||null,height:settings.height||null,fps:settings.frameRate||null,torch:settings.torch===true,focus:settings.focusMode||'system'},view:view,seconds:Math.round(seconds),frames:s?s.frames:0,decodeFps:s&&seconds>=1?Math.round(s.frames/seconds*10)/10:0,meanInputPixels:s&&s.frames?Math.round(s.pixels/s.frames):0,roiFrames:s?s.roiFrames:0,fullFrames:s?s.fullFrames:0,meanDecodeMs:s&&s.frames?Math.round(s.totalMs/s.frames*10)/10:0,maxDecodeMs:s?Math.round(s.maxMs*10)/10:0,primaryTimeShare:s&&seconds?Math.round(s.totalMs/(seconds*1000)*1000)/10:0,recoveryStarts:scannerRecoveryStarts};
}
async function copyScannerDiagnostics(){
  var d=scannerDiagnostics(),text=JSON.stringify(d,null,2)+'\n主识别计时占比不是电量或整机 CPU 测量；不含条码和商品数据。';
  try{if(!navigator.clipboard||!navigator.clipboard.writeText)throw Error('clipboard unavailable');await navigator.clipboard.writeText(text);showToast('扫描诊断已复制，可粘贴发给我；不含条码数据');}
  catch(e){showToast(text,false,true);}
}
function scannerPowerProfile(){
  if(enhanceMode)return {mode:'enhanced',saving:false,width:1920,height:1080,fps:24,maxFps:30,retry:80,recoveryGap:500,recoveryAge:600};
  if(scannerPowerSave)return {mode:'saving',saving:true,width:1280,height:720,fps:15,maxFps:20,retry:180,recoveryGap:1000,recoveryAge:1200};
  return {mode:'balanced',saving:false,width:1920,height:1080,fps:18,maxFps:24,retry:110,recoveryGap:650,recoveryAge:850};
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
async function applyCameraTuning(t){if(!t||!t.getCapabilities)return;var c=t.getCapabilities(),s=t.getSettings?t.getSettings():{},a=[];if(c.focusMode&&Array.from(c.focusMode).includes('continuous'))a.push({focusMode:'continuous'});if(c.exposureMode&&Array.from(c.exposureMode).includes('continuous'))a.push({exposureMode:'continuous'});if(c.whiteBalanceMode&&Array.from(c.whiteBalanceMode).includes('continuous'))a.push({whiteBalanceMode:'continuous'});await safeApply(t,a);if(!scanning||t!==cameraTrack)return;scheduleFocusKick();requestBarcodeFocus().catch(function(){});if(c.zoom){currentZoom=clamp(Number(s.zoom)||Number(c.zoom.min)||1,c.zoom.min,c.zoom.max);updateZoomUI(c.zoom);}}
function updateZoomUI(c){var l=document.getElementById('zoomLabel'),m=document.getElementById('zoomOutBtn'),p=document.getElementById('zoomInBtn'),ok=!!c;[l,m,p].forEach(function(x){if(x)x.hidden=!ok;});if(l)l.textContent=currentZoom.toFixed(1)+'×';if(m)m.disabled=!ok||currentZoom<=c.min+.01;if(p)p.disabled=!ok||currentZoom>=c.max-.01;}
async function changeCameraZoom(d){var c=cap(cameraTrack,'zoom');if(!c){showToast('当前浏览器不支持相机变焦',true);return;}var n=clamp(currentZoom+d*Math.max(Number(c.step)||.1,.2),c.min,c.max);if(await safeApply(cameraTrack,[{zoom:n}])){currentZoom=n;updateZoomUI(c);}}
async function requestFocusReset(event){if(!cameraTrack)return;if(await requestBarcodeFocus(event)){showToast("🎯 已请求条码区域对焦，请保持约半秒");return;}if(!scanning||!cameraTrack)return;var m=cap(cameraTrack,'focusMode');if(m&&Array.from(m).includes('continuous')){await safeApply(cameraTrack,[{focusMode:'continuous'}]);showToast('🎯 正在连续对焦，请保持约半秒');}else showToast('此设备由系统自动对焦');}
function kickContinuousFocus(){if(!cameraTrack)return;var a=[],fm=cap(cameraTrack,'focusMode'),em=cap(cameraTrack,'exposureMode');if(fm&&Array.from(fm).includes('continuous'))a.push({focusMode:'continuous'});if(em&&Array.from(em).includes('continuous'))a.push({exposureMode:'continuous'});if(a.length)safeApply(cameraTrack,a);}
function scheduleFocusKick(){focusKickTimers.forEach(clearTimeout);focusKickTimers=[80].map(function(ms){return setTimeout(function(){if(scanning)kickContinuousFocus();},ms);});}
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
  if(v&&v.parentElement)return v.parentElement;
  if(typeof document.querySelector!=='function')return null;
  return document.querySelector('#scanUI .scan-stage')||document.querySelector('#scanUI .relative')||null;
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
  var vw=v.videoWidth||0,vh=v.videoHeight||0,ar=vw>0&&vh>0?vw/vh:scanViewAspect;
  if(!isFinite(ar)||ar<=0)ar=16/9;
  /* 竖屏/方屏视频流不改横向框：object-fit:cover 会裁掉上下，横向仍是传感器全宽——
     条码最需要的正是水平分辨率。 */
  if(ar<1)ar=16/9;else if(ar<1.2)ar=1.2;else if(ar>3)ar=3;
  scanViewAspect=ar;
  var padX=Math.max(6,Math.round(availW*0.015));       /* 只留窄安全边，左右尽量吃满 */
  var w=Math.min(availW-padX*2,1200);
  var insets=scanViewInsets(host);
  var bandTop=insets.top,bandBottom=Math.max(bandTop+120,availH-insets.bottom);
  var bandH=bandBottom-bandTop,h=w/ar;
  if(h>bandH){h=bandH;w=h*ar;}                         /* 横屏/平板按可用高度回退，绝不超出屏幕 */
  var center=Math.round(bandTop+bandH/2);
  ui.style.setProperty('--scan-view-w',Math.round(w)+'px');
  ui.style.setProperty('--scan-view-h',Math.round(h)+'px');
  ui.style.setProperty('--scan-view-center',center+'px');
  ui.style.setProperty('--scan-line-travel',Math.max(12,Math.round(h-26))+'px');
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
}function bindScanViewport(v){
  if(!v||typeof v.addEventListener!=='function'||v.__scanViewBound)return;
  v.__scanViewBound=true;
  v.addEventListener('loadedmetadata',scanViewLayout);
  v.addEventListener('playing',updateScanBoot);
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
async function startScanning(){var sessionToken=scannerRecoveryEpoch,sessionReader=null,sessionStream=null;if(scanning){showToast('扫描器已在运行');return;}var f=document.getElementById('scanFrame'),v=document.getElementById('video');if(f)f.style.top='';document.getElementById('scanUI').style.display='flex';updateScanBoot();scanSessionCount=0;if(typeof updateScanCountLabel==='function')updateScanCountLabel();bindScanViewport(v);scanViewLayout();scanning=true;consecutiveFailures=0;if(reader){try{await reader.reset();}catch(e){}reader=null;}var badge=document.getElementById('enhanceBadge');if(badge)badge.classList.toggle('hidden',!enhanceMode);try{var h=new Map();if(enhanceMode)h.set(ZXing.DecodeHintType.TRY_HARDER,true);h.set(ZXing.DecodeHintType.ALSO_INVERTED,true);h.set(ZXing.DecodeHintType.POSSIBLE_FORMATS,[ZXing.BarcodeFormat.EAN_13,ZXing.BarcodeFormat.EAN_8,ZXing.BarcodeFormat.UPC_A,ZXing.BarcodeFormat.UPC_E,ZXing.BarcodeFormat.CODE_39,ZXing.BarcodeFormat.CODE_93,ZXing.BarcodeFormat.CODE_128,ZXing.BarcodeFormat.ITF,ZXing.BarcodeFormat.CODABAR]);sessionReader=new ZXing.BrowserMultiFormatReader(h);sessionReader.__scannerHints=h;sessionReader.__scannerHarder=!!enhanceMode;reader=sessionReader;installPrimaryROIDecoder(sessionReader,v,f);reader.timeBetweenDecodingAttempts=scannerPowerProfile().retry;updateScanPowerUI();kickVideoPlayback(v);if(scanBootTimer)clearTimeout(scanBootTimer);scanBootTimer=setTimeout(function(){scanBootTimer=null;if(scanning){if(!updateScanBoot())kickVideoPlayback(v);}},1500);sessionStream=await getScannerCameraStream();if(!scanning||sessionToken!==scannerRecoveryEpoch){releaseCameraSession(sessionReader,sessionStream,v);return;}await sessionReader.decodeFromStream(sessionStream,'video',async function(r){if(!scanning||sessionToken!==scannerRecoveryEpoch)return;if(r&&r.getText){acceptDecodedBarcode(r.getText(),r.getBarcodeFormat?String(r.getBarcodeFormat()):'ZXing-JS');return;}consecutiveFailures++;launchSupplementalRecovery(v,f).catch(function(e){console.info('[Scanner] recovery skipped',e&&e.name);});});if(!scanning||sessionToken!==scannerRecoveryEpoch){releaseCameraSession(sessionReader,sessionStream,v);return;}var t=v&&v.srcObject&&v.srcObject.getVideoTracks()[0];if(t){setupCameraControls(t);await applyScannerPowerProfile();scanViewLayout();await applyCameraTuning(t);if(!scanning||sessionToken!==scannerRecoveryEpoch){releaseCameraSession(sessionReader,sessionStream,v);return;}console.info('[Camera] settings',t.getSettings?t.getSettings():{});}showToast('极速扫码已启动'+(enhanceMode?' · WASM增强':' · 自动对焦'));}catch(e){releaseCameraSession(sessionReader,sessionStream,v);if(sessionToken!==scannerRecoveryEpoch)return;console.error('相机错误:',e);var msg=e&&e.name==='NotAllowedError'?'摄像头权限被拒绝':e&&e.name==='NotFoundError'?'未找到后置摄像头':'无法启动摄像头';showToast(msg+'，请检查权限与 HTTPS',true);stopScanning(true);}}
function acceptDecodedBarcode(v,f){if(!scanning)return;scannerRecoveryLastSuccess=Date.now();scannerRecoveryFocusRequested=false;scannerRecoveryPhase=0;var s=String(v||'').trim();if(!s)return;console.info('[Scanner] decoded:',{code:s,format:f,length:s.length});handleBarcode(s,true);consecutiveFailures=0;}
function stopScanning(){if(scannerPrimaryStats&&scannerPrimaryStats.startedAt)scannerPrimaryStats.stoppedAt=Date.now();resetScannerRecovery();scanning=false;if(cameraRestartTimer){clearTimeout(cameraRestartTimer);cameraRestartTimer=null;}cameraSwitching=false;focusKickTimers.forEach(clearTimeout);focusKickTimers=[];if(focusResetTimer){clearTimeout(focusResetTimer);focusResetTimer=null;}if(qualityUpgradeTimer){clearTimeout(qualityUpgradeTimer);qualityUpgradeTimer=null;}if(detectorWarmTimer){clearTimeout(detectorWarmTimer);detectorWarmTimer=null;}if(reader){try{reader.reset();}catch(e){}reader=null;}var v=document.getElementById('video');if(v&&v.srcObject){v.srcObject.getTracks().forEach(function(t){t.stop();});v.srcObject=null;}document.getElementById('scanUI').style.display='none';cameraTrack=null;consecutiveFailures=0;enhancedDecodeBusy=false;highQualityApplied=false;}
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
var startScanningEnergyBase=startScanning;
startScanning=function(){if(scanning){showToast('扫描器已在运行');return Promise.resolve();}resetScannerRecovery();scannerPrimaryStats=null;scannerRecoveryStarts=0;scanStartedAt=Date.now();highQualityApplied=false;return startScanningEnergyBase();};

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
  if(now-Math.max(scanStartedAt,scannerRecoveryLastSuccess)<p.recoveryAge||now-scannerRecoveryLastAt<p.recoveryGap)return;
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
    if(code&&scanning&&token===scannerRecoveryEpoch)acceptDecodedBarcode(code,'recovery '+kind);
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

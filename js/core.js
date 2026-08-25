'use strict';

var VERSION = 'S4.1.2';
var db = [];
var columns = [];
var currentPage = 0;
var pageSize = 500;
var totalPages = 0;
var scanning = false;
var reader = null;
var lastCode = '';
var lastTime = 0;
var currentFocusInterval = null;
var pendingJump = null;
var currentInputElement = null;
var originalViewportHeight = window.innerHeight;
var cameraTrack = null;
var enhanceMode = false;
var consecutiveFailures = 0;
var AUTO_ENHANCE_THRESHOLD = 3;
var toastTimer = null;
var isProcessing = false;
var BATCH_SIZE = 200;
var searchIndex = new Map();
var searchableRows = [];
var undoStack = [];
var MAX_UNDO = 100;

/* v4.1.2 扫码结果提示状态：
 * 只追踪“条码不存在”的持久提示。
 * 下一次识别到不同的有效条码时自动清除，不影响其他错误/进度提示。
 */
var activeBarcodeNotFoundCode = null;

var isAndroid = /Android/i.test(navigator.userAgent);
var isIPad = /iPad|Macintosh/.test(navigator.userAgent) && 'ontouchend' in document;
var isMobile = isAndroid || isIPad || /iPhone/i.test(navigator.userAgent);

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, function(m) {
    return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[m];
  });
}

function showToast(msg, isError, persistent) {
  if (isError === undefined) isError = false;
  if (persistent === undefined) persistent = false;
  var toast = document.getElementById('toast');
  if (!toast) return;
  if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
  toast.replaceChildren();
  if (isError) {
    var span = document.createElement('span');
    span.style.wordBreak = 'break-all';
    span.textContent = String(msg);
    var copyBtn = document.createElement('button');
    copyBtn.className = 'toast-copy';
    copyBtn.textContent = '📋 复制';
    copyBtn.onclick = function(){ copyText(String(msg)); };
    var closeBtn = document.createElement('button');
    closeBtn.className = 'toast-close';
    closeBtn.textContent = '✕';
    closeBtn.onclick = dismissToast;
    toast.append(span, copyBtn, closeBtn);
    Object.assign(toast.style, {background:'#dc2626',display:'block',maxWidth:'92%',whiteSpace:'normal',wordBreak:'break-all',padding:'14px 20px',lineHeight:'1.8',borderRadius:'12px',textAlign:'left'});
    toastTimer = setTimeout(function(){ toast.style.display='none'; toastTimer=null; }, persistent ? 60000 : 20000);
  } else {
    toast.textContent = String(msg);
    Object.assign(toast.style, {background:'#10b981',display:'block',whiteSpace:'nowrap',maxWidth:'80%',padding:'10px 20px',borderRadius:'40px',textAlign:'center'});
    toastTimer = setTimeout(function(){ toast.style.display='none'; toastTimer=null; }, 2000);
  }
}

function dismissToast(){ var toast=document.getElementById('toast'); if(toast) toast.style.display='none'; if(toastTimer){clearTimeout(toastTimer);toastTimer=null;} }

function showBarcodeNotFoundToast(code){
  activeBarcodeNotFoundCode = String(code || '');
  showToast('❌ 条码不存在: ' + activeBarcodeNotFoundCode.substring(0,20), true, true);
}

function clearPreviousBarcodeNotFoundOnNextScan(nextCode){
  var code = String(nextCode || '').trim();
  if(!code || !activeBarcodeNotFoundCode) return;
  /* 同一个不存在条码继续被镜头重复读到时不闪烁；
     只有识别到“另一个”条码才自动移除上一条提示。 */
  if(code !== activeBarcodeNotFoundCode){
    dismissToast();
    activeBarcodeNotFoundCode = null;
  }
}

function clearBarcodeNotFoundState(){
  activeBarcodeNotFoundCode = null;
}
function copyText(text){
  if(navigator.clipboard && navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(function(){showToast('✅ 已复制');}).catch(function(){copyTextFallback(text);});}
  else copyTextFallback(text);
}
function copyTextFallback(text){ var ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';ta.style.left='-9999px';document.body.appendChild(ta);ta.select();try{document.execCommand('copy');showToast('✅ 已复制');}catch(e){showToast('❌ 复制失败，请手动复制',true);}document.body.removeChild(ta); }
function copyToastMessage(){ /* 兼容旧调用 */ }

function playBeep(success, barcode){ if(window.SoundManager){if(success)SoundManager.success(barcode);else SoundManager.error(barcode);return;} }
function vibrate(){ /* v4.1: 震动由 SoundManager 与提示音统一管理，保留兼容空函数 */ }

function normalizeSpecialColumns(){
  var qtyCol='实际数量', priceCol='实际价格';
  if(!columns.includes(qtyCol)) columns.unshift(qtyCol);
  if(!columns.includes(priceCol)) columns.push(priceCol);
  var qi=columns.indexOf(qtyCol); if(qi>0){columns.splice(qi,1);columns.unshift(qtyCol);}
  var pi=columns.indexOf(priceCol); if(pi!==1 && pi>0){columns.splice(pi,1);columns.splice(1,0,priceCol);} else if(pi===-1){columns.splice(1,0,priceCol);}
}

function extractProduct(row){
  var barcode=row['条码']||row['barcode']||row['Barcode']||row['商品编码']||row['编码']||'';
  var name=row['名称']||row['商品名称']||row['name']||row['Name']||'';
  var qty=parseFloat(row['库存数量']||row['数量']||row['库存']||0)||0;
  var price=parseFloat(row['零售价']||row['售价']||row['价格']||0)||0;
  if(!barcode){for(var key in row){var val=String(row[key]||'').trim();if(val&&/^\d{8,14}$/.test(val.replace(/-/g,''))){barcode=val;break;}}}
  if(!name&&barcode) name=barcode;
  return {barcode:String(barcode).trim(),name:String(name).trim(),quantity:qty,price:price,valid:!!((barcode&&barcode!=='')||(name&&name!==''))};
}

function showProgress(show){var el=document.getElementById('progressArea');if(el)el.classList.toggle('active',!!show);}
function updateProgress(current,total,label,status){var pct=total>0?Math.round((current/total)*100):0;var fill=document.getElementById('progressFill'),per=document.getElementById('progressPercent'),count=document.getElementById('progressCount'),lab=document.getElementById('progressLabel'),st=document.getElementById('progressStatus');if(fill)fill.style.width=Math.min(pct,100)+'%';if(per)per.textContent=total>0?Math.min(pct,100)+'%':'…';if(count)count.textContent=total>0?current+' / '+total:String(current);if(label&&lab)lab.textContent=label;if(status&&st)st.textContent=status;}
function showErrors(errors){var el=document.getElementById('errorSummary'),list=document.getElementById('errorList'),title=document.getElementById('errorSummaryTitle');if(!el||!list||!title)return;if(!errors||!errors.length){el.classList.remove('active');return;}el.classList.add('active');title.textContent='⚠️ 导入完成，'+errors.length+' 行失败';list.replaceChildren();errors.slice(0,100).forEach(function(e){var li=document.createElement('li');li.textContent='行 '+e.row+': '+(e.message||'数据异常');list.appendChild(li);});}

function pushUndo(change){undoStack.push(change);if(undoStack.length>MAX_UNDO)undoStack.shift();}
function undoLastChange(){var c=undoStack.pop();if(!c){showToast('没有可撤销的操作');return;}if(c.type==='cell'&&db[c.rowIndex]){db[c.rowIndex][c.col]=c.oldValue;rebuildSearchIndex();renderPage();scheduleAutoSave();showToast('↶ 已撤销');}}

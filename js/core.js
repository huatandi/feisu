'use strict';

var VERSION = 'FEISU 4.8.1';
var db = [];
var columns = [];
var currentPage = 0;
var pageSize = 500;
var totalPages = 0;
var scanning = false;
var reader = null;
var lastCode = '';
var lastTime = 0;
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
var hiddenColumns = new Set();
try{hiddenColumns=new Set(JSON.parse(localStorage.getItem('sanfei_hidden_columns')||'[]'));}catch(e){hiddenColumns=new Set();}

/* v4.1.2 扫码结果提示状态：
 * 只追踪“条码不存在”的持久提示。
 * 下一次识别到不同的有效条码时自动清除，不影响其他错误/进度提示。
 */
var activeBarcodeNotFoundCode = null;
var currentInventoryFilter = 'all';
var unknownBarcodes = {};
var currentImportFileName = '';
var sourceQtyColumn = null;
var SCAN_INCREMENT_COOLDOWN = 650;
var lastIncrementCode = '';
var lastIncrementAt = 0;

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
  toast.className = '';
  Object.assign(toast.style,{left:'50%',top:'20%',width:'auto',maxHeight:'none',transform:'translateX(-50%)',overflow:''});
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
    var dragBtn = document.createElement('button');
    dragBtn.className = 'toast-drag'; dragBtn.textContent = '↔'; dragBtn.title='拖动';
    var closeBtn = document.createElement('button');
    closeBtn.className = 'toast-close';
    closeBtn.textContent = '✕';
    closeBtn.onclick = dismissToast;
    toast.append(span, copyBtn, dragBtn, closeBtn); if(isError)initToastDragResize(toast,dragBtn);
    Object.assign(toast.style, {background:'#dc2626',display:'block',maxWidth:'92%',whiteSpace:'normal',wordBreak:'break-all',padding:'14px 20px',lineHeight:'1.8',borderRadius:'12px',textAlign:'left'});
    toastTimer = setTimeout(function(){ toast.style.display='none'; toastTimer=null; }, persistent ? 60000 : 20000);
  } else {
    toast.textContent = String(msg);
    Object.assign(toast.style, {background:'#10b981',display:'block',whiteSpace:'nowrap',maxWidth:'80%',padding:'10px 20px',borderRadius:'40px',textAlign:'center'});
    toastTimer = setTimeout(function(){ toast.style.display='none'; toastTimer=null; }, 2000);
  }
}

function dismissToast(){ var toast=document.getElementById('toast'); if(toast){toast.classList.remove('scan-error-toast');toast.style.setProperty('display','none','important');} if(toastTimer){clearTimeout(toastTimer);toastTimer=null;} activeBarcodeNotFoundCode=null; }

function showBarcodeNotFoundToast(code){
  activeBarcodeNotFoundCode = String(code || '');
  recordUnknownBarcode(activeBarcodeNotFoundCode);
  showToast('❌ 条码不存在: ' + activeBarcodeNotFoundCode, true, true);
  var toast=document.getElementById('toast');
  if(toast&&scanning){toast.classList.add('scan-error-toast');requestAnimationFrame(positionScanErrorToast);}
}

function positionScanErrorToast(){
  var toast=document.getElementById('toast'),frame=document.getElementById('scanFrame'),header=document.querySelector('#scanUI .scan-header');
  if(!toast||!frame||!header||!toast.classList.contains('scan-error-toast'))return;
  var saved=getToastGeometry(); if(saved){Object.assign(toast.style,{left:Math.max(0,Math.min(saved.left,window.innerWidth-80))+'px',top:Math.max(0,Math.min(saved.top,window.innerHeight-50))+'px',width:Math.min(saved.width,window.innerWidth-12)+'px',height:saved.height?Math.min(saved.height,window.innerHeight-20)+'px':'auto',maxWidth:'96vw',maxHeight:'70vh',transform:'none'});return;}
  var fr=frame.getBoundingClientRect(),hr=header.getBoundingClientRect(),gap=6,available=Math.max(34,fr.top-hr.bottom-gap*2);
  Object.assign(toast.style,{left:fr.left+'px',top:(hr.bottom+gap)+'px',width:fr.width+'px',maxWidth:fr.width+'px',maxHeight:available+'px',transform:'none'});
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
  var q='实际数量',d='差异',st='盘点状态',p='实际价格';
  [q,d,st].forEach(function(c){var i=columns.indexOf(c);if(i!==-1)columns.splice(i,1);});
  sourceQtyColumn=sourceQtyColumn||detectSourceQtyColumn(columns,db);
  var at=sourceQtyColumn?columns.indexOf(sourceQtyColumn)+1:0;if(at<0)at=0;columns.splice(at,0,q,d,st);
  if(!columns.includes(p))columns.push(p);
}
function extractProduct(row){
  var barcode=row['条码']||row['barcode']||row['Barcode']||row['商品编码']||row['编码']||'';
  var name=row['名称']||row['商品名称']||row['name']||row['Name']||'';
  var qty=parseFloat(row['CNT']||row['数量']||row['库存数量']||row['库存']||0)||0;
  var price=parseFloat(row['零售价']||row['售价']||row['价格']||0)||0;
  if(!barcode){for(var key in row){var val=String(row[key]||'').trim();if(val&&/^\d{8,14}$/.test(val.replace(/-/g,''))){barcode=val;break;}}}
  if(!name&&barcode) name=barcode;
  return {barcode:String(barcode).trim(),name:String(name).trim(),quantity:qty,price:price,valid:!!((barcode&&barcode!=='')||(name&&name!==''))};
}



/* v4.8: 智能识别 Excel 原数量列 + 盘点状态。 */
function normalizeHeaderName(v){return String(v||'').trim().toUpperCase().replace(/[\s._\-\/\\]+/g,'');}
function quantityHeaderScore(name){
  var n=normalizeHeaderName(name);
  if(!n || n==='实际数量' || n==='差异' || n==='盘点状态') return -1;
  var exact={
    'CNT':120,'CANT':118,'CUANT':118,'CANTIDAD':118,'QTY':116,'QUANTITY':116,
    '总数量':115,'总数':114,'总量':114,'数量':112,'库存数量':112,'账面数量':112,'原数量':112,
    '件数':110,'个数':110,'PIEZAS':108,'PIEZA':108,'PCS':108,'UNIDADES':106,'UNDS':104,'UDS':104,
    'UDSE':86,'UDS/E':86
  };
  if(Object.prototype.hasOwnProperty.call(exact,n)) return exact[n];
  if(/^(CNT|CANT|CUANT|CANTIDAD|QTY|QUANTITY)\d*$/.test(n)) return 105;
  if(/(总数量|库存数量|账面数量|原数量|数量|件数|个数)/.test(n)) return 100;
  if(/(UNIDADES|PIEZAS|PCS|UNDS|UDS)/.test(n)) return 80;
  return -1;
}
function detectSourceQtyColumn(cols, rows){
  var best=null,bestScore=-1;
  (cols||[]).forEach(function(col,idx){
    var score=quantityHeaderScore(col); if(score<0)return;
    var checked=0,numeric=0;
    for(var i=0;i<Math.min((rows||[]).length,60);i++){
      var v=rows[i]&&rows[i][col]; if(v===null||v===undefined||String(v).trim()==='')continue;
      checked++; if(comparableNumber(v)!==null) numeric++;
    }
    if(checked) score += Math.min(8,(numeric/checked)*8);
    score -= idx*0.001;
    if(score>bestScore){bestScore=score;best=col;}
  });
  return best;
}
function getSourceQtyColumn(row){
  if(sourceQtyColumn && row && Object.prototype.hasOwnProperty.call(row,sourceQtyColumn)) return sourceQtyColumn;
  var keys=Object.keys(row||{}),best=null,bestScore=-1;
  keys.forEach(function(k){var sc=quantityHeaderScore(k);if(sc>bestScore){bestScore=sc;best=k;}});
  return bestScore>=0?best:null;
}
function comparableNumber(value){
  if(value===null||value===undefined||String(value).trim()==='') return null;
  var n=Number(String(value).replace(/,/g,'').trim());
  return Number.isFinite(n)?n:null;
}
function getQtyComparison(row){
  var sourceCol=getSourceQtyColumn(row),source=sourceCol?comparableNumber(row[sourceCol]):null,actual=comparableNumber(row&&row['实际数量']);
  if(!sourceCol) return {sourceCol:null,source:null,actual:actual,diff:null,state:'none'};
  if(source===null||actual===null) return {sourceCol:sourceCol,source:source,actual:actual,diff:null,state:'none'};
  var diff=actual-source;
  return {sourceCol:sourceCol,source:source,actual:actual,diff:diff,state:Math.abs(diff)<1e-9?'match':'mismatch'};
}
function getInventoryStatus(row){
  if(row&&row.__feisuStatus==='notfound') return '实物未找到';
  var cmp=getQtyComparison(row),actual=cmp.actual;
  if(actual===null) return '未盘点';
  if(actual===0) return '实际为零';
  if(cmp.source===null) return '已盘点';
  if(Math.abs(cmp.diff)<1e-9) return '一致';
  return cmp.diff<0?'数量不足':'数量超出';
}
function getInventoryDiff(row){var c=getQtyComparison(row);return c.diff===null?'':c.diff;}
function isProblemRow(row){var st=getInventoryStatus(row);return st==='数量不足'||st==='数量超出'||st==='实物未找到'||st==='实际为零';}
function rowMatchesInventoryFilter(row){
  var st=getInventoryStatus(row);
  if(currentInventoryFilter==='all')return true;
  if(currentInventoryFilter==='unpan')return st==='未盘点';
  if(currentInventoryFilter==='match')return st==='一致';
  if(currentInventoryFilter==='short')return st==='数量不足';
  if(currentInventoryFilter==='over')return st==='数量超出';
  if(currentInventoryFilter==='notfound')return st==='实物未找到';
  if(currentInventoryFilter==='review')return isProblemRow(row)&&!row.__feisuReviewed;
  return true;
}
function inventorySummary(){
  var r={total:db.length,unpan:0,match:0,short:0,over:0,notfound:0,zero:0,review:0};
  db.forEach(function(row){var st=getInventoryStatus(row);if(st==='未盘点')r.unpan++;else if(st==='一致')r.match++;else if(st==='数量不足')r.short++;else if(st==='数量超出')r.over++;else if(st==='实物未找到')r.notfound++;else if(st==='实际为零')r.zero++;if(isProblemRow(row)&&!row.__feisuReviewed)r.review++;});
  r.completed=r.total-r.unpan; r.percent=r.total?Math.round(r.completed/r.total*1000)/10:0; return r;
}
function setInventoryFilter(filter){currentInventoryFilter=filter||'all';currentPage=0;renderPage();scheduleAutoSave();}
function recordUnknownBarcode(code){var c=String(code||'').trim();if(!c)return;unknownBarcodes[c]=(unknownBarcodes[c]||0)+1;scheduleAutoSave();}
function showUnknownBarcodes(){
  var items=Object.keys(unknownBarcodes).sort(function(a,b){return unknownBarcodes[b]-unknownBarcodes[a];});
  if(!items.length){showToast('✅ 暂无未知条码');return;}
  alert('Excel 中不存在的条码（扫描次数）\n\n'+items.map(function(c){return c+'  × '+unknownBarcodes[c];}).join('\n'));
}
function markRowNotFound(rowIndex){if(!db[rowIndex])return;db[rowIndex].__feisuStatus=db[rowIndex].__feisuStatus==='notfound'?'': 'notfound';if(db[rowIndex].__feisuStatus==='notfound')db[rowIndex]['实际数量']='';db[rowIndex].__feisuReviewed=false;renderPage();scheduleAutoSave();}
function markRowReviewed(rowIndex){if(!db[rowIndex])return;db[rowIndex].__feisuReviewed=true;renderPage();scheduleAutoSave();showToast('✅ 已复盘确认');}
function isExactBarcodeForRow(row,code){
  var names=['条码','Código Barras','Codigo Barras','barcode','Barcode','商品条码','EAN','UPC'];
  for(var i=0;i<names.length;i++){if(row&&Object.prototype.hasOwnProperty.call(row,names[i])&&exactMatch(code,row[names[i]]))return true;}
  return false;
}
function incrementScannedQty(rowIndex,code){
  var row=db[rowIndex];if(!row||!isExactBarcodeForRow(row,code))return false;
  var now=Date.now();if(code===lastIncrementCode&&(now-lastIncrementAt)<SCAN_INCREMENT_COOLDOWN)return false;
  lastIncrementCode=code;lastIncrementAt=now;
  var old=comparableNumber(row['实际数量']);row['实际数量']=(old===null?1:old+1);row.__feisuStatus='';row.__feisuReviewed=false;scheduleAutoSave();return true;
}

function getToastGeometry(){try{return JSON.parse(localStorage.getItem('feisu_scan_error_geometry')||'null');}catch(e){return null;}}
function saveToastGeometry(toast){if(!toast||!toast.classList.contains('scan-error-toast'))return;var r=toast.getBoundingClientRect();localStorage.setItem('feisu_scan_error_geometry',JSON.stringify({left:r.left,top:r.top,width:r.width,height:r.height}));}
function initToastDragResize(toast,handle){
  if(!toast||!handle||handle.__bound)return;handle.__bound=true;
  handle.addEventListener('pointerdown',function(e){e.preventDefault();var r=toast.getBoundingClientRect(),sx=e.clientX,sy=e.clientY;toast.style.transform='none';toast.style.left=r.left+'px';toast.style.top=r.top+'px';handle.setPointerCapture(e.pointerId);
    function move(ev){toast.style.left=Math.max(0,Math.min(window.innerWidth-80,r.left+ev.clientX-sx))+'px';toast.style.top=Math.max(0,Math.min(window.innerHeight-50,r.top+ev.clientY-sy))+'px';}
    function up(ev){handle.releasePointerCapture(ev.pointerId);handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',up);saveToastGeometry(toast);}
    handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',up);
  });
  if(window.ResizeObserver&&!toast.__resizeObserver){toast.__resizeObserver=new ResizeObserver(function(){if(toast.style.display!=='none')saveToastGeometry(toast);});toast.__resizeObserver.observe(toast);}
}

function showProgress(show){var el=document.getElementById('progressArea');if(el)el.classList.toggle('active',!!show);}
function updateProgress(current,total,label,status){var pct=total>0?Math.round((current/total)*100):0;var fill=document.getElementById('progressFill'),per=document.getElementById('progressPercent'),count=document.getElementById('progressCount'),lab=document.getElementById('progressLabel'),st=document.getElementById('progressStatus');if(fill)fill.style.width=Math.min(pct,100)+'%';if(per)per.textContent=total>0?Math.min(pct,100)+'%':'…';if(count)count.textContent=total>0?current+' / '+total:String(current);if(label&&lab)lab.textContent=label;if(status&&st)st.textContent=status;}
function showErrors(errors){var el=document.getElementById('errorSummary'),list=document.getElementById('errorList'),title=document.getElementById('errorSummaryTitle');if(!el||!list||!title)return;if(!errors||!errors.length){el.classList.remove('active');return;}el.classList.add('active');title.textContent='⚠️ 导入完成，'+errors.length+' 行失败';list.replaceChildren();errors.slice(0,100).forEach(function(e){var li=document.createElement('li');li.textContent='行 '+e.row+': '+(e.message||'数据异常');list.appendChild(li);});}

function pushUndo(change){undoStack.push(change);if(undoStack.length>MAX_UNDO)undoStack.shift();}
function undoLastChange(){var c=undoStack.pop();if(!c){showToast('没有可撤销的操作');return;}if(c.type==='cell'&&db[c.rowIndex]){db[c.rowIndex][c.col]=c.oldValue;rebuildSearchIndex();renderPage();scheduleAutoSave();showToast('↶ 已撤销');}}

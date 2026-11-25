'use strict';
function makeStatusCell(realIdx,row){
  var td=document.createElement('td');td.dataset.col='盘点状态';td.dataset.rowIndex=realIdx;td.className='status-cell';
  var status=getInventoryStatus(row),pill=document.createElement('span');pill.className='status-pill status-'+status; pill.textContent=status+(row.__feisuReviewed?' ✓复盘':'');td.appendChild(pill);
  var nf=document.createElement('button');nf.className='mini-status-btn';nf.textContent=row.__feisuStatus==='notfound'?'取消未找到':'未找到';nf.onclick=function(){markRowNotFound(realIdx);};td.appendChild(nf);
  if(isProblemRow(row)&&!row.__feisuReviewed){var rv=document.createElement('button');rv.className='mini-status-btn review';rv.textContent='复盘确认';rv.onclick=function(){markRowReviewed(realIdx);};td.appendChild(rv);}
  return td;
}
function makeInputCell(realIdx,col,row){
  if(col==='盘点状态')return makeStatusCell(realIdx,row);
  var td=document.createElement('td');td.dataset.col=col;td.dataset.rowIndex=realIdx;
  if(col==='差异'){var d=document.createElement('div');d.className='diff-cell';var v=getInventoryDiff(row);d.textContent=v===''?'—':(v>0?'+'+v:String(v));td.appendChild(d);return td;}
  var pictures=typeof getRowPictures==='function'?getRowPictures(row,col):[];
  if(pictures.length){pictures.forEach(function(pic){var img=document.createElement('img');img.src=pic.data;img.className='product-picture';img.alt='商品图片';img.loading='lazy';img.onclick=function(){openPicturePreview(pic.data);};td.appendChild(img);});if(row[col]&&!safePictureSource(row[col])){var caption=document.createElement('div');caption.textContent=String(row[col]);td.appendChild(caption);}return td;}
  var input=document.createElement('input');
  if(col==='实际数量'){input.id='qty-'+realIdx;input.type='number';input.value=row[col]??'';input.className='qty-input';input.placeholder='未盘';input.inputMode='numeric';input.addEventListener('change',function(){updateQty(realIdx,this.value);});}
  else if(col==='实际价格'){input.id='price-'+realIdx;input.type='number';input.step='0.01';input.value=row[col]??'';input.className='price-input';input.placeholder='0.00';input.inputMode='decimal';input.addEventListener('change',function(){updatePrice(realIdx,this.value);});}
  else{var val=String(row[col]??'');input.type='text';input.value=val.length>100?val.slice(0,100)+'...':val;input.className='w-full p-2 text-sm outline-none bg-transparent';input.style.minWidth='80px';input.style.width='100%';if(col===sourceQtyColumn)input.classList.add('qty-source-input');td.title=val;input.addEventListener('change',function(){updateCell(realIdx,col,this.value);});}
  input.addEventListener('focus',function(){this.select();});td.appendChild(input);
  var cmp=getQtyComparison(row);if(cmp.state==='match'&&(col==='实际数量'||col===cmp.sourceCol))input.classList.add('qty-compare-match');else if(cmp.state==='mismatch'&&col==='实际数量')input.classList.add('qty-compare-actual-mismatch');else if(cmp.state==='mismatch'&&col===cmp.sourceCol)input.classList.add('qty-compare-source-mismatch');return td;
}
function filteredRowIndexes(){var out=[];for(var i=0;i<db.length;i++)if(rowMatchesInventoryFilter(db[i]))out.push(i);return out;}
function renderDashboard(){
  var el=document.getElementById('inventoryStats');if(!el)return;var s=inventorySummary();el.innerHTML='<span>总 '+s.total+'</span><span>已盘 '+s.completed+'</span><span>未盘 '+s.unpan+'</span><span>差异 '+(s.short+s.over)+'</span><span>未找到 '+s.notfound+'</span><strong>'+s.percent+'%</strong>';
  document.querySelectorAll('.inventory-filters button[data-filter]').forEach(function(b){b.classList.toggle('active',b.dataset.filter===currentInventoryFilter);});
}
function renderPage(){try{
  var thead=document.getElementById('tHead'),tbody=document.getElementById('tBody'),idxs=filteredRowIndexes(),total=idxs.length;totalPages=Math.ceil(total/pageSize)||1;if(currentPage>=totalPages)currentPage=totalPages-1;if(currentPage<0)currentPage=0;var start=currentPage*pageSize,end=Math.min(start+pageSize,total),pageIdx=idxs.slice(start,end);
  document.getElementById('pageInfo').textContent='第 '+(currentPage+1)+' / '+totalPages+' 页';document.getElementById('totalInfo').textContent='显示 '+total+' / '+db.length+' 条';document.getElementById('prevPageBtn').disabled=currentPage===0;document.getElementById('nextPageBtn').disabled=currentPage>=totalPages-1;thead.replaceChildren();tbody.replaceChildren();renderDashboard();
  if(!columns.length||!db.length){var tr0=document.createElement('tr'),td0=document.createElement('td');td0.colSpan=10;td0.className='text-center p-6 text-gray-500';td0.textContent='暂无数据，请导入Excel或CSV文件';tr0.appendChild(td0);tbody.appendChild(tr0);return;}
  var thr=document.createElement('tr');columns.forEach(function(col){var th=document.createElement('th');th.textContent=(typeof displayColumnName==='function'?displayColumnName(col):col);thr.appendChild(th);});thead.appendChild(thr);
  var frag=document.createDocumentFragment();pageIdx.forEach(function(realIdx){var row=db[realIdx],tr=document.createElement('tr');tr.id='row-'+realIdx;columns.forEach(function(col){tr.appendChild(makeInputCell(realIdx,col,row));});frag.appendChild(tr);});tbody.appendChild(frag);setTimeout(autoAdjustColumns,30);
  if(pendingJump!==null){var pos=idxs.indexOf(pendingJump);if(pos!==-1){var targetPage=Math.floor(pos/pageSize);if(targetPage!==currentPage){currentPage=targetPage;renderPage();return;}setTimeout(function(){jumpToRowAndFocusQty(pendingJump);pendingJump=null;},100);}}
}catch(e){console.error('渲染错误:',e);showToast('渲染错误: '+e.message,true);}}
function changePage(delta){var p=currentPage+delta;if(p>=0&&p<totalPages){currentPage=p;renderPage();scheduleAutoSave();}}
function updateStats(){renderDashboard();}
function refreshQtyComparison(rowIndex){renderPage();}
function updateQty(rowIndex,value){if(db[rowIndex]){pushUndo({type:'cell',rowIndex:rowIndex,col:'实际数量',oldValue:db[rowIndex]['实际数量'],newValue:value});db[rowIndex]['实际数量']=value;db[rowIndex].__feisuStatus='';delete db[rowIndex].__feisuNotFoundPreviousActual;db[rowIndex].__feisuReviewed=false;renderPage();scheduleAutoSave();showToast('数量已更新');hideKeyboard();}}
function updatePrice(rowIndex,value){if(db[rowIndex]){pushUndo({type:'cell',rowIndex:rowIndex,col:'实际价格',oldValue:db[rowIndex]['实际价格'],newValue:value});db[rowIndex]['实际价格']=value;renderDashboard();scheduleAutoSave();showToast('价格已更新');hideKeyboard();}}
function updateCell(rowIndex,col,value){if(db[rowIndex]){pushUndo({type:'cell',rowIndex:rowIndex,col:col,oldValue:db[rowIndex][col],newValue:value});db[rowIndex][col]=value;if(col===sourceQtyColumn)db[rowIndex].__feisuReviewed=false;rebuildSearchIndex();renderPage();scheduleAutoSave();}}
function autoAdjustColumns(){var table=document.getElementById('mainTable');if(!table)return;var visible=columns.length;if(!visible)return;var headers=table.querySelectorAll('thead th'),rows=table.querySelectorAll('tbody tr'),widths=new Array(visible).fill(0);headers.forEach(function(th,idx){if(idx<visible)widths[idx]=Math.max(widths[idx],Math.min((th.textContent||'').length*14+40,220));});rows.forEach(function(row){row.querySelectorAll('td').forEach(function(cell,idx){if(idx>=visible)return;var input=cell.querySelector('input'),text=input?(input.value||input.placeholder||''):(cell.textContent||''),w=Math.max(80,Math.min(260,text.length*10+30));if(w>widths[idx])widths[idx]=w;});});headers.forEach(function(th,idx){if(widths[idx]>0){th.style.width=widths[idx]+'px';th.style.minWidth=widths[idx]+'px';}});}
function jumpToRowAndFocusQty(foundIndex){var rowEl=document.getElementById('row-'+foundIndex);if(!rowEl){currentInventoryFilter='all';pendingJump=foundIndex;renderPage();return false;}document.querySelectorAll('#mainTable tbody tr').forEach(function(tr){tr.classList.remove('row-focus');});rowEl.classList.add('row-focus');rowEl.scrollIntoView({behavior:'smooth',block:'center'});var qty=document.getElementById('qty-'+foundIndex);
  if(qty){
    currentInputElement=qty;
    /* iOS 只在“用户手势的同一轮”里允许程序化聚焦弹出键盘。
       扫码结果是相机回调里来的，没有手势，所以先同步 focus（有时还能赶上），
       再补两次延时重试；都失败时把该框高亮，提示用户点一下。 */
    try{qty.focus();qty.select();}catch(e){}
    setTimeout(function(){try{qty.focus();qty.select();}catch(e){}},90);
    setTimeout(function(){
      try{
        if(document.activeElement!==qty){
          qty.focus();qty.select();
          if(document.activeElement!==qty){
            qty.classList.add('qty-needs-tap');
            setTimeout(function(){qty.classList.remove('qty-needs-tap');},2500);
          }
        }
      }catch(e){}
    },260);
  }
  return true;}
/* v5.0.3 连扫计数（可选，默认关）：
   扫码命中即 +1、相机不关闭、不重建整张表；非精确匹配仍退回人工确认。 */
function flashScanFrame(){var frame=document.getElementById('scanFrame');if(!frame)return;frame.classList.add('scan-success');setTimeout(function(){frame.classList.remove('scan-success');},200);}
function updateScanCountLabel(){
  var b=document.getElementById('scanCountBtn'),l=document.getElementById('scanCountLabel');
  if(b){b.classList.toggle('active',!!scanCountMode);b.textContent=scanCountMode?'⚡ 连扫中':'⚡ 连扫计数';b.setAttribute('aria-pressed',String(!!scanCountMode));}
  if(l){l.hidden=!scanCountMode;l.textContent='本次 '+scanSessionCount+' 件';}
}
function toggleScanCountMode(){
  scanCountMode=!scanCountMode;
  try{localStorage.setItem('sanfei_scan_count',scanCountMode?'1':'0');}catch(e){}
  if(!scanCountMode)scanSessionCount=0;
  updateScanCountLabel();
  showToast(scanCountMode?'⚡ 连扫计数已开启：扫码即 +1、不关相机；再点一次可退出':'已关闭连扫：扫码后跳行，等你输入数量');
}
function handleBarcode(code,fromCamera){
  if(!code)return false;
  var now=Date.now(),codeStr=String(code).trim();
  if(!codeStr)return false;
  clearPreviousBarcodeNotFoundOnNextScan(codeStr);
  if(codeStr===lastCode&&(now-lastTime)<200)return false;
  lastCode=codeStr;lastTime=now;
  /* 摄像头先走严格匹配；未命中再走“残缺条码分级匹配”（只定位、不计数）。 */
  var idx=fromCamera?findStrictBarcodeRow(codeStr):findBestMatchRowIndex(codeStr);
  var fragmentHit=null;
  if(idx===-1&&fromCamera&&scanFragmentMatch){
    var fm=typeof findFragmentBarcodeRow==='function'?findFragmentBarcodeRow(codeStr):null;
    if(fm&&fm.tier==='auto'){idx=fm.row;fragmentHit=fm;}
    else if(fm&&fm.tier==='candidates'){
      if(typeof showFragmentCandidates==='function')showFragmentCandidates(fm.candidates,'残缺条码 '+fm.fragment+'：请点选正确商品');
      else showToast('残缺条码命中 '+fm.candidates.length+' 个候选，请用「🔢 数字片段」确认',true);
      consecutiveFailures=0;return false;
    }
  }
  if(idx===-1){playBeep(false,codeStr);showBarcodeNotFoundToast(codeStr);consecutiveFailures++;return false;}
  clearBarcodeNotFoundState();consecutiveFailures=0;
  /* A 级片段命中：只定位 + 明确警示，绝不自动加数量。 */
  if(fragmentHit){
    playBeep(true,codeStr);
    showToast('⚠️ 片段匹配：'+fragmentHit.fragment+' → '+fragmentHit.code+'，请核对商品再填数量',true);
    currentInventoryFilter='all';
    var fIdxAll=filteredRowIndexes(),fPos=fIdxAll.indexOf(idx),fPage=fPos<0?0:Math.floor(fPos/pageSize);
    if(fPage!==currentPage)currentPage=fPage;
    renderPage();
    var fRow=document.getElementById('row-'+idx);if(fRow)fRow.classList.add('prefix-hit');
    jumpToRowAndFocusQty(idx);
    if(fromCamera)stopScanningAndJump(idx);
    return true;
  }
  var product=typeof extractProduct==='function'?extractProduct(db[idx]):null;
  var productName=(product&&product.name)||db[idx]['名称']||db[idx]['商品名称']||db[idx]['Descripción']||codeStr;
  if(fromCamera&&scanCountMode&&isExactBarcodeForRow(db[idx],codeStr)){
    if(incrementScannedQty(idx,codeStr)){
      scanSessionCount++;
      var qty=db[idx]['实际数量'],input=document.getElementById('qty-'+idx);
      if(input)input.value=qty;
      playBeep(true,codeStr);
      flashScanFrame();
      updateScanCountLabel();
      renderDashboard();
      showToast('✅ '+productName+' ×'+qty);
    }
    return true;                    /* 冷却期内的重复命中直接忽略，相机和表格都不动 */
  }
  playBeep(true,codeStr);
  showToast('✅ '+productName+' · 请盘点实际数量');
  var frame=document.getElementById('scanFrame');
  if(frame){frame.classList.add('scan-success');setTimeout(function(){frame.classList.remove('scan-success');},200);}
  currentInventoryFilter='all';
  var idxs=filteredRowIndexes(),pos=idxs.indexOf(idx),p=pos<0?0:Math.floor(pos/pageSize);
  if(p!==currentPage)currentPage=p;
  renderPage();
  jumpToRowAndFocusQty(idx);
  if(fromCamera)stopScanningAndJump(idx);
  return true;
}
function render(){renderPage();}

/* v5.0.4：残缺条码分级匹配开关（默认开：只定位、不计数） */
function updateFragmentMatchUI(){
  var b=document.getElementById('fragmentMatchBtn');
  if(b)b.textContent=(typeof scanFragmentMatch!=='undefined'&&scanFragmentMatch)?'🔗 片段匹配：开':'🔗 片段匹配：关';
}
function toggleFragmentMatchMode(){
  scanFragmentMatch=!scanFragmentMatch;
  try{localStorage.setItem('sanfei_fragment_match',scanFragmentMatch?'1':'0');}catch(e){}
  updateFragmentMatchUI();
  showToast(scanFragmentMatch?'残缺条码可自动定位（唯一命中且≥10 位）；多命中只列候选，不会自动计数':'已关闭：只接受完整条码精确匹配');
}

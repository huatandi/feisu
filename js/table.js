'use strict';
function makeInputCell(realIdx,col,row){var td=document.createElement('td');var input=document.createElement('input');td.dataset.col=col;td.dataset.rowIndex=realIdx;if(col==='实际数量'){input.id='qty-'+realIdx;input.type='number';input.value=row[col]??'';input.className='qty-input';input.placeholder='0';input.inputMode='numeric';input.addEventListener('change',function(){updateQty(realIdx,this.value);});}else if(col==='实际价格'){input.id='price-'+realIdx;input.type='number';input.step='0.01';input.value=row[col]??'';input.className='price-input';input.placeholder='0.00';input.inputMode='decimal';input.addEventListener('change',function(){updatePrice(realIdx,this.value);});}else{var val=String(row[col]??'');input.type='text';input.value=val.length>100?val.slice(0,100)+'...':val;input.className='w-full p-2 text-sm outline-none bg-transparent';input.style.minWidth='80px';input.style.width='100%';td.title=val;input.addEventListener('change',function(){updateCell(realIdx,col,this.value);});}input.addEventListener('focus',function(){this.select();});td.appendChild(input);var cmp=getQtyComparison(row);if(cmp.state==='match'&&(col==='实际数量'||col===cmp.sourceCol))input.classList.add('qty-compare-match');else if(cmp.state==='mismatch'&&col==='实际数量')input.classList.add('qty-compare-actual-mismatch');else if(cmp.state==='mismatch'&&col===cmp.sourceCol)input.classList.add('qty-compare-source-mismatch');return td;}
function renderPage(){try{var thead=document.getElementById('tHead'),tbody=document.getElementById('tBody');var total=db.length;totalPages=Math.ceil(total/pageSize)||1;if(currentPage>=totalPages)currentPage=totalPages-1;if(currentPage<0)currentPage=0;var start=currentPage*pageSize,end=Math.min(start+pageSize,total),pageData=db.slice(start,end);document.getElementById('pageInfo').textContent='第 '+(currentPage+1)+' / '+totalPages+' 页';document.getElementById('totalInfo').textContent='共 '+total+' 条';document.getElementById('prevPageBtn').disabled=currentPage===0;document.getElementById('nextPageBtn').disabled=currentPage>=totalPages-1;thead.replaceChildren();tbody.replaceChildren();if(!columns.length||!total){var tr0=document.createElement('tr'),td0=document.createElement('td');td0.colSpan=10;td0.className='text-center p-6 text-gray-500';td0.textContent='暂无数据，请导入Excel或CSV文件';tr0.appendChild(td0);tbody.appendChild(tr0);return;}var thr=document.createElement('tr');columns.forEach(function(col){var th=document.createElement('th');th.textContent=col;thr.appendChild(th);});thead.appendChild(thr);var frag=document.createDocumentFragment();pageData.forEach(function(row,idx){var realIdx=start+idx;var tr=document.createElement('tr');tr.id='row-'+realIdx;columns.forEach(function(col){tr.appendChild(makeInputCell(realIdx,col,row));});frag.appendChild(tr);});tbody.appendChild(frag);setTimeout(autoAdjustColumns,30);if(pendingJump!==null){var jumpIdx=pendingJump,targetPage=Math.floor(jumpIdx/pageSize);if(targetPage!==currentPage){currentPage=targetPage;renderPage();return;}setTimeout(function(){jumpToRowAndFocusQty(jumpIdx);pendingJump=null;},100);}updateStats();}catch(e){console.error('渲染错误:',e);showToast('渲染错误: '+e.message,true);}}
function changePage(delta){var p=currentPage+delta;if(p>=0&&p<totalPages){currentPage=p;renderPage();scheduleAutoSave();}}
function updateStats(){var statsDiv=document.querySelector('.stats');if(!statsDiv)return;var totalPrice=0;for(var i=0;i<db.length;i++){totalPrice+=(parseFloat(db[i]['实际数量'])||0)*(parseFloat(db[i]['实际价格'])||0);}statsDiv.textContent='';var a=document.createElement('span');a.textContent='📊 '+db.length+' 条';var b=document.createElement('span');b.textContent='💰 '+totalPrice.toFixed(2);statsDiv.append(a,b);}
function refreshQtyComparison(rowIndex){var tr=document.getElementById('row-'+rowIndex);if(!tr||!db[rowIndex])return;var cmp=getQtyComparison(db[rowIndex]);tr.querySelectorAll('input').forEach(function(el){el.classList.remove('qty-compare-match','qty-compare-actual-mismatch','qty-compare-source-mismatch');});tr.querySelectorAll('td').forEach(function(td){var input=td.querySelector('input'),col=td.dataset.col;if(!input)return;if(cmp.state==='match'&&(col==='实际数量'||col===cmp.sourceCol))input.classList.add('qty-compare-match');else if(cmp.state==='mismatch'&&col==='实际数量')input.classList.add('qty-compare-actual-mismatch');else if(cmp.state==='mismatch'&&col===cmp.sourceCol)input.classList.add('qty-compare-source-mismatch');});}
function updateQty(rowIndex,value){if(db[rowIndex]){pushUndo({type:'cell',rowIndex:rowIndex,col:'实际数量',oldValue:db[rowIndex]['实际数量'],newValue:value});db[rowIndex]['实际数量']=value;refreshQtyComparison(rowIndex);updateStats();scheduleAutoSave();showToast('数量已更新');hideKeyboard();}}
function updatePrice(rowIndex,value){if(db[rowIndex]){pushUndo({type:'cell',rowIndex:rowIndex,col:'实际价格',oldValue:db[rowIndex]['实际价格'],newValue:value});db[rowIndex]['实际价格']=value;updateStats();scheduleAutoSave();showToast('价格已更新');hideKeyboard();}}
function updateCell(rowIndex,col,value){if(db[rowIndex]){pushUndo({type:'cell',rowIndex:rowIndex,col:col,oldValue:db[rowIndex][col],newValue:value});db[rowIndex][col]=value;refreshQtyComparison(rowIndex);rebuildSearchIndex();scheduleAutoSave();}}
function autoAdjustColumns(){var table=document.getElementById('mainTable');if(!table)return;var colCount=columns.length;if(!colCount)return;var headers=table.querySelectorAll('thead th'),rows=table.querySelectorAll('tbody tr');if(!headers.length)return;var widths=new Array(colCount).fill(0);headers.forEach(function(th,idx){if(idx<colCount)widths[idx]=Math.max(widths[idx],Math.min((th.textContent||'').length*14+40,200));});rows.forEach(function(row){row.querySelectorAll('td').forEach(function(cell,idx){if(idx>=colCount)return;var input=cell.querySelector('input'),text=input?(input.value||input.placeholder||''):(cell.textContent||''),w=0;for(var i=0;i<text.length;i++){var c=text.charCodeAt(i);w+=(c>=0x4e00&&c<=0x9fff)?16:(c>=0x30&&c<=0x39)?8:10;}w=Math.max(w+30,80);w=Math.min(w,250);if(w>widths[idx])widths[idx]=w;});});headers.forEach(function(th,idx){if(widths[idx]>0){th.style.width=widths[idx]+'px';th.style.minWidth=widths[idx]+'px';}});}
function jumpToRowAndFocusQty(foundIndex){var rowEl=document.getElementById('row-'+foundIndex);if(!rowEl)return false;document.querySelectorAll('#mainTable tbody tr').forEach(function(tr){tr.classList.remove('row-focus');});rowEl.classList.add('row-focus');rowEl.scrollIntoView({behavior:'smooth',block:'center'});var qty=document.getElementById('qty-'+foundIndex);if(qty){currentInputElement=qty;setTimeout(function(){qty.focus();qty.select();qty.style.transform='scale(1.02)';qty.style.borderColor='#10b981';qty.style.backgroundColor='#fef9c3';var done=function(e){if(e.type==='blur'||(e.type==='keypress'&&e.key==='Enter')){hideKeyboard();qty.removeEventListener('blur',done);qty.removeEventListener('keypress',done);}};qty.addEventListener('blur',done);qty.addEventListener('keypress',done);setTimeout(function(){qty.style.transform='';qty.style.borderColor='';qty.style.backgroundColor='';},500);},250);}return true;}
function handleBarcode(code,fromCamera){
  if(!code)return false;
  var now=Date.now(),codeStr=String(code).trim();
  if(!codeStr)return false;

  /* v4.1.2：
     一旦读到“新的有效条码”，先清掉上一条“条码不存在”持久提示。
     同一个条码在镜头里重复出现时不清除/闪烁。 */
  clearPreviousBarcodeNotFoundOnNextScan(codeStr);

  if(codeStr===lastCode&&(now-lastTime)<200)return false;
  lastCode=codeStr;
  lastTime=now;

  var idx=findBestMatchRowIndex(codeStr);
  if(idx===-1){
    playBeep(false,codeStr);
    showBarcodeNotFoundToast(codeStr);
    consecutiveFailures++;
    setTimeout(function(){
      var input=document.getElementById('manualInput');
      if(input){input.focus();input.select();currentInputElement=input;}
    },100);
    return false;
  }

  /* 找到商品：清除“不存在”状态，成功提示会正常替换页面 toast。 */
  clearBarcodeNotFoundState();
  consecutiveFailures=0;
  playBeep(true,codeStr);

  var productName=db[idx]['名称']||db[idx]['商品名称']||codeStr;
  showToast('✅ '+productName);

  var frame=document.getElementById('scanFrame');
  if(frame){
    frame.classList.add('scan-success');
    setTimeout(function(){frame.classList.remove('scan-success');},200);
  }

  if(fromCamera)stopScanningAndJump(idx);
  else{
    var p=Math.floor(idx/pageSize);
    if(p!==currentPage){currentPage=p;renderPage();}
    jumpToRowAndFocusQty(idx);
  }
  return true;
}
function render(){renderPage();}

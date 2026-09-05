'use strict';
var FEISU_ORIGINAL_HEADERS=['Ref','Código Barras','Descripción','Local   Descripción','Uds/E','CNT','Precio','LSJ','HYJ','DTO 3','CDTO','IMP(Mex.$)'];
function isEmptyPlaceholderHeader(key){return /^_*(?:EMPTY|empty)(?:[-_]?\d+)?$/i.test(String(key||'').trim());}
function restoreOriginalHeaders(row){
  var out={},keys=Object.keys(row||{}),used=new Set();
  keys.forEach(function(key,index){var clean=String(key||'').trim(),target=isEmptyPlaceholderHeader(clean)?(FEISU_ORIGINAL_HEADERS[index]||clean):clean;if(!target)target=FEISU_ORIGINAL_HEADERS[index]||('列'+(index+1));if(used.has(target)){var n=2,base=target;while(used.has(base+' '+n))n++;target=base+' '+n;}used.add(target);out[target]=row[key];});
  return out;
}
function buildImportedRow(rawRow,allColumns){
  var row=restoreOriginalHeaders(rawRow),product=extractProduct(row),newRow={};
  for(var key in row){if(Object.prototype.hasOwnProperty.call(row,key)){newRow[key]=row[key];allColumns.add(key);}}
  if(!Object.prototype.hasOwnProperty.call(newRow,'条码')){newRow['条码']=product.barcode||'';allColumns.add('条码');}
  if(!Object.prototype.hasOwnProperty.call(newRow,'名称')){newRow['名称']=product.name||'';allColumns.add('名称');}
  newRow['实际数量']='';newRow['实际价格']=product.price||'';newRow.__feisuStatus='';newRow.__feisuReviewed=false;
  return {row:newRow,valid:product.valid};
}
function finalizeColumns(allColumns,rows){
  var cols=Array.from(allColumns).filter(function(c){return c!=='实际数量'&&c!=='差异'&&c!=='盘点状态';});
  sourceQtyColumn=detectSourceQtyColumn(cols,rows);
  var insertAt=sourceQtyColumn?cols.indexOf(sourceQtyColumn)+1:0;
  cols.splice(insertAt,0,'实际数量','差异','盘点状态');
  var p=cols.indexOf('实际价格');if(p===-1)cols.push('实际价格');
  return cols;
}
function importExcelInBatches(jsonData){return new Promise(function(resolve){var total=jsonData.length;if(!total){resolve({rows:[],errors:[],columns:[]});return;}var allColumns=new Set(),rows=[],errors=[],processed=0;function batch(){var end=Math.min(processed+BATCH_SIZE,total);for(var i=processed;i<end;i++){try{var r=buildImportedRow(jsonData[i],allColumns);if(r.valid)rows.push(r.row);else errors.push({row:i+1,message:'缺少条码或名称'});}catch(e){errors.push({row:i+1,message:e.message||'数据异常'});}}processed=end;updateProgress(processed,total,'📊 正在导入数据...',processed+' / '+total);if(processed<total)setTimeout(batch,0);else resolve({rows:rows,errors:errors,columns:finalizeColumns(allColumns,rows)});}showProgress(true);updateProgress(0,total,'📊 正在准备导入...','0 / '+total);setTimeout(batch,0);});}
function importCSVInBatches(file){return new Promise(function(resolve,reject){var rows=[],errors=[],allColumns=new Set(),totalRows=0;Papa.parse(file,{header:true,comments:'#',skipEmptyLines:true,transformHeader:function(h){return h.trim();},worker:true,chunkSize:1024*1024,chunk:function(results){for(var i=0;i<results.data.length;i++){var row=results.data[i];if(!row||!Object.keys(row).length)continue;totalRows++;try{var r=buildImportedRow(row,allColumns);if(r.valid)rows.push(r.row);else errors.push({row:totalRows,message:'缺少条码或名称'});}catch(e){errors.push({row:totalRows,message:e.message||'数据异常'});}}updateProgress(rows.length,0,'📄 流式解析 CSV...',rows.length+' 条');},complete:function(){resolve({rows:rows,errors:errors,columns:finalizeColumns(allColumns,rows)});},error:function(err){reject(err);}});});}
function applyImportResult(result){
  if(!result.rows.length){showToast('⚠️ 没有有效数据行',true);showProgress(false);isProcessing=false;return;}
  columns=result.columns;db=result.rows;unknownBarcodes={};currentInventoryFilter='all';currentPage=0;sourceQtyColumn=detectSourceQtyColumn(columns,db);rebuildSearchIndex();renderPage();showErrors(result.errors);showProgress(false);scheduleAutoSave();showToast('✅ 导入成功！共 '+db.length+' 条商品');isProcessing=false;
}
function bindFileImport(){document.getElementById('fileInput').onchange=function(e){if(isProcessing){showToast('⏳ 正在处理中...');return;}var file=e.target.files[0];if(!file)return;e.target.value='';currentImportFileName=file.name.replace(/\.(xlsx|xls|csv)$/i,'');var ext=file.name.split('.').pop().toLowerCase();isProcessing=true;showProgress(true);if(ext==='csv'){updateProgress(0,0,'📄 正在读取 CSV...','流式解析');importCSVInBatches(file).then(applyImportResult).catch(function(err){console.error(err);showToast('❌ CSV导入失败: '+(err.message||err),true);showProgress(false);isProcessing=false;});return;}showToast('正在读取 Excel...');var fr=new FileReader();fr.onload=function(ev){try{var data=new Uint8Array(ev.target.result),workbook=XLSX.read(data,{type:'array'}),sheet=workbook.Sheets[workbook.SheetNames[0]],json=XLSX.utils.sheet_to_json(sheet,{defval:''});if(!json.length){showToast('文件无数据',true);showProgress(false);isProcessing=false;return;}importExcelInBatches(json).then(applyImportResult);}catch(err){showToast('解析失败: '+(err.message||err),true);showProgress(false);isProcessing=false;}};fr.onerror=function(){showToast('读取Excel文件失败',true);showProgress(false);isProcessing=false;};fr.readAsArrayBuffer(file);};}
function exportRows(){return db.map(function(row){var out={};columns.forEach(function(col){if(col==='差异')out[col]=getInventoryDiff(row);else if(col==='盘点状态')out[col]=getInventoryStatus(row)+(row.__feisuReviewed?'（已复盘）':'');else out[col]=row[col]??'';});return out;});}
function exportExcel(){
  if(!db.length){showToast('暂无数据可导出',true);return;}
  var sum=inventorySummary();
  if((sum.unpan||sum.review)&&!confirm('盘点检查：\n未盘点 '+sum.unpan+' 项\n待复盘问题 '+sum.review+' 项\n\n仍然导出吗？'))return;
  var base=currentImportFileName||'库存',defaultName=base+'_FEISU盘点_'+new Date().toISOString().slice(0,10),name=prompt('请输入导出文件名：',defaultName);if(!name||!name.trim())name=defaultName;
  var rows=exportRows(),aoa=[['飞速盘点 · FEISU  |  免费盘点工具生成'],columns];
  rows.forEach(function(r){aoa.push(columns.map(function(c){return r[c]??'';}));});
  var ws=XLSX.utils.aoa_to_sheet(aoa);if(columns.length>1)ws['!merges']=[{s:{r:0,c:0},e:{r:0,c:columns.length-1}}];ws['!freeze']={xSplit:0,ySplit:2,topLeftCell:'A3',activePane:'bottomLeft',state:'frozen'};
  var wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,'盘点结果');
  var summary=[['飞速盘点 · FEISU'],['原文件',base],['总商品',sum.total],['已盘',sum.completed],['未盘点',sum.unpan],['一致',sum.match],['数量不足',sum.short],['数量超出',sum.over],['实物未找到',sum.notfound],['实际为零',sum.zero],['待复盘',sum.review],['完成率',sum.percent+'%']];
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(summary),'FEISU盘点摘要');
  XLSX.writeFile(wb,name.trim()+'.xlsx');showToast('✅ 导出成功 · 已加入 FEISU 品牌水印行');
}

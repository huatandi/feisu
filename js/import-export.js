'use strict';

/* Excel 某些模板的表头含合并/空白单元格，SheetJS 会生成 __EMPTY / EMPTY-1 等占位名。
   v4.7 只恢复这些占位表头的显示名称，不改原有有效列名与业务数据。 */
var FEISU_ORIGINAL_HEADERS=['Ref','Código Barras','Descripción','Local   Descripción','Uds/E','CNT','Precio','LSJ','HYJ','DTO 3','CDTO','IMP(Mex.$)'];
function isEmptyPlaceholderHeader(key){return /^_*(?:EMPTY|empty)(?:[-_]?\d+)?$/i.test(String(key||'').trim());}
function restoreOriginalHeaders(row){
  var out={}, keys=Object.keys(row||{}), used=new Set();
  keys.forEach(function(key,index){
    var clean=String(key||'').trim();
    var target=isEmptyPlaceholderHeader(clean)?(FEISU_ORIGINAL_HEADERS[index]||clean):clean;
    if(!target) target=FEISU_ORIGINAL_HEADERS[index]||('列'+(index+1));
    if(used.has(target)){
      var n=2,base=target; while(used.has(base+' '+n))n++; target=base+' '+n;
    }
    used.add(target); out[target]=row[key];
  });
  return out;
}
function buildImportedRow(rawRow,allColumns){var row=restoreOriginalHeaders(rawRow),product=extractProduct(row),newRow={};for(var key in row){if(Object.prototype.hasOwnProperty.call(row,key)){newRow[key]=row[key];allColumns.add(key);}}newRow['条码']=product.barcode||'';newRow['名称']=product.name||'';newRow['实际数量']=product.quantity||0;newRow['实际价格']=product.price||0;return {row:newRow,valid:product.valid};}
function finalizeColumns(allColumns){var cols=Array.from(allColumns),q='实际数量',p='实际价格',qi=cols.indexOf(q),pi=cols.indexOf(p);if(qi>0){cols.splice(qi,1);cols.unshift(q);}pi=cols.indexOf(p);if(pi>1){cols.splice(pi,1);cols.splice(1,0,p);}return cols;}
function importExcelInBatches(jsonData){return new Promise(function(resolve){var total=jsonData.length;if(!total){resolve({rows:[],errors:[],columns:[]});return;}var allColumns=new Set(['实际数量','实际价格','条码','名称']),rows=[],errors=[],processed=0;function batch(){var end=Math.min(processed+BATCH_SIZE,total);for(var i=processed;i<end;i++){try{var r=buildImportedRow(jsonData[i],allColumns);if(r.valid)rows.push(r.row);else errors.push({row:i+1,message:'缺少条码或名称'});}catch(e){errors.push({row:i+1,message:e.message||'数据异常'});}}processed=end;updateProgress(processed,total,'📊 正在导入数据...',processed+' / '+total);if(processed<total)setTimeout(batch,0);else resolve({rows:rows,errors:errors,columns:finalizeColumns(allColumns)});}showProgress(true);updateProgress(0,total,'📊 正在准备导入...','0 / '+total);setTimeout(batch,0);});}
function importCSVInBatches(file){return new Promise(function(resolve,reject){var rows=[],errors=[],allColumns=new Set(['实际数量','实际价格','条码','名称']),totalRows=0;Papa.parse(file,{header:true,comments:'#',skipEmptyLines:true,transformHeader:function(h){return h.trim();},worker:true,chunkSize:1024*1024,chunk:function(results){for(var i=0;i<results.data.length;i++){var row=results.data[i];if(!row||!Object.keys(row).length)continue;totalRows++;try{var r=buildImportedRow(row,allColumns);if(r.valid)rows.push(r.row);else errors.push({row:totalRows,message:'缺少条码或名称'});}catch(e){errors.push({row:totalRows,message:e.message||'数据异常'});} }updateProgress(rows.length,0,'📄 流式解析 CSV...',rows.length+' 条');},complete:function(){resolve({rows:rows,errors:errors,columns:finalizeColumns(allColumns)});},error:function(err){reject(err);}});});}
function applyImportResult(result){if(!result.rows.length){showToast('⚠️ 没有有效数据行',true);showProgress(false);isProcessing=false;return;}columns=result.columns;db=result.rows;currentPage=0;rebuildSearchIndex();renderPage();showErrors(result.errors);showProgress(false);scheduleAutoSave();showToast('✅ 导入成功！共 '+db.length+' 条商品');if(result.errors.length)showToast('⚠️ 跳过 '+result.errors.length+' 行无效数据',true);isProcessing=false;}
function bindFileImport(){document.getElementById('fileInput').onchange=function(e){if(isProcessing){showToast('⏳ 正在处理中...');return;}var file=e.target.files[0];if(!file)return;e.target.value='';var ext=file.name.split('.').pop().toLowerCase();isProcessing=true;showProgress(true);if(ext==='csv'){updateProgress(0,0,'📄 正在读取 CSV...','流式解析');importCSVInBatches(file).then(applyImportResult).catch(function(err){console.error(err);showToast('❌ CSV导入失败: '+(err.message||err),true);showProgress(false);isProcessing=false;});return;}showToast('正在读取 Excel...');var fr=new FileReader();fr.onload=function(ev){try{var data=new Uint8Array(ev.target.result),workbook=XLSX.read(data,{type:'array'}),sheet=workbook.Sheets[workbook.SheetNames[0]],json=XLSX.utils.sheet_to_json(sheet,{defval:''});if(!json.length){showToast('文件无数据',true);showProgress(false);isProcessing=false;return;}importExcelInBatches(json).then(applyImportResult);}catch(err){showToast('解析失败: '+(err.message||err),true);showProgress(false);isProcessing=false;}};fr.onerror=function(){showToast('读取Excel文件失败',true);showProgress(false);isProcessing=false;};fr.readAsArrayBuffer(file);};}
function exportExcel(){if(!db.length){showToast('暂无数据可导出',true);return;}var defaultName='飞速盘点_'+new Date().toLocaleDateString().replace(/[\\/]/g,'-'),name=prompt('请输入导出文件名：',defaultName);if(!name||!name.trim())name=defaultName;var ws=XLSX.utils.json_to_sheet(db,{header:columns}),wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,'库存数据');XLSX.writeFile(wb,name.trim()+'.xlsx');showToast('✅ 导出成功');}

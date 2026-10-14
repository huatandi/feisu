'use strict';
function safePictureSource(value){
  var s=String(value||'').trim();
  return /^(https?:\/\/|data:image\/(?:png|jpeg|gif|webp);base64,)/i.test(s)?s:'';
}
function getRowPictures(row,col){
  var embedded=row.__feisuImages&&row.__feisuImages[col];
  if(embedded&&embedded.length)return embedded;
  var src=safePictureSource(row[col]);
  return src?[{data:src}]:[];
}
function openPicturePreview(src){
  var overlay=document.createElement('div');overlay.className='picture-preview';overlay.setAttribute('role','dialog');overlay.setAttribute('aria-label','商品大图');
  var img=document.createElement('img');img.src=src;img.alt='商品大图';
  var close=document.createElement('button');close.textContent='✕ 关闭';
  function dismiss(){overlay.remove();document.removeEventListener('keydown',onKey);}
  function onKey(e){if(e.key==='Escape')dismiss();}
  overlay.onclick=function(e){if(e.target!==img)dismiss();};
  document.addEventListener('keydown',onKey);overlay.append(img,close);document.body.appendChild(overlay);close.focus();
}
function bytesToImageData(bytes,ext){
  var array=new Uint8Array(bytes),parts=[];
  for(var i=0;i<array.length;i+=8192)parts.push(String.fromCharCode.apply(null,array.subarray(i,i+8192)));
  return 'data:image/'+(ext==='jpg'?'jpeg':ext)+';base64,'+btoa(parts.join(''));
}
async function importEmbeddedImages(data,parsed){
  if(!window.ExcelJS)throw new Error('图片组件未加载，请刷新重试');
  var wb=new ExcelJS.Workbook();await wb.xlsx.load(data);
  var sheet=wb.worksheets[0];if(!sheet)return;
  var rowLookup=new Map();parsed.sourceRowNumbers.forEach(function(n,i){rowLookup.set(n,i);});
  sheet.getImages().forEach(function(entry){
    var anchor=entry.range.tl,rowIndex=rowLookup.get(Math.floor(anchor.nativeRow??anchor.row));
    if(rowIndex===undefined)return;
    var media=wb.getImage(entry.imageId),ext=String(media.extension||'').toLowerCase();
    if(!/^(png|jpeg|jpg|gif)$/.test(ext))throw new Error('存在暂不支持的图片格式：'+ext);
    var colIndex=Math.floor(anchor.nativeCol??anchor.col),col=parsed.headers[colIndex];
    if(!col){col='图片';if(parsed.headers.indexOf(col)<0)parsed.headers.push(col);parsed.rows.forEach(function(r){if(!(col in r))r[col]='';});}
    var row=parsed.rows[rowIndex];if(!row.__feisuImages)row.__feisuImages={};
    if(!row.__feisuImages[col])row.__feisuImages[col]=[];
    row.__feisuImages[col].push({data:media.base64?(media.base64.startsWith('data:')?media.base64:'data:image/'+(ext==='jpg'?'jpeg':ext)+';base64,'+media.base64):bytesToImageData(media.buffer,ext),extension:ext==='jpg'?'jpeg':ext});
  });
}
async function exportPictureData(pic){
  var src=safePictureSource(pic.data);if(!src)throw new Error('图片地址无效');
  if(src.startsWith('data:'))return src;
  var response=await fetch(src);if(!response.ok)throw new Error('图片下载失败：'+response.status);
  var blob=await response.blob();
  if(!/^image\/(png|jpeg|gif|webp)$/.test(blob.type))throw new Error('图片格式不支持');
  return await new Promise(function(resolve,reject){var fr=new FileReader();fr.onload=function(){resolve(fr.result);};fr.onerror=reject;fr.readAsDataURL(blob);});
}
async function writeWorkbookWithImages(source,name){
  var pictures=[];
  db.forEach(function(row,r){columns.forEach(function(col,c){getRowPictures(row,col).forEach(function(pic){pictures.push({r:r,c:c,pic:pic});});});});
  if(!pictures.length){XLSX.writeFile(source,name);return;}
  showToast('正在导出图片，请稍候…');
  var wb=new ExcelJS.Workbook();await wb.xlsx.load(XLSX.write(source,{bookType:'xlsx',type:'array'}));
  var sheet=wb.worksheets[0];sheet.views=[{state:'frozen',ySplit:2}];
  for(var i=0;i<pictures.length;i++){
    var item=pictures[i],data=await exportPictureData(item.pic),ext=data.slice(11,data.indexOf(';')).replace('jpg','jpeg');
    if(ext==='webp')throw new Error('WebP 图片需转换为 PNG/JPEG 后导出');
    var id=wb.addImage({base64:data,extension:ext});
    if(safePictureSource(db[item.r][columns[item.c]]))sheet.getCell(item.r+3,item.c+1).value='';
    sheet.getRow(item.r+3).height=Math.max(sheet.getRow(item.r+3).height||0,64);
    sheet.getColumn(item.c+1).width=Math.max(sheet.getColumn(item.c+1).width||0,14);
    sheet.addImage(id,{tl:{col:item.c+.05,row:item.r+2+.05},ext:{width:72,height:72},editAs:'oneCell'});
  }
  var bytes=await wb.xlsx.writeBuffer(),url=URL.createObjectURL(new Blob([bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
  var link=document.createElement('a');link.href=url;link.download=name;document.body.appendChild(link);link.click();link.remove();setTimeout(function(){URL.revokeObjectURL(url);},60000);
}

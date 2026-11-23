'use strict';

function cleanSearchText(value){
  if(value === null || value === undefined) return '';
  var s = String(value).trim();
  if((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))){
    s = s.slice(1,-1).trim();
  }
  return s;
}

function preprocessCode(code){
  if(code === null || code === undefined) return '';
  var cleaned = cleanSearchText(code).replace(/[^\w\d\-]/g,'');
  if(cleaned.startsWith('*') && cleaned.endsWith('*')) cleaned=cleaned.slice(1,-1);
  if(cleaned.length===12 && /^\d+$/.test(cleaned)) cleaned='0'+cleaned;
  return cleaned;
}

function barcodeCandidates(value){
  var original = cleanSearchText(value).toLowerCase();
  if(!original) return [];
  var out = [];
  function add(v){
    v = String(v || '').trim().toLowerCase();
    if(v && !out.includes(v)) out.push(v);
  }

  add(original);
  add(preprocessCode(original).toLowerCase());

  var digits = original.replace(/[^\d]/g,'');
  var looksNumeric = /^[\s'"+\-]*\d[\d\s'"+\-]*$/.test(original);
  if(looksNumeric && digits){
    add(digits);
    var noLead = digits.replace(/^0+/,'');
    if(noLead) add(noLead);

    if(digits.length === 12) add('0' + digits);
    if(digits.length === 13 && digits.charAt(0) === '0') add(digits.slice(1));

    if(digits.length === 14){
      if(digits.startsWith('0')) add(digits.slice(1));
      if(digits.startsWith('00')) add(digits.slice(2));
    }
    if(digits.length === 13) add('0' + digits);
    if(digits.length === 12) add('00' + digits);
  }
  return out;
}

function normalizeSearchValue(v){
  var s=cleanSearchText(v).toLowerCase();
  var p=preprocessCode(s).toLowerCase();
  var raw=s;
  if(/^\d+$/.test(raw)){
    var n=raw.replace(/^0+/,'');
    if(n) raw=n;
  }
  return {raw:raw,processed:p};
}

function exactMatch(code,dbValue){
  if(code === null || code === undefined || dbValue === null || dbValue === undefined) return false;
  var a = cleanSearchText(code);
  var b = cleanSearchText(dbValue);
  if(!a || !b) return false;

  if(a === b) return true;
  if(a.toLowerCase() === b.toLowerCase()) return true;
  if(preprocessCode(a).toLowerCase() === preprocessCode(b).toLowerCase()) return true;

  var ca = barcodeCandidates(a);
  var cb = barcodeCandidates(b);
  for(var i=0;i<ca.length;i++){
    if(cb.includes(ca[i])) return true;
  }

  if(/^\d+$/.test(a) && /^\d+$/.test(b)){
    var an=a.replace(/^0+/,'');
    var bn=b.replace(/^0+/,'');
    if(an && an===bn) return true;
  }
  return false;
}


function isSearchIgnoredColumn(key){
  var k=String(key||'');
  if(k.indexOf('__feisu')===0)return true;
  if(k==='实际数量'||k==='实际价格'||k==='差异'||k==='盘点状态')return true;
  if(typeof quantityHeaderScore==='function'&&quantityHeaderScore(k)>=0)return true;
  return false;
}

/* v5.0.3：摄像头识别专用。只接受
   1) 精确条码（含前导零/12↔13 位归一）；
   2) 位于“条码类”列、且全库唯一的片段匹配（供残缺码/局部识别使用，至少 8 位数字）。
   不再退回“任意列 startsWith / 任意列包含”，避免扫到 A 跳到 B。 */
function isBarcodeLikeKey(key){
  if(String(key||'').indexOf('__feisu')===0) return false;
  var n=String(typeof displayColumnName==='function'?displayColumnName(key):key).toUpperCase().replace(/[\s._\-\/\\:：()（）]+/g,'');
  return /^(条码|商品条码|BARCODE|CODIGOBARRAS|CÓDIGOBARRAS|EAN|EAN13|EAN8|UPC|UPCA)$/.test(n);
}
function barcodeColumnKeys(){
  var out=[];
  var first=db&&db[0]?db[0]:null;
  if(first)for(var key in first){if(Object.prototype.hasOwnProperty.call(first,key)&&isBarcodeLikeKey(key))out.push(key);}
  if(!out.length&&typeof columns!=='undefined'&&columns)out=columns.filter(isBarcodeLikeKey);
  return out;
}
function findStrictBarcodeRow(code){
  var fast=findBarcodeRowFast(code);
  if(fast!==-1) return fast;
  var digits=String(code==null?'':code).replace(/[^\d]/g,'');
  if(digits.length<8||!db||!db.length) return -1;
  var keys=barcodeColumnKeys();
  if(!keys.length) return -1;
  var hit=-1,count=0;
  for(var i=0;i<db.length;i++){
    var row=db[i]||{},matched=false;
    for(var k=0;k<keys.length;k++){
      var v=String(row[keys[k]]==null?'':row[keys[k]]).replace(/[^\d]/g,'');
      if(v.length>=digits.length&&v.indexOf(digits)!==-1){matched=true;break;}
    }
    if(matched){count++;hit=i;if(count>1)return -1;}   /* 多命中即判为不确定，交给人工 */
  }
  return count===1?hit:-1;
}

function rebuildSearchIndex(){
  searchIndex=new Map();
  searchableRows=new Array(db.length);

  for(var i=0;i<db.length;i++){
    var row=db[i]||{};
    var texts=[];

    for(var key in row){
      if(!Object.prototype.hasOwnProperty.call(row,key)||isSearchIgnoredColumn(key)) continue;
      var val=cleanSearchText(row[key]);
      if(!val) continue;

      texts.push(val.toLowerCase());

      var candidates=barcodeCandidates(val);
      for(var c=0;c<candidates.length;c++){
        var candidate=candidates[c];
        if(candidate && !searchIndex.has(candidate)) searchIndex.set(candidate,i);
      }

      var n=normalizeSearchValue(val);
      if(n.raw && !searchIndex.has(n.raw)) searchIndex.set(n.raw,i);
      if(n.processed && !searchIndex.has(n.processed)) searchIndex.set(n.processed,i);
    }
    searchableRows[i]=texts.join(' ');
  }

  if(typeof rebuildFragmentIndex==='function')rebuildFragmentIndex();
  console.info('[SearchEngine] index rebuilt:', {rows:db.length,keys:searchIndex.size});
}

function findBarcodeRowFast(code){
  if(!code || !db.length) return -1;
  var candidates=barcodeCandidates(code);
  for(var i=0;i<candidates.length;i++){
    if(searchIndex.has(candidates[i])) return searchIndex.get(candidates[i]);
  }
  var n=normalizeSearchValue(code);
  if(n.raw && searchIndex.has(n.raw)) return searchIndex.get(n.raw);
  if(n.processed && searchIndex.has(n.processed)) return searchIndex.get(n.processed);
  return -1;
}

function findBarcodeRowLegacy(code){
  if(!code || !db.length) return -1;
  for(var i=0;i<db.length;i++){
    var row=db[i]||{};
    for(var key in row){
      if(!Object.prototype.hasOwnProperty.call(row,key)||isSearchIgnoredColumn(key)) continue;
      if(exactMatch(code,row[key])) return i;
    }
  }
  return -1;
}

function findBarcodeRow(code){
  var fast=findBarcodeRowFast(code);
  if(fast!==-1) return fast;

  var legacy=findBarcodeRowLegacy(code);
  if(legacy!==-1){
    console.warn('[SearchEngine] fast index miss; legacy fallback hit:', {code:String(code),row:legacy});
    return legacy;
  }
  return -1;
}

function getSearchableRowText(row){
  var texts=[];
  Object.keys(row||{}).forEach(function(k){if(!isSearchIgnoredColumn(k))texts.push(cleanSearchText(row[k]));});
  return texts.join(' ').toLowerCase();
}

function findBestMatchRowIndex(query){
  if(!query || !db.length) return -1;
  var token=cleanSearchText(query);
  if(!token) return -1;

  var exact=findBarcodeRow(token);
  if(exact!==-1) return exact;

  var low=token.toLowerCase();
  var norm=preprocessCode(token).toLowerCase();

  for(var i=0;i<db.length;i++){
    var row=db[i]||{};
    for(var key in row){
      if(!Object.prototype.hasOwnProperty.call(row,key)||isSearchIgnoredColumn(key)) continue;
      var raw=cleanSearchText(row[key]);
      var v=raw.toLowerCase();
      var pv=preprocessCode(raw).toLowerCase();
      if((norm && (v.startsWith(norm)||pv.startsWith(norm))) || v.startsWith(low)) return i;
    }
  }

  for(var j=0;j<db.length;j++){
    var hay=(searchableRows[j] || getSearchableRowText(db[j]));
    if(hay.includes(low)) return j;
  }

  console.warn('[SearchEngine] no match:', {
    scanned:token,
    candidates:barcodeCandidates(token),
    rows:db.length,
    indexKeys:searchIndex.size
  });
  return -1;
}

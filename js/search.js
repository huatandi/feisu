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

/* v5.0.3+：摄像头识别专用严格索引。
   只承认两种等价：字符串完全相等；或 UPC-A(12位) 补一个前导 0 等于 EAN-13(13位)。
   其它任何“前缀/包含/去前导零”的近似都不再参与摄像头识别。 */
var strictBarcodeIndex = new Map();
function strictBarcodeKey(value){
  var d=String(value==null?'':value).replace(/[^\d]/g,'');
  if(!d) return '';
  if(d.length===12) return '0'+d;      /* UPC-A ↔ EAN-13 的唯一合法等价 */
  return d;
}
function strictKeyOf(value){
  var s=String(value==null?'':value).trim();
  if(!s) return null;
  return /^\d+$/.test(s)?strictBarcodeKey(s):'#'+s.toUpperCase();
}
function rebuildStrictBarcodeIndex(){
  strictBarcodeIndex=new Map();
  var bkeys=barcodeColumnKeys(),mkeys=modelColumnKeys();
  if(!bkeys.length&&!mkeys.length) return;
  for(var i=0;i<db.length;i++){
    var row=db[i]||{},found=false;
    for(var k=0;k<bkeys.length;k++){
      var key=strictKeyOf(row[bkeys[k]]);
      if(key){found=true;if(!strictBarcodeIndex.has(key))strictBarcodeIndex.set(key,i);}
    }
    /* 该行条码列全空时，才允许用型号列兜底，避免遮蔽真正的条码 */
    if(!found)for(var m=0;m<mkeys.length;m++){
      var key2=strictKeyOf(row[mkeys[m]]);
      if(key2&&!strictBarcodeIndex.has(key2))strictBarcodeIndex.set(key2,i);
    }
  }
}
/* v5.0.4：残缺条码的分级匹配。只用于“定位商品”，永不用于自动计数。
   A 级（自动定位）：片段 ≥10 位数字，且全库只在条码列唯一命中；
   B 级（候选列表）：片段 8–9 位，或命中 2–10 个，交人工点选；
   C 级：其余一律不做。 */
function findFragmentBarcodeRow(fragment){
  var raw=String(fragment==null?'':fragment).replace(/[^\d]/g,'');
  if(raw.length<8) return null;
  var keys=barcodeColumnKeys();
  if(!keys.length) return null;
  var hits=[],seen={};
  for(var i=0;i<db.length;i++){
    var row=db[i]||{};
    for(var k=0;k<keys.length;k++){
      var code=String(row[keys[k]]==null?'':row[keys[k]]).trim();
      if(!/^\d{8,14}$/.test(code)) continue;
      var at=code.indexOf(raw);
      if(at<0) continue;
      if(seen[code]) break;
      seen[code]=1;
      hits.push({row:i,code:code,where:at===0?'prefix':(at===code.length-raw.length?'suffix':'inner')});
      break;
    }
  }
  if(!hits.length) return null;
  if(hits.length===1&&raw.length>=10) return {tier:'auto',row:hits[0].row,code:hits[0].code,fragment:raw,where:hits[0].where};
  if(hits.length<=10) return {tier:'candidates',candidates:hits,fragment:raw};
  return {tier:'none',count:hits.length};
}
function normColumnKey(key){
  return String(typeof displayColumnName==='function'?displayColumnName(key):key).toUpperCase().replace(/[\s._\-\/\\:：()（）]+/g,'');
}
/* v5.1：列名识别。供应商常见的"条形码CODIGO DE BARRA"以前完全认不出来，
   导致整个文件被当成"没有条码列"，扫什么都提示不存在。 */
function isBarcodeLikeKey(key){
  if(String(key||'').indexOf('__feisu')===0) return false;
  var n=normColumnKey(key);
  if(!n) return false;
  if(/^(条码|条形码|条型码|商品条码|条码号|内部条码|BARCODE|CODIGOBARRA|CODIGODEBARRA|CODIGOBARRAS|CODIGODEBARRAS|EAN|EAN13|EAN8|UPC|UPCA)$/.test(n)) return true;
  return /(条形码|条型码|条码|BARCODE|CODIGODEBARRA)/.test(n);
}
/* 型号/货号列：条码列空着的单据，Code 128 里编的就是型号本身，可作精确匹配的次级键。 */
function isModelLikeKey(key){
  if(String(key||'').indexOf('__feisu')===0) return false;
  if(isBarcodeLikeKey(key)) return false;
  var n=normColumnKey(key);
  if(!n) return false;
  return /(型号|货号|貨號|商品编码|货品编码|CODIGO|MODELO|MODEL|SKU|REF|ITEM)/.test(n);
}
function barcodeColumnKeys(){
  var out=[];
  var first=db&&db[0]?db[0]:null;
  if(first)for(var key in first){if(Object.prototype.hasOwnProperty.call(first,key)&&isBarcodeLikeKey(key))out.push(key);}
  if(!out.length&&typeof columns!=='undefined'&&columns)out=columns.filter(isBarcodeLikeKey);
  return out;
}
function modelColumnKeys(){
  var out=[];
  var first=db&&db[0]?db[0]:null;
  if(first)for(var key in first){if(Object.prototype.hasOwnProperty.call(first,key)&&isModelLikeKey(key))out.push(key);}
  if(!out.length&&typeof columns!=='undefined'&&columns)out=columns.filter(isModelLikeKey);
  return out;
}
function rowHasBarcodeValue(row,bkeys){
  for(var i=0;i<bkeys.length;i++){if(String(row[bkeys[i]]==null?'':row[bkeys[i]]).trim())return true;}
  return false;
}
function sameCodeValue(value,raw,digitsOnly){
  var s=String(value==null?'':value).trim();
  if(!s) return false;
  if(digitsOnly&&/^\d+$/.test(s)) return strictBarcodeKey(s)===strictBarcodeKey(raw);
  return s.toUpperCase()===raw.toUpperCase();          /* 字母码：忽略大小写，仍要求全等 */
}
function findStrictBarcodeRow(code){
  var raw=String(code==null?'':code).trim();
  if(!raw) return -1;
  var digitsOnly=/^\d{6,}$/.test(raw);
  var key=digitsOnly?strictBarcodeKey(raw):'#'+raw.toUpperCase();
  if(strictBarcodeIndex.has(key)) return strictBarcodeIndex.get(key);
  var bkeys=barcodeColumnKeys(),mkeys=modelColumnKeys();
  if(!bkeys.length&&!mkeys.length) return -1;
  /* 一轮：只比条码列（含仅某些行有值的情况） */
  for(var i=0;i<db.length;i++){
    var row=db[i]||{};
    for(var k=0;k<bkeys.length;k++){
      if(sameCodeValue(row[bkeys[k]],raw,digitsOnly)) return i;
    }
  }
  /* 二轮：条码列空的行，用型号列做精确匹配（Code 128 编型号的那种单据） */
  for(var j=0;j<db.length;j++){
    var r2=db[j]||{};
    if(rowHasBarcodeValue(r2,bkeys)) continue;
    for(var m=0;m<mkeys.length;m++){
      if(sameCodeValue(r2[mkeys[m]],raw,digitsOnly)) return j;
    }
  }
  return -1;
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

  rebuildStrictBarcodeIndex();
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

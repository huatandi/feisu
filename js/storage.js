'use strict';
var STORAGE_DB='sanfei_inventory_v4';
var STORAGE_STORE='sessions';
var STORAGE_KEY='current';
var saveTimer=null;
var inventorySessionId=null;
var storageQueue=Promise.resolve();
function newInventorySessionId(){return 'history:'+Date.now()+':'+Math.random().toString(36).slice(2);}
function openInventoryDb(){return new Promise(function(resolve,reject){if(!('indexedDB' in window)){reject(new Error('IndexedDB unavailable'));return;}var req=indexedDB.open(STORAGE_DB,1);req.onupgradeneeded=function(){var idb=req.result;if(!idb.objectStoreNames.contains(STORAGE_STORE))idb.createObjectStore(STORAGE_STORE);};req.onsuccess=function(){resolve(req.result);};req.onerror=function(){reject(req.error);};});}
function sessionSnapshot(){if(!inventorySessionId)inventorySessionId=newInventorySessionId();return JSON.parse(JSON.stringify({id:inventorySessionId,version:VERSION,db:db,columns:columns,currentPage:currentPage,filter:currentInventoryFilter,unknownBarcodes:unknownBarcodes,currentImportFileName:currentImportFileName,sourceQtyColumn:sourceQtyColumn,savedAt:Date.now()}));}
function queueStorage(work){var task=storageQueue.then(work);storageQueue=task.catch(function(){});return task;}
function writeSession(data){return queueStorage(async function(){var idb=await openInventoryDb();try{await new Promise(function(resolve,reject){var tx=idb.transaction(STORAGE_STORE,'readwrite'),store=tx.objectStore(STORAGE_STORE);store.put(data,STORAGE_KEY);if(data.db.length)store.put(data,data.id);tx.oncomplete=resolve;tx.onabort=tx.onerror=function(){reject(tx.error||new Error('保存事务失败'));};});}finally{idb.close();}});}
async function persistSession(){try{await writeSession(sessionSnapshot());return true;}catch(e){console.warn('自动保存失败',e);showToast('❌ 盘点保存失败，请立即导出；不要关闭页面',true);return false;}}
function scheduleAutoSave(){if(saveTimer)clearTimeout(saveTimer);saveTimer=setTimeout(function(){saveTimer=null;persistSession();},500);}
async function saveBeforeInventorySwitch(){if(saveTimer){clearTimeout(saveTimer);saveTimer=null;}return persistSession();}
function applySavedSession(data){inventorySessionId=data.id||newInventorySessionId();db=data.db;columns=Array.isArray(data.columns)?data.columns:[];currentPage=Number.isFinite(data.currentPage)?data.currentPage:0;currentInventoryFilter=data.filter||'all';unknownBarcodes=data.unknownBarcodes||{};currentImportFileName=data.currentImportFileName||'';sourceQtyColumn=data.sourceQtyColumn||detectSourceQtyColumn(columns,db);undoStack=[];normalizeSpecialColumns();rebuildSearchIndex();renderPage();}
async function readInventorySessions(){await storageQueue;var idb=await openInventoryDb();try{return await new Promise(function(resolve,reject){var tx=idb.transaction(STORAGE_STORE,'readonly'),out=[],req=tx.objectStore(STORAGE_STORE).openCursor();req.onsuccess=function(){var c=req.result;if(c){out.push({key:c.key,data:c.value});c.continue();}};tx.oncomplete=function(){resolve(out);};tx.onabort=tx.onerror=function(){reject(tx.error);};});}finally{idb.close();}}
async function restoreSession(){try{var entries=await readInventorySessions(),entry=entries.find(function(e){return e.key===STORAGE_KEY;});if(entry&&Array.isArray(entry.data.db)&&entry.data.db.length){applySavedSession(entry.data);showToast('✅ 已恢复上次盘点 '+db.length+' 条');return true;}}catch(e){console.warn('恢复失败',e);}return false;}
async function clearPersistedSession(){if(saveTimer){clearTimeout(saveTimer);saveTimer=null;}await queueStorage(async function(){var idb=await openInventoryDb();try{await new Promise(function(resolve,reject){var tx=idb.transaction(STORAGE_STORE,'readwrite');tx.objectStore(STORAGE_STORE).delete(STORAGE_KEY);tx.oncomplete=resolve;tx.onabort=tx.onerror=function(){reject(tx.error);};});}finally{idb.close();}});inventorySessionId=null;}
async function openInventoryHistory(){
  if(isProcessing){showToast('⏳ 正在处理中...');return;}
  isProcessing=true;
  try{
    if(!await saveBeforeInventorySwitch())return;
    var entries=await readInventorySessions(),records=entries.filter(function(e){return String(e.key).indexOf('history:')===0&&e.data&&Array.isArray(e.data.db)&&e.data.db.length;}).sort(function(a,b){return b.data.savedAt-a.data.savedAt;});
    var previous=document.getElementById('inventoryHistory');if(previous)previous.remove();
    var overlay=document.createElement('div');overlay.id='inventoryHistory';overlay.style.cssText='position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px';
    var panel=document.createElement('div');panel.style.cssText='background:white;color:#111827;border-radius:16px;padding:20px;width:560px;max-width:100%;max-height:80vh;overflow:auto';
    var title=document.createElement('h2');title.textContent='历史盘点记录';title.style.cssText='font-size:20px;font-weight:bold;margin-bottom:12px';panel.appendChild(title);
    var note=document.createElement('p');note.textContent='记录保存在本设备浏览器。恢复后可继续盘点或使用原“导出”按钮。请定期导出，清除网站数据会删除记录。';panel.appendChild(note);
    var close=document.createElement('button');close.textContent='关闭';close.style.cssText='padding:10px 18px;margin:12px 0;background:#e5e7eb;border-radius:8px';close.onclick=function(){overlay.remove();};panel.appendChild(close);
    if(!records.length){var empty=document.createElement('p');empty.textContent='暂无历史盘点记录';panel.appendChild(empty);}
    records.forEach(function(entry){var row=document.createElement('div');row.style.cssText='border-top:1px solid #ddd;padding:14px 0';var label=document.createElement('p');label.textContent=(entry.data.currentImportFileName||'未命名盘点')+' · '+entry.data.db.length+' 项 · '+new Date(entry.data.savedAt).toLocaleString();row.appendChild(label);var button=document.createElement('button');button.textContent=entry.key===inventorySessionId?'当前盘点':'恢复此盘点';button.disabled=entry.key===inventorySessionId;button.style.cssText='padding:10px 16px;margin-top:8px;background:#2563eb;color:white;border-radius:8px';button.onclick=async function(){if(isProcessing)return;if(!confirm('恢复此盘点？当前盘点会先保存到历史，不会丢失。'))return;isProcessing=true;try{if(!await saveBeforeInventorySwitch())return;await writeSession(entry.data);applySavedSession(JSON.parse(JSON.stringify(entry.data)));overlay.remove();showToast('✅ 已恢复历史盘点，可继续盘点或导出');}catch(e){showToast('❌ 恢复失败，当前盘点保留',true);console.warn(e);}finally{isProcessing=false;}};row.appendChild(button);panel.appendChild(row);});
    overlay.appendChild(panel);document.body.appendChild(overlay);
  }catch(e){console.warn(e);showToast('❌ 读取历史失败，当前盘点保留',true);}finally{isProcessing=false;}
}

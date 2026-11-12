'use strict';

function makeInventoryBackup(){
  var data=sessionSnapshot();
  var stamp=new Date().toLocaleString('sv-SE').replace(/[: ]/g,'-');
  var name=(data.currentImportFileName||'盘点').replace(/[\\/:*?"<>|]/g,'_');
  return new File([JSON.stringify({format:'FEISU-inventory-backup',schema:1,session:data})],name+'_'+stamp+'.json',{type:'application/json'});
}

async function sendInventoryBackup(file){
  var canShare=false;
  try{canShare=!!(navigator.canShare&&navigator.share&&navigator.canShare({files:[file]}));}catch(e){}
  if(canShare){
    await navigator.share({files:[file],title:'盘点备份'});
    return 'share';
  }
  var url=URL.createObjectURL(file),a=document.createElement('a');
  try{
    a.href=url;a.download=file.name;
    document.body.appendChild(a);a.click();
  }finally{
    a.remove();
    setTimeout(function(){URL.revokeObjectURL(url);},60000);
  }
  return 'download';
}

// Call only after saveBeforeInventorySwitch succeeds. File backup is optional:
// a cancelled, rejected or unresolved system share must never lock switching.
function confirmInventorySwitch(options){
  if(!db.length)return Promise.resolve(true);
  options=options||{};
  return new Promise(function(resolve){
    var previousFocus=document.activeElement,finished=false;
    var overlay=document.createElement('div');
    overlay.id='inventorySwitchDialog';overlay.className='inventory-switch-overlay';
    var panel=document.createElement('div');panel.className='inventory-switch-panel';
    panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');
    panel.setAttribute('aria-labelledby','inventorySwitchTitle');
    panel.setAttribute('aria-describedby','inventorySwitchNote');
    var title=document.createElement('h2');title.id='inventorySwitchTitle';
    title.textContent=options.title||'打开新单？';panel.appendChild(title);
    var note=document.createElement('p');note.id='inventorySwitchNote';
    note.textContent='当前盘点已自动保存，可在「历史盘点」中继续。';panel.appendChild(note);
    if(options.nextName){
      var next=document.createElement('p');next.className='inventory-switch-next';
      next.textContent='即将打开：'+options.nextName;panel.appendChild(next);
    }
    function button(label,kind,fn){
      var b=document.createElement('button');b.type='button';b.textContent=label;
      b.className='inventory-switch-button '+kind;b.onclick=fn;panel.appendChild(b);return b;
    }
    function done(value){
      if(finished)return;
      finished=true;document.removeEventListener('keydown',onKey,true);
      overlay.remove();
      if(previousFocus&&previousFocus.isConnected)previousFocus.focus();
      resolve(value);
    }
    var open=button(options.actionLabel||'打开新单','primary',function(){done(true);});
    var backupNote=document.createElement('p');backupNote.className='inventory-switch-backup-note';
    backupNote.textContent='需要额外留一份文件？可选「另存备份」。';panel.appendChild(backupNote);
    var backup=button('另存备份','secondary',async function(){
      if(backup.disabled||finished)return;
      backup.disabled=true;backup.textContent='正在打开保存窗口…';
      status.textContent='请在系统窗口选择「存储到文件」。返回后可直接继续。';
      try{
        var mode=await sendInventoryBackup(makeInventoryBackup());
        if(finished)return;
        status.textContent=mode==='share'?'已返回。文件是否保存，请在「文件」App中查看。':'已发起下载，请在「下载」中查看备份文件。';
      }catch(e){
        if(finished)return;
        status.textContent=e.name==='AbortError'?'已取消文件备份，自动保存的盘点仍在。':'文件备份未完成，可重试；也可直接继续。';
      }finally{
        if(!finished){backup.disabled=false;backup.textContent='另存备份';}
      }
    });
    var status=document.createElement('p');status.className='inventory-switch-status';
    status.setAttribute('role','status');status.setAttribute('aria-live','polite');panel.appendChild(status);
    var cancel=button('继续当前盘点','cancel',function(){done(false);});
    function onKey(e){
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();done(false);return;}
      if(e.key==='Tab'){
        var buttons=[open,backup,cancel].filter(function(b){return !b.disabled;});
        var at=buttons.indexOf(document.activeElement);
        e.preventDefault();buttons[(at+(e.shiftKey?-1:1)+buttons.length)%buttons.length].focus();
      }
      e.stopPropagation();
    }
    overlay.appendChild(panel);document.body.appendChild(overlay);
    document.addEventListener('keydown',onKey,true);cancel.focus();
  });
}

async function backupCurrentInventory(){
  if(isProcessing){showToast('⏳ 正在处理中');return;}
  if(!db.length){showToast('暂无盘点可备份');return;}
  try{
    var mode=await sendInventoryBackup(makeInventoryBackup());
    showToast(mode==='share'?'请在「文件」App中查看备份文件':'已发起下载，请在「下载」中查看备份文件');
  }catch(e){showToast(e.name==='AbortError'?'已取消文件备份':'文件备份未完成，请重试',e.name!=='AbortError');}
}

async function restoreFileBackup(input){
  var file=input.files[0];input.value='';
  if(!file||isProcessing)return;
  isProcessing=true;
  try{
    var payload=JSON.parse(await file.text()),d=payload.session;
    if(payload.format!=='FEISU-inventory-backup'||payload.schema!==1||!d||!Array.isArray(d.db)||!d.db.length||!Array.isArray(d.columns))throw new Error('不是有效的飞速盘点备份');
    if(!await saveBeforeInventorySwitch())return;
    if(!await confirmInventorySwitch({title:'恢复这份备份？',actionLabel:'恢复备份',nextName:d.currentImportFileName||file.name}))return;
    d.id=newInventorySessionId();d.savedAt=Date.now();
    await writeSession(d);applySavedSession(d);
    showToast('✅ 已恢复备份，可继续盘点');
  }catch(e){showToast('❌ 恢复失败：'+e.message,true);}
  finally{isProcessing=false;}
}

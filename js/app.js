'use strict';
function bindAppEvents(){
  bindFileImport();
  var settingsToggle=document.getElementById('settingsToggle');
  var settingsPanel=document.getElementById('settingsPanel');
  var settingsTimer=null;
  function closeSettings(){clearTimeout(settingsTimer);settingsPanel.hidden=true;settingsToggle.setAttribute('aria-expanded','false');}
  settingsToggle.addEventListener('click',function(){
    settingsPanel.hidden=!settingsPanel.hidden;
    settingsToggle.setAttribute('aria-expanded',String(!settingsPanel.hidden));
    clearTimeout(settingsTimer);if(!settingsPanel.hidden)settingsTimer=setTimeout(closeSettings,15000);
  });
  settingsPanel.addEventListener('click',function(e){if(e.target.closest('button,label'))closeSettings();});
  document.addEventListener('click',function(e){if(!settingsPanel.hidden&&!settingsPanel.contains(e.target)&&!settingsToggle.contains(e.target))closeSettings();});
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&!settingsPanel.hidden){closeSettings();settingsToggle.focus();}});

  document.getElementById('confirmBtn').onclick=function(){if(window.SoundManager)SoundManager.unlock();var input=document.getElementById('manualInput'),val=input.value.trim();if(val){handleBarcode(val,false);input.value='';}hideKeyboard();};
  document.getElementById('manualInput').addEventListener('keydown',function(e){if(e.key==='Enter'){if(window.SoundManager)SoundManager.unlock();var val=e.target.value.trim();if(val){handleBarcode(val,false);e.target.value='';}hideKeyboard();}});
  document.getElementById('scanBtn').onclick=function(){if(window.SoundManager)SoundManager.unlock();if(scanning)stopScanning(true);else startScanning();hideKeyboard();};
  document.getElementById('showKeyboardBtn').onclick=showKeyboard;
  var enhance=document.getElementById('scanEnhanceBtn');if(enhance)enhance.onclick=toggleEnhanceMode;var soundBtn=document.getElementById('scanSoundBtn');if(soundBtn)soundBtn.onclick=function(e){e.stopPropagation();if(window.SoundManager){SoundManager.unlock();var on=SoundManager.toggle();showToast(on?'🔊 扫码提示音已开启':'🔇 扫码提示音已关闭');}};
  var scrollArea=document.querySelector('.scrollable-area'),bottomBar=document.querySelector('.bottom-fixed-btns'),lastScroll=scrollArea.scrollTop;
  function restoreBottomBar(){bottomBar.classList.remove('bottom-bar-hidden');}
  scrollArea.addEventListener('scroll',function(){
    var y=scrollArea.scrollTop;
    if(y<lastScroll||y<=0)restoreBottomBar();
    else if(y>lastScroll&&y+scrollArea.clientHeight>=scrollArea.scrollHeight-8&&!document.body.classList.contains('keyboard-open'))bottomBar.classList.add('bottom-bar-hidden');
    lastScroll=y;
  },{passive:true});
  scrollArea.addEventListener('wheel',function(e){if(e.deltaY<0)restoreBottomBar();},{passive:true});
  var lastTouchY=null;
  scrollArea.addEventListener('touchstart',function(e){lastTouchY=e.touches[0].clientY;},{passive:true});
  scrollArea.addEventListener('touchmove',function(e){var y=e.touches[0].clientY;if(lastTouchY!==null&&y>lastTouchY)restoreBottomBar();lastTouchY=y;},{passive:true});
  document.getElementById('manualInput').addEventListener('focus',restoreBottomBar);
  window.addEventListener('resize',function(){setTimeout(function(){autoAdjustColumns();positionScanErrorToast();},100);});
  window.addEventListener('beforeunload',function(){if(scanning)stopScanning(true);});
  document.addEventListener('visibilitychange',function(){if(document.hidden&&scanning){stopScanning(true);showToast('摄像头已在后台自动关闭，节省电量');}});
  document.addEventListener('touchstart',function(e){if(currentInputElement&&!e.target.closest('.qty-input')&&!e.target.closest('.price-input')&&!e.target.closest('#manualInput'))hideKeyboard();});
  document.addEventListener('keydown',function(e){if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'&&!e.shiftKey){e.preventDefault();undoLastChange();}});
}
async function initApp(){columns=['实际数量','实际价格','商品名称','编码','价格'];normalizeSpecialColumns();if(window.SoundManager)SoundManager.init();bindAppEvents();setupKeyboardListener();var restored=await restoreSession();if(!restored){rebuildSearchIndex();renderPage();}console.log('⚡ 飞速盘点 '+VERSION+' - 模块化增强版');console.log('✅ CSV流式Worker / O(1)条码索引 / IndexedDB自动恢复 / 安全DOM渲染 / Ctrl+Z撤销 / 扫码双音反馈');}
initApp();

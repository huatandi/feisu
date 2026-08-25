'use strict';
function bindAppEvents(){
  bindFileImport();
  document.getElementById('confirmBtn').onclick=function(){var input=document.getElementById('manualInput'),val=input.value.trim();if(val){handleBarcode(val,false);input.value='';}hideKeyboard();};
  document.getElementById('manualInput').addEventListener('keydown',function(e){if(e.key==='Enter'){var val=e.target.value.trim();if(val){handleBarcode(val,false);e.target.value='';}hideKeyboard();}});
  document.getElementById('scanBtn').onclick=function(){if(scanning)stopScanning(true);else startScanning();hideKeyboard();};
  document.getElementById('showKeyboardBtn').onclick=showKeyboard;
  var enhance=document.getElementById('scanEnhanceBtn');if(enhance)enhance.onclick=toggleEnhanceMode;
  window.addEventListener('resize',function(){setTimeout(autoAdjustColumns,100);});
  window.addEventListener('beforeunload',function(){if(scanning)stopScanning(true);});
  document.addEventListener('touchstart',function(e){if(currentInputElement&&!e.target.closest('.qty-input')&&!e.target.closest('.price-input')&&!e.target.closest('#manualInput'))hideKeyboard();});
  document.addEventListener('keydown',function(e){if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'&&!e.shiftKey){e.preventDefault();undoLastChange();}});
}
async function initApp(){columns=['实际数量','实际价格','商品名称','编码','价格'];normalizeSpecialColumns();bindAppEvents();setupKeyboardListener();var restored=await restoreSession();if(!restored){rebuildSearchIndex();renderPage();}console.log('⚡ 飞速盘点 '+VERSION+' - 模块化增强版');console.log('✅ CSV流式Worker / O(1)条码索引 / IndexedDB自动恢复 / 安全DOM渲染 / Ctrl+Z撤销');}
initApp();

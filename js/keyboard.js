'use strict';
/* v5.1.11：把键盘真实高度写进 --kb-inset，按钮条据此贴着键盘顶边。
   同时处理 iOS 聚焦输入框时 visualViewport 的滚动（offsetTop 变化）。 */
function syncKeyboardInset(){
  var vv=window.visualViewport;
  var inset=0;
  if(vv){inset=Math.max(0,Math.round(window.innerHeight-vv.height-(vv.offsetTop||0)));}
  else{inset=Math.max(0,Math.round(originalViewportHeight-window.innerHeight));}
  if(inset>0&&inset<80)inset=0;              /* 浏览器工具栏抖动，忽略 */
  document.documentElement.style.setProperty('--kb-inset',inset+'px');
  /* iOS 自带 ^ v ✓ 辅助条（约 48px）不在 visualViewport 内，需要额外抬高；
     其它平台没有这条，留 8px 缝隙即可。 */
  var ios=/iPad|iPhone|iPod/.test(navigator.userAgent||'');
  document.documentElement.style.setProperty('--kb-gap',(ios?89:8)+'px');
  return inset;
}
function setupKeyboardListener(){if(!isMobile)return;
if(window.visualViewport){window.visualViewport.addEventListener('scroll',syncKeyboardInset,{passive:true});}
syncKeyboardInset();if(window.visualViewport){window.visualViewport.addEventListener('resize',function(){syncKeyboardInset();var h=originalViewportHeight-window.visualViewport.height;if(h>150)document.body.classList.add('keyboard-open');else{document.body.classList.remove('keyboard-open');syncKeyboardInset();setTimeout(function(){if(pendingJump!==null){var row=document.getElementById('row-'+pendingJump);if(row)row.scrollIntoView({behavior:'smooth',block:'center'});}},100);}});}window.addEventListener('resize',function(){document.body.classList.toggle('keyboard-open',originalViewportHeight-window.innerHeight>150);});}
function showKeyboard(){if(currentInputElement&&document.activeElement!==currentInputElement){currentInputElement.focus();currentInputElement.select();}else{var input=document.getElementById('manualInput');if(input){input.focus();input.select();currentInputElement=input;}}}
function hideKeyboard(){if(currentInputElement){currentInputElement.blur();currentInputElement=null;}if(document.activeElement&&document.activeElement.blur)document.activeElement.blur();document.body.classList.remove('keyboard-open');syncKeyboardInset();}

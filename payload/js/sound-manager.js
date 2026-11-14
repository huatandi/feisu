'use strict';

/**
 * Sanfei SoundManager v4.4.0
 * 重点修复 iOS/Android/PWA AudioContext 解锁与提示音过轻问题。
 */
var SoundManager = (function(){
  var STORAGE_KEY = 'sanfei_scan_sound_enabled';
  var ctx = null;
  var successAudio = null, errorAudio = null;
  var enabled = true;
  var lastByType = { success:{barcode:'',at:0}, error:{barcode:'',at:0} };
  var SAME_BARCODE_COOLDOWN = { success:800, error:1000 };
  var gestureBound = false;

  function getCtor(){ return window.AudioContext || window.webkitAudioContext || null; }

  function init(){
    try {
      var saved = localStorage.getItem(STORAGE_KEY);
      enabled = saved === null ? true : saved === 'true';
    } catch(e){ enabled = true; }
    try {
      successAudio=new Audio('./assets/audio/scan-success.wav');
      errorAudio=new Audio('./assets/audio/scan-error.wav');
      [successAudio,errorAudio].forEach(function(a){a.preload='auto';a.volume=1;a.load();});
    } catch(e){ successAudio=null; errorAudio=null; }
    updateToggleUI();
    bindGestureUnlock();
    window.addEventListener('pageshow',function(){if(enabled)unlock();});
    document.addEventListener('visibilitychange',function(){if(enabled&&!document.hidden)unlock();});
  }

  // 必须尽量在用户手势的同步调用栈里创建/恢复 AudioContext。
  function unlock(){
    try {
      var Ctor = getCtor();
      if(!Ctor) return Promise.resolve(false);
      if(!ctx || ctx.state === 'closed') ctx = new Ctor();

      var p = Promise.resolve();
      if(ctx.state === 'suspended' && ctx.resume) p = ctx.resume();

      return p.then(function(){
        // 播放一个完全静音的极短 buffer，帮助 Safari/PWA 真正解锁输出通道。
        try {
          var b = ctx.createBuffer(1, 1, 22050);
          var s = ctx.createBufferSource();
          var g = ctx.createGain();
          g.gain.value = 0.00001;
          s.buffer = b; s.connect(g); g.connect(ctx.destination); s.start(0);
        } catch(e){}
        return ctx.state === 'running';
      }).catch(function(e){
        console.warn('[SoundManager] resume failed:', e);
        return false;
      });
    } catch(e){
      console.warn('[SoundManager] unlock failed:', e);
      return Promise.resolve(false);
    }
  }

  function bindGestureUnlock(){
    if(gestureBound) return;
    gestureBound = true;
    function once(){ unlock();primeMedia(successAudio);primeMedia(errorAudio); }
    document.addEventListener('pointerdown', once, {passive:true});
    document.addEventListener('touchend', once, {passive:true});
    document.addEventListener('keydown', once, {passive:true});
  }

  function primeMedia(audio){
    if(!audio||audio._sanfeiPrimed)return;
    try{audio.muted=true;var p=audio.play();if(p&&p.then)p.then(function(){audio.pause();audio.currentTime=0;audio.muted=false;audio._sanfeiPrimed=true;}).catch(function(){audio.muted=false;});}catch(e){audio.muted=false;}
  }

  function playMedia(audio,fallback){
    if(!audio){fallback();return;}
    try{audio.pause();audio.currentTime=0;audio.muted=false;audio.volume=1;var p=audio.play();if(p&&p.catch)p.catch(fallback);}catch(e){fallback();}
  }

  function shouldPlay(type, barcode){
    if(!enabled) return false;
    var now=Date.now(), code=String(barcode||''), last=lastByType[type];
    if(last && code && last.barcode===code && now-last.at<SAME_BARCODE_COOLDOWN[type]) return false;
    lastByType[type]={barcode:code,at:now};
    return true;
  }

  function safeVibrate(pattern){
    try { if(navigator.vibrate) navigator.vibrate(pattern); } catch(e){}
  }

  function ensureReady(){
    if(!enabled) return Promise.resolve(false);
    if(ctx && ctx.state === 'running') return Promise.resolve(true);
    return unlock();
  }

  function success(barcode){
    if(!shouldPlay('success', barcode)) return;
    safeVibrate(28);
    playMedia(successAudio,playSuccess);
  }

  function error(barcode){
    if(!shouldPlay('error', barcode)) return;
    safeVibrate([75,35,75]);
    playMedia(errorAudio,playError);
  }

  function playSuccess(){
    ensureReady().then(function(ok){
      if(!ok || !ctx) return;
      try {
        var now=ctx.currentTime;
        var master=ctx.createGain(), compressor=ctx.createDynamicsCompressor();
        compressor.threshold.value=-18;compressor.knee.value=12;compressor.ratio.value=6;compressor.attack.value=.002;compressor.release.value=.12;
        master.gain.setValueAtTime(0.0001,now);
        master.gain.exponentialRampToValueAtTime(0.88,now+0.004);
        master.gain.exponentialRampToValueAtTime(0.0001,now+0.30);
        master.connect(compressor);compressor.connect(ctx.destination);

        var o1=ctx.createOscillator();
        o1.type='sine';
        o1.frequency.setValueAtTime(1760,now);
        o1.frequency.exponentialRampToValueAtTime(1480,now+0.24);
        o1.connect(master);

        var hg=ctx.createGain();
        hg.gain.setValueAtTime(0.34,now);
        hg.gain.exponentialRampToValueAtTime(0.0001,now+0.20);
        hg.connect(compressor);
        var o2=ctx.createOscillator();
        o2.type='sine'; o2.frequency.value=2352; o2.connect(hg);

        o1.start(now); o2.start(now);
        o1.stop(now+0.31); o2.stop(now+0.21);
      } catch(e){ console.warn('[SoundManager] success failed:',e); }
    });
  }

  function playError(){
    ensureReady().then(function(ok){
      if(!ok || !ctx) return;
      try {
        var now=ctx.currentTime, osc=ctx.createOscillator(), gain=ctx.createGain(), compressor=ctx.createDynamicsCompressor();
        compressor.threshold.value=-20;compressor.knee.value=10;compressor.ratio.value=8;compressor.attack.value=.002;compressor.release.value=.15;
        osc.type='triangle';
        osc.frequency.setValueAtTime(210,now);
        osc.frequency.exponentialRampToValueAtTime(95,now+0.26);
        gain.gain.setValueAtTime(0.0001,now);
        gain.gain.exponentialRampToValueAtTime(0.82,now+0.005);
        gain.gain.setValueAtTime(0.72,now+0.18);
        gain.gain.exponentialRampToValueAtTime(0.0001,now+0.38);
        osc.connect(gain);gain.connect(compressor);compressor.connect(ctx.destination);
        osc.start(now); osc.stop(now+0.39);
      } catch(e){ console.warn('[SoundManager] error failed:',e); }
    });
  }

  // 用户点音效按钮时立即试听；用于确认设备音频通道已经解锁。
  function test(){
    if(!enabled) return;
    unlock().then(function(){ playMedia(successAudio,playSuccess); });
  }

  function setEnabled(value){
    enabled=!!value;
    try { localStorage.setItem(STORAGE_KEY,String(enabled)); } catch(e){}
    updateToggleUI();
    if(enabled) unlock();
    return enabled;
  }

  function toggle(){
    enabled=!enabled;
    try { localStorage.setItem(STORAGE_KEY,String(enabled)); } catch(e){}
    updateToggleUI();
    if(enabled) test();
    return enabled;
  }

  function isEnabled(){ return enabled; }

  function updateToggleUI(){
    var btn=document.getElementById('scanSoundBtn');
    if(!btn) return;
    btn.classList.toggle('active',enabled);
    btn.textContent=enabled?'🔊 音效':'🔇 静音';
    btn.setAttribute('aria-pressed',enabled?'true':'false');
    btn.title=enabled?'扫码提示音：开（点击可关闭）':'扫码提示音：关（点击开启并试听）';
  }

  return {
    init:init, unlock:unlock, success:success, error:error, test:test,
    setEnabled:setEnabled, toggle:toggle, isEnabled:isEnabled, updateToggleUI:updateToggleUI
  };
})();
window.SoundManager=SoundManager;

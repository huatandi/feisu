'use strict';

/**
 * Sanfei SoundManager v4.1
 * 扫码业务结果提示音：成功=清脆高音“叮”，失败=低沉“噗/咚”。
 * 零音频资源、完全离线、单 AudioContext 复用。
 */
var SoundManager = (function(){
  var STORAGE_KEY = 'sanfei_scan_sound_enabled';
  var ctx = null;
  var enabled = true;
  var lastByType = { success: {barcode:'', at:0}, error: {barcode:'', at:0} };
  var SAME_BARCODE_COOLDOWN = { success: 800, error: 1000 };

  function init(){
    try {
      var saved = localStorage.getItem(STORAGE_KEY);
      enabled = saved === null ? true : saved === 'true';
    } catch(e) { enabled = true; }
    updateToggleUI();
  }

  function getAudioContextCtor(){ return window.AudioContext || window.webkitAudioContext || null; }

  async function unlock(){
    try {
      var Ctor = getAudioContextCtor();
      if(!Ctor) return false;
      if(!ctx || ctx.state === 'closed') ctx = new Ctor();
      if(ctx.state === 'suspended') await ctx.resume();
      return ctx.state === 'running';
    } catch(e) {
      console.warn('[SoundManager] AudioContext unlock failed:', e);
      return false;
    }
  }

  function shouldPlay(type, barcode){
    if(!enabled) return false;
    var now = Date.now();
    var code = String(barcode || '');
    var last = lastByType[type];
    if(last && code && last.barcode === code && (now - last.at) < SAME_BARCODE_COOLDOWN[type]) return false;
    lastByType[type] = { barcode: code, at: now };
    return true;
  }

  function safeVibrate(pattern){
    try { if(navigator.vibrate) navigator.vibrate(pattern); } catch(e) {}
  }

  function success(barcode){
    if(!shouldPlay('success', barcode)) return;
    safeVibrate(28);
    playSuccess().catch(function(e){ console.warn('[SoundManager] success sound failed:', e); });
  }

  function error(barcode){
    if(!shouldPlay('error', barcode)) return;
    safeVibrate([75, 35, 75]);
    playError().catch(function(e){ console.warn('[SoundManager] error sound failed:', e); });
  }

  async function ensureReady(){
    if(!enabled) return false;
    if(!ctx || ctx.state !== 'running') return unlock();
    return true;
  }

  async function playSuccess(){
    if(!(await ensureReady())) return;
    var now = ctx.currentTime;
    var master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(0.18, now + 0.006);
    master.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
    master.connect(ctx.destination);

    // 主音：清脆明亮，不做刺耳的方波“哔”。
    var bell = ctx.createOscillator();
    bell.type = 'sine';
    bell.frequency.setValueAtTime(1568, now); // G6 附近
    bell.frequency.exponentialRampToValueAtTime(1475, now + 0.16);
    bell.connect(master);

    // 极轻的高次泛音，让“叮”更通透。
    var harmonicGain = ctx.createGain();
    harmonicGain.gain.setValueAtTime(0.055, now);
    harmonicGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    harmonicGain.connect(ctx.destination);
    var harmonic = ctx.createOscillator();
    harmonic.type = 'sine';
    harmonic.frequency.setValueAtTime(2352, now);
    harmonic.connect(harmonicGain);

    bell.start(now); harmonic.start(now);
    bell.stop(now + 0.19); harmonic.stop(now + 0.13);
  }

  async function playError(){
    if(!(await ensureReady())) return;
    var now = ctx.currentTime;

    // 低频下坠，形成低沉“咚/噗”的主体。
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(190, now);
    osc.frequency.exponentialRampToValueAtTime(105, now + 0.22);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.18, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);
    osc.connect(gain); gain.connect(ctx.destination);

    // 一小段低通噪声，让失败音更像“噗”而不是电子蜂鸣。
    var length = Math.max(1, Math.floor(ctx.sampleRate * 0.12));
    var buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    var data = buffer.getChannelData(0);
    for(var i=0;i<length;i++) data[i] = (Math.random()*2-1) * Math.pow(1-i/length, 2);
    var noise = ctx.createBufferSource();
    noise.buffer = buffer;
    var filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(280, now);
    filter.Q.setValueAtTime(0.7, now);
    var noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.045, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    noise.connect(filter); filter.connect(noiseGain); noiseGain.connect(ctx.destination);

    osc.start(now); noise.start(now);
    osc.stop(now + 0.25); noise.stop(now + 0.13);
  }

  function setEnabled(value){
    enabled = !!value;
    try { localStorage.setItem(STORAGE_KEY, String(enabled)); } catch(e) {}
    updateToggleUI();
    if(enabled) unlock();
    return enabled;
  }

  function toggle(){ return setEnabled(!enabled); }
  function isEnabled(){ return enabled; }

  function updateToggleUI(){
    var btn = document.getElementById('scanSoundBtn');
    if(!btn) return;
    btn.classList.toggle('active', enabled);
    btn.textContent = enabled ? '🔊 音效' : '🔇 静音';
    btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    btn.title = enabled ? '扫码提示音：开' : '扫码提示音：关';
  }

  return {
    init: init,
    unlock: unlock,
    success: success,
    error: error,
    setEnabled: setEnabled,
    toggle: toggle,
    isEnabled: isEnabled,
    updateToggleUI: updateToggleUI
  };
})();

window.SoundManager = SoundManager;

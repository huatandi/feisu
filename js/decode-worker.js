/* FEISU 解码 worker —— 把 ZXing 的识别从主线程挪到后台线程。
 * 主线程只做 drawImage + getImageData（几毫秒），识别（30–100ms）在这里跑，
 * 所以相机预览不再被解码阻塞。
 *
 * 消息约定
 *   收：{ id, w, h, buf(ArrayBuffer, RGBA), formats(number[]), harder(boolean) }
 *   发：{ id, text, format }  或  { id, error }  或  { unsupported:true }
 */
self.window = self;
importScripts('../vendor/zxing-0.19.1.min.js');

var Z = self.ZXing || (self.window && self.window.ZXing);
var readers = {};

if (!Z || !Z.RGBLuminanceSource || !Z.BrowserMultiFormatReader) {
  self.postMessage({ unsupported: true });
} else {
  self.onmessage = function (e) {
    var d = e.data || {};
    if (!d.buf) { self.postMessage({ id: d.id, error: 'nobuf' }); return; }
    var w = d.w | 0, h = d.h | 0;
    if (w < 8 || h < 8) { self.postMessage({ id: d.id, error: 'tiny' }); return; }

    var rgba = new Uint8ClampedArray(d.buf);
    var n = w * h, u32 = new Uint32Array(n), i;
    /* RGBA → ARGB（RGBLuminanceSource 按 (R<<16)|(G<<8)|B 取分量） */
    for (i = 0; i < n; i++) {
      u32[i] = (255 << 24) | (rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2];
    }

    var key = (d.formats || []).join(',') + '|' + (d.harder ? 'h' : 'n');
    var reader = readers[key];
    if (!reader) {
      var hints = new Map();
      if (d.formats && d.formats.length) hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, d.formats);
      if (d.harder) hints.set(Z.DecodeHintType.TRY_HARDER, true);
      reader = new Z.BrowserMultiFormatReader(hints);
      readers[key] = reader;
    }

    try {
      var src = new Z.RGBLuminanceSource(u32, w, h, w, h, 0, 0);
      var bitmap = new Z.BinaryBitmap(new Z.HybridBinarizer(src));
      var res = reader.decodeBitmap(bitmap);
      self.postMessage({ id: d.id, text: res.getText(), format: res.getBarcodeFormat() });
    } catch (err1) {
      /* 低对比/不均匀时换全局直方图再试一次（仍在后台线程） */
      try {
        var src2 = new Z.RGBLuminanceSource(u32, w, h, w, h, 0, 0);
        var bitmap2 = new Z.BinaryBitmap(new Z.GlobalHistogramBinarizer(src2));
        var res2 = reader.decodeBitmap(bitmap2);
        self.postMessage({ id: d.id, text: res2.getText(), format: res2.getBarcodeFormat() });
      } catch (err2) {
        self.postMessage({ id: d.id, error: (err1 && (err1.kind || err1.name)) || 'fail' });
      }
    }
  };
}

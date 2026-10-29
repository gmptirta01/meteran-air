/**
 * MeterQR — membaca stiker QR ID Pelanggan dari foto (stiker dibuat aplikasi lain).
 *
 * Isi QR: ID Pelanggan (mis. "0012345"), tanpa nama/awalan. Isi QR dipakai apa adanya TANPA validasi
 * (keputusan pengguna 2026-10-16); server membuat baris pelanggan otomatis bila ID dari QR belum terdaftar.
 *
 * Cara scan:
 *   - live(): analisis bingkai langsung dari kamera (viewfinder) -> terbaca otomatis tanpa memotret.
 *   - decodeCanvas(): dari foto (cadangan bila kamera langsung tidak tersedia, dan otomatis dari foto meter).
 *
 * Pembaca:
 *   - BarcodeDetector bawaan browser (Android Chrome): tanpa unduhan, jalan offline.
 *   - jsQR 1.4.0 (Cosmo Wolfe, Apache-2.0, vendor/jsQR.js) — dimuat HANYA bila browser tidak punya
 *     BarcodeDetector (mis. iPhone).
 */
(function (global) {
  'use strict';

  // Lokal (vendor/jsQR.js, sama persis dengan npm jsqr@1.4.0) agar tidak bergantung pada CDN pihak ketiga.
  // Build Apps Script tidak bisa menyajikan vendor/ -> memakai CDN versi tetap + cek integritas (SRI).
  const JSQR_URL = global.JSQR_SRC || 'vendor/jsQR.js';
  let loading = null;
  function loadJsQR() {
    if (global.jsQR) return Promise.resolve(global.jsQR);
    if (!loading) {
      loading = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = JSQR_URL; s.async = true;
        if (global.JSQR_SRI) { s.integrity = global.JSQR_SRI; s.crossOrigin = 'anonymous'; }
        s.onload = () => (global.jsQR ? resolve(global.jsQR) : reject(new Error('Pembaca QR tidak termuat')));
        s.onerror = () => { loading = null; s.remove(); reject(new Error('Pembaca QR gagal dimuat (perlu internet)')); };
        document.head.appendChild(s);
      });
    }
    return loading;
  }

  /** Teks QR -> ID Pelanggan apa adanya (tanpa validasi format; hanya spasi tepi dibuang, maks. 64 karakter) */
  function parse(text) {
    const t = String(text || '').trim();
    return t && t.length <= 64 ? t : null;
  }

  let detector;   // BarcodeDetector bawaan (null bila tidak ada)
  async function nativeDetector() {
    if (detector !== undefined) return detector;
    detector = null;
    try {
      if ('BarcodeDetector' in global) {
        const fmts = global.BarcodeDetector.getSupportedFormats ? await global.BarcodeDetector.getSupportedFormats() : ['qr_code'];
        if (fmts.includes('qr_code')) detector = new global.BarcodeDetector({ formats: ['qr_code'] });
      }
    } catch { detector = null; }
    return detector;
  }

  /** Salin (sebagian) kanvas, diperkecil bila sangat besar */
  function crop(src, x, y, w, h, maxSide) {
    const s = Math.min(1, maxSide / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
    c.getContext('2d', { willReadFrequently: true }).drawImage(src, x, y, w, h, 0, 0, c.width, c.height);
    return c;
  }

  /**
   * Cari stiker QR ID di gambar (foto meter / foto stiker). -> { id, raw, method: 'native'|'jsqr' } atau null.
   * opts.thorough (tombol Scan QR): bila QR kecil, ulangi pada potongan 2x2 tumpang-tindih agar QR tampak lebih
   * besar. Tanpa itu (otomatis dari setiap foto meter) cukup sekali pindai -> tidak memperlambat HP tanpa
   * BarcodeDetector ketika fotonya memang tidak berisi QR.
   */
  async function decodeCanvas(canvas, opts = {}) {
    // otomatis dari foto meter: 1200 px cukup (QR stiker ±150-250 px) & ±1,8x lebih ringan untuk jsQR
    const tries = [crop(canvas, 0, 0, canvas.width, canvas.height, opts.thorough ? 1600 : 1200)];
    const W = canvas.width, H = canvas.height, cw = Math.round(W * 0.6), ch = Math.round(H * 0.6);
    if (opts.thorough) for (const [x, y] of [[0, 0], [W - cw, 0], [0, H - ch], [W - cw, H - ch]]) tries.push(crop(canvas, x, y, cw, ch, 1200));
    const nat = await nativeDetector();
    if (nat) {
      for (const c of tries) {
        try {
          for (const b of await nat.detect(c)) { const id = parse(b.rawValue); if (id) return { id, raw: b.rawValue, method: 'native' }; }
        } catch { break; }   // BarcodeDetector bermasalah -> jsQR
      }
    }
    let jsQR;
    try { jsQR = await loadJsQR(); } catch (err) { if (nat) return null; throw err; }
    for (const c of tries) {
      const img = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
      const r = jsQR(img.data, c.width, c.height, { inversionAttempts: 'attemptBoth' });
      const id = r && parse(r.data);
      if (id) return { id, raw: r.data, method: 'jsqr' };
    }
    return null;
  }

  /**
   * Muat pembaca QR lebih awal (waktu luang setelah login) HANYA bila browser tidak punya BarcodeDetector:
   * scan pertama tidak menunggu unduhan, dan file ikut tersimpan di cache browser / service worker (offline).
   */
  async function preload() {
    if (await nativeDetector()) return;
    try { await loadJsQR(); } catch { /* offline: dicoba lagi saat scan */ }
  }

  /**
   * Kamera belakang untuk scan langsung -> { hasTorch, torch(on), close() }.
   * Melempar error getUserMedia apa adanya (NotAllowedError, NotFoundError, ...) agar pemanggil bisa
   * menawarkan foto sebagai cadangan.
   */
  async function openCamera(video) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw Object.assign(new Error('Kamera langsung tidak didukung di browser ini.'), { name: 'NotSupportedError' });
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    const track = stream.getVideoTracks()[0];
    const caps = (track.getCapabilities && track.getCapabilities()) || {};
    if ((caps.focusMode || []).includes('continuous')) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    video.muted = true; video.playsInline = true;
    video.srcObject = stream;
    try { await video.play(); } catch (err) { stream.getTracks().forEach((t) => t.stop()); throw err; }
    return {
      hasTorch: !!caps.torch,
      torch: (on) => track.applyConstraints({ advanced: [{ torch: !!on }] }),
      close() { stream.getTracks().forEach((t) => t.stop()); video.srcObject = null; },
    };
  }

  /**
   * Analisis bingkai langsung: setiap bingkai video baru dianalisis (tidak tumpang-tindih) sampai QR terbaca.
   *   - BarcodeDetector: seluruh bingkai, ±10 analisis/detik.
   *   - jsQR: hanya area bingkai bidik (opts.region, koordinat video) maks. 640 px, ±5 analisis/detik;
   *     umumnya tanpa inversi, tiap bingkai ke-4 juga mencoba QR terbalik (terang di atas gelap).
   * opts: { region(vw, vh) -> {x,y,w,h}, onResult({id, raw, method}), onError(err) }  -> { stop() }
   */
  function live(video, opts) {
    let stopped = false, busy = false, last = 0, n = 0, handle = 0, timer = 0, nat = null, jsQR = null;
    const rvfc = typeof video.requestVideoFrameCallback === 'function';
    const c = document.createElement('canvas'), ctx = c.getContext('2d', { willReadFrequently: true });
    const stop = () => {
      stopped = true;
      clearTimeout(timer);
      if (rvfc) video.cancelVideoFrameCallback(handle); else cancelAnimationFrame(handle);
    };
    const next = () => {
      if (stopped) return;
      // video terjeda (mis. browser menjedanya saat tab tersembunyi) -> tidak ada bingkai baru; putar lagi & cek ulang
      if (video.paused) { video.play().catch(() => {}); timer = setTimeout(tick, 250); return; }
      handle = rvfc ? video.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
    };
    const fail = (err) => { if (stopped) return; stop(); if (opts.onError) opts.onError(err); };

    async function analyze() {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (nat) {
        for (const b of await nat.detect(video)) { const id = parse(b.rawValue); if (id) return { id, raw: b.rawValue, method: 'native' }; }
        return null;
      }
      const g = (opts.region && opts.region(vw, vh)) || { x: 0, y: 0, w: vw, h: vh };
      const s = Math.min(1, 640 / Math.max(g.w, g.h));
      const w = Math.max(1, Math.round(g.w * s)), h = Math.max(1, Math.round(g.h * s));
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      ctx.drawImage(video, g.x, g.y, g.w, g.h, 0, 0, w, h);
      const r = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: n % 4 === 0 ? 'attemptBoth' : 'dontInvert' });
      const id = r && parse(r.data);
      return id ? { id, raw: r.data, method: 'jsqr' } : null;
    }
    async function tick() {
      if (stopped) return;
      const now = performance.now();
      if (busy || now - last < (nat ? 100 : 180) || video.paused || video.readyState < 2 || !video.videoWidth) return next();
      busy = true; last = now; n++;
      let r = null;
      try {
        r = await analyze();
      } catch (err) {
        if (!nat) return fail(err);
        nat = null;   // BarcodeDetector bermasalah -> jsQR
        try { jsQR = await loadJsQR(); } catch (e) { return fail(e); }
      } finally { busy = false; }
      if (stopped) return;
      if (r) { stop(); opts.onResult(r); return; }
      next();
    }

    nativeDetector()
      .then((d) => { nat = d; return d ? null : loadJsQR().then((f) => { jsQR = f; }); })
      .then(next, fail);
    return { stop };
  }

  global.MeterQR = { parse, decodeCanvas, preload, openCamera, live, JSQR_URL };
})(window);

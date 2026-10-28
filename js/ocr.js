/**
 * MeterOCR — OCR angka meter air buatan sendiri (tanpa library, tanpa server).
 *
 * Pipeline:
 *   1. ROI      : potong area jendela angka (dipilih petugas), normalisasi tinggi.
 *   2. Segmentasi: bagi ROI menjadi N kolom sama lebar (roda angka meter berjarak sama).
 *   3. Per digit: grayscale -> threshold Otsu -> deteksi polaritas (gelap/terang)
 *                 -> connected components -> buang noise/sekat -> bounding box
 *                 -> deteksi digit "berputar" (setengah terlihat).
 *   4. Normalisasi: digit di-fit ke patch 20x32 (aspect ratio dijaga).
 *   5. Fitur    : piksel 10x16 + HOG (histogram arah gradien) + rasio aspek.
 *   6. Klasifikasi: k-Nearest Neighbor terhadap sampel:
 *                 - sampel sintetis (digit dirender dari font, sebagai titik awal)
 *                 - sampel nyata dari koreksi petugas (model makin akurat seiring pemakaian)
 */
(function (global) {
  'use strict';

  const DW = 20, DH = 32;     // ukuran patch digit ternormalisasi
  const ROI_H = 96;           // tinggi ROI setelah diskalakan
  const K = 7;                // jumlah tetangga k-NN
  const MAX_PER_LABEL = 200;  // batas sampel nyata per digit
  const USER_WEIGHT = 4;      // bobot suara sampel nyata (dari foto meter asli)
  const SYNTH_WEIGHT = 0.5;   // bobot suara sampel sintetis (font bawaan)
  const STORAGE_KEY = 'meterOcrModel.v1';
  const CNN_WEIGHT = 0.6;     // porsi CNN dalam ensemble CNN + k-NN (bila CNN aktif)
  // Acuan bulan lalu: porsi & "kelembutan" peluang untuk angka mirip di luar K tetangga (lihat softenForPrior).
  // Eksperimen 14 foto: membetulkan +1 foto (belum belajar & leave-one-out), 0 salah-tapi-yakin.
  const SOFT_EPS = 0.1, SOFT_TAU = 0.08;

  // =====================================================================
  // Util citra
  // =====================================================================
  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  /**
   * ImageData -> {w,h,data: Float32Array 0..255}
   * channel 'luma' = kecerahan biasa; 'red' = kemerahan (R - max(G,B)), dibalik agar tinta
   * merah menjadi gelap. Pada kanal 'red', latar putih DAN pantulan silau sama-sama terang,
   * sehingga hanya tinta merah yang tersisa — jauh lebih bersih untuk roda desimal.
   */
  function toGray(img, channel = 'luma') {
    const n = img.width * img.height, d = img.data, out = new Float32Array(n);
    if (channel === 'red') {
      for (let i = 0, j = 0; i < n; i++, j += 4) {
        const r = d[j] - Math.max(d[j + 1], d[j + 2]);
        out[i] = 255 - Math.max(0, Math.min(255, r * 2.5));
      }
    } else {
      for (let i = 0, j = 0; i < n; i++, j += 4) out[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
    }
    return { w: img.width, h: img.height, data: out };
  }

  function subImage(g, x0, y0, w, h) {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = g.data[(y0 + y) * g.w + x0 + x];
    return { w, h, data: out };
  }

  /** Perenggangan kontras pada persentil 2%–98% */
  function stretch(g) {
    const hist = new Uint32Array(256);
    for (const v of g.data) hist[Math.max(0, Math.min(255, v | 0))]++;
    const n = g.data.length;
    let acc = 0, lo = 0, hi = 255;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= n * 0.02) { lo = i; break; } }
    acc = 0;
    for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= n * 0.02) { hi = i; break; } }
    const range = Math.max(1, hi - lo);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.max(0, Math.min(255, (g.data[i] - lo) * 255 / range));
    return { w: g.w, h: g.h, data: out };
  }

  /** Threshold Otsu */
  function otsu(data) {
    const hist = new Float64Array(256);
    for (const v of data) hist[Math.max(0, Math.min(255, v | 0))]++;
    const total = data.length;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, t = 127;
    for (let i = 0; i < 256; i++) {
      wB += hist[i]; if (!wB) continue;
      const wF = total - wB; if (!wF) break;
      sumB += i * hist[i];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; t = i; }
    }
    return t;
  }

  /** Connected components 8-tetangga */
  function components(mask, w, h) {
    const labels = new Int32Array(w * h).fill(-1);
    const comps = [], stack = [];
    for (let i = 0; i < w * h; i++) {
      if (!mask[i] || labels[i] >= 0) continue;
      const c = { id: comps.length, x0: w, y0: h, x1: -1, y1: -1, area: 0 };
      labels[i] = c.id; stack.push(i);
      while (stack.length) {
        const p = stack.pop(), x = p % w, y = (p / w) | 0;
        c.area++;
        if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x;
        if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy; if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx; if (nx < 0 || nx >= w) continue;
            const q = ny * w + nx;
            if (mask[q] && labels[q] < 0) { labels[q] = c.id; stack.push(q); }
          }
        }
      }
      comps.push(c);
    }
    return { labels, comps };
  }

  // =====================================================================
  // Proses 1 sel digit -> patch ternormalisasi
  // =====================================================================
  /**
   * @param g           sel grayscale
   * @param darkDigits  true = digit gelap di latar terang, false = sebaliknya.
   *                    read() mencoba keduanya lalu memilih yang paling meyakinkan.
   */
  function processCell(g, darkDigits, tAdj = 0) {
    const { w, h, data } = g, n = w * h;
    // Threshold dihitung dari bagian TENGAH sel (jendela roda) saja, supaya
    // pelat/bingkai di sekitar jendela tidak dianggap sebagai kelas tersendiri.
    const inner = [];
    for (let y = Math.round(h * 0.15); y < Math.round(h * 0.85); y++)
      for (let x = Math.round(w * 0.22); x < Math.round(w * 0.78); x++) inner.push(data[y * w + x]);
    // tAdj: geser ambang (dipakai test-time augmentation). Untuk digit gelap, ambang lebih tinggi = goresan lebih tebal.
    const t = Math.max(1, Math.min(254, otsu(inner) + tAdj));
    const v = new Float32Array(n), mask = new Uint8Array(n);
    const tt = darkDigits ? 255 - t : t;
    for (let i = 0; i < n; i++) {
      v[i] = darkDigits ? 255 - data[i] : data[i];
      mask[i] = v[i] > tt ? 1 : 0;
    }

    // Hapus baris bingkai jendela (hampir penuh foreground) agar potongan digit
    // yang menempel ke bingkai tidak ikut terbuang. Catat batas atas/bawah jendela.
    let bandTop = 0, bandBot = h - 1;
    for (let y = 0; y < h; y++) {
      let cnt = 0;
      for (let x = 0; x < w; x++) cnt += mask[y * w + x];
      if (cnt > 0.85 * w) {
        for (let x = 0; x < w; x++) mask[y * w + x] = 0;
        if (y < h * 0.25) bandTop = Math.max(bandTop, y + 1);
        if (y > h * 0.75) bandBot = Math.min(bandBot, y - 1);
      }
    }
    const bandH = bandBot - bandTop + 1;

    const { labels, comps } = components(mask, w, h);
    const minArea = 0.015 * n;
    const kept = comps.filter((c) => {
      const cw = c.x1 - c.x0 + 1;
      if (c.area < minArea) return false;
      if (cw > 0.9 * w) return false;                                   // bingkai horizontal
      if ((c.x0 === 0 || c.x1 === w - 1) && cw < 0.3 * w) return false; // sekat antar roda
      // garis tipis tegak di pinggir (tanda strip di tepi roda); angka "1" tetap aman karena di tengah
      const ch = c.y1 - c.y0 + 1, cx = (c.x0 + c.x1) / 2;
      if (ch > 4 * cw && cw < 0.12 * w && (cx < 0.3 * w || cx > 0.7 * w)) return false;
      // pita pipih mendatar di tepi atas/bawah = bayangan tepi jendela, bukan digit
      const cyc = (c.y0 + c.y1) / 2;
      if (cw > 2.2 * ch && ch < 0.2 * h && (cyc < 0.25 * h || cyc > 0.75 * h)) return false;
      return true;
    });

    const res = { empty: true, rolling: false, darkDigits, patch: null, bbox: null, mask, labels, w, h, chosen: [], geo: -9 };
    if (!kept.length) return res;

    const central = kept.filter((c) => { const cx = (c.x0 + c.x1) / 2; return cx > 0.15 * w && cx < 0.85 * w; });
    const pool = central.length ? central : kept;
    const main = pool.reduce((a, b) => (b.area > a.area ? b : a));
    const overlapX = (a, b) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) + 1;
    const group = kept.filter((c) => c === main ||
      overlapX(c, main) > 0.3 * Math.min(c.x1 - c.x0 + 1, main.x1 - main.x0 + 1));

    // Digit berputar: potongan di atas & bawah, atau digit utama terpotong tepi sel
    const atTop = (c) => c.y0 <= bandTop + 1, atBot = (c) => c.y1 >= bandBot - 1;
    const touchTop = group.some(atTop), touchBot = group.some(atBot);
    const mainH = main.y1 - main.y0 + 1;
    const rolling = (group.length >= 2 && touchTop && touchBot) ||
      ((atTop(main) || atBot(main)) && mainH < 0.75 * bandH) ||
      // dua potongan digit menyatu jadi satu blob setinggi penuh jendela
      (atTop(main) && atBot(main) && mainH > 0.92 * bandH);
    const chosen = rolling && group.length >= 2 ? [main] : group;

    const box = { x0: w, y0: h, x1: -1, y1: -1 };
    for (const c of chosen) {
      box.x0 = Math.min(box.x0, c.x0); box.y0 = Math.min(box.y0, c.y0);
      box.x1 = Math.max(box.x1, c.x1); box.y1 = Math.max(box.y1, c.y1);
    }

    // Normalisasi intensitas: latar -> 0, digit -> 1
    let fgS = 0, fgN = 0, bgS = 0, bgN = 0;
    for (let i = 0; i < n; i++) { if (mask[i]) { fgS += v[i]; fgN++; } else { bgS += v[i]; bgN++; } }
    const lo = bgN ? bgS / bgN : 0, hi = fgN ? fgS / fgN : 255, span = Math.max(1, hi - lo);

    // Hanya piksel milik komponen terpilih (+ dilasi 1px) yang dipakai
    const ids = new Set(chosen.map((c) => c.id));
    const soft = new Float32Array(n);
    for (let y = box.y0; y <= box.y1; y++) {
      for (let x = box.x0; x <= box.x1; x++) {
        let ok = false;
        for (let dy = -1; dy <= 1 && !ok; dy++) for (let dx = -1; dx <= 1 && !ok; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h && ids.has(labels[ny * w + nx])) ok = true;
        }
        if (ok) soft[y * w + x] = Math.max(0, Math.min(1, (v[y * w + x] - lo) / span));
      }
    }

    // Skor geometri: apakah bentuknya masuk akal sebagai digit (bukan latar/jendela)?
    const bw = box.x1 - box.x0 + 1, bhh = box.y1 - box.y0 + 1;
    const fill = chosen.reduce((s, c) => s + c.area, 0) / (bw * bhh);
    let geo = 0;
    if (box.x0 <= 0 || box.x1 >= w - 1) geo -= 1;
    if (bw > 0.8 * w) geo -= 1;
    if (fill > 0.75) geo -= 1;
    if (bhh < 0.3 * bandH) geo -= 1;

    // Rentang vertikal seluruh potongan digit di sel ini (dipakai read() untuk deteksi roda berputar)
    res.span = Math.max(...group.map((c) => c.y1)) - Math.min(...group.map((c) => c.y0)) + 1;
    res.geo = geo;
    res.empty = false;
    res.rolling = rolling;
    res.bbox = box;
    res.chosen = chosen.map((c) => c.id);
    res.patch = fitPatch(soft, w, box);
    return res;
  }

  /** Fit bbox ke patch DWxDH, jaga aspek, supersampling 3x3 */
  function fitPatch(soft, w, b) {
    const bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1;
    const s = Math.min((DW - 2) / bw, (DH - 2) / bh);
    const ox = (DW - bw * s) / 2, oy = (DH - bh * s) / 2;
    const out = new Float32Array(DW * DH);
    const at = (x, y) => (x < b.x0 || y < b.y0 || x > b.x1 || y > b.y1) ? 0 : soft[y * w + x];
    for (let v = 0; v < DH; v++) {
      for (let u = 0; u < DW; u++) {
        let acc = 0;
        for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) {
          const fx = b.x0 + (u + (sx + 0.5) / 3 - ox) / s - 0.5;
          const fy = b.y0 + (v + (sy + 0.5) / 3 - oy) / s - 0.5;
          const x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
          acc += at(x0, y0) * (1 - ax) * (1 - ay) + at(x0 + 1, y0) * ax * (1 - ay) +
                 at(x0, y0 + 1) * (1 - ax) * ay + at(x0 + 1, y0 + 1) * ax * ay;
        }
        out[v * DW + u] = acc / 9;
      }
    }
    out.aspect = bw / bh;
    return out;
  }

  // =====================================================================
  // Fitur
  // =====================================================================
  function l2(arr) {
    let s = 0; for (const x of arr) s += x * x;
    s = Math.sqrt(s) || 1;
    for (let i = 0; i < arr.length; i++) arr[i] /= s;
    return arr;
  }

  function features(p, aspect) {
    // a) piksel 10x16 (rata-rata 2x2)
    const pix = new Float32Array((DW / 2) * (DH / 2));
    for (let y = 0; y < DH / 2; y++) for (let x = 0; x < DW / 2; x++) {
      const i = 2 * y * DW + 2 * x;
      pix[y * (DW / 2) + x] = (p[i] + p[i + 1] + p[i + DW] + p[i + DW + 1]) / 4;
    }
    l2(pix);

    // b) HOG: sel 5x8 piksel (grid 4x4), 9 bin arah 0..180°
    const CX = 5, CY = 8, GX = DW / CX, GY = DH / CY, BINS = 9;
    const hog = new Float32Array(GX * GY * BINS);
    for (let y = 1; y < DH - 1; y++) for (let x = 1; x < DW - 1; x++) {
      const gx = p[y * DW + x + 1] - p[y * DW + x - 1];
      const gy = p[(y + 1) * DW + x] - p[(y - 1) * DW + x];
      const mag = Math.hypot(gx, gy); if (!mag) continue;
      let ang = Math.atan2(gy, gx); if (ang < 0) ang += Math.PI;
      const bin = Math.min(BINS - 1, Math.floor(ang / Math.PI * BINS));
      const cell = Math.min(GY - 1, (y / CY) | 0) * GX + Math.min(GX - 1, (x / CX) | 0);
      hog[cell * BINS + bin] += mag;
    }
    l2(hog);

    const f = new Float32Array(pix.length + hog.length + 1);
    f.set(pix, 0); f.set(hog, pix.length);
    f[f.length - 1] = Math.min(1.5, aspect || 0.6) * 0.5;
    return f;
  }

  // =====================================================================
  // Model k-NN
  // =====================================================================
  function encodePatch(p) {
    let s = '';
    for (let i = 0; i < p.length; i++) s += String.fromCharCode(Math.round(p[i] * 255));
    return btoa(s);
  }
  function decodePatch(b64, aspect) {
    const s = atob(b64), p = new Float32Array(s.length);
    for (let i = 0; i < s.length; i++) p[i] = s.charCodeAt(i) / 255;
    p.aspect = aspect;
    return p;
  }

  function createModel() {
    let synth = [];   // {label, f, patch}
    let user = [];    // {label, f, p (b64), a (aspect), t}
    let cnn = null;   // fungsi opsional patch -> Float32Array(10) probabilitas (lihat js/cnn.js)
    let synthJob = null;   // pembuatan sampel font yang sedang berjalan bertahap (seedSyntheticAsync)
    // Fitur disusun dalam satu Float32Array per kelompok -> jarak k-NN dihitung tanpa objek per sampel
    let synthMat = null, userMat = null;

    function matrix(list) {
      const D = list.length ? list[0].f.length : 0;
      const f = new Float32Array(list.length * D), label = new Uint8Array(list.length);
      list.forEach((s, i) => { f.set(s.f, i * D); label[i] = s.label; });
      return { f, label, n: list.length, D };
    }
    /** Selesaikan sampel font yang belum jadi (dipanggil sebelum prediksi pertama) */
    function ensureSynth() {
      if (!synthJob) return;
      while (!synthJob.next().done);
      synth = synthJob.out; synthJob = null; synthMat = null;
    }
    const synthM = () => { ensureSynth(); return synthMat || (synthMat = matrix(synth)); };
    const userM = () => userMat || (userMat = matrix(user));

    function persist() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(
          { v: 1, dw: DW, dh: DH, samples: user.map((s) => ({ l: s.label, p: s.p, a: s.a, t: s.t })) }));
        return true;
      } catch { return false; }
    }

    function loadFrom(obj) {
      if (!obj || obj.dw !== DW || obj.dh !== DH || !Array.isArray(obj.samples)) throw new Error('Format model tidak cocok');
      user = obj.samples.map((s) => ({ label: s.l, p: s.p, a: s.a, t: s.t || 0,
        f: features(decodePatch(s.p, s.a), s.a) }));
      userMat = null;
    }

    return {
      load() {
        try { const raw = localStorage.getItem(STORAGE_KEY); if (raw) loadFrom(JSON.parse(raw)); } catch { user = []; userMat = null; }
      },
      seedSynthetic(o) { synthJob = null; synth = generateSynthetic(o); synthMat = null; },
      /**
       * Sama dengan seedSynthetic, tetapi dikerjakan sedikit-sedikit di sela UI (tidak membekukan layar
       * saat aplikasi dibuka). Bila prediksi dibutuhkan sebelum selesai, sisanya diselesaikan saat itu juga.
       */
      seedSyntheticAsync(o) {
        synthJob = synthSteps(o);
        const job = synthJob;
        return new Promise((resolve) => {
          const step = () => {
            if (synthJob !== job) return resolve();          // sudah diselesaikan oleh ensureSynth()
            const t0 = performance.now();
            while (performance.now() - t0 < 12) {
              if (job.next().done) { synth = job.out; synthJob = null; synthMat = null; return resolve(); }
            }
            setTimeout(step, 0);
          };
          setTimeout(step, 0);
        });
      },
      /** Pasang/lepas classifier CNN untuk ensemble. fn(patch) -> probabilitas 10 kelas */
      setCNN(fn) { cnn = fn || null; },
      /** @param {{knnOnly?: boolean}} [opts]  knnOnly: abaikan CNN (dipakai saat memilih polaritas) */
      predict(patch, opts = {}) {
        const f = features(patch, patch.aspect);
        const U = userM(), S = synthM(), D = f.length;
        if (!U.n && !S.n) return null;
        // K tetangga terdekat. Urutan: sampel nyata lalu sintetis; jarak sama -> yang lebih dulu menang
        // (identik dengan mengurutkan semua jarak, tetapi tanpa sort ribuan objek per digit).
        const topD = new Float64Array(K).fill(Infinity), topL = new Int8Array(K), topW = new Float64Array(K);
        let cnt = 0;
        // Jarak terdekat ke SETIAP angka 0-9 (bukan hanya K tetangga): dipakai acuan bulan lalu, supaya angka
        // yang benar tetapi tidak masuk K besar tetap punya peluang kecil (bukan nol mutlak).
        const labelD = new Float64Array(10).fill(Infinity);
        const scan = (M, w) => {
          const mf = M.f;
          for (let s = 0, o = 0; s < M.n; s++, o += D) {
            // Jarak dihitung per blok 32 dimensi; berhenti begitu pasti tidak berguna (lebih jauh dari
            // tetangga ke-K DAN dari sampel terdekat angka yang sama)
            const lab = M.label[s];
            const kLim = cnt === K ? topD[K - 1] : Infinity, lim = Math.max(kLim, labelD[lab]);
            let d = 0, i = 0;
            while (i < D && d < lim) {
              const e = Math.min(D, i + 32);
              for (; i < e; i++) { const q = f[i] - mf[o + i]; d += q * q; }
            }
            if (d < labelD[lab]) labelD[lab] = d;
            if (d >= kLim) continue;
            let j = cnt < K ? cnt++ : K - 1;
            while (j > 0 && topD[j - 1] > d) { topD[j] = topD[j - 1]; topL[j] = topL[j - 1]; topW[j] = topW[j - 1]; j--; }
            topD[j] = d; topL[j] = M.label[s]; topW[j] = w;
          }
        };
        scan(U, USER_WEIGHT);
        scan(S, SYNTH_WEIGHT);
        const votes = new Float64Array(10);
        for (let j = 0; j < cnt; j++) votes[topL[j]] += topW[j] / (Math.sqrt(topD[j]) + 0.05);
        const sum = votes.reduce((a, b) => a + b, 0) || 1;
        // Distribusi k-NN, dikalikan penalti bila tetangga terdekat pun jauh (bentuk asing)
        const near = Math.sqrt(topD[0]);
        const penalty = Math.exp(-Math.max(0, near - 0.6) * 1.5);
        const probs = Array.from(votes, (v) => (v / sum) * penalty);

        // Ensemble dengan CNN bila tersedia
        let knnLabel = 0;
        for (let i = 1; i < 10; i++) if (probs[i] > probs[knnLabel]) knnLabel = i;
        let cnnProbs = null;
        if (cnn && !opts.knnOnly) {
          try { cnnProbs = cnn(patch); } catch (err) { console.warn('CNN gagal:', err); }
        }
        if (cnnProbs) for (let i = 0; i < 10; i++) probs[i] = CNN_WEIGHT * cnnProbs[i] + (1 - CNN_WEIGHT) * probs[i];

        let best = 0, second = -1;
        for (let i = 1; i < 10; i++) if (probs[i] > probs[best]) best = i;
        for (let i = 0; i < 10; i++) if (i !== best && (second < 0 || probs[i] > probs[second])) second = i;
        const cnnLabel = cnnProbs ? cnnProbs.indexOf(Math.max(...cnnProbs)) : null;
        let conf = probs[best];
        // CNN dan k-NN tidak sepakat -> jangan percaya diri; biarkan petugas mengecek
        if (cnnProbs && cnnLabel !== knnLabel) conf *= 0.5;
        return { label: best, second, conf: Math.max(0, Math.min(1, conf)), nearest: near, knnLabel, cnnLabel,
          probs, penalty: probs[best] > 0 ? conf / probs[best] : 1, labelDist: Array.from(labelD, Math.sqrt) };
      },
      /** Data latih untuk CNN: sampel nyata (dari petugas) + sampel font bawaan */
      trainingSet() {
        ensureSynth();
        return {
          user: user.map((s) => ({ patch: decodePatch(s.p, s.a), label: s.label })),
          synth: synth.map((s) => ({ patch: s.patch, label: s.label })),
        };
      },
      learn(patch, label) {
        const p = encodePatch(patch);
        user.push({ label, p, a: patch.aspect, t: Date.now(), f: features(patch, patch.aspect) });
        userMat = null;
        const mine = user.filter((s) => s.label === label);
        if (mine.length > MAX_PER_LABEL) {
          const oldest = mine.reduce((a, b) => (b.t < a.t ? b : a));
          user.splice(user.indexOf(oldest), 1);
        }
      },
      save: persist,
      stats() {
        const c = new Array(10).fill(0);
        for (const s of user) c[s.label]++;
        return { perDigit: c, total: user.length, synthetic: synthJob ? '…' : synth.length };
      },
      exportJSON() {
        return JSON.stringify({ v: 1, dw: DW, dh: DH, exported: new Date().toISOString(),
          samples: user.map((s) => ({ l: s.label, p: s.p, a: s.a, t: s.t })) });
      },
      importJSON(str, merge = true) {
        const before = merge ? user.slice() : [];
        loadFrom(JSON.parse(str));
        const seen = new Set(before.map((s) => s.p));
        user = before.concat(user.filter((s) => !seen.has(s.p)));
        userMat = null;
        persist();
      },
      reset() { user = []; userMat = null; persist(); },
    };
  }

  // =====================================================================
  // Sampel sintetis: render digit 0-9 dengan beberapa font sebagai titik awal
  // =====================================================================
  function generateSynthetic(o = {}) {
    const job = synthSteps(o);
    while (!job.next().done);
    return job.out;
  }

  /** Pembuat sampel font bertahap: setiap next() merender satu varian; hasil di job.out */
  function synthSteps(o = {}) {
    const out = [];
    const it = synthIter(o, out);
    it.out = out;
    return it;
  }

  function* synthIter(o, out) {
    const level = o.level || 'basic';  // 'basic' (default, cepat) | 'stroke' | 'rich' — eksperimen: variasi ekstra hanya +≈1 digit, 2-4x lebih lambat
    // Font umum di Android/iOS/desktop + font sempit/teknis yang mirip angka roda meter.
    // Font yang tidak terpasang jatuh ke font bawaan -> patch kembar dibuang di bawah.
    const fonts = ['Arial', 'Helvetica', 'Roboto', 'sans-serif', 'DejaVu Sans', 'Verdana', 'monospace', 'Courier New',
      'Arial Narrow', 'Helvetica Neue', 'DIN Alternate', 'Avenir Next Condensed', 'Noto Sans', 'Tahoma', 'Trebuchet MS'];
    const weights = ['normal', 'bold'];
    const squeeze = [1, 0.75];          // font condensed, umum di roda meter
    const tilts = [-3, 0, 3];           // derajat
    // Variasi kondisi foto: tajam, buram (kaca kotor / fokus meleset), goresan tebal (tinta melebar)
    let styles = [{ blur: 0, stroke: 0 }, { blur: 1.6, stroke: 0 }, { blur: 0, stroke: 3 }];
    if (level === 'basic') { fonts.length = 8; styles = [styles[0]]; }
    if (level === 'stroke') styles = [styles[0], styles[2]];
    const seen = new Set();
    const W = 60, H = 90;
    const c = makeCanvas(W, H), ctx = c.getContext('2d', { willReadFrequently: true });
    for (let d = 0; d <= 9; d++) {
      for (const font of fonts) for (const wt of weights) for (const sq of squeeze) for (const tilt of tilts) for (const st of styles) {
        const inverted = (d + tilt) % 2 === 0;  // variasi polaritas
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.filter = 'none';
        ctx.fillStyle = inverted ? '#111' : '#f4f4f4';
        ctx.fillRect(0, 0, W, H);
        ctx.translate(W / 2, H / 2);
        ctx.rotate(tilt * Math.PI / 180);
        ctx.scale(sq, 1);
        ctx.filter = st.blur ? `blur(${st.blur}px)` : 'none';
        ctx.fillStyle = inverted ? '#eee' : '#141414';
        ctx.strokeStyle = ctx.fillStyle;
        ctx.font = `${wt} 62px "${font}", sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        if (st.stroke) { ctx.lineWidth = st.stroke; ctx.lineJoin = 'round'; ctx.strokeText(String(d), 0, 3); }
        ctx.fillText(String(d), 0, 3);
        const cell = processCell(toGray(ctx.getImageData(0, 0, W, H)), !inverted);
        yield;
        if (cell.empty) continue;
        const key = d + ':' + encodePatch(cell.patch);
        if (seen.has(key)) continue;              // font tidak terpasang -> hasil kembar
        seen.add(key);
        out.push({ label: d, f: features(cell.patch, cell.patch.aspect), patch: cell.patch });
      }
    }
    ctx.filter = 'none';
  }

  // =====================================================================
  // Prior pembacaan: meter hanya bertambah, biasanya sedikit per bulan.
  // Gabungkan probabilitas OCR per digit dengan kisaran wajar dari pembacaan sebelumnya.
  // =====================================================================
  /**
   * @param probs   array per digit: Float/Array(10) probabilitas OCR
   * @param prior   { value: pembacaan sebelumnya (angka), days?: hari sejak itu, maxUsage?: m³ }
   * @returns null bila tidak berlaku, atau { digits: [...], marg: [[10]...], fromPrior: bool, value }
   */
  function decodeWithPrior(probs, prior) {
    const n = probs.length;
    if (!prior || !Number.isFinite(prior.value) || prior.value < 0 || n < 3) return null;
    const MOD = Math.pow(10, n);
    const L = probs.map((p) => Array.from({ length: 10 }, (_, d) => Math.log((p ? p[d] : 0.1) * 0.98 + 0.002)));
    const months = Math.max(1, (prior.days || 30) / 30);
    const lambda = 25 * months;                       // rata-rata pemakaian ±25 m³/bulan (rumah tangga)
    const maxUsage = prior.maxUsage || Math.round(300 * months);
    const hyps = [];
    // Kekuatan acuan SAJA (tanpa OCR) per digit: seberapa pasti nilai digit itu hanya dari kisaran wajar.
    // Digit depan ~1 (pasti sama dgn bulan lalu); digit belakang ~0.1 (semua nilai mungkin).
    const pmarg = Array.from({ length: n }, () => new Array(10).fill(0));
    let pZ = 0;
    for (let u = 0; u <= maxUsage; u++) {
      const N = (Math.round(prior.value) + u) % MOD;   // termasuk meter berputar ulang ke 00000
      const s = String(N).padStart(n, '0');
      let ll = 0;
      for (let i = 0; i < n; i++) ll += L[i][s.charCodeAt(i) - 48];
      // Datar di rentang pemakaian wajar (0 .. 2λ): acuan TIDAK memihak nilai tertentu, hanya
      // membuang angka yang tidak masuk akal. Di atas itu peluang menurun perlahan.
      const flat = 2 * lambda;
      const pu = 0.97 * (u <= flat ? 1 : Math.exp(-(u - flat) / lambda)) / (flat + lambda) + 0.03 / maxUsage;
      hyps.push({ s, score: ll + Math.log(pu) });
      pZ += pu;
      for (let i = 0; i < n; i++) pmarg[i][s.charCodeAt(i) - 48] += pu;
    }
    for (const row of pmarg) for (let d = 0; d < 10; d++) row[d] /= pZ;
    // Hipotesis "di luar kisaran" (meter diganti, salah catat bulan lalu, dll.): pakai OCR apa adanya
    const free = L.map((row) => row.indexOf(Math.max(...row)));
    const freeScore = L.reduce((acc, row, i) => acc + row[free[i]], 0) + Math.log(1e-4);
    hyps.push({ s: free.join(''), score: freeScore, free: true });
    const top = Math.max(...hyps.map((h) => h.score));
    const marg = Array.from({ length: n }, () => new Array(10).fill(0));
    let Z = 0;
    for (const h of hyps) {
      const w = Math.exp(h.score - top);
      Z += w;
      for (let i = 0; i < n; i++) marg[i][h.s.charCodeAt(i) - 48] += w;
    }
    for (const row of marg) for (let d = 0; d < 10; d++) row[d] /= Z;
    const best = hyps.reduce((a, b) => (b.score > a.score ? b : a));
    return { digits: best.s.split('').map(Number), marg, pmarg, fromPrior: !best.free, value: Number(best.s) };
  }

  /**
   * Peluang untuk acuan bulan lalu: distribusi k-NN + sedikit massa untuk angka yang bentuknya MIRIP
   * (sampel terdekatnya hampir sedekat tetangga terbaik), meski tidak masuk K tetangga.
   * Tanpa ini angka yang benar bisa berpeluang nol mutlak dan acuan tidak pernah bisa membetulkannya.
   */
  function softenForPrior(probs, dist) {
    if (!probs || !dist) return probs;
    const tau = SOFT_TAU, eps = SOFT_EPS;
    const dmin = Math.min(...dist.filter(Number.isFinite));
    const soft = dist.map((d) => (Number.isFinite(d) ? Math.exp(-(d - dmin) / tau) : 0));
    const ss = soft.reduce((a, b) => a + b, 0) || 1, sp = probs.reduce((a, b) => a + b, 0);
    const out = probs.map((v, i) => v + eps * sp * soft[i] / ss);
    const so = out.reduce((a, b) => a + b, 0) || 1;
    return out.map((v) => v * sp / so);
  }

  const PRIOR_MAX_CHANGES = 2;   // acuan boleh mengubah paling banyak 2 digit hasil OCR

  /**
   * Terapkan acuan bulan lalu ke hasil read() (mengubah `digits` di tempat).
   * Aman: hanya bila hasil terbaik ADA dalam kisaran wajar & mengubah <= 2 digit.
   * Selain itu hasil OCR dibiarkan apa adanya (pemeriksaan anomali di aplikasi yang menangani).
   * Digit yang diubah acuan selalu tetap ditandai ragu (conf <= 0.79).
   * @returns info penerapan, atau null bila tidak diterapkan
   */
  function applyPrior(digits, prior) {
    if (!prior || !digits.length || !digits.every((d) => d.probs)) return null;
    const pd = decodeWithPrior(digits.map((d) => d.priorProbs || d.probs), prior);
    if (!pd || !pd.fromPrior) return null;
    const changes = digits.filter((d, i) => d.label !== pd.digits[i]).length;
    if (changes > PRIOR_MAX_CHANGES) return null;
    const ocrText = digits.map((d) => (d.label === null ? '?' : d.label)).join('');
    digits.forEach((d, i) => {
      const ocrConf = d.conf;
      d.ocrLabel = d.label;
      d.label = pd.digits[i];
      d.priorChanged = d.ocrLabel !== d.label;
      // Naikkan keyakinan HANYA sebesar acuan benar-benar membatasi digit ini. Tanpa ini, digit belakang
      // (yang tidak dibatasi acuan) ikut "digelembungkan" oleh normalisasi -> salah tapi yakin.
      const strength = pd.pmarg[i][d.label];
      let c = d.priorChanged ? pd.marg[i][d.label] : ocrConf + (pd.marg[i][d.label] - ocrConf) * strength;
      if (d.rolling) c = Math.min(c, 0.5);
      if (d.priorChanged) c = Math.min(c, 0.79);
      d.conf = Math.max(0, Math.min(1, c));
    });
    return { value: pd.value, changes, ocrText };
  }

  // =====================================================================
  // API utama
  // =====================================================================
  /**
   * @param {HTMLCanvasElement} source  gambar kerja (sudah dirotasi)
   * @param {{x,y,w,h}} rect            area jendela angka di koordinat source
   * @param {number} nDigits            jumlah roda angka di dalam rect
   * @param model                       hasil createModel()
   * @param {{channel?: 'luma'|'red', tta?: boolean, prior?: {value:number, days?:number}}} [opts]
   *   channel 'red' untuk roda desimal merah; tta (default true) = baca tiap digit dengan beberapa ambang;
   *   prior = pembacaan sebelumnya untuk membantu digit yang ragu (hanya untuk digit m³).
   */
  function read(source, rect, nDigits, model, opts = {}) {
    const scale = ROI_H / rect.h;
    const rw = Math.max(nDigits * 8, Math.round(rect.w * scale));
    const rc = makeCanvas(rw, ROI_H), rctx = rc.getContext('2d', { willReadFrequently: true });
    rctx.imageSmoothingQuality = 'high';
    rctx.drawImage(source, rect.x, rect.y, rect.w, rect.h, 0, 0, rw, ROI_H);
    const imgData = rctx.getImageData(0, 0, rw, ROI_H);
    let gray = toGray(imgData, opts.channel);
    // Kanal merah lemah (foto bersemburat biru/kuning, tinta merah pudar) -> pakai kecerahan biasa
    if (opts.channel === 'red') {
      const v = Array.from(gray.data).sort((a, b) => a - b);
      const spread = v[Math.floor(v.length * 0.98)] - v[Math.floor(v.length * 0.02)];
      if (spread < 60) gray = toGray(imgData, 'luma');
    }
    const roi = stretch(gray);

    const debug = makeCanvas(rw, ROI_H), dctx = debug.getContext('2d');
    const dimg = dctx.createImageData(rw, ROI_H);
    const digits = [];
    const cellW = rw / nDigits;

    for (let i = 0; i < nDigits; i++) {
      const x0 = Math.round(i * cellW), x1 = Math.round((i + 1) * cellW);
      // Coba kedua polaritas (digit gelap / digit terang), pilih yang paling meyakinkan
      const sub = subImage(roi, x0, 0, x1 - x0, ROI_H);
      // Polaritas dipilih dengan k-NN + geometri saja: CNN tidak pernah melihat patch "bukan digit"
      // sehingga bisa terlalu yakin pada patch latar/jendela.
      let cell = null, bestScore = -Infinity;
      for (const dark of [true, false]) {
        const c = processCell(sub, dark);
        if (c.empty) { if (!cell) cell = c; continue; }
        const p = model.predict(c.patch, { knnOnly: true });
        const score = (p ? p.conf : 0) + 0.35 * c.geo;
        if (score > bestScore) { bestScore = score; cell = c; }
      }
      let pred = cell.empty ? null : model.predict(cell.patch);
      // Test-time augmentation: baca ulang dengan ambang lebih rendah & lebih tinggi, rata-ratakan probabilitas.
      // Mengurangi salah baca akibat goresan putus/menebal karena silau, bayangan, atau kaca kotor.
      if (pred && opts.tta !== false) {
        const acc = pred.probs.slice();
        let m = 1;
        for (const adj of [-14, 14]) {
          const v = processCell(sub, cell.darkDigits, adj);
          if (v.empty || v.rolling !== cell.rolling) continue;
          const p = model.predict(v.patch);
          if (!p) continue;
          for (let d = 0; d < 10; d++) acc[d] += p.probs[d];
          m++;
        }
        if (m > 1) {
          for (let d = 0; d < 10; d++) acc[d] /= m;
          let best = 0, second = -1;
          for (let d = 1; d < 10; d++) if (acc[d] > acc[best]) best = d;
          for (let d = 0; d < 10; d++) if (d !== best && (second < 0 || acc[d] > acc[second])) second = d;
          pred = { ...pred, label: best, second, probs: acc, conf: Math.max(0, Math.min(1, acc[best] * pred.penalty)) };
        }
      }

      // visualisasi biner
      const ids = new Set(cell.chosen);
      for (let y = 0; y < cell.h; y++) for (let x = 0; x < cell.w; x++) {
        const k = y * cell.w + x, j = (y * rw + x0 + x) * 4;
        const on = cell.mask[k], sel = ids.has(cell.labels[k]);
        const val = on ? (sel ? 255 : 90) : 0;
        dimg.data[j] = val; dimg.data[j + 1] = val; dimg.data[j + 2] = val; dimg.data[j + 3] = 255;
      }

      const conf = pred ? (cell.rolling ? pred.conf * 0.5 : pred.conf) : 0;
      digits.push({
        index: i,
        label: pred ? pred.label : null,
        second: pred ? pred.second : null,
        conf,
        rolling: cell.rolling,
        empty: cell.empty,
        patch: cell.patch,
        cellX: x0, cellW: x1 - x0,
        bbox: cell.bbox,
        rawConf: pred ? pred.conf : 0,
        span: cell.span || 0,
        probs: pred ? pred.probs : null,
        priorProbs: pred ? softenForPrior(pred.probs, pred.labelDist) : null,
      });
    }

    // Roda berputar: tinta di sel ini membentang jauh lebih tinggi dari digit lain di deret yang sama
    // (potongan bawah digit lama + potongan atas digit baru).
    const hs = digits.filter((d) => d.bbox && !d.rolling).map((d) => d.bbox.y1 - d.bbox.y0 + 1).sort((a, b) => a - b);
    if (hs.length >= 2) {
      const med = hs[hs.length >> 1];
      for (const d of digits) if (!d.rolling && d.span > 1.4 * med) { d.rolling = true; d.conf = d.rawConf * 0.5; }
    }

    dctx.putImageData(dimg, 0, 0);
    for (const d of digits) {
      dctx.strokeStyle = 'rgba(80,160,255,.9)';
      dctx.strokeRect(d.cellX + 0.5, 0.5, d.cellW - 1, ROI_H - 1);
      if (d.bbox) {
        dctx.strokeStyle = d.rolling ? '#f59e0b' : d.conf >= 0.8 ? '#22c55e' : '#ef4444';
        dctx.strokeRect(d.cellX + d.bbox.x0 + 0.5, d.bbox.y0 + 0.5, d.bbox.x1 - d.bbox.x0, d.bbox.y1 - d.bbox.y0);
      }
    }

    // Acuan pembacaan sebelumnya (hanya digit m³ hitam)
    const priorUsed = opts.prior && opts.channel !== 'red' ? applyPrior(digits, opts.prior) : null;

    const text = digits.map((d) => (d.label === null ? '?' : String(d.label))).join('');
    const minConf = digits.reduce((m, d) => Math.min(m, d.conf), 1);
    return { digits, text, minConf, debugCanvas: debug, prior: priorUsed };
  }

  /** Render patch digit ke canvas (untuk ditampilkan) */
  function patchToCanvas(p, zoom = 2) {
    const c = makeCanvas(DW * zoom, DH * zoom), ctx = c.getContext('2d');
    const img = ctx.createImageData(DW, DH);
    for (let i = 0; i < DW * DH; i++) {
      const v = p ? Math.round(p[i] * 255) : 40;
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
    }
    const tmp = makeCanvas(DW, DH); tmp.getContext('2d').putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, DW * zoom, DH * zoom);
    return c;
  }

  global.MeterOCR = { createModel, read, patchToCanvas, decodeWithPrior, applyPrior, DW, DH, util: { components, otsu, toGray } };
})(window);

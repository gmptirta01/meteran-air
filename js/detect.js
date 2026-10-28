/**
 * MeterDetect — deteksi otomatis jendela angka meter air (tanpa library).
 *
 * Ide: roda angka meter = deretan blob berbentuk digit yang SEJAJAR, BERJARAK SAMA,
 * dan BERUKURAN MIRIP. Pola keteraturan ini jarang muncul pada kotoran, tekstur, atau label.
 *
 * Langkah:
 *   1. Perkecil foto, buat mask "tinta" (piksel lebih gelap dari rata-rata lokal).
 *   2. Connected components -> saring blob yang bentuknya mirip digit.
 *   3. Cari rantai terbaik (mirip RANSAC): setiap pasangan blob bertetangga menjadi
 *      vektor jarak (pitch); hitung berapa blob lain jatuh di posisi a + k·pitch.
 *      Dicoba pada orientasi 0° dan 90° sehingga foto tegak/menyamping sama-sama terdeteksi.
 *   4. Sudut kemiringan diambil dari arah rantai (regresi linier pusat blob).
 *   5. Sel berwarna merah = digit desimal, dan pada meter ini selalu di ujung kanan.
 *      Jadi bila merah ada di kiri, foto terbalik (putar 180°). Jumlah digit hitam = sel sebelum merah.
 *   6. Ulangi pada foto yang sudah diluruskan untuk mendapatkan kotak ROI yang presisi.
 */
(function (global) {
  'use strict';

  const WORK_LONG = 1200;   // sisi terpanjang untuk analisis

  // ---------------------------------------------------------------------------
  function rotateCanvas(src, deg) {
    const rad = deg * Math.PI / 180, w = src.width, h = src.height;
    const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
    const W = Math.round(w * cos + h * sin), H = Math.round(w * sin + h * cos);
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(W / 2, H / 2); ctx.rotate(rad);
    ctx.drawImage(src, -w / 2, -h / 2);
    return c;
  }

  /** Skala ke ukuran kerja: foto besar diperkecil ke `long`; foto kecil (<1000 px) diperbesar (maks 3x) */
  /** Titik p pada kanvas w×h -> kanvas hasil rotateCanvas(..., deg) */
  function mapRot(p, w, h, deg) {
    const rad = deg * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
    const W = Math.round(w * Math.abs(cos) + h * Math.abs(sin)), H = Math.round(w * Math.abs(sin) + h * Math.abs(cos));
    const x = p.x - w / 2, y = p.y - h / 2;
    return { x: cos * x - sin * y + W / 2, y: sin * x + cos * y + H / 2 };
  }
  /** Kebalikan mapRot: titik pada kanvas hasil rotasi -> kanvas asal w×h */
  function unmapRot(p, w, h, deg) {
    const rad = deg * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
    const W = Math.round(w * Math.abs(cos) + h * Math.abs(sin)), H = Math.round(w * Math.abs(sin) + h * Math.abs(cos));
    const x = p.x - W / 2, y = p.y - H / 2;
    return { x: cos * x + sin * y + w / 2, y: -sin * x + cos * y + h / 2 };
  }

  function downscale(src, long) {
    const m = Math.max(src.width, src.height);
    const s = m < 1000 ? Math.min(3, 1000 / m) : Math.min(1, long / m);
    const c = document.createElement('canvas');
    c.width = Math.round(src.width * s); c.height = Math.round(src.height * s);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, c.width, c.height);
    return { canvas: c, scale: s };
  }

  // ---------------------------------------------------------------------------
  // 1-2. Mask tinta + kandidat blob digit
  // ---------------------------------------------------------------------------
  /**
   * Piksel, luma, dan integral image sebuah kanvas — dihitung SEKALI lalu dipakai bersama oleh
   * analisis tinta gelap & terang (bagian termahal setelah pelabelan komponen).
   */
  const prepCache = new WeakMap();
  function prepare(canvas, box = null) {
    let p = box ? null : prepCache.get(canvas);
    if (p) return p;
    const bx = box ? box.x : 0, by = box ? box.y : 0;
    const W = box ? box.w : canvas.width, H = box ? box.h : canvas.height, n = W * H;
    const img = canvas.getContext('2d', { willReadFrequently: true }).getImageData(bx, by, W, H).data;
    const L = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) L[i] = 0.299 * img[j] + 0.587 * img[j + 1] + 0.114 * img[j + 2];
    // integral image untuk rata-rata lokal
    const W1 = W + 1, integ = new Float64Array(W1 * (H + 1));
    for (let y = 0; y < H; y++) {
      let row = 0;
      const o = (y + 1) * W1 + 1, u = y * W1 + 1, l = y * W;
      for (let x = 0; x < W; x++) { row += L[l + x]; integ[o + x] = integ[u + x] + row; }
    }
    p = { W, H, img, L, integ };
    if (!box) prepCache.set(canvas, p);
    return p;
  }

  /** Mask tinta: piksel jauh lebih gelap/terang daripada rata-rata lokal (jendela persegi 2r+1) */
  /** @param long  sisi terpanjang kanvas PENUH (ukuran jendela & batas blob tetap sama walau menganalisis potongan) */
  const meanRadius = (long) => Math.max(8, Math.round(long / 40));
  /**
   * Tinta "lembut": ambang lebih rendah + closing 3x3. Untuk angka tipis & kontras rendah (Linflow, foto
   * gelap/buram) yang pada ambang normal pecah jadi potongan kecil. Hanya menambah KANDIDAT rantai;
   * penilaian jendela meter (rateChain) yang memilih.
   */
  const SOFT = { k: 0.06, min: 5, penalty: 0.85, rScale: 1, close: true };
  // Varian kedua: jendela rata-rata lokal lebih kecil -> bingkai jendela yang tebal & gelap tidak ikut
  // menurunkan rata-rata di sekitar angka (jendela sempit Linflow, foto buram)
  const SOFT2 = { k: 0.1, min: 5, rScale: 0.5, close: true };
  function inkMask(p, pol, long = Math.max(p.W, p.H)) {
    const { W, H, L, integ } = p, W1 = W + 1;
    const soft = pol === 'soft' || pol === 'soft2', cfg = pol === 'soft2' ? SOFT2 : SOFT;
    const r = soft ? Math.max(4, Math.round(meanRadius(long) * cfg.rScale)) : meanRadius(long);
    const mask = new Uint8Array(W * H), dark = pol !== 'bright';
    const kf = soft ? cfg.k : 0.14, kmin = soft ? cfg.min : 12;
    for (let y = 0; y < H; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1), a = y0 * W1, b = y1 * W1;
      for (let x = 0; x < W; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1);
        const s = integ[b + x1] - integ[a + x1] - integ[b + x0] + integ[a + x0];
        const mean = s / ((x1 - x0) * (y1 - y0));
        const thr = Math.max(kmin, kf * mean), v = L[y * W + x];
        if (dark ? v < mean - thr : v > mean + thr) mask[y * W + x] = 1;
      }
    }
    return soft && cfg.close ? close3(mask, W, H) : mask;
  }

  /** Closing morfologi 3x3 (dilasi lalu erosi): menyambung goresan yang putus 1-2 piksel tanpa menebalkan */
  function close3(m, W, H) {
    const n = W * H, t = new Uint8Array(n), u = new Uint8Array(n);
    // horizontal lalu vertikal (terpisah); tepi gambar memakai nilai piksel itu sendiri
    const vpass = (src, dst, grow) => {
      for (let x = 0; x < W; x++) dst[x] = grow ? src[x] | src[x + W] : src[x] & src[x + W];
      for (let i = W, e = n - W; i < e; i++) dst[i] = grow ? src[i - W] | src[i] | src[i + W] : src[i - W] & src[i] & src[i + W];
      for (let i = n - W; i < n; i++) dst[i] = grow ? src[i - W] | src[i] : src[i - W] & src[i];
    };
    hpass(m, t, true); vpass(t, u, true);      // dilasi
    hpass(u, t, false); vpass(t, u, false);    // erosi
    return u;

    function hpass(src, dst, grow) {
      for (let y = 0, o = 0; y < H; y++, o += W) {
        if (W === 1) { dst[o] = src[o]; continue; }
        dst[o] = grow ? src[o] | src[o + 1] : src[o] & src[o + 1];
        for (let i = o + 1, e = o + W - 1; i < e; i++) dst[i] = grow ? src[i - 1] | src[i] | src[i + 1] : src[i - 1] & src[i] & src[i + 1];
        dst[o + W - 1] = grow ? src[o + W - 2] | src[o + W - 1] : src[o + W - 2] & src[o + W - 1];
      }
    }
  }

  /** Komponen terhubung (8-tetangga) — hanya kotak pembatas & luas; array bertipe tanpa alokasi per piksel */
  function maskComps(mask, W, H) {
    const seen = new Uint8Array(W * H), stack = new Int32Array(W * H), comps = [];
    for (let i = 0; i < W * H; i++) {
      if (!mask[i] || seen[i]) continue;
      let sp = 0, area = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
      seen[i] = 1; stack[sp++] = i;
      while (sp) {
        const q = stack[--sp], y = (q / W) | 0, x = q - y * W;
        area++;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        const yA = y > 0 ? y - 1 : 0, yB = y < H - 1 ? y + 1 : y, xA = x > 0 ? x - 1 : 0, xB = x < W - 1 ? x + 1 : x;
        for (let ny = yA; ny <= yB; ny++) {
          for (let nx = xA, k = ny * W + xA; nx <= xB; nx++, k++) if (mask[k] && !seen[k]) { seen[k] = 1; stack[sp++] = k; }
        }
      }
      comps.push({ x0, y0, x1, y1, area });
    }
    return comps;
  }

  /** Komponen yang berbentuk digit (tinggi wajar, ramping, kepadatan tinta sedang) */
  function digitBlobs(comps, long) {
    const minH = Math.max(8, long * 0.01), maxH = long * 0.2;
    const blobs = [];
    for (const c of comps) {
      const w = c.x1 - c.x0 + 1, h = c.y1 - c.y0 + 1;
      if (h < minH || h > maxH) continue;
      const ar = w / h, fill = c.area / (w * h);
      if (ar < 0.1 || ar > 1.0 || fill < 0.12 || fill > 0.85) continue;
      blobs.push({ x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, w, h, cx: (c.x0 + c.x1) / 2, cy: (c.y0 + c.y1) / 2 });
    }
    return blobs;
  }

  /** @param {'dark'|'bright'} pol  tinta lebih gelap (umum) atau lebih terang dari sekitarnya */
  function analyze(canvas, pol = 'dark', box = null) {
    const p = prepare(canvas, box), { W, H } = p, long = Math.max(canvas.width, canvas.height);
    const mask = inkMask(p, pol, long);
    const comps = maskComps(mask, W, H);
    return { W, H, img: p.img, L: p.L, mask, ix: (x, y) => y * W + x, comps, blobs: digitBlobs(comps, long) };
  }

  /**
   * Analisis untuk kanvas yang diputar 90° (= rotateCanvas(canvas, 90)) TANPA menghitung ulang:
   * putaran 90° tepat memetakan piksel (x, y) -> (H-1-y, x), dan mask (jendela persegi) serta
   * komponen 8-tetangga tidak berubah oleh putaran itu — cukup dipindahkan posisinya.
   * Array piksel tidak disalin: ix(x, y) menunjuk ke piksel asalnya.
   */
  function rotate90(an) {
    const { W, H } = an, W2 = H, H2 = W;
    const comps = an.comps
      .map((c) => ({ x0: H - 1 - c.y1, x1: H - 1 - c.y0, y0: c.x0, y1: c.x1, area: c.area }))
      .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    return { W: W2, H: H2, img: an.img, L: an.L, mask: an.mask, ix: (x, y) => (W2 - 1 - x) * H2 + y,
      comps, blobs: digitBlobs(comps, Math.max(W2, H2)) };
  }

  // ---------------------------------------------------------------------------
  // 3. Rantai blob berjarak sama (horizontal ± 20°)
  // ---------------------------------------------------------------------------
  function findChain(blobs) {
    return findChains(blobs, 1)[0] || null;
  }

  /** Blob yang jatuh pada slot o + k·v (|k| <= 12), satu blob terdekat per slot, rangkaian terpanjang */
  const PARTIAL = { min: 0.55, halve: true };   // roda bergulir: potongan digit >= 55% tinggi digit
  /** @param partial terima juga potongan digit (roda bergulir) — hanya untuk rantai berjarak 2x (halvePitch) */
  function gather(blobs, ox, oy, vx, vy, hRef, partial = false) {
    const len = Math.hypot(vx, vy), v2 = len * len, slots = new Map();
    for (const c of blobs) {
      const ratio = Math.max(c.h, hRef) / Math.min(c.h, hRef);
      // Roda yang sedang bergulir (mis. 4599 -> 4600) hanya menampilkan sebagian angka -> blob lebih pendek
      // dan pusatnya bergeser ke atas/bawah. Tanpa ini deretan "putus" dan terpilih rantai berjarak 2x lipat.
      const part = partial && ratio > 1.35 && c.h < hRef && c.h >= PARTIAL.min * hRef;
      if (ratio > 1.35 && !part) continue;
      const dx = c.cx - ox, dy = c.cy - oy;
      const k = Math.round((dx * vx + dy * vy) / v2);
      if (Math.abs(k) > 12) continue;
      const res = Math.hypot(dx - k * vx, dy - k * vy);
      if (res > 0.22 * len + (part ? (hRef - c.h) / 2 : 0)) continue;
      const prev = slots.get(k);
      if (!prev || res < prev.res) slots.set(k, { k, blob: c, res });
    }
    return trimGaps([...slots.values()].sort((p, q) => p.k - q.k));
  }

  /**
   * Rantai TERPILIH yang ternyata berjarak 2x lipat (melompati setiap digit kedua) -> rantai jarak setengah.
   * Terjadi bila roda di tengah sedang bergulir (mis. 4599 -> 4600): digitnya terpotong & lebih pendek,
   * sehingga deretan berjarak normal "putus". Tandanya: hampir setiap celah antar-anggota berurutan berisi
   * blob digit (utuh/terpotong) tepat di tengahnya. Bila tidak, rantai dikembalikan apa adanya.
   */
  function halvePitch(blobs, chain) {
    const ms = chain.members, h = chain.digitH, len = Math.hypot(chain.v.x, chain.v.y);
    let gaps = 0, filled = 0;
    for (let i = 1; i < ms.length; i++) {
      if (ms[i].k - ms[i - 1].k !== 1) continue;
      gaps++;
      const a = ms[i - 1].blob, b = ms[i].blob, mx = (a.cx + b.cx) / 2, my = (a.cy + b.cy) / 2;
      if (blobs.some((c) => c !== a && c !== b && Math.abs(c.cx - mx) < 0.15 * len && Math.abs(c.cy - my) < 0.5 * h &&
        c.h >= PARTIAL.min * h && c.h <= 1.35 * h)) filled++;
    }
    if (gaps < 2 || filled < 0.75 * gaps) return chain;
    const a = ms[0].blob;
    const half = gather(blobs, a.cx, a.cy, chain.v.x / 2, chain.v.y / 2, h, true);
    if (half.length < 1.5 * ms.length) return chain;
    const r = refine({ members: half, score: chain.score, resMean: chain.resMean });
    r.halved = true;
    return r;
  }

  /** Kandidat rantai terbaik (berbeda anggota), diurutkan skor dasar */
  function findChains(blobs, maxN = 6) {
    const all = [];
    const nb = blobs.length;
    for (let i = 0; i < nb; i++) {
      const a = blobs[i];
      for (let j = 0; j < nb; j++) {
        if (i === j) continue;
        const b = blobs[j];
        const vx = b.cx - a.cx, vy = b.cy - a.cy;
        if (vx <= 0) continue;
        const hAvg = (a.h + b.h) / 2;
        if (Math.max(a.h, b.h) / Math.min(a.h, b.h) > 1.3) continue;
        const len = Math.hypot(vx, vy);
        if (len < 0.6 * hAvg || len > 2.2 * hAvg || Math.abs(vy) > 0.36 * vx) continue;

        // hitung anggota
        const members = gather(blobs, a.cx, a.cy, vx, vy, hAvg), L = len, H = hAvg;
        if (members.length < 4) continue;
        const resMean = members.reduce((s, m) => s + m.res, 0) / members.length / L;
        // Angka roda meter = deretan digit TERBESAR; nomor seri/label lebih kecil
        const score = members.length * H * (1 - resMean);
        all.push({ score, members, a, vx, vy, len: L, hAvg: H, resMean });
      }
    }
    all.sort((p, q) => q.score - p.score);
    const picked = [];
    for (const c of all) {
      const ids = new Set(c.members.map((m) => m.blob));
      // lewati kandidat yang sebagian besar anggotanya sama dengan kandidat yang sudah dipilih
      if (picked.some((p) => p.members.filter((m) => ids.has(m.blob)).length > 0.5 * Math.min(ids.size, p.members.length))) continue;
      picked.push(c);
      if (picked.length >= maxN) break;
    }
    return picked.map(refine);
  }

  /** Ambil rangkaian slot terpanjang dengan celah maksimal 1 slot kosong */
  function trimGaps(sorted) {
    let bestRun = [], run = [];
    for (const m of sorted) {
      if (run.length && m.k - run[run.length - 1].k > 2) { if (run.length > bestRun.length) bestRun = run; run = []; }
      run.push(m);
    }
    if (run.length > bestRun.length) bestRun = run;
    return bestRun;
  }

  /** Regresi linier: pusat = p0 + k·v */
  function refine(c) {
    const ms = c.members, n = ms.length;
    let sk = 0, sx = 0, sy = 0, skk = 0, skx = 0, sky = 0;
    for (const m of ms) {
      sk += m.k; sx += m.blob.cx; sy += m.blob.cy;
      skk += m.k * m.k; skx += m.k * m.blob.cx; sky += m.k * m.blob.cy;
    }
    const den = n * skk - sk * sk || 1;
    const vx = (n * skx - sk * sx) / den, vy = (n * sky - sk * sy) / den;
    const p0x = (sx - vx * sk) / n, p0y = (sy - vy * sk) / n;
    const hs = ms.map((m) => m.blob.h).sort((a, b) => a - b);
    return {
      p0: { x: p0x, y: p0y }, v: { x: vx, y: vy },
      kMin: ms[0].k, kMax: ms[n - 1].k,
      digitH: hs[hs.length >> 1], members: ms, score: c.score, resMean: c.resMean || 0,
    };
  }

  // ---------------------------------------------------------------------------
  // 5. Statistik tiap slot: tinta, warna merah, kontras
  // ---------------------------------------------------------------------------
  function slotStat(an, chain, k) {
    const { W, H, img, mask, ix } = an;
    const len = Math.hypot(chain.v.x, chain.v.y);
    const cx = chain.p0.x + k * chain.v.x, cy = chain.p0.y + k * chain.v.y;
    const hw = 0.35 * len, hh = 0.6 * chain.digitH;
    let n = 0, ink = 0, red = 0, inkL = 0, bgL = 0, bgN = 0, inkRG = 0;
    for (let y = Math.max(0, Math.round(cy - hh)); y <= Math.min(H - 1, Math.round(cy + hh)); y++) {
      for (let x = Math.max(0, Math.round(cx - hw)); x <= Math.min(W - 1, Math.round(cx + hw)); x++) {
        const i = ix(x, y), R = img[i * 4], G = img[i * 4 + 1], B = img[i * 4 + 2];
        const L = 0.299 * R + 0.587 * G + 0.114 * B;
        n++;
        if (R - Math.max(G, B) > 30) red++;
        if (mask[i]) { ink++; inkL += L; inkRG += (R - G) / (L + 1); } else { bgL += L; bgN++; }
      }
    }
    const contrast = bgN && ink ? Math.abs(bgL / bgN - inkL / ink) : 0;
    // Sel hitam praktis 0% piksel merah; sel merah (walau tertutup silau) >= 2%
    return { k, cx, cy, ink: n ? ink / n : 0, redFrac: n ? red / n : 0, red: n > 0 && red / n > 0.008, contrast,
      inkRG: ink ? inkRG / ink : 0 };
  }

  /** Ada blob berbentuk digit di slot ini? (atau potongan digit roda berputar) */
  function slotHasDigit(an, chain, s, partial = false) {
    const pitch = Math.hypot(chain.v.x, chain.v.y), h = chain.digitH;
    return an.blobs.some((b) => Math.abs(b.cx - s.cx) < 0.32 * pitch &&
      (partial
        ? Math.abs(b.cy - s.cy) < 0.7 * h && b.h >= 0.3 * h && b.h <= 1.35 * h          // potongan roda berputar
        : Math.abs(b.cy - s.cy) < 0.25 * h && b.h >= 0.8 * h && b.h <= 1.25 * h));      // digit utuh, sejajar
  }

  /**
   * Bukti "bingkai jendela": garis tepi lurus sejajar deretan angka, di atas DAN di bawahnya.
   * Jendela roda meter selalu punya tepi seperti ini; tulisan/nomor seri/angka cetak tidak.
   * @returns 0..1
   */
  function frameScore(an, chain, slots) {
    const { W, H, L, ix } = an;
    const len = Math.hypot(chain.v.x, chain.v.y), ux = chain.v.x / len, uy = chain.v.y / len;
    const nx = -uy, ny = ux, h = chain.digitH;
    const a = slots[0], b = slots[slots.length - 1];
    const sx = a.cx - ux * len / 2, sy = a.cy - uy * len / 2;
    const span = Math.hypot(b.cx - a.cx, b.cy - a.cy) + len;
    const at = (x, y) => { const xi = Math.round(x), yi = Math.round(y); return xi < 0 || yi < 0 || xi >= W || yi >= H ? 0 : L[ix(xi, yi)]; };
    const side = (sign) => {
      let best = 0;
      for (let t = Math.round(0.45 * h); t <= Math.round(1.5 * h); t++) {
        let hit = 0, n = 0;
        for (let u = 0; u < span; u += 1) {
          const x = sx + ux * u + sign * nx * t, y = sy + uy * u + sign * ny * t;
          const g = Math.abs(at(x + nx, y + ny) - at(x - nx, y - ny));
          n++; if (g > 18) hit++;
        }
        if (n) best = Math.max(best, hit / n);
      }
      return best;
    };
    return (side(-1) + side(1)) / 2;
  }

  /** Pertahankan hanya deretan merah yang menyentuh ujung kanan (atau kiri, foto terbalik) */
  function keepRedAtEnds(slots) {
    const n = slots.length;
    let r = n; while (r > 0 && slots[r - 1].red) r--;          // ekor merah di kanan: indeks r..n-1
    let l = 0; while (l < n && slots[l].red) l++;              // ekor merah di kiri: 0..l-1
    for (let i = 0; i < n; i++) if (slots[i].red && i >= l && i < r) { slots[i].red = false; slots[i].redStray = true; }
  }

  const RED_TAIL = 1.8;
  /** Semua slot merah berkumpul di salah satu ujung deretan (kanan, atau kiri bila foto terbalik) */
  function redAtEnd(slots) {
    const flags = slots.map((s) => !!s.red), n = flags.length;
    const first = flags.indexOf(true), last = flags.lastIndexOf(true);
    const contiguous = flags.slice(first, last + 1).every(Boolean);
    return contiguous && (last === n - 1 || first === 0);
  }

  /** Nilai seberapa mirip kandidat rantai dengan jendela angka meter */
  function rateChain(an, chain, pol) {
    const slots = buildSlots(an, chain);
    const n = slots.length;
    const nRed = slots.filter((s) => s.red).length;
    const frame = frameScore(an, chain, slots);
    let score = Math.min(n, 8) * chain.digitH * (1 - (chain.resMean || 0));
    score *= Math.pow(0.25 + frame, 2);      // bingkai jendela (bukti terkuat; lihat foto Itron: angka cetak besar tanpa bingkai)
    if (nRed) score *= 1.4;                  // roda desimal merah
    // Pola khas jendela meter air: >= 3 roda hitam lalu >= 2 roda merah di UJUNG deretan.
    // Barcode / nomor seri / tulisan tidak pernah berpola begini (foto Linflow: barcode berbingkai kuat).
    const redTail = nRed >= 2 && n - nRed >= 3 && redAtEnd(slots);
    if (redTail) score *= RED_TAIL;
    if (pol === 'bright') score *= 0.8;      // angka gelap di latar terang paling umum
    if (pol === 'soft' || pol === 'soft2') score *= SOFT.penalty;   // ambang normal diutamakan bila sama-sama menemukan rantai
    if (n > 8) score *= 0.35;                // > 8 roda (mis. 5 hitam + 3 merah) = nomor seri / tulisan
    return { score, slots, frame, n, nRed, redTail };
  }

  /**
   * Merah RELATIF: foto dengan semburat warna (white balance biru/kuning) membuat tinta merah tidak lagi
   * "merah" secara absolut. Bandingkan kemerahan tinta (R-G)/L tiap slot dengan median slot lain;
   * slot di UJUNG deretan yang jauh lebih kemerahan = roda desimal merah.
   */
  function markRelativeRed(slots) {
    if (slots.length < 4 || slots.some((s) => s.red)) return;   // merah absolut sudah terdeteksi
    const vals = slots.map((s) => s.inkRG).sort((a, b) => a - b);
    const base = vals[Math.floor(vals.length / 2)];
    const isRed = (s) => s.ink >= 0.05 && s.inkRG - base > 0.1;
    let k = slots.length - 1;
    while (k > 0 && isRed(slots[k]) && slots.length - k <= 4) { slots[k].red = true; slots[k].relRed = true; k--; }
    if (!slots.some((s) => s.red)) {           // foto terbalik: roda merah di ujung kiri
      let j = 0;
      while (j < slots.length - 1 && isRed(slots[j]) && j < 4) { slots[j].red = true; slots[j].relRed = true; j++; }
    }
  }

  /** Buang slot ujung yang bukan digit (noda), tambah slot ujung yang terlewat (mis. roda berputar) */
  function buildSlots(an, chain) {
    let slots = [];
    for (let k = chain.kMin; k <= chain.kMax; k++) slots.push(slotStat(an, chain, k));
    const median = () => { const c = slots.map((s) => s.contrast).sort((a, b) => a - b); return c[c.length >> 1]; };
    let med = median();
    // Roda merah berkontras rendah (tinta merah pudar) bukan "lemah" selama masih bertinta
    const weak = (s) => (s.contrast < 0.5 * med || s.ink < 0.06) && !(s.red && s.ink >= 0.05);
    while (slots.length > 3 && weak(slots[0])) slots.shift();
    while (slots.length > 3 && weak(slots[slots.length - 1])) slots.pop();
    med = median();
    const good = (s) => s.contrast >= 0.6 * med && s.ink >= 0.1 && slotHasDigit(an, chain, s);
    // Deretan yang sudah berekor roda merah = pasti jendela meter: di sisi seberangnya cukup POTONGAN digit
    // (angka tipis yang pecah, mis. "3" Linflow), tanpa membuka lagi masalah huruf "H-B" di meter lain.
    const redR = slots.length >= 4 && slots[slots.length - 1].red, redL = slots.length >= 4 && slots[0].red;
    const goodTail = (s) => !s.red && s.contrast >= 0.6 * med && s.ink >= 0.1 && slotHasDigit(an, chain, s, true);
    for (let i = 0; i < 2; i++) { const s = slotStat(an, chain, slots[0].k - 1); if (good(s) || (redR && goodTail(s))) slots.unshift(s); else break; }
    for (let i = 0; i < 2; i++) { const s = slotStat(an, chain, slots[slots.length - 1].k + 1); if (good(s) || (redL && goodTail(s))) slots.push(s); else break; }
    markRelativeRed(slots);
    // Roda desimal merah di ujung kanan: tinta merah kontras-terangnya rendah, jadi aturan kontras
    // di atas sering menolaknya. Selama slot berikutnya masih berisi tinta merah, terima (maks. 4 roda).
    if (slots[slots.length - 1].red) {
      for (let i = 0; i < 4; i++) {
        const s = slotStat(an, chain, slots[slots.length - 1].k + 1);
        if (s.red && s.ink >= 0.05 && (slotHasDigit(an, chain, s, true) || s.redFrac > 0.03)) slots.push(s); else break;
      }
    }
    // Roda desimal merah selalu berkumpul di UJUNG deretan. Slot "merah" yang terjepit di antara roda hitam
    // (goresan karat / noda oranye di kaca) bukan roda desimal -> anggap hitam.
    keepRedAtEnds(slots);
    return slots;
  }

  // ---------------------------------------------------------------------------
  // API utama
  // ---------------------------------------------------------------------------
  /**
   * @param {HTMLCanvasElement} src  foto asli
   * @param {object} [opt]
   *   opt.scoreFn(workCanvas, rect, n) -> skor keyakinan; dipakai memilih 0° vs 180° bila tidak ada digit merah
   * @returns {null | {angle, rect, nDigits, redRect, nRed, debug}}
   *   rect / redRect dalam koordinat rotateCanvas(src, angle)
   */
  function detect(src, opt = {}) {
    const small = downscale(src, WORK_LONG);

    // Orientasi kasar 0°/90° x polaritas tinta gelap/terang; setiap pass menghasilkan beberapa kandidat
    // rantai yang dinilai dengan ciri jendela meter (bingkai, jumlah digit wajar, roda merah, polaritas).
    const cands = [];
    const addPass = (pols) => {
      const an0 = Object.fromEntries(pols.map((pol) => [pol, analyze(small.canvas, pol)]));
      for (const base of [0, 90]) {
        for (const pol of pols) {
          const an = base ? rotate90(an0[pol]) : an0[pol];   // 90°: hasil analisis 0° dipindahkan, bukan dihitung ulang
          for (const chain of findChains(an.blobs, 6)) {
            const r = rateChain(an, chain, pol);
            cands.push({ base, pol, an, chain, rating: r.score, frame: r.frame, n: r.n, redTail: r.redTail });
          }
        }
      }
    };
    addPass(['dark', 'bright']);
    // Pass tinta lembut (mahal) hanya bila pass normal belum menemukan jendela yang meyakinkan:
    // kandidat terbaik berpola hitam + ekor merah dengan bingkai jelas = pasti jendela meter.
    const bestN = cands.reduce((a, c) => (!a || c.rating > a.rating ? c : a), null);
    if (!(bestN && bestN.redTail && bestN.frame >= 0.4)) addPass(['soft', 'soft2']);
    // Pass tinta lembut hanya CADANGAN, bukan pesaing:
    //  - wajib ada bukti bingkai jendela (ambang rendah gampang membentuk rantai dari noda/tekstur);
    //  - bila pass normal punya rantai cukup kuat di posisi yang sama, pakai yang normal (potongannya lebih presisi).
    const isSoft = (c) => c.pol === 'soft' || c.pol === 'soft2';
    const center = (c) => { const m = (c.chain.kMin + c.chain.kMax) / 2; return { x: c.chain.p0.x + m * c.chain.v.x, y: c.chain.p0.y + m * c.chain.v.y }; };
    for (let i = cands.length - 1; i >= 0; i--) {
      const c = cands[i];
      if (!isSoft(c)) continue;
      const p = center(c);
      const normalHere = cands.some((o) => !isSoft(o) && o.base === c.base && o.rating >= 0.5 * c.rating &&
        Math.hypot(center(o).x - p.x, center(o).y - p.y) < 1.5 * Math.max(o.chain.digitH, c.chain.digitH));
      if (c.frame < 0.3 || normalHere) cands.splice(i, 1);
    }
    if (!cands.length) return null;
    cands.sort((a, b) => b.rating - a.rating);
    const tr = opt.trace;   // diagnostik (devtest): kandidat teratas & alasan gagal
    if (tr) tr.cands = cands.slice(0, 6).map((c) => ({ base: c.base, pol: c.pol, n: c.n, rating: Math.round(c.rating), frame: +c.frame.toFixed(2),
      at: (() => { const m = (c.chain.kMin + c.chain.kMax) / 2, q = { x: c.chain.p0.x + m * c.chain.v.x, y: c.chain.p0.y + m * c.chain.v.y };
        const o = c.base ? unmapRot(q, small.canvas.width, small.canvas.height, c.base) : q; return [Math.round(o.x / small.scale), Math.round(o.y / small.scale)]; })() }));
    let pass = cands[0];
    // Rantai "sel roda" (kotak jendela) membungkus rantai angka di posisi yang sama.
    // Bila ada rantai lebih kecil yang bertumpuk, itulah angkanya.
    for (const c of cands.slice(1)) {
      if (c.base !== pass.base || c.rating < 0.5 * pass.rating) continue;
      const a = pass.chain, b = c.chain;
      const pa = Math.hypot(a.v.x, a.v.y), pb = Math.hypot(b.v.x, b.v.y);
      const ka = Math.round(((b.p0.x - a.p0.x) * a.v.x + (b.p0.y - a.p0.y) * a.v.y) / (pa * pa));
      const off = Math.hypot(b.p0.x - a.p0.x - ka * a.v.x, b.p0.y - a.p0.y - ka * a.v.y);
      if (Math.abs(pa - pb) < 0.15 * pa && off < 0.3 * pa && b.digitH < 0.85 * a.digitH && b.digitH > 0.3 * a.digitH) { pass = c; break; }
    }
    if (PARTIAL.halve) {
      const hc = halvePitch(pass.an.blobs, pass.chain);
      if (hc !== pass.chain) pass = { ...pass, chain: hc };
    }
    // Pusat rantai terpilih dalam koordinat foto asli -> dilacak lagi setelah foto diluruskan
    const pc = { x: pass.chain.p0.x + ((pass.chain.kMin + pass.chain.kMax) / 2) * pass.chain.v.x,
                 y: pass.chain.p0.y + ((pass.chain.kMin + pass.chain.kMax) / 2) * pass.chain.v.y };
    const ps = pass.base ? unmapRot(pc, small.canvas.width, small.canvas.height, pass.base) : pc;
    const target = { x: ps.x / small.scale, y: ps.y / small.scale, h: pass.chain.digitH / small.scale };

    const phi = Math.atan2(pass.chain.v.y, pass.chain.v.x) * 180 / Math.PI;
    let angle = pass.base - phi;
    const colors = buildSlots(pass.an, pass.chain);
    const redIdx = colors.map((c, i) => (c.red ? i : -1)).filter((i) => i >= 0);
    let orientationKnown = false;
    if (redIdx.length) {
      const mid = (colors.length - 1) / 2;
      const redMean = redIdx.reduce((s, i) => s + i, 0) / redIdx.length;
      if (redMean < mid) angle += 180;   // merah di kiri -> foto terbalik
      orientationKnown = true;
    }

    if (tr) tr.pass = { pol: pass.pol, base: pass.base, angle, colors: colors.map((c) => (c.red ? 'R' : 'B')).join('') };
    // Cadangan: bila deteksi ulang pada foto yang sudah diluruskan gagal (goresan tipis pecah lagi pada
    // skala lain), pakai posisi slot dari langkah pertama yang dipetakan ke foto lurus.
    const fin = (a, t) => finalize(src, a, pass.pol, target, t) || fromPass(src, a, pass, colors, small);
    let res = fin(angle, tr);
    if (res && !orientationKnown && opt.scoreFn) {
      // Tanpa petunjuk warna: bandingkan keyakinan baca 0° vs 180°
      const alt = fin(angle + 180);
      if (alt) {
        const s1 = opt.scoreFn(rotateCanvas(src, res.angle), res.rect, res.nDigits);
        const s2 = opt.scoreFn(rotateCanvas(src, alt.angle), alt.rect, alt.nDigits);
        if (s2 > s1) res = alt;
      }
    }
    return res;
  }

  /** Hasil langsung dari rantai langkah pertama (tanpa deteksi ulang), dalam koordinat rotateCanvas(src, angle) */
  function fromPass(src, angle, pass, colors, small) {
    angle = ((angle + 540) % 360) - 180;
    const toWork = (q) => {
      const o = pass.base ? unmapRot(q, small.canvas.width, small.canvas.height, pass.base) : q;
      return mapRot({ x: o.x / small.scale, y: o.y / small.scale }, src.width, src.height, angle);
    };
    const slots = colors.map((c) => ({ ...toWork({ x: c.cx, y: c.cy }), red: c.red })).sort((a, b) => a.x - b.x);
    const firstRed = slots.findIndex((c) => c.red);
    const black = firstRed >= 0 ? slots.slice(0, firstRed) : slots;
    const red = [];
    if (firstRed >= 0) for (let i = firstRed; i < slots.length && slots[i].red; i++) red.push(slots[i]);
    if (black.length < 3) return null;
    const pitch = Math.hypot(pass.chain.v.x, pass.chain.v.y) / small.scale, h = pass.chain.digitH / small.scale;
    const boxOf = (sl) => {
      const a = sl[0], b = sl[sl.length - 1], cy = (a.y + b.y) / 2, hh = h * 0.66;
      return { x: a.x - pitch / 2, y: cy - hh, w: b.x - a.x + pitch, h: 2 * hh };
    };
    return {
      angle: Math.round(angle * 10) / 10,
      rect: boxOf(black), nDigits: black.length,
      redRect: red.length ? boxOf(red) : null, nRed: red.length,
      debug: { chain: pass.chain, slots: slots, blobs: pass.an.blobs, scale: small.scale, fromPass: true },
    };
  }

  /** 6. Luruskan foto, deteksi ulang, dan hitung ROI presisi pada resolusi penuh */
  function finalize(src, angle, pol, target, tr) {
    angle = ((angle + 540) % 360) - 180;
    const work = rotateCanvas(src, angle);
    const small = downscale(work, WORK_LONG);
    const cw = small.canvas.width, ch = small.canvas.height;
    let t = null;
    if (target) {
      const m = mapRot(target, src.width, src.height, angle);
      t = { x: m.x * small.scale, y: m.y * small.scale, h: target.h * small.scale };
    }
    // Pilih rantai yang posisinya sama dengan rantai terpilih sebelum diluruskan
    const near = (chains, ox, oy) => {
      let chain = null, bestD = Infinity;
      for (const c of chains) {
        const mid = (c.kMin + c.kMax) / 2;
        const d = Math.hypot(c.p0.x + mid * c.v.x + ox - t.x, c.p0.y + mid * c.v.y + oy - t.y);
        if (d < 2.5 * t.h && Math.abs(c.digitH - t.h) < 0.5 * t.h && d < bestD) { bestD = d; chain = c; }
      }
      return chain;
    };
    let an = null, chain = null, off = { x: 0, y: 0 };
    if (t) {
      // Cukup analisis potongan di sekitar jendela angka. Margin >= jari-jari rata-rata lokal, sehingga
      // mask di area deretan angka (± 12 slot, bingkai ±1,5 tinggi digit) identik dengan analisis penuh.
      const r = meanRadius(Math.max(cw, ch));
      const x0 = Math.max(0, Math.floor(t.x - 30 * t.h - r)), x1 = Math.min(cw, Math.ceil(t.x + 30 * t.h + r));
      const y0 = Math.max(0, Math.floor(t.y - 3 * t.h - r)), y1 = Math.min(ch, Math.ceil(t.y + 3 * t.h + r));
      const box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      if (box.w * box.h < 0.8 * cw * ch) {
        const a = analyze(small.canvas, pol, box);
        const c = near(findChains(a.blobs, 8), x0, y0);
        if (c) { an = a; chain = c; off = { x: x0, y: y0 }; }
      }
    }
    if (!an) {
      an = analyze(small.canvas, pol);
      const chains = findChains(an.blobs, 8);
      if (!chains.length) { if (tr) (tr.final = tr.final || []).push({ angle, pol, noChains: true }); return null; }
      if (t) chain = near(chains, 0, 0);
      if (!chain) chain = chains.map((c) => ({ c, r: rateChain(an, c, pol).score })).sort((a, b) => b.r - a.r)[0].c;
    }
    if (PARTIAL.halve) chain = halvePitch(an.blobs, chain);   // rantai berjarak 2x (roda bergulir) -> jarak setengah
    const colors = buildSlots(an, chain);

    // Slot hitam = sebelum slot merah pertama; slot setelah merah diabaikan
    const firstRed = colors.findIndex((c) => c.red);
    const black = firstRed >= 0 ? colors.slice(0, firstRed) : colors;
    const red = [];
    if (firstRed >= 0) for (let i = firstRed; i < colors.length && colors[i].red; i++) red.push(colors[i]);
    if (tr) (tr.final = tr.final || []).push({ angle, pol, cropUsed: off.x > 0 || off.y > 0, slots: colors.map((c) => (c.red ? 'R' : 'B')).join(''),
      chainN: chain.members.length, h: Math.round(chain.digitH / small.scale) });
    if (black.length < 3) return null;

    const s = 1 / small.scale;
    const pitch = Math.hypot(chain.v.x, chain.v.y);
    const boxOf = (slots) => {
      const a = slots[0], b = slots[slots.length - 1];
      const x0 = a.cx - pitch / 2, x1 = b.cx + pitch / 2;
      const cy = (a.cy + b.cy) / 2, hh = chain.digitH * 0.66;
      return { x: (x0 + off.x) * s, y: (cy - hh + off.y) * s, w: (x1 - x0) * s, h: 2 * hh * s };
    };
    return {
      angle: Math.round(angle * 10) / 10,
      rect: boxOf(black), nDigits: black.length,
      redRect: red.length ? boxOf(red) : null, nRed: red.length,
      debug: { chain, slots: colors, blobs: an.blobs, scale: small.scale },
    };
  }

  global.MeterDetect = { detect, rotateCanvas, _analyze: analyze, _findChain: findChain, _findChains: findChains,
    _rateChain: rateChain, _downscale: downscale, _soft: SOFT, _soft2: SOFT2, _partial: PARTIAL };
})(window);

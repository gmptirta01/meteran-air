/**
 * MeterCNN — classifier digit CNN kecil dengan TensorFlow.js, dilatih DI BROWSER.
 *
 * Data latih = data yang sama dengan k-NN (js/ocr.js):
 *   - sampel font bawaan (sintetis), dan
 *   - patch digit nyata yang sudah dikonfirmasi/dikoreksi petugas (diperbanyak/oversampling).
 * Setiap epoch dibangkitkan ulang dengan AUGMENTASI acak (geser, putar, skala, tebal-tipis
 * goresan, blur, noise, dan "silau" yang menutup sebagian digit) supaya CNN tahan kondisi lapangan.
 *
 * Input  : patch 32x20 (tinggi x lebar), nilai 0..1 (digit terang di latar gelap)
 * Output : probabilitas 10 kelas (0-9)
 *
 * Model disimpan di IndexedDB perangkat dan bisa diekspor/impor (meter-cnn.json + .bin).
 * Bila TensorFlow.js tidak termuat (mis. offline pertama kali), aplikasi tetap berjalan dengan k-NN.
 */
(function (global) {
  'use strict';

  const DW = 20, DH = 32;
  const KEY = 'indexeddb://meter-cnn';
  const META_KEY = 'meterCnnMeta.v1';

  let net = null;
  let meta = null;

  const available = () => typeof global.tf !== 'undefined';

  // TF.js (1,4 MB) dimuat SAAT DIBUTUHKAN saja (CNN dipakai/dilatih/diimpor) agar aplikasi cepat dibuka.
  // Lokasi file: window.TFJS_SRC (lokal 'vendor/tf.min.js', atau CDN pada build Apps Script).
  let libPromise = null, libFailed = false;
  function loadLib() {
    if (available()) return Promise.resolve(true);
    if (libPromise) return libPromise;
    libPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = global.TFJS_SRC || 'vendor/tf.min.js';
      s.async = true;
      s.onload = () => { libFailed = false; tf.ready().then(() => resolve(true), reject); };
      s.onerror = () => { libFailed = true; libPromise = null; s.remove(); reject(new Error('TensorFlow.js gagal dimuat (offline?).')); };
      document.head.appendChild(s);
    });
    return libPromise;
  }
  /** Ada CNN tersimpan di perangkat ini? (dicek tanpa memuat TF.js) */
  const hasSaved = () => { try { return !!localStorage.getItem(META_KEY); } catch { return false; } };

  // ---------------------------------------------------------------------------
  // Arsitektur (±60 ribu parameter, ±250 KB)
  // ---------------------------------------------------------------------------
  function build() {
    const m = tf.sequential();
    m.add(tf.layers.conv2d({ inputShape: [DH, DW, 1], filters: 16, kernelSize: 3, padding: 'same', activation: 'relu' }));
    m.add(tf.layers.batchNormalization());
    m.add(tf.layers.maxPooling2d({ poolSize: 2 }));                       // 16x10
    m.add(tf.layers.conv2d({ filters: 32, kernelSize: 3, padding: 'same', activation: 'relu' }));
    m.add(tf.layers.batchNormalization());
    m.add(tf.layers.maxPooling2d({ poolSize: 2 }));                       // 8x5
    m.add(tf.layers.conv2d({ filters: 48, kernelSize: 3, padding: 'same', activation: 'relu' }));
    m.add(tf.layers.batchNormalization());
    m.add(tf.layers.flatten());
    m.add(tf.layers.dropout({ rate: 0.4 }));
    m.add(tf.layers.dense({ units: 32, activation: 'relu' }));
    m.add(tf.layers.dropout({ rate: 0.3 }));
    m.add(tf.layers.dense({ units: 10, activation: 'softmax' }));
    m.compile({ optimizer: tf.train.adam(0.002), loss: 'categoricalCrossentropy', metrics: ['accuracy'] });
    return m;
  }

  // ---------------------------------------------------------------------------
  // Augmentasi (JS murni, pada patch Float32Array DW*DH)
  // ---------------------------------------------------------------------------
  const rand = (a, b) => a + Math.random() * (b - a);
  function gauss() { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

  function augment(p) {
    // 1. Transformasi affine (putar, skala x/y, geser, shear) dengan pemetaan balik + bilinear
    const ang = rand(-7, 7) * Math.PI / 180, sx = rand(0.85, 1.12), sy = rand(0.88, 1.1);
    const sh = rand(-0.15, 0.15), tx = rand(-1.6, 1.6), ty = rand(-1.8, 1.8);
    const cos = Math.cos(ang), sin = Math.sin(ang), cx = DW / 2, cy = DH / 2;
    const at = (x, y) => (x < 0 || y < 0 || x >= DW || y >= DH) ? 0 : p[y * DW + x];
    let out = new Float32Array(DW * DH);
    for (let v = 0; v < DH; v++) for (let u = 0; u < DW; u++) {
      let x = u - cx - tx, y = v - cy - ty;
      const rx = (cos * x + sin * y) / sx, ry = (-sin * x + cos * y) / sy;
      const fx = rx - sh * ry + cx, fy = ry + cy;
      const x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
      out[v * DW + u] = at(x0, y0) * (1 - ax) * (1 - ay) + at(x0 + 1, y0) * ax * (1 - ay) +
        at(x0, y0 + 1) * (1 - ax) * ay + at(x0 + 1, y0 + 1) * ax * ay;
    }
    // 2. Tebal/tipis goresan: dilasi atau erosi ringan (max/min 3x3)
    const r = Math.random();
    if (r < 0.2 || r > 0.8) {
      const dil = r < 0.2, src = out, o2 = new Float32Array(DW * DH);
      const get = (x, y) => (x < 0 || y < 0 || x >= DW || y >= DH) ? 0 : src[y * DW + x];
      for (let y = 0; y < DH; y++) for (let x = 0; x < DW; x++) {
        let m = dil ? 0 : 1;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (Math.abs(dx) + Math.abs(dy) > 1) continue;   // tetangga silang (4 arah)
          const q = get(x + dx, y + dy);
          m = dil ? Math.max(m, q) : Math.min(m, q);
        }
        o2[y * DW + x] = dil ? m : 0.5 * m + 0.5 * out[y * DW + x];
      }
      out = o2;
    }
    // 3. Blur ringan
    if (Math.random() < 0.3) {
      const o3 = new Float32Array(DW * DH);
      for (let y = 0; y < DH; y++) for (let x = 0; x < DW; x++) {
        let s = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < DW && yy < DH) { s += out[yy * DW + xx]; n++; }
        }
        o3[y * DW + x] = s / n;
      }
      out = o3;
    }
    // 4. Kontras, gamma, noise
    const c = rand(0.65, 1.05), g = rand(0.7, 1.4), nz = rand(0, 0.08);
    for (let i = 0; i < out.length; i++) {
      out[i] = Math.max(0, Math.min(1, Math.pow(Math.max(0, out[i]), g) * c + gauss() * nz));
    }
    // 5. "Silau": hapus sebagian digit (kotak acak) — meniru pantulan yang menutup angka
    if (Math.random() < 0.2) {
      const w = Math.round(rand(4, 10)), h = Math.round(rand(4, 12));
      const x0 = Math.round(rand(0, DW - w)), y0 = Math.round(rand(0, DH - h));
      for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) out[y * DW + x] = 0;
    }
    return out;
  }

  function toTensor(patches) {
    const buf = new Float32Array(patches.length * DW * DH);
    patches.forEach((p, i) => buf.set(p, i * DW * DH));
    return tf.tensor4d(buf, [patches.length, DH, DW, 1]);
  }

  // ---------------------------------------------------------------------------
  // Pelatihan
  // ---------------------------------------------------------------------------
  /**
   * @param {{user: {patch,label}[], synth: {patch,label}[]}} data  dari model.trainingSet()
   * @param {{epochs?: number, onProgress?: (info) => void}} opt
   */
  async function train(data, opt = {}) {
    if (!available()) throw new Error('TensorFlow.js tidak termuat (periksa koneksi internet).');
    const epochs = opt.epochs || 25;
    const user = data.user || [], synth = data.synth || [];
    if (!user.length && !synth.length) throw new Error('Belum ada data latih.');

    // Sampel nyata disisihkan 15% untuk validasi (bila cukup banyak)
    const shuffled = user.slice().sort(() => Math.random() - 0.5);
    const nVal = user.length >= 30 ? Math.round(user.length * 0.15) : 0;
    const val = shuffled.slice(0, nVal), trainUser = shuffled.slice(nVal);

    // Oversampling: sampel nyata kira-kira separuh isi tiap epoch
    const rep = trainUser.length ? Math.max(1, Math.min(15, Math.round(synth.length / trainUser.length))) : 0;
    const base = synth.concat(...Array.from({ length: rep }, () => trainUser));

    const fresh = build();
    let lastLogs = {};
    for (let ep = 0; ep < epochs; ep++) {
      const items = base.map((s) => ({ p: augment(s.patch), l: s.label }));
      const xs = toTensor(items.map((s) => s.p));
      const ys = tf.oneHot(tf.tensor1d(items.map((s) => s.l), 'int32'), 10);
      // yieldEvery 'never': bawaan TF.js menunggu requestAnimationFrame, yang berhenti total
      // saat tab tersembunyi / layar HP mati -> pelatihan macet. Jeda UI ditangani di bawah.
      const h = await fresh.fit(xs, ys, { epochs: 1, batchSize: 64, shuffle: true, verbose: 0, yieldEvery: 'never' });
      xs.dispose(); ys.dispose();
      lastLogs = { loss: h.history.loss[0], acc: h.history.acc ? h.history.acc[0] : h.history.accuracy[0] };
      if (opt.onProgress) opt.onProgress({ epoch: ep + 1, epochs, ...lastLogs });
      // beri jeda ke UI; setTimeout (bukan requestAnimationFrame) agar tidak macet saat tab tersembunyi
      await new Promise((r) => setTimeout(r, 0));
    }

    // Evaluasi pada data bersih (tanpa augmentasi)
    const evalSet = val.length ? val : trainUser.length ? trainUser : synth;
    const acc = accuracy(fresh, evalSet);

    if (net) net.dispose();
    net = fresh;
    meta = {
      trainedAt: new Date().toISOString(), nUser: user.length, nSynth: synth.length, epochs,
      acc, accOn: val.length ? 'validasi (sampel nyata disisihkan)' : trainUser.length ? 'sampel nyata (data latih)' : 'sampel font',
    };
    await net.save(KEY);
    try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch {}
    return meta;
  }

  function accuracy(model, set) {
    if (!set.length) return null;
    return tf.tidy(() => {
      const pred = model.predict(toTensor(set.map((s) => s.patch))).argMax(-1).dataSync();
      let ok = 0;
      set.forEach((s, i) => { if (pred[i] === s.label) ok++; });
      return ok / set.length;
    });
  }

  // ---------------------------------------------------------------------------
  // Prediksi, simpan, muat, ekspor/impor
  // ---------------------------------------------------------------------------
  function predict(patch) {
    if (!net) return null;
    return tf.tidy(() => net.predict(toTensor([patch])).dataSync());
  }

  async function load() {
    if (!available()) return false;
    try {
      net = await tf.loadLayersModel(KEY);
      try { meta = JSON.parse(localStorage.getItem(META_KEY) || 'null'); } catch { meta = null; }
      tf.tidy(() => net.predict(tf.zeros([1, DH, DW, 1])));   // pemanasan (kompilasi shader)
      return true;
    } catch { net = null; return false; }
  }

  async function exportModel() {
    if (!net) throw new Error('CNN belum dilatih.');
    await net.save('downloads://meter-cnn');
  }

  /** @param {FileList|File[]} files  meter-cnn.json + meter-cnn.weights.bin */
  async function importModel(files) {
    if (!available()) throw new Error('TensorFlow.js tidak termuat.');
    const arr = Array.from(files);
    const json = arr.find((f) => f.name.endsWith('.json'));
    const bins = arr.filter((f) => f.name.endsWith('.bin'));
    if (!json || !bins.length) throw new Error('Pilih file .json DAN .bin sekaligus.');
    const m = await tf.loadLayersModel(tf.io.browserFiles([json, ...bins]));
    if (net) net.dispose();
    net = m;
    meta = { trainedAt: new Date().toISOString(), imported: json.name };
    await net.save(KEY);
    try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch {}
  }

  async function reset() {
    if (!available()) { try { await loadLib(); } catch {} }
    if (net) { net.dispose(); net = null; }
    meta = null;
    try { localStorage.removeItem(META_KEY); } catch {}
    try { if (available()) await tf.io.removeModel(KEY); } catch {}
  }

  global.MeterCNN = {
    available, loadLib, hasSaved, libFailed: () => libFailed,
    train, predict, load, exportModel, importModel, reset, augment,
    ready: () => !!net, meta: () => meta, backend: () => (available() ? tf.getBackend() : null),
  };
})(window);

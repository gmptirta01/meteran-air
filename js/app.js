(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const MAX_SIDE = 1600;
  const CONF_OK = 0.8;

  // ---------- Penyimpanan lokal ----------
  const store = {
    get(k, d = '') { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  // Server & sesi login ditangani js/auth.js (MeterAuth): google.script.run bila dibuka dari URL Apps Script,
  // fetch ke URL Web App bila di-hosting di luar (PWA).
  const serverReady = () => MeterAuth.GAS || !!store.get('cfgUrl');
  const me = () => MeterAuth.user();

  // ---------- Model OCR ----------
  const model = MeterOCR.createModel();
  model.load();
  // Contoh font bawaan dibuat sedikit-sedikit di sela UI (tidak membekukan layar saat aplikasi dibuka);
  // bila petugas sudah memotret sebelum selesai, sisanya diselesaikan otomatis saat membaca.
  model.seedSyntheticAsync();

  // =====================================================================
  // CNN (TensorFlow.js) — opsional, digabung dengan k-NN
  // =====================================================================
  // CNN yang hanya dilatih dari font bawaan terbukti salah dengan PERCAYA DIRI pada foto asli,
  // jadi CNN baru dipakai bila dilatih dengan cukup sampel nyata (atau diimpor dari HP lain).
  const CNN_MIN_REAL = 30;
  function cnnTrustworthy() {
    const m = window.MeterCNN && MeterCNN.meta();
    return !!m && (!!m.imported || (m.nUser || 0) >= CNN_MIN_REAL);
  }
  function applyCnn() {
    const use = $('cnnUse').checked && window.MeterCNN && MeterCNN.ready() && cnnTrustworthy();
    model.setCNN(use ? MeterCNN.predict : null);
  }
  function renderCnnStatus() {
    const el = $('cnnStatus');
    if (!window.MeterCNN) { el.innerHTML = '⚠️ Modul CNN tidak tersedia.'; return; }
    if (!MeterCNN.available()) {
      el.innerHTML = MeterCNN.libFailed()
        ? '⚠️ TensorFlow.js gagal dimuat (offline?). Pembacaan memakai k-NN saja.'
        : '💤 TensorFlow.js belum dimuat (agar aplikasi cepat dibuka). Dimuat otomatis saat CNN dilatih, diimpor, atau dipakai.';
      return;
    }
    const m = MeterCNN.meta();
    if (!MeterCNN.ready()) { el.innerHTML = `Belum dilatih. Backend: <b>${esc(MeterCNN.backend())}</b>`; return; }
    const total = model.stats().total;
    const fresh = m && m.nUser !== undefined ? total - m.nUser : 0;
    if (!cnnTrustworthy()) {
      el.innerHTML = `⏸️ CNN dilatih dengan ${m ? m.nUser : 0} sampel nyata — belum dipakai. ` +
        `Butuh ≥${CNN_MIN_REAL} sampel nyata (saat ini ${model.stats().total}); lalu latih ulang.`;
      return;
    }
    el.innerHTML = `✅ CNN aktif · dilatih ${m ? new Date(m.trainedAt).toLocaleString('id-ID') : '-'}` +
      (m && m.acc != null ? ` · akurasi ${Math.round(m.acc * 100)}% (${esc(m.accOn)})` : '') +
      (m && m.nUser !== undefined ? ` · ${m.nUser} sampel nyata` : '') +
      (fresh > 0 ? `<br>🔄 Ada <b>${fresh}</b> sampel baru sejak pelatihan terakhir — latih ulang.` : '');
  }
  // TF.js hanya dimuat bila memang ada CNN tersimpan & dipakai -> buka aplikasi tetap cepat
  async function initCnn() {
    $('cnnUse').checked = store.get('cnnUse', '1') === '1';
    if (window.MeterCNN && $('cnnUse').checked && MeterCNN.hasSaved() && !MeterCNN.ready()) {
      try { await MeterCNN.loadLib(); await MeterCNN.load(); } catch (err) { console.warn(err); }
    }
    applyCnn(); renderCnnStatus();
  }
  async function needTf() {
    try { await MeterCNN.loadLib(); return true; }
    catch (err) { msg('cnnMsg', err.message, 'err'); renderCnnStatus(); return false; }
  }
  $('cnnUse').onchange = () => { store.set('cnnUse', $('cnnUse').checked ? '1' : '0'); initCnn(); };
  $('btnTrainCnn').onclick = async () => {
    const btn = $('btnTrainCnn'), prog = $('cnnProgress');
    const nReal = model.stats().total;
    if (nReal < CNN_MIN_REAL && !confirm(`Baru ${nReal} sampel nyata. CNN baru dipakai setelah dilatih dengan ≥${CNN_MIN_REAL} sampel nyata. Tetap latih sekarang?`)) return;
    btn.disabled = true;
    msg('cnnMsg', 'Memuat TensorFlow.js…');
    if (!(await needTf())) { btn.disabled = false; return; }
    prog.classList.remove('hidden'); prog.value = 0;
    msg('cnnMsg', 'Melatih… (layar boleh tetap terbuka)');
    const t0 = performance.now();
    try {
      const m = await MeterCNN.train(model.trainingSet(), {
        epochs: 25,
        onProgress: (p) => {
          prog.value = p.epoch / p.epochs;
          msg('cnnMsg', `Epoch ${p.epoch}/${p.epochs} · loss ${p.loss.toFixed(3)} · akurasi latih ${Math.round(p.acc * 100)}%`);
        },
      });
      applyCnn();
      msg('cnnMsg', `Selesai dalam ${Math.round((performance.now() - t0) / 1000)} detik.` +
        (m.acc != null ? ` Akurasi ${Math.round(m.acc * 100)}% pada ${m.accOn}.` : ''), 'ok');
    } catch (err) {
      msg('cnnMsg', 'Gagal melatih: ' + err.message, 'err');
    }
    btn.disabled = false; prog.classList.add('hidden'); renderCnnStatus();
  };
  $('btnExportCnn').onclick = async () => {
    try { await MeterCNN.exportModel(); } catch (err) { msg('cnnMsg', err.message, 'err'); }
  };
  $('btnImportCnn').onclick = () => $('importCnn').click();
  $('importCnn').onchange = async (e) => {
    if (!(await needTf())) { e.target.value = ''; return; }
    try { await MeterCNN.importModel(e.target.files); applyCnn(); msg('cnnMsg', 'CNN berhasil diimpor.', 'ok'); }
    catch (err) { msg('cnnMsg', 'Gagal impor: ' + err.message, 'err'); }
    e.target.value = ''; renderCnnStatus();
  };
  $('btnResetCnn').onclick = async () => {
    if (!confirm('Hapus CNN yang sudah dilatih di HP ini?')) return;
    await MeterCNN.reset(); applyCnn(); renderCnnStatus(); msg('cnnMsg', 'CNN dihapus.', 'ok');
  };

  // ---------- State ----------
  let srcCanvas = null;     // foto asli (sudah diperkecil)
  let workCanvas = null;    // foto setelah rotasi
  let rect = null;          // area angka di koordinat workCanvas
  let result = null;        // hasil MeterOCR.read untuk digit m³ (hitam)
  let dec = null;           // hasil MeterOCR.read untuk digit desimal (merah), bila terdeteksi
  let all = [];             // gabungan digit m³ + desimal (urutan tile)
  let nInt = 0;             // jumlah digit m³ di dalam `all`
  let labels = [];          // label final per digit (bisa dikoreksi)
  let corrected = [];       // digit yang dikoreksi manual
  let selected = -1;
  let last = null;
  let mode = 'ocr';          // 'ocr' = hasil OCR dari foto, 'manual' = petugas mengetik angka tanpa OCR
  let manualEdited = false;  // petugas mengetik sendiri angka final (berbeda dari hasil tile OCR)
  let anomaly = '';          // peringatan kewajaran terhadap pembacaan sebelumnya
  let coords = null;

  // =====================================================================
  // Pengaturan & panel model
  // =====================================================================
  function loadCfg() {
    $('nDigits').value = store.get('nDigits', '5');
  }
  // Panel model OCR & CNN ada di menu Pengaturan (admin)
  MeterAuth.on('view', (v) => { if (v === 'settings') { renderStats(); renderCnnStatus(); } });

  // =====================================================================
  // Peran: pelanggan hanya mencatat meter miliknya sendiri (server juga menolak ID lain)
  // =====================================================================
  function applyRole(u) {
    const pel = u && u.role === 'pelanggan';
    const inp = $('customerId');
    inp.readOnly = pel;
    $('btnKbd').classList.toggle('hidden', pel);
    if (pel) { inp.value = u.idMeter; refreshLast(u.idMeter); }
    // Pelanggan: ID terkunci ke meternya sendiri -> tidak perlu scan QR
    $('btnScanQr').classList.toggle('hidden', !!pel);
    resetIdSource();
    showCustomer();
  }


  function renderStats() {
    const s = model.stats();
    $('modelStats').innerHTML =
      '<table class="stats"><tr><th>Digit</th>' + s.perDigit.map((_, i) => `<th>${i}</th>`).join('') + '</tr>' +
      '<tr><td>Sampel</td>' + s.perDigit.map((n) => `<td>${n}</td>`).join('') + '</tr></table>' +
      `<p class="muted">Total sampel nyata: <b>${s.total}</b> · sampel font bawaan: ${s.synthetic}</p>`;
  }
  $('btnExport').onclick = () => {
    const blob = new Blob([model.exportJSON()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `model-meter-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $('btnImport').onclick = () => $('importFile').click();
  $('importFile').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { model.importJSON(await f.text(), true); msg('modelMsg', 'Model berhasil diimpor & digabung.', 'ok'); }
    catch (err) { msg('modelMsg', 'Gagal impor: ' + err.message, 'err'); }
    e.target.value = ''; renderStats();
  };
  $('btnResetModel').onclick = () => {
    if (!confirm('Hapus semua sampel yang sudah dipelajari di HP ini?')) return;
    model.reset(); renderStats(); msg('modelMsg', 'Model direset.', 'ok');
  };

  // =====================================================================
  // Foto
  // =====================================================================
  $('btnPhoto').onclick = () => $('file').click();
  $('file').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' });
      const s = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
      srcCanvas = document.createElement('canvas');
      srcCanvas.width = Math.round(bmp.width * s); srcCanvas.height = Math.round(bmp.height * s);
      const ctx = srcCanvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bmp, 0, 0, srcCanvas.width, srcCanvas.height);
      bmp.close?.();
      $('cropCard').classList.remove('hidden');
      $('resultCard').classList.add('hidden');
      setManualEnabled(true);
      autoDetect();
      qrFromPhoto(srcCanvas);
    } catch (err) {
      alert('Gagal memuat foto: ' + err.message);
    }
    e.target.value = '';
    getLocation();
  };

  // =====================================================================
  // Deteksi otomatis area angka (js/detect.js)
  // =====================================================================
  let detected = null;   // hasil MeterDetect (berisi redRect untuk digit desimal)
  // Hasil baca saat memilih orientasi 0°/180° disimpan, supaya "Baca Angka" berikutnya tidak membaca ulang
  // gambar & kotak yang persis sama (menghemat satu kali OCR per foto).
  let readMemo = [];
  const readKey = (cv, r, n) => [cv.width, cv.height, r.x, r.y, r.w, r.h, n].join('|');
  const scoreFn = (cv, r, n) => {
    const res = MeterOCR.read(cv, r, n, model);
    readMemo.push({ key: readKey(cv, r, n), res });
    return res.digits.reduce((s, d) => s + d.conf, 0) / n;
  };

  function autoDetect() {
    msg('readMsg', '🎯 Mencari area angka…');
    readMemo = [];
    setTimeout(() => {   // beri waktu UI menampilkan pesan
      const t0 = performance.now();
      let d = null;
      try { d = MeterDetect.detect(srcCanvas, { scoreFn }); } catch (err) { console.error(err); }
      const ms = Math.round(performance.now() - t0);
      if (!d) {
        detected = null;
        $('angle').value = store.get('angle', '0');
        rect = null; applyRotation(); restoreRect(); drawEditor();
        msg('readMsg', 'Area angka tidak terdeteksi otomatis. Tarik kotak secara manual lalu tekan Baca Angka.', 'warn');
        $('cropCard').scrollIntoView({ behavior: 'smooth' });
        return;
      }
      detected = d;
      $('angle').value = d.angle;
      rect = null; applyRotation();
      rect = { ...d.rect }; clampRect();
      $('nDigits').value = d.nDigits;
      drawEditor();
      runRead(`Terdeteksi otomatis dalam ${ms} ms: ${d.nDigits} digit m³` +
        (d.nRed ? ` + ${d.nRed} digit desimal` : '') + '. Periksa kotak kuning; koreksi bila perlu.');
    }, 30);
  }
  $('btnDetect').onclick = () => { if (srcCanvas) autoDetect(); };

  function applyRotation() {
    const deg = Number($('angle').value);
    $('angleVal').textContent = deg + '°';
    const prev = workCanvas && { w: workCanvas.width, h: workCanvas.height };
    workCanvas = MeterDetect.rotateCanvas(srcCanvas, deg);   // geometri sama persis dengan detektor
    const W = workCanvas.width, H = workCanvas.height;
    // pertahankan posisi kotak relatif terhadap pusat
    if (rect && prev) {
      rect.x += (W - prev.w) / 2; rect.y += (H - prev.h) / 2;
      clampRect();
    }
  }
  $('angle').oninput = () => { detected = null; applyRotation(); drawEditor(); };
  $('angle').onchange = () => store.set('angle', $('angle').value);
  $('nDigits').oninput = () => { detected = null; store.set('nDigits', $('nDigits').value); drawEditor(); };

  function restoreRect() {
    const W = workCanvas.width, H = workCanvas.height;
    let r = null;
    try { r = JSON.parse(store.get('rectRatio', 'null')); } catch {}
    rect = r ? { x: r.x * W, y: r.y * H, w: r.w * W, h: r.h * H }
             : { x: W * 0.2, y: H * 0.42, w: W * 0.6, h: H * 0.12 };
    clampRect();
  }
  function saveRect() {
    const W = workCanvas.width, H = workCanvas.height;
    store.set('rectRatio', JSON.stringify({ x: rect.x / W, y: rect.y / H, w: rect.w / W, h: rect.h / H }));
  }
  function clampRect() {
    const W = workCanvas.width, H = workCanvas.height;
    rect.w = Math.max(10, Math.min(rect.w, W)); rect.h = Math.max(10, Math.min(rect.h, H));
    rect.x = Math.max(0, Math.min(rect.x, W - rect.w)); rect.y = Math.max(0, Math.min(rect.y, H - rect.h));
  }

  // =====================================================================
  // Editor kotak area angka (pointer events: mouse & sentuh)
  // =====================================================================
  const editor = $('editor');
  function drawEditor() {
    if (!workCanvas) return;
    editor.width = workCanvas.width; editor.height = workCanvas.height;
    const ctx = editor.getContext('2d');
    ctx.drawImage(workCanvas, 0, 0);
    if (!rect) return;
    const lw = Math.max(2, workCanvas.width / 300);
    ctx.fillStyle = 'rgba(0,0,0,.45)';
    ctx.fillRect(0, 0, editor.width, rect.y);
    ctx.fillRect(0, rect.y + rect.h, editor.width, editor.height - rect.y - rect.h);
    ctx.fillRect(0, rect.y, rect.x, rect.h);
    ctx.fillRect(rect.x + rect.w, rect.y, editor.width - rect.x - rect.w, rect.h);
    const n = nDigits();
    ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = lw / 2;
    for (let i = 1; i < n; i++) {
      const x = rect.x + rect.w * i / n;
      ctx.beginPath(); ctx.moveTo(x, rect.y); ctx.lineTo(x, rect.y + rect.h); ctx.stroke();
    }
    ctx.strokeStyle = '#facc15'; ctx.lineWidth = lw;
    ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
    if (detected && detected.redRect) {   // area digit desimal (merah) hasil deteksi
      const r = detected.redRect;
      ctx.setLineDash([lw * 3, lw * 2]); ctx.strokeStyle = '#f472b6';
      ctx.strokeRect(r.x, r.y, r.w, r.h); ctx.setLineDash([]);
    }
  }

  let drag = null;
  function toCanvas(e) {
    const r = editor.getBoundingClientRect();
    return { x: (e.clientX - r.left) * editor.width / r.width, y: (e.clientY - r.top) * editor.height / r.height };
  }
  editor.addEventListener('pointerdown', (e) => {
    if (!workCanvas) return;
    detected = null;   // kotak diubah manual -> posisi digit desimal tidak lagi valid
    editor.setPointerCapture(e.pointerId);
    const p = toCanvas(e);
    const inside = rect && p.x > rect.x && p.x < rect.x + rect.w && p.y > rect.y && p.y < rect.y + rect.h;
    drag = inside ? { mode: 'move', p, r0: { ...rect } } : { mode: 'draw', p };
  });
  editor.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = toCanvas(e);
    if (drag.mode === 'move') {
      rect = { ...drag.r0, x: drag.r0.x + p.x - drag.p.x, y: drag.r0.y + p.y - drag.p.y };
    } else {
      rect = { x: Math.min(p.x, drag.p.x), y: Math.min(p.y, drag.p.y),
               w: Math.abs(p.x - drag.p.x), h: Math.abs(p.y - drag.p.y) };
    }
    clampRect(); drawEditor();
  });
  const endDrag = () => { if (drag) { drag = null; saveRect(); } };
  editor.addEventListener('pointerup', endDrag);
  editor.addEventListener('pointercancel', endDrag);

  const nDigits = () => Math.max(3, Math.min(8, parseInt($('nDigits').value, 10) || 5));

  // =====================================================================
  // Baca
  // =====================================================================
  $('btnRead').onclick = () => runRead();

  function runRead(note) {
    if (!workCanvas || !rect) return;
    if (rect.w < 30 || rect.h < 12) return msg('readMsg', 'Kotak terlalu kecil. Seret kotak mengelilingi angka.', 'err');
    const t0 = performance.now();
    const memo = readMemo.find((m) => m.key === readKey(workCanvas, rect, nDigits()));
    readMemo = [];
    result = memo ? memo.res : MeterOCR.read(workCanvas, rect, nDigits(), model);
    // Digit desimal (merah) hanya bila area hasil deteksi otomatis tidak diubah.
    // Kanal 'red' membuang latar putih & silau sehingga hanya tinta merah yang tersisa.
    dec = detected && detected.redRect
      ? MeterOCR.read(workCanvas, detected.redRect, detected.nRed, model, { channel: 'red' }) : null;
    nInt = result.digits.length;
    all = result.digits.concat(dec ? dec.digits : []);
    labels = all.map((d) => d.label);
    corrected = all.map(() => false);
    setMode('ocr');
    $('decRow').classList.toggle('hidden', !dec);
    selected = -1;
    msg('readMsg', note || `Selesai dalam ${Math.round(performance.now() - t0)} ms.`, 'ok');

    const dbg = $('debug');
    dbg.width = result.debugCanvas.width; dbg.height = result.debugCanvas.height;
    dbg.getContext('2d').drawImage(result.debugCanvas, 0, 0);

    $('resultCard').classList.remove('hidden');
    $('btnSave').disabled = false; $('btnSave').textContent = '💾 Simpan ke Google Sheet';
    msg('saveMsg', '');
    applyPrior();      // bila data bulan lalu sudah ada (prefetch)
    renderTiles();
    syncFinal();
    fetchLast();
    $('resultCard').scrollIntoView({ behavior: 'smooth' });
  }

  /**
   * Gabungkan hasil OCR dengan pembacaan bulan lalu (meter hanya naik, biasanya sedikit).
   * Digit yang DIUBAH oleh acuan ini tetap ditandai ragu agar dicek petugas.
   */
  function applyPrior() {
    if (mode !== 'ocr' || !result || !last || result.priorApplied) return false;
    if (corrected.some(Boolean) || manualEdited) return false;       // petugas sudah turun tangan
    if (!result.digits.every((d) => d.probs)) return false;
    const days = last.timestamp ? Math.max(1, (Date.now() - new Date(last.timestamp)) / 864e5) : 30;
    const info = MeterOCR.applyPrior(result.digits, { value: Number(last.finalReading), days });
    result.priorApplied = info ? { ocrText: info.ocrText, changes: info.changes } : { skipped: true };
    if (!info) return false;
    result.digits.forEach((d, i) => { labels[i] = d.label; });
    result.text = result.digits.map((d) => d.label).join('');
    result.minConf = result.digits.reduce((m, d) => Math.min(m, d.conf), 1);
    return true;
  }

  function renderTiles() {
    const box = $('tiles');
    box.innerHTML = '';
    all.forEach((d, i) => {
      if (i === nInt) {   // pemisah m³ | desimal
        const sep = document.createElement('div');
        sep.className = 'tile-sep'; sep.textContent = ',';
        box.appendChild(sep);
      }
      const t = document.createElement('div');
      const cls = corrected[i] ? 'ok' : d.rolling ? 'warn' : d.conf >= CONF_OK ? 'ok' : 'err';
      t.className = `tile ${cls}${i >= nInt ? ' dec' : ''}${i === selected ? ' sel' : ''}${corrected[i] ? ' fixed' : ''}`;
      t.appendChild(MeterOCR.patchToCanvas(d.patch, 2));
      const dd = document.createElement('div'); dd.className = 'd'; dd.textContent = labels[i] ?? '?';
      const cc = document.createElement('div'); cc.className = 'c';
      cc.textContent = corrected[i] ? 'koreksi' : d.empty ? 'kosong'
        : (d.rolling ? '↻ ' : '') + (d.priorChanged ? `📅${d.ocrLabel}→ ` : '') + Math.round(d.conf * 100) + '%';
      if (d.priorChanged && !corrected[i]) t.title = `OCR membaca ${d.ocrLabel}, disesuaikan dengan pembacaan bulan lalu`;
      t.append(dd, cc);
      t.onclick = () => { selected = selected === i ? -1 : i; renderTiles(); renderPicker(); };
      box.appendChild(t);
    });
    renderPicker();
  }

  function renderPicker() {
    const p = $('picker');
    if (selected < 0) { p.classList.add('hidden'); return; }
    p.classList.remove('hidden');
    p.innerHTML = '';
    for (let k = 0; k <= 9; k++) {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = k;
      b.onclick = () => {
        corrected[selected] = k !== all[selected].label || corrected[selected];
        labels[selected] = k;
        selected = selected + 1 < labels.length ? selected + 1 : -1;  // lanjut ke digit berikutnya
        renderTiles(); syncFinal();
      };
      p.appendChild(b);
    }
  }

  function syncFinal() {
    const str = (arr) => arr.map((l) => (l === null ? '?' : l)).join('');
    const ints = str(labels.slice(0, nInt)), decs = str(labels.slice(nInt));
    $('readingDisplay').innerHTML = esc(ints) +
      (decs ? `<span style="color:#f87171;font-size:.6em">,${esc(decs)}</span>` : '');
    $('finalReading').value = ints.includes('?') ? '' : String(Number(ints));
    $('finalDecimal').value = decs.includes('?') ? '' : decs;
    manualEdited = false;
    $('finalReading').classList.remove('manual'); $('finalDecimal').classList.remove('manual');
    validate();
  }

  /** Nilai final menurut tile OCR (untuk mendeteksi apakah petugas mengetik angka lain) */
  function tileValues() {
    const str = (arr) => arr.map((l) => (l === null ? '?' : l)).join('');
    const ints = str(labels.slice(0, nInt)), decs = str(labels.slice(nInt));
    return { int: ints.includes('?') ? '' : String(Number(ints)), dec: decs.includes('?') ? '' : decs };
  }

  // Petugas mengetik angka langsung di kolom final
  function onManualType() {
    const fr = $('finalReading'), fd = $('finalDecimal');
    fr.value = fr.value.replace(/\D/g, ''); fd.value = fd.value.replace(/\D/g, '');
    if (mode === 'ocr' && result) {
      const t = tileValues();
      manualEdited = fr.value !== t.int || (!!dec && fd.value !== t.dec);
    } else {
      manualEdited = true;
    }
    fr.classList.toggle('manual', manualEdited); fd.classList.toggle('manual', manualEdited);
    if (manualEdited || mode === 'manual') {
      $('readingDisplay').innerHTML = (esc(fr.value) || '—') +
        (fd.value ? `<span style="color:#f87171;font-size:.6em">,${esc(fd.value)}</span>` : '') +
        '<div style="font-size:12px;letter-spacing:0;color:#fbbf24">✍️ diketik manual</div>';
    }
    validate();
  }
  $('finalReading').oninput = onManualType;
  $('finalDecimal').oninput = onManualType;

  // =====================================================================
  // Hasil meragukan -> minta petugas mencocokkan / mengetik manual
  // =====================================================================
  function digitDoubts() {
    if (mode !== 'ocr' || !result) return [];
    const bad = all.map((d, i) => ({ d, i })).filter(({ d, i }) =>
      !corrected[i] && (d.empty || d.label === null || d.rolling || d.conf < CONF_OK));
    const out = [];
    const ip = bad.filter((b) => b.i < nInt), dp = bad.filter((b) => b.i >= nInt);
    if (ip.length) out.push(`Digit m³ ke-${ip.map((b) => b.i + 1).join(', ')} ragu` +
      (ip.some((b) => b.d.rolling) ? ' (ada roda sedang berputar)' : ''));
    if (dp.length) out.push(`Digit desimal ke-${dp.map((b) => b.i - nInt + 1).join(', ')} ragu`);
    const pc = all.map((d, i) => ({ d, i })).filter(({ d, i }) => i < nInt && d.priorChanged && !corrected[i]);
    if (pc.length) out.push(`Digit ke-${pc.map((b) => b.i + 1).join(', ')} disesuaikan dengan pembacaan bulan lalu (OCR: ${pc.map((b) => b.d.ocrLabel).join(', ')}) — pastikan sesuai meter`);
    return out;
  }

  /** true bila boleh disimpan; sekaligus memperbarui kotak peringatan & tombol simpan */
  function renderDoubt() {
    const box = $('doubtBox');
    const digits = digitDoubts();
    const confirmed = $('confirmOk').checked;
    const items = digits.slice();
    if (anomaly) items.push(anomaly);
    const blocking = (digits.length && !manualEdited && !confirmed) || (anomaly && !confirmed);
    box.classList.toggle('hidden', !items.length);
    box.classList.toggle('resolved', !blocking);
    $('doubtTitle').textContent = blocking
      ? (mode === 'manual' ? '⚠️ Angka tidak wajar — cocokkan lagi dengan meter' : '⚠️ Hasil OCR meragukan — cocokkan dengan meter')
      : '✅ Sudah dicek petugas';
    $('doubtList').innerHTML = items.map((t) => `<li>${esc(t)}</li>`).join('') +
      (digits.length && manualEdited ? '<li>Angka sudah diketik manual oleh petugas.</li>' : '');
    $('btnTypeManual').classList.toggle('hidden', mode === 'manual' || manualEdited);
    const btn = $('btnSave');
    if (!btn.disabled) {
      btn.classList.toggle('btn-warn', !!blocking); btn.classList.toggle('btn-ok', !blocking);
      btn.textContent = blocking ? '⚠️ Cek angka dulu sebelum simpan' : '💾 Simpan ke Google Sheet';
    }
    return !blocking;
  }
  $('confirmOk').onchange = renderDoubt;
  $('btnTypeManual').onclick = () => {
    const fr = $('finalReading');
    fr.focus(); fr.select();
    fr.scrollIntoView({ behavior: 'smooth', block: 'center' });
    msg('saveMsg', 'Ketik angka m³ sesuai yang terlihat di meter (dan desimal merah bila perlu).', '');
  };

  // =====================================================================
  // Mode input manual (tanpa OCR)
  // =====================================================================
  function setMode(m) {
    mode = m;
    const manual = m === 'manual';
    $('resultTitle').textContent = manual ? '3. Input Manual' : '3. Hasil Pembacaan';
    $('ocrBlock').classList.toggle('hidden', manual);
    $('manualRow').classList.toggle('hidden', !manual);
    $('confirmOk').checked = false;
    if (manual) $('decRow').classList.remove('hidden');
  }

  function startManual(reason) {
    result = dec = null; all = []; nInt = 0; labels = []; corrected = []; selected = -1;
    setMode('manual');
    $('manualReason').value = reason || '';
    $('finalReading').value = ''; $('finalDecimal').value = '';
    manualEdited = true;
    $('finalReading').classList.add('manual'); $('finalDecimal').classList.add('manual');
    $('readingDisplay').innerHTML = '—<div style="font-size:12px;letter-spacing:0;color:#fbbf24">✍️ input manual</div>';
    $('resultCard').classList.remove('hidden');
    $('btnSave').disabled = false;
    msg('saveMsg', '');
    fetchLast();
    $('resultCard').scrollIntoView({ behavior: 'smooth' });
    setTimeout(() => $('finalReading').focus(), 300);
  }
  // Input manual hanya boleh setelah petugas mengambil foto meter (bukti sudah datang ke lokasi);
  // foto tetap tampil di langkah 2 sebagai acuan saat mengetik.
  function setManualEnabled(on) {
    $('btnManualNoPhoto').disabled = !on;
    $('manualHint').classList.toggle('hidden', on);
  }
  $('btnManualNoPhoto').onclick = () => {
    if (!srcCanvas) return setManualEnabled(false);
    startManual('');
  };
  $('btnManualFromCrop').onclick = () => startManual('Area angka tidak terdeteksi');

  // =====================================================================
  // Validasi terhadap pembacaan sebelumnya
  // =====================================================================
  // Pembacaan terakhir per pelanggan disimpan di HP: tampil seketika & tetap ada saat offline.
  // Server tetap ditanya di latar belakang untuk memperbarui (mis. dibaca petugas lain).
  const LAST_KEY = 'lastCache.v1';
  const lastCache = {
    all() { try { return JSON.parse(store.get(LAST_KEY, '{}')); } catch { return {}; } },
    get(id) { return this.all()[id] || null; },
    set(id, v) {
      const a = this.all();
      if (v) a[id] = { finalReading: v.finalReading, timestamp: v.timestamp, at: Date.now() }; else delete a[id];
      const keys = Object.keys(a);
      if (keys.length > 3000) keys.sort((x, y) => a[x].at - a[y].at).slice(0, keys.length - 3000).forEach((k) => delete a[k]);
      store.set(LAST_KEY, JSON.stringify(a));
    },
  };
  const inflight = {};
  // Profil pelanggan (nama & alamat) dari server, untuk memastikan operator mencatat meter yang benar
  const custInfo = {};
  function showCustomer() {
    const id = $('customerId').value.trim(), box = $('customerInfo'), u = me();
    const c = custInfo[id];
    if (u && u.role === 'pelanggan') {
      box.textContent = `🏠 Meter Anda: ${u.idMeter} · ${u.nama}`;
      box.classList.remove('hidden');
    } else if (id && c) {
      box.textContent = `🏠 ${c.nama}${c.alamat ? ' — ' + c.alamat : ''}${c.aktif === false && !idMethod.startsWith('QR') ? ' · ⛔ Nonaktif' : ''}`;
      box.classList.remove('hidden');
    } else if (id && c === null && id.length >= 3 && !idMethod.startsWith('QR')) {
      box.textContent = '⚠️ ID ini belum terdaftar di tabel Pelanggan — pembacaan akan ditolak. Periksa ID atau minta admin mendaftarkannya.';
      box.classList.remove('hidden');
    } else box.classList.add('hidden');
  }
  function refreshLast(id) {
    if (!id || !serverReady() || !me() || !navigator.onLine) return Promise.resolve(lastCache.get(id));
    if (!inflight[id]) {
      inflight[id] = api('last', { customerId: id })
        .then((res) => {
          // null = pasti belum terdaftar (hanya bila tabel Pelanggan sudah aktif); undefined = tidak diketahui
          custInfo[id] = res.customer || (res.registry ? null : undefined);
          showCustomer();
          // jangan timpa pembacaan lokal yang lebih baru (mis. masih di antrean)
          const local = lastCache.get(id);
          const srv = res.last;
          if (!srv && local && outbox.list().some((x) => x.record.customerId === id)) return local;
          if (!local || !srv || new Date(srv.timestamp) >= new Date(local.timestamp)) lastCache.set(id, srv);
          return lastCache.get(id);
        })
        .catch(() => lastCache.get(id))
        .finally(() => { delete inflight[id]; });
    }
    return inflight[id];
  }
  async function fetchLast() {
    const id = $('customerId').value.trim();
    last = id ? lastCache.get(id) : null;          // seketika dari cache HP
    if (applyPrior()) { renderTiles(); syncFinal(); } else validate();
    if (!id) return;
    if (last && last.at && Date.now() - last.at < 2 * 60 * 1000) return;   // baru diambil (prefetch) -> hemat 1 panggilan
    const fresh = await refreshLast(id);
    if ($('customerId').value.trim() !== id) return; // ID sudah diganti petugas
    last = fresh;
    if (applyPrior()) { renderTiles(); syncFinal(); } else validate();
  }
  // =====================================================================
  // ID dari stiker QR (js/qr.js; stiker dibuat aplikasi lain, isi = ID numerik): scan stikernya,
  // atau otomatis dari foto meter bila stikernya ikut terfoto.
  // ID dari QR dikunci (tidak tertimpa ketikan); "Ubah manual" membukanya. Ketik manual tetap boleh.
  // =====================================================================
  let idMethod = '';   // 'QR (foto meter)' | 'QR (scan stiker)' | 'Manual' | 'Akun pelanggan' | '' (belum diisi)
  function resetIdSource() {
    const u = me(), pel = u && u.role === 'pelanggan';
    idMethod = pel ? 'Akun pelanggan' : '';
    $('customerId').classList.remove('from-qr');
    if (!pel) $('customerId').readOnly = false;
    $('btnIdManual').classList.add('hidden');
    $('idSource').className = 'muted';
    $('idSource').textContent = pel ? 'ID meter akun Anda.' : 'Scan stiker QR, atau ID terbaca otomatis bila stikernya ikut terfoto. Ketik manual tetap bisa.';
  }
  function setIdFromQr(id, method) {
    const inp = $('customerId'), before = inp.value.trim();
    inp.value = id;
    inp.readOnly = true;
    inp.classList.add('from-qr');
    idMethod = method;
    $('btnIdManual').classList.remove('hidden');
    $('idSource').className = 'qr';
    $('idSource').textContent = `🔒 ID dari stiker QR (${method === 'QR (foto meter)' ? 'foto meter' : 'scan stiker'})` +
      (before && before !== id ? ` — menggantikan ketikan ${before}` : '');
    showCustomer();
    refreshLast(id);
    if (!$('resultCard').classList.contains('hidden')) fetchLast();
  }
  let qrJob = 0;
  /** Cari stiker QR di foto meter (di latar belakang, setelah deteksi angka mulai) */
  function qrFromPhoto(canvas) {
    const u = me();
    if (!u || u.role === 'pelanggan' || idMethod.startsWith('QR')) return;
    const job = ++qrJob;
    setTimeout(() => {
      MeterQR.decodeCanvas(canvas).then((r) => {
        if (job !== qrJob || canvas !== srcCanvas || !r) return;
        setIdFromQr(r.id, 'QR (foto meter)');
      }).catch(() => {});   // library QR tidak termuat (offline di iPhone) -> tetap bisa ketik manual
    }, 80);
  }
  // --- Scan QR langsung: viewfinder kamera + analisis bingkai terus-menerus; foto = cadangan ---
  let qrCam = null, qrScan = null, qrTip = 0, qrLiveJob = 0;
  const qrStatus = (t) => { $('qrStatus').textContent = t; };
  function stopQrLive() {
    qrLiveJob++;
    clearTimeout(qrTip);
    if (qrScan) { qrScan.stop(); qrScan = null; }
    if (qrCam) { qrCam.close(); qrCam = null; }
    $('qrView').classList.add('idle');
    $('qrTorch').classList.add('hidden');
    $('qrTorch').classList.remove('on');
  }
  /** Area bingkai bidik (#qrFrame) dalam koordinat video; video tampil object-fit: cover, +12% kelonggaran */
  function qrRegion(vw, vh) {
    const v = $('qrView').getBoundingClientRect(), f = $('qrFrame').getBoundingClientRect();
    const k = Math.max(v.width / vw, v.height / vh), ox = (v.width - vw * k) / 2, oy = (v.height - vh * k) / 2;
    const pad = f.width * 0.12;
    const x = Math.max(0, (f.left - v.left - pad - ox) / k), y = Math.max(0, (f.top - v.top - pad - oy) / k);
    const w = Math.min(vw - x, (f.width + 2 * pad) / k), h = Math.min(vh - y, (f.height + 2 * pad) / k);
    return w > 16 && h > 16 ? { x, y, w, h } : { x: 0, y: 0, w: vw, h: vh };
  }
  function camError(err) {
    switch (err && err.name) {
      case 'NotAllowedError': return 'Izin kamera ditolak (izinkan kamera di pengaturan browser).';
      case 'NotFoundError': case 'OverconstrainedError': return 'Kamera tidak ditemukan.';
      case 'NotReadableError': case 'AbortError': return 'Kamera sedang dipakai aplikasi lain.';
      default: return 'Kamera langsung tidak tersedia di sini.';
    }
  }
  async function openQrLive() {
    const dlg = $('qrDialog');
    stopQrLive();
    const job = qrLiveJob;
    qrStatus('Mengaktifkan kamera…');
    if (!dlg.open) dlg.showModal();
    try {
      const cam = await MeterQR.openCamera($('qrVideo'));
      if (job !== qrLiveJob) return cam.close();   // dialog ditutup saat menunggu izin kamera
      qrCam = cam;
      $('qrView').classList.remove('idle');
      $('qrTorch').classList.toggle('hidden', !cam.hasTorch);
      qrStatus('Arahkan bingkai ke stiker QR — terbaca otomatis.');
      qrTip = setTimeout(() => qrStatus('Belum terbaca: jarak ±15–25 cm, cukup terang & tidak silau. Atau pakai 🖼️ Ambil foto.'), 9000);
      qrScan = MeterQR.live($('qrVideo'), {
        region: qrRegion,
        onResult(r) {
          dlg.close();   // -> stopQrLive (kamera dimatikan)
          setIdFromQr(r.id, 'QR (scan stiker)');
        },
        onError(err) {
          stopQrLive();
          qrStatus('⚠️ ' + (err.message || 'Pembaca QR gagal') + ' — pakai 🖼️ Ambil foto atau ketik ID manual.');
        },
      });
    } catch (err) {
      if (job !== qrLiveJob) return;
      stopQrLive();
      qrStatus('⚠️ ' + camError(err) + ' Pakai 🖼️ Ambil foto, atau ketik ID manual.');
    }
  }
  $('btnScanQr').onclick = () => {
    // tanpa dukungan kamera langsung -> langsung foto (masih dalam ketukan pengguna, jadi tidak diblokir browser)
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return $('qrFile').click();
    openQrLive();
  };
  $('qrDialog').addEventListener('close', stopQrLive);
  $('qrCancel').onclick = () => $('qrDialog').close();
  $('qrPhoto').onclick = () => { $('qrDialog').close(); $('qrFile').click(); };
  $('qrTorch').onclick = () => {
    if (!qrCam) return;
    const on = !$('qrTorch').classList.contains('on');
    qrCam.torch(on).then(() => $('qrTorch').classList.toggle('on', on)).catch(() => {});
  };
  // aplikasi ke latar belakang -> matikan kamera
  document.addEventListener('visibilitychange', () => { if (document.hidden && $('qrDialog').open) $('qrDialog').close(); });
  $('qrFile').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    $('idSource').className = 'muted';
    $('idSource').textContent = '🔎 Membaca stiker QR…';
    try {
      const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' });
      const s = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close?.();
      const r = await MeterQR.decodeCanvas(c, { thorough: true });
      if (r) return setIdFromQr(r.id, 'QR (scan stiker)');
      $('idSource').textContent = '⚠️ QR tidak terbaca. Foto lebih dekat & fokus, atau ketik ID manual.';
    } catch (err) {
      $('idSource').textContent = '⚠️ ' + (err.message || 'Gagal membaca QR') + ' — ketik ID manual.';
    }
  };
  $('btnIdManual').onclick = () => {
    resetIdSource();
    idMethod = 'Manual';
    $('idSource').textContent = '✏️ ID diketik manual.';
    $('customerId').focus();
    $('customerId').select();
  };

  // =====================================================================
  // Input ID Meter: keyboard standar (huruf + angka) atau keypad angka, dipilih petugas & diingat di HP.
  // Huruf selalu kapital agar "a24c" dan "A24C" tidak dianggap pelanggan berbeda.
  // =====================================================================
  const KBD_KEY = 'idKeyboard';
  function applyKbd(mode) {
    const num = mode === 'num';
    $('customerId').inputMode = num ? 'numeric' : 'text';
    $('btnKbd').textContent = num ? 'ABC' : '123';
    $('btnKbd').setAttribute('aria-label', num ? 'Ganti ke keyboard huruf & angka' : 'Ganti ke keypad angka');
  }
  applyKbd(store.get(KBD_KEY, 'text'));
  $('btnKbd').addEventListener('pointerdown', (e) => e.preventDefault());   // jangan ambil fokus dari kolom
  $('btnKbd').onclick = () => {
    const next = $('customerId').inputMode === 'numeric' ? 'text' : 'num';
    store.set(KBD_KEY, next);
    applyKbd(next);
    const inp = $('customerId');
    if (inp.readOnly) return;
    inp.blur();                     // keyboard HP baru berganti setelah fokus ulang
    setTimeout(() => inp.focus(), 50);
  };
  function upperInput(inp) {
    const v = inp.value, up = v.toUpperCase();
    if (v === up) return;
    const a = inp.selectionStart, b = inp.selectionEnd;
    inp.value = up;
    try { inp.setSelectionRange(a, b); } catch {}
  }
  $('customerId').addEventListener('input', (e) => {
    upperInput($('customerId'));
    if (e.isTrusted && !$('customerId').readOnly) {           // diketik petugas
      idMethod = $('customerId').value.trim() ? 'Manual' : '';
      if (idMethod) { $('idSource').className = 'muted'; $('idSource').textContent = '✏️ ID diketik manual.'; }
    }
  });
  $('uMeter').addEventListener('input', () => upperInput($('uMeter')));

  // Ambil lebih awal: begitu ID diketik (selagi petugas memotret), data bulan lalu sudah siap
  let prefetchTimer = null;
  $('customerId').addEventListener('input', () => {
    clearTimeout(prefetchTimer);
    const id = $('customerId').value.trim();
    showCustomer();
    if (id.length >= 3) prefetchTimer = setTimeout(() => refreshLast(id), 700);
  });
  $('customerId').addEventListener('change', () => { if (!$('resultCard').classList.contains('hidden')) fetchLast(); });
  function validate() {
    const raw = $('finalReading').value.trim();
    anomaly = '';
    if (!last) { msg('compareMsg', ''); renderDoubt(); return; }
    const prev = Number(last.finalReading), when = new Date(last.timestamp).toLocaleDateString('id-ID');
    if (raw === '') { msg('compareMsg', `Pembacaan sebelumnya: ${prev} m³ (${when})`, ''); renderDoubt(); return; }
    const usage = Number(raw) - prev;
    if (usage < 0) {
      anomaly = `Angka lebih kecil dari pembacaan sebelumnya (${prev} m³, ${when})`;
      msg('compareMsg', `⚠️ ${anomaly}. Periksa ulang!`, 'warn');
    } else if (usage > 100) {
      anomaly = `Pemakaian ${usage} m³ sejak ${when} tidak wajar`;
      msg('compareMsg', `⚠️ ${anomaly}. Periksa ulang.`, 'warn');
    } else msg('compareMsg', `Sebelumnya ${prev} m³ (${when}) → pemakaian ${usage} m³`, 'ok');
    renderDoubt();
  }

  // =====================================================================
  // Simpan + belajar
  // =====================================================================
  const api = (action, data) => MeterAuth.api(action, data);

  // =====================================================================
  // Antrean offline: pembacaan disimpan di HP lalu dikirim saat online.
  // Tiap record punya clientId unik sehingga server menolak kiriman ganda.
  // =====================================================================
  const OUTBOX_KEY = 'outbox.v1';
  const outbox = {
    list() { try { return JSON.parse(store.get(OUTBOX_KEY, '[]')); } catch { return []; } },
    write(items) { store.set(OUTBOX_KEY, JSON.stringify(items)); updateNetbar(); },
    // owner: data hanya dikirim dengan sesi pemiliknya (HP dipakai bergantian -> tidak tercatat atas nama orang lain)
    add(record) { const items = this.list(); items.push({ record, tries: 0, owner: me() && me().username }); this.write(items); return items.length; },
    mine() { const u = me(); return this.list().filter((x) => u && (!x.owner || x.owner === u.username)); },
  };
  const newId = () => (crypto.randomUUID ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2));

  let syncing = false, again = false;
  const BATCH = 20;   // banyak data dalam SATU panggilan Apps Script (hemat ±2 detik per data)

  /** Kirim satu per satu — cadangan bila backend belum mendukung saveBatch */
  async function sendOneByOne(records) {
    const out = [];
    for (const record of records) {
      try { const r = await api('save', { record }); out.push({ ...r, ok: true, clientId: record.clientId }); }
      catch (err) { if (err.network) throw err; out.push({ ok: false, clientId: record.clientId, error: err.message }); }
    }
    return out;
  }

  async function flushOutbox() {
    if (syncing) { again = true; return; }      // simpanan baru saat sedang mengirim -> kirim lagi setelahnya
    if (!navigator.onLine || !me() || !outbox.mine().length) return;
    syncing = true; again = false; updateNetbar();
    let sent = 0;
    try {
      const items = outbox.mine();
      for (let i = 0; i < items.length; i += BATCH) {
        const records = items.slice(i, i + BATCH).map((x) => x.record);
        let results;
        try {
          results = (await api('saveBatch', { records })).results;
        } catch (err) {
          if (err.network || err.auth) break;                       // offline / sesi berakhir -> coba lagi nanti
          if (/Action tidak dikenal/.test(err.message)) results = await sendOneByOne(records);   // backend lama
          else results = records.map((r) => ({ ok: false, clientId: r.clientId, error: err.message }));  // mis. token salah
        }
        const byId = Object.fromEntries(results.map((r) => [r.clientId, r]));
        outbox.write(outbox.list()
          .filter((x) => !(byId[x.record.clientId] && byId[x.record.clientId].ok))
          .map((x) => (byId[x.record.clientId] ? { ...x, tries: x.tries + 1, error: byId[x.record.clientId].error } : x)));
        results.forEach((r) => { if (r.ok) sent++; onSent(r); });
      }
    } catch (err) {
      if (!err.network) console.warn(err);
    } finally {
      syncing = false; updateNetbar();
    }
    if (sent > 1) toastNet(`✅ ${sent} data antrean terkirim ke Google Sheet.`);
    if (again) flushOutbox();
  }

  function updateNetbar() {
    const all = outbox.list(), items = outbox.mine(), n = items.length, errs = items.filter((x) => x.error);
    const others = all.length - n;
    const online = navigator.onLine;
    const bar = $('netbar');
    bar.classList.toggle('hidden', online && !n && !others);
    bar.classList.toggle('online', online);
    $('netText').textContent = (online ? (syncing ? '🔄 Mengirim antrean…' : '🌐 Online') : '📴 Offline — aplikasi tetap bisa dipakai') +
      (n ? ` · ${n} data menunggu dikirim` : '') + (others ? ` · ${others} data milik akun lain (dikirim saat akun itu login)` : '') +
      (errs.length ? ` · ${errs.length} ditolak server: ${errs[errs.length - 1].error}` : '');
    $('btnSync').classList.toggle('hidden', !online || !n || syncing);
  }
  function toastNet(text) {
    const bar = $('netbar');
    bar.classList.remove('hidden'); bar.classList.add('online');
    $('netText').textContent = text;
    setTimeout(updateNetbar, 4000);
  }
  $('btnSync').onclick = () => flushOutbox();
  window.addEventListener('online', () => { updateNetbar(); flushOutbox(); });
  window.addEventListener('offline', updateNetbar);
  setInterval(() => { if (outbox.mine().length) flushOutbox(); }, 60000);

  /** Label final per digit: dari angka final (dipad nol) jika panjangnya cocok */
  function finalLabels() {
    if (!result) return null;
    const n = result.digits.length, raw = $('finalReading').value.trim();
    if (!/^\d+$/.test(raw) || raw.length > n) return null;
    return raw.padStart(n, '0').split('').map(Number);
  }

  /** Label final desimal: dari kolom Desimal Final jika jumlah digitnya cocok */
  function finalDecLabels() {
    if (!dec) return null;
    const raw = $('finalDecimal').value.trim();
    if (!/^\d+$/.test(raw) || raw.length !== dec.digits.length) return null;
    return raw.split('').map(Number);
  }

  /** Simpan patch digit sebagai sampel latih (m³ maupun desimal memakai model yang sama) */
  function learnDigits(digits, truth) {
    let added = 0;
    digits.forEach((d, i) => {
      if (d.empty || d.rolling || !d.patch) return;      // potongan digit berputar tidak dipelajari
      if (d.label !== truth[i] || d.conf < 0.95) { model.learn(d.patch, truth[i]); added++; }
    });
    return added;
  }

  function learnFromReading() {
    if (mode !== 'ocr' || !result) return 0;   // input manual tanpa foto: tidak ada patch untuk dipelajari
    const fl = finalLabels(), fd = finalDecLabels();
    let added = 0;
    if (fl) added += learnDigits(result.digits, fl);
    if (fd) added += learnDigits(dec.digits, fd);
    if (added) model.save();
    return added;
  }

  $('btnSave').onclick = async () => {
    const customerId = $('customerId').value.trim();
    const finalReading = $('finalReading').value.trim();
    if (!customerId) return msg('saveMsg', 'ID Pelanggan wajib diisi.', 'err');
    // Relasi ke tabel Pelanggan: bila server SUDAH memastikan ID ini tidak terdaftar / nonaktif, jangan antrekan
    // data yang pasti ditolak. (Offline / belum dicek: tetap diantrekan, server yang memutuskan.)
    const fromQr = idMethod.startsWith('QR');   // ID dari scan QR: tanpa validasi (server membuat pelanggan bila perlu)
    if (!fromQr && custInfo[customerId] === null) return msg('saveMsg', `ID Pelanggan ${customerId} belum terdaftar di tabel Pelanggan. Periksa ID, atau minta admin mendaftarkannya lebih dulu.`, 'err');
    if (!fromQr && custInfo[customerId] && custInfo[customerId].aktif === false) return msg('saveMsg', `Pelanggan ${customerId} berstatus Nonaktif — pembacaan tidak bisa disimpan.`, 'err');
    if (!/^\d+$/.test(finalReading)) return msg('saveMsg', 'Angka final harus berupa angka.', 'err');
    const isManual = mode === 'manual';
    const finalDecimal = (dec || isManual) ? $('finalDecimal').value.trim() : '';
    if (!/^\d*$/.test(finalDecimal)) return msg('saveMsg', 'Desimal harus berupa angka.', 'err');
    if (isManual && !$('manualReason').value) {
      $('manualReason').focus();
      return msg('saveMsg', 'Pilih alasan input manual dulu.', 'err');
    }
    if (!renderDoubt()) {
      $('doubtBox').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return msg('saveMsg', 'Hasil masih meragukan: koreksi digit, ketik angka manual, atau centang konfirmasi setelah mencocokkan dengan meter.', 'warn');
    }

    const btn = $('btnSave');
    btn.disabled = true; btn.textContent = 'Menyimpan…';
    const fl = finalLabels();
    const fd = finalDecLabels();
    const manuallyCorrected = isManual || !fl || fl.some((v, i) => v !== result.digits[i].label) ||
      (dec && (!fd || fd.some((v, i) => v !== dec.digits[i].label)));
    const doubts = digitDoubts();
    const inputMethod = isManual ? 'MANUAL'
      : manualEdited ? 'OCR + ketik manual'
      : corrected.some(Boolean) ? 'OCR + koreksi digit'
      : result && result.digits.some((d) => d.priorChanged) ? 'OCR + acuan bulan lalu'
      : $('confirmOk').checked ? 'OCR (dikonfirmasi petugas)' : 'OCR';
    const manualReason = isManual ? $('manualReason').value
      : manualEdited ? 'Hasil OCR salah / meragukan' : '';
    const record = {
          clientId: newId(),
          createdAt: new Date().toISOString(),
          customerId,
          officer: me() ? me().nama : '',   // server memakai nama dari sesi login
          ocrDigits: result ? (result.priorApplied && result.priorApplied.ocrText ? result.priorApplied.ocrText : result.text) : '',
          uncertainDigits: result ? result.digits.filter((d) => d.rolling || d.conf < CONF_OK).map((d) => d.index + 1).join(',') : '',
          finalReading: String(Number(finalReading)),
          manuallyCorrected,
          confidence: result ? Math.round(result.minConf * 100) / 100 : '',
          notes: [all.some((d) => d.rolling) && 'ada roda berputar', anomaly && `dikonfirmasi: ${anomaly}`,
            doubts.length && !isManual && doubts.join('; ')].filter(Boolean).join(' | '),
          inputMethod,
          idMethod: idMethod || (me() && me().role === 'pelanggan' ? 'Akun pelanggan' : 'Manual'),
          manualReason,
          ocrDecimal: dec ? dec.text : '',
          finalDecimal,
          lat: coords?.lat, lng: coords?.lng,
          modelSamples: model.stats().total,
    };
    // SIMPAN INSTAN: data langsung masuk antrean di HP, lalu dikirim ke Sheet di latar belakang.
    // Petugas tidak perlu menunggu ±2-3 detik respons Apps Script dan bisa lanjut ke meter berikutnya.
    const n = outbox.add(record);
    const usage = last ? Number(finalReading) - Number(last.finalReading) : null;
    lastCache.set(customerId, { finalReading: Number(finalReading), timestamp: record.createdAt });
    const learned = learnFromReading();
    pendingSave = record.clientId;
    const extra = (usage !== null ? ` Pemakaian: ${usage} m³.` : '') + (learned ? ` Model belajar ${learned} digit baru.` : '');
    msg('saveMsg', navigator.onLine
      ? `✅ Tersimpan di HP.${extra} 🔄 Mengirim ke Google Sheet…`
      : `📴 Tersimpan di HP (offline).${extra} Dikirim otomatis saat online — antrean: ${n}.`, 'ok');
    btn.textContent = 'Tersimpan';
    flushOutbox();
  };
  let pendingSave = null;   // clientId pembacaan yang sedang tampil, untuk kabar "terkirim"
  function onSent(r) {
    if (r.clientId !== pendingSave) return;
    const box = $('saveMsg').querySelector('.msg');
    if (!box) return;
    box.textContent = box.textContent.replace(/🔄 Mengirim ke Google Sheet…|📴 .*$/, '') +
      (r.ok ? ' ☁️ Terkirim ke Google Sheet.' : ` ⚠️ Ditolak server: ${r.error}`);
    box.className = 'msg ' + (r.ok ? 'ok' : 'err');
  }

  $('btnReset').onclick = () => {
    resetForm();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (!$('customerId').readOnly) $('customerId').focus();
  };
  function resetForm() {
    srcCanvas = workCanvas = result = dec = null; all = []; nInt = 0; labels = []; corrected = []; last = null;
    setMode('ocr'); manualEdited = false; anomaly = '';
    setManualEnabled(false);
    $('finalReading').value = ''; $('finalDecimal').value = ''; $('manualReason').value = '';
    $('doubtBox').classList.add('hidden');
    $('cropCard').classList.add('hidden'); $('resultCard').classList.add('hidden');
    ['readMsg', 'saveMsg', 'compareMsg'].forEach((id) => msg(id, ''));
    const u = me();
    $('customerId').value = u && u.role === 'pelanggan' ? u.idMeter : '';
    resetIdSource();
    showCustomer();
  }

  // =====================================================================
  // Util
  // =====================================================================
  function getLocation() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (p) => { coords = { lat: p.coords.latitude, lng: p.coords.longitude }; },
      () => { coords = null; }, { enableHighAccuracy: true, timeout: 8000 });
  }
  function msg(id, text, type) {
    $(id).innerHTML = text ? `<div class="msg ${type || ''}">${esc(text)}</div>` : '';
  }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Hook untuk pengujian/debug dari console
  window.__meterApp = { model, applyCnn, outbox, flushOutbox,
    pendingFor: (username) => outbox.list().filter((x) => !x.owner || x.owner === username).length, read: (canvas, r, n, opts) => MeterOCR.read(canvas, r, n, model, opts) };

  // =====================================================================
  // PWA: service worker (cache offline) + banner pembaruan versi
  // =====================================================================
  function initPwa() {
    // Di dalam Apps Script (iframe googleusercontent) service worker tidak bisa dipasang
    if (MeterAuth.GAS || !('serviceWorker' in navigator) || location.protocol === 'file:') return;
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').then((reg) => {
      const showUpdate = (worker) => {
        $('updbar').classList.remove('hidden');
        $('btnUpdate').onclick = () => worker.postMessage('skipWaiting');
      };
      if (reg.waiting && hadController) showUpdate(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) showUpdate(w);
        });
      });
    }).catch((err) => console.warn('Service worker gagal didaftarkan:', err));
    // versi baru aktif -> muat ulang sekali (tidak pada pemasangan pertama)
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded) return;
      reloaded = true; location.reload();
    });
  }

  loadCfg();
  initCnn();
  initPwa();
  updateNetbar();
  // Login / ganti pengguna (dipanggil langsung bila sesi sudah tersimpan)
  MeterAuth.on('login', ({ user, changed }) => {
    if (changed) resetForm();          // pengguna lain di HP yang sama -> mulai dari form kosong
    applyRole(user);
    // petugas: siapkan pembaca QR di waktu luang (hanya HP tanpa pembaca bawaan, mis. iPhone)
    if (user.role !== 'pelanggan') (window.requestIdleCallback || ((f) => setTimeout(f, 3000)))(() => MeterQR.preload());
    updateNetbar();
    flushOutbox();
  });
  MeterAuth.on('logout', () => { resetForm(); applyRole(null); updateNetbar(); });
})();

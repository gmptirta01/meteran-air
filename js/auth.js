/**
 * MeterAuth — login, sesi, menu sidebar per peran, kelola pengguna (admin), pengaturan.
 *
 * Menu disembunyikan sesuai peran hanya untuk kenyamanan. Aturan akses yang sebenarnya diperiksa
 * SERVER pada setiap permintaan (apps-script/Auth.gs -> PERMISSIONS), jadi mengubah HTML/JS di HP
 * tidak memberi akses tambahan.
 *
 * API untuk js/app.js:
 *   MeterAuth.api(action, data)  -> Promise<json>   (error: e.network / e.auth / e.forbidden)
 *   MeterAuth.user()             -> {id, username, nama, role, idMeter} | null
 *   MeterAuth.on('login'|'logout'|'view', cb)
 */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const GAS = !!(window.google && google.script && google.script.run);
  const store = {
    get(k, d = '') { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  // hosting sendiri: URL server bawaan dari js/config.js bila HP ini belum pernah mengaturnya
  const cfg = window.METER_CONFIG || {};
  if (!GAS && cfg.serverUrl && !store.get('cfgUrl')) store.set('cfgUrl', cfg.serverUrl);
  const SESSION_KEY = 'session.v1';
  const VIEWS = { meter: 'Catat Meter', users: 'Pengguna', settings: 'Pengaturan' };
  // Sama dengan menu di server; dipakai untuk menampilkan menu saja
  const MENU = { admin: ['meter', 'users', 'settings'], operator: ['meter'], pelanggan: ['meter'] };

  let state = null;                       // { token, user }
  try { state = JSON.parse(store.get(SESSION_KEY, 'null')); } catch { state = null; }
  const handlers = { login: [], logout: [], view: [] };
  const emit = (ev, arg) => handlers[ev].forEach((f) => { try { f(arg); } catch (err) { console.error(err); } });
  let currentView = 'meter';

  // =====================================================================
  // API
  // =====================================================================
  async function api(action, data = {}) {
    const body = { action, ...data };
    if (action !== 'login') body.session = state && state.token;
    let json;
    if (GAS) {
      json = await new Promise((resolve, reject) => {
        google.script.run
          .withSuccessHandler(resolve)
          .withFailureHandler(() => { const e = new Error('Tidak ada koneksi ke server.'); e.network = true; reject(e); })
          .apiCall(body);
      });
    } else {
      const url = store.get('cfgUrl');
      if (!url) throw new Error('Isi URL server dulu.');
      let res;
      try {
        res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) });
      } catch { const e = new Error('Tidak ada koneksi ke server.'); e.network = true; throw e; }
      try { json = await res.json(); } catch { throw new Error(`Respons server tidak valid (HTTP ${res.status}).`); }
    }
    if (!json || !json.ok) {
      const e = new Error((json && json.error) || 'Gagal');
      if (json && json.auth) { e.auth = true; if (action !== 'logout') sessionLost(); }
      if (json && json.forbidden) e.forbidden = true;
      throw e;
    }
    return json;
  }

  function setSession(token, user) {
    state = { token, user };
    store.set(SESSION_KEY, JSON.stringify(state));
    store.set('lastUser', user.username);
  }

  // =====================================================================
  // Login / logout
  // =====================================================================
  function showLogin(note, type) {
    $('shell').classList.add('hidden');
    $('loginView').classList.remove('hidden');
    $('serverBox').classList.toggle('hidden', GAS);
    $('cfgUrl').value = store.get('cfgUrl');
    if (!GAS && !store.get('cfgUrl')) $('serverBox').open = true;
    $('loginUser').value = (state && state.user && state.user.username) || store.get('lastUser');
    $('loginPass').value = '';
    msg('loginMsg', note || '', type);
    setTimeout(() => ($('loginUser').value ? $('loginPass') : $('loginUser')).focus(), 50);
  }

  function showShell() {
    $('loginView').classList.add('hidden');
    $('shell').classList.remove('hidden');
    applyUser();
    go(location.hash.slice(1) || currentView, true);
  }

  /** Sesi kedaluwarsa / dicabut admin: minta login ulang tanpa membuang pekerjaan yang sedang dibuka */
  function sessionLost() {
    if (!state) return;
    state = { token: null, user: state.user };
    store.set(SESSION_KEY, JSON.stringify(state));
    showLogin('Sesi berakhir atau akun diubah admin. Silakan login lagi — data yang belum terkirim tetap aman di HP ini.', 'warn');
  }

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('loginUser').value.trim(), password = $('loginPass').value;
    if (!GAS) store.set('cfgUrl', $('cfgUrl').value.trim());
    if (!username || !password) return msg('loginMsg', 'Isi username dan password.', 'err');
    const btn = $('btnLogin');
    btn.disabled = true; btn.textContent = 'Memeriksa…';
    try {
      const prev = state && state.user;
      const r = await api('login', { username, password });
      setSession(r.session, r.user);
      $('loginPass').value = '';
      msg('loginMsg', '');
      showShell();
      emit('login', { user: r.user, changed: !prev || prev.id !== r.user.id });
    } catch (err) {
      msg('loginMsg', err.network ? 'Tidak ada koneksi. Login butuh internet (setelah login, aplikasi bisa dipakai offline).' : err.message, 'err');
    } finally {
      btn.disabled = false; btn.textContent = 'Masuk';
    }
  });

  $('btnLogout').onclick = async () => {
    const pending = window.__meterApp ? window.__meterApp.pendingFor(state.user.username) : 0;
    if (pending && !confirm(`Masih ada ${pending} data Anda yang belum terkirim. Data tetap tersimpan di HP ini dan dikirim saat Anda login lagi.\n\nTetap keluar?`)) return;
    const token = state && state.token;
    state = null;
    store.del(SESSION_KEY);
    if (token) api('logout', { session: token }).catch(() => {});
    emit('logout');
    closeDrawer();
    showLogin('Anda sudah keluar.', 'ok');
  };

  // =====================================================================
  // Sidebar & navigasi
  // =====================================================================
  function applyUser() {
    const u = state.user;
    $('whoName').textContent = u.nama;
    $('whoAvatar').textContent = (u.nama || u.username || '?').trim().charAt(0).toUpperCase();
    for (const el of [$('whoRole'), $('topRole')]) { el.textContent = u.role; el.className = 'chip ' + u.role; }
    document.querySelectorAll('#nav a').forEach((a) => {
      a.classList.toggle('hidden', !a.dataset.roles.split(',').includes(u.role));
    });
  }

  function go(view, replace) {
    const allowed = MENU[state.user.role] || ['meter'];
    if (!VIEWS[view] || !allowed.includes(view)) view = 'meter';
    currentView = view;
    Object.keys(VIEWS).forEach((v) => $('view-' + v).classList.toggle('hidden', v !== view));
    document.querySelectorAll('#nav a').forEach((a) => {
      a.classList.toggle('active', a.dataset.view === view);
      if (a.dataset.view === view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    $('viewTitle').textContent = VIEWS[view];
    if (location.hash.slice(1) !== view) history[replace ? 'replaceState' : 'pushState'](null, '', '#' + view);
    closeDrawer();
    if (view === 'users') loadUsers();
    if (view === 'settings') renderSettings();
    emit('view', view);
  }
  document.querySelectorAll('#nav a').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); go(a.dataset.view); }));
  window.addEventListener('hashchange', () => { if (state && state.token) go(location.hash.slice(1), true); });

  function openDrawer() { $('sidebar').classList.add('open'); $('scrim').classList.remove('hidden'); }
  function closeDrawer() { $('sidebar').classList.remove('open'); $('scrim').classList.add('hidden'); }
  $('btnMenu').onclick = openDrawer;
  $('scrim').onclick = closeDrawer;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

  // Tampilkan / sembunyikan password (semua field .pw)
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.pw-toggle');
    if (!b) return;
    const inp = $(b.dataset.pw), show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    b.textContent = show ? '🙈' : '👁';
    b.setAttribute('aria-pressed', String(show));
    b.setAttribute('aria-label', show ? 'Sembunyikan password' : 'Tampilkan password');
    inp.focus();
  });

  // =====================================================================
  // Pengguna (admin)
  // =====================================================================
  let users = [];
  async function loadUsers(keepMsg) {
    if (!keepMsg) msg('usersMsg', 'Memuat pengguna…');
    try {
      users = (await api('users.list')).users;
      if (!keepMsg) msg('usersMsg', '');
      renderUsers();
    } catch (err) {
      msg('usersMsg', err.network ? 'Tidak ada koneksi — daftar pengguna butuh internet.' : err.message, 'err');
    }
  }
  $('btnReloadUsers').onclick = () => loadUsers();
  // Ribuan pelanggan: tampilkan bertahap & tunda pencarian sampai berhenti mengetik
  const PAGE = 50;
  let shown = PAGE, searchTimer = null;
  $('userSearch').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { shown = PAGE; renderUsers(); }, 200); };
  $('userRoleFilter').onchange = () => { shown = PAGE; renderUsers(); };

  function renderUsers() {
    const q = $('userSearch').value.trim().toLowerCase(), role = $('userRoleFilter').value;
    const count = (r) => users.filter((u) => u.role === r).length;
    $('userStats').innerHTML = [['Admin', 'admin'], ['Operator', 'operator'], ['Pelanggan', 'pelanggan']]
      .map(([t, r]) => `<div class="stat"><b>${count(r)}</b><span class="muted">${t}</span></div>`).join('');
    const list = users
      .filter((u) => !role || u.role === role)
      .filter((u) => !q || [u.nama, u.username, u.idMeter, u.alamat, u.email, u.noHp].join(' ').toLowerCase().includes(q))
      .sort((a, b) => ['admin', 'operator', 'pelanggan'].indexOf(a.role) - ['admin', 'operator', 'pelanggan'].indexOf(b.role) ||
        a.nama.localeCompare(b.nama, 'id'));
    const me = state.user.id;
    const total = list.length;
    $('userList').innerHTML = total ? list.slice(0, shown).map((u) => {
      const canEdit = u.role !== 'admin' || u.id === me;
      const canDel = u.role !== 'admin' && u.id !== me;
      const pel = u.role === 'pelanggan';
      const fmtDate = (t) => (t ? new Date(t).toLocaleDateString('id-ID') : '');
      return `<div class="user-item glass">
        <div class="avatar">${esc((u.nama || '?').charAt(0).toUpperCase())}</div>
        <div class="meta">
          <b>${esc(u.nama)}</b> <span class="chip ${u.role}">${u.role}</span>${u.aktif ? '' : ' <span class="chip off">nonaktif</span>'}${pel && !u.hasAccount ? ' <span class="chip">tanpa akun</span>' : ''}
          <div>${pel ? `ID <b>${esc(u.idMeter)}</b>${u.hasAccount ? ` · @${esc(u.username)}` : ''}` : `@${esc(u.username)}`}</div>
          ${pel ? `<div>${esc(u.alamat)}</div>` : ''}
          ${pel ? `<div>📈 ${u.count} pembacaan${u.lastReading !== null ? ` · terakhir <b>${u.lastReading}</b> m³ (${esc(fmtDate(u.lastAt))})` : ''}</div>` : ''}
          ${u.email || u.noHp ? `<div>${[u.email, u.noHp].filter(Boolean).map(esc).join(' · ')}</div>` : ''}
        </div>
        <div class="acts">
          ${canEdit ? `<button class="btn btn-ghost btn-inline" data-edit="${esc(u.id)}" type="button">✏️ Edit</button>` : ''}
          ${canDel ? `<button class="btn btn-danger btn-inline" data-del="${esc(u.id)}" type="button">🗑️ Hapus</button>` : ''}
        </div>
      </div>`;
    }).join('') + (total > shown ? `<button class="btn btn-ghost" id="btnMoreUsers" type="button">Tampilkan lebih banyak (${shown} dari ${total})</button>` : '')
      : '<p class="muted" style="text-align:center">Tidak ada pengguna yang cocok.</p>';
  }
  $('userList').addEventListener('click', (e) => {
    if (e.target.id === 'btnMoreUsers') { shown += PAGE; renderUsers(); return; }
    const ed = e.target.closest('[data-edit]'), del = e.target.closest('[data-del]');
    if (ed) openUserDialog(users.find((u) => u.id === ed.dataset.edit));
    if (del) deleteUser(users.find((u) => u.id === del.dataset.del));
  });
  $('btnAddOperator').onclick = () => openUserDialog(null, 'operator');
  $('btnAddPelanggan').onclick = () => openUserDialog(null, 'pelanggan');

  let editing = null, usernameTouched = false;
  function openUserDialog(u, role) {
    editing = u || null;
    usernameTouched = !!u;
    const r = u ? u.role : role;
    $('userDlgTitle').textContent = u ? `Edit ${u.nama}` : `Tambah ${r === 'pelanggan' ? 'Pelanggan' : 'Operator'}`;
    $('uRole').value = r === 'admin' ? 'operator' : r;
    $('uRole').disabled = r === 'admin';
    $('uRole').classList.toggle('hidden', r === 'admin');
    document.querySelector('label[for=uRole]').classList.toggle('hidden', r === 'admin');
    $('userDlgNote').textContent = r === 'admin' ? 'Akun admin: peran & status tidak bisa diubah dari aplikasi.' : '';
    $('uMeter').value = u ? u.idMeter : '';
    $('uNama').value = u ? u.nama : '';
    $('uAlamat').value = u ? u.alamat : '';
    $('uEmail').value = u ? u.email : '';
    $('uHp').value = u ? u.noHp : '';
    $('uUsername').value = u ? u.username : '';
    $('uPass').value = ''; $('uPass').type = 'password';
    const hasAcc = u ? (r === 'pelanggan' ? u.hasAccount : true) : true;
    $('uPassLabel').textContent = u && hasAcc ? 'Password baru (kosongkan bila tidak diganti)' : 'Password * (min. 6 karakter)';
    $('uAkun').checked = hasAcc;
    // ID Pelanggan = kunci relasi dengan data pembacaan -> tidak bisa diubah setelah dibuat
    $('uMeter').readOnly = !!u;
    $('uMeterNote').textContent = u ? '(tidak bisa diubah)' : '';
    $('uAktifText').textContent = r === 'pelanggan' ? 'Pelanggan aktif (bisa dicatat & login)' : 'Akun aktif (bisa login)';
    $('uAktif').checked = u ? u.aktif : true;
    $('uAktifRow').classList.toggle('hidden', r === 'admin');
    $('btnUserDelete').classList.toggle('hidden', !u || u.role === 'admin' || u.id === state.user.id);
    msg('userDlgMsg', '');
    roleFields();
    $('userDialog').showModal();
    setTimeout(() => (r === 'pelanggan' && !u ? $('uMeter') : $('uNama')).focus(), 50);
  }
  function roleFields() {
    const pel = $('uRole').value === 'pelanggan' && !(editing && editing.role === 'admin');
    $('uPelangganFields').classList.toggle('hidden', !pel);
    $('uPelangganFields2').classList.toggle('hidden', !pel);
    $('uAkunRow').classList.toggle('hidden', !pel);
    $('uLoginFields').classList.toggle('hidden', pel && !$('uAkun').checked);
  }
  $('uRole').onchange = roleFields;
  $('uAkun').onchange = () => {
    roleFields();
    if ($('uAkun').checked && !$('uUsername').value) $('uUsername').value = $('uMeter').value.trim();
  };
  // Pelanggan: username default = ID meter (masih bisa diubah)
  $('uMeter').oninput = () => { if (!usernameTouched) $('uUsername').value = $('uMeter').value.trim().toUpperCase(); };
  $('uUsername').oninput = () => { usernameTouched = true; };
  $('btnUserCancel').onclick = () => $('userDialog').close();

  $('userForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const role = editing && editing.role === 'admin' ? 'admin' : $('uRole').value;
    const data = {
      role, username: $('uUsername').value.trim(), nama: $('uNama').value.trim(),
      idMeter: $('uMeter').value.trim(), alamat: $('uAlamat').value.trim(),
      email: $('uEmail').value.trim(), noHp: $('uHp').value.trim(),
      aktif: $('uAktif').checked, password: $('uPass').value,
      akun: role !== 'pelanggan' || $('uAkun').checked,
    };
    const needPw = data.akun && (!editing || (role === 'pelanggan' && !editing.hasAccount));
    // Cek cepat di HP (server tetap memvalidasi ulang)
    const err = !data.nama ? 'Nama wajib diisi.'
      : role === 'pelanggan' && !data.idMeter ? 'ID Meter wajib diisi.'
      : role === 'pelanggan' && !data.alamat ? 'Alamat wajib diisi.'
      : data.akun && !/^[A-Za-z0-9._-]{3,32}$/.test(data.username) ? 'Username 3–32 karakter: huruf, angka, titik, minus, garis bawah.'
      : data.akun && (needPw || data.password) && data.password.length < 6 ? 'Password minimal 6 karakter.'
      : role === 'pelanggan' && data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email) ? 'Format email tidak valid.'
      : '';
    if (err) return msg('userDlgMsg', err, 'err');
    const btn = $('btnUserSave');
    btn.disabled = true; btn.textContent = 'Menyimpan…';
    try {
      const r = editing ? await api('users.update', { id: editing.id, user: data }) : await api('users.create', { user: data });
      if (r.session) { setSession(r.session, r.self); applyUser(); }
      $('userDialog').close();
      msg('usersMsg', editing ? `✅ ${r.user.nama} diperbarui.` + (data.password ? ' Password diganti — pengguna perlu login ulang.' : '')
        : `✅ ${r.user.role === 'pelanggan' ? 'Pelanggan' : 'Operator'} ${r.user.nama} dibuat.` + (data.akun ? ` Username: ${data.username}` : ' (tanpa akun login)'), 'ok');
      await loadUsers(true);
    } catch (er) {
      msg('userDlgMsg', er.network ? 'Tidak ada koneksi.' : er.message, 'err');
    } finally {
      btn.disabled = false; btn.textContent = 'Simpan';
    }
  });
  $('btnUserDelete').onclick = () => { const u = editing; $('userDialog').close(); deleteUser(u); };

  async function deleteUser(u) {
    if (!u) return;
    // Pelanggan yang sudah punya pembacaan: hapus BESERTA pembacaannya (dipindah ke sheet "Arsip Pembacaan").
    // Wajib ketik ulang ID — untuk data uji / ID salah ketik. Pelanggan nyata cukup dinonaktifkan lewat Edit.
    if (u.role === 'pelanggan' && u.count > 0) {
      const typed = prompt(`Pelanggan "${u.nama}" (ID ${u.idMeter}) punya ${u.count} data pembacaan.\n\n` +
        `Menghapus pelanggan ini juga MEMINDAHKAN semua pembacaannya ke sheet "Arsip Pembacaan" ` +
        `(tidak lagi dihitung di aplikasi; bisa dikembalikan manual dari sheet itu).\n` +
        `Bila pelanggan ini nyata dan hanya berhenti berlangganan, batalkan lalu Edit → nonaktifkan.\n\n` +
        `Ketik ID ${u.idMeter} untuk melanjutkan:`);
      if (typed === null) return;
      if (typed.trim() !== u.idMeter) return msg('usersMsg', 'ID yang diketik tidak cocok — pelanggan tidak dihapus.', 'warn');
      try {
        const r = await api('users.delete', { id: u.id, cascade: true, confirm: typed.trim() });
        msg('usersMsg', `🗑️ Pelanggan ${u.idMeter} dihapus; ${r.archived} pembacaan dipindah ke sheet "Arsip Pembacaan".`, 'ok');
        await loadUsers(true);
      } catch (err) {
        msg('usersMsg', err.network ? 'Tidak ada koneksi.' : err.message, 'err');
      }
      return;
    }
    const what = u.role === 'pelanggan' ? `pelanggan "${u.nama}" (ID ${u.idMeter}) dari tabel Pelanggan` : `${u.role} "${u.nama}" (@${u.username})`;
    if (!confirm(`Hapus ${what}?\n\nAkun loginnya juga dihapus. Data pembacaan meter yang sudah tersimpan TIDAK ikut terhapus.`)) return;
    try {
      await api('users.delete', { id: u.id });
      msg('usersMsg', `🗑️ ${u.nama} dihapus.`, 'ok');
      await loadUsers(true);
    } catch (err) {
      msg('usersMsg', err.network ? 'Tidak ada koneksi.' : err.message, 'err');
    }
  }

  // =====================================================================
  // Pengaturan (admin)
  // =====================================================================
  function renderSettings() {
    $('serverInfo').textContent = GAS
      ? '✅ Aplikasi dibuka langsung dari Google Apps Script — terhubung otomatis, tidak perlu URL.'
      : 'Aplikasi di-hosting di luar Apps Script (PWA). Data dikirim ke URL Web App di bawah.';
    $('serverUrlRow').classList.toggle('hidden', GAS);
    $('cfgUrl2').value = store.get('cfgUrl');
    loadExportMonths();
  }
  // ---------------------------------------------------------------- Ekspor Excel per bulan (admin)
  const BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  const monthLabel = (m) => `${BULAN[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
  // Daftar bulan disimpan 2 menit: membuka menu Pengaturan berulang tidak memanggil server tiap kali
  let monthsCache = null;
  async function loadExportMonths(force) {
    const sel = $('expMonth');
    try {
      const fresh = !force && monthsCache && Date.now() - monthsCache.at < 2 * 60 * 1000;
      const keep = sel.value;
      const r = fresh ? monthsCache.r : await api('readings.export');
      if (!fresh) monthsCache = { at: Date.now(), r };
      sel.innerHTML = r.months.length
        ? r.months.map((m) => `<option value="${esc(m.month)}">${esc(monthLabel(m.month))} — ${m.count} pembacaan</option>`).join('')
        : '<option value="">Belum ada data pembacaan</option>';
      $('btnExportXlsx').disabled = !r.months.length;
      if (keep && r.months.some((m) => m.month === keep)) sel.value = keep;
    } catch (err) {
      sel.innerHTML = '<option value="">Gagal memuat daftar bulan</option>';
      msg('exportMsg', err.network ? 'Tidak ada koneksi — ekspor butuh internet.' : err.message, 'err');
    }
  }
  /** "yyyy-MM-dd HH:mm:ss" (zona waktu spreadsheet) -> Date dengan komponen yang sama (Excel menampilkan apa adanya) */
  const parseLocal = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s || '');
    return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : (s || '');
  };
  $('btnExportXlsx').onclick = async () => {
    const month = $('expMonth').value;
    if (!month) return;
    const btn = $('btnExportXlsx');
    btn.disabled = true; btn.textContent = 'Menyiapkan…';
    msg('exportMsg', '');
    try {
      const r = await api('readings.export', { month });
      const rows = r.rows.map((row) => row.map((v, i) => (r.dateCols.includes(i) ? parseLocal(v) : v)));
      // Ringkasan per pelanggan (relasi Pelanggan -> Pembacaan)
      const by = {};
      rows.forEach((x) => {
        const g = by[x[1]] || (by[x[1]] = { id: x[1], nama: x[2], alamat: x[3], n: 0, first: x, last: x, usage: 0 });
        g.n++;
        if (x[0] < g.first[0]) g.first = x;
        if (x[0] >= g.last[0]) g.last = x;
        if (typeof x[8] === 'number') g.usage += x[8];
      });
      const summary = [['ID Pelanggan', 'Nama Pelanggan', 'Alamat', 'Jumlah Pembacaan', 'Pembacaan Pertama (m3)', 'Tanggal Pertama',
        'Pembacaan Terakhir (m3)', 'Tanggal Terakhir', 'Total Pemakaian (m3)']]
        .concat(Object.values(by).sort((a, b) => String(a.id).localeCompare(String(b.id), 'id', { numeric: true }))
          .map((g) => [g.id, g.nama, g.alamat, g.n, g.first[5], g.first[0], g.last[5], g.last[0], g.usage]));
      const blob = await MeterXlsx.build([
        { name: 'Pembacaan', rows: [r.headers].concat(rows),
          widths: [17, 14, 24, 30, 11, 10, 12, 11, 11, 26, 24, 26, 10, 12, 10, 10, 11, 30, 11, 11, 17, 38] },
        { name: 'Ringkasan', rows: summary, widths: [14, 24, 30, 11, 14, 17, 14, 17, 14] },
      ]);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `pembacaan-meter-${month}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      msg('exportMsg', `✅ ${a.download}: ${rows.length} pembacaan, ${summary.length - 1} pelanggan (${monthLabel(month)}).`, 'ok');
    } catch (err) {
      msg('exportMsg', err.network ? 'Tidak ada koneksi — ekspor butuh internet.' : err.message, 'err');
    } finally {
      btn.disabled = false; btn.textContent = '⬇️ Unduh Excel';
    }
  };

  $('btnSaveUrl').onclick = () => {
    store.set('cfgUrl', $('cfgUrl2').value.trim());
    msg('settingsMsg', 'URL disimpan.', 'ok');
  };

  // =====================================================================
  // Ganti password (semua peran)
  // =====================================================================
  $('btnChangePw').onclick = () => {
    $('pwOld').value = ''; $('pwNew').value = ''; msg('pwMsg', '');
    $('pwDialog').showModal();
    setTimeout(() => $('pwOld').focus(), 50);
  };
  $('btnPwCancel').onclick = () => $('pwDialog').close();
  $('pwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const oldPassword = $('pwOld').value, newPassword = $('pwNew').value;
    if (newPassword.length < 6) return msg('pwMsg', 'Password baru minimal 6 karakter.', 'err');
    const btn = $('btnPwSave');
    btn.disabled = true;
    try {
      const r = await api('changePassword', { oldPassword, newPassword });
      setSession(r.session, r.user);
      $('pwDialog').close();
      closeDrawer();
    } catch (err) {
      msg('pwMsg', err.network ? 'Tidak ada koneksi.' : err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  });

  // =====================================================================
  // Util
  // =====================================================================
  function msg(id, text, type) {
    $(id).innerHTML = text ? `<div class="msg ${type || ''}" role="status">${esc(text)}</div>` : '';
  }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  window.MeterAuth = {
    GAS,
    api,
    user: () => (state && state.token ? state.user : null),
    on(ev, cb) {
      handlers[ev].push(cb);
      if (ev === 'login' && state && state.token) cb({ user: state.user, changed: true });   // sesi sudah ada saat dimuat
    },
  };

  // =====================================================================
  // Mulai: sesi tersimpan -> langsung masuk (bisa offline); diperiksa ke server di latar belakang
  // =====================================================================
  if (state && state.token) {
    showShell();
    if (navigator.onLine) {
      api('me').then((r) => {
        if (JSON.stringify(r.user) !== JSON.stringify(state.user)) { setSession(state.token, r.user); applyUser(); go(currentView, true); }
      }).catch(() => {});   // sesi tidak sah -> sessionLost() sudah menampilkan login
    }
  } else {
    showLogin();
  }
})();

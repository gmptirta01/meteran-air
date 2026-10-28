/**
 * Konfigurasi hosting sendiri (GitHub Pages / PWA).
 * serverUrl: URL Web App Apps Script (/exec). Terisi otomatis di halaman login HP yang belum pernah diatur,
 * jadi petugas tidak perlu mengetik URL panjang. Tetap bisa diganti di halaman login / Pengaturan.
 * URL ini bukan rahasia (akses tetap lewat login), tetapi ikut terlihat bila repositori publik.
 * Diabaikan bila aplikasi dibuka dari URL Apps Script.
 */
window.METER_CONFIG = {
  serverUrl: 'https://script.google.com/macros/s/AKfycbwH0FvihGKD4qynp2ALoK4CnwOR9UtS84FH7cM3nsSoxOXNrrCIJE2yqHYRpOf3dGRb/exec',
};

# Dynamic Island untuk Linux

Pil hitam melayang di tengah-atas layar (terinspirasi Dynamic Island-nya
iPhone) yang melebar/menyusut mengikuti kejadian di desktop. Animasinya
memakai **fisika pegas (spring)** yang disinkronkan ke frame clock layar —
ada pantulan halus khas Dynamic Island setiap berganti ukuran, dan radius
sudutnya ikut bergerak (pil penuh ↔ panel membulat).

## Fitur

| Kejadian | Tampilan |
|---|---|
| Idle | Jam + tanggal (atau sisa timer bila berjalan) |
| Musik/video diputar (Spotify, VLC, browser, dll. via MPRIS) | Album art + judul/artis + **progress bar** + tombol prev / play-pause / next |
| Notifikasi masuk (semua aplikasi) | Ikon + nama aplikasi + ringkasan, tampil ±5 detik; 5 terakhir tersimpan di panel |
| Rekam layar aktif (OBS, wf-recorder, Kooha, SimpleScreenRecorder, ffmpeg x11grab, dll.) | Titik merah + durasi perekaman |
| Timer berjalan | Chip hitung mundur emas di samping jam; pil memberi tahu saat waktu habis |
| Charger dicolok/dilepas | Info baterai sesaat; **peringatan baterai lemah ≤ 20%** |
| Klik pil | Panel: media, baterai, status rekaman, preset timer (1/5/10/25 mnt), riwayat notifikasi |
| Klik kanan pil | Keluar |

## Cara menjalankan (Zorin / Ubuntu / Debian)

1. Pasang dependensi:

   ```bash
   sudo apt install python3-gi gir1.2-gtk-3.0 python3-gi-cairo
   ```

2. Jalankan:

   ```bash
   python3 dynamic_island.py
   ```

   Dengan timer langsung berjalan (format `10m`, `90`, `1:30`):

   ```bash
   python3 dynamic_island.py --timer 10m
   ```

Tanpa compile, tanpa layanan tambahan.

## Autostart saat login

Salin `dynamic-island.desktop` ke `~/.config/autostart/` lalu sesuaikan
baris `Exec=` dengan lokasi folder ini, contoh:

```ini
Exec=python3 /home/namauser/dynamic-island-linux/dynamic_island.py
```

## Catatan X11 vs Wayland

Fitur penuh (posisi tengah-atas + selalu di atas jendela lain) bekerja di
**sesi X11**, yang merupakan sesi bawaan Zorin. Di **Wayland**, aturan
keamanannya tidak mengizinkan aplikasi mengatur posisi jendelanya sendiri,
jadi pil tampil sebagai jendela melayang biasa — fungsinya tetap jalan
(jam, media, notifikasi, panel), hanya penempatannya diatur compositor.
Untuk pengalaman paling mirip aslinya, pakai sesi X11
(di layar login Zorin: klik ikon roda gigi → pilih sesi Xorg/X11).

**Alternatif Wayland tanpa ganti sesi:** gunakan versi ekstensi GNOME
Shell di folder `gnome-extension/` — pilnya hidup di dalam UI shell,
jadi posisinya terkunci di tengah-atas juga di Wayland.
Lihat `gnome-extension/README.md` untuk cara pasangnya.

## Cara kerja singkat

- **Animasi**: dua pegas (lebar & tinggi; kekakuan 210, redaman 21 —
  sedikit *underdamped* sehingga memantul lembut) digerakkan oleh
  *tick callback* frame clock GTK, jadi mengikuti refresh rate layar.
  Latar pil digambar dengan Cairo di sinyal `draw` jendela: bayangan
  lembut + radius yang dihitung dari tinggi saat itu juga.
- **Notifikasi**: aplikasi menjadi *monitor* D-Bus
  (`org.freedesktop.DBus.Monitoring.BecomeMonitor`) di **koneksi terpisah**
  dan mendengarkan panggilan `Notify` — daemon notifikasi bawaan (GNOME)
  tetap yang menampilkan notifikasi aslinya; program ini hanya ikut
  membaca. (Koneksi monitor tidak boleh mengirim pesan apa pun, karena
  itu wajib dipisah dari koneksi utama.)
- **Media**: D-Bus MPRIS (`org.mpris.MediaPlayer2.*`) — metadata dibaca
  via `GetAll`, posisi dipoll via `Properties.Get` (spesifikasi MPRIS
  tidak memperbarui `Position` otomatis), kontrol putar dari pil.
- **Baterai**: UPower (`org.freedesktop.UPower`) di bus sistem.
- **Rekam layar**: pemindaian berkala `/proc` untuk proses perekam yang
  dikenal + ffmpeg dengan encoder `x11grab`/`pipewire`.

## Batasan saat ini

- Satu monitor (monitor utama).
- Notifikasi hanya ditampilkan, belum bisa diklik untuk membuka aplikasinya.
- Deteksi rekam layar berbasis nama proses (bukan API compositor).

## Roadmap ide lanjutan

- Indikator mikrofon/kamera sedang dipakai
- Progres unduhan/transfer file
- Dukungan multi-monitor & tema terang/gelap mengikuti sistem
- Paket `.deb` / Flatpak

## Lisensi

Bebas dipakai dan dimodifikasi untuk keperluan pribadi.

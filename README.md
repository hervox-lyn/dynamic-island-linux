# Dynamic Island untuk Linux — MVP

Pil hitam melayang di tengah-atas layar (terinspirasi Dynamic Island-nya
iPhone) yang melebar dengan animasi halus mengikuti kejadian di desktop:

| Kejadian | Tampilan |
|---|---|
| Idle | Jam + tanggal |
| Musik/video diputar (Spotify, VLC, browser, dll. via MPRIS) | Judul + artis + tombol prev / play-pause / next |
| Notifikasi masuk (semua aplikasi) | Nama aplikasi + ringkasan + isi, tampil ±5 detik |
| Charger dicolok/dilepas | Info baterai sesaat |
| Klik pil | Panel: media, baterai, notifikasi terakhir |
| Klik kanan pil | Keluar |

## Cara menjalankan (Zorin / Ubuntu / Debian)

1. Pasang dependensi:

   ```bash
   sudo apt install python3-gi gir1.2-gtk-3.0
   ```

2. Jalankan:

   ```bash
   python3 dynamic_island.py
   ```

Itu saja — tanpa compile, tanpa layanan tambahan.

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

## Cara kerja singkat

- **Notifikasi**: aplikasi menjadi *monitor* D-Bus
  (`org.freedesktop.DBus.Monitoring.BecomeMonitor`) dan mendengarkan
  panggilan `Notify` — daemon notifikasi bawaan (GNOME) tetap yang
  menampilkan notifikasi aslinya, program ini hanya ikut membaca.
- **Media**: D-Bus MPRIS (`org.mpris.MediaPlayer2.*`), termasuk kontrol
  putar dari pil.
- **Baterai**: UPower (`org.freedesktop.UPower`) di bus sistem.
- **Animasi**: interpolasi ukuran jendela dengan easing *ease-out cubic*
  ±200 ms, crossfade antar-halaman via `GtkStack`.

## Batasan MVP

- Satu monitor (monitor utama).
- Notifikasi hanya ditampilkan, belum bisa diklik untuk membuka aplikasinya.
- Riwayat notifikasi di panel hanya yang terakhir; belum ada antrean.

## Roadmap ide lanjutan

- Timer / stopwatch yang berjalan di pil
- Indikator perekaman layar & mikrofon/kamera aktif
- Progres transfer file / unduhan
- Antrean notifikasi (geser untuk notifikasi berikutnya)
- Dukungan multi-monitor & tema terang/gelap mengikuti sistem
- Paket `.deb` / Flatpak

## Lisensi

Bebas dipakai dan dimodifikasi untuk keperluan pribadi.

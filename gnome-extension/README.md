# Versi ekstensi GNOME Shell (untuk Wayland)

Di **Wayland**, aplikasi biasa tidak diizinkan mengatur posisi
jendelanya sendiri — karena itu pil GTK akan ditaruh compositor di
tengah layar. Folder ini berisi versi **ekstensi GNOME Shell**:
pilnya hidup di dalam UI shell itu sendiri, jadi posisinya terkunci
di **tengah-atas** persis, di Wayland maupun X11, dengan fitur yang
sama (jam, media MPRIS + album art + progress, notifikasi, timer,
indikator rekam layar, baterai, panel klik).

## Pasang

Dari folder repo ini:

```bash
cp -r gnome-extension/dynamic-island@hervox-lyn ~/.local/share/gnome-shell/extensions/
```

Di **Wayland**: logout lalu login lagi sekali (shell tidak bisa
di-restart di tengah sesi Wayland — ekstensi baru hanya terbaca saat
login). Setelah itu aktifkan:

```bash
gnome-extensions enable dynamic-island@hervox-lyn
```

Cek status:

```bash
gnome-extensions info dynamic-island@hervox-lyn
```

## Pakai

- Klik pil → panel (media, baterai, rekaman, preset timer, riwayat notifikasi)
- Klik kanan → tutup panel
- Matikan: `gnome-extensions disable dynamic-island@hervox-lyn`
- Hapus: hapus folder `~/.local/share/gnome-shell/extensions/dynamic-island@hervox-lyn`

Kompatibilitas: GNOME Shell **45/46** (Zorin OS 18 memakai GNOME 46).

Catatan: versi GTK (`dynamic_island.py`) dan ekstensi ini jangan
dijalankan bersamaan — pilnya akan dobel.

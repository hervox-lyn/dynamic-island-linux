#!/usr/bin/env python3
"""
Dynamic Island untuk Linux — v2 (overlay GTK)
==============================================
Pil hitam melayang di tengah-atas layar yang melebar/menyusut dengan
animasi FISIKA PEGAS (spring) ala Dynamic Island — ada pantulan halus
saat berganti ukuran, radius sudut ikut bergerak.

State (prioritas dari atas):
  * Panel (klik pil)  -> media + baterai + kontrol timer + riwayat notif
  * Notifikasi masuk  -> aplikasi + ikon + ringkasan (±5 detik), dari
                         monitor D-Bus (daemon bawaan TIDAK digantikan)
  * Rekam layar aktif -> titik merah + durasi perekaman
  * Musik diputar     -> album art + judul/artis + progress bar + tombol
                         prev / play-pause / next (MPRIS)
  * Idle              -> jam + tanggal (atau sisa timer bila berjalan)

Lainnya: peringatan baterai lemah (<=20%), info colok/lepas charger,
timer hitung mundur (preset di panel atau --timer 5m / --timer 90).

Butuh: python3-gi, GTK 3 (gir1.2-gtk-3.0). Fitur penuh di sesi X11
(posisi + always-on-top); di Wayland jendela tetap jalan sebagai
jendela melayang biasa (Wayland tak mengizinkan aplikasi mengatur
posisi jendelanya sendiri).

Jalankan:  python3 dynamic_island.py [--timer 10m]
Keluar:    klik kanan pada pil, atau Ctrl+C di terminal.
"""

import os
import re
import sys
import time
from datetime import datetime

import cairo
import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("GdkPixbuf", "2.0")
from gi.repository import Gdk, GdkPixbuf, Gio, GLib, Gtk  # noqa: E402

# ---------------------------------------------------------------------------
# Ukuran tiap state (lebar, tinggi) — termasuk ruang bayangan di sekeliling
# ---------------------------------------------------------------------------
SHADOW = 10
SIZES = {
    "clock": (216, 58),
    "media": (424, 76),
    "notify": (446, 80),
    "recording": (300, 60),
    "panel": (452, 372),
}
RADIUS = {"panel": 30}          # state lain: pil penuh (radius = tinggi/2)
TOP_MARGIN = 6
NOTIFY_SHOW_S = 5
LOW_BATT_PCT = 20
RECORDER_NAMES = {"obs", "simplescreenrecorder", "kooha", "vokoscreenNG",
                  "vokoscreen", "wf-recorder", "byzanz-record"}

CSS = b"""
window { background: transparent; }
.island-text { color: #f5f5f5; }
.clock-time { font-size: 17px; font-weight: bold; color: #f5f5f5; }
.clock-date { font-size: 11px; color: #b9bec9; }
.timer-chip { font-size: 12px; font-weight: bold; color: #e8b84b; }
.media-title { font-size: 13px; font-weight: bold; color: #f5f5f5; }
.media-artist { font-size: 11px; color: #b9bec9; }
.notify-app { font-size: 11px; color: #e8b84b; font-weight: bold; }
.notify-summary { font-size: 13px; font-weight: bold; color: #f5f5f5; }
.notify-body { font-size: 11px; color: #b9bec9; }
.rec-text { font-size: 13px; font-weight: bold; color: #f5f5f5; }
.rec-dot { font-size: 13px; color: #ff453a; }
.panel-heading { font-size: 11px; color: #e8b84b; font-weight: bold; }
.panel-text { font-size: 12px; color: #f5f5f5; }
.panel-dim { font-size: 11px; color: #b9bec9; }
.ctl-btn {
    background: rgba(255, 255, 255, 0.10);
    border: none; border-radius: 999px;
    color: #ffffff; min-width: 30px; min-height: 30px;
    font-size: 13px; padding: 0 8px;
}
.ctl-btn:hover { background: rgba(255, 255, 255, 0.22); }
.preset-btn {
    background: rgba(255, 255, 255, 0.10);
    border: none; border-radius: 10px;
    color: #ffffff; font-size: 12px; padding: 5px 10px;
}
.preset-btn:hover { background: rgba(232, 184, 75, 0.35); }
progressbar trough { background: rgba(255,255,255,0.15); border-radius: 3px;
    min-height: 4px; border: none; }
progressbar progress { background: #e8b84b; border-radius: 3px; min-height: 4px;
    border: none; }
"""


def fmt_hms(seconds: float) -> str:
    seconds = max(0, int(seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def parse_timer_arg(argv):
    """--timer 10m | --timer 90 | --timer 1:30 -> detik (atau None)."""
    for i, a in enumerate(argv):
        if a == "--timer" and i + 1 < len(argv):
            raw = argv[i + 1].strip().lower()
            m = re.fullmatch(r"(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?", raw)
            if ":" in raw:
                parts = [int(p) for p in raw.split(":")]
                return parts[0] * 60 + parts[1] if len(parts) == 2 else None
            if m and any(m.groups()):
                h, mi, s = (int(g) if g else 0 for g in m.groups())
                return h * 3600 + mi * 60 + s
    return None


# ---------------------------------------------------------------------------
# Fisika pegas: satu sumbu (dipakai untuk lebar, tinggi)
# ---------------------------------------------------------------------------
class Spring:
    def __init__(self, x, stiffness=210.0, damping=21.0):
        self.x = float(x)
        self.v = 0.0
        self.target = float(x)
        self.k = stiffness
        self.c = damping

    def set(self, target):
        self.target = float(target)

    def step(self, dt):
        force = -self.k * (self.x - self.target) - self.c * self.v
        self.v += force * dt
        self.x += self.v * dt
        settled = abs(self.x - self.target) < 0.1 and abs(self.v) < 1.0
        if settled:
            self.x, self.v = self.target, 0.0
        return not settled


class MediaPlayer:
    """Satu pemain media MPRIS (Spotify, VLC, browser, dll.)."""

    def __init__(self, bus_name, on_change):
        self.bus_name = bus_name
        self.on_change = on_change
        self.title = ""
        self.artist = ""
        self.status = "Stopped"
        self.art_url = ""
        self.length_us = 0
        self.position_us = 0
        self._pos_at = 0.0
        self.proxy = Gio.DBusProxy.new_for_bus_sync(
            Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, None, bus_name,
            "/org/mpris/MediaPlayer2", "org.mpris.MediaPlayer2.Player", None)
        self.proxy.connect("g-properties-changed", self._on_props)
        self.refresh()

    def refresh(self):
        """Baca semua properti pemain secara sinkron (GetAll) — cache proxy
        tidak selalu terisi saat pemain baru muncul."""
        try:
            conn = Gio.bus_get_sync(Gio.BusType.SESSION, None)
            res = conn.call_sync(
                self.bus_name, "/org/mpris/MediaPlayer2",
                "org.freedesktop.DBus.Properties", "GetAll",
                GLib.Variant("(s)", ("org.mpris.MediaPlayer2.Player",)),
                None, Gio.DBusCallFlags.NONE, 800, None)
            props = res.unpack()[0]
            self.status = props.get("PlaybackStatus", "Stopped") or "Stopped"
            meta = props.get("Metadata", {}) or {}
            self.title = meta.get("xesam:title", "") or ""
            artists = meta.get("xesam:artist", []) or []
            self.artist = ", ".join(artists) if isinstance(artists, list) else str(artists)
            self.art_url = meta.get("mpris:artUrl", "") or ""
            self.length_us = int(meta.get("mpris:length", 0) or 0)
            self.position_us = int(props.get("Position", 0) or 0)
            self._pos_at = time.monotonic()
        except Exception:
            pass
        self.on_change()

    def poll_position(self):
        """Position tidak diperbarui otomatis oleh spesifikasi — ambil manual
        lewat interface org.freedesktop.DBus.Properties secara eksplisit."""
        try:
            conn = Gio.bus_get_sync(Gio.BusType.SESSION, None)
            res = conn.call_sync(
                self.bus_name, "/org/mpris/MediaPlayer2",
                "org.freedesktop.DBus.Properties", "Get",
                GLib.Variant("(ss)", ("org.mpris.MediaPlayer2.Player", "Position")),
                None, Gio.DBusCallFlags.NONE, 300, None)
            self.position_us = int(res.unpack()[0])
            self._pos_at = time.monotonic()
        except Exception:
            pass

    def estimated_position(self):
        if self.status == "Playing":
            return self.position_us + (time.monotonic() - self._pos_at) * 1e6
        return self.position_us

    def _on_props(self, _proxy, _changed, _invalidated):
        self.refresh()

    def call(self, method):
        try:
            self.proxy.call_sync(method, None, Gio.DBusCallFlags.NONE, 500, None)
        except Exception:
            pass


class Island(Gtk.Window):
    def __init__(self, timer_seconds=None):
        super().__init__(type=Gtk.WindowType.TOPLEVEL)
        self.set_decorated(False)
        self.set_resizable(False)
        self.set_keep_above(True)
        self.set_skip_taskbar_hint(True)
        self.set_skip_pager_hint(True)
        self.set_type_hint(Gdk.WindowTypeHint.DOCK)
        self.set_default_size(40, 40)
        try:
            self.set_app_paintable(True)
            visual = self.get_screen().get_rgba_visual()
            if visual:
                self.set_visual(visual)
        except Exception:
            pass

        provider = Gtk.CssProvider()
        provider.load_from_data(CSS)
        Gtk.StyleContext.add_provider_for_screen(
            Gdk.Screen.get_default(), provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)

        # --- state ------------------------------------------------------------
        self.state = "clock"
        self.panel_open = False
        self.players = {}
        self.notify_history = []          # [(app, summary, body, ts)]
        self._notify_source = None
        self.battery_pct = None
        self.battery_state = None
        self._low_batt_warned = False
        self.timer_end = None             # monotonic deadline
        self.timer_total = 0
        self.rec_since = None
        self._tick_cb_id = None

        # --- pegas ukuran: mulai kecil -> memantul ke ukuran jam (pop-in) -----
        self.spring_w = Spring(48)
        self.spring_h = Spring(48)
        self._cur_size = (48, 48)

        self._build_ui()
        self._build_dbus()
        if timer_seconds:
            self._start_timer(timer_seconds)
        self._tick_slow()
        GLib.timeout_add(500, self._tick_slow)
        self._scan_recorders()
        GLib.timeout_add_seconds(3, self._scan_recorders)
        self.connect("button-press-event", self._on_click)
        self.add_events(Gdk.EventMask.BUTTON_PRESS_MASK)
        self.connect("destroy", Gtk.main_quit)
        self.show_all()
        self._set_state("clock", force=True)

    # ------------------------------------------------------------------ UI --
    def _build_ui(self):
        # Latar digambar langsung di sinyal draw jendela (di belakang anak) —
        # tanpa Gtk.Overlay, supaya ukuran jendela murni diatur animasi pegas.
        self.connect("draw", self._draw_bg)

        self.frame = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        self.frame.set_margin_start(SHADOW)
        self.frame.set_margin_end(SHADOW)
        self.frame.set_margin_top(SHADOW)
        self.frame.set_margin_bottom(SHADOW)
        self.add(self.frame)

        self.stack = Gtk.Stack()
        self.stack.set_hhomogeneous(False)
        self.stack.set_vhomogeneous(False)
        self.stack.set_transition_type(Gtk.StackTransitionType.CROSSFADE)
        self.stack.set_transition_duration(160)
        self.frame.pack_start(self.stack, True, True, 0)

        # --- halaman jam ---
        clock_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        clock_box.set_halign(Gtk.Align.CENTER)
        clock_box.set_valign(Gtk.Align.CENTER)
        self.clock_time = Gtk.Label()
        self.clock_time.get_style_context().add_class("clock-time")
        self.clock_sub = Gtk.Label()
        self.clock_sub.get_style_context().add_class("clock-date")
        clock_box.pack_start(self.clock_time, False, False, 0)
        clock_box.pack_start(self.clock_sub, False, False, 0)
        self.stack.add_named(clock_box, "clock")

        # --- halaman media ---
        media_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        media_box.set_margin_start(14)
        media_box.set_margin_end(8)
        media_box.set_valign(Gtk.Align.CENTER)
        self.media_art = Gtk.Image()
        self.media_art.set_size_request(42, 42)
        media_box.pack_start(self.media_art, False, False, 0)
        mid = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=3)
        mid.set_valign(Gtk.Align.CENTER)
        self.media_title = Gtk.Label()
        self.media_title.set_xalign(0)
        self.media_title.set_ellipsize(3)
        self.media_title.get_style_context().add_class("media-title")
        self.media_artist = Gtk.Label()
        self.media_artist.set_xalign(0)
        self.media_artist.set_ellipsize(3)
        self.media_artist.get_style_context().add_class("media-artist")
        self.media_progress = Gtk.ProgressBar()
        self.media_progress.set_fraction(0)
        mid.pack_start(self.media_title, False, False, 0)
        mid.pack_start(self.media_artist, False, False, 0)
        mid.pack_start(self.media_progress, False, False, 0)
        media_box.pack_start(mid, True, True, 0)
        for label, method in (("⏮", "Previous"), ("⏯", "PlayPause"), ("⏭", "Next")):
            btn = Gtk.Button(label=label)
            btn.get_style_context().add_class("ctl-btn")
            btn.connect("clicked", self._on_media_btn, method)
            media_box.pack_start(btn, False, False, 0)
        self.stack.add_named(media_box, "media")

        # --- halaman notifikasi ---
        notify_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        notify_box.set_margin_start(16)
        notify_box.set_margin_end(12)
        notify_box.set_valign(Gtk.Align.CENTER)
        self.notify_icon = Gtk.Image()
        self.notify_icon.set_size_request(30, 30)
        notify_box.pack_start(self.notify_icon, False, False, 0)
        ntext = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        ntext.set_valign(Gtk.Align.CENTER)
        self.notify_app = Gtk.Label()
        self.notify_app.set_xalign(0)
        self.notify_app.get_style_context().add_class("notify-app")
        self.notify_summary = Gtk.Label()
        self.notify_summary.set_xalign(0)
        self.notify_summary.set_ellipsize(3)
        self.notify_summary.get_style_context().add_class("notify-summary")
        self.notify_body = Gtk.Label()
        self.notify_body.set_xalign(0)
        self.notify_body.set_ellipsize(3)
        self.notify_body.get_style_context().add_class("notify-body")
        ntext.pack_start(self.notify_app, False, False, 0)
        ntext.pack_start(self.notify_summary, False, False, 0)
        ntext.pack_start(self.notify_body, False, False, 0)
        notify_box.pack_start(ntext, True, True, 0)
        self.stack.add_named(notify_box, "notify")

        # --- halaman rekaman ---
        rec_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        rec_box.set_halign(Gtk.Align.CENTER)
        rec_box.set_valign(Gtk.Align.CENTER)
        dot = Gtk.Label(label="●")
        dot.get_style_context().add_class("rec-dot")
        self.rec_label = Gtk.Label(label="Merekam 00:00")
        self.rec_label.get_style_context().add_class("rec-text")
        rec_box.pack_start(dot, False, False, 0)
        rec_box.pack_start(self.rec_label, False, False, 0)
        self.stack.add_named(rec_box, "recording")

        # --- panel ---
        panel = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=5)
        panel.set_margin_start(16)
        panel.set_margin_end(16)
        panel.set_margin_top(12)
        panel.set_margin_bottom(12)

        def heading(text):
            lab = Gtk.Label(label=text)
            lab.set_xalign(0)
            lab.get_style_context().add_class("panel-heading")
            return lab

        self.panel_media = Gtk.Label(label="Tidak ada media diputar")
        self.panel_media.set_xalign(0)
        self.panel_media.set_ellipsize(3)
        self.panel_media.get_style_context().add_class("panel-text")
        self.panel_batt = Gtk.Label(label="-")
        self.panel_batt.set_xalign(0)
        self.panel_batt.get_style_context().add_class("panel-text")
        self.panel_rec = Gtk.Label(label="Tidak merekam")
        self.panel_rec.set_xalign(0)
        self.panel_rec.get_style_context().add_class("panel-text")

        timer_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        for label, secs in (("1 mnt", 60), ("5 mnt", 300), ("10 mnt", 600),
                            ("25 mnt", 1500)):
            b = Gtk.Button(label=label)
            b.get_style_context().add_class("preset-btn")
            b.connect("clicked", lambda _b, s=secs: self._start_timer(s))
            timer_row.pack_start(b, False, False, 0)
        self.timer_stop_btn = Gtk.Button(label="Berhenti")
        self.timer_stop_btn.get_style_context().add_class("preset-btn")
        self.timer_stop_btn.connect("clicked", lambda _b: self._stop_timer())
        timer_row.pack_start(self.timer_stop_btn, False, False, 0)
        self.panel_timer = Gtk.Label(label="Timer tidak aktif")
        self.panel_timer.set_xalign(0)
        self.panel_timer.get_style_context().add_class("panel-dim")

        self.panel_notify_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL,
                                        spacing=2)
        empty = Gtk.Label(label="Belum ada notifikasi")
        empty.set_xalign(0)
        empty.get_style_context().add_class("panel-dim")
        self.panel_notify_box.pack_start(empty, False, False, 0)

        panel.pack_start(heading("MEDIA"), False, False, 0)
        panel.pack_start(self.panel_media, False, False, 0)
        panel.pack_start(heading("BATERAI"), False, False, 0)
        panel.pack_start(self.panel_batt, False, False, 0)
        panel.pack_start(heading("REKAM LAYAR"), False, False, 0)
        panel.pack_start(self.panel_rec, False, False, 0)
        panel.pack_start(heading("TIMER"), False, False, 0)
        panel.pack_start(timer_row, False, False, 0)
        panel.pack_start(self.panel_timer, False, False, 0)
        panel.pack_start(heading("NOTIFIKASI TERAKHIR"), False, False, 0)
        panel.pack_start(self.panel_notify_box, False, False, 0)
        self.stack.add_named(panel, "panel")

    def _draw_bg(self, _widget, cr):
        """Gambar latar pil: bayangan lembut + badan dengan radius dinamis.

        Dipanggil dari sinyal draw jendela; return False agar widget anak
        tetap digambar di atasnya.
        """
        alloc = self.get_allocation()
        w, h = alloc.width, alloc.height
        x, y = SHADOW / 2, SHADOW / 2
        bw, bh = w - SHADOW, h - SHADOW
        target_r = RADIUS.get(self.state, 999)
        r = max(4, min(bh / 2, target_r))
        def rounded():
            cr.new_path()
            cr.arc(x + bw - r, y + r, r, -1.5708, 0)
            cr.arc(x + bw - r, y + bh - r, r, 0, 1.5708)
            cr.arc(x + r, y + bh - r, r, 1.5708, 3.1416)
            cr.arc(x + r, y + r, r, 3.1416, 4.7124)
            cr.close_path()
        for i, alpha in ((3.2, 0.10), (2.0, 0.12), (1.0, 0.14)):
            cr.save()
            cr.translate(0, i)
            rounded()
            cr.set_source_rgba(0, 0, 0, alpha)
            cr.fill()
            cr.restore()
        rounded()
        cr.set_source_rgba(0.03, 0.03, 0.045, 0.94)
        cr.fill_preserve()
        cr.set_source_rgba(1, 1, 1, 0.09)
        cr.set_line_width(1)
        cr.stroke()
        return False

    # ---------------------------------------------------------------- D-Bus --
    def _build_dbus(self):
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self._scan_players()
        self.bus.signal_subscribe(
            "org.freedesktop.DBus", "org.freedesktop.DBus", "NameOwnerChanged",
            "/org/freedesktop/DBus", None, Gio.DBusSignalFlags.NONE,
            self._on_name_owner_changed)
        # Monitor notifikasi di koneksi TERPISAH: setelah BecomeMonitor,
        # koneksi tidak boleh mengirim pesan apa pun (daemon menutupnya).
        try:
            address = Gio.dbus_address_get_for_bus_sync(Gio.BusType.SESSION, None)
            self.monitor_conn = Gio.DBusConnection.new_for_address_sync(
                address,
                Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT
                | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
                None, None)
            rules = ["type='method_call',path='/org/freedesktop/Notifications',"
                     "interface='org.freedesktop.Notifications',member='Notify'"]
            self.monitor_conn.call_sync(
                "org.freedesktop.DBus", "/org/freedesktop/DBus",
                "org.freedesktop.DBus.Monitoring", "BecomeMonitor",
                GLib.Variant("(asu)", (rules, 0)),
                None, Gio.DBusCallFlags.NONE, -1, None)
            self.monitor_conn.add_filter(self._bus_filter)
        except Exception as exc:
            print(f"[island] monitor notifikasi nonaktif: {exc}", flush=True)
            self.monitor_conn = None
        # Baterai via UPower
        try:
            self.upower = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, None,
                "org.freedesktop.UPower",
                "/org/freedesktop/UPower/devices/DisplayDevice",
                "org.freedesktop.UPower.Device", None)
            self.upower.connect("g-properties-changed",
                                lambda *_: self._read_battery())
            self._read_battery(initial=True)
        except Exception as exc:
            print(f"[island] UPower nonaktif: {exc}", flush=True)
            self.upower = None

    def _scan_players(self):
        try:
            result = self.bus.call_sync(
                "org.freedesktop.DBus", "/org/freedesktop/DBus",
                "org.freedesktop.DBus", "ListNames",
                None, None, Gio.DBusCallFlags.NONE, -1, None)
            names = result.unpack()[0]
        except Exception:
            names = []
        for name in names:
            if name.startswith("org.mpris.MediaPlayer2.") and name not in self.players:
                try:
                    self.players[name] = MediaPlayer(name, self._media_changed)
                    self._media_changed()  # konstruktor memanggil callback sebelum
                    # pemain sempat terdaftar di dict — evaluasi ulang di sini
                except Exception:
                    pass

    def _on_name_owner_changed(self, _c, _s, _p, _i, _sig, params):
        name, _old, new = params.unpack()
        if not name.startswith("org.mpris.MediaPlayer2."):
            return
        if new and name not in self.players:
            try:
                self.players[name] = MediaPlayer(name, self._media_changed)
                self._media_changed()
            except Exception:
                pass
        elif not new and name in self.players:
            del self.players[name]
            self._media_changed()

    def _bus_filter(self, _conn, message, _incoming):
        try:
            if message.get_member() == "Notify" and \
                    message.get_interface() == "org.freedesktop.Notifications":
                body = message.get_body().unpack()
                app, icon, summary, text = body[0], body[2], body[3], body[4]
                GLib.idle_add(self._show_notification, app, icon, summary, text)
        except Exception:
            pass
        return None  # telan: koneksi monitor hanya mengamati

    def _read_battery(self, initial=False):
        if not self.upower:
            return
        try:
            pct = self.upower.get_cached_property("Percentage")
            state = self.upower.get_cached_property("State")
            self.battery_pct = int(pct.unpack()) if pct else None
            new_state = int(state.unpack()) if state else None
        except Exception:
            return
        changed = new_state != self.battery_state
        self.battery_state = new_state
        if new_state == 1:
            self._low_batt_warned = False
        if not initial and changed and self.battery_pct is not None:
            if new_state == 1:
                self._show_notification("Baterai", "battery", "",
                                        f"Mengisi daya — {self.battery_pct}%")
            elif new_state == 2:
                self._show_notification("Baterai", "battery", "",
                                        f"Berhenti mengisi — {self.battery_pct}%")
            elif new_state == 4:
                self._show_notification("Baterai", "battery", "",
                                        "Baterai penuh — 100%")
        if (not initial and new_state == 2 and self.battery_pct is not None
                and self.battery_pct <= LOW_BATT_PCT and not self._low_batt_warned):
            self._low_batt_warned = True
            self._show_notification("Baterai lemah", "battery", "",
                                    f"Sisa {self.battery_pct}% — sambungkan charger")
        self._refresh_panel()

    # ---------------------------------------------------------------- timer --
    def _start_timer(self, seconds):
        self.timer_total = seconds
        self.timer_end = time.monotonic() + seconds
        self._refresh_panel()
        self._update_clock_sub()

    def _stop_timer(self, silent=False):
        self.timer_end = None
        self.timer_total = 0
        self._refresh_panel()
        self._update_clock_sub()
        if not silent:
            self._resolve_state()

    def _timer_remaining(self):
        if self.timer_end is None:
            return None
        return max(0.0, self.timer_end - time.monotonic())

    # ------------------------------------------------------------- perekam ---
    def _scan_recorders(self):
        found = False
        try:
            for pid in os.listdir("/proc"):
                if not pid.isdigit():
                    continue
                try:
                    with open(f"/proc/{pid}/comm", "r", encoding="utf-8",
                              errors="ignore") as fh:
                        comm = fh.read().strip()
                    if comm in RECORDER_NAMES:
                        found = True
                        break
                    if comm == "ffmpeg":
                        with open(f"/proc/{pid}/cmdline", "rb") as fh:
                            if b"x11grab" in fh.read() or b"pipewire" in fh.read():
                                found = True
                                break
                except Exception:
                    continue
        except Exception:
            pass
        if found and self.rec_since is None:
            self.rec_since = time.monotonic()
            self._resolve_state()
        elif not found and self.rec_since is not None:
            self.rec_since = None
            self._resolve_state()
        self._refresh_panel()
        return True

    # --------------------------------------------------------------- logika --
    def _active_player(self):
        playing = [p for p in self.players.values() if p.status == "Playing"]
        if playing:
            return playing[0]
        paused = [p for p in self.players.values() if p.status == "Paused" and p.title]
        return paused[0] if paused else None

    def _media_changed(self):
        player = self._active_player()
        if player:
            self.media_title.set_text(player.title or "Tanpa judul")
            self.media_artist.set_text(player.artist or player.bus_name.split(".")[-1])
            self._set_art(player.art_url)
            self._update_progress(player)
        self._refresh_panel()
        self._resolve_state()

    def _set_art(self, art_url):
        pixbuf = None
        if art_url.startswith("file://"):
            try:
                pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(
                    art_url[7:], 42, 42, True)
            except Exception:
                pixbuf = None
        if pixbuf:
            self.media_art.set_from_pixbuf(pixbuf)
            self.media_art.set_visible(True)
        else:
            self.media_art.clear()
            self.media_art.set_visible(False)

    def _update_progress(self, player):
        if player and player.length_us > 0:
            frac = min(1.0, player.estimated_position() / player.length_us)
            self.media_progress.set_fraction(frac)
            self.media_progress.set_visible(True)
        else:
            self.media_progress.set_visible(False)

    def _on_media_btn(self, _btn, method):
        player = self._active_player()
        if player:
            player.call(method)

    def _show_notification(self, app, icon, summary, body):
        self.notify_history.insert(0, (app, summary, body, time.time()))
        del self.notify_history[5:]
        self.notify_app.set_text(app or "Notifikasi")
        self.notify_summary.set_text(summary or "")
        self.notify_body.set_text(body or "")
        self.notify_body.set_visible(bool(body))
        shown = False
        if icon:
            try:
                if os.path.exists(icon):
                    self.notify_icon.set_from_file(icon)
                else:
                    self.notify_icon.set_from_icon_name(icon, Gtk.IconSize.DIALOG)
                shown = self.notify_icon.get_storage_type() != Gtk.ImageType.EMPTY
            except Exception:
                shown = False
        self.notify_icon.set_visible(shown)
        self._refresh_panel()
        if not self.panel_open:
            self.state = "notify"
            self.stack.set_visible_child_name("notify")
            self._animate_to(SIZES["notify"])
            if self._notify_source:
                GLib.source_remove(self._notify_source)
            self._notify_source = GLib.timeout_add_seconds(
                NOTIFY_SHOW_S, self._notification_done)
        return False

    def _notification_done(self):
        self._notify_source = None
        self._resolve_state()
        return False

    def _resolve_state(self):
        """Tentukan state dasar dari kondisi saat ini (panel & notif menang)."""
        if self.panel_open or self._notify_source is not None:
            return
        if self.rec_since is not None:
            target = "recording"
        elif self._active_player():
            target = "media"
        else:
            target = "clock"
        self._set_state(target)

    def _refresh_panel(self):
        player = self._active_player()
        if player:
            self.panel_media.set_text(
                f"{player.title} — {player.artist}".strip(" —"))
        else:
            self.panel_media.set_text("Tidak ada media diputar")
        if self.battery_pct is not None:
            status = {1: "mengisi", 2: "terpakai", 4: "penuh"}.get(
                self.battery_state or 0, "")
            self.panel_batt.set_text(f"{self.battery_pct}% {status}".strip())
        else:
            self.panel_batt.set_text("-")
        if self.rec_since is not None:
            self.panel_rec.set_text(
                f"Sedang merekam — {fmt_hms(time.monotonic() - self.rec_since)}")
        else:
            self.panel_rec.set_text("Tidak merekam")
        remaining = self._timer_remaining()
        if remaining is not None:
            self.panel_timer.set_text(
                f"Berjalan: sisa {fmt_hms(remaining)} dari {fmt_hms(self.timer_total)}")
            self.timer_stop_btn.set_sensitive(True)
        else:
            self.panel_timer.set_text("Timer tidak aktif")
            self.timer_stop_btn.set_sensitive(False)
        for child in self.panel_notify_box.get_children():
            self.panel_notify_box.remove(child)
        if not self.notify_history:
            lab = Gtk.Label(label="Belum ada notifikasi")
            lab.set_xalign(0)
            lab.get_style_context().add_class("panel-dim")
            self.panel_notify_box.pack_start(lab, False, False, 0)
        else:
            for app, summary, _body, _ts in self.notify_history:
                lab = Gtk.Label(label=f"{app}: {summary}")
                lab.set_xalign(0)
                lab.set_ellipsize(3)
                lab.get_style_context().add_class("panel-text")
                self.panel_notify_box.pack_start(lab, False, False, 0)
        self.panel_notify_box.show_all()

    def _update_clock_sub(self):
        remaining = self._timer_remaining()
        if remaining is not None:
            self.clock_sub.set_text(f"Timer {fmt_hms(remaining)}")
            self.clock_sub.get_style_context().remove_class("clock-date")
            self.clock_sub.get_style_context().add_class("timer-chip")
        else:
            self.clock_sub.set_text(datetime.now().strftime("%a, %d %b"))
            self.clock_sub.get_style_context().remove_class("timer-chip")
            self.clock_sub.get_style_context().add_class("clock-date")

    def _tick_slow(self):
        now = datetime.now()
        self.clock_time.set_text(now.strftime("%H:%M"))
        # timer
        remaining = self._timer_remaining()
        if remaining is not None and remaining <= 0:
            total = self.timer_total
            self._stop_timer(silent=True)
            self._show_notification("Timer", "alarm-clock", "",
                                    f"Waktu habis! ({fmt_hms(total)})")
        self._update_clock_sub()
        # rekaman
        if self.rec_since is not None:
            self.rec_label.set_text(
                f"Merekam {fmt_hms(time.monotonic() - self.rec_since)}")
        # progres media (poll posisi 1x per detik bergantian)
        player = self._active_player()
        if player:
            player.poll_position()
            if self.state == "media":
                self._update_progress(player)
        if self.panel_open:
            self._refresh_panel()
        else:
            self._resolve_state()  # jaring pengaman transisi yang terlewat
        return True

    # -------------------------------------------------------------- animasi --
    def _set_state(self, state, force=False):
        if state == self.state and not force:
            self.stack.set_visible_child_name(state)
            return
        self.state = state
        self.stack.set_visible_child_name(state)
        self._animate_to(SIZES[state])

    def _animate_to(self, target):
        self.spring_w.set(target[0])
        self.spring_h.set(target[1])
        if self._tick_cb_id is None:
            self._tick_cb_id = self.add_tick_callback(self._on_tick)

    def _on_tick(self, _widget, frame_clock):
        now = frame_clock.get_frame_time()
        last = getattr(self, "_last_frame", None) or now
        self._last_frame = now
        dt = min(max((now - last) / 1e6, 0.001), 0.05)
        moving_w = self.spring_w.step(dt)
        moving_h = self.spring_h.step(dt)
        w = round(self.spring_w.x)
        h = round(self.spring_h.x)
        if (w, h) != self._cur_size:
            self._cur_size = (w, h)
            self.resize(w, h)
            self._center_top(w)
            self.queue_draw()
        if not (moving_w or moving_h):
            self._tick_cb_id = None
            self._last_frame = None
            return False
        return True

    def _center_top(self, w):
        display = Gdk.Display.get_default()
        if display is None or "X11" not in type(display).__name__:
            return  # Wayland: posisi diatur compositor
        try:
            monitor = display.get_primary_monitor() or display.get_monitor(0)
            geo = monitor.get_geometry()
            self.move(geo.x + (geo.width - w) // 2, geo.y + TOP_MARGIN)
        except Exception:
            pass

    # ------------------------------------------------------------ interaksi --
    def _on_click(self, _widget, event):
        if event.button == 3:  # klik kanan: keluar
            Gtk.main_quit()
            return True
        if event.type != Gdk.EventType.BUTTON_PRESS:
            return False
        self.panel_open = not self.panel_open
        if self.panel_open:
            self._refresh_panel()
            self.state = "panel"
            self.stack.set_visible_child_name("panel")
            self._animate_to(SIZES["panel"])
        elif self._notify_source is not None:
            self.state = "notify"
            self.stack.set_visible_child_name("notify")
            self._animate_to(SIZES["notify"])
        else:
            self.state = ""
            self._resolve_state()
        return True


def main():
    timer = parse_timer_arg(sys.argv[1:])
    win = Island(timer_seconds=timer)
    win.show_all()
    Gtk.main()


if __name__ == "__main__":
    main()

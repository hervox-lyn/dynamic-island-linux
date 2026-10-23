#!/usr/bin/env python3
"""
Dynamic Island untuk Linux — MVP (overlay GTK)
================================================
Pil hitam melayang di tengah-atas layar yang melebar dengan animasi halus:

  * Idle            -> jam + tanggal
  * Musik diputar   -> judul/artis (MPRIS) + tombol prev / play-pause / next
  * Notifikasi masuk-> aplikasi + ringkasan (dimonitor via D-Bus, tanpa
                       menggantikan daemon notifikasi bawaan)
  * Colok/lepas daya-> info baterai sesaat; status baterai juga ada di panel
  * Klik pil        -> panel ringkas (media + baterai + notifikasi terakhir)

Butuh: python3-gi, GTK 3 (gir1.2-gtk-3.0). Paling penuh di sesi X11
(posisi + always-on-top); di Wayland jendela tetap jalan sebagai jendela
melayang biasa karena Wayland tidak mengizinkan aplikasi mengatur posisi.

Jalankan:  python3 dynamic_island.py
Keluar:    klik kanan pada pil, atau Ctrl+C di terminal.
"""

import time
from datetime import datetime

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, Gio, GLib, Gtk  # noqa: E402

# ---------------------------------------------------------------------------
# Ukuran tiap state (lebar, tinggi) dalam piksel
# ---------------------------------------------------------------------------
SIZES = {
    "clock": (200, 42),
    "media": (400, 58),
    "notify": (430, 62),
    "battery": (300, 46),
    "panel": (430, 210),
}
TOP_MARGIN = 10
ANIM_MS = 200          # durasi animasi ubah ukuran
NOTIFY_SHOW_S = 5      # berapa lama notifikasi ditampilkan

CSS = b"""
window { background: transparent; }
.island {
    background-color: rgba(8, 8, 11, 0.93);
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    color: #f5f5f5;
}
.panel {
    border-radius: 26px;
}
.clock-time { font-size: 17px; font-weight: bold; }
.clock-date { font-size: 11px; color: #b9bec9; }
.media-title { font-size: 13px; font-weight: bold; }
.media-artist { font-size: 11px; color: #b9bec9; }
.notify-app { font-size: 11px; color: #e8b84b; font-weight: bold; }
.notify-summary { font-size: 13px; font-weight: bold; }
.notify-body { font-size: 11px; color: #b9bec9; }
.panel-heading { font-size: 11px; color: #e8b84b; font-weight: bold; }
.panel-text { font-size: 12px; }
.ctl-btn {
    background: rgba(255, 255, 255, 0.10);
    border: none; border-radius: 999px;
    color: #ffffff; min-width: 30px; min-height: 30px;
    font-size: 13px; padding: 0 6px;
}
.ctl-btn:hover { background: rgba(255, 255, 255, 0.22); }
"""


def ease_out_cubic(t: float) -> float:
    return 1 - (1 - t) ** 3


class MediaPlayer:
    """Satu pemain media MPRIS (Spotify, VLC, browser, dll.)."""

    def __init__(self, bus_name: str, on_change):
        self.bus_name = bus_name
        self.on_change = on_change
        self.title = ""
        self.artist = ""
        self.status = "Stopped"
        self.proxy = Gio.DBusProxy.new_for_bus_sync(
            Gio.BusType.SESSION,
            Gio.DBusProxyFlags.NONE,
            None,
            bus_name,
            "/org/mpris/MediaPlayer2",
            "org.mpris.MediaPlayer2.Player",
            None,
        )
        self.proxy.connect("g-properties-changed", self._on_props)
        self.refresh()

    def refresh(self):
        try:
            self.status = self.proxy.get_cached_property("PlaybackStatus")
            self.status = self.status.unpack() if self.status else "Stopped"
            meta = self.proxy.get_cached_property("Metadata")
            meta = meta.unpack() if meta else {}
            self.title = meta.get("xesam:title", "") or ""
            artists = meta.get("xesam:artist", []) or []
            self.artist = ", ".join(artists) if isinstance(artists, list) else str(artists)
        except Exception:
            pass
        self.on_change()

    def _on_props(self, _proxy, _changed, _invalidated):
        self.refresh()

    def call(self, method: str):
        try:
            self.proxy.call_sync(method, None, Gio.DBusCallFlags.NONE, 500, None)
        except Exception:
            pass


class Island(Gtk.Window):
    def __init__(self):
        super().__init__(type=Gtk.WindowType.TOPLEVEL)
        self.set_decorated(False)
        self.set_resizable(False)
        self.set_keep_above(True)
        self.set_skip_taskbar_hint(True)
        self.set_skip_pager_hint(True)
        self.set_type_hint(Gdk.WindowTypeHint.DOCK)
        self.set_default_size(*SIZES["clock"])
        try:
            self.set_app_paintable(True)
            screen = self.get_screen()
            visual = screen.get_rgba_visual()
            if visual:
                self.set_visual(visual)
        except Exception:
            pass

        provider = Gtk.CssProvider()
        provider.load_from_data(CSS)
        Gtk.StyleContext.add_provider_for_screen(
            Gdk.Screen.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        )

        # --- state ------------------------------------------------------------
        self.state = "clock"          # state yang sedang tampil
        self.panel_open = False
        self.players = {}             # bus_name -> MediaPlayer
        self.last_notification = None  # (app, summary, body, waktu)
        self._notify_timer = None
        self._anim = None
        self._cur_size = SIZES["clock"]
        self.battery_pct = None
        self.battery_state = None     # 1 charging, 2 discharging, 4 full

        self._build_ui()
        self._build_dbus()
        self._tick_clock()
        GLib.timeout_add_seconds(1, self._tick_clock)
        self.connect("button-press-event", self._on_click)
        self.add_events(Gdk.EventMask.BUTTON_PRESS_MASK)
        self.connect("destroy", Gtk.main_quit)
        self.show_all()
        self._center_top(*SIZES["clock"])

    # ------------------------------------------------------------------ UI --
    def _build_ui(self):
        self.frame = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        self.frame.get_style_context().add_class("island")
        self.add(self.frame)

        self.stack = Gtk.Stack()
        self.stack.set_hhomogeneous(False)
        self.stack.set_vhomogeneous(False)
        self.stack.set_transition_type(Gtk.StackTransitionType.CROSSFADE)
        self.stack.set_transition_duration(150)
        self.frame.pack_start(self.stack, True, True, 0)

        # --- halaman jam ---
        clock_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        clock_box.set_halign(Gtk.Align.CENTER)
        clock_box.set_valign(Gtk.Align.CENTER)
        self.clock_time = Gtk.Label()
        self.clock_time.get_style_context().add_class("clock-time")
        self.clock_date = Gtk.Label()
        self.clock_date.get_style_context().add_class("clock-date")
        clock_box.pack_start(self.clock_time, False, False, 0)
        clock_box.pack_start(self.clock_date, False, False, 0)
        self.stack.add_named(clock_box, "clock")

        # --- halaman media ---
        media_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        media_box.set_margin_start(16)
        media_box.set_margin_end(10)
        media_box.set_valign(Gtk.Align.CENTER)
        text_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        text_box.set_valign(Gtk.Align.CENTER)
        self.media_title = Gtk.Label()
        self.media_title.set_xalign(0)
        self.media_title.set_ellipsize(3)  # PANGO_ELLIPSIZE_END
        self.media_title.get_style_context().add_class("media-title")
        self.media_artist = Gtk.Label()
        self.media_artist.set_xalign(0)
        self.media_artist.set_ellipsize(3)
        self.media_artist.get_style_context().add_class("media-artist")
        text_box.pack_start(self.media_title, False, False, 0)
        text_box.pack_start(self.media_artist, False, False, 0)
        media_box.pack_start(text_box, True, True, 0)
        for label, method in (("⏮", "Previous"), ("⏯", "PlayPause"), ("⏭", "Next")):
            btn = Gtk.Button(label=label)
            btn.get_style_context().add_class("ctl-btn")
            btn.connect("clicked", self._on_media_btn, method)
            media_box.pack_start(btn, False, False, 0)
        self.stack.add_named(media_box, "media")

        # --- halaman notifikasi ---
        notify_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        notify_box.set_margin_start(18)
        notify_box.set_margin_end(14)
        notify_box.set_valign(Gtk.Align.CENTER)
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
        notify_box.pack_start(self.notify_app, False, False, 0)
        notify_box.pack_start(self.notify_summary, False, False, 0)
        notify_box.pack_start(self.notify_body, False, False, 0)
        self.stack.add_named(notify_box, "notify")

        # --- halaman baterai sesaat ---
        batt_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        batt_box.set_halign(Gtk.Align.CENTER)
        batt_box.set_valign(Gtk.Align.CENTER)
        self.battery_label = Gtk.Label()
        self.battery_label.get_style_context().add_class("media-title")
        batt_box.pack_start(self.battery_label, False, False, 0)
        self.stack.add_named(batt_box, "battery")

        # --- panel (klik pil) ---
        panel_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        panel_box.set_margin_start(18)
        panel_box.set_margin_end(18)
        panel_box.set_margin_top(14)
        panel_box.set_margin_bottom(14)
        h1 = Gtk.Label(label="MEDIA")
        h1.set_xalign(0)
        h1.get_style_context().add_class("panel-heading")
        self.panel_media = Gtk.Label(label="Tidak ada media diputar")
        self.panel_media.set_xalign(0)
        self.panel_media.set_ellipsize(3)
        self.panel_media.get_style_context().add_class("panel-text")
        h2 = Gtk.Label(label="BATERAI")
        h2.set_xalign(0)
        h2.get_style_context().add_class("panel-heading")
        self.panel_batt = Gtk.Label(label="-")
        self.panel_batt.set_xalign(0)
        self.panel_batt.get_style_context().add_class("panel-text")
        h3 = Gtk.Label(label="NOTIFIKASI TERAKHIR")
        h3.set_xalign(0)
        h3.get_style_context().add_class("panel-heading")
        self.panel_notify = Gtk.Label(label="Belum ada notifikasi")
        self.panel_notify.set_xalign(0)
        self.panel_notify.set_ellipsize(3)
        self.panel_notify.get_style_context().add_class("panel-text")
        for w in (h1, self.panel_media, h2, self.panel_batt, h3, self.panel_notify):
            panel_box.pack_start(w, False, False, 0)
        self.stack.add_named(panel_box, "panel")

    # ---------------------------------------------------------------- D-Bus --
    def _build_dbus(self):
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        # Pantau pemain media MPRIS
        self._scan_players()
        self.bus.signal_subscribe(
            "org.freedesktop.DBus", "org.freedesktop.DBus", "NameOwnerChanged",
            "/org/freedesktop/DBus", None, Gio.DBusSignalFlags.NONE,
            self._on_name_owner_changed,
        )
        # Monitor notifikasi (eavesdrop di session bus; TIDAK mengambil alih
        # daemon notifikasi bawaan — hanya mendengarkan panggilan Notify).
        # PENTING: BecomeMonitor harus di koneksi D-Bus TERPISAH. Setelah
        # sebuah koneksi jadi monitor, koneksi itu tidak boleh mengirim pesan
        # apa pun (daemon akan menutupnya) — jadi semua panggilan lain
        # (MPRIS, ListNames) tetap lewat koneksi bersama self.bus.
        try:
            address = Gio.dbus_address_get_for_bus_sync(Gio.BusType.SESSION, None)
            self.monitor_conn = Gio.DBusConnection.new_for_address_sync(
                address,
                Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT
                | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
                None, None,
            )
            rules = ["type='method_call',path='/org/freedesktop/Notifications',"
                     "interface='org.freedesktop.Notifications',member='Notify'"]
            self.monitor_conn.call_sync(
                "org.freedesktop.DBus", "/org/freedesktop/DBus",
                "org.freedesktop.DBus.Monitoring", "BecomeMonitor",
                GLib.Variant("(asu)", (rules, 0)),
                None, Gio.DBusCallFlags.NONE, -1, None,
            )
            self.monitor_conn.add_filter(self._bus_filter)
        except Exception as exc:  # mis. policy D-Bus melarang eavesdrop
            print(f"[island] monitor notifikasi nonaktif: {exc}", flush=True)
            self.monitor_conn = None
        # Baterai via UPower
        try:
            self.upower = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, None,
                "org.freedesktop.UPower",
                "/org/freedesktop/UPower/devices/DisplayDevice",
                "org.freedesktop.UPower.Device", None,
            )
            self.upower.connect("g-properties-changed", self._on_upower_props)
            self._read_battery(initial=True)
        except Exception as exc:
            print(f"[island] UPower nonaktif: {exc}")
            self.upower = None

    def _scan_players(self):
        try:
            result = self.bus.call_sync(
                "org.freedesktop.DBus", "/org/freedesktop/DBus",
                "org.freedesktop.DBus", "ListNames",
                None, None, Gio.DBusCallFlags.NONE, -1, None,
            )
            names = result.unpack()[0]
        except Exception:
            names = []
        for name in names:
            if name.startswith("org.mpris.MediaPlayer2.") and name not in self.players:
                try:
                    self.players[name] = MediaPlayer(name, self._media_changed)
                except Exception:
                    pass

    def _on_name_owner_changed(self, _conn, _sender, _path, _iface, _signal, params):
        name, _old, new = params.unpack()
        if not name.startswith("org.mpris.MediaPlayer2."):
            return
        if new and name not in self.players:
            try:
                self.players[name] = MediaPlayer(name, self._media_changed)
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
                app, _rep, _icon, summary, text = body[0], body[1], body[2], body[3], body[4]
                GLib.idle_add(self._show_notification, app, summary, text)
        except Exception:
            pass
        # Telan pesan (return None): koneksi monitor tidak boleh memproses /
        # membalas pesan apa pun — cukup diamati lalu dibuang.
        return None

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
        if not initial and changed and self.battery_pct is not None:
            if self.battery_state == 1:
                self._flash_battery(f"Mengisi daya — {self.battery_pct}%")
            elif self.battery_state == 2:
                self._flash_battery(f"Berhenti mengisi — {self.battery_pct}%")
            elif self.battery_state == 4:
                self._flash_battery("Baterai penuh — 100%")
        self._refresh_panel()

    def _on_upower_props(self, _proxy, _changed, _invalidated):
        self._read_battery()

    # --------------------------------------------------------------- logika --
    def _active_player(self):
        playing = [p for p in self.players.values() if p.status == "Playing"]
        if playing:
            return playing[0]
        paused = [p for p in self.players.values()
                  if p.status == "Paused" and p.title]
        return paused[0] if paused else None

    def _media_changed(self):
        player = self._active_player()
        if player:
            title = player.title or "Tanpa judul"
            self.media_title.set_text(title)
            self.media_artist.set_text(player.artist or player.bus_name.split(".")[-1])
        self._refresh_panel()
        if not self.panel_open and self._notify_timer is None:
            self._set_state("media" if player else "clock")

    def _on_media_btn(self, _btn, method):
        player = self._active_player()
        if player:
            player.call(method)

    def _show_notification(self, app, summary, body):
        self.last_notification = (app, summary, body, time.time())
        self.notify_app.set_text(app or "Notifikasi")
        self.notify_summary.set_text(summary or "")
        self.notify_body.set_text(body or "")
        self.notify_body.set_visible(bool(body))
        self._refresh_panel()
        if not self.panel_open:
            self._set_state("notify")
            if self._notify_timer:
                GLib.source_remove(self._notify_timer)
            self._notify_timer = GLib.timeout_add_seconds(
                NOTIFY_SHOW_S, self._notification_done)
        return False

    def _notification_done(self):
        self._notify_timer = None
        if not self.panel_open:
            self._set_state("media" if self._active_player() else "clock")
        return False

    def _flash_battery(self, text):
        self.battery_label.set_text(text)
        if not self.panel_open:
            prev = self.state
            self._set_state("battery")
            GLib.timeout_add_seconds(3, self._battery_done, prev)

    def _battery_done(self, _prev):
        if self.state == "battery" and not self.panel_open:
            self._set_state("media" if self._active_player() else "clock")
        return False

    def _refresh_panel(self):
        player = self._active_player()
        if player:
            self.panel_media.set_text(f"{player.title} — {player.artist}".strip(" —"))
        else:
            self.panel_media.set_text("Tidak ada media diputar")
        if self.battery_pct is not None:
            status = {1: "mengisi", 2: "terpakai", 4: "penuh"}.get(
                self.battery_state or 0, "")
            self.panel_batt.set_text(f"{self.battery_pct}% {status}".strip())
        if self.last_notification:
            app, summary, _body, _ts = self.last_notification
            self.panel_notify.set_text(f"{app}: {summary}")

    def _tick_clock(self):
        now = datetime.now()
        self.clock_time.set_text(now.strftime("%H:%M"))
        self.clock_date.set_text(now.strftime("%a, %d %b"))
        return True

    # -------------------------------------------------------------- animasi --
    def _set_state(self, state: str):
        if state == self.state and not self.panel_open:
            self.stack.set_visible_child_name(state)
            return
        self.state = state
        self.stack.set_visible_child_name(state)
        if state == "panel":
            self.frame.get_style_context().add_class("panel")
        else:
            self.frame.get_style_context().remove_class("panel")
        self._animate_to(SIZES[state])

    def _animate_to(self, target):
        if self._anim:
            GLib.source_remove(self._anim)
            self._anim = None
        start = self._cur_size
        if start == target:
            return
        t0 = time.monotonic()

        def step():
            t = min((time.monotonic() - t0) / (ANIM_MS / 1000.0), 1.0)
            k = ease_out_cubic(t)
            w = round(start[0] + (target[0] - start[0]) * k)
            h = round(start[1] + (target[1] - start[1]) * k)
            self._apply_size(w, h)
            if t >= 1.0:
                self._anim = None
                return False
            return True

        self._anim = GLib.timeout_add(16, step)

    def _apply_size(self, w, h):
        self._cur_size = (w, h)
        self.resize(w, h)
        self._center_top(w, h)

    def _center_top(self, w, _h):
        display = Gdk.Display.get_default()
        if display is None or "X11" not in type(display).__name__:
            return  # Wayland: posisi diatur compositor
        try:
            monitor = display.get_primary_monitor() or display.get_monitor(0)
            geo = monitor.get_geometry()
            x = geo.x + (geo.width - w) // 2
            self.move(x, geo.y + TOP_MARGIN)
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
            self._set_state("panel")
        else:
            if self._notify_timer is not None:
                self._set_state("notify")
            else:
                self._set_state("media" if self._active_player() else "clock")
        return True


def main():
    win = Island()
    win.show_all()
    Gtk.main()


if __name__ == "__main__":
    main()

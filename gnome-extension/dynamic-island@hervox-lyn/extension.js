// Dynamic Island untuk GNOME Shell (Wayland & X11)
// =================================================
// Pil di tengah-atas layar yang hidup di dalam UI GNOME Shell sendiri,
// jadi posisinya bisa dikunci persis di tengah-atas — sesuatu yang tidak
// bisa dilakukan aplikasi GTK biasa di Wayland.
//
// Fitur setara versi GTK: jam, media MPRIS (album art, progress, kontrol),
// notifikasi (dari MessageTray shell), timer, indikator rekam layar,
// baterai UPower, panel saat diklik. Animasi memakai Clutter ease
// EASE_OUT_BACK (pantulan lembut ala Dynamic Island).

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const SIZES = {
    clock: [236, 58],
    media: [444, 76],
    notify: [466, 80],
    recording: [320, 60],
    panel: [472, 392],
};
const NOTIFY_SHOW_S = 5;
const LOW_BATT_PCT = 20;
const RECORDER_PATTERN = '^(obs|wf-recorder|kooha|simplescreenrecorder|vokoscreenNG|vokoscreen|byzanz-record)$';

const MPRIS_PLAYER_IFACE = `
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Position" type="x" access="read"/>
    <method name="PlayPause"/>
    <method name="Play"/>
    <method name="Pause"/>
    <method name="Next"/>
    <method name="Previous"/>
  </interface>
</node>`;

const UPOWER_DEVICE_IFACE = `
<node>
  <interface name="org.freedesktop.UPower.Device">
    <property name="Percentage" type="d" access="read"/>
    <property name="State" type="u" access="read"/>
  </interface>
</node>`;

const DBUS_IFACE = `
<node>
  <interface name="org.freedesktop.DBus">
    <method name="ListNames">
      <arg type="as" direction="out" name="names"/>
    </method>
    <signal name="NameOwnerChanged">
      <arg type="s" name="name"/>
      <arg type="s" name="oldOwner"/>
      <arg type="s" name="newOwner"/>
    </signal>
  </interface>
</node>`;

const PROPS_IFACE = `
<node>
  <interface name="org.freedesktop.DBus.Properties">
    <method name="Get">
      <arg type="s" direction="in" name="interface"/>
      <arg type="s" direction="in" name="property"/>
      <arg type="v" direction="out" name="value"/>
    </method>
    <method name="GetAll">
      <arg type="s" direction="in" name="interface"/>
      <arg type="a{sv}" direction="out" name="values"/>
    </method>
    <signal name="PropertiesChanged">
      <arg type="s" name="interface"/>
      <arg type="a{sv}" name="changed"/>
      <arg type="as" name="invalidated"/>
    </signal>
  </interface>
</node>`;

const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(MPRIS_PLAYER_IFACE);
const UPowerProxy = Gio.DBusProxy.makeProxyWrapper(UPOWER_DEVICE_IFACE);
const DBusProxy = Gio.DBusProxy.makeProxyWrapper(DBUS_IFACE);
const PropsProxy = Gio.DBusProxy.makeProxyWrapper(PROPS_IFACE);

function fmtHms(seconds) {
    seconds = Math.max(0, Math.floor(seconds));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

class Player {
    constructor(busName, onChange) {
        this.busName = busName;
        this.onChange = onChange;
        this.title = '';
        this.artist = '';
        this.status = 'Stopped';
        this.artUrl = '';
        this.lengthUs = 0;
        this.positionUs = 0;
        this.posAt = GLib.get_monotonic_time();
        this.proxy = new PlayerProxy(Gio.DBus.session, busName,
            '/org/mpris/MediaPlayer2');
        this.props = new PropsProxy(Gio.DBus.session, busName,
            '/org/mpris/MediaPlayer2');
        this.proxy.connect('g-properties-changed', () => this.refresh());
        this.refresh();
    }

    refresh() {
        this.props.GetAllAsync('org.mpris.MediaPlayer2.Player')
            .then(([values]) => {
                this.status = values.PlaybackStatus?.unpack() ?? 'Stopped';
                const meta = values.Metadata?.deepUnpack() ?? {};
                this.title = meta['xesam:title']?.unpack() ?? '';
                const artists = meta['xesam:artist']?.unpack() ?? [];
                this.artist = Array.isArray(artists) ? artists.join(', ') : `${artists}`;
                this.artUrl = meta['mpris:artUrl']?.unpack() ?? '';
                this.lengthUs = meta['mpris:length']?.unpack() ?? 0;
                this.positionUs = values.Position?.unpack() ?? 0;
                this.posAt = GLib.get_monotonic_time();
                this.onChange();
            })
            .catch(() => {});
    }

    pollPosition() {
        this.props.GetAsync('org.mpris.MediaPlayer2.Player', 'Position')
            .then(([value]) => {
                this.positionUs = value.unpack();
                this.posAt = GLib.get_monotonic_time();
            })
            .catch(() => {});
    }

    estimatedPosition() {
        if (this.status === 'Playing')
            return this.positionUs + (GLib.get_monotonic_time() - this.posAt);
        return this.positionUs;
    }

    call(method) {
        try {
            this.proxy[`${method}Async`]().catch(() => {});
        } catch (e) { /* pemain mungkin sudah tutup */ }
    }
}

export default class DynamicIslandExtension extends Extension {
    enable() {
        this._state = 'clock';
        this._panelOpen = false;
        this._players = new Map();
        this._notifyHistory = [];
        this._notifyTimeoutId = null;
        this._batteryPct = null;
        this._batteryState = null;
        this._lowBattWarned = false;
        this._timerEnd = null;
        this._timerTotal = 0;
        this._recSince = null;
        this._lastNotif = null;
        this._timeouts = [];

        this._buildUi();
        this._buildDbus();
        this._tick();
        this._later(500, () => this._tick());
        this._later(3000, () => this._scanRecorders());
        this._later(2000, () => this._pollNotifications());
    }

    disable() {
        for (const id of this._timeouts)
            GLib.source_remove(id);
        this._timeouts = [];
        if (this._notifyTimeoutId) {
            GLib.source_remove(this._notifyTimeoutId);
            this._notifyTimeoutId = null;
        }
        if (this._nameSignalId && this._dbusProxy) {
            this._dbusProxy.disconnect(this._nameSignalId);
            this._nameSignalId = null;
        }
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = null;
        }
        this._players.clear();
        if (this._actor) {
            Main.layoutManager.uiGroup.remove_child(this._actor);
            this._actor.destroy();
            this._actor = null;
        }
    }

    _later(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            fn();
            return GLib.SOURCE_CONTINUE;
        });
        this._timeouts.push(id);
        return id;
    }

    // ------------------------------------------------------------- UI ------
    _buildUi() {
        this._actor = new St.BoxLayout({
            style_class: 'island',
            vertical: true,
            reactive: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._actor.connect('button-press-event', (_a, event) => {
            if (event.get_button() === 3) {
                if (this._panelOpen)
                    this._togglePanel(false);
                return Clutter.EVENT_STOP;
            }
            this._togglePanel(!this._panelOpen);
            return Clutter.EVENT_STOP;
        });

        // --- halaman jam ---
        const clockBox = new St.BoxLayout({vertical: false});
        clockBox.set_x_align(Clutter.ActorAlign.CENTER);
        clockBox.set_y_align(Clutter.ActorAlign.CENTER);
        this._clockTime = new St.Label({style_class: 'clock-time', text: '--:--'});
        this._clockSub = new St.Label({style_class: 'clock-date', text: ''});
        this._clockSub.set_margin_left(10);
        clockBox.add_child(this._clockTime);
        clockBox.add_child(this._clockSub);

        // --- halaman media ---
        const mediaBox = new St.BoxLayout({vertical: false});
        mediaBox.set_y_align(Clutter.ActorAlign.CENTER);
        this._mediaArt = new St.Icon({icon_size: 42});
        this._mediaArt.set_margin_right(10);
        const mid = new St.BoxLayout({vertical: true});
        mid.set_y_align(Clutter.ActorAlign.CENTER);
        mid.set_x_expand(true);
        this._mediaTitle = new St.Label({style_class: 'media-title', text: ''});
        this._mediaArtist = new St.Label({style_class: 'media-artist', text: ''});
        const track = new St.BoxLayout({
            style_class: 'progress-track', vertical: false,
        });
        track.set_width(170);
        track.set_margin_top(4);
        this._mediaFill = new St.Widget({style_class: 'progress-fill'});
        this._mediaFill.set_width(0);
        track.add_child(this._mediaFill);
        this._mediaTrack = track;
        mid.add_child(this._mediaTitle);
        mid.add_child(this._mediaArtist);
        mid.add_child(track);
        mediaBox.add_child(this._mediaArt);
        mediaBox.add_child(mid);
        for (const [label, method] of [['⏮', 'Previous'], ['⏯', 'PlayPause'], ['⏭', 'Next']]) {
            const btn = new St.Button({label, style_class: 'ctl-btn'});
            btn.set_margin_left(6);
            btn.connect('clicked', () => {
                const p = this._activePlayer();
                if (p)
                    p.call(method);
            });
            mediaBox.add_child(btn);
        }

        // --- halaman notifikasi ---
        const notifyBox = new St.BoxLayout({vertical: false});
        notifyBox.set_y_align(Clutter.ActorAlign.CENTER);
        this._notifyIcon = new St.Icon({icon_size: 30});
        this._notifyIcon.set_margin_right(10);
        const ntext = new St.BoxLayout({vertical: true});
        ntext.set_y_align(Clutter.ActorAlign.CENTER);
        ntext.set_x_expand(true);
        this._notifyApp = new St.Label({style_class: 'notify-app', text: ''});
        this._notifySummary = new St.Label({style_class: 'notify-summary', text: ''});
        this._notifyBody = new St.Label({style_class: 'notify-body', text: ''});
        ntext.add_child(this._notifyApp);
        ntext.add_child(this._notifySummary);
        ntext.add_child(this._notifyBody);
        notifyBox.add_child(this._notifyIcon);
        notifyBox.add_child(ntext);

        // --- halaman rekaman ---
        const recBox = new St.BoxLayout({vertical: false});
        recBox.set_x_align(Clutter.ActorAlign.CENTER);
        recBox.set_y_align(Clutter.ActorAlign.CENTER);
        const dot = new St.Label({style_class: 'rec-dot', text: '●'});
        dot.set_margin_right(8);
        this._recLabel = new St.Label({style_class: 'rec-text', text: 'Merekam 00:00'});
        recBox.add_child(dot);
        recBox.add_child(this._recLabel);

        // --- panel ---
        const panel = new St.BoxLayout({vertical: true});
        const heading = (t) => {
            const l = new St.Label({style_class: 'panel-heading', text: t});
            panel.add_child(l);
            return l;
        };
        const info = (t) => {
            const l = new St.Label({style_class: 'panel-text', text: t});
            panel.add_child(l);
            return l;
        };
        heading('MEDIA');
        this._panelMedia = info('Tidak ada media diputar');
        heading('BATERAI');
        this._panelBatt = info('-');
        heading('REKAM LAYAR');
        this._panelRec = info('Tidak merekam');
        heading('TIMER');
        const timerRow = new St.BoxLayout({vertical: false});
        timerRow.set_margin_top(4);
        for (const [label, secs] of [['1 mnt', 60], ['5 mnt', 300], ['10 mnt', 600], ['25 mnt', 1500]]) {
            const b = new St.Button({label, style_class: 'preset-btn'});
            b.set_margin_right(6);
            b.connect('clicked', () => this._startTimer(secs));
            timerRow.add_child(b);
        }
        const stopBtn = new St.Button({label: 'Berhenti', style_class: 'preset-btn'});
        stopBtn.connect('clicked', () => this._stopTimer(true));
        timerRow.add_child(stopBtn);
        panel.add_child(timerRow);
        this._panelTimer = new St.Label({style_class: 'panel-dim', text: 'Timer tidak aktif'});
        this._panelTimer.set_margin_top(4);
        panel.add_child(this._panelTimer);
        heading('NOTIFIKASI TERAKHIR');
        this._panelNotifyBox = new St.BoxLayout({vertical: true});
        panel.add_child(this._panelNotifyBox);

        this._pages = {
            clock: clockBox,
            media: mediaBox,
            notify: notifyBox,
            recording: recBox,
            panel,
        };
        for (const [name, page] of Object.entries(this._pages)) {
            page.set_x_expand(true);
            page.set_y_expand(true);
            page.visible = name === 'clock';
            this._actor.add_child(page);
        }

        const [w, h] = SIZES.clock;
        this._actor.set_size(w, h);
        Main.layoutManager.uiGroup.add_child(this._actor);
        this._reposition();
        this._monitorsChangedId = Main.layoutManager.connect(
            'monitors-changed', () => this._reposition());
        // Pop-in: mulai kecil lalu memantul ke ukuran jam
        this._actor.set_size(48, 48);
        this._reposition();
        this._animateTo(SIZES.clock);
    }

    _reposition() {
        if (!this._actor)
            return;
        const mon = Main.layoutManager.primaryMonitor;
        if (!mon)
            return;
        const x = Math.round(mon.x + (mon.width - this._actor.width) / 2);
        this._actor.set_position(x, mon.y + 6);
    }

    _animateTo([w, h]) {
        this._actor.remove_all_transitions();
        this._actor.ease({
            width: w,
            height: h,
            duration: 420,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
            onUpdate: () => this._reposition(),
            onComplete: () => this._reposition(),
        });
    }

    _setState(state) {
        this._state = state;
        for (const [name, page] of Object.entries(this._pages))
            page.visible = name === state;
        this._actor.style_class = state === 'panel'
            ? 'island island-panel-radius'
            : 'island';
        this._animateTo(SIZES[state]);
    }

    _togglePanel(open) {
        this._panelOpen = open;
        if (open) {
            this._refreshPanel();
            this._setState('panel');
        } else if (this._notifyTimeoutId !== null) {
            this._setState('notify');
        } else {
            this._resolveState();
        }
    }

    _resolveState() {
        if (this._panelOpen || this._notifyTimeoutId !== null)
            return;
        if (this._recSince !== null)
            this._setState('recording');
        else if (this._activePlayer())
            this._setState('media');
        else
            this._setState('clock');
    }

    // ------------------------------------------------------------ D-Bus ----
    _buildDbus() {
        this._dbusProxy = new DBusProxy(Gio.DBus.session,
            'org.freedesktop.DBus', '/org/freedesktop/DBus');
        this._nameSignalId = this._dbusProxy.connectSignal(
            'NameOwnerChanged', (_p, _s, [name, _old, newOwner]) => {
                if (!name.startsWith('org.mpris.MediaPlayer2.'))
                    return;
                if (newOwner && !this._players.has(name)) {
                    try {
                        this._players.set(name, new Player(name,
                            () => this._mediaChanged()));
                        this._mediaChanged();
                    } catch (e) { /* abaikan pemain yang gagal dibaca */ }
                } else if (!newOwner && this._players.has(name)) {
                    this._players.delete(name);
                    this._mediaChanged();
                }
            });
        this._dbusProxy.ListNamesAsync()
            .then(([names]) => {
                for (const name of names) {
                    if (name.startsWith('org.mpris.MediaPlayer2.') &&
                        !this._players.has(name)) {
                        try {
                            this._players.set(name, new Player(name,
                                () => this._mediaChanged()));
                        } catch (e) { /* abaikan */ }
                    }
                }
                this._mediaChanged();
            })
            .catch(() => {});

        try {
            this._upower = new UPowerProxy(Gio.DBus.system,
                'org.freedesktop.UPower',
                '/org/freedesktop/UPower/devices/DisplayDevice');
            this._upower.connect('g-properties-changed',
                () => this._readBattery(false));
            this._readBattery(true);
        } catch (e) {
            this._upower = null;
        }
    }

    _readBattery(initial) {
        if (!this._upower)
            return;
        const pct = this._upower.Percentage;
        const state = this._upower.State;
        if (pct === null || pct === undefined)
            return;
        const newPct = Math.round(pct);
        const changed = state !== this._batteryState && !initial;
        this._batteryPct = newPct;
        this._batteryState = state;
        if (state === 1)
            this._lowBattWarned = false;
        if (changed) {
            if (state === 1)
                this._showNotification('Baterai', 'battery', '', `Mengisi daya — ${newPct}%`);
            else if (state === 2)
                this._showNotification('Baterai', 'battery', '', `Berhenti mengisi — ${newPct}%`);
            else if (state === 4)
                this._showNotification('Baterai', 'battery', '', 'Baterai penuh — 100%');
        }
        if (!initial && state === 2 && newPct <= LOW_BATT_PCT && !this._lowBattWarned) {
            this._lowBattWarned = true;
            this._showNotification('Baterai lemah', 'battery', '',
                `Sisa ${newPct}% — sambungkan charger`);
        }
        this._refreshPanel();
    }

    // ------------------------------------------------------------ media ----
    _activePlayer() {
        for (const p of this._players.values()) {
            if (p.status === 'Playing')
                return p;
        }
        for (const p of this._players.values()) {
            if (p.status === 'Paused' && p.title)
                return p;
        }
        return null;
    }

    _mediaChanged() {
        const p = this._activePlayer();
        if (p) {
            this._mediaTitle.set_text(p.title || 'Tanpa judul');
            this._mediaArtist.set_text(p.artist || p.busName.split('.').pop());
            if (p.artUrl && p.artUrl.startsWith('file://')) {
                this._mediaArt.set_gicon(Gio.FileIcon.new(
                    Gio.File.new_for_path(p.artUrl.slice(7))));
                this._mediaArt.visible = true;
            } else if (p.artUrl) {
                this._mediaArt.set_gicon(Gio.FileIcon.new(
                    Gio.File.new_for_uri(p.artUrl)));
                this._mediaArt.visible = true;
            } else {
                this._mediaArt.visible = false;
            }
            this._updateProgress(p);
        }
        this._refreshPanel();
        this._resolveState();
    }

    _updateProgress(p) {
        if (p && p.lengthUs > 0) {
            const frac = Math.min(1, p.estimatedPosition() / p.lengthUs);
            this._mediaFill.set_width(Math.round(frac * 170));
            this._mediaTrack.visible = true;
        } else {
            this._mediaTrack.visible = false;
        }
    }

    // -------------------------------------------------------- notifikasi ---
    _pollNotifications() {
        try {
            const sources = Main.messageTray.getSources();
            for (const source of sources) {
                const notifs = source.notifications ?? [];
                if (!notifs.length)
                    continue;
                const n = notifs[notifs.length - 1];
                if (n === this._lastNotif)
                    continue;
                this._lastNotif = n;
                const when = n.datetime ? n.datetime.to_unix() : 0;
                if (when && (Date.now() / 1000 - when) > 10)
                    continue; // notifikasi lama saat ekstensi baru aktif
                this._showNotification(source.title ?? 'Notifikasi', '',
                    n.title ?? '', n.body ?? '');
            }
        } catch (e) { /* API MessageTray berubah — fitur ini diam saja */ }
    }

    _showNotification(app, iconName, summary, body) {
        this._notifyHistory.unshift({app, summary});
        this._notifyHistory = this._notifyHistory.slice(0, 5);
        this._notifyApp.set_text(app || 'Notifikasi');
        this._notifySummary.set_text(summary || '');
        this._notifyBody.set_text(body || '');
        this._notifyBody.visible = !!body;
        if (iconName) {
            this._notifyIcon.set_icon_name(iconName);
            this._notifyIcon.visible = true;
        } else {
            this._notifyIcon.visible = false;
        }
        this._refreshPanel();
        if (this._panelOpen)
            return;
        this._setState('notify');
        if (this._notifyTimeoutId)
            GLib.source_remove(this._notifyTimeoutId);
        this._notifyTimeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, NOTIFY_SHOW_S, () => {
                this._notifyTimeoutId = null;
                this._resolveState();
                return GLib.SOURCE_REMOVE;
            });
    }

    // ------------------------------------------------------------- timer ---
    _startTimer(seconds) {
        this._timerTotal = seconds;
        this._timerEnd = GLib.get_monotonic_time() / 1e6 + seconds;
        this._refreshPanel();
    }

    _stopTimer(announce) {
        this._timerEnd = null;
        this._timerTotal = 0;
        this._refreshPanel();
        if (!announce)
            this._resolveState();
    }

    _timerRemaining() {
        if (this._timerEnd === null)
            return null;
        return Math.max(0, this._timerEnd - GLib.get_monotonic_time() / 1e6);
    }

    // ----------------------------------------------------------- perekam ---
    _scanRecorders() {
        try {
            const proc = Gio.Subprocess.new(
                ['pgrep', '-x', RECORDER_PATTERN],
                Gio.SubprocessFlags.STDOUT_SILENCE |
                Gio.SubprocessFlags.STDERR_SILENCE);
            proc.wait_check_async(null, (_p, res) => {
                let found = false;
                try {
                    found = proc.wait_check_finish(res);
                } catch (e) {
                    found = false; // pgrep exit 1 = tidak ada yang cocok
                }
                if (found && this._recSince === null) {
                    this._recSince = GLib.get_monotonic_time() / 1e6;
                    this._resolveState();
                } else if (!found && this._recSince !== null) {
                    this._recSince = null;
                    this._resolveState();
                }
                this._refreshPanel();
            });
        } catch (e) { /* pgrep tidak ada — lewati */ }
    }

    // -------------------------------------------------------------- panel --
    _refreshPanel() {
        if (!this._actor)
            return;
        const p = this._activePlayer();
        this._panelMedia.set_text(p
            ? `${p.title} — ${p.artist}`.replace(/ — $/, '')
            : 'Tidak ada media diputar');
        if (this._batteryPct !== null) {
            const st = {1: 'mengisi', 2: 'terpakai', 4: 'penuh'}[this._batteryState] ?? '';
            this._panelBatt.set_text(`${this._batteryPct}% ${st}`.trim());
        } else {
            this._panelBatt.set_text('-');
        }
        this._panelRec.set_text(this._recSince !== null
            ? `Sedang merekam — ${fmtHms(GLib.get_monotonic_time() / 1e6 - this._recSince)}`
            : 'Tidak merekam');
        const remaining = this._timerRemaining();
        this._panelTimer.set_text(remaining !== null
            ? `Berjalan: sisa ${fmtHms(remaining)} dari ${fmtHms(this._timerTotal)}`
            : 'Timer tidak aktif');
        this._panelNotifyBox.destroy_all_children();
        if (!this._notifyHistory.length) {
            const l = new St.Label({style_class: 'panel-dim', text: 'Belum ada notifikasi'});
            this._panelNotifyBox.add_child(l);
        } else {
            for (const item of this._notifyHistory) {
                const l = new St.Label({
                    style_class: 'panel-text',
                    text: `${item.app}: ${item.summary}`,
                });
                this._panelNotifyBox.add_child(l);
            }
        }
    }

    // --------------------------------------------------------------- tick --
    _tick() {
        const now = new Date();
        const hh = String(now.getHours()).padStart(2, '0');
        const mm = String(now.getMinutes()).padStart(2, '0');
        this._clockTime.set_text(`${hh}:${mm}`);

        const remaining = this._timerRemaining();
        if (remaining !== null && remaining <= 0) {
            const total = this._timerTotal;
            this._stopTimer(false);
            this._showNotification('Timer', 'alarm-clock', '',
                `Waktu habis! (${fmtHms(total)})`);
        }
        if (remaining !== null && remaining > 0) {
            this._clockSub.set_text(`Timer ${fmtHms(remaining)}`);
            this._clockSub.style_class = 'timer-chip';
            this._clockSub.set_margin_left(10);
        } else {
            const days = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
            const months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul',
                'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
            this._clockSub.set_text(
                `${days[now.getDay()]}, ${now.getDate()} ${months[now.getMonth()]}`);
            this._clockSub.style_class = 'clock-date';
            this._clockSub.set_margin_left(10);
        }

        if (this._recSince !== null) {
            this._recLabel.set_text(
                `Merekam ${fmtHms(GLib.get_monotonic_time() / 1e6 - this._recSince)}`);
        }

        const p = this._activePlayer();
        if (p) {
            p.pollPosition();
            if (this._state === 'media')
                this._updateProgress(p);
        }
        if (this._panelOpen)
            this._refreshPanel();
    }
}

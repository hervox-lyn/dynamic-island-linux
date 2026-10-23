// Dynamic Island untuk GNOME Shell (Wayland & X11)
// =================================================
// Pil compact di tengah-atas layar yang hidup di dalam UI GNOME Shell.
//
// Perilaku (mengikuti konsep Dynamic Island):
//   * Idle              -> pil kecil: jam + tanggal
//   * Media diputar     -> pil memanjang sedikit: cover kecil + judul
//                          + equalizer menari (tanpa tombol/progress)
//   * Klik saat media   -> DETAIL media player saja (cover besar,
//     aktif                equalizer, progress + waktu, kontrol tengah)
//                          — fitur lain tidak ikut tampil
//   * Klik saat idle    -> panel umum (baterai, timer, rekaman, notif)
//   * Notifikasi masuk  -> pil melebar sesaat
//   * Rekam layar       -> titik merah berdenyut + durasi
// Posisi terkunci tengah-atas: pil tinggal di wadah selebar monitor
// yang rata-tengah, jadi animasi ukurannya selalu simetris dari tengah.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const SIZES = {
    clock: [188, 44],
    media: [276, 48],
    mediadetail: [380, 200],
    notify: [384, 66],
    recording: [276, 48],
    panel: [416, 404],
};
const NOTIFY_SHOW_S = 5;
const LOW_BATT_PCT = 20;
const RECORDER_PATTERN = '^(obs|wf-recorder|kooha|simplescreenrecorder|vokoscreenNG|vokoscreen|byzanz-record)$';
const DETAIL_PROGRESS_W = 252;

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

function deepUnwrap(v) {
    // Beberapa pemain (terutama Chrome) membungkus nilai metadata dalam
    // varian berlapis — buka semua lapisannya sampai nilai JS murni,
    // supaya tidak muncul teks "[object variant of type ...]".
    if (v instanceof GLib.Variant)
        return deepUnwrap(v.unpack());
    if (Array.isArray(v))
        return v.map(deepUnwrap);
    if (v && typeof v === 'object') {
        const out = {};
        for (const [k, val] of Object.entries(v))
            out[k] = deepUnwrap(val);
        return out;
    }
    return v;
}

function icon(name, size, cls) {
    return new St.Icon({
        icon_name: name,
        icon_size: size,
        style_class: cls ?? '',
    });
}

function makeEq(barCount, pattern) {
    const box = new St.BoxLayout({vertical: false});
    box.set_y_align(Clutter.ActorAlign.END);
    box.set_height(16);
    const bars = [];
    for (let i = 0; i < barCount; i++) {
        const bar = new St.Widget({style_class: 'eq-bar'});
        bar.set_size(3, 5);
        bar.set_y_align(Clutter.ActorAlign.END);
        if (i > 0)
            bar.set_margin_left(2);
        box.add_child(bar);
        bars.push(bar);
    }
    return {box, bars, pattern};
}

let eqPhase = 0;
function animateEq(eq) {
    // Gelombang deterministik ala referensi (bukan acak): tiap batang
    // mengikuti pola tinggi dasar dengan fase bergeser — gerakannya
    // halus, berirama, dan sinkron antar batang.
    eqPhase += 0.85;
    eq.bars.forEach((bar, i) => {
        const base = eq.pattern[i % eq.pattern.length];
        const wave = 0.5 + 0.5 * Math.sin(eqPhase + i * 1.15);
        const h = Math.max(3, Math.round(base * (0.62 + 0.5 * wave)));
        bar.remove_all_transitions();
        bar.ease({
            height: h,
            duration: 470,
            mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
        });
    });
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
                const props = deepUnwrap(values);
                this.status = props.PlaybackStatus ?? 'Stopped';
                const meta = props.Metadata ?? {};
                this.title = meta['xesam:title'] ?? '';
                const artists = meta['xesam:artist'] ?? [];
                this.artist = Array.isArray(artists)
                    ? artists.join(', ')
                    : `${artists}`;
                this.artUrl = meta['mpris:artUrl'] ?? '';
                this.lengthUs = meta['mpris:length'] ?? 0;
                this.positionUs = props.Position ?? 0;
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
        this._detailOpen = false;
        this._players = new Map();
        this._notifyHistory = [];
        this._notifyTimeoutId = null;
        this._batteryPct = null;
        this._batteryState = null;
        this._lowBattWarned = false;
        this._timerEnd = null;
        this._timerTotal = 0;
        this._recSince = null;
        this._recPulse = false;
        this._pausedSince = null;
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
            this._dbusProxy.disconnectSignal(this._nameSignalId);
            this._nameSignalId = null;
        }
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = null;
        }
        this._players.clear();
        if (this._container) {
            Main.layoutManager.uiGroup.remove_child(this._container);
            this._container.destroy();
            this._container = null;
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

    _anyOpen() {
        return this._panelOpen || this._detailOpen;
    }

    // ------------------------------------------------------------- UI ------
    _buildUi() {
        this._actor = new St.BoxLayout({
            style_class: 'island',
            vertical: true,
            reactive: true,
            clip_to_allocation: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
        });
        this._actor.connect('button-press-event', (_a, event) => {
            const isRight = event.get_button() === 3;
            if (this._detailOpen) {
                if (!isRight)
                    this._closeDetail();
                return Clutter.EVENT_STOP;
            }
            if (this._panelOpen) {
                this._togglePanel(false);
                return Clutter.EVENT_STOP;
            }
            if (isRight)
                return Clutter.EVENT_STOP;
            // Klik kiri: media aktif -> detail media; idle -> panel umum
            if (this._activePlayer())
                this._openDetail();
            else
                this._togglePanel(true);
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

        // --- halaman media COMPACT: cover kecil + judul + equalizer ---
        const mediaBox = new St.BoxLayout({vertical: false});
        mediaBox.set_y_align(Clutter.ActorAlign.CENTER);
        this._mediaArt = new St.Icon({
            icon_size: 26,
            style_class: 'media-art-sm',
        });
        this._mediaArt.set_margin_right(10);
        this._mediaTitle = new St.Label({
            style_class: 'media-compact-title', text: '',
        });
        this._mediaTitle.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        this._mediaTitle.set_x_expand(true);
        this._mediaTitle.set_y_align(Clutter.ActorAlign.CENTER);
        this._eqCompact = makeEq(4, [10, 16, 12, 9]);
        this._eqCompact.box.set_margin_left(10);
        this._eqCompact.box.set_y_align(Clutter.ActorAlign.CENTER);
        mediaBox.add_child(this._mediaArt);
        mediaBox.add_child(this._mediaTitle);
        mediaBox.add_child(this._eqCompact.box);

        // --- halaman DETAIL media player (ala kartu Dynamic Island) ---
        const detail = new St.BoxLayout({vertical: true});
        const dHead = new St.BoxLayout({vertical: false});
        this._detailArt = new St.Icon({
            icon_size: 50,
            style_class: 'media-art-lg',
        });
        this._detailArt.set_margin_right(13);
        const dTitles = new St.BoxLayout({vertical: true});
        dTitles.set_y_align(Clutter.ActorAlign.CENTER);
        dTitles.set_x_expand(true);
        this._detailTitle = new St.Label({
            style_class: 'detail-title', text: '',
        });
        this._detailTitle.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        this._detailArtist = new St.Label({
            style_class: 'detail-artist', text: '',
        });
        this._detailArtist.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        dTitles.add_child(this._detailTitle);
        dTitles.add_child(this._detailArtist);
        this._eqDetail = makeEq(5, [12, 20, 16, 22, 14]);
        this._eqDetail.box.set_margin_left(12);
        this._eqDetail.box.set_y_align(Clutter.ActorAlign.CENTER);
        dHead.add_child(this._detailArt);
        dHead.add_child(dTitles);
        dHead.add_child(this._eqDetail.box);
        detail.add_child(dHead);

        const progRow = new St.BoxLayout({vertical: false});
        progRow.set_margin_top(20);
        this._detailElapsed = new St.Label({
            style_class: 'detail-time', text: '0:00',
        });
        const dTrack = new St.BoxLayout({
            style_class: 'progress-track', vertical: false,
        });
        dTrack.set_width(DETAIL_PROGRESS_W);
        dTrack.set_margin_left(8);
        dTrack.set_margin_right(8);
        dTrack.set_y_align(Clutter.ActorAlign.CENTER);
        this._detailFill = new St.Widget({style_class: 'progress-fill'});
        this._detailFill.set_width(0);
        dTrack.add_child(this._detailFill);
        this._detailTrack = dTrack;
        this._detailTotal = new St.Label({
            style_class: 'detail-time', text: '0:00',
        });
        progRow.add_child(this._detailElapsed);
        progRow.add_child(dTrack);
        progRow.add_child(this._detailTotal);
        detail.add_child(progRow);

        const ctlRow = new St.BoxLayout({vertical: false});
        ctlRow.set_x_align(Clutter.ActorAlign.CENTER);
        ctlRow.set_margin_top(20);
        const mkCtl = (iconName, size, method, ref, big) => {
            const btn = new St.Button({
                style_class: big ? 'ctl-btn-lg' : 'ctl-btn',
            });
            const ic = icon(iconName, size);
            if (ref)
                this[ref] = ic;
            btn.set_child(ic);
            btn.connect('clicked', () => {
                const p = this._activePlayer();
                if (p)
                    p.call(method);
            });
            return btn;
        };
        const prevBtn = mkCtl('media-skip-backward-symbolic', 18, 'Previous', null, false);
        this._detailPlayBtn = mkCtl('media-playback-pause-symbolic', 22, 'PlayPause', '_detailPlayIcon', true);
        this._detailPlayBtn.set_margin_left(18);
        this._detailPlayBtn.set_margin_right(18);
        const nextBtn = mkCtl('media-skip-forward-symbolic', 18, 'Next', null, false);
        ctlRow.add_child(prevBtn);
        ctlRow.add_child(this._detailPlayBtn);
        ctlRow.add_child(nextBtn);
        detail.add_child(ctlRow);

        // --- halaman notifikasi ---
        const notifyBox = new St.BoxLayout({vertical: false});
        notifyBox.set_y_align(Clutter.ActorAlign.CENTER);
        this._notifyIcon = new St.Icon({icon_size: 30});
        this._notifyIcon.set_margin_right(11);
        const ntext = new St.BoxLayout({vertical: true});
        ntext.set_y_align(Clutter.ActorAlign.CENTER);
        ntext.set_x_expand(true);
        this._notifyApp = new St.Label({style_class: 'notify-app', text: ''});
        this._notifySummary = new St.Label({style_class: 'notify-summary', text: ''});
        this._notifySummary.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        this._notifyBody = new St.Label({style_class: 'notify-body', text: ''});
        this._notifyBody.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        ntext.add_child(this._notifyApp);
        ntext.add_child(this._notifySummary);
        ntext.add_child(this._notifyBody);
        notifyBox.add_child(this._notifyIcon);
        notifyBox.add_child(ntext);

        // --- halaman rekaman (titik berdenyut) ---
        const recBox = new St.BoxLayout({vertical: false});
        recBox.set_x_align(Clutter.ActorAlign.CENTER);
        recBox.set_y_align(Clutter.ActorAlign.CENTER);
        this._recDot = new St.Widget({style_class: 'rec-dot'});
        this._recDot.set_size(10, 10);
        this._recDot.set_pivot_point(0.5, 0.5);
        this._recDot.set_margin_right(9);
        this._recDot.set_y_align(Clutter.ActorAlign.CENTER);
        this._recLabel = new St.Label({style_class: 'rec-text', text: 'Merekam 00:00'});
        recBox.add_child(this._recDot);
        recBox.add_child(this._recLabel);

        // --- panel umum (hanya dibuka saat TIDAK ada media) ---
        const panel = new St.BoxLayout({vertical: true});
        const heading = (iconName, t, first) => {
            const row = new St.BoxLayout({vertical: false});
            if (!first)
                row.set_margin_top(10);
            const chip = new St.Bin({style_class: 'heading-chip'});
            chip.set_size(22, 22);
            const ic = icon(iconName, 12, 'panel-heading-icon');
            ic.set_x_align(Clutter.ActorAlign.CENTER);
            ic.set_y_align(Clutter.ActorAlign.CENTER);
            chip.set_child(ic);
            chip.set_margin_right(8);
            row.add_child(chip);
            const lab = new St.Label({style_class: 'panel-heading', text: t});
            lab.set_y_align(Clutter.ActorAlign.CENTER);
            row.add_child(lab);
            panel.add_child(row);
        };
        const info = (t) => {
            const l = new St.Label({style_class: 'panel-text', text: t});
            l.set_margin_top(3);
            l.set_margin_left(30);
            panel.add_child(l);
            return l;
        };
        const separator = () => {
            const s = new St.Widget({style_class: 'sep'});
            s.set_height(1);
            s.set_margin_top(9);
            panel.add_child(s);
        };
        heading('audio-x-generic-symbolic', 'MEDIA', true);
        this._panelMedia = info('Tidak ada media diputar');
        separator();
        heading('battery-full-symbolic', 'BATERAI');
        this._panelBatt = info('-');
        separator();
        heading('media-record-symbolic', 'REKAM LAYAR');
        this._panelRec = info('Tidak merekam');
        separator();
        heading('alarm-symbolic', 'TIMER');
        const timerRow = new St.BoxLayout({vertical: false});
        timerRow.set_margin_top(6);
        timerRow.set_x_align(Clutter.ActorAlign.CENTER);
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
        this._panelTimer.set_margin_top(5);
        this._panelTimer.set_margin_left(30);
        panel.add_child(this._panelTimer);
        separator();
        heading('preferences-system-notifications-symbolic', 'NOTIFIKASI TERAKHIR');
        this._panelNotifyBox = new St.BoxLayout({vertical: true});
        this._panelNotifyBox.set_margin_top(3);
        this._panelNotifyBox.set_margin_left(30);
        panel.add_child(this._panelNotifyBox);

        this._pages = {
            clock: clockBox,
            media: mediaBox,
            mediadetail: detail,
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

        // Wadah selebar monitor berjangkar di tepi atas — pil selalu
        // ditengahkan ulang setiap frame animasi (membesar simetris).
        this._container = new St.Bin({reactive: false});
        this._container.add_child(this._actor);
        Main.layoutManager.uiGroup.add_child(this._container);
        this._reposition();
        this._monitorsChangedId = Main.layoutManager.connect(
            'monitors-changed', () => this._reposition());
        // Pop-in: mulai kecil lalu memantul ke ukuran jam
        this._actor.set_size(48, 48);
        this._animateTo(SIZES.clock);
    }

    _reposition() {
        if (!this._container)
            return;
        const mon = Main.layoutManager.primaryMonitor;
        if (!mon)
            return;
        this._container.set_position(mon.x, mon.y + 6);
        this._container.set_width(mon.width);
    }

    _animateTo([w, h]) {
        this._actor.remove_all_transitions();
        this._actor.ease({
            width: w,
            height: h,
            duration: 420,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
    }

    _setState(state) {
        this._state = state;
        for (const [name, page] of Object.entries(this._pages))
            page.visible = name === state;
        // Konten halaman baru memudar masuk (fade+sedikit napas) seperti
        // pola AnimatePresence di referensi — transisi terasa premium.
        const page = this._pages[state];
        page.opacity = 0;
        page.remove_all_transitions();
        page.ease({
            opacity: 255,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._actor.style_class =
            (state === 'panel' || state === 'mediadetail')
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

    _openDetail() {
        this._detailOpen = true;
        this._mediaChanged();
        this._setState('mediadetail');
    }

    _closeDetail() {
        this._detailOpen = false;
        if (this._notifyTimeoutId !== null)
            this._setState('notify');
        else
            this._resolveState();
    }

    _resolveState() {
        if (this._anyOpen() || this._notifyTimeoutId !== null)
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
                this._showNotification('Baterai', 'battery-full-symbolic', '', `Mengisi daya — ${newPct}%`);
            else if (state === 2)
                this._showNotification('Baterai', 'battery-full-symbolic', '', `Berhenti mengisi — ${newPct}%`);
            else if (state === 4)
                this._showNotification('Baterai', 'battery-full-symbolic', '', 'Baterai penuh — 100%');
        }
        if (!initial && state === 2 && newPct <= LOW_BATT_PCT && !this._lowBattWarned) {
            this._lowBattWarned = true;
            this._showNotification('Baterai lemah', 'battery-caution-symbolic', '',
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

    _setArt(widget, artUrl, fallbackIcon) {
        if (artUrl && artUrl.startsWith('file://')) {
            widget.set_gicon(Gio.FileIcon.new(
                Gio.File.new_for_path(artUrl.slice(7))));
        } else if (artUrl) {
            widget.set_gicon(Gio.FileIcon.new(
                Gio.File.new_for_uri(artUrl)));
        } else {
            widget.set_gicon(null);
            widget.set_icon_name(fallbackIcon);
        }
        widget.visible = true;
    }

    _mediaChanged() {
        const p = this._activePlayer();
        if (!p && this._detailOpen) {
            // Media berhenti total saat detail terbuka -> tutup detail
            this._detailOpen = false;
        }
        if (p) {
            const title = p.title || 'Tanpa judul';
            const artist = p.artist || p.busName.split('.').pop();
            this._mediaTitle.set_text(title);
            this._detailTitle.set_text(title);
            this._detailArtist.set_text(artist);
            this._setArt(this._mediaArt, p.artUrl, 'audio-x-generic-symbolic');
            this._setArt(this._detailArt, p.artUrl, 'audio-x-generic-symbolic');
            const playName = p.status === 'Playing'
                ? 'media-playback-pause-symbolic'
                : 'media-playback-start-symbolic';
            if (this._detailPlayIcon)
                this._detailPlayIcon.set_icon_name(playName);
            const eqVisible = p.status === 'Playing';
            this._eqCompact.box.visible = eqVisible;
            this._eqDetail.box.visible = eqVisible;
            this._updateProgress(p);
        }
        this._refreshPanel();
        this._resolveState();
    }

    _updateProgress(p) {
        if (p && p.lengthUs > 0) {
            const pos = p.estimatedPosition();
            const frac = Math.min(1, pos / p.lengthUs);
            this._detailFill.set_width(Math.round(frac * DETAIL_PROGRESS_W));
            this._detailElapsed.set_text(fmtHms(pos / 1e6));
            this._detailTotal.set_text(`-${fmtHms((p.lengthUs - pos) / 1e6)}`);
            this._detailTrack.visible = true;
        } else {
            this._detailTrack.visible = false;
            this._detailElapsed.set_text('0:00');
            this._detailTotal.set_text('0:00');
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
                let gicon = null;
                try {
                    gicon = n.gicon ?? n.icon ?? source.gicon ?? source.icon ?? null;
                } catch (e) {
                    gicon = null;
                }
                this._showNotification(source.title ?? 'Notifikasi', '',
                    n.title ?? '', n.body ?? '', gicon);
            }
        } catch (e) { /* API MessageTray berubah — fitur ini diam saja */ }
    }

    _showNotification(app, iconName, summary, body, gicon) {
        this._notifyHistory.unshift({app, summary});
        this._notifyHistory = this._notifyHistory.slice(0, 5);
        this._notifyApp.set_text(app || 'Notifikasi');
        this._notifySummary.set_text(summary || '');
        this._notifyBody.set_text(body || '');
        this._notifyBody.visible = !!body;
        if (gicon) {
            this._notifyIcon.set_gicon(gicon);
            this._notifyIcon.visible = true;
        } else if (iconName) {
            this._notifyIcon.set_icon_name(iconName);
            this._notifyIcon.visible = true;
        } else {
            this._notifyIcon.visible = false;
        }
        this._refreshPanel();
        if (this._anyOpen())
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
            this._showNotification('Timer', 'alarm-symbolic', '',
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
            this._recPulse = !this._recPulse;
            const s = this._recPulse ? 0.65 : 1.0;
            this._recDot.remove_all_transitions();
            this._recDot.ease({
                scale_x: s,
                scale_y: s,
                opacity: this._recPulse ? 160 : 255,
                duration: 480,
                mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
            });
        }

        const p = this._activePlayer();
        if (p) {
            p.pollPosition();
            // Auto-tutup detail 3 detik setelah media di-pause
            // (pola auto-collapse dari referensi)
            if (p.status === 'Paused') {
                const nowS = GLib.get_monotonic_time() / 1e6;
                if (this._pausedSince === null)
                    this._pausedSince = nowS;
                else if (this._detailOpen && nowS - this._pausedSince > 3) {
                    this._pausedSince = null;
                    this._closeDetail();
                }
            } else {
                this._pausedSince = null;
            }
            if (p.status === 'Playing') {
                if (this._state === 'media')
                    animateEq(this._eqCompact);
                else if (this._state === 'mediadetail')
                    animateEq(this._eqDetail);
            }
            if (this._detailOpen)
                this._updateProgress(p);
        }
        if (this._panelOpen)
            this._refreshPanel();
    }
}

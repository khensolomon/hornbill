import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import { log, logError } from '../util/logger.js';
import { ExtensionComponent } from './base.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { isMaximized, maximize, unmaximize } from '../util/compat.js';

/**
 * Remembers per-app window geometry (keyed by wm_class) and restores it when
 * a NEW window of that app is created.
 *
 * Design rules (each one fixes a real bug from the previous version):
 *
 * 1. NEVER restore already-open windows on enable. GNOME re-enables
 *    extensions on every unlock and shell restart; restoring then snapped
 *    every open window back to its saved slot, scrambling the workspace.
 *    Existing windows are tracked (for saving) only.
 *
 * 2. A new window is "unsettled" until restore has run plus a grace period.
 *    Changes from unsettled windows are IGNORED, so the app's own initial
 *    self-placement can no longer overwrite the saved slot before restore
 *    reads it (the old save/restore race).
 *
 * 3. wm_class is often still null at 'window-created' (especially Wayland).
 *    Restore polls briefly until it appears instead of giving up.
 *
 * 4. Only NORMAL, non-transient, non-skip-taskbar windows are handled.
 *    Dialogs sharing the app's wm_class used to overwrite the app's slot
 *    with dialog-sized geometry.
 *
 * 5. Restored geometry is clamped to the window's current work area, so a
 *    layout saved on a monitor that is gone (or not yet configured during
 *    login) cannot push windows off-screen.
 *
 * 6. The store is pruned (age + size cap) so 'geometry-data' cannot grow
 *    without bound.
 */

// Tuning constants
const WM_CLASS_POLL_MS = 250;     // Poll interval while waiting for the app identity
const WM_CLASS_MAX_TRIES = 12;    // ~3s: identities can CHANGE after mapping (see below)
const SETTLE_GRACE_MS = 600;      // Grace after the last verify pass
const VERIFY_DELAY_MS = 500;      // Delay between restore verification passes
const VERIFY_MAX_TRIES = 4;       // Reapply attempts against app self-placement
const SAVE_DEBOUNCE_SEC = 2;      // Disk write debounce
const PRUNE_MAX_AGE_DAYS = 180;   // Drop entries not seen for this long
const PRUNE_MAX_ENTRIES = 300;    // Hard cap on stored apps
const ANIMATE_AFTER_MS = 250;     // Window visible longer than this -> fade-move, don't snap
const FADE_OUT_MS = 90;           // Fade-out before an already-visible window is moved
const FADE_IN_MS = 140;           // Fade-in at the destination
const MOVE_MIN_DELTA = 8;         // Don't animate sub-8px corrections
const PRUNE_RECENT_KEEP_DAYS = 14; // Recency floor: never evict fresh entries
const CLOAK_OFFSET = -100000;     // Off-screen translation (Wayland only)
const X11_COORD_LIMIT = 32000;    // X11 geometry is 16-bit signed
const X11_APPLY_DELAY_MS = 250;   // Stay clear of the X11 map sequence
const CLOAK_MAX_MS = 550;         // Reveal deadline if identity never resolves
const REVEAL_FADE_MS = 120;       // Soften late reveals (after map anim ended)
const REVEAL_POLL_MS = 16;        // ~1 frame: how often to re-check the client took the geometry
const REVEAL_MAX_TRIES = 6;       // ~96ms cap before revealing regardless
// File-manager location suffixes. Lesion's panel already treats Files, Trash
// and a mounted drive as three separate buttons; geometry mirrors exactly that
// split and nothing finer. Every other folder window is just "a Files window".
const LOC_TRASH = '::trash';
const LOC_DRIVE = '::drive';
const LOC_SETTLE_MS = 120;        // Grace for a file manager to announce its location (must beat 'first-frame')

export class GeometryManager extends ExtensionComponent {

    onEnable() {
        this._saveTimeoutId = null;
        this._geometryCache = {};
        // win -> { signals: [], settled: bool, timerId: 0 }
        this._windowData = new Map();

        log("[Geometry] enabling manager");

        this._lastWrittenJson = null;

        // Location names for the file-manager split. Kept here rather than
        // reached for through AppsManager: the two components stay
        // independent, and this is a handful of strings refreshed on mount
        // changes.
        this._trashName = null;
        this._volumeNames = new Set();
        try {
            const info = Gio.File.new_for_uri('trash:///')
                .query_info('standard::display-name', Gio.FileQueryInfoFlags.NONE, null);
            this._trashName = info.get_display_name()?.trim().toLowerCase() || null;
        } catch (e) { log('[Geometry] trash display name lookup failed', e); }

        this._volumeMonitor = Gio.VolumeMonitor.get();
        this._refreshLocationNames();
        this._mountSignals = ['mount-added', 'mount-removed'].map(sig => ({
            obj: this._volumeMonitor,
            id: this._volumeMonitor.connect(sig, () => this._refreshLocationNames()),
        }));

        try {
            log(`[Geometry] Session type: ${Meta.is_wayland_compositor() ? 'Wayland' : 'X11'}`);
        } catch (e) { log('[Geometry] session type probe failed', e); }
        this._loadCache();
        this._pruneCache();

        // CRITICAL: the preferences window edits 'geometry-data' directly
        // (Forget This Window / Clear All). Without reloading here, the
        // stale in-memory cache kept restoring forgotten entries AND wrote
        // them all back to disk on the next window move — resurrecting the
        // list the user had just cleared. Own writes are recognized via
        // _lastWrittenJson and ignored.
        this.observe('changed::geometry-data', () => {
            let json = null;
            try { json = this.getSettings().get_string('geometry-data'); } catch (e) { logError('onEnable: get_string() failed', e); }
            if (json === null || json === this._lastWrittenJson) return;
            log('[Geometry] Store edited externally — reloading');
            this._loadCache();
        });

        const display = global.display;
        const id = display.connect('window-created', (d, win) => {
            // Never let an exception escape into shell signal emission
            try {
                this._trackWindow(win, true);
            } catch (e) {
                logError('[Geometry] window-created handler failed', e);
            }
        });
        this._signals.push({ obj: display, id });

        // USER INTENT IS AUTHORITATIVE: finishing a drag/resize settles the
        // window immediately. Previously a new window stayed "unsettled"
        // for up to ~3s (identity polling + grace), silently discarding the
        // user's first moves; and a fast drag could close before the save
        // debounce captured the final rect.
        const grabId = display.connect('grab-op-end', (d, win) => {
            const data = win ? this._windowData.get(win) : null;
            if (!data || !this._isAlive(win)) return;
            if (data.timerId) {
                GLib.source_remove(data.timerId);
                data.timerId = 0;
            }
            data.settled = true;
            this._reveal(win, data); // safety: a grabbed window must be visible
            this._onWindowChanged(win);
        });
        this._signals.push({ obj: display, id: grabId });

        // Existing windows: track only — see design rule 1.
        global.display.list_all_windows().forEach(win => this._trackWindow(win, false));

        this.observe('changed::geometry-enabled', () => {
            if (!this.getSettings().get_boolean('geometry-enabled')) {
                this._cleanupWindows();
            } else {
                global.display.list_all_windows().forEach(win => this._trackWindow(win, false));
            }
        });
    }

    onDisable() {
        if (this._saveTimeoutId) {
            GLib.source_remove(this._saveTimeoutId);
            this._saveTimeoutId = null;
            // Flush the pending debounce write so the last moves aren't lost
            this._saveToDisk();
        }
        if (this._mountSignals) {
            this._mountSignals.forEach(({ obj, id }) => {
                try { obj.disconnect(id); } catch (e) { log('onDisable: disconnect() failed', e); }
            });
            this._mountSignals = null;
        }
        this._volumeMonitor = null;
        this._volumeNames = null;
        this._cleanupWindows();
    }

    // --- Tracking ------------------------------------------------------

    /**
     * LIVENESS GUARD. Deferred work (timers, first-frame callbacks) can run
     * after a window has been unmanaged — Chrome's Task Manager creates and
     * destroys windows aggressively. Calling into a destroyed MetaWindow is
     * a use-after-free at the C level, which takes the whole shell down
     * (and on Wayland, the session with it). Every deferred entry point
     * checks this first.
     */
    /**
     * X11 CLIENTS NEED A CONSERVATIVE PATH. Journal evidence (Jul 21):
     * the session did not die from a shell crash — Xwayland itself exited
     * ("Connection to xwayland lost" / "Xwayland exited unexpectedly"),
     * and the shell then quit because Xwayland is mandatory. No [Lesion]
     * error appeared at all. Chrome and its Task Manager are X11 clients,
     * and X11 geometry is 16-bit signed: the cloak's -100000px offset and
     * rapid repeated configure requests from verify retries are exactly
     * the sort of thing that can take an X server down. X11 windows
     * therefore get: no cloak, clamped coordinates, and a single apply.
     */
    /**
     * OPERATION TRACE. The session terminations leave no [Lesion] error
     * because the failure is Xwayland exiting, not a JS exception here. Naming
     * each risky window operation immediately BEFORE it runs makes the
     * final journal line before a crash identify the exact call.
     */
    _trace(win, op, detail = '') {
        try {
            const kind = this._isX11(win) ? 'X11' : 'wl';
            log(`[Geometry] >> ${op} (${kind})${detail ? ' ' + detail : ''}`);
        } catch (e) { log('_trace: _isX11() failed', e); }
    }

    _isX11(win) {
        try {
            return win.get_client_type() === Meta.WindowClientType.X11;
        } catch (e) {
            return false; // unknown: treat as Wayland-safe
        }
    }

    _isAlive(win) {
        if (!win || !this._windowData.has(win)) return false;
        try {
            // get_compositor_private() is the real liveness test; a
            // destroyed window returns null.
            return win.get_compositor_private() !== null;
        } catch (e) {
            return false;
        }
    }

    _shouldManage(win) {
        if (!win) return false;
        // Escape hatch for the Xwayland termination issue: if X11 windows
        // ever destabilize the session again, this can be flipped off from
        // a TTY without loading the preferences UI.
        try {
            if (this._isX11(win) &&
                !this.getSettings().get_boolean('geometry-manage-x11'))
                return false;
        } catch (e) { log('_shouldManage: _isX11() failed', e); }
        // NORMAL only: dialogs, popups, tooltips, docks and menus must not
        // read from or write to the per-app slot.
        if (win.get_window_type() !== Meta.WindowType.NORMAL) return false;
        try {
            if (typeof win.get_transient_for === 'function' && win.get_transient_for()) return false;
            if (typeof win.is_skip_taskbar === 'function' && win.is_skip_taskbar()) return false;
        } catch (e) { log('_shouldManage: get_transient_for() failed', e); }
        return true;
    }

    _trackWindow(win, isNew) {
        if (!this.getSettings().get_boolean('geometry-enabled')) return;
        if (!this._shouldManage(win)) return;
        if (this._windowData.has(win)) return;

        const data = {
            signals: [],
            // Pre-existing windows were placed by the user already, so their
            // changes are trustworthy immediately. New windows must settle
            // first (design rule 2).
            settled: !isNew,
            restored: false,
            wmClassSignalId: 0,
            titleSignalId: 0,
            locTimerId: 0,
            locExpired: false,
            revealTimerId: 0,
            prePlaced: false,
            timerId: 0,
            firstId: null,
            cloaked: false,
            cloakTimerId: 0,
            verifyTimerId: 0,
            settleTimerId: 0,
            x11TimerId: 0,
            shownSeen: false,
            createdAt: GLib.get_monotonic_time(),
        };
        this._windowData.set(win, data);

        data.signals.push(win.connect('unmanaged', () => this._untrackWindow(win)));
        data.signals.push(win.connect('size-changed', () => this._onWindowChanged(win)));
        data.signals.push(win.connect('position-changed', () => this._onWindowChanged(win)));

        if (isNew) {
            // Second early trigger: the actor's first painted frame — some
            // identities land between window-created and first paint.
            try {
                const actor = win.get_compositor_private();
                if (actor) {
                    const ffId = actor.connect('first-frame', () => {
                        actor.disconnect(ffId);
                        if (!this._isAlive(win)) return;
                        this._tryResolveRestore(win, data);
                        this._authoritativeApply(win, data, 'first-frame');
                    });
                }
            } catch (e) { log('_trackWindow: get_compositor_private() failed', e); }

            // THE PLACEMENT OVERRIDE (found via journal analysis: every
            // restore was followed by "moved itself; reapplying" — a 100%
            // rate): Mutter runs its own placement when the window is first
            // SHOWN, discarding any geometry applied before that. Early
            // application is therefore kept only as a hint; the
            // authoritative apply happens in the one-shot 'shown' handler
            // below, after placement has run, while the cloak keeps the
            // whole sequence invisible.
            try {
                const shownId = win.connect('shown', () => {
                    win.disconnect(shownId);
                    if (!this._isAlive(win)) return;
                    data.shownSeen = true;
                    this._authoritativeApply(win, data, 'shown');
                });
            } catch (e) { log('_trackWindow: connect() failed', e); }

            const resolved = this._tryResolveRestore(win, data);
            let idNow = null;
            idNow = this._identityFor(win);

            // Cloak when something will happen off-view: either a restore
            // already resolved (it must be re-applied post-placement) or the
            // identity is still unknown (a restore may yet resolve). Known
            // identity with nothing saved maps naturally, uncloaked.
            // Holding counts as "something will happen off-view": without
            // this a folder window that already had a title at creation was
            // left uncloaked through the grace and then moved in plain sight.
            if (resolved || !idNow || this._isLocationPending(idNow, data))
                this._cloak(win, data);

            if (!resolved)
                this._scheduleRestore(win, data, 0);
        }
    }

    _untrackWindow(win) {
        const data = this._windowData.get(win);
        if (!data) return;

        if (data.cloakTimerId) {
            GLib.source_remove(data.cloakTimerId);
            data.cloakTimerId = 0;
        }

        try {
            const actor = win.get_compositor_private();
            if (actor) {
                // A disable mid-fade/mid-cloak must not leave the window
                // translucent or off-screen
                actor.remove_transition('opacity');
                if (actor.opacity < 255) actor.opacity = 255;
                if (actor.translation_x !== 0) actor.translation_x = 0;
            }
        } catch (e) { log('_untrackWindow: get_compositor_private() failed', e); }

        for (const slot of ['timerId', 'verifyTimerId', 'settleTimerId', 'x11TimerId', 'locTimerId', 'revealTimerId']) {
            if (data[slot]) {
                GLib.source_remove(data[slot]);
                data[slot] = 0;
            }
        }
        data.signals.forEach(id => {
            try { win.disconnect(id); } catch (e) { log('_untrackWindow: disconnect() failed', e); }
        });
        this._windowData.delete(win);
    }

    _cleanupWindows() {
        for (const win of [...this._windowData.keys()])
            this._untrackWindow(win);
    }

    // --- Restore -------------------------------------------------------

    /**
     * Restores once wm_class is available (polling briefly — Wayland apps
     * often set it after 'window-created'), then marks the window settled
     * after a grace period so saving can begin.
     */
    /**
     * CANONICAL IDENTITY. wm_class is session-dependent: the same app
     * reports different values under Wayland and Xorg ('TextEditor' vs
     * 'gnome-text-editor', 'gnome-terminal-server' vs 'gnome-terminal'),
     * so each session built a store the other could not read — and on Xorg
     * the value CHANGES mid-launch, making the early restore and the
     * authoritative apply resolve two different entries: the two-stage
     * flight.
     *
     * Shell.WindowTracker maps any window, X11 or Wayland, to its .desktop
     * app, which is identical across sessions. That app id is the key;
     * wm_class remains the fallback for windows the tracker cannot match
     * (many terminals, some Electron and Wine apps).
     */
    /**
     * Shell.WindowTracker invents a fallback id of the form 'window:N' for
     * windows it cannot match to a .desktop file. Those ids come from an
     * internal counter and are RECYCLED across unrelated windows, so they
     * must never be stored or aliased: doing so taught the extension that
     * 'window:3' meant Chrome, and Chrome's Task Manager — an unmatched
     * window that later drew the same id — was then resized to Chrome's
     * main-window geometry, ending the session.
     */
    _isSyntheticId(id) {
        return !id || /^window:\d+$/.test(id);
    }

    _isFileManagerId(id) {
        return !!id && (id.includes('nautilus') || id.includes('Nautilus'));
    }

    /**
     * Base identity without a location suffix, used wherever two ids must be
     * compared as "the same application" — alias learning in particular, which
     * would otherwise record 'Nautilus -> Nautilus::trash' the first time a
     * Trash window resolved its location and then send every Files window to
     * the Trash slot.
     */
    _baseId(id) {
        return id ? id.split('::')[0] : id;
    }

    /**
     * THE FILE MANAGER IS THE ONE EXCEPTION.
     *
     * Every other application gets a single slot: one window's worth of
     * geometry, and when several are open the last one moved is the one worth
     * remembering. A file manager is different because Lesion's panel already
     * treats Files, Trash and a mounted drive as three separate buttons, and a
     * user reasonably expects those three to remember three positions.
     *
     * The split is exactly those three and nothing finer. An ordinary folder
     * window — Home, Documents, anything else — is just a Files window and
     * shares the base slot. Only the trash display name and mounted volume
     * names are compared, never the title in general, so no document, path or
     * site name is read or stored.
     */
    _locationSuffix(win) {
        const title = (this._safeTitle(win) || '').trim().toLowerCase();
        if (!title) return '';

        if (this._trashName && title === this._trashName) return LOC_TRASH;
        // All drives share one slot, for the same reason all Chrome windows
        // do: several open at once means the last one moved wins.
        if (this._volumeNames.has(title)) return LOC_DRIVE;
        return '';
    }

    _identityFor(win) {
        if (!win) return null;
        let id = null;
        try {
            const app = Shell.WindowTracker.get_default().get_window_app(win);
            const appId = app?.get_id()?.replace(/\.desktop$/, '');
            if (appId && !this._isSyntheticId(appId)) id = appId;
        } catch (e) { log('_identityFor: get_default() failed', e); }

        if (!id) {
            try { id = win.get_wm_class() || null; } catch (e) { return null; }
        }
        if (!id) return null;
        if (!this._isFileManagerId(id)) return id;

        // A file manager window whose title has not arrived cannot be placed
        // yet: it might be Files, Trash or a drive. Reporting "unresolved"
        // routes it through the existing cloak-and-poll path rather than
        // adding a second waiting mechanism, and the poll is already bounded
        // by WM_CLASS_MAX_TRIES with a reveal fallback.
        if (!this._safeTitle(win)) return null;

        return id + this._locationSuffix(win);
    }

    /** Trash display name and mounted volume names, lowercased for matching. */
    _refreshLocationNames() {
        this._volumeNames = new Set();
        try {
            this._volumeMonitor.get_mounts().forEach(m => {
                const n = m.get_name();
                if (n) this._volumeNames.add(n.trim().toLowerCase());
            });
        } catch (e) { log('_refreshLocationNames: get_mounts() failed', e); }
    }

    /**
     * Identity resolution with ALIAS LEARNING.
     *
     * Several apps establish their final identity late (Firefox maps as
     * 'firefox' then becomes 'firefox_firefox'; Chrome and GTK4
     * single-instance apps behave similarly), which used to force waiting —
     * the window was already visible before restore could run, producing
     * the appear-then-move animation. The latency is learnable: whenever an
     * identity CHANGE is observed, the early->final mapping is persisted in
     * the cache under '__aliases__'. From the next launch on, the early
     * identity resolves through the alias IMMEDIATELY at window creation,
     * so the window is placed and sized before its first frame paints — no
     * animation at all.
     */
    _tryResolveRestore(win, data) {
        if (data.restored || !this._isAlive(win)) return false;

        let appId = null;
        appId = this._identityFor(win);
        if (!appId || this._isSyntheticId(appId)) return false;

        // LOCATION GRACE. Saving runs on a settled window, so it always sees
        // the final title and files Trash and Drive correctly. Restore runs as
        // early as possible, and a file manager announces a provisional title
        // before the real one — so the base identity matched first, restore
        // committed to it, and 'restored' short-circuited every later attempt.
        // Trash and Drive were written correctly and then never read.
        //
        // A suffix is definitive and resolves at once. A bare file-manager id
        // is held briefly in case a suffix is still coming. This is safe here
        // in a way a general wait was not: it applies only to file managers,
        // which are GTK4 and therefore always cloaked, and the grace is well
        // inside the cloak deadline.
        if (this._isLocationPending(appId, data)) {
            this._preplace(win, data, appId);
            this._scheduleLocationCommit(win, data);
            return false;
        }

        if (!data.firstId) {
            data.firstId = appId;
        } else if (appId !== data.firstId) {
            this._learnAlias(data.firstId, appId);
        }

        let effective = appId;
        if (!this._geometryCache[effective]) {
            const aliases = this._geometryCache['__aliases__'];
            const target = aliases?.[appId];
            if (target && this._geometryCache[target]) {
                log(`[Geometry] Alias hit: '${appId}' -> '${target}'`);
                effective = target;
            }
        }

        // Legacy entries (written before canonical app ids) are keyed by
        // wm_class; keep them reachable so nobody loses saved geometry.
        if (!this._geometryCache[effective]) {
            let wmClass = null;
            try { wmClass = win.get_wm_class(); } catch (e) { log('_tryResolveRestore: get_wm_class() failed', e); }
            if (wmClass && this._geometryCache[wmClass]) {
                log(`[Geometry] Legacy key hit: '${effective}' -> '${wmClass}'`);
                effective = wmClass;
            }
        }

        // SESSION IDENTITY FORK: the same app announces different WM_CLASS
        // casing per session type (Wayland 'google-chrome' vs Xorg/Xwayland
        // 'Google-chrome'), stranding entries saved under the other
        // session. Bridge pure casing variants with a case-insensitive
        // fallback. (Structurally different names like
        // 'gnome-terminal-server' vs 'Gnome-terminal' cannot be bridged
        // automatically and keep per-session entries.)
        if (!this._geometryCache[effective]) {
            const lower = appId.toLowerCase();
            const variant = Object.keys(this._geometryCache).find(k =>
                !k.startsWith('__') && k.toLowerCase() === lower);
            if (variant) {
                log(`[Geometry] Case-variant hit: '${appId}' -> '${variant}'`);
                effective = variant;
            }
        }

        if (this._geometryCache[effective]) {
            this._beginRestore(win, data, effective);
            return true;
        }
        return false;
    }

    /**
     * True while a bare file-manager identity might still gain a location
     * suffix. Everything that would otherwise commit or reveal early has to
     * consult this, or the grace has no effect.
     */
    /** Does this app actually have a location slot worth waiting for? */
    _hasLocationSlots(appId) {
        const base = this._baseId(appId);
        return !!(this._geometryCache[base + LOC_TRASH] ||
                  this._geometryCache[base + LOC_DRIVE]);
    }

    _isLocationPending(appId, data) {
        if (!appId || data.restored || data.locExpired) return false;
        if (!this._isFileManagerId(appId) || appId.includes('::')) return false;

        // NOTHING TO WAIT FOR, NOTHING TO HIDE. Holding cloaks the window,
        // and a cloak held past the map animation has to fade the window in
        // afterwards — which reads as a flash whether or not any geometry was
        // applied. With no Trash or Drive slot stored, a suffix could not
        // select anything the base id does not already select, so every
        // file-manager window was being hidden and late-revealed for no gain.
        // That is why a first-ever Files, Trash or Drive window flashed
        // equally, before any geometry existed to restore.
        if (!this._hasLocationSlots(appId)) return false;

        // createdAt is GLib.get_monotonic_time(): microseconds.
        return (GLib.get_monotonic_time() - data.createdAt) < LOC_SETTLE_MS * 1000;
    }

    /**
     * Provisional placement while the location is still being decided.
     *
     * A Trash or Drive window renames itself, so notify::title resolves it
     * BEFORE 'first-frame' and the client's very first painted frame is
     * already at the target — nothing to move afterwards. A Files window's
     * title is set before 'window-created' and never changes, so it can only
     * resolve at the end of the grace, by which time the client has painted
     * at Mutter's own placement. On Wayland move_resize_frame is a request:
     * the client repaints on its own schedule, so revealing straight after it
     * showed the window still at that placement, with the real geometry
     * arriving a frame or two later.
     *
     * Applying the base rectangle up front puts the window where an
     * early-resolving one already is. If a suffix lands during the grace the
     * correction happens while still cloaked, so it costs nothing.
     *
     * Deliberately NOT via _applyGeometry: that would also apply the stored
     * workspace, and a provisional workspace switch is visible even when the
     * window is not.
     */
    _preplace(win, data, appId) {
        if (data.prePlaced || !data.cloaked) return;
        // Same hard rule as _beginRestore: NO GEOMETRY OPERATIONS DURING
        // WINDOW CONSTRUCTION. _tryResolveRestore is called again from the
        // 'first-frame' and 'shown' handlers, so this lands at exactly the
        // moment an early-resolving window gets its apply.
        if (!data.mapped && !data.shownSeen) return;
        const geo = this._lookupGeometry(win, appId);
        if (!geo || geo.max) return;
        data.prePlaced = true;
        try {
            const t = this._clampToWorkArea(win, geo);
            this._trace(win, 'preplace', `${t.x},${t.y} ${t.w}x${t.h}`);
            win.move_resize_frame(true, t.x, t.y, t.w, t.h);
        } catch (e) { log('_preplace failed', e); }
    }

    /**
     * Forces a decision when the grace expires, so a plain folder window does
     * not sit waiting for the next 250ms identity poll.
     */
    _scheduleLocationCommit(win, data) {
        if (data.locTimerId || data.restored) return;
        const elapsedMs = (GLib.get_monotonic_time() - data.createdAt) / 1000;
        const remaining = Math.max(0, Math.round(LOC_SETTLE_MS - elapsedMs)) + 20;
        data.locTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, remaining, () => {
            data.locTimerId = 0;
            if (!this._isAlive(win) || data.restored) return GLib.SOURCE_REMOVE;
            data.locExpired = true;
            this._tryResolveRestore(win, data);
            return GLib.SOURCE_REMOVE;
        });
    }

    _learnAlias(earlyId, finalId) {
        if (!earlyId || !finalId || earlyId.startsWith('__')) return;
        if (this._isSyntheticId(earlyId) || this._isSyntheticId(finalId)) return;
        // Same app, different location: not an identity change to learn.
        if (this._baseId(earlyId) === this._baseId(finalId)) return;
        const aliases = this._geometryCache['__aliases__'] ??
            (this._geometryCache['__aliases__'] = {});
        if (aliases[earlyId] !== finalId) {
            aliases[earlyId] = finalId;
            log(`[Geometry] Learned identity alias '${earlyId}' -> '${finalId}'`);
            this._queueSave();
        }
    }

    _scheduleRestore(win, data, attempt) {
        // React immediately if the identity changes mid-wait
        if (attempt === 0 && !data.wmClassSignalId) {
            try {
                data.wmClassSignalId = win.connect('notify::wm-class', () => {
                    this._tryResolveRestore(win, data);
                });
                data.signals.push(data.wmClassSignalId);
            } catch (e) { log('_scheduleRestore: connect() failed', e); }
        }

        // The location arrives as a title change, so react to it directly
        // rather than waiting out the poll: a Trash window resolves the
        // instant it names itself, still behind the cloak.
        if (attempt === 0 && !data.titleSignalId) {
            try {
                data.titleSignalId = win.connect('notify::title', () => {
                    this._tryResolveRestore(win, data);
                });
                data.signals.push(data.titleSignalId);
            } catch (e) { log('_scheduleRestore: title connect() failed', e); }
        }

        data.timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            attempt === 0 ? 0 : WM_CLASS_POLL_MS, () => {
                data.timerId = 0;
                if (!this._isAlive(win) || data.restored) return GLib.SOURCE_REMOVE;

                if (this._tryResolveRestore(win, data)) return GLib.SOURCE_REMOVE;

                // Identity known but nothing saved (and no alias): no
                // restore is coming — stop hiding the window.
                if (data.cloaked) {
                    let idNow = null;
                    idNow = this._identityFor(win);
                    if (idNow && !this._isLocationPending(idNow, data) &&
                        !this._geometryCache['__aliases__']?.[idNow])
                        this._reveal(win, data);
                }

                if (attempt < WM_CLASS_MAX_TRIES) {
                    this._scheduleRestore(win, data, attempt + 1);
                } else {
                    let appId = null;
                    appId = this._identityFor(win);
                    log(`[Geometry] No saved entry for '${appId ?? 'unknown'}' — tracking only`);
                    this._reveal(win, data);
                    this._settleLater(win, data);
                }
                return GLib.SOURCE_REMOVE;
            });
    }

    _beginRestore(win, data, appId) {
        if (data.restored) return;

        // Re-validate: window type and transient parent are often set AFTER
        // 'window-created' (exactly like the late wm_class). A paste-conflict
        // dialog that slipped in as a "normal window" at creation is
        // untracked here instead of being flown to the app's saved position.
        if (!this._shouldManage(win)) {
            log(`[Geometry] '${appId}' turned out to be a dialog/transient — untracking`);
            this._untrackWindow(win);
            return;
        }

        data.restored = true;
        if (data.timerId) {
            GLib.source_remove(data.timerId);
            data.timerId = 0;
        }
        data.restoredAs = appId;

        // Usage accounting: a RESTORE is the event that proves an entry's
        // value (saves fire constantly and measure nothing). Feeds the
        // frequency-aware pruning below.
        const entry = this._geometryCache[appId];
        if (entry) {
            entry.uses = (entry.uses || 0) + 1;
            entry.last_seen = Date.now();
            this._queueSave();
        }

        // NO GEOMETRY OPERATIONS DURING WINDOW CONSTRUCTION.
        //
        // Journal evidence (Jul 21): the session ended immediately after
        // "Restoring firefox_firefox" -> ">> move_resize_frame", with no
        // authoritative-apply line before it — i.e. from the EARLY apply,
        // which runs synchronously inside the 'window-created' handler.
        // Moving a window Mutter is still constructing, from inside its
        // own signal emission, is re-entrancy into window management at
        // the most fragile moment available.
        //
        // The early apply has been redundant since the authoritative
        // post-first-frame apply landed; the cloak hides the wait. It is
        // removed entirely. If the window is already mapped, the apply is
        // still pushed out of the current signal emission via idle.
        if (!data.mapped && !data.shownSeen) {
            log(`[Geometry] Restore for ${appId} deferred to post-map apply`);
            this._verifyRestore(win, data, appId, 0);
            return;
        }

        data.finalApplyDone = true;
        this._deferApply(win, data, appId, this._lookupGeometry(win, appId), 0);
        this._verifyRestore(win, data, appId, 0);
    }

    _verifyRestore(win, data, appId, tries) {
        if (data.verifyTimerId) {
            GLib.source_remove(data.verifyTimerId);
            data.verifyTimerId = 0;
        }
        data.verifyTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, VERIFY_DELAY_MS, () => {
            data.verifyTimerId = 0;
            if (!this._isAlive(win)) return GLib.SOURCE_REMOVE;
            if (!this._shouldManage(win)) {
                this._untrackWindow(win);
                return GLib.SOURCE_REMOVE;
            }

            const geo = this._lookupGeometry(win, appId);
            // X11 clients get ONE corrective pass: repeated configure
            // requests are the other half of the Xwayland exposure.
            const maxTries = this._isX11(win) ? 1 : VERIFY_MAX_TRIES;
            if (geo && tries < maxTries && !this._matchesGeometry(win, geo)) {
                log(`[Geometry] ${appId} moved itself after restore; reapplying (${tries + 1}/${maxTries})`);
                // data omitted deliberately: verify corrections are INSTANT.
                // Fading each retry made apps that re-assert their own size
                // (Chrome) flash 2-4 times in place at launch.
                this._applyGeometry(win, appId, geo, null);
                this._verifyRestore(win, data, appId, tries + 1);
            } else {
                // Last resort: some apps insist on their own SIZE, but on
                // Wayland no app can position itself — a final move_frame
                // always sticks, so at least the position is honored.
                if (geo && !geo.max && !this._matchesGeometry(win, geo) &&
                    !isMaximized(win) && !win.is_fullscreen()) {
                    try {
                        const t = this._clampToWorkArea(win, geo);
                        log(`[Geometry] ${appId} kept its own size; enforcing position only`);
                        // Instant for the same reason as verify retries
                        win.move_frame(true, t.x, t.y);
                    } catch (e) { log('_verifyRestore: _clampToWorkArea() failed', e); }
                }
                this._settleLater(win, data);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _settleLater(win, data) {
        if (data.settleTimerId) {
            GLib.source_remove(data.settleTimerId);
            data.settleTimerId = 0;
        }
        data.settleTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_GRACE_MS, () => {
            data.settleTimerId = 0;
            if (!this._isAlive(win)) return GLib.SOURCE_REMOVE;
            data.settled = true;
            return GLib.SOURCE_REMOVE;
        });
    }

    _matchesGeometry(win, geo) {
        try {
            if (this.getSettings().get_boolean('geometry-restore-workspace') &&
                Number.isInteger(geo.ws) && !win.is_on_all_workspaces() &&
                win.get_workspace()?.index() !== geo.ws)
                return false;
            if (geo.max) return isMaximized(win);
            if (isMaximized(win)) return false;
            const r = win.get_frame_rect();
            const target = this._clampToWorkArea(win, geo);
            const near = (a, b) => Math.abs(a - b) <= 2;
            return near(r.x, target.x) && near(r.y, target.y) &&
                   near(r.width, target.w) && near(r.height, target.h);
        } catch (e) {
            return true; // Don't fight windows that can't be measured
        }
    }

    /**
     * MONITOR IDENTITY. Coordinates are stored monitor-relative together
     * with the monitor's index and geometry fingerprint. On restore, the
     * fingerprint is matched first (survives index shuffles after
     * docking/undocking), then the index, then the current monitor. A
     * missing monitor falls back gracefully to absolute coordinates
     * clamped to the current work area.
     */
    _monitorInfoFor(win, frame) {
        try {
            const idx = win.get_monitor();
            const m = Main.layoutManager.monitors[idx];
            if (!m) return {};
            return {
                mi: idx,
                mr: [m.x, m.y, m.width, m.height],
                rx: frame.x - m.x,
                ry: frame.y - m.y,
            };
        } catch (e) {
            return {};
        }
    }

    _resolveMonitor(geo) {
        try {
            const monitors = Main.layoutManager.monitors;
            if (geo.mr) {
                const m = monitors.find(mm =>
                    mm.x === geo.mr[0] && mm.y === geo.mr[1] &&
                    mm.width === geo.mr[2] && mm.height === geo.mr[3]);
                if (m) return m;
            }
            if (Number.isInteger(geo.mi) && monitors[geo.mi])
                return monitors[geo.mi];
        } catch (e) { log('_resolveMonitor: find() failed', e); }
        return null;
    }

    _clampToWorkArea(win, geo) {
        let { x, y, w, h } = geo;
        try {
            const mon = this._resolveMonitor(geo);
            let wa = null;
            if (mon && Number.isFinite(geo.rx)) {
                // Remembered monitor is present: place relative to it
                x = mon.x + geo.rx;
                y = mon.y + geo.ry;
                wa = win.get_work_area_for_monitor(mon.index);
            } else {
                wa = win.get_work_area_current_monitor();
            }
            if (wa && wa.width > 0 && wa.height > 0) {
                w = Math.min(w, wa.width);
                h = Math.min(h, wa.height);
                x = Math.max(wa.x, Math.min(x, wa.x + wa.width - w));
                y = Math.max(wa.y, Math.min(y, wa.y + wa.height - h));
            }
        } catch (e) { log('_clampToWorkArea failed', e); }

        // Hard safety rail: X11 geometry fields are 16-bit signed. Values
        // beyond that range have been implicated in Xwayland termination,
        // and no legitimate window geometry ever needs them.
        const lim = v => Math.max(-X11_COORD_LIMIT, Math.min(X11_COORD_LIMIT, Math.round(v || 0)));
        const dim = v => Math.max(1, Math.min(X11_COORD_LIMIT, Math.round(v || 1)));
        return { x: lim(x), y: lim(y), w: dim(w), h: dim(h) };
    }

    /**
     * ONE SLOT PER IDENTITY.
     *
     * Earlier versions kept per-window sub-slots keyed by title. That was the
     * wrong generalisation: outside a file manager an application is one
     * window's worth of geometry, and when several are open the last one to
     * move is the one worth remembering. Keying on title instead produced a
     * slot per document, per tab and per working directory — dead entries that
     * were never matched again, a store full of file and site names, and a
     * list showing 'Window 1' and 'Window 2' holding identical rectangles.
     *
     * The one real exception is the file manager, and it is handled where it
     * belongs: in the IDENTITY (see _identityFor), so Trash and Drive windows
     * are ordinary top-level entries rather than a parallel mechanism.
     */
    _lookupGeometry(win, appId) {
        return this._geometryCache[appId] || null;
    }

    _safeTitle(win) {
        try { return win.get_title(); }
        catch (e) { log('_safeTitle: get_title() failed', e); return null; }
    }

    /**
     * CLOAK: the reason restores used to be visible as a "fly" is that
     * GNOME's map animation shows the window from its very first frame,
     * while app identities often resolve 50-250ms later — so the
     * relocation happened in plain sight. macOS/Windows never show this
     * because the window isn't displayed until it's placed. Same here:
     * windows whose identity is unknown at creation are slid off-screen
     * via actor translation (a property the map animation never touches,
     * unlike opacity/scale), placed while off-view, and revealed AT the
     * restored geometry. The corners shadow is translation-bound to its
     * window, so it cloaks and reveals in sync automatically.
     */
    /**
     * AUTHORITATIVE POST-PLACEMENT APPLY. Journal evidence (Jul 20) showed
     * the 'shown'-based apply never executing — the signal did not fire on
     * this Mutter build, and every restore fell back to the visible verify
     * correction. The apply is therefore anchored to the actor's
     * 'first-frame' (a signal the shell itself relies on, guaranteed after
     * placement), with 'shown' kept as a secondary trigger; whichever
     * fires first wins, the other becomes a no-op.
     */
    _authoritativeApply(win, data, reason) {
        if (!this._isAlive(win)) return;
        data.mapped = true;

        if (data.restored && !data.finalApplyDone) {
            data.finalApplyDone = true;
            // Deliberately NOT re-resolving the identity here: an identity
            // that changes mid-launch (Xorg) would otherwise select a
            // different entry than the restore used, applying two positions
            // in sequence — the two-stage flight.
            const effective = data.restoredAs;
            const geo = this._lookupGeometry(win, effective);
            log(`[Geometry] Authoritative apply (${reason}) for ${effective} (cloaked=${data.cloaked})`);
            // 'first-frame' and 'shown' are signal emissions as well, so
            // this apply is deferred to a fresh main-loop iteration too.
            if (geo) {
                this._deferApply(win, data, effective, geo, 0);
                return; // _deferApply reveals once the apply has landed
            }
        } else if (!data.restored) {
            log(`[Geometry] ${reason} before restore resolved (cloaked=${data.cloaked})`);
            return; // keep cloak: resolution may still land within deadline
        }

        this._reveal(win, data);
    }

    _cloak(win, data) {
        // X11 clients are never cloaked: extreme actor translation is
        // implicated in the Xwayland termination that ends the session.
        if (this._isX11(win)) return;
        try {
            const actor = win.get_compositor_private();
            if (!actor) return;
            actor.translation_x = CLOAK_OFFSET;
            data.cloaked = true;

            data.cloakTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CLOAK_MAX_MS, () => {
                data.cloakTimerId = 0;
                if (!this._isAlive(win)) return GLib.SOURCE_REMOVE;

                // FORCE A DECISION BEFORE GIVING UP. This used to reveal
                // unconditionally, which raced anything still resolving: a
                // Files window resolves only via the location grace or the
                // 250ms poll (its title is set before 'window-created', so
                // notify::title never fires), landing 370-500ms in against a
                // 550ms deadline. Losing that race revealed the window at
                // Mutter's own placement and moved it afterwards — the flight,
                // and only for Files, since Trash and Drive rename themselves
                // and resolve early.
                data.locExpired = true;
                if (this._tryResolveRestore(win, data)) return GLib.SOURCE_REMOVE;

                // Genuinely nothing to apply — show it where it spawned.
                this._reveal(win, data);
                return GLib.SOURCE_REMOVE;
            });
        } catch (e) { log('_cloak failed', e); }
    }

    /**
     * Holds the cloak until the window's frame actually matches what was
     * applied. move_resize_frame only REQUESTS a size on Wayland, so
     * revealing immediately after it uncovers a window still showing its
     * previous geometry — the flash. Bounded by REVEAL_MAX_TRIES so a client
     * that refuses the size still appears promptly; _verifyRestore handles
     * that case afterwards.
     */
    _revealWhenPlaced(win, data, geo, tries) {
        if (!data.cloaked || !this._isAlive(win)) return;

        // This retry loop is the deadline now; the cloak timer would
        // otherwise fire mid-wait and reveal the window unplaced.
        if (data.cloakTimerId) {
            GLib.source_remove(data.cloakTimerId);
            data.cloakTimerId = 0;
        }

        if (!geo || this._matchesGeometry(win, geo) || tries >= REVEAL_MAX_TRIES) {
            this._reveal(win, data);
            return;
        }

        data.revealTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REVEAL_POLL_MS, () => {
            data.revealTimerId = 0;
            this._revealWhenPlaced(win, data, geo, tries + 1);
            return GLib.SOURCE_REMOVE;
        });
    }

    _reveal(win, data) {
        if (!data.cloaked) return;
        data.cloaked = false;

        if (data.cloakTimerId) {
            GLib.source_remove(data.cloakTimerId);
            data.cloakTimerId = 0;
        }

        try {
            const actor = win.get_compositor_private();
            if (!actor) return;
            actor.translation_x = 0;

            // GUARANTEED SOFT APPEARANCE. The map animation plays while
            // the window is cloaked off-screen; apps that take ~300ms to
            // paint their first frame (TextEditor) finish it before the
            // reveal, so snapping translation on a fully opaque actor read
            // as a teleport-pop. The old elapsed>300ms threshold sat
            // exactly on that boundary. Now: if a live opacity transition
            // (the map animation) is still running, let it provide the
            // fade-in; otherwise ALWAYS fade in ourselves — no timing
            // threshold to straddle.
            if (!actor.get_transition('opacity')) {
                actor.opacity = 0;
                actor.ease({
                    opacity: 255,
                    duration: REVEAL_FADE_MS,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            }
        } catch (e) { log('_reveal failed', e); }
    }

    /**
     * Moves an already-visible window without visible travel: fade the
     * actor out, apply the move while invisible, fade back in at the
     * destination. The previous slide animation visibly departed from the
     * arbitrary spawn position, which read as buggy rather than deliberate.
     */
    _fadeMove(win, before, target, applyFn) {
        const dx = Math.abs(before.x - target.x);
        const dy = Math.abs(before.y - target.y);
        const dw = Math.abs((before.width ?? before.w ?? 0) - (target.w ?? 0));
        const dh = Math.abs((before.height ?? before.h ?? 0) - (target.h ?? 0));
        if (dx < MOVE_MIN_DELTA && dy < MOVE_MIN_DELTA &&
            dw < MOVE_MIN_DELTA && dh < MOVE_MIN_DELTA) {
            applyFn();
            return;
        }

        let actor = null;
        try { actor = win.get_compositor_private(); } catch (e) { log('_fadeMove: get_compositor_private() failed', e); }
        if (!actor) {
            applyFn();
            return;
        }

        try {
            // FIX: if a fade is already in flight, its captured 'prev' is the
            // resting opacity — starting a second fade here would capture a
            // PARTIAL value (e.g. 200) and "restore" the window to permanent
            // semi-transparency. Apply follow-up corrections instantly instead.
            if (actor.get_transition('opacity')) {
                applyFn();
                return;
            }

            const prev = actor.opacity;
            actor.ease({
                opacity: 0,
                duration: FADE_OUT_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: () => {
                    try { applyFn(); } catch (e) { log('_fadeMove failed', e); }
                    actor.ease({
                        opacity: prev,
                        duration: FADE_IN_MS,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
                },
            });
        } catch (e) {
            applyFn();
        }
    }

    /** Animate only when the window has been visible long enough to notice */
    _shouldAnimate(data) {
        return data && (GLib.get_monotonic_time() - data.createdAt) > ANIMATE_AFTER_MS * 1000;
    }

    /**
     * WORKSPACE MEMORY. Windows return to the workspace they were closed
     * on. With dynamic workspaces the remembered index may no longer exist;
     * change_workspace_by_index with append=true recreates it. Gated by
     * 'geometry-restore-workspace' since some people prefer new windows on
     * the current workspace.
     */
    _applyWorkspace(win, geo) {
        try {
            if (!this.getSettings().get_boolean('geometry-restore-workspace')) return;
            if (!Number.isInteger(geo.ws)) return;
            if (win.is_on_all_workspaces()) return;
            const wsm = global.workspace_manager;
            const count = wsm?.get_n_workspaces?.() ?? 1;
            // Clamp to the existing set (+1 at most): a large stored index
            // with append=true would otherwise spawn many workspaces.
            const target = Math.max(0, Math.min(geo.ws, count));
            const current = win.get_workspace()?.index();
            if (current !== target) {
                // X11 windows are excluded: change_workspace_by_index with
                // append=true mutates the workspace set, which propagates
                // X11 property updates to Xwayland — an unnecessary risk
                // during the map sequence, and workspace placement is the
                // least critical part of a restore.
                if (this._isX11(win)) {
                    log('[Geometry] Skipping workspace restore for X11 client');
                    return;
                }
                this._trace(win, 'change_workspace_by_index', `${target}`);
                win.change_workspace_by_index(target, true);
            }
        } catch (e) { log('_applyWorkspace failed', e); }
    }

    /**
     * Runs an apply OUTSIDE the current signal emission. Every window
     * operation reaches Mutter from a fresh main-loop iteration, never
     * from inside 'window-created', 'first-frame' or 'shown' handlers.
     */
    _deferApply(win, data, appId, geo, delayMs) {
        if (!geo) return;
        if (data.x11TimerId) {
            GLib.source_remove(data.x11TimerId);
            data.x11TimerId = 0;
        }
        const wait = delayMs || (this._isX11(win) ? X11_APPLY_DELAY_MS : 0);
        data.x11TimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, wait, () => {
            data.x11TimerId = 0;
            if (!this._isAlive(win)) return GLib.SOURCE_REMOVE;
            // FINAL GATE. Dialog markers (window type, transient parent,
            // modality) often arrive after window-created — later than the
            // one-time check in _beginRestore. Nautilus's paste-conflict
            // dialogs passed that early check and were then flown to the
            // app's saved position from here. Re-validate at the moment of
            // truth: if the window has revealed itself as a dialog, untrack
            // it and leave it exactly where the shell placed it.
            if (!this._shouldManage(win)) {
                log(`[Geometry] '${appId}' revealed as dialog/transient before apply — untracking`);
                this._reveal(win, data);
                this._untrackWindow(win);
                return GLib.SOURCE_REMOVE;
            }
            this._applyGeometry(win, appId, geo, null);
            this._revealWhenPlaced(win, data, geo, 0);
            this._verifyRestore(win, data, appId, 0);
            return GLib.SOURCE_REMOVE;
        });
    }

    _applyGeometry(win, appId, geo, data = null) {
        if (win.is_fullscreen()) return;

        try {
            this._applyWorkspace(win, geo);
            // Apply the floating rect first (when present) so a later
            // unmaximize returns to the remembered size, then apply the
            // maximized state on top if that's how the app was closed.
            if (geo.w > 50 && geo.h > 50) {
                if (isMaximized(win) && !geo.max) unmaximize(win);
                if (!isMaximized(win)) {
                    const t = this._clampToWorkArea(win, geo);
                    const before = win.get_frame_rect();
                    // Diagnostic for edge-snapped apps (Firefox/Chrome) that
                    // show a shadow strip after restore: a nonzero
                    // frame-buffer delta here means the app's CSD shadow
                    // extents were still in floating mode when measured.
                    try {
                        const b = win.get_buffer_rect();
                        log(`[Geometry] Restoring ${appId} to ${t.x},${t.y} [${t.w}x${t.h}] ` +
                            `(frame-buffer delta ${before.x - b.x},${before.y - b.y})`);
                    } catch (e) {
                        log(`[Geometry] Restoring ${appId} to ${t.x},${t.y} [${t.w}x${t.h}]`);
                    }
                    const doMove = () => {
                        this._trace(win, 'move_resize_frame',
                            `${t.x},${t.y} ${t.w}x${t.h}`);
                        win.move_resize_frame(true, t.x, t.y, t.w, t.h);
                    };
                    if (!geo.max && this._shouldAnimate(data))
                        this._fadeMove(win, before, t, doMove);
                    else
                        doMove();
                }
            }
            if (geo.max && !isMaximized(win)) {
                this._trace(win, 'maximize');
                maximize(win);
            }
            geo.last_seen = Date.now();
        } catch (e) {
            logError(`[Geometry] Restore failed for ${appId}`, e);
        }
    }

    // --- Save ----------------------------------------------------------

    _onWindowChanged(win) {
        if (!this.getSettings().get_boolean('geometry-enabled')) return;

        const data = this._windowData.get(win);
        // Unsettled = the app is still doing its initial self-placement, or
        // a restore is in flight. Never persist those values.
        if (!data || !data.settled) return;

        if (win.is_fullscreen()) return;

        if (!this._isAlive(win)) return;
        const appId = this._identityFor(win);
        if (!appId || appId.startsWith('__') || this._isSyntheticId(appId)) return;

        // Dialogs/transients must never write into the app slot, even if
        // they were mis-typed as NORMAL at creation time.
        if (!this._shouldManage(win)) {
            this._untrackWindow(win);
            return;
        }

        // Maximized: remember the STATE, keep the last floating rect so
        // unmaximizing after restore returns to the remembered size.
        // (Previously maximized windows were skipped entirely, so an app
        // closed maximized reopened as a floating window.)
        if (isMaximized(win)) {
            const entry = this._geometryCache[appId] || {};
            entry.max = true;
            entry.last_seen = Date.now();
            this._geometryCache[appId] = entry;
            this._queueSave();
            return;
        }

        const rect = win.get_frame_rect();
        if (rect.width < 50 || rect.height < 50) return;

        // Workspace + monitor identity captured alongside the rect
        let ws = null;
        try {
            if (!win.is_on_all_workspaces())
                ws = win.get_workspace()?.index() ?? null;
        } catch (e) { log('_onWindowChanged: is_on_all_workspaces() failed', e); }
        const monInfo = this._monitorInfoFor(win, rect);

        const snapshot = {
            x: rect.x, y: rect.y, w: rect.width, h: rect.height,
            max: false, ws, ...monInfo,
        };

        const entry = this._geometryCache[appId] || {};
        Object.assign(entry, snapshot, { last_seen: Date.now() });
        this._geometryCache[appId] = entry;

        log(`[Geometry] Saved ${appId} ('${win.get_title?.() ?? ''}'): ${rect.x},${rect.y} [${rect.width}x${rect.height}]`);
        this._queueSave();
    }

    _queueSave() {
        // Cap pressure between shell restarts: prune opportunistically once
        // the store meaningfully exceeds the cap, not only at enable.
        const count = Object.keys(this._geometryCache)
            .filter(k => !k.startsWith('__')).length;
        if (count > PRUNE_MAX_ENTRIES + 20)
            this._pruneCache();

        if (this._saveTimeoutId)
            GLib.source_remove(this._saveTimeoutId);

        this._saveTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, SAVE_DEBOUNCE_SEC, () => {
            this._saveToDisk();
            return GLib.SOURCE_REMOVE;
        });
    }

    _saveToDisk() {
        this._saveTimeoutId = null;
        try {
            const json = JSON.stringify(this._geometryCache);
            this._lastWrittenJson = json; // so the changed:: observer can
                                          // distinguish in-process writes from external ones
            this.getSettings().set_string('geometry-data', json);
            log("[Geometry] Saved state to disk.");
        } catch (e) {
            logError("[Geometry] Save failed", e);
        }
    }

    // --- Store maintenance ----------------------------------------------

    _loadCache() {
        try {
            const json = this.getSettings().get_string('geometry-data');
            this._geometryCache = JSON.parse(json) || {};
        } catch (e) {
            this._geometryCache = {};
            logError("[Geometry] Failed to parse cache", e);
        }
        this._purgeSyntheticIds();
        this._dropLegacyTitleSlots();
    }

    /**
     * Strips per-window sub-slots written by versions 121-126, along with the
     * hash salt they used. The application's own rectangle is untouched, so
     * nothing the user positioned is lost; only the parallel per-title slots
     * and the titles they carried go away.
     */
    _dropLegacyTitleSlots() {
        let changed = false;
        if (this._geometryCache['__salt__'] !== undefined) {
            delete this._geometryCache['__salt__'];
            changed = true;
        }
        Object.keys(this._geometryCache).forEach(appId => {
            if (appId.startsWith('__')) return;
            const entry = this._geometryCache[appId];
            if (!entry || typeof entry !== 'object') return;
            ['titles', 'titleEvictions', 'volatileTitles'].forEach(f => {
                if (entry[f] !== undefined) {
                    delete entry[f];
                    changed = true;
                }
            });
        });
        if (changed) {
            log('[Geometry] Removed legacy per-window sub-slots');
            this._queueSave();
        }
    }

    /**
     * Removes recycled 'window:N' ids written by earlier versions. Stores
     * self-heal on load, so no manual clearing is required.
     */
    _purgeSyntheticIds() {
        let removed = 0;

        for (const key of Object.keys(this._geometryCache)) {
            if (this._isSyntheticId(key)) {
                delete this._geometryCache[key];
                removed++;
            }
        }

        const aliases = this._geometryCache['__aliases__'];
        if (aliases) {
            for (const [from, to] of Object.entries(aliases)) {
                if (this._isSyntheticId(from) || this._isSyntheticId(to)) {
                    delete aliases[from];
                    removed++;
                }
            }
            if (Object.keys(aliases).length === 0)
                delete this._geometryCache['__aliases__'];
        }

        if (removed > 0) {
            log(`[Geometry] Purged ${removed} recycled 'window:N' entries/aliases`);
            this._queueSave();
        }
    }

    /**
     * Drops entries not seen for PRUNE_MAX_AGE_DAYS and caps the store at
     * PRUNE_MAX_ENTRIES (oldest first), so 'geometry-data' can't grow forever.
     */
    _pruneCache() {
        const now = Date.now();
        const maxAge = PRUNE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
        const aliases = this._geometryCache['__aliases__'];
        let entries = Object.entries(this._geometryCache)
            .filter(([key]) => !key.startsWith('__'))
            .filter(([, geo]) => !geo.last_seen || (now - geo.last_seen) < maxAge);

        if (entries.length > PRUNE_MAX_ENTRIES) {
            // Recency floor: anything used in the last two weeks is
            // untouchable (a brand-new app must not lose to an old
            // high-count one). Beyond the floor, evict the least-USED
            // first, recency as tiebreak.
            const recentMs = PRUNE_RECENT_KEEP_DAYS * 24 * 60 * 60 * 1000;
            const recent = entries.filter(([, g]) => (now - (g.last_seen || 0)) < recentMs);
            const older = entries.filter(([, g]) => (now - (g.last_seen || 0)) >= recentMs);
            older.sort((a, b) =>
                ((b[1].uses || 0) - (a[1].uses || 0)) ||
                ((b[1].last_seen || 0) - (a[1].last_seen || 0)));
            entries = recent.concat(
                older.slice(0, Math.max(0, PRUNE_MAX_ENTRIES - recent.length)));
        }

        const pruned = Object.fromEntries(entries);
        if (aliases) pruned['__aliases__'] = aliases;
        const removed = Object.keys(this._geometryCache).length -
            Object.keys(pruned).length;
        if (removed > 0) {
            this._geometryCache = pruned;
            this._saveToDisk();
            log(`[Geometry] Pruned ${removed} stale entries.`);
        }
    }
}

import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { log } from './logger.js';

/** Per-leg duration; the full wobble is this times the offset count. */
const LEG_MS = 45;
/** Decaying offsets, in multiples of the amplitude. */
const LEGS = [1, -0.85, 0.6, -0.4, 0.2, 0];

const MAX_AMPLITUDE = 12;

/**
 * Wobble a window in place.
 *
 * CRITICAL: this animates the compositor actor's translation_x, never the
 * window's real position. GeometryManager connects 'position-changed' and
 * 'size-changed' on every managed window, so a shake done with
 * move_resize_frame() would be recorded as the user repositioning the window
 * and would rewrite the saved geometry mid-wobble. Actor translation leaves
 * the frame rect untouched, so no signal fires and the store is unaffected.
 *
 * Amplitude is capped low on purpose. This codebase already documents that
 * extreme actor translation is implicated in Xwayland termination — that is
 * why GeometryManager._cloak() skips X11 windows entirely — so a few pixels is
 * a deliberately different order of magnitude from that offset.
 */
export class ShakeAnimator {
    constructor() {
        this._active = new Set();
        this._interface = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
    }

    /** Honour the user's reduced-motion preference. */
    _animationsEnabled() {
        try { return this._interface.get_boolean('enable-animations'); }
        catch (e) { return true; }
    }

    _shouldSkip(win) {
        if (!win) return true;
        try {
            if (win.is_fullscreen()) return true;
            if (win.minimized) return true;
        } catch (e) { return true; }
        if (Main.overview.visible) return true;

        // Mid-drag or mid-resize: the user is already moving it, and a wobble
        // would fight the grab.
        try {
            const op = global.display.get_grab_op?.();
            if (op !== undefined && op !== Meta.GrabOp.NONE) return true;
        } catch (e) { log('[Shake] get_grab_op() failed', e); }

        return false;
    }

    shake(win, amplitude = 6) {
        if (!this._animationsEnabled()) return false;
        if (this._shouldSkip(win)) return false;

        let actor = null;
        try { actor = win.get_compositor_private(); }
        catch (e) { log('[Shake] get_compositor_private() failed', e); return false; }
        if (!actor) return false;

        const amp = Math.min(MAX_AMPLITUDE, Math.max(1, amplitude));

        // A second click mid-wobble restarts cleanly rather than compounding.
        actor.remove_transition('translation-x');
        actor.translation_x = 0;
        this._active.add(actor);

        const step = (i) => {
            if (!this._active.has(actor)) return;
            if (i >= LEGS.length) {
                actor.translation_x = 0;
                this._active.delete(actor);
                return;
            }
            actor.ease({
                translation_x: Math.round(amp * LEGS[i]),
                duration: LEG_MS,
                mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
                onComplete: () => step(i + 1),
            });
        };

        step(0);
        return true;
    }

    /**
     * Without this a disable() mid-wobble leaves the window permanently offset
     * by a few pixels, with nothing left running to put it back.
     */
    destroy() {
        this._active.forEach(actor => {
            try {
                actor.remove_transition('translation-x');
                actor.translation_x = 0;
            } catch (e) { log('[Shake] reset failed', e); }
        });
        this._active.clear();
        this._interface = null;
    }
}

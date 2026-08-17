import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import { log, logError } from '../util/logger.js';
import { ExtensionComponent } from './base.js';
import { isMaximized } from '../util/compat.js';

/**
 * Uniform window corner rounding — architecture ported from Rounded Window
 * Corners Reborn (the field-proven implementation).
 *
 * THE KEY INSIGHT (learned the hard way): a window's drop shadow is drawn by
 * the app itself, shaped for the window's ORIGINAL corners, and hugs them
 * densely. Cutting a rounded corner exposes the shadow that was hiding
 * underneath — a gray smudge at every corner, visible over light backgrounds
 * and invisible over dark ones. No amount of mask tuning can fix that,
 * because the smudge isn't the mask: it's the shadow. The only correct
 * design, and the one RWC uses, is:
 *
 *   1. The mask shader deletes EVERYTHING outside the frame bounds — the
 *      app's entire in-buffer shadow — in addition to rounding the corners.
 *   2. A dedicated shadow actor below the window paints a replacement
 *      shadow shaped for the ROUNDED window: an St.Bin whose inner child is
 *      a white rounded box with a CSS box-shadow. The white body exists
 *      only so CSS has something to cast a shadow from; a second small
 *      shader (ClipShadowEffect) erases bright pixels, leaving only the
 *      shadow itself.
 *   3. The shadow actor is geometry-bound to the window actor (position,
 *      size via BindConstraints; pivot/translation/scale/visible via
 *      property bindings) so it tracks moves, resizes, and animations.
 */

const SHADOW_PADDING = 80;   // px of room around the frame for the CSS shadow
const EDGE_SNAP_PX = 2;      // window edge within this of the work area = flush

const DECLARATIONS = `
uniform vec4 bounds;      // frame rect inside the buffer: x1, y1, x2, y2
uniform float clip_radius;
uniform vec2 tex_size;    // size of the actor the effect is attached to
uniform vec4 corner_mask; // 1.0 = round, 0.0 = square: TL, TR, BL, BR
`;

// Masking (RWC math): everything outside the frame is removed (that's the
// app's own shadow — replaced by the shadow actor); inside the frame, the
// corner circle test runs with an antialiasing band centered on the curve
// (radius +/- 0.5, linear falloff), touching only the corner squares.
const CODE = `
vec2 pos = cogl_tex_coord0_in.xy * tex_size;
if (clip_radius > 0.5) {
    if (pos.x < bounds.x || pos.y < bounds.y ||
        pos.x > bounds.z || pos.y > bounds.w) {
        cogl_color_out = vec4(0.0);
    } else {
        vec2 fmin = bounds.xy + vec2(clip_radius);
        vec2 fmax = bounds.zw - vec2(clip_radius);
        bool corner_x = pos.x < fmin.x || pos.x > fmax.x;
        bool corner_y = pos.y < fmin.y || pos.y > fmax.y;
        if (corner_x && corner_y) {
            // Per-corner gate: corners flush against a screen edge stay
            // square (mask 0), like tiled windows.
            float m = pos.y < fmin.y
                ? (pos.x < fmin.x ? corner_mask.x : corner_mask.y)
                : (pos.x < fmin.x ? corner_mask.z : corner_mask.w);
            if (m > 0.5) {
            vec2 center = clamp(pos, fmin, fmax);
            vec2 delta = pos - center;
            float distSq = dot(delta, delta);
            float outer = clip_radius + 0.5;
            float inner = clip_radius - 0.5;
            float f = 1.0;
            if (distSq >= outer * outer)
                f = 0.0;
            else if (distSq > inner * inner)
                f = outer - sqrt(distSq);
            cogl_color_out = cogl_color_out * f;
            }
        }
    }
}
`;

const RoundedCornersEffect = GObject.registerClass({
    GTypeName: 'LesionRoundedCornersEffect',
}, class RoundedCornersEffect extends Shell.GLSLEffect {
    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, CODE, false);
    }

    update(frameX, frameY, frameW, frameH, texW, texH, radius, mask = [1, 1, 1, 1]) {
        try {
            // RWC insets the top-left by 1px so the shadow actor's body can
            // never peek out along that edge.
            this.set_uniform_float(this.get_uniform_location('bounds'), 4,
                [frameX + 1, frameY + 1, frameX + frameW, frameY + frameH]);
            this.set_uniform_float(this.get_uniform_location('clip_radius'), 1, [radius]);
            this.set_uniform_float(this.get_uniform_location('tex_size'), 2, [texW, texH]);
            this.set_uniform_float(this.get_uniform_location('corner_mask'), 4, mask);
            this.queue_repaint();
        } catch (e) {
            logError('[Corners] uniform update failed', e);
        }
    }
});

// Erases the shadow actor's white body: bright pixels are attenuated, dark
// shadow pixels kept. Straight port of RWC's clip_shadow.frag, needed
// because of https://gitlab.gnome.org/GNOME/gnome-shell/-/issues/4474
const CLIP_SHADOW_CODE = `
vec4 c = cogl_color_out;
float gray = (c.r + c.g + c.b) / 3.0;
cogl_color_out *= (1.0 - smoothstep(0.4, 1.0, gray)) * c.a;
`;

const ClipShadowEffect = GObject.registerClass({
    GTypeName: 'LesionClipShadowEffect',
}, class ClipShadowEffect extends Shell.GLSLEffect {
    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, '', CLIP_SHADOW_CODE, false);
    }
});

export class EffectsManager extends ExtensionComponent {

    onEnable() {
        // win -> { effect, sigs, actor, target, shadow, bindings }
        this._windows = new Map();

        const id = global.display.connect('window-created', (d, win) => {
            this.idleOnce(() => this._maybeAttach(win), GLib.PRIORITY_DEFAULT);
        });
        this._signals.push({ obj: global.display, id });

        // RESTACKING: Mutter reorders window actors on focus/raise, but the
        // shadow actors keep their old depth — a stale shadow can end up
        // ABOVE a newly raised window, painting a dark rim over its edges
        // that reads as the window being translucent. Re-sync every shadow
        // to sit directly below its window whenever the stack changes
        // (same approach as Rounded Window Corners Reborn).
        const restackId = global.display.connect('restacked', () => {
            for (const rec of this._windows.values()) {
                try {
                    if (rec.shadow && rec.actor &&
                        rec.shadow.get_parent() === global.window_group &&
                        rec.actor.get_parent() === global.window_group) {
                        global.window_group.set_child_below_sibling(rec.shadow, rec.actor);
                    }
                } catch (e) {}
            }
        });
        this._signals.push({ obj: global.display, id: restackId });

        this._syncAll();

        this.observe('changed::corners-enabled', () => this._rebuildAll());
        this.observe('changed::transparency-enabled', () => this._rebuildAll());
        this.observe('changed::corners-radius', () => this._syncAll());
        this.observe('changed::corners-smart-edges', () => this._syncAll());
        this.observe('changed::transparency-opacity', () => this._syncAll());
        this.observe('changed::transparency-focused-opacity', () => this._syncAll());
    }

    onDisable() {
        this._detachAll();
    }

    _cornersEnabled() {
        return this.getSettings().get_boolean('corners-enabled') &&
               this.getSettings().get_int('corners-radius') > 0;
    }

    _transparencyEnabled() {
        return this.getSettings().get_boolean('transparency-enabled');
    }

    _anyEnabled() {
        return this._cornersEnabled() || this._transparencyEnabled();
    }

    _syncAll() {
        if (!this._anyEnabled()) {
            this._detachAll();
            return;
        }
        global.display.list_all_windows().forEach(win => {
            try { this._maybeAttach(win); }
            catch (e) { logError(`[Corners] attach failed for '${win?.get_wm_class?.() ?? '?'}'`, e); }
        });
        for (const win of this._windows.keys()) {
            try { this._updateWindow(win); }
            catch (e) { logError('[Corners] update failed', e); }
        }
    }

    /** Full re-attach: needed when a feature toggle changes which per-window
     *  machinery (effect + shadow) must exist. */
    _rebuildAll() {
        this._detachAll();
        this._syncAll();
    }

    _shouldRound(win) {
        if (!win) return false;
        // Desktop Icons NG (ships with Ubuntu) manages the desktop itself as
        // a window; rounding it and replacing its shadow would deform the
        // desktop. RWC skips it for the same reason.
        try {
            if (win.gtk_application_id === 'com.rastersoft.ding' ||
                win.gtkApplicationId === 'com.rastersoft.ding')
                return false;
        } catch (e) {}
        const t = win.get_window_type();
        return t === Meta.WindowType.NORMAL ||
               t === Meta.WindowType.DIALOG ||
               t === Meta.WindowType.MODAL_DIALOG;
    }

    _maybeAttach(win) {
        if (!this._anyEnabled()) return;
        if (this._windows.has(win)) return;
        if (!this._shouldRound(win)) {
            log(`[Corners] skipping '${win?.get_wm_class?.() ?? '?'}' (type=${win?.get_window_type?.()})`);
            return;
        }

        const actor = win.get_compositor_private();
        if (!actor) {
            const id = win.connect('shown', () => {
                win.disconnect(id);
                this._maybeAttach(win);
            });
            return;
        }

        // X11 clients (e.g. Chrome/VSCode/Electron under Xwayland): the
        // effect must live on the surface child, not the window actor.
        //
        // XWAYLAND SAFETY: Xwayland is itself a Wayland client of the
        // compositor, so compositor-side operations on its surface actors
        // can drop that connection — and losing it terminates the session
        // ("Connection to xwayland lost"). 'effects-manage-x11' excludes
        // X11 windows from effects entirely; it can be flipped from a TTY
        // without loading the preferences UI.
        let isX11 = false;
        try {
            isX11 = win.get_client_type &&
                win.get_client_type() === Meta.WindowClientType.X11;
        } catch (e) {}

        if (isX11) {
            try {
                if (!this.getSettings().get_boolean('effects-manage-x11')) {
                    log('[Effects] Skipping X11 client (effects-manage-x11 is off)');
                    return;
                }
            } catch (e) {}
        }

        let target = actor;
        if (isX11) {
            target = actor.get_first_child() ?? actor;
        }

        // Corner machinery (offscreen effect + replacement shadow) only
        // when rounding is on; transparency alone needs just the signals.
        let effect = null;
        let shadow = { shadow: null, bindings: [] };
        if (this._cornersEnabled()) {
            effect = new RoundedCornersEffect();
            try {
                target.add_effect_with_name('lesion-corners', effect);
            } catch (e) {
                logError('[Corners] failed to attach effect', e);
                return;
            }
            shadow = this._createShadow(actor);
        }

        const sigs = [];
        sigs.push(win.connect('size-changed', () => this._updateWindow(win)));
        // Smart edges: MOVING a window onto/off a screen edge changes its
        // corner mask without any size change.
        sigs.push(win.connect('position-changed', () => this._updateWindow(win)));
        sigs.push(win.connect('notify::appears-focused', () => this._updateWindow(win)));
        sigs.push(win.connect('unmanaged', () => this._detachWindow(win)));

        // HALF-WINDOW FIX: on Maximize -> Restore, 'size-changed' fires while
        // the actor still has its maximized allocation, baking a stale
        // tex_size into the uniforms — the outside-the-frame deletion then
        // erased everything past the midpoint. The actor's own size settles
        // later, so refresh the uniforms when it does.
        const targetSigs = [];
        targetSigs.push({
            obj: target,
            id: target.connect('notify::size', () => this._updateWindow(win)),
        });

        this._windows.set(win, { effect, sigs, targetSigs, actor, target, ...shadow });
        this._updateWindow(win);

        log(`[Corners] attached to '${win.get_wm_class?.() ?? '?'}' ` +
            `type=${win.get_window_type()} client=${win.get_client_type?.()}`);
    }

    /**
     * Builds the replacement shadow: an outer bin (frame + padding) whose
     * inner child is the white rounded shadow-caster, placed just below the
     * window actor and geometry-bound to it.
     */
    _createShadow(actor) {
        // INPUT TRANSPARENCY IS CRITICAL. St widgets are reactive by
        // default, and this bin extends SHADOW_PADDING px beyond the window
        // on every side — a reactive shadow is an invisible 80px click trap
        // around each window, swallowing clicks aimed at windows behind it
        // (first click eaten, second gets through: the reported
        // "have to click 2-3 times" mouse issue).
        const shadow = new St.Bin({
            name: 'lesion-shadow',
            style: `padding: ${SHADOW_PADDING}px;`,
            reactive: false,
            can_focus: false,
            track_hover: false,
            visible: false,   // shown after first sizing (see _updateShadow)
            child: new St.Bin({
                x_expand: true,
                y_expand: true,
                reactive: false,
                can_focus: false,
                track_hover: false,
            }),
        });

        try {
            shadow.add_effect_with_name('lesion-clip-shadow', new ClipShadowEffect());
        } catch (e) {}

        global.window_group.insert_child_below(shadow, actor);

        // Track position and size via constraints...
        for (let i = 0; i < 4; i++) {
            shadow.add_constraint(new Clutter.BindConstraint({
                source: actor,
                coordinate: i, // X, Y, WIDTH, HEIGHT
                offset: 0,
            }));
        }

        // The shadow is hidden until its first _updateShadow sets concrete
        // constraint offsets. Painting it before then produced "Can't update
        // stage views actor lesion-shadow needs an allocation" on GNOME 50.
        // It is revealed (via the property bindings from the window) only
        // after it has a real size.

        // Track animations and visibility
        const bindings = [];
        // Exactly RWC's binding set — notably WITHOUT 'opacity'
        for (const prop of ['pivot-point', 'translation-x', 'translation-y',
                            'scale-x', 'scale-y']) {  // 'visible' managed manually
            try {
                bindings.push(actor.bind_property(prop, shadow, prop,
                    GObject.BindingFlags.SYNC_CREATE));
            } catch (e) {}
        }

        return { shadow, bindings };
    }

    _updateWindow(win) {
        const rec = this._windows.get(win);
        if (!rec) return;

        try {
            if (rec.effect) {
                const buffer = win.get_buffer_rect();
                const frame = win.get_frame_rect();

                let radius = this.getSettings().get_int('corners-radius');
                if (isMaximized(win) || win.is_fullscreen())
                    radius = 0;
                radius = Math.min(radius, Math.floor(Math.min(frame.width, frame.height) / 2));

                const mask = this._computeCornerMask(win, frame);

                const tw = rec.target?.get_width?.() || buffer.width;
                const th = rec.target?.get_height?.() || buffer.height;

                rec.effect.update(
                    frame.x - buffer.x,
                    frame.y - buffer.y,
                    frame.width,
                    frame.height,
                    tw,
                    th,
                    radius,
                    mask
                );

                this._updateShadow(win, rec, frame, buffer, radius, mask);
            }

            this._updateTransparency(win, rec);
        } catch (e) {
            logError('[Corners] update failed', e);
        }
    }

    /**
     * Unfocused-only transparency. The FOCUSED window is always fully
     * opaque — dimming the focused window (a graphics editor, say) would
     * let the background bleed into visual judgement,
     * which is exactly the annoyance that motivated this design.
     * Skips actors with an opacity transition in flight (the geometry
     * fade-move owns those moments).
     */
    _updateTransparency(win, rec) {
        const actor = rec.actor;
        if (!actor) return;

        let op = 255;
        if (this._transparencyEnabled()) {
            const key = win.appears_focused
                ? 'transparency-focused-opacity'
                : 'transparency-opacity';
            const pct = this.getSettings().get_int(key);
            op = Math.round(255 * Math.min(100, Math.max(50, pct)) / 100);
        }

        try {
            if (actor.get_transition('opacity')) {
                // A geometry fade-move owns the actor right now. If focus
                // changed mid-fade, the fade will restore a stale opacity —
                // retry once after it has certainly finished.
                if (!rec.transparencyRetryId) {
                    rec.transparencyRetryId = GLib.timeout_add(
                        GLib.PRIORITY_DEFAULT, 400, () => {
                            rec.transparencyRetryId = 0;
                            if (this._windows.has(win))
                                this._updateTransparency(win, rec);
                            return GLib.SOURCE_REMOVE;
                        });
                }
                return;
            }
            if (actor.opacity !== op)
                actor.opacity = op;
        } catch (e) {}
    }

    /**
     * Smart edges: a corner flush against a screen (work area) edge stays
     * square — a rounded corner at the very edge of the screen leaves an
     * odd gap sliver, and tiled side-by-side windows should read as tiles.
     * Any corner whose adjacent window edge sits within EDGE_SNAP_PX of the
     * work area edge is squared; interior-facing corners stay rounded.
     * Returns [TL, TR, BL, BR] with 1 = round, 0 = square.
     */
    _computeCornerMask(win, frame) {
        if (!this.getSettings().get_boolean('corners-smart-edges'))
            return [1, 1, 1, 1];

        try {
            const wa = win.get_work_area_current_monitor();
            if (!wa || wa.width <= 0) return [1, 1, 1, 1];

            const touchL = frame.x <= wa.x + EDGE_SNAP_PX;
            const touchT = frame.y <= wa.y + EDGE_SNAP_PX;
            const touchR = frame.x + frame.width >= wa.x + wa.width - EDGE_SNAP_PX;
            const touchB = frame.y + frame.height >= wa.y + wa.height - EDGE_SNAP_PX;

            return [
                (touchL || touchT) ? 0 : 1, // TL
                (touchR || touchT) ? 0 : 1, // TR
                (touchL || touchB) ? 0 : 1, // BL
                (touchR || touchB) ? 0 : 1, // BR
            ];
        } catch (e) {
            return [1, 1, 1, 1];
        }
    }

    _updateShadow(win, rec, frame, buffer, radius, mask = [1, 1, 1, 1]) {
        if (!rec.shadow) return;

        // Outer bin covers frame + SHADOW_PADDING on all sides; the actor
        // (source of the constraints) is the buffer rect, so offset by the
        // frame-buffer delta.
        const ox = frame.x - buffer.x;
        const oy = frame.y - buffer.y;
        const offsets = [
            ox - SHADOW_PADDING,
            oy - SHADOW_PADDING,
            (frame.width - buffer.width) + 2 * SHADOW_PADDING,
            (frame.height - buffer.height) + 2 * SHADOW_PADDING,
        ];
        rec.shadow.get_constraints().forEach((c, i) => {
            if (c instanceof Clutter.BindConstraint)
                c.offset = offsets[i];
        });

        const child = rec.shadow.get_child();
        if (!child) return;

        let style;
        if (radius <= 0) {
            // Maximized/fullscreen: no shadow needed
            style = 'opacity: 0;';
        } else {
            const shadowCss = win.appears_focused
                ? 'box-shadow: 0 4px 20px 5px rgba(0,0,0,0.32);'
                : 'box-shadow: 0 2px 10px 2px rgba(0,0,0,0.18);';
            // Match the shadow body to the per-corner rounding so a squared
            // window corner doesn't sit on a rounded shadow.
            // CSS order: TL TR BR BL; the mask order: TL TR BL BR.
            const r = (i) => `${mask[i] ? radius : 0}px`;
            style = `background: white; border-radius: ${r(0)} ${r(1)} ${r(3)} ${r(2)}; ${shadowCss}`;
        }
        if (child.style !== style) {
            child.style = style;
            child.queue_redraw();
        }

        // First valid sizing: now safe to paint. Bind visibility to the
        // window from here so future show/hide tracks, without the actor
        // ever being visible while unallocated.
        if (!rec._shadowShown) {
            rec._shadowShown = true;
            try {
                rec.shadow.visible = rec.actor.visible;
                rec.bindings.push(rec.actor.bind_property('visible', rec.shadow, 'visible',
                    GObject.BindingFlags.SYNC_CREATE));
            } catch (e) {}
        }
    }

    _detachWindow(win) {
        const rec = this._windows.get(win);
        if (!rec) return;

        if (rec.transparencyRetryId) {
            GLib.source_remove(rec.transparencyRetryId);
            rec.transparencyRetryId = 0;
        }
        rec.sigs.forEach(id => {
            try { win.disconnect(id); } catch (e) {}
        });
        (rec.targetSigs || []).forEach(sig => {
            try { sig.obj.disconnect(sig.id); } catch (e) {}
        });
        (rec.bindings || []).forEach(b => {
            try { b.unbind(); } catch (e) {}
        });
        try {
            if (rec.shadow) {
                rec.shadow.get_constraints().forEach(c => {
                    try { rec.shadow.remove_constraint(c); } catch (e) {}
                });
                rec.shadow.clear_effects();
                rec.shadow.destroy();
            }
        } catch (e) {}
        try {
            const target = rec.target ?? rec.actor ?? win.get_compositor_private();
            if (target) target.remove_effect_by_name('lesion-corners');
        } catch (e) {}
        try {
            // Restore full opacity if transparency was managing this window
            if (rec.actor && rec.actor.opacity !== 255 &&
                !rec.actor.get_transition('opacity'))
                rec.actor.opacity = 255;
        } catch (e) {}

        this._windows.delete(win);
    }

    _detachAll() {
        for (const win of [...this._windows.keys()])
            this._detachWindow(win);
    }
}

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib'; 
import Shell from 'gi://Shell';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js'; 
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import { ExtensionComponent } from './base.js';
import { TooltipManager } from './tooltip.js';
import { setIconGeometry } from '../util/compat.js';
import { setVertical } from '../util/compat.js';
import { log, logError } from '../util/logger.js'; 
import { gettext as _ } from '../util/gettext.js';

/**
 * Base Button Class for Application Panel Items
 */
// A click delivered through more than one path within this window
// counts once.
const ACTIVATE_DEBOUNCE_MS = 400;

const AppPanelButton = GObject.registerClass(
    { GTypeName: 'HornbillAppPanelButton' },
    class AppPanelButton extends PanelMenu.Button {
        _init(iconOrActor, name, clickCallback, menuCallback) {
            super._init(0.0, name);

            // PanelMenu.Button attaches a Clutter_ClickGesture (confirmed by
            // inspection on GNOME 50) which handles clicks and toggles its
            // menu. Gestures claim the pointer sequence and run ahead of the
            // actor's own event handling, so while one is attached NO handler
            // — connected signal or overridden vfunc — ever sees a button
            // event. Removing it returns click handling to this button.
            this.clear_actions();

            // Fill the panel's height so the button has real clickable area.
            // Without this the button collapsed to zero height on GNOME 50 —
            // reactive and visible but with no surface to click.
            this.y_expand = true;
            this.y_align = Clutter.ActorAlign.FILL;
            this.x_align = Clutter.ActorAlign.FILL;
            
            // NOTE: no padding here — panels.js overwrites this button's
            // inline style with the global button style, wiping any padding
            // set on the button itself. Content padding lives on the inner
            // box instead (setContentPadding), which nothing else restyles.
            // A real minimum keeps the button from collapsing to zero size,
            // which made it unclickable on GNOME 50.
            this.style = 'min-width: 24px; min-height: 24px;';

            this._box = new St.Widget({
                layout_manager: new Clutter.BinLayout(),
                x_expand: true,
                y_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.FILL,
            });

            // The clickable surface. St.Button owns the click protocol; only
            // its 'clicked' signal is used. button_mask enables
            // middle and right clicks in addition to primary.
            this._clickButton = new St.Button({
                x_expand: true,
                y_expand: true,
                can_focus: true,
                reactive: true,
                track_hover: true,
                button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO | St.ButtonMask.THREE,
            });
            this._clickButton.set_child(this._box);
            this.add_child(this._clickButton);

            this._contentPad = null;

            this.iconActor = iconOrActor; 
            
            // Ensure the actor is aligned center if it's an Icon or Label
            this.iconActor.x_align = Clutter.ActorAlign.CENTER;
            this.iconActor.y_align = Clutter.ActorAlign.CENTER;
            
            // Pivot point is useful for icon animations, might not apply to Label, but harmless
            this.iconActor.set_pivot_point(0.5, 0.5);
            this._box.add_child(this.iconActor);

            this._dot = new St.Widget({
                visible: true, 
                opacity: 0
            });
            this._dot.set_pivot_point(0.5, 0.5);
            this._box.add_child(this._dot);

            // Secondary Label (e.g., Workspace Indicator)
            this._label = new St.Label({
                style_class: 'app-panel-label',
                visible: false,
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.END,
                style: 'font-size: 9px; font-weight: 800; color: white; background-color: rgba(0,0,0,0.6); border-radius: 99px; padding: 1px 4px; margin-bottom: 2px; margin-right: 2px;'
            });
            this._box.add_child(this._label);

            this.set_accessible_name(name);

            this._clickCallback = clickCallback;
            this._menuCallback = menuCallback;
            
            this._role = null;
            this._app = null; 
            this._windows = [];
            this._baseOpacity = 255; // Track intended state opacity
            
            // DND State
            this._isDraggable = false;
            this._dragged = false;
            this._placeholder = null;
            this._dragMonitor = null;
            this._container = null;
            
            // Effects (Only add if it's an icon-like actor)
            if (this.iconActor instanceof St.Icon) {
                this._desatEffect = new Clutter.DesaturateEffect({ factor: 0.0 });
                this.iconActor.add_effect(this._desatEffect);
            }


            // CLICK HANDLING.
            // St.Button implements the full click protocol (press/release
            // pairing, pointer grab, button mask) and emits one 'clicked'
            // signal with the button number. This is how GNOME Shell's own
            // app icons work (AppDisplay.AppIcon extends St.Button) and how
            // other taskbar extensions drive their buttons. PanelMenu.Button
            // is an St.Widget with no 'clicked' signal, and hand-wiring its
            // button events proved unreliable across shell versions.
            this._clickButton.connect('clicked', (actor, button) => this._activate(button));
            // Hover styling follows the clickable surface.
            this._clickButton.connect('notify::hover', () => this._onHoverChanged());

            // Second, independent path: a Clutter.ClickAction resolves the
            // click itself (including the pointer grab) rather than relying
            // on which button signal the shell delivers. Harmless if the
            // St.Button path already fired — _activate is debounced.
            try {
                const clickAction = new Clutter.ClickAction();
                clickAction.connect('clicked', (action) => {
                    let btn = 1;
                    btn = action.get_button() || 1;
                    this._activate(btn);
                });
                this.add_action(clickAction);
                this._clickAction = clickAction;
            } catch (e) {
                // ClickAction unavailable on this shell version; the other
                // paths still apply.
            }

            // Hover & Cleanup
            this.connect('notify::hover', () => this._onHoverChanged());
            this.connect('destroy', () => this._onDestroy());
        }

        /**
         * Single click entry point. St.Button has already resolved the
         * press/release pairing and the pointer grab; `button` is the
         * button number (1 primary, 2 middle, 3 secondary).
         */
        /**
         * Perform the button's action. Any click-delivery path may call
         * this; a short debounce means only the first one in a burst acts,
         * so having several paths wired cannot double-launch an app.
         *
         * Returns true when the click was handled.
         */
        _activate(button) {
            try {
                if (this._destroyed) return false;
                if (this._dragged) return false;

                const now = GLib.get_monotonic_time() / 1000; // ms
                if (this._lastActivateAt && (now - this._lastActivateAt) < ACTIVATE_DEBOUNCE_MS)
                    return true; // already handled by another path
                this._lastActivateAt = now;

                // If the Activities overview (including its search) is open,
                // close it before acting. Otherwise a launched app, an
                // activated window, or a minimized window all happen behind
                // the overview, which stays on screen — looking like the
                // click did nothing. The Applications/Overview buttons are
                // the overview's own toggle and manage it themselves, so
                // they are excluded here to avoid fighting their own logic.
                if (!this._managesOverview && Main.overview.visible) {
                    Main.overview.hide();
                }

                if (button === 3) {
                    if (this._menuCallback) this._menuCallback(this.menu);
                    if (this.menu) this.menu.toggle();
                    return true;
                }

                if (button === 2) {
                    if (this._app) { this._app.open_new_window(-1); return true; }
                    // Identity check, not a label: accessible_name is now the
                    // translated display string and cannot be compared against.
                    if (this._role === 'hornbill-trash') {
                        Gio.AppInfo.launch_default_for_uri('trash:///', null);
                        return true;
                    }
                    if (this._clickCallback) { this._clickCallback(true); return true; }
                    return false;
                }

                if (this._clickCallback) { this._clickCallback(); return true; }
                return false;
            } catch (e) {
                logError('[Apps] activate failed', e);
                return false;
            }
        }

        _onDestroy() {
            this._destroyed = true;
            if (this._dragEndIdleId) {
                GLib.source_remove(this._dragEndIdleId);
                this._dragEndIdleId = 0;
            }
            if (this._dragMonitor) {
                DND.removeDragMonitor(this._dragMonitor);
                this._dragMonitor = null;
            }
            if (this._placeholder) {
                this._placeholder.destroy();
                this._placeholder = null;
            }
            this._container = null;
        }

        _onHoverChanged() {
            if (this._dragged) return;

            // Hover can be reported by the outer PanelMenu.Button or by the
            // inner St.Button that owns the pointer; treat either as hover.
            const hovered = this.hover || this._clickButton?.hover;
            const targetOpacity = hovered ? 100 : this._baseOpacity;

            this.iconActor.ease({
                opacity: targetOpacity,
                duration: 600, 
                mode: Clutter.AnimationMode.EASE_OUT_QUAD
            });
        }

        enableDragging(onDragEndCallback) {
            this._isDraggable = true;
            this._onDragEnd = onDragEndCallback;

            this._draggable = DND.makeDraggable(this, {
                manualMode: true,   // drags are started manually; see press/motion
                restoreOnSuccess: false,
                dragActorOpacity: 255
            });
            this._pressX = -1;
            this._pressY = -1;
            this._dragThreshold = 8;

            this._draggable.connect('drag-begin', () => {
                if (this._dragged) return;
                this._dragged = true;

                this._container = this.get_parent();
                while (this._container && !(this._container instanceof St.BoxLayout)) {
                    this._container = this._container.get_parent();
                }
                if (!this._container) {
                    this._dragged = false;
                    return;
                }

                this.visible = false;
                this._createPlaceholder();
                this._startDragMonitoring();
            });

            this._draggable.connect('drag-cancelled', () => this._finishDrag(true));
            this._draggable.connect('drag-end', () => this._finishDrag(false));
        }

        getDragActor() {
            // Handle dragging for Text vs Icon
            if (this.iconActor instanceof St.Label) {
                 const clone = new St.Label({
                     text: this.iconActor.text,
                     style_class: this.iconActor.style_class,
                     opacity: 220
                 });
                 return clone;
            }

            const clone = new St.Icon({
                gicon: this.iconActor.gicon,
                icon_size: this.iconActor.icon_size || 24,
                opacity: 220
            });
            clone.set_pivot_point(0.5, 0.5);
            return clone;
        }

        getDragActorSource() {
            return this.iconActor;
        }

        _createPlaceholder() {
            if (!this._container) return;
            
            let childActor;
            if (this.iconActor instanceof St.Label) {
                 childActor = new St.Label({
                     text: this.iconActor.text,
                     style: 'opacity: 0.5'
                 });
            } else {
                 childActor = new St.Icon({
                    gicon: this.iconActor.gicon,
                    icon_size: (this.iconActor.icon_size || 20), 
                    opacity: 100,
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER
                });
                const effect = new Clutter.DesaturateEffect({ factor: 1.0 });
                childActor.add_effect(effect);
            }

            this._placeholder = new St.Bin({
                style_class: 'app-panel-placeholder',
                style: `
                    width: ${this.width}px;
                    height: 30px; 
                    background-color: rgba(255, 255, 255, 0.1);
                `,
                child: childActor
            });
            
            let insertBefore = this;
            if (this.get_parent() !== this._container) {
                let p = this.get_parent();
                while(p && p.get_parent() !== this._container) p = p.get_parent();
                if (p) insertBefore = p;
            }
            
            const index = this._container.get_children().indexOf(insertBefore);
            if (index !== -1) {
                this._container.insert_child_at_index(this._placeholder, index);
            }
        }

        _startDragMonitoring() {
            this._dragMonitor = {
                dragMotion: () => {
                    if (!this._placeholder || !this._container) return DND.DragMotionResult.CONTINUE;

                    const [x, ] = global.get_pointer();
                    const children = this._container.get_children();
                    let targetIndex = 0;

                    const ACTIVATION_RATIO = 0.5;
                    let lastIndex = -1;

                    for (const child of children) {
                        if (child === this._placeholder || !child.visible) continue;
                        if (child === this || (child.contains && child.contains(this))) continue;

                        const [childX] = child.get_transformed_position();
                        const childW = child.width;
                        const triggerX = childX + childW * ACTIVATION_RATIO;

                        if (x < triggerX) break;
                        targetIndex++;
                    }

                    const currentIndex = children.indexOf(this._placeholder);
                    if (targetIndex !== currentIndex && targetIndex !== lastIndex) {
                        try {
                            this._container.set_child_at_index(this._placeholder, targetIndex);
                        } catch (error) { log('_startDragMonitoring: set_child_at_index() failed', error); }
                        lastIndex = targetIndex;
                    }

                    return DND.DragMotionResult.CONTINUE;
                }
            };

            DND.addDragMonitor(this._dragMonitor);
        }

        _finishDrag(cancelled) {
            if (this._draggable && this._draggable._dragActor) {
                this._draggable._dragActor.destroy();
            }

            this._dragged = false;

            if (this._dragMonitor) {
                DND.removeDragMonitor(this._dragMonitor);
                this._dragMonitor = null;
            }

            if (this._placeholder && this._container) {
                const destIndex = this._container.get_children().indexOf(this._placeholder);
                if (destIndex !== -1) {
                    let actorToMove = this;
                    if (this.get_parent() !== this._container) {
                        let p = this.get_parent();
                        while(p && p.get_parent() !== this._container) p = p.get_parent();
                        if (p) actorToMove = p;
                    }
                    this._container.set_child_at_index(actorToMove, destIndex);
                }
                this._placeholder.destroy();
                this._placeholder = null;
            }

            this.visible = true;
            this.opacity = 255;
            this.iconActor.scale_x = 1.0;
            this.iconActor.scale_y = 1.0;

            if (this._onDragEnd && this._container) {
                this._dragEndIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    this._dragEndIdleId = 0;
                    if (!this._destroyed && this._onDragEnd) this._onDragEnd();
                    return GLib.SOURCE_REMOVE;
                });
            }

            this._container = null;
        }

        updateDotStyle(width, height, color, radius) {
            try {
                if (!this.iconActor) return;
                this._dot.width = width;
                this._dot.height = height;
                this._dot.style = `background-color: ${color}; border-radius: ${radius}px;`;
            } catch (e) { log('updateDotStyle failed', e); }
        }

        updateDotLayout(posEnum, offset) {
            try {
                if (!this.iconActor) return;
                this._dot.translation_x = 0;
                this._dot.translation_y = 0;
                switch(posEnum) {
                    case 0: this._dot.x_align = Clutter.ActorAlign.CENTER; this._dot.y_align = Clutter.ActorAlign.START; this._dot.translation_y = offset; break;
                    case 1: this._dot.x_align = Clutter.ActorAlign.END; this._dot.y_align = Clutter.ActorAlign.CENTER; this._dot.translation_x = -offset; break;
                    case 2: this._dot.x_align = Clutter.ActorAlign.CENTER; this._dot.y_align = Clutter.ActorAlign.END; this._dot.translation_y = -offset; break;
                    case 3: this._dot.x_align = Clutter.ActorAlign.START; this._dot.y_align = Clutter.ActorAlign.CENTER; this._dot.translation_x = offset; break;
                }
            } catch (e) { log('updateDotLayout failed', e); }
        }


        /**
         * Horizontal padding of the button content. Lives on the inner box
         * so it survives the global button styling applied by PanelsManager.
         */
        setContentPadding(px) {
            if (this._contentPad === px) return;
            this._contentPad = px;
            this._box.style = `padding: 0 ${px}px;`;
        }
        setVisualState(opacity, showDot) {
            try {
                if (!this.iconActor) return;
                if (this._dragged || !this.visible) return;

                // Store the intended state opacity (e.g. 160 for stopped, 255 for running)
                this._baseOpacity = opacity;

                // If currently hovered, stay at 255, otherwise use the requested state opacity
                const effectiveOpacity = this.hover ? 100 : this._baseOpacity;

                this.iconActor.ease({
                    opacity: effectiveOpacity,
                    duration: 250,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD
                });
                this._dot.ease({
                    opacity: showDot ? 255 : 0,
                    scale_x: showDot ? 1 : 0,
                    scale_y: showDot ? 1 : 0,
                    duration: 250,
                    mode: Clutter.AnimationMode.EASE_OUT_BACK
                });
            } catch (e) { log('setVisualState failed', e); }
        }

        setSecondaryLabel(text, visible) {
            if (!this._label) return;
            this._label.text = text || '';
            this._label.visible = visible;
        }

        _getWindows() {
            if (this._app) return this._app.get_windows();
            return this._windows || [];
        }

        vfunc_scroll_event(event) {
            const windows = this._getWindows();
            if (windows.length > 1) {
                const direction = event.get_scroll_direction();
                const focusWin = global.display.focus_window;
                let idx = windows.indexOf(focusWin);
                
                if (idx === -1) idx = 0;
                
                if (direction === Clutter.ScrollDirection.UP) {
                    idx = (idx - 1 + windows.length) % windows.length;
                } else if (direction === Clutter.ScrollDirection.DOWN) {
                    idx = (idx + 1) % windows.length;
                }
                
                windows[idx].activate(global.get_current_time());
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }

    }
);

/**
 * Main Extension Component for Managing Apps
 */
export class AppsManager extends ExtensionComponent {
    
    onEnable() {
        


        // Third click path: the panel's capture phase. Events reach here
        // before they are dispatched to individual children, so this works
        // even when a child never sees the button event itself. It could
        // not work while buttons had zero size (nothing to hit); they now
        // fill the panel height. _activate is debounced, so if another path
        // already handled the click this is a no-op.
        try {
            this._clickDispatchId = Main.panel.connect('captured-event', (actor, event) => {
                try {
                    if (event.type() !== Clutter.EventType.BUTTON_RELEASE)
                        return Clutter.EVENT_PROPAGATE;

                    const src = global.stage.get_event_actor
                        ? global.stage.get_event_actor(event) : null;

                    let btn = src;
                    let hops = 0;
                    while (btn && !(btn instanceof AppPanelButton) && hops < 24) {
                        btn = btn.get_parent ? btn.get_parent() : null;
                        hops++;
                    }
                    if (!btn || btn._destroyed) return Clutter.EVENT_PROPAGATE;

                    if (btn._activate(event.get_button()))
                        return Clutter.EVENT_STOP;
                } catch (e) {
                    logError('[Apps] panel click dispatch failed', e);
                }
                return Clutter.EVENT_PROPAGATE;
            });
        } catch (e) {
            logError('[Apps] panel click dispatch connect failed', e);
        }

        this._items = { favorites: [], running: [], disks: [], trash: null, showgrid: null, overview: null };
        // TWO DISTINCT SETS. _handledWindows means "already represented by
        // some button" and gates duplicate Running entries, so it includes
        // every window of every FAVOURITED app. _claimedWindows means
        // "belongs to a Trash or Drive button" and is the only correct basis
        // for separating Files from its siblings — v124 used _handledWindows
        // for that, and since Files is normally a favourite, every Nautilus
        // window was in it: the Files button could never find an unclaimed
        // window, so it never lit up and its click fell through to the Trash
        // window.
        this._handledWindows = new Set();
        this._claimedWindows = new Set();

        // One label and one timer for every button; see components/tooltip.js.
        // Created before the first _rebuildAll() so buttons can attach as they
        // are built.
        this._tooltips = new TooltipManager(this.getSettings());
        this._trashName = _('Trash'); // replaced below by the GIO display name
        
        this._appSystem = Shell.AppSystem.get_default();
        this._winTracker = Shell.WindowTracker.get_default();
        this._volumeMonitor = Gio.VolumeMonitor.get();
        this._windowSignals = new Map();

        try {
            const file = Gio.File.new_for_uri('trash:///');
            const info = file.query_info('standard::display-name', Gio.FileQueryInfoFlags.NONE, null);
            this._trashName = info.get_display_name();
        } catch (e) { logError('[Apps] trash display-name lookup failed', e); }

        const visualUpdate = () => this._updateVisuals();

        // FIX: Rebuild on icon changes, not just updateState
        const rebuild = () => this._rebuildAll();
        this.observe('changed::apps-icon-size', rebuild);
        this.observe('changed::apps-icon-desaturate', rebuild);
        
        this.observe('changed::apps-btn-padding', visualUpdate);
        this.observe('changed::apps-opacity-running', visualUpdate);
        this.observe('changed::apps-opacity-stopped', visualUpdate);
        
        ['pos', 'offset', 'width', 'height', 'radius', 'color'].forEach(k => {
            this.observe(`changed::apps-indicator-${k}`, visualUpdate);
        });

        // Watch Standard Groups
        ['favorites', 'running', 'disks', 'trash'].forEach(g => {
            const rebuild = () => {
                this._rebuildAll();
            };
            this.observe(`changed::apps-${g}-enabled`, rebuild);
            this.observe(`changed::apps-${g}-pos`, rebuild);
            this.observe(`changed::apps-${g}-index`, rebuild);
        });
        
        // Watch Show Grid / Overview Specifics
        ['showgrid', 'overview'].forEach(g => {
            this.observe(`changed::apps-${g}-enabled`, rebuild);
            this.observe(`changed::apps-${g}-pos`, rebuild);
            this.observe(`changed::apps-${g}-index`, rebuild);
            if (g === 'showgrid') {
                 // Watch all new keys
                 this.observe('changed::apps-showgrid-mode', rebuild);
                 this.observe('changed::apps-showgrid-icon', rebuild);
                 this.observe('changed::apps-showgrid-path', rebuild);
                 this.observe('changed::apps-showgrid-text', rebuild);
            }
            if (g === 'overview') this.observe(`changed::apps-${g}-hide-default`, rebuild);
        });

        const shellSettings = new Gio.Settings({ schema_id: 'org.gnome.shell' });
        this._signals.push({
            obj: shellSettings,
            id: shellSettings.connect('changed::favorite-apps', () => {
                this._syncFavorites();
                this._refreshHandledWindowsMap();
                this._syncRunning(); 
            }) 
        });
        
        this._signals.push({
            obj: this._appSystem,
            id: this._appSystem.connect('installed-changed', () => this._syncRunning(true))
        });

        this._signals.push({
            obj: this._winTracker,
            id: this._winTracker.connect('notify::focus-app', visualUpdate)
        });
        
        this._signals.push({
            obj: global.display,
            id: global.display.connect('notify::focus-window', visualUpdate)
        });

        this._signals.push({
            obj: global.display,
            id: global.display.connect('window-created', (d, w) => {
                this._trackWindow(w);
                this._handleWindowChange();
            })
        });
        
        this._signals.push({
            obj: global.display,
            id: global.display.connect('window-demands-attention', visualUpdate)
        });

        this._signals.push({
            obj: this._volumeMonitor,
            id: this._volumeMonitor.connect('mount-added', () => this._rebuildAll())
        });
        this._signals.push({
            obj: this._volumeMonitor,
            id: this._volumeMonitor.connect('mount-removed', () => this._rebuildAll())
        });

        // Trash Monitor
        try {
            const trashFile = Gio.File.new_for_uri('trash:///');
            this._trashMonitor = trashFile.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this._signals.push({
                obj: this._trashMonitor,
                id: this._trashMonitor.connect('changed', () => {
                    this._syncTrash();
                    this._refreshHandledWindowsMap();
                    this._syncRunning();
                    this._updateVisuals(); 
                })
            });
        } catch (e) {
            console.warn('Hornbill: Failed to monitor trash', e);
        }

        // Overview & Workspace Signals
        this._signals.push({
            obj: Main.overview,
            id: Main.overview.connect('showing', () => this._updateVisuals())
        });
        this._signals.push({
            obj: Main.overview,
            id: Main.overview.connect('hiding', () => this._updateVisuals())
        });
        // Connect to dash item (App Grid Button) state changes if possible, or just poll in visual update
        // Hooking into 'hidden'/'shown' gives cleaner transitions
        this._signals.push({
            obj: Main.overview,
            id: Main.overview.connect('shown', () => this._updateVisuals())
        });
         this._signals.push({
            obj: Main.overview,
            id: Main.overview.connect('hidden', () => this._updateVisuals())
        });

        if (global.workspace_manager) {
            this._signals.push({
                obj: global.workspace_manager,
                id: global.workspace_manager.connect('active-workspace-changed', () => this._updateVisuals())
            });
        }

        global.display.list_all_windows().forEach(win => this._trackWindow(win));

        this._rebuildAll();
    }

    onDisable() {
        if (this._clickDispatchId) {
            Main.panel.disconnect(this._clickDispatchId);
            this._clickDispatchId = 0;
        }
        // FIX: a pending debounce could fire after disable and touch
        // destroyed buttons, throwing in the shell's main loop.
        if (this._updateTimeout) {
            GLib.source_remove(this._updateTimeout);
            this._updateTimeout = null;
        }

        this._clearAll();
        // Restore Default Activities if hidden
        const act = Main.panel.statusArea.activities;
        if (act) {
            act.container.show();
            act.container.reactive = true;
            act.reactive = true;
            act.can_focus = true;
            act.track_hover = true;
        }

        if (this._windowSignals) {
            for (const [win, ids] of this._windowSignals) {
                ids.forEach(id => { try { win.disconnect(id); } catch (e) { log('onDisable: disconnect() failed', e); } });
            }
            this._windowSignals.clear();
        }
        if (this._trashMonitor) {
            this._trashMonitor.cancel();
            this._trashMonitor = null;
        }
        
        if (this._tooltips) {
            this._tooltips.destroy();
            this._tooltips = null;
        }

        // Cleanup Identity Dialog if open
        if (this._identityDialog) {
            this._identityDialog.destroy();
            this._identityDialog = null;
        }
    }

    _trackWindow(win) {
        if (!win || this._windowSignals.has(win)) return;
        const signals = [];

        signals.push(win.connect('unmanaged', () => {
            const ids = this._windowSignals.get(win);
            if (ids) ids.forEach(id => { win.disconnect(id); });
            this._windowSignals.delete(win);
            this._handleWindowChange();
        }));

        signals.push(win.connect('notify::title', () => {
            const app = this._winTracker.get_window_app(win);
            if (app && (app.get_id().includes('nautilus') || app.get_id().includes('org.gnome.Nautilus'))) {
                this._handleWindowChange();
            }
        }));

        this._windowSignals.set(win, signals);
    }

    _handleWindowChange() {
        if (this._updateTimeout) GLib.source_remove(this._updateTimeout);
        this._updateTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            this._updateState();
            this._updateTimeout = null;
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearAll() {
        this._clearGroup('favorites');
        this._clearGroup('running');
        this._clearGroup('disks');
        
        ['trash', 'showgrid', 'overview'].forEach(k => {
            if (this._items[k]) {
                if (this._items[k]._role) delete Main.panel.statusArea[this._items[k]._role];
                this._items[k].destroy();
                this._items[k] = null;
            }
        });
    }

    _clearGroup(group) {
        this._items[group].forEach(btn => {
            if (btn._role) delete Main.panel.statusArea[btn._role];
            btn.destroy();
        });
        this._items[group] = [];
    }

    _rebuildAll() {
        // Order matters: groups must be built before the items that are
        // positioned after them (trash offsets past disks, running past
        // favorites) so the group counts are accurate.
        this._syncDisks();
        this._syncTrash();
        this._syncShowGrid();
        this._syncOverview();
        this._syncFavorites();
        this._refreshHandledWindowsMap(); 
        this._syncRunning(true);
        this._updateVisuals();
    }

    _updateState() {
        this._refreshHandledWindowsMap();
        this._syncRunning(false); 
        this._updateVisuals();
    }

    /**
     * Assigns windows to the Trash and Drive buttons.
     *
     * Two rules, both learned from misassignment:
     *
     * 1. ONLY file-manager windows are candidates. Trash and drives open as
     *    Nautilus windows, but the old scan walked every running app and
     *    claimed any window whose title merely CONTAINED the name — a note
     *    named 'trash-notes.md', a browser tab titled 'Trash', a terminal
     *    sitting in ~/Trash, or, for a drive named 'Data', every window with
     *    'data' anywhere in its title.
     *
     * 2. A window belongs to exactly ONE button. Trash and each drive matched
     *    independently and both added to _handledWindows, so a window could
     *    land in two _windows lists; _updateVisuals then lit whichever ran
     *    last, and the running dot appeared on both.
     */
    _refreshHandledWindowsMap() {
        this._handledWindows.clear();
        this._claimedWindows.clear();

        const fmWindows = [];
        this._appSystem.get_running().forEach(app => {
            if (this._isFileManager(app)) fmWindows.push(...app.get_windows());
        });

        const titleOf = (w) => {
            try { return (w.get_title() || '').trim().toLowerCase(); }
            catch (e) { log('_refreshHandledWindowsMap: get_title() failed', e); return ''; }
        };

        // Exact title first. Nautilus titles a window with the folder name, so
        // an exact match is the correct test; substring is kept as a fallback
        // so a shell that appends a suffix degrades to the old behaviour
        // instead of matching nothing at all.
        const claim = (name) => {
            const want = (name || '').trim().toLowerCase();
            if (!want) return [];
            const free = fmWindows.filter(w => !this._claimedWindows.has(w));
            let hits = free.filter(w => titleOf(w) === want);
            if (hits.length === 0) hits = free.filter(w => titleOf(w).includes(want));
            hits.forEach(w => {
                this._claimedWindows.add(w);
                this._handledWindows.add(w);
            });
            return hits;
        };

        // Trash claims before drives: it is a fixed system location, whereas a
        // volume name is user-supplied and could collide with it.
        if (this._items.trash) {
            this._items.trash._windows =
                this.getSettings().get_boolean('apps-trash-enabled')
                    ? claim(this._trashName)
                    : [];
        }

        if (this.getSettings().get_boolean('apps-disks-enabled')) {
            this._items.disks.forEach(btn => {
                // _matchName is the raw, untranslated mount name kept for
                // title matching; accessible_name is display text.
                btn._windows = claim(btn._matchName);
            });
        }

        if (this.getSettings().get_boolean('apps-favorites-enabled')) {
            this._items.favorites.forEach(btn => {
                if (btn._app) {
                    btn._app.get_windows().forEach(w => this._handledWindows.add(w));
                }
            });
        }
    }

    _getIndicatorSettings() {
        return {
            pos: this.getSettings().get_enum('apps-indicator-pos'), 
            offset: this.getSettings().get_int('apps-indicator-offset'),
            width: this.getSettings().get_int('apps-indicator-width'),
            height: this.getSettings().get_int('apps-indicator-height'),
            radius: this.getSettings().get_int('apps-indicator-radius'),
            color: this.getSettings().get_string('apps-indicator-color')
        };
    }

    _applyEffects(icon) {
        if (!icon) return icon;
        // Don't apply desaturate to St.Label
        if (icon instanceof St.Label) return icon;

        const desaturate = this.getSettings().get_boolean('apps-icon-desaturate');
        if (desaturate) {
            const effect = new Clutter.DesaturateEffect({ factor: 1.0 });
            icon.add_effect(effect);
        }
        return icon;
    }

    _isFileManager(app) {
        if (!app) return false;
        const id = app.get_id();
        return id.includes('nautilus') || id.includes('org.gnome.Nautilus');
    }

    _updateVisuals() {
        const ind = this._getIndicatorSettings();
        const opacityRunning = this.getSettings().get_int('apps-opacity-running');
        const opacityStopped = this.getSettings().get_int('apps-opacity-stopped');
        const contentPad = this.getSettings().get_int('apps-btn-padding');

        // Content padding for all custom buttons (no-op if unchanged)
        const padAll = (btn) => { if (btn && btn.setContentPadding) btn.setContentPadding(contentPad); };
        padAll(this._items.trash);
        padAll(this._items.showgrid);
        padAll(this._items.overview);
        this._items.disks.forEach(padAll);
        this._items.favorites.forEach(padAll);
        this._items.running.forEach(padAll);

        const focusWindow = global.display.focus_window;
        let activeCustomBtn = null; 

        const checkBtnFocus = (btn) => {
            if (!btn || !btn._windows) return false;
            if (focusWindow && btn._windows.some(w => w === focusWindow)) {
                activeCustomBtn = btn;
                return true;
            }
            return false;
        };

        // Drop any buttons destroyed since the last tick so they are never
        // touched again (source of the "already disposed" log spam).
        this._items.favorites = (this._items.favorites || []).filter(b => b && !b._destroyed);
        this._items.running = (this._items.running || []).filter(b => b && !b._destroyed);
        this._items.disks = (this._items.disks || []).filter(b => b && !b._destroyed);

        if (this._items.trash) checkBtnFocus(this._items.trash);
        this._items.disks.forEach(checkBtnFocus);

        const apply = (btn, isRunning, isFocused) => {
            try {
                // _destroyed is a plain JS flag set in _onDestroy; reading it
                // never touches the disposed native object, so it can't log
                // "already disposed". This is the reliable liveness gate.
                if (!btn || btn._destroyed) return;
                if (!btn.iconActor || !btn.get_parent()) return;
                if (btn._dragged || btn.visible === false) return;

                btn.updateDotStyle(ind.width, ind.height, ind.color, ind.radius);
                btn.updateDotLayout(ind.pos, ind.offset);

                if (isFocused) btn.add_style_pseudo_class('active');
                else btn.remove_style_pseudo_class('active');

                let targetOpacity = opacityStopped;
                if (isFocused) targetOpacity = 255;
                else if (isRunning) targetOpacity = opacityRunning;

                btn.setVisualState(targetOpacity, isRunning);
            } catch (e) { log('_updateVisuals failed', e); }
        };

        if (this._items.trash) {
            const running = this._items.trash._windows && this._items.trash._windows.length > 0;
            const focused = activeCustomBtn === this._items.trash;
            apply(this._items.trash, running, focused);
        }

        this._items.disks.forEach(btn => {
            const running = btn._windows && btn._windows.length > 0;
            const focused = activeCustomBtn === btn;
            apply(btn, running, focused);
        });
        
        const focusApp = this._winTracker.focus_app;

        // Files is Files and Trash is Trash: the file manager's own button
        // must report only the windows no custom button claimed. Previously
        // 'running' came from the app state, so a session whose only Nautilus
        // window was the Trash window still lit the Files dot, and 'focused'
        // was cleared via the activeCustomBtn proxy rather than by asking
        // whether THIS window was claimed.
        const unclaimedWindows = (app) => {
            try { return app.get_windows().filter(w => !this._claimedWindows.has(w)); }
            catch (e) { log('_updateVisuals: get_windows() failed', e); return []; }
        };

        this._items.favorites.forEach(btn => {
            if (btn._app) {
                let running = btn._app.state === Shell.AppState.RUNNING;
                let focused = focusApp === btn._app;
                if (this._isFileManager(btn._app)) {
                    const own = unclaimedWindows(btn._app);
                    running = own.length > 0;
                    focused = focused && !!focusWindow && own.includes(focusWindow);
                }
                apply(btn, running, focused);
            }
        });

        this._items.running.forEach(btn => {
            if (btn._app) {
                let focused = focusApp === btn._app;
                if (focused && this._isFileManager(btn._app) && focusWindow)
                    focused = !this._claimedWindows.has(focusWindow);
                apply(btn, true, focused);
            }
        });

        this._syncIconGeometry();

        // --- NEW BUTTONS VISUALS ---

        const overviewVisible = Main.overview.visible;
        // Logic: Grid is 'open' if overview is visible AND app grid is selected (checked)
        // This is a proxy detection for standard GNOME Shell
        const isGridOpen = overviewVisible && Main.overview.dash.showAppsButton.checked;
        const isOverviewOpen = overviewVisible && !isGridOpen;

        if (this._items.showgrid) {
             apply(this._items.showgrid, isGridOpen, isGridOpen);
        }

        if (this._items.overview) {
             apply(this._items.overview, isOverviewOpen, isOverviewOpen);
             
             // Update Workspace Indicator for Overview Button
             if (isOverviewOpen && global.workspace_manager) {
                 const activeIndex = global.workspace_manager.get_active_workspace_index() + 1;
                 this._items.overview.setSecondaryLabel(`${activeIndex}`, true);
             } else {
                 this._items.overview.setSecondaryLabel('', false);
             }
        }
    }

    _appendAction(menu, label, callback, destructive = false) {
        const item = new PopupMenu.PopupMenuItem(label);
        if (destructive) item.actor.add_style_class_name('button-destructive-action');
        item.connect('activate', () => callback());
        menu.addMenuItem(item);
    }

    _appendSeparator(menu) {
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    }

    _buildContextAwareAppMenu(menu, app, appId, isFavorite) {
        menu.removeAll();
        const windows = app.get_windows();
        const isRunning = windows.length > 0;
        
        // --- NEW: Window Switching List ---
        if (isRunning) {
            this._appendSeparator(menu);
            // Header for windows
            const header = new PopupMenu.PopupMenuItem('Open Windows', { reactive: false });
            header.actor.add_style_class_name('popup-subtitle-menu-item');
            header.actor.style = 'font-weight: bold; padding-bottom: 4px; opacity: 0.7;';
            menu.addMenuItem(header);

            windows.forEach(w => {
                let title = w.get_title() || 'Untitled Window';
                if (title.length > 40) title = title.substring(0, 37) + '...';
                
                // Add a small dot if focused
                const isFocused = global.display.focus_window === w;
                if (isFocused) title = `• ${title}`;

                this._appendAction(menu, title, () => w.activate(global.get_current_time()));
            });
            this._appendSeparator(menu);
            this._appendAction(menu, 'New Window', () => app.open_new_window(-1));
        } else {
            this._appendAction(menu, 'Open', () => app.open_new_window(-1));
        }

        const settings = new Gio.Settings({ schema_id: 'org.gnome.shell' });
        const favorites = settings.get_strv('favorite-apps');
        const isPinned = favorites.includes(appId);

        this._appendSeparator(menu);
        this._appendAction(menu, isPinned ? 'Unpin from Favorites' : 'Pin to Favorites', () => {
            if (isPinned) {
                const newFavs = favorites.filter(id => id !== appId);
                settings.set_strv('favorite-apps', newFavs);
            } else {
                const newFavs = [...favorites, appId];
                settings.set_strv('favorite-apps', newFavs);
            }
        });

        // --- NEW: Check for Desktop Actions (Preferences/Settings) ---
        const appInfo = app.get_app_info();
        if (appInfo) {
            const actions = appInfo.list_actions();
            // Look for standard preference actions in the desktop file
            const prefAction = actions.find(a => {
                const lower = a.toLowerCase();
                return lower === 'preferences' || lower === 'settings' || lower === 'options';
            });

            if (prefAction) {
                this._appendSeparator(menu);
                // Get localized name (e.g., "Preferences")
                const label = appInfo.get_action_name(prefAction) || 'Preferences';
                this._appendAction(menu, label, () => {
                    try {
                        appInfo.launch_action(prefAction, null);
                    } catch (e) {
                        logError(`Failed to launch action ${prefAction} for ${appId}`, e);
                    }
                });
            }
        }

        // --- RENAMED: System Settings Link -> "System" ---
        this._appendSeparator(menu);
        this._appendAction(menu, 'System', () => {
            try {
                // Remove .desktop suffix for control center argument if present, though it often handles both
                const cleanId = appId.replace(/\.desktop$/i, '');
                GLib.spawn_command_line_async(`gnome-control-center applications ${cleanId}`);
            } catch (e) {
                logError('Failed to launch system settings', e);
            }
        });

        // --- RENAMED: "About" -> "Software" (User preferred) ---
        this._appendAction(menu, 'Software', () => {
            const uri = this._resolveAppStoreId(appId);
            try {
                Gio.AppInfo.launch_default_for_uri(uri, null);
            } catch(e) {
                Main.notify('Hornbill', `Unable to find ${app.get_name()} in Software Center.`);
            }
        });

        // --- RENAMED: "Identity" -> "Properties" (User preferred)
        this._appendAction(menu, 'Properties', () => this._showIdentityDialog(app, appId));

        if (isRunning) {
            this._appendSeparator(menu);
            this._appendAction(menu, 'Quit', () => app.request_quit());
        }
    }

    _showIdentityDialog(app, appId) {
        // Destroy existing dialog if present
        if (this._identityDialog) {
            this._identityDialog.destroy();
            this._identityDialog = null;
        }

        // Build Data Strings
        const info = [
            `Name: ${app.get_name()}`,
            `ID: ${appId}`
        ];
        
        const appInfo = app.get_app_info();
        if (appInfo) {
            info.push(`Command: ${appInfo.get_commandline() || 'N/A'}`);
            info.push(`Path: ${appInfo.get_filename() || 'N/A'}`);
        }
        
        const windows = app.get_windows();
        if (windows.length > 0 && windows[0].get_wm_class) {
             info.push(`WM Class: ${windows[0].get_wm_class()}`);
        }

        const fullTextToCopy = info.join('\n');

        // Create Container (Not ModalDialog, but a generic Box)
        this._identityDialog = new St.BoxLayout({
            reactive: true,
            can_focus: true, // Allow focus for key events
            style_class: 'modal-dialog', // Reuse modal style for visuals
            style: 'min-width: 360px; padding: 12px;' // Removed manual borders/colors to respect theme
        });
        setVertical(this._identityDialog, true);

        // Header (Draggable)
        const header = new St.BoxLayout({ vertical: false, style: 'padding-bottom: 12px;' });
        const icon = app.create_icon_texture(32);
        const title = new St.Label({ 
            // UPDATED TITLE
            text: _('Properties'), 
            style: 'font-weight: bold; font-size: 1.2em; padding-left: 12px;',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true // Title takes up remaining space
        });
        
        // Close Button
        const closeBtn = new St.Button({
            child: new St.Icon({ icon_name: 'window-close-symbolic', icon_size: 16 }),
            style_class: 'window-close', // Standard standard circular close button
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER
        });
        closeBtn.connect('clicked', () => {
            this._identityDialog.destroy();
            this._identityDialog = null;
        });

        header.add_child(icon);
        header.add_child(title);
        header.add_child(closeBtn);
        this._identityDialog.add_child(header);

        // Content
        const contentBox = new St.BoxLayout({ style: 'spacing: 4px;' });
        setVertical(contentBox, true);
        
        info.forEach(line => {
            const parts = line.split(': ');
            const label = parts[0];
            const val = parts.slice(1).join(': ');
            
            const row = new St.BoxLayout({ style: 'padding: 4px 0;' });
            row.add_child(new St.Label({ text: `${label}: `, style: 'font-weight: bold; opacity: 0.7; min-width: 80px;' }));
            
            const valLabel = new St.Label({ 
                text: val, 
                style: 'font-family: monospace;',
            });
            // Wrapping logic
            valLabel.clutter_text.line_wrap = true;
            valLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            
            row.add_child(valLabel);
            contentBox.add_child(row);
        });
        
        this._identityDialog.add_child(contentBox);

        // Action Bar
        const actionBox = new St.BoxLayout({ style: 'padding-top: 16px; spacing: 12px;', x_align: Clutter.ActorAlign.END });
        
        const copyBtn = new St.Button({
            label: _('Copy Info'),
            style_class: 'button',
            style: 'padding: 4px 12px;'
        });
        
        copyBtn.connect('clicked', () => {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, fullTextToCopy);
            copyBtn.label = _('Copied!');
            this.timeoutOnce(2000, () => {
                if (copyBtn) copyBtn.label = _('Copy Info');
            });
        });

        actionBox.add_child(copyBtn);
        this._identityDialog.add_child(actionBox);

        // Add to Shell
        Main.layoutManager.addChrome(this._identityDialog, { trackFullscreen: true });

        // Center on Screen
        const monitor = Main.layoutManager.primaryMonitor;
        this._identityDialog.width = 400; // Constrain width
        const x = monitor.x + (monitor.width - 400) / 2;
        const y = monitor.y + (monitor.height - this._identityDialog.height) / 2;
        this._identityDialog.set_position(x, y);

        // Make Draggable
        let dragging = false;
        let dragOffset = [0, 0];

        // Dragging Logic on the Dialog itself (or header)
        this._identityDialog.connect('button-press-event', (actor, event) => {
            dragging = true;
            const [ex, ey] = event.get_coords();
            dragOffset = [ex - actor.x, ey - actor.y];
            return Clutter.EVENT_PROPAGATE;
        });

        this._identityDialog.connect('button-release-event', () => {
            dragging = false;
            return Clutter.EVENT_PROPAGATE;
        });

        this._identityDialog.connect('motion-event', (actor, event) => {
            if (dragging) {
                const [ex, ey] = event.get_coords();
                actor.set_position(ex - dragOffset[0], ey - dragOffset[1]);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // Key Press (Escape to close)
        this._identityDialog.connect('key-press-event', (actor, event) => {
            const symbol = event.get_key_symbol();
            if (symbol === Clutter.KEY_Escape) {
                this._identityDialog.destroy();
                this._identityDialog = null;
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        
        // Grab focus so ESC key works immediately
        this._identityDialog.grab_key_focus();
    }

    /**
     * Resolves the AppStream URI by attempting to fix common ID quirks
     * (e.g. Snap duplicates like 'firefox_firefox').
     */
    _resolveAppStoreId(appId) {
        let id = appId.replace(/\.desktop$/i, '');
        const snapIdPattern = /^([^_]+)_\1$/.test(id);


        // Snap duplicate cleanup
        // Snap strict mode quirks (e.g. firefox_firefox -> firefox)
        if (snapIdPattern) {
            log(`Hornbill: checking ${id} for snap duplicate pattern`);
            id = id.split('_')[0];
        }

        // Cache map generation
        if (!this._appStreamMap) {
            this._appStreamMap = this._buildAppStreamMap();
        }

        // Lookup: Try exact ID first, then lowercase ID (often fixes casing mismatches)
        const map = this._appStreamMap;
        const mappedId = map[id] || map[id.toLowerCase()];

        log(`Hornbill: AppStream canonical match → ${id} → ${mappedId} → ${appId}`);
        if (mappedId) {
            return `appstream://${mappedId}`;
        } else if (snapIdPattern) {
            return `appstream://${id}`;
        }
        
        // FIX: Default fallback should be the cleaned 'id' (no .desktop), not 'appId'
        return `appstream://${id}`;
    }
    
    _buildAppStreamMap() {
        // Cache map generation
        if (this._appStreamMap) {
            return this._appStreamMap;
        }

        const CANONICAL_APPS = {
            // Browsers
            chrome: {
                target: 'google-chrome-stable',
                ids: ['google-chrome', 'google-chrome-stable', 'com.google.Chrome']
            },
            firefox: {
                target: 'org.mozilla.firefox',
                ids: ['firefox', 'firefox_firefox', 'org.mozilla.firefox']
            },
            chromium: {
                target: 'org.chromium.Chromium',
                ids: ['chromium', 'chromium_chromium', 'org.chromium.Chromium']
            },
            edge: {
                target: 'microsoft-edge-stable',
                ids: ['microsoft-edge', 'com.microsoft.Edge']
            },
            
            // Dev Tools
            vscode: {
                target: 'code', 
                ids: ['code', 'code_code', 'com.visualstudio.code']
            },
            
            // GNOME Core (Legacy mapping) - UNCOMMENTED TO FIX ISSUES
            terminal: {
                target: 'org.gnome.Terminal',
                ids: ['gnome-terminal', 'org.gnome.Terminal'] 
            },
            files: {
                target: 'org.gnome.Nautilus',
                ids: ['nautilus', 'org.gnome.Nautilus', 'org.gnome.nautilus']
            },
            software: {
                target: 'org.gnome.Software',
                ids: ['gnome-software', 'org.gnome.Software']
            }
        };

        this._appStreamMap = Object.create(null);

        for (const key in CANONICAL_APPS) {
            const { target, ids } = CANONICAL_APPS[key];
            for (const id of ids) {
                this._appStreamMap[id] = target;
                this._appStreamMap[id.toLowerCase()] = target; // Populate lowercase keys for easier lookup
            }
        }

        return this._appStreamMap;
    }

    _confirmEmptyTrash() {
        const dialog = new ModalDialog.ModalDialog();
        dialog.setButtons([
            { label: _('Cancel'), action: () => dialog.close(), key: Clutter.KEY_Escape },
            { 
                label: _('Empty Trash'), 
                action: () => {
                    dialog.close();
                    try { GLib.spawn_command_line_async('gio trash --empty'); } catch (e) { logError('_confirmEmptyTrash: spawn_command_line_async() failed', e); }
                },
                key: Clutter.KEY_Return
            }
        ]);
        const content = new St.Label({ 
            style_class: 'message-dialog-content',
            text: _('Are you sure you want to delete all items in the Trash?'),
            x_align: Clutter.ActorAlign.CENTER
        });
        dialog.contentLayout.add_child(content);
        dialog.open();
    }

    _safelyRemove(mount) {
        const name = mount.get_name();
        const callback = (source, res) => {
            try {
                if (source.eject_with_operation_finish) source.eject_with_operation_finish(res);
                else source.unmount_with_operation_finish(res);
                Main.notify('Safely Removed', `${name} can now be unplugged.`);
            } catch (e) {
                Main.notify('Safely Remove Failed', e.message);
                logError('Safely Remove Failed', e);
            }
        };
        if (mount.can_eject()) mount.eject_with_operation(Gio.MountUnmountFlags.NONE, null, null, callback);
        else mount.unmount_with_operation(Gio.MountUnmountFlags.NONE, null, null, callback);
    }

    _handleDragFinish() {
        if (this._items.favorites.length === 0) return;
        
        let container = null;
        for (const btn of this._items.favorites) {
            let p = btn.get_parent();
            while (p && !(p instanceof St.BoxLayout)) p = p.get_parent();
            if (p) {
                container = p;
                break;
            }
        }
        
        if (!container) return;
        
        const children = container.get_children();
        const newOrder = [];
        
        children.forEach(child => {
            let button = null;
            if (child instanceof AppPanelButton) {
                button = child;
            } else {
                const found = this._items.favorites.find(f => {
                    let p = f.get_parent();
                    while (p) {
                        if (p === child) return true;
                        if (p === container) break;
                        p = p.get_parent();
                    }
                    return false;
                });
                if (found) button = found;
            }

            if (button) {
                const favMatch = this._items.favorites.find(f => f === button);
                if (favMatch && favMatch._app) {
                    newOrder.push(favMatch._app.get_id());
                }
            }
        });
        
        if (newOrder.length === this._items.favorites.length) {
             const settings = new Gio.Settings({ schema_id: 'org.gnome.shell' });
             settings.set_strv('favorite-apps', newOrder);
        } else {
            this._syncFavorites();
        }
    }

    // --- BUTTON SYNC METHODS ---

    _syncTrash() {
        if (this._items.trash) {
            if (this._items.trash._role) delete Main.panel.statusArea[this._items.trash._role];
            this._items.trash.destroy();
            this._items.trash = null;
        }
        if (!this.getSettings().get_boolean('apps-trash-enabled')) return;

        const size = this.getSettings().get_int('apps-icon-size');
        const pos = this._getPos('trash');
        const idx = this._getIndexAfterGroup('trash', 'disks');

        let gicon = null;
        try {
            const file = Gio.File.new_for_uri('trash:///');
            const info = file.query_info('standard::icon', Gio.FileQueryInfoFlags.NONE, null);
            if (info && info.has_attribute('standard::icon')) {
                gicon = info.get_icon();
            }
        } catch (e) { log('_syncTrash: new_for_uri() failed', e); }

        if (!gicon) {
             const iconName = 'user-trash-symbolic';
             gicon = new Gio.ThemedIcon({ name: iconName });
        }

        const icon = new St.Icon({ gicon: gicon, icon_size: size, style_class: 'system-status-icon' });
        this._applyEffects(icon);
        
        const btn = new AppPanelButton(
            icon, this._trashName,
            () => {
                const wins = btn._windows || [];
                if (wins.length > 0) {
                    const focusWin = global.display.focus_window;
                    const isFocused = wins.some(w => w === focusWin);
                    
                    if (isFocused) {
                        wins.forEach(w => w.minimize());
                    } else {
                        wins[0].activate(global.get_current_time());
                    }
                } else {
                    Gio.AppInfo.launch_default_for_uri('trash:///', null);
                }
            },
            (menu) => {
                menu.removeAll();
                const wins = btn._windows || [];
                if (wins.length > 0) {
                    this._appendAction(menu, 'Quit', () => wins.forEach(w => w.delete(global.get_current_time())));
                } else {
                    this._appendAction(menu, 'Open', () => Gio.AppInfo.launch_default_for_uri('trash:///', null));
                }

                let hasTrash = false;
                try {
                    const file = Gio.File.new_for_uri('trash:///');
                    const enumerator = file.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
                    if (enumerator.next_file(null) !== null) {
                        hasTrash = true;
                    }
                    enumerator.close(null);
                } catch (e) { log('_syncTrash: new_for_uri() failed', e); }

                if (hasTrash) {
                    this._appendSeparator(menu);
                    this._appendAction(menu, 'Empty Trash', () => this._confirmEmptyTrash(), true);
                }
            }
        );
        
        btn.add_style_class_name('panel-button');
        btn.add_style_class_name('trash');

        const role = 'hornbill-trash';
        btn._role = role;
        this._tooltips?.attach(btn, this._trashName);
        Main.panel.addToStatusArea(role, btn, idx, pos);
        this._items.trash = btn;
    }

    _syncDisks() {
        this._clearGroup('disks');
        if (!this.getSettings().get_boolean('apps-disks-enabled')) return;

        const mounts = this._volumeMonitor.get_mounts();
        const pos = this._getPos('disks');
        const idx = this._getIndex('disks');
        const size = this.getSettings().get_int('apps-icon-size');
        const seenNames = new Set();

        mounts.forEach((mount, i) => {
            const name = mount.get_name();
            if (seenNames.has(name)) return;
            seenNames.add(name);

            const icon = new St.Icon({ gicon: mount.get_icon(), icon_size: size, style_class: 'system-status-icon' });
            this._applyEffects(icon);

            const btn = new AppPanelButton(
                icon, name,
                () => {
                    const wins = btn._windows || [];
                    if (wins.length > 0) {
                        const focusWin = global.display.focus_window;
                        const isFocused = wins.some(w => w === focusWin);
                        
                        if (isFocused) {
                            wins.forEach(w => w.minimize());
                        } else {
                            wins[0].activate(global.get_current_time());
                        }
                    } else {
                        const f = mount.get_root();
                        Gio.AppInfo.launch_default_for_uri(f.get_uri(), null);
                    }
                },
                (menu) => {
                    menu.removeAll();
                    const wins = btn._windows || [];
                    if (wins.length > 0) {
                        this._appendAction(menu, 'Close', () => wins.forEach(w => w.delete(global.get_current_time())));
                    } else {
                        this._appendAction(menu, 'Open', () => {
                            const f = mount.get_root();
                            Gio.AppInfo.launch_default_for_uri(f.get_uri(), null);
                        });
                    }
                    this._appendSeparator(menu);
                    const actionName = mount.can_eject() ? 'Eject' : 'Unmount';
                    this._appendAction(menu, actionName, () => this._safelyRemove(mount));
                }
            );
            
            btn.add_style_class_name('panel-button');
            btn.add_style_class_name('disk');

            const role = `hornbill-disk-${i}`;
            btn._role = role;
            btn._matchName = name;
            this._tooltips?.attach(btn, name);
            Main.panel.addToStatusArea(role, btn, idx + i, pos);
            this._items.disks.push(btn);
        });
    }

    _syncShowGrid() {
        // Cleanup old
        if (this._items.showgrid) {
            if (this._items.showgrid._role) delete Main.panel.statusArea[this._items.showgrid._role];
            this._items.showgrid.destroy();
            this._items.showgrid = null;
        }

        if (!this.getSettings().get_boolean('apps-showgrid-enabled')) return;

        const pos = this._getPos('showgrid');
        const idx = this._getIndex('showgrid');
        const size = this.getSettings().get_int('apps-icon-size');
        
        // Mode: 0=icon, 1=file, 2=text
        const mode = this.getSettings().get_enum('apps-showgrid-mode'); 
        
        let actor = null;

        if (mode === 2) {
            // Text Mode
            const text = this.getSettings().get_string('apps-showgrid-text') || 'Apps';
            actor = new St.Label({
                 text: text,
                 y_align: Clutter.ActorAlign.CENTER,
                 style_class: 'panel-button-text' // Uses GNOME's default or our own
            });
        } else {
            // Icon or File Mode
            let gicon = null;
            if (mode === 1) {
                // File Path
                const path = this.getSettings().get_string('apps-showgrid-path');
                if (path) {
                    try {
                         gicon = Gio.FileIcon.new(Gio.File.new_for_path(path));
                    } catch(e) {
                         console.warn('Hornbill: Failed to load icon file', e);
                    }
                }
            } else {
                // Icon Name
                const iconName = this.getSettings().get_string('apps-showgrid-icon') || 'start-here-symbolic';
                gicon = new Gio.ThemedIcon({ name: iconName });
            }

            // Fallback
            if (!gicon) {
                 gicon = new Gio.ThemedIcon({ name: 'start-here-symbolic' });
            }

            actor = new St.Icon({ gicon: gicon, icon_size: size, style_class: 'system-status-icon' });
            this._applyEffects(actor);
        }

        const btn = new AppPanelButton(
            actor, _('Applications'),
            () => {
                if (Main.overview.visible && Main.overview.dash.showAppsButton.checked) {
                    Main.overview.hide();
                } else {
                    Main.overview.show();
                    // Force switch to app grid
                    Main.overview.dash.showAppsButton.checked = true;
                }
            },
            (menu) => {
                menu.removeAll();
                this._appendAction(menu, 'Toggle Grid', () => Main.overview.dash.showAppsButton.clicked());
            }
        );
        btn._managesOverview = true;

        btn.add_style_class_name('panel-button');
        btn.add_style_class_name('show-apps');

        const role = 'hornbill-showgrid';
        btn._role = role;
        this._tooltips?.attach(btn, _('Applications'));
        Main.panel.addToStatusArea(role, btn, idx, pos);
        this._items.showgrid = btn;
    }

    _syncOverview() {
        if (this._items.overview) {
            if (this._items.overview._role) delete Main.panel.statusArea[this._items.overview._role];
            this._items.overview.destroy();
            this._items.overview = null;
        }

        // Hide Default Activities if requested.
        //
        // CRITICAL (GNOME 50): container.hide() alone leaves the
        // ActivitiesButton reactive and in the panel's input region, so it
        // floats invisibly over the app buttons and swallows every click
        // (diagnosed: all releases targeted ActivitiesButton, never the
        // buttons). Disable reactivity and input on hide; restore on show.
        const hideDefault = this.getSettings().get_boolean('apps-overview-hide-default');
        const act = Main.panel.statusArea.activities;
        if (act) {
            const cont = act.container;
            if (hideDefault) {
                cont.hide();
                cont.reactive = false;
                cont.can_focus = false;
                act.reactive = false;
                act.can_focus = false;
                act.track_hover = false;
                if (act.remove_style_pseudo_class) act.remove_style_pseudo_class('active');
            } else {
                cont.show();
                cont.reactive = true;
                act.reactive = true;
                act.can_focus = true;
                act.track_hover = true;
            }
        }

        if (!this.getSettings().get_boolean('apps-overview-enabled')) return;

        const pos = this._getPos('overview');
        const idx = this._getIndex('overview');
        const size = this.getSettings().get_int('apps-icon-size');

        // Use 'activities' icon logic or just a specific symbolic
        const gicon = new Gio.ThemedIcon({ name: 'view-paged-symbolic' }); // Good metaphor for overview
        const icon = new St.Icon({ gicon: gicon, icon_size: size, style_class: 'system-status-icon' });
        this._applyEffects(icon);

        const btn = new AppPanelButton(
            icon, _('Overview'),
            () => {
                 // Toggle overview, but ensure it isn't in grid mode when showing
                 if (Main.overview.visible && !Main.overview.dash.showAppsButton.checked) {
                     Main.overview.hide();
                 } else {
                     Main.overview.show();
                     Main.overview.dash.showAppsButton.checked = false; // Switch to window picker
                 }
            },
            (menu) => {
                menu.removeAll();
                if (global.workspace_manager) {
                    const n = global.workspace_manager.get_n_workspaces();
                    for(let i=0; i<n; i++) {
                        this._appendAction(menu, `Switch to Workspace ${i+1}`, () => {
                             global.workspace_manager.get_workspace_by_index(i).activate(global.get_current_time());
                        });
                    }
                }
            }
        );
        btn._managesOverview = true;

        btn.add_style_class_name('panel-button');
        btn.add_style_class_name('workspace');

        const role = 'hornbill-overview';
        btn._role = role;
        this._tooltips?.attach(btn, _('Overview'));
        Main.panel.addToStatusArea(role, btn, idx, pos);
        this._items.overview = btn;
    }

    _syncFavorites() {
        this._clearGroup('favorites');
        if (!this.getSettings().get_boolean('apps-favorites-enabled')) return;

        const favorites = (new Gio.Settings({ schema_id: 'org.gnome.shell' })).get_strv('favorite-apps');
        const pos = this._getPos('favorites');
        const idx = this._getIndex('favorites');
        const size = this.getSettings().get_int('apps-icon-size');

        favorites.forEach((appId, i) => {
            const app = this._appSystem.lookup_app(appId);
            if (!app) return;

            const icon = app.create_icon_texture(size);
            this._applyEffects(icon);

            const btn = new AppPanelButton(
                icon, app.get_name(),
                () => this._handleAppClick(app),
                (menu) => this._buildContextAwareAppMenu(menu, app, appId, true)
            );
            
            btn.enableDragging(() => this._handleDragFinish());
            
            btn.add_style_class_name('panel-button');
            btn.add_style_class_name('app'); // Generic app class

            btn._app = app;
            const role = `hornbill-fav-${i}`;
            btn._role = role;
            this._tooltips?.attach(btn, app.get_name());
            Main.panel.addToStatusArea(role, btn, idx + i, pos);
            this._items.favorites.push(btn);
        });
    }

    _syncRunning(forceRebuild = false) {
        if (!this.getSettings().get_boolean('apps-running-enabled')) {
            this._clearGroup('running');
            return;
        }

        const running = this._appSystem.get_running();
        const pos = this._getPos('running');
        const idx = this._getIndexAfterGroup('running', 'favorites');
        const size = this.getSettings().get_int('apps-icon-size');

        const favEnabled = this.getSettings().get_boolean('apps-favorites-enabled');
        let favIds = [];
        if (favEnabled) {
            const shellSettings = new Gio.Settings({ schema_id: 'org.gnome.shell' });
            favIds = shellSettings.get_strv('favorite-apps');
        }

        const appsToShow = running.filter(app => {
            if (favEnabled && favIds.includes(app.get_id())) return false;
            
            const windows = app.get_windows();
            const hasUnclaimed = windows.some(w => !this._handledWindows.has(w));
            
            if (!hasUnclaimed && windows.length > 0) return false;
            if (windows.length === 0) return false;
            return true;
        });

        if (!forceRebuild) {
            const currentIds = this._items.running.map(btn => btn._app ? btn._app.get_id() : '');
            const newIds = appsToShow.map(app => app.get_id());
            const isSame = currentIds.length === newIds.length && currentIds.every((id, index) => id === newIds[index]);
            if (isSame) return; 
        }

        this._clearGroup('running');

        appsToShow.forEach((app, i) => {
            const icon = app.create_icon_texture(size);
            this._applyEffects(icon);

            const btn = new AppPanelButton(
                icon, app.get_name(),
                () => this._handleAppClick(app),
                (menu) => this._buildContextAwareAppMenu(menu, app, app.get_id(), false)
            );

            btn.add_style_class_name('panel-button');
            btn.add_style_class_name('app');

            btn._app = app;
            const role = `hornbill-run-${i}`;
            btn._role = role;
            this._tooltips?.attach(btn, app.get_name());
            Main.panel.addToStatusArea(role, btn, idx + i, pos);
            this._items.running.push(btn);
        });
    }

    _handleAppClick(app) {
        // Overview/search is closed centrally in _activate() before any
        // click callback runs, so no need to repeat that here.
        // Same separation as the visuals: clicking Files must not raise or
        // minimize the Trash and Drive windows that have their own buttons.
        // The filter is unconditional — falling back to the full list when
        // nothing is unclaimed is what made Files toggle the Trash window.
        let windows = app.get_windows();
        if (this._isFileManager(app))
            windows = windows.filter(w => !this._claimedWindows.has(w));

        const ts = global.get_current_time();
        if (windows.length === 0) {
            if (app.get_n_windows() > 0) {
                // Running, but every window belongs to another button (only
                // Trash is open). activate_full() would raise that window;
                // the user asked for Files, so give them a Files window.
                app.open_new_window(-1);
            } else {
                // activate_full registers the launch with the shell's startup
                // notification, so the busy cursor is tracked and cleared when
                // the window maps — like the dock does. open_new_window bypasses
                // that, leaving the cursor spinning until it times out.
                app.activate_full(-1, ts);
            }
        } else {
            const focusWin = global.display.focus_window;
            if (windows.some(w => w === focusWin)) {
                windows.forEach(w => w.minimize());
            } else {
                // activate() the specific window rather than the app: for a
                // file manager, activate_full() could raise a Trash window
                // that belongs to another button.
                windows[0].activate(ts);
            }
        }
    }

    /**
     * MINIMIZE AND RESTORE DIRECTION.
     *
     * Mutter animates those toward the window's "icon geometry" — the
     * on-screen rect standing in for the window. Unset, it falls back to a
     * fixed spot, which is why a Trash window on a RIGHT-hand button still
     * flew off to the left. Pointing each window at the button that
     * represents it makes the animation aim at what the user actually
     * clicked, whichever side the button sits on.
     *
     * Cheap enough to redo on every visual update: it is a couple of
     * property reads and a setter per window, and the alternative is tracking
     * every way a button can move (panel position, layout order, monitor
     * changes, buttons added or removed).
     */
    _syncIconGeometry() {
        const assign = (btn, windows) => {
            if (!btn || !windows || windows.length === 0) return;
            try {
                if (!btn.get_parent()) return;
                const [x, y] = btn.get_transformed_position();
                const [w, h] = btn.get_transformed_size();
                if (!(w > 0 && h > 0)) return;
                windows.forEach(win => setIconGeometry(win, x, y, w, h));
            } catch (e) { log('_syncIconGeometry failed', e); }
        };

        const ownWindows = (app) => {
            try {
                const wins = app.get_windows();
                return this._isFileManager(app)
                    ? wins.filter(win => !this._claimedWindows.has(win))
                    : wins;
            } catch (e) { return []; }
        };

        this._items.favorites.forEach(btn => btn._app && assign(btn, ownWindows(btn._app)));
        this._items.running.forEach(btn => btn._app && assign(btn, ownWindows(btn._app)));

        // Trash and Drive own specific windows rather than a whole app.
        if (this._items.trash) assign(this._items.trash, this._items.trash._windows);
        this._items.disks.forEach(btn => assign(btn, btn._windows));
    }

    _getPos(keySuffix) {
        const key = `apps-${keySuffix}-pos`;
        const value = this.getSettings().get_value(key);
        if (value.is_of_type(new GLib.VariantType('s'))) {
            return value.deep_unpack() === 'right' ? 'right' : 'left'; 
        }
        if (value.is_of_type(new GLib.VariantType('i'))) {
            return value.deep_unpack() === 1 ? 'right' : 'left';
        }
        return 'left';
    }
    
    _getIndex(keySuffix) {
        return this.getSettings().get_int(`apps-${keySuffix}-index`);
    }

    /**
     * Index adjusted for a multi-button group placed before this item on the
     * same side. Static indexes alone interleave items into the group (e.g.
     * Trash landing between two disks, Running inside Favorites) because a
     * group occupies `count` slots, not one.
     */
    _getIndexAfterGroup(keySuffix, groupSuffix) {
        let idx = this._getIndex(keySuffix);
        if (this.getSettings().get_boolean(`apps-${groupSuffix}-enabled`) &&
            this._getPos(groupSuffix) === this._getPos(keySuffix) &&
            this._getIndex(groupSuffix) <= idx) {
            const group = this._items[groupSuffix];
            idx += Math.max(0, (group?.length || 0) - 1);
        }
        return idx;
    }
}
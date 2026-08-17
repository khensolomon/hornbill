import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { AppConfig } from '../config.js';
import { logError } from '../util/logger.js';

/**
 * Base class for all extension components.
 * Handles Settings initialization and Signal cleanup automatically.
 */
export class ExtensionComponent {
    constructor(extension) {
        this._extension = extension;
        this._settings = null;
        this._signals = [];
        this._sources = new Set();
        this._isEnabled = false;
    }

    /**
     * Helper to safely get settings
     */
    getSettings() {
        if (!this._settings) {
            try {
                this._settings = this._extension.getSettings(AppConfig.schemaId);
            } catch {
                this._settings = this._extension.getSettings();
            }
        }
        return this._settings;
    }

    /**
     * Helper to connect settings signal with auto-cleanup
     * @param {string} signal - e.g., 'changed::key-name'
     * @param {Function} callback 
     */
    observe(signal, callback) {
        const settings = this.getSettings();
        const id = settings.connect(signal, callback);
        this._signals.push({ obj: settings, id: id });
    }

    /**
     * Run `fn` once on the next idle, tracking the source so a pending
     * callback cannot outlive disable(). The id is untracked as soon as the
     * callback runs, and the guard skips work if the component was disabled
     * between scheduling and dispatch.
     * @param {Function} fn
     * @param {number} [priority]
     * @returns {number} GLib source id
     */
    idleOnce(fn, priority = GLib.PRIORITY_DEFAULT_IDLE) {
        let id = 0;
        id = GLib.idle_add(priority, () => {
            this._sources.delete(id);
            if (this._isEnabled) fn();
            return GLib.SOURCE_REMOVE;
        });
        this._sources.add(id);
        return id;
    }

    /**
     * Run `fn` once after `ms`, with the same tracking and guard as idleOnce().
     * @param {number} ms
     * @param {Function} fn
     * @param {number} [priority]
     * @returns {number} GLib source id
     */
    timeoutOnce(ms, fn, priority = GLib.PRIORITY_DEFAULT) {
        let id = 0;
        id = GLib.timeout_add(priority, ms, () => {
            this._sources.delete(id);
            if (this._isEnabled) fn();
            return GLib.SOURCE_REMOVE;
        });
        this._sources.add(id);
        return id;
    }

    /**
     * Lifecycle: Called when extension is enabled
     */
    enable() {
        this._isEnabled = true;
        this.onEnable();
    }

    /**
     * Lifecycle: Called when extension is disabled
     */
    disable() {
        this._isEnabled = false;
        this.onDisable();
        this._cleanup();
    }

    /**
     * Override this for setup logic
     */
    onEnable() {}

    /**
     * Override this for teardown logic
     */
    onDisable() {}

    /**
     * Internal cleanup (signals, etc)
     */
    _cleanup() {
        // FIX: one disposed object mid-loop used to abort the whole cleanup,
        // leaving every remaining signal connected (leaks + ghost callbacks).
        this._signals.forEach(sig => {
            try {
                sig.obj.disconnect(sig.id);
            } catch (e) {
                logError('Failed to disconnect signal during cleanup', e);
            }
        });
        this._signals = [];

        // Pending one-shot sources must go too, or a queued callback fires
        // after disable() and touches actors that are already destroyed.
        this._sources.forEach(id => {
            try {
                GLib.source_remove(id);
            } catch (e) {
                logError('Failed to remove pending source during cleanup', e);
            }
        });
        this._sources.clear();

        this._settings = null;
    }
}
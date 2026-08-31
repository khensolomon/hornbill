import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import GLib from "gi://GLib";
import { log, logError } from "./app/util/logger.js";
import { AppConfig } from "./app/config.js";
import { getComponents } from "./app/components/index.js";

export default class HornbillExtension extends Extension {
  _instances = [];

  enable() {
    AppConfig.init(this.metadata, this.path, true);
    log("System started.");

    this._trackPrefsWindow();

    this._instances = [];
    for (const ComponentClass of getComponents()) {
      try {
        const instance = new ComponentClass(this);
        this._instances.push(instance); // track first, so disable() can always clean up
        instance.enable?.();
      } catch (e) {
        logError(`Failed to enable ${ComponentClass.name}`, e);
      }
    }
  }

  disable() {
    log("System stopping.");
    if (this._winCreatedId) {
      // Clear it immediately
      global.display.disconnect(this._winCreatedId);
      this._winCreatedId = null;
    }
    if (this._adoptTimers) {
      for (const id of this._adoptTimers) GLib.source_remove(id);
      this._adoptTimers.clear();
    }
    this._prefsWindow = null;

    [...this._instances].reverse().forEach((instance) => {
      try {
        instance?.disable?.();
      } catch (e) {
        logError("Error disabling component", e);
      }
    });
    this._instances = [];
  }

  // Find this extension's own preferences window
  /**
   * Hold a live reference to the preferences window.
   *
   * Scanning list_all_windows() on demand proved unreliable: at the moment a
   * scan runs the window may not be there yet, and a stale "Extension Error"
   * dialog can be the only match. Instead, catch the window when the
   * compositor creates it and keep the reference until it is unmanaged.
   * wm_class is often not set at creation time, so re-check shortly after.
   */
  _trackPrefsWindow() {
    this._prefsWindow = null;
    this._adoptTimers = new Set();

    const isPrefsWindow = (win) => {
      try {
        const cls = win.get_wm_class ? win.get_wm_class() : null;
        const gtkId = win.get_gtk_application_id
          ? win.get_gtk_application_id()
          : null;
        return (
          cls === "org.gnome.Shell.Extensions" ||
          gtkId === "org.gnome.Shell.Extensions"
        );
      } catch (e) {
        return false;
      }
    };

    const adopt = (win) => {
      if (!win || this._prefsWindow === win) return false;
      if (!isPrefsWindow(win)) return false;
      this._prefsWindow = win;
      log(
        `Preferences window tracked: '${win.get_title ? win.get_title() : "?"}'`,
      );
      const id = win.connect("unmanaged", () => {
        if (this._prefsWindow === win) this._prefsWindow = null;
        win.disconnect(id);
      });
      return true;
    };

    // Adopt anything already open (e.g. after the extension is re-enabled).
    for (const w of global?.display?.list_all_windows()) {
      if (adopt(w)) break;
    }

    this._winCreatedId = global.display.connect("window-created", (_d, win) => {
      // wm_class frequently arrives after creation; try now, then again.
      if (adopt(win)) return;
      let tries = 0;
      let sourceId = 0;
      sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
        tries++;
        if (adopt(win) || tries > 12) {
          this._adoptTimers.delete(sourceId);
          return GLib.SOURCE_REMOVE;
        }
        return GLib.SOURCE_CONTINUE;
      });
      this._adoptTimers.add(sourceId);
    });
  }

  _getPreferencesWindow() {
    const w = this._prefsWindow;
    if (!w) return null;
    return global?.display?.list_all_windows()?.includes(w) ? w : null;
  }

  get isPreferencesOpen() {
    return !!this._getPreferencesWindow();
  }

  closePreferences() {
    const win = this._getPreferencesWindow();
    if (win) {
      win.delete(global.get_current_time());
    }
  }

  openPreferences(page) {
    // Save the requested page so the prefs window reads it on load.
    if (page) {
      const schema = AppConfig.schemaId || this.metadata["settings-schema"];
      if (schema) {
        const s = this.getSettings(schema);
        if (s) s.set_string("open-page", page);
      }
    }

    // If a preferences window is already open, raise it. activate() alone
    // does not lift a window from behind another on Wayland, so unminimize,
    // pull it to the current workspace, and go through Main.activateWindow —
    // the same call the shell uses when switching to an application.
    const win = this._getPreferencesWindow();
    if (win) {
      const now = global.get_current_time();
      try {
        if (win.minimized) win.unminimize();
        const ws = global.workspace_manager.get_active_workspace();
        if (ws && win.change_workspace) win.change_workspace(ws);
        Main.activateWindow(win, now);
        log("Raised existing preferences window.");
        return;
      } catch (e) {
        logError("Failed to raise preferences window", e);
      }
    }

    // Otherwise open it. GNOME's built-in also focuses an existing window if
    // one is open, so this is a safe fallback.
    const result = super.openPreferences();
    if (result && typeof result.then === "function") {
      result.catch((err) => logError("openPreferences() rejected", err));
    }
  }
}

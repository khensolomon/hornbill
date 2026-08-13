import St from "gi://St";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Clutter from "gi://Clutter";
import GObject from "gi://GObject";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";

import { AppConfig } from "../config.js";

/**
 * PanelMenu.Button toggles its own menu on EVERY primary press, from its
 * built-in vfunc_event, before any handler we connect can run. That is why
 * left-click showed the menu instead of opening preferences. Blocking the
 * base class's button handling lets our own press handler decide what each
 * button does. Everything that is not a button event still chains to the
 * base implementation.
 */
const LesionIndicatorButton = GObject.registerClass(
    { GTypeName: 'LesionIndicatorButton' },
    class LesionIndicatorButton extends PanelMenu.Button {
        vfunc_event(event) {
            const type = event.type();
            if (type === Clutter.EventType.BUTTON_PRESS ||
                type === Clutter.EventType.BUTTON_RELEASE ||
                type === Clutter.EventType.TOUCH_BEGIN ||
                type === Clutter.EventType.TOUCH_END)
                return Clutter.EVENT_PROPAGATE;
            return super.vfunc_event(event);
        }
    }
);
import { log, logError } from '../util/logger.js';

export class Indicator {
  constructor(ext) {
    this.extension = ext;
    this.button = null;
    this._settings = null;
    this._settingsSignals = [];
    this._menuSignals = [];
  }

  enable() {
    // 1. Initialize Settings
    try {
        try {
            this._settings = this.extension.getSettings(AppConfig.schemaId);
        } catch {
            this._settings = this.extension.getSettings();
        }

        this._settingsSignals.push(
            this._settings.connect('changed::indicator-enabled', () => this._sync()),
            this._settings.connect('changed::indicator-custom-icon', () => this._updateIcon())
        );
    } catch(e) {
        logError("Failed to init indicator settings", e);
    }

    // 2. Initial Sync
    this._sync();
  }

  disable() {
    this._destroyButton();

    if (this._settings) {
        this._settingsSignals.forEach(id => this._settings.disconnect(id));
        this._settingsSignals = [];
        this._settings = null;
    }
  }

  _sync() {
      // Check if enabled
      const enabled = this._settings ? this._settings.get_boolean('indicator-enabled') : true;

      if (!enabled) {
          this._destroyButton();
          return;
      }

      if (!this.button) {
          this._createButton();
      }
  }

  _createButton() {
    const nameId = AppConfig.name || "Lesion Extension";
    this.button = new LesionIndicatorButton(0.5, nameId);

    // PanelMenu.Button attaches a Clutter_ClickGesture (confirmed by
    // inspection on GNOME 50) that toggles its menu on any click. Gestures
    // claim the pointer sequence and run ahead of the actor's own event
    // handling, so while one is attached NO handler — connected signal or
    // overridden vfunc — ever sees a button event. Removing it returns
    // click handling to us.
    try { this.button.clear_actions(); } catch (e) {}

    try {
        const clickAction = new Clutter.ClickAction();
        clickAction.connect('clicked', (action) => {
            let btn = Clutter.BUTTON_PRIMARY;
            try { btn = action.get_button() || Clutter.BUTTON_PRIMARY; } catch (e) {}
            if (btn === Clutter.BUTTON_SECONDARY) {
                this.button.menu.toggle();
            } else {
                if (this.button.menu.isOpen) this.button.menu.close();
                this.extension.openPreferences();
            }
        });
        this.button.add_action(clickAction);
    } catch (e) {
        logError('Indicator click action unavailable', e);
    }
    // Note: St widgets have no 'tooltip_text' (that's GTK); setting it here
    // was a silent no-op, so it has been removed.

    // Create Icon Bin
    this._iconBin = new St.Bin();
    this.button.add_child(this._iconBin);
    
    // Set Initial Icon
    this._updateIcon();

    // 1. Custom Click Handling.
    //
    // PanelMenu.Button toggles its own menu on every primary press via an
    // internal handler. Listening on 'event' ran AFTER that, so left-click
    // opened preferences and also popped the menu. 'button-press-event'
    // fires early enough to fully own the interaction; we stop propagation
    // so the built-in toggle never runs.
    this.button.connect('button-press-event', (actor, event) => {
        const button = event.get_button();

        if (button === Clutter.BUTTON_PRIMARY) {
            // Ensure any open menu is closed, then open preferences
            if (this.button.menu.isOpen) this.button.menu.close();
            this.extension.openPreferences();
            return Clutter.EVENT_STOP;
        }

        if (button === Clutter.BUTTON_SECONDARY) {
            this.button.menu.toggle();
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    });

    // Also neutralize the default primary-button menu behavior in case a
    // touch/keyboard path still reaches it.
    this.button.connect('key-press-event', () => Clutter.EVENT_PROPAGATE);

    // 2. Dynamic Menu Handling
    this._menuSignals.push(
        this.button.menu.connect('open-state-changed', (menu, open) => {
            if (open) {
                this._updateMenu();
            }
        })
    );

    // Initial build (populate static items if any, or just wait for open)
    this._updateMenu();

    const role = AppConfig.uuid || "lesion-indicator";
    // Default slot: right box, after Disks (0) and Trash (1) per the
    // default layout — Disks, Trash, Indicator, native items, clock, system menu.
    Main.panel.addToStatusArea(role, this.button, 2, 'right');
  }

  _destroyButton() {
      if (this.button) {
          this._menuSignals.forEach(id => this.button.menu.disconnect(id));
          this._menuSignals = [];
          
          this.button.destroy();
          this.button = null;
          this._iconBin = null;
      }
  }

  _updateIcon() {
      if (!this._iconBin) return;

      const customPath = this._settings ? this._settings.get_string('indicator-custom-icon') : '';
      let gicon = null;

      // Try custom icon
      if (customPath && customPath.length > 0) {
          try {
              const file = Gio.File.new_for_path(customPath);
              if (file.query_exists(null)) {
                  gicon = new Gio.FileIcon({ file: file });
              }
          } catch (e) {
              logError("Failed to load custom indicator icon", e);
          }
      }

      // Default Icon
      if (!gicon) {
          const iconPath = GLib.build_filenamev([this.extension.path, 'icon', 'hornbill-symbolic.svg']);
          gicon = Gio.icon_new_for_string(iconPath);
      }

      const icon = new St.Icon({
          gicon: gicon,
          style_class: "system-status-icon symbolic",
      });

      this._iconBin.set_child(icon);
  }

  _updateMenu() {
    if (!this.button) return;
    const menu = this.button.menu;
    
    // Clear existing items to rebuild based on state
    menu.removeAll();

    // Running-build stamp: makes a stale/failed install obvious at a glance.
    try {
        const vn = AppConfig.metadata?.['version-name'] ?? '?';
        const vi = AppConfig.metadata?.version ?? '?';
        const stamp = new PopupMenu.PopupMenuItem(`Lesion ${vn} (${vi})`, { reactive: false });
        stamp.add_style_class_name('popup-subtitle-menu-item');
        menu.addMenuItem(stamp);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    } catch (e) {}

    // Check if extension has a state flag for prefs window
    const isPrefsOpen = this.extension.isPreferencesOpen === true;

    // If NOT open, add "Open" at the top
    if (!isPrefsOpen) {
        const prefsItem = new PopupMenu.PopupMenuItem("Preferences");
        prefsItem.connect("activate", () => {
            try {
                this.extension.openPreferences();
            } catch (err) {
                logError("Failed to spawn preferences", err);
            }
        //   this.extension.openPreferences();
        });
        menu.addMenuItem(prefsItem);
    }

    // Add About
    const aboutItem = new PopupMenu.PopupMenuItem("About");
    aboutItem.connect("activate", () => {
      this.extension.openPreferences("about");
    });
    menu.addMenuItem(aboutItem);

    menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    const submenu = new PopupMenu.PopupSubMenuMenuItem("Options");
    // Example toggles
    if (this.extension.toggleFeature) {
        submenu.menu.addAction("Toggle Feature", () => this.extension.toggleFeature());
    }
    if (this.extension.openLogs) {
        submenu.menu.addAction("Open Logs", () => this.extension.openLogs());
    }
    menu.addMenuItem(submenu);

    menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    const quitItem = new PopupMenu.PopupMenuItem("Disable Extension");
    quitItem.connect("activate", () => {
      // FIX: calling this.extension.disable() directly desyncs GNOME Shell's
      // extension manager (the shell still believes the extension is enabled,
      // and re-enabling misbehaves). Go through the extension manager instead,
      // and defer it to idle: disabling destroys this very menu while its
      // 'activate' signal is still being emitted, which can crash the shell.
      const uuid = this.extension.uuid;
      GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        try {
          Main.extensionManager.disableExtension(uuid);
        } catch (e) {
          logError("Failed to disable extension", e);
        }
        return GLib.SOURCE_REMOVE;
      });
    });
    menu.addMenuItem(quitItem);

    // If open, add "Close" at the bottom
    if (isPrefsOpen) {
        const closeItem = new PopupMenu.PopupMenuItem("Close");
        closeItem.connect("activate", () => {
             // Assuming you implement closePreferences in your extension class
             if (typeof this.extension.closePreferences === 'function') {
                 this.extension.closePreferences();
             } else {
                 // Fallback if no close method exists: just toggle prefs
                 this.extension.openPreferences();
             }
        });
        menu.addMenuItem(closeItem);
    }
  }
}
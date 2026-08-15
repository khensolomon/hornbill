import St from "gi://St";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Clutter from "gi://Clutter";
import GObject from "gi://GObject";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import * as ModalDialog from "resource:///org/gnome/shell/ui/modalDialog.js";
import * as Dialog from "resource:///org/gnome/shell/ui/dialog.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";

import { AppConfig } from "../config.js";
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

    // A standard PanelMenu.Button. Its built-in menu is used for the
    // right-click menu; the primary button is overridden to open preferences.
    this.button = new PanelMenu.Button(0.5, nameId, false);

    // Create Icon Bin, wrapped in an St.Button.
    //
    // The app panel buttons are reliably clickable because their content
    // lives inside an St.Button, whose 'clicked' signal owns the whole click
    // protocol (press/release pairing and the pointer grab) — after
    // clear_actions() strips PanelMenu.Button's own gesture, which otherwise
    // opens the menu on every press. The indicator now uses the same shape.
    try { this.button.clear_actions(); } catch (e) { logError('clear_actions failed', e); }

    this._iconBin = new St.Bin();

    this._clickButton = new St.Button({
      child: this._iconBin,
      x_expand: true,
      y_expand: true,
      can_focus: true,
      reactive: true,
      track_hover: true,
      button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO | St.ButtonMask.THREE,
    });
    this.button.add_child(this._clickButton);
    this._updateIcon();

    this._clickButton.connect('clicked', (actor, clickedButton) => {
      // St.Button reports the button number as an int (1 primary, 3 secondary).
      if (clickedButton === Clutter.BUTTON_SECONDARY || clickedButton === 3) {
        this.button.menu.toggle();
      } else {
        if (this.button.menu.isOpen) this.button.menu.close();
        this.extension.openPreferences();
      }
    });

    // Rebuild the menu contents whenever it opens.
    this._menuSignals.push(
        this.button.menu.connect('open-state-changed', (menu, open) => {
            if (open) this._updateMenu();
        })
    );
    this._updateMenu();

    const role = AppConfig.uuid || "lesion-indicator";
    Main.panel.addToStatusArea(role, this.button, 2, 'right');

    // Highlight the indicator while the preferences window is open, like a
    // running application's icon. Uses the extension's tracked window
    // reference, so this is a cheap boolean check with no window scanning
    // and no logging.
    this._prefsWatchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
      try {
        const open = this.extension.isPreferencesOpen === true;
        if (this._clickButton) {
          if (open) this._clickButton.add_style_pseudo_class('active');
          else this._clickButton.remove_style_pseudo_class('active');
        }
      } catch (e) {}
      return GLib.SOURCE_CONTINUE;
    });
  }

  _destroyButton() {
      if (this._prefsWatchId) {
          try { GLib.source_remove(this._prefsWatchId); } catch (e) {}
          this._prefsWatchId = 0;
      }
      if (this.button) {
          this._menuSignals.forEach(id => this.button.menu.disconnect(id));
          this._menuSignals = [];
          
          this.button.destroy();
          this.button = null;
          this._iconBin = null;
          this._clickButton = null;
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

  /**
   * Confirmation before disabling. This code runs inside gnome-shell, not
   * the preferences process, so it uses the shell's ModalDialog rather than
   * a Gtk/Adw dialog.
   */
  _confirmDisable() {
    let dialog;
    try {
      dialog = new ModalDialog.ModalDialog({ destroyOnClose: true });
    } catch (e) {
      logError("Could not create confirmation dialog", e);
      this._doDisable();
      return;
    }

    const content = new Dialog.MessageDialogContent({
      title: "Disable Lesion?",
      description:
        "The panel customisations and window features provided by this " +
        "extension will stop. You can re-enable it from the Extensions app.",
    });
    dialog.contentLayout.add_child(content);

    dialog.setButtons([
      {
        label: "Cancel",
        action: () => dialog.close(global.get_current_time()),
        key: Clutter.KEY_Escape,
        default: true,
      },
      {
        label: "Disable",
        action: () => {
          dialog.close(global.get_current_time());
          this._doDisable();
        },
      },
    ]);

    // Mark the destructive action so it renders in the warning style.
    try {
      const buttons = dialog.buttonLayout.get_children();
      const disableBtn = buttons[buttons.length - 1];
      disableBtn.add_style_class_name('destructive-action');
    } catch (e) {}

    dialog.open(global.get_current_time());
  }

  _doDisable() {
    // Calling this.extension.disable() directly desyncs GNOME Shell's
    // extension manager (the shell still believes the extension is enabled,
    // and re-enabling misbehaves). Go through the extension manager instead,
    // and defer to idle: disabling destroys this very menu while its
    // 'activate' signal may still be emitting, which can crash the shell.
    const uuid = this.extension.uuid;
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      try {
        Main.extensionManager.disableExtension(uuid);
      } catch (e) {
        logError("Failed to disable extension", e);
      }
      return GLib.SOURCE_REMOVE;
    });
  }

  _updateMenu() {
    if (!this.button) return;
    const menu = this.button.menu;
    
    // Clear existing items to rebuild based on state
    menu.removeAll();

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

    const extensionsItem = new PopupMenu.PopupMenuItem("Extensions");
    extensionsItem.connect("activate", () => {
        try {
            this.extension.openPreferences("extensions");
        } catch (err) {
            logError("Failed to open extensions page", err);
        }
    });
    menu.addMenuItem(extensionsItem);

    menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    const quitItem = new PopupMenu.PopupMenuItem("Disable Extension");
    quitItem.connect("activate", () => {
      // Confirm first: disabling from here removes the panel and this menu,
      // which is easy to hit by accident and not obvious to undo.
      this._confirmDisable();
    });
    menu.addMenuItem(quitItem);

    // Build stamp, dimmed and non-interactive, at the very bottom: useful
    // when diagnosing "which build is actually running" without taking up
    // room at the top of the menu.
    try {
        const vn = AppConfig.metadata?.['version-name'] ?? '?';
        const vi = AppConfig.metadata?.version ?? '?';
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const stamp = new PopupMenu.PopupMenuItem(`Lesion ${vn} (${vi})`, {
            reactive: false,
            can_focus: false,
        });
        stamp.label.add_style_class_name('dim-label');
        menu.addMenuItem(stamp);
    } catch (e) {}

    // If open, add "Close" at the bottom
    if (isPrefsOpen) {
        const closeItem = new PopupMenu.PopupMenuItem("Close");
        closeItem.connect("activate", () => {
             // Use closePreferences when the extension class provides it
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
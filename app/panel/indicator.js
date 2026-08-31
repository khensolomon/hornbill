import St from "gi://St";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Clutter from "gi://Clutter";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import * as ModalDialog from "resource:///org/gnome/shell/ui/modalDialog.js";
import * as Dialog from "resource:///org/gnome/shell/ui/dialog.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";

import Shell from "gi://Shell";
import { AppConfig } from "../config.js";
import { logError, log } from "../util/logger.js";
import { gettext as _ } from '../util/gettext.js';
import { ShakeAnimator } from '../util/shake.js';
import { setIconGeometry } from '../util/compat.js';

/** The shell's extension-preferences tool; every prefs window belongs to it. */
const PREFS_APP_ID = 'org.gnome.Shell.Extensions.desktop';

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
      this._settings = this.extension.getSettings(AppConfig.schemaId);

      this._settingsSignals.push(
        this._settings.connect("changed::indicator-enabled", () =>
          this._sync(),
        ),
        this._settings.connect("changed::indicator-custom-icon", () =>
          this._updateIcon(),
        ),
      );
    } catch (e) {
      logError("Failed to init indicator settings", e);
    }

    // 2. Initial Sync
    this._sync();
  }

  disable() {
    this._destroyButton();

    if (this._settings) {
      this._settingsSignals.forEach((id) => this._settings.disconnect(id));
      this._settingsSignals = [];
      this._settings = null;
    }
  }

  _sync() {
    const enabled = this._settings
      ? this._settings.get_boolean("indicator-enabled")
      : true;

    if (!enabled) {
      this._destroyButton();
      return;
    }

    if (!this.button) {
      this._createButton();
    }
  }

  _createButton() {
    const nameId = AppConfig.name || "Hornbill Extension";

    this.button = new PanelMenu.Button(0.5, nameId, false);
    this.button.clear_actions();

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

    this._clickButton.connect("clicked", (actor, clickedButton) => {
      if (clickedButton === Clutter.BUTTON_SECONDARY || clickedButton === 3) {
        this.button.menu.toggle();
      } else {
        if (this.button.menu.isOpen) this.button.menu.close();
        this._activatePrefs();
      }
    });

    this._menuSignals.push(
      this.button.menu.connect("open-state-changed", (menu, open) => {
        if (open) this._updateMenu();
      }),
    );
    this._updateMenu();

    const role = AppConfig.uuid || "hornbill-indicator";
    Main.panel.addToStatusArea(role, this.button, 2, "right");

    // State is driven by signals rather than the previous 800ms poll, which
    // could only ever report open/closed and lagged up to 800ms behind.
    this._shaker = new ShakeAnimator();

    this._displaySignals = [
      global.display.connect('notify::focus-window', () => this._updateState()),
      global.display.connect('window-created', () => this._updateState()),
    ];

    const appSystem = Shell.AppSystem.get_default();
    this._appSystemSignal = appSystem.connect('app-state-changed', () => this._updateState());

    this._updateState();
  }

  /**
   * The prefs window for THIS extension, or null.
   *
   * All extension preferences share one application, so when several are open
   * the app id alone is ambiguous. The window title is the extension's own
   * name, which is ours to match on — unlike a document or page title, it
   * carries nothing about what the user is doing.
   */
  _prefsWindow() {
    if (this.extension.isPreferencesOpen !== true) return null;

    let windows = [];
    try {
      const app = Shell.AppSystem.get_default().lookup_app(PREFS_APP_ID);
      windows = app ? app.get_windows() : [];
    } catch (e) {
      log('[Indicator] prefs app lookup failed', e);
      return null;
    }

    if (windows.length === 0) return null;
    if (windows.length === 1) return windows[0];

    const name = (AppConfig.name || '').trim().toLowerCase();
    if (name) {
      const match = windows.find(w => {
        try { return (w.get_title() || '').trim().toLowerCase() === name; }
        catch (e) { return false; }
      });
      if (match) return match;
    }
    return windows[0];
  }

  /**
   * Open / focused / unfocused, matching how the app buttons read: a dim
   * "running" state when the window exists, a full highlight when it is the
   * focused one.
   */
  _updateState() {
    if (!this._clickButton) return;

    const win = this._prefsWindow();
    const focused = !!win && global.display.focus_window === win;

    if (focused) this._clickButton.add_style_pseudo_class('active');
    else this._clickButton.remove_style_pseudo_class('active');

    this._clickButton.opacity = win ? 255 : 160;

    // Minimize and restore animate toward this rect; without it the prefs
    // window flies to a fixed corner instead of to the button that owns it.
    if (win) this._syncIconGeometry(win);
  }

  _syncIconGeometry(win) {
    if (!this.button) return;
    try {
      const [x, y] = this.button.get_transformed_position();
      const [w, h] = this.button.get_transformed_size();
      if (w > 0 && h > 0) setIconGeometry(win, x, y, w, h);
    } catch (e) { log('[Indicator] icon geometry failed', e); }
  }

  /**
   * Clicking the button while its window is already focused used to do
   * nothing at all — openPreferences() on an open, focused window is a no-op.
   * A short wobble answers "where is it?" on a wide desktop without changing
   * any existing behaviour, because there was none to change.
   */
  _activatePrefs() {
    const win = this._prefsWindow();

    if (win && global.display.focus_window === win) {
      this._shaker?.shake(win, 6);
      return;
    }

    if (win) {
      // Open but behind something, or on another workspace.
      win.activate(global.get_current_time());
      return;
    }

    this.extension.openPreferences();
  }

  _destroyButton() {
    if (this._displaySignals) {
      this._displaySignals.forEach((id) => {
        try { global.display.disconnect(id); } catch (e) { log('[Indicator] disconnect failed', e); }
      });
      this._displaySignals = null;
    }
    if (this._appSystemSignal) {
      try { Shell.AppSystem.get_default().disconnect(this._appSystemSignal); }
      catch (e) { log('[Indicator] disconnect failed', e); }
      this._appSystemSignal = 0;
    }
    if (this._shaker) {
      this._shaker.destroy();
      this._shaker = null;
    }
    if (this.button) {
      this._menuSignals.forEach((id) => this.button.menu.disconnect(id));
      this._menuSignals = [];

      this.button.destroy();
      this.button = null;
      this._iconBin = null;
      this._clickButton = null;
    }
  }

  _updateIcon() {
    if (!this._iconBin) return;

    const customPath = this._settings
      ? this._settings.get_string("indicator-custom-icon")
      : "";
    let gicon = null;

    // User-supplied path — keep try/catch (invalid path, permissions, etc.)
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

    if (!gicon) {
      const iconPath = GLib.build_filenamev([
        this.extension.path,
        "icon",
        "hornbill-symbolic.svg",
      ]);
      gicon = Gio.icon_new_for_string(iconPath);
    }

    const icon = new St.Icon({
      gicon: gicon,
      style_class: "system-status-icon symbolic",
    });

    this._iconBin.set_child(icon);
  }

  /**
   * Confirmation before disabling. Runs inside gnome-shell, so uses ModalDialog.
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
      title: _("Disable Hornbill?"),
      description:
        "The panel customisations and window features provided by this " +
        "extension will stop. You can re-enable it from the Extensions app.",
    });
    dialog.contentLayout.add_child(content);

    dialog.setButtons([
      {
        label: _("Cancel"),
        action: () => dialog.close(global.get_current_time()),
        key: Clutter.KEY_Escape,
        default: true,
      },
      {
        label: _("Disable"),
        action: () => {
          dialog.close(global.get_current_time());
          this._doDisable();
        },
      },
    ]);

    // Cosmetic: mark destructive button. Guard without try — only style if present.
    const buttons = dialog.buttonLayout?.get_children?.() ?? [];
    if (buttons.length > 0) {
      buttons[buttons.length - 1].add_style_class_name("destructive-action");
    }

    dialog.open(global.get_current_time());
  }

  _doDisable() {
    // Defer to idle so we don't destroy the menu while its activate signal is live.
    //
    // This source is deliberately not tracked for removal in disable(): it is
    // what *causes* the disable, so cancelling it during teardown would undo
    // the user's action. It is one-shot, holds no reference to any actor, and
    // resolves through the extension manager rather than this indicator.
    const uuid = this.extension.uuid;
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      Main.extensionManager.disableExtension(uuid);
      return GLib.SOURCE_REMOVE;
    });
  }

  _updateMenu() {
    if (!this.button) return;
    const menu = this.button.menu;

    menu.removeAll();

    const isPrefsOpen = this.extension.isPreferencesOpen === true;

    // Order: Preferences, Extensions, Disable, About, Close.
    // Disable is fenced by separators because it is the destructive item.
    if (!isPrefsOpen) {
      const prefsItem = new PopupMenu.PopupMenuItem("Preferences");
      prefsItem.connect("activate", () => this.extension.openPreferences());
      menu.addMenuItem(prefsItem);
    }

    const extensionsItem = new PopupMenu.PopupMenuItem("Extensions");
    extensionsItem.connect("activate", () =>
      this.extension.openPreferences("extensions"),
    );
    menu.addMenuItem(extensionsItem);

    menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    const quitItem = new PopupMenu.PopupMenuItem("Disable Extension");
    quitItem.connect("activate", () => {
      this._confirmDisable();
    });
    menu.addMenuItem(quitItem);

    menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    const aboutItem = new PopupMenu.PopupMenuItem("About");
    aboutItem.connect("activate", () => {
      this.extension.openPreferences("about");
    });
    menu.addMenuItem(aboutItem);

    if (isPrefsOpen) {
      const closeItem = new PopupMenu.PopupMenuItem("Close");
      closeItem.connect("activate", () => {
        this.extension.closePreferences();
      });
      menu.addMenuItem(closeItem);
    }
  }
}

import St from "gi://St";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Clutter from "gi://Clutter";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import * as ModalDialog from "resource:///org/gnome/shell/ui/modalDialog.js";
import * as Dialog from "resource:///org/gnome/shell/ui/dialog.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";

import { AppConfig } from "../config.js";
import { logError } from "../util/logger.js";
import { gettext as _ } from '../util/gettext.js';

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
    const nameId = AppConfig.name || "Lesion Extension";

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
        this.extension.openPreferences();
      }
    });

    this._menuSignals.push(
      this.button.menu.connect("open-state-changed", (menu, open) => {
        if (open) this._updateMenu();
      }),
    );
    this._updateMenu();

    const role = AppConfig.uuid || "lesion-indicator";
    Main.panel.addToStatusArea(role, this.button, 2, "right");

    // Highlight while prefs are open. No try/catch: these accesses are cheap
    // and non-throwing under normal conditions; the source keeps running either way.
    this._prefsWatchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
      const open = this.extension.isPreferencesOpen === true;
      if (this._clickButton) {
        if (open) this._clickButton.add_style_pseudo_class("active");
        else this._clickButton.remove_style_pseudo_class("active");
      }
      return GLib.SOURCE_CONTINUE;
    });
  }

  _destroyButton() {
    if (this._prefsWatchId) {
      GLib.source_remove(this._prefsWatchId);
      this._prefsWatchId = 0;
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
      title: _("Disable Lesion?"),
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

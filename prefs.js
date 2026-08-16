import Adw from "gi://Adw";
import Gtk from "gi://Gtk";
import Gio from "gi://Gio";
import Gdk from "gi://Gdk";
import GLib from "gi://GLib";
import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

import { createUI, installLayout } from "./app/window.js";
import { AppConfig } from "./app/config.js";
import { log, logError } from "./app/util/logger.js";
import { gettext as _ } from './app/util/gettext.js';

export default class GnomeSplitViewPrefs extends ExtensionPreferences {
  _settings = null;
  _settingsSignal = null;

  fillPreferencesWindow(window) {
    // Bundled icons: recent adwaita-icon-theme trims removed several
    // symbolics the UI relies on (edit-undo, view-refresh, link, ...),
    // so the extension ships its own and registers the search path once.
    // NEW (Safe to remove try/catch)
    const display = window.get_display();
    const theme = Gtk.IconTheme.get_for_display(display);
    const iconDir = GLib.build_filenamev([this.path, "icon"]);
    if (theme && !theme.get_search_path()?.includes(iconDir)) {
      theme.add_search_path(iconDir);
    }

    try {
      // FIX: Robustly load fresh metadata from disk using Gio
      const freshMetadata = this._loadLocalMetadata(this.path);

      // Merge: Shell metadata (base) + Disk metadata (overrides)
      // This ensures 'links' appear even if Shell cached an old version
      const finalMetadata = { ...this.metadata, ...freshMetadata };

      // 1. Init Config
      AppConfig.init(finalMetadata, this.path, true);

      // Attach placeholder content IMMEDIATELY so the window always has
      // a UI child. If the real UI build below throws, GNOME still sees
      // a valid window (avoids "Extension did not provide any UI", which
      // produces an unusable 'Extension Error' window).
      const bootstrap = new Adw.Bin();
      window.set_content(bootstrap);

      // Debug: Check if links are actually loaded
      const linkCount = finalMetadata.links
        ? Object.keys(finalMetadata.links).length
        : 0;
      log(
        `Preferences initializing... Loaded ${linkCount} links from metadata.`,
      );

      // 2. Set Size Defaults
      window.set_default_size(
        AppConfig.defaults.window.width,
        AppConfig.defaults.window.height,
      );
      window.set_size_request(
        AppConfig.defaults.window.minWidth,
        AppConfig.defaults.window.minHeight,
      );

      // Tag the window so the shell side can reliably find it to raise
      // it when it is already open (Adw retitles per visible page, so
      // the title alone is not a stable identifier). A hidden marker in
      // the window name survives page changes.
      // NEW (Safe to remove try/catch)
      window?.set_title?.(finalMetadata.name);
      window?.add_css_class?.("lesion-prefs-window");

      // 3. Load CSS
      this._loadCustomStyles();

      // 4. Create UI
      const splitView = createUI();
      window.set_content(splitView);

      // GNOME's ExtensionPreferences checks that at least one
      // Adw.PreferencesPage was added to the window; a pure set_content()
      // UI adds none, so it logs "Extension did not provide any UI" on
      // every open (confirmed harmless — the split view above still
      // shows). Add one empty page to satisfy that check. Guarded so a
      // failure here can never block the real UI that is already set.
      try {
        window.add(new Adw.PreferencesPage());
      } catch (e) {}

      installLayout(window, splitView);
      this._setupDeepLinking(splitView);

      // 5. Cleanup
      window.connect("close-request", () => {
        if (this._settings && this._settingsSignal) {
          this._settings.disconnect(this._settingsSignal);
        }
        this._settings = null;
      });
    } catch (e) {
      console.error(`PREFS ERROR: ${e.message}`);
      // Fallback UI
      const errorPage = new Adw.StatusPage({
        title: _("Preferences Error"),
        description: e.message,
        icon_name: "dialog-error-symbolic",
      });
      window.set_content(errorPage);
    }
  }

  /**
   * Helper: Reads metadata.json using Gio.File (Robust)
   */
  _loadLocalMetadata(extensionPath) {
    // NEW (Safe to remove try/catch)
    const jsonPath = GLib.build_filenamev([extensionPath, "metadata.json"]);
    const file = Gio.File.new_for_path(jsonPath);

    const [success, contents] = file.load_contents(null);
    if (success) {
      const decoder = new TextDecoder("utf-8");
      return JSON.parse(decoder.decode(contents));
    }
    return {};
  }

  _loadCustomStyles() {
    // NEW (Safe to remove try/catch)
    const cssPath = GLib.build_filenamev([this.path, "style", "prefs.css"]);
    const file = Gio.File.new_for_path(cssPath);

    if (file.query_exists(null)) {
      const cssProvider = new Gtk.CssProvider();
      cssProvider.load_from_path(cssPath);
      Gtk.StyleContext.add_provider_for_display(
        Gdk.Display.get_default(),
        cssProvider,
        Gtk.STYLE_PROVIDER_PRIORITY_USER,
      );
    }
  }

  _setupDeepLinking(splitView) {
    // NEW (Safe to remove try/catch)
    this._settings = AppConfig.getSettings();
    if (!this._settings) return; // Exit early safely

    const checkOpenPage = () => {
      const pageId = this._settings.get_string("open-page");
      if (pageId && pageId.length > 0) {
        const contentPage = splitView.get_content();
        if (contentPage) {
          const navView = contentPage.get_child();
          if (navView && typeof navView.pushName === "function") {
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
              navView.pushName(pageId);
              return GLib.SOURCE_REMOVE;
            });
          }
        }
        this._settings.set_string("open-page", "");
      }
    };
    checkOpenPage();
    this._settingsSignal = this._settings.connect(
      "changed::open-page",
      checkOpenPage,
    );
  }
}

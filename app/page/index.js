import { createDashboardUI } from "./dashboard.js";
import { createAboutUI } from "./about.js";
import { createWallpaperUI } from "./wallpaper.js";
import { createClockUI } from './clock.js';
import { createLayoutUI } from './layout.js';
import { createTooltipsUI } from './tooltips.js';
import { createAppearanceUI } from "./appearance.js";
import { createEffectsUI } from './effects.js';
import { createGeometryUI } from './geometry.js';
import { createStylesheetUI } from "./stylesheet.js";
import { createExtensionsUI } from "./extensions.js";
import { gettext as _ } from '../util/gettext.js';

export function getPages() {
  return [
    {
      title: _("General"),
      items: [
        {
          id: "dashboard",
          title: _("Dashboard"),
          icon: "user-home-symbolic",
          description: _("View system information and basic OS details"),
          keywords: ["dashboard", "home", "indicator", "backup", "restore", "reset"],
          ui: createDashboardUI,
        },
      ],
    },
    {
      title: _("Desktop"),
      items: [
        {
          id: "wallpaper",
          title: _("Wallpaper"),
          icon: "preferences-desktop-wallpaper-symbolic",
          description: _("Customize background images and colors"),
          keywords: ["background", "image", "picture", "color", "dark"],
          ui: createWallpaperUI,
        },
      ],
    },
    {
      title: _("Panel"),
      items: [
        {
          id: "panel-appearance",
          title: _("Appearance"),
          icon: "preferences-desktop-appearance-symbolic",
          description: _("Panel colors, gradient, borders, shadow, and presets"),
          keywords: ["panel", "style", "appearance", "theme", "color", "gradient", "background", "border", "shadow", "bar", "preset", "blur", "glass"],
          ui: createAppearanceUI,
        },
        {
          id: "panel-layout",
          title: _("Layout"),
          icon: "view-grid-symbolic",
          description: _("Arrange panel items and adjust their size, spacing, and colors"),
          keywords: ["layout", "apps", "applets", "arrange", "order", "position", "size", "margin", "padding", "grid", "launcher", "overview"],
          ui: createLayoutUI,
        },
        {
          id: "panel-tooltips",
          title: _("Tooltips"),
          icon: "dialog-information-symbolic",
          description: _("Style the hover labels on Hornbill's panel buttons"),
          keywords: ["tooltip", "tooltips", "hover", "label", "name", "hint", "caption"],
          ui: createTooltipsUI,
        },
        {
          id: "clock",
          title: _("Clock"),
          icon: "preferences-system-time-symbolic",
          description: _("Customize the panel clock"),
          keywords: ["clock", "time", "date", "calendar", "format"],
          ui: createClockUI,
        },
      ],
    },
    {
      title: _("Window"),
      items: [
        {
          id: "window-effects",
          title: _("Effects"),
          icon: "focus-windows-symbolic",
          description: _("Window corner rounding, shadows, and transparency"),
          keywords: ["window", "corners", "rounding", "radius", "shadow", "transparency", "opacity", "effects"],
          ui: createEffectsUI,
        },
        {
          id: "window-geometry",
          title: _("Geometry"),
          icon: "video-single-display-symbolic",
          description: _("Remember and restore window size and position"),
          keywords: ["geometry", "window", "size", "position", "remember", "restore", "workspace", "monitor"],
          ui: createGeometryUI,
        },
      ],
    },
    {
      title: _("Advanced"),
      items: [
        {
          id: "extensions",
          title: _("Extensions"),
          icon: "application-x-addon-symbolic",
          description: _("Manage installed GNOME Shell extensions"),
          keywords: ["extensions", "manage", "enable", "disable", "remove", "uninstall", "addons", "plugins"],
          ui: createExtensionsUI,
        },
        {
          id: "stylesheet",
          title: _("Stylesheet"),
          icon: "text-x-generic-symbolic",
          description: _("Hand-edit custom CSS applied to the shell"),
          keywords: ["css", "stylesheet", "custom", "code", "advanced", "style"],
          ui: createStylesheetUI,
        },
      ],
    },
    {
      title: null,
      items: [
        {
          id: "about",
          title: _("About"),
          icon: "help-about-symbolic",
          description: _("Learn more about this application"),
          keywords: ["about", "version", "info", "links", "documentation"],
          ui: createAboutUI,
        },
      ],
    },
  ];
}

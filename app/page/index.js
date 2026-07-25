import { createDashboardUI } from "./dashboard.js";
import { createAboutUI } from "./about.js";
import { createWallpaperUI } from "./wallpaper.js";
import { createClockUI } from './clock.js';
import { createLayoutUI } from './layout.js';
import { createAppearanceUI } from "./appearance.js";
import { createEffectsUI } from './effects.js';
import { createGeometryUI } from './geometry.js';
import { createStylesheetUI } from "./stylesheet.js";

export function getPages() {
  return [
    {
      title: "General",
      items: [
        {
          id: "dashboard",
          title: "Dashboard",
          icon: "user-home-symbolic",
          description: "View system information and basic OS details",
          keywords: ["dashboard", "home", "indicator", "backup", "restore", "reset"],
          ui: createDashboardUI,
        },
      ],
    },
    {
      title: "Desktop",
      items: [
        {
          id: "wallpaper",
          title: "Wallpaper",
          icon: "preferences-desktop-wallpaper-symbolic",
          description: "Customize background images and colors",
          keywords: ["background", "image", "picture", "color", "dark"],
          ui: createWallpaperUI,
        },
      ],
    },
    {
      title: "Panel",
      items: [
        {
          id: "panel-appearance",
          title: "Appearance",
          icon: "preferences-desktop-appearance-symbolic",
          description: "Panel colors, gradient, borders, shadow, and presets",
          keywords: ["panel", "style", "appearance", "theme", "color", "gradient", "background", "border", "shadow", "bar", "preset", "blur", "glass"],
          ui: createAppearanceUI,
        },
        {
          id: "panel-layout",
          title: "Layout",
          icon: "view-grid-symbolic",
          description: "Arrange panel items and adjust their size, spacing, and colors",
          keywords: ["layout", "apps", "applets", "arrange", "order", "position", "size", "margin", "padding", "grid", "launcher", "overview"],
          ui: createLayoutUI,
        },
        {
          id: "clock",
          title: "Clock",
          icon: "preferences-system-time-symbolic",
          description: "Customize the panel clock",
          keywords: ["clock", "time", "date", "calendar", "format"],
          ui: createClockUI,
        },
      ],
    },
    {
      title: "Window",
      items: [
        {
          id: "window-effects",
          title: "Effects",
          icon: "preferences-desktop-appearance-symbolic",
          description: "Window corner rounding, shadows, and transparency",
          keywords: ["window", "corners", "rounding", "radius", "shadow", "transparency", "opacity", "effects"],
          ui: createEffectsUI,
        },
        {
          id: "window-geometry",
          title: "Geometry",
          icon: "video-single-display-symbolic",
          description: "Remember and restore window size and position",
          keywords: ["geometry", "window", "size", "position", "remember", "restore", "workspace", "monitor"],
          ui: createGeometryUI,
        },
      ],
    },
    {
      title: "Advanced",
      items: [
        {
          id: "stylesheet",
          title: "Stylesheet",
          icon: "text-x-generic-symbolic",
          description: "Hand-edit custom CSS applied to the shell",
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
          title: "About",
          icon: "help-about-symbolic",
          description: "Learn more about this application",
          keywords: ["about", "version", "info", "links", "documentation"],
          ui: createAboutUI,
        },
      ],
    },
  ];
}

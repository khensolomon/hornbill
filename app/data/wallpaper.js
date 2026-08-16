import { N_ } from '../util/gettext.js';
/**
 * Wallpaper Presets Configuration
 * * * New Structure:
 * - name: Display name
 * - wallpaper: String (path relative to extension root) OR Object { light, dark }
 * - system: Settings for 'org.gnome.desktop.background'
 * - extension: Settings for the extension schema
 * * * Path Examples:
 * - "wallpaper/forest.jpg"  -> looks inside [extension_root]/wallpaper/
 * - "assets/bg.png"         -> looks inside [extension_root]/assets/
 * - "/usr/share/backgrounds/gnome/adwaita-l.jpg" -> Absolute path
 */
export const WallpaperPresets = [
    {
        name: N_("Midnight Gradient"),
        // No wallpaper property = use system colors defined below
        system: {
            "primary-color": "#858583",
            "secondary-color": "#636362",
            "color-shading-type": "vertical",
            "picture-options": "none",
            "picture-uri": "",
            "picture-uri-dark": ""
        },
        extension: {
            "wallpaper-primary-color-dark": "#1A1818",
            "wallpaper-secondary-color-dark": "#141414",
            "wallpaper-blur-sigma": 0,
            "wallpaper-monochrome": false,
            "wallpaper-brightness": 1.0,
            "wallpaper-show-image": false
        }
    },
    {
        name: N_("Diamond"),
        // Simple string: applies to both Light and Dark
        // Flexible path: explicitly prefixed with "wallpaper/..."
        wallpaper: "wallpaper/lethil.svg", 
        system: {
            "primary-color": "#656161",
            "secondary-color": "#474545",
            "color-shading-type": "vertical",
            "picture-options": "centered",
        },
        extension: {
            "wallpaper-primary-color-dark": "#474948ff",
            "wallpaper-secondary-color-dark": "#262927ff",
            "wallpaper-blur-sigma": 5,
            "wallpaper-monochrome": false,
            "wallpaper-brightness": 0.9,
            "wallpaper-show-image": true
        }
    },
    {
        name: N_("Chain Link"),
        // Object: distinct images for modes Day & Night
        wallpaper: {
            light: "wallpaper/chain.svg",
            dark: "wallpaper/chain.svg"
        },
        system: {
            "primary-color": "#9B9797",
            "secondary-color": "#7E7D7D",
            "color-shading-type": "vertical",
            "picture-options": "centered"
        },
        extension: {
            "wallpaper-primary-color-dark": "#413f3fff",
            "wallpaper-secondary-color-dark": "#313131ff",
            "wallpaper-blur-sigma": 0,
            "wallpaper-monochrome": false,
            "wallpaper-brightness": 1.0,
            "wallpaper-show-image": true
        }
    },
    {
        name: N_("Mono Minimal"),
        // Example: an absolute path in another folder also works
        wallpaper: "icon/hornbill.svg", 
        system: {
            "primary-color": "#615F5F",
            "secondary-color": "#4F4C4C",
            "picture-options": "scaled"
        },
        extension: {
            "wallpaper-primary-color-dark": "#333333",
            "wallpaper-secondary-color-dark": "#111111",
            "wallpaper-blur-sigma": 0,
            "wallpaper-monochrome": true,
            "wallpaper-brightness": 1.0,
            "wallpaper-show-image": true
        }
    }
];
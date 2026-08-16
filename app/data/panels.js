import { N_ } from '../util/gettext.js';
/**
 * Configuration structure for Panel Presets.
 * @typedef {Object} PanelPreset
 * @property {string} name
 * @property {string} description
 * @property {Object.<string, (string|number|boolean)>} data
 *
 * Design notes:
 * - Every preset sets EVERY visual key it cares about, including ones it
 *   wants at neutral values. Presets that only wrote their own keys left
 *   residue from the previously applied preset (e.g. a bottom panel
 *   surviving into a macOS look), making switching non-deterministic.
 * - Enum keys (positions, border styles) are written as enum ints and must
 *   be listed in the page's enumKeys set.
 * - Values are matched to the real platforms:
 *   macOS menu bar: heavy-blur translucency, no border, no shadow, 5px
 *   selection rounding, quiet hover; menus at 10px radius with a soft,
 *   large shadow. The menu bar carries status items only, so app buttons
 *   are turned off (pair it with a dock for the full experience).
 *   Windows 11 taskbar: bottom bar, Mica-style translucency, hairline
 *   divider on the desktop edge, 6px hover rounding, flyouts at 8px with a
 *   tight drop shadow; Start (grid) + pinned + running on the bar,
 *   no trash/disks (Windows keeps the Recycle Bin on the desktop).
 */

// Shared neutral values so presets stay deterministic when switching
const NO_GRADIENT = {
    'panel-bg-gradient-enabled': false,
    'panel-bg-gradient-color': 'rgba(0,0,0,0)',
    'panel-bg-gradient-dir': 0,
};

const FLAT_BAR = {
    'panel-margin': 0,
    'panel-corner-radius': 0,
};

export const PanelsPresets = [
    {
        name: N_('Default (GNOME)'),
        description: N_('Standard GNOME appearance with the stock app buttons'),
        data: {
            'panel-enabled': true,
            'panel-position': 0,
            'panel-bg-color': 'rgba(0,0,0,1)',
            ...NO_GRADIENT,
            ...FLAT_BAR,
            'panel-blur-enabled': false,
            'panel-blur-sigma': 0,
            'panel-border-size': 0,
            'panel-border-color': 'rgba(255,255,255,0.2)',
            'panel-border-style': 0,
            'panel-border-bottom-only': true,
            'panel-shadow-enabled': false,
            'panel-shadow-color': 'rgba(0,0,0,0.5)',
            'panel-shadow-x': 0,
            'panel-shadow-y': 0,
            'panel-shadow-blur': 4,
            'panel-shadow-spread': 0,
            'panel-shadow-inset': false,

            'panel-btn-color': 'rgba(255,255,255,1)',
            'panel-btn-radius': 6,
            'panel-btn-pad-min': 4,
            'panel-btn-pad-nat': 4,
            'panel-btn-hover-enabled': false,
            'panel-btn-bg-hover': 'rgba(255,255,255,0.1)',
            'panel-btn-bg-active': 'rgba(255,255,255,0.2)',

            'popup-radius': 12,
            'popup-border-size': 0,
            'popup-border-color': 'rgba(255,255,255,0.1)',
            'popup-border-style': 0,
            'popup-shadow-enabled': true,
            'popup-shadow-color': 'rgba(0,0,0,0.5)',
            'popup-shadow-x': 0,
            'popup-shadow-y': 4,
            'popup-shadow-blur': 12,
            'popup-shadow-spread': 4,

            // Matches the schema defaults
            'apps-showgrid-enabled': true,
            'apps-showgrid-pos': 0,
            'apps-showgrid-icon': 'start-here-symbolic',
            'apps-favorites-enabled': true,
            'apps-favorites-pos': 0,
            'apps-running-enabled': true,
            'apps-running-pos': 0,
            'apps-disks-enabled': true,
            'apps-disks-pos': 1,
            'apps-trash-enabled': true,
            'apps-trash-pos': 1,
        }
    },
    {
        name: N_('macOS Light'),
        description: N_('Translucent light menu bar. Status items only — pair with a dock.'),
        data: {
            'panel-enabled': true,
            'panel-position': 0, // Top
            'panel-bg-color': 'rgba(246,246,246,0.72)',
            ...NO_GRADIENT,
            ...FLAT_BAR,
            'panel-blur-enabled': true,
            'panel-blur-sigma': 36,
            // The real menu bar has no border and no shadow
            'panel-border-size': 0,
            'panel-border-color': 'rgba(0,0,0,0.08)',
            'panel-border-style': 0,
            'panel-border-bottom-only': true,
            'panel-shadow-enabled': false,
            'panel-shadow-color': 'rgba(0,0,0,0.10)',
            'panel-shadow-x': 0,
            'panel-shadow-y': 1,
            'panel-shadow-blur': 3,
            'panel-shadow-spread': 0,
            'panel-shadow-inset': false,

            'panel-btn-color': 'rgba(20,20,20,0.90)',
            'panel-btn-radius': 5,
            'panel-btn-pad-min': 6,
            'panel-btn-pad-nat': 10,
            'panel-btn-hover-enabled': true,
            'panel-btn-bg-hover': 'rgba(0,0,0,0.08)',
            'panel-btn-bg-active': 'rgba(0,0,0,0.16)',

            'popup-radius': 10,
            'popup-border-size': 1,
            'popup-border-color': 'rgba(0,0,0,0.10)',
            'popup-border-style': 0,
            'popup-shadow-enabled': true,
            'popup-shadow-color': 'rgba(0,0,0,0.25)',
            'popup-shadow-x': 0,
            'popup-shadow-y': 6,
            'popup-shadow-blur': 24,
            'popup-shadow-spread': 0,

            // Menu bar carries status items only
            'apps-showgrid-enabled': false,
            'apps-favorites-enabled': false,
            'apps-running-enabled': false,
            'apps-disks-enabled': false,
            'apps-trash-enabled': false,
        }
    },
    {
        name: N_('macOS Dark'),
        description: N_('Translucent dark menu bar. Status items only — pair with a dock.'),
        data: {
            'panel-enabled': true,
            'panel-position': 0, // Top
            'panel-bg-color': 'rgba(24,24,26,0.65)',
            ...NO_GRADIENT,
            ...FLAT_BAR,
            'panel-blur-enabled': true,
            'panel-blur-sigma': 36,
            'panel-border-size': 0,
            'panel-border-color': 'rgba(255,255,255,0.10)',
            'panel-border-style': 0,
            'panel-border-bottom-only': true,
            'panel-shadow-enabled': false,
            'panel-shadow-color': 'rgba(0,0,0,0.30)',
            'panel-shadow-x': 0,
            'panel-shadow-y': 1,
            'panel-shadow-blur': 3,
            'panel-shadow-spread': 0,
            'panel-shadow-inset': false,

            'panel-btn-color': 'rgba(255,255,255,0.95)',
            'panel-btn-radius': 5,
            'panel-btn-pad-min': 6,
            'panel-btn-pad-nat': 10,
            'panel-btn-hover-enabled': true,
            'panel-btn-bg-hover': 'rgba(255,255,255,0.12)',
            'panel-btn-bg-active': 'rgba(255,255,255,0.22)',

            'popup-radius': 10,
            'popup-border-size': 1,
            'popup-border-color': 'rgba(255,255,255,0.14)',
            'popup-border-style': 0,
            'popup-shadow-enabled': true,
            'popup-shadow-color': 'rgba(0,0,0,0.45)',
            'popup-shadow-x': 0,
            'popup-shadow-y': 6,
            'popup-shadow-blur': 24,
            'popup-shadow-spread': 0,

            'apps-showgrid-enabled': false,
            'apps-favorites-enabled': false,
            'apps-running-enabled': false,
            'apps-disks-enabled': false,
            'apps-trash-enabled': false,
        }
    },
    {
        name: N_('Windows 11 Light'),
        description: N_('Light Mica taskbar at the bottom with Start, pinned, and running apps'),
        data: {
            'panel-enabled': true,
            'panel-position': 2, // Bottom
            'panel-bg-color': 'rgba(243,243,243,0.85)',
            ...NO_GRADIENT,
            ...FLAT_BAR,
            'panel-blur-enabled': true,
            'panel-blur-sigma': 30,
            // Hairline divider on the desktop edge
            'panel-border-size': 1,
            'panel-border-color': 'rgba(0,0,0,0.06)',
            'panel-border-style': 0,
            'panel-border-bottom-only': true,
            'panel-shadow-enabled': false,
            'panel-shadow-color': 'rgba(0,0,0,0.10)',
            'panel-shadow-x': 0,
            'panel-shadow-y': 0,
            'panel-shadow-blur': 4,
            'panel-shadow-spread': 0,
            'panel-shadow-inset': false,

            'panel-btn-color': 'rgba(25,25,25,1)',
            'panel-btn-radius': 6,
            'panel-btn-pad-min': 6,
            'panel-btn-pad-nat': 10,
            'panel-btn-hover-enabled': true,
            'panel-btn-bg-hover': 'rgba(0,0,0,0.06)',
            'panel-btn-bg-active': 'rgba(0,0,0,0.10)',

            'popup-radius': 8,
            'popup-border-size': 1,
            'popup-border-color': 'rgba(0,0,0,0.08)',
            'popup-border-style': 0,
            'popup-shadow-enabled': true,
            'popup-shadow-color': 'rgba(0,0,0,0.28)',
            'popup-shadow-x': 0,
            'popup-shadow-y': 8,
            'popup-shadow-blur': 16,
            'popup-shadow-spread': 0,

            // Taskbar: Start + pinned + running; Recycle Bin stays off the bar
            'apps-showgrid-enabled': true,
            'apps-showgrid-pos': 0,
            'apps-showgrid-icon': 'view-grid-symbolic',
            'apps-showgrid-text': '',
            'apps-favorites-enabled': true,
            'apps-favorites-pos': 0,
            'apps-running-enabled': true,
            'apps-running-pos': 0,
            'apps-disks-enabled': false,
            'apps-trash-enabled': false,
        }
    },
    {
        name: N_('Windows 11 Dark'),
        description: N_('Dark Mica taskbar at the bottom with Start, pinned, and running apps'),
        data: {
            'panel-enabled': true,
            'panel-position': 2, // Bottom
            'panel-bg-color': 'rgba(32,32,32,0.85)',
            ...NO_GRADIENT,
            ...FLAT_BAR,
            'panel-blur-enabled': true,
            'panel-blur-sigma': 30,
            'panel-border-size': 1,
            'panel-border-color': 'rgba(255,255,255,0.06)',
            'panel-border-style': 0,
            'panel-border-bottom-only': true,
            'panel-shadow-enabled': false,
            'panel-shadow-color': 'rgba(0,0,0,0.30)',
            'panel-shadow-x': 0,
            'panel-shadow-y': 0,
            'panel-shadow-blur': 4,
            'panel-shadow-spread': 0,
            'panel-shadow-inset': false,

            'panel-btn-color': 'rgba(255,255,255,1)',
            'panel-btn-radius': 6,
            'panel-btn-pad-min': 6,
            'panel-btn-pad-nat': 10,
            'panel-btn-hover-enabled': true,
            'panel-btn-bg-hover': 'rgba(255,255,255,0.08)',
            'panel-btn-bg-active': 'rgba(255,255,255,0.12)',

            'popup-radius': 8,
            'popup-border-size': 1,
            'popup-border-color': 'rgba(255,255,255,0.09)',
            'popup-border-style': 0,
            'popup-shadow-enabled': true,
            'popup-shadow-color': 'rgba(0,0,0,0.50)',
            'popup-shadow-x': 0,
            'popup-shadow-y': 8,
            'popup-shadow-blur': 16,
            'popup-shadow-spread': 0,

            'apps-showgrid-enabled': true,
            'apps-showgrid-pos': 0,
            'apps-showgrid-icon': 'view-grid-symbolic',
            'apps-showgrid-text': '',
            'apps-favorites-enabled': true,
            'apps-favorites-pos': 0,
            'apps-running-enabled': true,
            'apps-running-pos': 0,
            'apps-disks-enabled': false,
            'apps-trash-enabled': false,
        }
    }
];

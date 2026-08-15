// Panel Widgets
import { Indicator } from '../panel/indicator.js';

// Logic Modules
import { WallpaperManager } from './wallpaper.js';
import { StyleManager } from './styles.js';
import { GeometryManager } from './geometry.js';
import { ClockManager } from './clock.js';
import { AppsManager } from './apps.js';
import { PanelsManager } from './panels.js';
import { EffectsManager } from './effects.js';

/**
 * Returns the list of component classes to be instantiated.
 * The order can matter (e.g. load styles before UI).
 */
export function getComponents() {
    return [
        Indicator,
        WallpaperManager,
        StyleManager,
        GeometryManager,
        ClockManager,
        PanelsManager,
        EffectsManager,
        AppsManager,
    ];
}

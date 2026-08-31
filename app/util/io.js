import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { AppConfig } from '../config.js';
import { log, logError } from './logger.js';
import { filterKeys, categoriesPresent, isInternalKey } from './categories.js';

/**
 * Export / Import / Reset, scoped by category.
 *
 * Scope is expressed as EXCLUDED category ids rather than included ones, so a
 * category added in a later version is in scope by default. Storing inclusions
 * would silently drop new settings from everyone's exports until they noticed
 * and ticked a box they had no reason to look for.
 *
 * The excluded list is passed in rather than read here, so these stay usable
 * with an ad-hoc scope — importing only what a file happens to contain, say.
 */
export const SettingsManager = {

    /**
     * @param {string[]} excluded category ids to leave out
     * @returns {string|null} Pretty printed JSON or null on error
     */
    exportSettings(excluded = []) {
        try {
            const settings = AppConfig.getSettings();
            const keys = filterKeys(settings.list_keys(), excluded);

            const exportData = {
                metadata: {
                    version: 1, // Bump when the export format changes incompatibly
                    uuid: AppConfig.uuid,
                    date: new Date().toISOString(),
                    // Recorded so an importer can report what a file holds
                    // without categorising every key itself.
                    categories: categoriesPresent(keys),
                },
                settings: {}
            };

            keys.forEach(key => {
                const variant = settings.get_value(key);
                // deep_unpack converts complex GVariants (like Arrays/Tuples) to JS objects
                exportData.settings[key] = variant.deep_unpack();
            });

            return JSON.stringify(exportData, null, 2);
        } catch (e) {
            logError("Export failed", e);
            return null;
        }
    },

    /**
     * Read a file without applying it, so the confirmation can state what is
     * actually about to change. Import previously ran blind and overwrote
     * every matching key with no prompt at all.
     *
     * @returns {Object} { success, message, categories, keyCount }
     */
    inspectSettings(jsonString) {
        try {
            const data = JSON.parse(jsonString);
            if (!data.settings || !data.metadata)
                return { success: false, message: "Invalid configuration file format.", categories: [], keyCount: 0 };

            const schemaKeys = AppConfig.getSettings().list_keys();

            // Only keys this build still understands: a file written by an
            // older version may carry keys that no longer exist.
            const known = Object.keys(data.settings)
                .filter(k => schemaKeys.includes(k) && !isInternalKey(k));

            return {
                success: true,
                message: '',
                categories: categoriesPresent(known),
                keyCount: known.length,
            };
        } catch (e) {
            return { success: false, message: e.message, categories: [], keyCount: 0 };
        }
    },

    /**
     * @param {string} jsonString
     * @param {string[]} excluded category ids to leave out
     * @returns {Object} { success: boolean, message: string }
     */
    importSettings(jsonString, excluded = []) {
        try {
            const data = JSON.parse(jsonString);

            // Basic Validation
            if (!data.settings || !data.metadata) {
                return { success: false, message: "Invalid configuration file format." };
            }

            // Version check (Optional: add logic here to handle migrations)
            // if (data.metadata.version < 1) { ... migrate ... }

            const settings = AppConfig.getSettings();
            const schemaKeys = settings.list_keys();
            const allowed = new Set(filterKeys(schemaKeys, excluded));
            let importCount = 0;
            let skippedByScope = 0;

            // Iterate over the keys provided in the JSON
            for (const [key, value] of Object.entries(data.settings)) {
                // 1. Check if this key actually exists in the current schema
                if (!schemaKeys.includes(key)) {
                    log(`Skipping unknown key: ${key} (deprecated?)`);
                    continue;
                }

                // 2. Honour the scope
                if (!allowed.has(key)) {
                    skippedByScope++;
                    continue;
                }

                // 3. Convert the JS value back to the specific GVariant type
                // We use the current setting value to determine the expected type signature
                const currentVariant = settings.get_value(key);
                const typeString = currentVariant.get_type_string();

                try {
                    // GLib.Variant.new() tries to construct a variant from a JS value
                    // based on the type signature string.
                    const newVariant = new GLib.Variant(typeString, value);
                    settings.set_value(key, newVariant);
                    importCount++;
                } catch (err) {
                    logError(`Type mismatch for key '${key}':`, err);
                }
            }

            // Force a sync to ensure disk write
            Gio.Settings.sync();

            const note = skippedByScope > 0 ? ` ${skippedByScope} skipped by scope.` : '';
            return { success: true, message: `Successfully imported ${importCount} settings.${note}` };

        } catch (e) {
            logError("Import failed", e);
            return { success: false, message: e.message };
        }
    },

    /**
     * @param {string[]} excluded category ids to leave out
     * @returns {Object} { success: boolean, count: number }
     */
    resetSettings(excluded = []) {
        try {
            // Throwaway object: delay() is permanent for the object it is
            // called on, and the shared one must stay in immediate mode.
            const batch = AppConfig.createSettings();
            batch.delay();

            const keys = filterKeys(batch.settings_schema.list_keys(), excluded);
            keys.forEach(key => batch.reset(key));

            batch.apply();
            Gio.Settings.sync();
            return { success: true, count: keys.length };
        } catch (e) {
            logError("Reset failed", e);
            return { success: false, count: 0 };
        }
    }
};

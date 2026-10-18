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
// GVariant integer type strings. JSON has one number type, so a float in an
// export file would otherwise be truncated silently into an integer key.
const INTEGER_TYPES = new Set(['y', 'n', 'q', 'i', 'u', 'x', 't']);

export const SettingsManager = {

    /**
     * @param {string[]} excluded category ids to leave out
     * @returns {string} Pretty printed JSON
     * @throws on failure, so the caller can report it; returning null left
     *   the export silently doing nothing.
     */
    exportSettings(excluded = []) {
        const settings = AppConfig.getSettings();
        const keys = filterKeys(settings.settings_schema.list_keys(), excluded);

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

            const schemaKeys = AppConfig.getSettings().settings_schema.list_keys();

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

            // Throwaway object: delay() is permanent for the object it is
            // called on, and the shared one must stay in immediate mode.
            const batch = AppConfig.createSettings();
            const schema = batch.settings_schema;
            const schemaKeys = schema.list_keys();
            const allowed = new Set(filterKeys(schemaKeys, excluded));
            const pending = [];
            const invalid = [];
            let skippedByScope = 0;

            // Validate everything before writing anything. Applying key by
            // key used to leave a half-applied configuration when a later key
            // was bad, and reported success regardless.
            for (const [key, value] of Object.entries(data.settings)) {
                // A file from an older version may carry keys that no longer exist.
                if (!schemaKeys.includes(key)) {
                    log(`Skipping unknown key: ${key}`);
                    continue;
                }
                if (!allowed.has(key)) {
                    skippedByScope++;
                    continue;
                }

                const schemaKey = schema.get_key(key);
                const typeString = schemaKey.get_value_type().dup_string();
                let variant = null;
                try {
                    if (INTEGER_TYPES.has(typeString) && !Number.isInteger(value))
                        throw new Error(`expected an integer, got ${JSON.stringify(value)}`);
                    variant = new GLib.Variant(typeString, value);
                } catch (err) {
                    invalid.push(`${key} (${err.message})`);
                    continue;
                }
                // Enum and range keys: the type alone accepts any string or
                // number, and set_value() would fail with only a warning.
                if (!schemaKey.range_check(variant)) {
                    invalid.push(`${key} (${JSON.stringify(value)} is out of range)`);
                    continue;
                }
                pending.push([key, variant]);
            }

            if (invalid.length > 0) {
                return {
                    success: false,
                    message: `Nothing was imported. ${invalid.length} setting(s) are invalid:\n` +
                        invalid.join('\n'),
                };
            }

            batch.delay();
            for (const [key, variant] of pending) {
                if (!batch.set_value(key, variant)) {
                    batch.revert();
                    return { success: false, message: `Nothing was imported. Could not write '${key}'.` };
                }
            }
            batch.apply();
            Gio.Settings.sync();

            const note = skippedByScope > 0 ? ` ${skippedByScope} skipped by scope.` : '';
            return { success: true, message: `Imported ${pending.length} settings.${note}` };

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

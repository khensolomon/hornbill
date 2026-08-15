import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { AppConfig } from '../config.js';
import { log, logError } from './logger.js';

export const SettingsManager = {
    
    /**
     * exports all settings to a JSON string
     * @returns {string|null} Pretty printed JSON or null on error
     */
    exportSettings() {
        try {
            const settings = AppConfig.getSettings();
            const keys = settings.list_keys();
            const exportData = {
                metadata: {
                    version: 1, // Bump when the export format changes incompatibly
                    uuid: AppConfig.uuid,
                    date: new Date().toISOString()
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
     * Imports settings from a JSON string
     * @param {string} jsonString 
     * @returns {Object} { success: boolean, message: string }
     */
    importSettings(jsonString) {
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
            let importCount = 0;

            // Iterate over the keys provided in the JSON
            for (const [key, value] of Object.entries(data.settings)) {
                // 1. Check if this key actually exists in the current schema
                if (!schemaKeys.includes(key)) {
                    log(`Skipping unknown key: ${key} (deprecated?)`);
                    continue;
                }

                // 2. Convert the JS value back to the specific GVariant type
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

            return { success: true, message: `Successfully imported ${importCount} settings.` };

        } catch (e) {
            logError("Import failed", e);
            return { success: false, message: e.message };
        }
    }
};
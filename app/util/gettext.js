import GLib from 'gi://GLib';

/**
 * Translation helpers for the extension.
 *
 * The text domain must match "gettext-domain" in metadata.json. GNOME's
 * Extension and ExtensionPreferences base classes bind that domain to the
 * extension's locale/ directory when the extension loads, so the GLib
 * dgettext family below resolves against:
 *
 *     locale/<lang>/LC_MESSAGES/lesion.mo
 *
 * GLib.dgettext works in every GJS context — the shell process, the prefs
 * process, and the standalone `gjs -m app.js` harness — so a single import
 * serves every file regardless of which process loads it. When no catalog is
 * bound (e.g. the standalone harness), dgettext returns the original English
 * string unchanged.
 */
export const DOMAIN = 'lesion';

/** Translate a single string. */
export function gettext(str) {
    return GLib.dgettext(DOMAIN, str);
}

/** Translate with singular/plural selection based on `n`. */
export function ngettext(singular, plural, n) {
    return GLib.dngettext(DOMAIN, singular, plural, n);
}

/** Translate with a disambiguating context. */
export function pgettext(context, str) {
    return GLib.dpgettext2(DOMAIN, context, str);
}

/**
 * Mark a string for extraction without translating it at definition time.
 * Use for strings kept in data tables: store N_('…') so xgettext collects it,
 * then translate at the display site with gettext(). Returns the input
 * unchanged, so the stored value stays a stable identity key.
 */
export function N_(str) {
    return str;
}

/**
 * Substitute %s placeholders left to right. A function replacement is used so
 * inserted values containing '$' are placed literally.
 *
 *     format(gettext('Apply %s'), preset.name)
 */
export function format(fmt, ...args) {
    let i = 0;
    return fmt.replace(/%s/g, () => (i < args.length ? String(args[i++]) : '%s'));
}

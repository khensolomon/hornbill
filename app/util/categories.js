import { N_ } from './gettext.js';

/**
 * Groups schema keys for scoped Export / Import / Reset.
 *
 * Matching is by key PREFIX, not by an enumerated key list. The schema already
 * namespaces every key by the area it belongs to, so a prefix table stays
 * correct as keys are added — the same reason the full reset iterates
 * list_keys() instead of naming keys. A hand-maintained list of 134 keys would
 * be wrong the first time someone added a setting and forgot to update it.
 *
 * THE RULE: one group per preferences page or section, so a user can look at
 * the page they were just editing and find its name in the list. Groups are
 * not invented to be tidy — 'Panel Tooltips' exists because Panel -> Tooltips
 * exists, and its keys share the 'apps-' prefix only for historical reasons.
 *
 * ORDER MATTERS: the first matching prefix wins, so narrower entries come
 * first. 'geometry-data' must precede 'geometry', and 'apps-tooltip' must
 * precede 'apps', or those keys would be swallowed by the wider group and
 * could never be selected on their own.
 *
 * COVERAGE IS PROVABLE, not assumed: listCategories() reports how many keys
 * each group holds and the preferences page shows those counts, so the numbers
 * either add up to the schema total or they visibly do not.
 */
const CATEGORIES = [
    {
        id: 'geometry-data',
        prefixes: ['geometry-data'],
        label: N_('Saved Applications'),
        blurb: N_('Remembered window positions and sizes'),
        // This is a RECORD OF THE USER'S DESKTOP, not a preference: it says
        // where they keep their windows. A config shared to pass on a look
        // should not carry it, so it starts excluded.
        defaultExcluded: true,
    },
    {
        id: 'geometry',
        prefixes: ['geometry'],
        label: N_('Geometry Settings'),
        blurb: N_('Whether positions are remembered, workspace and X11 options'),
    },
    {
        id: 'tooltips',
        prefixes: ['apps-tooltip', 'apps-tooltips'],
        label: N_('Panel Tooltips'),
        blurb: N_('Hover label styling, delay and offset'),
    },
    {
        id: 'apps',
        prefixes: ['apps'],
        label: N_('App Buttons'),
        blurb: N_('Favourites, running apps, drives, trash and the running dot'),
    },
    {
        id: 'panel',
        prefixes: ['panel'],
        label: N_('Panel Appearance'),
        blurb: N_('Panel colours, borders, layout and button styling'),
    },
    {
        id: 'popup',
        prefixes: ['popup'],
        label: N_('Popup Menus'),
        blurb: N_('Menu colours, borders and shadows'),
    },
    {
        id: 'clock',
        prefixes: ['clock'],
        label: N_('Clock'),
        blurb: N_('Position, format and two-line layout'),
    },
    {
        id: 'wallpaper',
        prefixes: ['wallpaper'],
        label: N_('Wallpaper'),
        blurb: N_('Images, colours and background effects'),
    },
    {
        id: 'corners',
        prefixes: ['corners'],
        label: N_('Screen Corners'),
        blurb: N_('Rounded corner radius and edge behaviour'),
    },
    {
        id: 'transparency',
        prefixes: ['transparency'],
        label: N_('Window Transparency'),
        blurb: N_('Focused and unfocused window opacity'),
    },
    {
        id: 'effects',
        prefixes: ['effects'],
        label: N_('Window Effects'),
        blurb: N_('Effect handling options'),
    },
    {
        id: 'indicator',
        prefixes: ['indicator'],
        label: N_('Extension Indicator'),
        blurb: N_('The Hornbill panel button and its icon'),
    },
    {
        id: 'stylesheet',
        prefixes: ['custom-styles', 'custom', 'enabled-styles'],
        label: N_('Custom Stylesheet'),
        blurb: N_('Hand-written CSS and which bundled styles are on'),
    },
];

/**
 * Keys that never travel and are never reset, whatever the scope says.
 *
 * 'data-scope-excluded' is the scope itself: exporting it would make an
 * imported file silently rewrite the recipient's scope, and importing it would
 * change the rules midway through the operation applying them. 'open-page' is
 * transient UI state — which page the window was last on — and means nothing
 * to another machine.
 */
const INTERNAL_KEYS = ['data-scope-excluded', 'open-page'];

/** Anything a future key does not match lands here rather than vanishing. */
export const OTHER_CATEGORY = {
    id: 'other',
    label: N_('Other'),
    blurb: N_('Settings not covered by the groups above'),
};

export function isInternalKey(key) {
    return INTERNAL_KEYS.includes(key);
}

/** @returns {string} category id for a key, or 'other'. */
export function categoryFor(key) {
    for (const cat of CATEGORIES) {
        for (const prefix of cat.prefixes) {
            if (key === prefix || key.startsWith(`${prefix}-`)) return cat.id;
        }
    }
    return OTHER_CATEGORY.id;
}

/**
 * Categories in display order, with 'Other' appended only when keys actually
 * fall into it — an empty group in the list would just be noise.
 * @param {string[]} allKeys the schema's key list
 */
export function listCategories(allKeys = []) {
    const count = (id) => allKeys.filter(k => !isInternalKey(k) && categoryFor(k) === id).length;

    const list = CATEGORIES.map(c => ({
        id: c.id,
        label: c.label,
        blurb: c.blurb,
        defaultExcluded: !!c.defaultExcluded,
        keyCount: count(c.id),
    }));

    const otherCount = count(OTHER_CATEGORY.id);
    if (otherCount > 0)
        list.push({ ...OTHER_CATEGORY, defaultExcluded: false, keyCount: otherCount });

    return list;
}

/**
 * Totals for the preferences page, so coverage can be shown rather than
 * claimed. If grouped ever falls short of total, a key is unaccounted for and
 * the 'Other' group appears to say so.
 */
export function coverage(allKeys = []) {
    const internal = allKeys.filter(isInternalKey).length;
    const grouped = listCategories(allKeys).reduce((n, c) => n + c.keyCount, 0);
    return { total: allKeys.length, internal, grouped };
}

export function defaultExcludedIds() {
    return CATEGORIES.filter(c => c.defaultExcluded).map(c => c.id);
}

/**
 * @param {string[]} keys
 * @param {string[]} excludedIds
 * @returns {string[]} keys that are in scope
 */
export function filterKeys(keys, excludedIds = []) {
    const excluded = new Set(excludedIds);
    return keys.filter(k => !isInternalKey(k) && !excluded.has(categoryFor(k)));
}

/** Distinct category ids present in a set of keys, internals ignored. */
export function categoriesPresent(keys) {
    const seen = new Set();
    keys.forEach(k => { if (!isInternalKey(k)) seen.add(categoryFor(k)); });
    return [...seen];
}

export function labelFor(id) {
    if (id === OTHER_CATEGORY.id) return OTHER_CATEGORY.label;
    return CATEGORIES.find(c => c.id === id)?.label || id;
}

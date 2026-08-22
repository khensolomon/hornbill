#!/usr/bin/env node
/**
 * Symbol-level import checker.
 *
 * `check.sh` only proves each file PARSES. It cannot see that a file uses
 * `Gio` without importing it, or imports `{ foo }` from a module that never
 * exports `foo`. Both fail at runtime inside GNOME Shell, where the only
 * symptom is a dead feature and a line in the journal.
 *
 * Three checks, all textual (no parser dependency):
 *
 *   1. UNDEFINED NAMESPACE — a known GI/Shell namespace is referenced as
 *      `Name.` but never imported in that file.
 *   2. MISSING EXPORT      — `import { x } from './y.js'` where y.js has no
 *      `export` of `x`.
 *   3. UNUSED IMPORT       — an imported binding is never referenced.
 *   4. SHADOWED LOGGER     — a file calls log()/logError() without importing
 *      them from util/logger.js. Both names also exist as GJS globals, so the
 *      call still runs — it just silently binds to the wrong function. The
 *      project's log() is gated on AppConfig.debug and the global one is not,
 *      so this leaks debug output into every user's journal.
 *
 * Usage:  node check-symbols.js        (exit 1 on any error)
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

// Namespaces that must be imported before use. Anything not listed here is
// ignored, so an unfamiliar name never produces a false positive.
const GI_NAMESPACES = new Set([
    'Adw', 'Atk', 'Cairo', 'Clutter', 'Cogl', 'Gdk', 'GdkPixbuf', 'Gio',
    'GLib', 'GObject', 'Graphene', 'Gtk', 'Meta', 'Pango', 'PangoCairo',
    'Shell', 'Soup', 'St',
]);

// Real globals in the GJS / GNOME Shell environment — never imported.
const AMBIENT = new Set([
    'global', 'imports', 'log', 'logError', 'print', 'printerr', 'console',
    'Debugger', 'ARGV', 'pkg', 'window', 'globalThis',
]);

// Directories excluded from the shipped extension (see .extensionignore).
const SKIP_DIRS = new Set(['node_modules', '.git', 'tmp', 'ui', 'po', 'locale']);

function walk(dir, out = []) {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            if (!SKIP_DIRS.has(entry)) walk(full, out);
        } else if (entry.endsWith('.js')) {
            out.push(full);
        }
    }
    return out;
}

/** Blank out comments and string/template literals so matches are code-only. */
function stripNonCode(src) {
    let out = '';
    let i = 0;
    const blank = s => s.replace(/[^\n]/g, ' ');
    while (i < src.length) {
        const two = src.slice(i, i + 2);
        if (two === '//') {
            const end = src.indexOf('\n', i);
            const stop = end === -1 ? src.length : end;
            out += blank(src.slice(i, stop));
            i = stop;
        } else if (two === '/*') {
            const end = src.indexOf('*/', i + 2);
            const stop = end === -1 ? src.length : end + 2;
            out += blank(src.slice(i, stop));
            i = stop;
        } else if (src[i] === '"' || src[i] === "'" || src[i] === '`') {
            const quote = src[i];
            let j = i + 1;
            while (j < src.length) {
                if (src[j] === '\\') { j += 2; continue; }
                if (src[j] === quote) { j++; break; }
                j++;
            }
            out += quote + blank(src.slice(i + 1, Math.max(j - 1, i + 1))) + (quote);
            // keep length roughly aligned; exact columns are not reported
            i = j;
        } else {
            out += src[i];
            i++;
        }
    }
    return out;
}

/** Parse `import ... from '...'` statements into binding records. */
function parseImports(src) {
    const bindings = [];
    const re = /^\s*import\s+([^;]+?)\s+from\s+['"]([^'"]+)['"]\s*;?/gm;
    let m;
    while ((m = re.exec(src)) !== null) {
        const [, clause, spec] = m;
        const line = src.slice(0, m.index).split('\n').length;
        const named = clause.match(/\{([^}]*)\}/);
        if (named) {
            for (const part of named[1].split(',')) {
                const t = part.trim();
                if (!t) continue;
                const [orig, alias] = t.split(/\s+as\s+/).map(s => s.trim());
                bindings.push({ local: alias || orig, imported: orig, spec, line });
            }
        }
        const star = clause.match(/\*\s+as\s+([A-Za-z0-9_$]+)/);
        if (star) bindings.push({ local: star[1], imported: '*', spec, line });

        const def = clause.replace(/\{[^}]*\}/, '').replace(/\*\s+as\s+[A-Za-z0-9_$]+/, '');
        for (const part of def.split(',')) {
            const t = part.trim();
            if (t && /^[A-Za-z0-9_$]+$/.test(t))
                bindings.push({ local: t, imported: 'default', spec, line });
        }
    }
    return bindings;
}

/** Collect names a module exports. */
function parseExports(src) {
    const names = new Set();
    for (const m of src.matchAll(/^\s*export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z0-9_$]+)/gm))
        names.add(m[1]);
    for (const m of src.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
        for (const part of m[1].split(',')) {
            const t = part.trim();
            if (!t) continue;
            const [orig, alias] = t.split(/\s+as\s+/).map(s => s.trim());
            names.add(alias || orig);
        }
    }
    if (/^\s*export\s+default\b/m.test(src)) names.add('default');
    if (/^\s*export\s+\*/m.test(src)) names.add('*wildcard*');
    return names;
}

const files = walk(ROOT).sort();
const exportCache = new Map();
const errors = [];

for (const file of files) {
    const rel = relative(ROOT, file);
    const raw = readFileSync(file, 'utf8');
    const code = stripNonCode(raw);
    const bindings = parseImports(raw);
    const imported = new Set(bindings.map(b => b.local));

    // Body = code with import statements removed, so an import line does not
    // count as a "use" of its own binding.
    const body = code.replace(/^\s*import\s+[^;]+?\s+from\s+['"][^'"]+['"]\s*;?/gm, '');

    // 1. Undefined namespace.
    const seen = new Set();
    for (const m of body.matchAll(/\b([A-Z][A-Za-z0-9_]*)\s*\./g)) {
        const name = m[1];
        if (seen.has(name)) continue;
        seen.add(name);
        if (!GI_NAMESPACES.has(name)) continue;
        if (imported.has(name) || AMBIENT.has(name)) continue;
        const line = body.slice(0, m.index).split('\n').length;
        errors.push(`${rel}:${line}: uses '${name}.' but never imports ${name}`);
    }

    // 2. Missing export on relative imports.
    for (const b of bindings) {
        if (!b.spec.startsWith('.')) continue;
        if (b.imported === '*' || b.imported === 'default') continue;
        const target = resolve(dirname(file), b.spec);
        if (!exportCache.has(target)) {
            try {
                exportCache.set(target, parseExports(readFileSync(target, 'utf8')));
            } catch {
                errors.push(`${rel}:${b.line}: imports from missing file '${b.spec}'`);
                exportCache.set(target, null);
            }
        }
        const exp = exportCache.get(target);
        if (!exp || exp.has('*wildcard*')) continue;
        if (!exp.has(b.imported))
            errors.push(`${rel}:${b.line}: '${b.imported}' is not exported by ${b.spec}`);
    }

    // 3. Shadowed logger helpers.
    if (!file.endsWith('util/logger.js')) {
        for (const name of ['log', 'logError']) {
            if (imported.has(name)) continue;
            const m = body.match(new RegExp(`(^|[^\\w.])${name}\\s*\\(`));
            if (m) {
                const line = body.slice(0, m.index).split('\n').length;
                errors.push(`${rel}:${line}: calls ${name}() but does not import it ` +
                            `from logger.js (falls through to the GJS global)`);
            }
        }
    }

    // 4. Unused imports.
    for (const b of bindings) {
        const re = new RegExp(`\\b${b.local.replace(/\$/g, '\\$')}\\b`);
        if (!re.test(body))
            errors.push(`${rel}:${b.line}: unused import '${b.local}'`);
    }
}

if (errors.length) {
    for (const e of errors) console.error(`FAIL ${e}`);
    console.error(`\n${errors.length} problem(s) in ${files.length} files.`);
    process.exit(1);
}
console.log(`All imports resolve. (${files.length} files)`);

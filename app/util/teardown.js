import { logError } from './logger.js';

/**
 * Teardown registry for preferences pages.
 *
 * Pages connect handlers to objects that outlive them: the shared
 * AppConfig.getSettings() singleton, org.gnome.shell settings, D-Bus proxies.
 * Disconnecting on the page's 'destroy' signal is unreliable, because a
 * handler closure that references the page keeps the page alive, so
 * 'destroy' never fires and the handler is never removed. Every visit then
 * adds another live handler running against an off-screen page.
 *
 * Instead, window.js builds each page inside collectTeardown() and runs the
 * collected teardown explicitly when the page leaves the navigation stack
 * or the window closes. Pages register work through pageScope(), which
 * binds to the page being built and stays valid for asynchronous callbacks
 * made after the build returns.
 */

let current = null;

/**
 * Run `build` with a fresh teardown list as the current scope.
 * @param {Function} build - returns the page widget
 * @returns {{result: *, teardown: Array<Function>}}
 */
export function collectTeardown(build) {
    const prev = current;
    const teardown = [];
    teardown.disposed = false;
    current = teardown;
    try {
        return { result: build(), teardown };
    } catch (e) {
        // Release whatever the failed build registered before it threw.
        runTeardown(teardown);
        throw e;
    } finally {
        current = prev;
    }
}

/**
 * Run and clear a teardown list. Idempotent: a list runs at most once, and
 * anything registered on it afterwards runs immediately (see pageScope()).
 * @param {Array<Function>} teardown
 */
export function runTeardown(teardown) {
    if (!teardown || teardown.disposed) return;
    teardown.disposed = true;
    for (const fn of teardown.splice(0).reverse()) {
        try {
            fn();
        } catch (e) {
            logError('Page teardown step failed', e);
        }
    }
}

/**
 * Handle for the page currently being built.
 *
 * Throws outside a page build: a handler registered there would never be
 * torn down, which is the leak this module exists to prevent.
 *
 * @returns {{connect: Function, add: Function}}
 */
export function pageScope() {
    const teardown = current;
    if (!teardown)
        throw new Error('pageScope() called outside a page build (collectTeardown)');

    const add = (fn) => {
        // The page may already be gone when an async callback registers.
        if (teardown.disposed) {
            try { fn(); } catch (e) { logError('Late teardown step failed', e); }
            return;
        }
        teardown.push(fn);
    };

    const connect = (obj, signal, handler) => {
        const id = obj.connect(signal, handler);
        add(() => obj.disconnect(id));
        return id;
    };

    return { connect, add };
}

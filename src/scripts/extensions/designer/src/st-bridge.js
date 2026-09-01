// @ts-check

/**
 * Lazy bridge to the SillyTavern main modules. The Designer extension ships as
 * its own bundle, so it must NOT statically import the app modules (that would
 * duplicate the whole app). Instead the modules are imported at runtime from
 * the served tree — the same pattern used by agent-run-controller.js.
 * `webpackIgnore` keeps rspack from bundling or resolving these specifiers.
 */

/** @returns {Promise<typeof import('/script.js')>} */
async function importScriptModule() {
    return import('/script.js' /* webpackIgnore: true */);
}

/** @returns {Promise<typeof import('/scripts/world-info.js')>} */
async function importWorldInfoModule() {
    return import('/scripts/world-info.js' /* webpackIgnore: true */);
}

/** @returns {Promise<typeof import('/scripts/preset-manager.js')>} */
async function importPresetManagerModule() {
    return import('/scripts/preset-manager.js' /* webpackIgnore: true */);
}

/** @returns {Promise<typeof import('/scripts/sysprompt.js')>} */
async function importSyspromptModule() {
    return import('/scripts/sysprompt.js' /* webpackIgnore: true */);
}

/** @returns {Promise<typeof import('/scripts/power-user.js')>} */
async function importPowerUserModule() {
    return import('/scripts/power-user.js' /* webpackIgnore: true */);
}

/**
 * Cached lazy accessors for the ST modules used by the Designer tools.
 */
export function createStBridge() {
    /** @type {Promise<any> | null} */
    let scriptPromise = null;
    /** @type {Promise<any> | null} */
    let worldInfoPromise = null;
    /** @type {Promise<any> | null} */
    let presetManagerPromise = null;
    /** @type {Promise<any> | null} */
    let syspromptPromise = null;
    /** @type {Promise<any> | null} */
    let powerUserPromise = null;

    return {
        loadScript: () => scriptPromise ??= importScriptModule(),
        loadWorldInfo: () => worldInfoPromise ??= importWorldInfoModule(),
        loadPresetManager: () => presetManagerPromise ??= importPresetManagerModule(),
        loadSysprompt: () => syspromptPromise ??= importSyspromptModule(),
        loadPowerUser: () => powerUserPromise ??= importPowerUserModule(),
    };
}

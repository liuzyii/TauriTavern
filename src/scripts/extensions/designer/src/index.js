// @ts-check

import {
    characters,
    this_chid,
    getCharacters,
    getOneCharacter,
    deleteCharacter,
    getRequestHeaders,
} from '../../../script.js';
import {
    worldInfoCache,
    saveWorldInfo,
    deleteWorldInfoEntry,
    deleteWorldInfo,
    getFreeWorldEntryUid,
    newWorldInfoEntryTemplate,
} from '../../world-info.js';
import { getPresetManager } from '../../preset-manager.js';
import { system_prompts } from '../../sysprompt.js';
import { power_user } from '../../power-user.js';
import { createRevLock } from './rev-lock.js';
import { buildUnifiedTools } from './build-tools.js';
import { createCharacterResource } from './character-tools.js';
import { createWorldInfoResource } from './world-info-tools.js';
import { createPromptResource } from './prompt-tools.js';
import { DESIGNER_GUIDANCE } from './guidance.js';

const DESIGNER_PROMPT_KEY = 'designer';

/**
 * Shared ST module bindings handed to the resource adapters. Follows the
 * upstream extension pattern: the extension lives in the same module graph as
 * the app, so these are plain static imports (no runtime loading hacks).
 */
const script = { characters, this_chid, getCharacters, getOneCharacter, deleteCharacter, getRequestHeaders };
const worldInfo = {
    worldInfoCache,
    saveWorldInfo,
    deleteWorldInfoEntry,
    deleteWorldInfo,
    getFreeWorldEntryUid,
    newWorldInfoEntryTemplate,
};
const presetManager = { getPresetManager };
const sysprompt = { system_prompts };
const powerUser = { power_user };

/** @param {any} context */
function functionCallingEnabled(context) {
    return Boolean(context?.chatCompletionSettings?.function_calling);
}

/** @param {any} context */
function registerTools(context) {
    const revLock = createRevLock();
    const resources = [
        createCharacterResource({ script, revLock }),
        createWorldInfoResource({ worldInfo, revLock }),
        createPromptResource({ presetManager, sysprompt, powerUser, revLock }),
    ];
    const tools = buildUnifiedTools(resources);
    for (const tool of tools) {
        context.registerFunctionTool(tool);
    }
    console.info(`[Designer] Registered ${tools.length} function tools.`);
}

/**
 * Injects the short Designer guidance as an extension prompt. The filter is
 * evaluated at prompt assembly time, so the guidance only appears while
 * "Enable function calling" is on, and disappears automatically when it is
 * turned off.
 * @param {any} context
 */
function syncGuidance(context) {
    context.setExtensionPrompt(
        DESIGNER_PROMPT_KEY,
        DESIGNER_GUIDANCE,
        0, // INJECTION_POSITION.RELATIVE
        0, // depth
        false, // scan
        undefined, // role -> SYSTEM
        () => functionCallingEnabled(context),
    );
}

/** Resolves the SillyTavern extension context once the app is ready. */
async function getStContext() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (typeof window.SillyTavern?.getContext === 'function') {
            return window.SillyTavern.getContext();
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('designer.context_unavailable: SillyTavern context is not available');
}

/**
 * Manifest "hooks.activate" entry point (upstream extension pattern, same as
 * stable-diffusion's exported init()).
 */
export async function init() {
    try {
        const context = await getStContext();
        registerTools(context);
        syncGuidance(context);
    } catch (error) {
        console.error('[Designer] Failed to initialize:', error);
    }
}

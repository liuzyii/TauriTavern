// @ts-check

import {
    characters,
    this_chid,
    getCharacters,
    getOneCharacter,
    deleteCharacter,
    getRequestHeaders,
    saveSettingsDebounced,
} from '../../../script.js';
import { eventSource, event_types } from '../../events.js';
import { user_avatar } from '../../personas.js';
import {
    worldInfoCache,
    saveWorldInfo,
    deleteWorldInfoEntry,
    deleteWorldInfo,
    getFreeWorldEntryUid,
    newWorldInfoEntryTemplate,
    showWorldEditor,
    updateWorldInfoList,
} from '../../world-info.js';
import { getPresetManager } from '../../preset-manager.js';
import { system_prompts } from '../../sysprompt.js';
import { power_user } from '../../power-user.js';
import { createRevLock } from './rev-lock.js';
import { buildUnifiedTools } from './build-tools.js';
import { buildDesignerContext } from './common.js';
import { createCharacterResource } from './character-tools.js';
import { createWorldInfoResource } from './world-info-tools.js';
import { createPromptResource } from './prompt-tools.js';
import { createPersonaResource } from './persona-tools.js';
import { DESIGNER_GUIDANCE } from './guidance.js';

const DESIGNER_PROMPT_KEY = 'designer';
const DESIGNER_CONTEXT_KEY = 'designer-context';

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
const personas = { user_avatar };

/**
 * Frontend sync after tool writes: the data layer updates the live in-memory
 * objects (readable by the LLM immediately), but open UI panels need an
 * explicit re-render. These hooks stay DOM-side (index.js only) so resource
 * adapters remain pure and testable. Errors are swallowed — UI refresh is
 * best-effort and must never fail a tool call.
 */
const syncUi = {
    /** Re-render the world info editor when it currently shows the touched book. */
    async entryChanged(book) {
        try {
            const select = document.querySelector('#world_editor_select');
            if (!select || select.selectedIndex < 0) {
                return;
            }
            const openName = select.options[select.selectedIndex]?.text;
            if (openName && String(openName).toLowerCase() === String(book).toLowerCase()) {
                await showWorldEditor(openName);
            }
        } catch (error) {
            console.warn('[Designer] World info editor sync failed:', error);
        }
    },
    /** Rebuild the world info book dropdowns (create/delete book). */
    async bookListChanged() {
        try {
            await updateWorldInfoList();
        } catch (error) {
            console.warn('[Designer] World info list sync failed:', error);
        }
    },
};

/** Notify listeners (prompt overrides, agent system) that a card changed. */
async function emitCharacterEdited(avatar) {
    try {
        const index = characters.findIndex((c) => c.avatar === avatar);
        if (index === -1) {
            return;
        }
        await eventSource.emit(event_types.CHARACTER_EDITED, { detail: { id: index, character: characters[index] } });
    } catch (error) {
        console.warn('[Designer] Character edited event failed:', error);
    }
}

/** @param {any} context */
function functionCallingEnabled(context) {
    return Boolean(context?.chatCompletionSettings?.function_calling);
}

/** @param {any} context */
function registerTools(context) {
    const revLock = createRevLock();
    const resources = [
        createCharacterResource({ script, revLock, onChanged: emitCharacterEdited }),
        createWorldInfoResource({ worldInfo, revLock, syncUi }),
        createPromptResource({ presetManager, sysprompt, powerUser, revLock }),
        createPersonaResource({
            personas,
            powerUser,
            saveSettings: saveSettingsDebounced,
            emit: (type, payload) => eventSource.emit(event_types[type], payload),
            revLock,
        }),
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

/** Snapshot of the current design objects for the dynamic context prompt. */
function currentDesignerContextState() {
    const books = [];
    for (const name of worldInfoCache.keys()) {
        const data = worldInfoCache.get(name);
        books.push({ name, entries: data?.entries ? Object.keys(data.entries).length : 0 });
    }
    const personaId = personas.user_avatar;
    return {
        characters: characters.map((c) => ({ avatar: c.avatar, name: c.name || c.data?.name || '' })),
        personaId,
        personaName: personaId ? power_user.personas?.[personaId] : undefined,
        books,
        prompts: system_prompts.map((p) => p.name),
        activePrompt: power_user.sysprompt?.enabled ? power_user.sysprompt.name : undefined,
    };
}

/**
 * Refreshes the dynamic context prompt with the current object list. Runs
 * before every generation (manifest "generate_interceptor", same mechanism as
 * stable-diffusion), so the list stays fresh even across tool-loop rounds —
 * objects created mid-conversation appear on the very next request. The
 * function-calling filter keeps it invisible when tools are not injected.
 */
export async function designerGenerateInterceptor() {
    const context = window.SillyTavern?.getContext?.();
    if (!context) {
        return;
    }
    context.setExtensionPrompt(
        DESIGNER_CONTEXT_KEY,
        buildDesignerContext(currentDesignerContextState()),
        0,
        0,
        false,
        undefined,
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
        await designerGenerateInterceptor();
    } catch (error) {
        console.error('[Designer] Failed to initialize:', error);
    }
}

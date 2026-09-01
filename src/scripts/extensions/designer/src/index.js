// @ts-check

import { createStBridge } from './st-bridge.js';
import { createRevLock } from './rev-lock.js';
import { buildDesignerTools } from './build-tools.js';
import { createCharacterResource } from './character-tools.js';
import { createWorldInfoResource } from './world-info-tools.js';
import { createPromptResource } from './prompt-tools.js';
import { DESIGNER_GUIDANCE } from './guidance.js';

const DESIGNER_PROMPT_KEY = 'designer';

/** @param {any} context */
function functionCallingEnabled(context) {
    return Boolean(context?.chatCompletionSettings?.function_calling);
}

/** @param {any} context */
function registerTools(context) {
    const st = createStBridge();
    const revLock = createRevLock();
    const resources = [
        createCharacterResource({ st, revLock }),
        createWorldInfoResource({ st, revLock }),
        createPromptResource({ st, revLock }),
    ];
    const tools = buildDesignerTools(resources);
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

async function main() {
    try {
        const context = await getStContext();
        registerTools(context);
        syncGuidance(context);
    } catch (error) {
        console.error('[Designer] Failed to initialize:', error);
    }
}

void main();

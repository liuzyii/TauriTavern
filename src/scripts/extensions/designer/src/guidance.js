// @ts-check

/**
 * Short system-role guidance injected while function calling is enabled. It
 * keeps the tools discoverable in every eligible chat while telling the model
 * when (and how) to use them. Structured in short labeled sections so the
 * model can parse the contract at a glance; kept compact (~200 words).
 *
 * This constant is the single source of truth: the extension injects it and
 * scripts/designer-deepseek-e2e.mjs uses the exact same text for perception
 * testing.
 */
export const DESIGNER_GUIDANCE = [
    'Designer tools (target: "character" | "persona" | "world_info" | "prompt"): use read, create, update, and delete to edit the character card, the user persona, world info (lorebooks), and system prompt presets.',
    '',
    'When to use: only when the user explicitly asks to create, modify, or inspect design content. Never during ordinary roleplay or casual conversation.',
    '',
    'How to use:',
    '- read first: it returns the object (or the list of existing objects) with its rev. If the requested object does not exist, use create (personas are created in the UI).',
    '- update and delete require the rev from a recent read.',
    '- update replaces the COMPLETE object: copy every field from the read result and change only what you need. Missing non-empty fields are rejected; missing empty fields and explicit nulls keep their current values.',
    '',
    'Examples:',
    '- create({target:"character", card:{name:"Mira", description:"A wandering fortune-teller."}}) — create only needs the fields you want to set.',
    '- read({target:"world_info", book:"Mira\'s World", uid:"0"}) returns the entry and its rev.',
    '- update({target:"world_info", book:"Mira\'s World", uid:"0", rev:"<rev from read>", entry:{...every field from the read result, changed as needed...}}) — the read result already shows the full object; copy it.',
    '',
    'Changes apply immediately and are shown in the chat.',
].join('\n');

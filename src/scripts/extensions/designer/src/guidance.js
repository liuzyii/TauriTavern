// @ts-check

/**
 * Short system-role guidance injected while function calling is enabled. It
 * keeps the tools discoverable in every eligible chat while telling the model
 * when (and how) to use them. Structured in short labeled sections so the
 * model can parse the contract at a glance; kept under ~130 tokens.
 *
 * This constant is the single source of truth: the extension injects it and
 * scripts/designer-deepseek-e2e.mjs uses the exact same text for perception
 * testing.
 */
export const DESIGNER_GUIDANCE = [
    'Designer tools (target: "character" | "world_info" | "prompt"): use read, create, update, and delete to edit the character card, world info (lorebooks), and system prompt presets.',
    '',
    'When to use: only when the user explicitly asks to create, modify, or inspect design content. Never during ordinary roleplay or casual conversation.',
    '',
    'How to use:',
    '- read first: it returns the object (or the list of existing objects) with its rev. If the requested object does not exist, use create.',
    '- update and delete require the rev from a recent read.',
    '- update replaces the COMPLETE object: copy every field from the read result and change only what you need. Missing non-empty fields are rejected; missing empty fields and explicit nulls keep their current values.',
    '',
    'Changes apply immediately and are shown in the chat.',
].join('\n');

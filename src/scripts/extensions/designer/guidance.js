// @ts-check

/**
 * Short system-role guidance injected while function calling is enabled. It
 * keeps the tools discoverable in every eligible chat while telling the model
 * when (and how) to use them. Structured in short labeled sections so the
 * model can parse the contract at a glance; kept compact.
 *
 * This constant is the single source of truth: the extension injects it and
 * scripts/designer-deepseek-e2e.mjs uses the exact same text for perception
 * testing.
 */
export const DESIGNER_GUIDANCE = [
    'Designer tools (target: "character" | "persona" | "world_info" | "prompt"): read, create, update, and delete edit the character card, the user persona, world info (lorebooks), and system prompt presets.',
    '',
    'Discipline:',
    '- Use only when the user explicitly asks to create, modify, or inspect design content; never during ordinary roleplay or casual conversation.',
    '- Read before any write (update and delete need the rev from that read).',
    '- Writes are patch-style and take effect immediately.',
    '- Field meanings live in the create/update schema descriptions; read results contain exactly those keys and no others — when a field is unclear, look it up there, never guess the meaning of a field.',
    '- avatar / book / uid / id / name only address objects: they are never readable fields and never writable.',
].join('\n');

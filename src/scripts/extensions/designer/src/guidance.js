// @ts-check

/**
 * Short system-role guidance injected while function calling is enabled. It
 * keeps the tools discoverable in every eligible chat while telling the model
 * when (and how) to use them: read first, carry the rev, and only act when the
 * user asks for design work. Kept intentionally small (~100 tokens).
 *
 * This constant is the single source of truth: the extension injects it and
 * scripts/designer-deepseek-e2e.mjs uses the exact same text for perception
 * testing.
 */
export const DESIGNER_GUIDANCE = 'Never use these tools during ordinary roleplay or casual conversation. Only use them when the user explicitly asks you to create, modify, or inspect the character card, world info (lorebooks), or system prompt presets. Always read an object first to obtain its rev, then pass that same rev to update_/delete_. When updating, send the COMPLETE object: copy every field from the read result and change only what you need; partial updates are rejected. Changes apply immediately and are shown in the chat.';

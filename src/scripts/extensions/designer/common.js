// @ts-check

/**
 * Shared helpers for the Designer extension: parameter normalization, field
 * whitelists, error codes, read-result truncation, and ToolManager-friendly
 * tool definition assembly.
 */

export function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Builds a recoverable tool error. Throwing it marks the invocation as failed
 * in the chat (error tool message) while the message text stays readable by
 * the model, so it can correct its parameters and retry.
 * @param {string} code
 * @param {string} message
 * @returns {Error}
 */
export function designerError(code, message) {
    const error = new Error(`${code}: ${message}`);
    error.code = code;
    return error;
}

/**
 * Models occasionally double-wrap the editable object (e.g. card nested under
 * another card or under ST's internal `data` key). Unwrap single-key wrappers
 * while the outer object holds none of the editable fields, bounded to a few
 * levels. Unambiguous, so the read surface contract is untouched.
 * @param {any} value
 * @param {string[]} fields
 * @param {string[]} [wrapperKeys]
 */
export function unwrapNestedPayload(value, fields, wrapperKeys = ['card', 'data']) {
    let current = value;
    for (let depth = 0; depth < 3 && isPlainObject(current); depth += 1) {
        const keys = Object.keys(current);
        if (keys.some((key) => fields.includes(key))) {
            break; // Already a flat editable object.
        }
        if (keys.length !== 1 || !wrapperKeys.includes(keys[0])) {
            break;
        }
        const nested = current[keys[0]];
        if (!isPlainObject(nested)) {
            break;
        }
        current = nested;
    }
    return current;
}

export function truncateText(text, maxChars) {
    const value = String(text ?? '');
    if (!(maxChars > 0) || value.length <= maxChars) {
        return value;
    }
    return `${value.slice(0, maxChars)}…[truncated ${value.length - maxChars} chars]`;
}

export function pickFields(object, fields) {
    const out = {};
    for (const field of fields) {
        if (field in object) {
            out[field] = object[field];
        }
    }
    return out;
}

/**
 * Resolves the `fields` parameter of a read tool. Omitted means "all
 * readable fields"; a provided list must be a non-empty subset of the
 * readable (and writable) surface for the target.
 * @param {unknown} fields
 * @param {string[]} available
 * @param {string} label
 * @returns {string[]}
 */
export function normalizeFieldSelection(fields, available, label) {
    if (fields === undefined || fields === null) {
        return available;
    }
    if (!Array.isArray(fields) || fields.length === 0) {
        throw designerError('designer.invalid_fields', `${label} fields must be a non-empty array of field names.`);
    }
    const list = [...new Set(fields.map((field) => String(field).trim()).filter(Boolean))];
    if (list.length === 0) {
        throw designerError('designer.invalid_fields', `${label} fields must be a non-empty array of field names.`);
    }
    const unknown = list.filter((field) => !available.includes(field));
    if (unknown.length > 0) {
        throw designerError(
            'designer.invalid_fields',
            `Unknown ${label} field(s): ${unknown.join(', ')}. Available fields: ${available.join(', ')}.`,
        );
    }
    return list;
}

/**
 * Truncates long string fields of a read result. Arrays and nested objects
 * stay verbatim so read values are never summarized into counts or shapes —
 * the model needs exact values to display or patch them.
 * @param {Record<string, any>} object
 * @param {number} maxChars
 */
export function limitObjectStrings(object, maxChars) {
    const out = {};
    for (const [key, value] of Object.entries(object)) {
        if (typeof value === 'string') {
            out[key] = truncateText(value, maxChars);
        } else {
            out[key] = value;
        }
    }
    return out;
}

export function requireString(value, label) {
    const text = String(value ?? '').trim();
    if (!text) {
        throw designerError('designer.required', `${label} is required.`);
    }
    return text;
}

export function optionalString(value) {
    if (value === null || value === undefined) {
        return undefined;
    }
    const text = String(value).trim();
    return text || undefined;
}

/**
 * Normalizes the maxChars read parameter.
 * @param {unknown} value
 * @param {number} [defaultMax]
 */
export function normalizeMaxChars(value, defaultMax = 200_000) {
    if (value === undefined || value === null) {
        return defaultMax;
    }
    const maxChars = Number(value);
    if (!Number.isInteger(maxChars) || maxChars <= 0 || maxChars > 1_000_000) {
        throw designerError('designer.invalid_maxChars', 'maxChars must be an integer between 1 and 1000000.');
    }
    return maxChars;
}

/**
 * Verifies a rev against the lock and throws the recoverable designer error
 * (including the current rev) when it fails. Returns the verified rev.
 * @param {ReturnType<import('./rev-lock.js').createRevLock>} revLock
 * @param {string} key
 * @param {unknown} suppliedRev
 * @param {any} currentValue
 * @returns {Promise<string>}
 */
export async function verifyRevOrThrow(revLock, key, suppliedRev, currentValue) {
    const verified = await revLock.verify(key, suppliedRev, currentValue);
    if (!verified.ok) {
        throw designerError(verified.code, verified.message);
    }
    return verified.rev;
}

export function normalizeBoolean(value, label) {
    if (typeof value !== 'boolean') {
        throw designerError('designer.invalid_boolean', `${label} must be a boolean.`);
    }
    return value;
}

export function normalizeInteger(value, label, { min, max } = {}) {
    const number = Number(value);
    if (!Number.isInteger(number)
        || (min !== undefined && number < min)
        || (max !== undefined && number > max)) {
        const bounds = [
            min !== undefined ? ` >= ${min}` : '',
            max !== undefined ? ` <= ${max}` : '',
        ].join('');
        throw designerError('designer.invalid_number', `${label} must be an integer${bounds}.`);
    }
    return number;
}

export function normalizeNumber(value, label, { min, max } = {}) {
    const number = Number(value);
    if (!Number.isFinite(number)
        || (min !== undefined && number < min)
        || (max !== undefined && number > max)) {
        const bounds = [
            min !== undefined ? ` >= ${min}` : '',
            max !== undefined ? ` <= ${max}` : '',
        ].join('');
        throw designerError('designer.invalid_number', `${label} must be a number${bounds}.`);
    }
    return number;
}

/** @type {string[]} */
export const CHARACTER_STRING_FIELDS = [
    'name',
    'description',
    'personality',
    'scenario',
    'first_mes',
    'mes_example',
    'system_prompt',
    'post_history_instructions',
    'creator_notes',
    'creator',
    'character_version',
];

/** @type {string[]} */
export const CHARACTER_FIELD_LIST = [
    ...CHARACTER_STRING_FIELDS,
    'tags',
    'talkativeness',
    'world',
    'depth_prompt',
];

/**
 * Single source of field semantics: `role` is emitted as the JSON-schema
 * property description on create/update — the complete per-field spec.
 */
export const CHARACTER_FIELD_META = {
    name: { role: 'Display name.' },
    description: { role: 'Persona, voice and style.' },
    personality: { role: 'Traits.' },
    scenario: { role: 'Current scene setup.' },
    first_mes: { role: 'Opening greeting.' },
    mes_example: { role: 'Example dialogue that anchors the writing style (few-shot).' },
    system_prompt: { role: 'Extra instructions injected with the card.' },
    post_history_instructions: { role: 'Instructions injected after the chat history.' },
    creator_notes: { role: 'Author notes (metadata, not injected).' },
    creator: { role: 'Author name (metadata).' },
    character_version: { role: 'Card version (metadata).' },
    tags: { role: 'Freeform labels (not injected).' },
    talkativeness: { role: 'Verbosity: 0 = terse, 1 = verbose.' },
    world: { role: 'Name of the primary lorebook attached to this character.' },
    depth_prompt: { role: 'Recurring instruction injected at a chosen depth.' },
};

export const CHARACTER_MAX_STRING_LENGTH = 200_000;
export const CHARACTER_MAX_TAGS = 100;
export const CHARACTER_MAX_TAG_LENGTH = 200;

function normalizeTags(value) {
    if (!Array.isArray(value)) {
        throw designerError('designer.invalid_tags', 'tags must be an array of strings.');
    }
    if (value.length > CHARACTER_MAX_TAGS) {
        throw designerError('designer.invalid_tags', `tags must contain at most ${CHARACTER_MAX_TAGS} items.`);
    }
    return value.map((item) => {
        const tag = String(item).trim();
        if (!tag || tag.length > CHARACTER_MAX_TAG_LENGTH) {
            throw designerError('designer.invalid_tags', `Each tag must be a non-empty string of at most ${CHARACTER_MAX_TAG_LENGTH} characters.`);
        }
        return tag;
    });
}

function normalizeDepthPrompt(value) {
    if (!isPlainObject(value)) {
        throw designerError('designer.invalid_depth_prompt', 'depth_prompt must be an object with prompt, depth, and role.');
    }
    const prompt = optionalString(value.prompt);
    const depth = value.depth === undefined ? 4 : normalizeInteger(value.depth, 'depth_prompt.depth', { min: 0, max: 100 });
    const role = optionalString(value.role) || 'system';
    return { prompt: prompt || '', depth, role };
}

/**
 * Validates character card fields against the whitelist.
 * @param {Record<string, any>} updates
 * @returns {{fields: Record<string, any>, extensions: Record<string, any>}}
 */
export function normalizeCharacterUpdates(updates) {
    if (!isPlainObject(updates)) {
        throw designerError('designer.invalid_updates', 'updates must be an object.');
    }

    /** @type {Record<string, any>} */
    const fields = {};
    /** @type {Record<string, any>} */
    const extensions = {};

    for (const [key, value] of Object.entries(updates)) {
        // Explicit null / undefined means "keep the current value" (create:
        // leave the field unset). Models routinely emit null for fields they
        // do not want to touch; treating it as a value would clear content.
        if (value === null || value === undefined) {
            continue;
        }
        if (CHARACTER_STRING_FIELDS.includes(key)) {
            const text = String(value ?? '');
            if (text.length > CHARACTER_MAX_STRING_LENGTH) {
                throw designerError('designer.field_too_long', `Field "${key}" exceeds ${CHARACTER_MAX_STRING_LENGTH} characters.`);
            }
            fields[key] = text;
        } else if (key === 'tags') {
            fields[key] = normalizeTags(value);
        } else if (key === 'talkativeness') {
            fields[key] = normalizeNumber(value, 'talkativeness', { min: 0, max: 1 });
        } else if (key === 'world') {
            extensions.world = String(value ?? '');
        } else if (key === 'depth_prompt') {
            extensions.depth_prompt = normalizeDepthPrompt(value);
        } else {
            throw designerError('designer.unknown_field', `Field "${key}" is not editable. Allowed fields: ${CHARACTER_FIELD_LIST.join(', ')}.`);
        }
    }

    return { fields, extensions };
}

/**
 * Builds the create payload for /api/characters/create (JSON branch). The
 * mapper reads flat fields first and falls back to `data.*`.
 * @param {{fields: Record<string, any>, extensions: Record<string, any>}} normalized
 * @returns {Record<string, any>}
 */
export function buildCharacterCreatePayload(normalized) {
    const { fields, extensions } = normalized;
    const payload = { ...fields };
    if (extensions.world !== undefined) {
        payload.world = String(extensions.world);
    }
    if (extensions.talkativeness !== undefined) {
        payload.talkativeness = extensions.talkativeness;
    }
    payload.data = { ...fields };
    if (Object.keys(extensions).length > 0) {
        payload.data.extensions = extensions;
    }
    return payload;
}

/**
 * Builds the update payload for /api/characters/merge-attributes.
 * @param {string} avatar
 * @param {{fields: Record<string, any>, extensions: Record<string, any>}} normalized
 * @returns {Record<string, any>}
 */
export function buildCharacterMergePayload(avatar, normalized) {
    const { fields, extensions } = normalized;
    const body = { avatar, data: { ...fields } };
    if (Object.keys(extensions).length > 0) {
        body.data.extensions = extensions;
    }
    return body;
}

/** @type {string[]} */
export const WORLD_ENTRY_STRING_FIELDS = ['comment', 'content', 'group'];

/** @type {string[]} */
export const WORLD_ENTRY_BOOL_FIELDS = [
    'constant',
    'selective',
    'disable',
    'excludeRecursion',
    'preventRecursion',
];

/** @type {string[]} */
export const WORLD_ENTRY_INT_FIELDS = ['order', 'position', 'delayUntilRecursion', 'depth'];

/** @type {string[]} */
export const WORLD_ENTRY_LIST_FIELDS = ['key', 'keysecondary'];

/** @type {string[]} */
export const WORLD_ENTRY_FIELD_LIST = [
    ...WORLD_ENTRY_STRING_FIELDS,
    ...WORLD_ENTRY_BOOL_FIELDS,
    ...WORLD_ENTRY_INT_FIELDS,
    ...WORLD_ENTRY_LIST_FIELDS,
];

export const WORLD_ENTRY_FIELD_META = {
    key: { role: 'Trigger keywords. The entry activates when the chat matches any of them. There is no title field — the display name belongs in comment.' },
    keysecondary: { role: 'Secondary keywords. Selective entries also need one of these to match.' },
    comment: { role: 'Short label shown in the editor as the entry title (Title/Memo column). Not injected into the prompt.' },
    content: { role: 'Lore text injected when the entry activates. Macros like {{...}} are supported.' },
    constant: { role: 'Always injected; no keyword match needed.' },
    selective: { role: 'Requires a keysecondary match in addition to a key match. Default true.' },
    disable: { role: 'true = entry is off; the UI shows enabled = !disable.' },
    excludeRecursion: { role: 'Recursion guard: controls whether this entry participates in chained activations from other entries.' },
    preventRecursion: { role: 'Recursion guard: controls whether this entry can chain-activate other entries.' },
    order: { role: 'Injection priority at equal depth: higher = earlier. Default 100.' },
    position: { role: 'Placement slot within the depth band. Default 0.' },
    delayUntilRecursion: { role: 'Recursion-delay counter. Default 0.' },
    depth: { role: 'Chat-depth tier: 0 = character definition, 4 = near the newest messages. Default 4.' },
    group: { role: 'Shared group: only one matching member of the group injects.' },
};

export const WORLD_ENTRY_MAX_CONTENT_LENGTH = 500_000;
export const WORLD_ENTRY_MAX_COMMENT_LENGTH = 10_000;
export const WORLD_ENTRY_MAX_KEYWORD_LENGTH = 500;
export const WORLD_ENTRY_MAX_KEYWORDS = 100;

function normalizeKeywords(value, label) {
    const list = Array.isArray(value) ? value : [value];
    if (list.length > WORLD_ENTRY_MAX_KEYWORDS) {
        throw designerError('designer.invalid_keywords', `${label} must contain at most ${WORLD_ENTRY_MAX_KEYWORDS} items.`);
    }
    return list.map((item) => {
        const keyword = String(item).trim();
        if (!keyword || keyword.length > WORLD_ENTRY_MAX_KEYWORD_LENGTH) {
            throw designerError('designer.invalid_keywords', `${label} items must be non-empty strings of at most ${WORLD_ENTRY_MAX_KEYWORD_LENGTH} characters.`);
        }
        return keyword;
    });
}

/**
 * Validates world info entry fields against the whitelist.
 * @param {Record<string, any>} updates
 * @returns {Record<string, any>}
 */
export function normalizeWorldEntryUpdates(updates) {
    if (!isPlainObject(updates)) {
        throw designerError('designer.invalid_updates', 'updates must be an object.');
    }

    /** @type {Record<string, any>} */
    const normalized = {};

    for (const [key, value] of Object.entries(updates)) {
        // Explicit null / undefined means "keep the current value".
        if (value === null || value === undefined) {
            continue;
        }
        if (key === 'content' || key === 'comment') {
            const limit = key === 'content' ? WORLD_ENTRY_MAX_CONTENT_LENGTH : WORLD_ENTRY_MAX_COMMENT_LENGTH;
            const text = String(value ?? '');
            if (text.length > limit) {
                throw designerError('designer.field_too_long', `${key} exceeds ${limit} characters.`);
            }
            normalized[key] = text;
        } else if (key === 'group') {
            normalized[key] = String(value ?? '');
        } else if (WORLD_ENTRY_BOOL_FIELDS.includes(key)) {
            normalized[key] = normalizeBoolean(value, key);
        } else if (key === 'order') {
            normalized[key] = normalizeInteger(value, key, { min: 0, max: 10_000 });
        } else if (key === 'position') {
            normalized[key] = normalizeInteger(value, key, { min: 0, max: 100 });
        } else if (key === 'delayUntilRecursion') {
            normalized[key] = normalizeInteger(value, key, { min: 0, max: 1000 });
        } else if (key === 'depth') {
            normalized[key] = normalizeInteger(value, key, { min: 0, max: 1000 });
        } else if (key === 'key') {
            normalized[key] = normalizeKeywords(value, 'key');
        } else if (key === 'keysecondary') {
            normalized[key] = normalizeKeywords(value, 'keysecondary');
        } else {
            throw designerError('designer.unknown_field', `Field "${key}" is not editable. Allowed fields: ${WORLD_ENTRY_FIELD_LIST.join(', ')}.`);
        }
    }

    return normalized;
}

/**
 * Normalizes a world info entry for creation. Requires at least one keyword.
 * @param {Record<string, any>} entry
 * @returns {Record<string, any>}
 */
export function normalizeWorldEntryForCreate(entry) {
    if (!isPlainObject(entry)) {
        throw designerError('designer.invalid_entry', 'entry must be an object.');
    }
    const normalized = normalizeWorldEntryUpdates(entry);
    const keys = normalized.key ?? [];
    if (keys.length === 0) {
        throw designerError('designer.entry_key_required', 'A world info entry requires at least one key.');
    }
    return normalized;
}

/**
 * Default human-readable tool call summary shown in the chat.
 * @param {string} name
 * @param {Record<string, any>} params
 */
export function summarizeToolCall(name, params) {
    const keys = Object.keys(isPlainObject(params) ? params : {});
    const summary = keys.length ? keys.join(', ') : 'no arguments';
    return `${name}(${summary})`;
}

/**
 * Builds the dynamic "Designer context" prompt: a compact snapshot of the
 * current design objects, refreshed by the generate interceptor before every
 * request. Ids come first so the model can call read with them directly;
 * names are quoted (they may contain spaces); the active prompt is marked.
 * @param {{
 *   characters: Array<{avatar: string, name: string}>,
 *   personaId?: string,
 *   personaName?: string,
 *   books: Array<{name: string, entries: number}>,
 *   prompts: string[],
 *   activePrompt?: string,
 *   maxItems?: number,
 * }} state
 */
export function buildDesignerContext({ characters, personaId, personaName, books, prompts, activePrompt, maxItems = 20 }) {
    const lines = [];
    const charLines = characters.slice(0, maxItems).map((c) => `${c.avatar} "${c.name}"`);
    if (charLines.length) {
        lines.push(`characters: ${charLines.join(', ')}`);
    }
    if (personaId && personaName) {
        lines.push(`persona: ${personaId} "${personaName}"`);
    }
    const bookLines = books.slice(0, maxItems).map((b) => `"${b.name}" (${b.entries} ${b.entries === 1 ? 'entry' : 'entries'})`);
    if (bookLines.length) {
        lines.push(`world info: ${bookLines.join(', ')}`);
    }
    const promptLines = prompts.slice(0, maxItems).map((p) => (p === activePrompt ? `"${p}" (active)` : `"${p}"`));
    if (promptLines.length) {
        lines.push(`prompts: ${promptLines.join(', ')}`);
    }
    return ['Designer context (current objects; call read for details):', ...lines].join('\n');
}

/**
 * Assembles a ToolManager registration from a raw tool definition.
 * `shouldRegister` stays true: the outer function-calling gate in ST only
 * injects tools when function calling is enabled and supported.
 * @param {{name: string, description: string, parameters: object, action: (params: any) => Promise<any>, formatMessage?: (params: any) => string}} tool
 */
export function toToolDefinition(tool) {
    return {
        name: tool.name,
        displayName: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        action: tool.action,
        formatMessage: tool.formatMessage
            || ((params) => summarizeToolCall(tool.name, params)),
        shouldRegister: () => true,
    };
}

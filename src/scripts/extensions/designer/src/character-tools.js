// @ts-check

import {
    CHARACTER_FIELD_LIST,
    buildCharacterCreatePayload,
    buildCharacterMergePayload,
    designerError,
    isPlainObject,
    limitObjectStrings,
    normalizeCharacterUpdates,
    normalizeMaxChars,
    ok,
    optionalString,
    pickFields,
    requireCompleteFields,
    requireString,
    verifyRevOrThrow,
} from './common.js';

/** Fields returned by read_character when no explicit field list is given. */
const DEFAULT_READ_FIELDS = [
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
    'tags',
    'talkativeness',
    'world',
    'depth_prompt',
];

const MAX_LIST_RESULTS = 200;
const DEFAULT_READ_MAX_CHARS = 200_000;

/**
 * First-class editable view of a character card: world / talkativeness /
 * depth_prompt live under data.extensions in real cards and are surfaced as
 * top-level editable fields here. Both read and update use the same view so
 * defaults and completeness checks stay aligned.
 * @param {Record<string, any>} data
 */
function characterView(data) {
    const extensions = isPlainObject(data.extensions) ? data.extensions : {};
    return {
        ...data,
        world: extensions.world !== undefined ? extensions.world : '',
        talkativeness: extensions.talkativeness !== undefined ? extensions.talkativeness : 0.5,
        depth_prompt: extensions.depth_prompt !== undefined
            ? extensions.depth_prompt
            : { prompt: '', depth: 4, role: 'system' },
    };
}

/** Shared JSON schema properties for the character card (create + update). */
const CHARACTER_CARD_SCHEMA = {
    name: { type: 'string' },
    description: { type: 'string' },
    personality: { type: 'string' },
    scenario: { type: 'string' },
    first_mes: { type: 'string' },
    mes_example: { type: 'string' },
    system_prompt: { type: 'string' },
    post_history_instructions: { type: 'string' },
    creator_notes: { type: 'string' },
    creator: { type: 'string' },
    character_version: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    talkativeness: { type: 'number', description: '0..1' },
    world: { type: 'string', description: 'Primary world info (lorebook) name.' },
    depth_prompt: { type: 'object', description: '{ prompt, depth, role }' },
};

/**
 * Character card resource adapter. The avatar file itself is never modified;
 * it only serves as the (read-only) addressing id.
 * @param {{st: any, revLock: ReturnType<import('./rev-lock.js').createRevLock>, fetchImpl?: typeof fetch}} deps
 */
export function createCharacterResource({ st, revLock, fetchImpl = globalThis.fetch }) {
    const key = (avatar) => `character:${avatar}`;
    const fingerprintTarget = (avatar, data) => ({ avatar, data });

    async function resolveCharacter(avatar) {
        const script = await st.loadScript();
        const normalized = String(avatar).trim();
        const found = script.characters.find((c) => c.avatar === normalized)
            ?? script.characters.find((c) => String(c.avatar).toLowerCase() === normalized.toLowerCase())
            ?? script.characters.find((c) => String(c.name || c.data?.name || '').toLowerCase() === normalized.toLowerCase());
        if (found) {
            return { script, character: found };
        }
        const character = await script.getOneCharacter(avatar);
        if (!character) {
            const available = script.characters
                .slice(0, 20)
                .map((c) => `${c.avatar} (${c.name || c.data?.name || ''})`)
                .join(', ');
            throw designerError(
                'designer.character_not_found',
                `Character "${avatar}" was not found. Available characters: ${available || 'none'}.`,
            );
        }
        return { script, character };
    }

    async function resolveCurrentAvatar(script) {
        const chid = script.this_chid;
        if (chid === undefined || !script.characters[chid]) {
            throw designerError(
                'designer.character_target_required',
                'No active character chat is open. Pass an explicit avatar instead.',
            );
        }
        return script.characters[chid].avatar;
    }

    function normalizeFieldsParam(fields) {
        if (fields === undefined || fields === null) {
            return DEFAULT_READ_FIELDS;
        }
        if (!Array.isArray(fields)) {
            throw designerError('designer.invalid_fields', 'fields must be an array of character field names.');
        }
        const normalized = [...new Set(fields.map((field) => String(field).trim()).filter(Boolean))]
            .filter((field) => CHARACTER_FIELD_LIST.includes(field));
        if (normalized.length === 0) {
            throw designerError('designer.invalid_fields', `fields must be a subset of: ${CHARACTER_FIELD_LIST.join(', ')}.`);
        }
        return normalized;
    }

    async function read(params = {}) {
        const script = await st.loadScript();
        const avatar = optionalString(params.avatar);

        if (!avatar) {
            const characters = script.characters
                .slice(0, MAX_LIST_RESULTS)
                .map((c) => ({ avatar: c.avatar, name: c.name || c.data?.name || '' }))
                .sort((a, b) => a.name.localeCompare(b.name));
            return ok({ characters, count: characters.length });
        }

        const { character } = await resolveCharacter(avatar);
        const fields = normalizeFieldsParam(params.fields);
        const maxChars = normalizeMaxChars(params.maxChars, DEFAULT_READ_MAX_CHARS);
        const data = character.data ?? {};
        const canonicalAvatar = character.avatar;
        const rev = await revLock.issue(key(canonicalAvatar), fingerprintTarget(canonicalAvatar, data));
        const view = characterView(data);
        const selected = pickFields(view, fields);
        const limited = limitObjectStrings(selected, maxChars);

        return ok({
            avatar: canonicalAvatar,
            name: character.name || data.name || '',
            fields: limited,
            rev,
            truncated: JSON.stringify(selected) !== JSON.stringify(limited),
        });
    }

    async function create(params = {}) {
        const script = await st.loadScript();
        if (!isPlainObject(params.card)) {
            throw designerError('designer.invalid_card', 'card must be an object.');
        }
        const name = requireString(params.card.name, 'card.name');
        const normalized = normalizeCharacterUpdates(params.card);
        const payload = buildCharacterCreatePayload(normalized);

        const response = await fetchImpl('/api/characters/create', {
            method: 'POST',
            headers: script.getRequestHeaders(),
            body: JSON.stringify(payload),
        });
        if (!response.ok) {
            throw designerError('designer.character_create_failed', `Character creation failed (HTTP ${response.status}).`);
        }
        const avatar = String(await response.text()).trim();
        if (!avatar) {
            throw designerError('designer.character_create_failed', 'Character creation returned no avatar id.');
        }

        await script.getCharacters();
        const created = script.characters.find((c) => c.avatar === avatar);
        const data = created?.data ?? { ...normalized.fields };
        if (Object.keys(normalized.extensions).length > 0) {
            data.extensions = { ...(data.extensions || {}), ...normalized.extensions };
        }
        const rev = await revLock.commit(key(avatar), fingerprintTarget(avatar, data));

        return ok({ avatar, name, rev });
    }

    async function update(params = {}) {
        const script = await st.loadScript();
        const avatar = optionalString(params.avatar) ?? await resolveCurrentAvatar(script);
        const { character } = await resolveCharacter(avatar);
        const canonicalAvatar = character.avatar;
        const data = character.data ?? {};

        await verifyRevOrThrow(revLock, key(canonicalAvatar), params.rev, fingerprintTarget(canonicalAvatar, data));

        // Complete-object contract: the model must send every editable field
        // that currently holds content (copying unchanged values from the read
        // result); missing empty/default fields are auto-filled, missing
        // non-empty fields are rejected so nothing can be dropped.
        const card = requireCompleteFields(params.card, CHARACTER_FIELD_LIST, 'card', { current: characterView(data) });
        const normalized = normalizeCharacterUpdates(card);

        const body = buildCharacterMergePayload(canonicalAvatar, normalized);
        const response = await fetchImpl('/api/characters/merge-attributes', {
            method: 'POST',
            headers: script.getRequestHeaders(),
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            throw designerError('designer.character_update_failed', `Character update failed (HTTP ${response.status}).`);
        }

        await script.getCharacters();
        const refreshed = script.characters.find((c) => c.avatar === canonicalAvatar);
        const mergedData = refreshed?.data ?? applyMergedUpdates(data, normalized);
        const rev = await revLock.commit(key(canonicalAvatar), fingerprintTarget(canonicalAvatar, mergedData));
        const updated = [...Object.keys(normalized.fields), ...Object.keys(normalized.extensions)];

        return ok({
            avatar: canonicalAvatar,
            name: mergedData.name || character.name || '',
            updated,
            rev,
        });
    }

    async function remove(params = {}) {
        const script = await st.loadScript();
        const avatar = optionalString(params.avatar) ?? await resolveCurrentAvatar(script);
        const { character } = await resolveCharacter(avatar);
        const canonicalAvatar = character.avatar;

        await verifyRevOrThrow(revLock, key(canonicalAvatar), params.rev, fingerprintTarget(canonicalAvatar, character.data ?? {}));

        const deleteChats = params.deleteChats === true;
        const deleted = await script.deleteCharacter(canonicalAvatar, { deleteChats });
        if (!deleted) {
            throw designerError('designer.character_delete_failed', 'Character deletion did not complete.');
        }
        revLock.forget(key(canonicalAvatar));

        return ok({ deleted: canonicalAvatar, deleteChats });
    }

    return {
        name: 'character',
        verbs: {
            read: {
                action: read,
                description: 'List all characters, or read one character card. Use this when the user asks you to design or modify characters. Omit avatar to list characters (avatar and name only). Pass avatar plus optional fields[] and maxChars to read a card; the result includes a rev that update_character/delete_character require. Use this before modifying a character.',
                parameters: {
                    type: 'object',
                    properties: {
                        avatar: { type: 'string', description: 'Character avatar id (e.g. "Seraphina.png"). Omit to list characters.' },
                        fields: {
                            type: 'array',
                            items: { type: 'string' },
                            description: `Character fields to return. Default: ${DEFAULT_READ_FIELDS.join(', ')}.`,
                        },
                        maxChars: { type: 'integer', description: 'Per-field character limit for long text fields (default 200000).' },
                    },
                },
            },
            create: {
                action: create,
                description: 'Create a new character card. card.name is required; other card fields (description, personality, scenario, first_mes, mes_example, system_prompt, post_history_instructions, creator_notes, creator, character_version, tags, talkativeness, world, depth_prompt) are optional. The change applies immediately and is shown in the chat.',
                parameters: {
                    type: 'object',
                    properties: {
                        card: {
                            type: 'object',
                            description: 'Character card data to create.',
                            properties: CHARACTER_CARD_SCHEMA,
                            required: ['name'],
                        },
                    },
                    required: ['card'],
                },
            },
            update: {
                action: update,
                description: 'Replace the editable fields of an existing character card with the COMPLETE card object: copy every field from read_character (name, description, personality, scenario, first_mes, mes_example, system_prompt, post_history_instructions, creator_notes, creator, character_version, tags, talkativeness, world, depth_prompt) and change only what you need; partial cards are rejected with designer.incomplete_update. Requires a rev from read_character so the change is based on the latest state. The avatar file itself is never modified.',
                parameters: {
                    type: 'object',
                    properties: {
                        avatar: { type: 'string', description: 'Character avatar id. Omit to use the character of the current chat.' },
                        rev: { type: 'string', description: 'Revision obtained from read_character.' },
                        card: {
                            type: 'object',
                            description: 'Complete character card data. All fields are required; copy unchanged values from the read result.',
                            properties: CHARACTER_CARD_SCHEMA,
                            required: CHARACTER_FIELD_LIST,
                        },
                    },
                    required: ['rev', 'card'],
                },
            },
            delete: {
                action: remove,
                description: 'Delete an existing character card. Requires a rev from read_character. deleteChats defaults to false (chat files are kept); set it to true only when the user explicitly asks to delete the chats too. This is destructive and irreversible.',
                parameters: {
                    type: 'object',
                    properties: {
                        avatar: { type: 'string', description: 'Character avatar id. Omit to use the character of the current chat.' },
                        rev: { type: 'string', description: 'Revision obtained from read_character.' },
                        deleteChats: { type: 'boolean', description: 'Also delete the character chat files. Default false.' },
                    },
                    required: ['rev'],
                },
            },
        },
    };
}

/**
 * Best-effort local merge used only to compute the next fingerprint when the
 * character list refresh does not return the updated card immediately.
 * @param {Record<string, any>} data
 * @param {{fields: Record<string, any>, extensions: Record<string, any>}} normalized
 */
function applyMergedUpdates(data, normalized) {
    const merged = structuredClone(data || {});
    Object.assign(merged, normalized.fields);
    if (Object.keys(normalized.extensions).length > 0) {
        merged.extensions = { ...(merged.extensions || {}), ...normalized.extensions };
    }
    return merged;
}

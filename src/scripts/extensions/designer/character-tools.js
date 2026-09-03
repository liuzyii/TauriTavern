// @ts-check

import {
    CHARACTER_FIELD_LIST,
    CHARACTER_FIELD_META,
    buildCharacterCreatePayload,
    buildCharacterMergePayload,
    designerError,
    isPlainObject,
    limitObjectStrings,
    normalizeCharacterUpdates,
    normalizeFieldSelection,
    normalizeMaxChars,
    optionalString,
    pickFields,
    requireString,
    unwrapNestedPayload,
    verifyRevOrThrow,
} from './common.js';

const MAX_LIST_RESULTS = 200;
const DEFAULT_READ_MAX_CHARS = 200_000;

/**
 * First-class editable view of a character card: world / talkativeness /
 * depth_prompt live under data.extensions in real cards and are surfaced as
 * top-level editable fields here, so read and update share one field surface.
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

/** Shared JSON schema properties for the character card (create + update).
 *  Descriptions come from CHARACTER_FIELD_META — the single field-spec source. */
const CHARACTER_CARD_TYPES = {
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
    talkativeness: { type: 'number' },
    world: { type: 'string' },
};

const CHARACTER_CARD_SCHEMA = {
    ...Object.fromEntries(Object.entries(CHARACTER_CARD_TYPES).map(([field, def]) => [
        field, { ...def, description: CHARACTER_FIELD_META[field]?.role },
    ])),
    depth_prompt: {
        type: 'object',
        description: CHARACTER_FIELD_META.depth_prompt.role,
        properties: {
            prompt: { type: 'string', description: 'Instruction text injected at the chosen depth.' },
            depth: { type: 'integer', description: '0 = with the character definition; higher = nearer the newest messages.' },
            role: { type: 'string', enum: ['system', 'user'], description: 'Injection role.' },
        },
    },
};

/**
 * Character card resource adapter. The avatar file itself is never modified;
 * it only serves as the (read-only) addressing id.
 * @param {{
 *   script: any,
 *   revLock: ReturnType<import('./rev-lock.js').createRevLock>,
 *   fetchImpl?: typeof fetch,
 *   onChanged?: (avatar: string) => Promise<void> | void,
 * }} deps
 */
export function createCharacterResource({ script, revLock, fetchImpl = globalThis.fetch, onChanged }) {
    const key = (avatar) => `character:${avatar}`;
    const fingerprintTarget = (avatar, data) => ({ avatar, data });

    async function resolveCharacter(avatar) {
        const normalized = String(avatar).trim();
        const found = script.characters.find((c) => c.avatar === normalized)
            ?? script.characters.find((c) => String(c.avatar).toLowerCase() === normalized.toLowerCase())
            ?? script.characters.find((c) => String(c.name || c.data?.name || '').toLowerCase() === normalized.toLowerCase());
        if (found) {
            return found;
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
        return character;
    }

    async function resolveCurrentAvatar() {
        const chid = script.this_chid;
        if (chid === undefined || !script.characters[chid]) {
            throw designerError(
                'designer.character_target_required',
                'No active character chat is open. Pass an explicit avatar instead.',
            );
        }
        return script.characters[chid].avatar;
    }

    async function read(params = {}) {
        const avatar = optionalString(params.avatar);

        if (!avatar) {
            const characters = script.characters
                .slice(0, MAX_LIST_RESULTS)
                .map((c) => ({ avatar: c.avatar, name: c.name || c.data?.name || '' }))
                .sort((a, b) => a.name.localeCompare(b.name));
            return { characters, count: characters.length };
        }

        const character = await resolveCharacter(avatar);
        const maxChars = normalizeMaxChars(params.maxChars, DEFAULT_READ_MAX_CHARS);
        const data = character.data ?? {};
        const canonicalAvatar = character.avatar;
        const view = characterView(data);
        const fields = normalizeFieldSelection(params.fields, CHARACTER_FIELD_LIST, 'character card');
        const selected = pickFields(view, fields);
        const limited = limitObjectStrings(selected, maxChars);
        const truncated = JSON.stringify(selected) !== JSON.stringify(limited);
        const rev = await revLock.issue(key(canonicalAvatar), fingerprintTarget(canonicalAvatar, data));

        return {
            avatar: canonicalAvatar,
            name: character.name || data.name || '',
            card: limited,
            rev,
            truncated,
        };
    }

    async function create(params = {}) {
        const card = unwrapNestedPayload(params.card, CHARACTER_FIELD_LIST);
        if (!isPlainObject(card)) {
            throw designerError('designer.invalid_card', 'card must be an object.');
        }
        requireString(card.name, 'card.name');
        const normalized = normalizeCharacterUpdates(card);
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
        await onChanged?.(avatar);

        return { avatar, rev };
    }

    async function update(params = {}) {
        const avatar = optionalString(params.avatar) ?? await resolveCurrentAvatar();
        const character = await resolveCharacter(avatar);
        const canonicalAvatar = character.avatar;
        const data = character.data ?? {};

        await verifyRevOrThrow(revLock, key(canonicalAvatar), params.rev, fingerprintTarget(canonicalAvatar, data));

        // Patch semantics: only the provided fields change; every field that
        // is omitted keeps its current value. null also means "leave it
        // unchanged"; send '' / [] / {} to clear a field explicitly.
        const card = unwrapNestedPayload(params.card, CHARACTER_FIELD_LIST);
        if (!isPlainObject(card)) {
            throw designerError('designer.invalid_card', 'card must be an object with at least one editable field.');
        }
        const normalized = normalizeCharacterUpdates(card);
        if (Object.keys(normalized.fields).length === 0 && Object.keys(normalized.extensions).length === 0) {
            throw designerError(
                'designer.no_fields',
                `No updatable card fields were provided. Send at least one of: ${CHARACTER_FIELD_LIST.join(', ')}.`,
            );
        }

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
        await onChanged?.(canonicalAvatar);

        return { updated, rev };
    }

    async function remove(params = {}) {
        const avatar = optionalString(params.avatar) ?? await resolveCurrentAvatar();
        const character = await resolveCharacter(avatar);
        const canonicalAvatar = character.avatar;

        await verifyRevOrThrow(revLock, key(canonicalAvatar), params.rev, fingerprintTarget(canonicalAvatar, character.data ?? {}));

        const deleteChats = params.deleteChats === true;
        const deleted = await script.deleteCharacter(canonicalAvatar, { deleteChats });
        if (!deleted) {
            throw designerError('designer.character_delete_failed', 'Character deletion did not complete.');
        }
        revLock.forget(key(canonicalAvatar));

        return { deleted: canonicalAvatar };
    }

    return {
        name: 'character',
        verbs: {
            read: {
                action: read,
                parameters: {
                    type: 'object',
                    properties: {
                        avatar: { type: 'string', description: 'Character avatar id (e.g. "Seraphina.png"). Omit to list characters.' },
                        fields: { type: 'array', items: { type: 'string' }, description: 'Fields to return. Omit for all readable fields; meanings are described in the create/update schema properties.' },
                        maxChars: { type: 'integer', description: 'Per-field character limit for long text (default 200000).' },
                    },
                },
            },
            create: {
                action: create,
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
                parameters: {
                    type: 'object',
                    properties: {
                        avatar: { type: 'string', description: 'Character avatar id. Omit to use the character of the current chat.' },
                        rev: { type: 'string', description: 'Revision obtained from read.' },
                        card: {
                            type: 'object',
                            description: 'Patch: include ONLY the fields to change; omitted fields keep their current values.',
                            properties: CHARACTER_CARD_SCHEMA,
                        },
                    },
                    required: ['rev', 'card'],
                },
            },
            delete: {
                action: remove,
                parameters: {
                    type: 'object',
                    properties: {
                        avatar: { type: 'string', description: 'Character avatar id. Omit to use the character of the current chat.' },
                        rev: { type: 'string', description: 'Revision obtained from read.' },
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

// @ts-check

import {
    designerError,
    isPlainObject,
    optionalString,
    requireString,
    verifyRevOrThrow,
} from './common.js';

/**
 * User persona resource adapter (v1: read + update only).
 *
 * In this fork the persona state is split across two places:
 *   power_user.personas[id]            -> name (string)
 *   power_user.persona_descriptions[id] -> descriptor { description, title, position, depth, role, lorebook }
 * and `user_avatar` is the currently active persona id. Creating/deleting
 * personas is tied to the avatar upload flow in the UI, so v1 only reads and
 * updates existing personas; the target-id defaults to the active persona.
 *
 * The rev lock fingerprints the full persona state (name + whole descriptor),
 * matching the whole-object granularity of the other resources: any external
 * change — including injection settings the tools cannot edit — invalidates
 * the rev.
 *
 * @param {{
 *   personas: { user_avatar: string },
 *   powerUser: { power_user: Record<string, any> },
 *   saveSettings: () => void,
 *   emit: (type: string, payload: any) => Promise<void> | void,
 *   revLock: ReturnType<import('./rev-lock.js').createRevLock>,
 * }} deps
 */
export function createPersonaResource({ personas, powerUser, saveSettings, emit, revLock }) {
    const key = (id) => `persona:${id}`;
    const fingerprintTarget = (id, name, descriptor) => ({ id, name, ...descriptor });

    function personasMap() {
        return powerUser.power_user.personas ?? {};
    }

    function descriptorsMap() {
        return powerUser.power_user.persona_descriptions ?? (powerUser.power_user.persona_descriptions = {});
    }

    function resolveId(requested) {
        const id = optionalString(requested) ?? personas.user_avatar;
        if (!id) {
            throw designerError(
                'designer.persona_target_required',
                'No active persona is set. Read the persona list and pass an explicit id.',
            );
        }
        return id;
    }

    function getPersona(id) {
        const name = personasMap()[id];
        if (name === undefined) {
            const available = Object.keys(personasMap()).join(', ') || 'none';
            throw designerError('designer.persona_not_found', `Persona "${id}" was not found. Available personas: ${available}.`);
        }
        return name;
    }

    async function read(params = {}) {
        const id = optionalString(params.id);

        if (!id) {
            const personasList = Object.entries(personasMap())
                .map(([personaId, name]) => ({ id: personaId, name }))
                .sort((a, b) => a.name.localeCompare(b.name));
            return { personas: personasList, count: personasList.length, current: personas.user_avatar || null };
        }

        const name = getPersona(id);
        const descriptor = descriptorsMap()[id] ?? {};
        const rev = await revLock.issue(key(id), fingerprintTarget(id, name, descriptor));

        return { id, persona: { name, description: descriptor.description ?? '' }, rev };
    }

    async function update(params = {}) {
        const id = resolveId(params.id);
        const name = getPersona(id);
        const descriptors = descriptorsMap();
        const descriptor = descriptors[id] ?? (descriptors[id] = {});

        await verifyRevOrThrow(revLock, key(id), params.rev, fingerprintTarget(id, name, descriptor));

        // Patch semantics: only the provided fields change. name must be a
        // non-empty string when provided; description may be any string.
        const provided = isPlainObject(params.persona) ? params.persona : {};
        const changes = {};
        if (provided.name !== undefined && provided.name !== null) {
            changes.name = requireString(provided.name, 'persona.name');
        }
        if (provided.description !== undefined && provided.description !== null) {
            changes.description = String(provided.description);
        }
        if (Object.keys(changes).length === 0) {
            throw designerError('designer.no_fields', 'No updatable persona fields were provided. Send name and/or description.');
        }

        const nextName = changes.name ?? name;
        if (changes.name !== undefined) {
            personasMap()[id] = changes.name;
        }
        if (changes.description !== undefined) {
            descriptor.description = changes.description;
            if (id === personas.user_avatar) {
                // Legacy sync, mirroring personas.js updatePersonaCallback.
                powerUser.power_user.persona_description = changes.description;
            }
        }
        if (nextName !== name) {
            await emit('PERSONA_RENAMED', { avatarId: id, oldName: name, newName: nextName });
        }
        saveSettings();
        const rev = await revLock.commit(key(id), fingerprintTarget(id, nextName, descriptor));

        return { updated: Object.keys(changes), rev };
    }

    return {
        name: 'persona',
        verbs: {
            read: {
                action: read,
                parameters: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', description: 'Persona id. Omit to list personas (with the active one).' },
                    },
                },
            },
            update: {
                action: update,
                parameters: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', description: 'Persona id. Omit to use the active persona.' },
                        rev: { type: 'string', description: 'Revision obtained from read.' },
                        persona: {
                            type: 'object',
                            description: 'Patch: include ONLY the fields to change (name and/or description); omitted fields keep their current values.',
                            properties: {
                                name: { type: 'string', description: 'User display name.' },
                                description: { type: 'string', description: 'User persona description injected into the prompt.' },
                            },
                        },
                    },
                    required: ['rev', 'persona'],
                },
            },
        },
    };
}

// @ts-check

import {
    designerError,
    ok,
    optionalString,
    requireCompleteFields,
    requireString,
    verifyUpdateOrThrow,
} from './common.js';

/** Editable surface of a user persona (complete-object contract). */
const PERSONA_EDITABLE_FIELDS = ['name', 'description'];

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
            return ok({ personas: personasList, count: personasList.length, current: personas.user_avatar || null });
        }

        const name = getPersona(id);
        const descriptor = descriptorsMap()[id] ?? {};
        const rev = await revLock.issue(key(id), fingerprintTarget(id, name, descriptor));

        return ok({ id, name, description: descriptor.description ?? '', rev });
    }

    async function update(params = {}) {
        const id = resolveId(params.id);
        const name = getPersona(id);
        const descriptors = descriptorsMap();
        const descriptor = descriptors[id] ?? (descriptors[id] = {});
        const current = { name, description: descriptor.description ?? '' };

        await verifyUpdateOrThrow(revLock, key(id), params.rev, fingerprintTarget(id, name, descriptor));

        const completePersona = requireCompleteFields(params.persona, PERSONA_EDITABLE_FIELDS, 'persona', { current });
        const nextName = requireString(completePersona.name, 'persona.name');
        const nextDescription = String(completePersona.description ?? '');

        personasMap()[id] = nextName;
        descriptor.description = nextDescription;
        if (id === personas.user_avatar) {
            // Legacy sync, mirroring personas.js updatePersonaCallback.
            powerUser.power_user.persona_description = nextDescription;
        }
        if (nextName !== name) {
            await emit('PERSONA_RENAMED', { avatarId: id, oldName: name, newName: nextName });
        }
        saveSettings();
        const rev = await revLock.commit(key(id), fingerprintTarget(id, nextName, descriptor));

        return ok({ id, name: nextName, rev });
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
                            description: 'Complete persona data {name, description}; copy unchanged values from the read result.',
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

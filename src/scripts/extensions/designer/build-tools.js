// @ts-check

import { designerError, toToolDefinition } from './common.js';

const CRUD_VERBS = ['read', 'create', 'update', 'delete'];

/** @type {Record<string, (targets: string[]) => string>} */
const VERB_DESCRIPTIONS = {
    read: (targets) => `Read a design object and get its rev (required for update/delete). Omit the addressing id to list all objects.
- fields[]: fetch only the fields you need (token cost); schema-listed fields only — addressing ids are not selectable.

Example: read({target:"character", avatar:"ada.png", fields:["description"]})`,
    create: (targets) => `Create a new design object. Targets: ${targets.join(' | ')}.
- character: card.name required; other card fields optional.
- world_info: book, and optionally entry (entry.key required, at least one trigger keyword; put a human-readable label in entry.comment).
- prompt: name and content required.

Example: create({target:"character", card:{name:"Mira", description:"A wandering fortune-teller."}})`,
    update: (targets) => `Update one or more fields of an existing object (patch). The rev from a recent read is required; there is no undo — verify the target before writing.
- Send ONLY the fields to change inside the object key (never echo whole objects or wrap them again): character→card, world_info→entry (book and uid), prompt→prompt (omit name = current preset), persona→persona (omit id = active persona).
- Omitted fields stay unchanged; null = unchanged; "" or [] clears a field.
- Write only fields you have read.

Example: update({target:"character", avatar:"ada.png", rev:"f9773d", card:{description:"A new description."}})`,
    delete: (targets) => `Delete a design object. This is destructive and cannot be undone; the rev from a recent read is required.
- character: avatar optional (defaults to the current chat); deleteChats defaults to false.
- world_info: entry (book and uid) or the whole lorebook (book, omit uid).
- prompt: name optional (defaults to the current preset).

Example: delete({target:"prompt", name:"Old Preset", rev:"8f9220"})`,
};

/**
 * Builds the unified CRUD tool set (read / create / update / delete) from
 * resource adapters. Each tool dispatches on a `target` parameter naming the
 * object type, so all object kinds share one uniform surface:
 *
 *   read({ target: 'character', avatar: ... })
 *   update({ target: 'world_info', book: ..., uid: ..., rev: ..., entry: ... })
 *
 * Resource adapters keep their per-target validation (rev lock, field
 * whitelists and patch normalization) — the schema union is only the transport.
 *
 * @param {Array<{name: string, verbs: Partial<Record<'read'|'create'|'update'|'delete', {action: (params: any) => Promise<any>, parameters: object}>>}>} resources
 */
export function buildUnifiedTools(resources) {
    /** @type {Record<string, Array<{target: string, def: any}>>} */
    const byVerb = {};
    for (const resource of resources) {
        for (const verb of CRUD_VERBS) {
            const definition = resource.verbs?.[verb];
            if (!definition) {
                continue;
            }
            (byVerb[verb] ??= []).push({ target: resource.name, def: definition });
        }
    }

    return CRUD_VERBS.map((verb) => {
        const entries = byVerb[verb];
        if (!entries || entries.length === 0) {
            return null;
        }
        const targets = entries.map((entry) => entry.target);
        const properties = {
            target: {
                type: 'string',
                enum: targets,
                description: 'Which object type to operate on.',
            },
        };
        for (const { def } of entries) {
            Object.assign(properties, stripNestedRequired(def.parameters?.properties ?? {}));
        }
        return toToolDefinition({
            name: verb,
            description: VERB_DESCRIPTIONS[verb](targets),
            parameters: {
                type: 'object',
                properties,
                required: ['target'],
            },
            action: async (params = {}) => {
                const target = params?.target;
                const entry = entries.find((candidate) => candidate.target === target);
                if (!entry) {
                    throw designerError(
                        'designer.unknown_target',
                        `Unknown target "${target}". Available targets: ${targets.join(', ')}.`,
                    );
                }
                const { target: _ignored, ...rest } = params ?? {};
                return entry.def.action(rest);
            },
        });
    }).filter(Boolean);
}

/**
 * Strips nested `required` arrays from a schema properties map. The unified
 * tool cannot express per-target requiredness (each target has its own), so
 * requiredness is enforced by the resource adapters' validators instead of
 * the JSON schema.
 * @param {Record<string, any>} properties
 */
function stripNestedRequired(properties) {
    const out = {};
    for (const [key, value] of Object.entries(properties)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            const { required: _ignored, ...rest } = value;
            out[key] = rest.properties
                ? { ...rest, properties: stripNestedRequired(rest.properties) }
                : rest;
        } else {
            out[key] = value;
        }
    }
    return out;
}

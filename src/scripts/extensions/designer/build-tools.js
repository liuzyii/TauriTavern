// @ts-check

import { designerError, toToolDefinition } from './common.js';

const CRUD_VERBS = ['read', 'create', 'update', 'delete'];

/** @type {Record<string, (targets: string[]) => string>} */
const VERB_DESCRIPTIONS = {
    read: (targets) => `Read design objects. Choose target from [${targets.join(' | ')}]: ` +
        '"character" reads a character card (omit avatar to list characters; pass avatar plus optional maxChars to read a card and get its rev); ' +
        '"world_info" reads a lorebook or entry (omit book to list books; pass book without uid to list entries and get a book rev; pass book and uid to read an entry and get its rev); ' +
        '"prompt" reads a system prompt preset (omit name to list presets; pass name to read content and get its rev); ' +
        '"persona" reads the user persona (omit id to list personas with the active one; pass id to read name and description and get its rev). ' +
        'Always read an object before updating or deleting it, and use the returned rev. ' +
        'Examples: read({target:"character"}) lists characters; read({target:"character", avatar:"ada.png"}) reads a card; read({target:"world_info", book:"Mira\'s World", uid:"0"}) reads an entry.',
    create: (targets) => `Create a design object. Choose target from [${targets.join(' | ')}]: ` +
        '"character" creates a character card (card.name required; other card fields optional); ' +
        '"world_info" creates a lorebook (book) and optionally an entry (entry.key required, at least one keyword); ' +
        '"prompt" creates a system prompt preset (name and content required). ' +
        'Changes apply immediately and are shown in the chat. ' +
        'Example: create({target:"character", card:{name:"Mira", description:"A wandering fortune-teller."}}).',
    update: (targets) => `Replace the editable fields of an existing design object with the COMPLETE object. Choose target from [${targets.join(' | ')}]; the rev from a recent read is required. ` +
        'Copy every field from the read result and change only what you need; missing non-empty fields are rejected (designer.incomplete_update), missing empty fields and explicit nulls keep their current values. ' +
        '"character": card (all editable fields). "world_info": entry (book and uid). "prompt": prompt {content, post_history}; omit name to target the current system prompt. "persona": persona {name, description}; omit id to target the active persona. ' +
        'Example: update({target:"world_info", book:"Mira\'s World", uid:"0", rev:"f9773d", entry:{...every field from the read result...}}).',
    delete: (targets) => `Delete a design object. Choose target from [${targets.join(' | ')}]; the rev from a recent read is required. ` +
        '"character" deletes a character card (avatar optional, defaults to the current chat; deleteChats defaults to false). ' +
        '"world_info" deletes an entry (book and uid) or the whole lorebook (book, omit uid). ' +
        '"prompt" deletes a system prompt preset (name optional, defaults to the current one). ' +
        'Destructive and irreversible — use only when the user explicitly asks to delete. ' +
        'Example: delete({target:"prompt", name:"Old Preset", rev:"8f9220"}).',
};

/**
 * Builds the unified CRUD tool set (read / create / update / delete) from
 * resource adapters. Each tool dispatches on a `target` parameter naming the
 * object type, so all object kinds share one uniform surface:
 *
 *   read({ target: 'character', avatar: ... })
 *   update({ target: 'world_info', book: ..., uid: ..., rev: ..., entry: ... })
 *
 * Resource adapters keep their per-target validation (rev lock, complete
 * object contract, type whitelists) — the schema union is only the transport.
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

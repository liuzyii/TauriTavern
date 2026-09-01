// @ts-check

import { toToolDefinition } from './common.js';

const CRUD_VERBS = ['read', 'create', 'update', 'delete'];

/**
 * Builds the uniform CRUD tool set from resource adapters.
 *
 * A resource adapter is a plain object:
 *
 *   {
 *     name: 'character',                       // -> read_character, update_character, ...
 *     verbs: {
 *       read:   { action, description, parameters },
 *       create: { action, description, parameters },
 *       update: { action, description, parameters },
 *       delete: { action, description, parameters },
 *     },
 *   }
 *
 * Adding a new editable object type (e.g. personas) is one new adapter module
 * plus one entry in index.js — no changes to naming, registration, or the
 * tool-loop mechanics.
 *
 * @param {Array<{
 *   name: string,
 *   verbs: Partial<Record<'read'|'create'|'update'|'delete', {
 *     action: (params: any) => Promise<any>,
 *     description: string,
 *     parameters: object,
 *   }>>,
 * }>} resources
 */
export function buildDesignerTools(resources) {
    const tools = [];
    for (const resource of resources) {
        for (const verb of CRUD_VERBS) {
            const definition = resource.verbs?.[verb];
            if (!definition) {
                continue;
            }
            tools.push(toToolDefinition({
                name: `${verb}_${resource.name}`,
                description: definition.description,
                parameters: definition.parameters,
                action: definition.action,
            }));
        }
    }
    return tools;
}

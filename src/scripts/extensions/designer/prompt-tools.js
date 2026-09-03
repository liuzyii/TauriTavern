// @ts-check

import {
    designerError,
    normalizeMaxChars,
    optionalString,
    requireString,
    truncateText,
    verifyRevOrThrow,
} from './common.js';

const DEFAULT_READ_MAX_CHARS = 200_000;
const PROMPT_MAX_CONTENT_LENGTH = 100_000;

/**
 * System prompt preset resource adapter. The active system prompt state lives
 * in power_user.sysprompt; the preset library is managed by the sysprompt
 * preset manager (system_prompts array). Saving a preset follows the ST UI
 * behavior: the preset becomes the selected/active system prompt.
 * @param {{presetManager: any, sysprompt: any, powerUser: any, revLock: ReturnType<import('./rev-lock.js').createRevLock>}} deps
 */
export function createPromptResource({ presetManager, sysprompt, powerUser, revLock }) {
    const key = (name) => `prompt:${name}`;

    // Whole-preset fingerprint: the rev lock granularity is the object (not
    // the editable surface), matching character cards and world info — any
    // external change to the preset invalidates the rev, editable or not.
    const fingerprintTarget = (preset) => preset;

    function load() {
        return {
            manager: presetManager.getPresetManager('sysprompt'),
            systemPrompts: sysprompt.system_prompts,
            powerUser: powerUser.power_user,
        };
    }

    function findPreset(list, name) {
        const normalized = String(name ?? '').trim().toLowerCase();
        return list.find((preset) => String(preset.name ?? '').trim().toLowerCase() === normalized);
    }

    function notFoundMessage(name, list) {
        const available = list.slice(0, 8).map((preset) => preset.name).join(', ');
        return `System prompt "${name}" was not found. Available presets: ${available || 'none'}.`;
    }

    /**
     * Resolves the preset name for update/delete: explicit param wins,
     * otherwise the currently enabled system prompt.
     * @param {string | undefined} requested
     * @param {{sysprompt: {enabled?: boolean, name?: string}}} powerUser
     */
    function resolveTargetName(requested, powerUser) {
        if (requested) {
            return requested;
        }
        const activeName = optionalString(powerUser.sysprompt?.name);
        if (powerUser.sysprompt?.enabled !== true || !activeName) {
            throw designerError(
                'designer.prompt_name_required',
                'No system prompt preset name was provided and no system prompt is currently enabled. Read the prompt list to find a name.',
            );
        }
        return activeName;
    }

    function normalizeContent(value) {
        const content = String(value ?? '');
        if (content.length > PROMPT_MAX_CONTENT_LENGTH) {
            throw designerError('designer.field_too_long', `content exceeds ${PROMPT_MAX_CONTENT_LENGTH} characters.`);
        }
        return content;
    }

    async function read(params = {}) {
        const { systemPrompts, powerUser } = load();
        const requested = optionalString(params.name);

        if (!requested) {
            const prompts = systemPrompts.map((preset) => ({
                name: preset.name,
                contentChars: String(preset.content ?? '').length,
            }));
            return {
                prompts,
                count: prompts.length,
                current: {
                    enabled: powerUser.sysprompt.enabled === true,
                    name: powerUser.sysprompt.name || null,
                },
            };
        }

        const preset = findPreset(systemPrompts, requested);
        if (!preset) {
            throw designerError('designer.prompt_not_found', notFoundMessage(requested, systemPrompts));
        }
        const maxChars = normalizeMaxChars(params.maxChars, DEFAULT_READ_MAX_CHARS);
        const content = truncateText(preset.content, maxChars);
        const truncated = String(preset.content ?? '').length !== content.length;
        const rev = await revLock.issue(key(preset.name), fingerprintTarget(preset));

        return {
            name: preset.name,
            prompt: {
                content,
                post_history: String(preset.post_history ?? ''),
            },
            rev,
            truncated,
        };
    }

    async function create(params = {}) {
        const { manager, systemPrompts } = load();
        const name = requireString(params.name, 'name');
        const content = normalizeContent(params.content);
        if (findPreset(systemPrompts, name)) {
            throw designerError('designer.prompt_exists', `System prompt "${name}" already exists.`);
        }

        const preset = { name, content };
        await manager.savePreset(name, preset);
        const rev = await revLock.commit(key(name), fingerprintTarget(preset));
        return { name, rev };
    }

    async function update(params = {}) {
        const { manager, systemPrompts, powerUser } = load();
        const name = resolveTargetName(optionalString(params.name), powerUser);
        const preset = findPreset(systemPrompts, name);
        if (!preset) {
            throw designerError('designer.prompt_not_found', notFoundMessage(name, systemPrompts));
        }
        await verifyRevOrThrow(revLock, key(name), params.rev, fingerprintTarget(preset));

        // Patch semantics: only the provided fields change; an explicit null
        // means "keep the current value".
        const changes = {};
        if (params.prompt?.content !== undefined && params.prompt?.content !== null) {
            changes.content = normalizeContent(params.prompt.content);
        }
        if (params.prompt?.post_history !== undefined && params.prompt?.post_history !== null) {
            changes.post_history = String(params.prompt.post_history);
        }
        if (Object.keys(changes).length === 0) {
            throw designerError('designer.no_fields', 'No updatable prompt fields were provided. Send content and/or post_history.');
        }
        Object.assign(preset, changes);
        await manager.savePreset(name, { ...preset });
        const rev = await revLock.commit(key(name), fingerprintTarget(preset));

        return { updated: Object.keys(changes), rev };
    }

    async function remove(params = {}) {
        const { manager, systemPrompts, powerUser } = load();
        const name = resolveTargetName(optionalString(params.name), powerUser);

        const preset = findPreset(systemPrompts, name);
        if (!preset) {
            throw designerError('designer.prompt_not_found', notFoundMessage(name, systemPrompts));
        }
        await verifyRevOrThrow(revLock, key(preset.name), params.rev, fingerprintTarget(preset));

        const deleted = await manager.deletePreset(preset.name);
        if (!deleted) {
            throw designerError('designer.prompt_delete_failed', `System prompt "${preset.name}" could not be deleted.`);
        }
        revLock.forget(key(preset.name));

        return { deleted: preset.name };
    }

    return {
        name: 'prompt',
        verbs: {
            read: {
                action: read,
                parameters: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'System prompt preset name. Omit to list presets.' },
                        maxChars: { type: 'integer', description: 'Per-field character limit for long text (default 200000).' },
                    },
                },
            },
            create: {
                action: create,
                parameters: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'Unique preset name.' },
                        content: { type: 'string', description: 'System prompt content.' },
                    },
                    required: ['name', 'content'],
                },
            },
            update: {
                action: update,
                parameters: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'Preset name to update. Omit to update the currently enabled system prompt.' },
                        rev: { type: 'string', description: 'Revision obtained from read.' },
                        prompt: {
                            type: 'object',
                            description: 'Patch: include ONLY the fields to change (content and/or post_history); omitted fields keep their current values.',
                            properties: {
                                content: { type: 'string' },
                                post_history: { type: 'string' },
                            },
                        },
                    },
                    required: ['rev', 'prompt'],
                },
            },
            delete: {
                action: remove,
                parameters: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'Preset name to delete. Omit to delete the currently enabled system prompt.' },
                        rev: { type: 'string', description: 'Revision obtained from read.' },
                    },
                    required: ['rev'],
                },
            },
        },
    };
}

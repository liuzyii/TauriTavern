// @ts-check

import {
    PROMPT_COMPLETE_FIELDS,
    designerError,
    normalizeMaxChars,
    ok,
    optionalString,
    requireCompleteFields,
    requireString,
    verifyRevOrThrow,
    verifyUpdateOrThrow,
} from './common.js';

const DEFAULT_READ_MAX_CHARS = 200_000;
const PROMPT_MAX_CONTENT_LENGTH = 100_000;

/**
 * System prompt preset resource adapter. The active system prompt state lives
 * in power_user.sysprompt; the preset library is managed by the sysprompt
 * preset manager (system_prompts array). Saving a preset follows the ST UI
 * behavior: the preset becomes the selected/active system prompt.
 * @param {{st: any, revLock: ReturnType<import('./rev-lock.js').createRevLock>}} deps
 */
export function createPromptResource({ presetManager, sysprompt, powerUser, revLock }) {
    const key = (name) => `prompt:${name}`;

    function fingerprintTarget(preset) {
        const target = { name: preset.name, content: preset.content };
        if (preset.post_history !== undefined) {
            target.post_history = preset.post_history;
        }
        return target;
    }

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
            return ok({
                prompts,
                count: prompts.length,
                current: {
                    enabled: powerUser.sysprompt.enabled === true,
                    name: powerUser.sysprompt.name || null,
                },
            });
        }

        const preset = findPreset(systemPrompts, requested);
        if (!preset) {
            throw designerError('designer.prompt_not_found', `System prompt "${requested}" was not found.`);
        }
        const maxChars = normalizeMaxChars(params.maxChars, DEFAULT_READ_MAX_CHARS);
        const content = truncatePromptContent(preset.content, maxChars);
        const truncated = String(preset.content ?? '').length !== content.length;
        const rev = await revLock.issue(key(preset.name), fingerprintTarget(preset), { truncated });

        return ok({
            name: preset.name,
            content,
            post_history: preset.post_history,
            rev,
            truncated,
        });
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
        return ok({ name, rev });
    }

    async function update(params = {}) {
        const { manager, systemPrompts, powerUser } = load();
        const name = resolveTargetName(optionalString(params.name), powerUser);
        const preset = findPreset(systemPrompts, name);
        if (!preset) {
            throw designerError('designer.prompt_not_found', `System prompt "${name}" was not found.`);
        }
        await verifyUpdateOrThrow(revLock, key(name), params.rev, fingerprintTarget(preset));

        // Complete-object contract: content and post_history are both required;
        // a missing empty post_history is auto-filled from the current preset,
        // and an explicit null means "keep the current value".
        const completePrompt = requireCompleteFields(params.prompt, PROMPT_COMPLETE_FIELDS, 'prompt', { current: preset });
        if (completePrompt.content !== null && completePrompt.content !== undefined) {
            preset.content = normalizeContent(completePrompt.content);
        }
        preset.post_history = String(completePrompt.post_history ?? '');
        await manager.savePreset(name, { ...preset });
        const rev = await revLock.commit(key(name), fingerprintTarget(preset));

        return ok({ name, rev });
    }

    async function remove(params = {}) {
        const { manager, systemPrompts, powerUser } = load();
        const name = resolveTargetName(optionalString(params.name), powerUser);

        const preset = findPreset(systemPrompts, name);
        if (!preset) {
            throw designerError('designer.prompt_not_found', `System prompt "${name}" was not found.`);
        }
        await verifyRevOrThrow(revLock, key(preset.name), params.rev, fingerprintTarget(preset));

        const deleted = await manager.deletePreset(preset.name);
        if (!deleted) {
            throw designerError('designer.prompt_delete_failed', `System prompt "${preset.name}" could not be deleted.`);
        }
        revLock.forget(key(preset.name));

        return ok({ deleted: preset.name });
    }

    return {
        name: 'prompt',
        verbs: {
            read: {
                action: read,
                description: 'List system prompt presets (with the currently active one), or read one preset by name. Use this when the user asks about designing or changing system prompts. Omit name to list presets. Pass name to read its content; the result includes a rev that update_prompt/delete_prompt require.',
                parameters: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'System prompt preset name. Omit to list presets.' },
                        maxChars: { type: 'integer', description: 'Character limit for content (default 200000).' },
                    },
                },
            },
            create: {
                action: create,
                description: 'Create a new system prompt preset with the given content. After saving, the preset becomes the selected system prompt (same as saving it in the UI).',
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
                description: 'Replace the content of an existing system prompt preset with the COMPLETE prompt object { content, post_history }: copy both fields from read_prompt and change only what you need; partial objects are rejected with designer.incomplete_update. Requires a rev from read_prompt. Omit name to update the currently enabled system prompt. After saving, the preset becomes the selected system prompt (same as saving it in the UI).',
                parameters: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'Preset name to update. Omit to update the currently enabled system prompt.' },
                        rev: { type: 'string', description: 'Revision obtained from read_prompt.' },
                        prompt: {
                            type: 'object',
                            description: 'Complete prompt data. Both fields are required; copy unchanged values from the read result.',
                            properties: {
                                content: { type: 'string' },
                                post_history: { type: 'string' },
                            },
                            required: PROMPT_COMPLETE_FIELDS,
                        },
                    },
                    required: ['rev', 'prompt'],
                },
            },
            delete: {
                action: remove,
                description: 'Delete a system prompt preset. Requires a rev from read_prompt. Omit name to delete the currently enabled system prompt. Deleting the currently selected preset follows the ST UI behavior (another preset is selected). This is destructive and irreversible.',
                parameters: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'Preset name to delete. Omit to delete the currently enabled system prompt.' },
                        rev: { type: 'string', description: 'Revision obtained from read_prompt.' },
                    },
                    required: ['rev'],
                },
            },
        },
    };
}

function truncatePromptContent(content, maxChars) {
    const text = String(content ?? '');
    if (!(maxChars > 0) || text.length <= maxChars) {
        return text;
    }
    return `${text.slice(0, maxChars)}…[truncated ${text.length - maxChars} chars]`;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('designer index.js relative imports resolve to real app modules', async () => {
    // The extension module is loaded by the browser at
    // /scripts/extensions/designer/src/index.js (served root = repo src/), so
    // every relative import resolves against that URL. A wrong number of
    // "../" segments silently 404s at activation time — the exact failure the
    // extension manager reports as "failed to load".
    const entryPath = 'src/scripts/extensions/designer/index.js';
    const source = await readFile(path.join(REPO_ROOT, entryPath), 'utf8');
    const specifiers = [...source.matchAll(/from\s+'(\.[^']+)'/g)].map((m) => m[1]);
    assert.ok(specifiers.length >= 8, `应至少有 8 个相对导入（实际 ${specifiers.length}）`);
    for (const specifier of specifiers) {
        const resolvedPath = new URL(specifier, 'http://local/scripts/extensions/designer/index.js').pathname;
        const repoFile = path.join(REPO_ROOT, 'src', resolvedPath.replace(/^\//, '').replace(/\//g, path.sep));
        assert.ok(existsSync(repoFile), `相对导入解析不到文件：${specifier} -> ${resolvedPath}`);
    }
});

test('persona tools: read and update with rev lock', async () => {
    const { createRevLock } = await importFresh('src/scripts/extensions/designer/rev-lock.js');
    const { buildUnifiedTools } = await importFresh('src/scripts/extensions/designer/build-tools.js');
    const { createPersonaResource } = await importFresh('src/scripts/extensions/designer/persona-tools.js');

    const promptModules = createFakePromptModules();
    const powerUser = promptModules.powerUser.power_user;
    powerUser.personas = { p1: 'Ada', p2: 'Mira' };
    powerUser.persona_descriptions = {
        p1: { description: 'A quiet archivist.' },
        p2: { description: '' },
    };
    const st = fakeSt({
        scriptModule: createFakeScriptModule(),
        worldInfoModule: createFakeWorldInfoModule(),
        promptModules,
        personas: { user_avatar: 'p1' },
    });

    const saved = [];
    const emitted = [];
    const tools = buildUnifiedTools([
        createPersonaResource({
            personas: st.personas,
            powerUser: st.powerUser,
            saveSettings: () => saved.push('save'),
            emit: (type, payload) => emitted.push({ type, payload }),
            revLock: createRevLock(),
        }),
    ]);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.action]));

    // List with the active persona
    const list = await byName.read({ target: 'persona' });
    assert.equal(list.count, 2);
    assert.equal(list.current, 'p1');

    // Detail issues a rev and returns the object under the update key
    const read = await byName.read({ target: 'persona', id: 'p1' });
    assert.equal(read.persona.name, 'Ada');
    assert.equal(read.persona.description, 'A quiet archivist.');
    assert.ok(read.rev.length > 0);

    // Complete-object update (name change emits the rename event)
    const updated = await byName.update({
        target: 'persona',
        id: 'p1',
        rev: read.rev,
        persona: { name: 'Ada the Archivist', description: 'A quiet archivist who guards the stacks.' },
    });
    assert.equal(powerUser.personas.p1, 'Ada the Archivist');
    assert.equal(powerUser.persona_descriptions.p1.description, 'A quiet archivist who guards the stacks.');
    assert.equal(powerUser.persona_description, 'A quiet archivist who guards the stacks.', '活动人设同步 legacy 字段');
    assert.equal(saved.length, 1, '更新后保存设置');
    assert.deepEqual(emitted[0], {
        type: 'PERSONA_RENAMED',
        payload: { avatarId: 'p1', oldName: 'Ada', newName: 'Ada the Archivist' },
    });

    // Stale rev fails
    await assert.rejects(
        byName.update({ target: 'persona', id: 'p1', rev: read.rev, persona: { name: 'X', description: '' } }),
        /designer\.rev_invalid/,
    );

    // Patch semantics: updating only name leaves the description untouched
    const read2 = await byName.read({ target: 'persona', id: 'p1' });
    const nameOnly = await byName.update({ target: 'persona', id: 'p1', rev: read2.rev, persona: { name: 'Ada' } });
    assert.equal(powerUser.personas.p1, 'Ada');
    assert.equal(powerUser.persona_descriptions.p1.description, 'A quiet archivist who guards the stacks.', '未提供的 description 保持不变');

    // Empty patch (no provided fields) is rejected
    const read2b = await byName.read({ target: 'persona', id: 'p1' });
    await assert.rejects(
        byName.update({ target: 'persona', id: 'p1', rev: read2b.rev, persona: {} }),
        /designer\.no_fields/,
    );

    // Unknown persona
    await assert.rejects(byName.read({ target: 'persona', id: 'nobody' }), /designer\.persona_not_found/);

    // Omitted id targets the active persona
    const read3 = await byName.read({ target: 'persona', id: 'p1' });
    const viaActive = await byName.update({
        target: 'persona',
        rev: read3.rev,
        persona: { name: 'Ada the Archivist', description: 'Updated via the active persona.' },
    });
    assert.equal(powerUser.persona_descriptions.p1.description, 'Updated via the active persona.');
});

test('common: buildDesignerContext formats the dynamic environment list', async () => {
    const common = await importFresh('src/scripts/extensions/designer/common.js');

    // Full state
    const text = common.buildDesignerContext({
        characters: [
            { avatar: 'ada.png', name: 'Ada' },
            { avatar: 'created-1.png', name: 'Mira the Wanderer' },
        ],
        personaId: 'p1',
        personaName: 'Ada the Archivist',
        books: [
            { name: "Mira's World", entries: 2 },
            { name: 'Tavern', entries: 1 },
        ],
        prompts: ['RP', 'Design Session'],
        activePrompt: 'Design Session',
    });
    const expected = [
        'Designer context (current objects; call read for details):',
        'characters: ada.png "Ada", created-1.png "Mira the Wanderer"',
        'persona: p1 "Ada the Archivist"',
        'world info: "Mira\'s World" (2 entries), "Tavern" (1 entry)',
        'prompts: "RP", "Design Session" (active)',
    ].join('\n');
    assert.equal(text, expected);

    // Empty state keeps only the header
    const empty = common.buildDesignerContext({ characters: [], books: [], prompts: [] });
    assert.equal(empty, 'Designer context (current objects; call read for details):');

    // No persona -> no persona line; maxItems caps the list
    const capped = common.buildDesignerContext({
        characters: [
            { avatar: 'a.png', name: 'A' },
            { avatar: 'b.png', name: 'B' },
            { avatar: 'c.png', name: 'C' },
        ],
        books: [],
        prompts: [],
        maxItems: 2,
    });
    assert.ok(capped.includes('a.png "A", b.png "B"'));
    assert.ok(!capped.includes('c.png'));
});

test('designer extension is registered in the system extension allowlist', async () => {
    // The Tauri backend only reports bundled extensions listed in
    // ENABLED_SYSTEM_EXTENSIONS; a missing entry silently prevents the whole
    // extension from loading (and therefore from registering any tools).
    const sourcePath = path.join(
        REPO_ROOT,
        'src-tauri/crates/tt-adapter-extension/src/repositories/file_extension_repository.rs',
    );
    const source = await readFile(sourcePath, 'utf8');
    const marker = 'ENABLED_SYSTEM_EXTENSIONS: &[&str] = &[';
    const start = source.indexOf(marker);
    assert.ok(start >= 0, '未找到 ENABLED_SYSTEM_EXTENSIONS 数组');
    const end = source.indexOf('];', start);
    const list = source.slice(start + marker.length, end);
    assert.ok(list.includes('"designer"'), 'designer 必须在 ENABLED_SYSTEM_EXTENSIONS 白名单中，否则应用不会加载该扩展');
});

async function importFresh(relativePath) {
    const modulePath = path.join(REPO_ROOT, relativePath);
    const url = `${pathToFileURL(modulePath).href}?t=${Date.now()}-${Math.random()}`;
    return import(url);
}

function createFakeScriptModule({ characters = [], this_chid = undefined } = {}) {
    return {
        characters,
        this_chid,
        async getCharacters() {},
        async getOneCharacter(avatar) {
            return characters.find((c) => c.avatar === avatar) || null;
        },
        async deleteCharacter(avatar, options = {}) {
            const index = characters.findIndex((c) => c.avatar === avatar);
            if (index === -1) {
                return false;
            }
            characters.splice(index, 1);
            return true;
        },
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    };
}

function createFakeFetch(onRequestOrOptions = {}) {
    const onRequest = typeof onRequestOrOptions === 'function'
        ? onRequestOrOptions
        : onRequestOrOptions.onRequest;
    const requests = [];
    return {
        requests,
        fetchImpl: async (url, options) => {
            requests.push({ url, options });
            const handler = onRequest?.(url, options);
            if (handler) {
                return handler;
            }
            return { ok: true, status: 200, async text() { return 'ok'; }, async json() { return {}; } };
        },
    };
}

function createFakeWorldInfoModule({ books = {} } = {}) {
    const cache = new Map(Object.entries(books));
    const calls = [];
    return {
        calls,
        worldInfoCache: cache,
        newWorldInfoEntryTemplate: {
            key: [],
            keysecondary: [],
            comment: '',
            content: '',
            constant: false,
            selective: true,
            disable: false,
            order: 100,
            position: 0,
            excludeRecursion: false,
            preventRecursion: false,
            delayUntilRecursion: 0,
            depth: 4,
            group: '',
        },
        getFreeWorldEntryUid(data) {
            for (let uid = 0; uid < 1_000_000; uid += 1) {
                if (!(uid in data.entries)) {
                    return uid;
                }
            }
            return null;
        },
        async saveWorldInfo(name, data, immediately) {
            calls.push({ op: 'save', name, immediately });
            cache.set(name, data);
        },
        async deleteWorldInfoEntry(data, uid) {
            if (!data.entries[uid]) {
                return false;
            }
            delete data.entries[uid];
            return true;
        },
        async deleteWorldInfo(name) {
            if (!cache.has(name)) {
                return false;
            }
            cache.delete(name);
            return true;
        },
    };
}

function createFakePromptModules({ presets = [] } = {}) {
    const systemPrompts = structuredClone(presets);
    const manager = {
        async savePreset(name, preset) {
            const index = systemPrompts.findIndex((p) => p.name === name);
            const next = { ...preset };
            if (index >= 0) {
                systemPrompts[index] = next;
            } else {
                systemPrompts.push(next);
            }
        },
        async deletePreset(name) {
            const index = systemPrompts.findIndex((p) => p.name === name);
            if (index === -1) {
                return false;
            }
            systemPrompts.splice(index, 1);
            return true;
        },
    };
    return {
        systemPrompts,
        presetManager: { getPresetManager: () => manager },
        sysprompt: { system_prompts: systemPrompts },
        powerUser: { power_user: { sysprompt: { enabled: false, name: '', content: '' } } },
        manager,
    };
}

function fakeSt({ scriptModule, worldInfoModule, promptModules, personas = { user_avatar: '' } }) {
    return {
        script: scriptModule,
        worldInfo: worldInfoModule,
        presetManager: promptModules.presetManager,
        sysprompt: promptModules.sysprompt,
        powerUser: promptModules.powerUser,
        personas,
    };
}

test('rev-lock: issue, verify, commit and forget lifecycle', async () => {
    const { createRevLock, canonicalJson, fingerprint } = await importFresh('src/scripts/extensions/designer/rev-lock.js');
    const lock = createRevLock();

    const value = { b: 1, a: [3, 2] };
    assert.equal(canonicalJson(value), '{"a":[3,2],"b":1}');

    const rev = await lock.issue('k', value);
    assert.equal(typeof rev, 'string');
    assert.match(rev, /^[0-9a-f]{6}$/);
    assert.equal(rev.length, 6, 'rev 必须是 6 位十六进制（参考 git 短哈希，过长的 rev 会被模型抄错）');
    assert.equal(rev, await fingerprint(value));

    const good = await lock.verify('k', rev, value);

    const required = await lock.verify('k', '', value);
    assert.equal(required.ok, false);
    assert.equal(required.code, 'designer.rev_required');

    const unknown = await lock.verify('other', rev, value);
    assert.equal(unknown.ok, false);
    assert.equal(unknown.code, 'designer.rev_unknown');

    const invalid = await lock.verify('k', 'made-up-rev', value);
    assert.equal(invalid.ok, false);
    assert.equal(invalid.code, 'designer.rev_invalid');

    const changed = { ...value, b: 2 };
    const mismatch = await lock.verify('k', rev, changed);
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.code, 'designer.rev_mismatch');
    assert.equal(mismatch.rev, await fingerprint(changed));
    // The mismatch error adopts the current fingerprint, so the attached rev
    // is immediately usable: retrying with it succeeds without another read.
    const retryAfterMismatch = await lock.verify('k', mismatch.rev, changed);

    const nextRev = await lock.commit('k', changed);
    assert.equal(nextRev, mismatch.rev);
    const afterCommit = await lock.verify('k', nextRev, changed);

    lock.forget('k');
    const forgotten = await lock.verify('k', nextRev, changed);
    assert.equal(forgotten.code, 'designer.rev_unknown');
});

test('common: character update whitelist and payload builders', async () => {
    const common = await importFresh('src/scripts/extensions/designer/common.js');

    const normalized = common.normalizeCharacterUpdates({
        description: 'brave',
        tags: ['knight', 'loyal'],
        talkativeness: 0.5,
        world: 'Lorebook',
        depth_prompt: { prompt: 'focus', depth: 2, role: 'system' },
    });
    assert.equal(normalized.fields.description, 'brave');
    assert.deepEqual(normalized.fields.tags, ['knight', 'loyal']);
    assert.equal(normalized.fields.talkativeness, 0.5);
    assert.equal(normalized.extensions.world, 'Lorebook');
    assert.deepEqual(normalized.extensions.depth_prompt, { prompt: 'focus', depth: 2, role: 'system' });

    assert.throws(() => common.normalizeCharacterUpdates({ extensions: {} }), /designer\.unknown_field/);
    assert.throws(() => common.normalizeCharacterUpdates({ tags: 'knight' }), /designer\.invalid_tags/);
    assert.throws(() => common.normalizeCharacterUpdates({ talkativeness: 5 }), /designer\.invalid_number/);

    const createPayload = common.buildCharacterCreatePayload(normalized);
    assert.equal(createPayload.name, undefined);
    assert.equal(createPayload.data.description, 'brave');
    assert.equal(createPayload.world, 'Lorebook');
    assert.deepEqual(createPayload.data.extensions.depth_prompt, { prompt: 'focus', depth: 2, role: 'system' });

    const mergePayload = common.buildCharacterMergePayload('a.png', normalized);
    assert.equal(mergePayload.avatar, 'a.png');
    assert.equal(mergePayload.data.description, 'brave');
    assert.deepEqual(mergePayload.data.extensions, { world: 'Lorebook', depth_prompt: { prompt: 'focus', depth: 2, role: 'system' } });
});

test('common: world entry whitelist and truncation', async () => {
    const common = await importFresh('src/scripts/extensions/designer/common.js');

    const normalized = common.normalizeWorldEntryUpdates({
        key: ['castle'],
        content: 'A castle on the hill.',
        constant: true,
        order: 10,
        position: 50,
    });
    assert.deepEqual(normalized.key, ['castle']);
    assert.equal(normalized.constant, true);
    assert.equal(normalized.order, 10);
    assert.throws(() => common.normalizeWorldEntryUpdates({ uid: 1 }), /designer\.unknown_field/);
    assert.throws(() => common.normalizeWorldEntryUpdates({ constant: 'yes' }), /designer\.invalid_boolean/);

    assert.throws(
        () => common.normalizeWorldEntryForCreate({ content: 'no keywords' }),
        /designer\.entry_key_required/,
    );
    assert.equal(common.truncateText('abcdef', 3), 'abc…[truncated 3 chars]');
});

test('designer prompts: update schema carries the complete per-field spec', async () => {
    const { createRevLock } = await importFresh('src/scripts/extensions/designer/rev-lock.js');
    const { buildUnifiedTools } = await importFresh('src/scripts/extensions/designer/build-tools.js');
    const { CHARACTER_FIELD_LIST, WORLD_ENTRY_FIELD_LIST } = await importFresh('src/scripts/extensions/designer/common.js');
    const { createCharacterResource } = await importFresh('src/scripts/extensions/designer/character-tools.js');
    const { createWorldInfoResource } = await importFresh('src/scripts/extensions/designer/world-info-tools.js');
    const { createPromptResource } = await importFresh('src/scripts/extensions/designer/prompt-tools.js');
    const { createPersonaResource } = await importFresh('src/scripts/extensions/designer/persona-tools.js');

    const st = fakeSt({
        scriptModule: createFakeScriptModule(),
        worldInfoModule: createFakeWorldInfoModule(),
        promptModules: createFakePromptModules(),
        personas: { user_avatar: '' },
    });
    const revLock = createRevLock();
    const tools = buildUnifiedTools([
        createCharacterResource({ script: st.script, revLock }),
        createWorldInfoResource({ worldInfo: st.worldInfo, revLock }),
        createPromptResource({ presetManager: st.presetManager, sysprompt: st.sysprompt, powerUser: st.powerUser, revLock }),
        createPersonaResource({ personas: st.personas, powerUser: st.powerUser, saveSettings: () => {}, emit: () => {}, revLock }),
    ]);
    const update = tools.find((t) => t.name === 'update');
    const cardProps = update.parameters.properties.card.properties;
    const entryProps = update.parameters.properties.entry.properties;

    // The schema is the complete per-field spec: every writable field must be
    // present with a non-empty description the model can consult.
    for (const field of CHARACTER_FIELD_LIST) {
        assert.ok(cardProps[field], `card schema 缺少字段 ${field}`);
        assert.ok(cardProps[field].description, `card schema 字段 ${field} 缺描述`);
    }
    for (const field of WORLD_ENTRY_FIELD_LIST) {
        assert.ok(entryProps[field], `entry schema 缺少字段 ${field}`);
        assert.ok(entryProps[field].description, `entry schema 字段 ${field} 缺描述`);
    }
    assert.ok(cardProps.depth_prompt.properties?.depth, 'depth_prompt 有子 schema');

    // read description stays a short tips text, not a dictionary
    const read = tools.find((t) => t.name === 'read');
    assert.ok(read.description.length < 900, `read 描述应简短（实际 ${read.description.length}）`);
    assert.ok(read.description.includes('addressing ids are not selectable'), '寻址参数排除规则在描述中');
});

test('designer tools: 4 unified lowercase CRUD tools with target dispatch', async () => {
    const { createRevLock } = await importFresh('src/scripts/extensions/designer/rev-lock.js');
    const { buildUnifiedTools } = await importFresh('src/scripts/extensions/designer/build-tools.js');
    const { createCharacterResource } = await importFresh('src/scripts/extensions/designer/character-tools.js');
    const { createWorldInfoResource } = await importFresh('src/scripts/extensions/designer/world-info-tools.js');
    const { createPromptResource } = await importFresh('src/scripts/extensions/designer/prompt-tools.js');
    const { createPersonaResource } = await importFresh('src/scripts/extensions/designer/persona-tools.js');

    const st = fakeSt({
        scriptModule: createFakeScriptModule(),
        worldInfoModule: createFakeWorldInfoModule(),
        promptModules: createFakePromptModules(),
        personas: { user_avatar: '' },
    });
    const revLock = createRevLock();

    const tools = buildUnifiedTools([
        createCharacterResource({ script: st.script, revLock }),
        createWorldInfoResource({ worldInfo: st.worldInfo, revLock }),
        createPromptResource({ presetManager: st.presetManager, sysprompt: st.sysprompt, powerUser: st.powerUser, revLock }),
        createPersonaResource({
            personas: st.personas,
            powerUser: st.powerUser,
            saveSettings: () => {},
            emit: () => {},
            revLock,
        }),
    ]);

    assert.deepEqual(tools.map((t) => t.name), ['read', 'create', 'update', 'delete']);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const fullTargets = ['character', 'world_info', 'prompt', 'persona'];
    const crudTargets = ['character', 'world_info', 'prompt'];
    for (const tool of tools) {
        assert.equal(tool.name, tool.name.toLowerCase());
        assert.equal(typeof tool.description, 'string');
        assert.equal(tool.description.length > 100, true);
        assert.equal(typeof tool.parameters, 'object');
        assert.deepEqual(tool.parameters.required, ['target']);
        const enumTargets = tool.parameters.properties.target.enum;
        assert.deepEqual(enumTargets, tool.name === 'read' || tool.name === 'update' ? fullTargets : crudTargets);
        assert.equal(typeof tool.action, 'function');
        assert.equal(typeof tool.formatMessage, 'function');
        assert.equal(tool.shouldRegister(), true);
    }

    // Dispatch rejects unknown targets with a recoverable error
    await assert.rejects(byName.read.action({ target: 'nobody' }), /designer\.unknown_target/);
});

test('designer tools: adding a resource adapter extends the target enum uniformly', async () => {
    const { buildUnifiedTools } = await importFresh('src/scripts/extensions/designer/build-tools.js');

    const personaResource = {
        name: 'persona',
        verbs: {
            read: { action: async () => ({}), description: 'read personas', parameters: { type: 'object', properties: {} } },
            create: { action: async () => ({}), description: 'create personas', parameters: { type: 'object', properties: {} } },
        },
    };
    const tools = buildUnifiedTools([personaResource]);
    assert.deepEqual(tools.map((t) => t.name), ['read', 'create']);
    assert.deepEqual(tools[0].parameters.properties.target.enum, ['persona']);
    for (const tool of tools) {
        assert.equal(typeof tool.action, 'function');
        assert.equal(typeof tool.description, 'string');
        assert.equal(tool.shouldRegister(), true);
    }
});

function fullAdaCard(overrides = {}) {
    return {
        name: 'Ada',
        description: 'hello',
        personality: 'dry humor',
        scenario: '',
        first_mes: 'hi',
        mes_example: '',
        system_prompt: '',
        post_history_instructions: '',
        creator_notes: '',
        creator: '',
        character_version: '1.0',
        tags: ['librarian'],
        talkativeness: 0.5,
        world: '',
        depth_prompt: { prompt: '', depth: 4, role: 'system' },
        ...overrides,
    };
}

function fullEntry(overrides = {}) {
    return {
        key: ['castle'],
        keysecondary: [],
        comment: '',
        content: '',
        constant: false,
        selective: true,
        disable: false,
        excludeRecursion: false,
        preventRecursion: false,
        order: 100,
        position: 0,
        delayUntilRecursion: 0,
        depth: 4,
        group: '',
        ...overrides,
    };
}

test('character tools: read, update with rev lock, create, delete', async () => {
    const { createRevLock } = await importFresh('src/scripts/extensions/designer/rev-lock.js');
    const { buildUnifiedTools } = await importFresh('src/scripts/extensions/designer/build-tools.js');
    const { createCharacterResource } = await importFresh('src/scripts/extensions/designer/character-tools.js');

    const characters = [
        { avatar: 'a1.png', name: 'Ada', data: { name: 'Ada', description: 'hello', personality: 'dry humor', tags: ['librarian'], talkativeness: 0.5, extensions: {} } },
    ];
    const scriptModule = createFakeScriptModule({ characters, this_chid: 0 });
    const fetchHarness = createFakeFetch((url, options) => {
        if (url === '/api/characters/merge-attributes') {
            const body = JSON.parse(options.body);
            const character = characters.find((c) => c.avatar === body.avatar);
            if (character) {
                Object.assign(character.data, body.data);
            }
            return { ok: true, status: 200, async text() { return 'ok'; } };
        }
        if (url === '/api/characters/create') {
            const body = JSON.parse(options.body);
            characters.push({ avatar: 'a2.png', name: body.name, data: { ...body.data } });
            return { ok: true, status: 200, async text() { return 'a2.png'; } };
        }
        return { ok: true, status: 200, async text() { return 'ok'; } };
    });
    const st = fakeSt({
        scriptModule,
        worldInfoModule: createFakeWorldInfoModule(),
        promptModules: createFakePromptModules(),
    });
    const tools = buildUnifiedTools([
        createCharacterResource({ script: st.script, revLock: createRevLock(), fetchImpl: fetchHarness.fetchImpl }),
    ]);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.action]));

    // List mode
    const list = await byName.read({ target: 'character',});
    assert.deepEqual(list.characters, [{ avatar: 'a1.png', name: 'Ada' }]);

    // Read detail issues a rev
    const read = await byName.read({ target: 'character', avatar: 'a1.png' });
    assert.equal(read.rev.length > 0, true);
    assert.equal(read.card.description, 'hello');
    assert.deepEqual(read.card.tags, ['librarian'], '数组字段必须原样返回');
    assert.equal(read.truncated, false);

    // Subset reads return only the requested fields; unknown fields rejected
    const subset = await byName.read({ target: 'character', avatar: 'a1.png', fields: ['description', 'tags'] });
    assert.deepEqual(Object.keys(subset.card), ['description', 'tags']);
    await assert.rejects(
        byName.read({ target: 'character', avatar: 'a1.png', fields: ['description', 'avatar'] }),
        /designer\.invalid_fields/,
    );

    // Case-insensitive avatar and name fallback (models mis-guess ids)
    const looseRead = await byName.read({ target: 'character', avatar: 'A1.PNG' });
    assert.equal(looseRead.avatar, 'a1.png');
    const nameRead = await byName.read({ target: 'character', avatar: 'Ada' });
    assert.equal(nameRead.avatar, 'a1.png');
    await assert.rejects(
        byName.read({ target: 'character', avatar: 'nobody' }),
        /designer\.character_not_found/,
    );

    // A full-card update (superset of the patch) is still accepted
    const updated = await byName.update({ target: 'character', avatar: 'a1.png', rev: read.rev, card: fullAdaCard({ description: 'brave' }) });
    assert.ok(updated.updated.includes('description'));
    const mergeRequest = fetchHarness.requests.find((r) => r.url === '/api/characters/merge-attributes');
    assert.ok(mergeRequest);
    const mergeBody = JSON.parse(mergeRequest.options.body);
    assert.equal(mergeBody.data.description, 'brave');
    assert.equal(mergeBody.data.personality, 'dry humor', '完整提交仍是合法超集');

    // Patch semantics: sending only one field changes only that field
    const freshForPatch = await byName.read({ target: 'character', avatar: 'a1.png' });
    const patched = await byName.update({ target: 'character', avatar: 'a1.png', rev: freshForPatch.rev, card: { description: 'brave again' } });
    assert.deepEqual(patched.updated, ['description'], '只上报被修改的字段');
    const patchBody = JSON.parse(fetchHarness.requests.filter((r) => r.url === '/api/characters/merge-attributes').at(-1).options.body);
    assert.deepEqual(Object.keys(patchBody.data), ['description'], 'merge 只携带补丁字段');
    assert.equal('personality' in patchBody.data, false, '未提供的字段不发送、保持原值');

    // Empty patch (no provided fields) is rejected
    const freshForEmpty = await byName.read({ target: 'character', avatar: 'a1.png' });
    await assert.rejects(
        byName.update({ target: 'character', avatar: 'a1.png', rev: freshForEmpty.rev, card: { description: null } }),
        /designer\.no_fields/,
    );

    // Explicit null means "keep the current value" (models emit null habitually)
    const freshForNull = await byName.read({ target: 'character', avatar: 'a1.png' });
    const cardWithNull = { description: null, tags: ['librarian'] };
    const nullUpdated = await byName.update({ target: 'character', avatar: 'a1.png', rev: freshForNull.rev, card: cardWithNull });
    const nullBody = JSON.parse(fetchHarness.requests.filter((r) => r.url === '/api/characters/merge-attributes').at(-1).options.body);
    assert.equal('description' in nullBody.data, false, 'null 字段不参与更新（保持当前值）');
    assert.deepEqual(nullBody.data.tags, ['librarian'], '非 null 字段正常更新');

    // A truncated read no longer blocks updates (patch semantics is safe)
    const truncatedRead = await byName.read({ target: 'character', avatar: 'a1.png', maxChars: 3 });
    assert.equal(truncatedRead.truncated, true);
    const afterTruncated = await byName.update({ target: 'character', avatar: 'a1.png', rev: truncatedRead.rev, card: { personality: 'x' } });

    // Models sometimes double-wrap card (card.card / card.data) — unwrapped
    const freshForNested = await byName.read({ target: 'character', avatar: 'a1.png' });
    const nestedAda = { card: { data: { description: 'nested-wrapped' } } };
    const nestedUpdated = await byName.update({ target: 'character', avatar: 'a1.png', rev: freshForNested.rev, card: nestedAda });
    const nestedBody = JSON.parse(fetchHarness.requests.filter((r) => r.url === '/api/characters/merge-attributes').at(-1).options.body);
    assert.equal(nestedBody.data.description, 'nested-wrapped');

    // Stale rev (superseded by our own update) fails with rev_invalid
    await assert.rejects(
        byName.update({ target: 'character', avatar: 'a1.png', rev: read.rev, card: fullAdaCard({ description: 'again' }) }),
        /designer\.rev_invalid/,
    );

    // External change after a fresh read fails with rev_mismatch
    const externalRead = await byName.read({ target: 'character', avatar: 'a1.png' });
    characters[0].data.description = 'externally edited';
    await assert.rejects(
        byName.update({ target: 'character', avatar: 'a1.png', rev: externalRead.rev, card: fullAdaCard({ description: 'x' }) }),
        /designer\.rev_mismatch/,
    );

    // Unknown field fails
    const freshRead = await byName.read({ target: 'character', avatar: 'a1.png' });
    await assert.rejects(
        byName.update({ target: 'character', avatar: 'a1.png', rev: freshRead.rev, card: fullAdaCard({ extensions: {} }) }),
        /designer\.unknown_field/,
    );

    // Create posts to the JSON create route and returns a rev
    const created = await byName.create({ target: 'character', card: { name: 'Bob', description: 'strong' } });
    assert.equal(created.avatar, 'a2.png');
    const createRequest = fetchHarness.requests.find((r) => r.url === '/api/characters/create');
    assert.ok(createRequest);
    const createBody = JSON.parse(createRequest.options.body);
    assert.equal(createBody.name, 'Bob');
    assert.equal(createBody.data.description, 'strong');

    // Delete requires rev and does not delete chats by default
    const readForDelete = await byName.read({ target: 'character', avatar: 'a1.png' });
    const deleted = await byName.delete({ target: 'character', avatar: 'a1.png', rev: readForDelete.rev });
    assert.equal(deleted.deleted, 'a1.png');
    assert.equal(characters.length, 1);
    assert.equal(characters[0].avatar, 'a2.png');

    // Delete without rev is rejected
    const created2 = await byName.create({ target: 'character', card: { name: 'Cid' } });
    await assert.rejects(() => byName.delete({ target: 'character', avatar: created2.avatar }), /designer\.rev_required/);
});

test('world info tools: writes notify UI sync hooks', async () => {
    const { createRevLock } = await importFresh('src/scripts/extensions/designer/rev-lock.js');
    const { buildUnifiedTools } = await importFresh('src/scripts/extensions/designer/build-tools.js');
    const { createWorldInfoResource } = await importFresh('src/scripts/extensions/designer/world-info-tools.js');

    const worldInfoModule = createFakeWorldInfoModule();
    const st = fakeSt({
        scriptModule: createFakeScriptModule(),
        worldInfoModule,
        promptModules: createFakePromptModules(),
    });
    const calls = { entryChanged: [], bookListChanged: 0 };
    const tools = buildUnifiedTools([
        createWorldInfoResource({
            worldInfo: st.worldInfo,
            revLock: createRevLock(),
            syncUi: {
                entryChanged: (book) => calls.entryChanged.push(book),
                bookListChanged: () => calls.bookListChanged += 1,
            },
        }),
    ]);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.action]));

    // Book create -> book list refresh only
    await byName.create({ target: 'world_info', book: 'Lorebook' });
    assert.equal(calls.bookListChanged, 1);
    assert.deepEqual(calls.entryChanged, []);

    // Entry create on existing book -> entry refresh only
    await byName.create({ target: 'world_info', book: 'Lorebook', entry: { key: ['castle'], content: 'On a hill.' } });
    assert.equal(calls.bookListChanged, 1);
    assert.deepEqual(calls.entryChanged, ['Lorebook']);

    // Entry create on a NEW book -> both refreshes
    await byName.create({ target: 'world_info', book: 'NewBook', entry: { key: ['x'], content: 'y' } });
    assert.equal(calls.bookListChanged, 2);
    assert.deepEqual(calls.entryChanged, ['Lorebook', 'NewBook']);

    // Entry update -> entry refresh
    const list = await byName.read({ target: 'world_info', book: 'Lorebook' });
    const uid = String(list.entries[0].uid);
    const read = await byName.read({ target: 'world_info', book: 'Lorebook', uid });
    const before = calls.entryChanged.length;
    await byName.update({
        target: 'world_info',
        book: 'Lorebook',
        uid,
        rev: read.rev,
        entry: { key: ['castle'], keysecondary: [], comment: '', content: 'Updated.', constant: false, selective: false, disable: false, excludeRecursion: false, preventRecursion: false, order: 100, position: 0, delayUntilRecursion: 0, depth: 4, group: '' },
    });
    assert.deepEqual(calls.entryChanged.slice(before), ['Lorebook']);

    // Entry delete -> entry refresh; book delete -> list refresh
    const readAfterUpdate = await byName.read({ target: 'world_info', book: 'Lorebook', uid });
    await byName.delete({ target: 'world_info', book: 'Lorebook', uid, rev: readAfterUpdate.rev });
    assert.deepEqual(calls.entryChanged.slice(-1), ['Lorebook']);
    const bookList = await byName.read({ target: 'world_info', book: 'NewBook' });
    const bookRev = bookList.rev;
    const beforeList = calls.bookListChanged;
    await byName.delete({ target: 'world_info', book: 'NewBook', rev: bookRev });
    assert.equal(calls.bookListChanged, beforeList + 1);
});

test('world info tools: book and entry CRUD with rev lock', async () => {
    const { createRevLock } = await importFresh('src/scripts/extensions/designer/rev-lock.js');
    const { buildUnifiedTools } = await importFresh('src/scripts/extensions/designer/build-tools.js');
    const { createWorldInfoResource } = await importFresh('src/scripts/extensions/designer/world-info-tools.js');

    const worldInfoModule = createFakeWorldInfoModule();
    const st = fakeSt({
        scriptModule: createFakeScriptModule(),
        worldInfoModule,
        promptModules: createFakePromptModules(),
    });
    const tools = buildUnifiedTools([
        createWorldInfoResource({ worldInfo: st.worldInfo, revLock: createRevLock() }),
    ]);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.action]));

    // Create a book
    const book = await byName.create({ target: 'world_info', book: 'Lorebook' });
    assert.equal(book.book, 'Lorebook');
    assert.ok(worldInfoModule.worldInfoCache.has('Lorebook'));

    // Create an entry
    const entry = await byName.create({ target: 'world_info', book: 'Lorebook', entry: { key: ['castle'], content: 'On a hill.' } });
    assert.equal(typeof entry.uid, 'number');
    const storedNewEntry = worldInfoModule.worldInfoCache.get('Lorebook').entries[entry.uid];
    assert.equal(storedNewEntry.uid, entry.uid, '条目对象必须携带与键一致的数值 uid（渲染器依赖）');

    // Read entry list carries a book rev
    const list = await byName.read({ target: 'world_info', book: 'Lorebook' });
    assert.equal(list.count, 1);

    // Case-insensitive book lookup (models mis-case names)
    const looseList = await byName.read({ target: 'world_info', book: 'lorebook' });
    assert.equal(looseList.count, 1);

    // Read the entry carries an entry rev
    const read = await byName.read({ target: 'world_info', book: 'Lorebook', uid: String(entry.uid) });
    assert.equal(read.entry.content, 'On a hill.');

    // Subset entry reads return only the requested fields
    const subsetEntry = await byName.read({ target: 'world_info', book: 'Lorebook', uid: String(entry.uid), fields: ['content'] });
    assert.deepEqual(Object.keys(subsetEntry.entry), ['content']);
    await assert.rejects(
        byName.read({ target: 'world_info', book: 'Lorebook', uid: String(entry.uid), fields: ['bogus'] }),
        /designer\.invalid_fields/,
    );

    // Patch semantics: a partial entry update succeeds (before the full update)
    const partialEntry = await byName.update({ target: 'world_info',
        book: 'Lorebook',
        uid: String(entry.uid),
        rev: read.rev,
        entry: { content: 'only this' },
    });
    assert.deepEqual(partialEntry.updated, ['content'], '只上报被修改的字段');

    // Full entry update (superset of the patch) is still accepted
    const readAfterPatch = await byName.read({ target: 'world_info', book: 'Lorebook', uid: String(entry.uid) });
    const updated = await byName.update({ target: 'world_info',
        book: 'Lorebook',
        uid: String(entry.uid),
        rev: readAfterPatch.rev,
        entry: fullEntry({ content: 'On a hill, guarded.', key: ['castle'] }),
    });
    assert.equal(updated.updated.length, 14, '全量提交仍是合法超集');
    assert.ok(updated.updated.includes('content'));
    assert.ok(updated.updated.includes('key'));

    // Partial update leaves omitted fields untouched
    const freshForPatch = await byName.read({ target: 'world_info', book: 'Lorebook', uid: String(entry.uid) });
    const patchedEntry = await byName.update({ target: 'world_info',
        book: 'Lorebook',
        uid: String(entry.uid),
        rev: freshForPatch.rev,
        entry: { content: 'patched only' },
    });
    const storedEntry = worldInfoModule.worldInfoCache.get('Lorebook').entries[entry.uid];
    assert.equal(storedEntry.content, 'patched only');
    assert.equal(storedEntry.comment, '', '未提供的字段保持原值');

    // Empty patch (no updatable fields) is rejected
    const freshForEmptyEntry = await byName.read({ target: 'world_info', book: 'Lorebook', uid: String(entry.uid) });
    await assert.rejects(
        byName.update({ target: 'world_info',
            book: 'Lorebook',
            uid: String(entry.uid),
            rev: freshForEmptyEntry.rev,
            entry: { comment: null, content: null },
        }),
        /designer\.no_fields/,
    );

    // Stale rev (superseded by our own update) fails with rev_invalid
    await assert.rejects(
        byName.update({ target: 'world_info',
            book: 'Lorebook',
            uid: String(entry.uid),
            rev: read.rev,
            entry: fullEntry({ content: 'x' }),
        }),
        /designer\.rev_invalid/,
    );

    // External change after a fresh read fails with rev_mismatch
    const externalRead = await byName.read({ target: 'world_info', book: 'Lorebook', uid: String(entry.uid) });
    worldInfoModule.worldInfoCache.get('Lorebook').entries[entry.uid].content = 'externally edited';
    await assert.rejects(
        byName.update({ target: 'world_info',
            book: 'Lorebook',
            uid: String(entry.uid),
            rev: externalRead.rev,
            entry: fullEntry({ content: 'y' }),
        }),
        /designer\.rev_mismatch/,
    );

    // Delete the entry
    const readAgain = await byName.read({ target: 'world_info', book: 'Lorebook', uid: String(entry.uid) });
    const deletedEntry = await byName.delete({ target: 'world_info', book: 'Lorebook', uid: String(entry.uid), rev: readAgain.rev });
    assert.equal(deletedEntry.deleted, String(entry.uid));
    assert.equal(worldInfoModule.worldInfoCache.get('Lorebook').entries[entry.uid], undefined);

    // Delete the book with its book rev
    const bookList = await byName.read({ target: 'world_info', book: 'Lorebook' });
    const deletedBook = await byName.delete({ target: 'world_info', book: 'Lorebook', rev: bookList.rev });
    assert.equal(deletedBook.deleted, 'Lorebook');
    assert.equal(worldInfoModule.worldInfoCache.has('Lorebook'), false);
});

test('prompt tools: preset CRUD with rev lock', async () => {
    const { createRevLock } = await importFresh('src/scripts/extensions/designer/rev-lock.js');
    const { buildUnifiedTools } = await importFresh('src/scripts/extensions/designer/build-tools.js');
    const { createPromptResource } = await importFresh('src/scripts/extensions/designer/prompt-tools.js');

    const promptModules = createFakePromptModules({ presets: [{ name: 'RP', content: 'old' }] });
    const st = fakeSt({
        scriptModule: createFakeScriptModule(),
        worldInfoModule: createFakeWorldInfoModule(),
        promptModules,
    });
    const tools = buildUnifiedTools([
        createPromptResource({ presetManager: st.presetManager, sysprompt: st.sysprompt, powerUser: st.powerUser, revLock: createRevLock() }),
    ]);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.action]));

    // List
    const list = await byName.read({ target: 'prompt',});
    assert.deepEqual(list.prompts, [{ name: 'RP', contentChars: 3 }]);

    // Read detail issues a rev and returns the object under the update key
    const read = await byName.read({ target: 'prompt', name: 'RP' });
    assert.equal(read.prompt.content, 'old');
    assert.equal(read.prompt.post_history, '');

    // Full prompt update (all fields) with the issued rev
    const updated = await byName.update({ target: 'prompt', name: 'RP', rev: read.rev, prompt: { content: 'new', post_history: '' } });
    assert.equal(promptModules.systemPrompts[0].content, 'new');

    // Missing empty post_history is auto-filled from the current preset
    const freshForAutoFill = await byName.read({ target: 'prompt', name: 'RP' });
    const autoFilled = await byName.update({ target: 'prompt', name: 'RP', rev: freshForAutoFill.rev, prompt: { content: 'auto' } });
    assert.equal(promptModules.systemPrompts[0].content, 'auto');
    assert.equal(promptModules.systemPrompts[0].post_history ?? '', '');

    // Stale rev (superseded by our own update) fails with rev_invalid
    await assert.rejects(
        byName.update({ target: 'prompt', name: 'RP', rev: read.rev, prompt: { content: 'x', post_history: '' } }),
        /designer\.rev_invalid/,
    );

    // External change after a fresh read fails with rev_mismatch
    const externalRead = await byName.read({ target: 'prompt', name: 'RP' });
    promptModules.systemPrompts[0].content = 'externally edited';
    await assert.rejects(
        byName.update({ target: 'prompt', name: 'RP', rev: externalRead.rev, prompt: { content: 'y', post_history: '' } }),
        /designer\.rev_mismatch/,
    );

    // Create a new preset and reject duplicates
    const created = await byName.create({ target: 'prompt', name: 'Noir', content: 'dark' });
    assert.equal(promptModules.systemPrompts.length, 2);
    await assert.rejects(
        byName.create({ target: 'prompt', name: 'noir', content: 'x' }),
        /designer\.prompt_exists/,
    );

    // Delete with rev
    const readNoir = await byName.read({ target: 'prompt', name: 'Noir' });
    const deleted = await byName.delete({ target: 'prompt', name: 'Noir', rev: readNoir.rev });
    assert.equal(promptModules.systemPrompts.length, 1);

    // Missing name is rejected when no system prompt is enabled
    await assert.rejects(() => byName.delete({ target: 'prompt', rev: 'x' }), /designer\.prompt_name_required/);
});

test('prompt tools: omitted name resolves to the active system prompt', async () => {
    const { createRevLock } = await importFresh('src/scripts/extensions/designer/rev-lock.js');
    const { buildUnifiedTools } = await importFresh('src/scripts/extensions/designer/build-tools.js');
    const { createPromptResource } = await importFresh('src/scripts/extensions/designer/prompt-tools.js');

    const promptModules = createFakePromptModules({ presets: [{ name: 'Active', content: 'current' }] });
    promptModules.powerUser.power_user.sysprompt = { enabled: true, name: 'Active', content: 'current' };
    const st = fakeSt({
        scriptModule: createFakeScriptModule(),
        worldInfoModule: createFakeWorldInfoModule(),
        promptModules,
    });
    const tools = buildUnifiedTools([
        createPromptResource({ presetManager: st.presetManager, sysprompt: st.sysprompt, powerUser: st.powerUser, revLock: createRevLock() }),
    ]);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.action]));

    // Read the active prompt by omitting name
    const read = await byName.read({ target: 'prompt',});
    assert.deepEqual(read.current, { enabled: true, name: 'Active' });

    const detail = await byName.read({ target: 'prompt', name: 'Active' });
    assert.equal(detail.prompt.content, 'current');

    // Update without name targets the active prompt
    const updated = await byName.update({ target: 'prompt', rev: detail.rev, prompt: { content: 'updated', post_history: '' } });
    assert.equal(promptModules.systemPrompts[0].content, 'updated');

    // Delete without name targets the active prompt
    const readAgain = await byName.read({ target: 'prompt', name: 'Active' });
    const deleted = await byName.delete({ target: 'prompt', rev: readAgain.rev });
    assert.equal(promptModules.systemPrompts.length, 0);
});

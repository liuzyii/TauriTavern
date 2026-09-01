import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

function fakeSt({ scriptModule, worldInfoModule, promptModules }) {
    return {
        loadScript: async () => scriptModule,
        loadWorldInfo: async () => worldInfoModule,
        loadPresetManager: async () => promptModules.presetManager,
        loadSysprompt: async () => promptModules.sysprompt,
        loadPowerUser: async () => promptModules.powerUser,
    };
}

test('rev-lock: issue, verify, commit and forget lifecycle', async () => {
    const { createRevLock, canonicalJson, fingerprint } = await importFresh('src/scripts/extensions/designer/src/rev-lock.js');
    const lock = createRevLock();

    const value = { b: 1, a: [3, 2] };
    assert.equal(canonicalJson(value), '{"a":[3,2],"b":1}');

    const rev = await lock.issue('k', value);
    assert.equal(typeof rev, 'string');
    assert.match(rev, /^[0-9a-f]{6}$/);
    assert.equal(rev.length, 6, 'rev 必须是 6 位十六进制（参考 git 短哈希，过长的 rev 会被模型抄错）');
    assert.equal(rev, await fingerprint(value));

    const good = await lock.verify('k', rev, value);
    assert.equal(good.ok, true);

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

    const nextRev = await lock.commit('k', changed);
    assert.equal(nextRev, mismatch.rev);
    const afterCommit = await lock.verify('k', nextRev, changed);
    assert.equal(afterCommit.ok, true);

    lock.forget('k');
    const forgotten = await lock.verify('k', nextRev, changed);
    assert.equal(forgotten.code, 'designer.rev_unknown');
});

test('common: character update whitelist and payload builders', async () => {
    const common = await importFresh('src/scripts/extensions/designer/src/common.js');

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
    const common = await importFresh('src/scripts/extensions/designer/src/common.js');

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

test('designer tools: 12 lowercase verb-first CRUD definitions', async () => {
    const { createRevLock } = await importFresh('src/scripts/extensions/designer/src/rev-lock.js');
    const { buildDesignerTools } = await importFresh('src/scripts/extensions/designer/src/build-tools.js');
    const { createCharacterResource } = await importFresh('src/scripts/extensions/designer/src/character-tools.js');
    const { createWorldInfoResource } = await importFresh('src/scripts/extensions/designer/src/world-info-tools.js');
    const { createPromptResource } = await importFresh('src/scripts/extensions/designer/src/prompt-tools.js');

    const st = fakeSt({
        scriptModule: createFakeScriptModule(),
        worldInfoModule: createFakeWorldInfoModule(),
        promptModules: createFakePromptModules(),
    });
    const revLock = createRevLock();

    const tools = buildDesignerTools([
        createCharacterResource({ st, revLock }),
        createWorldInfoResource({ st, revLock }),
        createPromptResource({ st, revLock }),
    ]);

    assert.deepEqual(
        tools.map((t) => t.name),
        [
            'read_character', 'create_character', 'update_character', 'delete_character',
            'read_world_info', 'create_world_info', 'update_world_info', 'delete_world_info',
            'read_prompt', 'create_prompt', 'update_prompt', 'delete_prompt',
        ],
    );
    for (const tool of tools) {
        assert.match(tool.name, /^(read|create|update|delete)_/);
        assert.equal(tool.name, tool.name.toLowerCase());
        assert.equal(typeof tool.description, 'string');
        assert.equal(typeof tool.parameters, 'object');
        assert.equal(typeof tool.action, 'function');
        assert.equal(typeof tool.formatMessage, 'function');
        assert.equal(tool.shouldRegister(), true);
    }
});

test('designer tools: adding a resource adapter extends the tool set uniformly', async () => {
    const { buildDesignerTools } = await importFresh('src/scripts/extensions/designer/src/build-tools.js');

    const personaResource = {
        name: 'persona',
        verbs: {
            read: { action: async () => ({}), description: 'read personas', parameters: { type: 'object', properties: {} } },
            create: { action: async () => ({}), description: 'create personas', parameters: { type: 'object', properties: {} } },
        },
    };
    const tools = buildDesignerTools([personaResource]);
    assert.deepEqual(tools.map((t) => t.name), ['read_persona', 'create_persona']);
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
    const { createRevLock } = await importFresh('src/scripts/extensions/designer/src/rev-lock.js');
    const { buildDesignerTools } = await importFresh('src/scripts/extensions/designer/src/build-tools.js');
    const { createCharacterResource } = await importFresh('src/scripts/extensions/designer/src/character-tools.js');

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
    const tools = buildDesignerTools([
        createCharacterResource({ st, revLock: createRevLock(), fetchImpl: fetchHarness.fetchImpl }),
    ]);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.action]));

    // List mode
    const list = await byName.read_character({});
    assert.equal(list.ok, true);
    assert.deepEqual(list.characters, [{ avatar: 'a1.png', name: 'Ada' }]);

    // Read detail issues a rev
    const read = await byName.read_character({ avatar: 'a1.png' });
    assert.equal(read.ok, true);
    assert.equal(read.rev.length > 0, true);
    assert.equal(read.fields.description, 'hello');
    assert.deepEqual(read.fields.tags, ['librarian'], '数组字段必须原样返回（完整对象契约）');
    assert.equal(read.truncated, false);

    // Case-insensitive avatar and name fallback (models mis-guess ids)
    const looseRead = await byName.read_character({ avatar: 'A1.PNG' });
    assert.equal(looseRead.ok, true);
    assert.equal(looseRead.avatar, 'a1.png');
    const nameRead = await byName.read_character({ avatar: 'Ada' });
    assert.equal(nameRead.ok, true);
    assert.equal(nameRead.avatar, 'a1.png');
    await assert.rejects(
        byName.read_character({ avatar: 'nobody' }),
        /designer\.character_not_found/,
    );

    // Partial cards are rejected when non-empty fields are missing
    await assert.rejects(
        byName.update_character({ avatar: 'a1.png', rev: read.rev, card: { description: 'only this' } }),
        /designer\.incomplete_update/,
    );

    // Update with the issued rev requires the COMPLETE card
    const updated = await byName.update_character({ avatar: 'a1.png', rev: read.rev, card: fullAdaCard({ description: 'brave' }) });
    assert.equal(updated.ok, true);
    assert.ok(updated.updated.includes('description'));
    const mergeRequest = fetchHarness.requests.find((r) => r.url === '/api/characters/merge-attributes');
    assert.ok(mergeRequest);
    const mergeBody = JSON.parse(mergeRequest.options.body);
    assert.equal(mergeBody.data.description, 'brave');
    assert.equal(mergeBody.data.personality, 'dry humor', '未改字段也必须随完整对象提交');

    // Missing empty/default fields are auto-filled from the current card
    const freshForAutoFill = await byName.read_character({ avatar: 'a1.png' });
    const cardWithoutEmptyFields = fullAdaCard({ description: 'brave again' });
    delete cardWithoutEmptyFields.scenario;
    delete cardWithoutEmptyFields.world;
    const autoFilled = await byName.update_character({ avatar: 'a1.png', rev: freshForAutoFill.rev, card: cardWithoutEmptyFields });
    assert.equal(autoFilled.ok, true);
    const mergeRequests = fetchHarness.requests.filter((r) => r.url === '/api/characters/merge-attributes');
    const autoFillBody = JSON.parse(mergeRequests.at(-1).options.body);
    assert.equal(autoFillBody.data.scenario, '', '缺失的空字段自动沿用旧值');
    assert.equal(autoFillBody.data.extensions.world, '', '缺失的默认 extensions 字段自动沿用旧值');

    // Explicit null means "keep the current value" (models emit null habitually)
    const freshForNull = await byName.read_character({ avatar: 'a1.png' });
    const cardWithNull = fullAdaCard({ description: null, depth_prompt: null });
    const nullUpdated = await byName.update_character({ avatar: 'a1.png', rev: freshForNull.rev, card: cardWithNull });
    assert.equal(nullUpdated.ok, true);
    const nullBody = JSON.parse(fetchHarness.requests.filter((r) => r.url === '/api/characters/merge-attributes').at(-1).options.body);
    assert.equal('description' in nullBody.data, false, 'null 字段不参与更新（保持当前值）');
    assert.equal('depth_prompt' in nullBody.data.extensions, false, 'null 的 depth_prompt 不参与更新');

    // Stale rev (superseded by our own update) fails with rev_invalid
    await assert.rejects(
        byName.update_character({ avatar: 'a1.png', rev: read.rev, card: fullAdaCard({ description: 'again' }) }),
        /designer\.rev_invalid/,
    );

    // External change after a fresh read fails with rev_mismatch
    const externalRead = await byName.read_character({ avatar: 'a1.png' });
    characters[0].data.description = 'externally edited';
    await assert.rejects(
        byName.update_character({ avatar: 'a1.png', rev: externalRead.rev, card: fullAdaCard({ description: 'x' }) }),
        /designer\.rev_mismatch/,
    );

    // Unknown field fails
    const freshRead = await byName.read_character({ avatar: 'a1.png' });
    await assert.rejects(
        byName.update_character({ avatar: 'a1.png', rev: freshRead.rev, card: fullAdaCard({ extensions: {} }) }),
        /designer\.unknown_field/,
    );

    // Create posts to the JSON create route and returns a rev
    const created = await byName.create_character({ card: { name: 'Bob', description: 'strong' } });
    assert.equal(created.ok, true);
    assert.equal(created.avatar, 'a2.png');
    const createRequest = fetchHarness.requests.find((r) => r.url === '/api/characters/create');
    assert.ok(createRequest);
    const createBody = JSON.parse(createRequest.options.body);
    assert.equal(createBody.name, 'Bob');
    assert.equal(createBody.data.description, 'strong');

    // Delete requires rev and does not delete chats by default
    const readForDelete = await byName.read_character({ avatar: 'a1.png' });
    const deleted = await byName.delete_character({ avatar: 'a1.png', rev: readForDelete.rev });
    assert.equal(deleted.ok, true);
    assert.equal(deleted.deleteChats, false);
    assert.equal(characters.length, 1);
    assert.equal(characters[0].avatar, 'a2.png');

    // Delete without rev is rejected
    const created2 = await byName.create_character({ card: { name: 'Cid' } });
    await assert.rejects(() => byName.delete_character({ avatar: created2.avatar }), /designer\.rev_required/);
});

test('world info tools: book and entry CRUD with rev lock', async () => {
    const { createRevLock } = await importFresh('src/scripts/extensions/designer/src/rev-lock.js');
    const { buildDesignerTools } = await importFresh('src/scripts/extensions/designer/src/build-tools.js');
    const { createWorldInfoResource } = await importFresh('src/scripts/extensions/designer/src/world-info-tools.js');

    const worldInfoModule = createFakeWorldInfoModule();
    const st = fakeSt({
        scriptModule: createFakeScriptModule(),
        worldInfoModule,
        promptModules: createFakePromptModules(),
    });
    const tools = buildDesignerTools([
        createWorldInfoResource({ st, revLock: createRevLock() }),
    ]);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.action]));

    // Create a book
    const book = await byName.create_world_info({ book: 'Lorebook' });
    assert.equal(book.ok, true);
    assert.equal(book.created, 'book');
    assert.ok(worldInfoModule.worldInfoCache.has('Lorebook'));

    // Create an entry
    const entry = await byName.create_world_info({ book: 'Lorebook', entry: { key: ['castle'], content: 'On a hill.' } });
    assert.equal(entry.ok, true);
    assert.equal(entry.created, 'entry');
    assert.equal(typeof entry.uid, 'number');

    // Read entry list carries a book rev
    const list = await byName.read_world_info({ book: 'Lorebook' });
    assert.equal(list.ok, true);
    assert.equal(list.count, 1);

    // Case-insensitive book lookup (models mis-case names)
    const looseList = await byName.read_world_info({ book: 'lorebook' });
    assert.equal(looseList.ok, true);
    assert.equal(looseList.count, 1);

    // Read the entry carries an entry rev
    const read = await byName.read_world_info({ book: 'Lorebook', uid: String(entry.uid) });
    assert.equal(read.ok, true);
    assert.equal(read.entry.content, 'On a hill.');

    // Partial entries are rejected (before any successful update)
    await assert.rejects(
        byName.update_world_info({
            book: 'Lorebook',
            uid: String(entry.uid),
            rev: read.rev,
            entry: { content: 'only this' },
        }),
        /designer\.incomplete_update/,
    );

    // Update with the entry rev requires the COMPLETE entry
    const updated = await byName.update_world_info({
        book: 'Lorebook',
        uid: String(entry.uid),
        rev: read.rev,
        entry: fullEntry({ content: 'On a hill, guarded.', key: ['castle'] }),
    });
    assert.equal(updated.ok, true);
    assert.equal(updated.updated.length, 14, '完整对象契约：全部可编辑字段一并提交');
    assert.ok(updated.updated.includes('content'));
    assert.ok(updated.updated.includes('key'));

    // Missing empty fields are auto-filled from the current entry
    const freshEntryForAutoFill = await byName.read_world_info({ book: 'Lorebook', uid: String(entry.uid) });
    const entryWithoutComment = fullEntry({ content: 'auto' });
    delete entryWithoutComment.comment;
    const autoFilledEntry = await byName.update_world_info({
        book: 'Lorebook',
        uid: String(entry.uid),
        rev: freshEntryForAutoFill.rev,
        entry: entryWithoutComment,
    });
    assert.equal(autoFilledEntry.ok, true);
    assert.equal(worldInfoModule.worldInfoCache.get('Lorebook').entries[entry.uid].comment, '');

    // Stale rev (superseded by our own update) fails with rev_invalid
    await assert.rejects(
        byName.update_world_info({
            book: 'Lorebook',
            uid: String(entry.uid),
            rev: read.rev,
            entry: fullEntry({ content: 'x' }),
        }),
        /designer\.rev_invalid/,
    );

    // External change after a fresh read fails with rev_mismatch
    const externalRead = await byName.read_world_info({ book: 'Lorebook', uid: String(entry.uid) });
    worldInfoModule.worldInfoCache.get('Lorebook').entries[entry.uid].content = 'externally edited';
    await assert.rejects(
        byName.update_world_info({
            book: 'Lorebook',
            uid: String(entry.uid),
            rev: externalRead.rev,
            entry: fullEntry({ content: 'y' }),
        }),
        /designer\.rev_mismatch/,
    );

    // Delete the entry
    const readAgain = await byName.read_world_info({ book: 'Lorebook', uid: String(entry.uid) });
    const deletedEntry = await byName.delete_world_info({ book: 'Lorebook', uid: String(entry.uid), rev: readAgain.rev });
    assert.equal(deletedEntry.ok, true);
    assert.equal(deletedEntry.deleted, 'entry');
    assert.equal(worldInfoModule.worldInfoCache.get('Lorebook').entries[entry.uid], undefined);

    // Delete the book with its book rev
    const bookList = await byName.read_world_info({ book: 'Lorebook' });
    const deletedBook = await byName.delete_world_info({ book: 'Lorebook', rev: bookList.rev });
    assert.equal(deletedBook.ok, true);
    assert.equal(deletedBook.deleted, 'book');
    assert.equal(worldInfoModule.worldInfoCache.has('Lorebook'), false);
});

test('prompt tools: preset CRUD with rev lock', async () => {
    const { createRevLock } = await importFresh('src/scripts/extensions/designer/src/rev-lock.js');
    const { buildDesignerTools } = await importFresh('src/scripts/extensions/designer/src/build-tools.js');
    const { createPromptResource } = await importFresh('src/scripts/extensions/designer/src/prompt-tools.js');

    const promptModules = createFakePromptModules({ presets: [{ name: 'RP', content: 'old' }] });
    const st = fakeSt({
        scriptModule: createFakeScriptModule(),
        worldInfoModule: createFakeWorldInfoModule(),
        promptModules,
    });
    const tools = buildDesignerTools([
        createPromptResource({ st, revLock: createRevLock() }),
    ]);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.action]));

    // List
    const list = await byName.read_prompt({});
    assert.equal(list.ok, true);
    assert.deepEqual(list.prompts, [{ name: 'RP', contentChars: 3 }]);

    // Read detail issues a rev
    const read = await byName.read_prompt({ name: 'RP' });
    assert.equal(read.ok, true);
    assert.equal(read.content, 'old');

    // Update with the rev requires the COMPLETE prompt object
    const updated = await byName.update_prompt({ name: 'RP', rev: read.rev, prompt: { content: 'new', post_history: '' } });
    assert.equal(updated.ok, true);
    assert.equal(promptModules.systemPrompts[0].content, 'new');

    // Missing empty post_history is auto-filled from the current preset
    const freshForAutoFill = await byName.read_prompt({ name: 'RP' });
    const autoFilled = await byName.update_prompt({ name: 'RP', rev: freshForAutoFill.rev, prompt: { content: 'auto' } });
    assert.equal(autoFilled.ok, true);
    assert.equal(promptModules.systemPrompts[0].content, 'auto');
    assert.equal(promptModules.systemPrompts[0].post_history ?? '', '');

    // Stale rev (superseded by our own update) fails with rev_invalid
    await assert.rejects(
        byName.update_prompt({ name: 'RP', rev: read.rev, prompt: { content: 'x', post_history: '' } }),
        /designer\.rev_invalid/,
    );

    // External change after a fresh read fails with rev_mismatch
    const externalRead = await byName.read_prompt({ name: 'RP' });
    promptModules.systemPrompts[0].content = 'externally edited';
    await assert.rejects(
        byName.update_prompt({ name: 'RP', rev: externalRead.rev, prompt: { content: 'y', post_history: '' } }),
        /designer\.rev_mismatch/,
    );

    // Create a new preset and reject duplicates
    const created = await byName.create_prompt({ name: 'Noir', content: 'dark' });
    assert.equal(created.ok, true);
    assert.equal(promptModules.systemPrompts.length, 2);
    await assert.rejects(
        byName.create_prompt({ name: 'noir', content: 'x' }),
        /designer\.prompt_exists/,
    );

    // Delete with rev
    const readNoir = await byName.read_prompt({ name: 'Noir' });
    const deleted = await byName.delete_prompt({ name: 'Noir', rev: readNoir.rev });
    assert.equal(deleted.ok, true);
    assert.equal(promptModules.systemPrompts.length, 1);

    // Missing name is rejected when no system prompt is enabled
    await assert.rejects(() => byName.delete_prompt({ rev: 'x' }), /designer\.prompt_name_required/);
});

test('prompt tools: omitted name resolves to the active system prompt', async () => {
    const { createRevLock } = await importFresh('src/scripts/extensions/designer/src/rev-lock.js');
    const { buildDesignerTools } = await importFresh('src/scripts/extensions/designer/src/build-tools.js');
    const { createPromptResource } = await importFresh('src/scripts/extensions/designer/src/prompt-tools.js');

    const promptModules = createFakePromptModules({ presets: [{ name: 'Active', content: 'current' }] });
    promptModules.powerUser.power_user.sysprompt = { enabled: true, name: 'Active', content: 'current' };
    const st = fakeSt({
        scriptModule: createFakeScriptModule(),
        worldInfoModule: createFakeWorldInfoModule(),
        promptModules,
    });
    const tools = buildDesignerTools([
        createPromptResource({ st, revLock: createRevLock() }),
    ]);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.action]));

    // Read the active prompt by omitting name
    const read = await byName.read_prompt({});
    assert.equal(read.ok, true);
    assert.deepEqual(read.current, { enabled: true, name: 'Active' });

    const detail = await byName.read_prompt({ name: 'Active' });
    assert.equal(detail.content, 'current');

    // Update without name targets the active prompt
    const updated = await byName.update_prompt({ rev: detail.rev, prompt: { content: 'updated', post_history: '' } });
    assert.equal(updated.ok, true);
    assert.equal(promptModules.systemPrompts[0].content, 'updated');

    // Delete without name targets the active prompt
    const readAgain = await byName.read_prompt({ name: 'Active' });
    const deleted = await byName.delete_prompt({ rev: readAgain.rev });
    assert.equal(deleted.ok, true);
    assert.equal(promptModules.systemPrompts.length, 0);
});

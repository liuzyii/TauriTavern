// @ts-check
//
// Designer 扩展的真实模型端到端测试（无需启动 Tauri 应用）。
//
// 用法：
//   DEEPSEEK_API_KEY=sk-xxx node scripts/designer-deepseek-e2e.mjs
//
// 它模拟 SillyTavern 原生 function-calling 循环：
//   1. 把 Designer 的 12 个工具定义（与注册进 ToolManager 的完全一致）发送给
//      DeepSeek chat-completions API（tools + tool_choice:auto）；
//   2. 模型返回 tool_calls 时，调用我们真实的 action 实现（character/world-info/
//      prompt 工具 + rev 状态锁），结果以 role:'tool' 消息回填；
//   3. 循环直到模型输出正文，然后断言沙箱内状态变化是否符合预期。
//
// 不写入任何真实数据：角色卡/世界书/预设都是内存假后端。

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESIGNER_SRC = path.join(REPO_ROOT, 'src/scripts/extensions/designer/src');

async function importDesigner(moduleName) {
    const url = `${pathToFileURL(path.join(DESIGNER_SRC, moduleName)).href}?t=${Date.now()}-${Math.random()}`;
    return import(url);
}

const API_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-chat';
// Mirrors ToolManager.RECURSE_LIMIT / oai_settings.tool_call_recurse_limit:
// in the real app `canPerformToolCalls = ... && depth < RECURSE_LIMIT`
// (src/script.js:5326), so tools are registered for at most 5 rounds and the
// next request goes out WITHOUT tools — the model must then finish in text.
const RECURSE_LIMIT = 5;

// ---------------------------------------------------------------------------
// 内存假后端（与 tests/designer-contract.test.mjs 同构，但更接近真实形态）
// ---------------------------------------------------------------------------

function createFakeBackend() {
    const characters = [
        {
            avatar: 'ada.png',
            name: 'Ada',
            data: {
                name: 'Ada',
                description: 'A quiet librarian who keeps the tavern archive.',
                personality: 'Observant, dry humor.',
                scenario: '',
                first_mes: 'The lanterns are lit. What brings you to the archive?',
                mes_example: '',
                system_prompt: '',
                post_history_instructions: '',
                creator_notes: '',
                creator: '',
                character_version: '1.0',
                tags: ['librarian'],
                extensions: {
                    world: '',
                    talkativeness: 0.5,
                    depth_prompt: { prompt: '', depth: 4, role: 'system' },
                },
            },
        },
    ];

    const scriptModule = {
        characters,
        this_chid: 0,
        async getCharacters() {},
        async getOneCharacter(avatar) {
            return characters.find((c) => c.avatar === avatar) || null;
        },
        async deleteCharacter(avatar) {
            const index = characters.findIndex((c) => c.avatar === avatar);
            if (index === -1) return false;
            characters.splice(index, 1);
            return true;
        },
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    };

    let createdCounter = 0;
    const fetchImpl = async (url, options) => {
        const body = JSON.parse(options.body);
        if (url === '/api/characters/merge-attributes') {
            const character = characters.find((c) => c.avatar === body.avatar);
            if (character) {
                Object.assign(character.data, body.data);
                character.name = character.data.name || character.name;
            }
            return { ok: true, status: 200, async text() { return 'ok'; } };
        }
        if (url === '/api/characters/create') {
            createdCounter += 1;
            const avatar = `created-${createdCounter}.png`;
            const data = { ...body.data, extensions: { ...(body.data.extensions || {}) } };
            characters.push({ avatar, name: body.name, data });
            return { ok: true, status: 200, async text() { return avatar; } };
        }
        return { ok: true, status: 200, async text() { return 'ok'; } };
    };

    const worldInfoCache = new Map();
    worldInfoCache.set('Tavern', {
        entries: {
            0: {
                key: ['tavern'],
                keysecondary: [],
                comment: 'The tavern itself',
                content: 'The Tavern at the crossroads never closes.',
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
                vectorized: false,
                role: 0,
                triggers: [],
            },
        },
    });

    const worldInfoModule = {
        worldInfoCache,
        newWorldInfoEntryTemplate: {
            key: [], keysecondary: [], comment: '', content: '', constant: false,
            selective: true, disable: false, order: 100, position: 0,
            excludeRecursion: false, preventRecursion: false, delayUntilRecursion: 0,
            depth: 4, group: '',
        },
        getFreeWorldEntryUid(data) {
            for (let uid = 0; uid < 1_000_000; uid += 1) {
                if (!(uid in data.entries)) return uid;
            }
            return null;
        },
        async saveWorldInfo(name, data) {
            worldInfoCache.set(name, data);
        },
        async deleteWorldInfoEntry(data, uid) {
            if (!data.entries[uid]) return false;
            delete data.entries[uid];
            return true;
        },
        async deleteWorldInfo(name) {
            if (!worldInfoCache.has(name)) return false;
            worldInfoCache.delete(name);
            return true;
        },
    };

    const systemPrompts = [
        { name: 'RP', content: 'You are an experienced roleplayer.' },
    ];
    const manager = {
        async savePreset(name, preset) {
            const index = systemPrompts.findIndex((p) => p.name === name);
            const next = { ...preset };
            if (index >= 0) systemPrompts[index] = next;
            else systemPrompts.push(next);
        },
        async deletePreset(name) {
            const index = systemPrompts.findIndex((p) => p.name === name);
            if (index === -1) return false;
            systemPrompts.splice(index, 1);
            return true;
        },
    };
    const presetManager = { getPresetManager: () => manager };
    const sysprompt = { system_prompts: systemPrompts };
    const powerUser = { power_user: { sysprompt: { enabled: false, name: '', content: '' } } };

    const st = {
        loadScript: async () => scriptModule,
        loadWorldInfo: async () => worldInfoModule,
        loadPresetManager: async () => presetManager,
        loadSysprompt: async () => sysprompt,
        loadPowerUser: async () => powerUser,
    };

    return { st, backend: { characters, worldInfoCache, systemPrompts, fetchImpl } };
}

// ---------------------------------------------------------------------------
// 组装工具（与 index.js 完全一致的注册方式）
// ---------------------------------------------------------------------------

async function buildTools({ st, fetchImpl }) {
    const [{ createRevLock }, { buildDesignerTools }, { createCharacterResource }, { createWorldInfoResource }, { createPromptResource }] = await Promise.all([
        importDesigner('rev-lock.js'),
        importDesigner('build-tools.js'),
        importDesigner('character-tools.js'),
        importDesigner('world-info-tools.js'),
        importDesigner('prompt-tools.js'),
    ]);
    const revLock = createRevLock();
    const tools = buildDesignerTools([
        createCharacterResource({ st, revLock, fetchImpl }),
        createWorldInfoResource({ st, revLock }),
        createPromptResource({ st, revLock }),
    ]);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.action]));
    const openaiTools = tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    return { tools, byName, openaiTools };
}

// ---------------------------------------------------------------------------
// DeepSeek 工具循环
// ---------------------------------------------------------------------------

async function callModel(messages, openaiTools) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 150_000);
    try {
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
            },
            body: JSON.stringify({
                model: MODEL,
                messages,
                tools: openaiTools,
                tool_choice: 'auto',
                temperature: 0.6,
                max_tokens: 4096,
            }),
            signal: controller.signal,
        });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`DeepSeek API ${response.status}: ${text.slice(0, 600)}`);
        }
        return await response.json();
    } finally {
        clearTimeout(timer);
    }
}

async function runScenario({ title, system, user, byName, openaiTools, stats }) {
    console.log(`\n${'='.repeat(70)}\n场景：${title}\n${'='.repeat(70)}`);
    const messages = [
        { role: 'system', content: system },
        { role: 'user', content: user },
    ];

    for (let depth = 0; depth <= RECURSE_LIMIT; depth += 1) {
        const canCallTools = depth < RECURSE_LIMIT;
        const data = await callModel(messages, canCallTools ? openaiTools : []);
        const usage = data?.usage;
        if (usage) {
            stats.promptTokens += usage.prompt_tokens || 0;
            stats.completionTokens += usage.completion_tokens || 0;
        }
        const message = data?.choices?.[0]?.message;
        if (!message) {
            throw new Error(`No message in response: ${JSON.stringify(data).slice(0, 400)}`);
        }

        const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        if (toolCalls.length > 0) {
            if (!canCallTools) {
                throw new Error(`场景「${title}」在 depth=${depth} 时模型仍调用工具——真实 ST 此时已不再注册 tools，行为不一致`);
            }
            messages.push({ role: 'assistant', content: message.content || '', tool_calls: message.tool_calls });
            for (const toolCall of toolCalls) {
                const name = toolCall?.function?.name || '?';
                let args;
                try {
                    args = JSON.parse(toolCall.function?.arguments || '{}');
                } catch {
                    args = {};
                }
                let content;
                try {
                    const action = byName[name];
                    if (!action) {
                        throw new Error(`Unknown tool "${name}"`);
                    }
                    const result = await action(args);
                    content = JSON.stringify(result);
                    stats.calls.push({ name, args, result, ok: true });
                } catch (error) {
                    content = `Error: ${error.message}`;
                    stats.calls.push({ name, args, error: error.message, ok: false });
                    if (String(error.message).includes('designer.rev_')) {
                        stats.revRejections += 1;
                    }
                }
                console.log(`\n[round ${depth + 1}] ${name}(${JSON.stringify(args)})`);
                console.log(`  -> ${content.slice(0, 500)}`);
                messages.push({ role: 'tool', tool_call_id: toolCall.id, content });
            }
            continue;
        }

        const finalText = String(message.content || '').trim();
        console.log(`\n[round ${depth + 1}] 模型最终回复：\n${finalText.slice(0, 1200)}`);
        return { finalText, messages, depth };
    }

    throw new Error(`场景「${title}」在 depth=${RECURSE_LIMIT} 后仍未以文本收尾（真实 ST 会在第 ${RECURSE_LIMIT} 轮后移除 tools）`);
}

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

function assert(condition, label, detail) {
    if (!condition) {
        throw new Error(`断言失败：${label}${detail ? `\n  ${detail}` : ''}`);
    }
    console.log(`  ✔ ${label}`);
}

// ---------------------------------------------------------------------------

async function main() {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
        console.error('缺少 DEEPSEEK_API_KEY 环境变量。用法：DEEPSEEK_API_KEY=sk-xxx node scripts/designer-deepseek-e2e.mjs');
        process.exit(2);
    }

    const { st, backend } = createFakeBackend();
    const { byName, openaiTools } = await buildTools({ st, fetchImpl: backend.fetchImpl });
    const { DESIGNER_GUIDANCE } = await importDesigner('guidance.js');

    const stats = { calls: [], revRejections: 0, promptTokens: 0, completionTokens: 0 };
    const perception = {};

    // ---- 机制场景 A：角色卡设计 -----------------------------------------------
    await runScenario({
        title: '角色卡：新建 + 读取 + 修改',
        system: 'You are a character design assistant inside a sandbox. Use the provided tools to fulfill the user request. Always read an object before modifying it and pass the returned rev. When updating, send the COMPLETE object and copy unchanged fields from the read result. Changes apply immediately.',
        user: '请帮我创建一位叫 Mira 的流浪占卜师角色卡：包含描述（一位流浪的占卜师，用塔罗牌为旅人指引）、性格（神秘、敏锐）、开场白。创建后读取一下确认，然后给她的卡加上深度提示（prompt 聚焦于塔罗占卜场景，depth=2，role=system）。另外把现有角色 Ada 的描述改成 "A quiet librarian who now also catalogs tarot decks."。',
        byName,
        openaiTools,
        stats,
    });
    const mira = backend.characters.find((c) => String(c.name || '').includes('Mira'));
    assert(Boolean(mira), 'Mira 角色卡已创建', JSON.stringify(backend.characters.map((c) => c.name)));
    assert(String(mira.data.description || '').length > 10, 'Mira 描述非空');
    assert(Boolean(mira.data.extensions?.depth_prompt), 'Mira 深度提示已设置', JSON.stringify(mira.data.extensions));
    const ada = backend.characters.find((c) => c.avatar === 'ada.png');
    assert(String(ada.data.description || '').includes('tarot'), 'Ada 描述已更新', ada.data.description);

    // ---- 场景 B：世界书 -----------------------------------------------------
    await runScenario({
        title: '世界书：建书 + 建条目 + 改条目',
        system: 'You are a world-building assistant inside a sandbox. Use the provided tools to fulfill the user request. Read before modifying and pass the returned rev. When updating, send the COMPLETE object and copy unchanged fields from the read result.',
        user: '请为 Mira 创建一本名为 "Mira\'s World" 的世界书，并添加两条条目：一条关键字是 ["tarot_fair"]，内容是 "The Tarot Fair visits every new moon."，comment 写 "占卜集市"；另一条关键字是 ["tower_card"]，内容是塔罗牌"高塔"在故事里的含义。然后读取这本书确认条目，再修改第一条的内容为 "The Tarot Fair visits every new moon, and Mira always has a stall."。',
        byName,
        openaiTools,
        stats,
    });
    const book = backend.worldInfoCache.get("Mira's World");
    assert(Boolean(book), '世界书 "Mira\'s World" 已创建', [...backend.worldInfoCache.keys()].join(', '));
    const entries = Object.values(book.entries || {});
    assert(entries.length >= 2, `世界书条目数 >= 2（实际 ${entries.length}）`);
    const fair = entries.find((e) => Array.isArray(e.key) && e.key.includes('tarot_fair'));
    assert(Boolean(fair), 'tarot_fair 条目存在');
    assert(String(fair.content || '').includes('always has a stall'), 'tarot_fair 条目内容已更新', fair.content);

    // ---- 场景 C：系统提示词 -------------------------------------------------
    await runScenario({
        title: '系统提示词：新建 + 读取 + 修改',
        system: 'You are an assistant inside a sandbox. Use the provided tools to fulfill the user request. Read before modifying and pass the returned rev. When updating, send the COMPLETE object and copy unchanged fields from the read result.',
        user: '请创建一个名为 "Design Session" 的系统提示词预设，内容为 "You are helping the user design a story setting."。读取确认后，把它的内容更新为 "You are helping the user design a story setting with consistent world rules."。',
        byName,
        openaiTools,
        stats,
    });
    const preset = backend.systemPrompts.find((p) => p.name === 'Design Session');
    assert(Boolean(preset), 'Design Session 预设已创建', JSON.stringify(backend.systemPrompts.map((p) => p.name)));
    assert(String(preset.content || '').includes('consistent world rules'), '预设内容已更新', preset.content);

    // ==========================================================================
    // 感知场景：模型能否自发感知并正确使用工具（用户消息均为自然语言，不提示工具）
    // ==========================================================================

    const snapshotCalls = () => stats.calls.slice();
    const scenarioToolCalls = (before) => stats.calls.slice(before.length).map((c) => c.name);

    // P1：真实引导文案 + 角色卡已在上下文中（同真实 Prompt 组装）+ 自然语言修改意图
    const adaCardForP1 = backend.characters.find((c) => c.avatar === 'ada.png').data;
    const adaBefore = String(adaCardForP1.description || '');
    const beforeP1 = snapshotCalls();
    await runScenario({
        title: '感知P1：真实引导文案 + 自然语言（改角色卡）',
        system: `You are a character design assistant. The active character card is: ${JSON.stringify(adaCardForP1)}. ` + DESIGNER_GUIDANCE,
        user: '帮我把 Ada 的角色卡改一下：她其实暗中收藏塔罗牌，把这一点写进她的描述里。',
        byName,
        openaiTools,
        stats,
    });
    {
        const calls = scenarioToolCalls(beforeP1);
        perception.p1 = calls;
        const updateIndex = calls.indexOf('update_character');
        assert(updateIndex >= 0, 'P1：模型自发调用 update_character', calls.join(', '));
        assert(calls.slice(0, updateIndex).includes('read_character'), 'P1：update 之前先 read（感知先读后改）', calls.join(', '));
        const adaNow = String(backend.characters.find((c) => c.avatar === 'ada.png').data.description || '');
        assert(adaNow !== adaBefore && adaNow.length > adaBefore.length, 'P1：Ada 描述已被模型修改', adaNow);
        const adaTags = backend.characters.find((c) => c.avatar === 'ada.png').data.tags;
        assert(Array.isArray(adaTags) && adaTags.includes('librarian'), 'P1：tags 未被清空（数组原样契约）', JSON.stringify(adaTags));
    }

    // P2：无引导文案（仅工具定义）-> 模型是否仅凭 description 感知到工具
    const beforeP2 = snapshotCalls();
    await runScenario({
        title: '感知P2：无引导文案 + 自然语言（建世界书）',
        system: 'You are a helpful assistant.',
        user: '我想给这个虚构世界添加一本名为 "Moon & Tides" 的世界书，里面加一条关键字为 ["moon_tides"] 的条目，内容写月相与潮汐的关系。',
        byName,
        openaiTools,
        stats,
    });
    {
        const calls = scenarioToolCalls(beforeP2);
        perception.p2 = calls;
        assert(calls.includes('create_world_info'), 'P2：无引导时模型仍凭工具描述自发调用 create_world_info', calls.join(', ') || '（未调用任何工具）');
        assert(Boolean(backend.worldInfoCache.get('Moon & Tides')), 'P2：世界书 "Moon & Tides" 已创建');
    }

    // P3：负面纪律——真实人设 + 引导文案，纯 RP 对话不应触发任何工具
    const beforeP3 = snapshotCalls();
    await runScenario({
        title: '感知P3：负面纪律（纯 RP 对话不应调工具）',
        system: 'You are Ada, a quiet librarian in a fantasy tavern who secretly collects tarot cards. Reply in character as Ada; the user has just greeted you in the archive at night. ' + DESIGNER_GUIDANCE,
        user: 'Ada 从柜台后抬起头，微笑着说："又来了？今晚档案馆很安静，只有风在翻书页。"',
        byName,
        openaiTools,
        stats,
    });
    {
        const calls = scenarioToolCalls(beforeP3);
        perception.p3 = calls;
        assert(calls.length === 0, 'P3：RP 对话中模型未调用任何工具', calls.join(', ') || '（无工具调用，符合纪律）');
    }

    // P4：隐含设计意图（用户只表达不满，未提工具/对象名）-> 模型应主动读世界书并修改
    const fairBefore = String(Object.values(backend.worldInfoCache.get("Mira's World").entries)
        .find((e) => Array.isArray(e.key) && e.key.includes('tarot_fair')).content || '');
    const beforeP4 = snapshotCalls();
    await runScenario({
        title: '感知P4：隐含意图（世界书内容要改）',
        system: DESIGNER_GUIDANCE,
        user: '我觉得 "Mira\'s World" 里占卜集市的内容不太对，占卜集市应该改成每逢满月才出现。',
        byName,
        openaiTools,
        stats,
    });
    {
        const calls = scenarioToolCalls(beforeP4);
        perception.p4 = calls;
        const updateIndex = calls.indexOf('update_world_info');
        assert(updateIndex >= 0, 'P4：模型自发调用 update_world_info', calls.join(', '));
        assert(calls.slice(0, updateIndex).some((name) => name === 'read_world_info'), 'P4：修改前先读世界书', calls.join(', '));
        const fairNow = String(Object.values(backend.worldInfoCache.get("Mira's World").entries)
            .find((e) => Array.isArray(e.key) && e.key.includes('tarot_fair')).content || '');
        assert(fairNow !== fairBefore, 'P4：tarot_fair 条目内容已被模型修改', fairNow);
    }

    // ---- 汇总 --------------------------------------------------------------
    const failedCalls = stats.calls.filter((c) => !c.ok);
    const toolNames = [...new Set(stats.calls.map((c) => c.name))];
    console.log(`\n${'='.repeat(70)}\n测试汇总\n${'='.repeat(70)}`);
    console.log(`工具调用总数：${stats.calls.length}（${toolNames.join(', ')}）`);
    console.log(`失败调用：${failedCalls.length}`);
    console.log(`rev 锁拒绝次数：${stats.revRejections}`);
    console.log(`token 用量：prompt ${stats.promptTokens} / completion ${stats.completionTokens}`);
    console.log(`\n感知测试结果：`);
    console.log(`  P1 真实引导+自然语言（改角色卡）    -> ${perception.p1.join(' → ') || '未调用工具'}`);
    console.log(`  P2 无引导仅工具描述（建世界书）      -> ${perception.p2.join(' → ') || '未调用工具'}`);
    console.log(`  P3 纯 RP 对话（负面纪律）            -> ${perception.p3.length === 0 ? '未调用工具 ✔' : perception.p3.join(', ') + ' ⚠️'}`);
    console.log(`  P4 隐含意图（改世界书内容）          -> ${perception.p4.join(' → ') || '未调用工具'}`);
    if (failedCalls.length > 0) {
        console.log('失败明细：');
        for (const call of failedCalls) {
            console.log(`  - ${call.name}(${JSON.stringify(call.args)}): ${call.error}`);
        }
    }
    if (stats.revRejections > 0) {
        console.log('⚠️ 提示：出现 rev 锁拒绝，说明模型使用了过期 rev（已通过错误信息自纠或未自纠，见上）');
    }
    assert(stats.revRejections === 0, '无 rev 锁拒绝（模型始终基于最新状态）');
    assert(failedCalls.length === 0, '无失败工具调用');

    console.log('\n✅ 全部端到端断言通过');
}

main().catch((error) => {
    console.error(`\n❌ 端到端测试失败：${error.message}`);
    process.exit(1);
});

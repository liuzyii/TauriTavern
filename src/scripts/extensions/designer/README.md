# Designer Tools

Designer 是随 TauriTavern 打包的系统默认扩展：用户开启 **“启用函数调用”（Function Calling）** 后，模型即可通过 SillyTavern 原生函数调用对 **角色卡（character）**、**世界书（world info）**、**系统提示词预设（system prompt presets）** 进行增删查改，用于与用户协作设计剧情、背景与角色设定。

## 设计原则

- **走 ST 原生 tool_call 链路**：4 个统一 CRUD 工具（`read` / `create` / `update` / `delete`）注册进 `ToolManager`，由 `registerFunctionToolsOpenAI()` 以 `tools` + `tool_choice: 'auto'` 注入每次请求；工具调用与结果以 assistant `tool_calls` + `role:'tool'` 消息写入聊天（天然审计），随后递归续跑直到模型输出普通文本。不依赖 TauriTavern Agent runtime。
- **随开关生效**：`shouldRegister()` 恒为 true，由 ST 外层门控（`oai_settings.function_calling` + provider 支持 + 生成类型）决定是否注入；关闭函数调用即完全不可见，Agent Mode 下也不注入。**本 fork 已将 `function_calling` 默认值改为开启**（`src/scripts/openai.js`），新安装开箱即用；已保存的用户设置仍优先。
- **统一对象面**：所有对象类型通过 `target` 参数区分（`character` / `persona` / `world_info` / `prompt`），一个动词一个工具——工具面最小，模型感知负担最低。
- **直接应用 + 状态锁**：写操作立即通过既有保存路径落盘；每次写必须携带 `rev`（读工具返回的版本指纹），保证修改总是基于最新状态，过期即返回可恢复错误。
- **全小写、动词在前的 CRUD 命名**：`read` / `create` / `update` / `delete`。

## 工具清单（4 个统一工具）

每个工具都必须携带 `target`（可选值：`character` / `persona` / `world_info` / `prompt`），其余参数按目标对象不同而不同（下方矩阵）。工具名全局唯一：ToolManager 对重名工具会静默覆盖（`tool-calling.js` 仅告警），当前无其他扩展注册裸动词名。

| 工具 | target=character | target=persona | target=world_info | target=prompt |
| --- | --- | --- | --- | --- |
| `read` | `avatar?`、`maxChars?`（省略 avatar 列角色；读取面 = 更新面，恒返回全部可编辑字段） | `id?`（省略列全部人设 + 当前项） | `book?`、`uid?`、`maxChars?`（省略 book 列书；book 无 uid 列条目） | `name?`、`maxChars?`（省略 name 列预设 + 当前项） |
| `create` | `card`（name 必填） | —（v1 不支持，人设由 UI 创建） | `book`、`entry?`（key 至少一个关键字） | `name`、`content` |
| `update` | `avatar?`、`rev`、`card`（完整对象） | `id?`、`rev`、`persona`（`{name, description}`） | `book`、`uid`、`rev`、`entry`（完整条目） | `name?`、`rev`、`prompt`（`{content, post_history}`） |
| `delete` | `avatar?`、`rev`、`deleteChats?` | —（v1 不支持） | `book`、`uid?`、`rev`（有 uid 删条目，无 uid 删整书） | `name?`、`rev` |

- 角色卡可编辑字段：`name, description, personality, scenario, first_mes, mes_example, system_prompt, post_history_instructions, creator_notes, creator, character_version, tags, talkativeness, world, depth_prompt`；**avatar（头像文件）不可由工具修改**，由用户自行维护。
- 人设（User Persona）可编辑字段：`name, description`（描述会注入提示词）；头像与注入位置/深度/角色等配置由 UI 维护；`id` 省略时作用于当前人设。
- 世界书条目可编辑字段：`key, keysecondary, comment, content, constant, selective, disable, excludeRecursion, preventRecursion, order, position, delayUntilRecursion, depth, group`（读取结果只含这些字段，保证“照抄读取结果”恰好可满足）。
- 读取返回 `rev`；`update` / `delete` 必须携带同一 `rev`。
- 保存/删除预设遵循 ST UI 行为（保存后该预设成为当前选中的系统提示词；删除当前选中项时自动切换到第一个预设）。

## 动态环境清单（对话初始化感知）

每次生成前（`manifest.generate_interceptor`，与 stable-diffusion 同机制）注入一行当前对象快照，
让模型**开局就知道有哪些对象可操作**，无需先猜再 read：

```text
Designer context (current objects; call read for details):
characters: ada.png "Ada", created-1.png "Mira the Wanderer"
persona: p1 "Ada the Archivist"
world info: "Mira's World" (2 entries), "Tavern" (1 entry)
prompts: "RP", "Design Session" (active)
```

- **每轮刷新**：拦截器在每次 `GenerateInternal` 提示组装前运行（`script.js:5401`），工具循环的每一轮都会重建清单——**讨论中新建的对象下一轮就出现**，无过期问题；
- id 前置、名称加引号、书带条目数、当前预设标 `(active)`——模型可直接拿 id 调 `read`；
- 受 `function_calling` 过滤门控（与工具同门控），关闭即不可见；列表按类截断（默认 20 项）控制 token 成本。

## 更新契约：完整对象替换

`update` 工具以**完整对象替换**为契约，且不允许任何字段丢失：

- **非空字段缺失** → 可恢复错误 `designer.incomplete_update`（列出缺失字段，提示从 read 结果照抄）——防止模型"只改一半"悄悄丢内容；
- **空/默认字段缺失** → 自动沿用当前值（真实模型会习惯性省略空字符串字段，实测严格拒绝会白白烧掉工具轮次）；
- **显式 `null`** → 语义为"保持当前值/不设置"（模型 JSON 习惯），create 时等价于缺省；
- 因此 `read` 默认返回完整可编辑值：字符串数组（tags/key 等）**原样返回**（不压缩成计数），长文本按 `maxChars` 截断（默认 200000）；**若读取被截断，基于它的更新会被 `designer.truncated_read` 拒绝**，必须用更大 `maxChars` 重读——防止截断文本写回覆盖完整内容；读取面与更新面严格一致（只含可编辑字段），保证"照抄读取结果"恰好可满足；
- 该契约与 `rev` 锁配合：读 → 拿 `rev` 与全量字段 → 改 → 完整提交，从机制上杜绝"改一半丢字段"。

## 实现结构：资源适配器 + 统一构建器

工具面由**资源适配器**（每个可编辑对象类型一个模块）与**统一 CRUD 构建器**
（`build-tools.js`）组装：

```js
// 资源适配器：一个对象类型 = name + 四个动词（action/description/parameters）
{
    name: 'character',                       // -> read({target:'character', ...}), ...
    verbs: { read: {...}, create: {...}, update: {...}, delete: {...} },
}
```

`buildUnifiedTools(resources)` 把各资源的同名动词合并成 4 个统一工具，`target`
参数负责派发（enum 自动来自资源名），每个动词的描述自动拼接各目标的用法。
新增一种可编辑对象只需新增一个适配器模块并在 `index.js` 注册一行
（`persona` 即按此路径加入），`target` enum 自动扩展，`tests` 中有可扩展性用例守护。共享的校验/rev/完整对象
助手集中在 `common.js`。

## rev 状态锁契约

- `rev = sha256(canonicalJson(target))` 的**前 6 位十六进制**（24 bit，参考 git 短哈希）；目标粒度为：角色卡 `{avatar, data}`、世界书条目 `entry`、整书 `{book, data}`、提示词预设 `{name, content, post_history?}`。
- 6 位是刻意选择：完整 64 位 SHA-256 在真实模型测试中被模型抄错（多次重试失败），短哈希让模型复制可靠；会话级对象数量极少，残余碰撞只会表现为可恢复的 rev 错误，不会造成数据损坏。
- 读工具返回 `rev` 并登记到会话 `revRegistry`；写工具（`update` / `delete`）必须携带同一 `rev`。
- 校验顺序：`rev` 必填 → 会话登记过 → 与登记值一致 → 与对象当前实际指纹一致。任一失败返回可恢复错误，错误消息中会附带**当前正确 rev** 以便模型自纠：
  - `designer.rev_required` / `designer.rev_unknown` / `designer.rev_invalid` / `designer.rev_mismatch`
- 写成功后返回新 `rev`，模型可在同一轮内链式修改而无需重读；外部（UI）修改会使下一次写因 `rev_mismatch` 被拒绝。
- 目标解析容忍大小写与名称兜底：角色可按 `avatar` 大小写不敏感或角色名解析，世界书按名称大小写不敏感解析；找不到时错误消息会列出可用目标，便于模型自纠。

## 错误码

| code | 含义 |
| --- | --- |
| `designer.rev_*` | rev 状态锁失败（见上） |
| `designer.character_not_found` / `designer.book_not_found` / `designer.entry_not_found` / `designer.prompt_not_found` | 目标不存在 |
| `designer.character_target_required` | 非角色聊天且未传 avatar |
| `designer.unknown_field` / `designer.invalid_*` | 字段白名单或类型校验失败 |
| `designer.incomplete_update` | 更新时非空字段缺失（完整对象契约） |
| `designer.truncated_read` | 基于截断读取的更新被拒绝，需重读 |
| `designer.prompt_exists` / `designer.book_exists` | 重名冲突 |
| `designer.entry_key_required` | 世界书条目缺少关键字 |
| `designer.field_too_long` | 字段超长 |
| `designer.*_failed` | 宿主侧保存/删除失败（fail-fast） |

## 目录结构

```text
src/scripts/extensions/designer/
├── manifest.json          # 扩展清单（js: src/index.js，hooks.activate=init，上游加载模式）
├── README.md
└── src/
    ├── index.js           # 组合资源适配器 + 注册工具 + 注入短系统提示（方案 B）
    ├── guidance.js        # 注入的系统提示文案（单一事实源，e2e 测试同源使用）
    ├── build-tools.js     # 统一 CRUD 构建器（资源适配器 -> 4 个 target 派发工具）
    ├── rev-lock.js        # canonicalJson / sha256 截断 / rev 登记与校验
    ├── common.js          # 白名单、校验、错误码、完整对象契约、ToolManager 定义组装
    ├── character-tools.js # 资源适配器：角色卡
    ├── persona-tools.js   # 资源适配器：用户人设
    ├── world-info-tools.js# 资源适配器：世界书
    └── prompt-tools.js    # 资源适配器：系统提示词
```

> **加载与暴露机制完全遵循上游 SillyTavern 模式**（与 stable-diffusion 一致）：
> 后端 `ENABLED_SYSTEM_EXTENSIONS` 白名单 → `/api/extensions/discover` →
> 前端 `import(扩展 js)` → `hooks.activate` 调 `init()` → `ToolManager.registerFunctionTool`
> → 生成时 `registerFunctionToolsOpenAI` 注入 payload。扩展与主应用共享同一原生模块图，
> 通过**静态相对导入**访问 `script.js` / `world-info.js` / `preset-manager.js` 等，
> 不做任何运行时动态导入。

## 构建与测试

- 构建：designer **不需要 rspack 打包**（manifest `js` 指向源码 `src/index.js`，按上游模式以源码模块加载）；`pnpm run web:build` 不涉及 designer。
- 测试：`node --test tests/designer-contract.test.mjs`；完整契约套件：`pnpm run test:contracts`。
- 守护：`pnpm run check:frontend`。

## 真实模型端到端测试（快速验证，无需启动应用）

`scripts/designer-deepseek-e2e.mjs` 用真实 DeepSeek API 模拟 ST 原生 function-calling
循环，并**对齐真实 ST 语义**：

- 工具注册上限按真实 ST 设置 `ToolManager.RECURSE_LIMIT` 执行（默认 5，UI 滑块 1–50
  可调，`src/script.js:5326`、`#tool_call_recurse_limit`）：前 N 轮请求携带 tools，
  之后请求不再携带 tools，模型必须以文本收尾；e2e 用 `DESIGNER_E2E_RECURSE_LIMIT`
  环境变量对齐当前用户设置；
- 角色卡内容已放入系统上下文（同真实 Prompt 组装），工具调用是模型的选择而非必需；
- 循环内执行的是扩展的真实 action（rev 锁、完整对象契约、容错解析全部生效）。

覆盖机制场景（角色卡/世界书/系统提示词 CRUD）与感知场景：

- **P1**：线上真实引导文案 + 自然语言修改意图 → 模型自发 read 后 update；
- **P2**：无引导文案（仅工具描述）→ 模型仍能凭 description 感知并调用工具；
- **P3**：纯 RP 对话 → 模型不调用任何工具（纪律）；
- **P4**：隐含设计意图（只表达不满，不点名对象）→ 模型主动读世界书并修改。

```bash
DEEPSEEK_API_KEY=sk-xxx node scripts/designer-deepseek-e2e.mjs
# 按需单跑某个场景（省 token）：
DEEPSEEK_API_KEY=sk-xxx DESIGNER_E2E_SCENARIO=感知P4 node scripts/designer-deepseek-e2e.mjs
# 用你自己的递归上限设置验证（默认 5）：
DEEPSEEK_API_KEY=sk-xxx DESIGNER_E2E_RECURSE_LIMIT=8 node scripts/designer-deepseek-e2e.mjs
```

**失败口径**：只有「宿主级失败」（未知工具、保存/删除失败等）与场景状态断言失败才判
FAIL；模型可恢复的错误（rev 锁拒绝、完整对象契约拒绝、参数校验拒绝等）是锁与校验
在正常工作，只作为指标报告——否则测试测的是模型完美度而非工具正确性。感知场景 P4
自包含（缺少目标世界书时自动播种），可独立运行。

真实测试中发现并修复的问题：

1. **rev 过长会被模型抄错**：64 位 hex 在 DeepSeek 实测中被改写（连续 4 轮重试失败）。
   已改为 6 位 hex（参考 git 短哈希），实测 0 次抄错；错误消息同时附带当前正确 rev 便于自纠。
2. **引导文案会诱导 RP 场景偷读角色卡**：已把"RP/闲聊中禁用"放到引导文案最前，并在 e2e
   中以真实人设复测（P3 零工具调用）。
3. **模型会猜错目标 ID（大小写/名称）**：角色按 avatar 大小写不敏感 + 角色名兜底解析，
   世界书按名称大小写不敏感解析，未找到时错误消息列出可用目标；工具返回规范 avatar。
4. **读取结果把字符串数组压成计数导致更新丢字段**：`tags:1` 被模型照抄后标签被清空；
   已改为数组原样返回，并提高默认 `maxChars` 至 200000，配合完整对象契约保证无字段丢失。

## 已知边界（v1）

- 不做撤销工具；安全依赖 `rev` 锁 + 聊天内审计。
- 世界书 v1 只支持条目级 `update`；书级元数据（如名称/描述）不支持。
- `extra_books`（附属世界书列表）不在可编辑字段内。
- 删除角色卡默认不删除聊天文件（`deleteChats=false`）。
- 系统提示词预设不支持重命名（可用 create + delete 组合完成）。
- avatar（头像文件）不可由工具修改，由用户自行维护。
- 人设 v1 只支持 `read` / `update`：创建/删除与头像上传绑定在 UI；注入位置/深度/角色等描述器配置不可由工具修改（但外部修改会使 rev 失效，安全方向）。
- 删除类操作无二次确认：依赖 `rev` 锁 + 工具描述纪律 + 聊天审计（误删不可恢复，删除前请确认模型意图）。
- 保存/删除系统提示词预设遵循 ST UI 行为（保存即选中该预设），模型操作与 UI 操作一致。

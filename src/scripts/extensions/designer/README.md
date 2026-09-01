# Designer Tools

Designer 是随 TauriTavern 打包的系统默认扩展：用户开启 **“启用函数调用”（Function Calling）** 后，模型即可通过 SillyTavern 原生函数调用对 **角色卡（character）**、**世界书（world info）**、**系统提示词预设（system prompt presets）** 进行增删查改，用于与用户协作设计剧情、背景与角色设定。

## 设计原则

- **走 ST 原生 tool_call 链路**：12 个工具注册进 `ToolManager`，由 `registerFunctionToolsOpenAI()` 以 `tools` + `tool_choice: 'auto'` 注入每次请求；工具调用与结果以 assistant `tool_calls` + `role:'tool'` 消息写入聊天（天然审计），随后递归续跑直到模型输出普通文本。不依赖 TauriTavern Agent runtime。
- **随开关生效**：`shouldRegister()` 恒为 true，由 ST 外层门控（`oai_settings.function_calling` + provider 支持 + 生成类型）决定是否注入；关闭函数调用即完全不可见，Agent Mode 下也不注入。
- **直接应用 + 状态锁**：写操作立即通过既有保存路径落盘；每次写必须携带 `rev`（读工具返回的版本指纹），保证修改总是基于最新状态，过期即返回可恢复错误。
- **全小写、动词在前的 CRUD 命名**：`read_*` / `create_*` / `update_*` / `delete_*`。

## 工具清单（12 个）

### 角色卡（character）

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `read_character` | `avatar?`、`fields[]?`、`maxChars?` | 省略 avatar 返回角色列表；指定则读卡（返回 `rev`，默认全量字段） |
| `create_character` | `card`（name 必填） | JSON 创建，走 `/api/characters/create` |
| `update_character` | `avatar?`、`rev`、`card` | **完整对象替换**（15 个可编辑字段全部必填，见「更新契约」） |
| `delete_character` | `avatar?`、`rev`、`deleteChats?`（默认 false） | 默认不级联删除聊天 |

可编辑字段：`name, description, personality, scenario, first_mes, mes_example, system_prompt, post_history_instructions, creator_notes, creator, character_version, tags, talkativeness, world, depth_prompt`。**avatar（头像文件）不可由工具修改**，由用户自行维护。

### 世界书（world info）

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `read_world_info` | `book?`、`uid?`、`maxChars?` | 省略 book 返回书列表；book 无 uid 返回条目索引（book `rev`）；book+uid 返回单条目（entry `rev`） |
| `create_world_info` | `book`、`entry?` | 无 entry 建空书；有 entry 建条目（key 至少一个关键字） |
| `update_world_info` | `book`、`uid`、`rev`、`entry` | **完整条目替换**（14 个可编辑字段全部必填） |
| `delete_world_info` | `book`、`uid?`、`rev` | 有 uid 删条目；无 uid 删整书（不更新角色链接） |

条目可编辑字段：`key, keysecondary, comment, content, constant, selective, disable, excludeRecursion, preventRecursion, order, position, delayUntilRecursion, depth, group`。

### 系统提示词预设（system prompt presets）

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `read_prompt` | `name?`、`maxChars?` | 省略 name 返回预设列表 + 当前启用项；指定则读内容（返回 `rev`） |
| `create_prompt` | `name`、`content` | 新建预设，重名 fail-fast |
| `update_prompt` | `name?`、`rev`、`prompt` | **完整对象替换**（`{content, post_history}` 均必填）；省略 name = 当前启用项 |
| `delete_prompt` | `name?`、`rev` | 删除预设；省略 name = 当前启用项 |

> 保存/删除预设遵循 ST UI 行为（保存后该预设成为当前选中的系统提示词；删除当前选中项时自动切换到第一个预设）。

## 更新契约：完整对象替换

`update_*` 工具以**完整对象替换**为契约，且不允许任何字段丢失：

- **非空字段缺失** → 可恢复错误 `designer.incomplete_update`（列出缺失字段，提示从 read 结果照抄）——防止模型"只改一半"悄悄丢内容；
- **空/默认字段缺失** → 自动沿用当前值（真实模型会习惯性省略空字符串字段，实测严格拒绝会白白烧掉工具轮次）；
- **显式 `null`** → 语义为"保持当前值/不设置"（模型 JSON 习惯），create 时等价于缺省；
- 因此 `read_*` 默认返回完整可编辑值：字符串数组（tags/key 等）**原样返回**（不压缩成计数），长文本按 `maxChars` 截断（默认 200000，读取结果带 `truncated` 标志；若被截断需用更大 `maxChars` 重读后再更新）；
- 该契约与 `rev` 锁配合：读 → 拿 `rev` 与全量字段 → 改 → 完整提交，从机制上杜绝"改一半丢字段"。

## 实现结构：资源适配器 + 统一构建器

工具面由**资源适配器**（每个可编辑对象类型一个模块）与**统一 CRUD 构建器**
（`build-tools.js`）组装：

```js
// 资源适配器：一个对象类型 = name + 四个动词（action/description/parameters）
{
    name: 'character',                       // -> read_character, update_character, ...
    verbs: { read: {...}, create: {...}, update: {...}, delete: {...} },
}
```

新增一种可编辑对象（如 persona）只需新增一个适配器模块并在 `index.js` 注册一行；
命名、注册、工具循环机制完全复用，`tests` 中有可扩展性用例守护（假第 4 资源自动
产出 `read_persona` 等）。共享的校验/rev/完整对象助手集中在 `common.js`。

## rev 状态锁契约

- `rev = sha256(canonicalJson(target))` 的**前 6 位十六进制**（24 bit，参考 git 短哈希）；目标粒度为：角色卡 `{avatar, data}`、世界书条目 `entry`、整书 `{book, data}`、提示词预设 `{name, content, post_history?}`。
- 6 位是刻意选择：完整 64 位 SHA-256 在真实模型测试中被模型抄错（多次重试失败），短哈希让模型复制可靠；会话级对象数量极少，残余碰撞只会表现为可恢复的 rev 错误，不会造成数据损坏。
- 读工具返回 `rev` 并登记到会话 `revRegistry`；写工具（`update_*` / `delete_*`）必须携带同一 `rev`。
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
| `designer.no_updates` | 未提供任何有效修改 |
| `designer.prompt_exists` / `designer.book_exists` | 重名冲突 |
| `designer.entry_key_required` | 世界书条目缺少关键字 |
| `designer.field_too_long` | 字段超长 |
| `designer.*_failed` | 宿主侧保存/删除失败（fail-fast） |

## 目录结构

```text
src/scripts/extensions/designer/
├── manifest.json          # 扩展清单（js: dist/index.bundle.js）
├── README.md
└── src/
    ├── index.js           # 组合资源适配器 + 注册工具 + 注入短系统提示（方案 B）
    ├── guidance.js        # 注入的系统提示文案（单一事实源，e2e 测试同源使用）
    ├── build-tools.js     # 统一 CRUD 构建器（资源适配器 -> 工具定义）
    ├── st-bridge.js       # 运行时懒加载 /script.js、/scripts/*（webpackIgnore）
    ├── rev-lock.js        # canonicalJson / sha256 截断 / rev 登记与校验
    ├── common.js          # 白名单、校验、错误码、完整对象契约、ToolManager 定义组装
    ├── character-tools.js # 资源适配器：角色卡
    ├── world-info-tools.js# 资源适配器：世界书
    └── prompt-tools.js    # 资源适配器：系统提示词
```

## 构建与测试

- 构建：`pnpm run web:build`（rspack 会额外产出 `designer/dist/index.bundle.js`）。
- 测试：`node --test tests/designer-contract.test.mjs`；完整契约套件：`pnpm run test:contracts`。
- 守护：`pnpm run check:frontend`。

## 真实模型端到端测试（快速验证，无需启动应用）

`scripts/designer-deepseek-e2e.mjs` 用真实 DeepSeek API 模拟 ST 原生 function-calling
循环，并**对齐真实 ST 语义**：

- 工具注册上限按 `ToolManager.RECURSE_LIMIT`（默认 5 轮，`src/script.js:5326`）执行：
  前 5 轮请求携带 tools，之后请求不再携带 tools，模型必须以文本收尾；
- 角色卡内容已放入系统上下文（同真实 Prompt 组装），工具调用是模型的选择而非必需；
- 循环内执行的是扩展的真实 action（rev 锁、完整对象契约、容错解析全部生效）。

覆盖机制场景（角色卡/世界书/系统提示词 CRUD）与感知场景：

- **P1**：线上真实引导文案 + 自然语言修改意图 → 模型自发 read 后 update；
- **P2**：无引导文案（仅工具描述）→ 模型仍能凭 description 感知并调用工具；
- **P3**：纯 RP 对话 → 模型不调用任何工具（纪律）；
- **P4**：隐含设计意图（只表达不满，不点名对象）→ 模型主动读世界书并修改。

```bash
DEEPSEEK_API_KEY=sk-xxx node scripts/designer-deepseek-e2e.mjs
```

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
- 若单个字段超过 `maxChars`（默认 200000），读取会截断并带 `truncated: true`；更新前需用更大 `maxChars` 重读，避免把截断文本写回。

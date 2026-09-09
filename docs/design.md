# Chat History Optimization (chat-optimization-v2) — 完整流程交接文档

> 版本：v2.23.0（2026-09-07）
> 仓库：本目录是独立 git 仓库（嵌套在 SillyTavern 安装目录内），在此提交，不要提交到父仓库。
> 无 package.json、无构建、无 lint。功能模块为浏览器端普通脚本。

---

## 1. 插件做什么

这是一个 SillyTavern 第三方扩展（UI 名「剧情角色档案」），核心目标是**控制长对话发送给 LLM 的 token 量**，同时保持剧情上下文完整：

1. **结构化剧情协议**：要求 AI 每次回复末尾输出 `<NEW_STORY_DATA>` 块（含 `NEW_HISTORY` 故事历程 JSON、可选 `NEW_CHARACTER_CARD` 角色卡 JSON）。插件把全部楼层的这些块解析、合并、去重，形成全局「故事历程」数组和「角色卡」映射。
2. **分层注入**：把最终 prompt 装配为三层——`RAG 远端召回段 + 中段历程窗口 + 正文 verbatim 尾部`，在 `tokenLimit` 预算内最大化保留上下文；超预算时用检索从远期条目中挑回相关条目。
3. **角色卡管理**：槽位上限淘汰 + 久未活跃丢弃（超 `ROLE_CARD_STALE_DISTANCE` 条消息未出场且非当前提问提及的角色直接丢弃，不保留空壳），阈值见 `core/constant.js`；v2.23.0 起叠加角色状态追踪的顺序合并（追踪赢）。
4. **分层摘要（v2.21.0 起，替代逐条目二级摘要 + 混合召回）**：L0 历程条目 → L1 天摘要（一 key 一条）→ L(k≥2) 连续 `hierFanin` 个同层节点合并，纯文本摘要持久化在 `chat_metadata`，父节点以子文本哈希校验。超预算时从最旧侧折叠（高层永远在远端），token 够用时零压缩；发送前永不等 LLM，缺失部分用原文兜底。
5. **角色状态追踪（v2.23.0 起）**：角色卡模板中属性行 `//` 注释含 `<可变>` 标签的属性按同样树形组成可变状态模版；每次助手回复后以后台对本楼层 L0（该回复的 NEW_HISTORY 条目）调一次独立 LLM 连接，输入为可变状态模版 + 本楼层 L0 + 本楼层出现角色的完整角色卡（`{角色名: 角色卡}`），输出为一个 JSON 对象（以可变状态模版为树形参考，键为有状态变化的角色名），存该楼层 `extra`，装配角色卡时按楼层顺序合并为最终可变状态。

---

## 2. 目录结构

```
├── manifest.json              # ST 扩展清单（js: index.js, css: styles/coo.css, generate_interceptor）
├── index.js                   # 唯一 ESM 入口：bootstrap + bridge + 模块注入
├── core/
│   ├── constant.js            # 可调常数集中定义（NS.Constants，每项附调整指导；须最先加载）
│   ├── settings.js            # 设置存取（extension_settings["chat-optimization-v2"]）
│   ├── engine.js              # 核心引擎（纯逻辑无 DOM）：解析/合并/折叠装配/拦截器
│   │   └── subsummary.js          # 分层摘要生成器（纯逻辑）：LLM 调用、chat_metadata 持久化、自动触发、后台补齐
│   └── roletrack.js           # 角色状态追踪（纯逻辑）：模版解析、逐楼层 LLM 追踪、楼层 extra 持久化、顺序合并
├── ui/
│   └── coo-window.js          # 浮动窗口 UI（7 个 tab，全 createElement）
├── styles/
│   └── coo.css                # 全部样式（按区块注释分节）
├── test/
│   ├── smoke-hybrid-recall.cjs  # Node 冒烟测试（mock 浏览器环境，node 直接跑）
│   └── smoke-roletrack.cjs      # 角色状态追踪冒烟测试（模版解析/逐楼层追踪/extra/顺序合并/端到端）
└── docs/
    └── design.md              # 本文档
```

---

## 3. 加载与启动流程

### 3.1 ST 加载入口

`manifest.json` 声明 `js: index.js`、`css: styles/coo.css`、`loading_order: 30`、`generate_interceptor: "replaceChatHistoryWithDetailsV2"`。

**硬约束**：`generate_interceptor` 必须与 `core/engine.js` 中定义在全局 `globalThis.replaceChatHistoryWithDetailsV2` 的函数名一致，改名会静默断开 ST 的生成管线。

### 3.2 index.js bootstrap

1. 仅 `index.js` 使用 ESM import，从 ST 内部文件引入：`extension_settings`、`saveMetadataDebounced`（extensions.js）、`chat`/`saveChatDebounced`/`saveSettingsDebounced`/`chat_metadata`（script.js）、`getTokenCountAsync`（tokenizers.js）、`eventSource`/`event_types`（events.js）、`ConnectionManagerRequestService`（extensions/shared.js）。
2. 防重复加载：`window.ChatOptimizationV2.loaded` 已置位则直接 return。
3. 初始化命名空间 `window.ChatOptimizationV2`（下称 `NS`）：`loaded / version / baseUrl / bridge`。
4. **bridge 是唯一访问 ST 内部的通道**，`Object.freeze` 冻结：
   - `extensionSettings`（引用）、`saveSettingsDebounced`、`saveMetadataDebounced`
   - `getTokenCountAsync`
   - `getCurrentChat()` → 当前 `chat` 数组引用
   - `saveChatDebounced`、`getChatMetadata()` → `chat_metadata`
   - `eventSource`、`eventTypes`
   - `connectionManagerRequest`（ConnectionManagerRequestService）
5. 按 `MODULES` 数组顺序**逐个 `await` 加载** `<script>`（`loadScript` 返回 Promise，`script.async = false`，URL 带 `?v=VERSION` 缓存击穿），全部就绪后才进入 DOM ready 挂窗口：
     ```
      core/constant.js → core/settings.js → core/engine.js
      → core/subsummary.js → core/roletrack.js → ui/coo-window.js
     ```
    **新增脚本模块文件必须加入此数组**，否则不加载。
6. `DOMContentLoaded` 后调用 `NS.CooWindow.mount()`。

### 3.3 模块模式（NS 模式）

功能模块全是 **IIFE + 'use strict' 的普通脚本，不是 ES module**：

```js
(function () {
    'use strict';
    const NS = window.ChatOptimizationV2 = window.ChatOptimizationV2 || {};
    // ...
    NS.XxxModule = Object.freeze({ ... });
})();
```

- 模块间只通过 `NS.<Module>` 互相引用（如 `NS.Settings`、`NS.Engine`、`NS.SubSummary`），**禁止在功能模块里直接 import ST 文件**——一切 ST 访问走 `NS.bridge`。
- 加载顺序即依赖顺序：constant 最先（人人经 `NS.Constants` 读可调常数），settings 次之（人人依赖），engine 第三（subsummary 依赖 `NS.Engine` 的 `getStoryProgressRange`/`entryToDocText` 做天分组与输入拼装；roletrack 依赖 `NS.Engine` 的 `getFloorStoryBlock`/`entryToDocText`/`nameMatches`/`getKnownRoles` 做本楼层输入与角色列表）。engine 在装配时经 `NS.RoleTrack.applyToCharacterData` 合并追踪状态——调用时（生成/刷新）查 `NS`，不依赖加载时存在，保证向后兼容。
- 各模块末尾 `Object.freeze` 导出 API，加载顺序变了若引用未初始化模块会直接抛错，可作断点。

### 3.4 启动时的自执行行为

| 模块 | 模块加载即执行 |
|---|---|
| `constant.js` | 无（仅定义并冻结 `NS.Constants`） |
| `subsummary.js` | `init()` 注册 `GENERATION_ENDED` 事件监听（后台补齐缺失摘要，不阻塞发送） |
| `roletrack.js` | `init()` 注册 `MESSAGE_RECEIVED` 事件监听（助手新回复后后台追踪本楼层，不阻塞发送） |
| `coo-window.js` | 由 index.js 在 DOM ready 后调 `mount()` |

---

## 4. 数据模型与协议

### 4.1 chat 数组约定（ST 原生）

- `chat` 是消息数组，`chat[0]` 为首条消息（通常为 system 或第一条回复），**楼层号 = 数组下标，楼层从 1 开始**。
- AI（assistant）消息判定：遍历原始 ST `chat` 数组时用 `!item.is_user`（ST 消息恒带 `is_user` 字段）；遍历故事历程条目时用完整判定式 `("is_user" in item && !item.is_user) || (item.role === "assistant")`。两种形式在 engine/subsummary 中反复出现，保持原样。
- 消息 `mes` 为主文本；存在 swipe 时 `getFloorStoryBlock` 回退读 `item.swipes[item.swipe_id]`（当前激活 swipe）。

### 4.2 NEW_STORY_DATA 块协议

AI 回复末尾（由 `getCharPrompt` 注入的模板要求）输出：

```
<NEW_STORY_DATA>
<NEW_HISTORY>
{ "故事历程": [ { "天数":"第X天", "时间段":"清晨|上午|中午|下午|傍晚|晚上|深夜|凌晨", "地点":"大地点.小地点", "历程":"..." } ] }
</NEW_HISTORY>
<NEW_CHARACTER_CARD>
{ "角色名": { "角色设定": {...} } }
</NEW_CHARACTER_CARD>
</NEW_STORY_DATA>
```

- 提取正则：`<NEW_STORY_DATA>` 块取**最后一个**（`matches[matches.length-1]`），块内再取 `<NEW_HISTORY>` / `<NEW_CHARACTER_CARD>`。
- 解析前统一 `replace(/\/\/.*$/gm, '')` 去掉 `//` 行内注释（模板允许带注释，LLM 输出可能带回显）。
- 取第一个 `{...}` 后 `JSON.parse`。
- `NEW_HISTORY` **必选**：缺失/解析失败 → 该楼层进 `failedFloors`（UI 红色显示）。
- `NEW_CHARACTER_CARD` **可选**：无新角色或角色卡功能关闭（`roleCardToggle`）时合法缺失。
- **失败原因明细（v2.10.2，v2.11.1 改为事件驱动）**：`mergeDataInfo` 同时收集 `failedDetails = [{index, reasons:[...]}]`（每层去重原因，如「缺少 NEW_STORY_DATA 块 / 缺少 NEW_HISTORY 区段 / NEW_HISTORY 解析错误 / NEW_CHARACTER_CARD 解析错误」）。`Engine.checkParseFailures()` 在**回复到达/消息修改后**（非生成发送时）重解析当前聊天，对**新出现**的失败楼层（相对上次基线）经 `Engine.onParseFail` 总线广播，UI 弹出解析失败气泡（见 §11.2.2）；历史失败不重复提示。

### 4.3 模板解析（`Engine.parseTemplate`）

- `historyPrompt` / `characterPrompt` 是**带 `//` 注释的 JSON 文本**。解析 = 去注释后 `JSON.parse`。
- **默认模板与 UI 文案是中文产品数据，保留不翻译**；改默认模板必须保证「去注释后可被 `JSON.parse`」，且 `{{占位符}}` 动态键机制（见 5.3 checkPath）仍然成立。

### 4.4 分层摘要持久化结构（v2.21.0）

```js
chat_metadata["chat-optimization-v2-hier"] = {
    version: 1,
    fanin: 5,
    l1: { "<dayKey>": { text: "<天摘要纯文本>", h: "<当天条目 JSON 串哈希>", t: <ms> } },
    upper: { "L2:1~5": { text: "<合并摘要纯文本>", h: "<子文本串哈希>", t: <ms> } }
}
```

- `dayKey` = 天数数字字符串（`parseDayNumber` 结果），解析失败归 `"unknown"`（展示为"未知天"）。
- **哈希失效**：L1 读时重算当天条目语义哈希（仅天数/时间段/地点/历程，不含 floor/index；删楼层致后续楼层下标前移不再误伤），不匹配即视为缺失；上层节点读时重算子文本串哈希，不匹配即视为缺失。某天条目变化只脏该天 L1 + 覆盖该天的祖先链，不清整树。失效场景：楼层重新生成、手动编辑消息、切换 swipe。
- 上层节点键为 span（`L<level>:<startKey>~<endKey>`）而非下标：严格整组 + 只合并同层连续节点，不满组/落单尾巴直接晋升（v2.23.1 起；此前提前合并 + 混层父在装配层永不可用，还会在加天时变孤儿致 UI 闪现又消失）；新增天只追加尾部节点，已凑满的旧节点键稳定。
- **孤儿清理**：批次结束 `pruneStore()` 删除已不存在日子的 L1 与不在当前规划内的 upper；`fanin` 变化清空 upper（L1 与 fanin 无关保留），`loadStore` 读到旧 fanin 即清。
- **封天**：数字最大的那天视为未封天（仍在进行中），自动补齐（`ensureMissing(false)`）跳过它的 L1（`openDayKeyOf`；`'unknown'` 无法判断封天，始终可生成）；覆盖未封天的上层因子的 L1 缺失而子不齐备，自然收不到。次日历程出现（更大天数）即自动转正。强制重建（`force=true`）与故事 tab 单天按钮不受限。
- 旧版 `extra["chat-optimization-v2"]` 逐条目摘要与 `chat_metadata["chat-optimization-v2-embed"]` 向量库已删除，不做迁移。

### 4.5 角色状态追踪存储（v2.23.0）

```js
chat[floor].extra["chat-optimization-v2-roletrack"] = {
    v: 2,
    h: "<可变模版 + 本楼层 L0 条目 JSON 串哈希>",
    states: { "<实际角色名>": { /* 以可变状态模版为树形参考的可变子树 */ } },
    t: <ms>
}
```

- 逐楼层存 `extra`（随聊天文件持久化，经 `saveChatDebounced` 落盘），不是 `chat_metadata`：追踪是单楼层 L0 的派生物，随楼层走。
- `h` 覆盖可变模版文本（含保留注释，已删 `<可变>`）与本楼层 L0：楼层重写/编辑消息/切换 swipe/模板变更（含注释变更）即标脏，只重追该楼层，其余楼层保留。
- `states` 为空对象表示"本楼层无角色状态变化"（有效结果，避免重复消耗 LLM）；无历程的楼层不建槽位。
- 输出截断：单楼层最多 `ROLETRACK_TRACKS_MAX_PER_FLOOR`（默认 10）个角色，超长按返回顺序保留前 N 项。

---

## 5. 核心流程：生成拦截器（最重要）

入口：`globalThis.replaceChatHistoryWithDetailsV2(chat, contextSize, abort, type)`（定义在 `core/engine.js`）。ST 在每次生成前调用，**约定为原地修改 `chat` 数组并返回 undefined**——实现中把整个 `chat` 替换为**单条消息**，其 `mes` 是完整装配好的 prompt。

### 5.1 流程总览

```
replaceChatHistoryWithDetailsV2
 ├─ guard: chat 非空; extensionToggle 开（否则直接 return，ST 用原始 chat）
 ├─ chatCopy = JSON.parse(JSON.stringify(chat))     # 深拷贝，mergeDataInfo 会写 messageCount
 ├─ result = await assembleFinalPrompt(chatCopy, {runRag: true})
 │    └─ buildPromptData(chatCopy, {runRag})        # 详见 5.2
 │    └─ 首条信息特判 + FIRST_MESSAGE_SUFFIX
  ├─ chat[chat.length-1].mes = result.lastMessage    # 先写最后一条
  ├─ notifyParseFail(新失败楼层 failedDetails)        # 仅相对上次 stats 新增的失败，UI 弹气泡
  ├─ notifyStats(...)                                # 广播统计给 UI
 └─ chat.length = 0; chat.push(chat[原最后一条])     # 原地替换为单条消息
```

UI 的「发送预览」与窗口打开时的 `Engine.refreshStats()` 走**同一个 `assembleFinalPrompt`**（`runRag: true`），保证预览 = 实际将发送的内容。

### 5.2 buildPromptData 逐步骤

1. **模板解析**：`parseTemplate(historyPrompt)`；`roleCardToggle` 开时还需 `parseTemplate(characterPrompt)`。解析失败仅 console.error，不中断（生成可能异常，UI 模板 tab 有有效性徽章）。
2. **mergeDataInfo**：遍历楼层 1..n 的 assistant 消息，提取每层 `NEW_HISTORY`/`NEW_CHARACTER_CARD`，用 `deepMerge` 累积成全局 `historyData`（含 `故事历程` 数组）与 `characterData`（角色名→角色卡）。同时：
   - 每层写入 `item.messageCount = historyObj.故事历程.length`（该层贡献的历程条数，供正文覆盖计算）；
    - 任何一层缺块/解析失败 → `failedFloors.push(j)`，并记录 `failedDetails` 原因（见 §4.2）。
3. **processCharacterData 角色卡淘汰**：
   - `MAX_SLOTS = 10`。
   - 打分：最新用户消息（`chat[chat.length-1].mes`）中 `nameMatches` 命中 → `Constants.ROLE_CARD_MENTION_SCORE`（必保）；否则取**最后一次出现**的消息下标作为分数；都没出现 → `-1`。
       - `nameMatches`：角色名按 `()`/`（）`/`·`/`.` 拆出所有别名 term（`getNameSearchTerms`），任一 term 命中即可；**消歧义**：若 term 是另一个更长角色名的子串（「沈梦」⊂「沈梦瑶」），逐次出现检查是否被长名「吞掉」，至少一次独立出现才算命中。
   - 按分数降序取前 10，其余物理删除。
    - **久未活跃丢弃**：分数 < `ROLE_CARD_MENTION_SCORE` 且距最后出现 > `ROLE_CARD_STALE_DISTANCE`（100）条消息的角色直接丢弃（不保留蒸馏空壳，避免模板已删除字段的空对象污染 prompt）。
4. **正文尾部（verbatim）**：
   - `assistantIdxArr` = 所有非用户消息下标；取倒数第 `keepCount` 条 assistant 起，到末尾，过滤出非用户消息的 `mes` 拼接为 `tailText`。
   - `tailCovered` = 这些 assistant 消息 `messageCount` 之和（正文已原文覆盖的历程条数）。
   - 边界：`keepCount=0 且只有 1 条 assistant` 时强制保留 1 条；`keepCount > assistant 数` 时钳到 assistant 数。
5. **历程拆分**：`fullJourney = historyData.故事历程`；`midEntries = fullJourney.slice(0, length - tailCovered)`（正文覆盖的尾部条目从历程剔除，避免重复）；`midMaxDay` 从**完整历程**计算（识别「当前天」必须含被排除部分）。
6. **Token 预算判定**：
    - `fullTokens = tokens(fullMidMarkdown + tailText + characterDataJson)`（`getTokenCountAsync`）。
    - **模板/包装开销（v2.9.1）**：`overheadTokens = tokens(getCharPrompt({前文:''}, {}))`——STORY_DATA 骨架 + NEW_STORY_DATA 模板恒附在最终消息上（默认模板约 2k tokens），若不扣除，最终显示的 tokenCount 永远超出 tokenLimit 一个开销量。`contentLimit = max(1, tokenLimit - overheadTokens)`，后续所有预算判定用 `contentLimit`。
    - `hierWillActivate = fullTokens > contentLimit`（无比例、无开关门槛：预算由折叠自然决定）。
    - 未触发 → 全量注入（`midMarkdown = fullMidMarkdown`），零压缩。
7. **分层折叠路径**（触发且 `runFold` 时，见 `planFoldSlots`）：
     - **正文硬上限（v2.9.2）**：`tokens(tailText + charJson) > contentLimit` 时从最旧整条 assistant 消息丢弃（`tailPos` 右移，其历程条目回归中段，仍可被折叠覆盖），直到装下或只剩 1 条；仍超则 console.warn（此时最终必然超限）。
     - `midBudget = contentLimit - tailTok`；中段按天分组（首现顺序，天为原子单位），从最旧侧折叠：
       - **Phase A**：最旧天 L0 → 有效 L1（须完全落在中段内；部分被正文覆盖的天永不折叠），直到估算装下。
       - **Phase B**：仍超则把连续同层天按上层节点 span 换成父摘要（逐层上升；span 必须整体完全落在中段内，防正文重复）。
      - **精确计数兜底（v2.23.3 修复估算偏乐观丢整天）**：估算口径（`EST_CHARS_PER_TOKEN=1.5`）与真实 tokenizer 不一致时可能"该折的没折"（如只超 1k 却要丢 5k 的整天）。故折叠后渲染做 `getTokenCountAsync` 精确计数；仍超则按序兜底：①最旧可折叠 L0→L1、②上层合并（与 Phase B 同判定、可复用 `tryApplyUpper`）、③都不可行才从最旧槽位逐个丢弃（被合并吞掉的天不占预算，不参与丢弃；整跨度父槽位被丢即整段消失），直至 ≤ midBudget（无次数上限，保证硬上限）。`spanFullyInside` 只要求 span 内实际存在的天全部落在中段内，数字断层直接跳过（v2.23.1 修复：此前缺一天即整父永不可用，非连续时间线白生成）。
     - 发送前永不等 LLM：只读 `SubSummary.getCoverage()` 快照，缺失摘要的天保持原文（Phase A 跳过），折叠抛错 → 回退全量中段。
     - `hier = {active, willActivate, days:[{dayKey,label,count,level,text,endKey,mergedInto}], upper, foldedDays, droppedDays}`（level 0=原文，1=天摘要，≥2=上层合并，-1=已丢弃），供 UI 按天展示层级。
8. **装配前文**：`historyData.前文 = joinNonEmpty([midMarkdown, tailText])`（中段已是折叠结果，不再分召回段/窗口段）。
9. **getCharPrompt** 生成最终 `lastMessage`：

```
<STORY_DATA>
<HISTORY>{前文（wordMapping 处理后）}</HISTORY>
<CHARACTER_CARD>{characterData JSON（wordMapping 处理后）}</CHARACTER_CARD>   # roleCardToggle 关时整段省略
</STORY_DATA>
**在回复最末尾必须生成当前正文的NEW_STORY_DATA信息...**
<NEW_STORY_DATA>
<NEW_HISTORY>{historyPrompt 模板}</NEW_HISTORY>
<NEW_CHARACTER_CARD>{characterPrompt 模板（发送前删除 <可变> 标记文本，其余注释保留）}</NEW_CHARACTER_CARD>
</NEW_STORY_DATA>
```

       - `wordMapping` 敏感词降级替换（如 崩溃→失控），同时作用于前文与角色卡 JSON——内容合规策略，改词表需谨慎。
   - `前文` 从 `historyData` 浅拷贝后剥离，不改调用方数据。
10. **token 计数**：对最终 `lastMessage`（含 STORY_DATA 包装与 NEW_STORY_DATA 模板）计数，与实际发送一致。
11. **首条信息特判**（`assembleFinalPrompt`）：`chat.length==2 且 chat[0] 是 AI、chat[1] 是用户` → 追加 `FIRST_MESSAGE_SUFFIX`（提示生成全量历程），并重新计数。

### 5.3 deepMerge 规则（合并语义的核心）

- **数组 + 数组**：源数组中 `JSON.stringify` 与目标重复的条目过滤后 append（**去重键 = 整条 JSON 全等**；摘要哈希键、`getStoryProgressRange` 的 `seen` 去重都与此一致）。数组 + 字符串 delta 时无特殊处理（字符串视为标量，按对象合并规则处理）。
- **对象合并**：已存在的 key 递归合并（后写覆盖先写，无保护字段）；新 key 需通过 `checkPath(path, template)` 校验——模板中存在该路径才接受（模板里 `{{...}}` 动态键允许任意子键），否则 warn 跳过。顶层遗留 `allowUpdate` 字段在 `mergeDataInfo` 中直接丢弃（仅防动态键误收为角色名，不作更新开关）。
- 合并后空字符串值 `delete`。

### 5.4 历程渲染（`renderJourneyMarkdown`）

- 按 `第X天` 分组升序。
- `maxDay`（当前天）与无法解析天数的条目 → 每条详细格式：`# 天数|时间段|地点\n## 历程`。
- 更早的天 → 聚合格式：按「天数+时间段+地点」合并连续条目（同组内字段全等才拼接，任意一项变化即新起一块）：`# 天数|时间段|地点\n## 组内历程拼接`（省 token）。
- 回退：`maxDay==0`（无天数可解析）全部详细格式。
- `extractItemProcess`：历程可能是数组或字符串；每条补中文句号。

---

## 6. 分层摘要层级（v2.21.0）

- **L0** = 历程条目全局有序数组（`fullJourney`，去重键 `JSON.stringify` 全等，与 `deepMerge` 一致）。
- **L1** = 天摘要，一 key 一条；key = `parseDayNumber(天数)` 的数字字符串，解析失败归 `"unknown"`。输入 = 该天全部 L0 条目（`entryToDocText` 拼装）。
- **L(k≥2)** = 连续 `hierFanin`（默认 5，钳制 `HIER_FANIN_MIN/MAX`）个 L(k-1) 节点合并，层数按需生长，`HIER_MAX_LEVELS`（默认 4）封顶。规划由 `planUpperTree` 按存在天数的顺序从最旧侧切块（位置切块，不按绝对天数对齐；span 取首尾，中间缺的天直接归入该组，如 `L2:1~10=[1,2,3,4,10]`）；严格整组合并（不满 `fanin` 的尾巴全部晋升，v2.23.1 起；此前 `2~fanin-1` 提前合并致尾巴 key 天天变），不同层节点永不混入同一父。代价：尾巴凑满前无父（如 fanin5 时 L3 需 25 天），极端预算下尾巴靠 L1/丢弃顶（装配永不等 LLM，见 §5.2-7）。
- 上层节点键为 span（`L<level>:<startKey>~<endKey>`）而非下标：新增天只追加尾部节点，旧节点键稳定。
- 摘要长度只由两个纯文本模板的措辞控制（`hierDayPrompt` / `{{当天历程}}`、`hierMergePrompt` / `{{子摘要列表}}`，L2 及以上复用同一个合并模板），代码不改写不截断，只做整节点取舍。

## 7. 统一 markdown 渲染（`summaryToEntry`）

- 摘要伪装成与 L0 同形的条目，复用 `renderJourneyMarkdown`，三段**分开渲染后拼接**（不混在一次调用里，防同天 L1/L0 被错误合并）：
  - L1 → `{天数:"第X天", 时间段:"全天", 地点:当天去重地点拼接, 历程:摘要原文}`；
  - L(k≥2) → `{天数:"第X天~第Y天", 时间段:"多日", 地点:覆盖地点, 历程:摘要原文}`。
- 摘要原文原样使用，不走 `extractItemProcess` 的补句号逻辑；`maxDay` 仍从完整 L0 计算后透传各段。
- 正文 tail 保持 assistant 原文 verbatim 接最后（对话与历程本质不同，不统一）。

## 8. 分层摘要模块（subsummary.js，v2.21.0 重写）

- 存储见 §4.4；`getCoverage()` 返回校验后的只读快照 `{fanin, days, upper}`（装配层与 UI 共用，不触发 LLM）。
- 生成单元：L1 按天（自动跳过未封天，见 §4.4）；上层按规划树节点。`ensureMissing(force)` 经 `batchChain` 串行，按 L1→L2→… 逐层收集（子齐备才收集父）执行；层内 worker 池并行（并发数 = `subSummaryConcurrency`，钳制 `SUBSUMMARY_CONCURRENCY_MAX`）；批次结束 `pruneStore()` 清孤儿。
- `getMissingCount()` 只计可执行缺失（L1 限已封天，上层需子齐备，与 `collectLevelTargets` 同口径）。
- LLM 调用（fetch / profile 双通道、超时、重试、状态节流）沿用旧二级摘要实现；输出为纯文本（兼容 code fence 包裹），空即失败。
- 触发：`GENERATION_ENDED` 后台补齐（`subSummaryToggle` 开且已配置）；手动 `generateMissing()` / `forceRebuild()` / `generateForDay(dayKey)` / `eraseAll()`（擦除只清摘要，不动开关与原文）。
- 发送前永不等 LLM：`buildPromptData` 只读快照（见 §5.2-7），缺失即原文兜底。

## 9. 角色状态追踪（v2.23.0，core/roletrack.js）

### 9.1 可变状态模版

- `extractVariablePaths` 按行解析角色卡模板原文：属性行 `//` 注释含 `<可变>` 即标记该行全部属性键；`{`/`[` 计数维护对象栈（要求模板保持一行一属性的 pretty 格式，与默认模板一致）。
- 父级标记覆盖整棵子树：`"当前状态": { // <可变>` 下全部子属性自动为可变，无需逐行标记。
- `getVariableInfo` 用标记路径集过滤 `parseTemplate` 后的模板对象：可变路径（含祖先被标记）整体保留，其余分支只保留通向可变后代的骨架；无标记/模板非法时 `hasVariable=false`，追踪拒绝生成并提示去模板 tab 标记。同时 `buildVariableTemplateText` 按同样口径过滤原始文本行，生成保留原树对应行注释的可变状态模版文本（根骨架/可变子树内纯注释行保留，其余丢弃；保留行统一删除 `<可变>` 标记文本后原样输出）。
- `{{可变状态模版}}` 占位符填入的是上述保留注释的文本（已删 `<可变>`，无文本时回退对象 JSON）；`h` 哈希同样基于该文本，模板注释变更即标脏。`getCharPrompt` 发送原角色卡模板时同样删除 `<可变>` 标记文本（其余注释保留），避免模型误解。
- 默认角色卡模板仅 `"{{角色名}}"."职业"` 带 `<可变>` 标记（最小示例）。老用户已保存的旧模板不受影响（设置按鍵合并），需点模板重置或手工加标记才能用追踪。

### 9.2 单楼层输入输出

- 本次故事历程 = 本楼层 L0：`Engine.getFloorStoryBlock` 取该楼层 NEW_HISTORY 的故事历程数组（与 `mergeDataInfo` 同提取口径，mes 优先、swipe 回退），经 `entryToDocText` 拼接；超 `ROLETRACK_JOURNEY_MAX_CHARS`（默认 12000 字符）时从最旧侧截断保留尾部。
- 角色卡（`{{角色列表}}` 占位符的内容）= 本楼层历程文本中出现的角色的完整角色卡：`Engine.getKnownRoleCards()`（全部楼层 NEW_CHARACTER_CARD 合并映射）经 `Engine.nameMatches`（含长名消歧义）过滤，以 `{角色名: 角色卡}` 形式填入模板。历程中无已知角色时直接记空对象，不调 LLM。
- 输出解析：一个 JSON 对象，以可变状态模版为树形参考（键为角色名，值为可变状态子树；空对象表示无变化）。兼容 code fence 包裹与前后杂文本，取首个 `{...}` 做 `JSON.parse`（数组形式宽容并入）；值须为非空对象，超上限截断。解析失败按普通失败走重试。

### 9.3 连接、触发与批量

- 独立连接配置（`roleTrackSource/Profile/BaseUrl/ApiKey/Model/ExtraParams/Temperature/MaxTokens/Concurrency/TimeoutSec`，见 §12），fetch / profile 双通道、超时（钳制复用 `SUBSUMMARY_TIMEOUT_MIN/MAX_MS`）、`MAX_RETRIES` 重试、状态节流口径与分层摘要一致；配置类错误（未配置/模板无效/附加参数非法）`noRetry`。
- 自动触发：`MESSAGE_RECEIVED` 且新消息非用户消息 → 后台补齐全部缺失楼层（覆盖并发到达，不阻塞发送）。用户消息到达不触发；编辑/swipe 导致的过期由手动补齐覆盖（UI 显示"缺失"）。
- 手动（不受 `roleTrackToggle` 限制，只受 `isConfigured()`）：`generateMissing()` 补齐缺失 / `forceRebuild()` 清空后全部重建 / `generateForFloor(floor, {force})` 单楼层 / `eraseAll()` 清空全部楼层追踪（UI 口令确认）。

### 9.4 顺序合并（计算角色卡时）

- `Engine.buildPromptData` 在 `processCharacterData` 淘汰**之后**调 `NS.RoleTrack.applyToCharacterData(characterData, chatCopy)`（`NS` 调用时查找，未加载跳过）。
- `getMergedStates` 按楼层从旧到新遍历各楼层 `states` 对象：同一角色的后楼层覆盖前楼层（对象递归合并，其余含数组整体覆盖——状态快照语义）；未知键按当前角色卡模板校验跳过并 warn（防 LLM 幻觉污染）。
- 合并只作用于传入 `characterData` 中已存在的角色：被淘汰/丢弃的角色不复活（追踪赢，但不复活）。

### 9.5 UI 快照轻量口径

- `getCoverage()` 只读 extra + hash：可变模板走 `getVariableInfoCached()`（`characterPrompt` 文本不变直接复用，不重复 `parseTemplate` + 行级扫描）；每楼层只做 `getFloorEntries`（`Engine.getFloorStoryBlock` 缓存命中）+ `floorHash` + `readFloorSlot` 对比。不做全聊天深拷贝（`getKnownRoleCards`）、不拼 `journeyText`、不做 `nameMatches` 角色匹配。
- `floors[].roles` 取已存 `states` 的键（缺失/无效楼层为空数组，不再预览“待追踪谁”）；生成路径 `runOne` 仍按需调 `getFloorRoleCards` 计算出场角色，语义不变。



## 10. 分层摘要生成细节（subsummary.js）

### 10.1 配置

`isConfigured()` 两种连接方式（`subSummarySource`）：

- **fetch**（默认）：`subSummaryBaseUrl` + `subSummaryApiKey` + `subSummaryModel` 三项非空。浏览器直连 OpenAI 兼容接口（需对方允许 CORS）。
- **profile**：`subSummaryProfileId` 指向 SillyTavern Connection Manager 的 **CC 类型** profile（`mode==='cc'` 且 url/model 齐全；secret-id 可缺省，服务端回退主 API Key）。走 `ConnectionManagerRequestService.sendRequest(profileId, messages, maxTokens, {stream:false, signal:null, extractData:true, includePreset:false, includeInstruct:false, instructSettings:{}}, {...extraParams, temperature})`——**API Key 由服务端解密，不经过浏览器**（比 fetch 模式更安全）。第 5 参数 `overridePayload` 会展开进发往 `/api/backends/chat-completions/generate` 的请求体：白名单采样字段（`top_p/top_k/seed/stop/…`）直接转发上游；CUSTOM 源另支持 `custom_include_body` / `custom_include_headers`（YAML 字符串，即预设"Custom Include Body/Headers"机制）。注意扩展传 `includePreset: false`，profile 绑定的预设参数不会自动带入——要用 preset 里的采样参数请写进 `subSummaryExtraParams`。

### 10.2 单节点生成（`runOne`）

1. `isConfigured()` 否则抛错（UI 状态行提示去配置）。
2. L1：当天分组（`getDayGroups`，经 `Engine.getStoryProgressRange` 全局去重后按天聚合）→ 非 force 且语义哈希命中即 `'skip'`（哈希不含 floor/index，v2.23.1 起删楼层不再误伤后续天）；自动收集跳过未封天（v2.23.2 起，`generateForDay` 单天按钮不受限）；模板 `hierDayPrompt` 须含 `{{当天历程}}`，占位符替换为当天条目 `entryToDocText` 串（`split/join` 防 `$` 模式）。
3. 上层：子文本必须齐备（`getCoverage` 实时重算），模板 `hierMergePrompt` 须含 `{{子摘要列表}}`，占位符替换为 `【子摘要i】` 标注的子串。
4. 调 LLM → 纯文本（兼容 code fence 包裹，空即失败）。单次请求超时（设置项 `subSummaryTimeoutSec` 默认 120 秒，钳制 10~600 秒）：fetch 通道 Abort 中断建连/等包/读 body 全程，无 AbortController 的老环境退化为竞态；profile 通道传 AbortSignal + 超时竞态双保险（服务端忽略 signal 也不 hang）。超时按普通失败走重试。
5. 写 `chat_metadata["chat-optimization-v2-hier"]` → `saveMetadataDebounced()`。

### 10.3 重试与批量（批次内同层并行、层间串行）

- `runOneWithRetry`：失败（含单次请求超时）等 1s 重试，最多 3 次（`RETRY_DELAY_MS`/`MAX_RETRIES`），全失败抛最后错误。持续 hang 的节点最终记 failed，批次必定结束。
- `ensureMissing`：按 L1→L2→… 逐层 `collectLevelTargets`（子齐备才收集父）+ `executeLevel`（层内 worker 池并行，并发数 = `subSummaryConcurrency`，clamp 到 1..`SUBSUMMARY_CONCURRENCY_MAX=8`）；模块级 `running` + `batchChain` 保证批次之间串行。
- 状态总线 `onStatus/getStatus`：`{running, current, done, failed, error, message, lastDone}`，trailing throttle（`SUBSUMMARY_STATUS_NOTIFY_INTERVAL_MS=300ms`）+ 终态立即广播；成功节点附 `lastDone: {dayKey, level, key}` 供 UI 重绘天分组。
- `getDayGroups` 复用 `Engine.getStoryProgressRange`（全局去重语义一致）与 `Engine.entryToDocText`（输入拼装口径一致）。

### 10.4 触发方式

- **自动**：`GENERATION_ENDED` 事件（经 bridge 的 ST EventEmitter，**不是** CustomEvent）→ 条件 `subSummaryToggle && isConfigured` → 后台 `ensureMissing(false)`（不阻塞发送）。天然覆盖「楼层重写 → 哈希失效 → 后台重建」闭环。
- **手动**（不受 `subSummaryToggle` 限制，只受 `isConfigured()`，均返回 promise）：
  - `generateMissing()` — 补齐缺失
  - `forceRebuild()` — 清空后全部重建
  - `generateForDay(dayKey, {force})` — 单天生成/重新生成（故事 tab 按天按钮用）
  - `eraseAll()` — 清空全部层级摘要（不动开关与原文；UI 要求输入口令「确认全部擦除」）

### 10.5 默认摘要模板（产品数据，长度只由措辞控制）

- `hierDayPrompt`：天摘要（同一天历程 → 一条纯文本，默认模板要求保留关键细节、用角色名、相对时间转绝对时间）。
- `hierMergePrompt`：合并摘要（连续子摘要 → 一条纯文本，L2 及以上复用，要求保留主线、合并重复）。

---

## 11. UI（ui/coo-window.js）

### 11.1 结构

- 入口：wand 扩展菜单（`#extensionsMenu`）顶部插入菜单项「剧情角色档案」；`#extensionsMenu` 不存在时回退插入 `#top-settings-holder` 顶部；DOM 未就绪时 500ms 间隔重试最多 30 次，并监听 `#extensionsMenuButton` 点击后重挂。
- 浮动窗口（`#coo-root > .coo-shell`）：顶栏（标题+版本+关闭）+ 左侧栏（tab 导航 + 底部运行状态：失败楼层/Token 数）+ 工作区。侧边栏可折叠（localStorage `coo_sidebar_collapsed`）。
- **7 个 tab**（`TABS`）：`settings` 基础设置 / `subsummary` 分层摘要 / `roletrack` 角色状态 / `templates` 模板 / `roles` 角色查看 / `story` 故事历程 / `preview` 发送预览。激活 tab 记 localStorage `coo_active_tab`。
- **DOM 全部 `createElement` 构建，无 HTML 字符串、无 jQuery**（硬约束）。
- 事件全委托到 workspace：`input`（按 `data-coo-field` switch 分发到 `Settings.set`）、`change`（roleSelect）、`click`（按 `data-coo-action` / `data-coo-reset` 分发）。Esc 关窗。
- **布局与响应式**：workspace `overflow-y: auto`（内容高于窗口即滚动）；`.coo-tab-panel > .coo-section` 为 `flex: 1 0 auto`（永不压缩低于内容高）；模板 textarea 块 `.coo-template-block` 为 `flex: 1 1 auto`——**basis 必须是内容高**（v2.11.0 修复：旧值 `flex: 1 1 0` + `min-height: 0` 在窗口矮、section 无剩余空间时把块塌缩到 0px，内部 textarea（min-height 96px）溢出绘制到下方状态行/按钮上；二级摘要/模板 tab 均受影响）；高窗口时块按 `createTemplateBlock` 的 `flexGrow` 内联参数分配剩余空间撑满。`.coo-subsummary-actions` `flex-wrap: wrap`（窄窗换行）；`@media (max-width: 760px)` 侧栏缩为 56px 纯图标栏、窗口全屏、行内输入框缩窄。

### 11.2 各 tab 要点

- **基础设置**：extensionToggle / roleCardToggle / keepCount / tokenLimit。
- **分层摘要**：开关、连接方式 select（fetch/profile 互斥禁用对应输入区）、profile 下拉（`getProfileOptions` 过滤 CC 类型）、baseUrl/apiKey/password/model/temperature/maxTokens/concurrency/timeout、合并扇入 hierFanin、三模板 textarea（profile 附加参数 JSON 徽章 + `{{当天历程}}` / `{{子摘要列表}}` 徽章）、状态行 ×2（生成状态 / 层级统计）、按钮：补齐缺失 / 强制重建全部 / 擦除全部（口令确认弹层；只清摘要，不动开关与原文）。配置类错误（未配置连接/模板无效/附加参数非法 JSON）记 `noRetry`，失败即停不再重试。
  - profile 下拉监听 `CONNECTION_PROFILE_LOADED/CREATED/UPDATED/DELETED` 事件刷新；已保存 id 失效时自动清空设置。
- **模板**：historyPrompt / characterPrompt textarea + JSON 有效性徽章 + 重置按钮（回 `Settings.defaultSettings`）。
- **角色查看**：角色下拉（活跃角色标 `<活跃角色>`）+ `buildRoleTree` 递归树渲染。
- **故事历程**：楼层范围查询（起始/结束，空=全部）；上层合并卡片（Lx · 起止天 + 摘要正文）置顶；按天分组卡片：天标签 + 条目数 + 层级徽章（原文/天摘要/Lx合并/已丢弃，来自 `stats.hier`）+ 天摘要块（有效→正文 +「重新生成」；无效→「生成摘要」按钮）+ 天内条目（楼层 + 时间段|地点 + 历程正文）；被上层合并吞掉的天不单独展示；「补齐缺失摘要」按钮后台补齐。
- **角色状态**：结构同分层摘要 tab（开关、独立连接配置、profile 下拉、三占位符模板 textarea + 有效性徽章、状态行 ×2、补齐缺失 / 强制重建全部 / 擦除全部口令确认）；另有可变状态模版预览行（可变属性数 + JSON）与逐楼层卡片列表（楼层号 + 历程条数 + 已追踪/缺失徽章 + 各角色状态树 + 单楼层生成/重新生成按钮；已追踪楼层的角色名由状态树标题给出，不再单独显示按历程匹配的“涉及角色”行）。`CONNECTION_PROFILE_*` 事件同时刷新两套 profile 下拉。
### 11.2.1 解析失败气泡（v2.10.2，v2.11.1 检查时机改为消息事件驱动）

- 检查时机：`engine.js` 订阅 ST 消息事件——`MESSAGE_RECEIVED`（回复到达）/`MESSAGE_EDITED`/`MESSAGE_UPDATED`（消息修改）/`MESSAGE_SWIPED`（切 swipe）触发 `checkParseFailures()`；`MESSAGE_DELETED`/`CHAT_CHANGED`/`CHAT_LOADED` 触发**静默重建基线**（`silent` 模式：只更新 `lastStats.failedFloors` 不广播、不通知 UI，避免楼层下标错位导致误报/漏报）。不在生成拦截器（发送时）检查——发送时最新回复尚未到达，检查必然滞后一轮。
- `checkParseFailures` 深拷贝当前 chat 走 `mergeDataInfo`（与生成同一解析逻辑），对**新出现**的失败楼层（相对上次基线）经 `onParseFail(details)` 总线广播 `[{index, reasons}]`（engine 不碰 DOM，模式同 onStats）；基线变化时同步 `notifyStats({failedFloors})` 刷新 UI 失败楼层显示（silent 模式除外）。
- `coo-window.js` 订阅后在右下角浮动 `#coo-parsefail-bubble`（`.coo-parsefail-bubble`，红色）显示「NEW_STORY_DATA 解析失败（楼层X：原因；…」，`Constants.PARSE_FAIL_BUBBLE_TIMEOUT_MS`（默认 8s）后自动隐藏；已入基线的失败楼层不重复弹出，修复后再损坏会重新提示。

### 11.3 刷新链路

- 打开/切换窗口 → `Engine.refreshStats()`（只读深拷贝 + 完整装配，**不改 ST chat**）→ `notifyStats` → `onStatsChanged` → `refreshActiveTabData`（只刷轻量行：stats 值、折叠信息行、层级统计、预览文本、故事天分组列表、分层摘要/角色状态的状态行文本；不再触发角色状态覆盖扫描）。
- `SubSummary.onStatus` → 刷新状态行 + 层级统计；批次结束或单天完成（`lastDone` 非空）时重绘故事天分组列表（天数少，重绘成本低）。
- `RoleTrack.onStatus` → 中间进度 tick 只原地更新状态行文本（零扫描）；批次结束或单楼层完成（`running==false || lastDone`）且当前为角色状态 tab 时，才做一次 `getCoverage` 快照刷统计行 + 楼层卡片列表（`refreshRoleTrackPanel` 内统计行与列表共用同一快照）。tab 打开时同样单次快照（`renderRoleTrackTab` → `refreshRoleTrackPanel`）。
- 侧边栏状态（失败楼层/tokenCount）随 `updateStatsValues` 更新；「将发送词元数」行显示为 `当前 / tokenLimit`，超限时标红（`coo-stat-bad`）。

---

## 12. 设置清单（settings.js `defaultSettings`）

存于 `extension_settings["chat-optimization-v2"]`；`Settings.get` 逐键回退默认，`set` 自动 `saveSettingsDebounced`。

| 键 | 默认 | 说明 |
|---|---|---|
| `extensionToggle` | false | 总开关（关 → 拦截器直接 return，ST 用原始 chat） |
| `roleCardToggle` | true | 角色卡功能（关 → 不注入 CHARACTER_CARD 与 NEW_CHARACTER_CARD 模板、不解析卡片段） |
| `keepCount` | 3 | 正文 verbatim 保留的 assistant 回复条数 |
| `tokenLimit` | 51200 | prompt token 上限（v2.9.1 起先扣除模板/包装开销再分配内容预算，保证最终 tokenCount ≤ 该值） |
| `historyPrompt` | （中文 JSON 模板） | NEW_HISTORY 模板，产品数据 |
| `characterPrompt` | （中文 JSON 模板） | NEW_CHARACTER_CARD 模板，产品数据 |
| `subSummaryToggle` | true | 分层摘要自动生成开关（手动生成不受限；键名沿用旧二级摘要开关） |
| `subSummarySource` | 'fetch' | 'fetch' / 'profile' |
| `subSummaryBaseUrl` / `ApiKey` / `Model` | '' | fetch 模式三项 |
| `subSummaryProfileId` | '' | profile 模式 |
| `subSummaryExtraParams` | '' | profile 附加参数（JSON 对象，经 overridePayload 发往服务端；temperature 设置项优先；fetch 模式忽略） |
| `subSummaryTemperature` | 0.3 | 非法值回退默认 |
| `subSummaryMaxTokens` | 512 | 非法值回退默认 |
| `subSummaryConcurrency` | 4 | 批量生成并行数（1 为串行，上限 `SUBSUMMARY_CONCURRENCY_MAX=8`；限流时调小） |
| `subSummaryTimeoutSec` | 120 | 单次请求超时秒数（钳制 10~600 秒；超时按失败重试，本地慢模型调大） |
| `hierFanin` | 5 | L(k≥2) 合并扇入（钳制 `HIER_FANIN_MIN/MAX`） |
| `hierDayPrompt` | （天摘要模板） | 纯文本模板，占位符 `{{当天历程}}`，长度只由措辞控制 |
| `hierMergePrompt` | （合并摘要模板） | 纯文本模板，占位符 `{{子摘要列表}}`，L2 及以上复用 |
| `roleTrackToggle` | true | 角色状态追踪自动开关（手动生成不受限） |
| `roleTrackSource` | 'fetch' | 'fetch' / 'profile'（独立于分层摘要的连接） |
| `roleTrackBaseUrl` / `ApiKey` / `Model` | '' | fetch 模式三项 |
| `roleTrackProfileId` | '' | profile 模式 |
| `roleTrackExtraParams` | '' | profile 附加参数（JSON 对象，口径同分层摘要；fetch 模式忽略） |
| `roleTrackTemperature` | 0.3 | 非法值回退默认 |
| `roleTrackMaxTokens` | 512 | 非法值回退默认 |
| `roleTrackConcurrency` | 4 | 批量补齐并行数（上限 `ROLETRACK_CONCURRENCY_MAX=8`） |
| `roleTrackTimeoutSec` | 120 | 单次请求超时秒数（钳制复用 `SUBSUMMARY_TIMEOUT_MIN/MAX_MS`） |
| `roleTrackPrompt` | （追踪模板） | 纯文本模板，占位符 `{{可变状态模版}}` / `{{角色列表}}`（内容为完整角色卡 `{角色名: 角色卡}`） / `{{故事历程}}` 三者必填 |

数值设置读取处均有 `isNaN` 回退（模式统一）。

---

## 13. 设计决策汇总（为什么这么做）

| 决策 | 理由 |
|---|---|
| 拦截器原地替换 chat 为单条消息 | ST 原地拦截器约定；ST 后续管线只处理最后一条用户消息，历史被合并 prompt 吸收 |
| 深拷贝 chat 再处理 | `mergeDataInfo` 写 `messageCount`，不能污染 ST 数据 |
| 预览/刷新与生成走同一 `assembleFinalPrompt` | 保证「发送预览」与实际发送逐字一致（含 RAG 检索与首条后缀） |
| token 计数基于最终 lastMessage（含模板包装） | 与实际发送内容一致，预算判定不漂移 |
| 预算先扣除模板/包装开销（v2.9.1，contentLimit） | 最终消息恒含 STORY_DATA 骨架 + NEW_STORY_DATA 模板（默认模板 ~2k tokens）；不扣除时显示的 tokenCount 系统性超出 tokenLimit，限制越小超出比例越大 |
| 正文 verbatim + 历程分层 | 近期对话必须原文（语气/细节），远期用分层摘要压缩；token 够用时零压缩 |
| 折叠按天原子 + 从最旧侧 | 天不可拆（整天要么原文要么摘要要么丢弃）；只折叠最旧的天，高层永远在远端 |
| 折叠估算按「详细格式」计费 | 最坏成本估计，避免混入聚合天分组后超预算 |
| 天级 FNV 哈希失效 + 上层 childHash | 某天条目变化只脏该天 L1 与祖先链；上层节点键为 span，新增天不扰动旧节点 |
| 摘要存 `chat_metadata`（per-chat） | 层级摘要是跨楼层的派生物，不随单条消息走；`fanin` 变化整树重建 |
| 摘要生成批次串行 + 层内并行 | LLM 限流友好；层间串行保证父输入依赖子文本；自动/手动互斥避免写竞争 |
| 分层摘要手动生成不受总开关限制 | 开关只表达「自动行为」意愿（用户确认的决策） |
| 追踪存楼层 extra 而非 chat_metadata | 追踪是单楼层 L0 的派生物，随楼层走；删楼层即删其追踪，楼层重写只脏本楼层 |
| 追踪用独立 LLM 连接 | 与分层摘要的成本/模型解耦：追踪输出 JSON 对模型指令遵循要求更高，允许配不同模型与参数 |
| 本次历程 = 本楼层 L0 而非全量 | 增量语义：每楼层只判断本回复带来的状态变化，全局最终状态由顺序合并得出 |
| 合并在淘汰之后、追踪赢 | 追踪是最新事实源；角色多且上下文紧时可关追踪或调小可变分区 |
| 合并未知键跳过、不复活淘汰角色 | LLM 幻觉键不污染角色卡；淘汰语义（槽位上限）不受追踪影响 |
| 摘要长度只由模板措辞控制 | 代码不改写不截断摘要文本，只做整节点取舍；长度要求写进模板 |
| 发送前永不等 LLM | 缺失摘要的天保持原文兜底；超时/失败不阻塞发送，后台补齐下次生效 |
| 折叠估算 1.5 字符/token + 精确计数丢弃 | 估算优先保速度（`getTokenCountAsync` 调用重，尽量少调）；精确计数**无次数上限**地从最旧槽位丢弃至 ≤ midBudget |
| 正文超预算时从最旧整条 assistant 消息丢弃（v2.9.2） | 单条超长回复会让 正文+角色卡 超预算，旧版无上限直接溢出 tokenLimit；丢整条而非截断文本，且其历程条目回归中段仍可被折叠覆盖 |
| fetch 与 profile 双连接方式 | fetch 简单但 Key 过浏览器+CORS 风险；profile 走 ST 服务端解密更安全（UI 文案已注明） |
| 分层摘要状态节流 + 天分组重绘 | 300ms trailing throttle + 终态/单天完成时重绘天分组列表（天数少，成本低） |
| UI 全 createElement + 事件委托 | AGENTS.md 硬约束；委托使 tab 每次重建 DOM 无需重绑 |
| 菜单项 500ms×30 重试 | ST 扩展菜单 DOM 就绪时机不定 |

---

## 14. 硬约束与坑（AGENTS.md + 实践）

1. **IIFE + 'use strict' 普通脚本**，仅 index.js 用 ESM。新功能模块：建文件 → 加进 `MODULES` 数组 → 挂 `NS.Xxx` → `Object.freeze` 导出。
2. **ST 访问只走 `NS.bridge`**。需要新的 ST 内部符号 → 在 index.js import 并加进 bridge（freeze 内追加）。
3. **`generate_interceptor` 名 = `replaceChatHistoryWithDetailsV2`**，engine.js 中 `globalThis.` 定义，勿改名。
4. **拦截器原地改 chat、返回 undefined**。
5. `index.js` 的 `VERSION` 与 `manifest.json` 的 `version` **必须同步**（VERSION 用于模块 script 的 `?v=` 缓存击穿，不同步 → 用户浏览器拿旧模块）。
6. 模板/默认文案中文是产品数据，**不翻译不清理**；默认模板必须满足 parseTemplate 规则。
7. `deepMerge` 去重键、`getStoryProgressRange` seen 键、天分组 childHash 输入都依赖 `JSON.stringify` 全等——**改历程条目字段名/顺序会连锁影响去重与摘要失效判定**。
8. `wordMapping` 作用于前文与角色卡 JSON，是内容合规策略，不是 bug。
9. `isFirstMessage` 判定依赖 `chat.length==2` 的严格形态，勿在拦截器里提前改动 chat 长度。
10. （v2.21.0 起无 `lib/` 模型资产；此前 `lib/` 下模型/wasm 是大二进制资产，git 提交时注意仓库体积。）
11. 验证方式：从 SillyTavern 父目录启动，浏览器控制台看 `[Chat History Optimization]` 日志；或跑 Node 冒烟测试（§15）。
12. `Settings.set` 已含 `saveSettingsDebounced`，不要在调用方再手动存。
13. 状态总线模式统一为 `notifyXxx(patch) → 快照深拷贝 → 逐个 listener try/catch`、`onXxx(listener) → unsubscribe`。新增模块照抄。

---

## 15. 测试

### 15.1 冒烟测试

```
node test/smoke-hybrid-recall.cjs
```

- mock `window/document/navigator` + `NS.bridge`（假 `getTokenCountAsync` = 长度/1.5 且计数 `tokenCallCount`，与 `EST_CHARS_PER_TOKEN` 同口径；`chat_metadata` 内存对象；最小事件总线 `eventSource` + `fireEvent` 触发器；全局 `fetch` 桩按模板类型回确定性纯文本摘要并计数 `fetchCallCount`），用 `(0,eval)` 按加载序注入 `constant/settings/engine/subsummary` 四个模块。
- 额外 mock：`Engine.onParseFail` 订阅间谍（验证解析失败气泡广播）。
- 构造多天假聊天（默认一楼层一条，B/C 场景每天 3 条），跑 8 个场景（预算相对全量动态校准）：
  - **A**（零压缩）：token 充足 → 不触发折叠，chat 压成 1 条，前文含全部原文。
  - **B**（折叠旧天）：收紧预算 → 最旧天折叠为 L1（伪条目 `# 第X天|全天|` 与原文同形），中段最新天保持原文；装配过程 fetch 计数为 0（发送永不等待）；天为原子单位。
  - **C**（上层合并）：20 天 fanin 3 → 生成 7 个 L2；深压预算 → 出现 L2 折叠，实际渲染槽位从旧到新层级非递增（高层离尾远），跨天伪条目含 `|多日|`，最终不超限。
  - **D**（无摘要兜底 + 精确丢弃）：无任何摘要 + 超预算 → 丢最旧天，保证硬上限，装配不调 LLM。
  - **E**（脏链）：改动某天条目 → 仅该天 L1 失效，其余有效。
  - **F**（fanin 钳制）：1 → 2，99 → 10。
  - **G**（解析失败气泡总线，事件驱动）：某楼层 NEW_STORY_DATA 块 JSON 损坏 → `MESSAGE_RECEIVED` 事件触发引擎检查，经 `onParseFail` 广播该楼层与原因；同内容再次到达不重复广播（历史失败不触发）。
  - **G2**（编辑修复/再损坏）：修复楼层后 `MESSAGE_EDITED` 不再广播且失败基线清空；再次损坏则重新广播（修复后重新损坏可再提示）。
- 改折叠装配/层级生成逻辑后**必须跑此测试**；新增场景往 `check` 里加。

### 15.1.1 角色状态追踪冒烟测试

```
node test/smoke-roletrack.cjs
```

- 同 `15.1` 的 mock 口径另加：`saveChatDebounced` 计数；全局 `fetch` 桩按调用顺序返回 `{"爱丽丝":{"当前状态":{"地点":"地点N"}}}`（code fence 包裹，验证输出解析与顺序合并），并记录末次 prompt（验证 `{{角色列表}}` 为完整角色卡）；用 `(0,eval)` 按加载序注入 `constant/settings/engine/subsummary/roletrack` 五个模块。
- 11 个场景：
  - **A**（模版解析）：默认模板检出唯一可变叶 `{{角色名}}.职业`、不可变字段剔除；另用显式模板覆盖父级 `<可变>` 整子树保留（`当前状态` 地点/穿着）与静态分支剔除。**C–K** 用该显式模板（不依赖默认值）。
  - **B**（无标记）：去掉 `<可变>` 后 `hasVariable=false`。
  - **C**（逐楼层追踪）：3 楼层 `generateMissing` 成功 3 次、extra 落盘、`getCoverage` 全有效、prompt 中角色列表含完整角色卡字段。
  - **D**（顺序合并）：三楼层地点依次不同，合并取最末楼层值。
  - **E**（脏链）：改中间楼层历程只脏该楼层。
  - **F**（合并语义）：追踪赢、不可变设定保留、幻觉键跳过、未出场/已淘汰角色不注入不复活。
  - **G**（无角色楼层）：记空对象且不调 LLM。
  - **H**（模板校验 + 未配置）：缺占位符无效、三占位符有效、空 baseUrl 未配置。
  - **I**（自动触发）：`MESSAGE_RECEIVED` 助手楼层触发补齐、用户消息不触发。
  - **J**（擦除）：清空 3 楼层后全缺失。
  - **K**（端到端）：`replaceChatHistoryWithDetailsV2` 装配出的发送消息含合并后状态。
- 改追踪/合并逻辑后**必须跑此测试**；改折叠/层级逻辑后仍跑 `15.1`。

### 15.2 浏览器手工验证清单

1. wand 菜单出现「剧情角色档案」，打开窗口 7 个 tab 正常，控制台无红错。
2. 开 `extensionToggle`，正常聊天 → 控制台看 `全量 X tokens…分层折叠将启用/不启用`、`Final last message`；发送预览与之一致。
3. 超预算 → 折叠激活，故事历程 tab 按天分组卡片出现层级徽章（原文/天摘要/Lx合并/已丢弃），上层合并卡片置顶；越新的天层级越低。
4. 配置分层摘要（fetch 或 profile），发消息 → 后台自动补齐天摘要并落盘（刷新仍在）；手动 补齐缺失/强制重建/擦除（口令）行为正确；发送时缺失摘要不阻塞（用原文兜底）。
5. （v2.23.0）配置角色状态（独立连接），发消息 → 新助手楼层后台自动追踪并写入 extra（刷新仍在）；角色状态 tab 楼层卡片显示已追踪/缺失与状态树；发送预览的 CHARACTER_CARD 中可变字段为顺序合并后的最终值；模板去掉 `<可变>` 后 tab 提示去标记且追踪拒绝生成。
5. 编辑某旧楼层消息 → 仅该天 L1 失效（故事 tab 该天显示未生成），其余天摘要保留；后台自动重建。
6. 配置不允许 CORS 的 API → 状态行 + console 明确报错，metadata 不被污染。
7. （v2.11.1）解析失败气泡时机：让某次回复的 `<NEW_STORY_DATA>` JSON 损坏 → **回复到达即**弹出红色气泡（无需再发一条消息）；手动编辑修复该楼层后气泡不再出现、侧栏失败楼层消失；再次编辑弄坏 → 重新弹出；删除消息/切换聊天不产生误报气泡。

---

## 16. 版本演进（git log 摘要）

| 版本 | 内容 |
|---|---|
| 2.23.2 | **天摘要封天**：自动补齐跳过数字最大天（未封天），次日历程出现即转正；覆盖未封天的上层因子不齐备自然跳过。 Steady-state 同天回复零 LLM 调用（此前每条回复跟一次当天 L1＋祖先链）；强制重建与单天按钮不受限；冒烟新增 L 场景，B/I/J 断言按封天更新 |
| 2.23.1 | **分层摘要稳定性修复**：`planUpperTree` 严格整组合并 + 只合并同层连续节点（不满 `fanin` 的尾巴全部晋升，如 7 天 fanin5 仅 `L2:1~5`；此前 `L2:6~7`/`L3:1~6=[L2:1~5,6]` 在装配层永不可用，还会在加天时变孤儿致 UI 出现又消失；代价是 L3 需 25 天、尾巴压缩延迟，极端预算靠 L1/丢弃顶）；L1 脏哈希只看语义字段（去 floor/index，删楼层不再误伤后续天）；批次结束 `pruneStore()` 清孤儿 + `fanin` 切换清空 upper（L1 保留）；`getMissingCount` 只计子齐备缺失；冒烟新增 I（删楼层不误伤）/J（整组合并 + fanin 切换）/K（断层跨洞父可用）场景，C 改 20 天 fanin3 为 6 个 L2 |
| 2.23.0 | **角色状态追踪**：角色卡模板 `// <可变>` 标记按同样树形组成可变状态模版；每次助手回复后后台对本楼层 L0 调独立 LLM 连接（`roleTrack*` 设置），输入为模版 + 本楼层 L0 + 出场角色完整角色卡，输出单个 JSON 对象（以模版为树形参考）存楼层 `extra`（哈希标脏），角色卡装配时按楼层顺序合并（追踪赢、未知键跳过、不复活淘汰角色）；新增「角色状态」tab（独立连接配置 + 模版预览 + 逐楼层卡片 + 单楼层生成）；`Engine.getKnownRoleCards/getKnownRoles` + `deepMerge` 导出；默认角色卡模板新增示例可变分区 `当前状态`；冒烟测试新增 `smoke-roletrack.cjs`（11 场景） |
| 2.22.0 | **profile 附加参数**：`subSummaryExtraParams`（JSON 对象）经 `sendRequest` 第 5 参数 `overridePayload` 发往 ST 服务端，白名单采样字段直达上游，CUSTOM 源另支持 `custom_include_body` / `custom_include_headers`（YAML）；temperature 设置项优先；配置类错误（未配置/模板无效/非法 JSON）`noRetry` 不重试；冒烟测试新增 H 场景（透传 + 覆盖优先级 + 非法 JSON） |
| 2.21.0 | **多层级摘要替代 tag + 稀疏远程记忆**：删除 `retrieval/embedding/embed-worker/embedstore/recallcache + lib/`（模型资产）与整套打分（`scoreFarEntries/ModeA/BM25`）；`subsummary.js` 重写为 L1 天摘要 + L(k≥2) 按 `hierFanin` 合并（纯文本，`chat_metadata` 持久化，childHash 校验，逐层收集执行，发送前永不等 LLM）；`engine.js` 改分层折叠装配（预算自然决定、从最旧侧折叠、天原子、精确丢弃保证硬上限）+ 摘要伪条目统一渲染；`ragRatio` 删除；UI 改按天分组 + 上层卡片（删语义打分 tab）；冒烟测试重写为 8 确定性场景，全过 |
| 2.19.0 | **Mode A 改流式配额选中**：`FRAG_WEIGHT_USER/WIN_BASE/WIN_DECAY/WIN_MIN` 加权 max 删除，改 `MODEA_USER_BUDGET_RATIO(0.4)` + `MODEA_WINDOW_BUDGET_RATIO(0.2)`（每窗口片段独立配额）：Stage U 对全池按 user fragScore 降序选满 userQuota 并移出池，Stage W 按窗口最新→最旧逐片段只对剩余池选满 winQuota，总量满 ragBudget 即停（后续窗口不编码不打分）；单分公式/门槛/三级缓存沿用，选中来源唯一（`bestFrag` = 选中阶段）；精确裁剪改来源优先级（最旧window→…→最新window→最后user，同源内选中分低先剔）；空查询回退到最近非空用户消息；冒烟测试新增 J 场景（窗口通道从剩余池拾取 + 来源唯一）与 K 场景（空查询回退），全过 |
| 2.18.0 | **RAG 打分改纯语义 + 命中门槛，新增「语义打分」tab**：Mode B `scoreFarEntries` 与 Mode A `scoreFarEntriesModeA`（window 片段）的 `score = 0.25·S_actor + 0.15·S_location + 0.60·S_semantic` 改为门槛公式——`S_actor=0` 且 `S_location=0` → 0 分（未命中，parts 仍保留明细），命中 → 纯 `S_semantic` 排序；Mode A `user` 片段无门槛（恒为 `S_semantic`）；`SUMMARY_W_ACTOR/LOCATION/SEMANTIC` 删除（S_actor/S_location 仅作门槛信号不入总分；故事历程 RAG 徽章同步不再显示人/地算分，只保留命中比例）；新增 `Engine.scoreJourneySemantics(queryText)`（user 信息流程，全部楼层条目按 JSON 去重，无门槛，返回 floor/index/天数/时间段/地点/历程/semantic + event{text,score} + recall[{text,score}] 组件得分明细）与「语义打分」tab（输入信息→全部历程条目 S_semantic 故事卡片展示，按得分降序 + 事件/各触发实际语义得分明细，批量生成完成后自动重算）；冒烟测试假 Embedder 改 bigram 词袋向量（余弦与文本重叠正相关），场景 A 新增门槛断言、新增 I 场景，10 场景全过 |
| 2.17.0 | **历程聚合渲染改按「天数+时间段+地点」合并连续条目**：`renderJourneyMarkdown` 早于 maxDay 的天不再整天聚合成 `# 第X天\n## 当日全部历程`，改为同一天内「天数+时间段+地点」三项全等的连续条目合并为一块 `# 天数|时间段|地点\n## 组内历程拼接`，任意一项变化即新起一块（更细粒度保留时间/地点结构，token 成本与整天聚合基本持平）；maxDay/无法解析天仍逐条详细格式，不变；连带修复：精确计数剪枝剔除的条目同步移出 `packedSet`，`farScores.hit` 与最终 `ragMarkdown`/`rag.hits` 严格一致（旧版被剔除条目仍标 RAG命中）；冒烟测试场景 H 窗口/远端数量断言按新格式重校准（聚合头变长 → 窗口 4 条 → 2 条），9 场景全过 |
| 2.16.0 | **Mode A 窗口片段权重改指数衰减**：`FRAG_WEIGHT_WIN_NEW/WIN_NEXT/WIN_OTHER` 三级固定权重删除，改 `FRAG_WEIGHT_WIN_BASE(1.0) × FRAG_WEIGHT_WIN_DECAY(0.95)^i`（i=0 为最新窗口条目）+ 下限 `FRAG_WEIGHT_WIN_MIN(0.50)`：权重低于下限的条目跳过且后续更旧条目一并停止参与 farEntries 打分（权重单调递减，0.95^i < 0.5 约在 i=14）；行为变化：最新/次新条目权重 0.90/0.85 → 1.0/0.95（窗口信号略增强），旧条目 0.80 平权 → 逐条衰减并截断；冒烟测试全过 |
| 2.15.0 | **语义打分两分量合并为单 max 分量**：Mode B `scoreFarEntries` 与 Mode A `scoreFarEntriesModeA` 不再分别计 `0.20·S_event + 0.40·S_recall`，改为 `S_semantic = max(S_event, S_recall)` 单分量、权重 `SUMMARY_W_SEMANTIC(0.60)` 入总分（总权重仍 ≈1：0.25/0.15/0.60）；`SUMMARY_W_EVENT`/`SUMMARY_W_RECALL` 删除；`parts` 的 `event`/`recall` 字段合并为 `semantic`，UI RAG 徽章 `事 忆 → 总分` 改 `语义 → 总分`；行为变化：S_event 与 S_recall 相等时结果与旧版一致，不等时新值不低于旧值（取高者 ×0.6）；冒烟测试场景 A 新增 semantic 断言，全场景过 |
| 2.14.0 | **S_actor 移除主角排除**：删除「far 池 df（出现的摘要条目数）最高的前 N 名人物在 `Q`、`F` 两侧剔除」逻辑（Mode B `scoreFarEntries` 与 Mode A `scoreFarEntriesModeA` 的 user 片段 Q / window 片段 actor 集 / 远端 actor 均不再过滤），Dice 系数 `2\|Q∩F\|/(|Q|+|F|)` 直接对全量摘要 actor 计算；`Constants.ACTOR_EXCLUDE_TOP` 删除；行为变化：纯主角查询有人物分（纯主角条目 actorScore = 1 满分、与稀有角色同条目 = 0.67，v2.13.0 为全池 0）、非主角查询含主角 actor 的条目人物分下降（如场景 A 陈九条目 1 → 0.67）；冒烟测试场景 A/C 断言同步更新，9 场景全过 |
| 2.13.0 | **S_actor 计算方式改为 Dice + 主角排除**：原「命中人物 IDF 之和 / `ACTOR_IDF_SATURATION` 饱和」改为 Dice 系数 `2\|Q∩F\|/(|Q|+|F|)`（Q=查询侧人物集，F=远端摘要 actor，两侧去重），并剔除 far 池出场最多（df 最高）的前 `Constants.ACTOR_EXCLUDE_TOP(1)` 名人物——Mode B 的 Q 为查询中 nameMatches 命中的已知人物集（同一查询对全池共用，跨条目可比），Mode A 的 Q 为 user 片段全名单提取 / window 片段条目 actor 集（成对匹配语义不变）；行为变化：纯主角查询人物分全池为 0（旧版约 0.1）、非主角人物不再按稀有度加权；`ACTOR_IDF_SATURATION` 删除；冒烟测试场景 A/C 断言同步更新，9 场景全过 |
| 2.12.0 | **远端条目 RAG 全量命中/未命中标记**：`rag.farScores` 记录全部远端条目打分明细（text/score/parts/hit，无摘要被排除者为 null）；故事历程 tab 每个 far 卡片显示 `RAG命中/未命中（bestFrag 片段来源：用户/楼层N） 人x/y(人物分) 地x/y(地点分) 事 忆 → 总分`（BM25 通道显示 `BM25 0.xx`，无摘要显示 `（无二级摘要）`），未命中用弱化徽章（`.coo-rag-miss-score`），命中卡片高亮不变；「仅显示选中楼层」仍只过滤命中条目；bestFrag 标记为真实楼层号 `fN`（首现楼层归属映射，UI 显示「用户 / 楼层N」，归属缺失回退 `wN`「窗口·第N」）；**窗口起点对齐楼层边界**（楼层不可拆，被引用的楼层必整层在窗口内，不会与 farEntries 矛盾）；冒烟测试 A/A' 新增 farScores 断言、新增 H 场景（非空窗口对齐 + bestFrag 楼层号）全过 |
| 2.11.1 | **NEW_STORY_DATA 解析失败检查时机改为消息事件驱动**：原在生成拦截器（发送时）检查，导致某次回复损坏要到下一条消息发送时才提示（滞后一轮）；新增 `Engine.checkParseFailures()`，订阅 `MESSAGE_RECEIVED`（回复到达）/`MESSAGE_EDITED`/`MESSAGE_UPDATED`（修改）/`MESSAGE_SWIPED`（切 swipe）即时检查当前聊天并对新出现失败楼层经 `onParseFail` 广播，基线变化同步 `notifyStats` 刷新失败楼层显示；`MESSAGE_DELETED`/`CHAT_CHANGED`/`CHAT_LOADED` 静默重建基线（楼层下标错位防护）；拦截器内检查移除；修复后重新损坏可再次提示；冒烟测试新增 G2 场景（编辑修复/再损坏），9 场景全过 |
| 2.11.0 | **UI 响应性修复**（生成二级摘要时界面卡死）：① embedding 推理移入 `core/embed-worker.js` module WebWorker（`embedding.js` 重写为 worker 编排 + 主线程回退，接口不变）；② 二级摘要状态通知 300ms trailing throttle + `lastDone` 单条目增量更新（story tab 不再每条整表重绘）；③ 楼层 story block 解析缓存（`Engine.storyBlockCache`）+ 摘要哈希缓存（`SubSummary.storyHashCache`）；④ 向量同步补齐逐批进度上报（`encodeBatch` 新增 `onProgress`，状态行实时显示 `补齐向量 done/total…`，消除大批量编码时状态行看似卡死）+ worker 初始化失败真正回退主线程（terminate 残留 worker 后走 `initMainThread`，与降级链一致）；⑤ 修复批量向量拆分：v3 feature-extraction 批量输入返回单个 `[N,D]` Tensor 而非逐条数组，旧代码 flatten 成单向量导致 embedstore 收到 `undefined`（`vecToBase64` 抛 `reading 'buffer'`）→ 始终传数组 + `batchToVectors` 按行拆分 + 条数一致性守卫（worker 与主线程回退路径同修）；⑥ WebGPU 加速：`EMBED_USE_WEBGPU` 开关下优先 `{dtype:'fp32', device:'webgpu'}`（捆绑 onnx-community fp32 model.onnx ~95MB），失败/不支持自动回退 q8/WASM，后端经 ready 消息上报、UI 状态行显示「，WebGPU」标记（fp32/q8 向量混用无害，不触发向量库重建）；⑦ 修复污染向量库导致刷新全量重算：旧批量 bug 曾把 7680 维（15×512）长向量写入持久化库，`loadStore`「首条定基准」被单条污染条目击溃 → 整库丢弃、每次刷新重算全部向量；改 `raw.dims` 优先 / 多数派基准维度（污染条目丢弃后按缺失自动重编码，库自愈）+ `persistVectors` 维度守卫 + `resolve` 跳过空向量；同步完成文案改为「向量库现有 X 条（本次新增 Y，清理失效 Z）」消除总数与增量数字不自洽的误读；⑧ 矮窗口模板块塌缩修复：`.coo-template-block` 旧值 `flex: 1 1 0` + `min-height: 0` 在窗口高度不足（section 无剩余空间）时塌缩到 0px，内部 textarea（min-height 96px）溢出绘制到下方状态行/按钮上（二级摘要/模板 tab 均受影响）→ 改 `flex: 1 1 auto`（块至少占内容高，超出经 workspace 滚动，高窗口撑满行为不变）+ `.coo-subsummary-actions` `flex-wrap: wrap`（窄窗换行）；最终渲染结果不变，冒烟测试全过 |
| 2.2.0 | 分层注入 + 浏览器内 RAG（bge-small-zh via transformers.js） |
| 2.2.5 | 最终消息计数；发送预览 tab |
| 2.3.0 | **bge embedding RAG → 纯 BM25**；稀疏远期记忆默认开启，删 ragToggle |
| 2.3.1 | BM25 停用词单字过滤（保 bigram） |
| 2.4.0 | 二级摘要（fetch LLM、楼层哈希失效、二级摘要 tab） |
| 2.5.0 | **召回特化摘要**（actor/location/event/recall_when）+ 混合召回（IDF 人物分 + 地点精确 + 本地 bge 余弦 + BM25 回退）；恢复模型资产 |
| 2.6.0 | 故事 tab RAG 命中标记内联到条目；仅显示选中楼层 |
| (2.6.x) | 批量状态全局进度；失败重试 3×1s；生成所有缺失；擦除口令确认 |
| 2.8.0 | **向量持久化**（chat_metadata base64 + 文本哈希键 + 后台完整性同步 + 打分路径 store 优先） |
| 2.9.0 | **Mode A 分段加权召回**（用户+窗口片段 max-pooling，权重 1.0/0.95/0.90/0.80）+ **召回 LRU 内容寻址缓存**（fragVec/docVec/pairScore）+ **发送前补生成二级摘要**（30s 超时，无 BM25 回退）+ **装箱估算(1.5字符/token)+精确计数剪枝** + **补漏气泡 UI** |
| 2.9.1 | **预算扣除模板/包装开销**（contentLimit = tokenLimit - overheadTokens），最终 tokenCount 不再系统性超出 tokenLimit；侧边栏 token 行显示 `当前 / 上限` 且超限标红 |
| 2.9.2 | **tokenLimit 硬保证**：召回段精确计数剔除去掉 3+1 次上限（剔除至 ≤ ragBudget，修复候选装多）；正文超 midBudget 时从最旧整条 assistant 消息丢弃；RAG 失败回退保留有上限窗口中段 |
| 2.9.3 | 侧边栏 token 行标签中文化：`Chat History Token Count` → `将发送词元数`（修复窄侧边栏截断） |
| 2.10.2 | **NEW_STORY_DATA 解析失败气泡**：`mergeDataInfo` 收集每层失败原因（`failedDetails`）；生成拦截器对新出现失败楼层经 `Engine.onParseFail` 总线广播，UI 右下角红色气泡提示（8s 自动隐藏，历史失败不重复弹出） |
| 2.10.1 | `config/` 目录重命名为 `core/`（功能模块目录名更贴切）；无行为变更，冒烟测试全过 |
| 2.10.0 | **可调常数集中到 `core/constant.js`**（`NS.Constants`，每项附调整指导）：召回打分权重/IDF 饱和/BM25 参数/停用词、角色卡槽位/蒸馏阈值、片段权重、装箱估算、重试、embedding 缓存/批大小、持久化与预热延迟、LRU 容量、菜单挂载时机；各模块改经 `NS.Constants` 读取；无行为变更，冒烟测试 7 场景全过 |

---

## 17. 接手者常见任务指引

- **加一个新 tab / 设置项**：TABS 数组 + 对应 `renderXxxTab` + input 委托 case + settings 默认值 + CSS。
- **改折叠策略**：可调常数全部在 `core/constant.js`（`NS.Constants`，每项附调整指导）；折叠在 `planFoldSlots`；层级规划在 `planUpperTree`；改完跑冒烟测试。
- **改摘要模板**：`hierDayPrompt` / `hierMergePrompt` 默认模板（产品数据，长度只由措辞控制）+ UI 徽章校验占位符；模板键变化时旧摘要按缺失重建（childHash 自然 miss，无需迁移）。
- **新增模块依赖 ST 内部**：index.js import → bridge 追加 → 模块内 `NS.bridge.xxx`。
- **发布**：bump `index.js` VERSION 与 `manifest.json` version（同步）→ 提交（本仓库）→ 用户侧强刷（`?v=` 缓存击穿自动生效）。

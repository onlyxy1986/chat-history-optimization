# Chat History Optimization (chat-optimization-v2) — 完整流程交接文档

> 版本：v2.17.0（2026-08-31）
> 仓库：本目录是独立 git 仓库（嵌套在 SillyTavern 安装目录内），在此提交，不要提交到父仓库。
> 无 package.json、无构建、无 lint。功能模块为浏览器端普通脚本。

---

## 1. 插件做什么

这是一个 SillyTavern 第三方扩展（UI 名「剧情角色档案」），核心目标是**控制长对话发送给 LLM 的 token 量**，同时保持剧情上下文完整：

1. **结构化剧情协议**：要求 AI 每次回复末尾输出 `<NEW_STORY_DATA>` 块（含 `NEW_HISTORY` 故事历程 JSON、可选 `NEW_CHARACTER_CARD` 角色卡 JSON）。插件把全部楼层的这些块解析、合并、去重，形成全局「故事历程」数组和「角色卡」映射。
2. **分层注入**：把最终 prompt 装配为三层——`RAG 远端召回段 + 中段历程窗口 + 正文 verbatim 尾部`，在 `tokenLimit` 预算内最大化保留上下文；超预算时用检索从远期条目中挑回相关条目。
3. **角色卡管理**：槽位上限淘汰 + 蒸馏（久未出场角色只保留核心设定），阈值见 `core/constant.js`。
4. **二级摘要（recall-specialized sub-summary）**：对每条历程条目调用 LLM 生成 `{actor, location, event, recall_when}` 结构化摘要，持久化在楼层消息 `extra` 中，既供 UI 浏览，也作为混合召回的语义信号。
5. **混合召回（v2.5.0+）**：BM25 词法检索 + 本地 ONNX embedding（bge-small-zh-v1.5, transformers.js）语义打分，向量持久化在 `chat_metadata`；推理在 WebWorker 中执行（v2.11.0，主线程回退）。
6. **LRU 召回缓存 + Mode A 分段加权打分（v2.9.0）**：`recallcache.js` 对片段向量 / 远端条目向量 / 逐对分数做内容寻址 LRU 缓存，使「发送新用户信息只重算新相关远端条目」；`subSummaryToggle` 开启时走 Mode A（按最新用户消息 + 每个窗口条目的二级摘要切成多个片段，逐片段加权 max），缺失摘要发送前先补生成（带超时），绝不 BM25 回退。

---

## 2. 目录结构

```
├── manifest.json              # ST 扩展清单（js: index.js, css: styles/coo.css, generate_interceptor）
├── index.js                   # 唯一 ESM 入口：bootstrap + bridge + 模块注入
├── core/
│   ├── constant.js            # 可调常数集中定义（NS.Constants，每项附调整指导；须最先加载）
│   ├── settings.js            # 设置存取（extension_settings["chat-optimization-v2"]）
│   ├── engine.js              # 核心引擎（纯逻辑无 DOM）：解析/合并/装配/召回打分/拦截器
│   ├── subsummary.js          # 二级摘要生成器（纯逻辑）：LLM 调用、extra 持久化、自动触发、缺失收集/补生成
│   ├── recallcache.js         # 召回 LRU 缓存（fragVec/docVec/pairScore 内容寻址）+ 补漏气泡总线 + 后台预热
│   ├── retrieval.js           # BM25 检索器（纯逻辑，中文 unigram+bigram 分词）
│   ├── embedding.js           # 本地 embedding 编排（transformers.js + 本地 ONNX 模型；worker 优先，主线程回退）
│   ├── embed-worker.js        # module WebWorker：transformers.js 推理跑在独立线程（不经 MODULES 注入，由 embedding.js `new Worker` 加载）
│   └── embedstore.js          # 摘要向量持久化（chat_metadata）+ 后台完整性同步
├── ui/
│   └── coo-window.js          # 浮动窗口 UI（6 个 tab，全 createElement）
├── styles/
│   └── coo.css                # 全部样式（按区块注释分节）
├── lib/
│   ├── transformers.min.js    # @huggingface/transformers v3 ESM 打包
│   ├── ort/                   # onnxruntime-web wasm（jsep, simd-threaded）
│   └── models/bge-small-zh-v1.5/  # 本地模型（q8 量化 onnx + tokenizer）
├── test/
│   └── smoke-hybrid-recall.cjs  # Node 冒烟测试（mock 浏览器环境，node 直接跑）
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
      → core/subsummary.js → core/retrieval.js → core/embedding.js
      → core/embedstore.js → core/recallcache.js → ui/coo-window.js
     ```
    **新增脚本模块文件必须加入此数组**，否则不加载。例外：`core/embed-worker.js` 是 WebWorker 脚本，由 `embedding.js` 经 `new Worker(url, {type:'module'})` 独立加载，**不进此数组**。
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
- 加载顺序即依赖顺序：constant 最先（人人经 `NS.Constants` 读可调常数），settings 次之（人人依赖），engine 第三（subsummary 依赖 `NS.Engine`），embedding 在 retrieval 后（engine 的 `scoreFarEntries` 运行期读 `NS.Embedder`，加载期不强依赖，但 UI 与 embedstore 需要）。
- 各模块末尾 `Object.freeze` 导出 API，加载顺序变了若引用未初始化模块会直接抛错，可作断点。

### 3.4 启动时的自执行行为

| 模块 | 模块加载即执行 |
|---|---|
| `constant.js` | 无（仅定义并冻结 `NS.Constants`） |
| `subsummary.js` | `init()` 注册 `GENERATION_ENDED` 事件监听 |
| `embedding.js` | `init()` 立即预热：优先启动 `core/embed-worker.js` WebWorker 并在其中加载 transformers + ONNX 模型（异步，失败可重试）；worker 不可用时回退主线程加载（v2.11.0）；模型加载 WebGPU fp32 优先、失败回退 q8/WASM（v2.11.0） |
| `embedstore.js` | `init()` 注册事件监听 + 延迟 1s 首次向量完整性同步 |
| `recallcache.js` | `init()` 订阅 `MESSAGE_RECEIVED`(2s 防抖)/`GENERATION_ENDED`/`CHAT_CHANGED`/`Embedder.onStatus` 做后台预热；`onFill` 气泡总线 |
| `coo-window.js` | 由 index.js 在 DOM ready 后调 `mount()` |

---

## 4. 数据模型与协议

### 4.1 chat 数组约定（ST 原生）

- `chat` 是消息数组，`chat[0]` 为首条消息（通常为 system 或第一条回复），**楼层号 = 数组下标，楼层从 1 开始**。
- AI（assistant）消息判定：遍历原始 ST `chat` 数组时用 `!item.is_user`（ST 消息恒带 `is_user` 字段）；遍历故事历程条目时用完整判定式 `("is_user" in item && !item.is_user) || (item.role === "assistant")`。两种形式在 engine/subsummary/recallcache/embedstore 中反复出现，保持原样。
- 消息 `mes` 为主文本；存在 swipe 时 `getFloorStoryBlock` 回退读 `item.swipes[item.swipe_id]`（当前激活 swipe）。

### 4.2 NEW_STORY_DATA 块协议

AI 回复末尾（由 `getCharPrompt` 注入的模板要求）输出：

```
<NEW_STORY_DATA>
<NEW_HISTORY>
{ "故事历程": [ { "天数":"第X天", "时间段":"清晨|上午|中午|下午|傍晚|晚上|深夜|凌晨", "地点":"大地点.小地点", "历程":"..." } ] }
</NEW_HISTORY>
<NEW_CHARACTER_CARD>
{ "角色名": { "角色设定": {...} }, "allowUpdate": false }
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

### 4.4 二级摘要持久化结构

```js
item.extra["chat-optimization-v2"] = {
    storyHash: "<FNV-1a 32bit hex of JSON.stringify(该楼层故事历程数组)>",
    summaries: [ { s: {actor:[], location:[], event:'', recall_when:[]}, t: <ms> } | null, ... ]
}
```

- `summaries` 与该楼层 `故事历程` 数组**按下标一一对应**，缺失为 `null`（部分生成合法）。
- **楼层级哈希失效**：读时重算 `storyHash`，不匹配即 `delete item.extra["chat-optimization-v2"]`，全部条目视为未生成。失效场景：楼层重新生成、手动编辑消息、切换 swipe。
- 向量持久化（v2.8.0）：

```js
chat_metadata["chat-optimization-v2-embed"] = {
    model: 'bge-small-zh-v1.5',
    dims: 512,
    v: { "<文本FNV哈希>": { b: "<base64 Float32Array>", t: <ms> }, ... }
}
```

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
3. **processCharacterData 角色卡淘汰与蒸馏**：
   - `MAX_SLOTS = 10`。
   - 打分：最新用户消息（`chat[chat.length-1].mes`）中 `nameMatches` 命中 → `Constants.ROLE_CARD_MENTION_SCORE`（必保）；否则取**最后一次出现**的消息下标作为分数；都没出现 → `-1`。
       - `nameMatches`：角色名按 `()`/`（）`/`·`/`.` 拆出所有别名 term（`getNameSearchTerms`），任一 term 命中即可；**消歧义**：若 term 是另一个更长角色名的子串（「沈梦」⊂「沈梦瑶」），逐次出现检查是否被长名「吞掉」，至少一次独立出现才算命中。
   - 按分数降序取前 10，其余物理删除。
   - **蒸馏**：分数 < `ROLE_CARD_MENTION_SCORE` 且距最后出现 > `ROLE_CARD_STALE_DISTANCE`（30）条消息的角色，只保留 `{角色设定}`（丢弃穿戴/物品/技能等动态字段）。
4. **正文尾部（verbatim）**：
   - `assistantIdxArr` = 所有非用户消息下标；取倒数第 `keepCount` 条 assistant 起，到末尾，过滤出非用户消息的 `mes` 拼接为 `tailText`。
   - `tailCovered` = 这些 assistant 消息 `messageCount` 之和（正文已原文覆盖的历程条数）。
   - 边界：`keepCount=0 且只有 1 条 assistant` 时强制保留 1 条；`keepCount > assistant 数` 时钳到 assistant 数。
5. **历程拆分**：`fullJourney = historyData.故事历程`；`midEntries = fullJourney.slice(0, length - tailCovered)`（正文覆盖的尾部条目从历程剔除，避免重复）；`midMaxDay` 从**完整历程**计算（识别「当前天」必须含被排除部分）。
6. **Token 预算判定**：
    - `fullTokens = tokens(fullMidMarkdown + tailText + characterDataJson)`（`getTokenCountAsync`）。
    - **模板/包装开销（v2.9.1）**：`overheadTokens = tokens(getCharPrompt({前文:''}, {}))`——STORY_DATA 骨架 + NEW_STORY_DATA 模板恒附在最终消息上（默认模板约 2k tokens），若不扣除，最终显示的 tokenCount 永远超出 tokenLimit 一个开销量。`contentLimit = max(1, tokenLimit - overheadTokens)`，后续所有预算判定用 `contentLimit`。
    - `useModeA = !!(NS.SubSummary && Settings.get('subSummaryToggle'))`。
    - `ragWillActivate = (Retriever ? Retriever.isReady() : false) || useModeA`，且 `fullTokens > contentLimit × (1 - ragRatio)`。
    - 未触发 → 全量注入（`midMarkdown = fullMidMarkdown`），不裁剪。
7. **RAG 路径**（触发且 `runRag` 时）：
     - `ragBudget = round(contentLimit × ragRatio)`；`midBudget = contentLimit - ragBudget`。
     - **正文硬上限（v2.9.2）**：`tokens(tailText + charJson) > midBudget` 时从最旧整条 assistant 消息丢弃（`tailPos` 右移，其历程条目回归中段，可被窗口/召回重新拾取），直到装下或只剩 1 条；仍超则 console.warn（此时最终必然超限）。
      - **二分搜索**最大后缀窗口 `bestK`：`tokens(窗口markdown + tailText + charJson) ≤ midBudget`。窗口 = `midEntries` 尾部 `bestK` 条（时间最近的）。
      - **楼层对齐（v2.12.0）**：二分后把 `bestK` 收缩到楼层边界——楼层不可拆，整层要么在窗口要么在远端（避免同一楼层一部分被 RAG 打分、一部分在窗口内，导致 bestFrag 标注与 UI 标记矛盾）。楼层归属按首现顺序扫各楼层 `NEW_HISTORY` 块、原始条目 JSON 作键（与 `getStoryProgressRange` 全局去重语义一致）。
    - `farEntries = midEntries` 前段（窗口外）；`query = 最后一条消息（用户消息）mes`。
    - **Mode A（`useModeA`）**：发送前先补齐缺失二级摘要——`SubSummary.getRecallMissingCount(1, lastFloor) > 0` 且 `isConfigured()` 则 `await withTimeout(SubSummary.ensureRecallSummaries(1, lastFloor), SUBSUMMARY_WAIT_TIMEOUT_MS)`（超时 30s，见 §10.6）；未配置连接则 warning 并跳过缺失条目（**绝不 BM25 回退**）。打分走 `scoreFarEntriesModeA`（见 §7.4）。
    - **Mode B（`!useModeA`）**：`queryText = query + 窗口各条目 docText`（`entryToDocText`），打分走 `scoreFarEntries`（见 §7.1-7.3）。
    - **贪心装箱**：按分数降序遍历，单条**估算**成本 = 该条目**详细格式** markdown 长度 / `EST_CHARS_PER_TOKEN`(1.5)（即最大成本估计）；重复文本去重（`packedSet`）；停止条件：预算满 / 全部唯一条目装完 / 已见最小条目也装不下。装入的按**原始时间顺序**重排。
    - **精确计数剪枝**：`ragMarkdown` 渲染后做 `getTokenCountAsync` 精确计数；若精确 token 超预算，从**最低分**逐条剔除后再渲染，**直至 ≤ ragBudget（v2.9.2 起无次数上限**——估算 1 token≈1.5 汉字对中文偏乐观，旧版 3+1 次上限会漏剔，召回段可超预算数千 token）；剔除条目同步移出 `packedSet`（v2.17.0），`farScores` 的 `hit` 标记与最终 `ragMarkdown`/`rag.hits` 严格一致（旧版被剪枝剔除的条目仍标 hit=true，UI 误标 RAG命中）。
    - `ragMarkdown = renderJourneyMarkdown(装入条目, midMaxDay)`；`rag.hits` 记录每条命中的 text/score/parts；`rag.farScores`（v2.12.0）记录**全部**远端条目的打分明细 `{text, score, parts, hit}`（无摘要被排除者 score/parts 为 null），UI 用 `entryToDocText` 反查，在每个 far 卡片上标记 RAG命中/未命中。
    - 检索抛错 → 保留二分窗口中段（有上限），仅放弃召回，`rag.active = false`（v2.9.2 起不再回退无上限全量）。
8. **装配前文**：`historyData.前文 = joinNonEmpty([ragMarkdown, midMarkdown, tailText])`。
9. **getCharPrompt** 生成最终 `lastMessage`：

```
<STORY_DATA>
<HISTORY>{前文（wordMapping 处理后）}</HISTORY>
<CHARACTER_CARD>{characterData JSON（wordMapping 处理后）}</CHARACTER_CARD>   # roleCardToggle 关时整段省略
</STORY_DATA>
**在回复最末尾必须生成当前正文的NEW_STORY_DATA信息...**
<NEW_STORY_DATA>
<NEW_HISTORY>{historyPrompt 模板}</NEW_HISTORY>
<NEW_CHARACTER_CARD>{characterPrompt 模板}</NEW_CHARACTER_CARD>
</NEW_STORY_DATA>
```

       - `wordMapping` 敏感词降级替换（如 崩溃→失控），同时作用于前文与角色卡 JSON——内容合规策略，改词表需谨慎。
   - `前文` 从 `historyData` 浅拷贝后剥离，不改调用方数据。
10. **token 计数**：对最终 `lastMessage`（含 STORY_DATA 包装与 NEW_STORY_DATA 模板）计数，与实际发送一致。
11. **首条信息特判**（`assembleFinalPrompt`）：`chat.length==2 且 chat[0] 是 AI、chat[1] 是用户` → 追加 `FIRST_MESSAGE_SUFFIX`（提示生成全量历程），并重新计数。

### 5.3 deepMerge 规则（合并语义的核心）

- **数组 + 字符串 delta**：支持 LLM 发出 `"delete 2-4"` 指令删除数组下标区间（越界则 warn 不删）。这是历程条目修正通道。
- **数组 + 数组**：源数组中 `JSON.stringify` 与目标重复的条目过滤后 append（**去重键 = 整条 JSON 全等**；摘要哈希键、`getStoryProgressRange` 的 `seen` 去重都与此一致）。
- **对象合并**：已存在的 key 递归合并；新 key 需通过 `checkPath(path, template)` 校验——模板中存在该路径才接受（模板里 `{{...}}` 动态键允许任意子键），否则 warn 跳过。
- **角色设定保护**：路径含 `角色设定` 的字符串值，若 `allowUpdate=false`、值不含「未知」、且 key 不是 `处女` → 拒绝更新（不可变核心设定；`allowUpdate` 由 LLM 在 NEW_CHARACTER_CARD 顶层显式声明后删除该字段）。
- 合并后空字符串值 `delete`。

### 5.4 历程渲染（`renderJourneyMarkdown`）

- 按 `第X天` 分组升序。
- `maxDay`（当前天）与无法解析天数的条目 → 每条详细格式：`# 天数|时间段|地点\n## 历程`。
- 更早的天 → 聚合格式：按「天数+时间段+地点」合并连续条目（同组内字段全等才拼接，任意一项变化即新起一块）：`# 天数|时间段|地点\n## 组内历程拼接`（省 token）。
- 回退：`maxDay==0`（无天数可解析）全部详细格式。
- `extractItemProcess`：历程可能是数组或字符串；每条补中文句号。

---

## 6. RAG 检索器（retrieval.js）

- `NS.Retriever.isReady()` 恒为 true（纯 JS，无加载态）。
- **分词（`tokenize`）无词典**：
  - 中文连续段 → 单字（过滤 `Constants.STOP_UNI` 虚词：的了着在和与及或是等都就还又很太更最被把让向对从到为之其此该这那它我你他她吗吧啊呀嘛呢么）+ 全部 bigram（不过滤，保证短语片段可重叠）。
  - 英文/数字 → 整词小写，保留内部 `._-` 连接（如 `3.14`）。
- **BM25**：`k1=Constants.BM25_K1(1.5), b=Constants.BM25_B(0.75)`，`idf = log(1 + (N-d+0.5)/(d+0.5))`；每次调用对传入 docs 现建统计（远端条目集合每次生成都不同，**不缓存**）。
- `minScore=0` 表示取所有有词项命中的文档（`Constants.RAG_MIN_SCORE`）。
- 设计史：v2.2.0 用 bge embedding 余弦做 RAG → v2.3.0 发现 embedding 对中文短查询召回不稳，**整体换成 BM25** 并删除模型资产与 `ragToggle`（稀疏远期记忆默认开启，见 §16 版本表） → v2.5.0 混合召回把 embedding 以「摘要语义分量」的形式加回来（§7），v2.6.0 恢复模型资产。v2.9.0 引入 Mode A（§7.4）：`subSummaryToggle` 开启时**不再走 BM25 回退**——缺失摘要的条目直接排除，BM25 回退仅保留给 Mode B（二级摘要关闭）路径。

---

## 7. 混合召回打分（`scoreFarEntries` / `scoreFarEntriesModeA`）

- **Mode B**（`subSummaryToggle` 关）：走 §7.1-7.3 的 BM25 或 摘要单查询通道（与历史行为一致）。
- **Mode A**（`subSummaryToggle` 开）：走 §7.4 的分段加权 max，且不依赖 BM25。

### 7.1 摘要通道（条目有召回特化摘要 且 `NS.Embedder.isReady()`；Mode B 路径之一）

```
score = 0.25·S_actor + 0.15·S_location + 0.60·S_semantic
```

（权重常量为 `core/constant.js` 的 `Constants.SUMMARY_W_*`，各项附调整指导）

- **S_actor**（v2.13.0 起，原为 IDF 之和绝对饱和；v2.14.0 起移除主角排除）：**Dice 系数** `2|Q∩F|/(|Q|+|F|)`，天然 [0,1]。
  - `Q` = 从消歧名单 `nameList`（全部摘要人物 ∪ 已知角色名）中 `nameMatches(n, queryText, nameList)` 命中的已知人物集；`F` = 摘要 `actor` 去重集（主角不排除）。同一查询对池内所有条目共用同一个 `Q`，分数跨条目可比。
  - **设计决策**：放弃 IDF 稀有度加权（全部人物等权），换得查询侧/远端侧人数比的可比性——旧版 IDF 之和只反映 far 侧稀有度，查询提到一堆人时无法体现「对不上」；v2.13.0 曾引入主角排除（df 最高的前 `ACTOR_EXCLUDE_TOP` 名人物两侧剔除），v2.14.0 移除，纯主角查询同样有人物分。
- **S_location**：`location` 数组中 `queryText.includes(loc)` 的命中比例。
- **S_semantic**（v2.15.0 起，原为 0.20·S_event + 0.40·S_recall 两分量）：`max(S_event, S_recall)`，只取一份最大值入总分。
  - `S_event`：`cosine(queryVec, eventVec)`，clamp 到 [0,1]。
  - `S_recall`：`max(cosine(queryVec, recall_when[i]))`。
- 查询向量：`NS.Embedder.withQueryInstruction(queryText)`（BGE 官方指令前缀「为这个句子生成表示以用于检索相关文章：」，**文档侧不加**）。
- 文档侧向量：优先 `NS.EmbedStore.resolve(jobTexts)`（读持久化 store，缺失现场编码并回写）；store 模块缺失时直接 `encodeBatch`。
- `parts` 记录各分量明细（source/actor/location/actorScore/locationScore/semantic），UI 展示。

### 7.2 BM25 回退通道（无摘要条目 / Embedder 未就绪时全池）

- 无摘要条目池（Embedder 未就绪 = 全池）走 `Retriever.retrieve(queryText, docs, topK=池大小, minScore=0)`。
- 归一化：`score = bm25 / (bm25 + Constants.BM25_NORM_K)`，`BM25_NORM_K=4`，使两通道分数可比（都落在 [0,1)）。

### 7.3 buildSummaryMap

收集全部楼层 `extra` 中有效摘要，键 = `JSON.stringify(故事历程条目)`（与 deepMerge 去重键一致，合并后的 `farEntries` 可直接命中）。条目级 `hasRecallFields` 校验：旧 schema（`{摘要, 关键}`）摘要返回 false → 回退 BM25 通道（仅 Mode B 路径）。

### 7.4 Mode A 分段加权打分（`scoreFarEntriesModeA`）

`subSummaryToggle` 开启时启用；把查询切成多个**片段**，逐条远端条目取「各片段加权分」的最大值（max-pooling），使「用户提到某角色」与「窗口条目提到同一角色」两个信号都能独立触发召回。

- **片段（fragments）**：
  - `user` 片段：最新用户消息 `query`（权重 `FRAG_WEIGHT_USER=1.0`）。
  - `window` 片段：窗口各条目（最新→更旧），第 i 条（最新 i=0）权重 = `FRAG_WEIGHT_WIN_BASE(1.0) × FRAG_WEIGHT_WIN_DECAY(0.95)^i`；权重低于 `FRAG_WEIGHT_WIN_MIN(0.50)` 时停止，后续更旧条目不再参与打分（权重单调递减）。
  - 窗口为空时只保留 `user` 片段。
- **每片段对远端条目 computes 一个 fragScore**（与 §7.1 同公式）：`0.25·S_actor + 0.15·S_location + 0.60·S_semantic`。其中：
  - `S_actor`（与 §7.1 同 Dice 公式，主角不排除）：`user` 片段的 `Q` = 从全角色名单提取消息提及的人物集；`window` 片段的 `Q` = 窗口条目 actor 集；`F` = 远端条目 actor 集。匹配：`user` 片段按集合成员判定，`window` 片段**成对匹配**（任一 `(winActor, farActor)` 对 `nameMatches(winActor, farActor, nameList)` 命中即计 1）。
  - `S_location`：`user` 片段 `query.includes(loc)`；`window` 片段 **层级匹配** `isHierMatch`（如 `酒馆.二楼` ⊂ `酒馆.二楼.卡座`，按 `.` 分段前缀匹配）。
  - `S_semantic` = `max(S_event, S_recall)`，其中 `S_event` / `S_recall` = `clamp01(cosine(fragVec, docVec))`，`fragVec` 由 `Embedder.encodeBatch([withQueryInstruction(片段文本)])[0]` 得到。
- **最终分数**：`score = max_f(w_f · fragScore_f)`，并标注命中贡献最大的 `bestFrag`（`'user'` 或 `'fN'`，N=该窗口条目所在楼层号，楼层由首现归属映射得到；归属缺失时回退 `'wN'`=片段序号；UI 展示为「用户 / 楼层N / 窗口·第N」）。因窗口起点对齐楼层边界，`fN` 必对应整层在窗口内的楼层。
- **绝不 BM25**：Mode A 下缺失摘要的条目直接排除，不回退词法检索（设计决策：二级摘要开启即信任语义通道）。

---

## 8. Embedding 模块（embedding.js + embed-worker.js，v2.11.0 起 worker 架构）

- **推理在 WebWorker 中执行**：`embedding.js` 经 `new Worker(<baseUrl>core/embed-worker.js?v=VERSION, {type:'module'})` 启动 worker（`NS.baseUrl` 以 `/` 结尾，URL 带 `?v=` 缓存击穿），WASM 多线程推理不占主线程；worker 不可用（构造/onerror/超时）时**自动回退主线程**加载，接口与行为不变。
- worker 内动态 `import` 本地 `lib/transformers.min.js`（绝对 URL，transformers.js v3 ESM，内置 ORT Web 1.22 含 WebGPU EP）+ `lib/models/bge-small-zh-v1.5`（外部数据格式 onnx：`onnx/model.onnx` fp32 ~95MB 供 WebGPU，`onnx/model_quantized.onnx` q8 ~24MB 供 WASM）；协议消息：`init`（主→worker，附 env 配置 + `useWebgpu`）/`encode`（附 id+texts）/`result`/`encodeError`（按 id 配对）/`status`/`ready`（附 `backend: 'webgpu' | 'wasm'`）/`error`；pipeline 单例 + `initPromise` 防重入。
- **v3 加载要点**（历史坑，主线程回退路径同此）：v3 不支持把完整 URL 当 model_id → `env.remoteHost = <baseUrl>lib/models/`，`env.remotePathTemplate = '{model}/'`，model_id 用 repo 风格 `'bge-small-zh-v1.5'`。
- `env.useBrowserCache = false`、`allowLocalModels = false`；wasm 指向本地 `lib/ort/`（mjs+wasm），`numThreads = navigator.hardwareConcurrency`（worker 内由主线程经 init 消息传入配置）。
- pipeline: `feature-extraction`；编码：`pooling: 'mean', normalize: true`（BGE 用法）。
- **后端选择（v2.11.0，`Constants.EMBED_USE_WEBGPU`）**：开关开时先试 `createPipeline('feature-extraction', modelId, { dtype: 'fp32', device: 'webgpu' })`（加载 `onnx/model.onnx` fp32）；WebGPU 不可用（`device:'webgpu'` 抛 `Unsupported device`）或会话创建失败 → 捕获后回退 `dtype: 'q8'`（WASM，原行为）。worker 与主线程回退路径同一逻辑；实际后端经 `ready` 消息（worker）/返回值（主线程）记入 `getStatus().backend`，UI 状态行就绪文案追加「，WebGPU」标记。
- **为何 GPU 必须 fp32**：WebGPU EP 不支持 int8 量化 GEMM（MatMulInteger），q8 模型走 GPU 重计算仍落回 CPU 无加速意义；wasmPaths 仍须配置——WebGPU 会话中个别不支持的算子由 WASM CPU EP 兜底。
- **fp32/q8 向量混用无害**：两后端向量仅数值精度差异（均为 512 维 L2 归一化），余弦排序影响可忽略；embedstore 按文本哈希存向量且模型名不变，**后端切换不触发向量库重建**（避免 3095 条级重编码）。
- **批量输出形态（历史坑，v2.11.0 修复）**：v3 的 feature-extraction pipeline 对批量输入**不逐条拆分**，直接返回单个 Tensor（mean pooling 后 dims `[N, D]`）。因此调用时**始终传数组**（单条也传 `[text]`，保证输出 dims `[1, D]`），返回后经 `batchToVectors(output, count)` 按行 `subarray` 拆成 N 个独立 Float32Array（worker 与主线程回退路径同一实现）；拆后校验 `vectors.length === 输入条数`，不一致即抛错。旧版把整批 flatten 成单个 8192 维向量，embedstore 收到 `undefined` 后在 `vecToBase64` 抛 `Cannot read properties of undefined (reading 'buffer')`。
- **LRU 缓存** 2048 条（精确文本键，`encodeBatch` 主线程侧，worker 前拦截），`BATCH_SIZE=16` 批量推理。
- `encodeBatch(texts, {onProgress})`：每完成一批回调 `onProgress(done, total)`（done/total 为缓存未命中条数），供调用方刷新进度。
- 状态总线 `onStatus`（idle/loading/ready/error），模块加载即 `init()` 预热；失败置 `initPromise=null` 允许重试；`isReady()` 为纯状态检查。
- **降级链**：worker 失败 → 主线程加载；Embedder 未就绪 → 全池 BM25 归一化（等价纯 BM25 排序），功能不中断。

## 9. 向量持久化（embedstore.js，v2.8.0）

- 存储：`chat_metadata["chat-optimization-v2-embed"]`（per-chat），`saveMetadataDebounced` 落盘。
- 键 = 文本 FNV-1a 哈希（`NS.SubSummary.textHash`）→ **跨楼层去重、不受楼层下标漂移影响**。
- 序列化：Float32Array ↔ base64（8KB 分片 `String.fromCharCode` 防栈溢出）。
- `loadStore`：模型名不匹配 → 全量作废重建；逐条解码校验，损坏丢弃；**基准维度 = 优先 `raw.dims`（须与向量维度分布命中），否则按条数多数派**；维度不符的条目丢弃（视为缺失，由 sync 重新编码补齐）；全部不可用视为 reset。旧版「首条定基准」被单条 7680 维污染条目（旧批量 bug 把 15×512 flatten 成长向量写入；哈希键是数字字符串按升序迭代，污染条恰好排在最前）击溃 → 整库丢弃、每次刷新全量重算（v2.11.0 修复，污染库自动愈合）。
- `persistVectors` 写守卫（v2.11.0）：跳过 `undefined`/空向量与维度不符库基准的条目，防批量形状异常再次污染库。
- **完整性同步 `sync()`**：
  - 期望集合 = 全部楼层有效摘要的 `event` + 各 `recall_when`（trim 非空）文本。
  - 缺失 → `encodeBatch` 补齐并持久化；store 中不在期望集合的哈希 → 删除（摘要被擦除/哈希失效的残留）。
   - 触发时机：模块加载后 1s（`Constants.EMBED_SYNC_FIRST_DELAY_MS`）、`MESSAGE_RECEIVED`（`Constants.EMBED_SYNC_DEBOUNCE_MS` 防抖）、`CHAT_CHANGED`、SubSummary 生成批次结束（`done>0`）。`syncing` 互斥 + `syncQueued` 补跑一次。
   - 补齐阶段经 `encodeBatch` 的 `onProgress` 逐批广播 `补齐向量 done/total…`（v2.11.0）——大批量 CPU 推理可达数分钟，无进度时状态行看似卡死。
  - 前提：`subSummaryToggle` 开。
- **打分路径 `resolve(texts)`**：store 命中直接解码；缺失现场编码 + 回写；store 不可用降级为纯现场编码。

---

## 9.5 召回 LRU 缓存模块（recallcache.js，v2.9.0）

- **目的**：让「发送新用户信息」只重算与新片段相关的远端条目，而非每次全量重算——缓存按**内容哈希**寻址，过期条目自然失效，避免脏缓存。
- 三张 LRU（容量 `FRAG_VEC_CAP=4096` / `DOC_VEC_CAP=4096` / `PAIR_SCORE_CAP=262144`）：
  - `fragVec`：片段文本 → 向量（受 `Embedder.model` 校验，模型变了全清）。
  - `docVec`：键 = 条目 `JSON.stringify(entry)`；**摘要哈希**（`SubSummary.textHash(JSON.stringify([actor,location,event,recall_when]))`）存于槽位、读取时校验，摘要一变即 miss 重算。
  - `pairScore`：键 = `片段文本 + ' ' + 条目键`，双方摘要哈希存于槽位、读取时校验 → `{fragScore, parts}`；跨发送复用逐对分数。
- 接口：`getFragVec/setFragVec`、`getDocVecs/setDocVecs`、`getPair/setPair`、`summaryHash`、`clear`、`setModel`（模型变化清全部）、`onFill/setFilling/setFilled`（补漏气泡总线）、`warmup`、`init`。
- **后台预热 `warmup`**：解码所有楼层摘要向量（`EmbedStore.resolve`） + 编码最新用户消息片段 + 最近 `WARMUP_WINDOW_PREVIEW=16` 条事件片段；订阅 `MESSAGE_RECEIVED`(2s 防抖)/`GENERATION_ENDED`/`CHAT_CHANGED`/`Embedder.onStatus` 在空闲时预热。
- 调用方：`scoreFarEntriesModeA` 全程经缓存读写（命中则跳过 `Embedder.encodeBatch` 与余弦计算），UI 不参与。

---

## 10. 二级摘要模块（subsummary.js）

### 10.1 配置

`isConfigured()` 两种连接方式（`subSummarySource`）：

- **fetch**（默认）：`subSummaryBaseUrl` + `subSummaryApiKey` + `subSummaryModel` 三项非空。浏览器直连 OpenAI 兼容接口（需对方允许 CORS）。
- **profile**：`subSummaryProfileId` 指向 SillyTavern Connection Manager 的 **CC 类型** profile（`mode==='cc'` 且 url/model 齐全；secret-id 可缺省，服务端回退主 API Key）。走 `ConnectionManagerRequestService.sendRequest(profileId, messages, maxTokens, {stream:false, signal:null, extractData:true, includePreset:false, includeInstruct:false, instructSettings:{}}, {temperature})`——**API Key 由服务端解密，不经过浏览器**（比 fetch 模式更安全）。

### 10.2 单条生成（`runOne`）

1. `isConfigured()` 否则抛错（UI 状态行提示去配置）。
2. 取楼层 story block（复用 `Engine.getFloorStoryBlock`）→ `journey[entryIndex]`。
3. 非 force 且该楼层 extra 有效且该下标已有 `s` → 返回 `'skip'`。
4. 模板校验：`subSummaryPrompt` 非空且含占位符 `{{故事历程}}`（**纯文本模板，不是 JSON**，不复用 `Engine.validateTemplate`）。
5. 占位符替换 = 条目**完整 JSON**（`split(PLACEHOLDER).join(...)` 防 `$` 模式）。
6. 调 LLM → `extractJson`（取第一个 `{...}`，兼容 code fence）→ `normalizeSummary` 规范化为 `{actor, location, event, recall_when}`（字符串自动包数组、去空去重；**全字段空视为失败**）。
7. 写 `item.extra["chat-optimization-v2"] = {storyHash, summaries}`（summaries 全量写回保持下标对齐）→ `saveChatDebounced()`。

### 10.3 重试与批量

- `runOneWithRetry`：失败等 1s 重试，最多 3 次（`RETRY_DELAY_MS`/`MAX_RETRIES`），全失败抛最后错误。
- `executeBatch`：串行（按楼层序、条目序），统一维护状态总线；模块级 `running` 互斥，进行中再次触发直接忽略（自动/手动互斥）。
- 状态总线 `onStatus/getStatus`：`{running, current:"第k/N条·楼层x 条目y", done, failed, error, message, lastDone}`，快照广播（模式同 Engine.onStats）。
- **状态通知节流（v2.11.0）**：`executeBatch` 内广播走 trailing throttle（`SUBSUMMARY_STATUS_NOTIFY_INTERVAL_MS=300ms`），合并期间最后一次进度；批次结束（`finally`）立即广播终态。成功条目附 `lastDone: {floor, index}`，供 UI 单条目增量更新；`generateForEntry`/`generateForRange`/`eraseForRange` 的即时通知同样带 `lastDone`。
- **解析缓存（v2.11.0）**：楼层 story block 解析结果按楼层缓存（`Engine.storyBlockCache`，`STORY_PARSE_CACHE_MAX=4096`，键含 mes/swipeText 引用校验，超限全清）；摘要哈希按 (楼层, 历程) 缓存（`SubSummary.storyHashCache`）。生成路径反复取同一楼层时不再重复正则解析。

### 10.4 触发方式

- **自动**：`GENERATION_ENDED` 事件（经 bridge 的 ST EventEmitter，**不是** CustomEvent）→ 条件 `subSummaryToggle && isConfigured` → 最后一条 assistant 楼层中缺失的条目走 `ensureRecallSummaries(lastFloor, lastFloor)`（复用 §10.6 的发送前补生成 API，与手动/Mode A 路径统一）。天然覆盖「楼层重新生成 → 哈希失效 → 清空 → 重新生成」闭环。
- **手动**（不受 `subSummaryToggle` 限制，只受 `isConfigured()`）：
  - `generateForEntry(floor, index, {force})` — 单条/重新生成
  - `generateForRange(start, end, {force, onlyMissing})` — 范围生成（null 边界 = 全部楼层）
  - `eraseForRange(start, end)` — 强制擦除 extra（UI 要求输入口令「确认全部擦除」）

### 10.6 发送前补生成 API（v2.9.0，供 Mode A 调用）

- `getRecallMissingCount(startFloor, endFloor)`：遍历楼层区间内每条历程，返回「无摘要 / 旧 schema / 摘要未含 `recall_when`」的条目数（依赖 `hasRecallFields`）。
- `ensureRecallSummaries(startFloor, endFloor)`：收集缺失目标（`collectRecallMissingTargets`）→ 经 `batchChain` 串行 `executeBatch` 补齐，返回 `{done, failed}`。应由 `buildPromptData` 在 Mode A 打分前 `await withTimeout(..., SUBSUMMARY_WAIT_TIMEOUT_MS)` 调用。
- `onGenerationEnded` 自动补生成已重构为复用 `ensureRecallSummaries(lastFloor, lastFloor)`，与手动/自动路径统一。

### 10.5 默认摘要模板

要求 LLM 输出召回特化 JSON：`actor`（角色名非代词）、`location`（层级从大到小）、`event`（谁在哪做了什么结果如何）、`recall_when`（2~4 条未来触发条件，不复述 event）。该 schema 是混合召回的数据来源——**模板改动会直接影响召回质量**，属产品数据。

---

## 11. UI（ui/coo-window.js）

### 11.1 结构

- 入口：wand 扩展菜单（`#extensionsMenu`）顶部插入菜单项「剧情角色档案」；`#extensionsMenu` 不存在时回退插入 `#top-settings-holder` 顶部；DOM 未就绪时 500ms 间隔重试最多 30 次，并监听 `#extensionsMenuButton` 点击后重挂。
- 浮动窗口（`#coo-root > .coo-shell`）：顶栏（标题+版本+关闭）+ 左侧栏（tab 导航 + 底部运行状态：失败楼层/Token 数）+ 工作区。侧边栏可折叠（localStorage `coo_sidebar_collapsed`）。
- **6 个 tab**（`TABS`）：`settings` 基础设置 / `subsummary` 二级摘要 / `templates` 模板 / `roles` 角色查看 / `story` 故事历程 / `preview` 发送预览。激活 tab 记 localStorage `coo_active_tab`。
- **DOM 全部 `createElement` 构建，无 HTML 字符串、无 jQuery**（硬约束）。
- 事件全委托到 workspace：`input`（按 `data-coo-field` switch 分发到 `Settings.set`）、`change`（roleSelect）、`click`（按 `data-coo-action` / `data-coo-reset` 分发）。Esc 关窗。
- **布局与响应式**：workspace `overflow-y: auto`（内容高于窗口即滚动）；`.coo-tab-panel > .coo-section` 为 `flex: 1 0 auto`（永不压缩低于内容高）；模板 textarea 块 `.coo-template-block` 为 `flex: 1 1 auto`——**basis 必须是内容高**（v2.11.0 修复：旧值 `flex: 1 1 0` + `min-height: 0` 在窗口矮、section 无剩余空间时把块塌缩到 0px，内部 textarea（min-height 96px）溢出绘制到下方状态行/按钮上；二级摘要/模板 tab 均受影响）；高窗口时块按 `createTemplateBlock` 的 `flexGrow` 内联参数分配剩余空间撑满。`.coo-subsummary-actions` `flex-wrap: wrap`（窄窗换行）；`@media (max-width: 760px)` 侧栏缩为 56px 纯图标栏、窗口全屏、行内输入框缩窄。

### 11.2 各 tab 要点

- **基础设置**：extensionToggle / roleCardToggle / keepCount / tokenLimit / ragRatio（slider 0.1–0.9）。
- **二级摘要**：开关、连接方式 select（fetch/profile 互斥禁用对应输入区）、profile 下拉（`getProfileOptions` 过滤 CC 类型）、baseUrl/apiKey/password/model/temperature/maxTokens、摘要模板 textarea（徽章校验 = 含 `{{故事历程}}`）、状态行 ×3（生成状态 / Embedder 状态 / 向量持久化状态）、按钮：生成所有缺失（onlyMissing）/ 强制生成全部（force）/ 强制擦除全部（口令确认弹层）。
  - profile 下拉监听 `CONNECTION_PROFILE_LOADED/CREATED/UPDATED/DELETED` 事件刷新；已保存 id 失效时自动清空设置。
- **模板**：historyPrompt / characterPrompt textarea + JSON 有效性徽章 + 重置按钮（回 `Settings.defaultSettings`）。
- **角色查看**：角色下拉（活跃角色标 `<活跃角色>`）+ `buildRoleTree` 递归树渲染。
- **故事历程**：楼层范围查询（起始/结束，空=全部）；单列表渲染每条历程：楼层号 + 天数|时间段|地点 + 历程正文 + 二级摘要块（有效→结构化展示 人物/地点/事件/触发 +「重新生成」；无效→「生成摘要」按钮）；**RAG 命中/未命中标记内联**在所有远端（far）条目上（v2.12.0：`farMap` 以 `Engine.entryToDocText(entry)` 为键反查 `stats.rag.farScores`，未命中/被排除条目同样显示；旧格式 stats 降级为仅标记 `rag.hits`）+ 分数明细徽章（`RAG命中/未命中（片段来源） 人x/y(分) 地x/y(分) 事0.xx 忆0.xx → 总分` 或 `BM25 0.xx` 或 `（无二级摘要）`，Mode A 的片段来源即 bestFrag：「用户 / 楼层N / 窗口·第N」（楼层N 必为整层在窗口内的楼层）；命中条目卡片高亮（`.coo-story-item-hit`）；「仅显示选中楼层」复选框过滤到命中条目；「生成全部摘要」按钮（当前范围）。
- **发送预览**：`Engine.getStats().lastMessage` 原文 `<pre>` 展示。

### 11.2.1 补漏气泡（v2.9.0）

- Mode A 发送前若需补生成缺失摘要，`recallcache.js` 经 `onFill(status)` 总线广播 `{filling, count}` / `{filled}`；`coo-window.js` 订阅后在右下角浮动 `#coo-fill-bubble`（`.coo-fill-bubble`，`coo.css` 新增样式）显示「正在补漏 N 个二级摘要…」，完成后淡出。仅 `subSummaryToggle` 开且确有缺失时弹出。

### 11.2.2 解析失败气泡（v2.10.2，v2.11.1 检查时机改为消息事件驱动）

- 检查时机：`engine.js` 订阅 ST 消息事件——`MESSAGE_RECEIVED`（回复到达）/`MESSAGE_EDITED`/`MESSAGE_UPDATED`（消息修改）/`MESSAGE_SWIPED`（切 swipe）触发 `checkParseFailures()`；`MESSAGE_DELETED`/`CHAT_CHANGED`/`CHAT_LOADED` 触发**静默重建基线**（`silent` 模式：只更新 `lastStats.failedFloors` 不广播、不通知 UI，避免楼层下标错位导致误报/漏报）。不在生成拦截器（发送时）检查——发送时最新回复尚未到达，检查必然滞后一轮。
- `checkParseFailures` 深拷贝当前 chat 走 `mergeDataInfo`（与生成同一解析逻辑），对**新出现**的失败楼层（相对上次基线）经 `onParseFail(details)` 总线广播 `[{index, reasons}]`（engine 不碰 DOM，模式同 onStats/onFill）；基线变化时同步 `notifyStats({failedFloors})` 刷新 UI 失败楼层显示（silent 模式除外）。
- `coo-window.js` 订阅后在右下角浮动 `#coo-parsefail-bubble`（`.coo-parsefail-bubble`，红色，位于补漏气泡上方）显示「NEW_STORY_DATA 解析失败（楼层X：原因；…」，`Constants.PARSE_FAIL_BUBBLE_TIMEOUT_MS`（默认 8s）后自动隐藏；已入基线的失败楼层不重复弹出，修复后再损坏会重新提示。

### 11.3 刷新链路

- 打开/切换窗口 → `Engine.refreshStats()`（只读深拷贝 + 完整装配，**不改 ST chat**）→ `notifyStats` → `onStatsChanged` → `refreshActiveTabData`（stats 值、RAG 信息行、预览文本，**不再重绘 story 列表**——story 数据由下方增量链路维护）。
- `SubSummary.onStatus`（v2.11.0 增量更新）→ 仅刷新状态行文本；`lastDone` 非空时 `updateStoryEntrySummary` **单条目原地替换**（重建该条目 DOM，保留 `data-coo-*` 委托属性，点击仍有效）；`running === false` 时全量重绘一次 story 列表。避免每条摘要完成都整表重绘。
- `Embedder.onStatus` / `EmbedStore.onStatus` → 对应状态行。
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
| `ragRatio` | 0.3 | 稀疏远期记忆预算 = tokenLimit × ragRatio |
| `historyPrompt` | （中文 JSON 模板） | NEW_HISTORY 模板，产品数据 |
| `characterPrompt` | （中文 JSON 模板） | NEW_CHARACTER_CARD 模板，产品数据 |
| `subSummaryToggle` | true | 二级摘要自动生成开关（手动生成不受限） |
| `subSummarySource` | 'fetch' | 'fetch' / 'profile' |
| `subSummaryBaseUrl` / `ApiKey` / `Model` | '' | fetch 模式三项 |
| `subSummaryProfileId` | '' | profile 模式 |
| `subSummaryTemperature` | 0.3 | 非法值回退默认 |
| `subSummaryMaxTokens` | 512 | 非法值回退默认 |
| `subSummaryPrompt` | （召回特化模板） | 纯文本模板，占位符 `{{故事历程}}` |

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
| 正文 verbatim + 历程分层 | 近期对话必须原文（语气/细节），远期用结构化历程压缩；RAG 再捞回相关远期条目 |
| 二分搜索窗口而非线性裁剪 | markdown 聚合渲染使成本非线性，二分保证找到预算内最大窗口 |
| 单条装箱按「详细格式」计费 | 最坏成本估计，避免混入聚合天分组后超预算 |
| BM25 中文 unigram+bigram 无词典分词 | 无词典依赖；bigram 保短语重叠；停用词只滤单字保 bigram |
| 召回分数双通道归一到 [0,1)（Mode B） | 摘要语义分与 BM25 回退分可比，可混排；Mode A 仅语义通道，无 BM25 |
| actor 分用 Dice（v2.13.0，v2.14.0 移除主角排除） | Dice = 查询侧/远端侧命中人数比，同一查询对所有条目用同一个 Q，跨条目可比（v2.13.0 前为 IDF 绝对饱和）；v2.13.0 曾两侧剔除 df 最高者（主角），v2.14.0 移除，主角正常参与人物打分 |
| 楼层级 FNV 哈希失效（非逐条） | 楼层 story block 是整体重写的（重新生成/编辑/swipe），逐条哈希无意义；整层清空最简单正确 |
| 摘要存 `extra`、向量存 `chat_metadata` | extra per-消息随 chat 走；metadata per-chat 存跨消息的派生物（向量按文本哈希跨楼层去重） |
| 向量库基准维度 = `raw.dims` 优先 / 多数派（v2.11.0） | 旧批量 bug 曾把整批 flatten 的 7680 维长向量写入库（15×512）；「首条定基准」+ 数字哈希键升序迭代 → 单条污染条目令整库丢弃、每次刷新全量重算；多数派 + `raw.dims` 使污染库自愈（污染条目按缺失重编码），`persistVectors` 维度守卫防再发 |
| 摘要生成串行 + 模块级 running 互斥 | LLM 限流友好；自动/手动互斥避免 extra 写竞争 |
| 二级摘要手动生成不受总开关限制 | 开关只表达「自动行为」意愿（用户确认的决策） |
| 摘要 schema 含 `recall_when` | 面向召回而非阅读：「未来何时想起」比事件复述更有检索区分度 |
| Mode A 分段加权 max（v2.9.0） | 用户片段 + 各窗口条目片段独立计分后取 max → 任一信号（用户提角色 / 上下文提角色）都可触发召回，且天然按重要性加权（用户 1.0 > 最新窗口 0.90 > 次新 0.85 > 其他 0.80） |
| Mode A 绝不 BM25 回退 | 二级摘要开启即信任结构化语义通道；未配置连接的缺失条目直接排除，不让词法检索污染语义排序 |
| 发送前补生成（`ensureRecallSummaries` + 30s 超时） | 二级摘要开启时，缺失摘要先补齐再打分；超时降级为「缺哪些排除哪些」并 warn，不让一次补漏阻塞整次生成 |
| 召回 LRU 内容寻址缓存（v2.9.0） | fragVec/docVec/pairScore 按内容哈希寻址，新发送只重算新相关远端条目；摘要一变即 miss，无脏缓存；模型切换全清 |
| 装箱按估算 1.5 字符/token + 精确计数剪枝 | 估算优先保速度（`getTokenCountAsync` 调用重，尽量少调）；精确计数**无次数上限**地从最低分剔除至 ≤ ragBudget（v2.9.2：估算对中文偏乐观，旧版 3+1 次上限导致召回段超预算、最终 tokenCount 超限） |
| 正文超 midBudget 时从最旧整条 assistant 消息丢弃（v2.9.2） | 单条超长回复会让 正文+角色卡 超 midBudget，旧版无上限直接溢出 tokenLimit；丢整条而非截断文本，且其历程条目回归中段不丢失 |
| fetch 与 profile 双连接方式 | fetch 简单但 Key 过浏览器+CORS 风险；profile 走 ST 服务端解密更安全（UI 文案已注明） |
| Embedder 失败全链降级 | embedding 是增强项，BM25 兜底保证核心功能不中断 |
| embedding 推理移入 WebWorker（v2.11.0） | WASM 多线程推理在主线程会阻塞 UI（生成二级摘要时界面卡死无响应）；worker 独立线程消除阻塞，worker 不可用（老浏览器/file:// 限制）自动回退主线程，最终渲染结果不变 |
| WebGPU fp32 优先 + q8/WASM 回退（v2.11.0） | WASM CPU 推理大批量补齐可达数分钟；WebGPU 下 GEMM 上 GPU 可降到秒级。WebGPU EP 不支持 int8 GEMM → GPU 路径必须 fp32（捆绑 95MB model.onnx）；`device:'webgpu'` 在不支持的浏览器直接抛错 → try/catch 回退 q8/WASM 与降级链一致；`EMBED_USE_WEBGPU` 可整体关闭 |
| 二级摘要状态节流 + lastDone 增量更新（v2.11.0） | 每条摘要完成都整表重绘 story 列表造成卡顿；300ms trailing throttle + 单条目原地替换（保留事件委托属性）+ 终态全量重绘一次，渲染结果与旧版一致 |
| 楼层解析/摘要哈希缓存（v2.11.0） | 生成批次反复取同一楼层 story block，正则解析成本随楼层长度放大；缓存键含引用校验，楼层重写即失效，无脏缓存 |
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
7. `deepMerge` 去重键、`getStoryProgressRange` seen 键、`buildSummaryMap` 键、摘要哈希输入都依赖 `JSON.stringify` 全等——**改历程条目字段名/顺序会连锁影响去重与摘要命中**。
8. `wordMapping` 作用于前文与角色卡 JSON，是内容合规策略，不是 bug。
9. `isFirstMessage` 判定依赖 `chat.length==2` 的严格形态，勿在拦截器里提前改动 chat 长度。
10. `lib/` 下模型/wasm 是大二进制资产，git 提交时注意仓库体积（历史上曾因换方案删除又恢复过，见 git log）。
11. 验证方式：从 SillyTavern 父目录启动，浏览器控制台看 `[Chat History Optimization]` 日志；或跑 Node 冒烟测试（§15）。
12. `Settings.set` 已含 `saveSettingsDebounced`，不要在调用方再手动存。
13. 状态总线模式统一为 `notifyXxx(patch) → 快照深拷贝 → 逐个 listener try/catch`、`onXxx(listener) → unsubscribe`。新增模块照抄。

---

## 15. 测试

### 15.1 冒烟测试

```
node test/smoke-hybrid-recall.cjs
```

- mock `window/document/navigator` + `NS.bridge`（假 `getTokenCountAsync` = 长度/1 且计数 `tokenCallCount`，最小事件总线 `eventSource` + `fireEvent` 触发器——engine.js 依此订阅 `MESSAGE_RECEIVED` 等消息事件），用 `(0,eval)` 按加载序注入 `settings/engine/subsummary/retrieval` 四个模块（**不加载 embedding/embedstore**——Node 无模型；`scoreFarEntries` 对缺失 `NS.EmbedStore` 有回退路径）。
- 额外 mock：`NS.RecallCache`（内存、内容寻址忠实实现，验证 LRU 跨发送复用）、`Retriever.retrieve` 间谍（验证 Mode A 不调用 BM25）、`encodeBatch` 计数（验证缓存命中后不再编码）、`Engine.onParseFail` 订阅间谍（验证解析失败气泡广播）。
- 构造 4 楼层 × 2 条目假聊天（含 6 条新 schema 摘要、1 条旧 schema、1 条无摘要），跑 9 个场景：
  - **A**（Mode B，Embedder 就绪，稀有角色查询）：chat 压成 1 条、RAG 激活、最优命中是目标条目、走 summary 通道、actor 1/2 且 actorScore=1（Dice 满分）、地点 2/2、分数 ∈ [0,1]、`farScores` 覆盖全部远端条目（条数=farCount、命中数=hits 数、每条有明细、存在未命中条目）。
  - **C**（Mode B，主角不排除）：只提高频主角时主角正常参与打分 → 纯主角条目 actorScore = 1 且人物 1/1，actor 不含主角的条目人物分 = 0，与稀有角色同条目的主角贡献人物分 > 0（Dice 2·1/(1+2)）。
  - **B**（Mode B，Embedder 未就绪）：全池走 bm25 通道、分数 ∈ [0,1)。
  - **A'**（Mode A，全部有摘要）：RAG 激活、全部 summary 通道、**绝不调用 `Retriever.retrieve`**、有 `bestFrag` 标记、最优命中是陈九仓库条目、`farScores` 全部条目有 `bestFrag` 且未命中条目同样有明细。
  - **H**（Mode A + 非空窗口，tokenLimit 放大）：RAG 激活、窗口/远端非空、**窗口起点对齐楼层边界**（测试数据对齐后窗口=楼层3+5 共 4 条、远端=楼层1 共 2 条）、全部 `farScores` 的 `bestFrag` ∈ `user/f3/f5`（楼层 1 整体在远端，不得出现 `f1` 或 `wN` 回退）。
  - **D**（Mode A + LRU）：同内容连续两次装配，第二次 `encodeBatch` 计数 = 0（缓存命中）。
  - **E**（Mode A + 装箱剪枝）：精确计数（假 1 字符/token，比估算乐观）触发 `getTokenCountAsync` 多次且命中数 < 远端条目数。
  - **F**（Mode A + 发送前补生成）：e7 旧 schema + e8 无摘要 → 缺失 >0；`ensureRecallSummaries` 被调用 1 次且补后缺失归 0；全部走 summary 通道。
  - **G**（解析失败气泡总线，事件驱动）：某楼层 NEW_STORY_DATA 块 JSON 损坏 → `MESSAGE_RECEIVED` 事件触发引擎检查，经 `onParseFail` 广播该楼层与原因；同内容再次到达不重复广播（历史失败不触发）。
  - **G2**（编辑修复/再损坏）：修复楼层后 `MESSAGE_EDITED` 不再广播且失败基线清空；再次损坏则重新广播（修复后重新损坏可再提示）。
- 改召回打分/装配/缓存逻辑后**必须跑此测试**；新增场景往 `runCase` + `check` 里加。

### 15.2 浏览器手工验证清单

1. wand 菜单出现「剧情角色档案」，打开窗口 6 个 tab 正常，控制台无红错。
2. 开 `extensionToggle`，正常聊天 → 控制台看 `全量 X tokens…RAG 将启用/不启用`、`Final last message`；发送预览与之一致。
3. 超预算 → RAG 激活，故事历程 tab **全部远端条目**出现 RAG命中/未命中徽章 + 分数明细（`人x/y(分) 地x/y(分) 事 忆 → 总分`，Mode A 附 bestFrag 片段来源）；命中条目卡片高亮；「仅显示选中楼层」过滤正确。
4. 配置二级摘要（fetch 或 profile），发消息 → 最后楼层自动生成摘要并落盘（刷新仍在）；手动 生成所有缺失/强制生成/擦除（口令）行为正确。
5. 重新生成某楼层 → 该层摘要清空并自动重新生成；向量 store 对应清理（二级摘要 tab 持久化状态行）。
6. Embedder 加载失败（断网/模型损坏）→ 召回降级纯 BM25，功能不中断，状态行报错。
7. 配置不允许 CORS 的 API → 状态行 + console 明确报错，extra 不被污染。
8. （v2.11.0）生成二级摘要时页面保持可交互（推理在 WebWorker，DevTools → Workers 可见 `embed-worker.js`）；批量生成期间 story tab 条目逐条原地更新、状态行 300ms 节流刷新，批次结束后列表完整重绘；worker 不可用时自动回退主线程（状态行仍走 loading/ready）。
9. （v2.11.0）WebGPU 加速：Chrome/Edge 打开 `chrome://gpu` 确认 WebGPU 可用后，二级摘要 tab 状态行显示「召回嵌入模型：就绪（bge-small-zh 本地，WebGPU）」，加载阶段显示「加载模型 bge-small-zh-v1.5（WebGPU fp32）…」；大批量补齐向量明显快于 WASM；无 WebGPU 的环境状态行无「，WebGPU」标记且加载阶段显示「（WASM q8）」；`Constants.EMBED_USE_WEBGPU=false` 时始终走 WASM q8。
10. （v2.11.0）矮窗口/窄窗口响应式：把浏览器窗口高度压到 600px 左右打开二级摘要/模板 tab → 模板 textarea 保持内容高度、不与下方状态行/按钮重叠，超出部分经 workspace 滚动条访问；窗口宽度 <760px 时侧栏为纯图标栏、操作按钮自动换行不溢出。
11. （v2.11.1）解析失败气泡时机：让某次回复的 `<NEW_STORY_DATA>` JSON 损坏 → **回复到达即**弹出红色气泡（无需再发一条消息）；手动编辑修复该楼层后气泡不再出现、侧栏失败楼层消失；再次编辑弄坏 → 重新弹出；删除消息/切换聊天不产生误报气泡。

---

## 16. 版本演进（git log 摘要）

| 版本 | 内容 |
|---|---|
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
- **改召回策略**：可调常数全部在 `core/constant.js`（`NS.Constants`，每项附调整指导）；打分在 `scoreFarEntries` / `scoreFarEntriesModeA`；装箱在 `buildPromptData` 的 RAG 路径；改完跑冒烟测试。
- **改摘要 schema**：`subSummaryPrompt` 默认模板 + `normalizeSummary` + `hasRecallFields` + UI `appendSummaryContent` + 打分分量，四处联动；旧摘要经 `hasRecallFields` 自动回退 BM25，无需迁移。
- **新增模块依赖 ST 内部**：index.js import → bridge 追加 → 模块内 `NS.bridge.xxx`。
- **发布**：bump `index.js` VERSION 与 `manifest.json` version（同步）→ 提交（本仓库）→ 用户侧强刷（`?v=` 缓存击穿自动生效）。

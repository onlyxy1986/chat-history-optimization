# Chat History Optimization (chat-optimization-v2) — 完整流程交接文档

> 版本：v2.10.0（2026-08-29）
> 仓库：本目录是独立 git 仓库（嵌套在 SillyTavern 安装目录内），在此提交，不要提交到父仓库。
> 无 package.json、无构建、无 lint。功能模块为浏览器端普通脚本。

---

## 1. 插件做什么

这是一个 SillyTavern 第三方扩展（UI 名「剧情角色档案」），核心目标是**控制长对话发送给 LLM 的 token 量**，同时保持剧情上下文完整：

1. **结构化剧情协议**：要求 AI 每次回复末尾输出 `<NEW_STORY_DATA>` 块（含 `NEW_HISTORY` 故事历程 JSON、可选 `NEW_CHARACTER_CARD` 角色卡 JSON）。插件把全部楼层的这些块解析、合并、去重，形成全局「故事历程」数组和「角色卡」映射。
2. **分层注入**：把最终 prompt 装配为三层——`RAG 远端召回段 + 中段历程窗口 + 正文 verbatim 尾部`，在 `tokenLimit` 预算内最大化保留上下文；超预算时用检索从远期条目中挑回相关条目。
3. **角色卡管理**：槽位上限淘汰 + 蒸馏（久未出场角色只保留核心设定），阈值见 `core/constant.js`。
4. **二级摘要（recall-specialized sub-summary）**：对每条历程条目调用 LLM 生成 `{actor, location, event, recall_when}` 结构化摘要，持久化在楼层消息 `extra` 中，既供 UI 浏览，也作为混合召回的语义信号。
5. **混合召回（v2.5.0+）**：BM25 词法检索 + 本地 ONNX embedding（bge-small-zh-v1.5, transformers.js）语义打分，向量持久化在 `chat_metadata`。
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
│   ├── embedding.js           # 本地 embedding（transformers.js + 本地 ONNX 模型）
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
   **新增模块文件必须加入此数组**，否则不加载。
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
| `embedding.js` | `init()` 立即预热加载 transformers + ONNX 模型（异步，失败可重试） |
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
 ├─ notifyStats(...)                                # 广播统计给 UI
 └─ chat.length = 0; chat.push(chat[原最后一条])     # 原地替换为单条消息
```

UI 的「发送预览」与窗口打开时的 `Engine.refreshStats()` 走**同一个 `assembleFinalPrompt`**（`runRag: true`），保证预览 = 实际将发送的内容。

### 5.2 buildPromptData 逐步骤

1. **模板解析**：`parseTemplate(historyPrompt)`；`roleCardToggle` 开时还需 `parseTemplate(characterPrompt)`。解析失败仅 console.error，不中断（生成可能异常，UI 模板 tab 有有效性徽章）。
2. **mergeDataInfo**：遍历楼层 1..n 的 assistant 消息，提取每层 `NEW_HISTORY`/`NEW_CHARACTER_CARD`，用 `deepMerge` 累积成全局 `historyData`（含 `故事历程` 数组）与 `characterData`（角色名→角色卡）。同时：
   - 每层写入 `item.messageCount = historyObj.故事历程.length`（该层贡献的历程条数，供正文覆盖计算）；
   - 任何一层缺块/解析失败 → `failedFloors.push(j)`。
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
    - `farEntries = midEntries` 前段（窗口外）；`query = 最后一条消息（用户消息）mes`。
    - **Mode A（`useModeA`）**：发送前先补齐缺失二级摘要——`SubSummary.getRecallMissingCount(1, lastFloor) > 0` 且 `isConfigured()` 则 `await withTimeout(SubSummary.ensureRecallSummaries(1, lastFloor), SUBSUMMARY_WAIT_TIMEOUT_MS)`（超时 30s，见 §10.6）；未配置连接则 warning 并跳过缺失条目（**绝不 BM25 回退**）。打分走 `scoreFarEntriesModeA`（见 §7.4）。
    - **Mode B（`!useModeA`）**：`queryText = query + 窗口各条目 docText`（`entryToDocText`），打分走 `scoreFarEntries`（见 §7.1-7.3）。
    - **贪心装箱**：按分数降序遍历，单条**估算**成本 = 该条目**详细格式** markdown 长度 / `EST_CHARS_PER_TOKEN`(1.5)（即最大成本估计）；重复文本去重（`packedSet`）；停止条件：预算满 / 全部唯一条目装完 / 已见最小条目也装不下。装入的按**原始时间顺序**重排。
    - **精确计数剪枝**：`ragMarkdown` 渲染后做 `getTokenCountAsync` 精确计数；若精确 token 超预算，从**最低分**逐条剔除后再渲染，**直至 ≤ ragBudget（v2.9.2 起无次数上限**——估算 1 token≈1.5 汉字对中文偏乐观，旧版 3+1 次上限会漏剔，召回段可超预算数千 token）。
    - `ragMarkdown = renderJourneyMarkdown(装入条目, midMaxDay)`；`rag.hits` 记录每条命中的 text/score/parts（UI 用 `entryToDocText` 反查标记）。
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
- 更早的天 → 聚合格式：`# 第X天\n## 当日所有历程拼接`（省 token）。
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
score = 0.30·S_actor + 0.15·S_location + 0.20·S_event + 0.35·S_recall
```

（权重常量为 `core/constant.js` 的 `Constants.SUMMARY_W_*`，各项附调整指导）

- **S_actor**：摘要 `actor` 中 `nameMatches(a, queryText, nameList)` 命中的人物的 **IDF 之和**，除以 `Constants.ACTOR_IDF_SATURATION(1.0)` 截断到 1。
  - `idf(a) = log(1 + (N - d + 0.5)/(d + 0.5))`，`d` = 该人物出现的摘要条目数。
  - **设计决策**：绝对饱和而非条目内归一 → 只命中高频主角（几乎每条都在场，idf 低）的条目拿不满人物分，稀有角色命中才能饱和。测试 `smoke-hybrid-recall.cjs` 场景 C 专门验证此点。
  - `nameList` 消歧名单 = 全部摘要人物 ∪ 已知角色名。
- **S_location**：`location` 数组中 `queryText.includes(loc)` 的命中比例。
- **S_event**：`cosine(queryVec, eventVec)`，clamp 到 [0,1]。
- **S_recall**：`max(cosine(queryVec, recall_when[i]))`。
- 查询向量：`NS.Embedder.withQueryInstruction(queryText)`（BGE 官方指令前缀「为这个句子生成表示以用于检索相关文章：」，**文档侧不加**）。
- 文档侧向量：优先 `NS.EmbedStore.resolve(jobTexts)`（读持久化 store，缺失现场编码并回写）；store 模块缺失时直接 `encodeBatch`。
- `parts` 记录各分量明细（source/actor/location/actorScore/locationScore/event/recall），UI 展示。

### 7.2 BM25 回退通道（无摘要条目 / Embedder 未就绪时全池）

- 无摘要条目池（Embedder 未就绪 = 全池）走 `Retriever.retrieve(queryText, docs, topK=池大小, minScore=0)`。
- 归一化：`score = bm25 / (bm25 + Constants.BM25_NORM_K)`，`BM25_NORM_K=4`，使两通道分数可比（都落在 [0,1)）。

### 7.3 buildSummaryMap

收集全部楼层 `extra` 中有效摘要，键 = `JSON.stringify(故事历程条目)`（与 deepMerge 去重键一致，合并后的 `farEntries` 可直接命中）。条目级 `hasRecallFields` 校验：旧 schema（`{摘要, 关键}`）摘要返回 false → 回退 BM25 通道（仅 Mode B 路径）。

### 7.4 Mode A 分段加权打分（`scoreFarEntriesModeA`）

`subSummaryToggle` 开启时启用；把查询切成多个**片段**，逐条远端条目取「各片段加权分」的最大值（max-pooling），使「用户提到某角色」与「窗口条目提到同一角色」两个信号都能独立触发召回。

- **片段（fragments）**：
  - `user` 片段：最新用户消息 `query`（权重 `FRAG_WEIGHT_USER=1.0`）。
  - `winNew` 片段：窗口中最新的 1 条（权重 `FRAG_WEIGHT_WIN_NEW=0.95`）。
  - `winNext` 片段：窗口倒数第 2 条（权重 `FRAG_WEIGHT_WIN_NEXT=0.90`）。
  - `winOther` 片段：窗口其余条目（权重 `FRAG_WEIGHT_WIN_OTHER=0.80`）。
  - 窗口为空时只保留 `user` 片段。
- **每片段对远端条目 computes 一个 fragScore**（与 §7.1 同公式）：`0.30·S_actor + 0.15·S_location + 0.20·S_event + 0.35·S_recall`。其中：
  - `S_actor`：`user` 片段用 `nameMatches(a, query, nameList)`（IDF 之和，饱和 1）；`window` 片段用窗口条目 actor 与远端 actor 的**成对方差逐对匹配**（任一两集合人名 term 命中即得分，IDF 之和饱和 1）。
  - `S_location`：`user` 片段 `query.includes(loc)`；`window` 片段 **层级匹配** `isHierMatch`（如 `酒馆.二楼` ⊂ `酒馆.二楼.卡座`，按 `.` 分段前缀匹配）。
  - `S_event` / `S_recall` = `clamp01(cosine(fragVec, docVec))`，`fragVec` 由 `Embedder.encodeBatch([withQueryInstruction(片段文本)])[0]` 得到。
- **最终分数**：`score = max_f(w_f · fragScore_f)`，并标注命中贡献最大的 `bestFrag`（UI 展示）。
- **绝不 BM25**：Mode A 下缺失摘要的条目直接排除，不回退词法检索（设计决策：二级摘要开启即信任语义通道）。

---

## 8. Embedding 模块（embedding.js）

- 加载本地 `lib/transformers.min.js`（transformers.js v3 ESM）+ `lib/models/bge-small-zh-v1.5`（q8 外部数据格式 onnx）。
- **v3 加载要点**（历史坑）：v3 不支持把完整 URL 当 model_id → `env.remoteHost = <baseUrl>lib/models/`，`env.remotePathTemplate = '{model}/'`，model_id 用 repo 风格 `'bge-small-zh-v1.5'`。
- `env.useBrowserCache = false`、`allowLocalModels = false`；wasm 指向本地 `lib/ort/`（mjs+wasm），`numThreads = navigator.hardwareConcurrency`。
- pipeline: `feature-extraction`，`dtype: 'q8'`；编码：`pooling: 'mean', normalize: true`（BGE 用法）。
- **LRU 缓存** 2048 条（精确文本键），`BATCH_SIZE=16` 批量推理。
- 状态总线 `onStatus`（idle/loading/ready/error），模块加载即 `init()` 预热；失败置 `initPromise=null` 允许重试。
- **降级链**：Embedder 未就绪 → 全池 BM25 归一化（等价纯 BM25 排序），功能不中断。

## 9. 向量持久化（embedstore.js，v2.8.0）

- 存储：`chat_metadata["chat-optimization-v2-embed"]`（per-chat），`saveMetadataDebounced` 落盘。
- 键 = 文本 FNV-1a 哈希（`NS.SubSummary.textHash`）→ **跨楼层去重、不受楼层下标漂移影响**。
- 序列化：Float32Array ↔ base64（8KB 分片 `String.fromCharCode` 防栈溢出）。
- `loadStore`：模型名不匹配 → 全量作废重建；逐条解码校验维度，损坏丢弃；全部损坏视为 reset。
- **完整性同步 `sync()`**：
  - 期望集合 = 全部楼层有效摘要的 `event` + 各 `recall_when`（trim 非空）文本。
  - 缺失 → `encodeBatch` 补齐并持久化；store 中不在期望集合的哈希 → 删除（摘要被擦除/哈希失效的残留）。
  - 触发时机：模块加载后 1s（`Constants.EMBED_SYNC_FIRST_DELAY_MS`）、`MESSAGE_RECEIVED`（`Constants.EMBED_SYNC_DEBOUNCE_MS` 防抖）、`CHAT_CHANGED`、SubSummary 生成批次结束（`done>0`）。`syncing` 互斥 + `syncQueued` 补跑一次。
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
- 状态总线 `onStatus/getStatus`：`{running, current:"第k/N条·楼层x 条目y", done, failed, error, message}`，快照广播（模式同 Engine.onStats）。

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

### 11.2 各 tab 要点

- **基础设置**：extensionToggle / roleCardToggle / keepCount / tokenLimit / ragRatio（slider 0.1–0.9）。
- **二级摘要**：开关、连接方式 select（fetch/profile 互斥禁用对应输入区）、profile 下拉（`getProfileOptions` 过滤 CC 类型）、baseUrl/apiKey/password/model/temperature/maxTokens、摘要模板 textarea（徽章校验 = 含 `{{故事历程}}`）、状态行 ×3（生成状态 / Embedder 状态 / 向量持久化状态）、按钮：生成所有缺失（onlyMissing）/ 强制生成全部（force）/ 强制擦除全部（口令确认弹层）。
  - profile 下拉监听 `CONNECTION_PROFILE_LOADED/CREATED/UPDATED/DELETED` 事件刷新；已保存 id 失效时自动清空设置。
- **模板**：historyPrompt / characterPrompt textarea + JSON 有效性徽章 + 重置按钮（回 `Settings.defaultSettings`）。
- **角色查看**：角色下拉（活跃角色标 `<活跃角色>`）+ `buildRoleTree` 递归树渲染。
- **故事历程**：楼层范围查询（起始/结束，空=全部）；单列表渲染每条历程：楼层号 + 天数|时间段|地点 + 历程正文 + 二级摘要块（有效→结构化展示 人物/地点/事件/触发 +「重新生成」；无效→「生成摘要」按钮）；**RAG 命中标记内联**在对应条目上（`hitMap` 以 `Engine.entryToDocText(entry)` 为键反查 `stats.rag.hits`）+ 分数明细徽章（`人x/y 地x/y 事0.xx 忆0.xx → 总分` 或 `BM25 0.xx`）；「仅显示选中楼层」复选框过滤到命中条目；「生成全部摘要」按钮（当前范围）。
- **发送预览**：`Engine.getStats().lastMessage` 原文 `<pre>` 展示。

### 11.2.1 补漏气泡（v2.9.0）

- Mode A 发送前若需补生成缺失摘要，`recallcache.js` 经 `onFill(status)` 总线广播 `{filling, count}` / `{filled}`；`coo-window.js` 订阅后在右下角浮动 `#coo-fill-bubble`（`.coo-fill-bubble`，`coo.css` 新增样式）显示「正在补漏 N 个二级摘要…」，完成后淡出。仅 `subSummaryToggle` 开且确有缺失时弹出。

### 11.3 刷新链路

- 打开/切换窗口 → `Engine.refreshStats()`（只读深拷贝 + 完整装配，**不改 ST chat**）→ `notifyStats` → `onStatsChanged` → `refreshActiveTabData`（stats 值、RAG 信息行、预览文本、当前 tab 数据重绘）。
- `SubSummary.onStatus` → 状态行 + story tab 重绘；`Embedder.onStatus` / `EmbedStore.onStatus` → 对应状态行。
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
| actor 分用 IDF 绝对饱和 | 抑制高频主角的无区分度命中，稀有角色/具体人物才拿满分 |
| 楼层级 FNV 哈希失效（非逐条） | 楼层 story block 是整体重写的（重新生成/编辑/swipe），逐条哈希无意义；整层清空最简单正确 |
| 摘要存 `extra`、向量存 `chat_metadata` | extra per-消息随 chat 走；metadata per-chat 存跨消息的派生物（向量按文本哈希跨楼层去重） |
| 摘要生成串行 + 模块级 running 互斥 | LLM 限流友好；自动/手动互斥避免 extra 写竞争 |
| 二级摘要手动生成不受总开关限制 | 开关只表达「自动行为」意愿（用户确认的决策） |
| 摘要 schema 含 `recall_when` | 面向召回而非阅读：「未来何时想起」比事件复述更有检索区分度 |
| Mode A 分段加权 max（v2.9.0） | 用户片段 + 各窗口条目片段独立计分后取 max → 任一信号（用户提角色 / 上下文提角色）都可触发召回，且天然按重要性加权（最新窗口 0.95 > 次新 0.90 > 其他 0.80 > 用户 1.0） |
| Mode A 绝不 BM25 回退 | 二级摘要开启即信任结构化语义通道；未配置连接的缺失条目直接排除，不让词法检索污染语义排序 |
| 发送前补生成（`ensureRecallSummaries` + 30s 超时） | 二级摘要开启时，缺失摘要先补齐再打分；超时降级为「缺哪些排除哪些」并 warn，不让一次补漏阻塞整次生成 |
| 召回 LRU 内容寻址缓存（v2.9.0） | fragVec/docVec/pairScore 按内容哈希寻址，新发送只重算新相关远端条目；摘要一变即 miss，无脏缓存；模型切换全清 |
| 装箱按估算 1.5 字符/token + 精确计数剪枝 | 估算优先保速度（`getTokenCountAsync` 调用重，尽量少调）；精确计数**无次数上限**地从最低分剔除至 ≤ ragBudget（v2.9.2：估算对中文偏乐观，旧版 3+1 次上限导致召回段超预算、最终 tokenCount 超限） |
| 正文超 midBudget 时从最旧整条 assistant 消息丢弃（v2.9.2） | 单条超长回复会让 正文+角色卡 超 midBudget，旧版无上限直接溢出 tokenLimit；丢整条而非截断文本，且其历程条目回归中段不丢失 |
| fetch 与 profile 双连接方式 | fetch 简单但 Key 过浏览器+CORS 风险；profile 走 ST 服务端解密更安全（UI 文案已注明） |
| Embedder 失败全链降级 | embedding 是增强项，BM25 兜底保证核心功能不中断 |
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

- mock `window/document/navigator` + `NS.bridge`（假 `getTokenCountAsync` = 长度/1 且计数 `tokenCallCount`，假 `eventSource`），用 `(0,eval)` 按加载序注入 `settings/engine/subsummary/retrieval` 四个模块（**不加载 embedding/embedstore**——Node 无模型；`scoreFarEntries` 对缺失 `NS.EmbedStore` 有回退路径）。
- 额外 mock：`NS.RecallCache`（内存、内容寻址忠实实现，验证 LRU 跨发送复用）、`Retriever.retrieve` 间谍（验证 Mode A 不调用 BM25）、`encodeBatch` 计数（验证缓存命中后不再编码）。
- 构造 4 楼层 × 2 条目假聊天（含 6 条新 schema 摘要、1 条旧 schema、1 条无摘要），跑 7 个场景：
  - **A**（Mode B，Embedder 就绪，稀有角色查询）：chat 压成 1 条、RAG 激活、最优命中是目标条目、走 summary 通道、actor 饱和=1、地点 2/2、分数 ∈ [0,1]。
  - **C**（Mode B，IDF 抑制）：只提高频主角时纯主角条目 actorScore ≈ 0.24 < 0.3，远低于稀有角色饱和分。
  - **B**（Mode B，Embedder 未就绪）：全池走 bm25 通道、分数 ∈ [0,1)。
  - **A'**（Mode A，全部有摘要）：RAG 激活、全部 summary 通道、**绝不调用 `Retriever.retrieve`**、有 `bestFrag` 标记、最优命中是陈九仓库条目。
  - **D**（Mode A + LRU）：同内容连续两次装配，第二次 `encodeBatch` 计数 = 0（缓存命中）。
  - **E**（Mode A + 装箱剪枝）：精确计数（假 1 字符/token，比估算乐观）触发 `getTokenCountAsync` 多次且命中数 < 远端条目数。
  - **F**（Mode A + 发送前补生成）：e7 旧 schema + e8 无摘要 → 缺失 >0；`ensureRecallSummaries` 被调用 1 次且补后缺失归 0；全部走 summary 通道。
- 改召回打分/装配/缓存逻辑后**必须跑此测试**；新增场景往 `runCase` + `check` 里加。

### 15.2 浏览器手工验证清单

1. wand 菜单出现「剧情角色档案」，打开窗口 6 个 tab 正常，控制台无红错。
2. 开 `extensionToggle`，正常聊天 → 控制台看 `全量 X tokens…RAG 将启用/不启用`、`Final last message`；发送预览与之一致。
3. 超预算 → RAG 激活，故事历程 tab 条目出现命中高亮 + 分数明细；「仅显示选中楼层」过滤正确。
4. 配置二级摘要（fetch 或 profile），发消息 → 最后楼层自动生成摘要并落盘（刷新仍在）；手动 生成所有缺失/强制生成/擦除（口令）行为正确。
5. 重新生成某楼层 → 该层摘要清空并自动重新生成；向量 store 对应清理（二级摘要 tab 持久化状态行）。
6. Embedder 加载失败（断网/模型损坏）→ 召回降级纯 BM25，功能不中断，状态行报错。
7. 配置不允许 CORS 的 API → 状态行 + console 明确报错，extra 不被污染。

---

## 16. 版本演进（git log 摘要）

| 版本 | 内容 |
|---|---|
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
| 2.10.1 | `config/` 目录重命名为 `core/`（功能模块目录名更贴切）；无行为变更，冒烟测试全过 |
| 2.10.0 | **可调常数集中到 `core/constant.js`**（`NS.Constants`，每项附调整指导）：召回打分权重/IDF 饱和/BM25 参数/停用词、角色卡槽位/蒸馏阈值、片段权重、装箱估算、重试、embedding 缓存/批大小、持久化与预热延迟、LRU 容量、菜单挂载时机；各模块改经 `NS.Constants` 读取；无行为变更，冒烟测试 7 场景全过 |

---

## 17. 接手者常见任务指引

- **加一个新 tab / 设置项**：TABS 数组 + 对应 `renderXxxTab` + input 委托 case + settings 默认值 + CSS。
- **改召回策略**：可调常数全部在 `core/constant.js`（`NS.Constants`，每项附调整指导）；打分在 `scoreFarEntries` / `scoreFarEntriesModeA`；装箱在 `buildPromptData` 的 RAG 路径；改完跑冒烟测试。
- **改摘要 schema**：`subSummaryPrompt` 默认模板 + `normalizeSummary` + `hasRecallFields` + UI `appendSummaryContent` + 打分分量，四处联动；旧摘要经 `hasRecallFields` 自动回退 BM25，无需迁移。
- **新增模块依赖 ST 内部**：index.js import → bridge 追加 → 模块内 `NS.bridge.xxx`。
- **发布**：bump `index.js` VERSION 与 `manifest.json` version（同步）→ 提交（本仓库）→ 用户侧强刷（`?v=` 缓存击穿自动生效）。

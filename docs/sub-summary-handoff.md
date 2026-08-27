# 二级摘要功能 — 交接文档

> 状态：已实现（v2.4.0），待浏览器端人工验证。
> 日期：2026-08-27
> 目标版本：v2.4.0

## 1. 需求背景

本插件把每层 AI 回复（楼层）里的 `<NEW_STORY_DATA><NEW_HISTORY>` 解析为 `故事历程` 数组（条目形如 `{天数, 时间段, 地点, 历程}`），合并去重后用于拼装 prompt。历程原文很长，用户希望对每个条目额外生成一份"二级摘要"，便于在 UI 中快速浏览剧情脉络。

需求三要素（用户确认）：

1. 二级摘要持久化在楼层消息的 `extra` 中，数组与该楼层 `<NEW_HISTORY>` 的 `故事历程` 数组按下标一一对应。
2. 通过独立配置的 OpenAI 兼容 LLM API 生成，每次调用只生成一个条目的二级摘要。
3. 发送给 LLM 的模板可编辑，始终用 `{{故事历程}}` 作为"该楼层故事历程数组中一个条目"的占位符，发送前替换。

## 2. 已确认的设计决策

| 决策点 | 结论 |
|---|---|
| 生成时机 | 自动 + 手动。AI 回复生成完成后自动为新楼层条目生成；UI 可手动对任意楼层范围生成/重新生成 |
| 用途 | **仅 UI 展示**，不参与 prompt 拼装（`buildPromptData`/`renderJourneyMarkdown` 零改动） |
| 占位符替换内容 | 条目**完整 JSON**（`JSON.stringify(entry)`，含 天数/时间段/地点/历程） |
| LLM 配置项 | `baseUrl` + `apiKey` + `model` + `temperature` + `maxTokens`（共 5 项 + 总开关 + 模板 = 7 个新设置） |
| 失效处理 | **楼层级哈希校验**：存整个 `故事历程` 数组的哈希，不匹配则清空该楼层 extra 字段、全部条目视为未生成（不做逐条哈希、不做 min 对齐） |
| 摘要值类型 | `s` 是 **JSON object**（结构由模板定义），不是纯文本 |
| 调用方式 | 浏览器直接 `fetch`（本地/远程 API 都可能），失败不重试，UI + console 明确报错 |
| 持久化 | 批量中逐条 `saveChatDebounced()`，整批结束 `saveChat()` 强制落盘 |

### 失效场景（为什么需要楼层级哈希）

楼层的 `故事历程` 数组来自该楼层消息的 `<NEW_HISTORY>`，以下操作会改变它：

- 该楼层重新生成（AI 重新回复，NEW_STORY_DATA 整块替换）
- 手动编辑该条消息
- 切换 swipe（`getFloorStoryBlock` 读的是当前激活 swipe）

## 3. 数据存储

```js
item.extra["chat-optimization-v2"] = {
    storyHash: "<JSON.stringify(该楼层故事历程数组) 的 FNV-1a 32-bit 十六进制哈希>",
    summaries: [
        { s: <LLM 返回的 JSON object>, t: <生成时间戳 ms> },
        // 与 故事历程 数组按下标一一对应
    ]
}
```

- extra 键名：`"chat-optimization-v2"`（整个对象由本插件独占读写）。
- 哈希：FNV-1a 32-bit（同步实现，无需 `crypto.subtle`），输入为 `JSON.stringify(故事历程数组)`。
- 读取流程：解析楼层 story block → 计算当前哈希 → 与 `storyHash` 不匹配 → 清空 `item.extra["chat-optimization-v2"]` → 所有条目视为未生成。
- 部分生成合法：`summaries` 可以只有部分下标有值（数组用 `null` 占位或直接稀疏），缺失下标 = 未生成。
- 写 extra 后：单条 → `saveChatDebounced()`；批量结束 → `saveChat()`。

## 4. LLM API 调用

- 端点：`POST {baseUrl}/chat/completions`。baseUrl 用户可能填 `http://localhost:8080`、`http://localhost:8080/v1` 等，需规范化：若路径未以 `/chat/completions` 结尾则补上（已带 `/v1` 的保留）。
- 头：`Authorization: Bearer {apiKey}`、`Content-Type: application/json`。
- Body：`{ model, messages: [{ role: "user", content: 填充后的模板 }], temperature, max_tokens }`。
- 响应解析：取 `choices[0].message.content` → 提取第一个 `{...}` 块（正则 `/\{[\s\S]*\}/`，兼容 markdown code fence 包裹）→ `JSON.parse`。
- 解析失败/网络失败/CORS 失败/非 2xx：视为该条生成失败，**不写 extra**，`console.error` 原始响应 + UI 状态行报错。不重试。

### 新增设置（`config/settings.js` 的 `defaultSettings`）

```js
subSummaryToggle: true,       // 二级摘要总开关
subSummaryBaseUrl: '',        // OpenAI 兼容 API 的 baseUrl
subSummaryApiKey: '',         // API Key
subSummaryModel: '',          // 模型名
subSummaryTemperature: 0.3,
subSummaryMaxTokens: 512,
subSummaryPrompt: `你是故事摘要助手。请将以下"故事历程"条目压缩为二级摘要，只输出一个 JSON 对象，不要输出任何其他内容。
格式：{"摘要": "一段简洁的二级摘要，保留关键情节、人物动作、状态变化", "关键": ["关键事件1", "关键事件2"]}
条目：
{{故事历程}}`
```

- 模板为**纯文本**（区别于 `historyPrompt`/`characterPrompt` 的 JSON 模板），校验规则 = 非空且包含 `{{故事历程}}`（不复用 `Engine.validateTemplate`，那是对 JSON 的校验）。
- 默认模板中的 JSON schema 只是示例，实际结构随用户编辑的模板走；插件只负责把解析出的 object 原样存入 `s`。

## 5. 模块设计

### 新文件 `config/subsummary.js`（纯逻辑，无 DOM，IIFE + 'use strict'，挂到 `window.ChatOptimizationV2`）

加载顺序：在 `config/engine.js` 之后、`ui/coo-window.js` 之前（依赖 `NS.Engine`、`NS.Settings`、`NS.bridge`）。需加入 `index.js` 的 `MODULES` 数组。

对外 API（`NS.SubSummary`）：

```js
{
    isConfigured(),                          // baseUrl/apiKey/model 三项非空
    getFloorSummaries(floor),                // 返回 {valid, summaries, storyHash}；哈希失效时已清空 extra
    getValidSummary(floor, entryIndex),      // 返回 {s, t} 或 null
    generateForEntry(floor, entryIndex, {force}),   // 单条：取条目 → 填模板 → 调 LLM → 解析 JSON → 写 extra → saveChatDebounced()
    generateForRange(start, end, {force}),   // 按楼层序、条目序串行生成；跳过有效且非 force 的条目；结束调 saveChat()
    onStatus(listener),                      // 状态总线，返回 unsubscribe
    init(),                                  // 注册 generate_end 监听（由 mount 或模块自执行调用）
}
```

内部要点：

- 取楼层 story block：复用 `Engine.getFloorStoryBlock(item)`（mes 优先、swipes 回退）。`NS.Engine` 目前已导出该函数？——**注意：当前 `NS.Engine` 的 freeze 对象并未导出 `getFloorStoryBlock`，需要加进 `NS.Engine` 导出列表**（engine.js 末尾 `NS.Engine = Object.freeze({...})` 增加 `getFloorStoryBlock`）。
- 状态总线：`{running: bool, current: "楼层X 条目Y/n", done: n, failed: n, error: string|null, message: string|null}`，每次变化广播深拷贝快照（模式同 `Engine.notifyStats/onStats`）。`message` 为中性提示（实现时新增）：全部跳过时如"该条目已有有效摘要，无需生成"。
- 模块级 `running` guard：同一时间只允许一个生成任务（自动与手动互斥），进行中再次触发直接忽略。
- 条目文本：`JSON.stringify(entry)`（紧凑格式）替换模板中的 `{{故事历程}}`。
- 写 extra：`item.extra = item.extra || {}`；`item.extra["chat-optimization-v2"] = {storyHash, summaries}`（summaries 全量写回，保持下标对齐）。

### 自动触发

- ~~监听 `generate_end` CustomEvent~~ **实现修正**：本 ST 版本没有 `generate_end` CustomEvent。ST 用 EventEmitter：`eventSource.emit(event_types.GENERATION_ENDED, chat.length)`（script.js）。模块改经 bridge 取 `eventSource` + `eventTypes`，`eventSource.on(eventTypes.GENERATION_ENDED, onGenerationEnded)` 监听。
- 条件：`subSummaryToggle` 开启 且 `isConfigured()`。
- 目标：`chat` 中最后一条 assistant 楼层中缺失/失效的条目，走 `executeBatch`（与手动范围生成共用串行逻辑与状态总线）。
- 该钩子天然覆盖"楼层重新生成后哈希失效 → 清空 → 重新生成"的闭环。

### `config/engine.js` 改动（最小）

1. `NS.Engine` 导出列表增加 `getFloorStoryBlock`。
2. `getStoryProgressRange` 返回的 entry 增加 `index` 字段：该条目在**所属楼层** `故事历程` 数组中的下标（目前只有 `floor`）。实现：楼层内遍历 `historyObj.故事历程` 时记录原始下标；注意现有 `seen` 去重逻辑——条目归属"首次出现的楼层"，index 取首次出现楼层内的下标。

### `index.js` 改动

- import 增加 `saveChat`、`saveChatDebounced`（来自 `../../../../script.js`）。
- `bridge` 增加这两个导出（`Object.freeze` 内追加）。
- `MODULES` 数组在 `'config/engine.js'` 后插入 `'config/subsummary.js'`。
- `VERSION` `2.3.1` → `2.4.0`（同时改 manifest.json 的 `version`，两者必须同步）。

### `ui/coo-window.js` 改动

> **实现后调整（用户要求）**：① 故事历程 tab 的摘要块不做格式化渲染，直接 `JSON.stringify(s)` 单行显示（等宽字体 + 横向滚动）；② 二级摘要 tab 位置移到「基础设置」之后；③ 二级摘要 tab 增加「强制生成全部」（全部楼层 `force: true`）与「强制擦除全部」（`eraseForRange`，删除全部楼层 extra 字段并 `saveChat()`）两个按钮。

1. **新 tab「二级摘要」**（`TABS` 追加，如 `{ id: 'subsummary', label: '二级摘要', icon: 'fa-solid fa-compress' }`）：
   - 开关行「启用二级摘要」(`subSummaryToggle`)，复用 `createSwitchRow`。
   - API 设置：baseUrl / apiKey / model（文本输入，可用 `createNumberRow` 同款的 label+input 行，需新增一个文本输入行工厂或复用现有 class）、temperature / maxTokens（`createNumberRow`）。
   - 模板 textarea + 有效性徽章 + 重置按钮。徽章校验用 `SubSummary` 的模板校验（非 JSON 校验），`updateValidityBadge` 需要区分字段类型或新增 `updateSubSummaryBadge`。
   - 生成状态行：订阅 `SubSummary.onStatus`，running 时显示 `当前进度 (done/failed)`，error 时红色显示。
   - 所有输入走 workspace 的 `input` 事件委托，`switch (field)` 增加新 case，`Settings.set(...)` 持久化。
2. **故事历程 tab 增强**（`buildStoryEntry` / `renderStoryResult`）：
   - 每个 entry 行显示摘要状态：
     - 有有效摘要 → 摘要块（用 `buildRoleTree` 风格渲染 `s` object）+「重新生成」按钮
     - 无摘要/失效 → 「生成摘要」按钮
   - 工具栏新增「生成全部」按钮（当前楼层范围，跳过有效条目，`generateForRange`）。
   - entry 行按钮通过 `data-coo-action` + `data-coo-floor`/`data-coo-index` 委托处理（现有 click 委托已按 `data-coo-action` 分发，扩展 `handleStoryAction` 或新增分支）。
   - 摘要展示数据来源：渲染时逐条 `SubSummary.getValidSummary(entry.floor, entry.index)`；`onStatus` 变化（生成完成）时刷新当前 tab。
3. `refreshActiveTabData` 中 story tab 分支已有刷新逻辑，摘要展示随 `queryStoryRange` 重渲染即可。

### `styles/coo.css` 改动

- 摘要块样式（与 `.coo-story-item-body` 区分，如浅色背景 + 左边框）。
- 状态行样式（running/error 态）。
- 文本输入行样式（若新增工厂复用 `.coo-input` 则可能无需新样式）。

## 6. 文件改动清单

| 文件 | 改动 |
|---|---|
| `index.js` | bridge 增加 `saveChat`/`saveChatDebounced`；MODULES 加 `config/subsummary.js`；VERSION → 2.4.0 |
| `manifest.json` | `version` → 2.4.0 |
| `config/settings.js` | `defaultSettings` 新增 7 个 `subSummary*` 键 |
| `config/subsummary.js` | **新文件**：哈希、extra 读写（含失效清空）、LLM fetch + JSON 解析、单条/范围生成、状态总线、`generate_end` 自动钩子 |
| `config/engine.js` | `NS.Engine` 导出 `getFloorStoryBlock`；`getStoryProgressRange` entry 增加 `index` |
| `ui/coo-window.js` | 新 tab；故事 tab 摘要展示 + 生成按钮；状态订阅；input/click 委托扩展 |
| `styles/coo.css` | 摘要块/状态行样式 |

## 7. 硬约束提醒（来自 AGENTS.md，实现时勿破坏）

- 功能模块是**普通脚本非 ES module**：IIFE + `'use strict'`，经 `window.ChatOptimizationV2` 共享状态；只有 `index.js` 用 ESM import。
- 访问 ST 内部一律走 `NS.bridge`，不得在功能模块里 import ST 文件 → 所以 `saveChat`/`saveChatDebounced` 必须经 bridge 暴露。
- UI DOM 全部 `createElement` 构建，无 HTML 字符串、无 jQuery。
- 设置读写一律 `Settings.get/set`（`set` 内部已调 `saveSettingsDebounced`）。
- 模板/文案中文是产品数据，保留不翻译。
- `manifest.json` 的 `generate_interceptor` 与 `replaceChatHistoryWithDetailsV2` 全局名不动（本功能不涉及）。

## 8. 验证方式

无测试/lint。从 SillyTavern 根目录启动，浏览器控制台验证：

1. 配置本地 OpenAI 兼容 API（如 llama.cpp server），开关开启，发消息触发 `generate_end` → 最后楼层条目自动生成摘要，`extra["chat-optimization-v2"]` 落盘（刷新页面仍在）。
2. 故事历程 tab：查看摘要展示、单条生成/重新生成、生成全部。
3. 重新生成某楼层 → 该层摘要清空并自动重新生成。
4. 配置远程不允许 CORS 的 API → 状态行与 console 有明确报错，extra 未被污染。
5. 关闭开关 → 自动生成不触发，手动按钮行为（建议：手动生成不受总开关限制，只受 `isConfigured()` 限制——**待用户最终确认**）。

## 9. 遗留小决策（实现时若无异议按括号内执行）

- 手动生成是否受 `subSummaryToggle` 限制？（建议：不受限，开关只控制自动触发） -> 按建议实施
- `summaries` 缺失下标用 `null` 占位（保证下标对齐直观）。
- baseUrl 规范化：trim → 去尾部 `/` → 若不以 `/chat/completions` 结尾则拼接。 -> 按建议实施
- `temperature`/`maxTokens` 非法值回退默认（模式同 engine 里 `keepCount`/`tokenLimit` 的校验）。 -> 按建议实施

## 10. 可参考的资料
https://docs.sillytavern.app/for-contributors/writing-extensions/

# AGENTS.md

本仓库是 SillyTavern 扩展 **Chat History Optimization** 的独立 git 仓库（对应 `github.com/onlyxy1986/chat-history-optimization`），部署在 SillyTavern 的 `public/scripts/extensions/third-party/chat-history-optimization` 下。

## 文件结构（全部即全部）

- `manifest.json` — 扩展清单：`loading_order: 30`，`generate_interceptor: "replaceChatHistoryWithDetails"`，`js: index.js`
- `index.js` — 全部逻辑（无构建、无打包、无测试、无 lint）
- `index.html` — 设置面板 UI，运行时通过 `$.get` 加载并追加到 `#extensions_settings`
- `style.css` — 基本为空

## 硬性约束

- 无 npm / 构建 / 测试 / CI。改动只能靠手动在运行的 SillyTavern 实例中验证（浏览器控制台日志前缀 `[Chat History Optimization]`）。
- `index.js` 通过相对路径导入 SillyTavern 内部模块：`../../../extensions.js`、`../../../tokenizers.js`、`../../../../script.js`。这些路径依赖扩展位于 `scripts/extensions/third-party/<名称>/`，不要移动文件或改目录层级。
- 依赖浏览器全局 `SillyTavern` 和 jQuery `$`；代码是 ES module（用 `import`，不要用 CommonJS）。
- `extensionName` 必须与目录名一致（`chat-history-optimization`），它是 `extension_settings` 的存储键。

## 入口与执行流

- 唯一入口：`globalThis.replaceChatHistoryWithDetails(chat, contextSize, abort, type)`（index.js:618），由 SillyTavern 在生成上下文时调用。开关关闭时直接 return（不修改 chat）。
- 流程：`mergeDataInfo` 解析历史 → `processCharacterData` 角色卡淘汰（10 槽位上限）→ 保留最后 `keepCount` 条 assistant 原文 → token 超限裁剪 → `getCharPrompt` 生成新 prompt，替换 `chat` 为单条消息。
- 拦截器**就地修改** `chat` 数组（清空后重填），不要返回新数组。

## 数据协议（模型回复格式）

- 模型回复末尾必须带 `<NEW_STORY_DATA>` 块，内含 `<NEW_HISTORY>`（必选）和 `<NEW_CHARACTER_CARD>`（可选，角色卡开关关闭时可缺失）。
- 解析前先 `//` 注释剥离（正则 `/\/\/.*$/gm`），模板本身是带 `//` 注释的"JSON5 风格"文本，不能直接 `JSON.parse`。
- `deepMerge` 只接受模板（`checkPath`）中存在的键，未知键会被跳过并 warn——新增字段必须同步更新 `defaultSettings` 中的模板。
- 数组型 delta 支持 `"delete start-end"` 字符串指令删除区间元素。
- `wordMapping`（index.js:64）在输出前做敏感词替换，替换对象包括前文和角色卡 JSON。

## UI 耦合

- `index.html` 中的元素 id（`#extension_toggle`、`#keep_count`、`#history_prompt_textarea` 等）与 `index.js` 中 jQuery 选择器一一对应，改 HTML 必须同步改 JS 的事件绑定和 `loadSettings`。
- `#token-count` 兼作调试进度指示（依次显示 1、3、4，最后显示实际 token 数），不要当成纯展示删掉。
- `globalThis.updateRoleSelectAndInfo` 是跨函数共享的角色卡 UI 更新接口，被 `replaceChatHistoryWithDetails` 调用。

## 风格约定

- 注释与 UI 文案用中文。
- 日志统一前缀 `[Chat History Optimization]`；`printObj` 输出美化 JSON。
- 设置变更一律走 `saveSettingsDebounced()`，不要直接写存储。

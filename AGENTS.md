# AGENTS.md

SillyTavern 第三方扩展「Chat History Optimization」（5 个文件：`manifest.json`、`index.js`、`index.html`、`style.css`、`README.md`）。无构建、无 package.json、无测试。

## 仓库与运行环境

- 本目录是独立 git 仓库（origin: `github.com/onlyxuyang/chat-history-optimization`），但嵌在 SillyTavern 检出中；外层 SillyTavern 是另一个仓库，勿在其中提交本扩展的改动（反之亦然）。
- 扩展无法独立运行。验证方式：在 SillyTavern 根目录（本目录上 5 级）执行 `npm start`（即 `node server.js`），浏览器进入 设置 → 扩展 → "Chat History Optimization" 测试。
- `index.js` 顶部从宿主导入 `extensions.js`、`tokenizers.js`、`script.js`（相对路径），改动 import 时注意层级。

## 关键接线（改名会破坏功能）

- `manifest.json` 的 `generate_interceptor: "replaceChatHistoryWithDetails"` 对应 `index.js` 中 `globalThis.replaceChatHistoryWithDetails`（index.js:618），是 SillyTavern 生成聊天历史时的拦截入口。
- `index.html` 不在加载时注册，而是运行时通过 `$.get(extensionFolderPath + '/index.html')` 注入（index.js:707）；其中的元素 `id` 必须与 `index.js` 的 jQuery 选择器一致。
- 设置存于 `extension_settings["chat-history-optimization"]`，改动默认值需同步 `defaultSettings`（index.js:18）。

## 约定

- `historyPrompt` / `characterPrompt` 模板是含 `//` 注释和 `{{...}}` 占位符的 JSON，解析前会先剔除 `//` 注释（index.js:132、152）——这是有意设计，不要把注释当错误修掉。
- `wordMapping`（index.js:64）是敏感词降级替换表，应用于最终 prompt 与角色卡 JSON。
- 角色卡解析依赖 AI 回复中的 `<NEW_STORY_DATA>` / `<NEW_HISTORY>` / `<NEW_CHARACTER_CARD>` 标签，正则解析，失败会记录到 `#chars-failed`。
- 版本号需保持 `manifest.json`（`version` 字段）与 `README.md` 一致（当前不一致：1.0.0 vs 1.0.1）。
- 外层 SillyTavern 的 `npm run lint`（eslint `public/**/*.js`）会覆盖本目录，可借用来做语法检查。

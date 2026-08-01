# 角色卡功能开关 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在设置面板增加「启用角色卡」开关，禁用时提示词与 roledata 的「角色卡」部分完全不处理。

**Architecture:** 方案 A（源头剔除）：禁用时在 `mergeDataInfo` 解析 delta 后删除 `角色卡` 键，使其永远进不了 roledata，下游现有守卫（nameMapping / 角色下拉 UI / 10 槽位淘汰）自然失效；同时 `getCharPrompt` 用注释/字符串感知的花括号配对函数从 ROLE_DATA_TEMPLATE 文本中剔除角色卡段落。

**Tech Stack:** 纯浏览器 JS（ES module），jQuery，SillyTavern 扩展机制。无构建、无测试套件。

## Global Constraints

- 只修改 `index.js` 与 `index.html`（CLAUDE.md：其他文件是 git 元数据）
- 无 linter / 测试套件：验证方式是刷新 SillyTavern 手动检查，纯函数可用 node 临时脚本验证
- 中文注释与命名风格与现有代码一致；`角色卡` 等中文字段名保持原样
- 默认行为不变：`roleCardToggle` 默认 `true`（旧存档无此键时也回退到 true）
- 设置持久化沿用 `extension_settings[extensionName]` + `saveSettingsDebounced()`
- 每次 commit 结尾带 `Co-Authored-By: Claude <noreply@anthropic.com>`

---

### Task 1: 设置项 + UI 开关

**Files:**
- Modify: `index.js:17-20`（defaultSettings）、`index.js:91-100`（loadSettings）、`index.js:102-106` 后（新增 onRoleCardToggleInput）、`index.js:699`（jQuery 绑定）
- Modify: `index.html:10-13`（启用功能 checkbox 后插入）

**Interfaces:**
- Produces: `isRoleCardEnabled()` — 无参，返回 `boolean`。Task 2、3 依赖它读取开关状态。

- [ ] **Step 1: defaultSettings 新增 roleCardToggle**

在 `index.js` 的 `defaultSettings` 中 `extensionToggle: false,` 之后加一行：

```js
const defaultSettings = {
    extensionToggle: false,
    roleCardToggle: true, // 角色卡功能开关，默认启用
    keepCount: 3,
```

- [ ] **Step 2: index.html 插入开关**

在 `index.html` 「启用功能」label 块（10-13 行）之后插入：

```html
<label title="启用角色卡功能" class="checkbox_label" for="role_card_toggle">
    <input type="checkbox" id="role_card_toggle">
    <span>启用角色卡</span>
</label>
```

- [ ] **Step 3: loadSettings 加载开关状态**

`index.js` `loadSettings()` 中 `extension_toggle` 那行之后加：

```js
$("#role_card_toggle").prop("checked", extension_settings[extensionName].roleCardToggle ?? defaultSettings.roleCardToggle).trigger("input");
```

- [ ] **Step 4: 新增 onRoleCardToggleInput 与 isRoleCardEnabled**

在 `index.js` `onToggleInput` 函数（102-106 行）之后加：

```js
function onRoleCardToggleInput(event) {
    const value = Boolean($(event.target).prop("checked"));
    extension_settings[extensionName].roleCardToggle = value;
    saveSettingsDebounced();
}

function isRoleCardEnabled() {
    return extension_settings[extensionName].roleCardToggle ?? defaultSettings.roleCardToggle;
}
```

- [ ] **Step 5: jQuery ready 绑定事件**

`index.js` jQuery 回调里 `$("#extension_toggle").on("input", onToggleInput);` 之后加：

```js
$("#role_card_toggle").on("input", onRoleCardToggleInput);
```

- [ ] **Step 6: 浏览器验证**

1. 刷新 SillyTavern，打开 设置 → 扩展 → Chat History Optimization：应看到「启用角色卡」checkbox 且默认勾选
2. 取消勾选 → 刷新页面 → 应保持未勾选（持久化生效）
3. DevTools console：`extension_settings["chat-history-optimization"].roleCardToggle` 应为 `false`

- [ ] **Step 7: Commit**

```bash
git add index.js index.html
git commit -m "feat: add role card toggle setting and UI checkbox

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: mergeDataInfo 源头剔除

**Files:**
- Modify: `index.js:325-326`（`const itemObj = JSON.parse(objMatch[0]);` 之后）

**Interfaces:**
- Consumes: `isRoleCardEnabled()`（Task 1 产出）
- Produces: 禁用时 `mergedRoleData` 永不包含 `角色卡` 键 → `replaceChatHistoryWithDetails` 中 546-552（nameMapping）、555-559（角色下拉 UI）、565-622（10 槽位淘汰）的现有守卫全部自然跳过，无需改动

- [ ] **Step 1: 删除 delta 中的角色卡**

`index.js` `mergeDataInfo` 内，`const itemObj = JSON.parse(objMatch[0]);` 之后加：

```js
// 角色卡功能关闭时，不合并角色卡数据
if (!isRoleCardEnabled()) delete itemObj.角色卡;
```

- [ ] **Step 2: 浏览器验证**

1. 刷新 SillyTavern，保持「启用角色卡」勾选：正常生成一次回复，DevTools console 里 `new chat history` 输出的最后一条 `mes` 应包含 `"角色卡"`（对照组）
2. 取消勾选「启用角色卡」，再生成一次回复：console 里 `new chat history` 的最后一条 `mes` 中，`<ROLE_DATA>` 的 JSON **不含** `"角色卡"`；`Final Summary Info Pre/Post` 日志中的 roledata 也不含 `角色卡`；角色下拉框显示「无角色」；`Chat History Token Count` 应下降
3. 重新勾选后生成：`"角色卡"` 恢复出现在 ROLE_DATA（历史 delta 全量重扫恢复）

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "feat: skip role card merge when role card toggle is off

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: stripRoleCardSection + 模板剔除

**Files:**
- Modify: `index.js`（`postProcess` 之后、`getCharPrompt` 之前新增 `stripRoleCardSection`；`getCharPrompt` 517 行模板注入处）

**Interfaces:**
- Consumes: `isRoleCardEnabled()`（Task 1 产出）
- Produces: `stripRoleCardSection(templateText: string): string` — 纯函数，无副作用，找不到键/括号不配对时原样返回

- [ ] **Step 1: 新增 stripRoleCardSection 函数**

在 `index.js` `postProcess` 函数之后、`getCharPrompt` 之前插入：

```js
/**
 * 从模板文本中剔除顶层 "角色卡": {...} 段落，其余文本（含 // 注释与排版）原样保留
 * 花括号配对扫描会跳过字符串（防 {{占位符}} 干扰）、// 行注释、/* 块注释
 */
function stripRoleCardSection(templateText) {
    if (typeof templateText !== 'string') return templateText;
    const key = '"角色卡"';
    const keyIdx = templateText.indexOf(key);
    if (keyIdx === -1) return templateText;

    // 确认是顶层键：向前跳过空白后应为 { 或 ,
    let j = keyIdx - 1;
    while (j >= 0 && /\s/.test(templateText[j])) j--;
    if (j >= 0 && templateText[j] !== '{' && templateText[j] !== ',') return templateText;

    // 定位值对象 '{'
    let i = keyIdx + key.length;
    while (i < templateText.length && /\s/.test(templateText[i])) i++;
    if (templateText[i] !== ':') return templateText;
    i++;
    while (i < templateText.length && /\s/.test(templateText[i])) i++;
    if (templateText[i] !== '{') return templateText;

    // 花括号配对：跳过字符串、// 行注释、/* 块注释
    let depth = 0;
    let inStr = false;
    let end = -1;
    for (; i < templateText.length; i++) {
        const c = templateText[i];
        const next = templateText[i + 1];
        if (inStr) {
            if (c === '\\') { i++; continue; }
            if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') { inStr = true; continue; }
        if (c === '/' && next === '/') { while (i < templateText.length && templateText[i] !== '\n') i++; continue; }
        if (c === '/' && next === '*') { i += 2; while (i < templateText.length && !(templateText[i] === '*' && templateText[i + 1] === '/')) i++; i++; continue; }
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) { end = i + 1; break; }
        }
    }
    if (end === -1) return templateText; // 括号不配对，安全返回原文

    // 回扫前导逗号（如存在），保证删除后 JSON 合法
    let start = keyIdx;
    let k = keyIdx - 1;
    while (k >= 0 && /\s/.test(templateText[k])) k--;
    if (k >= 0 && templateText[k] === ',') start = k;

    return templateText.slice(0, start) + templateText.slice(end);
}
```

- [ ] **Step 2: getCharPrompt 使用剔除后的模板**

`index.js` `getCharPrompt` 中，`const prompt = \`` 之前加：

```js
// 角色卡功能关闭时，从模板中剔除角色卡段落
const roleCardEnabled = isRoleCardEnabled();
const roleCardTemplate = roleCardEnabled ? $("#char_prompt_textarea").val() : stripRoleCardSection($("#char_prompt_textarea").val());
```

模板字面量里的 `${$("#char_prompt_textarea").val()}`（517 行）替换为 `${roleCardTemplate}`。

- [ ] **Step 3: node 纯函数验证**

在项目目录运行（函数内联复制到 node 脚本，用默认模板文本验证三类用例）：

```bash
node -e '
const def = '"'"'"{\n    \"天数\": \"第1天\",\n    \"故事历程\": [], // **每次回复强制输出**\n    \"角色卡\": { // **仅新角色出现时输出**\n        \"{{角色名}}\": { //所有角色都必须有完整的角色卡\n            \"角色设定\": {\n                \"角色名\": \"{{角色名}}\",\n                \"永久身体特征\": { // 格式2. \"部位2\": {\"特征1\":\"特征描述\"}\n                    // 示例: \"身高\": \"172cm\"\n                },\n                \"场景人格\": {\n                    \"SFW场景人格\": \"{{三个词}}\"\n                }\n            }\n        }\n        // ... 其他角色\n    }\n}'"'"';
'"$(sed -n '/function stripRoleCardSection/,/^}/p' index.js)"'
const out = stripRoleCardSection(def);
console.log(out);
if (out.includes('"'"'角色卡'"'"')) { console.error('"'"'FAIL: 角色卡未剔除'"'"'); process.exit(1); }
JSON.parse(out.replace(/\/\/.*$/gm, '"'"''"'"'));
console.log('"'"'PASS: 剔除后仍为合法JSON（去注释后）'"'"');
// 边界1：模板无角色卡键 → 原样返回
const noKey = '{"天数": "第1天"}';
if (stripRoleCardSection(noKey) !== noKey) { console.error('"'"'FAIL: 无键时被改动'"'"'); process.exit(1); }
// 边界2：角色卡是首键 → 删除后合法
const firstKey = '"'"'{"角色卡": {"A": {"角色设定": {"角色名": "A"}}}, "天数": "第1天"}'"'"';
const out2 = stripRoleCardSection(firstKey);
if (JSON.parse(out2).天数 !== '第1天') { console.error('"'"'FAIL: 首键删除后JSON非法'"'"'); process.exit(1); }
// 边界3：括号不配对 → 原样返回
const broken = '"'"'{"角色卡": {"A": {"B": 1}, "天数": "第1天"}'"'"';
if (stripRoleCardSection(broken) !== broken) { console.error('"'"'FAIL: 不配对时被改动'"'"'); process.exit(1); }
console.log('"'"'PASS: 全部边界用例通过'"'"');
'
```

Expected: 两个 PASS 输出，剔除后的文本不再含 `角色卡` 且无残留前导逗号。

（Windows Git Bash 下若引号转义报错，可把脚本写入临时 `verify_strip.js` 再 `node verify_strip.js`，验证后删除。）

- [ ] **Step 4: 浏览器验证**

1. 刷新 SillyTavern，取消勾选「启用角色卡」并生成回复：console 里 `new chat history` 最后一条 `mes` 中，`<ROLE_DATA_TEMPLATE>` 段落不含 `"角色卡"` 键；`<ROLE_DATA>` 不含角色卡（Task 2 已保证）
2. 重新勾选后生成：模板段落恢复含 `"角色卡"` 及注释
3. 在模板 textarea 里把 `"角色卡"` 段落删掉、保持开关关闭：生成回复不报错，模板原样输出

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "feat: strip role card section from prompt template when toggle is off

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Self-Review 记录

- **Spec 覆盖**：设置项+UI（Task 1）✓；mergeDataInfo 源头剔除（Task 2）✓；getCharPrompt 模板剔除（Task 3）✓；isRoleCardEnabled 辅助函数（Task 1）✓；边界情况（node 验证覆盖无键/首键/不配对）✓；测试方式（手动验证步骤逐条给出）✓
- **占位符扫描**：无 TBD/TODO；所有步骤含具体代码或验证命令
- **类型一致性**：`isRoleCardEnabled()` 在 Task 1 定义、Task 2/3 消费，签名一致；`stripRoleCardSection` 输入输出均为 string；`roleCardTemplate` 变量名在 Task 3 的 Step 2 内自洽

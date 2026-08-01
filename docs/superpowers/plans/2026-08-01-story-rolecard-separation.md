# 故事历程与角色卡分离（双域双状态）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将故事历程与角色卡从单个混合 JSON 拆成两条独立管道：独立状态（HISTORY_DATA / CHARACTER_DATA）、独立模板、独立合并、独立后处理，AI 输出格式从 `<delta>` 改为 `<NEW_STORY_DATA>`（内含 `<NEW_HISTORY>` / `<NEW_CHARACTER_CARD>`）。

**Architecture:** 方案 A（双域双状态）。`mergeDataInfo` 解析 `<NEW_STORY_DATA>` 后按区段拆分，分别 deepMerge 进两个状态；`checkPath`/`deepMerge` 增加模板参数按域校验；设置面板拆成两个模板 textarea；旧 `<delta>` 与旧 `charPrompt` 设置项完全不识别（用户已确认干净切断）。用户已改写的 `getCharPrompt` 模板字面量为不可改动的核心。

**Tech Stack:** 纯浏览器 JS（ES module），jQuery，SillyTavern 扩展机制。无构建、无测试套件。

## Global Constraints

- 只修改 `index.js` 与 `index.html`（CLAUDE.md：其他文件是 git 元数据；CLAUDE.md 本身除外，Task 3 会更新它）
- 无 linter / 测试套件：验证方式是刷新 SillyTavern 手动检查，纯函数用 node 临时脚本验证（Windows Git Bash 下引号转义报错时把脚本写入临时 `verify_*.js` 再 `node verify_*.js`，验证后删除）
- 中文注释与命名风格与现有代码一致；`故事历程`、`角色设定`、`天数` 等中文字段名保持原样
- 旧 `<delta>` 完全不识别；旧 `charPrompt` 设置项作废不迁移
- 设置持久化沿用 `extension_settings[extensionName]` + `saveSettingsDebounced()`
- 每次 commit 结尾带 `Co-Authored-By: Claude <noreply@anthropic.com>`
- 用户已改的 `getCharPrompt` 模板字面量（`<STORY_DATA>` / `<NEW_STORY_DATA>` 结构）为核心，不得改写其结构

---

### Task 1: 设置层拆分（双模板 textarea + 持久化 + 有效性）

**Files:**
- Modify: `index.js`（defaultSettings 17-70、全局变量 12、loadSettings 92-102、onCharPromptInput 132-150、jQuery 绑定 784-792）
- Modify: `index.html`（43-51 char_prompt_textarea 块）

**Interfaces:**
- Consumes: 无
- Produces: 全局 `history_json_template` / `character_json_template`（解析后的模板对象，Task 2 使用）；`json_template` 保留为兼容别名（仅过渡期，Task 2 移除）；设置键 `historyPrompt` / `characterPrompt`

**过渡说明：** 本任务只换设置层。旧管线（checkPath/deepMerge/getCharPrompt）仍运行在 `json_template` 上——`onHistoryPromptInput` 同时把解析结果写入 `json_template`（别名），因此故事数据仍能合并；角色卡键会因不在历史模板中而被跳过（退化但可运行）。Task 2 修复。

- [ ] **Step 1: defaultSettings 拆成双模板**

`index.js` 的 `defaultSettings`（17-70 行）整体替换为：

```js
const defaultSettings = {
    extensionToggle: false,
    roleCardToggle: true, // 角色卡功能开关，默认启用
    keepCount: 3,
    tokenLimit: 50 * 1024,
    historyPrompt: `{
    // **注意** 所有时间表述都**必须**用第X天Y点的表述
    // 天数: 第1天开始计数的天数
    // 日期: 世界观下当前日期,如无日期信息,则从第1天开始
    // 地点: 用.分隔大小地点，如“图书馆.三楼.阅览室”、“酒馆.二楼.卫生间”
    "天数": "第1天",
    "日期": "日期",
    "星期": "星期一",
    "正文出场或提及到的角色": "{{角色名1}},{{角色名2}},{{角色名3}},...",
    "故事历程": [ // **每次回复强制输出**
        {
            "天数":"第1天",
            "时间":"9:00至10:00",
            "地点":"地点",
            "历程":"{{总结当前消息要点，需用词明确 要求:1.必须保留所有关键信息，比如重要动作、暗示、数字、人物、物品、时间、日期、日程安排、说明、描述、地点、要求、承诺、言语、规则、事实、推断、招式名、对话、安排等 2.使用角色名代替人称 3.NSFW场景用词需极简 4.记录相对时间时必须附上绝对时间，例如:相约明天(第13天)去逛街}}"
        }
        // ...
    ]
}`,
    characterPrompt: `{ // **仅新角色出现时输出**
    "{{角色名}}": { //所有角色都必须有完整的角色卡
        "角色设定": { // [角色设定]：此部分包含角色的**不可更改的**核心基础设定，是判断角色行为是否OOC的最高依据。
            "角色名": "{{角色名}}",
            "职业": "{{职业}}",
            "年龄": "{{年龄}}",
            "性别": "男/女",
            "背景": {
                "概述": "{{以一句话客观概括人物在故事开始前的人生经历，不涉及人物主观想法，不随故事更新}}"
            },
            "永久身体特征": { // 身体的固有特征或不可逆的改变，填充时自选格式:
                // 格式1. "部位1":"特征描述"
                // 格式2. "部位2": {"特征1":"特征描述", "特征2":"特征描述"}
                // 示例1: "面容": "棱角分明的刀削面庞，冷白皮，狭长的凤眼"
                // 示例2: "手": "白玉似的手，指节泛白"
                // 示例3: "身高": "172cm"
                // 示例4: "臀部": {"尺寸": "94cm", "特征": "蜜桃一般，弹性十足"}
                // 示例5: "处女": "是/否，由XX破处"
                // 示例6: "胸部": {"尺寸": "110cm", "罩杯": "G罩杯", "特征": "白嫩，能看到青色血管" }
            },
            "性癖": "性癖A,性癖B,…",
            "场景人格":{ // 角色不同情境时所展现出的、相对固定的、独特的性格侧面与行为模式，不同场景的影响**独立**，互不影响
                "SFW场景人格": "{{用三个词描述角色在SFW场景下的表现}}",
                "NSFW场景人格": "{{用三个词描述角色在NSFW场景下的表现}}"
            }
        }
    }
    // ... 其他角色
}`,
};
```

（原 `charPrompt` 键删除；`historyPrompt` = 旧模板去 `角色卡`，`characterPrompt` = 旧 `角色卡` 段落直接作为根对象，无 `"角色卡"` 包装键。）

- [ ] **Step 2: 全局变量改造**

`index.js` 第 12 行 `let json_template = null;` 替换为：

```js
let json_template = null; // 过渡期兼容别名，Task 2 删除
let history_json_template = null;
let character_json_template = null;
```

- [ ] **Step 3: index.html 双 textarea**

`index.html` 43-51 行的 `char_prompt_textarea` 块替换为：

```html
<div class="marginTop5">
    <label for="history_prompt_textarea">
        <span>故事历程JSON模板</span>
        <small id="history_prompt_validity" style="color:#888">(有效性检测)</small>
        <button id="history_prompt_reset" type="button" style="margin-left:8px;">重置</button>
    </label>
    <textarea id="history_prompt_textarea" rows="18" style="width:100%;font-family:monospace;resize:vertical;"></textarea>
</div>
<div class="marginTop5">
    <label for="character_prompt_textarea">
        <span>角色卡JSON模板</span>
        <small id="character_prompt_validity" style="color:#888">(有效性检测)</small>
        <button id="character_prompt_reset" type="button" style="margin-left:8px;">重置</button>
    </label>
    <textarea id="character_prompt_textarea" rows="12" style="width:100%;font-family:monospace;resize:vertical;"></textarea>
</div>
```

- [ ] **Step 4: loadSettings 更新**

`index.js` `loadSettings()`（96-101 行）中 `char_prompt_textarea` 那行替换为：

```js
    // 加载 historyPrompt / characterPrompt 到各自的 textarea
    $("#history_prompt_textarea").prop("value", extension_settings[extensionName].historyPrompt ?? defaultSettings.historyPrompt).trigger("input");
    $("#character_prompt_textarea").prop("value", extension_settings[extensionName].characterPrompt ?? defaultSettings.characterPrompt).trigger("input");
```

- [ ] **Step 5: handler 替换（onCharPromptInput → 双 handler）**

`index.js` 132-150 行的 `onCharPromptInput` 整体替换为：

```js
function onHistoryPromptInput(event) {
    let val = $(event.target).val();
    // 移除//开头的注释
    let jsonStr = val.replace(/\/\/.*$/gm, '');
    let isValid = false;
    try {
        history_json_template = JSON.parse(jsonStr);
        json_template = history_json_template; // 过渡期兼容别名，Task 2 删除
        printObj("[Chat History Optimization] Loaded history prompt template", history_json_template);
        isValid = true;
    } catch (e) {
        console.error(`[Chat History Optimization] JSON parse error`, jsonStr, e);
        history_json_template = null;
        json_template = null;
        isValid = false;
    }
    // 设置 index.html 选中区标签内容
    $("#history_prompt_validity").text(isValid ? "(有效)" : "(无效)");
    extension_settings[extensionName].historyPrompt = val;
    saveSettingsDebounced();
}

function onCharacterPromptInput(event) {
    let val = $(event.target).val();
    // 移除//开头的注释
    let jsonStr = val.replace(/\/\/.*$/gm, '');
    let isValid = false;
    try {
        character_json_template = JSON.parse(jsonStr);
        printObj("[Chat History Optimization] Loaded character prompt template", character_json_template);
        isValid = true;
    } catch (e) {
        console.error(`[Chat History Optimization] JSON parse error`, jsonStr, e);
        character_json_template = null;
        isValid = false;
    }
    // 设置 index.html 选中区标签内容
    $("#character_prompt_validity").text(isValid ? "(有效)" : "(无效)");
    extension_settings[extensionName].characterPrompt = val;
    saveSettingsDebounced();
}
```

- [ ] **Step 6: jQuery 绑定更新**

`index.js` jQuery 回调（784-792 行）中 `char_prompt_textarea` 的 input 绑定与 `char_prompt_reset` click 绑定替换为：

```js
    $("#history_prompt_textarea").on("input", onHistoryPromptInput);
    $("#character_prompt_textarea").on("input", onCharacterPromptInput);
    $("#history_prompt_reset").on("click", function () {
        $("#history_prompt_textarea").val(defaultSettings.historyPrompt).trigger("input");
    });
    $("#character_prompt_reset").on("click", function () {
        $("#character_prompt_textarea").val(defaultSettings.characterPrompt).trigger("input");
    });
```

- [ ] **Step 7: 浏览器验证**

1. 刷新 SillyTavern，打开 设置 → 扩展 → Chat History Optimization：应看到「故事历程JSON模板」与「角色卡JSON模板」两个 textarea，默认内容分别为旧模板去角色卡、角色卡段落
2. 修改任一模板 → 刷新页面 → 修改被持久化
3. 点任一「重置」→ 恢复对应默认模板
4. 输入非法 JSON（如 `{`）→ 该模板有效性标签变「(无效)」，console 有 parse error
5. DevTools console：`extension_settings["chat-history-optimization"].historyPrompt` / `.characterPrompt` 存在，`.charPrompt` 为 undefined
6. 生成一次回复：不报错（故事仍合并，角色卡暂缺——Task 2 修复），`<ROLE_DATA_TEMPLATE>` 段落显示 "undefined" 属预期（旧模板注入点无 UI 可读，Task 2 修复）

- [ ] **Step 8: Commit**

```bash
git add index.js index.html
git commit -m "feat: split JSON template settings into history and character card templates

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: 双域管线重构（解析 / 合并 / 后处理 / 提示词）

**Files:**
- Modify: `index.js`（checkPath 152-176、deepMerge 246-308、mergeDataInfo 310-373、postProcess 488-504、stripRoleCardSection 506-569 删除、getCharPrompt 571-613、replaceChatHistoryWithDetails 615-771、全局变量 12-13）

**Interfaces:**
- Consumes: `history_json_template` / `character_json_template`（Task 1）、`isRoleCardEnabled()`（现有）、用户已写的 `getCharPrompt` 模板字面量（工作区未提交改动）
- Produces: `checkPath(path, template)`、`deepMerge(merged, delta, path, allowUpdate, template)`、`mergeDataInfo(chat)` 返回 `{ historyData, characterData }`、`postProcessHistory(data)`、`processCharacterData(characterData, chat, nameMapping)`、`getCharPrompt(historyData, characterData)`

**Task 内部步骤按依赖排序，每步有独立验证；2.1-2.4 完成后才可刷新浏览器。**

- [ ] **Step 1: checkPath 参数化**

`index.js` `checkPath`（152-176 行）整体替换为（签名加 `template`，内部引用模板而非全局）：

```js
function checkPath(path, template) {
    let current = template;
    if (path.length == 1 && path[0] === '故事历程总结') {
        return true;
    }
    for (let j = 0; j < path.length; j++) {
        let key = path[j];
        if (key in current) {
            if (typeof current[key] === 'object' && Object.keys(current[key]).length === 0) {
                return true;
            } else {
                current = current[key];
                continue;
            }
        }
        if (typeof current === 'object' && Object.keys(current).length === 1 && Object.keys(current)[0].startsWith("{{") && Object.keys(current)[0].endsWith("}}")) {
            // 动态键，继续深入
            current = current[Object.keys(current)[0]];
            continue;
        }

        return false;
    }
    return true;
}
```

node 验证（模板 null 时 `key in null` 抛 TypeError 属预期——由 mergeDataInfo 的 try/catch 捕获转 failed floor）：

```bash
node -e '
'"$(sed -n '/^function checkPath/,/^}/p' index.js)"'
const histTpl = JSON.parse(`{"天数":"第1天","故事历程":[],"正文出场或提及到的角色":"x"}`);
const charTpl = JSON.parse(`{"{{角色名}}":{"角色设定":{"角色名":"x","性别":"男/女"}}}`);
if (!checkPath(["天数"], histTpl) || checkPath(["未知键"], histTpl)) { console.error("FAIL: 故事域路径校验"); process.exit(1); }
if (!checkPath(["Alice","角色设定","角色名"], charTpl) || checkPath(["Alice","不存在"], charTpl)) { console.error("FAIL: 角色域路径校验"); process.exit(1); }
if (!checkPath(["Alice"], charTpl)) { console.error("FAIL: 动态键单层路径"); process.exit(1); }
if (!checkPath(["故事历程总结"], histTpl)) { console.error("FAIL: 故事历程总结特例"); process.exit(1); }
console.log("PASS: checkPath 双模板验证通过");
'
```

Expected: `PASS: checkPath 双模板验证通过`

- [ ] **Step 2: deepMerge 加模板参数**

`index.js` `deepMerge`（246-308 行）整体替换为（签名加 `template = null`，所有递归调用与 checkPath 调用穿透该参数；其余逻辑不变）：

```js
function deepMerge(merged, delta, path = [], allowUpdate = false, template = null) {
    if (path.length == 0 && delta.故事历程总结 && merged.故事历程) {
        merged.故事历程 = [];
        delta.故事历程 = [];
    }
    // 检查target是否为数组并且source是否为字符串
    if (Array.isArray(merged) && typeof delta === 'string') {
        // 使用正则表达式匹配 "delete start-end" 格式
        const regex = /delete\s+(\d+)\s*-\s*(\d+)/i;
        const match = delta.match(regex);

        if (match) {
            const start = parseInt(match[1]);
            const end = parseInt(match[2]);

            // 验证索引范围是否有效
            if (start >= 0 && end < merged.length && start <= end) {
                // 创建新数组，不包含指定范围的元素
                return [
                    ...merged.slice(0, start),
                    ...merged.slice(end + 1)
                ];
            } else {
                console.warn(`Invalid index range ${start}-${end} for array of length ${merged.length}. No items deleted.`);
            }
        }
    }
    if (Array.isArray(merged) && Array.isArray(delta)) {
        // 过滤 source 中 target 已经存在的 item，比较方式是 JSON.stringify
        const targetStrSet = new Set(merged.map(item => JSON.stringify(item)));
        const filteredSource = delta.filter(item => !targetStrSet.has(JSON.stringify(item)));
        return merged.concat(filteredSource);
    }
    if (typeof merged !== 'object' || merged === null) return delta;
    if (typeof delta !== 'object' || delta === null) return merged;
    const preDay = merged.天数 || null;
    for (const key of Object.keys(delta)) {
        if (key in merged) {
            if (!allowUpdate && path.concat(key).includes("角色设定") && merged[key] && typeof merged[key] === 'string' && !merged[key].includes("未知") && key != "处女") {
                continue;
            }
            merged[key] = deepMerge(merged[key], delta[key], path.concat(key), allowUpdate, template);
        } else if (checkPath(path.concat(key), template)) {
            if (Array.isArray(delta[key])) {
                merged[key] = deepMerge([], delta[key], path.concat(key), allowUpdate, template);
            } else if (typeof delta[key] === 'object') {
                merged[key] = deepMerge({}, delta[key], path.concat(key), allowUpdate, template);
            } else {
                merged[key] = delta[key];
            }
        } else {
            console.warn(`[Chat History Optimization] Skipping unknown key at path: ${path.concat(key).join(' -> ')}`);
        }
        if (merged[key] === "") {
            delete merged[key];
        }
    }
    const postDay = merged.天数 || null;
    if (postDay && preDay !== postDay) {
        console.log(`[Chat History Optimization] Day changed from ${preDay} to ${postDay}`);
    }
    return merged;
}
```

node 验证：

```bash
node -e '
'"$(sed -n '/^function checkPath/,/^}/p' index.js)"'
'"$(sed -n '/^function deepMerge/,/^}/p' index.js)"'
const histTpl = JSON.parse(`{"天数":"第1天","故事历程":[]}`);
const charTpl = JSON.parse(`{"{{角色名}}":{"角色设定":{"角色名":"x","性别":"男/女"}}}`);
// 故事域：数组去重
let h = deepMerge({"故事历程":[{"天数":"第1天","历程":"A"}]}, {"故事历程":[{"天数":"第1天","历程":"A"},{"天数":"第1天","历程":"B"}]}, [], false, histTpl);
if (h.故事历程.length !== 2) { console.error("FAIL: 故事数组去重", JSON.stringify(h.故事历程)); process.exit(1); }
// 故事域：delete 区间
h = deepMerge(h, "delete 0-0", ["故事历程"], false, histTpl);
if (h.故事历程.length !== 1 || h.故事历程[0].历程 !== "B") { console.error("FAIL: delete 区间"); process.exit(1); }
// 角色域：角色设定不可变
let c = deepMerge({"Alice":{"角色设定":{"角色名":"Alice","性别":"女"}}}, {"Alice":{"角色设定":{"性别":"男"}}}, [], false, charTpl);
if (c.Alice.角色设定.性别 !== "女") { console.error("FAIL: 角色设定不可变"); process.exit(1); }
// 角色域：allowUpdate 覆盖
c = deepMerge(c, {"Alice":{"角色设定":{"性别":"男"}}}, [], true, charTpl);
if (c.Alice.角色设定.性别 !== "男") { console.error("FAIL: allowUpdate 覆盖"); process.exit(1); }
// 角色域：未知键被跳过
c = deepMerge(c, {"Alice":{"随便键":"x"}}, [], false, charTpl);
if ("随便键" in c.Alice) { console.error("FAIL: 未知键未跳过"); process.exit(1); }
// 故事域：未知键被跳过（角色卡键不在历史模板中）
h = deepMerge(h, {"角色卡":{"Alice":{}}}, [], false, histTpl);
if ("角色卡" in h) { console.error("FAIL: 历史模板未跳过角色卡键"); process.exit(1); }
console.log("PASS: deepMerge 分域验证通过");
'
```

Expected: `PASS: deepMerge 分域验证通过`

- [ ] **Step 3: mergeDataInfo 重写（双区段解析）**

`index.js` `mergeDataInfo`（310-373 行）整体替换为：

```js
function mergeDataInfo(chat) {
    let failedChars = [];
    let historyData = {};
    let characterData = {};

    for (let j = 1; j < chat.length; j++) {
        const item = chat[j];
        if (item && (("is_user" in item && !item.is_user) || (item.role && item.role == "assistant"))) {
            let matches = [];
            if (item.mes) {
                matches = [...item.mes
                    .replace(/\/\/.*$/gm, '')
                    .matchAll(/<NEW_STORY_DATA>((?:(?!<NEW_STORY_DATA>)[\s\S])*?)<\/NEW_STORY_DATA>/gi)];
            }
            if (matches.length == 0 && ("swipes" in item && "swipe_id" in item && item.swipes[item.swipe_id])) {
                matches = [...item.swipes[item.swipe_id]
                    .replace(/\/\/.*$/gm, '')
                    .matchAll(/<NEW_STORY_DATA>((?:(?!<NEW_STORY_DATA>)[\s\S])*?)<\/NEW_STORY_DATA>/gi)];
            }
            if (matches.length > 0) {
                const block = matches[matches.length - 1][1];
                let failedSection = false;

                // --- NEW_HISTORY 区段：必选 ---
                const historyMatch = block.match(/<NEW_HISTORY>((?:(?!<NEW_HISTORY>)[\s\S])*?)<\/NEW_HISTORY>/i);
                if (historyMatch) {
                    const objMatch = historyMatch[1].trim().match(/\{[\s\S]*\}/);
                    if (objMatch) {
                        try {
                            const historyObj = JSON.parse(objMatch[0]);
                            historyData = deepMerge(historyData, historyObj, [], false, history_json_template);
                            item.messageCount = 0;
                            if (historyObj.故事历程) {
                                item.messageCount = historyObj.故事历程.length;
                            }
                        } catch (e) {
                            console.error(`[Chat History Optimization] NEW_HISTORY JSON parse error at chat[${j}]:`, e);
                            failedSection = true;
                        }
                    } else {
                        failedSection = true;
                    }
                } else {
                    failedSection = true; // 缺 NEW_HISTORY 视为失败
                }

                // --- NEW_CHARACTER_CARD 区段：可选（无新角色/开关关闭时合法缺失）---
                if (isRoleCardEnabled()) {
                    const charMatch = block.match(/<NEW_CHARACTER_CARD>((?:(?!<NEW_CHARACTER_CARD>)[\s\S])*?)<\/NEW_CHARACTER_CARD>/i);
                    if (charMatch) {
                        const objMatch = charMatch[1].trim().match(/\{[\s\S]*\}/);
                        if (objMatch) {
                            try {
                                const charObj = JSON.parse(objMatch[0]);
                                let allowUpdate = charObj.allowUpdate || false;
                                delete charObj.allowUpdate;
                                characterData = deepMerge(characterData, charObj, [], allowUpdate, character_json_template);
                            } catch (e) {
                                console.error(`[Chat History Optimization] NEW_CHARACTER_CARD JSON parse error at chat[${j}]:`, e);
                                failedSection = true;
                            }
                        } else {
                            failedSection = true;
                        }
                    }
                }

                if (failedSection) {
                    failedChars.push(j);
                }
            } else {
                failedChars.push(j);
            }
        }
    }

    if (failedChars.length > 0) {
        console.warn(`[Chat History Optimization] Failed to parse or missing <NEW_STORY_DATA> at chat indexes: ${failedChars.join(', ')}`);
        $("#chars-failed").prop("textContent", failedChars.join(', '));
    } else {
        $("#chars-failed").prop("textContent", "无");
    }

    return {
        "historyData": historyData,
        "characterData": characterData
    };
}
```

（不再返回 `roledata_history` 快照——死数据。nameMapping 重命名迁移到 Step 6。）

node 验证区段抽取正则（内联复制正则，不依赖模块）：

```bash
node -e '
const block = `<NEW_STORY_DATA>
<NEW_HISTORY>
{"天数": "第2天", "故事历程": [{"天数":"第2天","时间":"10:00","地点":"家","历程":"A。"}]}
</NEW_HISTORY>
<NEW_CHARACTER_CARD>
{"Alice": {"角色设定": {"角色名": "Alice"}}}
</NEW_CHARACTER_CARD>
</NEW_STORY_DATA>`;
const hist = block.match(/<NEW_HISTORY>((?:(?!<NEW_HISTORY>)[\s\S])*?)<\/NEW_HISTORY>/i);
const chars = block.match(/<NEW_CHARACTER_CARD>((?:(?!<NEW_CHARACTER_CARD>)[\s\S])*?)<\/NEW_CHARACTER_CARD>/i);
if (!hist || !chars) { console.error("FAIL: 双区段抽取失败"); process.exit(1); }
JSON.parse(hist[1].match(/\{[\s\S]*\}/)[0]);
JSON.parse(chars[1].match(/\{[\s\S]*\}/)[0]);
console.log("PASS: 双区段抽取+解析成功");
// 缺角色卡区段 → 仍可取到 NEW_HISTORY
const onlyHist = `<NEW_STORY_DATA><NEW_HISTORY>{"天数":"第3天"}</NEW_HISTORY></NEW_STORY_DATA>`;
const h2 = onlyHist.match(/<NEW_HISTORY>((?:(?!<NEW_HISTORY>)[\s\S])*?)<\/NEW_HISTORY>/i);
if (!h2 || JSON.parse(h2[1].match(/\{[\s\S]*\}/)[0]).天数 !== "第3天") { console.error("FAIL: 缺角色卡区段"); process.exit(1); }
// 含 // 注释的块
const commented = `<NEW_STORY_DATA>
<NEW_HISTORY> // **新HISTORY信息的模板**
{"天数":"第4天"}
</NEW_HISTORY>
</NEW_STORY_DATA>`;
const h3 = commented.match(/<NEW_HISTORY>((?:(?!<NEW_HISTORY>)[\s\S])*?)<\/NEW_HISTORY>/i);
if (!h3 || JSON.parse(h3[1].replace(/\/\/.*$/gm, "").match(/\{[\s\S]*\}/)[0]).天数 !== "第4天") { console.error("FAIL: 注释干扰"); process.exit(1); }
console.log("PASS: 缺区段/注释场景通过");
'
```

Expected: 两个 PASS

- [ ] **Step 4: postProcess 拆分 + getCharPrompt 重构**

**4a.** `index.js` `postProcess`（488-504 行）整体替换为 `postProcessHistory`（新增 `故事历程总结` 处理、NEW_STORY_DATA 与 delta 标签剥离、日期锚点）：

```js
function postProcessHistory(data) {
    if (data && data.故事历程 && Array.isArray(data.故事历程)) {
        data.前文 = arrayToMarkdown(data.故事历程, keepMessageCount) + '\n' + (data.前文 || '');
        data.故事历程 = [];
    }
    if (data && data.故事历程总结 && Array.isArray(data.故事历程总结)) {
        data.前文 = arrayToMarkdown(data.故事历程总结, 0) + '\n' + (data.前文 || '');
        delete data.故事历程总结;
    }
    data.前文 = data.前文.replace(/<(?:NEW_STORY_DATA|delta)>((?:(?!<(?:NEW_STORY_DATA|delta)>)[\s\S])*?)<\/(?:NEW_STORY_DATA|delta)>/gi, '').trim();
    // 在前文末尾附加时间锚点，方便AI将相对时间引用转换为绝对天数
    if (data && data.天数) {
        data.前文 += '\n\n' + generateTimeAnchor(data.天数);
    }
    printObj("[Chat History Optimization] Post Processed 前文", data.前文);
    return data;
}
```

**4b.** `index.js` `getCharPrompt`（571-613 行）整体替换为（沿用用户已写的模板字面量结构，补齐变量与开关条件）：

```js
function getCharPrompt(historyData, characterData) {
    historyData = postProcessHistory(historyData || {});
    // 将前文从历史数据中剥离，单独放入HISTORY
    let historyContent = historyData.前文 || '';
    delete historyData.前文;
    // 对前文也应用敏感词替换
    for (const [key, value] of Object.entries(wordMapping)) {
        historyContent = historyContent.replace(new RegExp(key, 'g'), value);
    }
    let charsInfoJsonStr = JSON.stringify(characterData || {});
    for (const [key, value] of Object.entries(wordMapping)) {
        charsInfoJsonStr = charsInfoJsonStr.replace(new RegExp(key, 'g'), value);
    }

    // 角色卡功能关闭时，不注入角色卡区段与模板
    const roleCardEnabled = isRoleCardEnabled();
    const newHistoryTemplate = $("#history_prompt_textarea").val();
    const newCharacterCardTemplate = roleCardEnabled ? $("#character_prompt_textarea").val() : '';

    const prompt = `
<STORY_DATA>

<HISTORY>
${historyContent}
</HISTORY>

${roleCardEnabled ? `<CHARACTER_CARD>
${charsInfoJsonStr}
</CHARACTER_CARD>
` : ''}
</STORY_DATA>

**在回复最末尾必须生成当前正文的NEW_STORY_DATA信息。**
<NEW_STORY_DATA>
<NEW_HISTORY> // **新HISTORY信息的模板**
${newHistoryTemplate}
</NEW_HISTORY>
${roleCardEnabled ? `<NEW_CHARACTER_CARD> // **新CHARACTER_CARD信息的模板**
${newCharacterCardTemplate}
</NEW_CHARACTER_CARD>
` : ''}
</NEW_STORY_DATA>
`
    return prompt;
}
```

**4c.** `index.js` `stripRoleCardSection`（506-569 行）**整个删除**（双 textarea 后不再需要）。

node 验证 postProcessHistory（函数依赖：parseDayNumber / extractItemProcess / arrayToMarkdown / generateTimeAnchor / printObj / 全局 keepMessageCount）：

```bash
node -e '
let keepMessageCount = 0;
'"$(sed -n '/^function printObj/,/^}/p' index.js)"'
'"$(sed -n '/^function parseDayNumber/,/^}/p' index.js)"'
'"$(sed -n '/^function extractItemProcess/,/^}/p' index.js)"'
'"$(sed -n '/^function arrayToMarkdown/,/^}/p' index.js)"'
'"$(sed -n '/^function generateTimeAnchor/,/^}/p' index.js)"'
'"$(sed -n '/^function postProcessHistory/,/^}/p' index.js)"'
const data = {
    天数: "第2天",
    前文: "<NEW_STORY_DATA>残留标签</NEW_STORY_DATA>",
    故事历程: [
        {天数: "第1天", 时间: "9:00", 地点: "家", 历程: "A。"},
        {天数: "第2天", 时间: "10:00", 地点: "公司", 历程: "B。"}
    ]
};
const out = postProcessHistory(data);
if (!Array.isArray(out.故事历程) || out.故事历程.length !== 0) { console.error("FAIL: 故事历程未清空"); process.exit(1); }
if (!out.前文.includes("第1天") || !out.前文.includes("B。")) { console.error("FAIL: 前文内容缺失"); process.exit(1); }
if (!out.前文.includes("日期换算表")) { console.error("FAIL: 日期锚点缺失"); process.exit(1); }
if (out.前文.includes("<NEW_STORY_DATA>")) { console.error("FAIL: NEW_STORY_DATA 标签未剥离"); process.exit(1); }
console.log("PASS: postProcessHistory 验证通过");
'
```

Expected: `PASS: postProcessHistory 验证通过`

- [ ] **Step 5: processCharacterData 提取 + replaceChatHistoryWithDetails 重排**

**5a.** 新增 `processCharacterData`（从 replaceChatHistoryWithDetails 内联逻辑 649-707 行提取），放在 `getCharPrompt` 之后：

```js
/**
 * 角色卡淘汰与蒸馏：固定 10 槽位上限
 * 当前 prompt 提到的角色得分 1,000,000（保证保留）；其余按最后出现索引计分
 * 超过 30 条消息未活跃（且非当前提问提及）的角色只保留核心设定
 * @param {object} characterData - 角色卡映射 { 角色名: {...} }
 * @param {object[]} chat - 原始聊天记录
 * @param {object} nameMapping - 别名映射
 * @returns {object} 精简后的角色卡映射
 */
function processCharacterData(characterData, chat, nameMapping) {
    const MAX_SLOTS = 10;
    if (!characterData || typeof characterData !== 'object') return characterData;

    const roleScores = [];
    const userPrompt = chat[chat.length - 1]?.mes || "";
    const roleNames = Object.keys(characterData);

    // 构建所有已知角色名集合，用于消歧义：
    // 当"沈梦"和"沈梦瑶"同时存在时，"沈梦"在文本中的匹配不会被"沈梦瑶"吞掉才算真正命中
    const allKnownNames = [...new Set([
        ...roleNames,
        ...Object.values(nameMapping),
    ])];

    for (const roleName of roleNames) {
        const realName = nameMapping[roleName] || roleName;
        let score = -1;

        // 1. 意图驱动：如果最新 Prompt 提到了，给予极高优先级（确保唤醒）
        if (nameMatches(roleName, userPrompt, allKnownNames) || nameMatches(realName, userPrompt, allKnownNames)) {
            score = 1000000;
        } else {
            // 2. 活跃度：寻找最后一次出现的索引作为基础分
            for (let i = chat.length - 1; i >= 0; i--) {
                const mes = chat[i].mes || "";
                if (nameMatches(roleName, mes, allKnownNames) || nameMatches(realName, mes, allKnownNames)) {
                    score = i;
                    break;
                }
            }
        }
        roleScores.push({ name: roleName, score });
    }

    // 3. 排序并只保留前 10 个角色
    const sortedRoles = roleScores
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_SLOTS);

    const newRoleCards = {};
    for (const item of sortedRoles) {
        const roleName = item.name;
        const originalData = characterData[roleName];

        // 4. 特征蒸馏：如果角色虽然在前 10，但距离上次活跃已超过 30 条消息（且非当前提问提及）
        // 则只保留核心设定，剔除角色状态（穿戴、物品、技能等动态高消耗字段）
        const distance = chat.length - 1 - item.score;
        if (item.score < 1000000 && distance > 30) {
            newRoleCards[roleName] = {
                "角色设定": originalData.角色设定 || {}
            };
        } else {
            newRoleCards[roleName] = originalData;
        }
    }

    // 5. 替换为精简后的角色集合（物理删除不在槽位内的角色）
    return newRoleCards;
}
```

**5b.** `index.js` `replaceChatHistoryWithDetails`（615-771 行）整体替换为：

```js
globalThis.replaceChatHistoryWithDetails = async function (chat, contextSize, abort, type) {
    if (!extension_settings[extensionName].extensionToggle) {
        console.info("[Chat History Optimization] extension is disabled.")
        return;
    }

    keepMessageCount = 0;
    printObj("[Chat History Optimization] Original chat history:", chat);
    let isFirstMessage = false;
    if (chat.length == 2 && chat[0].is_user === false && chat[1].is_user === true) {
        isFirstMessage = true;
    }
    let mergedDataInfo = mergeDataInfo(chat);
    let historyData = mergedDataInfo.historyData || {};
    let characterData = mergedDataInfo.characterData || {};

    // 处理角色别名信息
    if (characterData && typeof characterData === 'object') {
        for (const roleName of Object.keys(characterData)) {
            if (characterData[roleName] && characterData[roleName].角色设定 && characterData[roleName].角色设定.角色名 && roleName !== characterData[roleName].角色设定.角色名) {
                nameMapping[roleName] = characterData[roleName].角色设定.角色名;
            }
        }
    }

    // 更新角色下拉框和信息显示
    globalThis.updateRoleSelectAndInfo(JSON.parse(JSON.stringify(characterData || {})));

    const tokenCount_origin = await getTokenCountAsync(JSON.stringify(historyData) + JSON.stringify(characterData));
    console.log("[Chat History Optimization] origin token count:", tokenCount_origin);
    printObj("[Chat History Optimization] Final Summary Info Pre", { historyData, characterData });
    $("#token-count").prop("textContent", "1");
    // --- 优化后的角色卡管理：固定 10 槽位上限 ---
    characterData = processCharacterData(characterData, chat, nameMapping);

    $("#token-count").prop("textContent", "3");
    // 保留倒数第 keepCount 条 assistant 消息及其后的所有信息
    let assistantIdxArr = [];
    for (let i = 0; i < chat.length; i++) {
        if (!chat[i].is_user) assistantIdxArr.push(i);
    }
    let keepCount = extension_settings[extensionName].keepCount;
    if (typeof keepCount !== 'number' || isNaN(keepCount)) keepCount = defaultSettings.keepCount;
    if (keepCount == 0 && assistantIdxArr.length == 1) keepCount = 1;
    if (keepCount > assistantIdxArr.length) keepCount = assistantIdxArr.length;
    if (keepCount > 0) {
        const startIdx = assistantIdxArr[assistantIdxArr.length - keepCount];
        let tail = chat
            .slice(startIdx)
            .filter(item => item && item.is_user === false)
            .map(item => {
                if (!item || !item.mes) return '';
                keepMessageCount += item.messageCount;
                const regex = /(?:<\/(?:think|thinking)>|^)([\s\S]*?)<(?:post_thinking|delta|NEW_STORY_DATA)>/gi;
                const matches = Array.from(item.mes.matchAll(regex));
                if (matches.length > 0) {
                    // 取最后一个匹配的捕获组
                    return matches[matches.length - 1][1].trim();
                } else {
                    return item.mes;
                }
            });
        historyData.前文 = tail.join('\n');
    } else {
        historyData.前文 = "";
    }
    $("#token-count").prop("textContent", "4");
    let tokenCount = await getTokenCountAsync(JSON.stringify(historyData) + JSON.stringify(characterData));
    // 超限裁剪：剪故事历程；故事历程已空仍超限则停止（硬停守卫，旧代码会无限循环）
    while (tokenCount > extension_settings[extensionName].tokenLimit && historyData.故事历程 && historyData.故事历程.length > 0) {
        historyData.故事历程 = historyData.故事历程.slice(Math.floor(historyData.故事历程.length / 50));
        tokenCount = await getTokenCountAsync(JSON.stringify(historyData) + JSON.stringify(characterData));
        console.warn("[Chat History Optimization] Summary info is too large, reduce message to count.", tokenCount);
    }
    if (tokenCount > extension_settings[extensionName].tokenLimit) {
        console.warn("[Chat History Optimization] Summary info still exceeds token limit after trimming history.");
    }

    $("#token-count").prop("textContent", `${tokenCount}`);
    console.log("[Chat History Optimization] token count:", tokenCount);
    if (historyData && historyData.天数) {
        historyData.故事历程 = JSON.parse(convertDayReferences(JSON.stringify(historyData.故事历程), historyData.天数));
        if (historyData.故事历程总结) {
            historyData.故事历程总结 = JSON.parse(convertDayReferences(JSON.stringify(historyData.故事历程总结), historyData.天数));
        }
    }

    const mergedChat = [];
    chat[chat.length - 1]['mes'] = getCharPrompt(historyData, characterData);
    if (isFirstMessage) {
        chat[chat.length - 1]['mes'] = chat[chat.length - 1]['mes'] + "\n（此为首条信息，<NEW_STORY_DATA>中需要参考前文和当前输出的信息生成全量信息，尤其注意'故事历程'需额外添加前文的历程）";
    }
    mergedChat.push(chat[chat.length - 1])

    // 用 mergedChat 替换 chat 的内容
    chat.length = 0;
    for (const item of mergedChat) {
        chat.push(item);
    }
    console.log("[Chat History Optimization] new chat history:", chat);
}
```

- [ ] **Step 6: nameMapping 重命名迁移 + 移除 json_template 别名**

**6a.** 旧 `mergeDataInfo` 里的 nameMapping 循环（原 346-350 行）迁移到新 `mergeDataInfo` 的 NEW_CHARACTER_CARD 合并成功后（`deepMerge` 那行之后加）：

```js
                                for (const roleName of Object.keys(nameMapping)) {
                                    if (!characterData || !(roleName in characterData)) continue;
                                    characterData[nameMapping[roleName]] = characterData[roleName];
                                    delete characterData[roleName];
                                }
```

**6b.** 全局变量（Task 1 Step 2 处）删除兼容别名：

```js
let history_json_template = null;
let character_json_template = null;
```

**6c.** `onHistoryPromptInput` 中删除两行别名代码（`json_template = history_json_template;` 与 catch 分支里的 `json_template = null;`）。

- [ ] **Step 7: 残留清理与语法核对**

1. 删除 `json_template` 全局后，全文不应再有引用。核对：
```bash
cd "F:\WorkDir\SillyTavern-Launcher\SillyTavern\public\scripts\extensions\third-party\chat-history-optimization"
grep -n "json_template\|ROLE_PLAY\|ROLE_DATA\|<delta>\|roledata_history\|stripRoleCardSection\|charPrompt\|char_prompt" index.js index.html
```
Expected: 无任何输出（`delta` 只允许出现在 postProcessHistory 的剥离正则与尾部截断正则的 `delta` 备选中）
2. 核对失败提示文案含 `NEW_STORY_DATA`（`grep -n "NEW_STORY_DATA" index.js` 应有多处）
3. `node --check index.js` 做语法检查（浏览器外可用的静态检查）：
```bash
node --check index.js
```
Expected: 无输出（语法 OK）。若 node 版本不支持 ES module 语法检查报错，改用手工核对：`grep -n "json_template"` 无残留 + 浏览器加载验证

- [ ] **Step 8: 浏览器全链路验证**

1. 刷新 SillyTavern，生成一次回复：console 里 `new chat history` 最后一条 `mes` 应为新格式 —— 含 `<STORY_DATA>`、`<HISTORY>`（markdown 前文）、`<CHARACTER_CARD>`（角色 JSON）、`<NEW_HISTORY>` 模板、`<NEW_CHARACTER_CARD>` 模板
2. 让 AI 按新格式输出 `<NEW_STORY_DATA>`（含两个区段），再生成一次：`Final Summary Info Pre` 日志中 historyData 应含新的故事历程、characterData 应含角色卡 —— 故事与角色互不串扰
3. 关闭「启用角色卡」再生成：prompt 无 `<CHARACTER_CARD>` 区段与 `<NEW_CHARACTER_CARD>` 模板；角色下拉框「无角色」
4. 打开旧聊天记录（含 `<delta>` 消息）生成：不报错，状态重建，failed floors 计数正常
5. 单条消息缺 NEW_HISTORY：failed floors 显示该楼层号
6. 角色查看器：下拉框列出角色卡，选择后显示信息
7. token 超限（调小 token_limit 为 100 再生成）：故事历程被裁剪；构造超大角色数据（脚本往 characterData 塞大量数据不可行，可在角色卡模板里加大字段）验证不无限循环——观察生成正常结束、console 出现 `still exceeds token limit after trimming history` 告警（仅当角色数据单独超限时）
8. 首条信息（新开对话第一条 user 消息）：mes 末尾追加新格式注释（`<NEW_STORY_DATA>` 字样）

- [ ] **Step 9: Commit**

```bash
git add index.js
git commit -m "refactor: separate story history and character card into dual domains

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: 残留核对、文档更新与回归

**Files:**
- Modify: `CLAUDE.md`（架构描述同步新格式）
- Verify: `index.js`、`index.html`

**Interfaces:**
- Consumes: Task 1、Task 2 产物

- [ ] **Step 1: 全局残留核对**

```bash
cd "F:\WorkDir\SillyTavern-Launcher\SillyTavern\public\scripts\extensions\third-party\chat-history-optimization"
grep -rn "json_template\|ROLE_PLAY\|ROLE_DATA_TEMPLATE\|roledata_history\|stripRoleCardSection\|charPrompt\|char_prompt" index.js index.html docs/
```

Expected: 仅 `docs/` 下旧 spec/plan 文档中出现（历史文档不改）；`index.js`/`index.html` 无输出

- [ ] **Step 2: CLAUDE.md 架构章节更新**

`CLAUDE.md` 中以下小节替换为对应新内容：

**2a.** 「Core Flow」第 2-6 条整体替换：

```markdown
2. **NEW_STORY_DATA parsing**: `mergeDataInfo()` scans every assistant message in `chat` for `<NEW_STORY_DATA>...</NEW_STORY_DATA>` blocks (using regex, stripping `//` comments first; `swipes[swipe_id]` fallback; only the **last** block per message). Within each block it extracts the `<NEW_HISTORY>` and `<NEW_CHARACTER_CARD>` sections separately. Legacy `<delta>` blocks are **not** recognized.
3. **State merging**: NEW_HISTORY JSON merges into `HISTORY_DATA` (story timeline) and NEW_CHARACTER_CARD JSON merges into `CHARACTER_DATA` (character card map) via `deepMerge()`, each validated against its own template (`history_json_template` / `character_json_template`).
4. **Post-processing**: `postProcessHistory()` converts story events (`故事历程`) to a markdown-like `前文` string. `processCharacterData()` evicts/distills character cards (10-slot cap, 30-message inactivity distillation).
5. **History replacement**: The entire chat array is replaced with a single message — the original last message with its `mes` field rewritten to contain the `<STORY_DATA>` prompt wrapping `<HISTORY>` (markdown 前文) and `<CHARACTER_CARD>` (character JSON).
6. **Token enforcement**: If the serialized summary exceeds `tokenLimit`, older story events are thinned by keeping every 50th element until under budget (hard-stop guard: stops when `故事历程` is empty instead of looping forever).
```

**2b.** 「Data Structure (ROLE_DATA)」整节替换：

```markdown
### Data Structure

Two independent domain states, merged and processed separately:

`HISTORY_DATA` — Story timeline:
- `天数`, `日期`, `星期` — Time tracking
- `正文出场或提及到的角色` — Comma-separated role names mentioned in the current text
- `故事历程` — Array of story events, each with `天数`, `时间`, `地点`, `历程` (string or array of strings)
- `故事历程总结` — Alternative/merged story summary (deleted after post-processing into `前文`)
- `前文` — Generated context string (markdown-format story events + tail messages + time anchor)

`CHARACTER_DATA` — Character card map:
- `角色名 → { 角色设定: {...}, 角色状态: {...} }` (no `角色卡` wrapper key — the section is the domain)
- `角色设定` is considered immutable once set (except for `处女` field or `"未知"` values)
- `allowUpdate` — Optional boolean flag in NEW_CHARACTER_CARD JSON to bypass `角色设定` immutability
```

**2c.** 「Key Functions in Detail」中 `deepMerge`、`mergeDataInfo`、`postProcess`、`getCharPrompt`、`checkPath` 五条替换：

```markdown
**`deepMerge(merged, delta, path, allowUpdate, template)`**
Recursively merges `delta` into `merged` with special behaviors:
- **Array + string**: If the string matches `delete N-M`, removes that index range from the array. Used for story event deletion.
- **Array + array**: Deduplicates by `JSON.stringify` comparison before concatenating.
- **`角色设定` protection**: If the path contains `角色设定`, existing string values are NOT overwritten (unless the existing value is `"未知"`, the key is `处女`, or `allowUpdate` is true).
- **Unknown key guard**: Only keys that pass `checkPath(path, template)` (against the domain's own template) are added; unknown keys are warned and skipped.
- **Empty value cleanup**: Keys set to `""` are deleted from the object.

**`mergeDataInfo(chat)`**
Scans `chat[1..]` for assistant messages containing `<NEW_STORY_DATA>` blocks, extracting `<NEW_HISTORY>` (mandatory — missing counts as a failed floor) and `<NEW_CHARACTER_CARD>` (optional — legitimately absent when no new characters appear or the role card toggle is off) sections. Returns `{ historyData, characterData }`. Applies `nameMapping` to normalize character names in the character domain. Does **not** recognize legacy `<delta>` blocks.

**`postProcessHistory(data)`**
Converts `故事历程` array to markdown `前文` string via `arrayToMarkdown()`, appending existing `前文` if any. Deletes `故事历程` and `故事历程总结` after conversion. Strips any remaining `<NEW_STORY_DATA>`/`<delta>` tags from `前文`, appends the day-conversion anchor table.

**`processCharacterData(characterData, chat, nameMapping)`**
Evicts/distills the character card map: 10-slot cap, current-prompt-mention priority (score 1,000,000), >30-message inactivity → keep only `角色设定`. Returns the trimmed map.

**`getCharPrompt(historyData, characterData)`**
Wraps the processed domains in a `<STORY_DATA>` prompt with `<HISTORY>` (markdown) and `<CHARACTER_CARD>` (JSON) sections, instructing the AI to output `<NEW_STORY_DATA>` (with `<NEW_HISTORY>` and `<NEW_CHARACTER_CARD>` sub-sections) in its reply. When the role card toggle is off, the `<CHARACTER_CARD>` section and `<NEW_CHARACTER_CARD>` template are omitted.

**`checkPath(path, template)`**
Validates that a JSON key path exists in the given domain template (`history_json_template` or `character_json_template`), supporting `{{placeholder}}` dynamic keys. Returns `true` if the path is valid (including the special `故事历程总结` path). This prevents arbitrary keys from being injected into the merged state.
```

**2d.** 「Settings」小节 `charPrompt` 行替换：

```markdown
- `historyPrompt` / `characterPrompt` — Two independent JSON templates (story timeline / character card), each stored as raw text with `//` comments; validated on input by stripping comments and attempting `JSON.parse`
```

**2e.** 「Edge Cases & Gotchas」两条替换：

```markdown
- **`<NEW_STORY_DATA>` parsing**: Regex strips `//` comments before matching. If no match in `mes`, falls back to `swipes[swipe_id]`. Only the **last** block per message. Legacy `<delta>` blocks are ignored.
- **`前文` from tail messages**: When extracting the last N assistant messages for `前文`, only the text between `</think>`/`</thinking>` and `<post_thinking>`/`<delta>`/`<NEW_STORY_DATA>` is kept (the "post-thinking" visible reply).
```

（「Character Card Eviction Strategy」「Name Alias Resolution」「Token Trimming Algorithm」「First Message Detection」「Word Mapping」小节保持不变——逻辑未变。CLAUDE.md 其他无关小节不动。）

- [ ] **Step 3: 回归浏览器验证**

重复 Task 2 Step 8 的 1、2、3、6 条（默认生成、状态累积、角色卡开关、角色查看器），确认重构后整体稳定。

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for dual-domain story/rolecard architecture

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Self-Review 记录

- **Spec 覆盖**：设置层拆分（Task 1）✓；解析重写含双区段/allowUpdate/失败语义/旧 delta 忽略（Task 2 Step 3）✓；deepMerge/checkPath 模板参数化（Task 2 Step 1-2）✓；postProcess 分域（Task 2 Step 4a）✓；getCharPrompt 新字面量+开关条件（Task 2 Step 4b）✓；角色淘汰/蒸馏提取（Task 2 Step 5a）✓；replaceChatHistoryWithDetails 重排+token 硬停守卫（Task 2 Step 5b）✓；roledata_history 移除（Task 2 Step 3）✓；stripRoleCardSection 删除（Task 2 Step 4c）✓；CLAUDE.md 更新（Task 3）✓；边界情况全部进入 node/浏览器验证步骤 ✓
- **占位符扫描**：无 TBD/TODO；所有代码步骤含完整代码或精确替换文本；所有验证步骤含具体命令与预期输出
- **类型一致性**：`checkPath(path, template)`、`deepMerge(..., template)` 在 Task 2 Step 1-3 签名一致；`mergeDataInfo` 返回 `{historyData, characterData}` 与 Step 5b 消费方一致；`processCharacterData(characterData, chat, nameMapping)` 与 `postProcessHistory(data)` 定义与调用签名一致；`getCharPrompt(historyData, characterData)` 在 Step 4b 定义、Step 5b 调用，参数一致；设置键 `historyPrompt`/`characterPrompt` 在 Task 1 定义、Task 2 Step 4b 的 `$("#history_prompt_textarea").val()` 消费一致
- **过渡期说明**：Task 1 结束时旧管线以 json_template 别名运行（故事可合并、角色卡暂缺、`<ROLE_DATA_TEMPLATE>` 显示 undefined），Task 2 Step 6 移除别名——中间状态有文档说明，且实现发生在同一会话内，用户不会在 Task 1 与 Task 2 之间刷新浏览器

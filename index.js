// The main script for the extension
// The following are examples of some basic extension functionality

//You'll likely need to import extension_settings, getContext, and loadExtensionSettings from extensions.js
import { extension_settings, getContext, loadExtensionSettings } from "../../../extensions.js";
import { getTokenCountAsync } from '../../../tokenizers.js';
//You'll likely need to import some other functions from the main script
import { saveSettingsDebounced, this_chid, characters } from "../../../../script.js";

const context = SillyTavern.getContext();

let json_template = null;

// Keep track of where your extension is located, name should match repo name
const extensionName = "chat-history-optimization";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
const defaultSettings = {
    extensionToggle: false,
    keepCount: 3,
    tokenLimit: 50 * 1024,
    charPrompt: `{
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
    ],
    "角色卡": { // **仅新角色出现时输出**
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
    }
}`,
};

const wordMapping = {
    "崩溃": "恐惧",
    "绝望": "害怕",
    "空洞": "迷离",
    "麻木": "挣扎",
    "认命": "求生欲",
    "极端": "有些",
    "扭曲": "抵触",
    "神圣": "重要",
    "学术": ""
}

let nameMapping = {};
let keepMessageCount = 0;

function printObj(comment, obj) {
    console.log(`[${comment}]`, JSON.parse(JSON.stringify(obj, null, 2)));
}

// Loads the extension settings if they exist, otherwise initializes them to the defaults.
async function loadSettings() {
    //Create the settings if they don't exist
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    // Updating settings in the UI
    $("#extension_toggle").prop("checked", extension_settings[extensionName].extensionToggle ?? defaultSettings.extensionToggle).trigger("input");
    $("#keep_count").prop("value", extension_settings[extensionName].keepCount ?? defaultSettings.keepCount).trigger("input");
    // 加载 charPrompt 到 textarea
    $("#char_prompt_textarea").prop("value", extension_settings[extensionName].charPrompt ?? defaultSettings.charPrompt).trigger("input");
    $("#token_limit").prop("value", extension_settings[extensionName].tokenLimit ?? defaultSettings.tokenLimit).trigger("input");
}

function onToggleInput(event) {
    const value = Boolean($(event.target).prop("checked"));
    extension_settings[extensionName].extensionToggle = value;
    saveSettingsDebounced();
}

function onTokenLimitInput(event) {
    const value = parseInt($(event.target).prop("value"));
    extension_settings[extensionName].tokenLimit = value;
    saveSettingsDebounced();
}

function onKeepCountInput(event) {
    const value = parseInt($(event.target).prop("value"));
    extension_settings[extensionName].keepCount = value;
    saveSettingsDebounced();
}

function onCharPromptInput(event) {
    let val = $(event.target).val();
    // 移除//开头的注释
    let jsonStr = val.replace(/\/\/.*$/gm, '');
    let isValid = false;
    try {
        json_template = JSON.parse(jsonStr);
        printObj("[Chat History Optimization] Loaded char prompt template", json_template);
        isValid = true;
    } catch (e) {
        console.error(`[Chat History Optimization] JSON parse error`, jsonStr, e);
        json_template = null;
        isValid = false;
    }
    // 设置 index.html 选中区标签内容
    $("#char_prompt_validity").text(isValid ? "(有效)" : "(无效)");
    extension_settings[extensionName].charPrompt = val;
    saveSettingsDebounced();
}

function checkPath(path) {
    let current = json_template;
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

function deepMerge(merged, delta, path = [], allowUpdate = false) {
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
            merged[key] = deepMerge(merged[key], delta[key], path.concat(key), allowUpdate);
        } else if (checkPath(path.concat(key))) {
            if (Array.isArray(delta[key])) {
                merged[key] = deepMerge([], delta[key], path.concat(key), allowUpdate);
            } else if (typeof delta[key] === 'object') {
                merged[key] = deepMerge({}, delta[key], path.concat(key), allowUpdate);
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

function mergeDataInfo(chat) {
    let failedChars = [];
    let mergedRoleData = {};
    let mergedRoleDataHistory = {};

    for (let j = 1; j < chat.length; j++) {
        const item = chat[j];
        if (item && (("is_user" in item && !item.is_user) || (item.role && item.role == "assistant"))) {
            let matches = [];
            if (item.mes) {
                matches = [...item.mes
                    .replace(/\/\/.*$/gm, '')
                    .matchAll(/<delta>((?:(?!<delta>)[\s\S])*?)<\/delta>/gi)];
            }
            if (matches.length == 0 && ("swipes" in item && "swipe_id" in item && item.swipes[item.swipe_id])) {
                matches = [...item.swipes[item.swipe_id]
                    .replace(/\/\/.*$/gm, '')
                    .matchAll(/<delta>((?:(?!<delta>)[\s\S])*?)<\/delta>/gi)];
            }
            if (matches.length > 0) {
                let jsonStr = matches[matches.length - 1][1].trim();
                try {
                    const objMatch = jsonStr.match(/\{[\s\S]*\}/);
                    if (!objMatch) {
                        failedChars.push(j);
                        continue;
                    }
                    const itemObj = JSON.parse(objMatch[0]);
                    item.messageCount = 0;
                    if (itemObj.故事历程) {
                        item.messageCount = itemObj.故事历程.length;
                    }
                    let allowUpdate = itemObj.allowUpdate || false;
                    mergedRoleData = deepMerge(mergedRoleData, itemObj, [], allowUpdate);
                    for (const roleName of Object.keys(nameMapping)) {
                        if (!mergedRoleData.角色卡 || !(roleName in mergedRoleData.角色卡)) continue;
                        mergedRoleData.角色卡[nameMapping[roleName]] = mergedRoleData.角色卡[roleName];
                        delete mergedRoleData.角色卡[roleName];
                    }
                    mergedRoleDataHistory[j] = JSON.parse(JSON.stringify(mergedRoleData));
                } catch (e) {
                    console.error(`[Chat History Optimization] delta JSON parse error at chat[${j}]:`, e);
                    failedChars.push(j);
                }
            } else if (mergedRoleData) {
                failedChars.push(j);
            }
        }
    }

    if (failedChars.length > 0) {
        console.warn(`[Chat History Optimization] Failed to parse or missing <delta> at chat indexes: ${failedChars.join(', ')}`);
        $("#chars-failed").prop("textContent", failedChars.join(', '));
    } else {
        $("#chars-failed").prop("textContent", "无");
    }

    return {
        "roledata": mergedRoleData,
        "roledata_history": mergedRoleDataHistory
    };
}

function convertDayReferences(text, currentDayOverride) {
    return text;
    if (typeof text !== 'string' || text.length === 0) return text;

    // currentDayOverride 一定是 "第X天" 形式的字符串，直接提取数字
    const m = String(currentDayOverride).match(/第\s*(\d+)\s*天/);
    const X = m ? parseInt(m[1], 10) : null;
    if (!Number.isFinite(X) || X <= 1) return text;

    let out = text;
    // 从第1天到第X-1天，分别替换为 (X - n)天前
    for (let n = 1; n < X; n++) {
        const daysAgo = X - n;
        const re = new RegExp(`第\\s*${n}\\s*天`, 'g');
        out = out.replace(re, `${daysAgo}天前`);
    }
    return out;
}

function arrayToMarkdown(data, n = 0) {
    // 计算需要处理的数据范围（排除最后n个元素）
    const endIndex = n > 0 ? data.length - n : data.length;
    const processedData = data.slice(0, endIndex);

    return processedData.map(item => {
        // 构建第一行：[天数|时间|地点]
        const header = `[${item.天数}|${item.时间}|${item.地点}]`;

        // 构建第二行：历程数组拼接
        let process = '';
        if (Array.isArray(item.历程)) {
            process = item.历程
                .map(entry => {
                    let s = entry == null ? '' : String(entry).trim();
                    if (s === '') return '';
                    // 如果不是以中文句号或英文句号结尾，则追加中文句号
                    if (!(/[。\.]$/.test(s))) s += '。';
                    return s;
                })
                .join('');
        } else if (typeof item.历程 === 'string') {
            let s = item.历程.trim();
            if (s !== '' && !(/[。\.]$/.test(s))) s += '。';
            process = s;
        }

        // 组合成完整的两行格式
        return `${header.trim()}\n${process.trim()}`;
    }).join('\n');
}

function postProcess(data) {
    if (data && data.故事历程 && Array.isArray(data.故事历程)) {
        data.前文 = arrayToMarkdown(data.故事历程, keepMessageCount) + '\n' + (data.前文 || '');
        data.故事历程 = [];
    }
    if (data && data.故事历程总结 && Array.isArray(data.故事历程总结)) {
        data.前文 = arrayToMarkdown(data.故事历程总结, 0) + '\n' + (data.前文 || '');
        delete data.故事历程总结;
    }
    data.前文 = data.前文.replace(/<delta>((?:(?!<delta>)[\s\S])*?)<\/delta>/gi, '').trim();
    printObj("[Chat History Optimization] Post Processed 前文", data.前文);
    const { 前文, ...rest } = data;
    return { 前文, ...rest };
}

function getCharPrompt(mergedDataInfo) {
    mergedDataInfo.roledata = postProcess(mergedDataInfo.roledata || {});
    let charsInfoJsonStr = JSON.stringify(mergedDataInfo.roledata || {});
    for (const [key, value] of Object.entries(wordMapping)) {
        charsInfoJsonStr = charsInfoJsonStr.replace(new RegExp(key, 'g'), value);
    }

    const prompt = `
<ROLE_PLAY>

<ROLE_DATA>
${charsInfoJsonStr}
</ROLE_DATA>
<ROLE_DATA_TEMPLATE> // **ROLE_DATA的字段指引模板**
${$("#char_prompt_textarea").val()}
</ROLE_DATA_TEMPLATE>
------
**在回复最末尾必须生成<delta>信息，确保输出为有效JSON。**
<delta>
//......
</delta>

</ROLE_PLAY>
`
    return prompt;
}

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
    let finalRoleDataInfo = mergedDataInfo.roledata || {};

    // 处理角色别名信息
    if (finalRoleDataInfo && finalRoleDataInfo.角色卡 && typeof finalRoleDataInfo.角色卡 === 'object') {
        for (const roleName of Object.keys(finalRoleDataInfo.角色卡)) {
            if (finalRoleDataInfo.角色卡[roleName] && finalRoleDataInfo.角色卡[roleName].角色设定 && finalRoleDataInfo.角色卡[roleName].角色设定.角色名 && roleName !== finalRoleDataInfo.角色卡[roleName].角色设定.角色名) {
                nameMapping[roleName] = finalRoleDataInfo.角色卡[roleName].角色设定.角色名;
            }
        }
    }

    // 更新角色下拉框和信息显示
    if (finalRoleDataInfo.角色卡 && typeof finalRoleDataInfo.角色卡 === 'object') {
        globalThis.updateRoleSelectAndInfo(JSON.parse(JSON.stringify(finalRoleDataInfo.角色卡)));
    } else {
        globalThis.updateRoleSelectAndInfo({});
    }
    const tokenCount_origin = await getTokenCountAsync(JSON.stringify(finalRoleDataInfo));
    console.log("[Chat History Optimization] origin token count:", tokenCount_origin);
    printObj("[Chat History Optimization] Final Summary Info Pre", finalRoleDataInfo);
    $("#token-count").prop("textContent", "1");
    // --- 优化后的角色卡管理：固定 10 槽位上限 ---
    if (finalRoleDataInfo && finalRoleDataInfo.角色卡 && typeof finalRoleDataInfo.角色卡 === 'object') {
        const MAX_SLOTS = 10;
        const roleScores = [];
        const userPrompt = chat[chat.length - 1]?.mes || "";
        const roleNames = Object.keys(finalRoleDataInfo.角色卡);

        for (const roleName of roleNames) {
            const realName = nameMapping[roleName] || roleName;
            let score = -1;

            // 1. 意图驱动：如果最新 Prompt 提到了，给予极高优先级（确保唤醒）
            if (userPrompt.includes(roleName) || (realName && userPrompt.includes(realName))) {
                score = 1000000;
            } else {
                // 2. 活跃度：寻找最后一次出现的索引作为基础分
                for (let i = chat.length - 1; i >= 0; i--) {
                    const mes = chat[i].mes || "";
                    if (mes.includes(roleName) || (realName && mes.includes(realName))) {
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
            const originalData = finalRoleDataInfo.角色卡[roleName];

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
        finalRoleDataInfo.角色卡 = newRoleCards;
    }
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
                const regex = /(?:<\/(?:think|thinking)>|^)([\s\S]*?)<(?:post_thinking|delta)>/gi;
                const matches = Array.from(item.mes.matchAll(regex));
                if (matches.length > 0) {
                    // 取最后一个匹配的捕获组
                    return matches[matches.length - 1][1].trim();
                } else {
                    return item.mes;
                }
            });
        finalRoleDataInfo.前文 = tail.join('\n');
    } else {
        finalRoleDataInfo.前文 = "";
    }
    $("#token-count").prop("textContent", "4");
    let tokenCount = await getTokenCountAsync(JSON.stringify(finalRoleDataInfo));
    while (tokenCount > extension_settings[extensionName].tokenLimit) {
        finalRoleDataInfo.故事历程 = finalRoleDataInfo.故事历程.slice(Math.floor(finalRoleDataInfo.故事历程.length / 50));
        tokenCount = await getTokenCountAsync(JSON.stringify(finalRoleDataInfo));
        console.warn("[Chat History Optimization] Summary info is too large, reduce message to count.", tokenCount);
    }

    $("#token-count").prop("textContent", `${tokenCount}`);
    console.log("[Chat History Optimization] token count:", tokenCount);
    if (finalRoleDataInfo && finalRoleDataInfo.天数) {
        finalRoleDataInfo.故事历程 = JSON.parse(convertDayReferences(JSON.stringify(finalRoleDataInfo.故事历程), finalRoleDataInfo.天数));
        if (finalRoleDataInfo.故事历程总结) {
            finalRoleDataInfo.故事历程总结 = JSON.parse(convertDayReferences(JSON.stringify(finalRoleDataInfo.故事历程总结), finalRoleDataInfo.天数));
        }
    }
    mergedDataInfo.roledata = finalRoleDataInfo
    printObj("[Chat History Optimization] Final Summary Info Post", mergedDataInfo);

    const mergedChat = [];
    chat[chat.length - 1]['mes'] = getCharPrompt(mergedDataInfo);
    if (isFirstMessage) {
        chat[chat.length - 1]['mes'] = chat[chat.length - 1]['mes'] + "\n（此为首条信息，<delta>中需要参考`前文`和当前输出的信息生成全量信息，尤其注意'故事历程'需额外添加`前文`的历程）";
    }
    mergedChat.push(chat[chat.length - 1])

    // 用 mergedChat 替换 chat 的内容
    chat.length = 0;
    for (const item of mergedChat) {
        chat.push(item);
    }
    console.log("[Chat History Optimization] new chat history:", chat);
}


// This function is called when the extension is loaded
jQuery(async () => {
    // This is an example of loading HTML from a file
    const settingsHtml = await $.get(`${extensionFolderPath}/index.html`);

    // Append settingsHtml to extensions_settings
    // extension_settings and extensions_settings2 are the left and right columns of the settings menu
    // Left should be extensions that deal with system functions and right should be visual/UI related
    $("#extensions_settings").append(settingsHtml);

    $("#extension_toggle").on("input", onToggleInput);
    $("#keep_count").on("input", onKeepCountInput);
    $("#char_prompt_textarea").on("input", onCharPromptInput);
    $("#token_limit").on("input", onTokenLimitInput);
    $("#char_prompt_reset").on("click", function () {
        // 恢复为默认模板
        $("#char_prompt_textarea").val(defaultSettings.charPrompt).trigger("input");
    });

    // 角色信息显示相关逻辑
    // 用于存储最新的角色卡信息
    let latestRoleCard = {};

    // 渲染角色下拉框
    function renderRoleSelect(roleCardObj) {
        const $select = $("#role_select");
        $select.empty();
        if (!roleCardObj || typeof roleCardObj !== 'object') {
            $select.append('<option value="">无角色</option>');
            return;
        }
        $select.append('<option value="">请选择角色</option>');
        Object.keys(roleCardObj).forEach(roleName => {
            $select.append(`<option value="${roleName}">${roleName}</option>`);
        });
    }

    // 角色信息格式化显示
    function formatRoleInfo(roleObj) {
        if (!roleObj || typeof roleObj !== 'object') return '<span style="color:#888">无信息</span>';
        // 递归格式化为HTML
        function render(obj, indent = 0) {
            let html = '';
            for (const key in obj) {
                if (!obj.hasOwnProperty(key)) continue;
                const value = obj[key];
                const pad = '&nbsp;'.repeat(indent * 2);
                if (typeof value === 'object' && value !== null) {
                    html += `<div>${pad}<b>${key}:</b><div style="margin-left:16px;">${render(value, indent + 1)}</div></div>`;
                } else {
                    html += `<div>${pad}<b>${key}:</b> ${value}</div>`;
                }
            }
            return html;
        }
        return render(roleObj);
    }

    // 监听角色选择变化
    $(document).on('change', '#role_select', function () {
        const selected = $(this).val();
        const $display = $('#role_info_display');
        if (selected && latestRoleCard[selected]) {
            $display.html(formatRoleInfo(latestRoleCard[selected]));
        } else {
            $display.html('<span style="color:#888">请选择角色以查看信息</span>');
        }
    });

    // 提供外部调用以更新角色卡和下拉框
    globalThis.updateRoleSelectAndInfo = function (roleCardObj) {
        latestRoleCard = roleCardObj || {};
        renderRoleSelect(latestRoleCard);
        // 清空显示区
        $('#role_info_display').html('<span style="color:#888">请选择角色以查看信息</span>');
    };

    // Load settings when starting things up (if you have any)
    loadSettings();
});

// The main script for the extension
// The following are examples of some basic extension functionality

//You'll likely need to import extension_settings, getContext, and loadExtensionSettings from extensions.js
import { extension_settings, getContext, loadExtensionSettings } from "../../../extensions.js";
import { getTokenCountAsync } from '../../../tokenizers.js';
//You'll likely need to import some other functions from the main script
import { saveSettingsDebounced, this_chid, characters } from "../../../../script.js";
import { getRegexedString, regex_placement } from '../../../extensions/regex/engine.js';

const context = SillyTavern.getContext();

// Keep track of where your extension is located, name should match repo name
const extensionName = "chat-history-optimization";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
const mergeThreshold = 64 * 1024;
const defaultSettings = {
    extensionToggle: false,
    keepCount: 3,
    charPrompt: `{
    "characters": { // 角色信息记录，包括{{user}}和其他NPC
        "character_name": { // 角色名
            "character_name": "角色名", // 角色唯一标识名称
            "pet_names": ["称呼1", "称呼2"], // 被用过的角色代称
            "seen": ["事物1","事物2"], // 角色看过或接触过的人或者物
            "acquaintance": ["角色1","角色2"], // 角色认识的其它角色
            "personality": "性格",
            "job": "职业",
            "background": "背景故事",
            "appearance": {
                // 外貌特征描述, 格式填充时自选，需提取所有出现的外貌特征描述
                // 1. "部位1":"特征描述"
                // 2. "部位2": {"特征1":"特征描述", "特征2":"特征描述"}
            },
            "body": {
                // 身体特征描述, 格式填充时自选，需提取所有出现的身体部位特征描述
                // 1. "部位1":"特征描述"
                // 2. "部位2": {"特征1":"特征描述", "特征2":"特征描述"}
            },
            "status": "当前状态", // **所有(无论是否在当前回复中出现)**角色都需根据action字段更新status字段，并安排下一步action
            "action": "将要做的事情", // **所有(无论是否在当前回复中出现)**角色都需根据action字段更新status字段，并安排下一步action
            "age": "年龄",
            "clothing": {
                // 着装描述, 格式 "部位":"着装描述"，需提取所有出现的身体部位着装信息
            },
            "misc": { // misc字段记录无预定义字段的重要角色信息, 随当前回复新增/调整，例如是否处女、资金、特殊点数等
                // "信息名":"信息内容" // 例如 "favorite_food": "pizza"
            },
            "items": { // 角色的物品记录，随当前回复增减物品
                // "物品名":{ "count": 1, "desc": "物品描述" }
            },
            "skills": { // 角色的技能记录，随当前回复新增/调整
                // "技能名":{ "level": 1, "desc": "技能的功能描述" }
            },
            "relationships": { // 角色与其他角色的关系记录，随当前回复新增/调整
                // "其他角色": "关系描述" // 关系描述格式为"对<其他角色> 情感:[类型]，强度:[高/中/低]，表现:[具体行为]"
            },
            "stories": [ // 角色事件记录，只输出当前回复的事件信息，不要带入之前信息
                // 格式: "日期[日期(记录世界观下当前日期,如无日期信息,则从第1天开始)] 时间[时间(可选)] 地点[地点(用.分隔大小地点，如“图书馆.三楼.阅览室”、“酒馆.二楼.卫生间”)] 其他相关角色[在场的其他相关角色(如果有,多人用逗号分隔)] [10个字内的事件精确简述]"
                // 示例: "日期[2023-10-01] 地点[图书馆] 其他相关角色[Alice,Bob] [读书]"
            ]
        }
        // ... 其他人物信息
    },
    "quests": { // 任务记录数组，抽取当前回复中的明示或暗示的任务信息，随当前回复新增/调整
        "任务名": {
            "publisher": "发布者", // 发布任务的角色名
            "receivers": "接受者", // 接受任务的角色名
            "name": "任务名",
            "status": "进行中/已完成", // 任务状态
            "requirements": "完整未删减的任务要求", // 保留原始任务要求描述
            "reward": "任务奖励" // 任务奖励描述
            // ... 其他任务信息
        }
        // ... 其他任务
    },
    "locations": { // 地点记录数组，抽取当前回复中的地点信息，随当前回复新增/调整
        "地点(用.分隔大小地点，如“图书馆.三楼.阅览室”、“酒馆.二楼.卫生间”)": "地点描述" // 地点描述仅描写[地点]的永久性物理特征（景物/建筑/材质/光照/气味/风化痕迹）。禁止任何动态过程（声音/天气/生物活动/事件）。示例：「青铜神像表面覆满绿锈，砂岩台阶被千年风蚀成波浪状，裂缝中的枯藤如铁铸般凝固。」
    },
    "extra_informations": [ // extra_informations记录无预定义字段的重要全局信息, 随当前回复新增/调整，例如奖励条款（赏金/物品/经验值）、 规则警示（禁令/惩罚/限制）、关键线索（谜题提示/地点解锁）、时效信息（限时事件/倒计时）等
        //格式："日期[日期(记录世界观下当前日期,如无日期信息,则从第1天开始)] 时间[时间(可选)] 地点[地点(用.分隔大小地点，如“图书馆.三楼.阅览室”、“酒馆.二楼.卫生间”)] 人物[与信息有关的角色(多人用逗号分隔)] [核心短语（20字内精炼）]"
        //示例: "日期[2023-10-01] 地点[某虚拟游戏空间] 人物[Alice,Bob,{{user}}] [服务器将在10月5日进行维护，请提前做好准备。]"
    ]
}`,
};

// Loads the extension settings if they exist, otherwise initializes them to the defaults.
async function loadSettings() {
    //Create the settings if they don't exist
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    console.warn("extension_settings[extensionName] 1", extension_settings[extensionName]);
    if (Object.keys(extension_settings[extensionName]).length === 0 || !Object.keys(defaultSettings).every(key => key in extension_settings[extensionName])) {
        Object.assign(extension_settings[extensionName], defaultSettings);
    }
    console.warn("extension_settings[extensionName] 2", extension_settings[extensionName]);
    // Updating settings in the UI
    $("#extension_toggle").prop("checked", extension_settings[extensionName].extensionToggle).trigger("input");
    $("#keep_count").prop("value", extension_settings[extensionName].keepCount).trigger("input");
    // 加载 charPrompt 到 textarea
    $("#char_prompt_textarea").prop("value", extension_settings[extensionName].charPrompt).trigger("input");
}

function onToggleInput(event) {
    const value = Boolean($(event.target).prop("checked"));
    extension_settings[extensionName].extensionToggle = value;
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
        JSON.parse(jsonStr);
        isValid = true;
    } catch (e) {
        console.error(`[Chat History Optimization] JSON parse error`, jsonStr, e);
        isValid = false;
    }
    // 设置 index.html 选中区标签内容
    $("#char_prompt_validity").text(isValid ? "(有效)" : "(无效)");
    extension_settings[extensionName].charPrompt = val;
    saveSettingsDebounced();
}

function deepMerge(target, source) {
    if (Array.isArray(target) && Array.isArray(source)) {
        return target.concat(source);
    }
    if (typeof target !== 'object' || target === null) return source;
    if (typeof source !== 'object' || source === null) return target;
    const result = { ...target };
    for (const key of Object.keys(source)) {
        if (key in target) {
            result[key] = deepMerge(target[key], source[key]);
        } else {
            result[key] = source[key];
        }
    }
    return result;
}

function mergeSummaryInfo(chat) {
    let failedChars = [];
    let mergedObj = {};

    for (let j = 1; j < chat.length; j++) {
        const item = chat[j];
        if (item && !item.is_user && item.swipes && item.swipes[item.swipe_id]) {
            const swipeContent = item.swipes[item.swipe_id];
            const matches = [...swipeContent
                .replace(/\/\/.*$/gm, '')
                .matchAll(/<message_summary>((?:(?!<message_summary>)[\s\S])*?)<\/message_summary>/gi)];
            if (matches.length > 0) {
                let jsonStr = matches[matches.length - 1][1].trim();
                try {
                    const objMatch = jsonStr.match(/\{[\s\S]*\}/);
                    if (!objMatch) {
                        failedChars.push(j);
                        continue;
                    }
                    const itemObj = JSON.parse(objMatch[0]);
                    mergedObj = deepMerge(mergedObj, itemObj);
                } catch (e) {
                    console.error(`[Chat History Optimization] JSON parse error at chat[${j}]:`, e);
                    failedChars.push(j);
                }
            } else {
                failedChars.push(j);
            }
        }
    }

    if (failedChars.length > 0) {
        console.warn(`[Chat History Optimization] Failed to parse or missing <characters> at chat indexes: ${failedChars.join(', ')}`);
        $("#chars-failed").prop("textContent", failedChars.join(', '));
    } else {
        $("#chars-failed").prop("textContent", "无");
    }

    return mergedObj;
}

function getCharPrompt() {
    // 获取 textarea 的内容作为 charPrompt
    return `
<ROLE_DATA_FILL>
额外要求:在回复末尾生成<message_summary>信息,用注释包裹:
<!--
// 以JSON格式提取当前回复的信息，输出与<ROLE_DATA_UPDATE>的差异item，无变化的field无需输出，确保输出的JSON格式正确。
<message_summary>
${$("#char_prompt_textarea").val()}
</message_summary>
-->
</ROLE_DATA_FILL>`;
}

globalThis.replaceChatHistoryWithDetails = async function (chat, contextSize, abort, type) {
    if (!extension_settings[extensionName].extensionToggle) {
        console.info("[Chat History Optimization] extension is disabled.")
        return;
    }

    // 用 textarea 的内容作为 charPrompt
    chat[chat.length - 1]['mes'] = "用户输入:" + chat[chat.length - 1]['mes'] + "\n\n" + getCharPrompt();
    const summaryInfo = mergeSummaryInfo(chat);
    console.log("[Chat History Optimization] characters info:", summaryInfo);

    const mergedChat = [];

    // 保留第一条assistant消息
    let firstAssistantIdx = chat.findIndex(item => !item.is_user);
    const assistantName = chat[firstAssistantIdx].name || "Unknown";
    if (firstAssistantIdx !== -1) {
        mergedChat.push(chat[firstAssistantIdx]);
    }

    let finalSummaryInfo = summaryInfo;
    let tokenCount = await getTokenCountAsync(JSON.stringify(finalSummaryInfo, null, 2));
    while (tokenCount > mergeThreshold) {
        finalSummaryInfo.events = finalSummaryInfo.events.slice(Math.floor(finalSummaryInfo.events.length / 6));
        tokenCount = await getTokenCountAsync(JSON.stringify(finalSummaryInfo, null, 2));
        console.warn("[Chat History Optimization] Summary info is too large, reduce message to count.", tokenCount);
    }
    // charsInfo 转为 json 文本，作为一条 assistant 消消息加入
    if (finalSummaryInfo && Object.keys(finalSummaryInfo).length > 0) {
        const charsInfoJsonStr = JSON.stringify(finalSummaryInfo, null, 2);
        // 动态生成 summary keys string
        const summaryKeysStr = Object.keys(finalSummaryInfo).join('&');
        const charsInfoNotify = {
            is_user: false,
            name: assistantName,
            send_date: Date.now(),
            mes: `
    # 载入下方记录${summaryKeysStr}的JSON对象，更新${summaryKeysStr}信息。
    生成回复的内容需参考<ROLE_DATA_UPDATE>的信息，不可与<ROLE_DATA_UPDATE>的信息产生冲突。
    ---
    <ROLE_DATA_UPDATE>
    ${charsInfoJsonStr}
    </ROLE_DATA_UPDATE>
    `
        };
        mergedChat.push(charsInfoNotify);
    }

    // 保留倒数第 keepCount 条 assistant 消息及其后的所有信息
    let assistantIdxArr = [];
    for (let i = 1; i < chat.length; i++) {
        if (!chat[i].is_user) assistantIdxArr.push(i);
    }
    let keepCount = extension_settings[extensionName].keepCount;
    if (typeof keepCount !== 'number' || isNaN(keepCount)) keepCount = defaultSettings.keepCount;
    const firstUserIdx = chat.findIndex(item => item.is_user);
    let startIdx;
    if (assistantIdxArr.length === 0 || keepCount == 0) {
        startIdx = chat.length;
    } else if (assistantIdxArr.length >= keepCount) {
        startIdx = assistantIdxArr[assistantIdxArr.length - keepCount];
    } else {
        startIdx = assistantIdxArr[0];
    }
    if (firstUserIdx > 0) {
        startIdx = Math.max(startIdx, firstUserIdx + 1);
    }
    let tail = [];
    if (startIdx < chat.length) {
        // 从startIdx-1开始保留到结尾
        tail = chat.slice(startIdx - 1).filter(item => item && item.is_user === false);
    }
    mergedChat.push(...tail);
    mergedChat.push(chat[chat.length - 1])

    // 用 mergedChat 替换 chat 的内容
    chat.length = 0;
    let chatHistory = "";
    for (const item of mergedChat) {
        chat.push(item);
        chatHistory += item.mes + "\n";
    }

    // 计算 token 数量
    $("#token-count").prop("textContent", `${tokenCount}`);
    console.log("[Chat History Optimization] token count:", tokenCount);

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
    $("#char_prompt_reset").on("click", function () {
        // 恢复为默认模板
        $("#char_prompt_textarea").val(defaultSettings.charPrompt).trigger("input");
    });

    // Load settings when starting things up (if you have any)
    loadSettings();
});

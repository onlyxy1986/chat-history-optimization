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
            "pet_names": ["称呼1", "称呼2"], // 旁人如何称呼此角色?
            "seen": ["事物1","事物2"], // 角色看到或者接触的人或者物
            "acquaintance": ["角色1","角色2"], // 角色见过|对话过|合作过的其它角色
            "personality": "人物性格",
            "job": "职业",
            "background": "背景故事",
            "appearance": "外貌",
            "body": "身高,体重,罩杯,三围",
            "status": "当前状态", // **所有(无论是否在当前回复中出现)**角色都需根据action字段更新status字段，并安排下一步action
            "action": "将要做的事情", // **所有(无论是否在当前回复中出现)**角色都需根据action字段更新status字段，并安排下一步action
            "age": "年龄",
            "clothing": "当前着装",
            "misc": { // 有重要信息但没定义field? 记录在misc里, 随当前回复新增/调整，例如是否处女、资金、特殊点数等
                // "信息名":"信息内容" // 例如 "favorite_food": "pizza"
            },
            "items": { // 角色的物品记录，随当前回复增减物品
                // "物品名":{ "count": 1, "desc": "物品描述" }
            },
            "skills": { // 角色的技能记录，随当前回复新增/调整
                // "技能名":{ "level": 1, "desc": "技能的功能描述" }
            },
            "relationships": { // 角色与旁人关系记录，随当前回复新增/调整
                // "角色名": { "relationship": "关系描述"} // 关系描述，例如"[角色名]的恋人，好感度60"，"[角色名]的仆人，臣服度100"
            },
            "stories": [ // 角色事件记录，只输出当前回复的事件信息，不要带入之前信息
                // "日期:[日期] 地点:[地点] 在场人物:[一起行动的人(如果有,多人用逗号分隔)] [6个字内的事件精确简述]" // 例如 "日期:[2023-10-01] 地点:[图书馆] 在场人物:[Alice,Bob] [读书]"
            ]
        }
        // ... 其他人物信息
    },
    "tasks": { // 任务记录数组，随当前回复新增/调整
        "任务名": {
            "publisher": "发布者", // 发布任务的角色名
            "receivers": "接受者", // 接受任务的角色名
            "name": "任务名",
            "status": "进行中/已完成", // 任务状态
            "requirements": "完整未删减的任务要求", // 保留原始任务要求描述
            "reward": "任务奖励" // 任务奖励描述
        }
        // ... 其他任务
    },
    "events": [ // 历史信息记录, 只输出当前消息的事件信息，不要带入已存在信息
        {
            "date": "世界观当前日期", // 记录世界观下当前日期,如无日期信息,则从第1天开始
            "timestamp": "HH:mm (可选)", // 事件发生时间（可选）
            "participants": ["角色名1", "角色名2"], // 相关人员名字的数组
            "location": "地点名称", // 事件发生的地点，用.分隔大小地点，如“图书馆.三楼.阅览室”、“酒馆.二楼.卫生间”等
            "summary": "当前信息描述,原样保留数值信息，其余内容需精简且无歧义。"
        }
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
额外要求:在回复末尾生成本条信息,用注释包裹:
<!--
// 对当前正文的信息提取(JSON格式),输出与<ROLE_DATA_UPDATE>的差异item，无变化的field无需输出，确保输出的JSON格式正确。
<message_summary>
${$("#char_prompt_textarea").val()}
</message_summary>
-->
`;
}

function mergeEvents(events) {
    if (!Array.isArray(events) || events.length === 0) return [];

    const merged = [];
    let prev = null;

    for (const curr of events) {
        if (
            prev &&
            prev.date === curr.date &&
            prev.location === curr.location
        ) {
            // 合并participants并去重
            prev.participants = Array.from(new Set([...prev.participants, ...curr.participants]));
            // 合并timestamp为区间
            if (typeof prev.timestamp === 'object' && prev.timestamp.start && prev.timestamp.end) {
                prev.timestamp.end = curr.timestamp && curr.timestamp.end ? curr.timestamp.end : curr.timestamp;
            } else {
                prev.timestamp = {
                    start: prev.timestamp && prev.timestamp.start ? prev.timestamp.start : prev.timestamp,
                    end: curr.timestamp && curr.timestamp.end ? curr.timestamp.end : curr.timestamp
                };
            }
            // 拼接summary
            prev.summary = (prev.summary || '') + (curr.summary || '');
        } else {
            if (prev) merged.push(prev);
            prev = {
                date: curr.date,
                timestamp: curr.timestamp && curr.timestamp.start ? { ...curr.timestamp } : { start: curr.timestamp, end: curr.timestamp },
                participants: [...curr.participants],
                location: curr.location,
                summary: curr.summary || ''
            };
        }
    }
    if (prev) merged.push(prev);
    return merged;
}

function filterSummaryInfoByRecent(chat, summaryInfo, keepCount, username) {
    if (keepCount == 0) {
        return summaryInfo;
    }
    const recentCount = keepCount * 2 + 1;
    const startIdx = Math.max(chat.length - recentCount, 0);
    const recentMessages = chat.slice(startIdx).map(item => {
        // 移除 <message_summary>...</message_summary> 内容
        const mes = item.mes || '';
        return mes.replace(/<message_summary>((?:(?!<message_summary>)[\s\S])*?)<\/message_summary>/gi, '');
    }).join(' ');

    // summaryInfo.characters 是对象，key为角色名
    // 过滤events
    const filteredEvents = (summaryInfo.events || []).filter(event => {
        // 参与人名去除括号内容
        const participants = (event.participants || []).map(name => name.replace(/[（(].*?[）)]/g, '').trim());
        let allNames = [];
        for (const roleName of participants) {
            if (roleName === username) continue;
            if (roleName && roleName.trim()) allNames.push(roleName);
            const charObj = summaryInfo.characters && summaryInfo.characters[roleName];
            if (charObj && Array.isArray(charObj.pet_names)) {
                allNames.push(...charObj.pet_names.filter(n => n && n.trim()));
            }
        }
        // 检查角色名或pet_names是否出现在最近消息
        const nameMatched = allNames.some(name => {
            const cleanName = name.replace(/[（(].*?[）)]/g, '').trim();
            return cleanName && recentMessages.includes(cleanName);
        });
        // 检查location是否出现在最近消息
        const locationMatched = event.location && recentMessages.includes(event.location.replace(/[（(].*?[）)]/g, '').trim());
        return nameMatched || locationMatched;
    });

    return {
        ...summaryInfo,
        events: filteredEvents
    };
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
    // 根据 events 生成每个角色的 visitedLocations
    if (finalSummaryInfo && finalSummaryInfo.characters && Array.isArray(finalSummaryInfo.events)) {
        for (const event of finalSummaryInfo.events) {
            if (!event.location || !Array.isArray(event.participants)) continue;
            for (const name in finalSummaryInfo.characters) {
                const charObj = finalSummaryInfo.characters[name];
                // 检查 character_name 或 pet_names 是否出现在 participants 中（均需去除括号内容和trim）
                const allNames = [charObj.character_name, ...(Array.isArray(charObj.pet_names) ? charObj.pet_names : [])]
                    .map(n => n ? n.replace(/[（(].*?[）)]/g, '').trim() : '');
                const cleanParticipants = event.participants.map(p => p ? p.replace(/[（(].*?[）)]/g, '').trim() : '');
                if (allNames.some(n => cleanParticipants.includes(n) && n)) {
                    if (!charObj.visitedLocations) charObj.visitedLocations = [];
                    charObj.visitedLocations.push(event.location);
                }
            }
        }
        // 去重 visitedLocations
        for (const name in finalSummaryInfo.characters) {
            const charObj = finalSummaryInfo.characters[name];
            if (Array.isArray(charObj.visitedLocations)) {
                charObj.visitedLocations = Array.from(new Set(charObj.visitedLocations));
            }
        }
    }

    finalSummaryInfo.events = mergeEvents(finalSummaryInfo.events);
    finalSummaryInfo = filterSummaryInfoByRecent(chat, summaryInfo, extension_settings[extensionName].keepCount, chat[chat.length - 1].name);

    let tokenCount = await getTokenCountAsync(JSON.stringify(finalSummaryInfo, null, 2));
    while (tokenCount > mergeThreshold) {
        finalSummaryInfo.events = finalSummaryInfo.events.slice(Math.floor(finalSummaryInfo.events.length / 6));
        tokenCount = await getTokenCountAsync(JSON.stringify(finalSummaryInfo, null, 2));
        console.warn("[Chat History Optimization] Summary info is too large, reduce message to count.", tokenCount);
    }
    // charsInfo 转为 json 文本，作为一条 assistant 消消息加入
    if (finalSummaryInfo && Object.keys(finalSummaryInfo).length > 0) {
        const charsInfoJsonStr = JSON.stringify(finalSummaryInfo, null, 2);
        const charsInfoNotify = {
            is_user: false,
            name: assistantName,
            send_date: Date.now(),
            mes: `
<ROLE_DATA_UPDATE>
# 载入下方记录角色&任务&事件的JSON对象，更新角色&任务&事件记录。
生成回复时，在<thinking>阶段需先检索ROLE_DATA_UPDATE的内容，在回复中合理体现角色的真实状态和历史。
---
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

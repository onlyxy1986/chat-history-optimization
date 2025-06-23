// The main script for the extension
// The following are examples of some basic extension functionality

//You'll likely need to import extension_settings, getContext, and loadExtensionSettings from extensions.js
import { extension_settings, getContext, loadExtensionSettings } from "../../../extensions.js";
import { getTokenCountAsync } from '../../../tokenizers.js';
//You'll likely need to import some other functions from the main script
import { saveSettingsDebounced } from "../../../../script.js";
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
    "characters": [ // 用数组记录各个角色信息，包括{{user}}和其他NPC
        {
            "character_name": "角色名", // 角色唯一标识名称
            "pet_names": ["称呼1", "称呼2"], // {{user}}对此角色的常用称呼
            "personality": "在此处描述人物性格", // 角色性格特征
            "background": "在此处描述人物背景", // 角色背景故事
            "appearance": "在此处描述外貌", // 角色外貌特征
            "body": "在此描述身材数据", // 具体的身高，体重，罩杯，三围等数据
            "status": "在此处描述当前状态", // 角色当前状态（如情绪、健康、身体情况等）
            "age": "在此处描述年龄", // 角色年龄
            "clothing": "在此处描述当前衣装", // 角色当前衣着
            "voice": "在此处描述声音", // 角色声音特征
            "misc": "在此描述其他特征", // 角色未分类的特征数据
            "notes": "在此处描述其他重要信息", // 角色其他非分类信息,尤其注意数字化信息
            "items": [ // 道具记录，随获得/消耗增减,count为0则删除条目
                // { "item_name": "道具名", "count": 1, "desc": "道具描述" }
            ],
            "skills": [ // 技能记录，随获得/移除增减
                // { "skill_name": "技能名", "level": 1, "desc": "技能描述" }
            ],
            "relationships": { // 关系记录，随时间推移增减
                // "角色名": { "relationship": "关系描述"} // 关系描述和等级
            }
        }
        // ... 其他人物信息
    ],
    "tasks": [ // 任务记录数组，收到任务新增条目，任务已完成则删除条目
        {
            "publisher": "发布者", // 发布任务的角色名
            "receivers": "接受者", // 接受任务的角色名
            "name": "任务名",
            "status": "进行中/已完成", // 任务状态
            "requirements": "完整未删减的任务要求", // 保留原始任务要求描述
            "reward": "任务奖励" // 任务奖励描述
        }
        // ... 其他任务
    ],
    "event": { // 本条消息的事件记录
        "date": "世界观当前日期", // 记录世界观下当前日期,如无日期信息,则从第1天开始
        "timestamp": "HH:mm (可选)", // 事件发生时间（可选）
        "participants": ["角色名1", "角色名2"], // 相关人员名字的数组
        "location": "地点名称", // 事件发生的主要地点
        "location_desc": "地点描述", // 对地点的简要描述（可选）
        "summary": "当前信息描述, 完整保留所有行为主体、核心动作、具体数据（数字/时间/数量等）及硬性要求（步骤/标准/条件等），其余内容需精简且无歧义。"
    }
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

function mergeSummaryInfo(chat) {
    // 记录解析失败或未找到的消息索引
    let failedChars = [];
    // characterMap: { character_name: { pet_names: Set, tasks: [], items: [], [record_date]: { events: [] } } }
    const characterMap = {};
    let latestTasks = [];
    const events = [];

    for (let j = 1; j < chat.length; j++) {
        const item = chat[j];
        if (item && !item.is_user && item.swipes && item.swipes[item.swipe_id]) {
            const swipeContent = item.swipes[item.swipe_id];
            // 去除注释并提取 <message_summary>...</message_summary> 标签内容（不捕获标签本身，忽略嵌套错误）
            const matches = [...swipeContent
                .replace(/\/\/.*$/gm, '')
                .matchAll(/<message_summary>((?:(?!<message_summary>)[\s\S])*?)<\/message_summary>/gi)];
            if (matches.length > 0) {
                let jsonStr = matches[matches.length - 1][1].trim();
                try {
                    // 只提取第一个{...}对象
                    const objMatch = jsonStr.match(/\{[\s\S]*\}/);
                    if (!objMatch) {
                        failedChars.push(j);
                        continue;
                    }
                    const item = JSON.parse(objMatch[0]);
                    // 更新角色信息，id为唯一标识，后出现的覆盖前面的
                    if (Array.isArray(item.characters)) {
                        for (const char of item.characters) {
                            characterMap[char.character_name] = char;
                        }
                    }
                    // 只保留最后一次出现的tasks
                    if (Array.isArray(item.tasks)) {
                        latestTasks = item.tasks;
                    }
                    // 整合event为events数组
                    if (item.event) {
                        if (chat[j - 1].is_user && chat[j - 1].mes) {
                            item.event.user_input = chat[j - 1].mes;
                        }
                        events.push(item.event);
                    }
                } catch (e) {
                    // 非法json直接丢弃并记录
                    console.error(`[Chat History Optimization] JSON parse error at chat[${j}]:`, e);
                    failedChars.push(j);
                }
            } else {
                // 没有找到<message_summary>标签，记录
                failedChars.push(j);
            }
        }
    }

    // 打印log并显示在failed-chars里
    if (failedChars.length > 0) {
        console.warn(`[Chat History Optimization] Failed to parse or missing <characters> at chat indexes: ${failedChars.join(', ')}`);
        $("#chars-failed").prop("textContent", failedChars.join(', '));
    } else {
        $("#chars-failed").prop("textContent", "无");
    }

    return {
        characters: characterMap,
        tasks: latestTasks,
        events_history: events
    };
}

function getCharPrompt() {
    // 获取 textarea 的内容作为 charPrompt
    return `
额外要求:在回复末尾生成本条信息,用注释包裹:
<!--
// 对本条消息的总结(JSON格式),field禁止缺漏,对双引号转义以保证JSON格式正确
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
            // 更新时间范围
            prev.timestamp.end = curr.timestamp;
            // location_desc用最后一个
            prev.location_desc = curr.location_desc;
            // 拼接summary
            prev.summary += curr.summary ? curr.summary : '';
            // user_input丢弃
        } else {
            // 新建一个合并项
            if (prev) merged.push(prev);
            prev = {
                date: curr.date,
                timestamp: { start: curr.timestamp, end: curr.timestamp },
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
    // 过滤events_history
    const filteredEvents = (summaryInfo.events_history || []).filter(event => {
        const participants = event.participants.map(name => name.replace(/[（(].*?[）)]/g, '').trim()) || [];
        let allNames = [];
        for (const roleName of participants) {
            if (roleName === username) continue;
            if (roleName && roleName.trim()) allNames.push(roleName);
            const charObj = summaryInfo.characters[roleName];
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
        events_history: filteredEvents
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

    let finalSummaryInfo = filterSummaryInfoByRecent(chat, summaryInfo, extension_settings[extensionName].keepCount, chat[chat.length - 1].name);
    finalSummaryInfo.events_history = mergeEvents(finalSummaryInfo.events_history);
    let tokenCount = await getTokenCountAsync(JSON.stringify(finalSummaryInfo, null, 2));
    while (tokenCount > mergeThreshold) {
        finalSummaryInfo.events_history = finalSummaryInfo.events_history.slice(Math.floor(finalSummaryInfo.events_history.length / 4));
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
# 已载入下方角色&任务&事件记录JSON对象,角色&任务&事件记录已更新。
生成最新回复时，会优先以角色&任务&事件记录为准，并在回复中合理体现角色的真实状态和历史。
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

    // Load settings when starting things up (if you have any)
    loadSettings();
});


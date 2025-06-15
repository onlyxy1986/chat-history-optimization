// The main script for the extension
// The following are examples of some basic extension functionality

//You'll likely need to import extension_settings, getContext, and loadExtensionSettings from extensions.js
import { extension_settings, getContext, loadExtensionSettings } from "../../../extensions.js";
import { getTokenCountAsync } from '../../../tokenizers.js';
//You'll likely need to import some other functions from the main script
import { saveSettingsDebounced } from "../../../../script.js";

const context = SillyTavern.getContext();

// Keep track of where your extension is located, name should match repo name
const extensionName = "chat-history-optimization";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
const defaultSettings = {
    extensionToggle: false,
    keepCount: 3
};

const removedSections = [
    "think",
    "reason",
    "challenge_to_censorship",
    "guifan",
    "internal_process"
];

// Loads the extension settings if they exist, otherwise initializes them to the defaults.
async function loadSettings() {
    //Create the settings if they don't exist
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    if (Object.keys(extension_settings[extensionName]).length === 0 || !Object.keys(defaultSettings).every(key => key in extension_settings[extensionName])) {
        Object.assign(extension_settings[extensionName], defaultSettings);
    }

    // Updating settings in the UI
    $("#extension_toggle").prop("checked", extension_settings[extensionName].extensionToggle).trigger("input");
    $("#keep_count").prop("value", extension_settings[extensionName].keepCount).trigger("input");
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
            const charMatch = swipeContent
                .replace(/\/\/.*$/gm, '')
                .match(/<message_summary>((?:(?!<message_summary>)[\s\S])*?)<\/message_summary>/i);
            if (charMatch) {
                let jsonStr = charMatch[1].trim();
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
                        events.push(item.event);
                    }
                } catch (e) {
                    // 非法json直接丢弃并记录
                    failedChars.push(j);
                }
            } else {
                // 没有找到<characters>标签，记录
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
        events: events
    };
}

const charPrompt = `
额外要求:在回复末尾生成本条信息,用注释包裹:
<!--
// 对本条消息的总结(JSON格式)
<message_summary>
{
    "characters": [ // 用数组记录各个角色信息，包括{{user}}和其他NPC
        {
            "character_name": "角色名", // 角色唯一标识名称
            "pet_names": ["称呼1", "称呼2", etc…], // {{user}}对此角色的常用称呼
            "personality": "在此处描述人物性格", // 角色性格特征
            "background": "在此处描述人物背景", // 角色背景故事
            "appearance": "在此处描述外貌", // 角色外貌特征
            "status": "在此处描述当前状态", // 角色当前状态（如情绪、健康、身体情况等）
            "age": "在此处描述年龄", // 角色年龄
            "clothing": "在此处描述当前衣装", // 角色当前衣着
            "voice": "在此处描述声音", // 角色声音特征
            "notes": "在此处描述其他重要信息", // 角色其他重要信息
            "items": [ // 道具记录，随获得/消耗增减
                // { "item_name": "道具名", "count": 1, "desc": "道具描述" }
            ]
        },
        // ... 其他人物信息
    ],
    "tasks": [ // 任务记录数组，收到任务新增条目，完成任务删除条目
        {
            "publisher": "发布者", // 发布任务的角色名
            "receivers": "接受者", // 接受任务的角色名
            "name": "任务名",
            "status": "进行中/已完成", // 任务状态
            "description": "完整未删减的任务详情文本", // 原始描述保留
        }
        // ... 其他任务
    ],
    "event": { // 本条消息的事件记录
        "record_date": "世界观当前日期", // 记录世界观下当前日期
        "timestamp": "HH:mm (可选)", // 事件发生时间（可选）
        "participants": ["角色名1", "角色名2"], // 相关人员名字的数组
        "keywords": ["关键词1", "关键词2"], // 当前信息的关键词数组,仅提取原文中直接出现的、非抽象的关键词。
        "description": "当前信息描述, 完整保留所有行为主体、核心动作、具体数据（数字/时间/数量等）及硬性要求（步骤/标准/条件等），其余内容精简至最简且无歧义。"
    }
}
</message_summary>
-->
`;

function filterSummaryInfoByRecent(chat, summaryInfo, keepCount) {
    const recentCount = keepCount * 2 + 1;
    const startIdx = Math.max(chat.length - recentCount, 0);
    const recentMessages = chat.slice(startIdx).map(item => item.mes || '').join(' ');

    // summaryInfo.characters 是对象，key为角色名
    // 过滤events
    const filteredEvents = (summaryInfo.events || []).filter(event => {
        const participants = event.participants.map(name => name.replace(/\（.*?\）/g, '').replace(/\(.*?\)/g, '').trim()) || [];
        let allNames = [];
        for (const roleName of participants) {
            allNames.push(roleName);
            const charObj = summaryInfo.characters[roleName];
            if (charObj && Array.isArray(charObj.pet_names)) {
                allNames = allNames.concat(charObj.pet_names);
            }
        }
        // 检查角色名或pet_names是否出现在最近消息
        const nameMatched = allNames.some(name => name && recentMessages.includes(name));
        // 检查keywords是否出现在最近消息
        const keywordMatched = (event.keywords || []).some(kw => recentMessages.includes(kw));
        return nameMatched || keywordMatched;
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

    chat[chat.length - 1]['mes'] = "用户输入:" + chat[chat.length - 1]['mes'] + "\n\n" + charPrompt;
    const summaryInfo = mergeSummaryInfo(chat);
    console.log("[Chat History Optimization] characters info:", summaryInfo);

    const mergedChat = [];

    // 保留第一条assistant消息
    let firstAssistantIdx = chat.findIndex(item => !item.is_user);
    const assistantName = chat[firstAssistantIdx].name || "Unknown";
    if (firstAssistantIdx !== -1) {
        mergedChat.push(chat[firstAssistantIdx]);
    }

    // charsInfo 转为 json 文本，作为一条 assistant 消消息加入
    if (summaryInfo && Object.keys(summaryInfo).length > 0) {
        const charsInfoJsonStr = JSON.stringify(filterSummaryInfoByRecent(chat, summaryInfo, extension_settings[extensionName].keepCount), null, 2);
        const charsInfoNotify = {
            is_user: true,
            name: chat[chat.length - 1].name,
            send_date: Date.now(),
            mes: `
<ROLE_DATA_UPDATE>
# 指令
全量载入下方角色/任务/事件记录JSON对象（覆盖历史缓存）。
【重要】生成最新回复时，绝不允许出现与角色/任务/事件记录矛盾的内容。
如有矛盾，请优先以角色/任务/事件记录为准，并在回复中合理体现角色的真实状态和历史。
---
${charsInfoJsonStr}
</ROLE_DATA_UPDATE>
`
        };
        mergedChat.push(charsInfoNotify);
        const charsInfoNotifyConfirm = {
            is_user: false,
            name: assistantName,
            send_date: Date.now(),
            mes: `
<DIRECTIVE_CONFIRM>
执行状态: SUCCESS
操作日志:
- 已载入角色/任务/事件记录JSON对象·
</DIRECTIVE_CONFIRM>
角色/任务/事件记录已更新。请继续与我对话，我会根据最新的角色/任务/事件记录信息进行回复。
`
        };
        mergedChat.push(charsInfoNotifyConfirm);
    }

    // 保留倒数第 keepCount 条 assistant 消息及其后的所有信息
    let assistantIdxArr = [];
    for (let i = 1; i < chat.length; i++) {
        if (!chat[i].is_user) assistantIdxArr.push(i);
    }
    const keepCount = extension_settings[extensionName].keepCount || 3;
    const firstUserIdx = chat.findIndex(item => item.is_user);
    let startIdx;
    if (assistantIdxArr.length === 0) {
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
    if (startIdx >= chat.length) {
        // 只保留最后一条消息
        tail = [chat[chat.length - 1]];
    } else {
        // 从startIdx-1开始保留到结尾
        tail = chat.slice(startIdx - 1);
        tail = tail.map(item => {
            if (item && typeof item.mes === "string" && item.swipes && item.swipe_id !== undefined && item.swipes[item.swipe_id]) {
                return {
                    ...item, mes: removedSections.reduce((mes, section) => {
                        return mes.replace(new RegExp(`<${section}[\\s\\S]*?${section}.*?>`, "g"), '');
                    }, item.swipes[item.swipe_id])
                };
            }
            return item;
        });
        const historyInfoNotify = {
            is_user: false,
            name: assistantName,
            send_date: Date.now(),
            mes: `后续消息是最近的消息记录.`
        };
        mergedChat.push(historyInfoNotify);
    }
    mergedChat.push(...tail);


    const userInfoNotify = {
        is_user: false,
        name: assistantName,
        send_date: Date.now(),
        mes: `下一条消息是用户输入的内容.`
    };
    mergedChat.splice(mergedChat.length - 1, 0, userInfoNotify);

    // 用 mergedChat 替换 chat 的内容
    chat.length = 0;
    let chatHistory = "";
    for (const item of mergedChat) {
        chat.push(item);
        chatHistory += item.mes + "\n";
    }

    // 计算 token 数量
    const tokenCount = await getTokenCountAsync(chatHistory);
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

    // Load settings when starting things up (if you have any)
    loadSettings();
});


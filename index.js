// The main script for the extension
// The following are examples of some basic extension functionality

//You'll likely need to import extension_settings, getContext, and loadExtensionSettings from extensions.js
import { extension_settings, getContext, loadExtensionSettings } from "../../../extensions.js";

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
    "guifan"
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

function mergeCharsInfo(chat) {
    // 记录解析失败或未找到的消息索引
    let failedChars = [];
    // characterMap: { character_name: { pet_names: Set, tasks: [], items: [], [record_date]: { events: [] } } }
    const characterMap = {};

    for (let j = 1; j < chat.length; j++) {
        const item = chat[j];
        if (item && !item.is_user && item.swipes && item.swipes[item.swipe_id]) {
            const swipeContent = item.swipes[item.swipe_id];
            // 去除注释并提取 <characters>...</characters> 标签内容（不捕获标签本身，忽略嵌套错误）
            const charMatch = swipeContent
                .replace(/\/\/.*$/gm, '')
                .match(/<characters>((?:(?!<characters>)[\s\S])*?)<\/characters>/i);
            if (charMatch) {
                let jsonStr = charMatch[1].trim();
                try {
                    // 只提取第一个{...}对象
                    const objMatch = jsonStr.match(/\{[\s\S]*\}/);
                    if (!objMatch) {
                        failedChars.push(j);
                        continue;
                    }
                    const obj = JSON.parse(objMatch[0]);
                    if (Array.isArray(obj.characters)) {
                        for (const char of obj.characters) {
                            if (!char.character_name || !char.record_date) continue;
                            const name = char.character_name;
                            const date = char.record_date;
                            // 初始化结构
                            if (!characterMap[name]) {
                                characterMap[name] = {
                                    pet_names: new Set(),
                                    tasks: [],
                                    items: []
                                };
                            }
                            if (!characterMap[name][date]) {
                                characterMap[name][date] = { events: [] };
                            }
                            // 合并pet_names到characterMap[name].pet_names（去重）
                            if (Array.isArray(char.pet_names)) {
                                char.pet_names.forEach(n => characterMap[name].pet_names.add(n));
                            }
                            // tasks和items直接覆盖为最新记录
                            if (Array.isArray(char.tasks)) {
                                characterMap[name].tasks = char.tasks;
                            }
                            if (Array.isArray(char.items)) {
                                characterMap[name].items = char.items;
                            }
                            // 合并event
                            if (char.event) {
                                characterMap[name][date].events.push(char.event);
                            }
                        }
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

    // 构建最终json，pet_names去重转为数组，tasks/items提升到与pet_names同级
    for (const name of Object.keys(characterMap)) {
        characterMap[name].pet_names = Array.from(characterMap[name].pet_names);
    }

    // 打印log并显示在failed-chars里
    if (failedChars.length > 0) {
        console.warn(`[Chat History Optimization] Failed to parse or missing <characters> at chat indexes: ${failedChars.join(', ')}`);
        $("#chars-failed").prop("textContent", failedChars.join(', '));
    } else {
        $("#chars-failed").prop("textContent", "无");
    }

    return characterMap;
}

const charPrompt = `
额外要求:在回复末尾生成characters信息,用注释包裹:
<!--
// 对本条消息出场角色(包括{{user}})的总结(JSON格式)
<characters>
{
    "characters": [ // 使用数组，方便增删和遍历角色
        {
            "character_name": "角色名", // 角色唯一标识名称
            "pet_names": ["称呼1", "称呼2", etc…], // {{user}}对角色的常用称呼
            "record_date": "世界观当前日期", // 记录世界观下当前日期
            "event": {
                "timestamp": "HH:mm (可选)", // 事件发生时间（可选）
                "description": "角色事件描述,保留关键信息,涉及到数据的要准确保留,其余部分确保简洁无歧义"
            },
            "tasks": [ // {{user}}收到的系统任务记录，随完成情况增减
                // { "task_name": "任务名", "status": "进行中/已完成", "desc": "任务描述" }
            ],
            "items": [ // 道具记录，随获得/消耗增减
                // { "item_name": "道具名", "count": 1, "desc": "道具描述" }
            ]
        },
        // ... يمكن إضافة المزيد من الشخصيات هنا
    ]
}
</characters>
-->
`;

function filterCharsInfoByRecent(chat, charsInfo, keepCount) {
    // 统计最近keepCount*2+1条消息中出现过的pet_names或charName
    const recentPetNames = new Set();
    const recentCount = keepCount * 2 + 1;
    const startIdx = Math.max(chat.length - recentCount, 0);
    for (let i = startIdx; i < chat.length; i++) {
        const item = chat[i];
        if (!item || !item.mes) continue;
        // 遍历charsInfo所有pet_names和charName，若出现在消息文本中则记录
        for (const charName in charsInfo) {
            if (!charsInfo.hasOwnProperty(charName)) continue;
            // 检查角色名
            if (item.mes.includes(charName)) {
                recentPetNames.add(charName);
            }
            // 检查pet_names
            const petNames = Array.isArray(charsInfo[charName].pet_names) ? charsInfo[charName].pet_names : [];
            petNames.forEach(pet => {
                if (typeof pet === "string" && item.mes.includes(pet)) {
                    recentPetNames.add(pet);
                }
            });
        }
    }

    // 过滤charsInfo对象
    const filtered = {};
    for (const charName in charsInfo) {
        if (!charsInfo.hasOwnProperty(charName)) continue;
        const charObj = charsInfo[charName];
        const petNames = Array.isArray(charObj.pet_names) ? charObj.pet_names : [];
        // 只要有一个pet_name或charName在recentPetNames中就保留
        const hasRecent = petNames.some(n => recentPetNames.has(n)) || recentPetNames.has(charName);
        if (hasRecent) {
            filtered[charName] = charObj;
        }
    }
    return filtered;
}

globalThis.replaceChatHistoryWithDetails = async function (chat, contextSize, abort, type) {
    if (!extension_settings[extensionName].extensionToggle) {
        console.info("[Chat History Optimization] extension is disabled.")
        return;
    }

    chat[chat.length - 1]['mes'] = "用户输入:" + chat[chat.length - 1]['mes'] + "\n\n" + charPrompt;
    const charsInfo = mergeCharsInfo(chat);
    console.log("[Chat History Optimization] characters info:", charsInfo);

    const mergedChat = [];

    // 保留第一条assistant消息
    let firstAssistantIdx = chat.findIndex(item => !item.is_user);
    const assistantName = chat[firstAssistantIdx].name || "Unknown";
    if (firstAssistantIdx !== -1) {
        mergedChat.push(chat[firstAssistantIdx]);
    }

    // charsInfo 转为 json 文本，作为一条 assistant 消消息加入
    if (charsInfo && Object.keys(charsInfo).length > 0) {
        const charsInfoNotify = {
            is_user: false,
            name: assistantName,
            send_date: Date.now(),
            mes: `下一条消息将是一个包含**角色行为记录**的JSON对象.在生成你的回复时,**必须严格遵循并深度融入**该角色记录中的信息.`
        };
        mergedChat.push(charsInfoNotify);
        mergedChat.push({
            is_user: false,
            name: assistantName,
            send_date: Date.now(),
            mes: `\n${JSON.stringify(filterCharsInfoByRecent(chat, charsInfo, extension_settings[extensionName].keepCount), null, 2)}\n`
        });
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

    // Load settings when starting things up (if you have any)
    loadSettings();
});


// The main script for the extension
// The following are examples of some basic extension functionality

//You'll likely need to import extension_settings, getContext, and loadExtensionSettings from extensions.js
import { extension_settings, getContext, loadExtensionSettings } from "../../../extensions.js";
import { getTokenCountAsync } from '../../../tokenizers.js';
//You'll likely need to import some other functions from the main script
import { saveSettingsDebounced, this_chid, characters } from "../../../../script.js";
import { getRegexedString, regex_placement } from '../../../extensions/regex/engine.js';
import { eventSource, event_types } from "../../../../script.js";

const context = SillyTavern.getContext();

// Keep track of where your extension is located, name should match repo name
const extensionName = "chat-history-optimization";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
const mergeThreshold = 54 * 1024;
const defaultSettings = {
    extensionToggle: false,
    keepCount: 3,
    charPrompt: `{
    "characters": { // {{user}}和其他NPC的信息记录
        "character_name": { // 角色名
            "character_name": "角色名", // 角色名
            "pet_names": ["代称1", "代称2"], // 被用过的角色代称
            "acquaintance": ["角色1","角色2"], // 角色见过的其它角色
            "personality": "角色性格",
            "job": "角色职业",
            "age": "角色年龄",
            "background": "角色背景故事",
            "physical_traits": { // 【身体蓝图】裸体时仍存在的永久特征，包含：体型/疤痕/纹身/天生属性
                // 提取角色被提及的所有外貌和部位的**静态特征**描述, 填充时自选格式:
                // 格式1. "部位1":"特征描述"
                // 格式2. "部位2": {"特征1":"特征描述", "特征2":"特征描述"}
                // 示例1: "手": "白玉似的手，指节泛白"
                // 示例2: "身高": "172cm"
                // 示例3: "臀部": {"尺寸": "94cm", "特征": "蜜桃一般，弹性十足"}
                // 示例4: "胸部": {"尺寸": "110cm", "罩杯": "G罩杯", "特征": "白嫩，能看到青色血管" }
            },
            "persistent_state": {  // 【持续状态】事件引发的较长时间身体状态改变（持续几分钟以上至永久）
                // **所有(无论是否在当前回复中出现)角色**都需根据当前时间更新状态的[持续时间](可预估),状态结束后移除
                // 记录会持续一段时间的生理变化/伤痕/体液残留等，排除瞬态反应
                // 格式要求：每个状态必须包含持续时间(可预估)或消退条件(可推测)
                // 格式: "部位": "[原因][状态1描述][持续时间/消退条件]，[原因][状态2描述][持续时间/消退条件]"
                // 示例1: "背部": "[被主人鞭打][三道鞭痕][持续48小时]"
                // 示例2: "乳头": "[被主人捏弄][红肿][持续1小时]，[被主人滴催情药水][敏感度提升][持续2小时]"
                // 示例3: "双腿": "[被捆绑至沙发两边][无法动弹][直至松绑]"
            },
            "clothing": { // 【穿戴层】可随时穿上/脱下的物品，包含：衣物/饰品/玩具/电子设备
                // **所有(无论是否在当前回复中出现)角色**都需在日期变换时通过置空字符串来清空的clothing 例如: "下身": ""
                // 提取角色被提及的着装信息, 按具体部位列出('全身'需拆分为'上身'+'下身')，格式 "具体部位":"着装描述"，如佩戴饰物或者玩具也需记录
                // 示例1: "下身": "黑色西裤，黑色丝袜，黑色内裤",
                // 示例2: "乳头": "黑色金属乳环，银色乳夹"
                // 示例3: "屁眼": "粗大的肛塞"
            },
            "current_state": "角色可观测的具体状态，包括：姿势、动作、生理反应、环境交互（避免主观形容词，用行为表现代替情绪）",  // 示例："双腿被皮带固定于沙发扶手，全身痉挛，阴道持续收缩，发出断续尖叫，眼角有泪"
            "items": { // 角色的物品记录，随当前回复增减物品
                // "物品名":{ "count": 1, "desc": "物品描述" }
            },
            "skills": { // 角色的技能记录，随当前回复新增/调整
                // "技能名":{ "level": 1, "desc": "技能的功能描述" }
            },
            "relationships": { // 角色与其他角色的关系记录，随当前回复新增/调整
                // "其他角色": "是<其他角色>的[主人/奴隶/朋友/夫妻] 情感[类型]，强度[高/中/低]"
            },
            "shame_play": {
                // "性爱相关play方式": 次数
            },
            "misc": { // ... 其它重要信息, 随当前回复新增/调整，例如是否处女、资金、特殊点数等
                // "信息名":"信息内容"
                // 示例1: "性生活频率": "一周两到三次"
                // 示例2: "高潮次数": 2
            }
        }
        // ... 其他角色
    },
    "information": [ // 记录当前回复中命令、要求、条款、规则、线索、时效、通知、说明(禁止记录其它类型信息)
        //格式：{"日期":"(记录世界观下当前日期,如无日期信息,则从第1天开始)","时间(可选)":"时间","地点":"(用.分隔大小地点，如“图书馆.三楼.阅览室”、“酒馆.二楼.卫生间”)","角色":"与信息有关的角色(多人用逗号分隔)","类型":"说明","主题":"主题","细项":["细项1","细项2",…] // 细项的格式为"[细项][细项原文]"}
    ],
    "quests": { // 任务记录：提取当前回复中的明确及暗示的任务，随回复动态更新
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
    }
}`,
};

let finalSummaryInfo = null;

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

function fixupValue(object) {
    if (object && typeof object === 'object' && !Array.isArray(object)) {
        // 移除 count 为 0 的 item
        for (const key in object) {
            if (Object.prototype.hasOwnProperty.call(object, key)) {
                const item = object[key];
                if (item && typeof item === 'object' && 'count' in item && ((item.count == 0) || (item.count == "0"))) {
                    delete object[key];
                }
            }
        }

        for (const key of Object.keys(object)) {
            const value = object[key];
            if (value && value.character_name && key !== value.character_name) {
                delete object[key];
                object[value.character_name] = deepMerge(object[value.character_name], value);
            }
        }

        if ('全身' in object) {
            object['上身'] = object['全身'];
            object['下身'] = object['全身'];
            object['脚'] = object['全身'];
            delete object['全身'];
        }

        if ('shame_play' in object) {
            delete object['shame_play'];
        }


    }
    return object
}

function deepMerge(target, source) {
    if (Array.isArray(target) && Array.isArray(source)) {
        // 去除source中与target重复的item
        const filteredSource = source.filter(item => !target.includes(item));
        return target.concat(filteredSource);
    }
    if (typeof target !== 'object' || target === null) return source;
    if (typeof source !== 'object' || source === null) return target;
    const result = { ...target };
    for (const key of Object.keys(source)) {
        if (key in target) {
            result[key] = fixupValue(deepMerge(target[key], source[key]));
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
                .matchAll(/<ROLE_DATA_DELTA_UPDATE>((?:(?!<ROLE_DATA_DELTA_UPDATE>)[\s\S])*?)<\/ROLE_DATA_DELTA_UPDATE>/gi)];
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
    const charsInfoJsonStr = JSON.stringify(finalSummaryInfo, null, 2);
    const summaryKeysStr = Object.keys(finalSummaryInfo).join('&');
    const prompt = `
额外要求:
1. 载入<ROLE_DATA>里的${summaryKeysStr}做为回复生成时的内容基石，不可与<ROLE_DATA>的信息矛盾。
2. 在回复末尾生成<ROLE_DATA_DELTA_UPDATE>信息,完整提取回复中相对于<ROLE_DATA>内容发生变化的字段(严格遵循字段注释中的规则),省略未修改字段,确保输出为有效JSON。
------
<ROLE_DATA>
${charsInfoJsonStr}
</ROLE_DATA>
------
<ROLE_DATA_DELTA_UPDATE>
${$("#char_prompt_textarea").val()}
</ROLE_DATA_DELTA_UPDATE>

`
    return prompt;
}

globalThis.replaceChatHistoryWithDetails = async function (chat, contextSize, abort, type) {
    if (!extension_settings[extensionName].extensionToggle) {
        console.info("[Chat History Optimization] extension is disabled.")
        return;
    }

    finalSummaryInfo = mergeSummaryInfo(chat);
    finalSummaryInfo.information && (finalSummaryInfo.information.forEach(item => {item.mention=false;}));
    let tokenCount = await getTokenCountAsync(JSON.stringify(finalSummaryInfo, null, 2));
    while (tokenCount > mergeThreshold) {
        finalSummaryInfo.information && (finalSummaryInfo.information = finalSummaryInfo.information.slice(Math.floor(finalSummaryInfo.information.length / 10)));
        finalSummaryInfo.action_waiting_result && (finalSummaryInfo.action_waiting_result = Object.fromEntries(Object.entries(finalSummaryInfo.action_waiting_result).filter(([, v]) => v.status !== '已有结果' && v.status !== '已完成无后续')));
        finalSummaryInfo.quests && (finalSummaryInfo.quests = Object.fromEntries(Object.entries(finalSummaryInfo.quests).filter(([, v]) => v.status !== '已完成')));
        tokenCount = await getTokenCountAsync(JSON.stringify(finalSummaryInfo, null, 2));
        console.warn("[Chat History Optimization] Summary info is too large, reduce message to count.", tokenCount, finalSummaryInfo);
    }
    $("#token-count").prop("textContent", `${tokenCount}`);
    console.log("[Chat History Optimization] token count:", tokenCount);

    const mergedChat = [];

    // 保留倒数第 keepCount 条 assistant 消息及其后的所有信息
    let assistantIdxArr = [];
    for (let i = 0; i < chat.length; i++) {
        if (!chat[i].is_user) assistantIdxArr.push(i);
    }
    let keepCount = extension_settings[extensionName].keepCount;
    if (typeof keepCount !== 'number' || isNaN(keepCount)) keepCount = defaultSettings.keepCount;
    if (keepCount == 0 && assistantIdxArr.length == 1) keepCount = 1;
    if (keepCount > assistantIdxArr.length) keepCount = assistantIdxArr.length;
    const startIdx = assistantIdxArr[assistantIdxArr.length - keepCount];
    let tail = chat
        .slice(startIdx)
        .filter(item => item && item.is_user === false)
        .map(item => {
            const match = (item.mes || '').match(/<StatusBlocks>((?:(?!<StatusBlocks>)[\s\S])*?)<\/content>/);
            return {
                ...item,
                mes: match ? match[0] : '' // 只保留整个匹配内容，没有则为空字符串
            };
        });
    mergedChat.push(...tail);

    chat[chat.length - 1]['mes'] = "用户输入:" + chat[chat.length - 1]['mes'] + "\n\n" + getCharPrompt();
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
    $("#char_prompt_reset").on("click", function () {
        // 恢复为默认模板
        $("#char_prompt_textarea").val(defaultSettings.charPrompt).trigger("input");
    });

    // Load settings when starting things up (if you have any)
    loadSettings();
});

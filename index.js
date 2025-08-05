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
const defaultSettings = {
    extensionToggle: false,
    keepCount: 3,
    charPrompt: `{
    // 天数: 第1天开始计数的天数
    // 日期: 世界观下当前日期,如无日期信息,则从第1天开始
    // 地点: 用.分隔大小地点，如“图书馆.三楼.阅览室”、“酒馆.二楼.卫生间”
    "天数": "第1天",
    "日期": "日期",
    "任务记录": { // 任务记录：识别并抽取所有[任务|命令|安排|要求]的信息，随回复动态更新
        "{{任务名}}": {
            "发布者": "{{角色名}}",
            "接受者": "{{角色名}}",
            "任务名": "{{任务名}}",
            "发布日": "{{天数}}",
            "截止日": "{{天数}}",
            "任务状态": "已过期/进行中/已完成",
            "任务进度": "任务进度",
            "任务要求": {
                "主要要求":"完整未删减的任务主要求", // 保留原始任务要求描述
                "次要要求1":"完整未删减的任务次要要求1" // (可选)，保留原始任务要求描述
               // ... 其它次要要求
            },
            "任务奖励": "任务奖励"
            // ... 其他任务信息
        }
        // ... 其他任务
    },
    "全局设定": { // 全局设定：识别并**原文复制**所有[系统|设定|规则]的信息
        // 格式：
        // 示例: {"全局设定名字": ["子设定1:详情1**原文复制*","子设定2:详情2**原文复制**","补充子设定3:详情3**原文复制**"]},
       // …其它全局设定
    },
    "信息记录": [// **每轮必须增加，无需与历史信息比较** 记录回复中的行为结果、伏笔、伏笔收尾、要求、规则、线索、通知、说明等会对后文内容产生持续影响的关键信息
        // **特殊情况:**
        // 1. 涉及**数字**需准确保留数字及其相关信息
        // 2. 涉及**人物、地点、物品**则需准确记录名称及其相关信息
        // 3. 说明类信息需**复制原文**
        // 格式：{"天数":"天数","时间":"时间(可选)","地点":"地点","角色":"相关角色(多人用逗号分隔)","主题":"主题","细项":["结果1","说明2","通知3",…]}
    ],
    "角色信息": { // {{user}}和其他NPC的信息记录
        "{{角色名}}": { //角色名(中文)
            "角色名": "{{角色名}}", //角色名(中文)
            "性格": "{{性格}}",
            "职业": "{{职业}}",
            "年龄": "{{年龄}}",
            "背景": "{{背景}}",
            "境界(或符合当前世界观的其它名称)": "淬体境(初级)",
            "兴趣爱好": {
                // "兴趣爱好1":{ "level": 1, "desc": "描述" }
                // ... 其它兴趣爱好
            },
            "永久特征": { // 【身体蓝图】裸体时仍存在的永久特征，包含：体型/疤痕/纹身/天生属性
                // 提取角色被提及的所有外貌和部位的**静态特征**描述, 填充时自选格式:
                // 格式1. "部位1":"特征描述"
                // 格式2. "部位2": {"特征1":"特征描述", "特征2":"特征描述"}
                // 示例1: "手": "白玉似的手，指节泛白"
                // 示例2: "身高": "172cm"
                // 示例3: "臀部": {"尺寸": "94cm", "特征": "蜜桃一般，弹性十足"}
                // 示例4: "胸部": {"尺寸": "110cm", "罩杯": "G罩杯", "特征": "白嫩，能看到青色血管" }
            },
            "身体状态": {  // 【持续状态】事件引发的较长时间身体状态改变
                // 记录会持续一段时间的生理变化/伤痕/体液残留等，排除瞬态反应
                // 格式要求：每个状态必须包含持续天数(可预估)
                // 格式: "部位": "[状态1描述][持续到第X天]，[状态2描述][持续到第X天]"，第X天为绝对时间而非相对时间
                // 示例1: "背部": "[三道鞭痕][持续到第2天]"
                // 示例2: "乳头": "[掌掴后红肿][持续到第1天]，[因催情药水敏感度提升][持续到第3天]"
                // 示例3: "双腿": "[无法动弹][持续到第2天]"
            },
            "衣着": { // 【穿戴层】可随时穿上/脱下的物品，包含：衣物/饰品/玩具/电子设备
                // 提取角色被提及的着装信息, 按具体部位列出，格式 "具体部位":"[天数][着装描述]"，如佩戴饰物或者玩具也需记录
                // 示例1: "下身": "[第1天][黑色西裤，黑色丝袜，黑色内裤]",
                // 示例2: "乳头": "[第2天][黑色金属乳环，银色乳夹]"
                // 示例3: "屁眼": "[第X天][粗大的肛塞]"
            },
            "情境快照": "[第X天][时间][地点]角色可观测的具体状态，包括：姿势、动作、生理反应、环境交互（避免主观形容词，用行为表现代替情绪）",  // 示例："[第2天][10:15][别墅]双腿被皮带固定于沙发扶手，全身痉挛，阴道持续收缩，发出断续尖叫，眼角有泪"
            "物品": { // 角色长期使用或主要用途的物品，排除一次性或临时物品，需随当前回复增减物品数量
                // "物品1":{"价值":"100{{兑换单位}}","数量": 1,"状态":"已装备(for法宝)/无(for道具)","物品说明": "物品说明**复制原文**" }
                // "物品2":{"价值":"100{{兑换单位}}", "数量": 0, "状态":"已装备(for法宝)/无(for道具)", "物品说明": "物品说明**复制原文**" }
            },
            "技能": { // 角色的技能记录，随当前回复新增/调整
                // "技能1":{ "品级": "天阶/SS","价值":"10000{{兑换单位}}", "修炼等级": "1/初窥门径", "技能说明": "技能说明**复制原文**" }
            },
            "额外信息": { // 额外信息存储区：用于动态记录和更新与当前上下文相关的各种属性和状态。
                // 键名规则: 中文，确保清晰且无空格。
                // 值类型: 可以是字符串、数字、布尔值、数组或嵌套对象，根据信息特性灵活选择。
                // 示例1: "性生活频率": "一周两到三次"
                // 示例2: "高潮次数": {"当天次数":次数, "累计次数":累计次数}
            }
        }
        // ... 其他角色
    },
    "角色关系": { // 出场角色之间的关系记录
        // 示例:
        // "角色1": {
        //     "角色2": {
        //         "关系": "父子|恋人|主奴|朋友|顾客|仇敌"
        //     }
        // }
    }
}`,
};

const wordMapping = {
    "崩溃": "臣服",
    "绝望": "释然",
    "空洞": "迷离",
    "麻木": "挣扎",
    "认命": "求生欲",
    "极端": "有些",
    "极度": "有些",
    "扭曲": "抵触"
}

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
                if (item && typeof item === 'object' && '数量' in item && ((item.数量 == 0) || (item.数量 == "0"))) {
                    delete object[key];
                }
            }
        }

        if ('全身' in object) {
            object['上身'] = object['全身'];
            object['下身'] = object['全身'];
            object['脚'] = object['全身'];
            delete object['全身'];
        }

        if ('精神' in object) {
            delete object['精神'];
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

function mergeRoleDataInfo(chat) {
    let failedChars = [];
    let mergedObj = {};

    for (let j = 1; j < chat.length; j++) {
        const item = chat[j];
        if (item && !item.is_user && item.swipes && item.swipes[item.swipe_id]) {
            let matches = [...item.mes
                .replace(/\/\/.*$/gm, '')
                .matchAll(/<ROLE_DATA_DELTA_UPDATE>((?:(?!<ROLE_DATA_DELTA_UPDATE>)[\s\S])*?)<\/ROLE_DATA_DELTA_UPDATE>/gi)];
            if (matches.length == 0) {
                matches = [...item.swipes[item.swipe_id]
                    .replace(/\/\/.*$/gm, '')
                    .matchAll(/<ROLE_DATA_DELTA_UPDATE>((?:(?!<ROLE_DATA_DELTA_UPDATE>)[\s\S])*?)<\/ROLE_DATA_DELTA_UPDATE>/gi)];
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
        console.warn(`[Chat History Optimization] Failed to parse or missing <ROLE_DATA_DELTA_UPDATE> at chat indexes: ${failedChars.join(', ')}`);
        $("#chars-failed").prop("textContent", failedChars.join(', '));
    } else {
        $("#chars-failed").prop("textContent", "无");
    }

    return mergedObj;
}

function mergeRoleDataSummaryInfo(chat) {
    let roleDataSummary = [];

    for (let j = 1; j < chat.length; j++) {
        const item = chat[j];
        if (item && !item.is_user && item.swipes && item.swipes[item.swipe_id]) {
            let matches = [...item.mes
                .replace(/\/\/.*$/gm, '')
                .matchAll(/<ROLE_DATA_SUMMARY>((?:(?!<ROLE_DATA_SUMMARY>)[\s\S])*?)<\/ROLE_DATA_SUMMARY>/gi)];
            if (matches.length == 0) {
                matches = [...item.swipes[item.swipe_id]
                    .replace(/\/\/.*$/gm, '')
                    .matchAll(/<ROLE_DATA_SUMMARY>((?:(?!<ROLE_DATA_SUMMARY>)[\s\S])*?)<\/ROLE_DATA_SUMMARY>/gi)];
            }
            if (matches.length > 0) {
                let jsonStr = matches[matches.length - 1][1].trim();
                try {
                    const objMatch = jsonStr.match(/\[[\s\S]*\]/);
                    if (!objMatch) {
                        continue;
                    }
                    roleDataSummary.push(JSON.parse(objMatch[0]));
                } catch (e) {
                    console.error(`[Chat History Optimization] JSON parse error at chat[${j}]:`, e);
                }
            }
        }
    }

    return roleDataSummary;
}

function getCharPrompt(finalSummaryInfo) {
    let charsInfoJsonStr = JSON.stringify(finalSummaryInfo, null, 2);
    for (const [key, value] of Object.entries(wordMapping)) {
        charsInfoJsonStr = charsInfoJsonStr.replace(new RegExp(key, 'g'), value);
    }

    const prompt = `
<ROLE_PLAY>

<ROLE_DATA>
${charsInfoJsonStr}
</ROLE_DATA>
------
**在回复末尾生成<ROLE_DATA_DELTA_UPDATE>信息，提取<ROLE_DATA>发生改变的字段（严格遵循字段注释中的规则），省略未改变字段，确保输出为有效JSON。**
<ROLE_DATA_DELTA_UPDATE>
${$("#char_prompt_textarea").val()}
</ROLE_DATA_DELTA_UPDATE>
------

</ROLE_PLAY>
`
    return prompt;
}

function replaceInfoRecordsWithSummary(finalSummaryInfo, roleDataSummary) {
    if (!finalSummaryInfo || !Array.isArray(finalSummaryInfo.信息记录) || !Array.isArray(roleDataSummary)) return;

    for (const roleDataSummaryItem of roleDataSummary) {
        const infoRecords = finalSummaryInfo.信息记录;
        const newInfoRecords = [];
        let i = 0;
        while (i < infoRecords.length) {
            const current = infoRecords[i];
            // 查找 roleDataSummary 中匹配的 summary
            const summaryItem = roleDataSummaryItem.find(
                s => (s.天数 && s.天数 === current.天数) || (s.日期 && s.日期 === current.日期)
            );
            if (summaryItem) {
                // 找到所有连续的同日期/天数的 item
                const matchKey = summaryItem.天数 || summaryItem.日期;
                let j = i;
                while (
                    j < infoRecords.length &&
                    ((summaryItem.天数 && infoRecords[j].天数 === summaryItem.天数) ||
                        (summaryItem.日期 && infoRecords[j].日期 === summaryItem.日期))
                ) {
                    j++;
                }
                // 替换为 summary
                newInfoRecords.push({
                    "天数": summaryItem.天数,
                    "主题": `${summaryItem.天数}摘要`,
                    "细项": summaryItem.summary || [],
                });
                i = j; // 跳过已替换的
            } else {
                // 没有 summary 匹配，保留原 item
                newInfoRecords.push(current);
                i++;
            }
        }
        finalSummaryInfo.信息记录 = newInfoRecords;
    }
}

globalThis.replaceChatHistoryWithDetails = async function (chat, contextSize, abort, type) {
    if (!extension_settings[extensionName].extensionToggle) {
        console.info("[Chat History Optimization] extension is disabled.")
        return;
    }

    let finalSummaryInfo = mergeRoleDataInfo(chat);
    const tokenCount_origin = await getTokenCountAsync(JSON.stringify(finalSummaryInfo, null, 2));
    console.log("[Chat History Optimization] origin token count:", tokenCount_origin);

    // 过滤掉任务状态为'已完成'的任务
    if (finalSummaryInfo && finalSummaryInfo.任务记录 && typeof finalSummaryInfo.任务记录 === 'object') {
        for (const key of Object.keys(finalSummaryInfo.任务记录)) {
            const task = finalSummaryInfo.任务记录[key];
            if (task && (task.任务状态 === '已完成' || task.任务状态 === '已失败' || task.任务状态 === '已取消')) {
                delete finalSummaryInfo.任务记录[key];
            }
        }
    }
    const roleDataSummary = mergeRoleDataSummaryInfo(chat);
    console.log("[Chat History Optimization] roleDataSummary:", roleDataSummary);
    replaceInfoRecordsWithSummary(finalSummaryInfo, roleDataSummary);
    // 对 finalSummaryInfo.信息记录 去重，保留最后出现的 item，保持原顺序
    if (finalSummaryInfo && Array.isArray(finalSummaryInfo.信息记录)) {
        const seen = new Map();
        // 逆序遍历，记录每个唯一 item 的索引
        for (let i = finalSummaryInfo.信息记录.length - 1; i >= 0; i--) {
            const item = finalSummaryInfo.信息记录[i];
            // 以按字母序排序后的 JSON 字符串作为唯一标识，避免 key 顺序问题
            const key = item.主题 + ',' + item.天数;

            if (!seen.has(key)) {
                seen.set(key, i);
            }
        }
        // 按原顺序保留最后出现的 item
        const uniqueRecords = Array.from(seen.values()).sort((a, b) => a - b).map(idx => finalSummaryInfo.信息记录[idx]);
        finalSummaryInfo.信息记录 = uniqueRecords;
    }
    // 收集所有出现在信息记录中的角色
    let infoRolesSet = new Set();
    for (let j = 1; j < chat.length; j++) {
        const item = chat[j];
        if (item && !item.is_user && item.swipes && item.swipes[item.swipe_id]) {
            let matches = [...item.mes
                .replace(/\/\/.*$/gm, '')
                .matchAll(/<ROLE_DATA_DELTA_UPDATE>((?:(?!<ROLE_DATA_DELTA_UPDATE>)[\s\S])*?)<\/ROLE_DATA_DELTA_UPDATE>/gi)];
            if (matches.length == 0) {
                matches = [...item.swipes[item.swipe_id]
                    .replace(/\/\/.*$/gm, '')
                    .matchAll(/<ROLE_DATA_DELTA_UPDATE>((?:(?!<ROLE_DATA_DELTA_UPDATE>)[\s\S])*?)<\/ROLE_DATA_DELTA_UPDATE>/gi)];
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
                    let shouldProcessRoles = false;
                    if (
                        itemObj &&
                        Array.isArray(itemObj.信息记录) &&
                        Array.isArray(finalSummaryInfo.信息记录)
                    ) {
                        // 按字母序 stringify 作为唯一标识
                        const makeKey = obj => {
                            if (!obj || typeof obj !== 'object') return '';
                            let time = (typeof obj.时间 === 'string' && obj.时间.trim() !== '' && obj.时间 !== '无效' && obj.时间 !== null && obj.时间 !== undefined) ? obj.时间 : '';
                            return obj.主题 + ',' + obj.天数 + ',' + time + ',' + obj.地点;
                        };
                        const finalKeys = new Set(finalSummaryInfo.信息记录.slice(Math.max(0, finalSummaryInfo.信息记录.length - 50)).map(makeKey));
                        for (const infoItem of itemObj.信息记录) {
                            if (finalKeys.has(makeKey(infoItem))) {
                                shouldProcessRoles = true;
                                break;
                            }
                        }
                    }
                    if (!shouldProcessRoles) continue;
                    if (itemObj && itemObj.角色信息 && typeof itemObj.角色信息 === 'object') {
                        for (const roleName of Object.keys(itemObj.角色信息)) {
                            infoRolesSet.add(roleName);
                        }
                    }
                } catch (e) {
                }
            }
        }
    }

    console.log("[Chat History Optimization] infoRolesSet:", infoRolesSet);
    console.log("[Chat History Optimization] finalSummaryInfo:", finalSummaryInfo);

    // 处理角色信息，只保留未出现角色的角色名和当前状态
    if (finalSummaryInfo && finalSummaryInfo.角色信息 && typeof finalSummaryInfo.角色信息 === 'object') {
        for (const roleName of Object.keys(finalSummaryInfo.角色信息)) {
            if (!infoRolesSet.has(roleName)) {
                const roleObj = finalSummaryInfo.角色信息[roleName];
                finalSummaryInfo.角色信息[roleName] = {
                    "角色名": roleObj.角色名,
                    "情境快照": roleObj.情境快照
                };
            }
        }
    }

    const mergeThreshold = 50 * 1024;
    let tokenCount = await getTokenCountAsync(JSON.stringify(finalSummaryInfo, null, 2));
    while (tokenCount > mergeThreshold) {
        finalSummaryInfo.信息记录 = finalSummaryInfo.信息记录.slice(Math.floor(finalSummaryInfo.信息记录.length / 10));
        tokenCount = await getTokenCountAsync(JSON.stringify(finalSummaryInfo, null, 2));
        console.warn("[Chat History Optimization] Summary info is too large, reduce message to count.", tokenCount);
    }
    $("#token-count").prop("textContent", `${tokenCount}`);
    console.log("[Chat History Optimization] token count:", tokenCount);

    // 过滤chat, 如果item.mes包含<ROLE_DATA_SUMMARY>...</ROLE_DATA_SUMMARY>,则移除item,如果前一个item.is_user是true,也一并移除
    const summaryRegex = /<ROLE_DATA_SUMMARY>[\s\S]*?<\/ROLE_DATA_SUMMARY>/i;
    const chatToKeep = [];
    for (const currentItem of chat) {
        // 检查当前消息是否为包含摘要的AI消息
        if (currentItem?.mes && !currentItem.is_user && summaryRegex.test(currentItem.mes)) {
            // 如果是，检查待保留列表中的上一条消息是否为用户消息
            if (chatToKeep.length > 0 && chatToKeep[chatToKeep.length - 1].is_user) {
                // 如果是用户消息，则将其从待保留列表中移除
                chatToKeep.pop();
            }
            // 当前包含摘要的AI消息不添加到待保留列表
        } else {
            // 否则，将当前消息添加到待保留列表
            chatToKeep.push(currentItem);
        }
    }
    chat.length = 0;
    chat.push(...chatToKeep);

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
    if (keepCount > 0) {
        const startIdx = assistantIdxArr[assistantIdxArr.length - keepCount];
        let tail = chat
            .slice(startIdx)
            .filter(item => item && item.is_user === false)
            .map(item => (item.mes || '')
                .replace(/<thinking>[\s\S]*?<\/thinking>/g, '<thinking>\nFILL YOUR THINKING\n<\/thinking>').trim()
                .replace(/<ROLE_DATA_DELTA_UPDATE>((?:(?!<ROLE_DATA_DELTA_UPDATE>)[\s\S])*?)<\/ROLE_DATA_DELTA_UPDATE>/gi, '<ROLE_DATA_DELTA_UPDATE>\n//IMPORTANT INFORMATION, FILL IT\n<\/ROLE_DATA_DELTA_UPDATE>').trim());
        finalSummaryInfo.前文 = tail.join('\n');
    } else {
        finalSummaryInfo.前文 = "";
    }

    chat[chat.length - 1]['mes'] = "用户输入:" + chat[chat.length - 1]['mes'] + "\n\n" + getCharPrompt(finalSummaryInfo);
    if (chat.length == 2 && chat[0].is_user === false && chat[1].is_user === true) {
        chat[chat.length - 1]['mes'] = chat[chat.length - 1]['mes'] + "（此为首条信息，必须完整地把所有可能的信息都记录到<ROLE_DATA_DELTA_UPDATE>中）";
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
    $("#char_prompt_reset").on("click", function () {
        // 恢复为默认模板
        $("#char_prompt_textarea").val(defaultSettings.charPrompt).trigger("input");
    });

    // Load settings when starting things up (if you have any)
    loadSettings();
});

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

let json_template = null;

// Keep track of where your extension is located, name should match repo name
const extensionName = "chat-history-optimization";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
const defaultSettings = {
    extensionToggle: false,
    keepCount: 3,
    tokenLimit: 50 * 1024,
    charPrompt: `{
    // **注意** 所有涉及到时间的表述，都**必须**用第X天Y点的表述，禁止使用相对时间或当天
    // 天数: 第1天开始计数的天数
    // 日期: 世界观下当前日期,如无日期信息,则从第1天开始
    // 地点: 用.分隔大小地点，如“图书馆.三楼.阅览室”、“酒馆.二楼.卫生间”
    "天数": "第1天",
    "日期": "日期",
    "星期": "星期一",
    "正文出场或提及到的角色": "{{角色名1}},{{角色名2}},{{角色名3}},...",
    "任务记录": { // 任务记录：识别任务或委托信息，并及时更新状态
        "{{任务名}}": {
            "发布者": "{{角色名}}",
            "接受者": "{{角色名}}",
            "任务名": "{{任务名}}",
            "发布日": "{{天数}}",
            "截止日": "{{天数}}",
            "任务状态": "已过期/进行中/已完成",
            "任务进度": "任务进度",
            "任务要求": {
                // "主要要求": "完整未删减的任务主要求",
                // "次要要求1": "(可选)完整未删减的任务次要要求1"
                // ... 其它次要要求
            },
            "任务奖励": "任务奖励",
            "失败惩罚": "失败惩罚"
            // ... 其他任务信息
        }
        // ... 其他任务
    },
    "故事历程": [ // **只输出当前回复的信息** 以客观视角总结信息要点,突出事件的关键转折点,必须保留数字、人物、物品、时间时长、说明、描述、地点、要求等具体主体和客体信息，使用角色名代替人称。目标是用历程替代原信息时不丢失重要客观细节。
        {
            "天数":"第1天",
            "时间":"时间(可选)",
            "地点":"地点",
            "历程":["历程1","历程2","历程3"]
        }
        // ...
    ],
    "角色卡": {
        "{{角色名}}": {
            "角色设定": { // [角色设定]：此部分包含角色的核心、基础设定，初始化后不可更改，是判断角色行为是否OOC的最高依据。
                "角色名": "{{角色名}}",
                "核心人设": "{{最精炼的词语定义角色，这是AI在任何时候都应遵守的首要原则，也是判断角色行为是否“OOC”的重要依据，50字内}}",
                "行事底线": "{{角色绝对不会做的事，50字内}}",
                "根本欲望": "{{角色内心深处最渴望的东西，50字内}}",

                // [AI的表演脚本]：这是让AI说话、行动“像他”的最直接指令！
                "言行风格": {
                    "语言特点": "用词精准、正式，常使用长句和反问句主导对话，很少直接表露情感。",
                    "标志性言行": [
                        "口头禅: ‘理论上来说...’、‘简直是场灾难。’",
                        "习惯动作: 思考时用指尖轻敲眼镜框，烦躁时整理袖口。"
                    ]
                },
                "职业": "{{职业}}",
                "年龄": "{{年龄}}",
                "性别": "男/女",
                "背景": {
                    "概述": "出生于学者世家，因父亲的学术丑闻而度过了备受歧视的童年。",
                    "关键事件": [
                        "【15岁】目睹父亲被逐出皇家学院，这塑造了他对‘权威’和‘真相’的执念。",
                        "【25岁】成为导师马库斯的学生，找到了学术上的归属感。",
                        "【30岁】导师神秘失踪，留下了唯一的线索，故事由此开始。"
                    ]
                },
                "永久特征": { // 【身体蓝图】裸体时仍存在的永久特征，包含：体型/疤痕/纹身/天生属性
                    // 提取角色被提及的所有外貌和部位的**静态特征**描述, 填充时自选格式:
                    // 格式1. "部位1":"特征描述"
                    // 格式2. "部位2": {"特征1":"特征描述", "特征2":"特征描述"}
                    // 示例1: "手": "白玉似的手，指节泛白"
                    // 示例2: "身高": "172cm"
                    // 示例3: "臀部": {"尺寸": "94cm", "特征": "蜜桃一般，弹性十足"}
                    // 示例4: "胸部": {"尺寸": "110cm", "罩杯": "G罩杯", "特征": "白嫩，能看到青色血管" } **女性角色强制信息，可推测**
                }
            },
            "角色状态": { // [角色状态]：此部分记录角色的动态信息，会随着故事进展频繁更新。
                "武力等级": "{{武力等级}}", // 符合世界观的武力等级名称
                "兴趣爱好": {
                    // "兴趣爱好1":{ "level": 1, "desc": "描述" }
                    // ... 其它兴趣爱好
                },
                "场景人格":{ // 角色不同情境时所展现出的、相对固定的、独特的性格侧面与行为模式，不同场景的影响**独立**，互不影响
                    "普通场景人格": "{{由角色设定推测的角色在普通场景下的人格描述，普通场景经历影响普通场景人格，50字内}}",
                    "NSFW场景人格": "{{由角色设定推测的角色在NSFW场景下的人格描述，NSFW场景经历影响NSFW场景人格，50字内}}"
                },
                "身体状态": { // 【持续状态】事件引发的较长时间身体状态改变
                    // 记录会持续一段时间的生理变化/伤痕/体液残留等，排除瞬态反应
                    // 格式要求：每个状态必须包含持续天数(可预估)
                    // 格式: "部位": "[状态1描述][开始于第Y天][持续到第X天]，[状态2描述][持续到第X天]"，第X天为绝对时间而非相对时间
                    // 示例1: "背部": "[三道鞭痕][开始于第1天][持续到第2天]"
                    // 示例2: "乳头": "[掌掴后红肿][开始于第1天][持续到第1天]，[因催情药水敏感度提升][开始于第2天][持续到第3天]"
                    // 示例3: "双腿": "[无法动弹][开始于第1天][持续到第2天]"
                },
                "穿戴": { // 【穿戴层】可随时穿上/脱下的物品，包含：衣物/饰品/玩具/电子设备/...
                    // 提取角色被提及的着装信息, 按具体部位列出，格式 "具体部位":"[天数][着装描述]"，如佩戴饰物或者玩具也需记录
                    // 示例1: "下身": "[第1天][黑色西裤，黑色丝袜，黑色内裤]",
                    // 示例2: "乳头": "[第2天][黑色金属乳环，银色乳夹]"
                    // 示例3: "屁眼": "[第X天][粗大的肛塞]"
                },
                "场景快照": "[第X天][时间][地点]角色可观测的具体状态，包括：姿势、动作、生理反应、环境交互（避免主观形容词，用行为表现代替情绪）", // 示例："[第2天][10:15][别墅]双腿被皮带固定于沙发扶手，全身痉挛，阴道持续收缩，发出断续尖叫，眼角有泪"
                "和{{user}}的最新沟通":"[第X天][时间][抖音/微信/推特/微博]角色与{{user}}在通讯工具上的最新沟通，保留原文",
                "物品": { // 角色长期使用或主要用途的物品，排除一次性或临时物品，需随当前信息增减物品数量
                    // "物品1":{"价值":"100{{单位}}","数量": 1,"物品说明": "物品说明**复制原文**" }
                    // "物品2":{"价值":"100{{单位}}", "数量": 0, "物品说明": "物品说明**复制原文**" }
                },
                "技能": { // 角色的技能记录，随当前信息新增/调整
                    // "技能1":{ "品级": "天阶/SS","价值":"10000{{单位}}", "修炼等级": "修炼等级", "技能说明": "技能说明**复制原文**" }
                },
                "额外信息": { // 额外信息存储区：用于动态记录和更新本故事特有的各种属性和状态。
                    // 键名规则: 中文，确保清晰且无空格。
                    // 值类型: 可以是字符串、数字、布尔值或嵌套对象，根据信息特性灵活选择，但**禁止**使用数组。
                    // 示例1: "性生活频率": "一周两到三次"
                    // 示例2: "高潮次数": {"当天次数":次数, "累计次数":累计次数}
                }
            },
            "角色关系": { // [角色关系]：角色与其他人的社会关系，只能是一个名词
                // "莉娜": "伙伴",
                // "马库斯": "导师"
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

function fixupValue(key, object) {
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

        if ('精神状态' in object) {
            delete object['精神状态'];
        }

        if ('精神' in object) {
            delete object['精神'];
        }

        // 错误格式特殊修正
        // if ('角色关系' in object && key === '角色状态') {
        //     delete object['角色关系'];
        // }
        // if ('待办任务' in object && key === '角色状态') {
        //     delete object['待办任务'];
        // }
        // if ('新增待办任务' in object && key === '角色状态') {
        //     delete object['新增待办任务'];
        // }
        // if ('待办事项' in object && key === '角色状态') {
        //     delete object['待办事项'];
        // }
        // if ('待办事项' in object && key === '角色状态') {
        //     delete object['待办事项'];
        // }
        // if ('羞辱记录' in object && key === '角色状态') {
        //     delete object['羞辱记录'];
        // }
    }
    return object
}

function checkPath(path) {
    let current = json_template;
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

        // workaround for "和{{user}}的最新沟通"
        if (key.includes("最新沟通") && "和{{user}}的最新沟通" in current) {
            current = current["和{{user}}的最新沟通"];
            continue;
        }
        return false;
    }
    return true;
}

function deepMerge(target, delta, path = []) {
    // 检查target是否为数组并且source是否为字符串
    if (Array.isArray(target) && typeof delta === 'string') {
        // 使用正则表达式匹配 "delete start-end" 格式
        const regex = /delete\s+(\d+)\s*-\s*(\d+)/i;
        const match = delta.match(regex);

        if (match) {
            const start = parseInt(match[1]);
            const end = parseInt(match[2]);

            // 验证索引范围是否有效
            if (start >= 0 && end < target.length && start <= end) {
                // 创建新数组，不包含指定范围的元素
                return [
                    ...target.slice(0, start),
                    ...target.slice(end + 1)
                ];
            } else {
                console.warn(`Invalid index range ${start}-${end} for array of length ${target.length}. No items deleted.`);
            }
        }
    }
    if (Array.isArray(target) && Array.isArray(delta)) {
        // 过滤 source 中 target 已经存在的 item，比较方式是 JSON.stringify
        const targetStrSet = new Set(target.map(item => JSON.stringify(item)));
        const filteredSource = delta.filter(item => !targetStrSet.has(JSON.stringify(item)));
        return target.concat(filteredSource);
    }
    if (typeof target !== 'object' || target === null) return delta;
    if (typeof delta !== 'object' || delta === null) return target;
    const result = { ...target };
    for (const key of Object.keys(delta)) {
        if (key in target) {
            result[key] = fixupValue(key, deepMerge(target[key], delta[key], path.concat(key)));
        } else if (checkPath(path.concat(key))) {
            result[key] = delta[key];
        } else {
            console.warn(`[Chat History Optimization] Skipping unknown key at path: ${path.concat(key).join(' -> ')}`);
        }
    }
    return result;
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
                    mergedRoleData = deepMerge(mergedRoleData, itemObj);
                    mergedRoleDataHistory[j] = mergedRoleData;
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
        const process = item.历程.join('');

        // 组合成完整的两行格式
        return `${header}\n${process}`;
    }).join('\n\n');
}

function postProcess(data) {
    if (data && data.故事历程 && Array.isArray(data.故事历程)) {
        data.前文 = arrayToMarkdown(data.故事历程, extension_settings[extensionName].keepCount) + '\n' + (data.前文 || '');
        data.故事历程 = [];
        printObj("[Chat History Optimization] Post Processed 前文", data.前文);
    }
    return data;
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
**在正文后生成<delta>信息，提取<ROLE_DATA>发生改变的字段（严格遵循<ROLE_DATA_TEMPLATE>字段注释中的规则），省略未改变字段，确保输出为有效JSON。**
<delta>
//change of role data, output valid JSON only
</delta>

</ROLE_PLAY>
`
    return prompt;
}

function isCharNameRecent(chat, charName, recentThreshold = 10) {
    for (let j = chat.length - 1; j >= 0 && j >= chat.length - recentThreshold; j--) {
        const item = chat[j];
        if (item && item.mes && item.mes.includes(charName)) {
            return true;
        }
    }
    return false;
}

globalThis.replaceChatHistoryWithDetails = async function (chat, contextSize, abort, type) {
    if (!extension_settings[extensionName].extensionToggle) {
        console.info("[Chat History Optimization] extension is disabled.")
        return;
    }

    let mergedDataInfo = mergeDataInfo(chat);
    let finalRoleDataInfo = mergedDataInfo.roledata || {};

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
    // 过滤掉任务状态为'已完成'的任务
    if (finalRoleDataInfo && finalRoleDataInfo.任务记录 && typeof finalRoleDataInfo.任务记录 === 'object') {
        for (const key of Object.keys(finalRoleDataInfo.任务记录)) {
            const task = finalRoleDataInfo.任务记录[key];
            if (task && (task.任务状态 === '已完成' || task.任务状态 === '已失败' || task.任务状态 === '已取消')) {
                delete finalRoleDataInfo.任务记录[key];
            }
        }
    }
    // 处理角色信息，只保留最近或将要提及的角色信息
    if (finalRoleDataInfo && finalRoleDataInfo.角色卡 && typeof finalRoleDataInfo.角色卡 === 'object') {
        for (const roleName of Object.keys(finalRoleDataInfo.角色卡)) {
            if (!isCharNameRecent(chat, roleName, 10)) {
                finalRoleDataInfo.角色卡[roleName] = {};
            }
        }
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
                // 提取 </thinking> 到 <post_thinking> 之间的内容（不包含标签本身）
                const match = item.mes.match(/<\/thinking>([\s\S]*?)<post_thinking>/i);
                return match ? match[1].trim() : item.mes;
            });
        finalRoleDataInfo.前文 = tail.join('\n');
    } else {
        finalRoleDataInfo.前文 = "";
    }
    $("#token-count").prop("textContent", "4");
    let tokenCount = await getTokenCountAsync(JSON.stringify(finalRoleDataInfo));
    while (tokenCount > extension_settings[extensionName].tokenLimit) {
        finalRoleDataInfo.故事历程 = finalRoleDataInfo.故事历程.slice(Math.floor(finalRoleDataInfo.故事历程.length / 10));
        tokenCount = await getTokenCountAsync(JSON.stringify(finalRoleDataInfo));
        console.warn("[Chat History Optimization] Summary info is too large, reduce message to count.", tokenCount);
    }

    $("#token-count").prop("textContent", `${tokenCount}`);
    console.log("[Chat History Optimization] token count:", tokenCount);
    if (finalRoleDataInfo && finalRoleDataInfo.天数) {
        finalRoleDataInfo = JSON.parse(convertDayReferences(JSON.stringify(finalRoleDataInfo), finalRoleDataInfo.天数));
    }
    mergedDataInfo.roledata = finalRoleDataInfo
    printObj("[Chat History Optimization] Final Summary Info Post", mergedDataInfo);

    const mergedChat = [];
    chat[chat.length - 1]['mes'] = getCharPrompt(mergedDataInfo);
    if (chat.length == 2 && chat[0].is_user === false && chat[1].is_user === true) {
        chat[chat.length - 1]['mes'] = chat[chat.length - 1]['mes'] + "\n（此为首条信息，<delta>中需要参考`前文`和当前输出的信息）";
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

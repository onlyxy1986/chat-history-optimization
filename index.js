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
    // **注意** 所有时间表述都**必须**用第X天Y点的表述，禁止使用相对时间或"当天""当前""明天"等词汇
    // 天数: 第1天开始计数的天数
    // 日期: 世界观下当前日期,如无日期信息,则从第1天开始
    // 地点: 用.分隔大小地点，如“图书馆.三楼.阅览室”、“酒馆.二楼.卫生间”
    "天数": "第1天",
    "日期": "日期",
    "星期": "星期一",
    "正文出场或提及到的角色": "{{角色名1}},{{角色名2}},{{角色名3}},...",
    "故事历程": [ // **只输出当前回复的信息**
        {
            "天数":"第1天",
            "时间":"9:00至10:00",
            "地点":"地点",
            "历程":"{{总结当前回复中的外部可观测事实，避免主观角色感受 要求:1.保留有关键的具体信息(重要动作、数字、人物、物品、时间、说明、描述、地点、要求、承诺、言语、规则解释、事实、推断、招式名等) 2.使用角色名代替人称 3.禁止使用形容词和副词 4.忽略角色的情绪和心态转变"
        }
        // ...
    ],
    "角色卡": {
        "{{角色名}}": { //所有角色都必须有完整的角色卡
            "角色设定": { // [角色设定]：此部分包含角色的核心、基础设定，初始化后不可更改，是判断角色行为是否OOC的最高依据。
                "角色名": "{{角色名}}",
                "世界观": "{{为角色定义一个深刻的'世界观'。不要只用'乐观/悲观'来概括。。请具体描述角色眼中世界的运行法则、人性的本质，以及角色自认为在其中的位置。这种世界观需要能解释角色的一些独特行为。}}",
                "核心驱动力": "{{为角色定义'核心驱动力'。这不是指具体的目标（如'赚钱'），而是指驱动角色去实现所有目标的内心最深层的欲望或恐惧。这个驱动力是正面的（如爱、守护）还是负面的（如恨、恐惧）？它如何塑造了角色的长期追求？}}",
                "情绪反应": "{{为角色设计一个'情绪反应模型'。请使用'当[触发条件]时，他/她会感到[情绪]，并表现为[外在行为]'的格式，描述至少三种不同的情绪反应。这应该能体现角色的性格弱点或隐藏特质。}}",
                "内部矛盾": "{{为角色设计一个核心的'内部矛盾'。请使用'[价值观A] vs [与之冲突的价值观B]'的格式来清晰地定义它。并简要说明，在什么样的情景下，这个矛盾会让角色感到挣扎。}}",
                "成长可能": "{{为角色预设一种'成长可能'。基于角色的世界观和内部矛盾，设想一个可能从根本上改变角色的关键事件或人物。角色会因此变得更好还是更糟？这种转变会如何体现在角色的行为上？}}",
                "行事底线": "{{基于角色设定他绝对不会做的事情。}}",

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
                "永久身体特征": { // 裸体时仍**永久**存在的身体特征的客观描述，填充时自选格式:
                    // 格式1. "部位1":"特征描述"
                    // 格式2. "部位2": {"特征1":"特征描述", "特征2":"特征描述"}
                    // 示例1: "面容": "棱角分明的刀削面庞，冷白皮，狭长的凤眼"
                    // 示例2: "手": "白玉似的手，指节泛白"
                    // 示例3: "身高": "172cm"
                    // 示例4: "臀部": {"尺寸": "94cm", "特征": "蜜桃一般，弹性十足"}
                    // 示例5: "处女": "是/否，由XX破处"
                    // 示例6: "胸部": {"尺寸": "110cm", "罩杯": "G罩杯", "特征": "白嫩，能看到青色血管" } **女性角色强制信息，可推测**
                },
                "场景人格":{ // 角色不同情境时所展现出的、相对固定的、独特的性格侧面与行为模式，不同场景的影响**独立**，互不影响
                    "SFW场景人格": "{{用三个形容词描述角色在SFW场景下的人格描，例如: 清冷,善良,严苛}}",
                    "NSFW场景人格": "{{用三个形容词描述角色在NSFW场景下的人格描，例如: 羞涩,被动,敏感}}"
                }
            },
            "角色状态": { // [角色状态]：此部分记录角色的动态信息，会随着故事进展频繁更新。
                "武力等级": "{{武力等级}}", // 符合世界观的武力等级名称
                "穿戴": { // 【穿戴层】可随时穿上/脱下的物品，包含：衣物/饰品/玩具/电子设备/...
                    // 提取角色被提及的当前着装信息, 按具体部位列出，格式 "具体部位":"[天数][着装描述]"，如佩戴饰物或者玩具也需记录
                    // 示例1: "下身": "[第1天][黑色西裤][黑色丝袜][黑色内裤]",
                    // 示例2: "乳头": "[第2天][黑色金属乳环][银色乳夹]"
                    // 示例3: "屁眼": "[第X天][粗大的肛塞]"
                },
                "短期身体特征": {
                    // 角色的短期身体特征,在短期内预期会消失,超过时效应及时置为[无],不记录1天内能恢复的身体特征
                    // 格式1. "部位1":"[第X天至第Y天][临时特征1],[第A天至第B天][临时特征2],..."
					// 示例1. "乳头":"[第1天到第2天][因被捏玩而肿大]"
					// 示例2. "屁股":"[第1天到第2天][因被拍打而红肿],[第1天到第3天][因被鞭打而留下血痕]"
                },
                "物品": { // 角色拥有的战斗用相关物品
                    // "物品名":{"价值":"100{{单位}}","数量": 1,"物品说明": "完整的物品用途的静态描述" }
                },
                "技能": { // 角色拥有技能的详尽信息
                    // "技能名":{ "品级": "天阶/SS","价值":"10000{{单位}}", "修炼等级": "修炼等级", "技能说明": "完整的技能描述" }
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

function isPrimitive(val) {
    return val === null || (typeof val !== 'object' && typeof val !== 'function');
}


function deepMerge(merged, delta, path = []) {
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
            merged[key] = deepMerge(merged[key], delta[key], path.concat(key));
        } else if (checkPath(path.concat(key))) {
            if (Array.isArray(delta[key])) {
                merged[key] = deepMerge([], delta[key], path.concat(key));
            } else if (typeof delta[key] === 'object') {
                merged[key] = deepMerge({}, delta[key], path.concat(key));
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
        if (merged && merged.角色卡 && typeof merged.角色卡 === 'object') {
            for (const roleName of Object.keys(merged.角色卡)) {
                if (merged.角色卡[roleName].角色状态 && merged.角色卡[roleName].角色状态.穿戴) {
                    merged.角色卡[roleName].角色状态.穿戴 = {};
                }
            }
        }
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
                    objMatch[0] = objMatch[0].replace(/<你好和谐>/g, '');
                    const itemObj = JSON.parse(objMatch[0]);
                    item.messageCount = 0;
                    if (itemObj.故事历程) {
                        item.messageCount = itemObj.故事历程.length;
                    }
                    mergedRoleData = deepMerge(mergedRoleData, itemObj);
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
    printObj("[Chat History Optimization] Post Processed 前文", data.前文);
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
**在正文后生成<delta>信息，提取<ROLE_DATA>发生改变的字段（严格遵循<ROLE_DATA_TEMPLATE>字段注释中的规则），禁止输出未改变字段，确保输出为有效JSON。**
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
            if (finalRoleDataInfo.角色卡[roleName] && finalRoleDataInfo.角色卡[roleName].角色状态 && finalRoleDataInfo.角色卡[roleName].角色状态.短期身体特征) {
                delete finalRoleDataInfo.角色卡[roleName].角色状态.短期身体特征;
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
            if (!isCharNameRecent(chat, roleName, 20)) {
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
                keepMessageCount += item.messageCount;
                // 提取 </thinking> 到 <post_thinking> 之间的内容（不包含标签本身）
                let match = item.mes.match(/<\/(?:think|thinking)>([\s\S]*?)<post_thinking>/i);
                if (!match) {
                    match = item.mes.match(/<\/(?:think|thinking)>([\s\S]*?)<delta>/i);
                }
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
        finalRoleDataInfo.故事历程 = JSON.parse(convertDayReferences(JSON.stringify(finalRoleDataInfo.故事历程), finalRoleDataInfo.天数));
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

// The main script for the extension
// The following are examples of some basic extension functionality

//You'll likely need to import extension_settings, getContext, and loadExtensionSettings from extensions.js
import { extension_settings, getContext, loadExtensionSettings } from "../../../extensions.js";
import { getTokenCountAsync } from '../../../tokenizers.js';
//You'll likely need to import some other functions from the main script
import { saveSettingsDebounced, this_chid, characters } from "../../../../script.js";

const context = SillyTavern.getContext();

let history_json_template = null;
let character_json_template = null;

// Keep track of where your extension is located, name should match repo name
const extensionName = "chat-history-optimization";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
const defaultSettings = {
    extensionToggle: false,
    roleCardToggle: true, // 角色卡功能开关，默认启用
    keepCount: 3,
    tokenLimit: 50 * 1024,
    historyPrompt: `{
    // **注意** 所有时间表述都**必须**用第X天+时间段的表述，如：第3天傍晚
    // 地点: 用.分隔大小地点，如“图书馆.三楼.阅览室”、“酒馆.二楼.卫生间”
    "故事历程": [ // **每次回复强制输出，仅针对最新回复做历程记录**
        {
            "天数":"第1天",
            "时间段":"清晨/上午/中午/下午/傍晚/晚上/深夜/凌晨",
            "地点":"地点",
            "历程":"{{总结当前消息要点，需用词明确，主客体清晰 要求:1.必须保留所有关键细节，比如重要动作、暗示、数字、人数、人物、物品、时间、日期、日程安排、说明、描述、地点、要求、承诺、言语、规则、事实、推断、招式名、对话、安排等 2.使用角色名代替人称，不要用模糊指代 3.NSFW场景用词需极简 4.相对时间记录时必须转为绝对时间，例如:相约明天(第13天)去逛街}}"
        }
        // ...
    ]
}`,
    characterPrompt: `{ // **仅新角色出现时输出**
        "{{角色名}}": { //所有角色都必须有完整的角色卡
            "角色设定": { // [角色设定]：此部分包含角色的**不可更改的**核心基础设定，是判断角色行为是否OOC的最高依据。
                "角色名": "{{角色名}}",
                "职业": "{{职业}}",
                "年龄": "{{年龄}}",
                "性别": "男/女",
                "背景": "{{客观概括人物在故事开始前的人生经历，不涉及人物主观想法，不随故事更新}}",
                "永久身体特征": { // 身体的固有特征或不可逆的改变，以下示例为**必填**部位，也可根据需要新增其他部位:
                    // 格式. "部位":"特征描述"
                    // 必填: "身高": "具体数值+整体体型给人的色气印象（如丰腴肉感/纤腰硕乳/筋肉结实等）"
                    // 必填: "面容": "五官特征+肤色+最能勾起欲望的表情或神态"
                    // 必填: "头发": "发色+长度+发质+散落时的色气姿态"
                    // 必填: "胸部": "胸围数值+罩杯+形状与下垂度+乳肉触感与弹性+乳晕颜色大小+乳头大小形态与挺翘度+受刺激时的反应"
                    // 必填: "腰部": "腰围数值+腰臀比例+被握住时的手感"
                    // 必填: "臀部": "尺寸+形状（如蜜桃/满月/心形）+走动时的晃动程度+肉感与回弹力+承托力"
                    // 必填: "腿部": "腿长数值+身腿比例+腿型线条+大腿内侧的肉感+交缠时的触感"
                    // 必填: "阴部": "花瓣形态与厚薄+颜色深浅+阴蒂大小形态+松紧度+敏感带与反应"
                    // 必填: "后穴": "颜色深浅+褶皱形态+松紧度+是否开发过+承受力"
                    // 必填: "足部": "足型+趾型+肤色+是否敏感"
                    // 必填: "处女": "是/否"
                }
            }
        }
        // ... 其他角色
}`,
};

const wordMapping = {
    "崩溃": "失控",
    "绝望": "难过",
    "空洞": "恍惚",
    "麻木": "迟钝",
    "认命": "妥协",
    "极端": "偏激",
    "扭曲": "纠结",
    "神圣": "重要",
    "疯狂": "激动",
    "痛苦": "难受",
    "愤怒": "生气",
    "杀戮": "冲突",
    "彻底": "",
    "学术": ""
}

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
    $("#role_card_toggle").prop("checked", extension_settings[extensionName].roleCardToggle ?? defaultSettings.roleCardToggle).trigger("input");
    $("#keep_count").prop("value", extension_settings[extensionName].keepCount ?? defaultSettings.keepCount).trigger("input");
    // 加载 historyPrompt / characterPrompt 到各自的 textarea
    $("#history_prompt_textarea").prop("value", extension_settings[extensionName].historyPrompt ?? defaultSettings.historyPrompt).trigger("input");
    $("#character_prompt_textarea").prop("value", extension_settings[extensionName].characterPrompt ?? defaultSettings.characterPrompt).trigger("input");
    $("#token_limit").prop("value", extension_settings[extensionName].tokenLimit ?? defaultSettings.tokenLimit).trigger("input");
}

function onToggleInput(event) {
    const value = Boolean($(event.target).prop("checked"));
    extension_settings[extensionName].extensionToggle = value;
    saveSettingsDebounced();
}

function onRoleCardToggleInput(event) {
    const value = Boolean($(event.target).prop("checked"));
    extension_settings[extensionName].roleCardToggle = value;
    saveSettingsDebounced();
}

function isRoleCardEnabled() {
    return extension_settings[extensionName].roleCardToggle ?? defaultSettings.roleCardToggle;
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

function onHistoryPromptInput(event) {
    let val = $(event.target).val();
    // 移除//开头的注释
    let jsonStr = val.replace(/\/\/.*$/gm, '');
    let isValid = false;
    try {
        history_json_template = JSON.parse(jsonStr);
        printObj("[Chat History Optimization] Loaded history prompt template", history_json_template);
        isValid = true;
    } catch (e) {
        console.error(`[Chat History Optimization] JSON parse error`, jsonStr, e);
        history_json_template = null;
        isValid = false;
    }
    // 设置 index.html 选中区标签内容
    $("#history_prompt_validity").text(isValid ? "(有效)" : "(无效)");
    extension_settings[extensionName].historyPrompt = val;
    saveSettingsDebounced();
}

function onCharacterPromptInput(event) {
    let val = $(event.target).val();
    // 移除//开头的注释
    let jsonStr = val.replace(/\/\/.*$/gm, '');
    let isValid = false;
    try {
        character_json_template = JSON.parse(jsonStr);
        printObj("[Chat History Optimization] Loaded character prompt template", character_json_template);
        isValid = true;
    } catch (e) {
        console.error(`[Chat History Optimization] JSON parse error`, jsonStr, e);
        character_json_template = null;
        isValid = false;
    }
    // 设置 index.html 选中区标签内容
    $("#character_prompt_validity").text(isValid ? "(有效)" : "(无效)");
    extension_settings[extensionName].characterPrompt = val;
    saveSettingsDebounced();
}

function checkPath(path, template) {
    let current = template;
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

/**
 * 生成角色名的所有搜索词（处理常见别名写法）
 * 支持: A(B), A（B）, A·B, A.B 等格式
 * 拆分后任意一部分匹配即算命中
 */
function getNameSearchTerms(name) {
    if (!name || typeof name !== 'string') return [];
    const terms = new Set();
    terms.add(name); // 原始名称始终包含

    // 按常见分隔符拆分：英文括号、中文括号、间隔号、英文句点
    const parts = name.split(/[\(\)（）·\.]/).filter(p => p.trim().length > 0);
    for (const part of parts) {
        terms.add(part);
    }

    return [...terms];
}

/**
 * 检查 name 的任意别名形式是否出现在 text 中
 * @param {string} name - 要搜索的角色名
 * @param {string} text - 被搜索的文本
 * @param {string[]} [allRoleNames] - 可选，所有已知角色名列表，用于消歧义：
 *   当 name 是另一个更长角色名的子串时（如"沈梦" vs "沈梦瑶"），
 *   检查每次出现是否被更长名字"吞掉"。只有至少一次出现是独立命中时才返回 true。
 */
function nameMatches(name, text, allRoleNames) {
    if (!name || !text) return false;
    const terms = getNameSearchTerms(name);

    for (const term of terms) {
        if (!text.includes(term)) continue;

        // 如果没有提供消歧义名单，简单包含匹配即可
        if (!allRoleNames || allRoleNames.length === 0) return true;

        // 找出所有包含当前 term 的更长的已知角色名
        // （例如 term="沈梦"，更长名="沈梦瑶"）
        const superNames = allRoleNames.filter(
            rn => rn !== name && rn.length > term.length && rn.includes(term)
        );

        // 没有更长名字包含它，命中有效
        if (superNames.length === 0) return true;

        // 遍历 term 在 text 中的每次出现，检查是否被更长名字"吞掉"
        let pos = -1;
        while ((pos = text.indexOf(term, pos + 1)) !== -1) {
            let subsumed = false;
            for (const superName of superNames) {
                const offset = superName.indexOf(term);
                const superStart = pos - offset;
                if (superStart >= 0 &&
                    superStart + superName.length <= text.length &&
                    text.substring(superStart, superStart + superName.length) === superName) {
                    subsumed = true;
                    break;
                }
            }
            if (!subsumed) return true; // 找到了至少一次独立出现
        }
        // 当前 term 的所有出现都被更长名字吞掉，继续检查下一个 term
    }

    return false; // 所有 term 的出现都被吞掉
}

function deepMerge(merged, delta, path = [], allowUpdate = false, template = null) {
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
    for (const key of Object.keys(delta)) {
        if (key in merged) {
            if (!allowUpdate && path.concat(key).includes("角色设定") && merged[key] && typeof merged[key] === 'string' && !merged[key].includes("未知") && key != "处女") {
                continue;
            }
            merged[key] = deepMerge(merged[key], delta[key], path.concat(key), allowUpdate, template);
        } else if (checkPath(path.concat(key), template)) {
            if (Array.isArray(delta[key])) {
                merged[key] = deepMerge([], delta[key], path.concat(key), allowUpdate, template);
            } else if (typeof delta[key] === 'object') {
                merged[key] = deepMerge({}, delta[key], path.concat(key), allowUpdate, template);
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
    return merged;
}

function mergeDataInfo(chat) {
    let failedChars = [];
    let historyData = {};
    let characterData = {};

    for (let j = 1; j < chat.length; j++) {
        const item = chat[j];
        if (item && (("is_user" in item && !item.is_user) || (item.role && item.role == "assistant"))) {
            let matches = [];
            if (item.mes) {
                matches = [...item.mes
                    .replace(/\/\/.*$/gm, '')
                    .matchAll(/<NEW_STORY_DATA>((?:(?!<NEW_STORY_DATA>)[\s\S])*?)<\/NEW_STORY_DATA>/gi)];
            }
            if (matches.length == 0 && ("swipes" in item && "swipe_id" in item && item.swipes[item.swipe_id])) {
                matches = [...item.swipes[item.swipe_id]
                    .replace(/\/\/.*$/gm, '')
                    .matchAll(/<NEW_STORY_DATA>((?:(?!<NEW_STORY_DATA>)[\s\S])*?)<\/NEW_STORY_DATA>/gi)];
            }
            if (matches.length > 0) {
                const block = matches[matches.length - 1][1];
                let failedSection = false;

                // --- NEW_HISTORY 区段：必选 ---
                const historyMatch = block.match(/<NEW_HISTORY>((?:(?!<NEW_HISTORY>)[\s\S])*?)<\/NEW_HISTORY>/i);
                if (historyMatch) {
                    const objMatch = historyMatch[1].trim().match(/\{[\s\S]*\}/);
                    if (objMatch) {
                        try {
                            const historyObj = JSON.parse(objMatch[0]);
                            historyData = deepMerge(historyData, historyObj, [], false, history_json_template);
                            item.messageCount = 0;
                            if (historyObj.故事历程) {
                                item.messageCount = historyObj.故事历程.length;
                            }
                        } catch (e) {
                            console.error(`[Chat History Optimization] NEW_HISTORY JSON parse error at chat[${j}]:`, e);
                            console.error(`[Chat History Optimization] NEW_HISTORY content:`, objMatch[0]);
                            failedSection = true;
                        }
                    } else {
                        failedSection = true;
                    }
                } else {
                    failedSection = true; // 缺 NEW_HISTORY 视为失败
                }

                // --- NEW_CHARACTER_CARD 区段：可选（无新角色/开关关闭时合法缺失）---
                if (isRoleCardEnabled()) {
                    const charMatch = block.match(/<NEW_CHARACTER_CARD>((?:(?!<NEW_CHARACTER_CARD>)[\s\S])*?)<\/NEW_CHARACTER_CARD>/i);
                    if (charMatch && charMatch[1].trim()) {
                        const objMatch = charMatch[1].trim().match(/\{[\s\S]*\}/);
                        if (objMatch) {
                            try {
                                const charObj = JSON.parse(objMatch[0]);
                                let allowUpdate = charObj.allowUpdate || false;
                                delete charObj.allowUpdate;
                                characterData = deepMerge(characterData, charObj, [], allowUpdate, character_json_template);
                            } catch (e) {
                                console.error(`[Chat History Optimization] NEW_CHARACTER_CARD JSON parse error at chat[${j}]:`, e);
                                console.error(`[Chat History Optimization] NEW_CHARACTER_CARD content:`, objMatch[0]);
                                failedSection = true;
                            }
                        } else {
                            failedSection = true;
                        }
                    }
                }

                if (failedSection) {
                    failedChars.push(j);
                }
            } else {
                failedChars.push(j);
            }
        }
    }

    if (failedChars.length > 0) {
        console.warn(`[Chat History Optimization] Failed to parse or missing <NEW_STORY_DATA> at chat indexes: ${failedChars.join(', ')}`);
        $("#chars-failed").prop("textContent", failedChars.join(', '));
    } else {
        $("#chars-failed").prop("textContent", "无");
    }

    return {
        "historyData": historyData,
        "characterData": characterData
    };
}

function parseDayNumber(dayStr) {
    if (typeof dayStr !== 'string') return null;
    const m = dayStr.match(/第\s*(\d+)\s*天/);
    return m ? parseInt(m[1], 10) : null;
}

function extractItemProcess(item) {
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
    return process;
}

function arrayToMarkdown(data, n = 0) {
    // 从完整数据中确定最新的天数（包含被n排除的尾部，以确保正确识别当前天）
    let maxDay = 0;
    for (const item of data) {
        const day = parseDayNumber(item.天数);
        if (day !== null && day > maxDay) maxDay = day;
    }

    // 计算需要处理的数据范围（排除最后n个元素）
    const endIndex = n > 0 ? data.length - n : data.length;
    const processedData = data.slice(0, endIndex);

    // 回退：没有可解析的天数，所有事件使用详细格式
    if (maxDay === 0) {
        return processedData.map(item => {
            const header = `# ${item.天数}|${item.时间段}|${item.地点}`;
            const process = extractItemProcess(item);
            return `${header.trim()}\n## ${process.trim()}`;
        }).join('\n');
    }

    // 按天数分组（无法解析的归入 -1）
    const groups = {};
    for (const item of processedData) {
        const day = parseDayNumber(item.天数);
        const key = day !== null ? day : -1;
        if (!groups[key]) groups[key] = [];
        groups[key].push(item);
    }

    // 按天数升序排列，构建输出
    const sortedKeys = Object.keys(groups).map(Number).sort((a, b) => a - b);
    const result = [];

    for (const dayNum of sortedKeys) {
        const items = groups[dayNum];

        if (dayNum === -1 || dayNum === maxDay) {
            // 当前天或无法解析的天：每个事件使用详细格式 [天数|时间段|地点]
            for (const item of items) {
                const header = `# ${item.天数}|${item.时间段}|${item.地点}`;
                const process = extractItemProcess(item);
                result.push(`${header.trim()}\n## ${process.trim()}`);
            }
        } else {
            // 之前的天：聚合格式 [第X天]\n所有历程
            const allProcess = items.map(item => extractItemProcess(item)).join('');
            result.push(`# ${items[0].天数}\n## ${allProcess.trim()}`);
        }
    }

    return result.join('\n');
}

function postProcessHistory(data) {
    if (data && data.故事历程 && Array.isArray(data.故事历程)) {
        data.前文 = arrayToMarkdown(data.故事历程, keepMessageCount) + '\n' + (data.前文 || '');
        data.故事历程 = [];
    }
    if (data && data.故事历程总结 && Array.isArray(data.故事历程总结)) {
        data.前文 = arrayToMarkdown(data.故事历程总结, 0) + '\n' + (data.前文 || '');
        delete data.故事历程总结;
    }
    // data.前文 = data.前文.replace(/<(?:NEW_STORY_DATA|delta)>((?:(?!<(?:NEW_STORY_DATA|delta)>)[\s\S])*?)<\/(?:NEW_STORY_DATA|delta)>/gi, '').trim();
    printObj("[Chat History Optimization] Post Processed 前文", data.前文);
    return data;
}

function getCharPrompt(historyData, characterData) {
    historyData = postProcessHistory(historyData || {});
    // 将前文从历史数据中剥离，单独放入HISTORY
    let historyContent = historyData.前文 || '';
    delete historyData.前文;
    // 对前文也应用敏感词替换
    for (const [key, value] of Object.entries(wordMapping)) {
        historyContent = historyContent.replace(new RegExp(key, 'g'), value);
    }
    let charsInfoJsonStr = JSON.stringify(characterData || {});
    for (const [key, value] of Object.entries(wordMapping)) {
        charsInfoJsonStr = charsInfoJsonStr.replace(new RegExp(key, 'g'), value);
    }

    // 角色卡功能关闭时，不注入角色卡区段与模板
    const roleCardEnabled = isRoleCardEnabled();
    const newHistoryTemplate = $("#history_prompt_textarea").val();
    const newCharacterCardTemplate = roleCardEnabled ? $("#character_prompt_textarea").val() : '';

    const prompt = `
<STORY_DATA>

<HISTORY>
${historyContent}
</HISTORY>

${roleCardEnabled ? `<CHARACTER_CARD>
${charsInfoJsonStr}
</CHARACTER_CARD>
` : ''}
</STORY_DATA>

**在回复最末尾必须生成当前正文的NEW_STORY_DATA信息。若本次回复没有新角色出现或角色信息无变化，可省略NEW_CHARACTER_CARD区段。**
<NEW_STORY_DATA>
<NEW_HISTORY> // **新HISTORY信息的模板**
${newHistoryTemplate}
</NEW_HISTORY>
${roleCardEnabled ? `<NEW_CHARACTER_CARD> // **新CHARACTER_CARD信息的模板**
${newCharacterCardTemplate}
</NEW_CHARACTER_CARD>
` : ''}
</NEW_STORY_DATA>
`
    return prompt;
}

/**
 * 角色卡淘汰与蒸馏：固定 10 槽位上限
 * 当前 prompt 提到的角色得分 1,000,000（保证保留）；其余按最后出现索引计分
 * 超过 30 条消息未活跃（且非当前提问提及）的角色只保留核心设定
 * @param {object} characterData - 角色卡映射 { 角色名: {...} }
 * @param {object[]} chat - 原始聊天记录
 * @returns {object} 精简后的角色卡映射
 */
function processCharacterData(characterData, chat) {
    const MAX_SLOTS = 10;
    if (!characterData || typeof characterData !== 'object') return characterData;

    const roleScores = [];
    const userPrompt = chat[chat.length - 1]?.mes || "";
    const roleNames = Object.keys(characterData);

    // 构建所有已知角色名集合，用于消歧义：
    // 当"沈梦"和"沈梦瑶"同时存在时，"沈梦"在文本中的匹配不会被"沈梦瑶"吞掉才算真正命中
    const allKnownNames = [...new Set(roleNames)];

    for (const roleName of roleNames) {
        let score = -1;

        // 1. 意图驱动：如果最新 Prompt 提到了，给予极高优先级（确保唤醒）
        if (nameMatches(roleName, userPrompt, allKnownNames)) {
            score = 1000000;
        } else {
            // 2. 活跃度：寻找最后一次出现的索引作为基础分
            for (let i = chat.length - 1; i >= 0; i--) {
                const mes = chat[i].mes || "";
                if (nameMatches(roleName, mes, allKnownNames)) {
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
        const originalData = characterData[roleName];

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
    return newRoleCards;
}

globalThis.replaceChatHistoryWithDetails = async function (chat, contextSize, abort, type) {
    if (!chat || !Array.isArray(chat) || chat.length === 0) {
        console.warn("[Chat History Optimization] No chat history to process.");
        return;
    }
    if (!extension_settings[extensionName].extensionToggle) {
        console.info("[Chat History Optimization] extension is disabled.")
        return;
    }

    keepMessageCount = 0;
    // 捕获改写前的原始用户消息，供 {{lastUserReact}} 使用
    const lastMsg = chat[chat.length - 1];
    if (lastMsg && lastMsg.is_user && !lastMsg.is_system) {
        lastRawUserMessage = lastMsg.mes || '';
    }
    printObj("[Chat History Optimization] Original chat history:", chat);
    let isFirstMessage = false;
    if (chat.length == 2 && chat[0].is_user === false && chat[1].is_user === true) {
        isFirstMessage = true;
    }
    let mergedDataInfo = mergeDataInfo(chat);
    let historyData = mergedDataInfo.historyData || {};
    let characterData = mergedDataInfo.characterData || {};

    // 更新角色下拉框和信息显示
    globalThis.updateRoleSelectAndInfo(JSON.parse(JSON.stringify(characterData || {})));

    const tokenCount_origin = await getTokenCountAsync(JSON.stringify(historyData) + JSON.stringify(characterData));
    console.log("[Chat History Optimization] origin token count:", tokenCount_origin);
    printObj("[Chat History Optimization] Final Summary Info Pre", { historyData, characterData });
    $("#token-count").prop("textContent", "1");
    // --- 优化后的角色卡管理：固定 10 槽位上限 ---
    characterData = processCharacterData(characterData, chat);

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
                return item.mes;
            });
        historyData.前文 = tail.join('\n');
    } else {
        historyData.前文 = "";
    }
    $("#token-count").prop("textContent", "4");
    let tokenCount = await getTokenCountAsync(JSON.stringify(historyData) + JSON.stringify(characterData));
    // 超限裁剪：剪故事历程；故事历程已空仍超限则停止（硬停守卫，旧代码会无限循环）
    while (tokenCount > extension_settings[extensionName].tokenLimit && historyData.故事历程 && historyData.故事历程.length > 0) {
        historyData.故事历程 = historyData.故事历程.slice(Math.floor(historyData.故事历程.length / 50));
        tokenCount = await getTokenCountAsync(JSON.stringify(historyData) + JSON.stringify(characterData));
        console.warn("[Chat History Optimization] Summary info is too large, reduce message to count.", tokenCount);
    }
    if (tokenCount > extension_settings[extensionName].tokenLimit) {
        console.warn("[Chat History Optimization] Summary info still exceeds token limit after trimming history.");
    }

    $("#token-count").prop("textContent", `${tokenCount}`);
    console.log("[Chat History Optimization] token count:", tokenCount);
    printObj("[Chat History Optimization] Final Summary Info Post", { historyData, characterData });

    const mergedChat = [];
    chat[chat.length - 1]['mes'] = getCharPrompt(historyData, characterData);
    if (isFirstMessage) {
        chat[chat.length - 1]['mes'] = chat[chat.length - 1]['mes'] + "\n（此为首条信息，<NEW_STORY_DATA>中需要参考前文和当前输出的信息生成全量信息，尤其注意'故事历程'需额外添加前文的历程）";
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
    $("#role_card_toggle").on("input", onRoleCardToggleInput);
    $("#keep_count").on("input", onKeepCountInput);
    $("#history_prompt_textarea").on("input", onHistoryPromptInput);
    $("#character_prompt_textarea").on("input", onCharacterPromptInput);
    $("#token_limit").on("input", onTokenLimitInput);
    $("#react_rules_textarea").on("input", onReactRulesInput);
    $("#react_default").on("input", onReactDefaultInput);
    $("#react_rules_reset").on("click", function () {
        $("#react_rules_textarea").val(defaultSettings.reactRules).trigger("input");
        $("#react_default").val(defaultSettings.reactDefault).trigger("input");
    });

    // 注册 {{lastUserReact}}：根据最后一条用户消息匹配规则返回对应值
    macros.register('lastUserReact', {
        category: MacroCategory.CHAT,
        description: '根据最后一条用户消息匹配 Chat History Optimization 扩展中配置的第一条规则，返回其值；无匹配时返回默认值。',
        returns: '匹配规则的值或默认值',
        exampleUsage: ['{{lastUserReact}}'],
        handler: () => {
            const matched = matchReactRules(getReactSourceMessage());
            return matched ?? (extension_settings[extensionName].reactDefault ?? '');
        },
    });

    $("#history_prompt_reset").on("click", function () {
        $("#history_prompt_textarea").val(defaultSettings.historyPrompt).trigger("input");
    });
    $("#character_prompt_reset").on("click", function () {
        $("#character_prompt_textarea").val(defaultSettings.characterPrompt).trigger("input");
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

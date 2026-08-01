// The main script for the extension
// The following are examples of some basic extension functionality

//You'll likely need to import extension_settings, getContext, and loadExtensionSettings from extensions.js
import { extension_settings, getContext, loadExtensionSettings } from "../../../extensions.js";
import { getTokenCountAsync } from '../../../tokenizers.js';
//You'll likely need to import some other functions from the main script
import { saveSettingsDebounced, this_chid, characters } from "../../../../script.js";

const context = SillyTavern.getContext();

let json_template = null; // 过渡期兼容别名，Task 2 删除
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
    // **注意** 所有时间表述都**必须**用第X天Y点的表述
    // 天数: 第1天开始计数的天数
    // 日期: 世界观下当前日期,如无日期信息,则从第1天开始
    // 地点: 用.分隔大小地点，如“图书馆.三楼.阅览室”、“酒馆.二楼.卫生间”
    "天数": "第1天",
    "日期": "日期",
    "星期": "星期一",
    "正文出场或提及到的角色": "{{角色名1}},{{角色名2}},{{角色名3}},...",
    "故事历程": [ // **每次回复强制输出**
        {
            "天数":"第1天",
            "时间":"9:00至10:00",
            "地点":"地点",
            "历程":"{{总结当前消息要点，需用词明确 要求:1.必须保留所有关键信息，比如重要动作、暗示、数字、人物、物品、时间、日期、日程安排、说明、描述、地点、要求、承诺、言语、规则、事实、推断、招式名、对话、安排等 2.使用角色名代替人称 3.NSFW场景用词需极简 4.记录相对时间时必须附上绝对时间，例如:相约明天(第13天)去逛街}}"
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
            "背景": {
                "概述": "{{以一句话客观概括人物在故事开始前的人生经历，不涉及人物主观想法，不随故事更新}}"
            },
            "永久身体特征": { // 身体的固有特征或不可逆的改变，填充时自选格式:
                // 格式1. "部位1":"特征描述"
                // 格式2. "部位2": {"特征1":"特征描述", "特征2":"特征描述"}
                // 示例1: "面容": "棱角分明的刀削面庞，冷白皮，狭长的凤眼"
                // 示例2: "手": "白玉似的手，指节泛白"
                // 示例3: "身高": "172cm"
                // 示例4: "臀部": {"尺寸": "94cm", "特征": "蜜桃一般，弹性十足"}
                // 示例5: "处女": "是/否，由XX破处"
                // 示例6: "胸部": {"尺寸": "110cm", "罩杯": "G罩杯", "特征": "白嫩，能看到青色血管" }
            },
            "性癖": "性癖A,性癖B,…",
            "场景人格":{ // 角色不同情境时所展现出的、相对固定的、独特的性格侧面与行为模式，不同场景的影响**独立**，互不影响
                "SFW场景人格": "{{用三个词描述角色在SFW场景下的表现}}",
                "NSFW场景人格": "{{用三个词描述角色在NSFW场景下的表现}}"
            }
        }
    }
    // ... 其他角色
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
        json_template = history_json_template; // 过渡期兼容别名，Task 2 删除
        printObj("[Chat History Optimization] Loaded history prompt template", history_json_template);
        isValid = true;
    } catch (e) {
        console.error(`[Chat History Optimization] JSON parse error`, jsonStr, e);
        history_json_template = null;
        json_template = null;
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

function deepMerge(merged, delta, path = [], allowUpdate = false) {
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
            if (!allowUpdate && path.concat(key).includes("角色设定") && merged[key] && typeof merged[key] === 'string' && !merged[key].includes("未知") && key != "处女") {
                continue;
            }
            merged[key] = deepMerge(merged[key], delta[key], path.concat(key), allowUpdate);
        } else if (checkPath(path.concat(key))) {
            if (Array.isArray(delta[key])) {
                merged[key] = deepMerge([], delta[key], path.concat(key), allowUpdate);
            } else if (typeof delta[key] === 'object') {
                merged[key] = deepMerge({}, delta[key], path.concat(key), allowUpdate);
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
                    const itemObj = JSON.parse(objMatch[0]);
                    // 角色卡功能关闭时，不合并角色卡数据
                    if (!isRoleCardEnabled()) delete itemObj.角色卡;
                    item.messageCount = 0;
                    if (itemObj.故事历程) {
                        item.messageCount = itemObj.故事历程.length;
                    }
                    let allowUpdate = itemObj.allowUpdate || false;
                    mergedRoleData = deepMerge(mergedRoleData, itemObj, [], allowUpdate);
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
    return text;
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

function generateTimeAnchor(dayStr) {
    const dayNum = parseDayNumber(dayStr);
    if (dayNum === null || dayNum <= 0) return '';

    let anchor = '<日期换算表>\n';
    anchor += '# 说明：以下为“相对日期”与“绝对天数（第X天）”的映射表，AI提及相对时间时请严格查表换算，注意天数推进时"昨天"会变成"前天"\n';
    anchor += `今天=${dayStr}, 昨天=第${dayNum - 1}天, 前天=第${dayNum - 2}天`;
    for (let i = 3; i <= Math.min(dayNum - 1, 7); i++) {
        anchor += `, ${i}天前=第${dayNum - i}天`;
    }
    anchor += '\n</日期换算表>';
    return anchor;
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
    data.前文 = data.前文.replace(/<delta>((?:(?!<delta>)[\s\S])*?)<\/delta>/gi, '').trim();
    // 在前文末尾附加时间锚点，方便AI将相对时间引用转换为绝对天数
    if (data && data.天数) {
        data.前文 += '\n\n' + generateTimeAnchor(data.天数);
    }
    printObj("[Chat History Optimization] Post Processed 前文", data.前文);
    return data;
}

/**
 * 从模板文本中剔除顶层 "角色卡": {...} 段落，其余文本（含 // 注释与排版）原样保留
 * 单次正向扫描：跳过字符串（防 {{占位符}} 干扰）与注释，按花括号深度识别根对象层级的键
 */
function stripRoleCardSection(templateText) {
    if (typeof templateText !== 'string') return templateText;
    let depth = 0;
    let inStr = false;
    let keyStart = -1;      // "角色卡" 键的起始位置
    let lastComma = -1;     // 根对象层级最近一次逗号位置（用于连同前导逗号一起删除）
    let end = -1;           // 值对象的结束位置（含闭合 '}'）
    for (let i = 0; i < templateText.length; i++) {
        const c = templateText[i];
        const next = templateText[i + 1];
        if (inStr) {
            if (c === '\\') { i++; continue; }
            if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') {
            inStr = true;
            if (depth === 1 && keyStart === -1 && templateText.startsWith('"角色卡"', i)) {
                keyStart = i;
            }
            continue;
        }
        if (c === '/' && next === '/') { while (i < templateText.length && templateText[i] !== '\n') i++; continue; }
        if (c === '/' && next === '*') { i += 2; while (i < templateText.length && !(templateText[i] === '*' && templateText[i + 1] === '/')) i++; i++; continue; }
        if (c === '{') {
            depth++;
            continue;
        }
        if (c === '}') {
            if (keyStart !== -1 && depth === 2 && end === -1) end = i + 1;
            depth--;
            continue;
        }
        if (c === ',' && depth === 1 && keyStart === -1) lastComma = i;
    }
    if (end === -1 || depth !== 0) return templateText; // 未找到键或括号不配对，安全返回原文

    // 跳过空白与注释，返回 s 中第一个有效字符的位置
    const skipJunk = (s, i) => {
        while (i < s.length) {
            const c = s[i];
            if (/\s/.test(c)) { i++; continue; }
            if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
            if (c === '/' && s[i + 1] === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i++; continue; }
            break;
        }
        return i;
    };

    let start = keyStart;
    if (lastComma !== -1 && lastComma < keyStart) {
        // 有前导逗号：连同逗号一起删除（值后的逗号留给下一个键）
        start = lastComma;
    } else {
        // 角色卡是根对象首键：值后紧跟的逗号（跳过空白/注释）也要删掉
        const t = skipJunk(templateText, end);
        if (templateText[t] === ',') end = t + 1;
    }
    return templateText.slice(0, start) + templateText.slice(end);
}

function getCharPrompt(mergedDataInfo) {
    mergedDataInfo.roledata = postProcess(mergedDataInfo.roledata || {});
    // 将前文从roledata中剥离，单独放入HISTORY
    let historyContent = mergedDataInfo.roledata.前文 || '';
    delete mergedDataInfo.roledata.前文;
    // 对前文也应用敏感词替换
    for (const [key, value] of Object.entries(wordMapping)) {
        historyContent = historyContent.replace(new RegExp(key, 'g'), value);
    }
    let charsInfoJsonStr = JSON.stringify(mergedDataInfo.roledata || {});
    for (const [key, value] of Object.entries(wordMapping)) {
        charsInfoJsonStr = charsInfoJsonStr.replace(new RegExp(key, 'g'), value);
    }

    // 角色卡功能关闭时，从模板中剔除角色卡段落
    const roleCardEnabled = isRoleCardEnabled();
    const roleCardTemplate = roleCardEnabled ? $("#char_prompt_textarea").val() : stripRoleCardSection($("#char_prompt_textarea").val());

    const prompt = `
<STORY_DATA>

<HISTORY>
${historyContent}
</HISTORY>

<CHARACTER_CARD>
${charsInfoJsonStr}
</CHARACTER_CARD>

</STORY_DATA>

**在回复最末尾必须生成当前正文的NEW_STORY_DATA信息。**
<NEW_STORY_DATA>
<NEW_HISTORY> // **新HISTORY信息的模板**
${newHistoryTemplate}
</NEW_HISTORY>
<NEW_CHARACTER_CARD> // **新CHARACTER_CARD信息的模板**
${newCharacterCardTemplate}
</NEW_CHARACTER_CARD>
</NEW_STORY_DATA>
`
    return prompt;
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
    // --- 优化后的角色卡管理：固定 10 槽位上限 ---
    if (finalRoleDataInfo && finalRoleDataInfo.角色卡 && typeof finalRoleDataInfo.角色卡 === 'object') {
        const MAX_SLOTS = 10;
        const roleScores = [];
        const userPrompt = chat[chat.length - 1]?.mes || "";
        const roleNames = Object.keys(finalRoleDataInfo.角色卡);

        // 构建所有已知角色名集合，用于消歧义：
        // 当"沈梦"和"沈梦瑶"同时存在时，"沈梦"在文本中的匹配不会被"沈梦瑶"吞掉才算真正命中
        const allKnownNames = [...new Set([
            ...roleNames,
            ...Object.values(nameMapping),
        ])];

        for (const roleName of roleNames) {
            const realName = nameMapping[roleName] || roleName;
            let score = -1;

            // 1. 意图驱动：如果最新 Prompt 提到了，给予极高优先级（确保唤醒）
            if (nameMatches(roleName, userPrompt, allKnownNames) || nameMatches(realName, userPrompt, allKnownNames)) {
                score = 1000000;
            } else {
                // 2. 活跃度：寻找最后一次出现的索引作为基础分
                for (let i = chat.length - 1; i >= 0; i--) {
                    const mes = chat[i].mes || "";
                    if (nameMatches(roleName, mes, allKnownNames) || nameMatches(realName, mes, allKnownNames)) {
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
            const originalData = finalRoleDataInfo.角色卡[roleName];

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
        finalRoleDataInfo.角色卡 = newRoleCards;
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
                const regex = /(?:<\/(?:think|thinking)>|^)([\s\S]*?)<(?:post_thinking|delta)>/gi;
                const matches = Array.from(item.mes.matchAll(regex));
                if (matches.length > 0) {
                    // 取最后一个匹配的捕获组
                    return matches[matches.length - 1][1].trim();
                } else {
                    return item.mes;
                }
            });
        finalRoleDataInfo.前文 = tail.join('\n');
    } else {
        finalRoleDataInfo.前文 = "";
    }
    $("#token-count").prop("textContent", "4");
    let tokenCount = await getTokenCountAsync(JSON.stringify(finalRoleDataInfo));
    while (tokenCount > extension_settings[extensionName].tokenLimit) {
        finalRoleDataInfo.故事历程 = finalRoleDataInfo.故事历程.slice(Math.floor(finalRoleDataInfo.故事历程.length / 50));
        tokenCount = await getTokenCountAsync(JSON.stringify(finalRoleDataInfo));
        console.warn("[Chat History Optimization] Summary info is too large, reduce message to count.", tokenCount);
    }

    $("#token-count").prop("textContent", `${tokenCount}`);
    console.log("[Chat History Optimization] token count:", tokenCount);
    if (finalRoleDataInfo && finalRoleDataInfo.天数) {
        finalRoleDataInfo.故事历程 = JSON.parse(convertDayReferences(JSON.stringify(finalRoleDataInfo.故事历程), finalRoleDataInfo.天数));
        if (finalRoleDataInfo.故事历程总结) {
            finalRoleDataInfo.故事历程总结 = JSON.parse(convertDayReferences(JSON.stringify(finalRoleDataInfo.故事历程总结), finalRoleDataInfo.天数));
        }
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
    $("#role_card_toggle").on("input", onRoleCardToggleInput);
    $("#keep_count").on("input", onKeepCountInput);
    $("#history_prompt_textarea").on("input", onHistoryPromptInput);
    $("#character_prompt_textarea").on("input", onCharacterPromptInput);
    $("#token_limit").on("input", onTokenLimitInput);
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

// ============================================================================
// chat-optimization-v2 prompt engine.
// Pure logic: no DOM access. UI updates flow through the stats event bus.
// ============================================================================
(function () {
    'use strict';

    const NS = window.ChatOptimizationV2 = window.ChatOptimizationV2 || {};
    const { getTokenCountAsync } = NS.bridge;
    const Settings = NS.Settings;

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
    };

    let keepMessageCount = 0;
    let lastStats = {
        tokenCount: 0,
        failedFloors: [],
        roles: {},
    };
    const statsListeners = new Set();

    function printObj(comment, obj) {
        console.log(`[${comment}]`, JSON.parse(JSON.stringify(obj, null, 2)));
    }

    function parseTemplate(text, verbose = false) {
        if (typeof text !== 'string' || text.trim() === '') return null;
        // 移除//开头的注释
        const jsonStr = text.replace(/\/\/.*$/gm, '');
        try {
            return JSON.parse(jsonStr);
        } catch (e) {
            if (verbose) console.error(`[Chat History Optimization] JSON parse error`, jsonStr, e);
            return null;
        }
    }

    function validateTemplate(text) {
        return parseTemplate(text) !== null;
    }

    function notifyStats(patch) {
        lastStats = { ...lastStats, ...patch };
        const snapshot = getStats();
        for (const listener of statsListeners) {
            try {
                listener(snapshot);
            } catch (e) {
                console.error('[Chat History Optimization] stats listener error', e);
            }
        }
    }

    function onStats(listener) {
        statsListeners.add(listener);
        return () => statsListeners.delete(listener);
    }

    function getStats() {
        return {
            tokenCount: lastStats.tokenCount,
            failedFloors: [...lastStats.failedFloors],
            roles: JSON.parse(JSON.stringify(lastStats.roles)),
        };
    }

    function isRoleCardEnabled() {
        return Settings.get('roleCardToggle');
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

    function mergeDataInfo(chat, historyTemplate, characterTemplate) {
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
                                historyData = deepMerge(historyData, historyObj, [], false, historyTemplate);
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
                    if (characterTemplate) {
                        const charMatch = block.match(/<NEW_CHARACTER_CARD>((?:(?!<NEW_CHARACTER_CARD>)[\s\S])*?)<\/NEW_CHARACTER_CARD>/i);
                        if (charMatch && charMatch[1].trim()) {
                            const objMatch = charMatch[1].trim().match(/\{[\s\S]*\}/);
                            if (objMatch) {
                                try {
                                    const charObj = JSON.parse(objMatch[0]);
                                    let allowUpdate = charObj.allowUpdate || false;
                                    delete charObj.allowUpdate;
                                    characterData = deepMerge(characterData, charObj, [], allowUpdate, characterTemplate);
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
        }

        return {
            "historyData": historyData,
            "characterData": characterData,
            "failedFloors": failedChars,
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
        printObj("[Chat History Optimization] Post Processed 前文", data.前文);
        return data;
    }

    /**
     * 解析单条楼层消息中的 <NEW_STORY_DATA><NEW_HISTORY> 区段，返回解析后的对象。
     * 与 mergeDataInfo 的提取逻辑一致（mes 优先，swipes 回退），解析失败返回 null。
     */
    function getFloorStoryBlock(item) {
        if (!item) return null;
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
        if (matches.length === 0) return null;
        const block = matches[matches.length - 1][1];
        const historyMatch = block.match(/<NEW_HISTORY>((?:(?!<NEW_HISTORY>)[\s\S])*?)<\/NEW_HISTORY>/i);
        if (!historyMatch) return null;
        const objMatch = historyMatch[1].trim().match(/\{[\s\S]*\}/);
        if (!objMatch) return null;
        try {
            return JSON.parse(objMatch[0]);
        } catch (e) {
            return null;
        }
    }

    /**
     * 只读解析指定楼层范围 [startFloor, endFloor] 内新增的故事历程条目。
     * 条目归属其首次出现的楼层；去重规则与 deepMerge 一致（JSON.stringify 全等）。
     * 不修改 ST 的 chat 数组。
     * @returns {{entries: Array<{floor: number, 天数: string, 时间段: string, 地点: string, 历程: string}>, startFloor: number, endFloor: number, totalFloors: number}}
     */
    function getStoryProgressRange(startFloor, endFloor) {
        const sourceChat = NS.bridge && NS.bridge.getCurrentChat ? NS.bridge.getCurrentChat() : null;
        const totalFloors = sourceChat && Array.isArray(sourceChat) ? sourceChat.length - 1 : 0;
        if (totalFloors < 1) {
            return { entries: [], startFloor: 1, endFloor: Math.max(totalFloors, 0), totalFloors: totalFloors };
        }

        function toFloor(value) {
            if (value === null || value === undefined || value === '') return null;
            const n = Math.floor(Number(value));
            return isNaN(n) ? null : n;
        }
        let start = toFloor(startFloor);
        let end = toFloor(endFloor);
        if (start === null) start = 1;
        if (end === null) end = totalFloors;
        start = Math.max(1, start);
        end = Math.min(totalFloors, end);
        if (start > end) {
            const tmp = start;
            start = end;
            end = tmp;
        }

        const entries = [];
        if (totalFloors >= 1) {
            const seen = new Set();
            for (let floor = 1; floor <= end; floor++) {
                const item = sourceChat[floor];
                if (!item || (!((("is_user" in item && !item.is_user) || (item.role && item.role == "assistant"))))) continue;
                const historyObj = getFloorStoryBlock(item);
                if (!historyObj || !Array.isArray(historyObj.故事历程)) continue;
                for (const entry of historyObj.故事历程) {
                    if (!entry || typeof entry !== 'object') continue;
                    const key = JSON.stringify(entry);
                    if (seen.has(key)) continue;
                    seen.add(key);
                    if (floor < start) continue;
                    entries.push({
                        floor: floor,
                        天数: entry.天数 || '',
                        时间段: entry.时间段 || '',
                        地点: entry.地点 || '',
                        历程: extractItemProcess(entry),
                    });
                }
            }
        }
        return { entries: entries, startFloor: start, endFloor: end, totalFloors: totalFloors };
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
        const newHistoryTemplate = Settings.get('historyPrompt');
        const newCharacterCardTemplate = roleCardEnabled ? Settings.get('characterPrompt') : '';

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

    /**
     * 只读解析当前聊天记录并刷新统计（失败楼层/角色卡/Token 数），
     * 用于 UI 打开前拿到最新数据。不修改 ST 的 chat 数组。
     */
    async function refreshStats() {
        const sourceChat = NS.bridge && NS.bridge.getCurrentChat ? NS.bridge.getCurrentChat() : null;
        if (!sourceChat || !Array.isArray(sourceChat) || sourceChat.length === 0) return;
        // 深拷贝：mergeDataInfo 会写入 item.messageCount，不能污染 ST 数据
        const chat = JSON.parse(JSON.stringify(sourceChat));
        const historyTemplate = parseTemplate(Settings.get('historyPrompt'));
        const characterTemplate = isRoleCardEnabled() ? parseTemplate(Settings.get('characterPrompt')) : null;
        const mergedDataInfo = mergeDataInfo(chat, historyTemplate, characterTemplate);
        const historyData = mergedDataInfo.historyData || {};
        const rawCharacterData = mergedDataInfo.characterData || {};
        let characterData = processCharacterData(rawCharacterData, chat);

        let assistantIdxArr = [];
        for (let i = 0; i < chat.length; i++) {
            if (!chat[i].is_user) assistantIdxArr.push(i);
        }
        let keepCount = Settings.get('keepCount');
        if (typeof keepCount !== 'number' || isNaN(keepCount)) keepCount = Settings.defaultSettings.keepCount;
        if (keepCount == 0 && assistantIdxArr.length == 1) keepCount = 1;
        if (keepCount > assistantIdxArr.length) keepCount = assistantIdxArr.length;
        if (keepCount > 0) {
            const startIdx = assistantIdxArr[assistantIdxArr.length - keepCount];
            let tail = chat
                .slice(startIdx)
                .filter(item => item && item.is_user === false)
                .map(item => (item && item.mes) || '');
            historyData.前文 = tail.join('\n');
        } else {
            historyData.前文 = "";
        }
        let tokenLimit = Settings.get('tokenLimit');
        if (typeof tokenLimit !== 'number' || isNaN(tokenLimit)) tokenLimit = Settings.defaultSettings.tokenLimit;
        let tokenCount = await getTokenCountAsync(JSON.stringify(historyData) + JSON.stringify(characterData));
        while (tokenCount > tokenLimit && historyData.故事历程 && historyData.故事历程.length > 0) {
            historyData.故事历程 = historyData.故事历程.slice(Math.floor(historyData.故事历程.length / 50));
            tokenCount = await getTokenCountAsync(JSON.stringify(historyData) + JSON.stringify(characterData));
        }

        notifyStats({
            failedFloors: mergedDataInfo.failedFloors,
            roles: JSON.parse(JSON.stringify(rawCharacterData)),
            tokenCount,
        });
    }

    globalThis.replaceChatHistoryWithDetailsV2 = async function (chat, contextSize, abort, type) {
        if (!chat || !Array.isArray(chat) || chat.length === 0) {
            console.warn("[Chat History Optimization] No chat history to process.");
            return;
        }
        if (!Settings.get('extensionToggle')) {
            console.info("[Chat History Optimization] extension is disabled.")
            return;
        }

        keepMessageCount = 0;
        printObj("[Chat History Optimization] Original chat history:", chat);
        let isFirstMessage = false;
        if (chat.length == 2 && chat[0].is_user === false && chat[1].is_user === true) {
            isFirstMessage = true;
        }
        const historyTemplate = parseTemplate(Settings.get('historyPrompt'), true);
        const characterTemplate = isRoleCardEnabled() ? parseTemplate(Settings.get('characterPrompt'), true) : null;
        if (historyTemplate === null || (isRoleCardEnabled() && characterTemplate === null)) {
            console.error('[Chat History Optimization] 模板解析失败，生成可能异常，请在"模板"选项卡检查 JSON');
        }
        let mergedDataInfo = mergeDataInfo(chat, historyTemplate, characterTemplate);
        let historyData = mergedDataInfo.historyData || {};
        let characterData = mergedDataInfo.characterData || {};

        notifyStats({
            failedFloors: mergedDataInfo.failedFloors,
            roles: JSON.parse(JSON.stringify(characterData || {})),
        });

        const tokenCount_origin = await getTokenCountAsync(JSON.stringify(historyData) + JSON.stringify(characterData));
        console.log("[Chat History Optimization] origin token count:", tokenCount_origin);
        printObj("[Chat History Optimization] Final Summary Info Pre", { historyData, characterData });
        // --- 优化后的角色卡管理：固定 10 槽位上限 ---
        characterData = processCharacterData(characterData, chat);

        // 保留倒数第 keepCount 条 assistant 消息及其后的所有信息
        let assistantIdxArr = [];
        for (let i = 0; i < chat.length; i++) {
            if (!chat[i].is_user) assistantIdxArr.push(i);
        }
        let keepCount = Settings.get('keepCount');
        if (typeof keepCount !== 'number' || isNaN(keepCount)) keepCount = Settings.defaultSettings.keepCount;
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
        let tokenLimit = Settings.get('tokenLimit');
        if (typeof tokenLimit !== 'number' || isNaN(tokenLimit)) tokenLimit = Settings.defaultSettings.tokenLimit;
        let tokenCount = await getTokenCountAsync(JSON.stringify(historyData) + JSON.stringify(characterData));
        // 超限裁剪：剪故事历程；故事历程已空仍超限则停止（硬停守卫，旧代码会无限循环）
        while (tokenCount > tokenLimit && historyData.故事历程 && historyData.故事历程.length > 0) {
            historyData.故事历程 = historyData.故事历程.slice(Math.floor(historyData.故事历程.length / 50));
            tokenCount = await getTokenCountAsync(JSON.stringify(historyData) + JSON.stringify(characterData));
            console.warn("[Chat History Optimization] Summary info is too large, reduce message to count.", tokenCount);
        }
        if (tokenCount > tokenLimit) {
            console.warn("[Chat History Optimization] Summary info still exceeds token limit after trimming history.");
        }

        notifyStats({ tokenCount });
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
    };

    NS.Engine = Object.freeze({
        wordMapping,
        parseTemplate,
        validateTemplate,
        onStats,
        getStats,
        refreshStats,
        getStoryProgressRange,
    });
})();

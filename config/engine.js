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

    // BM25 得分无归一化，0 表示取所有有词项命中的文档
    const RAG_MIN_SCORE = 0;
    // 召回特化摘要四分量权重（各分量归一化到 [0,1]）
    const SUMMARY_W_ACTOR = 0.30;
    const SUMMARY_W_LOCATION = 0.15;
    const SUMMARY_W_EVENT = 0.20;
    const SUMMARY_W_RECALL = 0.35;
    // BM25 回退分数饱和归一化常数：score/(score+K) ∈ [0,1)
    const BM25_NORM_K = 4;
    // actor 命中 IDF 饱和值：命中人物的 idf 之和达到该值即记满 S_actor=1，
    // 只命中高频主角（idf 低）时只能拿到部分分数
    const ACTOR_IDF_SATURATION = 1.0;

    let lastStats = {
        tokenCount: 0,
        failedFloors: [],
        roles: {},
        activeRoleNames: [],
        rag: null,
        lastMessage: '',
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
            activeRoleNames: [...lastStats.activeRoleNames],
            rag: lastStats.rag ? JSON.parse(JSON.stringify(lastStats.rag)) : null,
            lastMessage: lastStats.lastMessage || '',
        };
    }

    function isRoleCardEnabled() {
        return Settings.get('roleCardToggle');
    }

    function checkPath(path, template) {
        let current = template;
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

    function computeMaxDay(entries) {
        let maxDay = 0;
        if (!Array.isArray(entries)) return maxDay;
        for (const item of entries) {
            const day = parseDayNumber(item && item.天数);
            if (day !== null && day > maxDay) maxDay = day;
        }
        return maxDay;
    }

    /**
     * 将一组故事历程条目渲染为 markdown。
     * maxDay 必须从完整历程（含被窗口排除的部分）计算，以正确识别"当前天"。
     * 早于 maxDay 的天聚合格式；maxDay 与无法解析的天使用详细格式。
     */
    function renderJourneyMarkdown(entries, maxDay) {
        if (!Array.isArray(entries) || entries.length === 0) return '';

        // 回退：没有可解析的天数，所有事件使用详细格式
        if (maxDay === 0) {
            return entries.map(item => {
                const header = `# ${item.天数}|${item.时间段}|${item.地点}`;
                const process = extractItemProcess(item);
                return `${header.trim()}\n## ${process.trim()}`;
            }).join('\n');
        }

        // 按天数分组（无法解析的归入 -1）
        const groups = {};
        for (const item of entries) {
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

    /**
      * 单条历程条目 → RAG 检索文本（含天数/时间段/地点，用作 BM25 文档与查询）。
      */
    function entryToDocText(entry) {
        const meta = [entry && entry.天数, entry && entry.时间段, entry && entry.地点]
            .map(s => (s == null ? '' : String(s).trim())).filter(Boolean).join(' ');
        const process = extractItemProcess(entry).trim();
        return [meta, process].filter(Boolean).join(' ');
    }

    function joinNonEmpty(parts) {
        return parts.map(s => (s || '').trim()).filter(Boolean).join('\n');
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
      * index 为条目在所属楼层 故事历程 数组中的原始下标。
      * 不修改 ST 的 chat 数组。
      * @returns {{entries: Array<{floor: number, index: number, 天数: string, 时间段: string, 地点: string, 历程: string}>, startFloor: number, endFloor: number, totalFloors: number}}
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
                const journey = historyObj.故事历程;
                for (let i = 0; i < journey.length; i++) {
                    const entry = journey[i];
                    if (!entry || typeof entry !== 'object') continue;
                    const key = JSON.stringify(entry);
                    if (seen.has(key)) continue;
                    seen.add(key);
                    if (floor < start) continue;
                    entries.push({
                        floor: floor,
                        index: i,
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

    /**
     * 将敏感词替换应用到文本。
     */
    function applyWordMapping(text) {
        let result = text || '';
        for (const [key, value] of Object.entries(wordMapping)) {
            result = result.replace(new RegExp(key, 'g'), value);
        }
        return result;
    }

    /**
     * 构建注入 prompt。historyData.前文 已是最终装配文本（RAG 远端条目+中段+正文）。
     */
    function getCharPrompt(historyData, characterData) {
        // 浅拷贝：不修改调用方的 historyData（前文需保留给统计/日志/预览）
        const history = { ...(historyData || {}) };
        // 将前文从历史数据中剥离，单独放入HISTORY
        const historyContent = applyWordMapping(history.前文 || '');
        delete history.前文;
        const charsInfoJsonStr = applyWordMapping(JSON.stringify(characterData || {}));

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
     * 分层注入核心：把故事数据装配为 中段历程 + 正文（verbatim 尾部）。
     *
     * - 正文：倒数第 keepCount 条 assistant 回复起的原文（其 messageCount 对应的
     *   历程条目已被正文覆盖，从历程中排除，避免重复）。
     * - 中段：历程中未被正文覆盖的条目；RAG 触发时二分搜索最大后缀窗口，
     *   使 窗口+正文+角色卡 ≤ tokenLimit - ragBudget。
      * - RAG：触发时（全量 > tokenLimit×(1-ragRatio)），
      *   以 最新用户消息 + 窗口历程条目（最新→次新→…，含天数/时间段/地点）为查询序列
      *   逐个 BM25 检索，窗口外的远端条目按得分 topK 贪心装入，直到预算装满，
     *   按时间顺序渲染为历程 markdown 放在 <HISTORY> 头部（与中段格式一致），
     *   预算 ragBudget = tokenLimit × ragRatio。
     * - 未触发：全量注入，不裁剪。
     *
     * @param {object[]} chatCopy - 聊天记录的深拷贝（mergeDataInfo 会写入 messageCount）
     * @param {{runRag?: boolean}} options - runRag=false 时只判断是否触发，不执行检索
     */
    // ------------------------------------------------------------------
    // 召回特化摘要混合打分
    // ------------------------------------------------------------------

    /**
     * 收集各楼层 extra 中的有效召回特化摘要，
     * 键为 JSON.stringify(故事历程条目)（与 deepMerge 去重键一致，
     * 使合并后的 farEntries 可直接命中）。
     */
    function buildSummaryMap(chatCopy) {
        const map = new Map();
        const SubSummary = NS.SubSummary;
        if (!SubSummary) return map;
        for (let i = 0; i < chatCopy.length; i++) {
            const item = chatCopy[i];
            if (!item) continue;
            if (!((("is_user" in item && !item.is_user) || (item.role && item.role === 'assistant')))) continue;
            const historyObj = getFloorStoryBlock(item);
            if (!historyObj || !Array.isArray(historyObj.故事历程)) continue;
            const journey = historyObj.故事历程;
            const { summaries } = SubSummary.getFloorSummaries(i);
            for (let j = 0; j < journey.length; j++) {
                const slot = summaries[j];
                if (!slot || typeof slot !== 'object') continue;
                if (slot.s === undefined || slot.s === null) continue;
                if (!SubSummary.hasRecallFields(slot.s)) continue;
                map.set(JSON.stringify(journey[j]), slot.s);
            }
        }
        return map;
    }

    /**
     * 远端条目混合打分（与 farEntries 同序返回）：
     * - 有召回特化摘要且 Embedder 就绪：
     *   score = W_ACTOR·(命中人物/总数) + W_LOCATION·(命中地点/总数)
     *         + W_EVENT·cos(query,event) + W_RECALL·max(cos(query,recall_when))
     * - 否则：BM25 回退，score = bm25/(bm25+BM25_NORM_K)
     * Embedder 未就绪时全池走 BM25 归一化（等价于纯 BM25 排序）。
     */
    async function scoreFarEntries(queryText, farEntries, docs, summaryMap, knownNames) {
        const embedderReady = !!(NS.Embedder && NS.Embedder.isReady());
        const summaries = farEntries.map(entry => (embedderReady ? summaryMap.get(JSON.stringify(entry)) : null));

        // BM25 回退池：无摘要条目（Embedder 未就绪时为全池）
        const bm25Score = new Map(); // entryIdx -> 归一化分数
        const poolIdx = [];
        for (let i = 0; i < farEntries.length; i++) {
            if (!summaries[i] && docs[i]) poolIdx.push(i);
        }
        if (poolIdx.length > 0 && NS.Retriever) {
            const hits = await NS.Retriever.retrieve(queryText, poolIdx.map(i => docs[i]), poolIdx.length, RAG_MIN_SCORE);
            for (const hit of hits) {
                const idx = poolIdx[hit.index];
                if (idx !== undefined && !bm25Score.has(idx)) {
                    bm25Score.set(idx, hit.score / (hit.score + BM25_NORM_K));
                }
            }
        }

        // actor 消歧名单：全部摘要人物 ∪ 已知角色名
        const allNames = new Set(knownNames || []);
        for (const s of summaries) {
            if (s && Array.isArray(s.actor)) for (const a of s.actor) allNames.add(a);
        }
        const nameList = [...allNames];

        // actor IDF：高频人物（主角几乎每条都在场）命中权重降低，
        // idf = log(1 + (N - d + 0.5) / (d + 0.5))，d 为该人物出现的摘要条目数；
        // S_actor 取命中人物 idf 之和的绝对饱和（非条目内归一），
        // 使"只命中主角"的条目无法拿满人物分
        const summaryPoolSize = summaries.filter(Boolean).length;
        const actorDf = new Map();
        for (const s of summaries) {
            if (!s || !Array.isArray(s.actor)) continue;
            for (const a of new Set(s.actor)) actorDf.set(a, (actorDf.get(a) || 0) + 1);
        }
        const actorIdf = name => {
            const d = actorDf.get(name) || 0;
            return Math.log(1 + (summaryPoolSize - d + 0.5) / (d + 0.5));
        };

        // 批量编码 event / recall_when（文档侧不加查询指令）
        const jobTexts = [];
        const jobMap = new Map(); // entryIdx -> { eventPos, recallPos: [] }
        for (let i = 0; i < farEntries.length; i++) {
            const s = summaries[i];
            if (!s) continue;
            const job = { eventPos: -1, recallPos: [] };
            if (typeof s.event === 'string' && s.event.trim() !== '') job.eventPos = jobTexts.push(s.event.trim()) - 1;
            if (Array.isArray(s.recall_when)) {
                for (const r of s.recall_when) {
                    const t = String(r == null ? '' : r).trim();
                    if (t !== '') job.recallPos.push(jobTexts.push(t) - 1);
                }
            }
            jobMap.set(i, job);
        }
        const queryVec = embedderReady && queryText !== ''
            ? (await NS.Embedder.encodeBatch([NS.Embedder.withQueryInstruction(queryText)]))[0]
            : null;
        const vecs = jobTexts.length > 0 ? await NS.Embedder.encodeBatch(jobTexts) : [];

        const clamp01 = v => Math.min(1, Math.max(0, v));
        const results = new Array(farEntries.length);
        for (let i = 0; i < farEntries.length; i++) {
            const s = summaries[i];
            if (s) {
                const actors = Array.isArray(s.actor) ? s.actor : [];
                let actorHit = 0;
                let actorIdfHit = 0;
                for (const a of new Set(actors)) {
                    if (nameMatches(a, queryText, nameList)) {
                        actorHit++;
                        actorIdfHit += actorIdf(a);
                    }
                }
                const actorScore = Math.min(1, actorIdfHit / ACTOR_IDF_SATURATION);
                const locations = Array.isArray(s.location) ? s.location : [];
                let locHit = 0;
                for (const loc of locations) {
                    if (loc && queryText.includes(loc)) locHit++;
                }
                const locationScore = locations.length > 0 ? locHit / locations.length : 0;
                const job = jobMap.get(i) || { eventPos: -1, recallPos: [] };
                const sEvent = (job.eventPos >= 0 && queryVec && vecs[job.eventPos])
                    ? clamp01(NS.Embedder.cosine(queryVec, vecs[job.eventPos])) : 0;
                let sRecall = 0;
                for (const p of job.recallPos) {
                    if (queryVec && vecs[p]) sRecall = Math.max(sRecall, clamp01(NS.Embedder.cosine(queryVec, vecs[p])));
                }
                const score = SUMMARY_W_ACTOR * actorScore
                    + SUMMARY_W_LOCATION * locationScore
                    + SUMMARY_W_EVENT * sEvent
                    + SUMMARY_W_RECALL * sRecall;
                results[i] = {
                    index: i,
                    score,
                    parts: {
                        source: 'summary',
                        actor: actorHit + '/' + actors.length,
                        location: locHit + '/' + locations.length,
                        actorScore: Number(actorScore.toFixed(2)),
                        locationScore: Number(locationScore.toFixed(2)),
                        event: Number(sEvent.toFixed(2)),
                        recall: Number(sRecall.toFixed(2)),
                    },
                };
            } else {
                const b = bm25Score.has(i) ? bm25Score.get(i) : 0;
                results[i] = {
                    index: i,
                    score: b,
                    parts: { source: 'bm25', score: Number(b.toFixed(2)) },
                };
            }
        }
        return results;
    }

    async function buildPromptData(chatCopy, options) {
        const runRag = Boolean(options && options.runRag);
        const historyTemplate = parseTemplate(Settings.get('historyPrompt'), true);
        const characterTemplate = isRoleCardEnabled() ? parseTemplate(Settings.get('characterPrompt'), true) : null;
        if (historyTemplate === null || (isRoleCardEnabled() && characterTemplate === null)) {
            console.error('[Chat History Optimization] 模板解析失败，生成可能异常，请在"模板"选项卡检查 JSON');
        }
        const mergedDataInfo = mergeDataInfo(chatCopy, historyTemplate, characterTemplate);
        const historyData = mergedDataInfo.historyData || {};
        const characterData = processCharacterData(mergedDataInfo.characterData || {}, chatCopy);
        const charJson = JSON.stringify(characterData);

        // --- 正文：倒数第 keepCount 条 assistant 消息及其后的原文 ---
        let assistantIdxArr = [];
        for (let i = 0; i < chatCopy.length; i++) {
            if (!chatCopy[i].is_user) assistantIdxArr.push(i);
        }
        let keepCount = Settings.get('keepCount');
        if (typeof keepCount !== 'number' || isNaN(keepCount)) keepCount = Settings.defaultSettings.keepCount;
        if (keepCount == 0 && assistantIdxArr.length == 1) keepCount = 1;
        if (keepCount > assistantIdxArr.length) keepCount = assistantIdxArr.length;
        let tailText = '';
        let tailCovered = 0;
        if (keepCount > 0) {
            const startIdx = assistantIdxArr[assistantIdxArr.length - keepCount];
            tailText = chatCopy
                .slice(startIdx)
                .filter(item => item && item.is_user === false)
                .map(item => {
                    if (!item || !item.mes) return '';
                    tailCovered += item.messageCount || 0;
                    return item.mes;
                })
                .join('\n');
        }

        // --- 历程拆分：maxDay 从完整历程计算；正文覆盖的尾部条目从中段排除 ---
        const fullJourney = Array.isArray(historyData.故事历程) ? historyData.故事历程 : [];
        const midEntries = tailCovered > 0
            ? fullJourney.slice(0, Math.max(0, fullJourney.length - tailCovered))
            : [...fullJourney];
        const midMaxDay = computeMaxDay(fullJourney);
        delete historyData.故事历程;

        let tokenLimit = Settings.get('tokenLimit');
        if (typeof tokenLimit !== 'number' || isNaN(tokenLimit)) tokenLimit = Settings.defaultSettings.tokenLimit;
        let ragRatio = Settings.get('ragRatio');
        if (typeof ragRatio !== 'number' || isNaN(ragRatio) || ragRatio <= 0) ragRatio = Settings.defaultSettings.ragRatio;

        const fullMidMarkdown = renderJourneyMarkdown(midEntries, midMaxDay);
        const fullTokens = await getTokenCountAsync(joinNonEmpty([fullMidMarkdown, tailText]) + charJson);

        const ragReady = NS.Retriever ? NS.Retriever.isReady() : false;
        const ragWillActivate = ragReady && fullTokens > tokenLimit * (1 - ragRatio);
        console.log(`[Chat History Optimization] 全量 ${fullTokens} tokens，tokenLimit=${tokenLimit}，ragRatio=${ragRatio}，RAG ${ragWillActivate ? '将启用' : '不启用'}（ready=${ragReady}）`);

        let rag = {
            active: false,
            willActivate: ragWillActivate,
            hits: [],
            windowCount: midEntries.length,
            farCount: 0,
            query: '',
        };
        let midMarkdown = fullMidMarkdown;
        let ragMarkdown = '';

        if (ragWillActivate && runRag && midEntries.length > 0) {
            const ragBudget = Math.max(1, Math.round(tokenLimit * ragRatio));
            const midBudget = tokenLimit - ragBudget;
            // 二分搜索最大后缀窗口 k：tokens(窗口markdown + 正文 + 角色卡) ≤ midBudget
            let lo = 0, hi = midEntries.length, bestK = 0;
            while (lo <= hi) {
                const k = (lo + hi) >> 1;
                const windowMarkdown = k === 0 ? '' : renderJourneyMarkdown(midEntries.slice(midEntries.length - k), midMaxDay);
                const tokens = await getTokenCountAsync(joinNonEmpty([windowMarkdown, tailText]) + charJson);
                if (tokens <= midBudget) {
                    bestK = k;
                    lo = k + 1;
                } else {
                    hi = k - 1;
                }
            }
            const farEntries = midEntries.slice(0, midEntries.length - bestK);
            midMarkdown = bestK === 0 ? '' : renderJourneyMarkdown(midEntries.slice(midEntries.length - bestK), midMaxDay);
            rag.windowCount = bestK;
            rag.farCount = farEntries.length;

            const query = (chatCopy[chatCopy.length - 1] && chatCopy[chatCopy.length - 1].mes) || '';
            rag.query = query;
            // 组合查询文本：最新用户消息 + 窗口历程条目，供混合打分与 BM25 回退共用
            const queryText = joinNonEmpty([query, ...midEntries.slice(midEntries.length - bestK).map(entryToDocText)]);
            if (farEntries.length > 0 && queryText !== '' && NS.Retriever) {
                try {
                    const docs = farEntries.map(entryToDocText);
                    // 记录每条远端条目在 farEntries 中的原始（时间）顺序，用于最终排序
                    const docOrder = new Map();
                    docs.forEach((text, i) => {
                        if (text && !docOrder.has(text)) docOrder.set(text, i);
                    });
                    const uniqueDocCount = docOrder.size;

                    const summaryMap = buildSummaryMap(chatCopy);
                    const allRoleNames = Object.keys(mergedDataInfo.characterData || {});
                    const scored = await scoreFarEntries(queryText, farEntries, docs, summaryMap, allRoleNames);
                    // 按最终分数降序贪心装入（按单条详细 markdown 成本计费，即单条最大成本）
                    const ranked = scored
                        .map((r, i) => (r && docs[i] ? r : null))
                        .filter(Boolean)
                        .sort((a, b) => b.score - a.score);
                    let used = 0;
                    let minDocTokens = Infinity;
                    const packed = [];
                    const packedSet = new Set();
                    for (const r of ranked) {
                        // 预算装满 / 远端条目已全部装入 / 剩余预算装不下已见最小条目 时停止
                        if (used >= ragBudget || packedSet.size >= uniqueDocCount
                            || (minDocTokens !== Infinity && used + minDocTokens > ragBudget)) break;
                        const text = docs[r.index];
                        if (packedSet.has(text)) continue;
                        const entry = farEntries[r.index];
                        const t = await getTokenCountAsync(renderJourneyMarkdown([entry], 0));
                        // 已见最小成本（无论是否装入）：装不下最小条目即可停止
                        if (t < minDocTokens) minDocTokens = t;
                        if (used + t > ragBudget) continue;
                        packedSet.add(text);
                        packed.push({ text, score: r.score, parts: r.parts, order: docOrder.get(text) ?? Infinity, entry });
                        used += t;
                    }
                    // 按 farEntries 原始顺序（时间顺序）渲染为与中段一致的历程 markdown，放到 <HISTORY> 头部
                    if (packed.length > 0) {
                        packed.sort((a, b) => a.order - b.order);
                        ragMarkdown = renderJourneyMarkdown(packed.map((p) => p.entry), midMaxDay);
                        rag.hits = packed.map((p) => ({ text: p.text, score: p.score, parts: p.parts }));
                        rag.active = true;
                    }
                } catch (e) {
                    console.error('[Chat History Optimization] RAG retrieval failed, fallback to no-RAG', e);
                    rag = { active: false, willActivate: false, hits: [], windowCount: midEntries.length, farCount: 0, query: '' };
                    midMarkdown = fullMidMarkdown;
                    ragMarkdown = '';
                }
            }
        }

        historyData.前文 = joinNonEmpty([ragMarkdown, midMarkdown, tailText]);
        // token 数按最终拼接的最后一条消息（含 STORY_DATA 包装与 NEW_STORY_DATA 模板）计算，
        // 与实际发送给模型的内容一致
        const lastMessage = getCharPrompt(historyData, characterData);
        const tokenCount = await getTokenCountAsync(lastMessage);

        return {
            historyData,
            characterData,
            allCharacterData: mergedDataInfo.characterData,
            activeRoleNames: Object.keys(characterData),
            failedFloors: mergedDataInfo.failedFloors,
            ragMarkdown,
            lastMessage,
            tokenCount,
            rag,
        };
    }

    const FIRST_MESSAGE_SUFFIX = "\n（此为首条信息，<NEW_STORY_DATA>中需要参考前文和当前输出的信息生成全量信息，尤其注意'故事历程'需额外添加前文的历程）";

    /**
     * 生成与 UI 刷新共用的最终装配：buildPromptData → 首条信息后缀 → 重新计数。
     * 两条路径由此保证产出完全一致的 last message 与 token 数。
     */
    async function assembleFinalPrompt(chatCopy, options) {
        const result = await buildPromptData(chatCopy, options);
        let lastMessage = result.lastMessage;
        let tokenCount = result.tokenCount;
        const isFirstMessage = chatCopy.length == 2 && chatCopy[0].is_user === false && chatCopy[1].is_user === true;
        if (isFirstMessage) {
            lastMessage = lastMessage + FIRST_MESSAGE_SUFFIX;
            tokenCount = await getTokenCountAsync(lastMessage);
        }
        return Object.assign({ isFirstMessage }, result, { lastMessage, tokenCount });
    }

    /**
     * 只读解析当前聊天记录并刷新统计（失败楼层/角色卡/Token 数/发送预览），
     * 用于 UI 打开时拿到最新数据。与正常生成走同一装配逻辑
     * （含 RAG 检索与首条信息后缀），保证预览与"现在生成会发送的内容"一致。
     * 不修改 ST 的 chat 数组。
     */
    async function refreshStats() {
        const sourceChat = NS.bridge && NS.bridge.getCurrentChat ? NS.bridge.getCurrentChat() : null;
        if (!sourceChat || !Array.isArray(sourceChat) || sourceChat.length === 0) return;
        const chatCopy = JSON.parse(JSON.stringify(sourceChat));
        const result = await assembleFinalPrompt(chatCopy, { runRag: true });
        notifyStats({
            failedFloors: result.failedFloors,
            roles: JSON.parse(JSON.stringify(result.allCharacterData)),
            activeRoleNames: [...result.activeRoleNames],
            tokenCount: result.tokenCount,
            rag: result.rag,
            lastMessage: result.lastMessage,
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

        printObj("[Chat History Optimization] Original chat history:", chat);

        // 深拷贝：mergeDataInfo 会写入 item.messageCount，不能污染 ST 数据
        const chatCopy = JSON.parse(JSON.stringify(chat));
        const result = await assembleFinalPrompt(chatCopy, { runRag: true });
        const historyData = result.historyData;
        const characterData = result.characterData;

        chat[chat.length - 1]['mes'] = result.lastMessage;

        notifyStats({
            failedFloors: result.failedFloors,
            roles: JSON.parse(JSON.stringify(result.allCharacterData)),
            activeRoleNames: [...result.activeRoleNames],
            tokenCount: result.tokenCount,
            rag: result.rag,
            lastMessage: result.lastMessage,
        });

        console.log("[Chat History Optimization] token count:", result.tokenCount);
        printObj("[Chat History Optimization] Final Summary Info", { historyData, characterData, ragMarkdown: result.ragMarkdown });
        if (!result.rag.active && result.tokenCount > Settings.get('tokenLimit')) {
            console.warn("[Chat History Optimization] 内容超出 token 限制且 RAG 未生效（未超预算阈值），按全量注入。");
        }

        const mergedChat = [];
        mergedChat.push(chat[chat.length - 1])

        // 用 mergedChat 替换 chat 的内容
        chat.length = 0;
        for (const item of mergedChat) {
            chat.push(item);
        }
        console.log("[Chat History Optimization] Final last message:", chat[chat.length - 1]['mes']);
    };

    NS.Engine = Object.freeze({
        wordMapping,
        parseTemplate,
        validateTemplate,
        onStats,
        getStats,
        refreshStats,
        getFloorStoryBlock,
        getStoryProgressRange,
        getNameSearchTerms,
        nameMatches,
    });
})();

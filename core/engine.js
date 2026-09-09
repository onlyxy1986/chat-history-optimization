// ============================================================================
// chat-optimization-v2 prompt engine.
// Pure logic: no DOM access. UI updates flow through the stats event bus.
// ============================================================================
(function () {
    'use strict';

    const NS = window.ChatOptimizationV2 = window.ChatOptimizationV2 || {};
    const { getTokenCountAsync } = NS.bridge;
    const Settings = NS.Settings;
    const Constants = NS.Constants;

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

    let lastStats = {
        tokenCount: 0,
        failedFloors: [],
        roles: {},
        activeRoleNames: [],
        hier: null,
        lastMessage: '',
    };
    const statsListeners = new Set();

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

    // <NEW_STORY_DATA> 解析失败总线：回复到达/消息修改后检测到新失败楼层时广播
    // [{index, reasons: [原因, ...]}]，UI 订阅渲染提示气泡（engine 不碰 DOM）。
    const parseFailListeners = new Set();

    function onParseFail(listener) {
        parseFailListeners.add(listener);
        return () => parseFailListeners.delete(listener);
    }

    function notifyParseFail(details) {
        if (!details || details.length === 0) return;
        for (const listener of parseFailListeners) {
            try {
                listener(details);
            } catch (e) {
                console.error('[Chat History Optimization] parse-fail listener error', e);
            }
        }
    }

    function getStats() {
        return {
            tokenCount: lastStats.tokenCount,
            failedFloors: [...lastStats.failedFloors],
            roles: JSON.parse(JSON.stringify(lastStats.roles)),
            activeRoleNames: [...lastStats.activeRoleNames],
            hier: lastStats.hier ? JSON.parse(JSON.stringify(lastStats.hier)) : null,
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

    function deepMerge(merged, delta, path = [], template = null) {
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
                merged[key] = deepMerge(merged[key], delta[key], path.concat(key), template);
            } else if (checkPath(path.concat(key), template)) {
                if (Array.isArray(delta[key])) {
                    merged[key] = deepMerge([], delta[key], path.concat(key), template);
                } else if (typeof delta[key] === 'object') {
                    merged[key] = deepMerge({}, delta[key], path.concat(key), template);
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
        const failedReasons = {}; // 楼层下标 -> [原因, ...]
        let historyData = {};
        let characterData = {};

        function markFailed(j, reason) {
            if (!failedChars.includes(j)) failedChars.push(j);
            if (!failedReasons[j]) failedReasons[j] = [];
            if (!failedReasons[j].includes(reason)) failedReasons[j].push(reason);
        }

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

                    // --- NEW_HISTORY 区段：必选 ---
                    const historyMatch = block.match(/<NEW_HISTORY>((?:(?!<NEW_HISTORY>)[\s\S])*?)<\/NEW_HISTORY>/i);
                    if (historyMatch) {
                        const objMatch = historyMatch[1].trim().match(/\{[\s\S]*\}/);
                        if (objMatch) {
                            try {
                                const historyObj = JSON.parse(objMatch[0]);
                                historyData = deepMerge(historyData, historyObj, [], historyTemplate);
                                item.messageCount = 0;
                                if (historyObj.故事历程) {
                                    item.messageCount = historyObj.故事历程.length;
                                }
                            } catch (e) {
                                console.error(`[Chat History Optimization] NEW_HISTORY JSON parse error at chat[${j}]:`, e);
                                console.error(`[Chat History Optimization] NEW_HISTORY content:`, objMatch[0]);
                                markFailed(j, 'NEW_HISTORY 解析错误');
                            }
                        } else {
                            markFailed(j, 'NEW_HISTORY 缺少 JSON 对象');
                        }
                    } else {
                        markFailed(j, '缺少 NEW_HISTORY 区段'); // 缺 NEW_HISTORY 视为失败
                    }

                    // --- NEW_CHARACTER_CARD 区段：可选（无新角色/开关关闭时合法缺失）---
                    if (characterTemplate) {
                        const charMatch = block.match(/<NEW_CHARACTER_CARD>((?:(?!<NEW_CHARACTER_CARD>)[\s\S])*?)<\/NEW_CHARACTER_CARD>/i);
                        if (charMatch && charMatch[1].trim()) {
                            const objMatch = charMatch[1].trim().match(/\{[\s\S]*\}/);
                            if (objMatch) {
                                try {
                                    const charObj = JSON.parse(objMatch[0]);
                                    // 遗留字段清理：旧版 LLM 输出可能带顶层 allowUpdate，
                                    // 此处直接丢弃，防止被动态键模板误收为角色名。
                                    delete charObj.allowUpdate;
                                    characterData = deepMerge(characterData, charObj, [], characterTemplate);
                                } catch (e) {
                                    console.error(`[Chat History Optimization] NEW_CHARACTER_CARD JSON parse error at chat[${j}]:`, e);
                                    console.error(`[Chat History Optimization] NEW_CHARACTER_CARD content:`, objMatch[0]);
                                    markFailed(j, 'NEW_CHARACTER_CARD 解析错误');
                                }
                            } else {
                                markFailed(j, 'NEW_CHARACTER_CARD 缺少 JSON 对象');
                            }
                        }
                    }
                } else {
                    markFailed(j, '缺少 NEW_STORY_DATA 块');
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
            "failedDetails": failedChars.map(j => ({ index: j, reasons: failedReasons[j] || [] })),
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
     * 早于 maxDay 的天聚合格式（按 天数+时间段+地点 合并连续历程）；
     * maxDay 与无法解析的天使用详细格式。
     */
    function renderJourneyMarkdown(entries, maxDay) {
        if (!Array.isArray(entries) || entries.length === 0) return '';

        // 回退：没有可解析的天数，所有事件使用详细格式
        if (maxDay === 0) {
            return entries.map(item => {
                const header = `# ${item.天数}|${item.时间段}|${item.地点}`;
                const process = extractItemProcess(item);
                return `${header.trim()}\n ${process.trim()}`;
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
                    result.push(`${header.trim()}\n ${process.trim()}`);
                }
            } else {
                // 之前的天：聚合格式，按「天数+时间段+地点」合并连续历程
                let groupKey = null;
                let groupItems = [];
                const flushGroup = () => {
                    if (groupItems.length === 0) return;
                    const first = groupItems[0];
                    const header = `${first.天数}|${first.时间段}|${first.地点}`;
                    const allProcess = groupItems.map(item => extractItemProcess(item)).join('');
                    result.push(`# ${header.trim()}\n ${allProcess.trim()}`);
                };
                for (const item of items) {
                    const key = [dayNum, item.时间段, item.地点]
                        .map(s => (s == null ? '' : String(s).trim())).join('\u0000');
                    if (key !== groupKey) {
                        flushGroup();
                        groupKey = key;
                        groupItems = [item];
                    } else {
                        groupItems.push(item);
                    }
                }
                flushGroup();
            }
        }

        return result.join('\n');
    }

    /**
      * 单条历程条目 → 检索文本（含天数/时间段/地点，用作天摘要生成的当天历程输入）。
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

    // 故事块解析结果缓存：以楼层消息对象为键，
    // 按 (mes 引用 + 当前 swipe 文本引用) 双重校验有效性——
    // 字符串不可变，mes 被替换或当前 swipe 内容变化都会导致引用不同而自动重解析。
    // 上限由 Constants.STORY_PARSE_CACHE_MAX 控制，超限整体清空重建。
    const storyBlockCache = new Map();

    /**
      * 解析单条楼层消息中的 <NEW_STORY_DATA><NEW_HISTORY> 区段，返回解析后的对象。
      * 与 mergeDataInfo 的提取逻辑一致（mes 优先，swipes 回退），解析失败返回 null。
      */
    function getFloorStoryBlock(item) {
        if (!item) return null;
        const mes = item.mes;
        const swipeText = ("swipes" in item && "swipe_id" in item && item.swipes[item.swipe_id])
            ? item.swipes[item.swipe_id] : null;
        let slot = storyBlockCache.get(item);
        if (slot && slot.mes === mes && slot.swipeText === swipeText) {
            return slot.result;
        }
        const result = parseFloorStoryBlock(item, mes, swipeText);
        if (storyBlockCache.size >= Constants.STORY_PARSE_CACHE_MAX) storyBlockCache.clear();
        storyBlockCache.set(item, { mes, swipeText, result });
        return result;
    }

    function parseFloorStoryBlock(item, mes, swipeText) {
        let matches = [];
        if (mes) {
            matches = [...mes
                .replace(/\/\/.*$/gm, '')
                .matchAll(/<NEW_STORY_DATA>((?:(?!<NEW_STORY_DATA>)[\s\S])*?)<\/NEW_STORY_DATA>/gi)];
        }
        if (matches.length == 0 && swipeText) {
            matches = [...swipeText
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
     * 角色卡模板原样发送时会删除 <可变> 标记文本（保留其余注释），
     * 避免模型将其误解为角色卡生成内容。
     */
    function stripVariableTag(text) {
        if (typeof text !== 'string' || text === '') return text;
        const tag = (NS.RoleTrack && NS.RoleTrack.VARIABLE_TAG) || '<可变>';
        return text.split(tag).join('');
    }

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
        const newCharacterCardTemplate = roleCardEnabled ? stripVariableTag(Settings.get('characterPrompt')) : '';

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
<NEW_HISTORY> // **新HISTORY信息的模板,每条消息都要输出**
${newHistoryTemplate}
</NEW_HISTORY>
${roleCardEnabled ? `<NEW_CHARACTER_CARD> // **新CHARACTER_CARD信息的模板,仅新角色出现时输出**
${newCharacterCardTemplate}
</NEW_CHARACTER_CARD>
` : ''}
</NEW_STORY_DATA>
`
        return prompt;
    }

    /**
     * 当前聊天的全部已知角色卡（全部楼层 NEW_CHARACTER_CARD 合并后的映射）。
     * 只读：深拷贝当前 chat 后走同一 mergeDataInfo，不修改 ST 数据。
     * 供角色状态追踪取"故事历程中出现角色的完整角色卡"（全集输入，调用方再按
     * 本楼层历程文本过滤）。角色卡关闭/模板非法/解析失败时返回空对象。
     * @returns {object} { 角色名: 角色卡 }
     */
    function getKnownRoleCards() {
        if (!isRoleCardEnabled()) return {};
        const sourceChat = NS.bridge && NS.bridge.getCurrentChat ? NS.bridge.getCurrentChat() : null;
        if (!sourceChat || !Array.isArray(sourceChat) || sourceChat.length === 0) return {};
        const chatCopy = JSON.parse(JSON.stringify(sourceChat));
        const historyTemplate = parseTemplate(Settings.get('historyPrompt'));
        const characterTemplate = parseTemplate(Settings.get('characterPrompt'));
        if (characterTemplate === null) return {};
        try {
            const info = mergeDataInfo(chatCopy, historyTemplate, characterTemplate);
            const cards = (info && info.characterData) || {};
            return (cards && typeof cards === 'object' && !Array.isArray(cards)) ? cards : {};
        } catch (e) {
            console.error('[Chat History Optimization] getKnownRoleCards 解析失败', e);
            return {};
        }
    }

    /**
     * 当前聊天的全部已知角色名（getKnownRoleCards 的键）。
     * @returns {string[]}
     */
    function getKnownRoles() {
        return Object.keys(getKnownRoleCards());
    }

    /**
     * 角色卡淘汰：槽位上限 Constants.ROLE_CARD_MAX_SLOTS
     * 当前 prompt 提到的角色得分 Constants.ROLE_CARD_MENTION_SCORE（保证保留）；其余按最后出现索引计分
     * 超过 Constants.ROLE_CARD_STALE_DISTANCE 条消息未活跃（且非当前提问提及）的角色直接丢弃
     * @param {object} characterData - 角色卡映射 { 角色名: {...} }
     * @param {object[]} chat - 原始聊天记录
     * @returns {object} 精简后的角色卡映射
     */
    function processCharacterData(characterData, chat) {
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
                score = Constants.ROLE_CARD_MENTION_SCORE;
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

        // 3. 排序并只保留前 ROLE_CARD_MAX_SLOTS 个角色
        const sortedRoles = roleScores
            .sort((a, b) => b.score - a.score)
            .slice(0, Constants.ROLE_CARD_MAX_SLOTS);

        const newRoleCards = {};
        for (const item of sortedRoles) {
            const roleName = item.name;
            const originalData = characterData[roleName];

            // 4. 久未活跃丢弃：距离上次活跃已超过
            // ROLE_CARD_STALE_DISTANCE 条消息（且非当前提问提及）
            // 则直接丢弃，不保留空壳（旧版曾只保留核心设定，易产生模板已删除字段的空对象）。
            const distance = chat.length - 1 - item.score;
            if (item.score < Constants.ROLE_CARD_MENTION_SCORE && distance > Constants.ROLE_CARD_STALE_DISTANCE) {
                continue;
            }
            newRoleCards[roleName] = originalData;
        }

        // 5. 替换为精简后的角色集合（物理删除不在槽位内的角色）
        return newRoleCards;
    }

    /**
     * 分层注入核心：把故事数据装配为 中段历程 + 正文（verbatim 尾部）。
     *
     * - 正文：倒数第 keepCount 条 assistant 回复起的原文（其 messageCount 对应的
     *   历程条目已被正文覆盖，从历程中排除，避免重复）。
     * - 中段：历程中未被正文覆盖的条目，按天分组后从最旧侧折叠为
     *   L1 天摘要 / L(k≥2) 合并摘要（见 planFoldSlots），使
     *   中段+正文+角色卡 ≤ contentLimit。
     * - 折叠：触发条件为全量 > contentLimit；token 够用时零压缩（全量原文），
     *   不够时只折叠最旧的天，高层摘要永远只出现在远端。
     * - 预算基于 contentLimit = max(1, tokenLimit - 模板/包装开销)，
     *   使最终 lastMessage（含 STORY_DATA 骨架与 NEW_STORY_DATA 模板）≤ tokenLimit。
     * - 未触发：全量注入，不裁剪。
     *
     * @param {object[]} chatCopy - 聊天记录的深拷贝（mergeDataInfo 会写入 messageCount）
     * @param {{runFold?: boolean}} options - runFold=false 时只判断是否触发，不执行折叠
     */
    // ------------------------------------------------------------------
    // 分层折叠：L0 条目按天分组 → 从最旧侧折叠为摘要 → 装不下再丢弃最旧节点
    // ------------------------------------------------------------------

    function dayKeyOf(entry) {
        const day = parseDayNumber(entry && entry.天数);
        return day !== null ? String(day) : 'unknown';
    }

    function dayLabelOf(dayKey) {
        if (dayKey === 'unknown') return (Constants.HIER_UNKNOWN_DAY_LABEL || '未知天');
        return `第${dayKey}天`;
    }

    // 摘要伪条目：与 L0 同形（天数|时间段|地点 + 历程），复用 renderJourneyMarkdown。
    // 摘要原文原样使用，不走 extractItemProcess 的补句号逻辑。
    function summaryToEntry(dayKey, endKey, text, locations) {
        const loc = (locations || []).filter(Boolean).join('、');
        if (endKey && endKey !== dayKey) {
            return { 天数: `${dayLabelOf(dayKey)}~${dayLabelOf(endKey)}`, 时间段: '多日', 地点: loc, 历程: text };
        }
        return { 天数: dayLabelOf(dayKey), 时间段: '全天', 地点: loc, 历程: text };
    }

    function estChars(text) {
        return Math.ceil(String(text || '').length / Constants.EST_CHARS_PER_TOKEN);
    }

    // 天在上层节点起止范围内（含端点；unknown 键排最后，只与 unknown 匹配）
    function dayKeyInSpan(dayKey, startKey, endKey, order) {
        const pos = order.indexOf(dayKey);
        const s = order.indexOf(startKey);
        const e = order.indexOf(endKey);
        if (pos === -1 || s === -1 || e === -1) return false;
        return pos >= Math.min(s, e) && pos <= Math.max(s, e);
    }

    // 上层节点 span 内实际存在的天必须全部完全落在中段内：
    // 否则父文本会覆盖正文 verbatim 区的条目造成重复。
    // 数字断层（缺的天，如 1~10 缺 5~9）直接跳过：没有条目就 nothing to cover，
    // 此前 `f === 0 → false` 导致非连续时间线的所有跨洞父永不可用（生成白花、只能靠 L1/丢弃）。
    function spanFullyInside(startKey, endKey, fullDayCounts, midDayCounts) {
        if (startKey === 'unknown' || endKey === 'unknown') {
            return startKey === 'unknown' && endKey === 'unknown'
                && (fullDayCounts.get('unknown') || 0) > 0
                && (midDayCounts.get('unknown') || 0) === (fullDayCounts.get('unknown') || 0);
        }
        const s = parseInt(startKey, 10);
        const e = parseInt(endKey, 10);
        if (isNaN(s) || isNaN(e)) return false;
        const lo = Math.min(s, e);
        const hi = Math.max(s, e);
        for (let n = lo; n <= hi; n++) {
            const k = String(n);
            const f = fullDayCounts.get(k) || 0;
            if (f === 0) continue;
            if ((midDayCounts.get(k) || 0) !== f) return false;
        }
        return true;
    }

    /**
     * 规划中段折叠：midEntries（时间序）按天分组（首现顺序），从最旧侧折叠。
     * hier = NS.SubSummary.getCoverage() 只读快照（无 LLM）。
     * midBudgetEst 为估算口径的中段预算（estChars 单位）。
     * 天为原子单位：整天要么原文、要么摘要、要么丢弃。
     * 部分落在正文覆盖区（tailCovered）的天永不折叠（其 L1 文本含正文内容，会重复）。
     * 返回 { days, upperUsed }：
     *   days: [{dayKey, label, count, entries, locations, level, text, endKey, dropped}]
     *     level 0=原文，1=天摘要，≥2=上层合并，dropped=true=已丢弃。
     */
    function planFoldSlots(midEntries, fullDayCounts, midDayCounts, hier, midBudgetEst) {
        const days = [];
        const dayIdx = new Map();
        for (const entry of midEntries) {
            const dk = dayKeyOf(entry);
            let d = dayIdx.has(dk) ? days[dayIdx.get(dk)] : null;
            if (!d) {
                d = { dayKey: dk, label: dayLabelOf(dk), count: 0, entries: [], locations: [], level: 0, text: null, endKey: dk, dropped: false };
                dayIdx.set(dk, days.length);
                days.push(d);
            }
            d.entries.push(entry);
            d.count++;
            const loc = String(entry.地点 || '').trim();
            if (loc && !d.locations.includes(loc)) d.locations.push(loc);
        }
        // 完全落在中段内的天（才允许折叠/参与上层合并）
        const fullyInside = new Set();
        for (const d of days) {
            if ((fullDayCounts.get(d.dayKey) || 0) === d.count) fullyInside.add(d.dayKey);
        }
        const l1ByDay = new Map();
        if (hier && Array.isArray(hier.days)) {
            for (const hd of hier.days) {
                if (hd && hd.text && fullyInside.has(hd.dayKey)) l1ByDay.set(hd.dayKey, hd.text);
            }
        }
        const validUpper = [];
        if (hier && Array.isArray(hier.upper)) {
            for (const u of hier.upper) {
                if (u && u.text) validUpper.push(u);
            }
        }
        const order = days.map((d) => d.dayKey);
        const dayEst = (d) => {
            if (d.dropped) return 0;
            if (d.level === 0) return estChars(renderJourneyMarkdown(d.entries, 0));
            return estChars(renderJourneyMarkdown([summaryToEntry(d.dayKey, d.endKey, d.text, d.locations)], 0));
        };
        const totalEst = () => days.reduce((a, d) => a + dayEst(d), 0);

        // Phase A：从最旧天开始把 L0 换成 L1（有有效天摘要且完全落在中段内才可折）
        for (const d of days) {
            if (totalEst() <= midBudgetEst) break;
            if (d.level === 0 && fullyInside.has(d.dayKey)) {
                const t = l1ByDay.get(d.dayKey);
                if (t) {
                    d.level = 1;
                    d.text = t;
                }
            }
        }
        // 单个上层节点尝试合并：调用方保证 level 顺序（逐层上升），返回是否合并成功。
        // 精确裁剪阶段复用同一判定（span 完全落在中段内 + 被覆盖天全部处于 level-1），
        // 避免估算偏乐观时"该合的没合就直接丢整天"。
        const tryApplyUpper = (u) => {
            // span 必须整体完全落在中段内（防正文重复），且 span 内中段天
            // 必须全部处于 level-1 且未丢弃
            if (!spanFullyInside(u.startKey, u.endKey, fullDayCounts, midDayCounts)) return false;
            const covered = days.filter((d) => !d.dropped && dayKeyInSpan(d.dayKey, u.startKey, u.endKey, order));
            if (covered.length <= 1) return false;
            if (!covered.every((d) => d.level === u.level - 1)) return false;
            if (!covered.every((d) => fullyInside.has(d.dayKey))) return false;
            const first = covered[0];
            first.level = u.level;
            first.text = u.text;
            first.endKey = u.endKey;
            // 合并地点；被吞掉的天标记 mergedInto（与精确裁剪的丢弃区分）
            for (const d of covered.slice(1)) {
                for (const loc of d.locations) {
                    if (loc && !first.locations.includes(loc)) first.locations.push(loc);
                }
                d.dropped = true;
                d.mergedInto = u.key;
                d.mergedLevel = u.level;
            }
            return true;
        };
        // Phase B：从最旧侧把连续同层天换成父节点（逐层上升）
        if (totalEst() > midBudgetEst) {
            const maxLevel = (typeof Constants.HIER_MAX_LEVELS === 'number' && Constants.HIER_MAX_LEVELS >= 2)
                ? Math.floor(Constants.HIER_MAX_LEVELS) : 4;
            for (let level = 2; level <= maxLevel; level++) {
                if (totalEst() <= midBudgetEst) break;
                for (const u of validUpper) {
                    if (u.level !== level) continue;
                    if (totalEst() <= midBudgetEst) break;
                    tryApplyUpper(u);
                }
            }
        }
        return { days, upperUsed: validUpper.length, l1ByDay, validUpper, fullyInside, order, tryApplyUpper };
    }

    // 槽位 → 统一 markdown 条目列（原文与摘要伪条目同形，一次渲染）
    function slotsToEntries(days) {
        const out = [];
        for (const d of days) {
            if (d.dropped) continue;
            if (d.level === 0) {
                for (const e of d.entries) out.push(e);
            } else {
                out.push(summaryToEntry(d.dayKey, d.endKey, d.text, d.locations));
            }
        }
        return out;
    }

    async function buildPromptData(chatCopy, options) {
        const runFold = Boolean(options && (options.runFold !== undefined ? options.runFold : options.runRag));
        const historyTemplate = parseTemplate(Settings.get('historyPrompt'), true);
        const characterTemplate = isRoleCardEnabled() ? parseTemplate(Settings.get('characterPrompt'), true) : null;
        if (historyTemplate === null || (isRoleCardEnabled() && characterTemplate === null)) {
            console.error('[Chat History Optimization] 模板解析失败，生成可能异常，请在"模板"选项卡检查 JSON');
        }
        const mergedDataInfo = mergeDataInfo(chatCopy, historyTemplate, characterTemplate);
        const historyData = mergedDataInfo.historyData || {};
        const characterData = processCharacterData(mergedDataInfo.characterData || {}, chatCopy);
        // 角色状态追踪：按楼层顺序把各楼层 extra 的可变状态数组合并为最终状态，
        // 覆盖到角色卡可变子树（追踪赢）。RoleTrack 未加载时跳过，保证向后兼容。
        try {
            if (NS.RoleTrack && typeof NS.RoleTrack.applyToCharacterData === 'function') {
                NS.RoleTrack.applyToCharacterData(characterData, chatCopy);
            }
        } catch (e) {
            console.error('[Chat History Optimization] 角色状态合并失败，使用未合并角色卡', e);
        }
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
        // tailPos：assistantIdxArr 中正文起点下标；正文超预算时右移以丢弃最旧消息
        let tailPos = assistantIdxArr.length - keepCount;
        const buildTail = (pos) => {
            const startIdx = assistantIdxArr[pos];
            let covered = 0;
            const text = chatCopy
                .slice(startIdx)
                .filter(item => item && item.is_user === false)
                .map(item => {
                    if (!item || !item.mes) return '';
                    covered += item.messageCount || 0;
                    return item.mes;
                })
                .join('\n');
            return { text, covered };
        };
        const initialTail = keepCount > 0 ? buildTail(tailPos) : { text: '', covered: 0 };
        let tailText = initialTail.text;
        let tailCovered = initialTail.covered;

        // --- 历程拆分：maxDay 从完整历程计算；正文覆盖的尾部条目从中段排除 ---
        const fullJourney = Array.isArray(historyData.故事历程) ? historyData.故事历程 : [];
        let midEntries = tailCovered > 0
            ? fullJourney.slice(0, Math.max(0, fullJourney.length - tailCovered))
            : [...fullJourney];
        const midMaxDay = computeMaxDay(fullJourney);
        delete historyData.故事历程;

        let tokenLimit = Settings.get('tokenLimit');
        if (typeof tokenLimit !== 'number' || isNaN(tokenLimit)) tokenLimit = Settings.defaultSettings.tokenLimit;

        // 模板/包装开销：STORY_DATA 骨架 + NEW_STORY_DATA 模板恒附在最终消息上，
        // 从内容预算中扣除，保证最终 tokenCount ≤ tokenLimit
        const overheadTokens = await getTokenCountAsync(getCharPrompt({ 前文: '' }, {}));
        const contentLimit = Math.max(1, tokenLimit - overheadTokens);

        let fullMidMarkdown = renderJourneyMarkdown(midEntries, midMaxDay);
        const fullTokens = await getTokenCountAsync(joinNonEmpty([fullMidMarkdown, tailText]) + charJson);

        // 分层折叠由预算自然决定：全量装得下 → 零压缩；装不下 → 从最旧侧折叠。
        // 发送前永不等 LLM：只读已有摘要，缺失父节点用子节点原文兜底。
        const hierWillActivate = fullTokens > contentLimit;
        console.log(`[Chat History Optimization] 全量 ${fullTokens} tokens，tokenLimit=${tokenLimit}（模板开销 ${overheadTokens}，内容预算 ${contentLimit}），分层折叠${hierWillActivate ? '将启用' : '不启用'}（中段 ${midEntries.length} 条）`);

        let hier = {
            active: false,
            willActivate: hierWillActivate,
            days: [],
            upper: [],
            foldedDays: 0,
            droppedDays: 0,
        };
        let midMarkdown = fullMidMarkdown;

        if (hierWillActivate && runFold && midEntries.length > 0) {
            // 正文硬上限：正文+角色卡超 contentLimit 时从最旧整条 assistant 消息丢弃，
            // 其历程条目回归中段（仍可被折叠覆盖）
            let tailTok = await getTokenCountAsync(tailText + charJson);
            while (tailTok > contentLimit && tailPos < assistantIdxArr.length - 1) {
                tailPos++;
                const t = buildTail(tailPos);
                tailText = t.text;
                tailCovered = t.covered;
                midEntries = tailCovered > 0
                    ? fullJourney.slice(0, Math.max(0, fullJourney.length - tailCovered))
                    : [...fullJourney];
                fullMidMarkdown = renderJourneyMarkdown(midEntries, midMaxDay);
                tailTok = await getTokenCountAsync(tailText + charJson);
            }
            if (tailTok > contentLimit) {
                console.warn(`[Chat History Optimization] 正文+角色卡（${tailTok}）超出内容预算（${contentLimit}）且无可丢弃消息，最终将超 tokenLimit，请调大 tokenLimit 或调小 keepCount`);
            }
            const midBudget = Math.max(0, contentLimit - tailTok);
            // 全历程/中段按天计数：判定"完全落在中段内"的天（部分被正文覆盖的天永不折叠）
            const fullDayCounts = new Map();
            for (const e of fullJourney) {
                const dk = dayKeyOf(e);
                fullDayCounts.set(dk, (fullDayCounts.get(dk) || 0) + 1);
            }
            const midDayCounts = new Map();
            for (const e of midEntries) {
                const dk = dayKeyOf(e);
                midDayCounts.set(dk, (midDayCounts.get(dk) || 0) + 1);
            }
            try {
                const coverage = (NS.SubSummary && typeof NS.SubSummary.getCoverage === 'function')
                    ? NS.SubSummary.getCoverage() : { days: [], upper: [] };
                const plan = planFoldSlots(midEntries, fullDayCounts, midDayCounts, coverage, midBudget);
                const renderPlan = () => renderJourneyMarkdown(slotsToEntries(plan.days), midMaxDay);
                midMarkdown = renderPlan();
                // 精确计数：估算（EST_CHARS_PER_TOKEN）偏乐观时可能"该折的没折"，
                // 直接丢整天会把有 L1 的天整个丢掉（如超 1k 却丢 5k）。故超预算时
                // 优先把最旧可折叠 L0 折成 L1、再试上层合并，都不行才丢最旧槽位，
                // 直到 ≤ midBudget（无次数上限，保证硬上限）。
                let tok = await getTokenCountAsync(midMarkdown);
                const maxLevel = (typeof Constants.HIER_MAX_LEVELS === 'number' && Constants.HIER_MAX_LEVELS >= 2)
                    ? Math.floor(Constants.HIER_MAX_LEVELS) : 4;
                while (tok > midBudget) {
                    // 1. 最旧可折叠 L0 → L1（须完全落在中段内且有有效天摘要）
                    const foldIdx = plan.days.findIndex((d) => !d.dropped && d.level === 0
                        && plan.fullyInside && plan.fullyInside.has(d.dayKey)
                        && plan.l1ByDay && plan.l1ByDay.has(d.dayKey));
                    if (foldIdx !== -1) {
                        const d = plan.days[foldIdx];
                        d.level = 1;
                        d.text = plan.l1ByDay.get(d.dayKey);
                        d.endKey = d.dayKey;
                        midMarkdown = renderPlan();
                        tok = await getTokenCountAsync(midMarkdown);
                        continue;
                    }
                    // 2. 上层合并（逐层上升，复用与 Phase B 同一判定）
                    let merged = false;
                    if (plan.tryApplyUpper && Array.isArray(plan.validUpper)) {
                        for (let level = 2; level <= maxLevel; level++) {
                            if (tok <= midBudget) break;
                            for (const u of plan.validUpper) {
                                if (u.level !== level) continue;
                                if (tok <= midBudget) break;
                                if (plan.tryApplyUpper(u)) {
                                    merged = true;
                                    midMarkdown = renderPlan();
                                    tok = await getTokenCountAsync(midMarkdown);
                                    if (tok <= midBudget) break;
                                }
                            }
                            if (tok <= midBudget) break;
                        }
                    }
                    if (merged) continue;
                    // 3. 都不行才丢最旧槽位
                    const idx = plan.days.findIndex((d) => !d.dropped);
                    if (idx === -1) break;
                    plan.days[idx].dropped = true;
                    midMarkdown = renderPlan();
                    tok = await getTokenCountAsync(midMarkdown);
                }
                hier.active = true;
                hier.days = plan.days.map((d) => ({
                    dayKey: d.dayKey,
                    label: d.label,
                    count: d.count,
                    level: d.dropped ? (d.mergedInto ? d.mergedLevel : -1) : d.level,
                    text: (!d.dropped && d.level > 0) ? d.text : null,
                    endKey: d.endKey,
                    mergedInto: d.mergedInto || null,
                }));
                hier.upper = (coverage.upper || []).filter((u) => u && u.text).map((u) => ({
                    level: u.level,
                    key: u.key,
                    startKey: u.startKey,
                    endKey: u.endKey,
                    startLabel: u.startLabel,
                    endLabel: u.endLabel,
                    text: u.text,
                }));
                hier.foldedDays = hier.days.filter((d) => d.level > 0).length;
                hier.droppedDays = hier.days.filter((d) => d.level < 0).length;
            } catch (e) {
                console.error('[Chat History Optimization] 分层折叠失败，使用全量中段', e);
                hier = { active: false, willActivate: true, days: [], upper: [], foldedDays: 0, droppedDays: 0 };
                midMarkdown = fullMidMarkdown;
            }
        }

        historyData.前文 = joinNonEmpty([midMarkdown, tailText]);
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
            failedDetails: mergedDataInfo.failedDetails,
            hierMarkdown: midMarkdown,
            lastMessage,
            tokenCount,
            hier,
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
     * （含分层折叠与首条信息后缀），保证预览与"现在生成会发送的内容"一致。
     * 不修改 ST 的 chat 数组。
     */
    async function refreshStats() {
        const sourceChat = NS.bridge && NS.bridge.getCurrentChat ? NS.bridge.getCurrentChat() : null;
        if (!sourceChat || !Array.isArray(sourceChat) || sourceChat.length === 0) return;
        const chatCopy = JSON.parse(JSON.stringify(sourceChat));
        const result = await assembleFinalPrompt(chatCopy, { runFold: true });
        notifyStats({
            failedFloors: result.failedFloors,
            roles: JSON.parse(JSON.stringify(result.allCharacterData)),
            activeRoleNames: [...result.activeRoleNames],
            tokenCount: result.tokenCount,
            hier: result.hier,
            lastMessage: result.lastMessage,
        });
    }

    /**
     * 轻量检查当前聊天中新出现的 NEW_STORY_DATA 解析失败楼层，
     * 经 onParseFail 总线广播（只报相对上次基线新出现的，历史失败不重复提示）。
     * 由消息事件驱动（回复到达/编辑/更新/切 swipe），不在生成发送时检查。
     * silent 模式（删消息/切聊天）：楼层下标整体错位，只静默重建基线不广播。
     */
    function checkParseFailures(options) {
        const silent = !!(options && options.silent);
        if (!Settings.get('extensionToggle')) return;
        const sourceChat = NS.bridge && NS.bridge.getCurrentChat ? NS.bridge.getCurrentChat() : null;
        if (!sourceChat || !Array.isArray(sourceChat) || sourceChat.length === 0) return;
        const chatCopy = JSON.parse(JSON.stringify(sourceChat));
        const historyTemplate = parseTemplate(Settings.get('historyPrompt'));
        const characterTemplate = isRoleCardEnabled() ? parseTemplate(Settings.get('characterPrompt')) : null;
        const { failedFloors, failedDetails } = mergeDataInfo(chatCopy, historyTemplate, characterTemplate);
        const newlyFailed = failedFloors.filter(i => !lastStats.failedFloors.includes(i));
        if (!silent && newlyFailed.length > 0) {
            notifyParseFail(failedDetails.filter(d => newlyFailed.includes(d.index)));
        }
        const prev = lastStats.failedFloors;
        const changed = failedFloors.length !== prev.length || failedFloors.some((i, idx) => prev[idx] !== i);
        if (changed) {
            if (silent) lastStats = { ...lastStats, failedFloors };
            else notifyStats({ failedFloors });
        }
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

        // 深拷贝：mergeDataInfo 会写入 item.messageCount，不能污染 ST 数据
        const chatCopy = JSON.parse(JSON.stringify(chat));
        const result = await assembleFinalPrompt(chatCopy, { runFold: true });
        const historyData = result.historyData;
        const characterData = result.characterData;

        chat[chat.length - 1]['mes'] = result.lastMessage;

        notifyStats({
            failedFloors: result.failedFloors,
            roles: JSON.parse(JSON.stringify(result.allCharacterData)),
            activeRoleNames: [...result.activeRoleNames],
            tokenCount: result.tokenCount,
            hier: result.hier,
            lastMessage: result.lastMessage,
        });

        console.log("[Chat History Optimization] token count:", result.tokenCount);
        if (result.tokenCount > Settings.get('tokenLimit')) {
            console.warn(`[Chat History Optimization] 最终 ${result.tokenCount} tokens 仍超 tokenLimit=${Settings.get('tokenLimit')}（正文/角色卡本身超预算且无可丢弃消息），请调大 tokenLimit 或调小 keepCount`);
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

    // 解析失败检查改为消息事件驱动（v2.11.1）：回复到达/编辑/更新/切 swipe 时检查；
    // 删消息/切聊天时楼层下标错位，静默重建失败楼层基线避免误报
    const { eventSource, eventTypes } = NS.bridge;
    if (eventSource && eventTypes) {
        if (eventTypes.MESSAGE_RECEIVED) eventSource.on(eventTypes.MESSAGE_RECEIVED, () => checkParseFailures());
        if (eventTypes.MESSAGE_EDITED) eventSource.on(eventTypes.MESSAGE_EDITED, () => checkParseFailures());
        if (eventTypes.MESSAGE_UPDATED) eventSource.on(eventTypes.MESSAGE_UPDATED, () => checkParseFailures());
        if (eventTypes.MESSAGE_SWIPED) eventSource.on(eventTypes.MESSAGE_SWIPED, () => checkParseFailures());
        if (eventTypes.MESSAGE_DELETED) eventSource.on(eventTypes.MESSAGE_DELETED, () => checkParseFailures({ silent: true }));
        if (eventTypes.CHAT_CHANGED) eventSource.on(eventTypes.CHAT_CHANGED, () => checkParseFailures({ silent: true }));
        if (eventTypes.CHAT_LOADED) eventSource.on(eventTypes.CHAT_LOADED, () => checkParseFailures({ silent: true }));
    }

    NS.Engine = Object.freeze({
        wordMapping,
        parseTemplate,
        validateTemplate,
        deepMerge,
        onStats,
        onParseFail,
        getStats,
        refreshStats,
        getFloorStoryBlock,
        getStoryProgressRange,
        getKnownRoles,
        getKnownRoleCards,
        entryToDocText,
        getNameSearchTerms,
        nameMatches,
    });
})();

// ============================================================================
// chat-optimization-v2 二级摘要生成器。
// 纯逻辑：不访问 DOM。UI 更新走状态事件总线（onStatus/getStatus）。
// 摘要持久化在楼层消息 item.extra["chat-optimization-v2"]，
// 以楼层级 FNV-1a 哈希校验 故事历程 数组是否变化，失效即清空。
// ============================================================================
(function () {
    'use strict';

    const NS = window.ChatOptimizationV2 = window.ChatOptimizationV2 || {};
    const { saveChat, saveChatDebounced, eventSource, eventTypes } = NS.bridge;
    const Settings = NS.Settings;
    const Engine = NS.Engine;

    const EXTRA_KEY = 'chat-optimization-v2';
    const PLACEHOLDER = '{{故事历程}}';

    let lastStatus = { running: false, current: '', done: 0, failed: 0, error: null, message: null };
    const statusListeners = new Set();
    let running = false;
    let initialized = false;

    // ------------------------------------------------------------------
    // 哈希
    // ------------------------------------------------------------------

    function fnv1a32(text) {
        let hash = 0x811c9dc5;
        for (let i = 0; i < text.length; i++) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193) >>> 0;
        }
        return hash.toString(16).padStart(8, '0');
    }

    // ------------------------------------------------------------------
    // 状态总线（模式同 Engine.notifyStats/onStats）
    // ------------------------------------------------------------------

    function getStatus() {
        return Object.assign({}, lastStatus);
    }

    function notifyStatus(patch) {
        lastStatus = Object.assign({}, lastStatus, patch);
        const snapshot = getStatus();
        for (const listener of statusListeners) {
            try {
                listener(snapshot);
            } catch (e) {
                console.error('[Chat History Optimization] 二级摘要状态监听器错误', e);
            }
        }
    }

    function onStatus(listener) {
        statusListeners.add(listener);
        return () => statusListeners.delete(listener);
    }

    // ------------------------------------------------------------------
    // 设置访问（非法值回退默认）
    // ------------------------------------------------------------------

    function isConfigured() {
        return Boolean(String(Settings.get('subSummaryBaseUrl') || '').trim())
            && Boolean(String(Settings.get('subSummaryApiKey') || '').trim())
            && Boolean(String(Settings.get('subSummaryModel') || '').trim());
    }

    function validateTemplate(text) {
        return typeof text === 'string' && text.trim() !== '' && text.indexOf(PLACEHOLDER) !== -1;
    }

    function normalizeBaseUrl(baseUrl) {
        let url = String(baseUrl || '').trim().replace(/\/+$/, '');
        if (!url) return null;
        if (!/\/chat\/completions$/.test(url)) url += '/chat/completions';
        return url;
    }

    function getTemperature() {
        const value = Settings.get('subSummaryTemperature');
        return (typeof value === 'number' && !isNaN(value)) ? value : Settings.defaultSettings.subSummaryTemperature;
    }

    function getMaxTokens() {
        const value = Settings.get('subSummaryMaxTokens');
        return (typeof value === 'number' && !isNaN(value) && value > 0) ? value : Settings.defaultSettings.subSummaryMaxTokens;
    }

    // ------------------------------------------------------------------
    // extra 读写（含楼层级哈希失效清空）
    // ------------------------------------------------------------------

    function getFloorItem(floor) {
        const chat = NS.bridge.getCurrentChat ? NS.bridge.getCurrentChat() : null;
        if (!chat || !Array.isArray(chat)) return null;
        const item = chat[floor];
        if (!item) return null;
        if (!((("is_user" in item && !item.is_user) || (item.role && item.role === 'assistant')))) return null;
        return item;
    }

    function getFloorJourney(floor) {
        const item = getFloorItem(floor);
        if (!item) return null;
        const historyObj = Engine.getFloorStoryBlock(item);
        if (!historyObj || !Array.isArray(historyObj.故事历程)) return null;
        return { item, journey: historyObj.故事历程 };
    }

    // 哈希不匹配（或结构非法）时清空该楼层 extra 字段并返回 null
    function readFloorExtra(item, storyHash) {
        const extra = item.extra && typeof item.extra === 'object' ? item.extra[EXTRA_KEY] : null;
        const valid = !!(extra && extra.storyHash === storyHash && Array.isArray(extra.summaries));
        if (!valid) {
            if (item.extra) delete item.extra[EXTRA_KEY];
            return null;
        }
        return extra;
    }

    function getFloorSummaries(floor) {
        const floorData = getFloorJourney(floor);
        if (!floorData) return { valid: false, summaries: [], storyHash: null };
        const storyHash = fnv1a32(JSON.stringify(floorData.journey));
        const extra = readFloorExtra(floorData.item, storyHash);
        return {
            valid: !!extra,
            summaries: extra ? extra.summaries : [],
            storyHash,
        };
    }

    function getValidSummary(floor, entryIndex) {
        const { valid, summaries } = getFloorSummaries(floor);
        if (!valid) return null;
        const entry = summaries[entryIndex];
        if (entry && typeof entry === 'object' && entry.s !== undefined && entry.s !== null) {
            return { s: entry.s, t: entry.t || 0 };
        }
        return null;
    }

    // ------------------------------------------------------------------
    // LLM 调用
    // ------------------------------------------------------------------

    async function callLlm(content) {
        const url = normalizeBaseUrl(Settings.get('subSummaryBaseUrl'));
        if (!url) throw new Error('API baseUrl 未配置');
        const apiKey = String(Settings.get('subSummaryApiKey') || '').trim();
        const model = String(Settings.get('subSummaryModel') || '').trim();

        let response;
        try {
            response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model,
                    messages: [{ role: 'user', content }],
                    temperature: getTemperature(),
                    max_tokens: getMaxTokens(),
                }),
            });
        } catch (e) {
            console.error('[Chat History Optimization] 二级摘要 API 请求失败（网络/CORS 错误）:', e);
            throw new Error('API 请求失败（网络/CORS 错误）');
        }

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            console.error(`[Chat History Optimization] 二级摘要 API 返回 ${response.status}:`, text);
            throw new Error(`API 返回 ${response.status}`);
        }

        let data;
        try {
            data = await response.json();
        } catch (e) {
            console.error('[Chat History Optimization] 二级摘要 API 响应不是 JSON:', e);
            throw new Error('API 响应不是 JSON');
        }

        const raw = data && data.choices && data.choices[0] && data.choices[0].message
            ? data.choices[0].message.content
            : null;
        if (typeof raw !== 'string') {
            console.error('[Chat History Optimization] 二级摘要 API 响应结构异常:', data);
            throw new Error('API 响应结构异常');
        }

        // 兼容 markdown code fence 包裹：取第一个 {...} 块
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) {
            console.error('[Chat History Optimization] 二级摘要 API 响应中未找到 JSON 对象:', raw);
            throw new Error('API 响应中未找到 JSON 对象');
        }

        let obj;
        try {
            obj = JSON.parse(match[0]);
        } catch (e) {
            console.error('[Chat History Optimization] 二级摘要 API 响应 JSON 解析失败:', match[0], e);
            throw new Error('API 响应 JSON 解析失败');
        }

        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
            console.error('[Chat History Optimization] 二级摘要 API 响应 JSON 不是对象:', raw);
            throw new Error('API 响应 JSON 不是对象');
        }
        return obj;
    }

    // ------------------------------------------------------------------
    // 生成核心
    // ------------------------------------------------------------------

    // 单条目生成。返回 'ok'（已生成）或 'skip'（已有效且非 force）。失败时抛错。
    async function runOne(floor, entryIndex, force) {
        if (!isConfigured()) {
            throw new Error('请先在"二级摘要"选项卡配置 baseUrl、apiKey 和模型');
        }
        const floorData = getFloorJourney(floor);
        if (!floorData) throw new Error(`楼层 ${floor} 无有效故事历程`);
        const { item, journey } = floorData;
        const entry = journey[entryIndex];
        if (!entry || typeof entry !== 'object') throw new Error(`楼层 ${floor} 条目 ${entryIndex + 1} 不存在`);

        const storyHash = fnv1a32(JSON.stringify(journey));
        const extra = readFloorExtra(item, storyHash);
        if (!force && extra) {
            const existing = extra.summaries[entryIndex];
            if (existing && typeof existing === 'object' && existing.s !== undefined && existing.s !== null) {
                return 'skip';
            }
        }

        const template = Settings.get('subSummaryPrompt');
        if (!validateTemplate(template)) {
            throw new Error(`二级摘要模板无效（需非空且包含 ${PLACEHOLDER}）`);
        }
        // 占位符替换为条目完整 JSON（紧凑格式）；split/join 避免 JSON 中 $ 模式被 replace 解释
        const content = String(template).split(PLACEHOLDER).join(JSON.stringify(entry));

        const s = await callLlm(content);

        const summaries = (extra && Array.isArray(extra.summaries)) ? extra.summaries : new Array(journey.length).fill(null);
        while (summaries.length < journey.length) summaries.push(null);
        summaries[entryIndex] = { s, t: Date.now() };
        item.extra = item.extra || {};
        item.extra[EXTRA_KEY] = { storyHash, summaries };
        saveChatDebounced();
        return 'ok';
    }

    // 串行执行一批 {floor, index} 目标，统一维护状态总线
    async function executeBatch(targets, force) {
        const total = targets.length;
        if (total === 0) {
            notifyStatus({ running: false, current: '', done: 0, failed: 0, error: '没有可生成的故事历程条目' });
            return { done: 0, failed: 0 };
        }
        let done = 0;
        let failed = 0;
        let lastError = null;
        running = true;
        try {
            for (let k = 0; k < total; k++) {
                const floor = targets[k].floor;
                const index = targets[k].index;
                notifyStatus({ running: true, current: `楼层${floor} 条目${index + 1}/${total}`, done, failed, error: null });
                try {
                    const result = await runOne(floor, index, force);
                    if (result === 'ok') done++;
                } catch (e) {
                    failed++;
                    lastError = String((e && e.message) || e);
                    console.error(`[Chat History Optimization] 楼层 ${floor} 条目 ${index + 1} 二级摘要生成失败:`, e);
                }
            }
            if (done > 0) saveChat();
        } finally {
            running = false;
            notifyStatus({
                running: false,
                current: '',
                done,
                failed,
                error: failed > 0 ? `失败 ${failed} 条${lastError ? '：' + lastError : ''}` : null,
                message: (failed === 0 && done === 0) ? '范围内条目均已有有效摘要，无需生成' : null,
            });
        }
        return { done, failed };
    }

    async function generateForEntry(floor, entryIndex, options = {}) {
        if (running) {
            console.warn('[Chat History Optimization] 二级摘要生成进行中，忽略本次请求');
            return false;
        }
        const force = Boolean(options && options.force);
        let done = 0;
        let failed = 0;
        let error = null;
        let message = null;
        running = true;
        notifyStatus({ running: true, current: `楼层${floor} 条目${entryIndex + 1}`, done: 0, failed: 0, error: null, message: null });
        try {
            const result = await runOne(floor, entryIndex, force);
            if (result === 'ok') done = 1;
            else if (result === 'skip') message = '该条目已有有效摘要，无需生成';
        } catch (e) {
            failed = 1;
            error = String((e && e.message) || e);
            console.error(`[Chat History Optimization] 楼层 ${floor} 条目 ${entryIndex + 1} 二级摘要生成失败:`, e);
        } finally {
            running = false;
            notifyStatus({ running: false, current: '', done, failed, error, message });
        }
        return failed === 0;
    }

    function toFloor(value) {
        if (value === null || value === undefined || value === '') return null;
        const n = Math.floor(Number(value));
        return isNaN(n) ? null : n;
    }

    function collectRangeTargets(startFloor, endFloor) {
        const chat = NS.bridge.getCurrentChat ? NS.bridge.getCurrentChat() : null;
        if (!chat || !Array.isArray(chat)) return null;
        const totalFloors = Math.max(0, chat.length - 1);
        if (totalFloors < 1) return null;

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

        const targets = [];
        for (let floor = start; floor <= end; floor++) {
            const floorData = getFloorJourney(floor);
            if (!floorData) continue;
            for (let i = 0; i < floorData.journey.length; i++) {
                targets.push({ floor, index: i });
            }
        }
        return targets;
    }

    async function generateForRange(startFloor, endFloor, options = {}) {
        if (running) {
            console.warn('[Chat History Optimization] 二级摘要生成进行中，忽略本次请求');
            return false;
        }
        const force = Boolean(options && options.force);
        const targets = collectRangeTargets(startFloor, endFloor);
        if (targets === null) {
            notifyStatus({ running: false, current: '', done: 0, failed: 0, error: '没有可用的楼层范围' });
            return false;
        }
        await executeBatch(targets, force);
        return true;
    }

    // 强制擦除范围内全部楼层的二级摘要（无视哈希有效性），返回擦除的楼层数
    function eraseForRange(startFloor, endFloor) {
        if (running) {
            notifyStatus({ running: false, current: '', done: 0, failed: 0, error: '生成进行中，请稍后再擦除', message: null });
            return 0;
        }
        const chat = NS.bridge.getCurrentChat ? NS.bridge.getCurrentChat() : null;
        if (!chat || !Array.isArray(chat)) {
            notifyStatus({ running: false, current: '', done: 0, failed: 0, error: '没有可用的聊天数据', message: null });
            return 0;
        }
        const totalFloors = Math.max(0, chat.length - 1);
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
        let erased = 0;
        for (let floor = start; floor <= end; floor++) {
            const item = chat[floor];
            if (item && item.extra && item.extra[EXTRA_KEY]) {
                delete item.extra[EXTRA_KEY];
                erased++;
            }
        }
        if (erased > 0) saveChat();
        notifyStatus({
            running: false,
            current: '',
            done: 0,
            failed: 0,
            error: null,
            message: erased > 0 ? `已擦除 ${erased} 个楼层的二级摘要` : '楼层范围内没有可擦除的二级摘要',
        });
        return erased;
    }

    // ------------------------------------------------------------------
    // 自动触发：AI 回复生成结束后，为最后一条 assistant 楼层补齐缺失条目
    // ------------------------------------------------------------------

    function onGenerationEnded() {
        if (running) return;
        if (!Settings.get('subSummaryToggle')) return;
        if (!isConfigured()) return;
        const chat = NS.bridge.getCurrentChat ? NS.bridge.getCurrentChat() : null;
        if (!chat || !Array.isArray(chat)) return;

        let lastFloor = null;
        for (let i = chat.length - 1; i >= 1; i--) {
            if (getFloorItem(i)) {
                lastFloor = i;
                break;
            }
        }
        if (lastFloor === null) return;

        const floorData = getFloorJourney(lastFloor);
        if (!floorData) return;
        const { journey } = floorData;

        const { valid, summaries } = getFloorSummaries(lastFloor);
        const targets = [];
        for (let i = 0; i < journey.length; i++) {
            const existing = valid ? summaries[i] : null;
            if (!existing || typeof existing !== 'object' || existing.s === undefined || existing.s === null) {
                targets.push({ floor: lastFloor, index: i });
            }
        }
        if (targets.length === 0) return;

        console.log(`[Chat History Optimization] 自动生成二级摘要：楼层 ${lastFloor} 缺失 ${targets.length} 条`);
        executeBatch(targets, false).catch((e) => {
            console.error('[Chat History Optimization] 自动生成二级摘要失败:', e);
        });
    }

    function init() {
        if (initialized) return;
        initialized = true;
        eventSource.on(eventTypes.GENERATION_ENDED, onGenerationEnded);
    }

    NS.SubSummary = Object.freeze({
        EXTRA_KEY,
        PLACEHOLDER,
        isConfigured,
        validateTemplate,
        getFloorSummaries,
        getValidSummary,
        generateForEntry,
        generateForRange,
        eraseForRange,
        onStatus,
        getStatus,
        init,
    });

    init();
})();

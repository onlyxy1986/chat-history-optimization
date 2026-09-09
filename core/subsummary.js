// ============================================================================
// chat-optimization-v2 分层摘要生成器。
// 纯逻辑：不访问 DOM。UI 更新走状态事件总线（onStatus/getStatus）。
//
// 层级：L0 = 历程条目原文（事实源，不存）；
//   L1 = 天摘要（一 key 一条，key = 天数数字或 'unknown'），
//   L(k≥2) = 连续 fanin 个 L(k-1) 节点合并成的父摘要，层数按需生长。
// 摘要持久化在 chat_metadata["chat-optimization-v2-hier"]（per-chat），
// 父节点以 childHash（子节点文本串哈希）校验，子变化即标脏，不清整树。
// 发送前永不等 LLM：装配层只读已有摘要，缺失父节点用子节点原文兜底。
// ============================================================================
(function () {
    'use strict';

    const NS = window.ChatOptimizationV2 = window.ChatOptimizationV2 || {};
    const { eventSource, eventTypes } = NS.bridge;
    const Settings = NS.Settings;
    const Engine = NS.Engine;

    const Constants = NS.Constants;
    const HIER_METADATA_KEY = 'chat-optimization-v2-hier';
    const UNKNOWN_KEY = 'unknown';
    const DAY_PLACEHOLDER = '{{当天历程}}';
    const MERGE_PLACEHOLDER = '{{子摘要列表}}';

    // lastDone：最近一次成功生成影响的 {dayKey, level, key}，供 UI 做增量刷新
    let lastStatus = { running: false, current: '', done: 0, failed: 0, error: null, message: null, lastDone: null };
    const statusListeners = new Set();
    let running = false;
    let initialized = false;
    // 所有批次（自动触发 / 手动）经此链串行，批次之间不并行；
    // 批次内部同层级多节点经 worker 池并行（并发数见 getConcurrency），
    // 层与层之间按 L1→L2→… 顺序执行（父输入依赖子文本）。
    let batchChain = Promise.resolve();

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

    function parseDayNumber(dayStr) {
        if (typeof dayStr !== 'string') return null;
        const m = dayStr.match(/第\s*(\d+)\s*天/);
        return m ? parseInt(m[1], 10) : null;
    }

    function dayLabel(dayKey) {
        if (dayKey === UNKNOWN_KEY) {
            return (Constants.HIER_UNKNOWN_DAY_LABEL || '未知天');
        }
        return `第${dayKey}天`;
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
                console.error('[Chat History Optimization] 分层摘要状态监听器错误', e);
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

    function getConnectionManagerProfiles() {
        const extensionSettings = NS.bridge.extensionSettings;
        if (!extensionSettings) return [];
        if (Array.isArray(extensionSettings.disabledExtensions) && extensionSettings.disabledExtensions.includes('connection-manager')) return [];
        const manager = extensionSettings.connectionManager;
        if (!manager || !Array.isArray(manager.profiles)) return [];
        return manager.profiles;
    }

    // 可用于分层摘要的 connection profile（仅 CC 类型且 url/model 齐全；
    // secret-id 可缺省，缺省时服务端回退到该 API 类型的主 API Key）
    function getProfileOptions() {
        return getConnectionManagerProfiles()
            .filter((p) => p && p.mode === 'cc'
                && typeof p.id === 'string' && p.id !== ''
                && String(p['api-url'] || '').trim() !== ''
                && String(p.model || '').trim() !== '')
            .map((p) => ({ id: p.id, name: p.name || p.id, model: String(p.model).trim(), url: String(p['api-url']).trim() }));
    }

    function isConfigured() {
        const source = String(Settings.get('subSummarySource') || 'fetch');
        if (source === 'profile') {
            const profileId = String(Settings.get('subSummaryProfileId') || '');
            if (!profileId) return false;
            return getProfileOptions().some((p) => p.id === profileId);
        }
        return Boolean(String(Settings.get('subSummaryBaseUrl') || '').trim())
            && Boolean(String(Settings.get('subSummaryApiKey') || '').trim())
            && Boolean(String(Settings.get('subSummaryModel') || '').trim());
    }

    function getFanin() {
        const min = (typeof Constants.HIER_FANIN_MIN === 'number' && Constants.HIER_FANIN_MIN >= 2)
            ? Math.floor(Constants.HIER_FANIN_MIN) : 2;
        const max = (typeof Constants.HIER_FANIN_MAX === 'number' && Constants.HIER_FANIN_MAX >= min)
            ? Math.floor(Constants.HIER_FANIN_MAX) : 10;
        const fallback = (typeof Constants.HIER_FANIN_DEFAULT === 'number')
            ? Math.floor(Constants.HIER_FANIN_DEFAULT) : 5;
        const raw = Settings.get('hierFanin');
        const n = (typeof raw === 'number' && !isNaN(raw)) ? Math.floor(raw) : fallback;
        if (n < min) return min;
        if (n > max) return max;
        return n;
    }

    function getMaxLevels() {
        const n = (typeof Constants.HIER_MAX_LEVELS === 'number' && Constants.HIER_MAX_LEVELS >= 2)
            ? Math.floor(Constants.HIER_MAX_LEVELS) : 4;
        return n;
    }

    function validateDayTemplate(text) {
        return typeof text === 'string' && text.trim() !== '' && text.indexOf(DAY_PLACEHOLDER) !== -1;
    }

    function validateMergeTemplate(text) {
        return typeof text === 'string' && text.trim() !== '' && text.indexOf(MERGE_PLACEHOLDER) !== -1;
    }

    function fatal(message) {
        const err = new Error(message);
        err.noRetry = true;
        return err;
    }

    // profile 附加参数：设置项 subSummaryExtraParams，JSON 对象（空视为无）。
    // 经 sendRequest 第 5 参数 overridePayload 发往 ST 服务端：
    // 白名单采样字段（top_p/top_k/seed/stop/…）直接转发上游；
    // CUSTOM 源另支持 custom_include_body / custom_include_headers（YAML 字符串，
    // 即预设里"Custom Include Body/Headers"机制，见 ST 后端 chat-completions.js）。
    // temperature 始终以温度设置项为准（见 callLlmViaProfile）。
    // 非法时抛 fatal 错误（配置问题，重试无意义）。
    function parseExtraParams() {
        const raw = Settings.get('subSummaryExtraParams');
        if (typeof raw !== 'string' || raw.trim() === '') return {};
        let obj;
        try {
            obj = JSON.parse(raw);
        } catch (e) {
            throw fatal('profile 附加参数不是有效 JSON');
        }
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
            throw fatal('profile 附加参数必须是 JSON 对象');
        }
        return obj;
    }

    function validateExtraParams(text) {
        if (typeof text !== 'string' || text.trim() === '') return true;
        try {
            const obj = JSON.parse(text);
            return !!obj && typeof obj === 'object' && !Array.isArray(obj);
        } catch (e) {
            return false;
        }
    }

    function getTemperature() {
        const value = Settings.get('subSummaryTemperature');
        return (typeof value === 'number' && !isNaN(value)) ? value : Settings.defaultSettings.subSummaryTemperature;
    }

    function getMaxTokens() {
        const value = Settings.get('subSummaryMaxTokens');
        return (typeof value === 'number' && !isNaN(value) && value > 0) ? value : Settings.defaultSettings.subSummaryMaxTokens;
    }

    function getConcurrency() {
        const max = (typeof Constants.SUBSUMMARY_CONCURRENCY_MAX === 'number' && Constants.SUBSUMMARY_CONCURRENCY_MAX > 0)
            ? Math.floor(Constants.SUBSUMMARY_CONCURRENCY_MAX) : 8;
        const fallback = (typeof Settings.defaultSettings.subSummaryConcurrency === 'number'
            && !isNaN(Settings.defaultSettings.subSummaryConcurrency))
            ? Math.floor(Settings.defaultSettings.subSummaryConcurrency) : 4;
        const value = Settings.get('subSummaryConcurrency');
        const n = (typeof value === 'number' && !isNaN(value)) ? Math.floor(value) : fallback;
        if (n < 1) return 1;
        return Math.min(n, max);
    }

    // 单次 LLM 请求超时（毫秒）：设置项 subSummaryTimeoutSec（秒）钳制到
    // SUBSUMMARY_TIMEOUT_MIN/MAX_MS；不合法回退 SUBSUMMARY_REQUEST_TIMEOUT_MS。
    function getRequestTimeoutMs() {
        const min = (typeof Constants.SUBSUMMARY_TIMEOUT_MIN_MS === 'number' && Constants.SUBSUMMARY_TIMEOUT_MIN_MS > 0)
            ? Math.floor(Constants.SUBSUMMARY_TIMEOUT_MIN_MS) : 10000;
        const max = (typeof Constants.SUBSUMMARY_TIMEOUT_MAX_MS === 'number' && Constants.SUBSUMMARY_TIMEOUT_MAX_MS > 0)
            ? Math.floor(Constants.SUBSUMMARY_TIMEOUT_MAX_MS) : 600000;
        const fallback = (typeof Constants.SUBSUMMARY_REQUEST_TIMEOUT_MS === 'number' && Constants.SUBSUMMARY_REQUEST_TIMEOUT_MS > 0)
            ? Math.floor(Constants.SUBSUMMARY_REQUEST_TIMEOUT_MS) : 120000;
        const raw = Settings.get('subSummaryTimeoutSec');
        const ms = (typeof raw === 'number' && !isNaN(raw)) ? Math.round(raw * 1000) : fallback;
        if (ms < min) return min;
        if (ms > max) return max;
        return ms;
    }

    function timeoutMessage(prefix, ms) {
        return `${prefix}请求超时（${Math.max(1, Math.round(ms / 1000))}秒）`;
    }

    function isAbortError(e) {
        return !!e && (e.name === 'AbortError' || (typeof DOMException !== 'undefined' && e instanceof DOMException && e.name === 'AbortError'));
    }

    // ------------------------------------------------------------------
    // L0 读取：全局去重历程条目 → 按天分组（顺序：天数升序，未知天最后）
    // ------------------------------------------------------------------

    function getDayGroups() {
        const EngineRef = NS.Engine;
        if (!EngineRef || typeof EngineRef.getStoryProgressRange !== 'function') return [];
        const { entries } = EngineRef.getStoryProgressRange(null, null);
        const groups = new Map(); // dayKey -> {dayKey, dayNum, entries: []}
        for (const e of entries) {
            const dayNum = parseDayNumber(e.天数);
            const dayKey = dayNum !== null ? String(dayNum) : UNKNOWN_KEY;
            if (!groups.has(dayKey)) {
                groups.set(dayKey, { dayKey, dayNum, entries: [] });
            }
            groups.get(dayKey).entries.push(e);
        }
        const out = [...groups.values()];
        out.sort((a, b) => {
            if (a.dayNum === null && b.dayNum === null) return 0;
            if (a.dayNum === null) return 1;
            if (b.dayNum === null) return -1;
            return a.dayNum - b.dayNum;
        });
        return out;
    }

    // L1 脏检查只看语义内容（天数/时间段/地点/历程），不含 floor/index：
    // 删楼层会导致后续楼层下标整体前移，含 floor 会误伤未改的天（全变脏）。
    function dayChildHash(day) {
        const content = (day.entries || []).map((e) => ({
            天数: e.天数 || '',
            时间段: e.时间段 || '',
            地点: e.地点 || '',
            历程: e.历程 || '',
        }));
        return fnv1a32(JSON.stringify(content));
    }

    function dayLocations(day) {
        const seen = new Set();
        const out = [];
        for (const e of day.entries) {
            const loc = String(e.地点 || '').trim();
            if (loc && !seen.has(loc)) {
                seen.add(loc);
                out.push(loc);
            }
        }
        return out;
    }

    // ------------------------------------------------------------------
    // store 读写（chat_metadata per-chat）
    // ------------------------------------------------------------------

    function getMetadata() {
        const meta = NS.bridge.getChatMetadata ? NS.bridge.getChatMetadata() : null;
        if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
        return meta;
    }

    function freshStore() {
        return { version: 1, fanin: getFanin(), l1: {}, upper: {} };
    }

    function loadStore() {
        const meta = getMetadata();
        if (!meta) return null;
        const raw = meta[HIER_METADATA_KEY];
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return freshStore();
        if (!raw.l1 || typeof raw.l1 !== 'object' || Array.isArray(raw.l1)) return freshStore();
        if (!raw.upper || typeof raw.upper !== 'object' || Array.isArray(raw.upper)) return freshStore();
        // fanin 变化整树重建上层：上层键 span 依赖 fanin 切分，旧键在新规划下永不命中，
        // 留着只会占存储 + 在 UI 切回旧 fanin 前一直是隐形垃圾；L1 与 fanin 无关予以保留。
        if (raw.fanin !== getFanin()) {
            raw.upper = {};
            raw.fanin = getFanin();
            if (typeof NS.bridge.saveMetadataDebounced === 'function') NS.bridge.saveMetadataDebounced();
        }
        return raw;
    }

    function saveStore(store) {
        const meta = getMetadata();
        if (!meta) return false;
        store.fanin = getFanin();
        meta[HIER_METADATA_KEY] = store;
        if (typeof NS.bridge.saveMetadataDebounced === 'function') NS.bridge.saveMetadataDebounced();
        return true;
    }

    // 删除孤儿：L1 只保留当前仍存在的日子；upper 只保留当前规划内的键。
    // 规划随天数/fanin 变化，旧 span（如 L3:1~6 → L3:1~7）永不再命中，不删即永久堆积。
    function pruneStore() {
        const meta = getMetadata();
        if (!meta) return false;
        const store = meta[HIER_METADATA_KEY];
        if (!store || typeof store !== 'object' || Array.isArray(store)) return false;
        if (!store.l1 || typeof store.l1 !== 'object' || !store.upper || typeof store.upper !== 'object') return false;
        let dayKeys = [];
        try {
            dayKeys = getDayGroups().map((g) => g.dayKey);
        } catch (e) {
            return false;
        }
        const daySet = new Set(dayKeys);
        let planSet = new Set();
        try {
            planSet = new Set(planUpperTree(dayKeys).map((n) => n.key));
        } catch (e) {
            return false;
        }
        let changed = false;
        for (const k of Object.keys(store.l1)) {
            if (!daySet.has(k)) {
                delete store.l1[k];
                changed = true;
            }
        }
        for (const k of Object.keys(store.upper)) {
            if (!planSet.has(k)) {
                delete store.upper[k];
                changed = true;
            }
        }
        if (store.fanin !== getFanin()) {
            store.fanin = getFanin();
            changed = true;
        }
        if (changed && typeof NS.bridge.saveMetadataDebounced === 'function') NS.bridge.saveMetadataDebounced();
        return changed;
    }

    // ------------------------------------------------------------------
    // 上层树规划：按天序把同层节点按 fanin 从最旧侧切块
    // ------------------------------------------------------------------

    function upperKey(level, startKey, endKey) {
        return `L${level}:${startKey}~${endKey}`;
    }

    // 上层键 span 解析：L1 dayKey 自身即 span；上层键 Lx:s~e 取 s/e。
    function spanOfKey(key) {
        if (typeof key !== 'string') return { start: key, end: key };
        if (key[0] !== 'L' || key.indexOf(':') === -1) return { start: key, end: key };
        const after = key.split(':')[1] || '';
        const parts = after.split('~');
        return { start: parts[0], end: parts[1] };
    }

    // 按当前天序 + fanin 规划全树结构（不含文本）：
    // 返回 [{level, key, startKey, endKey, startLabel, endLabel, childKeys}]
    // 严格整组合并：同层连续节点凑满 fanin 才建父，不满整组的尾巴全部直接晋升
    // （不满组提前合并会导致尾巴每来一天 key 就变，旧卡变孤儿致 UI 闪现又消失）。
    // 不同层节点永不混入同一父（混层父在装配层 spanFullyInside + 同层检查下永不可用，
    // 生成只是浪费 LLM）。
    function planUpperTree(dayKeys) {
        const fanin = getFanin();
        const maxLevels = getMaxLevels();
        const nodes = [];
        if (dayKeys.length <= 1) return nodes;
        let prev = dayKeys.map((k) => ({ key: k, level: 1 }));
        for (let level = 2; level <= maxLevels; level++) {
            if (prev.length <= 1) break;
            const cur = [];
            let made = false;
            let i = 0;
            while (i < prev.length) {
                if (prev[i].level !== level - 1) {
                    // 非本层输入（低层落单晋升上来的尾巴），原样晋升，不参与本层合并
                    cur.push(prev[i]);
                    i++;
                    continue;
                }
                let j = i;
                while (j < prev.length && prev[j].level === level - 1) j++;
                for (let k = i; k < j; k += fanin) {
                    const chunk = prev.slice(k, Math.min(k + fanin, j));
                    if (chunk.length < fanin) {
                        // 不满整组直接晋升（不生成摘要，沿用子节点）：尾巴凑满前保持 L(k-1) 原样，
                        // key 稳定无闪现；代价是尾巴压缩延迟，极端预算下靠 L1/丢弃顶（见设计）。
                        for (const c of chunk) cur.push(c);
                        continue;
                    }
                    const startKey = spanOfKey(chunk[0].key).start;
                    const endKey = spanOfKey(chunk[chunk.length - 1].key).end;
                    const key = upperKey(level, startKey, endKey);
                    nodes.push({
                        level,
                        key,
                        startKey,
                        endKey,
                        startLabel: dayLabel(startKey),
                        endLabel: dayLabel(endKey),
                        childKeys: chunk.map((c) => c.key),
                    });
                    cur.push({ key, level });
                    made = true;
                }
                i = j;
            }
            if (!made) break;
            prev = cur;
        }
        return nodes;
    }

    function childrenTexts(store, validL1, validUpper, node) {
        const texts = [];
        for (const ck of node.childKeys) {
            if (ck[0] === 'L') {
                const u = validUpper.get(ck);
                if (!u) return null;
                texts.push(u.text);
            } else {
                const d = validL1.get(ck);
                if (!d) return null;
                texts.push(d.text);
            }
        }
        return texts;
    }

    // ------------------------------------------------------------------
    // 只读快照：校验后的 days + upper（装配层与 UI 共用，不触发 LLM）
    // ------------------------------------------------------------------

    function getCoverage() {
        const groups = getDayGroups();
        const store = loadStore();
        const dayKeys = groups.map((g) => g.dayKey);
        const days = [];
        const validL1 = new Map(); // dayKey -> {text, t}
        if (store) {
            for (const g of groups) {
                const slot = store.l1[g.dayKey];
                const hash = dayChildHash(g);
                if (slot && typeof slot === 'object' && typeof slot.text === 'string' && slot.text.trim() !== '' && slot.h === hash) {
                    validL1.set(g.dayKey, { text: slot.text, t: slot.t || 0 });
                    days.push({
                        dayKey: g.dayKey,
                        label: dayLabel(g.dayKey),
                        count: g.entries.length,
                        floors: [...new Set(g.entries.map((e) => e.floor))],
                        locations: dayLocations(g),
                        text: slot.text,
                        t: slot.t || 0,
                    });
                } else {
                    days.push({
                        dayKey: g.dayKey,
                        label: dayLabel(g.dayKey),
                        count: g.entries.length,
                        floors: [...new Set(g.entries.map((e) => e.floor))],
                        locations: dayLocations(g),
                        text: null,
                        t: 0,
                    });
                }
            }
        } else {
            for (const g of groups) {
                days.push({
                    dayKey: g.dayKey,
                    label: dayLabel(g.dayKey),
                    count: g.entries.length,
                    floors: [...new Set(g.entries.map((e) => e.floor))],
                    locations: dayLocations(g),
                    text: null,
                    t: 0,
                });
            }
        }

        // 自底向上校验上层节点
        const plan = planUpperTree(dayKeys);
        const validUpper = new Map(); // key -> {text, t}
        const upper = [];
        if (store) {
            for (const node of plan) {
                const texts = childrenTexts(store, validL1, validUpper, node);
                const slot = store.upper[node.key];
                if (texts && slot && typeof slot === 'object'
                    && typeof slot.text === 'string' && slot.text.trim() !== ''
                    && slot.h === fnv1a32(texts.join('\n---\n'))) {
                    validUpper.set(node.key, { text: slot.text, t: slot.t || 0 });
                    upper.push({
                        level: node.level,
                        key: node.key,
                        startKey: node.startKey,
                        endKey: node.endKey,
                        startLabel: node.startLabel,
                        endLabel: node.endLabel,
                        childKeys: node.childKeys.slice(),
                        text: slot.text,
                        t: slot.t || 0,
                    });
                } else {
                    upper.push({
                        level: node.level,
                        key: node.key,
                        startKey: node.startKey,
                        endKey: node.endKey,
                        startLabel: node.startLabel,
                        endLabel: node.endLabel,
                        childKeys: node.childKeys.slice(),
                        text: null,
                        t: 0,
                    });
                }
            }
        } else {
            for (const node of plan) {
                upper.push({
                    level: node.level,
                    key: node.key,
                    startKey: node.startKey,
                    endKey: node.endKey,
                    startLabel: node.startLabel,
                    endLabel: node.endLabel,
                    childKeys: node.childKeys.slice(),
                    text: null,
                    t: 0,
                });
            }
        }
        return { fanin: getFanin(), days, upper };
    }

    function getMissingCount() {
        const cov = getCoverage();
        let n = 0;
        for (const d of cov.days) if (!d.text) n++;
        // 上层缺失只计子齐备的（子不齐时生成也无意义，与 collectLevelTargets 口径一致）
        const readyL1 = new Set(cov.days.filter((d) => d.text).map((d) => d.dayKey));
        const readyUpper = new Set(cov.upper.filter((u) => u.text).map((u) => u.key));
        for (const u of cov.upper) {
            if (u.text) continue;
            const ready = (u.childKeys || []).every((ck) => (ck[0] === 'L' ? readyUpper.has(ck) : readyL1.has(ck)));
            if (ready) n++;
        }
        return n;
    }

    // ------------------------------------------------------------------
    // LLM 调用
    // ------------------------------------------------------------------

    // 从 LLM 原始返回文本中提取正文（兼容 markdown code fence 包裹）
    function extractText(raw) {
        if (typeof raw !== 'string' || raw.trim() === '') {
            console.error('[Chat History Optimization] 分层摘要 API 响应结构异常:', raw);
            throw new Error('API 响应结构异常');
        }
        let text = raw.trim();
        const fence = text.match(/```(?:[a-zA-Z]*\n)?([\s\S]*?)```/);
        if (fence) text = fence[1].trim();
        if (text === '') throw new Error('API 响应内容为空');
        return text;
    }

    // 通过 SillyTavern connection profile 调用（API Key 由服务端按 secret_id 解密，不经过浏览器）。
    // 超时双保险：传 AbortSignal 给 sendRequest，并与超时 promise 竞态——
    // 即使服务端实现忽略 signal，本次调用也必定在 timeoutMs 内结算（成功/失败/超时三选一，
    // 永不 hang 住堵死批次）；超时的孤儿请求结果会被丢弃，不会写回。
    async function callLlmViaProfile(content, profileId) {
        const service = NS.bridge.connectionManagerRequest;
        if (!service || typeof service.sendRequest !== 'function') throw new Error('Connection Manager 服务不可用');
        const extra = parseExtraParams();
        const timeoutMs = getRequestTimeoutMs();
        const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        let timer = null;
        const timeoutP = new Promise((_, reject) => {
            timer = setTimeout(() => {
                try { if (controller) controller.abort(); } catch (_) { /* ignore */ }
                reject(new Error(timeoutMessage('Connection profile ', timeoutMs)));
            }, timeoutMs);
        });
        let result;
        try {
            result = await Promise.race([
                service.sendRequest(
                    profileId,
                    [{ role: 'user', content }],
                    getMaxTokens(),
                    { stream: false, signal: controller ? controller.signal : null, extractData: true, includePreset: false, includeInstruct: false, instructSettings: {} },
                    // temperature 设置项优先于附加参数里的同名字段（保持现有行为）
                    Object.assign({}, extra, { temperature: getTemperature() }),
                ),
                timeoutP,
            ]);
        } catch (e) {
            if (e && typeof e.message === 'string' && e.message.indexOf('请求超时') !== -1) {
                console.error('[Chat History Optimization] 分层摘要 connection profile 请求超时:', e);
                throw e;
            }
            if (isAbortError(e) || (controller && controller.signal.aborted)) {
                console.error('[Chat History Optimization] 分层摘要 connection profile 请求超时（abort）:', e);
                throw new Error(timeoutMessage('Connection profile ', timeoutMs));
            }
            console.error('[Chat History Optimization] 分层摘要 connection profile 请求失败:', e);
            const cause = e && e.cause ? e.cause : null;
            throw new Error(`Connection profile 请求失败${cause && cause.message ? `：${cause.message}` : ''}`);
        } finally {
            if (timer !== null) clearTimeout(timer);
        }
        // extractData=true 时 sendRequest 返回 ExtractedData { content, reasoning }
        const raw = result && typeof result === 'object'
            ? (typeof result.content === 'string' ? result.content : null)
            : (typeof result === 'string' ? result : null);
        if (raw === null) {
            console.error('[Chat History Optimization] 分层摘要 profile 响应中未提取到 content，当前 LLM 完整回复:', result);
        }
        return extractText(raw);
    }

    async function callLlm(content) {
        const source = String(Settings.get('subSummarySource') || 'fetch');
        if (source === 'profile') {
            const profileId = String(Settings.get('subSummaryProfileId') || '');
            if (!profileId) throw new Error('未选择 connection profile');
            return callLlmViaProfile(content, profileId);
        }
        const baseUrl = String(Settings.get('subSummaryBaseUrl') || '').trim().replace(/\/+$/, '');
        let url = baseUrl || null;
        if (url && !/\/chat\/completions$/.test(url)) url += '/chat/completions';
        if (!url) throw new Error('API baseUrl 未配置');
        const apiKey = String(Settings.get('subSummaryApiKey') || '').trim();
        const model = String(Settings.get('subSummaryModel') || '').trim();

        // 超时覆盖"建连 + 等首包 + 读 body"全程：timer 在 body 读完（raw 提取）前一直有效，
        // abort 会中断进行中的 body 读取；无 AbortController 的老环境退化为竞态（不断连但保证结算）。
        const timeoutMs = getRequestTimeoutMs();
        const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        const fetchOptions = {
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
        };
        if (controller) fetchOptions.signal = controller.signal;
        let timer = null;
        let timedOut = false;
        const timeoutP = new Promise((_, reject) => {
            timer = setTimeout(() => {
                timedOut = true;
                try { if (controller) controller.abort(); } catch (_) { /* ignore */ }
                reject(new Error(timeoutMessage('API ', timeoutMs)));
            }, timeoutMs);
        });
        // controller 路径不 race timeoutP（靠 abort 中断），挂一个空 catch 避免其 reject 时报 unhandled rejection；
        // 无 controller 的老环境才 race（不断连但保证结算）。
        timeoutP.catch(() => {});
        // 注意：必须始终 race——若底层 fetch 实现忽略 signal（如某些后端/代理），
        // abort 中断不了请求，只能靠竞态保证本次调用必定结算（孤儿请求结果被丢弃）。
        // race 已订阅双方，后续结算不会报 unhandled rejection。
        const doFetch = async () => {
            let response;
            try {
                response = await fetch(url, fetchOptions);
            } catch (e) {
                if (timedOut || isAbortError(e) || (controller && controller.signal.aborted)) {
                    throw new Error(timeoutMessage('API ', timeoutMs));
                }
                console.error('[Chat History Optimization] 分层摘要 API 请求失败（网络/CORS 错误）:', e);
                throw new Error('API 请求失败（网络/CORS 错误）');
            }

            if (!response.ok) {
                const text = await response.text().catch(() => '');
                console.error(`[Chat History Optimization] 分层摘要 API 返回 ${response.status}:`, text);
                throw new Error(`API 返回 ${response.status}`);
            }

            let data;
            try {
                data = await response.json();
            } catch (e) {
                if (timedOut || isAbortError(e) || (controller && controller.signal.aborted)) {
                    throw new Error(timeoutMessage('API ', timeoutMs));
                }
                console.error('[Chat History Optimization] 分层摘要 API 响应不是 JSON:', e);
                throw new Error('API 响应不是 JSON');
            }

            const raw = data && data.choices && data.choices[0] && data.choices[0].message
                ? data.choices[0].message.content
                : null;
            if (raw === null) {
                console.error('[Chat History Optimization] 分层摘要 API 响应中未提取到 message.content，当前 LLM 完整回复:', data);
            }
            return extractText(raw);
        };

        try {
            return await Promise.race([doFetch(), timeoutP]);
        } catch (e) {
            if (e && typeof e.message === 'string' && e.message.indexOf('请求超时') !== -1) {
                console.error('[Chat History Optimization] 分层摘要 API 请求超时:', e);
            }
            throw e;
        } finally {
            if (timer !== null) clearTimeout(timer);
        }
    }

    // ------------------------------------------------------------------
    // 生成核心
    // ------------------------------------------------------------------

    function buildDayInput(day) {
        const EngineRef = NS.Engine;
        const lines = day.entries.map((e) => {
            const doc = (EngineRef && typeof EngineRef.entryToDocText === 'function')
                ? EngineRef.entryToDocText(e) : String(e.历程 || '');
            return doc;
        });
        return lines.join('\n');
    }

    // 单节点生成。返回 'ok'（已生成）或 'skip'（已有效且非 force）。失败时抛错。
    async function runOne(target, force) {
        if (!isConfigured()) {
            throw fatal('请先在"分层摘要"选项卡选择 connection profile 或配置直连的 baseUrl、apiKey 和模型');
        }
        if (target.kind === 'L1') {
            const groups = getDayGroups();
            const day = groups.find((g) => g.dayKey === target.dayKey);
            if (!day) throw new Error(`当天历程不存在：${target.dayKey}`);
            const hash = dayChildHash(day);
            if (!force) {
                const store = loadStore();
                const slot = store && store.l1[target.dayKey];
                if (slot && slot.h === hash && typeof slot.text === 'string' && slot.text.trim() !== '') {
                    return 'skip';
                }
            }
            const template = Settings.get('hierDayPrompt');
            if (!validateDayTemplate(template)) {
                throw fatal(`天摘要模板无效（需非空且包含 ${DAY_PLACEHOLDER}）`);
            }
            // 占位符替换为当天历程文本；split/join 避免 $ 模式被 replace 解释
            const content = String(template).split(DAY_PLACEHOLDER).join(buildDayInput(day));
            const text = await callLlm(content);
            const store = loadStore() || freshStore();
            store.l1[target.dayKey] = { text, h: hash, t: Date.now() };
            saveStore(store);
            return 'ok';
        }
        // 上层节点：子文本必须齐备（缺失则抛错，由收集阶段保证不入队）
        const cov = getCoverage();
        const validL1 = new Map(cov.days.filter((d) => d.text).map((d) => [d.dayKey, { text: d.text }]));
        const validUpper = new Map(cov.upper.filter((u) => u.text).map((u) => [u.key, { text: u.text }]));
        const node = (cov.upper.find((u) => u.key === target.key)
            || planUpperTree(cov.days.map((d) => d.dayKey)).find((n) => n.key === target.key));
        if (!node || !node.childKeys) throw new Error(`上层节点不存在：${target.key}`);
        const childTexts = [];
        for (const ck of node.childKeys) {
            const c = ck[0] === 'L' ? validUpper.get(ck) : validL1.get(ck);
            if (!c) throw new Error(`子节点缺失，跳过：${target.key}`);
            childTexts.push(c.text);
        }
        const hash = fnv1a32(childTexts.join('\n---\n'));
        if (!force) {
            const store = loadStore();
            const slot = store && store.upper[target.key];
            if (slot && slot.h === hash && typeof slot.text === 'string' && slot.text.trim() !== '') {
                return 'skip';
            }
        }
        const template = Settings.get('hierMergePrompt');
        if (!validateMergeTemplate(template)) {
            throw fatal(`合并摘要模板无效（需非空且包含 ${MERGE_PLACEHOLDER}）`);
        }
        const labeled = childTexts.map((t, i) => `【子摘要${i + 1}】\n${t}`).join('\n\n');
        const content = String(template).split(MERGE_PLACEHOLDER).join(labeled);
        const text = await callLlm(content);
        const store = loadStore() || freshStore();
        store.upper[target.key] = { text, h: hash, t: Date.now() };
        saveStore(store);
        return 'ok';
    }

    // 带重试的 runOne：失败（含单次请求超时）等待 Constants.RETRY_DELAY_MS 后重试，
    // 最多 Constants.MAX_RETRIES 次，全部失败则抛出最后错误。
    async function runOneWithRetry(target, force) {
        let lastErr = null;
        for (let attempt = 0; attempt <= Constants.MAX_RETRIES; attempt++) {
            try {
                return await runOne(target, force);
            } catch (e) {
                lastErr = e;
                if (e && e.noRetry) break;
                if (attempt < Constants.MAX_RETRIES) {
                    console.warn(`[Chat History Optimization] 分层摘要生成失败，${Constants.RETRY_DELAY_MS}ms 后重试（第 ${attempt + 1}/${Constants.MAX_RETRIES} 次）:`, e);
                    await new Promise(r => setTimeout(r, Constants.RETRY_DELAY_MS));
                }
            }
        }
        throw lastErr;
    }

    function targetLabel(target) {
        if (target.kind === 'L1') return `${dayLabel(target.dayKey)}天摘要`;
        return `${target.key}合并摘要`;
    }

    // 同层级内 worker 池并行执行一批目标，统一维护状态总线。
    // 进度通知按 Constants.SUBSUMMARY_STATUS_NOTIFY_INTERVAL_MS 做 trailing 节流。
    // 成功生成的通知附带 lastDone={dayKey, level, key}，UI 据此增量更新。
    async function executeLevel(targets, force, counter) {
        const total = targets.length;
        if (total === 0) return;
        let done = counter.done;
        let failed = counter.failed;
        const interval = Constants.SUBSUMMARY_STATUS_NOTIFY_INTERVAL_MS;
        let lastNotifyAt = counter.lastNotifyAt || 0;
        let throttleTimer = null;
        let pendingPatch = null;
        const emitStatus = (patch) => {
            pendingPatch = Object.assign({}, pendingPatch, patch);
            const now = Date.now();
            if (now - lastNotifyAt >= interval) {
                lastNotifyAt = now;
                const flush = pendingPatch;
                pendingPatch = null;
                notifyStatus(flush);
            } else if (throttleTimer === null) {
                throttleTimer = setTimeout(() => {
                    throttleTimer = null;
                    lastNotifyAt = Date.now();
                    const flush = pendingPatch;
                    pendingPatch = null;
                    if (flush) notifyStatus(flush);
                }, interval - (now - lastNotifyAt));
            }
        };
        try {
            const concurrency = Math.min(getConcurrency(), total);
            let next = 0;
            async function worker() {
                while (true) {
                    const k = next++;
                    if (k >= total) return;
                    const target = targets[k];
                    emitStatus({ running: true, current: `第${counter.seq + k + 1}个 · ${targetLabel(target)}`, done, failed, error: null, lastDone: null });
                    try {
                        const result = await runOneWithRetry(target, force);
                        if (result === 'ok') {
                            done++;
                            emitStatus({
                                done,
                                lastDone: target.kind === 'L1'
                                    ? { dayKey: target.dayKey, level: 1, key: target.dayKey }
                                    : { dayKey: null, level: target.level, key: target.key },
                            });
                        }
                    } catch (e) {
                        failed++;
                        counter.lastError = String((e && e.message) || e);
                        emitStatus({ failed, lastDone: null });
                        console.error(`[Chat History Optimization] ${targetLabel(target)}生成失败:`, e);
                    }
                }
            }
            const workers = [];
            for (let w = 0; w < concurrency; w++) workers.push(worker());
            await Promise.all(workers);
        } finally {
            if (throttleTimer !== null) {
                clearTimeout(throttleTimer);
                throttleTimer = null;
            }
            pendingPatch = null;
            counter.done = done;
            counter.failed = failed;
            counter.seq += total;
            counter.lastNotifyAt = lastNotifyAt;
        }
    }

    // 收集指定层级的缺失/脏节点：上层节点只在子齐备时收集。
    // 调用方按 L1→L2→… 逐层收集执行（每层执行后重算快照），保证父输入依赖子文本。
    function collectLevelTargets(level, force) {
        const cov = getCoverage();
        if (level === 1) {
            const out = [];
            for (const d of cov.days) {
                if (force || !d.text) out.push({ kind: 'L1', dayKey: d.dayKey });
            }
            return out;
        }
        const readyL1 = new Set(cov.days.filter((d) => d.text).map((d) => d.dayKey));
        const readyUpper = new Set(cov.upper.filter((u) => u.text).map((u) => u.key));
        const plan = planUpperTree(cov.days.map((d) => d.dayKey));
        const upperByKey = new Map(cov.upper.map((u) => [u.key, u]));
        const out = [];
        for (const node of plan) {
            if (node.level !== level) continue;
            const childrenReady = node.childKeys.every((ck) => (ck[0] === 'L' ? readyUpper.has(ck) : readyL1.has(ck)));
            if (!childrenReady) continue;
            const slot = upperByKey.get(node.key);
            if (force || !slot || !slot.text) {
                out.push({ kind: 'L' + level, level, key: node.key });
            }
        }
        return out;
    }

    // 后台补齐入口：经 batchChain 串行；按层顺序逐层收集执行。
    function ensureMissing(force) {
        const run = async () => {
            running = true;
            notifyStatus({ running: true, current: '', done: 0, failed: 0, error: null, message: null, lastDone: null });
            const counter = { done: 0, failed: 0, seq: 0, lastNotifyAt: 0, lastError: null };
            try {
                const maxLevels = getMaxLevels();
                for (let level = 1; level <= maxLevels; level++) {
                    const targets = collectLevelTargets(level, force);
                    if (targets.length > 0) {
                        await executeLevel(targets, force, counter);
                    }
                }
                // 批次结束清孤儿（规划随天数变化，旧 span 不删即永久堆积 + 切回旧天数时幽灵出现）
                try {
                    pruneStore();
                } catch (e) {
                    console.error('[Chat History Optimization] 清理孤儿摘要失败', e);
                }
                if (counter.done > 0 && typeof NS.bridge.saveMetadataDebounced === 'function') NS.bridge.saveMetadataDebounced();
            } finally {
                running = false;
                notifyStatus({
                    running: false,
                    current: '',
                    done: counter.done,
                    failed: counter.failed,
                    error: counter.failed > 0 ? `失败 ${counter.failed} 个${counter.lastError ? '：' + counter.lastError : ''}` : null,
                    message: (counter.failed === 0 && counter.done === 0) ? '摘要均已有效，无需生成' : null,
                    lastDone: null,
                });
            }
            return { done: counter.done, failed: counter.failed, total: counter.seq };
        };
        const p = batchChain.then(run, run);
        batchChain = p.catch(() => {});
        return p;
    }

    function generateMissing() {
        if (running) {
            console.warn('[Chat History Optimization] 分层摘要生成进行中，忽略本次请求');
            return false;
        }
        return ensureMissing(false).catch((e) => {
            console.error('[Chat History Optimization] 分层摘要补齐失败:', e);
            return { done: 0, failed: 0, total: 0 };
        });
    }

    function forceRebuild() {
        if (running) {
            console.warn('[Chat History Optimization] 分层摘要生成进行中，忽略本次请求');
            return false;
        }
        const meta = getMetadata();
        if (meta && meta[HIER_METADATA_KEY]) {
            delete meta[HIER_METADATA_KEY];
            if (typeof NS.bridge.saveMetadataDebounced === 'function') NS.bridge.saveMetadataDebounced();
        }
        return ensureMissing(true).catch((e) => {
            console.error('[Chat History Optimization] 分层摘要重建失败:', e);
            return { done: 0, failed: 0, total: 0 };
        });
    }

    // 单天生成/重新生成（故事 tab 按天按钮用）
    function generateForDay(dayKey, options = {}) {
        if (running) {
            console.warn('[Chat History Optimization] 分层摘要生成进行中，忽略本次请求');
            return false;
        }
        const force = Boolean(options && options.force);
        const run = async () => {
            running = true;
            notifyStatus({ running: true, current: `${dayLabel(dayKey)}天摘要`, done: 0, failed: 0, error: null, message: null, lastDone: null });
            let done = 0;
            let failed = 0;
            let error = null;
            try {
                const result = await runOneWithRetry({ kind: 'L1', dayKey }, force);
                if (result === 'ok') done = 1;
                else if (result === 'skip') error = null;
            } catch (e) {
                failed = 1;
                error = String((e && e.message) || e);
                console.error(`[Chat History Optimization] ${dayLabel(dayKey)}天摘要生成失败:`, e);
            } finally {
                running = false;
                notifyStatus({
                    running: false,
                    current: '',
                    done,
                    failed,
                    error,
                    message: (failed === 0 && done === 0) ? '该天摘要已有效，无需生成' : null,
                    lastDone: done === 1 ? { dayKey, level: 1, key: dayKey } : null,
                });
            }
            return failed === 0;
        };
        const p = batchChain.then(run, run);
        batchChain = p.catch(() => {});
        return p.catch(() => false);
    }

    // 擦除全部层级摘要（不影响故事历程原文与开关）
    function eraseAll() {
        if (running) {
            notifyStatus({ running: false, current: '', done: 0, failed: 0, error: '生成进行中，请稍后再擦除', message: null, lastDone: null });
            return 0;
        }
        const meta = getMetadata();
        let erased = 0;
        if (meta && meta[HIER_METADATA_KEY]) {
            const store = meta[HIER_METADATA_KEY];
            erased = Object.keys(store.l1 || {}).length + Object.keys(store.upper || {}).length;
            delete meta[HIER_METADATA_KEY];
            if (typeof NS.bridge.saveMetadataDebounced === 'function') NS.bridge.saveMetadataDebounced();
        }
        notifyStatus({
            running: false,
            current: '',
            done: 0,
            failed: 0,
            error: null,
            message: erased > 0 ? `已擦除 ${erased} 条层级摘要` : '没有可擦除的层级摘要',
            lastDone: null,
        });
        return erased;
    }

    // ------------------------------------------------------------------
    // 自动触发：AI 回复生成结束后，后台补齐缺失摘要（不阻塞发送）
    // ------------------------------------------------------------------

    function onGenerationEnded() {
        if (running) return;
        if (!Settings.get('subSummaryToggle')) return;
        if (!isConfigured()) return;
        ensureMissing(false).catch((e) => {
            console.error('[Chat History Optimization] 自动生成分层摘要失败:', e);
        });
    }

    function init() {
        if (initialized) return;
        initialized = true;
        eventSource.on(eventTypes.GENERATION_ENDED, onGenerationEnded);
    }

    NS.SubSummary = Object.freeze({
        HIER_METADATA_KEY,
        DAY_PLACEHOLDER,
        MERGE_PLACEHOLDER,
        textHash: fnv1a32,
        isConfigured,
        getProfileOptions,
        getFanin,
        validateDayTemplate,
        validateMergeTemplate,
        validateExtraParams,
        parseExtraParams,
        getDayGroups,
        getCoverage,
        getMissingCount,
        generateMissing,
        generateForDay,
        forceRebuild,
        eraseAll,
        onStatus,
        getStatus,
        init,
    });

    init();
})();

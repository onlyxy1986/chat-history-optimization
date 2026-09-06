// ============================================================================
// chat-optimization-v2 二级摘要生成器。
// 纯逻辑：不访问 DOM。UI 更新走状态事件总线（onStatus/getStatus）。
// 摘要持久化在楼层消息 item.extra["chat-optimization-v2"]，
// 以楼层级 FNV-1a 哈希校验 故事历程 数组是否变化，失效即清空。
// ============================================================================
(function () {
    'use strict';

    const NS = window.ChatOptimizationV2 = window.ChatOptimizationV2 || {};
    const { saveChatDebounced, eventSource, eventTypes } = NS.bridge;
    const Settings = NS.Settings;
    const Engine = NS.Engine;

    const Constants = NS.Constants;
    const EXTRA_KEY = 'chat-optimization-v2';
    const PLACEHOLDER = '{{故事历程}}';

    // lastDone：最近一次成功生成/擦除影响的 {floor, index}，供 UI 做单条目增量刷新
    let lastStatus = { running: false, current: '', done: 0, failed: 0, error: null, message: null, lastDone: null };
    const statusListeners = new Set();
    let running = false;
    let initialized = false;
    // 所有批次（自动触发 / 发送前补生成）经此链串行，批次之间不并行；
    // 批次内部多条目经 worker 池并行（并发数见 getConcurrency）
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

    // storyHash 缓存：楼层解析缓存命中时 故事历程 数组引用不变，
    // 直接复用哈希，避免逐条目重复 JSON.stringify 全数组 + FNV 哈希
    // （故事历程 tab 每次重绘都逐条目取摘要，无此缓存时成本随条目数放大）
    const storyHashCache = new Map();

    function getStoryHash(item, journey) {
        let slot = storyHashCache.get(item);
        if (slot && slot.journey === journey) return slot.hash;
        const hash = fnv1a32(JSON.stringify(journey));
        if (storyHashCache.size >= Constants.STORY_PARSE_CACHE_MAX) storyHashCache.clear();
        storyHashCache.set(item, { journey, hash });
        return hash;
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

    function getConnectionManagerProfiles() {
        const extensionSettings = NS.bridge.extensionSettings;
        if (!extensionSettings) return [];
        if (Array.isArray(extensionSettings.disabledExtensions) && extensionSettings.disabledExtensions.includes('connection-manager')) return [];
        const manager = extensionSettings.connectionManager;
        if (!manager || !Array.isArray(manager.profiles)) return [];
        return manager.profiles;
    }

    // 可用于二级摘要的 connection profile（仅 CC 类型且 url/model 齐全；
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

    function validateTemplate(text) {
        return typeof text === 'string' && text.trim() !== '' && text.indexOf(PLACEHOLDER) !== -1;
    }

    // ------------------------------------------------------------------
    // 召回特化摘要 schema：{actor:[], location:[], event:'', recall_when:[]}
    // ------------------------------------------------------------------

    function toStringArray(value) {
        let arr = value;
        if (typeof value === 'string') arr = [value];
        if (!Array.isArray(arr)) return [];
        const seen = new Set();
        const out = [];
        for (const v of arr) {
            if (typeof v !== 'string') continue;
            const t = v.trim();
            if (t !== '' && !seen.has(t)) {
                seen.add(t);
                out.push(t);
            }
        }
        return out;
    }

    // 将 LLM 返回对象规范化为召回特化结构；所有字段均为空时返回 null（视为生成失败）
    function normalizeSummary(obj) {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
        const event = typeof obj.event === 'string' ? obj.event.trim() : '';
        const actor = toStringArray(obj.actor);
        const location = toStringArray(obj.location);
        const recall_when = toStringArray(obj.recall_when);
        if (event === '' && actor.length === 0 && location.length === 0 && recall_when.length === 0) return null;
        return { actor, location, event, recall_when };
    }

    // 已存摘要是否含可用召回字段（旧 schema 摘要返回 false，召回时回退 BM25）
    function hasRecallFields(s) {
        if (!s || typeof s !== 'object') return false;
        return (typeof s.event === 'string' && s.event.trim() !== '')
            || (Array.isArray(s.actor) && s.actor.length > 0)
            || (Array.isArray(s.location) && s.location.length > 0)
            || (Array.isArray(s.recall_when) && s.recall_when.length > 0);
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
        const storyHash = getStoryHash(floorData.item, floorData.journey);
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

    // 从 LLM 原始返回文本中提取第一个 {...} JSON 对象（兼容 markdown code fence 包裹）
    function extractJson(raw) {
        if (typeof raw !== 'string' || raw.trim() === '') {
            console.error('[Chat History Optimization] 二级摘要 API 响应结构异常:', raw);
            throw new Error('API 响应结构异常');
        }
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

    // 通过 SillyTavern connection profile 调用（API Key 由服务端按 secret_id 解密，不经过浏览器）。
    // 超时双保险：传 AbortSignal 给 sendRequest，并与超时 promise 竞态——
    // 即使服务端实现忽略 signal，本次调用也必定在 timeoutMs 内结算（成功/失败/超时三选一，
    // 永不 hang 住堵死批次）；超时的孤儿请求结果会被丢弃，不会写回。
    async function callLlmViaProfile(content, profileId) {
        const service = NS.bridge.connectionManagerRequest;
        if (!service || typeof service.sendRequest !== 'function') throw new Error('Connection Manager 服务不可用');
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
                    { temperature: getTemperature() },
                ),
                timeoutP,
            ]);
        } catch (e) {
            if (e && typeof e.message === 'string' && e.message.indexOf('请求超时') !== -1) {
                console.error('[Chat History Optimization] 二级摘要 connection profile 请求超时:', e);
                throw e;
            }
            if (isAbortError(e) || (controller && controller.signal.aborted)) {
                console.error('[Chat History Optimization] 二级摘要 connection profile 请求超时（abort）:', e);
                throw new Error(timeoutMessage('Connection profile ', timeoutMs));
            }
            console.error('[Chat History Optimization] 二级摘要 connection profile 请求失败:', e);
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
            console.error('[Chat History Optimization] 二级摘要 profile 响应中未提取到 content，当前 LLM 完整回复:', result);
        }
        return extractJson(raw);
    }

    async function callLlm(content) {
        const source = String(Settings.get('subSummarySource') || 'fetch');
        if (source === 'profile') {
            const profileId = String(Settings.get('subSummaryProfileId') || '');
            if (!profileId) throw new Error('未选择 connection profile');
            return callLlmViaProfile(content, profileId);
        }
        const url = normalizeBaseUrl(Settings.get('subSummaryBaseUrl'));
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
                if (timedOut || isAbortError(e) || (controller && controller.signal.aborted)) {
                    throw new Error(timeoutMessage('API ', timeoutMs));
                }
                console.error('[Chat History Optimization] 二级摘要 API 响应不是 JSON:', e);
                throw new Error('API 响应不是 JSON');
            }

            const raw = data && data.choices && data.choices[0] && data.choices[0].message
                ? data.choices[0].message.content
                : null;
            if (raw === null) {
                console.error('[Chat History Optimization] 二级摘要 API 响应中未提取到 message.content，当前 LLM 完整回复:', data);
            }
            return extractJson(raw);
        };

        try {
            return await Promise.race([doFetch(), timeoutP]);
        } catch (e) {
            if (e && typeof e.message === 'string' && e.message.indexOf('请求超时') !== -1) {
                console.error('[Chat History Optimization] 二级摘要 API 请求超时:', e);
            }
            throw e;
        } finally {
            if (timer !== null) clearTimeout(timer);
        }
    }

    // ------------------------------------------------------------------
    // 生成核心
    // ------------------------------------------------------------------

    // 单条目生成。返回 'ok'（已生成）或 'skip'（已有效且非 force）。失败时抛错。
    async function runOne(floor, entryIndex, force) {
        if (!isConfigured()) {
            throw new Error('请先在"二级摘要"选项卡选择 connection profile 或配置直连的 baseUrl、apiKey 和模型');
        }
        const floorData = getFloorJourney(floor);
        if (!floorData) throw new Error(`楼层 ${floor} 无有效故事历程`);
        const { item, journey } = floorData;
        const entry = journey[entryIndex];
        if (!entry || typeof entry !== 'object') throw new Error(`楼层 ${floor} 条目 ${entryIndex + 1} 不存在`);

        const storyHash = getStoryHash(item, journey);
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

        const s = normalizeSummary(await callLlm(content));
        if (!s) {
            console.error('[Chat History Optimization] 二级摘要返回内容全部字段为空，视为生成失败');
            throw new Error('二级摘要返回内容全部字段为空');
        }

        // 并行安全写回：LLM 等待期间同楼层其他 worker 可能已写入，
        // 必须以写回时刻的最新 extra 为基合并，不能复用 await 前的 extra 快照，
        // 否则同楼层多条目并行时后写者会覆盖先写者（丢摘要）。
        // 同步合并段内无 await，单线程下是原子的。
        const latest = readFloorExtra(item, storyHash);
        const summaries = (latest && Array.isArray(latest.summaries)) ? latest.summaries : new Array(journey.length).fill(null);
        while (summaries.length < journey.length) summaries.push(null);
        summaries[entryIndex] = { s, t: Date.now() };
        item.extra = item.extra || {};
        item.extra[EXTRA_KEY] = { storyHash, summaries };
        saveChatDebounced();
        return 'ok';
    }

    // 带重试的 runOne：失败（含单次请求超时）等待 Constants.RETRY_DELAY_MS 后重试，
    // 最多 Constants.MAX_RETRIES 次，全部失败则抛出最后错误。
    // 超时计为普通失败：瞬时 hang 重试可能恢复；持续 hang 则最终记 failed，不会卡死批次。
    async function runOneWithRetry(floor, index, force) {
        let lastErr = null;
        for (let attempt = 0; attempt <= Constants.MAX_RETRIES; attempt++) {
            try {
                return await runOne(floor, index, force);
            } catch (e) {
                lastErr = e;
                if (attempt < Constants.MAX_RETRIES) {
                    console.warn(`[Chat History Optimization] 楼层 ${floor} 条目 ${index + 1} 二级摘要生成失败，${Constants.RETRY_DELAY_MS}ms 后重试（第 ${attempt + 1}/${Constants.MAX_RETRIES} 次）:`, e);
                    await new Promise(r => setTimeout(r, Constants.RETRY_DELAY_MS));
                }
            }
        }
        throw lastErr;
    }

    // worker 池并行执行一批 {floor, index} 目标，统一维护状态总线。
    // 并发数 = 设置项 subSummaryConcurrency（clamp 到 1..SUBSUMMARY_CONCURRENCY_MAX，
    // 1 即退化为串行）。LLM 调用是 IO 等待，并行省的是等待时间。
    // 进度通知按 Constants.SUBSUMMARY_STATUS_NOTIFY_INTERVAL_MS 做 trailing 节流：
    // 每条完成都尝试通知，间隔不足时合并进下一次，保证批次最后一条进度不丢失；
    // 批次终态（成功/失败汇总）不受节流、始终立即通知。
    // 成功生成的通知附带 lastDone={floor,index}，UI 据此只原地更新该条目摘要块，
    // 避免大批量时逐条全量重绘。
    async function executeBatch(targets, force) {
        const total = targets.length;
        if (total === 0) {
            notifyStatus({ running: false, current: '', done: 0, failed: 0, error: '没有可生成的故事历程条目', lastDone: null });
            return { done: 0, failed: 0 };
        }
        let done = 0;
        let failed = 0;
        let lastError = null;
        running = true;
        const interval = Constants.SUBSUMMARY_STATUS_NOTIFY_INTERVAL_MS;
        let lastNotifyAt = 0;
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
                    const floor = targets[k].floor;
                    const index = targets[k].index;
                    emitStatus({ running: true, current: `第${k + 1}/${total}条 · 楼层${floor} 条目${index + 1}`, done, failed, error: null, lastDone: null });
                    try {
                        const result = await runOneWithRetry(floor, index, force);
                        if (result === 'ok') {
                            done++;
                            emitStatus({ done, lastDone: { floor, index } });
                        }
                    } catch (e) {
                        failed++;
                        lastError = String((e && e.message) || e);
                        emitStatus({ failed, lastDone: null });
                        console.error(`[Chat History Optimization] 楼层 ${floor} 条目 ${index + 1} 二级摘要生成失败:`, e);
                    }
                }
            }
            const workers = [];
            for (let w = 0; w < concurrency; w++) workers.push(worker());
            await Promise.all(workers);
            if (done > 0) saveChatDebounced();
        } finally {
            running = false;
            if (throttleTimer !== null) {
                clearTimeout(throttleTimer);
                throttleTimer = null;
            }
            pendingPatch = null;
            notifyStatus({
                running: false,
                current: '',
                done,
                failed,
                error: failed > 0 ? `失败 ${failed} 条${lastError ? '：' + lastError : ''}` : null,
                message: (failed === 0 && done === 0) ? '范围内条目均已有有效摘要，无需生成' : null,
                lastDone: null,
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
        notifyStatus({ running: true, current: `楼层${floor} 条目${entryIndex + 1}`, done: 0, failed: 0, error: null, message: null, lastDone: null });
        try {
            const result = await runOneWithRetry(floor, entryIndex, force);
            if (result === 'ok') done = 1;
            else if (result === 'skip') message = '该条目已有有效摘要，无需生成';
        } catch (e) {
            failed = 1;
            error = String((e && e.message) || e);
            console.error(`[Chat History Optimization] 楼层 ${floor} 条目 ${entryIndex + 1} 二级摘要生成失败:`, e);
        } finally {
            running = false;
            notifyStatus({
                running: false,
                current: '',
                done,
                failed,
                error,
                message,
                lastDone: done === 1 ? { floor, index: entryIndex } : null,
            });
        }
        return failed === 0;
    }

    function toFloor(value) {
        if (value === null || value === undefined || value === '') return null;
        const n = Math.floor(Number(value));
        return isNaN(n) ? null : n;
    }

    // onlyMissing 为 true 时只收集缺少有效摘要的条目（进度总数即缺失数）
    function collectRangeTargets(startFloor, endFloor, onlyMissing) {
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
            const cached = onlyMissing ? getFloorSummaries(floor) : null;
            const valid = cached ? cached.valid : false;
            const summaries = cached ? cached.summaries : [];
            for (let i = 0; i < floorData.journey.length; i++) {
                if (onlyMissing) {
                    const existing = valid ? summaries[i] : null;
                    if (existing && typeof existing === 'object' && existing.s !== undefined && existing.s !== null) continue;
                }
                targets.push({ floor, index: i });
            }
        }
        return targets;
    }

    // 收集楼层范围内「无 s 或 s 不含可用召回字段（旧 schema 摘要）」的条目，
    // 这些条目在 Mode A（二级摘要功能开启）召回前必须先补齐生成。
    function collectRecallMissingTargets(startFloor, endFloor) {
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
            const { valid, summaries } = getFloorSummaries(floor);
            for (let i = 0; i < floorData.journey.length; i++) {
                const existing = valid ? summaries[i] : null;
                const s = (existing && typeof existing === 'object') ? existing.s : undefined;
                if (!s || !hasRecallFields(s)) targets.push({ floor, index: i });
            }
        }
        return targets;
    }

    function getRecallMissingCount(startFloor, endFloor) {
        const targets = collectRecallMissingTargets(startFloor, endFloor);
        return targets ? targets.length : 0;
    }

    // 召回补生成入口（Mode A 发送前调用）：经 promise 链串行，
    // 若已有批次进行中则挂在其后，结束后重收集仍未补齐的条目再跑，
    // 消除 onGenerationEnded 原实现在 running 时直接忽略导致的竞态。
    function ensureRecallSummaries(startFloor, endFloor) {
        const run = async () => {
            const targets = collectRecallMissingTargets(startFloor, endFloor);
            if (!targets || targets.length === 0) {
                return { done: 0, failed: 0, total: 0 };
            }
            return executeBatch(targets, false);
        };
        const p = batchChain.then(run, run);
        batchChain = p.catch(() => {});
        return p;
    }

    async function generateForRange(startFloor, endFloor, options = {}) {
        if (running) {
            console.warn('[Chat History Optimization] 二级摘要生成进行中，忽略本次请求');
            return false;
        }
        const force = Boolean(options && options.force);
        const onlyMissing = Boolean(options && options.onlyMissing);
        const targets = collectRangeTargets(startFloor, endFloor, onlyMissing);
        if (targets === null) {
            notifyStatus({ running: false, current: '', done: 0, failed: 0, error: '没有可用的楼层范围', lastDone: null });
            return false;
        }
        if (targets.length === 0 && onlyMissing) {
            notifyStatus({ running: false, current: '', done: 0, failed: 0, error: null, message: '没有缺失的条目，无需生成', lastDone: null });
            return true;
        }
        await executeBatch(targets, force);
        return true;
    }

    // 强制擦除范围内全部楼层的二级摘要（无视哈希有效性），返回擦除的楼层数。
    // 全量擦除（start/end 均为 null/空，即 UI“强制擦除全部”按钮）额外清空所有
    // 二级摘要相关元数据并关闭二级摘要开关（RAG 切到 Mode B / off）：
    //   - 各楼层 extra[EXTRA_KEY]
    //   - 内存摘要哈希缓存 storyHashCache
    //   - RecallCache 内存打分缓存（fragVec/docVec/pairScore）
    //   - Embedder 内存向量缓存
    //   - EmbedStore 持久化向量库（chat_metadata）
    //   - Settings subSummaryToggle → false（停止自动生成与发送前补生成）
    // 范围擦除（传了具体楼层）只清该范围 extra + 哈希缓存，不动开关与向量库
    // （向量库失效条目由 EmbedStore.sync 下次同步时按期望集合自动清理）。
    function eraseForRange(startFloor, endFloor) {
        if (running) {
            notifyStatus({ running: false, current: '', done: 0, failed: 0, error: '生成进行中，请稍后再擦除', message: null, lastDone: null });
            return 0;
        }
        const chat = NS.bridge.getCurrentChat ? NS.bridge.getCurrentChat() : null;
        if (!chat || !Array.isArray(chat)) {
            notifyStatus({ running: false, current: '', done: 0, failed: 0, error: '没有可用的聊天数据', message: null, lastDone: null });
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
        if (erased > 0) saveChatDebounced();
        // 摘要哈希缓存以楼层消息对象为键，extra 删除后缓存的 journey 引用即失效，直接全清
        storyHashCache.clear();
        // 全量擦除：清空其余二级摘要相关元数据并关闭开关（RAG off）
        const isFullErase = toFloor(startFloor) === null && toFloor(endFloor) === null;
        if (isFullErase) {
            try {
                if (NS.RecallCache && typeof NS.RecallCache.clear === 'function') NS.RecallCache.clear();
            } catch (e) {
                console.error('[Chat History Optimization] 清空召回缓存失败:', e);
            }
            try {
                if (NS.Embedder && typeof NS.Embedder.clearCache === 'function') NS.Embedder.clearCache();
            } catch (e) {
                console.error('[Chat History Optimization] 清空嵌入缓存失败:', e);
            }
            try {
                if (NS.EmbedStore && typeof NS.EmbedStore.clear === 'function') NS.EmbedStore.clear();
            } catch (e) {
                console.error('[Chat History Optimization] 清空向量库失败:', e);
            }
            try {
                Settings.set('subSummaryToggle', false);
            } catch (e) {
                console.error('[Chat History Optimization] 关闭二级摘要开关失败:', e);
            }
        }
        // 擦除影响多个楼层，无法用单个 lastDone 表达，置 null 让 UI 全量重绘
        notifyStatus({
            running: false,
            current: '',
            done: 0,
            failed: 0,
            error: null,
            message: isFullErase
                ? '已清空全部二级摘要及相关元数据，并关闭二级摘要开关'
                : (erased > 0 ? `已擦除 ${erased} 个楼层的二级摘要` : '楼层范围内没有可擦除的二级摘要'),
            lastDone: null,
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
        ensureRecallSummaries(lastFloor, lastFloor).catch((e) => {
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
        textHash: fnv1a32,
        isConfigured,
        getProfileOptions,
        validateTemplate,
        hasRecallFields,
        getFloorSummaries,
        getValidSummary,
        generateForEntry,
        generateForRange,
        eraseForRange,
        getRecallMissingCount,
        ensureRecallSummaries,
        onStatus,
        getStatus,
        init,
    });

    init();
})();

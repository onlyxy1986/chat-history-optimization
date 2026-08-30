// ============================================================================
// chat-optimization-v2 二级摘要向量持久化存储。
// 把召回特化摘要 event/recall_when 文本的本地 embedding 持久化到
// chat_metadata["chat-optimization-v2-embed"]（per-chat，saveMetadataDebounced 落盘）。
// 键为文本 FNV-1a 哈希（跨楼层去重、不受楼层下标漂移影响）。
// 进页面 / 收到消息 / 摘要生成批次结束 / 切换聊天 时后台检查完整性：
// 补缺失向量、删除已失效（摘要被擦除或哈希失效清空）的向量。
// 纯逻辑：不访问 DOM。状态经 onStatus 总线广播，UI 订阅渲染。
// ============================================================================
(function () {
    'use strict';

    const NS = window.ChatOptimizationV2 = window.ChatOptimizationV2 || {};
    const { eventSource, eventTypes } = NS.bridge;
    const Settings = NS.Settings;

    const Constants = NS.Constants;
    const METADATA_KEY = 'chat-optimization-v2-embed';

    let lastStatus = { running: false, persisted: 0, added: 0, removed: 0, error: null, message: null };
    const statusListeners = new Set();
    let syncing = false;
    let syncQueued = false;
    let initialized = false;

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
                console.error('[Chat History Optimization] embedding 持久化状态监听器错误', e);
            }
        }
    }

    function onStatus(listener) {
        statusListeners.add(listener);
        return () => statusListeners.delete(listener);
    }

    // ------------------------------------------------------------------
    // 序列化（Float32Array <-> base64）
    // ------------------------------------------------------------------

    function vecToBase64(vec) {
        const bytes = new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
        let bin = '';
        for (let i = 0; i < bytes.length; i += 8192) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
        }
        return btoa(bin);
    }

    function base64ToVec(b64) {
        if (typeof b64 !== 'string' || b64 === '') return null;
        const bin = atob(b64);
        if (bin.length === 0 || bin.length % 4 !== 0) return null;
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Float32Array(bytes.buffer);
    }

    // ------------------------------------------------------------------
    // store 读写
    // ------------------------------------------------------------------

    function getMetadata() {
        const meta = NS.bridge.getChatMetadata ? NS.bridge.getChatMetadata() : null;
        if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
        return meta;
    }

    // 读取当前 store；结构非法或模型不匹配时返回全新空 store（reset=true 表示旧数据作废）。
    // 基准维度判定：优先取 raw.dims（须有向量与之匹配），否则按条数多数派；
    // 维度不符的条目直接丢弃（缺失后由 sync 重新编码补齐）。
    // 历史污染：旧版批量路径曾把整批 flatten 成单条长向量写入（如 7680 = 15×512），
    // 若按"首条定基准"，单条污染条目会导致整库被丢弃、刷新后全量重算。
    function loadStore(meta) {
        const embedder = NS.Embedder;
        const model = embedder ? embedder.model : '';
        const fresh = () => ({ model, dims: 0, v: {} });
        const raw = meta[METADATA_KEY];
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { store: fresh(), reset: true };
        if (!raw.v || typeof raw.v !== 'object' || Array.isArray(raw.v)) return { store: fresh(), reset: true };
        if (model && raw.model && raw.model !== model) return { store: fresh(), reset: true };
        // 逐条校验向量可解码并统计维度分布，损坏条目直接丢弃
        const kept = []; // [hash, slot, dims]
        const dimTally = {};
        for (const hash of Object.keys(raw.v)) {
            const slot = raw.v[hash];
            const vec = slot && typeof slot === 'object' ? base64ToVec(slot.b) : null;
            if (!vec || vec.length === 0) continue;
            dimTally[vec.length] = (dimTally[vec.length] || 0) + 1;
            kept.push([hash, slot, vec.length]);
        }
        let dims = 0;
        if (Number.isInteger(raw.dims) && dimTally[raw.dims]) {
            dims = raw.dims;
        } else {
            for (const d of Object.keys(dimTally)) {
                if (dims === 0 || dimTally[d] > dimTally[dims]) dims = d;
            }
        }
        const clean = {};
        for (const [hash, slot, len] of kept) {
            if (len !== dims) continue;
            clean[hash] = { b: slot.b, t: typeof slot.t === 'number' ? slot.t : 0 };
        }
        return { store: { model, dims, v: clean }, reset: Object.keys(clean).length === 0 && kept.length > 0 };
    }

    function saveStore(store) {
        const meta = getMetadata();
        if (!meta) return false;
        meta[METADATA_KEY] = store;
        if (typeof NS.bridge.saveMetadataDebounced === 'function') NS.bridge.saveMetadataDebounced();
        return true;
    }

    function persistVectors(store, items) {
        let changed = false;
        for (const item of items) {
            const vec = item.vec;
            // 防御：批量路径形状异常（undefined / 整批 flatten 的长向量）不得写入 store，
            // 否则会污染库并让 loadStore 的多数派判定失效
            if (!vec || vec.length === 0) continue;
            if (store.dims > 0 && vec.length !== store.dims) continue;
            store.v[item.hash] = { b: vecToBase64(vec), t: Date.now() };
            store.dims = vec.length;
            changed = true;
        }
        if (changed) saveStore(store);
        return changed;
    }

    // ------------------------------------------------------------------
    // 期望文本集合：全部楼层有效摘要的 event + recall_when（trim 非空）
    // ------------------------------------------------------------------

    function collectExpectedTexts() {
        const SubSummary = NS.SubSummary;
        if (!SubSummary || typeof SubSummary.textHash !== 'function') return null;
        const chat = NS.bridge.getCurrentChat ? NS.bridge.getCurrentChat() : null;
        if (!chat || !Array.isArray(chat)) return null;
        const texts = new Map(); // hash -> text
        for (let i = 0; i < chat.length; i++) {
            const item = chat[i];
            if (!item) continue;
            if (!((("is_user" in item && !item.is_user) || (item.role && item.role === 'assistant')))) continue;
            const { valid, summaries } = SubSummary.getFloorSummaries(i);
            if (!valid) continue;
            for (const slot of summaries) {
                if (!slot || typeof slot !== 'object' || slot.s === undefined || slot.s === null) continue;
                if (!SubSummary.hasRecallFields(slot.s)) continue;
                const s = slot.s;
                const add = (raw) => {
                    const text = String(raw == null ? '' : raw).trim();
                    if (text === '') return;
                    texts.set(SubSummary.textHash(text), text);
                };
                add(s.event);
                if (Array.isArray(s.recall_when)) {
                    for (const r of s.recall_when) add(r);
                }
            }
        }
        return texts;
    }

    // ------------------------------------------------------------------
    // 同步（完整性检查：补缺 + 删失效）
    // ------------------------------------------------------------------

    async function sync() {
        if (syncing) {
            syncQueued = true;
            return;
        }
        if (!Settings.get('subSummaryToggle')) {
            notifyStatus({ running: false, error: null, message: '二级摘要开关未启用，跳过向量同步' });
            return;
        }
        syncing = true;
        notifyStatus({ running: true, error: null, message: '检查向量完整性…' });
        try {
            const texts = collectExpectedTexts();
            if (texts === null) {
                notifyStatus({ running: false, error: null, message: '没有可用的聊天数据或摘要模块' });
                return;
            }
            const embedder = NS.Embedder;
            if (!embedder) {
                notifyStatus({ running: false, error: 'Embedder 模块未加载' });
                return;
            }
            await embedder.init();
            if (!embedder.isReady()) {
                notifyStatus({ running: false, error: 'Embedder 未就绪：' + (embedder.getStatus().message || '未知错误') });
                return;
            }
            const meta = getMetadata();
            if (!meta) {
                notifyStatus({ running: false, error: 'chat_metadata 不可用' });
                return;
            }
            const { store, reset } = loadStore(meta);

            // 缺失：期望文本中无有效向量的
            const missing = [];
            for (const [hash, text] of texts) {
                if (!store.v[hash]) missing.push([hash, text]);
            }
            let added = 0;
            if (missing.length > 0) {
                notifyStatus({ running: true, error: null, message: `补齐 ${missing.length} 条向量…` });
                // 逐批上报进度（大批量 CPU 推理可达数分钟，无进度时状态行看似卡死）
                const vecs = await embedder.encodeBatch(missing.map(m => m[1]), {
                    onProgress: (done, total) => {
                        notifyStatus({ running: true, error: null, message: `补齐向量 ${done}/${total}…` });
                    },
                });
                const items = missing.map(([hash], i) => ({ hash, vec: vecs[i] }));
                persistVectors(store, items);
                added = items.length;
            }

            // 失效：store 中不存在于当前期望集合的哈希
            let removed = 0;
            for (const hash of Object.keys(store.v)) {
                if (!texts.has(hash)) {
                    delete store.v[hash];
                    removed++;
                }
            }
            if (reset || added > 0 || removed > 0) saveStore(store);

            const persisted = Object.keys(store.v).length;
            console.log(`[Chat History Optimization] embedding 持久化同步完成：向量库现有 ${persisted} 条（本次新增 ${added}，清理失效 ${removed}）`);
            notifyStatus({
                running: false,
                persisted,
                added,
                removed,
                error: null,
                message: (added > 0 || removed > 0)
                    ? `向量库现有 ${persisted} 条（本次新增 ${added}，清理失效 ${removed}）`
                    : `向量库现有 ${persisted} 条，无需变更`,
            });
        } catch (e) {
            console.error('[Chat History Optimization] embedding 持久化同步失败:', e);
            notifyStatus({ running: false, error: String((e && e.message) || e) });
        } finally {
            syncing = false;
            if (syncQueued) {
                syncQueued = false;
                setTimeout(() => {
                    sync().catch((e) => console.error('[Chat History Optimization] embedding 持久化同步失败:', e));
                }, 0);
            }
        }
    }

    // ------------------------------------------------------------------
    // 打分路径取向量：优先读持久化 store，缺失现场编码并回写
    // ------------------------------------------------------------------

    async function resolve(texts) {
        const out = new Map(); // text -> Float32Array
        if (!Array.isArray(texts) || texts.length === 0) return out;
        const embedder = NS.Embedder;
        const SubSummary = NS.SubSummary;
        if (!embedder || !SubSummary || !embedder.isReady()) return out;

        let store = null;
        let meta = null;
        try {
            meta = getMetadata();
            if (meta) store = loadStore(meta).store;
        } catch (e) {
            console.error('[Chat History Optimization] embedding 持久化读取失败，降级现场编码:', e);
        }

        const pending = [];
        for (const text of texts) {
            const t = String(text == null ? '' : text).trim();
            if (t === '' || out.has(t)) continue;
            const slot = store ? store.v[SubSummary.textHash(t)] : null;
            const vec = slot ? base64ToVec(slot.b) : null;
            if (vec && vec.length > 0) {
                out.set(t, vec);
            } else {
                pending.push(t);
            }
        }

        if (pending.length > 0) {
            const vecs = await embedder.encodeBatch(pending);
            pending.forEach((t, i) => {
                const vec = vecs[i];
                if (vec && vec.length > 0) out.set(t, vec);
            });
            if (store) {
                try {
                    persistVectors(store, pending.map((t, i) => ({ hash: SubSummary.textHash(t), vec: vecs[i] })));
                } catch (e) {
                    console.error('[Chat History Optimization] embedding 持久化回写失败:', e);
                }
            }
        }
        return out;
    }

    // ------------------------------------------------------------------
    // 触发器
    // ------------------------------------------------------------------

    function safeSync() {
        sync().catch((e) => console.error('[Chat History Optimization] embedding 持久化同步失败:', e));
    }

    function debounce(fn, ms) {
        let timer = null;
        return function (...args) {
            if (timer !== null) clearTimeout(timer);
            timer = setTimeout(() => {
                timer = null;
                fn(...args);
            }, ms);
        };
    }

    const onMessageReceived = debounce(safeSync, Constants.EMBED_SYNC_DEBOUNCE_MS);

    const onSubSummaryStatus = (s) => {
        if (s && s.running === false && s.done > 0) safeSync();
    };

    function init() {
        if (initialized) return;
        initialized = true;
        if (eventSource && eventTypes) {
            if (eventTypes.MESSAGE_RECEIVED) eventSource.on(eventTypes.MESSAGE_RECEIVED, onMessageReceived);
            if (eventTypes.CHAT_CHANGED) eventSource.on(eventTypes.CHAT_CHANGED, safeSync);
        }
        if (NS.SubSummary && typeof NS.SubSummary.onStatus === 'function') {
            NS.SubSummary.onStatus(onSubSummaryStatus);
        }
        setTimeout(safeSync, Constants.EMBED_SYNC_FIRST_DELAY_MS);
    }

    NS.EmbedStore = Object.freeze({
        METADATA_KEY,
        sync,
        resolve,
        getStatus,
        onStatus,
        init,
    });

    init();
})();

// ============================================================================
// chat-optimization-v2 召回打分缓存 + 后台预热。
// 纯逻辑：不访问 DOM。状态经 onFill 总线广播，UI 订阅渲染"补漏"气泡。
//
// 设计：S_event/S_recall 与 S_actor/S_location 的打分在 Mode A（二级摘要开启）
// 下完全由 (片段文本 / 片段二级摘要) × (farEntry 二级摘要) 的片段对决定，
// 因此三个内容寻址 LRU 缓存的命中都是数学上精确、可跨发送复用的：
//   - fragVec   片段 query 指令向量（用户消息 / 窗口条目 event）
//   - docVec    条目二级摘要的 event + recall_when 文档向量
//   - pairScore 单个 (片段, 条目) 对的合成分 fragScore
// 写时以两侧摘要内容哈希（sumHash）校验，摘要重生成/楼层哈希失效即自动换值；
// 模型名不匹配或切换聊天（CHAT_CHANGED）全清。
// ============================================================================
(function () {
    'use strict';

    const NS = window.ChatOptimizationV2 = window.ChatOptimizationV2 || {};
    const { eventSource, eventTypes } = NS.bridge;
    const Settings = NS.Settings;

    const FIRST_WARMUP_DELAY_MS = 1000;
    const MESSAGE_DEBOUNCE_MS = 2000;
    // 预热时最多取最近若干楼层条目的 event 作为"窗口候选"预热其片段向量
    const WARMUP_WINDOW_PREVIEW = 16;
    // 各缓存容量
    const FRAG_VEC_CAP = 4096;
    const DOC_VEC_CAP = 4096;
    const PAIR_SCORE_CAP = 262144;

    // ------------------------------------------------------------------
    // 基础 LRU（Map 访问即刷新，超容量逐出最旧）
    // ------------------------------------------------------------------
    function LRU(cap) {
        this.cap = cap;
        this.m = new Map();
    }
    LRU.prototype.get = function (k) {
        if (!this.m.has(k)) return undefined;
        const v = this.m.get(k);
        this.m.delete(k);
        this.m.set(k, v);
        return v;
    };
    LRU.prototype.set = function (k, v) {
        if (this.m.has(k)) this.m.delete(k);
        this.m.set(k, v);
        if (this.m.size > this.cap) {
            const oldest = this.m.keys().next().value;
            this.m.delete(oldest);
        }
    };
    LRU.prototype.clear = function () { this.m.clear(); };

    const fragVec = new LRU(FRAG_VEC_CAP);
    const docVec = new LRU(DOC_VEC_CAP);
    const pairScore = new LRU(PAIR_SCORE_CAP);

    let currentModel = '';

    function summaryHash(s) {
        if (!s || typeof s !== 'object') return '';
        const Sub = NS.SubSummary;
        const key = JSON.stringify([s.actor || [], s.location || [], s.event || '', s.recall_when || []]);
        return Sub && typeof Sub.textHash === 'function' ? Sub.textHash(key) : String(key.length);
    }

    // ------------------------------------------------------------------
    // 文档侧向量缓存
    // ------------------------------------------------------------------
    function getDocVecs(entryKey, summary) {
        const slot = docVec.get(entryKey);
        if (!slot) return null;
        if (slot.sumHash !== summaryHash(summary)) return null;
        return { eventVec: slot.eventVec, recallVecs: slot.recallVecs };
    }
    function setDocVecs(entryKey, summary, eventVec, recallVecs) {
        if (!entryKey) return;
        docVec.set(entryKey, {
            sumHash: summaryHash(summary),
            eventVec: eventVec || null,
            recallVecs: recallVecs || [],
        });
    }

    // ------------------------------------------------------------------
    // 片段 query 向量缓存
    // ------------------------------------------------------------------
    function getFragVec(text) {
        if (!text) return null;
        const slot = fragVec.get(text);
        if (!slot) return null;
        if (slot.model !== currentModel) return null;
        return slot.vec;
    }
    function setFragVec(text, vec) {
        if (!text) return;
        fragVec.set(text, { model: currentModel, vec });
    }

    // ------------------------------------------------------------------
    // 片段对合成分缓存
    // ------------------------------------------------------------------
    function getPair(fragText, fragSummary, entryKey, entrySummary) {
        const key = (fragText || '') + ' ' + entryKey;
        const slot = pairScore.get(key);
        if (!slot) return null;
        if (slot.fragSumHash !== summaryHash(fragSummary)) return null;
        if (slot.entrySumHash !== summaryHash(entrySummary)) return null;
        return { fragScore: slot.fragScore, parts: slot.parts };
    }
    function setPair(fragText, fragSummary, entryKey, entrySummary, fragScore, parts) {
        const key = (fragText || '') + ' ' + entryKey;
        pairScore.set(key, {
            fragSumHash: summaryHash(fragSummary),
            entrySumHash: summaryHash(entrySummary),
            fragScore,
            parts,
        });
    }

    function clear() {
        fragVec.clear();
        docVec.clear();
        pairScore.clear();
    }

    function setModel(model) {
        if (model && model !== currentModel) {
            clear();
            currentModel = model;
        }
    }

    // ------------------------------------------------------------------
    // "补漏"气泡状态总线（发送前补生成二级摘要时，UI 显示数量气泡）
    // ------------------------------------------------------------------
    const fillListeners = new Set();
    function onFill(listener) {
        fillListeners.add(listener);
        return () => fillListeners.delete(listener);
    }
    function setFilling(count) {
        for (const l of fillListeners) {
            try { l({ filling: true, count: count | 0 }); } catch (e) { console.error('[Chat History Optimization] 补漏气泡监听错误', e); }
        }
    }
    function setFilled() {
        for (const l of fillListeners) {
            try { l({ filling: false, count: 0 }); } catch (e) { console.error('[Chat History Optimization] 补漏气泡监听错误', e); }
        }
    }

    // ------------------------------------------------------------------
    // 后台预热：补全 in-memory 向量缓存，使正式发送路径只需最少现场编码
    // ------------------------------------------------------------------
    let warming = false;
    let warmQueued = false;

    function collectEntryBatches() {
        const chat = NS.bridge.getCurrentChat ? NS.bridge.getCurrentChat() : null;
        if (!chat || !Array.isArray(chat)) return [];
        const Engine = NS.Engine;
        const Sub = NS.SubSummary;
        if (!Sub || !Engine || !Engine.getFloorStoryBlock) return [];
        const out = [];
        for (let i = 1; i < chat.length; i++) {
            const item = chat[i];
            if (!item) continue;
            if (!((("is_user" in item && !item.is_user) || (item.role && item.role === 'assistant')))) continue;
            const historyObj = Engine.getFloorStoryBlock(item);
            if (!historyObj || !Array.isArray(historyObj.故事历程)) continue;
            const journey = historyObj.故事历程;
            const { summaries } = Sub.getFloorSummaries(i);
            for (let j = 0; j < journey.length; j++) {
                const slot = summaries[j];
                if (!slot || typeof slot !== 'object') continue;
                if (slot.s === undefined || slot.s === null) continue;
                if (!Sub.hasRecallFields(slot.s)) continue;
                const entry = journey[j];
                out.push({ entryKey: JSON.stringify(entry), summary: slot.s });
            }
        }
        return out;
    }

    async function warmup() {
        if (warming) { warmQueued = true; return; }
        warming = true;
        try {
            const embedder = NS.Embedder;
            if (!embedder || !embedder.isReady()) return;
            setModel(embedder.model);

            const batches = collectEntryBatches();
            if (batches.length > 0 && NS.EmbedStore && NS.EmbedStore.resolve) {
                const texts = [];
                const plan = batches.map((b) => {
                    const s = b.summary;
                    const t = [];
                    if (s.event && s.event.trim()) t.push(s.event.trim());
                    if (Array.isArray(s.recall_when)) for (const r of s.recall_when) {
                        const x = String(r == null ? '' : r).trim();
                        if (x) t.push(x);
                    }
                    t.forEach((x) => { if (!texts.includes(x)) texts.push(x); });
                    return { b, texts: t };
                });
                const vecMap = await NS.EmbedStore.resolve(texts);
                for (const p of plan) {
                    const b = p.b;
                    const eventVec = (b.summary.event && b.summary.event.trim())
                        ? vecMap.get(b.summary.event.trim()) || null : null;
                    const recallVecs = p.texts.map((x) => vecMap.get(x) || null).filter(Boolean);
                    if (eventVec || recallVecs.length) {
                        const c = getDocVecs(b.entryKey, b.summary);
                        if (!c || c.eventVec !== eventVec) setDocVecs(b.entryKey, b.summary, eventVec, recallVecs);
                    }
                }
            }

            // 片段向量：最新用户消息 + 最近若干楼层条目的 event
            const chat = NS.bridge.getCurrentChat ? NS.bridge.getCurrentChat() : null;
            const fragTexts = [];
            if (chat && chat.length) {
                const last = chat[chat.length - 1];
                if (last && last.mes) fragTexts.push(last.mes);
            }
            for (const b of batches.slice(-WARMUP_WINDOW_PREVIEW)) {
                if (b.summary.event && b.summary.event.trim()) fragTexts.push(b.summary.event.trim());
            }
            const uniq = [...new Set(fragTexts)];
            const toEncodeText = [];
            const toEncode = [];
            for (const t of uniq) {
                if (getFragVec(t)) continue;
                toEncodeText.push(t);
                toEncode.push(embedder.withQueryInstruction(t));
            }
            if (toEncode.length > 0) {
                const vecs = await embedder.encodeBatch(toEncode);
                toEncodeText.forEach((t, i) => setFragVec(t, vecs[i]));
            }
        } catch (e) {
            console.error('[Chat History Optimization] 召回缓存预热失败:', e);
        } finally {
            warming = false;
            if (warmQueued) { warmQueued = false; setTimeout(warmup, 0); }
        }
    }

    function safeWarmup() { warmup().catch((e) => console.error('[Chat History Optimization] 召回缓存预热失败:', e)); }

    function debounce(fn, ms) {
        let timer = null;
        return function () {
            if (timer !== null) clearTimeout(timer);
            timer = setTimeout(() => { timer = null; fn(); }, ms);
        };
    }

    function init() {
        if (eventSource && eventTypes) {
            if (eventTypes.MESSAGE_RECEIVED) eventSource.on(eventTypes.MESSAGE_RECEIVED, debounce(safeWarmup, MESSAGE_DEBOUNCE_MS));
            if (eventTypes.GENERATION_ENDED) eventSource.on(eventTypes.GENERATION_ENDED, safeWarmup);
            if (eventTypes.CHAT_CHANGED) eventSource.on(eventTypes.CHAT_CHANGED, () => { clear(); safeWarmup(); });
        }
        if (NS.Embedder && typeof NS.Embedder.onStatus === 'function') {
            NS.Embedder.onStatus((s) => { if (s && s.state === 'ready') safeWarmup(); });
        }
        setTimeout(safeWarmup, FIRST_WARMUP_DELAY_MS);
    }

    NS.RecallCache = Object.freeze({
        getFragVec,
        setFragVec,
        getDocVecs,
        setDocVecs,
        getPair,
        setPair,
        summaryHash,
        clear,
        setModel,
        onFill,
        setFilling,
        setFilled,
        warmup,
        init,
    });

    init();
})();

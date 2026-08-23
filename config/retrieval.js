// ============================================================================
// chat-optimization-v2 in-browser RAG retriever.
// Loads the bundled @huggingface/transformers (ESM, lib/transformers.min.js)
// and the local bge-small-zh-v1.5 model (lib/models/...). Pure logic: no DOM.
// Status flows through onStatus listeners; the UI subscribes to render it.
// ============================================================================
(function () {
    'use strict';

    const NS = window.ChatOptimizationV2 = window.ChatOptimizationV2 || {};

    const MODEL_REL = 'lib/models/bge-small-zh-v1.5/';
    const TRANSFORMERS_REL = 'lib/transformers.min.js';
    const WASM_MJS_REL = 'lib/ort/ort-wasm-simd-threaded.jsep.mjs';
    const WASM_WASM_REL = 'lib/ort/ort-wasm-simd-threaded.jsep.wasm';
    // BGE 官方推荐的查询指令前缀（文档侧不加）
    const QUERY_INSTRUCTION = '为这个句子生成表示以用于检索相关文章：';
    const CACHE_MAX = 2048;
    const BATCH_SIZE = 16;

    let status = { state: 'idle', message: '' };
    let pipeline = null;
    let transformersModule = null;
    let transformersPromise = null;
    let initPromise = null;
    const cache = new Map();
    const statusListeners = new Set();

    function setStatus(state, message) {
        status = { state: state, message: message || '' };
        const snapshot = getStatus();
        for (const listener of statusListeners) {
            try {
                listener(snapshot);
            } catch (e) {
                console.error('[Chat History Optimization] retriever status listener error', e);
            }
        }
    }

    function getStatus() {
        return { state: status.state, message: status.message };
    }

    function onStatus(listener) {
        statusListeners.add(listener);
        return () => statusListeners.delete(listener);
    }

    function isReady() {
        return status.state === 'ready' && pipeline !== null;
    }

    function loadTransformers() {
        if (!transformersPromise) {
            transformersPromise = import(new URL(TRANSFORMERS_REL, NS.baseUrl).href)
                .then(mod => {
                    transformersModule = mod && mod.default && mod.default.pipeline ? mod.default : mod;
                    return transformersModule;
                });
            transformersPromise.catch(() => {
                transformersPromise = null;
            });
        }
        return transformersPromise;
    }

    /**
     * 加载 transformers.js 与本地 bge-small-zh-v1.5（q8 外部数据格式）。
     * 并发调用共享同一次初始化；失败后允许重试。
     */
    async function init() {
        if (isReady()) return;
        if (initPromise) return initPromise;
        initPromise = (async () => {
            try {
                setStatus('loading', '加载 transformers.js…');
                const tjs = await loadTransformers();
                const { env, pipeline: createPipeline } = tjs;
                env.useBrowserCache = false;
                env.allowLocalModels = true;
                if (env.backends && env.backends.onnx && env.backends.onnx.wasm) {
                    env.backends.onnx.wasm.wasmPaths = {
                        mjs: new URL(WASM_MJS_REL, NS.baseUrl).href,
                        wasm: new URL(WASM_WASM_REL, NS.baseUrl).href,
                    };
                    if (typeof navigator !== 'undefined' && navigator.hardwareConcurrency > 0) {
                        env.backends.onnx.wasm.numThreads = navigator.hardwareConcurrency;
                    }
                }
                setStatus('loading', '加载模型 bge-small-zh-v1.5…');
                pipeline = await createPipeline('feature-extraction', new URL(MODEL_REL, NS.baseUrl).href, {
                    dtype: 'q8',
                });
                setStatus('ready', '');
            } catch (e) {
                initPromise = null;
                pipeline = null;
                console.error('[Chat History Optimization] Retriever init failed', e);
                setStatus('error', e && e.message ? e.message : String(e));
            }
        })();
        return initPromise;
    }

    function cacheSet(key, vec) {
        if (cache.has(key)) cache.delete(key);
        cache.set(key, vec);
        while (cache.size > CACHE_MAX) {
            const oldest = cache.keys().next().value;
            cache.delete(oldest);
        }
    }

    function toVector(output) {
        let data = output;
        if (Array.isArray(data)) data = data[0];
        if (data && data.data) data = data.data;
        return Float32Array.from(data);
    }

    /**
     * 批量编码文本为归一化向量（mean pooling + L2 normalize，BGE 用法）。
     * 命中 LRU 缓存的文本不重复推理。返回与输入同序的向量数组。
     */
    async function encodeBatch(texts) {
        if (!isReady()) throw new Error('Retriever not ready');
        const results = new Array(texts.length);
        const pending = [];
        for (let i = 0; i < texts.length; i++) {
            const text = texts[i];
            if (cache.has(text)) {
                const vec = cache.get(text);
                cache.delete(text);
                cache.set(text, vec);
                results[i] = vec;
            } else {
                pending.push(i);
            }
        }
        for (let i = 0; i < pending.length; i += BATCH_SIZE) {
            const idxs = pending.slice(i, i + BATCH_SIZE);
            const batch = idxs.map(k => texts[k]);
            const outputs = await pipeline(batch.length === 1 ? batch[0] : batch, {
                pooling: 'mean',
                normalize: true,
            });
            idxs.forEach((k, j) => {
                const vec = toVector(Array.isArray(outputs) ? outputs[j] : outputs);
                cacheSet(texts[k], vec);
                results[k] = vec;
            });
        }
        return results;
    }

    async function encodeText(text) {
        const [vec] = await encodeBatch([text]);
        return vec;
    }

    function cosine(a, b) {
        if (!a || !b || a.length === 0 || b.length === 0) return 0;
        const len = Math.min(a.length, b.length);
        let dot = 0, na = 0, nb = 0;
        for (let i = 0; i < len; i++) {
            dot += a[i] * b[i];
            na += a[i] * a[i];
            nb += b[i] * b[i];
        }
        if (na === 0 || nb === 0) return 0;
        return dot / (Math.sqrt(na) * Math.sqrt(nb));
    }

    /**
     * 对 docs 做余弦 topK 检索（BGE 查询指令只加在 query 上）。
     * @param {string} query - 查询文本（通常为最新用户消息）
     * @param {Array<string|{text: string}>} docs - 候选文档
     * @param {number} topK
     * @param {number} minScore
     * @returns {Promise<Array<{index: number, text: string, score: number}>>}
     */
    async function retrieve(query, docs, topK = 6, minScore = 0.3) {
        if (!isReady() || !query || !Array.isArray(docs) || docs.length === 0) return [];
        const docTexts = docs.map(d => (typeof d === 'string' ? d : (d && d.text) || ''))
            .map(t => String(t).trim()).filter(t => t !== '');
        if (docTexts.length === 0) return [];

        const [queryVec] = await encodeBatch([QUERY_INSTRUCTION + query]);
        const docVecs = await encodeBatch(docTexts);

        const results = [];
        for (let i = 0; i < docTexts.length; i++) {
            const score = cosine(queryVec, docVecs[i]);
            if (score >= minScore) results.push({ index: i, text: docTexts[i], score });
        }
        results.sort((a, b) => b.score - a.score);
        return results.slice(0, topK);
    }

    NS.Retriever = Object.freeze({
        init,
        isReady,
        getStatus,
        onStatus,
        encodeText,
        encodeBatch,
        retrieve,
    });
})();

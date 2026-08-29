// ============================================================================
// chat-history-optimization-v2 local embedding provider.
// Loads the bundled @huggingface/transformers (ESM, lib/transformers.min.js)
// and the local bge-small-zh-v1.5 model (lib/models/...). Pure logic: no DOM.
// Status flows through onStatus listeners; the UI subscribes to render it.
// Used by the recall scorer for semantic similarity of 摘要 event/recall_when.
// ============================================================================
(function () {
    'use strict';

    const NS = window.ChatOptimizationV2 = window.ChatOptimizationV2 || {};
    const Constants = NS.Constants;

    const MODEL_DIR_REL = 'lib/models/';
    const MODEL_ID = 'bge-small-zh-v1.5';
    const TRANSFORMERS_REL = 'lib/transformers.min.js';
    const WASM_MJS_REL = 'lib/ort/ort-wasm-simd-threaded.jsep.mjs';
    const WASM_WASM_REL = 'lib/ort/ort-wasm-simd-threaded.jsep.wasm';
    // BGE 官方推荐的查询指令前缀（文档侧不加）
    const QUERY_INSTRUCTION = '为这个句子生成表示以用于检索相关文章：';

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
                console.error('[Chat History Optimization] embedder status listener error', e);
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

    function withQueryInstruction(text) {
        return QUERY_INSTRUCTION + text;
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
                env.allowLocalModels = false;
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
                // v3 不支持把完整 URL 当 model_id：改用 repo 风格 ID，
                // 把 remoteHost 指到本地 lib/models/ 目录，模板直接接 {model}/
                env.remoteHost = new URL(MODEL_DIR_REL, NS.baseUrl).href;
                env.remotePathTemplate = '{model}/';
                pipeline = await createPipeline('feature-extraction', MODEL_ID, {
                    dtype: 'q8',
                });
                setStatus('ready', '');
            } catch (e) {
                initPromise = null;
                pipeline = null;
                console.error('[Chat History Optimization] Embedder init failed', e);
                setStatus('error', e && e.message ? e.message : String(e));
            }
        })();
        return initPromise;
    }

    function cacheSet(key, vec) {
        if (cache.has(key)) cache.delete(key);
        cache.set(key, vec);
        while (cache.size > Constants.CACHE_MAX) {
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
        if (!isReady()) throw new Error('Embedder not ready');
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
        for (let i = 0; i < pending.length; i += Constants.BATCH_SIZE) {
            const idxs = pending.slice(i, i + Constants.BATCH_SIZE);
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

    NS.Embedder = Object.freeze({
        model: MODEL_ID,
        init,
        isReady,
        getStatus,
        onStatus,
        encodeText,
        encodeBatch,
        cosine,
        withQueryInstruction,
    });

    // 模块加载即开始预热模型，首次 RAG 触发时通常已就绪
    init();
})();

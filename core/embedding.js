// ============================================================================
// chat-history-optimization-v2 local embedding provider.
// Loads the bundled @huggingface/transformers (ESM, lib/transformers.min.js)
// and the local bge-small-zh-v1.5 model (lib/models/...). Pure logic: no DOM.
// 推理默认在 WebWorker（core/embed-worker.js）中执行，WASM 负载不占主线程；
// 环境不支持 Worker 时回退主线程推理（逻辑与 v2.10.x 相同）。
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
    const WORKER_REL = 'core/embed-worker.js';
    // BGE 官方推荐的查询指令前缀（文档侧不加）
    const QUERY_INSTRUCTION = '为这个句子生成表示以用于检索相关文章：';

    let status = { state: 'idle', message: '' };
    let initPromise = null;
    // 实际使用的推理后端：'webgpu' | 'wasm'（就绪后可经 getStatus() 查询）
    let backend = null;
    // 主线程回退路径专用
    let pipeline = null;
    let transformersModule = null;
    let transformersPromise = null;
    // WebWorker 路径专用
    let worker = null;
    let workerInitSettler = null;
    const pendingEncode = new Map();
    let encodeSeq = 0;
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
        return { state: status.state, message: status.message, backend: backend };
    }

    function onStatus(listener) {
        statusListeners.add(listener);
        return () => statusListeners.delete(listener);
    }

    // 'ready' 只在初始化完成后（worker 上报或主线程 pipeline 建成）设置
    function isReady() {
        return status.state === 'ready';
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

    // ------------------------------------------------------------------
    // WebWorker 编排
    // ------------------------------------------------------------------

    function handleWorkerMessage(event) {
        const msg = event.data || {};
        if (msg.type === 'status') {
            if (msg.state === 'ready' && workerInitSettler) {
                const s = workerInitSettler;
                workerInitSettler = null;
                backend = msg.backend || 'wasm';
                setStatus('ready', '');
                s.resolve();
            } else if (msg.state === 'error' && workerInitSettler) {
                const s = workerInitSettler;
                workerInitSettler = null;
                s.reject(new Error(msg.message || 'embedding worker 初始化失败'));
            } else if (msg.state === 'loading') {
                setStatus('loading', msg.message || '加载…');
            }
        } else if (msg.type === 'result') {
            const p = pendingEncode.get(msg.id);
            if (p) {
                pendingEncode.delete(msg.id);
                p.resolve(msg.vectors);
            }
        } else if (msg.type === 'encodeError') {
            const p = pendingEncode.get(msg.id);
            if (p) {
                pendingEncode.delete(msg.id);
                p.reject(new Error(msg.message || 'embedding worker 推理失败'));
            }
        }
    }

    function handleWorkerError(event) {
        const message = (event && event.message) ? event.message : 'embedding worker 已崩溃';
        if (workerInitSettler) {
            const s = workerInitSettler;
            workerInitSettler = null;
            s.reject(new Error(message));
        } else {
            setStatus('error', message);
        }
        if (worker) {
            worker.terminate();
            worker = null;
        }
        for (const p of pendingEncode.values()) p.reject(new Error(message));
        pendingEncode.clear();
    }

    function ensureWorker() {
        if (worker) return worker;
        const url = new URL(WORKER_REL, NS.baseUrl);
        url.searchParams.set('v', NS.version || '0');
        const w = new Worker(url.href, { type: 'module' });
        w.onmessage = handleWorkerMessage;
        w.onerror = handleWorkerError;
        worker = w;
        return w;
    }

    function initViaWorker() {
        const w = ensureWorker();
        return new Promise((resolve, reject) => {
            workerInitSettler = { resolve, reject };
            w.postMessage({
                type: 'init',
                transformersUrl: new URL(TRANSFORMERS_REL, NS.baseUrl).href,
                wasmMjs: new URL(WASM_MJS_REL, NS.baseUrl).href,
                wasmWasm: new URL(WASM_WASM_REL, NS.baseUrl).href,
                modelDir: new URL(MODEL_DIR_REL, NS.baseUrl).href,
                modelId: MODEL_ID,
                dtype: 'q8',
                useWebgpu: Constants.EMBED_USE_WEBGPU,
                numThreads: (typeof navigator !== 'undefined' && navigator.hardwareConcurrency > 0)
                    ? navigator.hardwareConcurrency : 0,
            });
        });
    }

    function encodeWorkerBatch(texts) {
        const w = worker;
        if (!w) return Promise.reject(new Error('embedding worker 不可用'));
        const id = ++encodeSeq;
        return new Promise((resolve, reject) => {
            pendingEncode.set(id, { resolve, reject });
            w.postMessage({ type: 'encode', id, texts });
        });
    }

    // ------------------------------------------------------------------
    // 主线程回退路径（Worker 不可用）
    // ------------------------------------------------------------------

    async function initMainThread() {
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
        // v3 不支持把完整 URL 当 model_id：改用 repo 风格 ID，
        // 把 remoteHost 指到本地 lib/models/ 目录，模板直接接 {model}/
        env.remoteHost = new URL(MODEL_DIR_REL, NS.baseUrl).href;
        env.remotePathTemplate = '{model}/';
        // 优先 WebGPU fp32（onnx/model.onnx）：WebGPU EP 不支持 int8 量化 GEMM，
        // q8 模型走 GPU 无加速意义；WebGPU 不可用或会话创建失败时回退 q8/WASM。
        // wasmPaths 始终配置：WebGPU 会话中不支持的算子由 WASM CPU EP 兜底。
        if (Constants.EMBED_USE_WEBGPU) {
            try {
                setStatus('loading', '加载模型 bge-small-zh-v1.5（WebGPU fp32）…');
                pipeline = await createPipeline('feature-extraction', MODEL_ID, {
                    dtype: 'fp32',
                    device: 'webgpu',
                });
                return 'webgpu';
            } catch (e) {
                console.warn('[Chat History Optimization] WebGPU 推理不可用，回退 WASM q8', e);
                pipeline = null;
            }
        }
        setStatus('loading', '加载模型 bge-small-zh-v1.5（WASM q8）…');
        pipeline = await createPipeline('feature-extraction', MODEL_ID, {
            dtype: 'q8',
        });
        return 'wasm';
    }

    function disposeWorker() {
        if (worker) {
            worker.terminate();
            worker = null;
        }
        workerInitSettler = null;
    }

    /**
     * 加载 transformers.js 与本地 bge-small-zh-v1.5（外部数据格式 onnx）。
     * 优先在 WebWorker 中初始化（推理不占主线程）；
     * 环境不支持 Worker 或 worker 初始化失败时回退主线程；
     * 模型加载 WebGPU fp32 优先（EMBED_USE_WEBGPU），失败回退 q8/WASM。
     * 并发调用共享同一次初始化；失败后允许重试。
     */
    async function init() {
        if (isReady()) return;
        if (initPromise) return initPromise;
        initPromise = (async () => {
            try {
                if (typeof Worker !== 'undefined') {
                    setStatus('loading', '启动 embedding worker…');
                    try {
                        await initViaWorker();
                        return;
                    } catch (workerErr) {
                        console.warn('[Chat History Optimization] embedding worker 不可用，回退主线程推理', workerErr);
                        disposeWorker();
                    }
                }
                backend = await initMainThread();
                setStatus('ready', '');
            } catch (e) {
                initPromise = null;
                pipeline = null;
                backend = null;
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

    // feature-extraction 对批量输入返回单个 Tensor（dims [N, D]，mean pooling 后），
    // 按行拆成 N 个独立 Float32Array；非 Tensor 形态走防御性兜底。
    function batchToVectors(output, count) {
        if (output && output.data && Array.isArray(output.dims)) {
            const dims = output.dims;
            const D = dims[dims.length - 1];
            const data = output.data;
            const out = new Array(count);
            for (let i = 0; i < count; i++) {
                out[i] = new Float32Array(data.subarray(i * D, (i + 1) * D));
            }
            return out;
        }
        const list = Array.isArray(output) ? output : [output];
        return list.map((o) => {
            let d = o;
            if (d && d.data) d = d.data;
            return Float32Array.from(d);
        });
    }

    // 单批推理（BATCH_SIZE 内）：worker 路径经 postMessage，主线程路径直接调用 pipeline
    async function inferBatch(batch) {
        if (worker) {
            return encodeWorkerBatch(batch);
        }
        // 始终传数组：保证 tokenizer/model 输出 dims [N, D]，便于按行拆分
        const outputs = await pipeline(batch, {
            pooling: 'mean',
            normalize: true,
        });
        const vecs = batchToVectors(outputs, batch.length);
        if (vecs.length !== batch.length) {
            throw new Error('嵌入推理返回向量数与输入不一致：' + vecs.length + ' ≠ ' + batch.length);
        }
        return vecs;
    }

    /**
     * 批量编码文本为归一化向量（mean pooling + L2 normalize，BGE 用法）。
     * 命中 LRU 缓存的文本不重复推理。返回与输入同序的向量数组。
     * opts.onProgress(done, total)：每完成一批（BATCH_SIZE 条）回调一次，
     * done/total 为实际需推理（缓存未命中）的条数；供调用方刷新进度，避免大批量编码时状态行长时间无更新。
     */
    async function encodeBatch(texts, opts) {
        if (!isReady()) throw new Error('Embedder not ready');
        const onProgress = opts && typeof opts.onProgress === 'function' ? opts.onProgress : null;
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
        const total = pending.length;
        let done = 0;
        for (let i = 0; i < total; i += Constants.BATCH_SIZE) {
            const idxs = pending.slice(i, i + Constants.BATCH_SIZE);
            const batch = idxs.map(k => texts[k]);
            const vecs = await inferBatch(batch);
            idxs.forEach((k, j) => {
                const vec = vecs[j];
                cacheSet(texts[k], vec);
                results[k] = vec;
            });
            done += idxs.length;
            if (onProgress) {
                try {
                    onProgress(done, total);
                } catch (e) {
                    console.error('[Chat History Optimization] encodeBatch 进度回调错误', e);
                }
            }
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

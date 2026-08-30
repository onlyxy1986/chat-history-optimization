// ============================================================================
// chat-optimization-v2 embedding 推理 WebWorker（module worker）。
// 在 worker 线程运行 transformers.js pipeline + ONNX Runtime WASM，
// 把推理负载移出主线程，避免批量编码时阻塞 UI。
// 由 embedding.js 通过 new Worker(..., { type: 'module' }) 加载，
// 不加入 index.js 的 MODULES 数组（不是主线程脚本）。
//
// 协议（postMessage）：
//   main → worker: { type: 'init', transformersUrl, wasmMjs, wasmWasm, modelDir, modelId, dtype, numThreads, useWebgpu }
//   main → worker: { type: 'encode', id: number, texts: string[] }
//   worker → main: { type: 'status', state: 'loading' | 'ready' | 'error', message, backend? }
//                  （ready 附 backend: 'webgpu' | 'wasm'）
//                  { type: 'result', id, vectors: Float32Array[] }（buffer 转移）
//                  { type: 'encodeError', id, message }
// ============================================================================
'use strict';

let pipeline = null;
let initPromise = null;
let backendUsed = null;

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

async function doInit(cfg) {
    const tjs = await import(cfg.transformersUrl);
    const mod = tjs && tjs.default && tjs.default.pipeline ? tjs.default : tjs;
    const { env, pipeline: createPipeline } = mod;
    env.useBrowserCache = false;
    env.allowLocalModels = false;
    if (env.backends && env.backends.onnx && env.backends.onnx.wasm) {
        env.backends.onnx.wasm.wasmPaths = { mjs: cfg.wasmMjs, wasm: cfg.wasmWasm };
        if (typeof cfg.numThreads === 'number' && cfg.numThreads > 0) {
            env.backends.onnx.wasm.numThreads = cfg.numThreads;
        }
    }
    // 与主线程回退路径一致：repo 风格 model_id + 本地目录 remoteHost
    env.remoteHost = cfg.modelDir;
    env.remotePathTemplate = '{model}/';
    // 优先 WebGPU fp32（onnx/model.onnx）：WebGPU EP 不支持 int8 量化 GEMM，
    // q8 模型走 GPU 无加速意义；WebGPU 不可用或会话创建失败时回退 q8/WASM。
    // wasmPaths 始终配置：WebGPU 会话中不支持的算子由 WASM CPU EP 兜底。
    if (cfg.useWebgpu) {
        try {
            self.postMessage({ type: 'status', state: 'loading', message: '加载模型 bge-small-zh-v1.5（WebGPU fp32）…' });
            pipeline = await createPipeline('feature-extraction', cfg.modelId, {
                dtype: 'fp32',
                device: 'webgpu',
            });
            return 'webgpu';
        } catch (e) {
            console.warn('[Chat History Optimization] WebGPU 推理不可用，回退 WASM q8', e);
            pipeline = null;
        }
    }
    self.postMessage({ type: 'status', state: 'loading', message: '加载模型 bge-small-zh-v1.5（WASM q8）…' });
    pipeline = await createPipeline('feature-extraction', cfg.modelId, { dtype: cfg.dtype });
    return 'wasm';
}

self.onmessage = async (event) => {
    const msg = event.data || {};
    if (msg.type === 'init') {
        if (pipeline) {
            self.postMessage({ type: 'status', state: 'ready', message: '', backend: backendUsed });
            return;
        }
        if (!initPromise) {
            initPromise = doInit(msg).then((backend) => {
                backendUsed = backend;
                return backend;
            }).catch((e) => {
                initPromise = null;
                throw e;
            });
        }
        self.postMessage({ type: 'status', state: 'loading', message: '加载 transformers.js…' });
        try {
            const backend = await initPromise;
            self.postMessage({ type: 'status', state: 'ready', message: '', backend });
        } catch (e) {
            self.postMessage({ type: 'status', state: 'error', message: e && e.message ? e.message : String(e) });
        }
        return;
    }
    if (msg.type === 'encode') {
        try {
            if (!pipeline) throw new Error('pipeline 未初始化');
            // 始终传数组：保证 tokenizer/model 输出 dims [N, D]，便于按行拆分
            const outputs = await pipeline(msg.texts, {
                pooling: 'mean',
                normalize: true,
            });
            const vectors = batchToVectors(outputs, msg.texts.length);
            if (vectors.length !== msg.texts.length) {
                throw new Error('嵌入推理返回向量数与输入不一致：' + vectors.length + ' ≠ ' + msg.texts.length);
            }
            const buffers = vectors.map((v) => v.buffer);
            self.postMessage({ type: 'result', id: msg.id, vectors }, buffers);
        } catch (e) {
            self.postMessage({ type: 'encodeError', id: msg.id, message: e && e.message ? e.message : String(e) });
        }
    }
};

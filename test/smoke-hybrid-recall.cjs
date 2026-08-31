// 端到端冒烟测试：模拟浏览器环境与 NS.bridge，验证召回特化摘要混合打分链路
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

global.window = {};
global.navigator = { hardwareConcurrency: 4 };
global.document = { readyState: 'complete', addEventListener() { }, createElement: () => ({ style: {} }), head: { appendChild() { } } };

const chat = [];
let tokenCallCount = 0;
// 最小事件总线 mock：engine.js 依此订阅 MESSAGE_RECEIVED 等消息事件
const eventListeners = {};
function fireEvent(type, ...args) {
    (eventListeners[type] || []).slice().forEach(fn => fn(...args));
}
window.ChatOptimizationV2 = {
    loaded: true,
    version: '2.5.0-test',
    baseUrl: ROOT + '/',
    bridge: {
        extensionSettings: {},
        saveSettingsDebounced: () => { },
        getTokenCountAsync: async (text) => { tokenCallCount++; return Math.ceil(String(text || '').length / 1); },
        getCurrentChat: () => chat,
        saveChatDebounced: () => { },
        eventSource: {
            on: (type, fn) => { (eventListeners[type] = eventListeners[type] || []).push(fn); },
            off: (type, fn) => { eventListeners[type] = (eventListeners[type] || []).filter(f => f !== fn); },
        },
        eventTypes: {
            GENERATION_ENDED: 'GENERATION_ENDED',
            MESSAGE_RECEIVED: 'message_received',
            MESSAGE_EDITED: 'message_edited',
            MESSAGE_UPDATED: 'message_updated',
            MESSAGE_SWIPED: 'message_swiped',
            MESSAGE_DELETED: 'message_deleted',
            CHAT_CHANGED: 'chat_id_changed',
            CHAT_LOADED: 'chatLoaded',
        },
    },
};

function load(rel) {
    const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    // eslint-disable-next-line no-eval
    (0, eval)(code);
}
load('core/constant.js');
load('core/settings.js');
load('core/engine.js');
load('core/subsummary.js');
load('core/retrieval.js');

const NS = window.ChatOptimizationV2;
const Settings = NS.Settings;

// 假 RecallCache（内存、内容寻址去重，用于验证 LRU 跨发送复用）
NS.RecallCache = (function () {
    const fragVec = new Map(), docVec = new Map(), pair = new Map();
    const sh = (s) => NS.SubSummary.textHash(JSON.stringify(s || {}));
    return {
        getFragVec: (t) => (t ? fragVec.get(t) || null : null),
        setFragVec: (t, v) => { if (t) fragVec.set(t, v); },
        getDocVecs: (k, s) => { const sl = docVec.get(k); return sl && sl.h === sh(s) ? { eventVec: sl.e, recallVecs: sl.r } : null; },
        setDocVecs: (k, s, e, r) => { docVec.set(k, { h: sh(s), e, r }); },
        getPair: (ft, fs, k, es) => { const sl = pair.get(ft + ' ' + k); return sl && sl.fh === sh(fs) && sl.eh === sh(es) ? { fragScore: sl.s, parts: sl.p } : null; },
        setPair: (ft, fs, k, es, s, p) => { pair.set(ft + ' ' + k, { fh: sh(fs), eh: sh(es), s, p }); },
        summaryHash: sh,
        clear() { fragVec.clear(); docVec.clear(); pair.clear(); },
        onFill() { return () => {}; }, setFilling() {}, setFilled() {},
    };
})();

// onParseFail 广播间谍（验证解析失败气泡总线只对新失败楼层触发）
const parseFailEvents = [];
NS.Engine.onParseFail((details) => parseFailEvents.push(details));

// Retriever 调用间谍（验证 Mode A 绝不走 BM25）
let retrieveCount = 0;
if (NS.Retriever) {
    const _orig = NS.Retriever.retrieve;
    NS.Retriever.retrieve = async (...a) => { retrieveCount++; return _orig ? _orig(...a) : []; };
}

// ---------------- 假 Embedder（确定性向量：字符 5-bit 散布，真实余弦） ----------------
const DIM = 64;
function fakeVec(text) {
    const v = new Float32Array(DIM);
    const s = String(text || '');
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        v[(c * 31 + i) % DIM] += 1;
        v[(c * 17 + i * 7) % DIM] += 0.5;
    }
    return v;
}
function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < DIM; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
let encodeBatchCount = 0;
function installFakeEmbedder(ready) {
    encodeBatchCount = 0;
    NS.Embedder = {
        isReady: () => ready,
        getStatus: () => ({ state: ready ? 'ready' : 'idle', message: '' }),
        encodeBatch: async (texts) => { encodeBatchCount += texts.length; return texts.map(fakeVec); },
        encodeText: async (t) => fakeVec(t),
        cosine,
        withQueryInstruction: (t) => 'Q:' + t,
    };
}

// ---------------- 构造假聊天 ----------------
function fnv1a32(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; }
    return hash.toString(16).padStart(8, '0');
}
function makeEntry(day, time, loc, process) {
    return { 天数: day, 时间段: time, 地点: loc, 历程: process };
}
function makeFloor(journey, summaries) {
    const mes = '正常回复内容\n<NEW_STORY_DATA>\n<NEW_HISTORY>\n' + JSON.stringify({ 故事历程: journey }) + '\n</NEW_HISTORY>\n</NEW_STORY_DATA>';
    const item = { mes, is_user: false };
    if (journey && summaries) {
        item.extra = { 'chat-optimization-v2': { storyHash: fnv1a32(JSON.stringify(journey)), summaries } };
    }
    return item;
}

// 6 条新 schema 摘要（沈梦瑶 出现在 5/6，是高频主角）+ 1 旧 schema + 1 无摘要
const e1 = makeEntry('第1天', '晚上', '酒馆.二楼.卡座', '沈梦瑶在卡座喝醉，被李昂扶走，两人发生争执。');
const e2 = makeEntry('第1天', '深夜', '酒馆.门口', '王虎拦路索要保护费，李昂与其动手。');
const e3 = makeEntry('第2天', '清晨', '码头', '沈梦瑶在码头等人，见到陈九。');
const e4 = makeEntry('第2天', '中午', '码头.仓库', '陈九交付货物，双方清点完毕。');
const e5 = makeEntry('第3天', '上午', '药铺', '沈梦瑶买药，抓药的是老周。');
const e6 = makeEntry('第3天', '下午', '药铺.后院', '沈梦瑶在后院遇到赵雷，赵雷递来一封信。');
const e7 = makeEntry('第4天', '清晨', '码头', '沈梦瑶在码头见到船夫老孙。');
const e8 = makeEntry('第4天', '中午', '码头.仓库', '船夫老孙搬运货物受伤。');

function buildChat(lastUserMes, allSummaries) {
    chat.length = 0;
    chat.push({ mes: '开场', is_user: true });
    chat.push(makeFloor([e1, e2], [
        { s: { actor: ['沈梦瑶', '李昂'], location: ['酒馆', '二楼', '卡座'], event: '沈梦瑶在酒馆卡座喝醉与李昂争执', recall_when: ['有人提及旧恩怨时', '再次来到酒馆时'] }, t: 1 },
        { s: { actor: ['王虎', '李昂'], location: ['酒馆', '门口'], event: '王虎拦路索费与李昂动手', recall_when: ['有人提到保护费时'] }, t: 1 },
    ]));
    chat.push({ mes: '好', is_user: true });
    chat.push(makeFloor([e3, e4], [
        { s: { actor: ['沈梦瑶', '陈九'], location: ['码头'], event: '沈梦瑶在码头见到陈九', recall_when: ['再次提到码头会面时'] }, t: 1 },
        { s: { actor: ['陈九', '沈梦瑶'], location: ['码头', '仓库'], event: '陈九在仓库交付货物并清点', recall_when: ['有人问起货物下落时'] }, t: 1 },
    ]));
    chat.push({ mes: '嗯', is_user: true });
    chat.push(makeFloor([e5, e6], [
        { s: { actor: ['沈梦瑶'], location: ['药铺'], event: '沈梦瑶在药铺买药', recall_when: ['有人提到旧伤时'] }, t: 1 },
        { s: { actor: ['沈梦瑶', '赵雷'], location: ['药铺', '后院'], event: '沈梦瑶在药铺后院收到赵雷的信', recall_when: ['有人提到那封信时'] }, t: 1 },
    ]));
    chat.push({ mes: '好', is_user: true });
    const e7s = allSummaries
        ? { s: { actor: ['沈梦瑶', '老孙'], location: ['码头'], event: '沈梦瑶在码头见到船夫老孙', recall_when: ['有人提到船夫时'] }, t: 1 }
        : { s: { 摘要: '沈梦瑶码头见船夫', 关键: ['见面'] }, t: 1 };
    const e8s = allSummaries
        ? { s: { actor: ['老孙'], location: ['码头', '仓库'], event: '船夫老孙搬运货物受伤', recall_when: ['有人问起货物时'] }, t: 1 }
        : null;
    chat.push(makeFloor([e7, e8], [e7s, e8s]));
    chat.push({ mes: lastUserMes, is_user: true });
}

function check(name, cond, extra) {
    if (cond) { console.log('PASS', name); }
    else { console.log('FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); process.exitCode = 1; }
}

const realLog = console.log;
function quiet(promise) {
    console.log = () => { };
    return promise.finally(() => { console.log = realLog; });
}

// tokenLimit = 795：假计数器 1 字符/token 下模板/包装开销恒为 695（roleCard 关），
// 795 - 695 = 100 即内容预算，与旧版 tokenLimit=100 的预算行为完全一致
function baseSettings(override) {
    return Object.assign({
        extensionToggle: true, roleCardToggle: false, keepCount: 1,
        tokenLimit: 795, ragRatio: 0.5, subSummaryToggle: false,
    }, override || {});
}

function modeAConfig() {
    return {
        subSummaryToggle: true,
        subSummarySource: 'fetch',
        subSummaryBaseUrl: 'http://x', subSummaryApiKey: 'k', subSummaryModel: 'm',
    };
}

async function runCase(embedderReady, lastUserMes, opts = {}) {
    buildChat(lastUserMes, opts.allSummaries);
    installFakeEmbedder(embedderReady);
    NS.bridge.extensionSettings['chat-optimization-v2'] = baseSettings(opts.settings);
    await globalThis.replaceChatHistoryWithDetailsV2(chat, 4096, null, 0);
    const stats = NS.Engine.getStats();
    return { rag: stats.rag, finalMes: String(chat[0] && chat[0].mes) };
}

// 为某楼层条目生成一个有效召回摘要（用于补生成场景）
function validSummaryFor(entry) {
    return {
        s: {
            actor: (entry.历程 || '').includes('沈梦瑶') ? ['沈梦瑶', '老孙'] : ['老孙'],
            location: entry.地点 ? entry.地点.split('.') : ['码头'],
            event: entry.历程 || '事件',
            recall_when: ['有人提到此事时'],
        }, t: 1,
    };
}

(async () => {
    // 场景 A（Mode B / 二级摘要关闭，保留现状回归）：Embedder 就绪，稀有角色（陈九）触发召回
    const { rag: ragA, finalMes: mesA } = await quiet(runCase(true, '陈九提到了码头仓库的货物'));
    console.log('A rag:', JSON.stringify(ragA, null, 1));
    check('A: chat 被压成 1 条', chat.length === 1);
    check('A: 最后一条消息含前文', mesA.includes('<HISTORY>'));
    check('A: RAG 激活', ragA && ragA.active === true, ragA);
    check('A: 有命中', ragA.hits.length > 0, ragA);
    const topA = ragA.hits.reduce((m, h) => (h.score > m.score ? h : m), ragA.hits[0]);
    check('A: 最优命中是陈九仓库条目', topA && topA.text.includes('陈九交付货物'), topA);
    check('A: 走 summary 通道', topA && topA.parts && topA.parts.source === 'summary', topA);
    check('A: 人物 1/2 且 actorScore=0.67（Dice 2·1/(1+2)，主角不排除）', topA && topA.parts.actor === '1/2' && Math.abs(topA.parts.actorScore - 0.67) < 0.001, topA && topA.parts);
    check('A: 地点 2/2 命中', topA && topA.parts.location === '2/2', topA && topA.parts);
    check('A: 语义分量为单 max 值（parts.semantic ∈ [0,1]，无 event/recall 字段）', topA && typeof topA.parts.semantic === 'number' && topA.parts.semantic >= 0 && topA.parts.semantic <= 1 && !('event' in topA.parts) && !('recall' in topA.parts), topA && topA.parts);
    check('A: 分数在 [0,1]', ragA.hits.every(h => h.score >= 0 && h.score <= 1));
    check('A: farScores 覆盖全部远端条目且命中数与 hits 一致', ragA && Array.isArray(ragA.farScores) && ragA.farScores.length === ragA.farCount && ragA.farScores.filter(r => r.hit).length === ragA.hits.length, ragA && ragA.farScores);
    check('A: 每条 farScores 均有打分明细（无摘要被排除者 score 为 null）', ragA && ragA.farScores.every(r => r.score === null || (r.parts && r.parts.source)), ragA.farScores);
    check('A: 存在未命中远端条目（全量标记而非仅 hits）', ragA && ragA.farScores.some(r => !r.hit), ragA.farScores && ragA.farScores.length);

    // 场景 C（Mode B）：主角不排除 —— 查询只提高频主角（沈梦瑶），主角正常参与 S_actor 打分
    const { rag: ragC } = await quiet(runCase(true, '沈梦瑶又出现了'));
    console.log('C rag:', JSON.stringify(ragC, null, 1));
    const e5Score = ragC.farScores.find(r => r.text && r.text.includes('买药'));
    const e2Score = ragC.farScores.find(r => r.text && r.text.includes('保护费'));
    const e4Score = ragC.farScores.find(r => r.text && r.text.includes('陈九交付货物'));
    check('C: 纯主角条目有打分明细', !!e5Score, ragC.farScores);
    check('C: 纯主角条目 actorScore = 1 且人物 1/1（主角不排除，Dice 2·1/(1+1) 满分）', e5Score && e5Score.score !== null && e5Score.parts.actorScore >= 0.99 && e5Score.parts.actor === '1/1', e5Score && e5Score.parts);
    check('C: actor 不含主角的条目人物分 = 0', e2Score && e2Score.parts.source === 'summary' && e2Score.parts.actorScore === 0 && e2Score.parts.actor === '0/2', e2Score && e2Score.parts);
    check('C: 与稀有角色同条目的主角贡献人物分 > 0（Dice 2·1/(1+2)）', e4Score && e4Score.parts.source === 'summary' && Math.abs(e4Score.parts.actorScore - 0.67) < 0.001, e4Score && e4Score.parts);

    // 场景 B（Mode B）：Embedder 未就绪，全池 BM25 归一化降级
    const { rag: ragB } = await quiet(runCase(false, '陈九提到了码头仓库的货物'));
    console.log('B rag:', JSON.stringify(ragB, null, 1));
    check('B: RAG 激活', ragB && ragB.active === true, ragB);
    check('B: 全部走 bm25 通道', ragB.hits.length > 0 && ragB.hits.every(h => h.parts.source === 'bm25'), ragB.hits);
    check('B: 分数在 [0,1)', ragB.hits.every(h => h.score >= 0 && h.score < 1));

    // 场景 A'（Mode A）：开启二级摘要，全部条目已有有效摘要，逐片段加权 max
    retrieveCount = 0;
    const { rag: ragA2 } = await quiet(runCase(true, '陈九提到了码头仓库的货物', { allSummaries: true, settings: modeAConfig() }));
    console.log('A2 rag:', JSON.stringify(ragA2, null, 1));
    check('A\': RAG 激活', ragA2 && ragA2.active === true, ragA2);
    check('A\': 走 summary 通道（无 BM25）', ragA2.hits.length > 0 && ragA2.hits.every(h => h.parts.source === 'summary'), ragA2.hits);
    check('A\': 绝不调用 Retriever', retrieveCount === 0, retrieveCount);
    check('A\': 有 bestFrag 标记', ragA2.hits.every(h => h.parts && h.parts.bestFrag), ragA2.hits);
    check('A\': farScores 覆盖全部远端条目且每条有 bestFrag', ragA2 && Array.isArray(ragA2.farScores) && ragA2.farScores.length === ragA2.farCount && ragA2.farScores.every(r => r.score === null || (r.parts && r.parts.bestFrag)), ragA2 && ragA2.farScores);
    check('A\': 未命中远端条目同样有明细（score 非 null）', ragA2 && ragA2.farScores.some(r => !r.hit && r.score !== null), ragA2.farScores && ragA2.farScores.length);
    const topA2 = ragA2.hits.reduce((m, h) => (h.score > m.score ? h : m), ragA2.hits[0]);
    check('A\': 最优命中是陈九仓库条目', topA2 && topA2.text.includes('陈九交付货物'), topA2);

    // 场景 D（Mode A + LRU）：第二次相同装配不再编码任何片段向量（跨发送复用缓存）
    NS.RecallCache.clear();
    buildChat('陈九提到了码头仓库的货物', true);
    installFakeEmbedder(true);
    NS.bridge.extensionSettings['chat-optimization-v2'] = baseSettings(modeAConfig());
    await globalThis.replaceChatHistoryWithDetailsV2(chat, 4096, null, 0);
    const firstEncode = encodeBatchCount;
    encodeBatchCount = 0;
    await globalThis.replaceChatHistoryWithDetailsV2(chat, 4096, null, 0); // 同内容第二次
    check('D: 首次发送有编码', firstEncode > 0, firstEncode);
    check('D: 第二次发送 0 次编码（LRU 命中）', encodeBatchCount === 0, encodeBatchCount);

    // 场景 E（Mode A + 估算装箱剪枝）：精确计数比估算乐观（1 字符/token）时按分数升序剔除最低分
    tokenCallCount = 0;
    const { rag: ragE } = await quiet(runCase(true, '陈九提到了码头仓库的货物', { allSummaries: true, settings: modeAConfig() }));
    console.log('E rag:', JSON.stringify(ragE, null, 1));
    check('E: 精确计数被调用（含剪枝循环）', tokenCallCount >= 2, tokenCallCount);
    check('E: 装箱后 RAG 激活', ragE && ragE.active === true, ragE);
    check('E: 因精确计数乐观而触发剪枝（命中数 < 远端条目数）', ragE && ragE.active && ragE.hits.length < ragE.farCount, ragE && ragE.hits.length);

    // 场景 F（Mode A + 发送前补生成）：缺失摘要先补齐再打分
    buildChat('陈九提到了码头仓库的货物');
    installFakeEmbedder(true);
    NS.bridge.extensionSettings['chat-optimization-v2'] = baseSettings(modeAConfig());
    let genCalls = 0;
    const countMissing = () => {
        let n = 0;
        for (let i = 1; i < chat.length; i++) {
            const item = chat[i]; if (!item || !item.extra) continue;
            const hb = item.mes.match(/<NEW_HISTORY>\s*([\s\S]*?)\s*<\/NEW_HISTORY>/);
            if (!hb) continue;
            let journey; try { journey = JSON.parse(hb[1]).故事历程; } catch (e) { continue; }
            const summaries = (item.extra['chat-optimization-v2'] && item.extra['chat-optimization-v2'].summaries) || [];
            for (let j = 0; j < journey.length; j++) {
                const s = summaries[j] && summaries[j].s;
                if (!s || !NS.SubSummary.hasRecallFields(s)) n++;
            }
        }
        return n;
    };
    const fillMissing = () => {
        for (let i = 1; i < chat.length; i++) {
            const item = chat[i]; if (!item) continue;
            const hb = item.mes.match(/<NEW_HISTORY>\s*([\s\S]*?)\s*<\/NEW_HISTORY>/);
            if (!hb) continue;
            let journey; try { journey = JSON.parse(hb[1]).故事历程; } catch (e) { continue; }
            if (!item.extra) item.extra = {};
            if (!item.extra['chat-optimization-v2']) item.extra['chat-optimization-v2'] = { storyHash: fnv1a32(JSON.stringify(journey)), summaries: [] };
            const summaries = item.extra['chat-optimization-v2'].summaries;
            for (let j = 0; j < journey.length; j++) {
                const s = summaries[j] && summaries[j].s;
                if (!s || !NS.SubSummary.hasRecallFields(s)) summaries[j] = validSummaryFor(journey[j]);
            }
        }
    };
    const prevSub = NS.SubSummary;
    const SubSpy = Object.assign({}, prevSub, {
        getRecallMissingCount: () => countMissing(),
        ensureRecallSummaries: async () => { genCalls++; fillMissing(); return { done: 0, failed: 0 }; },
    });
    NS.SubSummary = SubSpy;
    const missingBefore = countMissing();
    const { rag: ragF } = await quiet(runCase(true, '陈九提到了码头仓库的货物', { settings: modeAConfig() }));
    NS.SubSummary = prevSub;
    console.log('F rag:', JSON.stringify(ragF, null, 1));
    check('F: 缺失摘要数 > 0（e7 旧 schema + e8 无摘要）', missingBefore > 0, missingBefore);
    check('F: 发送前触发补生成', genCalls === 1, genCalls);
    check('F: 补生成后缺失为 0', countMissing() === 0, countMissing());
    check('F: RAG 激活且全部走 summary 通道', ragF && ragF.active === true && ragF.hits.length > 0 && ragF.hits.every(h => h.parts.source === 'summary'), ragF.hits);

    // 场景 H（Mode A + 非空窗口）：tokenLimit 放大 → bestK>0，窗口片段参与打分，bestFrag 标记为 user 或 f+楼层号
    const { rag: ragH } = await quiet(runCase(true, '陈九提到了码头仓库的货物', { allSummaries: true, settings: Object.assign({}, modeAConfig(), { tokenLimit: 1300 }) }));
    console.log('H rag:', JSON.stringify({ active: ragH.active, windowCount: ragH.windowCount, farCount: ragH.farCount, farScores: ragH.farScores }, null, 1));
    check('H: RAG 激活且窗口/远端非空（对齐后窗口=楼层3+5 共4条，远端=楼层1 共2条）', ragH && ragH.active === true && ragH.windowCount === 4 && ragH.farCount === 2, ragH && { active: ragH.active, windowCount: ragH.windowCount, farCount: ragH.farCount });
    check('H: 窗口对齐楼层边界 → 楼层 1 整体在远端，bestFrag 只能是 user/f3/f5（不得出现 f1 或 wN 回退）', ragH && ragH.farScores.length > 0 && ragH.farScores.every(r => r.score === null || (/^(user|f3|f5)$/.test(r.parts && r.parts.bestFrag))), ragH.farScores);

    // 场景 G（解析失败气泡总线，v2.11.1 事件驱动）：楼层 3（第 2 个 assistant 楼层）的 NEW_HISTORY JSON 损坏
    // → MESSAGE_RECEIVED 到达事件触发引擎检查，onParseFail 广播该楼层与原因；同内容再次到达不重复广播（历史失败楼层不触发）
    const brokenMes = '损坏楼层\n<NEW_STORY_DATA>\n<NEW_HISTORY>\n{ "故事历程": [ { 损坏\n</NEW_HISTORY>\n</NEW_STORY_DATA>';
    parseFailEvents.length = 0;
    buildChat('陈九提到了码头仓库的货物', true);
    chat[3].mes = brokenMes;
    installFakeEmbedder(true);
    NS.bridge.extensionSettings['chat-optimization-v2'] = baseSettings(modeAConfig());
    fireEvent('message_received', 3);
    check('G: 回复到达时广播一次', parseFailEvents.length === 1, parseFailEvents.length);
    check('G: 广播含楼层 3 且原因非空', parseFailEvents[0] && parseFailEvents[0].some(d => d.index === 3 && d.reasons.length > 0), parseFailEvents[0]);
    buildChat('陈九提到了码头仓库的货物', true);
    chat[3].mes = brokenMes;
    fireEvent('message_received', 3);
    check('G: 相同失败再次到达不重复广播', parseFailEvents.length === 1, parseFailEvents.length);
    // 场景 G2（消息编辑修复）：修复楼层 3 后编辑事件不再广播；再弄坏则重新广播
    buildChat('陈九提到了码头仓库的货物', true);
    chat[3].mes = brokenMes;
    fireEvent('message_received', 3);
    chat[3].mes = makeFloor([e3, e4], null).mes;
    fireEvent('message_edited', 3);
    check('G2: 修复后无新广播', parseFailEvents.length === 1, parseFailEvents.length);
    check('G2: 失败楼层基线已更新', NS.Engine.getStats().failedFloors.length === 0, NS.Engine.getStats().failedFloors);
    chat[3].mes = brokenMes;
    fireEvent('message_edited', 3);
    check('G2: 重新损坏后再次广播', parseFailEvents.length === 2, parseFailEvents.length);
})().catch(e => { console.error('TEST ERROR', e); process.exit(1); });

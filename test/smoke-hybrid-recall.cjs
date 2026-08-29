// 端到端冒烟测试：模拟浏览器环境与 NS.bridge，验证召回特化摘要混合打分链路
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

global.window = {};
global.navigator = { hardwareConcurrency: 4 };
global.document = { readyState: 'complete', addEventListener() { }, createElement: () => ({ style: {} }), head: { appendChild() { } } };

const chat = [];
window.ChatOptimizationV2 = {
    loaded: true,
    version: '2.5.0-test',
    baseUrl: ROOT + '/',
    bridge: {
        extensionSettings: {},
        saveSettingsDebounced: () => { },
        getTokenCountAsync: async (text) => Math.ceil(String(text || '').length / 3),
        getCurrentChat: () => chat,
        saveChatDebounced: () => { },
        eventSource: { on() { }, off() { } },
        eventTypes: { GENERATION_ENDED: 'GENERATION_ENDED' },
    },
};

function load(rel) {
    const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    // eslint-disable-next-line no-eval
    (0, eval)(code);
}
load('config/settings.js');
load('config/engine.js');
load('config/subsummary.js');
load('config/retrieval.js');

const NS = window.ChatOptimizationV2;
const Settings = NS.Settings;

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
function installFakeEmbedder(ready) {
    NS.Embedder = {
        isReady: () => ready,
        getStatus: () => ({ state: ready ? 'ready' : 'idle', message: '' }),
        encodeBatch: async (texts) => texts.map(fakeVec),
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

function buildChat(lastUserMes) {
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
    chat.push(makeFloor([e7, e8], [
        { s: { 摘要: '沈梦瑶码头见船夫', 关键: ['见面'] }, t: 1 },
        null,
    ]));
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

async function runCase(embedderReady, lastUserMes) {
    buildChat(lastUserMes);
    installFakeEmbedder(embedderReady);
    NS.bridge.extensionSettings['chat-optimization-v2'] = {
        extensionToggle: true,
        roleCardToggle: false,
        keepCount: 1,
        tokenLimit: 100,
        ragRatio: 0.5,
    };
    await globalThis.replaceChatHistoryWithDetailsV2(chat, 4096, null, 0);
    const stats = NS.Engine.getStats();
    return { rag: stats.rag, finalMes: String(chat[0] && chat[0].mes) };
}

(async () => {
    // 场景 A：Embedder 就绪，稀有角色（陈九）触发召回
    const { rag: ragA, finalMes: mesA } = await quiet(runCase(true, '陈九提到了码头仓库的货物'));
    console.log('A rag:', JSON.stringify(ragA, null, 1));
    check('A: chat 被压成 1 条', chat.length === 1);
    check('A: 最后一条消息含前文', mesA.includes('<HISTORY>'));
    check('A: RAG 激活', ragA && ragA.active === true, ragA);
    check('A: 有命中', ragA.hits.length > 0, ragA);
    const topA = ragA.hits.reduce((m, h) => (h.score > m.score ? h : m), ragA.hits[0]);
    check('A: 最优命中是陈九仓库条目', topA && topA.text.includes('陈九交付货物'), topA);
    check('A: 走 summary 通道', topA && topA.parts && topA.parts.source === 'summary', topA);
    check('A: 人物 1/2 且 actorScore 饱和为 1', topA && topA.parts.actor === '1/2' && topA.parts.actorScore >= 0.99, topA && topA.parts);
    check('A: 地点 2/2 命中', topA && topA.parts.location === '2/2', topA && topA.parts);
    check('A: 分数在 [0,1]', ragA.hits.every(h => h.score >= 0 && h.score <= 1));

    // 场景 C：IDF —— 查询只提高频主角（沈梦瑶），纯主角条目的人物分必须远低于 1
    const { rag: ragC } = await quiet(runCase(true, '沈梦瑶又出现了'));
    console.log('C rag:', JSON.stringify(ragC, null, 1));
    const e5Hit = ragC.hits.find(h => h.text.includes('买药'));
    check('C: 纯主角条目有命中记录', !!e5Hit, ragC.hits);
    // 沈梦瑶 出现在 5/6 条摘要：idf = log(1+1.5/5.5) ≈ 0.24，远低于稀有角色的饱和值 1.0
    check('C: 纯主角条目 actorScore ≈0.24 < 0.3（IDF 抑制）', e5Hit && e5Hit.parts.actorScore < 0.3, e5Hit && e5Hit.parts);
    check('C: 主角分数远低于稀有角色饱和分', e5Hit && topA && e5Hit.parts.actorScore < topA.parts.actorScore * 0.3, e5Hit && e5Hit.parts);

    // 场景 B：Embedder 未就绪，全池 BM25 归一化降级
    const { rag: ragB } = await quiet(runCase(false, '陈九提到了码头仓库的货物'));
    console.log('B rag:', JSON.stringify(ragB, null, 1));
    check('B: RAG 激活', ragB && ragB.active === true, ragB);
    check('B: 全部走 bm25 通道', ragB.hits.length > 0 && ragB.hits.every(h => h.parts.source === 'bm25'), ragB.hits);
    check('B: 分数在 [0,1)', ragB.hits.every(h => h.score >= 0 && h.score < 1));
})().catch(e => { console.error('TEST ERROR', e); process.exit(1); });

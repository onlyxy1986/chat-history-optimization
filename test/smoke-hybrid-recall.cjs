// 分层摘要折叠冒烟测试：模拟浏览器环境与 NS.bridge，验证按天分层 + 折叠装配
// node test/smoke-hybrid-recall.cjs
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

global.window = {};
global.navigator = { hardwareConcurrency: 4 };
global.document = { readyState: 'complete', addEventListener() { }, createElement: () => ({ style: {} }), head: { appendChild() { } } };

const chat = [];
const metadata = {};
let tokenCallCount = 0;
let fetchCallCount = 0;
// 最小事件总线 mock：engine.js/subsummary.js 依此订阅消息与生成事件
const eventListeners = {};
function fireEvent(type, ...args) {
    (eventListeners[type] || []).slice().forEach(fn => fn(...args));
}
window.ChatOptimizationV2 = {
    loaded: true,
    version: '2.22.0-test',
    baseUrl: ROOT + '/',
    bridge: {
        extensionSettings: {},
        saveSettingsDebounced: () => { },
        saveMetadataDebounced: () => { },
        // 假计数 1 token ≈ 1.5 字符（与 EST_CHARS_PER_TOKEN 同口径，保证估算与精确一致）
        getTokenCountAsync: async (text) => { tokenCallCount++; return Math.ceil(String(text || '').length / 1.5); },
        getCurrentChat: () => chat,
        saveChatDebounced: () => { },
        getChatMetadata: () => metadata,
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

const NS = window.ChatOptimizationV2;
const Settings = NS.Settings;

// ---------------- 假 LLM（纯文本摘要，贴近真实长度关系） ----------------
// 天摘要 ≈ 当天条目原文的前 50 字（省约 1/4）；合并摘要取子摘要串尾 80 字（省约一半）。
// 长度关系决定折叠 economics：L1 先行、上层后补，与生产一致。
let fetchSeq = 0;
global.fetch = async (url, opts) => {
    fetchCallCount++;
    const body = JSON.parse(opts.body);
    const content = body.messages[0].content;
    fetchSeq++;
    if (content.includes('【子摘要')) {
        return {
            ok: true,
            json: async () => ({ choices: [{ message: { content: `合并摘要${fetchSeq}：` + content.slice(-80) } }] }),
        };
    }
    const marker = '当天历程：\n';
    const at = content.indexOf(marker);
    const input = at !== -1 ? content.slice(at + marker.length) : content;
    return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: `天摘要${fetchSeq}：` + input.slice(0, 50) } }] }),
    };
};

// onParseFail 广播间谍（验证解析失败气泡总线只对新失败楼层触发）
const parseFailEvents = [];
NS.Engine.onParseFail((details) => parseFailEvents.push(details));

// ---------------- 构造假聊天（默认一楼层一条历程） ----------------
function fnv1a32(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; }
    return hash.toString(16).padStart(8, '0');
}
function makeEntry(day, time, loc, process) {
    return { 天数: day, 时间段: time, 地点: loc, 历程: process };
}
function makeFloor(journey) {
    const mes = '正常回复内容\n<NEW_STORY_DATA>\n<NEW_HISTORY>\n' + JSON.stringify({ 故事历程: journey }) + '\n</NEW_HISTORY>\n</NEW_STORY_DATA>';
    return { mes, is_user: false };
}

const TIMES = ['清晨', '上午', '中午', '下午', '傍晚', '晚上', '深夜', '凌晨'];
// perDay：每天的历程条目数（多条目/天时 L1 相对原文才有压缩意义，贴近生产）
function buildChat(numDays, userMes, perDay) {
    chat.length = 0;
    for (const k of Object.keys(metadata)) delete metadata[k];
    chat.push({ mes: '开场', is_user: true });
    const entries = [];
    const n = perDay || 1;
    for (let d = 1; d <= numDays; d++) {
        const journey = [];
        for (let k = 0; k < n; k++) {
            const e = makeEntry(`第${d}天`, TIMES[(d + k) % TIMES.length], `地点${d}`, `第${d}天发生了重要事件${d}-${k}，人物甲与人物乙在地点${d}达成了关键约定${d}-${k}。`);
            journey.push(e);
            entries.push(e);
        }
        chat.push(makeFloor(journey));
        chat.push({ mes: '好', is_user: true });
    }
    chat.push({ mes: userMes || '继续', is_user: true });
    return entries;
}

// 按指定天号数组建聊天（断层时间线，如 [1,2,10,11]），口径与 buildChat 一致
function buildChatDays(dayNums, perDay) {
    chat.length = 0;
    for (const k of Object.keys(metadata)) delete metadata[k];
    chat.push({ mes: '开场', is_user: true });
    const n = perDay || 1;
    for (const d of dayNums) {
        const journey = [];
        for (let k = 0; k < n; k++) {
            journey.push(makeEntry(`第${d}天`, TIMES[(d + k) % TIMES.length], `地点${d}`, `第${d}天发生了重要事件${d}-${k}，人物甲与人物乙在地点${d}达成了关键约定${d}-${k}。`));
        }
        chat.push(makeFloor(journey));
        chat.push({ mes: '好', is_user: true });
    }
    chat.push({ mes: '继续', is_user: true });
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

function baseSettings(override) {
    return Object.assign({
        extensionToggle: true, roleCardToggle: false, keepCount: 1,
        tokenLimit: 100000,
        subSummaryToggle: true,
        subSummarySource: 'fetch',
        subSummaryBaseUrl: 'http://x', subSummaryApiKey: 'k', subSummaryModel: 'm',
        hierFanin: 5,
    }, override || {});
}

async function runAssemble() {
    await globalThis.replaceChatHistoryWithDetailsV2(chat, 4096, null, 0);
    return NS.Engine.getStats();
}

// 测当前聊天在不限预算下的全量 token（校准用；装配会压 collapsed chat，需先 buildChat）
async function measureFullTokens() {
    NS.bridge.extensionSettings['chat-optimization-v2'] = baseSettings({ tokenLimit: 1000000 });
    const stats = await quiet(runAssemble());
    return stats.tokenCount;
}

(async () => {
    // 场景 A（零压缩）：token 充足 → 不折叠，全量原文
    buildChat(4);
    NS.bridge.extensionSettings['chat-optimization-v2'] = baseSettings();
    const statsA = await quiet(runAssemble());
    console.log('A hier:', JSON.stringify(statsA.hier));
    check('A: chat 被压成 1 条', chat.length === 1);
    check('A: 不触发折叠', statsA.hier && statsA.hier.willActivate === false && statsA.hier.active === false, statsA.hier);
    check('A: 前文含全部历程原文', statsA.lastMessage.includes('关键约定1') && statsA.lastMessage.includes('关键约定4'), statsA.lastMessage.slice(0, 200));
    const fullTokensA = statsA.tokenCount;

    // 场景 B（折叠旧天）：收紧预算 → 最旧天折叠为 L1，中段最新天保持原文
    // 注意 keepCount=1 时最后一天被正文覆盖，不在中段内；中段最新天为倒数第 2 天
    // 每天 3 条目：L1 相对原文有实质压缩，折叠停在 L1 层
    buildChat(6, null, 3);
    NS.bridge.extensionSettings['chat-optimization-v2'] = baseSettings();
    await quiet(NS.SubSummary.generateMissing());
    const covB = NS.SubSummary.getCoverage();
    check('B: 6 天已封天 L1 生成、未封天跳过', covB.days.length === 6 && covB.days.filter(d => d.dayKey !== '6').every(d => d.text) && !covB.days.find(d => d.dayKey === '6').text, covB.days.map(d => [d.dayKey, !!d.text]));
    const fullTokensB = await quiet(measureFullTokens());
    buildChat(6, null, 3);
    NS.bridge.extensionSettings['chat-optimization-v2'] = baseSettings();
    await quiet(NS.SubSummary.generateMissing());
    const covB2 = NS.SubSummary.getCoverage();
    const l1Text1 = covB2.days.find(d => d.dayKey === '1').text;
    NS.bridge.extensionSettings['chat-optimization-v2'] = baseSettings({ tokenLimit: fullTokensB - 15 });
    fetchCallCount = 0;
    const statsB = await quiet(runAssemble());
    console.log('B hier:', JSON.stringify(statsB.hier && statsB.hier.days));
    check('B: 折叠激活', statsB.hier && statsB.hier.active === true, statsB.hier);
    check('B: 有天被折叠', statsB.hier.foldedDays >= 1, statsB.hier);
    const dayB = Object.fromEntries(statsB.hier.days.map(d => [d.dayKey, d.level]));
    check('B: 中段最新天保持原文（level 0）', dayB['5'] === 0, dayB);
    check('B: 最旧天已折叠（level ≥ 1）', (dayB['1'] || 0) >= 1, dayB);
    check('B: 前文含最旧天 L1 全文', l1Text1 && statsB.lastMessage.includes(l1Text1), l1Text1);
    check('B: 前文不含最旧天 L0 块头（# 第1天|上午|）', !statsB.lastMessage.includes('# 第1天|上午|'), 'dup-check');
    check('B: 装配过程不调 LLM（发送永不等待）', fetchCallCount === 0, fetchCallCount);
    check('B: 天摘要伪条目与原文同形（# 第1天|全天|）', statsB.lastMessage.includes('# 第1天|全天|'), statsB.lastMessage.slice(0, 500));
    check('B: 天为原子单位（同天条目同进退）', statsB.hier.days.every(d => typeof d.level === 'number'), statsB.hier.days);

    // 场景 C（上层合并）：20 天 fanin 3 → L2 参与折叠；实际渲染槽位从旧到新层级非递增
    // 整组合并：20 = 6×3 + 尾巴 2（尾巴晋升），故 6 个 L2
    buildChat(20, null, 3);
    NS.bridge.extensionSettings['chat-optimization-v2'] = baseSettings({ hierFanin: 3 });
    await quiet(NS.SubSummary.generateMissing());
    const covC = NS.SubSummary.getCoverage();
    const l2Count = covC.upper.filter(u => u.level === 2 && u.text).length;
    check('C: 20 天 fanin3 生成 6 个 L2', l2Count === 6, covC.upper.map(u => [u.key, !!u.text]));
    const fullTokensC = await quiet(measureFullTokens());
    buildChat(20, null, 3);
    NS.bridge.extensionSettings['chat-optimization-v2'] = baseSettings({ hierFanin: 3 });
    await quiet(NS.SubSummary.generateMissing());
    const limitC = fullTokensC - 1450;
    NS.bridge.extensionSettings['chat-optimization-v2'] = baseSettings({ hierFanin: 3, tokenLimit: limitC });
    const statsC = await quiet(runAssemble());
    console.log('C hier:', JSON.stringify(statsC.hier.days.map(d => [d.dayKey, d.level])));
    // 只比较实际渲染的槽位（被合并吞掉/被丢弃的天不参与排序比较）
    const renderedC = statsC.hier.days.filter(d => d.level >= 0 && !d.mergedInto).map(d => d.level);
    let mono = renderedC.length > 0;
    for (let i = 1; i < renderedC.length; i++) {
        if (renderedC[i] > renderedC[i - 1]) { mono = false; break; }
    }
    check('C: 出现 L2 折叠', renderedC.some(l => l >= 2), renderedC);
    check('C: 越新层级越低（高层离尾远）', mono, renderedC);
    check('C: 合并伪条目跨天同形（|多日|）', statsC.lastMessage.includes('|多日|'), 'no-multi-day-block');
    check('C: 最终不超 tokenLimit', statsC.tokenCount <= limitC, { tokenCount: statsC.tokenCount, limitC });

    // 场景 D（无摘要兜底 + 精确丢弃）：无任何摘要 + 超预算 → 丢最旧天，保证硬上限
    buildChat(6);
    const fullTokensD = await quiet(measureFullTokens());
    buildChat(6);
    const limitD = fullTokensD - 100;
    NS.bridge.extensionSettings['chat-optimization-v2'] = baseSettings({ tokenLimit: limitD });
    fetchCallCount = 0;
    const statsD = await quiet(runAssemble());
    console.log('D hier:', JSON.stringify(statsD.hier));
    check('D: 折叠激活', statsD.hier && statsD.hier.active === true, statsD.hier);
    check('D: 无摘要时丢弃最旧天', statsD.hier.droppedDays >= 1, statsD.hier);
    check('D: 最终不超 tokenLimit', statsD.tokenCount <= limitD, { tokenCount: statsD.tokenCount, limitD });
    check('D: 装配不调 LLM', fetchCallCount === 0, fetchCallCount);

    // 场景 E（脏链）：改动某天条目 → 仅该天 L1 失效，其余有效
    buildChat(4);
    NS.bridge.extensionSettings['chat-optimization-v2'] = baseSettings();
    await quiet(NS.SubSummary.generateMissing());
    // 改第 2 天楼层的历程文本（chat 结构：开场 + (楼层,用户)×4 + 用户）
    chat[3].mes = chat[3].mes.replace('关键约定2', '关键约定2（已修改）');
    const covE = NS.SubSummary.getCoverage();
    const e2 = covE.days.find(d => d.dayKey === '2');
    const e1 = covE.days.find(d => d.dayKey === '1');
    check('E: 被改的天 L1 失效', e2 && !e2.text, covE.days.map(d => [d.dayKey, !!d.text]));
    check('E: 未改的天 L1 仍有效', e1 && !!e1.text, covE.days.map(d => [d.dayKey, !!d.text]));

    // 场景 F（fanin 钳制）
    NS.bridge.extensionSettings['chat-optimization-v2'] = baseSettings({ hierFanin: 1 });
    check('F: fanin 下限钳制到 2', NS.SubSummary.getFanin() === 2, NS.SubSummary.getFanin());
    NS.bridge.extensionSettings['chat-optimization-v2'] = baseSettings({ hierFanin: 99 });
    check('F: fanin 上限钳制到 10', NS.SubSummary.getFanin() === 10, NS.SubSummary.getFanin());

    // 场景 I（L1 哈希不含 floor/index）：删首楼层致后续楼层前移，未改内容的天仍有效
    buildChat(4);
    NS.bridge.extensionSettings['chat-optimization-v2'] = baseSettings();
    await quiet(NS.SubSummary.generateMissing());
    chat.splice(1, 2); // 删除第 1 天楼层 + 其后用户消息，后续楼层下标前移
    const covI = NS.SubSummary.getCoverage();
    check('I: 删楼层后剩余已封天 L1 仍有效、未封天跳过', covI.days.length === 3 && covI.days.filter(d => d.dayKey !== '4').every(d => d.text) && !covI.days.find(d => d.dayKey === '4').text, covI.days.map(d => [d.dayKey, !!d.text]));

    // 场景 J（整组合并）：不满 fanin 的尾巴晋升，上层子节点同层；fanin 切换清上层留 L1
    buildChat(6);
    NS.bridge.extensionSettings['chat-optimization-v2'] = baseSettings({ hierFanin: 5 });
    await quiet(NS.SubSummary.generateMissing());
    const covJ6 = NS.SubSummary.getCoverage();
    check('J: 6 天 fanin5 仅 L2:1~5（尾巴 6 晋升）', covJ6.upper.length === 1 && covJ6.upper[0].key === 'L2:1~5', covJ6.upper.map(u => u.key));
    buildChat(7);
    NS.bridge.extensionSettings['chat-optimization-v2'] = baseSettings({ hierFanin: 5 });
    await quiet(NS.SubSummary.generateMissing());
    const covJ7 = NS.SubSummary.getCoverage();
    const j7ok = covJ7.upper.every(u => (u.level === 2 && u.childKeys.every(k => k[0] !== 'L')) || (u.level >= 3 && u.childKeys.every(k => k[0] === 'L')));
    check('J: 上层子节点同层（L2 子为天、L3+ 子为上层）', j7ok, covJ7.upper.map(u => [u.key, u.childKeys]));
    check('J: 7 天仍仅 L2:1~5（尾巴 6~7 不满组晋升、无 L3）', covJ7.upper.length === 1 && covJ7.upper[0].key === 'L2:1~5' && !!covJ7.upper[0].text, covJ7.upper.map(u => [u.key, !!u.text]));
    buildChat(11);
    NS.bridge.extensionSettings['chat-optimization-v2'] = baseSettings({ hierFanin: 5 });
    await quiet(NS.SubSummary.generateMissing());
    const covJ10 = NS.SubSummary.getCoverage();
    check('J: 11 天两组 L2、无 L3（已封天 1~10 凑满两组，未封天 11 跳过；L3 需 5 个 L2）', covJ10.upper.length === 2 && covJ10.upper.every(u => u.level === 2 && !!u.text), covJ10.upper.map(u => [u.key, !!u.text]));
    buildChat(5);
    NS.bridge.extensionSettings['chat-optimization-v2'] = baseSettings({ hierFanin: 2 });
    await quiet(NS.SubSummary.generateMissing());
    const covJ4 = NS.SubSummary.getCoverage();
    check('J: 5 天 fanin2 出 L3:1~4（已封天 1~4 凑满 2 个 L2，未封天 5 跳过）', covJ4.upper.some(u => u.key === 'L3:1~4' && u.text), covJ4.upper.map(u => [u.key, !!u.text]));
    buildChat(7);
    NS.bridge.extensionSettings['chat-optimization-v2'] = baseSettings({ hierFanin: 5 });
    await quiet(NS.SubSummary.generateMissing());
    NS.bridge.extensionSettings['chat-optimization-v2'] = baseSettings({ hierFanin: 2 });
    const covJfanin = NS.SubSummary.getCoverage();
    check('J: fanin 切换清上层', covJfanin.upper.every(u => !u.text), covJfanin.upper.map(u => [u.key, !!u.text]));
    check('J: fanin 切换保留已封天 L1、未封天仍跳过', covJfanin.days.length === 7 && covJfanin.days.filter(d => d.dayKey !== '7').every(d => d.text) && !covJfanin.days.find(d => d.dayKey === '7').text, covJfanin.days.map(d => [d.dayKey, !!d.text]));

    // 场景 L（封天）：自动补齐跳过数字最大天，新天出现后旧天自动转正
    buildChat(3);
    NS.bridge.extensionSettings['chat-optimization-v2'] = baseSettings();
    await quiet(NS.SubSummary.generateMissing());
    const covL1 = NS.SubSummary.getCoverage();
    check('L: 未封天跳过（第 3 天缺失）', covL1.days.length === 3 && covL1.days[0].text && covL1.days[1].text && !covL1.days[2].text, covL1.days.map(d => [d.dayKey, !!d.text]));
    // 追加第 4 天楼层（插到末尾用户消息前，不清 metadata，模拟次日历程出现）
    chat.splice(chat.length - 1, 0, makeFloor([makeEntry('第4天', '上午', '地点4', '第4天发生了重要事件4。')]), { mes: '好', is_user: true });
    await quiet(NS.SubSummary.generateMissing());
    const covL2 = NS.SubSummary.getCoverage();
    const l3 = covL2.days.find(d => d.dayKey === '3');
    const l4 = covL2.days.find(d => d.dayKey === '4');
    check('L: 新天出现后旧天转正、新天仍跳过', l3 && !!l3.text && l4 && !l4.text, covL2.days.map(d => [d.dayKey, !!d.text]));

    // 场景 K（断层时间线）：规划按存在天数的顺序切块，span 含数字断层；折叠跳过缺的天，跨洞父可用
    buildChatDays([1, 2, 10, 11, 12, 13], 3);
    NS.bridge.extensionSettings['chat-optimization-v2'] = baseSettings({ hierFanin: 3 });
    await quiet(NS.SubSummary.generateMissing());
    const covK = NS.SubSummary.getCoverage();
    check('K: 跨洞 L2:1~10 按位置成组', covK.upper.some(u => u.key === 'L2:1~10' && u.text), covK.upper.map(u => [u.key, !!u.text]));
    const fullTokensK = await quiet(measureFullTokens());
    buildChatDays([1, 2, 10, 11, 12, 13], 3);
    NS.bridge.extensionSettings['chat-optimization-v2'] = baseSettings({ hierFanin: 3 });
    await quiet(NS.SubSummary.generateMissing());
    NS.bridge.extensionSettings['chat-optimization-v2'] = baseSettings({ hierFanin: 3, tokenLimit: fullTokensK - 400 });
    const statsK = await quiet(runAssemble());
    const kMerged = statsK.hier.days.filter(d => d.mergedInto === 'L2:1~10');
    check('K: 跨洞父参与折叠（2 天被 L2:1~10 合并）', kMerged.length === 2, statsK.hier.days.map(d => [d.dayKey, d.level, d.endKey, d.mergedInto]));
    check('K: 最终不超 tokenLimit', statsK.tokenCount <= fullTokensK - 400, { tokenCount: statsK.tokenCount, limit: fullTokensK - 400 });

    // 场景 G（解析失败气泡总线，事件驱动）：楼层 2 的 NEW_HISTORY JSON 损坏
    const brokenMes = '损坏楼层\n<NEW_STORY_DATA>\n<NEW_HISTORY>\n{ "故事历程": [ { 损坏\n</NEW_HISTORY>\n</NEW_STORY_DATA>';
    parseFailEvents.length = 0;
    buildChat(4);
    chat[1].mes = brokenMes;
    fireEvent('message_received', 1);
    check('G: 回复到达时广播一次', parseFailEvents.length === 1, parseFailEvents.length);
    check('G: 广播含楼层 1 且原因非空', parseFailEvents[0] && parseFailEvents[0].some(d => d.index === 1 && d.reasons.length > 0), parseFailEvents[0]);
    buildChat(4);
    chat[1].mes = brokenMes;
    fireEvent('message_received', 1);
    check('G: 相同失败再次到达不重复广播', parseFailEvents.length === 1, parseFailEvents.length);
    // 场景 G2（消息编辑修复）：修复后不再广播；再弄坏则重新广播
    buildChat(4);
    chat[1].mes = brokenMes;
    fireEvent('message_received', 1);
    const fixed = makeFloor([makeEntry('第1天', '晚上', '地点1', '第1天发生了重要事件1。')]);
    chat[1].mes = fixed.mes;
    fireEvent('message_edited', 1);
    check('G2: 修复后无新广播', parseFailEvents.length === 1, parseFailEvents.length);
    check('G2: 失败楼层基线已更新', NS.Engine.getStats().failedFloors.length === 0, NS.Engine.getStats().failedFloors);
    chat[1].mes = brokenMes;
    fireEvent('message_edited', 1);
    check('G2: 重新损坏后再次广播', parseFailEvents.length === 2, parseFailEvents.length);

    // 场景 H（profile 附加参数透传）：mock ConnectionManagerRequestService，
    // 验证 extra 经 sendRequest 第 5 参数 overridePayload 发出，temperature 设置项优先
    NS.bridge.extensionSettings.connectionManager = {
        profiles: [{ id: 'p1', mode: 'cc', name: 'P1', model: 'm', 'api-url': 'http://x' }],
    };
    let capturedOverride = null;
    NS.bridge.connectionManagerRequest = {
        sendRequest: async (pid, msgs, maxTok, custom, override) => {
            capturedOverride = { pid, override };
            return { content: 'profile 摘要正文' };
        },
    };
    buildChat(2);
    NS.bridge.extensionSettings['chat-optimization-v2'] = baseSettings({
        subSummarySource: 'profile', subSummaryProfileId: 'p1',
        subSummaryExtraParams: '{"top_p": 0.9, "custom_include_headers": "X-Title: T"}',
    });
    check('H: profile 已配置', NS.SubSummary.isConfigured() === true);
    const resH = await quiet(NS.SubSummary.generateMissing());
    check('H: 生成成功', resH && resH.done > 0, resH);
    check('H: 附加参数透传 overridePayload', capturedOverride && capturedOverride.pid === 'p1' && capturedOverride.override && capturedOverride.override.top_p === 0.9, capturedOverride);
    check('H: temperature 设置项优先', capturedOverride && capturedOverride.override.temperature === 0.3, capturedOverride);
    check('H: custom_include_headers 透传', capturedOverride && capturedOverride.override.custom_include_headers === 'X-Title: T', capturedOverride);
    // 非法 JSON → fatal，不重试直接失败
    NS.SubSummary.eraseAll();
    NS.bridge.extensionSettings['chat-optimization-v2'] = baseSettings({
        subSummarySource: 'profile', subSummaryProfileId: 'p1', subSummaryExtraParams: '{bad',
    });
    const resH2 = await quiet(NS.SubSummary.generateMissing());
    check('H: 非法 JSON 生成失败且不重试', resH2 && resH2.failed > 0 && resH2.done === 0, resH2);
    delete NS.bridge.extensionSettings.connectionManager;
    delete NS.bridge.connectionManagerRequest;
})().catch(e => { console.error('TEST ERROR', e); process.exit(1); });

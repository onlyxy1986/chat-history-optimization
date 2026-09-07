// 角色状态追踪冒烟测试：可变模版解析 + 逐楼层 LLM 追踪 + extra 存储 + 顺序合并
// 输出为单个 JSON 对象（键为角色名），{{角色列表}} 为完整角色卡 JSON
// node test/smoke-roletrack.cjs
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

global.window = {};
global.navigator = { hardwareConcurrency: 4 };
global.document = { readyState: 'complete', addEventListener() { }, createElement: () => ({ style: {} }), head: { appendChild() { } } };

const chat = [];
const metadata = {};
let fetchCallCount = 0;
let saveChatCount = 0;
const eventListeners = {};
function fireEvent(type, ...args) {
    (eventListeners[type] || []).slice().forEach(fn => fn(...args));
}
window.ChatOptimizationV2 = {
    loaded: true,
    version: '2.23.0-test',
    baseUrl: ROOT + '/',
    bridge: {
        extensionSettings: {},
        saveSettingsDebounced: () => { },
        saveMetadataDebounced: () => { },
        getTokenCountAsync: async (text) => Math.ceil(String(text || '').length / 1.5),
        getCurrentChat: () => chat,
        saveChatDebounced: () => { saveChatCount++; },
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
load('core/roletrack.js');

const NS = window.ChatOptimizationV2;

// ---------------- 假 LLM：返回 JSON 对象（按调用顺序换地点，验证顺序合并） ----------------
let fetchSeq = 0;
let lastPrompt = '';
global.fetch = async (url, opts) => {
    fetchCallCount++;
    fetchSeq++;
    const body = JSON.parse(opts.body);
    const content = body.messages[0].content;
    lastPrompt = content;
    const loc = `地点${fetchSeq}`;
    return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: `以下是追踪结果：\n\`\`\`json\n{"爱丽丝":{"当前状态":{"地点":"${loc}"}}}\n\`\`\`` } }] }),
    };
};

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
        extensionToggle: true, roleCardToggle: true, keepCount: 1,
        tokenLimit: 100000,
        roleTrackToggle: true,
        roleTrackSource: 'fetch',
        roleTrackBaseUrl: 'http://x', roleTrackApiKey: 'k', roleTrackModel: 'm',
        roleTrackConcurrency: 4,
    }, override || {});
}

function makeFloor(journey, cardObj) {
    let inner = '<NEW_HISTORY>\n' + JSON.stringify({ 故事历程: journey }) + '\n</NEW_HISTORY>';
    if (cardObj) {
        inner += '\n<NEW_CHARACTER_CARD>\n' + JSON.stringify(cardObj) + '\n</NEW_CHARACTER_CARD>';
    }
    return { mes: '正文\n<NEW_STORY_DATA>\n' + inner + '\n</NEW_STORY_DATA>', is_user: false };
}

function journeyEntry(day, time, loc, who, doing) {
    return { 天数: day, 时间段: time, 地点: loc, 历程: `${who}${doing}` };
}

function cardFor(name) {
    const card = {};
    card[name] = { '角色设定': { '角色名': name }, '当前状态': { '地点': '未知', '穿着': '常服' } };
    return card;
}

// 三个助手楼层：楼层1/2/3（数组下标1/3/5），各一条历程，均出现爱丽丝
function buildChat3() {
    chat.length = 0;
    for (const k of Object.keys(metadata)) delete metadata[k];
    fetchSeq = 0;
    chat.push({ mes: '开场', is_user: true });
    chat.push(makeFloor(
        [journeyEntry('第1天', '晚上', '酒馆', '爱丽丝', '在酒馆与主角相遇。')],
        cardFor('爱丽丝'),
    ));
    chat.push({ mes: '好', is_user: true });
    chat.push(makeFloor(
        [journeyEntry('第1天', '深夜', '旅店', '爱丽丝', '随主角前往旅店休息。')],
        null,
    ));
    chat.push({ mes: '好', is_user: true });
    chat.push(makeFloor(
        [journeyEntry('第2天', '清晨', '广场', '爱丽丝', '在广场与主角告别。')],
        null,
    ));
    chat.push({ mes: '继续', is_user: true });
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

(async () => {
    // 场景 A（模版解析）：默认模板含 <可变>，过滤后只剩可变子树
    NS.bridge.extensionSettings['chat-optimization-v2'] = baseSettings();
    const varInfo = NS.RoleTrack.getVariableInfo();
    check('A: 检测到可变标记', varInfo.hasVariable === true, varInfo);
    check('A: 可变路径含当前状态', varInfo.paths.some(p => p.indexOf('当前状态') !== -1), varInfo.paths);
    check('A: 模版保留当前状态', !!(varInfo.variableTemplate && varInfo.variableTemplate['{{角色名}}'] && varInfo.variableTemplate['{{角色名}}']['当前状态']), varInfo.variableTemplate);
    check('A: 模版剔除角色设定', !(varInfo.variableTemplate['{{角色名}}'] && varInfo.variableTemplate['{{角色名}}']['角色设定']), varInfo.variableTemplate);
    // 父级 <可变> 覆盖整棵子树：整段 当前状态 即使子行无标记也保留（地点/穿着都在）
    const sub = varInfo.variableTemplate['{{角色名}}']['当前状态'];
    check('A: 子树整体保留', !!sub['地点'] && !!sub['穿着'], sub);

    // 场景 B（无标记模板）：去掉 <可变> 后 hasVariable 为 false
    NS.bridge.extensionSettings['chat-optimization-v2'] = baseSettings({
        characterPrompt: '{ "{{角色名}}": { "角色设定": { "角色名": "X" }, "当前状态": { "地点": "Y" } } }',
    });
    const varInfoB = NS.RoleTrack.getVariableInfo();
    check('B: 无标记时 hasVariable=false', varInfoB.hasVariable === false, varInfoB);

    // 场景 C（逐楼层追踪 + extra 存储）
    NS.bridge.extensionSettings['chat-optimization-v2'] = baseSettings();
    buildChat3();
    fetchCallCount = 0;
    const resC = await quiet(NS.RoleTrack.generateMissing());
    check('C: 3 个楼层全部追踪', resC && resC.done === 3 && resC.failed === 0, resC);
    check('C: 装配过程调 3 次 LLM', fetchCallCount === 3, fetchCallCount);
    const covC = NS.RoleTrack.getCoverage();
    check('C: 覆盖已追踪 3', covC.tracked === 3 && covC.missing === 0, { tracked: covC.tracked, missing: covC.missing });
    check('C: 每楼层 states 为单角色对象', covC.floors.every(f => f.states && f.states['爱丽丝'] && f.states['爱丽丝']['当前状态']), covC.floors.map(f => f.states));
    check('C: extra 落盘且 saveChat 被调', saveChatCount > 0 && !!chat[1].extra['chat-optimization-v2-roletrack'], { saveChatCount });
    check('C: prompt 中角色列表为完整角色卡', lastPrompt.indexOf('"角色设定"') !== -1 && lastPrompt.indexOf('"当前状态"') !== -1, lastPrompt.slice(0, 200));

    // 场景 D（顺序合并：后楼层赢）
    const mergedD = NS.RoleTrack.getMergedStates();
    check('D: 合并后爱丽丝地点为第 3 次追踪值', mergedD['爱丽丝'] && mergedD['爱丽丝']['当前状态'] && mergedD['爱丽丝']['当前状态']['地点'] === '地点3', mergedD);

    // 场景 E（脏链：改某楼层历程只脏该楼层）
    chat[3].mes = chat[3].mes.replace('旅店休息', '旅店休息（已修改）');
    const covE = NS.RoleTrack.getCoverage();
    const e3 = covE.floors.find(f => f.floor === 3);
    const e1 = covE.floors.find(f => f.floor === 1);
    check('E: 被改楼层失效', e3 && !e3.valid, covE.floors.map(f => [f.floor, f.valid]));
    check('E: 未改楼层仍有效', e1 && !!e1.valid, covE.floors.map(f => [f.floor, f.valid]));

    // 场景 F（applyToCharacterData：追踪赢 + 不复活淘汰角色 + 跳过未知键）
    // 手工给楼层 5 的 states 注入终值与幻觉键
    chat[5].extra['chat-optimization-v2-roletrack'].states = { '爱丽丝': { '当前状态': { '地点': '终点', '幻觉属性': 'xxx' } } };
    const cardF = { '爱丽丝': { '角色设定': { '角色名': '爱丽丝' }, '当前状态': { '地点': '旧', '穿着': '常服' } }, '鲍勃': { '角色设定': { '角色名': '鲍勃' } } };
    NS.RoleTrack.applyToCharacterData(cardF, chat);
    check('F: 追踪覆盖地点', cardF['爱丽丝']['当前状态']['地点'] === '终点', cardF['爱丽丝']);
    check('F: 未变字段保留', cardF['爱丽丝']['当前状态']['穿着'] === '常服', cardF['爱丽丝']);
    check('F: 不可变设定不受影响', cardF['爱丽丝']['角色设定']['角色名'] === '爱丽丝', cardF['爱丽丝']);
    check('F: 幻觉键被跳过', !('幻觉属性' in cardF['爱丽丝']['当前状态']), cardF['爱丽丝']);
    check('F: 未出场的鲍勃不注入状态', !cardF['鲍勃']['当前状态'], cardF['鲍勃']);
    // 淘汰角色不复活：目标卡无该角色时不新增
    const cardF2 = { '爱丽丝': { '角色设定': {}, '当前状态': {} } };
    NS.RoleTrack.applyToCharacterData(cardF2, chat);
    check('F: 不复活已淘汰角色', !('鲍勃' in cardF2), Object.keys(cardF2));

    // 场景 G（无角色楼层记空对象，不调 LLM）
    buildChat3();
    NS.bridge.extensionSettings['chat-optimization-v2'] = baseSettings();
    chat.push(makeFloor([journeyEntry('第2天', '中午', '荒野', '一阵风', '吹过荒野。')], null));
    chat.push({ mes: '继续', is_user: true });
    fetchCallCount = 0;
    await quiet(NS.RoleTrack.generateMissing());
    const lastFloor = chat.length - 2;
    const slotG = chat[lastFloor].extra['chat-optimization-v2-roletrack'];
    check('G: 无角色楼层记空对象', slotG && slotG.states && typeof slotG.states === 'object' && Object.keys(slotG.states).length === 0, slotG);
    check('G: 4 楼层只需 3 次 LLM', fetchCallCount === 3, fetchCallCount);

    // 场景 H（模板校验 + 未配置）
    check('H: 缺占位符的模板无效', NS.RoleTrack.validateRoleTrackTemplate('只有故事历程 {{故事历程}}') === false);
    check('H: 全占位符的模板有效', NS.RoleTrack.validateRoleTrackTemplate('a{{可变状态模版}}b{{角色列表}}c{{故事历程}}') === true);
    NS.bridge.extensionSettings['chat-optimization-v2'] = baseSettings({ roleTrackBaseUrl: '' });
    check('H: 未配置 baseUrl 时 isConfigured=false', NS.RoleTrack.isConfigured() === false);
    NS.bridge.extensionSettings['chat-optimization-v2'] = baseSettings();

    // 场景 I（自动触发：新助手回复到达后后台追踪）
    buildChat3();
    NS.RoleTrack.eraseAll();
    NS.bridge.extensionSettings['chat-optimization-v2'] = baseSettings();
    fetchCallCount = 0;
    // 模拟 3 条助手回复逐条到达
    fireEvent('message_received', 1);
    fireEvent('message_received', 3);
    fireEvent('message_received', 5);
    for (let i = 0; i < 50 && fetchCallCount < 3; i++) await sleep(50);
    const covI = NS.RoleTrack.getCoverage();
    check('I: 自动触发追踪全部缺失楼层', covI.tracked === 3, { tracked: covI.tracked, fetchCallCount });
    // 用户消息到达不触发
    NS.RoleTrack.eraseAll();
    fetchCallCount = 0;
    fireEvent('message_received', 2);
    await sleep(200);
    check('I: 用户消息不触发追踪', fetchCallCount === 0, fetchCallCount);

    // 场景 J（擦除）
    buildChat3();
    await quiet(NS.RoleTrack.generateMissing());
    const erased = NS.RoleTrack.eraseAll();
    check('J: 擦除 3 个楼层', erased === 3, erased);
    check('J: 擦除后全缺失', NS.RoleTrack.getCoverage().missing === 3, NS.RoleTrack.getCoverage());

    // 场景 K（端到端：拦截器装配的角色卡含顺序合并后的最终状态）
    buildChat3();
    NS.bridge.extensionSettings['chat-optimization-v2'] = baseSettings({ tokenLimit: 1000000 });
    await quiet(NS.RoleTrack.generateMissing());
    const statsK = await quiet(globalThis.replaceChatHistoryWithDetailsV2(chat, 4096, null, 0));
    const lastMsg = NS.Engine.getStats().lastMessage;
    check('K: 发送消息含合并后的追踪状态', lastMsg.indexOf('地点3') !== -1, lastMsg.slice(0, 300));
    check('K: 发送消息保留不可变设定', lastMsg.indexOf('爱丽丝') !== -1, lastMsg.slice(0, 300));
})().catch(e => { console.error('TEST ERROR', e); process.exit(1); });

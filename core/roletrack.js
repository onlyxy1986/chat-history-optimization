// ============================================================================
// chat-optimization-v2 角色状态追踪。
// 纯逻辑：不访问 DOM。UI 更新走状态事件总线（onStatus/getStatus，模式同 subsummary）。
//
// 输入（单楼层）：
//   1. 可变状态模版：角色卡模板（characterPrompt）中属性行 // 注释含 <可变>
//      标签的属性，按同样树形过滤出的子树；
//   2. 本次故事历程：本楼层 L0（该助手回复 NEW_HISTORY 的故事历程条目）；
//   3. 角色卡：本楼层历程文本中出现的角色的完整角色卡
//      {角色名: 角色卡}（Engine.getKnownRoleCards 全集经
//      Engine.nameMatches 过滤，含消歧义）。
// 输出：一个 JSON 对象，以可变状态模版为树形参考：键为有状态变化的角色名，
//   值为该角色的可变状态子树，无变化时为 {}。
//
// 触发：助手新回复到达（MESSAGE_RECEIVED 且非用户消息）后后台追踪本楼层，
//   不阻塞发送；编辑/swipe 导致的过期由手动补齐覆盖。
// 存储：各楼层 extra[EXTRA_KEY] = {v: 2, h, states, t}，states 为输出对象，
//   h 为（可变模版+本楼层 L0）哈希；楼层重写/模板变更即标脏，只重追该楼层。
// 合并：Engine.buildPromptData 在角色卡淘汰/蒸馏后调 applyToCharacterData，
//   按楼层顺序把各楼层 states 对象合并为最终可变状态并覆盖（追踪赢；淘汰掉的
//   角色不复活；未知键按模板校验跳过）。
// 连接：独立于分层摘要的配置（roleTrackSource/Profile/BaseUrl/ApiKey/
//   Model/ExtraParams/Temperature/MaxTokens/Concurrency/TimeoutSec），
//   fetch / profile 双通道、超时、重试口径与 subsummary 一致。
// ============================================================================
(function () {
    'use strict';

    const NS = window.ChatOptimizationV2 = window.ChatOptimizationV2 || {};
    const Settings = NS.Settings;
    const Constants = NS.Constants;

    const EXTRA_KEY = 'chat-optimization-v2-roletrack';
    const VARIABLE_TAG = '<可变>';
    const TEMPLATE_PLACEHOLDER = '{{可变状态模版}}';
    const ROLELIST_PLACEHOLDER = '{{角色列表}}';
    const JOURNEY_PLACEHOLDER = '{{故事历程}}';

    let lastStatus = { running: false, current: '', done: 0, failed: 0, error: null, message: null, lastDone: null };
    const statusListeners = new Set();
    let running = false;
    let initialized = false;
    // 批次（自动触发 / 手动）经此链串行，批次内部多楼层经 worker 池并行。
    let batchChain = Promise.resolve();

    // ------------------------------------------------------------------
    // 小工具
    // ------------------------------------------------------------------

    function fnv1a32(text) {
        let hash = 0x811c9dc5;
        for (let i = 0; i < text.length; i++) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193) >>> 0;
        }
        return hash.toString(16).padStart(8, '0');
    }

    function clone(value) {
        return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    }

    function isPlainObject(value) {
        return !!value && typeof value === 'object' && !Array.isArray(value);
    }

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
                console.error('[Chat History Optimization] 角色状态追踪状态监听器错误', e);
            }
        }
    }

    function onStatus(listener) {
        statusListeners.add(listener);
        return () => statusListeners.delete(listener);
    }

    function fatal(message) {
        const err = new Error(message);
        err.noRetry = true;
        return err;
    }

    function isAbortError(e) {
        return !!e && (e.name === 'AbortError' || (typeof DOMException !== 'undefined' && e instanceof DOMException && e.name === 'AbortError'));
    }

    // ------------------------------------------------------------------
    // 设置访问（非法值回退默认，模式同 subsummary）
    // ------------------------------------------------------------------

    function getConnectionManagerProfiles() {
        const extensionSettings = NS.bridge.extensionSettings;
        if (!extensionSettings) return [];
        if (Array.isArray(extensionSettings.disabledExtensions) && extensionSettings.disabledExtensions.includes('connection-manager')) return [];
        const manager = extensionSettings.connectionManager;
        if (!manager || !Array.isArray(manager.profiles)) return [];
        return manager.profiles;
    }

    function getProfileOptions() {
        return getConnectionManagerProfiles()
            .filter((p) => p && p.mode === 'cc'
                && typeof p.id === 'string' && p.id !== ''
                && String(p['api-url'] || '').trim() !== ''
                && String(p.model || '').trim() !== '')
            .map((p) => ({ id: p.id, name: p.name || p.id, model: String(p.model).trim(), url: String(p['api-url']).trim() }));
    }

    function isConfigured() {
        const source = String(Settings.get('roleTrackSource') || 'fetch');
        if (source === 'profile') {
            const profileId = String(Settings.get('roleTrackProfileId') || '');
            if (!profileId) return false;
            return getProfileOptions().some((p) => p.id === profileId);
        }
        return Boolean(String(Settings.get('roleTrackBaseUrl') || '').trim())
            && Boolean(String(Settings.get('roleTrackApiKey') || '').trim())
            && Boolean(String(Settings.get('roleTrackModel') || '').trim());
    }

    function parseExtraParams() {
        const raw = Settings.get('roleTrackExtraParams');
        if (typeof raw !== 'string' || raw.trim() === '') return {};
        let obj;
        try {
            obj = JSON.parse(raw);
        } catch (e) {
            throw fatal('profile 附加参数不是有效 JSON');
        }
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
            throw fatal('profile 附加参数必须是 JSON 对象');
        }
        return obj;
    }

    function validateExtraParams(text) {
        if (typeof text !== 'string' || text.trim() === '') return true;
        try {
            const obj = JSON.parse(text);
            return !!obj && typeof obj === 'object' && !Array.isArray(obj);
        } catch (e) {
            return false;
        }
    }

    function getTemperature() {
        const value = Settings.get('roleTrackTemperature');
        return (typeof value === 'number' && !isNaN(value)) ? value : Settings.defaultSettings.roleTrackTemperature;
    }

    function getMaxTokens() {
        const value = Settings.get('roleTrackMaxTokens');
        return (typeof value === 'number' && !isNaN(value) && value > 0) ? value : Settings.defaultSettings.roleTrackMaxTokens;
    }

    function getConcurrency() {
        const max = (Constants && typeof Constants.ROLETRACK_CONCURRENCY_MAX === 'number' && Constants.ROLETRACK_CONCURRENCY_MAX > 0)
            ? Math.floor(Constants.ROLETRACK_CONCURRENCY_MAX) : 8;
        const fallback = (typeof Settings.defaultSettings.roleTrackConcurrency === 'number'
            && !isNaN(Settings.defaultSettings.roleTrackConcurrency))
            ? Math.floor(Settings.defaultSettings.roleTrackConcurrency) : 4;
        const value = Settings.get('roleTrackConcurrency');
        const n = (typeof value === 'number' && !isNaN(value)) ? Math.floor(value) : fallback;
        if (n < 1) return 1;
        return Math.min(n, max);
    }

    // 超时口径复用分层摘要的钳制常数，读本模块的 roleTrackTimeoutSec（秒）。
    function getRequestTimeoutMs() {
        const min = (Constants && typeof Constants.SUBSUMMARY_TIMEOUT_MIN_MS === 'number' && Constants.SUBSUMMARY_TIMEOUT_MIN_MS > 0)
            ? Math.floor(Constants.SUBSUMMARY_TIMEOUT_MIN_MS) : 10000;
        const max = (Constants && typeof Constants.SUBSUMMARY_TIMEOUT_MAX_MS === 'number' && Constants.SUBSUMMARY_TIMEOUT_MAX_MS > 0)
            ? Math.floor(Constants.SUBSUMMARY_TIMEOUT_MAX_MS) : 600000;
        const fallback = (Constants && typeof Constants.SUBSUMMARY_REQUEST_TIMEOUT_MS === 'number' && Constants.SUBSUMMARY_REQUEST_TIMEOUT_MS > 0)
            ? Math.floor(Constants.SUBSUMMARY_REQUEST_TIMEOUT_MS) : 120000;
        const raw = Settings.get('roleTrackTimeoutSec');
        const ms = (typeof raw === 'number' && !isNaN(raw)) ? Math.round(raw * 1000) : fallback;
        if (ms < min) return min;
        if (ms > max) return max;
        return ms;
    }

    function getJourneyMaxChars() {
        const n = (Constants && typeof Constants.ROLETRACK_JOURNEY_MAX_CHARS === 'number' && Constants.ROLETRACK_JOURNEY_MAX_CHARS > 0)
            ? Math.floor(Constants.ROLETRACK_JOURNEY_MAX_CHARS) : 12000;
        return n;
    }

    function getTracksMaxPerFloor() {
        const n = (Constants && typeof Constants.ROLETRACK_TRACKS_MAX_PER_FLOOR === 'number' && Constants.ROLETRACK_TRACKS_MAX_PER_FLOOR > 0)
            ? Math.floor(Constants.ROLETRACK_TRACKS_MAX_PER_FLOOR) : 10;
        return n;
    }

    function timeoutMessage(prefix, ms) {
        return `${prefix}请求超时（${Math.max(1, Math.round(ms / 1000))}秒）`;
    }

    function validateRoleTrackTemplate(text) {
        return typeof text === 'string' && text.trim() !== ''
            && text.indexOf(TEMPLATE_PLACEHOLDER) !== -1
            && text.indexOf(ROLELIST_PLACEHOLDER) !== -1
            && text.indexOf(JOURNEY_PLACEHOLDER) !== -1;
    }

    // ------------------------------------------------------------------
    // 可变状态模版：角色卡模板中 // 含 <可变> 的属性按同样树形过滤。
    // 要求模板保持一行一属性的 pretty 格式（与默认模板一致）；单行多属性时
    // 行尾注释作用于该行全部属性键。
    // ------------------------------------------------------------------

    // 原始模板文本 → 可变路径集合（路径以 \0 连接键）。
    function extractVariablePaths(templateText) {
        const paths = new Set();
        if (typeof templateText !== 'string' || templateText === '') return paths;
        const stack = [];
        const lines = templateText.split('\n');
        for (const line of lines) {
            const commentAt = line.indexOf('//');
            const jsonPart = commentAt === -1 ? line : line.slice(0, commentAt);
            const comment = commentAt === -1 ? '' : line.slice(commentAt);
            const keys = [];
            const re = /"((?:[^"\\]|\\.)*)"\s*:/g;
            let m = null;
            while ((m = re.exec(jsonPart)) !== null) {
                keys.push(m[1]);
            }
            if (comment.indexOf(VARIABLE_TAG) !== -1) {
                for (const key of keys) {
                    paths.add(stack.concat([key]).join('\0'));
                }
            }
            const opens = (jsonPart.match(/[{[]/g) || []).length;
            const closes = (jsonPart.match(/[}\]]/g) || []).length;
            const net = opens - closes;
            if (net > 0) {
                if (keys.length > 0) {
                    stack.push(keys[keys.length - 1]);
                    for (let i = 1; i < net; i++) stack.push(keys[keys.length - 1]);
                }
            } else if (net < 0) {
                for (let i = 0; i < -net && stack.length > 0; i++) stack.pop();
            }
        }
        return paths;
    }

    function pathUnderVariable(pathArr, variablePaths) {
        for (let i = 1; i <= pathArr.length; i++) {
            if (variablePaths.has(pathArr.slice(0, i).join('\0'))) return true;
        }
        return false;
    }

    function hasVariableDescendant(pathArr, variablePaths) {
        if (variablePaths.size === 0) return false;
        if (pathArr.length === 0) return true;
        const prefix = pathArr.join('\0') + '\0';
        for (const p of variablePaths) {
            if (p.indexOf(prefix) === 0) return true;
        }
        return false;
    }

    function filterVariableValue(value, pathArr, variablePaths) {
        if (pathUnderVariable(pathArr, variablePaths)) return clone(value);
        if (isPlainObject(value)) {
            const out = {};
            let any = false;
            for (const key of Object.keys(value)) {
                const sub = filterVariableValue(value[key], pathArr.concat([key]), variablePaths);
                if (sub !== undefined) {
                    out[key] = sub;
                    any = true;
                }
            }
            return any ? out : undefined;
        }
        if (Array.isArray(value)) {
            // 数组按叶处理：祖先可变则整体保留；后代可变（极少见）也整体保留，
            // 否则整段丢弃（状态快照语义，不做按下标过滤）。
            if (hasVariableDescendant(pathArr, variablePaths)) return clone(value);
            return undefined;
        }
        return undefined;
    }

    // 只读解析当前角色卡模板 → {hasVariable, paths, template, variableTemplate}。
    function getVariableInfo() {
        const EngineRef = NS.Engine;
        const raw = Settings.get('characterPrompt');
        const template = EngineRef && typeof EngineRef.parseTemplate === 'function'
            ? EngineRef.parseTemplate(typeof raw === 'string' ? raw : '')
            : null;
        if (!template || typeof template !== 'object' || Array.isArray(template)) {
            return { hasVariable: false, paths: [], template: null, variableTemplate: null };
        }
        const variablePaths = extractVariablePaths(typeof raw === 'string' ? raw : '');
        if (variablePaths.size === 0) {
            return { hasVariable: false, paths: [], template, variableTemplate: null };
        }
        const variableTemplate = filterVariableValue(template, [], variablePaths);
        if (!variableTemplate || typeof variableTemplate !== 'object' || Object.keys(variableTemplate).length === 0) {
            return { hasVariable: false, paths: [...variablePaths], template, variableTemplate: null };
        }
        return { hasVariable: true, paths: [...variablePaths], template, variableTemplate };
    }

    // ------------------------------------------------------------------
    // 楼层 L0 读取与角色列表
    // ------------------------------------------------------------------

    function getChat() {
        return (NS.bridge && typeof NS.bridge.getCurrentChat === 'function') ? NS.bridge.getCurrentChat() : null;
    }

    function isAssistantItem(item) {
        return !!item && ((('is_user' in item) && !item.is_user) || (item.role && item.role === 'assistant'));
    }

    // 本楼层 L0 条目（该回复 NEW_HISTORY 的故事历程数组，归一化为
    // {天数,时间段,地点,历程}；无历程返回空数组）。
    function getFloorEntries(floor) {
        const chat = getChat();
        if (!chat || !Array.isArray(chat) || floor < 1 || floor >= chat.length) return [];
        const item = chat[floor];
        if (!isAssistantItem(item)) return [];
        const EngineRef = NS.Engine;
        if (!EngineRef || typeof EngineRef.getFloorStoryBlock !== 'function') return [];
        let block = null;
        try {
            block = EngineRef.getFloorStoryBlock(item);
        } catch (e) {
            return [];
        }
        if (!block || !Array.isArray(block.故事历程)) return [];
        const out = [];
        for (const entry of block.故事历程) {
            if (!entry || typeof entry !== 'object') continue;
            const process = Array.isArray(entry.历程)
                ? entry.历程.map((s) => (s == null ? '' : String(s).trim())).filter(Boolean).join('')
                : (entry.历程 == null ? '' : String(entry.历程));
            out.push({
                天数: entry.天数 || '',
                时间段: entry.时间段 || '',
                地点: entry.地点 || '',
                历程: process,
            });
        }
        return out;
    }

    // 本楼层历程文本（entryToDocText 拼接，超长从最旧侧截断保留尾部）。
    function getFloorJourneyText(floorEntries) {
        const EngineRef = NS.Engine;
        const lines = (floorEntries || []).map((e) => {
            try {
                return (EngineRef && typeof EngineRef.entryToDocText === 'function')
                    ? EngineRef.entryToDocText(e) : String((e && e.历程) || '');
            } catch (err) {
                return String((e && e.历程) || '');
            }
        }).filter((s) => typeof s === 'string' && s.trim() !== '');
        let text = lines.join('\n');
        const max = getJourneyMaxChars();
        if (text.length > max) text = text.slice(text.length - max);
        return text;
    }

    // 本楼层历程中出现的角色的完整角色卡（已知全集按文本过滤，含消歧义）。
    // 返回 {角色名: 角色卡}，无匹配时返回空对象。
    function getFloorRoleCards(journeyText) {
        const EngineRef = NS.Engine;
        if (!EngineRef || typeof EngineRef.nameMatches !== 'function') return {};
        let cards = {};
        if (EngineRef && typeof EngineRef.getKnownRoleCards === 'function') {
            try {
                cards = EngineRef.getKnownRoleCards() || {};
            } catch (e) {
                cards = {};
            }
        }
        if (!isPlainObject(cards)) return {};
        const names = Object.keys(cards);
        if (names.length === 0) return {};
        if (typeof journeyText !== 'string' || journeyText.trim() === '') return {};
        const out = {};
        for (const name of names) {
            try {
                if (EngineRef.nameMatches(name, journeyText, names)) out[name] = cards[name];
            } catch (e) { /* 单个角色匹配失败不影响其他 */ }
        }
        return out;
    }

    function floorHash(variableTemplate, floorEntries) {
        return fnv1a32(JSON.stringify({ v: variableTemplate || null, e: floorEntries || [] }));
    }

    // ------------------------------------------------------------------
    // 楼层 extra 读写
    // ------------------------------------------------------------------

    function readFloorSlot(floor, chatRef) {
        const chat = chatRef || getChat();
        if (!chat || !Array.isArray(chat) || floor < 1 || floor >= chat.length) return null;
        const item = chat[floor];
        if (!item || typeof item !== 'object') return null;
        const extra = item.extra;
        if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return null;
        const slot = extra[EXTRA_KEY];
        if (!slot || typeof slot !== 'object' || Array.isArray(slot)) return null;
        if (!isPlainObject(slot.states)) return null;
        return slot;
    }

    function writeFloorSlot(floor, states, hash) {
        const chat = getChat();
        if (!chat || !Array.isArray(chat) || floor < 1 || floor >= chat.length) return false;
        const item = chat[floor];
        if (!item || typeof item !== 'object') return false;
        if (!item.extra || typeof item.extra !== 'object' || Array.isArray(item.extra)) item.extra = {};
        item.extra[EXTRA_KEY] = { v: 2, h: hash, states: clone(states) || {}, t: Date.now() };
        if (typeof NS.bridge.saveChatDebounced === 'function') NS.bridge.saveChatDebounced();
        return true;
    }

    // 槽位输出 {角色名: 可变子树}，无有效输出返回 null。
    function slotStates(slot) {
        if (!slot || typeof slot !== 'object' || Array.isArray(slot)) return null;
        if (!isPlainObject(slot.states)) return null;
        return slot.states;
    }

    function isSlotValid(floor, hash, chatRef) {
        const slot = readFloorSlot(floor, chatRef);
        return !!slot && slot.h === hash;
    }

    // ------------------------------------------------------------------
    // 只读快照：各楼层追踪覆盖（UI 与合并共用，不触发 LLM）
    // ------------------------------------------------------------------

    function getCoverage(chatRef) {
        const chat = chatRef || getChat();
        const variableInfo = getVariableInfo();
        const floors = [];
        let tracked = 0;
        let missing = 0;
        if (chat && Array.isArray(chat)) {
            for (let floor = 1; floor < chat.length; floor++) {
                const item = chat[floor];
                if (!isAssistantItem(item)) continue;
                const entries = getFloorEntries(floor);
                if (entries.length === 0) continue;
                const journeyText = getFloorJourneyText(entries);
                const roleCards = getFloorRoleCards(journeyText);
                const hash = variableInfo.hasVariable ? floorHash(variableInfo.variableTemplate, entries) : null;
                const slot = readFloorSlot(floor, chat);
                const valid = !!slot && !!hash && slot.h === hash;
                if (valid) tracked++;
                else missing++;
                floors.push({
                    floor,
                    count: entries.length,
                    roles: Object.keys(roleCards),
                    states: slot ? clone(slotStates(slot)) : null,
                    valid,
                    t: (slot && typeof slot.t === 'number') ? slot.t : 0,
                });
            }
        }
        return {
            hasVariable: variableInfo.hasVariable,
            variableCount: variableInfo.paths.length,
            variableTemplate: variableInfo.variableTemplate ? clone(variableInfo.variableTemplate) : null,
            floors,
            tracked,
            missing,
        };
    }

    function getMissingCount() {
        return getCoverage().missing;
    }

    // ------------------------------------------------------------------
    // LLM 调用（独立连接，口径同 subsummary：超时/重试/双通道）
    // ------------------------------------------------------------------

    function extractText(raw) {
        if (typeof raw !== 'string' || raw.trim() === '') {
            console.error('[Chat History Optimization] 角色状态追踪 API 响应结构异常:', raw);
            throw new Error('API 响应结构异常');
        }
        let text = raw.trim();
        const fence = text.match(/```(?:[a-zA-Z]*\n)?([\s\S]*?)```/);
        if (fence) text = fence[1].trim();
        if (text === '') throw new Error('API 响应内容为空');
        return text;
    }

    // LLM 输出 → JSON 对象（兼容 code fence 包裹与前后杂文本；非对象/解析失败即错）。
    // 键为角色名，值为该角色的可变状态子树；空对象表示无变化。
    function extractStates(raw) {
        const text = extractText(raw);
        const objStart = text.indexOf('{');
        const objEnd = text.lastIndexOf('}');
        if (objStart === -1 || objEnd === -1 || objEnd <= objStart) {
            console.error('[Chat History Optimization] 角色状态追踪输出不是 JSON 对象，当前 LLM 完整回复:', raw);
            throw new Error('追踪输出不是 JSON 对象');
        }
        let parsed = null;
        try {
            parsed = JSON.parse(text.slice(objStart, objEnd + 1));
        } catch (e) {
            console.error('[Chat History Optimization] 角色状态追踪输出 JSON 解析失败，当前 LLM 完整回复:', raw, e);
            throw new Error('追踪输出 JSON 解析失败');
        }
        if (!isPlainObject(parsed)) {
            console.error('[Chat History Optimization] 角色状态追踪输出不是 JSON 对象，当前 LLM 完整回复:', raw);
            throw new Error('追踪输出不是 JSON 对象');
        }
        const max = getTracksMaxPerFloor();
        const out = {};
        for (const roleName of Object.keys(parsed)) {
            if (!isPlainObject(parsed[roleName])) continue;
            if (Object.keys(parsed[roleName]).length === 0) continue;
            out[roleName] = parsed[roleName];
            if (Object.keys(out).length >= max) break;
        }
        return out;
    }

    async function callLlmViaProfile(content, profileId) {
        const service = NS.bridge.connectionManagerRequest;
        if (!service || typeof service.sendRequest !== 'function') throw new Error('Connection Manager 服务不可用');
        const extra = parseExtraParams();
        const timeoutMs = getRequestTimeoutMs();
        const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        let timer = null;
        const timeoutP = new Promise((_, reject) => {
            timer = setTimeout(() => {
                try { if (controller) controller.abort(); } catch (_) { /* ignore */ }
                reject(new Error(timeoutMessage('Connection profile ', timeoutMs)));
            }, timeoutMs);
        });
        let result;
        try {
            result = await Promise.race([
                service.sendRequest(
                    profileId,
                    [{ role: 'user', content }],
                    getMaxTokens(),
                    { stream: false, signal: controller ? controller.signal : null, extractData: true, includePreset: false, includeInstruct: false, instructSettings: {} },
                    Object.assign({}, extra, { temperature: getTemperature() }),
                ),
                timeoutP,
            ]);
        } catch (e) {
            if (e && typeof e.message === 'string' && e.message.indexOf('请求超时') !== -1) {
                console.error('[Chat History Optimization] 角色状态追踪 connection profile 请求超时:', e);
                throw e;
            }
            if (isAbortError(e) || (controller && controller.signal.aborted)) {
                console.error('[Chat History Optimization] 角色状态追踪 connection profile 请求超时（abort）:', e);
                throw new Error(timeoutMessage('Connection profile ', timeoutMs));
            }
            console.error('[Chat History Optimization] 角色状态追踪 connection profile 请求失败:', e);
            const cause = e && e.cause ? e.cause : null;
            throw new Error(`Connection profile 请求失败${cause && cause.message ? `：${cause.message}` : ''}`);
        } finally {
            if (timer !== null) clearTimeout(timer);
        }
        const raw = result && typeof result === 'object'
            ? (typeof result.content === 'string' ? result.content : null)
            : (typeof result === 'string' ? result : null);
        if (raw === null) {
            console.error('[Chat History Optimization] 角色状态追踪 profile 响应中未提取到 content，当前 LLM 完整回复:', result);
        }
        return extractText(raw);
    }

    async function callLlm(content) {
        const source = String(Settings.get('roleTrackSource') || 'fetch');
        if (source === 'profile') {
            const profileId = String(Settings.get('roleTrackProfileId') || '');
            if (!profileId) throw new Error('未选择 connection profile');
            return callLlmViaProfile(content, profileId);
        }
        const baseUrl = String(Settings.get('roleTrackBaseUrl') || '').trim().replace(/\/+$/, '');
        let url = baseUrl || null;
        if (url && !/\/chat\/completions$/.test(url)) url += '/chat/completions';
        if (!url) throw new Error('API baseUrl 未配置');
        const apiKey = String(Settings.get('roleTrackApiKey') || '').trim();
        const model = String(Settings.get('roleTrackModel') || '').trim();

        const timeoutMs = getRequestTimeoutMs();
        const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        const fetchOptions = {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model,
                messages: [{ role: 'user', content }],
                temperature: getTemperature(),
                max_tokens: getMaxTokens(),
            }),
        };
        if (controller) fetchOptions.signal = controller.signal;
        let timer = null;
        let timedOut = false;
        const timeoutP = new Promise((_, reject) => {
            timer = setTimeout(() => {
                timedOut = true;
                try { if (controller) controller.abort(); } catch (_) { /* ignore */ }
                reject(new Error(timeoutMessage('API ', timeoutMs)));
            }, timeoutMs);
        });
        timeoutP.catch(() => {});
        const doFetch = async () => {
            let response;
            try {
                response = await fetch(url, fetchOptions);
            } catch (e) {
                if (timedOut || isAbortError(e) || (controller && controller.signal.aborted)) {
                    throw new Error(timeoutMessage('API ', timeoutMs));
                }
                console.error('[Chat History Optimization] 角色状态追踪 API 请求失败（网络/CORS 错误）:', e);
                throw new Error('API 请求失败（网络/CORS 错误）');
            }

            if (!response.ok) {
                const text = await response.text().catch(() => '');
                console.error(`[Chat History Optimization] 角色状态追踪 API 返回 ${response.status}:`, text);
                throw new Error(`API 返回 ${response.status}`);
            }

            let data;
            try {
                data = await response.json();
            } catch (e) {
                if (timedOut || isAbortError(e) || (controller && controller.signal.aborted)) {
                    throw new Error(timeoutMessage('API ', timeoutMs));
                }
                console.error('[Chat History Optimization] 角色状态追踪 API 响应不是 JSON:', e);
                throw new Error('API 响应不是 JSON');
            }

            const raw = data && data.choices && data.choices[0] && data.choices[0].message
                ? data.choices[0].message.content
                : null;
            if (raw === null) {
                console.error('[Chat History Optimization] 角色状态追踪 API 响应中未提取到 message.content，当前 LLM 完整回复:', data);
            }
            return extractText(raw);
        };

        try {
            return await Promise.race([doFetch(), timeoutP]);
        } catch (e) {
            if (e && typeof e.message === 'string' && e.message.indexOf('请求超时') !== -1) {
                console.error('[Chat History Optimization] 角色状态追踪 API 请求超时:', e);
            }
            throw e;
        } finally {
            if (timer !== null) clearTimeout(timer);
        }
    }

    // ------------------------------------------------------------------
    // 生成核心（单楼层）
    // ------------------------------------------------------------------

    function buildPromptContent(variableTemplate, roleCards, journeyText) {
        const template = Settings.get('roleTrackPrompt');
        if (!validateRoleTrackTemplate(template)) {
            throw fatal(`角色状态追踪模板无效（需非空且包含 ${TEMPLATE_PLACEHOLDER}、${ROLELIST_PLACEHOLDER}、${JOURNEY_PLACEHOLDER}）`);
        }
        return String(template)
            .split(TEMPLATE_PLACEHOLDER).join(JSON.stringify(variableTemplate, null, 2))
            .split(ROLELIST_PLACEHOLDER).join(JSON.stringify(roleCards, null, 2))
            .split(JOURNEY_PLACEHOLDER).join(journeyText);
    }

    // 单楼层追踪。返回 'ok'（已生成，含空对象）/ 'skip'（已有效且非 force）/
    // 'empty'（本楼层无历程，无需追踪）。失败时抛错。
    async function runOne(floor, force) {
        if (!isConfigured()) {
            throw fatal('请先在"角色状态"选项卡选择 connection profile 或配置直连的 baseUrl、apiKey 和模型');
        }
        const entries = getFloorEntries(floor);
        if (entries.length === 0) return 'empty';
        const variableInfo = getVariableInfo();
        if (!variableInfo.hasVariable) {
            throw fatal('角色卡模板中未检测到 <可变> 标记：请在角色卡模板的属性行 // 注释中标记可变属性');
        }
        const journeyText = getFloorJourneyText(entries);
        const roleCards = getFloorRoleCards(journeyText);
        const hash = floorHash(variableInfo.variableTemplate, entries);
        if (!force && isSlotValid(floor, hash)) return 'skip';
        if (Object.keys(roleCards).length === 0) {
            // 历程中未出现已知角色：记空对象，避免重复入队消耗 LLM。
            writeFloorSlot(floor, {}, hash);
            return 'ok';
        }
        const content = buildPromptContent(variableInfo.variableTemplate, roleCards, journeyText);
        const raw = await callLlm(content);
        const states = extractStates(raw);
        writeFloorSlot(floor, states, hash);
        return 'ok';
    }

    async function runOneWithRetry(floor, force) {
        const maxRetries = (Constants && typeof Constants.MAX_RETRIES === 'number' && Constants.MAX_RETRIES >= 0)
            ? Math.floor(Constants.MAX_RETRIES) : 3;
        const delayMs = (Constants && typeof Constants.RETRY_DELAY_MS === 'number' && Constants.RETRY_DELAY_MS > 0)
            ? Math.floor(Constants.RETRY_DELAY_MS) : 1000;
        let lastErr = null;
        // 重试时复用 runOne（其内部重算输入，楼层未变则输入一致），
        // 失败（含超时）等待后重试。
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                return await runOne(floor, force);
            } catch (e) {
                lastErr = e;
                if (e && e.noRetry) break;
                if (attempt < maxRetries) {
                    console.warn(`[Chat History Optimization] 角色状态追踪失败，${delayMs}ms 后重试（第 ${attempt + 1}/${maxRetries} 次）:`, e);
                    await new Promise(r => setTimeout(r, delayMs));
                }
            }
        }
        throw lastErr;
    }

    function collectMissingFloors() {
        const chat = getChat();
        const out = [];
        if (!chat || !Array.isArray(chat)) return out;
        const variableInfo = getVariableInfo();
        if (!variableInfo.hasVariable) return out;
        for (let floor = 1; floor < chat.length; floor++) {
            if (!isAssistantItem(chat[floor])) continue;
            const entries = getFloorEntries(floor);
            if (entries.length === 0) continue;
            const hash = floorHash(variableInfo.variableTemplate, entries);
            if (!isSlotValid(floor, hash)) out.push(floor);
        }
        return out;
    }

    function collectAllTrackableFloors() {
        const chat = getChat();
        const out = [];
        if (!chat || !Array.isArray(chat)) return out;
        for (let floor = 1; floor < chat.length; floor++) {
            if (!isAssistantItem(chat[floor])) continue;
            if (getFloorEntries(floor).length === 0) continue;
            out.push(floor);
        }
        return out;
    }

    // 多楼层 worker 池并行执行，统一维护状态总线（trailing 节流口径同 subsummary）。
    async function executeBatch(floors, force, counter) {
        const total = floors.length;
        if (total === 0) return;
        let done = counter.done;
        let failed = counter.failed;
        const interval = (Constants && typeof Constants.SUBSUMMARY_STATUS_NOTIFY_INTERVAL_MS === 'number'
            && Constants.SUBSUMMARY_STATUS_NOTIFY_INTERVAL_MS > 0)
            ? Math.floor(Constants.SUBSUMMARY_STATUS_NOTIFY_INTERVAL_MS) : 300;
        let lastNotifyAt = counter.lastNotifyAt || 0;
        let throttleTimer = null;
        let pendingPatch = null;
        const emitStatus = (patch) => {
            pendingPatch = Object.assign({}, pendingPatch, patch);
            const now = Date.now();
            if (now - lastNotifyAt >= interval) {
                lastNotifyAt = now;
                const flush = pendingPatch;
                pendingPatch = null;
                notifyStatus(flush);
            } else if (throttleTimer === null) {
                throttleTimer = setTimeout(() => {
                    throttleTimer = null;
                    lastNotifyAt = Date.now();
                    const flush = pendingPatch;
                    pendingPatch = null;
                    if (flush) notifyStatus(flush);
                }, interval - (now - lastNotifyAt));
            }
        };
        try {
            const concurrency = Math.min(getConcurrency(), total);
            let next = 0;
            async function worker() {
                while (true) {
                    const k = next++;
                    if (k >= total) return;
                    const floor = floors[k];
                    emitStatus({ running: true, current: `第${counter.seq + k + 1}个 · 楼层${floor}状态追踪`, done, failed, error: null, lastDone: null });
                    try {
                        const result = await runOneWithRetry(floor, force);
                        if (result === 'ok') {
                            done++;
                            emitStatus({ done, lastDone: { floor } });
                        }
                    } catch (e) {
                        failed++;
                        counter.lastError = String((e && e.message) || e);
                        emitStatus({ failed, lastDone: null });
                        console.error(`[Chat History Optimization] 楼层${floor}状态追踪失败:`, e);
                    }
                }
            }
            const workers = [];
            for (let w = 0; w < concurrency; w++) workers.push(worker());
            await Promise.all(workers);
        } finally {
            if (throttleTimer !== null) {
                clearTimeout(throttleTimer);
                throttleTimer = null;
            }
            pendingPatch = null;
            counter.done = done;
            counter.failed = failed;
            counter.seq += total;
            counter.lastNotifyAt = lastNotifyAt;
        }
    }

    function ensureFloors(floors, force) {
        const run = async () => {
            running = true;
            notifyStatus({ running: true, current: '', done: 0, failed: 0, error: null, message: null, lastDone: null });
            const counter = { done: 0, failed: 0, seq: 0, lastNotifyAt: 0, lastError: null };
            try {
                if (floors.length > 0) {
                    await executeBatch(floors, force, counter);
                }
                if (counter.done > 0 && typeof NS.bridge.saveChatDebounced === 'function') NS.bridge.saveChatDebounced();
            } finally {
                running = false;
                notifyStatus({
                    running: false,
                    current: '',
                    done: counter.done,
                    failed: counter.failed,
                    error: counter.failed > 0 ? `失败 ${counter.failed} 个${counter.lastError ? '：' + counter.lastError : ''}` : null,
                    message: (counter.failed === 0 && counter.done === 0) ? '状态追踪均已有效，无需生成' : null,
                    lastDone: null,
                });
            }
            return { done: counter.done, failed: counter.failed, total: counter.seq };
        };
        const p = batchChain.then(run, run);
        batchChain = p.catch(() => {});
        return p;
    }

    function ensureMissing(force) {
        if (!force) return ensureFloors(collectMissingFloors(), false);
        return ensureFloors(collectAllTrackableFloors(), true);
    }

    function generateMissing() {
        if (running) {
            console.warn('[Chat History Optimization] 角色状态追踪进行中，忽略本次请求');
            return false;
        }
        return ensureMissing(false).catch((e) => {
            console.error('[Chat History Optimization] 角色状态追踪补齐失败:', e);
            return { done: 0, failed: 0, total: 0 };
        });
    }

    function forceRebuild() {
        if (running) {
            console.warn('[Chat History Optimization] 角色状态追踪进行中，忽略本次请求');
            return false;
        }
        eraseAll(true);
        return ensureMissing(true).catch((e) => {
            console.error('[Chat History Optimization] 角色状态追踪重建失败:', e);
            return { done: 0, failed: 0, total: 0 };
        });
    }

    function generateForFloor(floor, options) {
        if (running) {
            console.warn('[Chat History Optimization] 角色状态追踪进行中，忽略本次请求');
            return false;
        }
        const force = Boolean(options && options.force);
        const run = async () => {
            running = true;
            notifyStatus({ running: true, current: `楼层${floor}状态追踪`, done: 0, failed: 0, error: null, message: null, lastDone: null });
            let done = 0;
            let failed = 0;
            let error = null;
            try {
                const result = await runOneWithRetry(floor, force);
                if (result === 'ok') done = 1;
                else if (result === 'skip' || result === 'empty') error = null;
            } catch (e) {
                failed = 1;
                error = String((e && e.message) || e);
                console.error(`[Chat History Optimization] 楼层${floor}状态追踪失败:`, e);
            } finally {
                running = false;
                notifyStatus({
                    running: false,
                    current: '',
                    done,
                    failed,
                    error,
                    message: (failed === 0 && done === 0) ? '该楼层状态追踪已有效，无需生成' : null,
                    lastDone: done === 1 ? { floor } : null,
                });
            }
            return failed === 0;
        };
        const p = batchChain.then(run, run);
        batchChain = p.catch(() => {});
        return p.catch(() => false);
    }

    // 擦除全部楼层追踪（不动开关与历程原文；silent 时不广播完成文案，供重建前调用）。
    function eraseAll(silent) {
        if (running && !silent) {
            notifyStatus({ running: false, current: '', done: 0, failed: 0, error: '追踪进行中，请稍后再擦除', message: null, lastDone: null });
            return 0;
        }
        const chat = getChat();
        let erased = 0;
        if (chat && Array.isArray(chat)) {
            for (let floor = 1; floor < chat.length; floor++) {
                const item = chat[floor];
                if (item && typeof item === 'object' && item.extra && typeof item.extra === 'object' && item.extra[EXTRA_KEY]) {
                    delete item.extra[EXTRA_KEY];
                    erased++;
                }
            }
            if (erased > 0 && typeof NS.bridge.saveChatDebounced === 'function') NS.bridge.saveChatDebounced();
        }
        if (!silent) {
            notifyStatus({
                running: false,
                current: '',
                done: 0,
                failed: 0,
                error: null,
                message: erased > 0 ? `已擦除 ${erased} 个楼层的角色状态追踪` : '没有可擦除的角色状态追踪',
                lastDone: null,
            });
        }
        return erased;
    }

    // ------------------------------------------------------------------
    // 顺序合并：按楼层顺序把各楼层 states 对象合并为 {角色名: 可变子树}。
    // 后楼层赢：对象递归合并，其余（含数组）整体覆盖（状态快照语义）。
    // 未知键按当前角色卡模板校验跳过（防 LLM 幻觉污染）。
    // ------------------------------------------------------------------

    function roleShapeOf(roleName, characterTemplate) {
        if (!characterTemplate || typeof characterTemplate !== 'object') return null;
        if (Object.prototype.hasOwnProperty.call(characterTemplate, roleName)) {
            return characterTemplate[roleName];
        }
        for (const key of Object.keys(characterTemplate)) {
            if (key.length >= 4 && key[0] === '{' && key[1] === '{' && key.endsWith('}}')) {
                return characterTemplate[key];
            }
        }
        return null;
    }

    function shapeHasPath(shape, pathArr) {
        let current = shape;
        for (let i = 0; i < pathArr.length; i++) {
            if (!isPlainObject(current)) return false;
            const key = pathArr[i];
            if (Object.prototype.hasOwnProperty.call(current, key)) {
                current = current[key];
                continue;
            }
            // 嵌套动态键回退（与 Engine.checkPath 同约定）
            const dynKeys = Object.keys(current).filter((k) => k.length >= 4 && k.startsWith('{{') && k.endsWith('}}'));
            if (dynKeys.length === 1) {
                current = current[dynKeys[0]];
                continue;
            }
            return false;
        }
        return true;
    }

    function mergeValidated(target, delta, basePath, shape) {
        if (!isPlainObject(delta)) return clone(delta);
        if (!isPlainObject(target)) target = {};
        for (const key of Object.keys(delta)) {
            const path = basePath.concat([key]);
            if (shape && !shapeHasPath(shape, path)) {
                console.warn(`[Chat History Optimization] 角色状态追踪跳过未知键: ${path.join(' -> ')}`);
                continue;
            }
            const dv = delta[key];
            const tv = target[key];
            if (isPlainObject(dv) && isPlainObject(tv)) {
                mergeValidated(tv, dv, path, shape);
            } else if (isPlainObject(dv)) {
                target[key] = clone(dv);
            } else {
                target[key] = clone(dv);
            }
            if (target[key] === '') delete target[key];
        }
        return target;
    }

    // chatRef 缺省读实时 chat；Engine.buildPromptData 传入其深拷贝以保证一致性。
    function getMergedStates(chatRef) {
        const acc = {};
        const chat = chatRef || getChat();
        if (!chat || !Array.isArray(chat)) return acc;
        const EngineRef = NS.Engine;
        const raw = Settings.get('characterPrompt');
        const characterTemplate = EngineRef && typeof EngineRef.parseTemplate === 'function'
            ? EngineRef.parseTemplate(typeof raw === 'string' ? raw : '')
            : null;
        for (let floor = 1; floor < chat.length; floor++) {
            const slot = readFloorSlot(floor, chat);
            const states = slotStates(slot);
            if (!states) continue;
            for (const roleName of Object.keys(states)) {
                const subtree = states[roleName];
                if (!isPlainObject(subtree)) continue;
                const shape = characterTemplate ? roleShapeOf(roleName, characterTemplate) : null;
                if (!acc[roleName]) acc[roleName] = {};
                mergeValidated(acc[roleName], subtree, [], shape);
            }
        }
        return acc;
    }

    // Engine.buildPromptData 在淘汰/蒸馏后调用：追踪赢，但不复活已淘汰角色。
    function applyToCharacterData(characterData, chatRef) {
        if (!characterData || typeof characterData !== 'object' || Array.isArray(characterData)) return characterData;
        let states = null;
        try {
            states = getMergedStates(chatRef);
        } catch (e) {
            console.error('[Chat History Optimization] 角色状态合并读取失败', e);
            return characterData;
        }
        const roles = states ? Object.keys(states) : [];
        if (roles.length === 0) return characterData;
        const EngineRef = NS.Engine;
        const raw = Settings.get('characterPrompt');
        const characterTemplate = EngineRef && typeof EngineRef.parseTemplate === 'function'
            ? EngineRef.parseTemplate(typeof raw === 'string' ? raw : '')
            : null;
        for (const roleName of roles) {
            if (!Object.prototype.hasOwnProperty.call(characterData, roleName)) continue;
            const shape = characterTemplate ? roleShapeOf(roleName, characterTemplate) : null;
            try {
                mergeValidated(characterData[roleName], states[roleName], [], shape);
            } catch (e) {
                console.error(`[Chat History Optimization] 角色 ${roleName} 状态合并失败`, e);
            }
        }
        return characterData;
    }

    // ------------------------------------------------------------------
    // 自动触发：助手新回复到达后，后台追踪缺失楼层（不阻塞发送）
    // ------------------------------------------------------------------

    function onMessageReceived(messageId) {
        if (running) return;
        let toggle = true;
        try {
            toggle = Settings.get('roleTrackToggle');
        } catch (e) {
            toggle = true;
        }
        if (!toggle) return;
        if (!isConfigured()) return;
        const chat = getChat();
        if (!chat || !Array.isArray(chat)) return;
        const floor = (typeof messageId === 'number' && !isNaN(messageId)) ? Math.floor(messageId) : (chat.length - 1);
        const item = chat[floor];
        // 用户消息不产生 L0，直接返回；助手消息走全量缺失收集（覆盖并发到达）。
        if (item && typeof item === 'object' && ('is_user' in item) && item.is_user) return;
        if (item && typeof item === 'object' && item.role && item.role !== 'assistant' && !('is_user' in item)) return;
        ensureMissing(false).catch((e) => {
            console.error('[Chat History Optimization] 自动追踪角色状态失败:', e);
        });
    }

    function init() {
        if (initialized) return;
        initialized = true;
        try {
            const bridge = NS.bridge;
            if (bridge && bridge.eventSource && bridge.eventTypes && bridge.eventTypes.MESSAGE_RECEIVED) {
                bridge.eventSource.on(bridge.eventTypes.MESSAGE_RECEIVED, onMessageReceived);
            }
        } catch (e) {
            console.error('[Chat History Optimization] 角色状态追踪事件订阅失败', e);
        }
    }

    NS.RoleTrack = Object.freeze({
        EXTRA_KEY,
        VARIABLE_TAG,
        TEMPLATE_PLACEHOLDER,
        ROLELIST_PLACEHOLDER,
        JOURNEY_PLACEHOLDER,
        isConfigured,
        getProfileOptions,
        validateRoleTrackTemplate,
        validateExtraParams,
        parseExtraParams,
        extractVariablePaths,
        getVariableInfo,
        getFloorEntries,
        getFloorJourneyText,
        getFloorRoleCards,
        getCoverage,
        getMissingCount,
        getMergedStates,
        applyToCharacterData,
        generateMissing,
        generateForFloor,
        forceRebuild,
        eraseAll,
        onStatus,
        getStatus,
        init,
    });

    init();
})();

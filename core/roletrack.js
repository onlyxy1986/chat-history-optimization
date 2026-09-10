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
// 存储：各楼层 extra[EXTRA_KEY] = {v: 2, h, th, eh, states, t}，states 为输出对象，
//   h 为（可变模版+本楼层 L0）组合哈希（旧存档仅有 h，仍按 h 校验）；th/eh 为
//   模板与历程的细分哈希（新存档写入，用于过期原因诊断）；楼层重写/模板变更即
//   标脏（stale），只重追该楼层。stale 存档仍参与最终合并（显式擦除前不丢数据），
//   UI 以“已过期”展示存档与原因，而非“尚未追踪”。
// 合并：Engine.buildPromptData 在角色卡淘汰后调 applyToCharacterData，
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

    // 发送前删除 <可变> 标记文本，避免模型将其误解为角色卡内容。
    // 只删标记本身，保留同一行的其余注释说明。
    function stripVariableTag(text) {
        if (typeof text !== 'string' || text === '') return text;
        return text.split(VARIABLE_TAG).join('');
    }

    // 原始模板文本 → 保留注释的可变状态模版文本。
    // 与 extractVariablePaths 同一行一属性假设、同一切分口径（首个 // 为注释起点）：
    // 有键行：任一键整体可变或通向可变后代即保留整行；无键行：根层骨架保留，
    // 收尾括号按其所属层级的保留状态取舍，纯注释行仅在可变子树内保留。
    // 保留行统一删除 <可变> 标记后原样输出（含其余注释）。
    function buildVariableTemplateText(rawText, variablePaths) {
        if (typeof rawText !== 'string' || rawText === '') return '';
        if (!variablePaths || variablePaths.size === 0) return '';
        const lines = rawText.split('\n');
        const stack = [];
        const keepStack = [];
        const out = [];
        for (const line of lines) {
            const commentAt = line.indexOf('//');
            const jsonPart = commentAt === -1 ? line : line.slice(0, commentAt);
            const keys = [];
            const re = /"((?:[^"\\]|\\.)*)"\s*:/g;
            let m = null;
            while ((m = re.exec(jsonPart)) !== null) {
                keys.push(m[1]);
            }
            const opens = (jsonPart.match(/[{[]/g) || []).length;
            const closes = (jsonPart.match(/[}\]]/g) || []).length;
            const net = opens - closes;

            let keep = false;
            if (keys.length > 0) {
                for (const key of keys) {
                    const full = stack.concat([key]);
                    if (pathUnderVariable(full, variablePaths) || hasVariableDescendant(full, variablePaths)) {
                        keep = true;
                        break;
                    }
                }
            } else if (stack.length === 0) {
                keep = true;
            } else if (net < 0) {
                const n = Math.min(-net, keepStack.length);
                for (let i = 0; i < n; i++) {
                    if (keepStack[keepStack.length - 1 - i]) {
                        keep = true;
                        break;
                    }
                }
                if (keepStack.length === 0) {
                    keep = pathUnderVariable(stack, variablePaths) || hasVariableDescendant(stack, variablePaths);
                }
            } else if (jsonPart.trim() === '') {
                keep = pathUnderVariable(stack, variablePaths);
            } else {
                keep = pathUnderVariable(stack, variablePaths) || hasVariableDescendant(stack, variablePaths);
            }

            if (keep) out.push(stripVariableTag(line));

            if (net > 0) {
                if (keys.length > 0) {
                    const lastFull = stack.concat([keys[keys.length - 1]]);
                    const flag = pathUnderVariable(lastFull, variablePaths) || hasVariableDescendant(lastFull, variablePaths);
                    stack.push(keys[keys.length - 1]);
                    keepStack.push(flag);
                    for (let i = 1; i < net; i++) {
                        stack.push(keys[keys.length - 1]);
                        keepStack.push(flag);
                    }
                }
            } else if (net < 0) {
                for (let i = 0; i < -net && stack.length > 0; i++) {
                    stack.pop();
                    keepStack.pop();
                }
            }
        }
        return out.join('\n');
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

    // 只读解析当前角色卡模板 → {hasVariable, paths, template, variableTemplate, variableTemplateText}。
    // variableTemplate 为过滤后的对象（合并/校验用）；variableTemplateText 为
    // 同一子树的保留注释文本（发送给 LLM 用，已删除 <可变> 标记）。
    function getVariableInfo() {
        const EngineRef = NS.Engine;
        const raw = Settings.get('characterPrompt');
        const rawText = typeof raw === 'string' ? raw : '';
        const template = EngineRef && typeof EngineRef.parseTemplate === 'function'
            ? EngineRef.parseTemplate(rawText)
            : null;
        if (!template || typeof template !== 'object' || Array.isArray(template)) {
            return { hasVariable: false, paths: [], template: null, variableTemplate: null, variableTemplateText: null };
        }
        const variablePaths = extractVariablePaths(rawText);
        if (variablePaths.size === 0) {
            return { hasVariable: false, paths: [], template, variableTemplate: null, variableTemplateText: null };
        }
        const variableTemplate = filterVariableValue(template, [], variablePaths);
        if (!variableTemplate || typeof variableTemplate !== 'object' || Object.keys(variableTemplate).length === 0) {
            return { hasVariable: false, paths: [...variablePaths], template, variableTemplate: null, variableTemplateText: null };
        }
        const variableTemplateText = buildVariableTemplateText(rawText, variablePaths);
        return { hasVariable: true, paths: [...variablePaths], template, variableTemplate, variableTemplateText };
    }

    // 可变模板解析缓存：UI 快照（getCoverage）高频调用，模板文本不变时
    // 直接复用上次结果，避免每次重复 parseTemplate + 行级扫描。
    // 生成路径（runOne/collectMissingFloors）仍按需实时解析，不走缓存，
    // 语义不变。缓存对象只读，调用方需 clone 后再对外返回。
    let cachedVarRaw = null;
    let cachedVarInfo = null;

    function getVariableInfoCached() {
        let rawText = '';
        try {
            const raw = Settings.get('characterPrompt');
            rawText = typeof raw === 'string' ? raw : '';
        } catch (e) {
            rawText = '';
        }
        if (cachedVarInfo && cachedVarRaw === rawText) return cachedVarInfo;
        const info = getVariableInfo();
        cachedVarRaw = rawText;
        cachedVarInfo = info;
        return info;
    }

    // ------------------------------------------------------------------
    // 楼层 L0 读取与角色列表（注意：UI 快照 getCoverage 不走角色匹配，
    // 只读 extra + hash；角色匹配仅生成路径 runOne 按需调用）
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

    // 已知角色卡全集单次获取（Engine.getKnownRoleCards 每次深拷贝全聊天并全量
    // mergeDataInfo，直接在循环内调用即 O(楼层²)）。同步循环内 chat 不可变，
    // 调用方只读过滤，故单次快照复用与逐次获取结果一致。
    function getKnownCardsOnce() {
        const EngineRef = NS.Engine;
        if (!EngineRef || typeof EngineRef.getKnownRoleCards !== 'function') return {};
        try {
            return EngineRef.getKnownRoleCards() || {};
        } catch (e) {
            return {};
        }
    }

    // 本楼层历程中出现的角色的完整角色卡（已知全集按文本过滤，含消歧义）。
    // 返回 {角色名: 角色卡}，无匹配时返回空对象。
    // knownCards 可选：传入时直接复用（getCoverage 批量路径），不传入时单次获取
    // （单楼层 runOne 路径，保持向后兼容）。返回值为对全集值的引用，调用方只读勿改。
    function getFloorRoleCards(journeyText, knownCards) {
        const EngineRef = NS.Engine;
        if (!EngineRef || typeof EngineRef.nameMatches !== 'function') return {};
        const cards = (knownCards !== undefined) ? knownCards : getKnownCardsOnce();
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

    function floorHash(variableTemplateOrText, floorEntries) {
        return fnv1a32(JSON.stringify({ v: variableTemplateOrText || null, e: floorEntries || [] }));
    }

    function hashOfVariableInfo(variableInfo) {
        return (variableInfo.variableTemplateText && variableInfo.variableTemplateText.trim() !== '')
            ? variableInfo.variableTemplateText
            : variableInfo.variableTemplate;
    }

    // 细分哈希：模板与历程分开存，用于过期原因诊断（模板已变更 / 本楼层历程已变更）。
    // h 保持组合哈希不变（向后兼容旧存档）；th/eh 为新增字段，旧存档缺失时原因记 unknown。
    function templateHashOf(variableInfo) {
        return fnv1a32(JSON.stringify(hashOfVariableInfo(variableInfo) || null));
    }

    function entriesHashOf(floorEntries) {
        return fnv1a32(JSON.stringify(floorEntries || []));
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

    function writeFloorSlot(floor, states, hash, hashesOpt) {
        const chat = getChat();
        if (!chat || !Array.isArray(chat) || floor < 1 || floor >= chat.length) return false;
        const item = chat[floor];
        if (!item || typeof item !== 'object') return false;
        if (!item.extra || typeof item.extra !== 'object' || Array.isArray(item.extra)) item.extra = {};
        const slot = { v: 2, h: hash, states: clone(states) || {}, t: Date.now() };
        if (hashesOpt && typeof hashesOpt.th === 'string') slot.th = hashesOpt.th;
        if (hashesOpt && typeof hashesOpt.eh === 'string') slot.eh = hashesOpt.eh;
        item.extra[EXTRA_KEY] = slot;
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
    // 只读快照：各楼层追踪覆盖（UI 与合并共用，不触发 LLM）。
    // 轻量口径：只读 extra + hash（可变模板缓存 + 楼层故事块缓存），
    // 不做全聊天深拷贝、不做角色名匹配。roles 取已存 states 的键
    // （从未追踪的楼层为空数组，不再预览“待追踪谁”；已过期的楼层保留
    // 存档键以便 UI 展示过期存档）；生成路径 runOne
    // 仍按需调 getFloorRoleCards 计算出场角色，不受影响。
    // 状态三分：valid=已追踪有效；stale=有存档但哈希过期（模板/历程已变更，
    // 存档仍参与最终合并，UI 必须展示而非报“尚未追踪”）；无存档=从未追踪。
    // missing 保持“非有效”总数（stale + untracked，向后兼容）；
    // 新增 stale/untracked 供 UI 展示细分。
    // ------------------------------------------------------------------

    function getCoverage(chatRef) {
        const chat = chatRef || getChat();
        const variableInfo = getVariableInfoCached();
        const curTh = variableInfo.hasVariable ? templateHashOf(variableInfo) : null;
        const floors = [];
        let tracked = 0;
        let stale = 0;
        let untracked = 0;
        if (chat && Array.isArray(chat)) {
            for (let floor = 1; floor < chat.length; floor++) {
                const item = chat[floor];
                if (!isAssistantItem(item)) continue;
                const entries = getFloorEntries(floor);
                if (entries.length === 0) continue;
                const hash = variableInfo.hasVariable ? floorHash(hashOfVariableInfo(variableInfo), entries) : null;
                const curEh = entriesHashOf(entries);
                const slot = readFloorSlot(floor, chat);
                const valid = !!slot && !!hash && slot.h === hash;
                const hasSlot = !!slot;
                const isStale = hasSlot && !valid;
                let dirtyReason = null;
                if (isStale) {
                    if (typeof slot.th === 'string' && typeof slot.eh === 'string' && curTh !== null) {
                        const thMatch = slot.th === curTh;
                        const ehMatch = slot.eh === curEh;
                        if (!thMatch) dirtyReason = 'template';
                        else if (!ehMatch) dirtyReason = 'story';
                        else dirtyReason = 'unknown';
                    } else {
                        dirtyReason = 'unknown';
                    }
                }
                if (valid) tracked++;
                else if (isStale) stale++;
                else untracked++;
                const states = slot ? clone(slotStates(slot)) : null;
                floors.push({
                    floor,
                    count: entries.length,
                    roles: states ? Object.keys(states) : [],
                    states,
                    valid,
                    hasSlot,
                    stale: isStale,
                    dirtyReason,
                    t: (slot && typeof slot.t === 'number') ? slot.t : 0,
                });
            }
        }
        return {
            hasVariable: variableInfo.hasVariable,
            variableCount: variableInfo.paths.length,
            variableTemplate: variableInfo.variableTemplate ? clone(variableInfo.variableTemplate) : null,
            variableTemplateText: variableInfo.variableTemplateText || null,
            floors,
            tracked,
            stale,
            untracked,
            missing: stale + untracked,
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

    function buildPromptContent(variableTemplateOrText, roleCards, journeyText) {
        const template = Settings.get('roleTrackPrompt');
        if (!validateRoleTrackTemplate(template)) {
            throw fatal(`角色状态追踪模板无效（需非空且包含 ${TEMPLATE_PLACEHOLDER}、${ROLELIST_PLACEHOLDER}、${JOURNEY_PLACEHOLDER}）`);
        }
        const variableText = typeof variableTemplateOrText === 'string'
            ? variableTemplateOrText
            : JSON.stringify(variableTemplateOrText, null, 2);
        return String(template)
            .split(TEMPLATE_PLACEHOLDER).join(variableText)
            .split(ROLELIST_PLACEHOLDER).join(JSON.stringify(roleCards, null, 2))
            .split(JOURNEY_PLACEHOLDER).join(journeyText);
    }

    // 可变状态模版的发送文本：保留注释的子树文本（已删 <可变> 标记），
    // 无文本时回退为对象 JSON（兼容单行模板等极端情况）。
    function promptVariableText(variableInfo) {
        if (variableInfo.variableTemplateText && variableInfo.variableTemplateText.trim() !== '') {
            return variableInfo.variableTemplateText;
        }
        return JSON.stringify(variableInfo.variableTemplate, null, 2);
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
        const hash = floorHash(hashOfVariableInfo(variableInfo), entries);
        const hashes = { th: templateHashOf(variableInfo), eh: entriesHashOf(entries) };
        if (!force && isSlotValid(floor, hash)) return 'skip';
        if (Object.keys(roleCards).length === 0) {
            // 历程中未出现已知角色：记空对象，避免重复入队消耗 LLM。
            writeFloorSlot(floor, {}, hash, hashes);
            return 'ok';
        }
        const content = buildPromptContent(promptVariableText(variableInfo), roleCards, journeyText);
        const raw = await callLlm(content);
        const states = extractStates(raw);
        writeFloorSlot(floor, states, hash, hashes);
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
            const hash = floorHash(hashOfVariableInfo(variableInfo), entries);
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
    // 注意：此处有意合并全部存档（含哈希过期的 stale）：过期存档是“需要重追”的
    // 提示信号，不是“已丢弃”——丢弃只由 eraseAll/forceRebuild 显式执行。
    // UI 的 getCoverage 用 valid/stale/untracked 三分展示，stale 卡片会明确提示
    // “存档仍参与最终合并”，避免“页面全缺失但合并仍生效”的困惑。
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

    // Engine.buildPromptData 在淘汰后调用：追踪赢，但不复活已淘汰角色。
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
        stripVariableTag,
        buildVariableTemplateText,
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

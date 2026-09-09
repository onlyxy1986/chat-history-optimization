// ============================================================================
// chat-optimization-v2 settings store.
// Settings live in extension_settings["chat-optimization-v2"].
// ============================================================================
(function () {
    'use strict';

    const NS = window.ChatOptimizationV2 = window.ChatOptimizationV2 || {};
    const { extensionSettings, saveSettingsDebounced } = NS.bridge;

    const EXTENSION_NAME = 'chat-optimization-v2';

    const defaultSettings = {
        extensionToggle: false,
        roleCardToggle: true, // 角色卡功能开关，默认启用
        keepCount: 3,
        tokenLimit: 50 * 1024,
        historyPrompt: `{
    // **注意** 所有时间表述都**必须**用第X天+时间段的表述，如：第3天傍晚
    // 地点: 用.分隔大小地点，如“图书馆.三楼.阅览室”、“酒馆.二楼.卫生间”
    "故事历程": [ // **每次回复强制输出，仅针对最新回复做历程记录**
        {
            "天数":"第1天",
            "时间段":"清晨/上午/中午/下午/傍晚/晚上/深夜/凌晨",
            "地点":"地点",
            "历程":"{{总结当前消息要点，需用词明确，主客体清晰 要求:1.必须保留所有关键细节，比如重要动作、暗示、数字、人数、人物、物品、时间、日期、日程安排、说明、描述、地点、要求、承诺、言语、规则、事实、推断、招式名、对话、安排等 2.使用角色名代替人称，不要用模糊指代 3.NSFW场景用词需极简 4.相对时间记录时必须转为绝对时间，例如:相约明天(第13天)去逛街}}"
        }
        // ...
    ]
}`,
        characterPrompt: `{
    "{{角色名}}": {
        "职业": "{{职业}}", // <可变>
        "年龄": "{{年龄}}",
        "性别": "男/女",
        "人物小传": "{{客观概括人物在故事开始前的人生经历和个性风格，不涉及人物主观想法，不随故事更新}}",
        "身体特征": {
            "身高": "具体数值+整体体型给人的印象（如丰腴肉感/纤腰硕乳/筋肉结实等）",
            "面容": "五官特征+肤色+习惯性的表情或神态",
            "头发": "发色+长度+发质",
            "胸部": "胸围数值+罩杯+形状+乳肉触感与弹性+乳晕颜色大小+乳头大小形态与挺翘度",
            "腰部": "腰围数值+腰臀比例+手感",
            "臀部": "尺寸+形状+走动时的晃动程度+肉感与回弹力+承托力",
            "腿部": "腿长数值+身腿比例+腿型线条+大腿内侧的肉感",
            "阴部": "花瓣形态与厚薄+颜色深浅+阴蒂大小形态+松紧度+敏感带与反应",
            "后穴": "颜色深浅+褶皱形态+松紧度+是否开发过+承受力",
            "足部": "足型+趾型+肤色+是否敏感",
            "处女": "是/否，如果是处女第一次性交时必须要描写破处的情况"
        }
    }
    // ... 其他角色
}`,
        subSummaryToggle: true, // 分层摘要总开关（只控制 AI 回复后的自动生成，手动生成不受限）
        subSummarySource: 'fetch', // 'fetch' = 直连 OpenAI 兼容接口；'profile' = 使用 SillyTavern connection profile（仅 CC 类型）
        subSummaryBaseUrl: '', // OpenAI 兼容 API 的 baseUrl
        subSummaryApiKey: '', // API Key
        subSummaryModel: '', // 模型名
        subSummaryProfileId: '', // 选中的 SillyTavern connection profile id（source 为 profile 时生效）
        subSummaryExtraParams: '', // profile 模式的附加参数（JSON 对象，经 overridePayload 发往 ST 服务端；fetch 模式忽略）
        subSummaryTemperature: 0.3,
        subSummaryMaxTokens: 512,
        subSummaryConcurrency: 4, // 分层摘要批量生成的并行数（1 = 串行；上限见 Constants.SUBSUMMARY_CONCURRENCY_MAX）
        subSummaryTimeoutSec: 120, // 单次 LLM 请求超时（秒），钳制范围见 Constants.SUBSUMMARY_TIMEOUT_MIN/MAX_MS
        hierFanin: 5, // L(k≥2) 合并扇入：连续几个 L(k-1) 节点合并成一条父摘要（钳制范围见 Constants.HIER_FANIN_MIN/MAX）
        hierDayPrompt: `你是故事摘要助手。请将以下"当天历程"（同一天的全部故事历程条目）压缩为一条天摘要，只输出摘要正文，不要输出任何其他内容。
要求：
1. 用词明确，主客体清晰，必须用角色名，不要用代词
2. 保留所有关键细节：重要动作、人物、物品、地点、时间、数字、承诺、安排等
3. 相对时间必须转为绝对时间（如"明天"改为"第X天"）
4. NSFW场景用词需极简
当天历程：
{{当天历程}}`,
        hierMergePrompt: `你是故事摘要助手。请将以下"子摘要列表"（连续若干天的摘要）合并压缩为一条上层摘要，只输出摘要正文，不要输出任何其他内容。
要求：
1. 用词明确，主客体清晰，必须用角色名，不要用代词
2. 保留主线脉络与关键细节，合并重复内容
3. 相对时间必须转为绝对时间（如"明天"改为"第X天"）
子摘要列表：
{{子摘要列表}}`,
        roleTrackToggle: true, // 角色状态追踪总开关（只控制助手回复后的自动追踪，手动生成不受限）
        roleTrackSource: 'fetch', // 'fetch' = 直连 OpenAI 兼容接口；'profile' = 使用 SillyTavern connection profile（仅 CC 类型）
        roleTrackBaseUrl: '', // OpenAI 兼容 API 的 baseUrl
        roleTrackApiKey: '', // API Key
        roleTrackModel: '', // 模型名
        roleTrackProfileId: '', // 选中的 SillyTavern connection profile id（source 为 profile 时生效）
        roleTrackExtraParams: '', // profile 模式的附加参数（JSON 对象，经 overridePayload 发往 ST 服务端；fetch 模式忽略）
        roleTrackTemperature: 0.3,
        roleTrackMaxTokens: 512,
        roleTrackConcurrency: 4, // 批量补齐缺失追踪时的并行数（1 = 串行；上限见 Constants.ROLETRACK_CONCURRENCY_MAX）
        roleTrackTimeoutSec: 120, // 单次 LLM 请求超时（秒），钳制范围复用 SUBSUMMARY_TIMEOUT_MIN/MAX_MS
        roleTrackPrompt: `你是角色状态追踪助手。请根据"本次故事历程"推断各角色可变状态的变化，只输出 JSON Object，不要输出任何其他内容。
要求：
1. 只输出在本次故事历程中有状态变化的角色，无变化的角色不要输出；若均无变化则输出 {}。
2. 数组每一项为一个有状态变化的角色的"可变状态模版"（与下方"可变状态模版"同树形，角色名键替换为实际角色名），只探测"可变状态模版"中列出的属性变化。

可变状态模版：
{{可变状态模版}}

角色列表：
{{角色列表}}

本次故事历程：
{{故事历程}}`,
    };

    function getSettings() {
        extensionSettings[EXTENSION_NAME] = Object.assign({}, defaultSettings, extensionSettings[EXTENSION_NAME] || {});
        return extensionSettings[EXTENSION_NAME];
    }

    function get(key) {
        const settings = getSettings();
        return settings[key] ?? defaultSettings[key];
    }

    function set(key, value) {
        getSettings()[key] = value;
        saveSettingsDebounced();
    }

    NS.Settings = Object.freeze({
        EXTENSION_NAME,
        defaultSettings,
        getSettings,
        get,
        set,
    });
})();

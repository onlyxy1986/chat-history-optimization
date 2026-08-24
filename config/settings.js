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
        ragToggle: false, // RAG 远端记忆分层注入开关，默认关闭
        ragRatio: 0.3, // RAG 远端历程区段占 tokenLimit 的预算比例
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
        characterPrompt: `{ // **仅新角色出现时输出**
        "{{角色名}}": { //所有角色都必须有完整的角色卡
            "角色设定": { // [角色设定]：此部分包含角色的**不可更改的**核心基础设定，是判断角色行为是否OOC的最高依据。
                "角色名": "{{角色名}}",
                "职业": "{{职业}}",
                "年龄": "{{年龄}}",
                "性别": "男/女",
                "背景": "{{客观概括人物在故事开始前的人生经历，不涉及人物主观想法，不随故事更新}}",
                "永久身体特征": { // 身体的固有特征或不可逆的改变，以下示例为**必填**部位，也可根据需要新增其他部位:
                    // 格式. "部位":"特征描述"
                    // 必填: "身高": "具体数值+整体体型给人的色气印象（如丰腴肉感/纤腰硕乳/筋肉结实等）"
                    // 必填: "面容": "五官特征+肤色+最能勾起欲望的表情或神态"
                    // 必填: "头发": "发色+长度+发质+散落时的色气姿态"
                    // 必填: "胸部": "胸围数值+罩杯+形状与下垂度+乳肉触感与弹性+乳晕颜色大小+乳头大小形态与挺翘度+受刺激时的反应"
                    // 必填: "腰部": "腰围数值+腰臀比例+被握住时的手感"
                    // 必填: "臀部": "尺寸+形状（如蜜桃/满月/心形）+走动时的晃动程度+肉感与回弹力+承托力"
                    // 必填: "腿部": "腿长数值+身腿比例+腿型线条+大腿内侧的肉感+交缠时的触感"
                    // 必填: "阴部": "花瓣形态与厚薄+颜色深浅+阴蒂大小形态+松紧度+敏感带与反应"
                    // 必填: "后穴": "颜色深浅+褶皱形态+松紧度+是否开发过+承受力"
                    // 必填: "足部": "足型+趾型+肤色+是否敏感"
                    // 必填: "处女": "是/否"
                }
            }
        }
        // ... 其他角色
}`,
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

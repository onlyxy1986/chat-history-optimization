// The main script for the extension
// The following are examples of some basic extension functionality

//You'll likely need to import extension_settings, getContext, and loadExtensionSettings from extensions.js
import { extension_settings, getContext, loadExtensionSettings } from "../../../extensions.js";

//You'll likely need to import some other functions from the main script
import { saveSettingsDebounced } from "../../../../script.js";

const context = SillyTavern.getContext();

// Keep track of where your extension is located, name should match repo name
const extensionName = "chat-history-optimization";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
const defaultSettings = {
    extensionToggle: false,
    keepCount: 3,
    detailsRegex: "+<details>((?:(?!<details>)[\\s\\S])*?)<\\/details>",
    contentRegex: "+<content[\\s\\S]*?<\\/content>"
};

let totalCharsSaved = 0;
// Loads the extension settings if they exist, otherwise initializes them to the defaults.
async function loadSettings() {
    //Create the settings if they don't exist
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    if (Object.keys(extension_settings[extensionName]).length === 0 || !Object.keys(defaultSettings).every(key => key in extension_settings[extensionName])) {
        Object.assign(extension_settings[extensionName], defaultSettings);
    }

    // Updating settings in the UI
    $("#extension_toggle").prop("checked", extension_settings[extensionName].extensionToggle).trigger("input");
    $("#keep_count").prop("value", extension_settings[extensionName].keepCount).trigger("input");
    $("#details_regex").prop("value", extension_settings[extensionName].detailsRegex).trigger("input");
    $("#content_regex").prop("value", extension_settings[extensionName].contentRegex).trigger("input");
}

function onToggleInput(event) {
    const value = Boolean($(event.target).prop("checked"));
    extension_settings[extensionName].extensionToggle = value;
    saveSettingsDebounced();
}

function onKeepCountInput(event) {
    const value = parseInt($(event.target).prop("value"));
    extension_settings[extensionName].keepCount = value;
    saveSettingsDebounced();
}

function validateRegexList(regexStr) {
    const lines = regexStr.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    for (const line of lines) {
        let pattern = line;
        if (line.startsWith('+') || line.startsWith('-')) {
            pattern = line.slice(1).trim();
        }
        if (!pattern) continue;
        try {
            new RegExp(pattern, 'gi');
        } catch (e) {
            return false;
        }
    }
    return true;
}

function updateRegexStatusLabels() {
    // detailsRegex
    const detailsValue = $("#details_regex").val();
    const detailsValid = validateRegexList(detailsValue);
    $("#details_regex_status").text(detailsValid ? "valid regex(s)" : "invalid regex(s)")
        .css("color", detailsValid ? "green" : "red");

    // contentRegex
    const contentValue = $("#content_regex").val();
    const contentValid = validateRegexList(contentValue);
    $("#content_regex_status").text(contentValid ? "valid regex(s)" : "invalid regex(s)")
        .css("color", contentValid ? "green" : "red");
}


function onDetailsRegexInput(event) {
    const value = $(event.target).prop("value");
    extension_settings[extensionName].detailsRegex = value;
    updateRegexStatusLabels();
    onDetailsPreviewToggle(false);
    saveSettingsDebounced();
}

function onContentRegexInput(event) {
    const value = $(event.target).prop("value");
    extension_settings[extensionName].contentRegex = value;
    updateRegexStatusLabels();
    onContentPreviewToggle(false);
    saveSettingsDebounced();
}

function findlastAssistantMessage(chat) {
    for (let i = chat.length - 1; i >= 0; i--) {
        if (!chat[i]['is_user'] && chat[i]['mes']) {
            return chat[i]['mes'];
        }
    }
    return null;
}

function onDetailsPreviewToggle(changeStatus = true) {
    const $textarea = $("#details-preview-textarea");
    const $arrow = $("#details-preview-arrow");
    const lastAssistantMessage = findlastAssistantMessage(context.chat);
    let previewContent = "未找到摘要内容";
    if (lastAssistantMessage) {
        previewContent = extractByRegexList(lastAssistantMessage, $("#details_regex").val());
    }
    $textarea.val(previewContent);
    if (changeStatus) {
        if ($textarea.is(":visible")) {
            $textarea.hide();
            $arrow.css("transform", "rotate(0deg)");
        } else {
            $textarea.show();
            $arrow.css("transform", "rotate(180deg)");
        }
    }
}

function onContentPreviewToggle(changeStatus = true) {
    const $textarea = $("#content-preview-textarea");
    const $arrow = $("#content-preview-arrow");
    const lastAssistantMessage = findlastAssistantMessage(context.chat);
    let previewContent = "未找到正文内容";
    if (lastAssistantMessage) {
        previewContent = extractByRegexList(lastAssistantMessage, $("#content_regex").val());
    }
    $textarea.val(previewContent);
    if (changeStatus) {
        // Toggle visibility and arrow rotation
        if ($textarea.is(":visible")) {
            $textarea.hide();
            $arrow.css("transform", "rotate(0deg)");
        } else {

            $textarea.show();
            $arrow.css("transform", "rotate(180deg)");
        }
    }
}

function countAssistantCount(chat) {
    let count = 0;
    for (let i = chat.length - 1; i >= 0; i--) {
        let role = chat[i]['is_user'] ? 'user' : 'assistant';
        if (role === 'assistant') {
            count += 1;
        }
    }
    return count;
}

/**
 * 通用正则处理函数
 * @param {string} content - 要处理的文本
 * @param {string} regexStr - 多行正则字符串，每行一个正则
 * 以+开头的正则为保留内容（匹配后用空行拼接），以-开头的正则为排除内容（在所有+处理后移除匹配内容）
 * @returns {string} 匹配结果拼接字符串
 */
function extractByRegexList(content, regexStr) {
    const regexLines = regexStr
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);

    let includeMatches = [];
    let excludeRegexes = [];

    for (const line of regexLines) {
        if (line.startsWith('+')) {
            const pattern = line.slice(1).trim();
            if (!pattern) continue;
            try {
                const regex = new RegExp(pattern, 'gi');
                const matches = [...content.matchAll(regex)].map(m => m[0]);
                includeMatches.push(...matches);
            } catch (e) {
                console.warn(`[Chat History Optimization] Invalid include regex: ${pattern}`);
            }
        } else if (line.startsWith('-')) {
            const pattern = line.slice(1).trim();
            if (!pattern) continue;
            try {
                excludeRegexes.push(new RegExp(pattern, 'gi'));
            } catch (e) {
                console.warn(`[Chat History Optimization] Invalid exclude regex: ${pattern}`);
            }
        }
    }

    let result = includeMatches.join('\n\n');
    for (const ex of excludeRegexes) {
        result = result.replace(ex, '');
    }
    return result;
}

globalThis.replaceChatHistoryWithDetails = async function (chat, contextSize, abort, type) {
    if (!extension_settings[extensionName].extensionToggle) {
        console.info("[Chat History Optimization] extension is disabled.")
        return;
    }

    // 校验正则有效性
    const detailsValid = validateRegexList(extension_settings[extensionName].detailsRegex);
    const contentValid = validateRegexList(extension_settings[extensionName].contentRegex);

    if (!detailsValid || !contentValid) {
        console.error("[Chat History Optimization] Invalid regex detected in " +
            (!detailsValid && !contentValid
                ? "detailsRegex and contentRegex."
                : (!detailsValid ? "detailsRegex." : "contentRegex.")));
        return;
    }

    const assistantCount = countAssistantCount(chat);
    let currentAssistantCount = 0;
    let charsSaved = 0;
    for (let j = 0; j < chat.length; j++) {
        let role = chat[j]['is_user'] ? 'user' : 'assistant';
        if (role === 'assistant' && chat[j]['swipes'] && chat[j]['swipes'][chat[j]['swipe_id']]) {
            currentAssistantCount += 1;
            const content = chat[j]['swipes'][chat[j]['swipe_id']];
            charsSaved += content.length;
            if (assistantCount - currentAssistantCount > extension_settings[extensionName].keepCount) {
                const result = extractByRegexList(content, extension_settings[extensionName].detailsRegex);
                if (result) chat[j]['mes'] = result;
            } else {
                const result = extractByRegexList(content, extension_settings[extensionName].contentRegex);
                if (result) chat[j]['mes'] = result;
            }
            charsSaved -= chat[j]['mes']?.length || 0;
        }
    }
    totalCharsSaved += charsSaved;
    $("#saved-chars").prop("textContent", totalCharsSaved.toLocaleString());
    console.log(`[Chat History Optimization] Compression saved ${charsSaved} chars (cumulative: ${totalCharsSaved} chars since server startup`);
}

// This function is called when the extension is loaded
jQuery(async () => {
    // This is an example of loading HTML from a file
    const settingsHtml = await $.get(`${extensionFolderPath}/index.html`);

    // Append settingsHtml to extensions_settings
    // extension_settings and extensions_settings2 are the left and right columns of the settings menu
    // Left should be extensions that deal with system functions and right should be visual/UI related
    $("#extensions_settings").append(settingsHtml);

    $("#details_regex_label").after('<label id="details_regex_status" style="margin-left:10px;"></label>');
    $("#content_regex_label").after('<label id="content_regex_status" style="margin-left:10px;"></label>');

    $("#extension_toggle").on("input", onToggleInput);
    $("#keep_count").on("input", onKeepCountInput);
    $("#details_regex").on("input", onDetailsRegexInput);
    $("#content_regex").on("input", onContentRegexInput);

    // 绑定预览展开/折叠事件
    $("#details-preview-toggle").on("click", onDetailsPreviewToggle);
    $("#content-preview-toggle").on("click", onContentPreviewToggle);

    // Load settings when starting things up (if you have any)
    loadSettings();
});


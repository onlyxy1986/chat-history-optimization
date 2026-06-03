# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a SillyTavern third-party extension for optimizing chat history by compressing conversation data into structured summaries. It reduces token consumption in long conversations while preserving key information.

## Commands

This is a browser-based SillyTavern extension with no build step, linter, or test suite. Development is done by editing files directly and reloading SillyTavern. The only files that matter are `index.js`, `index.html`, `style.css`, and `manifest.json` — everything else is git metadata.

To test changes: reload SillyTavern, enable the extension in Settings → Extensions → Chat History Optimization, and observe the token count and "failed floors" indicators in the settings panel.

## Architecture

### Core Flow

1. **Registration**: `manifest.json` declares `replaceChatHistoryWithDetails` as a `generate_interceptor`. SillyTavern calls this function (exposed via `globalThis`) before each generation, passing the full chat array.
2. **Delta parsing**: `mergeDataInfo()` scans every assistant message in `chat` for `<delta>...</delta>` JSON blocks (using regex, stripping `//` comments first). It checks both `mes` and `swipes[swipe_id]`, taking only the **last** match per message.
3. **State merging**: Each parsed delta is recursively merged via `deepMerge()` into a single accumulated `ROLE_DATA` object. A snapshot of state after each message is kept in `roledata_history`.
4. **Post-processing** (`postProcess` / `getCharPrompt`): Story events (`故事历程`) are converted to a markdown-like `前文` string. Word mapping sanitizes sensitive terms. Character cards are capped at 10 slots.
5. **History replacement**: The entire chat array is replaced with a single message — the original last message with its `mes` field rewritten to contain the `<ROLE_PLAY>` prompt wrapping the summarized data.
6. **Token enforcement**: If the serialized summary exceeds `tokenLimit`, older story events are thinned by keeping every 50th element until under budget.

### Key Files

- `index.js` — All logic: interceptor, merge, post-processing, settings UI wiring, role viewer
- `index.html` — Settings panel HTML
- `style.css` — Currently empty
- `manifest.json` — Declares extension name, loading order (30), and interceptor function name

### GlobalThis Exports

Two functions are exposed on `globalThis` because they need to be callable from outside the module scope:

- `globalThis.replaceChatHistoryWithDetails(chat, contextSize, abort, type)` — The interceptor; named in manifest.json
- `globalThis.updateRoleSelectAndInfo(roleCardObj)` — Called internally to update the settings UI role dropdown; defined as a global so the jQuery ready callback can reference it

### Data Structure (`ROLE_DATA`)

The accumulated state object has these top-level fields:

- `天数`, `日期`, `星期` — Time tracking
- `故事历程` — Array of story events, each with `天数`, `时间`, `地点`, `历程` (string or array of strings)
- `故事历程总结` — Alternative/merged story summary (deleted after post-processing into `前文`)
- `角色卡` — Map of `roleName → { 角色设定: {...}, 角色状态: {...} }`. `角色设定` is considered immutable once set (except for `处女` field).
- `前文` — Generated context string (markdown-format story events + tail messages)
- `allowUpdate` — Optional boolean flag in delta to bypass `角色设定` immutability

### Key Functions in Detail

**`deepMerge(merged, delta, path, allowUpdate)`**
Recursively merges `delta` into `merged` with special behaviors:
- **Array + string**: If the string matches `delete N-M`, removes that index range from the array. Used for story event deletion.
- **Array + array**: Deduplicates by `JSON.stringify` comparison before concatenating.
- **`角色设定` protection**: If the path contains `角色设定`, existing string values are NOT overwritten (unless the existing value is `"未知"`, the key is `处女`, or `allowUpdate` is true).
- **Unknown key guard**: Only keys that pass `checkPath()` (exist in the JSON template) are added; unknown keys are warned and skipped.
- **Empty value cleanup**: Keys set to `""` are deleted from the object.

**`mergeDataInfo(chat)`**
Scans `chat[1..]` for assistant messages containing `<delta>` blocks. Handles both direct `mes` and `swipes[swipe_id]` fallback. Applies `nameMapping` to normalize character names. Returns `{ roledata, roledata_history }`.

**`postProcess(data)`**
Converts `故事历程` array to markdown `前文` string via `arrayToMarkdown()`, appending existing `前文` if any. Deletes `故事历程` and `故事历程总结` from the object after conversion. Strips any remaining `<delta>` tags from `前文`.

**`getCharPrompt(mergedDataInfo)`**
Wraps the processed role data in a `<ROLE_PLAY>` prompt template with the JSON template schema, instructing the AI to output `<delta>` blocks in its response.

**`checkPath(path)`**
Validates that a JSON key path exists in the loaded `json_template`, supporting `{{placeholder}}` dynamic keys. Returns `true` if the path is valid (including the special `故事历程总结` path). This prevents arbitrary keys from being injected into the merged state.

**`convertDayReferences(text, currentDayOverride)`**
Currently **disabled** — returns `text` unmodified on line 295. The implementation below (lines 296-311) converts absolute "第N天" references to relative "X天前" format, but is skipped via early return.

### Character Card Eviction Strategy

- **Max 10 slots**: `角色卡` is capped at 10 entries.
- **Scoring**: Characters mentioned in the current user prompt get score 1,000,000 (guaranteed retention). Others score by their last appearance index in chat history.
- **Distillation**: Characters inactive for >30 messages (and not in the current prompt) have all fields except `角色设定` stripped — dynamic state (equipment, skills, status) is discarded.
- **Hard removal**: Characters outside the top 10 are physically deleted from `角色卡`.

### Name Alias Resolution (`nameMapping`)

After merging, if a character's `角色设定.角色名` differs from its key in `角色卡`, the key is renamed. This handles cases where the same character is referenced by different names across messages.

### Token Trimming Algorithm

When the serialized summary exceeds `tokenLimit`:
```js
finalRoleDataInfo.故事历程 = finalRoleDataInfo.故事历程.slice(
    Math.floor(finalRoleDataInfo.故事历程.length / 50)
);
```
This keeps the latter portion by discarding the first `length/50` elements, repeating until under budget. This is a coarse but fast trim — it doesn't remove individual events proportionally.

### First Message Detection

If the chat has exactly 2 messages (first assistant greeting + first user input), the prompt is annotated with instructions to generate a full initial `<delta>` including context from `前文`.

### Settings

- `extension_settings[extensionName]` — Persisted via `saveSettingsDebounced()`
- `extensionToggle` — Master on/off
- `keepCount` — Number of last assistant messages kept verbatim in `前文`
- `tokenLimit` — Max token budget for the serialized summary
- `charPrompt` — JSON template (stored as raw text with `//` comments); validated on input by stripping comments and attempting `JSON.parse`

### Word Mapping

The `wordMapping` object replaces sensitive/negative terms in the final output (e.g., `崩溃→恐惧`, `绝望→害怕`). Applied during `getCharPrompt()` via regex replace on the serialized JSON string.

## SillyTavern Extension Conventions

Imports from parent SillyTavern:
- `../../../extensions.js` → `extension_settings`, `getContext`, `loadExtensionSettings`
- `../../../tokenizers.js` → `getTokenCountAsync`
- `../../../../script.js` → `saveSettingsDebounced`, `this_chid`, `characters`

The extension folder name must match `extensionName` (`"chat-history-optimization"`). The `generate_interceptor` value in manifest.json names a function on `globalThis` that SillyTavern calls with `(chat, contextSize, abort, type)`.

## Edge Cases & Gotchas

- **`<delta>` parsing**: Regex strips `//` comments before matching. If no match in `mes`, falls back to `swipes[swipe_id]`. Only the **last** `<delta>` block in a message is used.
- **`keepCount=0` with single assistant**: If keepCount is 0 but there's only 1 assistant message, it's forced to 1 to avoid empty context.
- **`角色设定` immutability**: Once set, character background fields won't be overwritten by subsequent deltas unless `allowUpdate: true` is set in the delta or the existing value is `"未知"`.
- **`前文` from tail messages**: When extracting the last N assistant messages for `前文`, only the text between `</think>`/`</thinking>` and `<post_thinking>`/`<delta>` is kept (the "post-thinking" visible reply).


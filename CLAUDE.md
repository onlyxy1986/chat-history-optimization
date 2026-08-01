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
2. **NEW_STORY_DATA parsing**: `mergeDataInfo()` scans every assistant message in `chat` for `<NEW_STORY_DATA>...</NEW_STORY_DATA>` blocks (using regex, stripping `//` comments first; `swipes[swipe_id]` fallback; only the **last** block per message). Within each block it extracts the `<NEW_HISTORY>` and `<NEW_CHARACTER_CARD>` sections separately. Legacy `<delta>` blocks are **not** recognized.
3. **State merging**: NEW_HISTORY JSON merges into `HISTORY_DATA` (story timeline) and NEW_CHARACTER_CARD JSON merges into `CHARACTER_DATA` (character card map) via `deepMerge()`, each validated against its own template (`history_json_template` / `character_json_template`).
4. **Post-processing**: `postProcessHistory()` converts story events (`故事历程`) to a markdown-like `前文` string. `processCharacterData()` evicts/distills character cards (10-slot cap, 30-message inactivity distillation).
5. **History replacement**: The entire chat array is replaced with a single message — the original last message with its `mes` field rewritten to contain the `<STORY_DATA>` prompt wrapping `<HISTORY>` (markdown 前文) and `<CHARACTER_CARD>` (character JSON).
6. **Token enforcement**: If the serialized summary exceeds `tokenLimit`, older story events are thinned by keeping every 50th element until under budget (hard-stop guard: stops when `故事历程` is empty instead of looping forever).

### Key Files

- `index.js` — All logic: interceptor, merge, post-processing, settings UI wiring, role viewer
- `index.html` — Settings panel HTML
- `style.css` — Currently empty
- `manifest.json` — Declares extension name, loading order (30), and interceptor function name

### GlobalThis Exports

Two functions are exposed on `globalThis` because they need to be callable from outside the module scope:

- `globalThis.replaceChatHistoryWithDetails(chat, contextSize, abort, type)` — The interceptor; named in manifest.json
- `globalThis.updateRoleSelectAndInfo(roleCardObj)` — Called internally to update the settings UI role dropdown; defined as a global so the jQuery ready callback can reference it

### Data Structure

Two independent domain states, merged and processed separately:

`HISTORY_DATA` — Story timeline:
- `正文出场或提及到的角色` — Comma-separated role names mentioned in the current text
- `故事历程` — Array of story events, each with `天数`, `时间`, `地点`, `历程` (string or array of strings). Note: each event carries its own `天数` (the current day is derived from events, not tracked at top level)
- `故事历程总结` — Alternative/merged story summary (deleted after post-processing into `前文`)
- `前文` — Generated context string (markdown-format story events + tail messages)

`CHARACTER_DATA` — Character card map:
- `角色名 → { 角色设定: {...}, 角色状态: {...} }` (no `角色卡` wrapper key — the section is the domain)
- `角色设定` is considered immutable once set (except for `处女` field or `"未知"` values)
- `allowUpdate` — Optional boolean flag in NEW_CHARACTER_CARD JSON to bypass `角色设定` immutability

### Key Functions in Detail

**`deepMerge(merged, delta, path, allowUpdate, template)`**
Recursively merges `delta` into `merged` with special behaviors:
- **Array + string**: If the string matches `delete N-M`, removes that index range from the array. Used for story event deletion.
- **Array + array**: Deduplicates by `JSON.stringify` comparison before concatenating.
- **`角色设定` protection**: If the path contains `角色设定`, existing string values are NOT overwritten (unless the existing value is `"未知"`, the key is `处女`, or `allowUpdate` is true).
- **Unknown key guard**: Only keys that pass `checkPath(path, template)` (against the domain's own template) are added; unknown keys are warned and skipped.
- **Empty value cleanup**: Keys set to `""` are deleted from the object.

**`mergeDataInfo(chat)`**
Scans `chat[1..]` for assistant messages containing `<NEW_STORY_DATA>` blocks, extracting `<NEW_HISTORY>` (mandatory — missing counts as a failed floor) and `<NEW_CHARACTER_CARD>` (optional — legitimately absent when no new characters appear or the role card toggle is off) sections. Returns `{ historyData, characterData }`. Applies `nameMapping` to normalize character names in the character domain. Does **not** recognize legacy `<delta>` blocks.

**`postProcessHistory(data)`**
Converts `故事历程` array to markdown `前文` string via `arrayToMarkdown()`, appending existing `前文` if any. Deletes `故事历程` and `故事历程总结` after conversion. Strips any remaining `<NEW_STORY_DATA>`/`<delta>` tags from `前文`.

**`processCharacterData(characterData, chat, nameMapping)`**
Evicts/distills the character card map: 10-slot cap, current-prompt-mention priority (score 1,000,000), >30-message inactivity → keep only `角色设定`. Returns the trimmed map.

**`getCharPrompt(historyData, characterData)`**
Wraps the processed domains in a `<STORY_DATA>` prompt with `<HISTORY>` (markdown) and `<CHARACTER_CARD>` (JSON) sections, instructing the AI to output `<NEW_STORY_DATA>` (with `<NEW_HISTORY>` and `<NEW_CHARACTER_CARD>` sub-sections) in its reply. When the role card toggle is off, the `<CHARACTER_CARD>` section and `<NEW_CHARACTER_CARD>` template are omitted.

**`checkPath(path, template)`**
Validates that a JSON key path exists in the given domain template (`history_json_template` or `character_json_template`), supporting `{{placeholder}}` dynamic keys. Returns `true` if the path is valid (including the special `故事历程总结` path). This prevents arbitrary keys from being injected into the merged state.

**`convertDayReferences(text, currentDayOverride)`**
Currently **disabled and uncalled** — returns `text` unmodified via early return. Its caller gated on the top-level `天数` field, which was removed. The implementation below converts absolute "第N天" references to relative "X天前" format.

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
historyData.故事历程 = historyData.故事历程.slice(
    Math.floor(historyData.故事历程.length / 50)
);
```
This keeps the latter portion by discarding the first `length/50` elements, repeating until under budget (guarded by a hard stop when `故事历程` is empty). This is a coarse but fast trim — it doesn't remove individual events proportionally.

### First Message Detection

If the chat has exactly 2 messages (first assistant greeting + first user input), the prompt is annotated with instructions to generate a full initial `<NEW_STORY_DATA>` including context from `前文`.

### Settings

- `extension_settings[extensionName]` — Persisted via `saveSettingsDebounced()`
- `extensionToggle` — Master on/off
- `keepCount` — Number of last assistant messages kept verbatim in `前文`
- `tokenLimit` — Max token budget for the serialized summary
- `historyPrompt` / `characterPrompt` — Two independent JSON templates (story timeline / character card), each stored as raw text with `//` comments; validated on input by stripping comments and attempting `JSON.parse`

### Word Mapping

The `wordMapping` object replaces sensitive/negative terms in the final output (e.g., `崩溃→恐惧`, `绝望→害怕`). Applied during `getCharPrompt()` via regex replace on the serialized JSON string.

## SillyTavern Extension Conventions

Imports from parent SillyTavern:
- `../../../extensions.js` → `extension_settings`, `getContext`, `loadExtensionSettings`
- `../../../tokenizers.js` → `getTokenCountAsync`
- `../../../../script.js` → `saveSettingsDebounced`, `this_chid`, `characters`

The extension folder name must match `extensionName` (`"chat-history-optimization"`). The `generate_interceptor` value in manifest.json names a function on `globalThis` that SillyTavern calls with `(chat, contextSize, abort, type)`.

## Edge Cases & Gotchas

- **`<NEW_STORY_DATA>` parsing**: Regex strips `//` comments before matching. If no match in `mes`, falls back to `swipes[swipe_id]`. Only the **last** block per message. Legacy `<delta>` blocks are ignored.
- **`keepCount=0` with single assistant**: If keepCount is 0 but there's only 1 assistant message, it's forced to 1 to avoid empty context.
- **`角色设定` immutability**: Once set, character background fields won't be overwritten by subsequent NEW_CHARACTER_CARD sections unless `allowUpdate: true` is set in the section JSON or the existing value is `"未知"`.
- **`前文` from tail messages**: When extracting the last N assistant messages for `前文`, only the text between `</think>`/`</thinking>` and `<post_thinking>`/`<delta>`/`<NEW_STORY_DATA>` is kept (the "post-thinking" visible reply).


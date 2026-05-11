# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a SillyTavern third-party extension for optimizing chat history by compressing conversation data into structured summaries. It reduces token consumption in long conversations while preserving key information.

## Architecture

### Core Flow
1. The extension registers `replaceChatHistoryWithDetails` as a `generate_interceptor` in `manifest.json`
2. When triggered, it parses `<delta>` JSON blocks from AI responses and merges them into a consolidated state object
3. The full chat history is replaced with a single message containing the summary data plus the last N AI responses
4. Token limits are enforced by trimming older story events

### Key Files
- `index.js` - Main extension logic with the interceptor function
- `index.html` - Settings UI panel
- `style.css` - Styling
- `manifest.json` - Extension metadata and interceptor registration

### Data Structure
The extension maintains a `ROLE_DATA` object containing:
- `天数`, `日期`, `星期` - Time tracking
- `故事历程` - Array of story events with day/time/location/process
- `角色卡` - Character cards with `角色设定` (immutable) and `角色状态` (mutable)
- Various task and item tracking fields

### Key Functions
- `replaceChatHistoryWithDetails()` - Main interceptor that processes chat and generates optimized history
- `mergeDataInfo()` - Parses `<delta>` blocks from all messages and builds merged state
- `deepMerge()` - Recursive merge with special handling for arrays and delete operations
- `getCharPrompt()` - Generates the prompt injected into the last message

### Character Card Management
- Maximum 10 character slots maintained
- Scoring based on recent appearance in chat or explicit mention in current prompt
- Characters inactive for >30 messages have their dynamic state stripped, keeping only `角色设定`

## SillyTavern Extension Conventions

The extension imports from:
- `../../../extensions.js` - `extension_settings`, `getContext`, `loadExtensionSettings`
- `../../../tokenizers.js` - `getTokenCountAsync`
- `../../../../script.js` - `saveSettingsDebounced`, `this_chid`, `characters`

Settings are stored in `extension_settings[extensionName]` and persisted via `saveSettingsDebounced()`.

## Development Notes

- The `generate_interceptor` hook in manifest.json names the global function to call
- The extension uses `globalThis` to expose functions needed by the interceptor
- Word mapping (`wordMapping`) replaces sensitive words in output
- Day references in `故事历程` are converted to relative time (e.g., "X天前") based on current day

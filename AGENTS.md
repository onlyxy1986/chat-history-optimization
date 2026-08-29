# AGENTS.md

SillyTavern third-party extension (browser-side only). No package.json, no build, no lint — verify changes by running `node test/smoke-hybrid-recall.cjs` (Node smoke test, mocks the browser environment) and loading SillyTavern from the parent directory to check the browser console.

## Repo layout

- This directory is its **own git repo** nested inside the SillyTavern install. Commit here, not in the parent repo.
- `manifest.json` — SillyTavern loads `js: index.js` and `css: styles/coo.css`.
- `index.js` — bootstrap only: injects modules, exposes `window.ChatOptimizationV2`. No feature logic here.
- `core/constant.js` → `core/settings.js` → `core/engine.js` → … → `ui/coo-window.js` — feature modules, loaded in this order by the `MODULES` array in index.js. New files must be added to that array.
- `core/constant.js` — all tunable constants, exposed as frozen `NS.Constants` with per-constant adjustment guidance comments. It must stay first in `MODULES` (every other module reads from it). Identity strings (storage keys, DOM ids, model paths) and product data (templates, prompt texts, `wordMapping`, UI labels) deliberately stay in their own modules.

## Hard constraints (breaking these silently breaks the extension)

- Feature modules are **plain scripts, not ES modules**: IIFE + `'use strict'`, sharing state via `window.ChatOptimizationV2` (NS pattern). Only `index.js` uses ESM imports.
- The only access to SillyTavern internals is `NS.bridge` (`extensionSettings`, `saveSettingsDebounced`, `getTokenCountAsync`) set up in index.js. Don't import ST files directly from feature modules.
- `manifest.json` `generate_interceptor` must match the global function `replaceChatHistoryWithDetailsV2` (defined on `globalThis` in `core/engine.js`). Renaming it breaks ST's generation pipeline.
- The interceptor **mutates the `chat` array in place** (replaces history with one message whose `mes` is the merged prompt) and returns nothing — ST in-place interceptor convention.
- Keep `VERSION` in index.js and `version` in manifest.json in sync; `VERSION` is used as a cache-busting query param on module script tags.

## Conventions

- Settings live in `extension_settings["chat-optimization-v2"]`; defaults in `settings.js`. Always read/write via `Settings.get/set` (`set` calls `saveSettingsDebounced`).
- `engine.js` is pure logic, no DOM. UI updates flow through the `Engine.onStats` listener bus; `ui/coo-window.js` subscribes.
- Tunable behavior/performance constants live in `NS.Constants` (`core/constant.js`), not as module-local `const`s. Add new tunables there with an adjustment-guidance comment.
- UI DOM is built entirely with `createElement` — no HTML strings, no jQuery.
- Default templates in `settings.js` and UI labels are Chinese and part of the product data — preserve them, don't translate or "clean up". Template strings are parsed by `parseTemplate`, which strips `//` to end-of-line then `JSON.parse`s; keep default templates valid under that rule.

## Remember to update all documents when modification is made.

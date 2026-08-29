// ============================================================================
// chat-optimization-v2
// SillyTavern chat history optimization plugin entry.
// Keep this file as the loader/bootstrap only; feature logic belongs in modules.
// ============================================================================
import { extension_settings, saveMetadataDebounced } from '../../../extensions.js';
import { chat, saveChatDebounced, saveSettingsDebounced, chat_metadata } from '../../../../script.js';
import { getTokenCountAsync } from '../../../tokenizers.js';
import { eventSource, event_types } from '../../../events.js';
import { ConnectionManagerRequestService } from '../../../extensions/shared.js';

(function () {
    'use strict';

    const NAMESPACE = 'ChatOptimizationV2';
    const VERSION = '2.10.0';
    const baseUrl = new URL('./', import.meta.url).href;

    const MODULES = [
        'config/constant.js',
        'config/settings.js',
        'config/engine.js',
        'config/subsummary.js',
        'config/retrieval.js',
        'config/embedding.js',
        'config/embedstore.js',
        'config/recallcache.js',
        'ui/coo-window.js',
    ];

    if (window[NAMESPACE]?.loaded) {
        console.warn('[chat-optimization-v2] Already loaded, skipping duplicate init.');
        return;
    }

    window[NAMESPACE] = Object.assign(window[NAMESPACE] || {}, {
        loaded: true,
        version: VERSION,
        baseUrl,
        bridge: Object.freeze({
            extensionSettings: extension_settings,
            saveSettingsDebounced,
            saveMetadataDebounced,
            getTokenCountAsync,
            getCurrentChat: () => chat,
            saveChatDebounced,
            getChatMetadata: () => chat_metadata,
            eventSource,
            eventTypes: event_types,
            connectionManagerRequest: ConnectionManagerRequestService,
        }),
    });

    function resolveModule(path) {
        const url = new URL(path, baseUrl);
        url.searchParams.set('v', VERSION);
        return url.href;
    }

    function loadScript(path) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = resolveModule(path);
            script.async = false;
            script.dataset.cooModule = path;
            script.onload = () => resolve(path);
            script.onerror = () => reject(new Error(`Failed to load module: ${path}`));
            document.head.appendChild(script);
        });
    }

    function onDomReady(callback) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', callback, { once: true });
            return;
        }
        callback();
    }

    async function bootstrap() {
        try {
            for (const modulePath of MODULES) {
                await loadScript(modulePath);
            }

            onDomReady(() => {
                window[NAMESPACE].CooWindow?.mount?.();
                console.log(`[chat-optimization-v2] v${VERSION} ready.`);
            });
        } catch (error) {
            console.error('[chat-optimization-v2] Startup failed.', error);
        }
    }

    bootstrap();
})();

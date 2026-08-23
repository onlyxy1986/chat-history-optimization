// ============================================================================
// chat-optimization-v2 floating window UI.
// Layout borrowed from yuzuki-Memory: top bar + left sidebar (feature tabs)
// + workspace pane. DOM is built entirely with createElement (no HTML, no jQuery).
// Entry point: wand extension menu item (see createExtensionMenuEntry).
// ============================================================================
(function () {
    'use strict';

    const NS = window.ChatOptimizationV2 = window.ChatOptimizationV2 || {};
    const Settings = NS.Settings;
    const Engine = NS.Engine;

    const ROOT_ID = 'coo-root';
    const EXTENSION_ENTRY_ID = 'coo-extension-entry';
    const EXTENSION_ROW_ID = 'coo-extension-row';
    const EXTENSION_ICON_ID = 'coo-extension-icon';
    const TAB_STORAGE_KEY = 'coo_active_tab';
    const SIDEBAR_STORAGE_KEY = 'coo_sidebar_collapsed';
    const DISPLAY_NAME = '剧情角色档案';
    const BRAND_ICON = 'fa-solid fa-hourglass-half';

    const TABS = [
        { id: 'settings', label: '基础设置', icon: 'fa-solid fa-sliders' },
        { id: 'templates', label: '模板', icon: 'fa-solid fa-file-code' },
        { id: 'roles', label: '角色查看', icon: 'fa-solid fa-id-card' },
        { id: 'story', label: '故事历程', icon: 'fa-solid fa-route' },
    ];

    let extensionRetryTimer = null;
    let activeTabId = 'settings';
    let selectedRoleName = '';

    // ------------------------------------------------------------------
    // Storage helpers
    // ------------------------------------------------------------------

    function readStorage(key, fallback) {
        try {
            const value = window.localStorage.getItem(key);
            return value === null ? fallback : value;
        } catch (e) {
            return fallback;
        }
    }

    function writeStorage(key, value) {
        try {
            window.localStorage.setItem(key, value);
        } catch (e) {
            // ignore storage errors
        }
    }

    // ------------------------------------------------------------------
    // DOM factories
    // ------------------------------------------------------------------

    function createIcon(className) {
        const icon = document.createElement('i');
        icon.className = className;
        icon.setAttribute('aria-hidden', 'true');
        return icon;
    }

    function createText(tagName, className, text = '') {
        const element = document.createElement(tagName);
        if (className) element.className = className;
        if (text) element.textContent = text;
        return element;
    }

    function createButton(label, className = 'coo-button', iconClass = '') {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className;
        if (iconClass) button.appendChild(createIcon(iconClass));
        if (label) button.appendChild(createText('span', 'coo-button-label', label));
        return button;
    }

    function createIconButton(title, iconClass, className = 'coo-icon-button') {
        const button = createButton('', className, iconClass);
        button.title = title;
        button.setAttribute('aria-label', title);
        return button;
    }

    function createSwitchRow(label, field) {
        const row = document.createElement('label');
        row.className = 'coo-row coo-switch-row';

        const box = document.createElement('span');
        box.className = 'coo-switch';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.dataset.cooField = field;
        box.appendChild(input);
        const track = document.createElement('span');
        track.className = 'coo-switch-track';
        const thumb = document.createElement('span');
        thumb.className = 'coo-switch-thumb';
        track.appendChild(thumb);
        box.appendChild(track);

        const text = createText('span', 'coo-row-label', label);
        row.append(text, box);
        return row;
    }

    function createNumberRow(label, hint, field, options = {}) {
        const row = document.createElement('div');
        row.className = 'coo-row coo-input-row';

        const labelBox = document.createElement('div');
        labelBox.className = 'coo-label-box';
        labelBox.appendChild(createText('span', 'coo-row-label', label));
        if (hint) labelBox.appendChild(createText('small', 'coo-row-hint', hint));
        row.appendChild(labelBox);

        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'coo-input';
        input.dataset.cooField = field;
        if (options.min !== undefined) input.min = options.min;
        if (options.max !== undefined) input.max = options.max;
        if (options.step !== undefined) input.step = options.step;
        row.appendChild(input);
        return row;
    }

    function createStatRow(label, field) {
        const row = document.createElement('div');
        row.className = 'coo-row coo-stat-row';
        row.appendChild(createText('span', 'coo-row-label', label));
        const value = createText('span', 'coo-stat-value', '—');
        value.dataset.cooField = field;
        row.appendChild(value);
        return row;
    }

    function createSection(iconClass, title) {
        const section = document.createElement('div');
        section.className = 'coo-section';
        const header = document.createElement('div');
        header.className = 'coo-section-header';
        header.appendChild(createIcon(iconClass));
        header.appendChild(createText('span', 'coo-section-title', title));
        section.appendChild(header);
        return section;
    }

    function createTemplateBlock(title, field, rows, grow) {
        const block = document.createElement('div');
        block.className = 'coo-template-block';
        if (grow) block.style.flexGrow = String(grow);

        const head = document.createElement('div');
        head.className = 'coo-template-head';
        head.appendChild(createText('span', 'coo-row-label', title));
        const badge = createText('span', 'coo-badge coo-badge-muted', '(检测中)');
        badge.dataset.cooValidity = field;
        const reset = createButton('重置', 'coo-button coo-button-ghost coo-button-sm', 'fa-solid fa-rotate-left');
        reset.dataset.cooReset = field;
        reset.title = `重置${title}`;
        head.append(badge, reset);
        block.appendChild(head);

        const textarea = document.createElement('textarea');
        textarea.className = 'coo-textarea';
        textarea.dataset.cooField = field;
        textarea.rows = rows;
        textarea.spellcheck = false;
        textarea.setAttribute('aria-label', `${title}模板`);
        block.appendChild(textarea);
        return block;
    }

    // ------------------------------------------------------------------
    // Shell construction
    // ------------------------------------------------------------------

    function buildSidebarStatus() {
        const footer = document.createElement('div');
        footer.className = 'coo-sidebar-status';
        footer.setAttribute('aria-label', '运行状态');

        const head = document.createElement('div');
        head.className = 'coo-sidebar-status-head';
        head.appendChild(createIcon('fa-solid fa-gauge-high'));
        head.appendChild(createText('span', 'coo-sidebar-status-title', '运行状态'));
        footer.appendChild(head);

        const failedRow = createStatRow('失败的楼层', 'failedFloors');
        failedRow.title = '失败的楼层';
        const tokenRow = createStatRow('Chat History Token Count', 'tokenCount');
        tokenRow.title = 'Chat History Token Count';
        footer.append(failedRow, tokenRow);
        return footer;
    }

    function buildSidebar() {
        const sidebar = document.createElement('div');
        sidebar.className = 'coo-sidebar';
        sidebar.setAttribute('role', 'navigation');
        sidebar.setAttribute('aria-label', '功能导航');

        const main = document.createElement('div');
        main.className = 'coo-sidebar-main';

        const group = document.createElement('div');
        group.className = 'coo-sidebar-group-label';
        const groupSpan = document.createElement('span');
        groupSpan.textContent = '功能';
        group.appendChild(groupSpan);
        main.appendChild(group);

        for (const tab of TABS) {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'coo-nav-item';
            item.dataset.cooTab = tab.id;
            item.title = tab.label;
            item.appendChild(createIcon(tab.icon));
            item.appendChild(createText('span', 'coo-nav-label', tab.label));
            main.appendChild(item);
        }

        sidebar.appendChild(main);
        sidebar.appendChild(buildSidebarStatus());
        return sidebar;
    }

    function buildShell() {
        const shell = document.createElement('div');
        shell.className = 'coo-shell';
        shell.hidden = true;
        shell.setAttribute('role', 'dialog');
        shell.setAttribute('aria-label', DISPLAY_NAME);

        const bar = document.createElement('div');
        bar.className = 'coo-shell-bar';

        const brand = document.createElement('div');
        brand.className = 'coo-shell-brand';
        brand.appendChild(createIcon(`${BRAND_ICON} coo-shell-logo`));
        brand.appendChild(createText('span', 'coo-shell-title', DISPLAY_NAME));
        const version = createText('span', 'coo-version-badge', `v${NS.version}`);
        brand.appendChild(version);

        const actions = document.createElement('div');
        actions.className = 'coo-shell-actions';
        const closeButton = createIconButton('关闭窗口', 'fa-solid fa-xmark', 'coo-icon-button coo-shell-close');
        closeButton.dataset.cooAction = 'close';
        actions.append(closeButton);

        bar.append(brand, actions);
        shell.appendChild(bar);

        const body = document.createElement('div');
        body.className = 'coo-shell-body';
        body.appendChild(buildSidebar());

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'coo-sidebar-toggle';
        toggle.dataset.cooAction = 'toggleSidebar';
        toggle.title = '折叠侧边栏';
        toggle.setAttribute('aria-label', '折叠侧边栏');
        toggle.appendChild(createIcon('fa-solid fa-chevron-left'));

        const workspace = document.createElement('div');
        workspace.className = 'coo-workspace';

        body.append(toggle, workspace);
        shell.appendChild(body);
        return shell;
    }

    function ensureRoot() {
        let root = document.getElementById(ROOT_ID);
        if (root) return root;

        root = document.createElement('div');
        root.id = ROOT_ID;
        root.className = 'coo-root';
        root.appendChild(buildShell());
        document.body.appendChild(root);
        return root;
    }

    // ------------------------------------------------------------------
    // Tab renderers (each builds its panel content from scratch)
    // ------------------------------------------------------------------

    function updateValidityBadge(scope, field) {
        const badge = scope.querySelector(`[data-coo-validity="${field}"]`);
        if (!badge) return;
        const textarea = scope.querySelector(`[data-coo-field="${field}"]`);
        const valid = Engine.validateTemplate(textarea ? textarea.value : '');
        badge.textContent = valid ? '(有效)' : '(无效)';
        badge.className = `coo-badge ${valid ? 'coo-badge-valid' : 'coo-badge-invalid'}`;
    }

    function renderSettingsTab(panel) {
        const section = createSection('fa-solid fa-sliders', '基础设置');
        section.appendChild(createSwitchRow('启用功能', 'extensionToggle'));
        section.appendChild(createSwitchRow('启用角色卡', 'roleCardToggle'));
        section.appendChild(createNumberRow('正文深度', '（保留的AI最后回复的完整消息数量）', 'keepCount', { min: 0, max: 100, step: 1 }));
        section.appendChild(createNumberRow('Token 限制', '（超限将自动裁剪故事历程）', 'tokenLimit', { min: 0, max: 2000000, step: 1024 }));

        const settings = Settings.getSettings();
        section.querySelector('[data-coo-field="extensionToggle"]').checked = Boolean(settings.extensionToggle);
        section.querySelector('[data-coo-field="roleCardToggle"]').checked = Boolean(settings.roleCardToggle);
        section.querySelector('[data-coo-field="keepCount"]').value = settings.keepCount;
        section.querySelector('[data-coo-field="tokenLimit"]').value = settings.tokenLimit;

        panel.appendChild(section);
    }

    function renderTemplatesTab(panel) {
        const section = createSection('fa-solid fa-file-code', '模板');
        section.appendChild(createTemplateBlock('故事历程 JSON 模板', 'historyPrompt', 14, 40));
        section.appendChild(createTemplateBlock('角色卡 JSON 模板', 'characterPrompt', 10, 60));

        const settings = Settings.getSettings();
        section.querySelector('[data-coo-field="historyPrompt"]').value = settings.historyPrompt;
        section.querySelector('[data-coo-field="characterPrompt"]').value = settings.characterPrompt;
        updateValidityBadge(section, 'historyPrompt');
        updateValidityBadge(section, 'characterPrompt');

        panel.appendChild(section);
    }

    function renderRolesTab(panel) {
        const section = createSection('fa-solid fa-id-card', '角色查看');
        const select = document.createElement('select');
        select.className = 'coo-select';
        select.dataset.cooField = 'roleSelect';
        select.setAttribute('aria-label', '角色选择');
        const info = document.createElement('div');
        info.className = 'coo-role-info';
        info.dataset.cooField = 'roleInfo';
        section.append(select, info);
        panel.appendChild(section);
        renderRoleSelect(panel);
        renderRoleInfo(panel);
    }

    function createStoryRangeField(label, field) {
        const fieldBox = document.createElement('div');
        fieldBox.className = 'coo-story-range-field';
        fieldBox.appendChild(createText('label', 'coo-row-label', label));
        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'coo-input';
        input.dataset.cooField = field;
        input.min = 1;
        input.placeholder = '全部';
        fieldBox.appendChild(input);
        return fieldBox;
    }

    function buildStoryEntry(entry) {
        const item = document.createElement('div');
        item.className = 'coo-story-item';
        const head = document.createElement('div');
        head.className = 'coo-story-item-head';
        head.appendChild(createText('span', 'coo-story-floor', `楼层 ${entry.floor}`));
        const meta = [entry.天数, entry.时间段, entry.地点].filter(Boolean).join(' · ');
        head.appendChild(createText('span', 'coo-story-item-meta', meta));
        item.appendChild(head);
        if (entry.历程) {
            item.appendChild(createText('div', 'coo-story-item-body', entry.历程));
        }
        return item;
    }

    function renderStoryResult(scope, result) {
        const info = scope.querySelector('[data-coo-field="storyInfo"]');
        const list = scope.querySelector('[data-coo-field="storyList"]');
        if (!info || !list) return;
        info.textContent = `楼层 ${result.startFloor} - ${result.endFloor}，共 ${result.entries.length} 条历程`;
        list.textContent = '';
        if (result.entries.length === 0) {
            list.appendChild(createText('span', 'coo-role-empty', '该楼层范围内没有新的故事历程'));
            return;
        }
        for (const entry of result.entries) {
            list.appendChild(buildStoryEntry(entry));
        }
    }

    function queryStoryRange(scope, start, end) {
        renderStoryResult(scope, Engine.getStoryProgressRange(start, end));
    }

    function handleStoryAction(scope, action) {
        const startInput = scope.querySelector('[data-coo-field="storyStart"]');
        const endInput = scope.querySelector('[data-coo-field="storyEnd"]');
        if (action === 'storyAll') {
            if (startInput) startInput.value = '1';
            if (endInput) endInput.value = '';
            queryStoryRange(scope, 1, '');
        } else if (action === 'storyQuery') {
            queryStoryRange(scope, startInput ? startInput.value : '1', endInput ? endInput.value : '');
        }
    }

    function renderStoryTab(panel) {
        const section = createSection('fa-solid fa-route', '故事历程');

        const toolbar = document.createElement('div');
        toolbar.className = 'coo-story-toolbar';
        toolbar.appendChild(createStoryRangeField('起始楼层', 'storyStart'));
        toolbar.appendChild(createStoryRangeField('结束楼层', 'storyEnd'));
        const queryButton = createButton('查看', 'coo-button coo-button-sm', 'fa-solid fa-magnifying-glass');
        queryButton.dataset.cooAction = 'storyQuery';
        queryButton.title = '查看指定楼层范围的故事历程';
        const allButton = createButton('全部楼层', 'coo-button coo-button-ghost coo-button-sm', 'fa-solid fa-arrows-up-down');
        allButton.dataset.cooAction = 'storyAll';
        allButton.title = '查看全部楼层的故事历程';
        toolbar.append(queryButton, allButton);
        section.appendChild(toolbar);

        const info = createText('div', 'coo-story-info', '—');
        info.dataset.cooField = 'storyInfo';
        const list = document.createElement('div');
        list.className = 'coo-story-list';
        list.dataset.cooField = 'storyList';
        section.append(info, list);
        panel.appendChild(section);

        const startInput = section.querySelector('[data-coo-field="storyStart"]');
        const endInput = section.querySelector('[data-coo-field="storyEnd"]');
        startInput.value = '1';
        endInput.value = '';
        queryStoryRange(section, 1, '');
    }

    const TAB_RENDERERS = {
        settings: renderSettingsTab,
        templates: renderTemplatesTab,
        roles: renderRolesTab,
        story: renderStoryTab,
    };

    function renderActiveTab(shell) {
        const workspace = shell.querySelector('.coo-workspace');
        if (!workspace) return;
        workspace.textContent = '';

        const panel = document.createElement('div');
        panel.className = 'coo-tab-panel';
        panel.dataset.cooTab = activeTabId;
        (TAB_RENDERERS[activeTabId] || renderSettingsTab)(panel);
        workspace.appendChild(panel);

        updateStatsValues(shell);

        shell.querySelectorAll('.coo-nav-item').forEach((item) => {
            item.classList.toggle('coo-nav-item-active', item.dataset.cooTab === activeTabId);
            item.setAttribute('aria-pressed', item.dataset.cooTab === activeTabId ? 'true' : 'false');
        });
    }

    function setActiveTab(shell, tabId) {
        if (!TABS.some((tab) => tab.id === tabId)) return;
        activeTabId = tabId;
        writeStorage(TAB_STORAGE_KEY, tabId);
        renderActiveTab(shell);
    }

    // ------------------------------------------------------------------
    // Stats + role renderers (scoped to the current workspace)
    // ------------------------------------------------------------------

    function updateStatsValues(scope) {
        const stats = Engine.getStats();
        scope.querySelectorAll('[data-coo-field="failedFloors"]').forEach((failed) => {
            failed.textContent = stats.failedFloors.length > 0 ? stats.failedFloors.join(', ') : '无';
            failed.classList.toggle('coo-stat-bad', stats.failedFloors.length > 0);
        });
        scope.querySelectorAll('[data-coo-field="tokenCount"]').forEach((token) => {
            token.textContent = String(stats.tokenCount);
        });
    }

    function buildRoleTree(container, roleObj) {
        container.textContent = '';
        if (!roleObj || typeof roleObj !== 'object') {
            container.appendChild(createText('span', 'coo-role-empty', '无信息'));
            return;
        }

        function render(obj, parent, depth) {
            for (const key of Object.keys(obj)) {
                const value = obj[key];
                const row = document.createElement('div');
                row.className = 'coo-role-row';
                row.style.paddingLeft = `${depth * 22}px`;

                const label = document.createElement('b');
                label.className = 'coo-role-key';
                label.textContent = `${key}:`;
                row.appendChild(label);

                if (value !== null && typeof value === 'object') {
                    const child = document.createElement('div');
                    child.className = 'coo-role-children';
                    row.appendChild(child);
                    render(value, child, depth + 1);
                } else {
                    row.appendChild(createText('span', 'coo-role-value', String(value)));
                }
                parent.appendChild(row);
            }
        }

        render(roleObj, container, 0);
    }

    function renderRoleSelect(scope) {
        const stats = Engine.getStats();
        const select = scope.querySelector('[data-coo-field="roleSelect"]');
        if (!select) return;

        const roles = stats.roles || {};
        const names = Object.keys(roles);
        if (selectedRoleName && !roles[selectedRoleName]) selectedRoleName = '';

        const previous = select.value;
        select.textContent = '';
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = names.length > 0 ? '请选择角色' : '无角色';
        select.appendChild(placeholder);
        for (const name of names) {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = name;
            select.appendChild(option);
        }
        select.value = selectedRoleName || (names.includes(previous) ? previous : '');
    }

    function renderRoleInfo(scope) {
        const info = scope.querySelector('[data-coo-field="roleInfo"]');
        if (!info) return;
        const stats = Engine.getStats();
        const role = stats.roles?.[selectedRoleName];
        if (!selectedRoleName || !role) {
            info.textContent = '';
            info.appendChild(createText('span', 'coo-role-empty', '请选择角色以查看信息'));
            return;
        }
        buildRoleTree(info, role);
    }

    function refreshActiveTabData(shell) {
        const workspace = shell.querySelector('.coo-workspace');
        if (!workspace) return;
        updateStatsValues(shell);
        if (activeTabId === 'roles') {
            renderRoleSelect(workspace);
            renderRoleInfo(workspace);
        } else if (activeTabId === 'story') {
            const startInput = workspace.querySelector('[data-coo-field="storyStart"]');
            const endInput = workspace.querySelector('[data-coo-field="storyEnd"]');
            if (startInput && endInput) {
                queryStoryRange(workspace, startInput.value, endInput.value);
            }
        }
    }

    // ------------------------------------------------------------------
    // Sidebar collapse
    // ------------------------------------------------------------------

    function setSidebarCollapsed(shell, collapsed) {
        const body = shell.querySelector('.coo-shell-body');
        const toggle = shell.querySelector('[data-coo-action="toggleSidebar"]');
        if (body) body.classList.toggle('coo-sidebar-collapsed', collapsed);
        if (toggle) {
            toggle.textContent = '';
            toggle.appendChild(createIcon(collapsed ? 'fa-solid fa-chevron-right' : 'fa-solid fa-chevron-left'));
            toggle.title = collapsed ? '展开侧边栏' : '折叠侧边栏';
            toggle.setAttribute('aria-label', collapsed ? '展开侧边栏' : '折叠侧边栏');
        }
        writeStorage(SIDEBAR_STORAGE_KEY, collapsed ? '1' : '0');
    }

    // ------------------------------------------------------------------
    // Interactions
    // ------------------------------------------------------------------

    function bindShell(shell) {
        if (shell.dataset.cooBound) return;
        shell.dataset.cooBound = 'true';

        shell.querySelector('[data-coo-action="close"]').addEventListener('click', () => {
            shell.hidden = true;
        });

        shell.querySelectorAll('.coo-nav-item').forEach((item) => {
            item.addEventListener('click', () => setActiveTab(shell, item.dataset.cooTab));
        });

        shell.querySelector('[data-coo-action="toggleSidebar"]').addEventListener('click', () => {
            const body = shell.querySelector('.coo-shell-body');
            setSidebarCollapsed(shell, !body.classList.contains('coo-sidebar-collapsed'));
        });

        const workspace = shell.querySelector('.coo-workspace');

        workspace.addEventListener('input', (event) => {
            const field = event.target && event.target.dataset ? event.target.dataset.cooField : null;
            if (!field) return;
            switch (field) {
                case 'extensionToggle':
                    Settings.set('extensionToggle', Boolean(event.target.checked));
                    break;
                case 'roleCardToggle':
                    Settings.set('roleCardToggle', Boolean(event.target.checked));
                    break;
                case 'keepCount': {
                    const value = parseInt(event.target.value);
                    Settings.set('keepCount', isNaN(value) ? 0 : value);
                    break;
                }
                case 'tokenLimit': {
                    const value = parseInt(event.target.value);
                    Settings.set('tokenLimit', isNaN(value) ? 0 : value);
                    break;
                }
                case 'historyPrompt':
                    Settings.set('historyPrompt', event.target.value);
                    updateValidityBadge(workspace, 'historyPrompt');
                    break;
                case 'characterPrompt':
                    Settings.set('characterPrompt', event.target.value);
                    updateValidityBadge(workspace, 'characterPrompt');
                    break;
                default:
                    break;
            }
        });

        workspace.addEventListener('change', (event) => {
            const field = event.target && event.target.dataset ? event.target.dataset.cooField : null;
            if (field === 'roleSelect') {
                selectedRoleName = event.target.value;
                renderRoleInfo(workspace);
            }
        });

        workspace.addEventListener('click', (event) => {
            const target = event.target;
            const closest = target && target.closest ? target.closest.bind(target) : null;
            const actionButton = closest ? closest('[data-coo-action]') : null;
            if (actionButton) {
                handleStoryAction(workspace, actionButton.dataset.cooAction);
                return;
            }
            const resetButton = closest ? closest('[data-coo-reset]') : null;
            if (!resetButton) return;
            const field = resetButton.dataset.cooReset;
            const textarea = workspace.querySelector(`[data-coo-field="${field}"]`);
            if (!textarea) return;
            textarea.value = Settings.defaultSettings[field];
            Settings.set(field, textarea.value);
            updateValidityBadge(workspace, field);
        });

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !shell.hidden) {
                shell.hidden = true;
            }
        });

        setSidebarCollapsed(shell, readStorage(SIDEBAR_STORAGE_KEY, '0') === '1');
    }

    function onStatsChanged() {
        const root = document.getElementById(ROOT_ID);
        const shell = root ? root.querySelector('.coo-shell') : null;
        if (!shell || shell.hidden) return;
        refreshActiveTabData(shell);
    }

    // ------------------------------------------------------------------
    // Shell visibility
    // ------------------------------------------------------------------

    function toggleShell(forceOpen = false) {
        const root = ensureRoot();
        const shell = root.querySelector('.coo-shell');
        if (!shell) return;
        shell.hidden = forceOpen ? false : !shell.hidden;
        if (!shell.hidden) {
            renderActiveTab(shell);
            Engine.refreshStats();
        }
    }

    // ------------------------------------------------------------------
    // Extension menu entry (wand dropdown), borrowed from yuzuki-Memory
    // ------------------------------------------------------------------

    function getExtensionMenuHost() {
        return document.getElementById('extensionsMenu');
    }

    function createExtensionMenuEntry() {
        const entry = document.createElement('div');
        entry.id = EXTENSION_ENTRY_ID;
        entry.className = 'extension_container interactable coo-extension-entry';
        entry.title = DISPLAY_NAME;
        entry.setAttribute('role', 'button');
        entry.setAttribute('aria-label', DISPLAY_NAME);
        entry.tabIndex = 0;

        const row = document.createElement('div');
        row.id = EXTENSION_ROW_ID;
        row.className = 'list-group-item flex-container flexGap5 interactable coo-extension-row';
        row.setAttribute('role', 'listitem');
        row.tabIndex = 0;
        row.title = DISPLAY_NAME;

        const icon = document.createElement('div');
        icon.id = EXTENSION_ICON_ID;
        icon.className = `fa-fw ${BRAND_ICON} extensionsMenuExtensionButton coo-extension-icon`;
        icon.setAttribute('role', 'button');
        icon.tabIndex = 0;

        const label = createText('span', 'coo-extension-label', DISPLAY_NAME);

        row.append(icon, label);
        entry.appendChild(row);

        const handleOpen = (event) => {
            event.preventDefault();
            event.stopPropagation();
            toggleShell();
        };

        entry.addEventListener('click', handleOpen);
        row.addEventListener('click', handleOpen);
        entry.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') handleOpen(event);
        });
        row.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') handleOpen(event);
        });

        return entry;
    }

    function mountExtensionMenuEntry() {
        const host = getExtensionMenuHost() || document.getElementById('top-settings-holder');
        if (!host) return false;

        let entry = document.getElementById(EXTENSION_ENTRY_ID);
        if (!entry) {
            entry = createExtensionMenuEntry();
        }

        if (entry.parentElement !== host) {
            host.insertBefore(entry, host.firstChild);
        }

        return true;
    }

    function watchExtensionMenuButton() {
        const button = document.getElementById('extensionsMenuButton');
        if (!button || button.dataset.cooBound === 'true') return;

        button.dataset.cooBound = 'true';
        button.addEventListener('click', () => {
            window.setTimeout(mountExtensionMenuEntry, 0);
            window.setTimeout(mountExtensionMenuEntry, 100);
        });
    }

    function startExtensionEntryRetry() {
        if (mountExtensionMenuEntry()) return;
        let extensionAttempts = 0;
        window.clearInterval(extensionRetryTimer);
        extensionRetryTimer = window.setInterval(() => {
            extensionAttempts += 1;
            watchExtensionMenuButton();
            if (mountExtensionMenuEntry() || extensionAttempts >= 30) {
                window.clearInterval(extensionRetryTimer);
                extensionRetryTimer = null;
            }
        }, 500);
    }

    // ------------------------------------------------------------------
    // Mount
    // ------------------------------------------------------------------

    function mount() {
        const root = ensureRoot();
        const shell = root.querySelector('.coo-shell');
        const savedTab = readStorage(TAB_STORAGE_KEY, 'settings');
        activeTabId = TABS.some((tab) => tab.id === savedTab) ? savedTab : 'settings';
        bindShell(shell);
        Engine.onStats(onStatsChanged);
        startExtensionEntryRetry();
    }

    NS.CooWindow = Object.assign(NS.CooWindow || {}, {
        mount,
        toggle: toggleShell,
    });
})();

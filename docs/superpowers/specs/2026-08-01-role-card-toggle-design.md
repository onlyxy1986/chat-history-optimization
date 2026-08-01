# 角色卡功能开关（enable/disable 角色卡）设计

日期：2026-08-01
状态：已获用户确认

## 目标

在设置面板加一个开关，可启用/禁用「角色卡」功能。禁用时：

- 提示词（ROLE_DATA 与 ROLE_DATA_TEMPLATE）中不包含角色卡内容
- roledata 的「角色卡」部分完全不做处理（不合并、不淘汰、不显示）

「故事历程」「前文」「天数」等其他功能不受影响。

## 用户已确认的决定

禁用期间，从 ROLE_DATA_TEMPLATE 中剔除角色卡段落 → AI 停止输出角色卡 delta。

代价（用户接受）：重新启用后，禁用期间新出现的角色没有角色卡（AI 仅在新角色首次出现时输出一次）。禁用前已有的角色卡不受影响——每次生成都从聊天记录全量重扫 delta，重新启用后自动恢复。

## 方案

**方案 A（已选定）：源头剔除 + 模板文本剔除**，改动最小，下游现有守卫自然生效。

否决方案 C：JSON 解析后重序列化模板会丢失所有 `//` 注释（那些是给 AI 的指令），不可取。

## 改动点

### 1. `defaultSettings` 新增设置项（index.js）

```js
roleCardToggle: true,   // 默认启用，保持现状
```

### 2. index.html — 新增开关

在「启用功能」checkbox 下方加同款 checkbox（沿用现有 `checkbox_label` 样式）：

```html
<label title="启用角色卡功能" class="checkbox_label" for="role_card_toggle">
    <input type="checkbox" id="role_card_toggle">
    <span>启用角色卡</span>
</label>
```

### 3. 设置读写（index.js）

- `loadSettings()`：`$("#role_card_toggle").prop("checked", extension_settings[extensionName].roleCardToggle ?? defaultSettings.roleCardToggle).trigger("input");`
- 新增 `onRoleCardToggleInput(event)`（仿照 `onToggleInput`）：写 `extension_settings[extensionName].roleCardToggle`，`saveSettingsDebounced()`
- jQuery ready 回调绑定 `$("#role_card_toggle").on("input", onRoleCardToggleInput);`
- 新增辅助函数：

```js
function isRoleCardEnabled() {
    return extension_settings[extensionName].roleCardToggle ?? defaultSettings.roleCardToggle;
}
```

### 4. `mergeDataInfo` — 源头剔除

`const itemObj = JSON.parse(objMatch[0]);` 之后加一行：

```js
if (!isRoleCardEnabled()) delete itemObj.角色卡;
```

角色卡进不了 `mergedRoleData`，下游全部自然跳过：

- nameMapping 提取（546-552 行）→ 现有守卫 `finalRoleDataInfo.角色卡 && typeof === 'object'` 不成立，跳过
- 角色下拉框 UI（555-559 行）→ 走 else 分支，`updateRoleSelectAndInfo({})`，显示「无角色」
- 10 槽位淘汰/蒸馏（565-622 行）→ 现有守卫不成立，跳过
- token 统计（`getTokenCountAsync(JSON.stringify(finalRoleDataInfo))`）→ 自然不含角色卡

### 5. `getCharPrompt` — 模板剔除

模板注入处（第 517 行）改为：

```js
const roleCardEnabled = isRoleCardEnabled();
// 模板
${roleCardEnabled ? $("#char_prompt_textarea").val() : stripRoleCardSection($("#char_prompt_textarea").val())}
```

（用局部变量，避免每处重复调用。）

新增函数 `stripRoleCardSection(templateText)`：

- 找到顶层 `"角色卡"` 键（`indexOf('"角色卡"')`，且向前跳过空白后是 `{` 或 `,` 才算顶层键）
- 跳过 `:` 后对 `{` 做**花括号配对扫描**，扫描时识别三种状态：
  - 字符串内：跳过，处理 `\"` 转义（防止 `{{占位符}}` 里的花括号干扰）
  - `//` 行注释内：跳到行尾（模板示例注释里有 `{"特征1":"特征描述"}` 这类花括号）
  - `/* */` 块注释内：跳到 `*/`
- 配对成功后，向前回扫空白找到前导 `,`（如有）一并删除，保证删除后 JSON 合法（角色卡是首键时无前导逗号，不用删）
- 任何异常（找不到键、不是对象值、括号不配对）→ 安全返回原文，不破坏模板

### 6. 不改动的部分

- `deepMerge`、`checkPath`：不需要改（角色卡根本不会传入）
- `postProcess`：不涉及角色卡
- `nameMapping` 生命周期：禁用期间残留的旧值无害（merge 循环有 `!mergedRoleData.角色卡` 守卫），重新启用后会被重新构建

## 边界情况

| 场景 | 行为 |
|---|---|
| 模板里没有 `"角色卡"` 键 | `stripRoleCardSection` 返回原文，无影响 |
| 模板正在编辑（JSON 不合法） | 剔除函数只做文本级操作，尽力而为；括号不配对时返回原文 |
| 禁用期间生成 | ROLE_DATA 无角色卡；模板无角色卡段落；下拉框显示「无角色」 |
| 重新启用 | 下次生成重扫聊天记录，禁用前的角色卡全部恢复；禁用期间的新角色无卡 |
| 角色卡是模板最后一个键 | 删除块连同前导逗号，剩余 JSON 保持合法 |

## 测试方式

浏览器手动验证（无测试套件）：

1. 默认（启用）：生成一次，确认 ROLE_DATA 与模板含角色卡、下拉框有角色
2. 关闭「启用角色卡」：生成一次，确认 ROLE_DATA 无角色卡、模板无角色卡段落、下拉框「无角色」、token 数下降
3. 重新开启：生成一次，确认历史角色卡恢复（聊天记录里的旧 delta 含角色卡）
4. 边界：模板中把 `"角色卡"` 删掉再关闭开关，确认不报错、模板原样输出

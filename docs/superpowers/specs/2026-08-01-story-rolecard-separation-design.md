# 故事历程与角色卡彻底切开（双域双状态）设计

日期：2026-08-01
状态：已获用户确认（逐节确认）

## 目标

将「故事历程」（时间线/前文）与「角色卡」（人物档案）从单个混合 JSON 中彻底拆成两条独立管道：独立状态、独立模板、独立合并、独立后处理、独立输出区段。AI 输出格式从 `<delta>`（一个 JSON 含全部字段）改为 `<NEW_STORY_DATA>`（内含 `<NEW_HISTORY>` 与 `<NEW_CHARACTER_CARD>` 两个独立区段）。

## 用户已确认的决定

1. **旧格式不兼容**：只解析新 `<NEW_STORY_DATA>` 格式，旧 `<delta>` 块全部忽略。升级后首次生成时插件积累状态重建（提示词仍带之前的前文，AI 从当前上下文续）
2. **两个独立模板 textarea**：故事历程模板 + 角色卡模板，各自有效性检测与重置；旧 `charPrompt` 设置项作废，不迁移
3. **只保留角色卡开关**：故事历程无独立开关（它是核心功能）
4. **NEW_HISTORY 为结构化 JSON**：天数/日期/星期 + 故事历程数组（与现在相同），`arrayToMarkdown` 管线保留
5. **天数/日期/星期/正文出场或提及到的角色 全归故事侧**
6. **架构：方案 A 双域双状态**

## 架构

### 数据模型

```js
// 故事域（HISTORY）
HISTORY_DATA = {
    天数, 日期, 星期, 正文出场或提及到的角色,   // 时间线字段
    故事历程: [{天数, 时间, 地点, 历程}, ...],
    故事历程总结: [...],   // 旧兼容字段，保留
    前文: string            // postProcess 生成
}

// 角色域（CHARACTER）
CHARACTER_DATA = {
    "角色名": { 角色设定: {...}, 角色状态: {...} }   // 直接是映射，无 "角色卡" 包装键
}
```

角色域去掉 `角色卡` 包装键：旧格式里它是大 JSON 的一个键，现在是专属区段，包装键冗余。角色查看器 UI 直接消费此映射。

### 模板（defaultSettings 拆成两份）

- `historyPrompt` = 旧 charPrompt 去掉 `角色卡` 键（天数/日期/星期/正文出场角色/故事历程及全部注释原样保留）
- `characterPrompt` = `{ "{{角色名}}": { "角色设定": {...}, "角色状态": {...} } }` 结构，注释保留「仅新角色出现时输出」指引

`checkPath(path, template)` 增加模板参数：故事域按 historyTemplate 校验，角色域按 characterTemplate 校验（动态键 `{{角色名}}` 已有支持）。

## 改动点

### 1. 解析（`mergeDataInfo` 重写）

1. 每条 assistant 消息（含 swipes 回退）用正则找 `<NEW_STORY_DATA>...</NEW_STORY_DATA>`（先剥 `//` 注释），只取最后一个
2. 块内分别抽取 `<NEW_HISTORY>` 与 `<NEW_CHARACTER_CARD>`，各自用 `{[\s\S]*}` 提取 JSON 独立解析
3. 两个解析结果分别 `deepMerge` 进 `HISTORY_DATA` / `CHARACTER_DATA`
4. 旧 `<delta>` 完全不识别
5. 失败统计：无 NEW_STORY_DATA 或 缺 NEW_HISTORY → 记 failed floor；**缺 NEW_CHARACTER_CARD 不记失败**（角色卡「仅新角色出现时输出」，无新角色时合法省略；开关关闭时必然缺失）
6. `allowUpdate` 标志放 NEW_CHARACTER_CARD JSON 顶层（`{"allowUpdate": true, ...}`），合并前先取出，不当作未知键

### 2. 合并（`deepMerge` 仅加模板参数）

- **故事域**：`deepMerge(HISTORY_DATA, historyObj, [], allowUpdate=false, historyTemplate)`。数组去重、`delete N-M` 区间删除、`故事历程总结` 特例照旧；路径无 `角色设定`，不可变保护不触发
- **角色域**：`deepMerge(CHARACTER_DATA, charObj, [], allowUpdate, characterTemplate)`。`角色设定` 不可变性（`处女`/`未知` 特例）照旧，路径含 `角色设定` 自动生效
- `nameMapping` 别名重命名只作用于角色域

### 3. 后处理

- **故事域**：`故事历程` → `arrayToMarkdown(故事历程, keepMessageCount)` 拼进 `前文`；`故事历程总结` 同理后删除；前文末尾追加日期换算表锚点；剥掉残留的 `<NEW_STORY_DATA>` 标签
- **角色域**：10 槽位淘汰 + 30 条蒸馏 + 当前 prompt 提及角色保活（现有逻辑整体平移；开关关闭时角色域为空对象，守卫天然成立）
- 尾部保留消息（keepCount）照旧提取进 `前文`；`</think>` → `<post_thinking>`/`<NEW_STORY_DATA>` 截断正则同步换新标签

### 4. Token 控制

- 计数口径：`JSON.stringify(HISTORY_DATA) + JSON.stringify(CHARACTER_DATA)` 总 token
- 超限剪 `故事历程`（slice 1/50 循环）不变
- **新增硬停守卫**：旧代码在角色数据单独超限时会无限循环（故事历程空后仍剪）。改为剪到 `故事历程` 为空仍超限则告警并接受结果

### 5. 提示词构建（`getCharPrompt`）

采用用户已写的模板字面量，补齐变量：

```js
const newHistoryTemplate = $("#history_prompt_textarea").val();
const newCharacterCardTemplate = isRoleCardEnabled() ? $("#character_prompt_textarea").val() : '';
```

- `historyContent` = 故事域 `前文`（敏感词替换）
- `charsInfoJsonStr` = `JSON.stringify(CHARACTER_DATA)`（敏感词替换）
- 角色卡关闭时：省略 `<CHARACTER_CARD>` 区段与 `<NEW_CHARACTER_CARD>` 模板块，NEW_STORY_DATA 只剩 NEW_HISTORY
- 首条信息注释改新格式措辞（"`<NEW_STORY_DATA>` 中需要参考前文…"）

### 6. 设置 UI（index.html）

- `char_prompt_textarea` 拆成 `history_prompt_textarea` 与 `character_prompt_textarea`，各自带有效性标签与重置按钮
- 设置键：`charPrompt` → `historyPrompt` + `characterPrompt`，旧值作废不迁移
- extensionToggle / roleCardToggle / keepCount / tokenLimit / 角色查看器 不动

### 7. 代码清理

- 删除 `stripRoleCardSection`（独立 textarea 后不再需要）
- 删除旧 `<delta>` 正则路径、旧单 `json_template` 逻辑
- 删除 `roledata_history` 逐条快照（死数据，无任何消费方；`mergeDataInfo` 不再返回）
- 变量命名对齐新域：`mergedRoleData` → `historyData` / `characterData`
- `convertDayReferences` 保持禁用不动
- 默认模板更新为拆分后的两份

## 边界情况

| 场景 | 行为 |
|---|---|
| 旧聊天记录含 `<delta>` | 不识别，忽略；升级后首次生成状态重建 |
| AI 只输 NEW_STORY_DATA 但缺 NEW_HISTORY | 记 failed floor，本次不合并 |
| 缺 NEW_CHARACTER_CARD | 正常（无新角色/开关关闭），不记失败 |
| 某一区段 JSON 解析失败 | 该区段跳过、记 failed floor，另一区段照常合并 |
| 角色卡关闭 | 不合并角色域、提示词无角色卡区段、查看器显示「无角色」 |
| 模板 JSON 无效 | 对应 json_template 为 null，该域合并抛错 → 被 try/catch 捕获 → 记 failed floor，不崩 |
| 两个模板重置 | 各自恢复默认模板 |

## 测试方式

浏览器手动验证 + node 纯函数脚本：

1. 默认（开启）：生成一次，确认 prompt 含 `<STORY_DATA>`/`<HISTORY>`/`<CHARACTER_CARD>` 与双模板；AI 输出 `<NEW_STORY_DATA>` 后，两次生成间状态正确累积（故事与角色互不串扰）
2. 关闭「启用角色卡」：prompt 无 `<CHARACTER_CARD>` 与 `<NEW_CHARACTER_CARD>`，查看器「无角色」，token 下降
3. 旧聊天记录（含 `<delta>`）加载：不报错，状态重建
4. 单条消息缺 NEW_HISTORY：failed floors 计数 +1
5. node 脚本：NEW_STORY_DATA 区段抽取正则（双区段、缺区段、注释）；checkPath 双模板（含 `{{角色名}}` 动态键）；历史模板剥离 `角色卡` 后 JSON 合法
6. token 超限：故事历程被裁剪；构造角色数据超限场景验证硬停守卫不死循环

# Chat History Optimization Extension for SillyTavern

优化 SillyTavern 聊天历史，智能摘要角色、任务与事件信息，减少长对话时的 token 消耗，并提供可视化设置与统计。

---

## 简介
本扩展通过自动提取和合并对话中的角色、任务、事件等关键信息，优化聊天历史结构，显著降低 token 占用，提升长对话体验。支持自定义保留 AI 回复数量、实时 token 统计、失败摘要提示等功能。

---

## 主要功能
- **角色/任务/事件摘要**：自动解析并合并对话中的 `<message_summary>` JSON 信息，生成结构化角色、任务、事件记录。
- **智能历史裁剪**：可自定义保留最近 N 条 AI 回复，其余内容以摘要形式保留，兼顾上下文完整性与 token 节省。
- **Token 统计**：实时显示当前聊天历史的 token 数量，便于把控上下文长度。
- **失败统计**：统计并提示未能成功解析摘要的消息索引，便于排查问题。
- **可视化设置界面**：所有功能均可在 SillyTavern 扩展设置页中直观操作。

---

## 安装与使用
1. 将本扩展文件夹放入 `SillyTavern/public/scripts/extensions/third-party/` 目录下。
2. 启动 SillyTavern，进入设置页，在"扩展"栏目找到"Chat History Optimization"。
3. 勾选"启用功能"以激活扩展。
4. 可根据需求调整"正文深度"（保留的 AI 回复数量）。

---

## 设置项说明
- **启用功能**：总开关，控制扩展是否生效。
- **正文深度**：设置保留最近多少条 AI 回复，其余历史将以摘要形式合并。
- **人物总结失败的楼层**：显示未能成功解析摘要的消息索引。
- **Chat History Token Count**：显示当前聊天历史的 token 数量。

---

## 技术细节
- 自动解析每条 AI 回复中的 `<message_summary>` JSON 区块，合并为全局角色/任务/事件信息。
- 通过正则与 JSON 解析，兼容多种格式与异常情况，失败项会在界面提示。
- 聊天历史裁剪逻辑：保留首条 AI 回复、合并摘要、保留最近 N 条 AI 回复及其后所有内容。
- 支持与 SillyTavern 原生设置无缝集成。

---

## 贡献与反馈
- 欢迎提交 issue 或 PR 以完善功能。
- 主页：[GitHub](https://github.com/onlyxy1986/chat-history-optimization)

---

## 作者
- only
- 版本：1.0.0

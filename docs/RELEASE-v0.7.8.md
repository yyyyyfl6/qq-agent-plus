双人格皮肤：会话独立绑定人格卡、provider、model；鱼/猫分别保存聊天记录、线程、人物印象和备份。
新增主人提供的 `blue_fish`、`hajimi` 卡、owner 切换命令、可关闭的转述交接摘要，以及控制台配置/筛选/切换页面。
保留上游 main 到 `53ad4ac7` 的作者更新。本版只发布到 `yyyyyfl6/qq-agent-plus`，服务器部署由主人负责。

## 升级影响

- **运行期依赖无变化**，Node 要求仍为 ≥22.19.0。安装时仍建议 `npm ci`；自动更新与部署脚本会执行原有依赖安装流程。
- 新增 `config.skins`，默认 `enabled:false`。提供商 id 是实例本地值，启用前在控制台检查；缺失时回落当前 api 并告警。
- owner 使用 `autoUpdate.ownerUin`；支持 `/skin <id>`、`切鱼`、`切猫`，确认文案可配置。
- 首次启用新增 SQLite 皮肤元数据，旧数据归当时的默认皮肤；默认仓记忆复制保留原件，另一仓独立保存。不会删除旧数据。
- 交接摘要默认随皮肤开启，可单独关闭；仅下一轮注入，声明是另一 AI 的转述。摘要失败不阻止切换。
- 部署方需将 `autoUpdate.repository` 与 `.deployment.json.repository` 指向 fork，并保持其它现有部署参数一致。分支 `dual-skin` 的普通提交不触发更新器，更新器仍只部署已发布 Release。

## 回滚

升级前停服备份完整数据目录（包含 SQLite 与 WAL/SHM、config、memory、sessions）及 `.deployment.json`。
关闭 `skins.enabled` 即使用旧单仓和全局人格；皮肤历史仍保留，重新启用可恢复。
需要回滚代码时按既有部署流程安装上一个已验证 revision/tag，保持安装/数据目录等目标参数一致。
旧版忽略新增表/列并读取保留的旧单仓；分仓期间的新记忆不会自动合并回旧全局记忆。
若需恢复升级前完全相同状态，停服恢复完整备份；不要在线覆盖 SQLite 文件。

## 验证

发布闸门：Linux / Node 22，`npm ci`、ESLint、递归 JavaScript 和 shell 语法、严格 ops 扫描、全部单元测试、
本地回归、提示词/渲染/滚动/用量端到端回归；只有全部通过才会发布此 Release。
新增测试覆盖配置优先级、provider/key 配对、缺失回落、旧数据迁移、两套消息/记忆/线程、
异步写入与重放去重、owner 命令、摘要开关/失败/一次消费，以及真实 HTTP API 和 DOM 页面交互。
服务器实际 QQ 和人工浏览器布局验收由部署方完成。

详细使用、存储与 API 说明：[双人格皮肤](https://github.com/yyyyyfl6/qq-agent-plus/blob/v0.7.8/docs/DUAL_SKINS.md)。

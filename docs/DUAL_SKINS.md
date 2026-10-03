# 双人格皮肤

功能默认关闭。启用后，每个会话绑定一套人格卡、provider 和 model；优先级高于全局 persona。
`blue_fish` 与 `hajimi` 的正文来自主人提供的两张卡，按原文复制。

## 使用

主控制台的「人格」入口打开 `/skins.html`。先在主控制台登录，再打开此页。
页面可以开关皮肤、开关交接摘要、编辑默认皮肤/确认文案/皮肤列表，以及查看和切换会话绑定。
列表中的 provider 使用本实例目录。人格页支持编辑 Base URL/API Key、检索或手动添加模型，并用表单选择人格预设、模型和专属切换指令。
显式跟随全局 Key 的提供商仅在同端点继承；手动 Key 按提供商保存，Key 不回显。
提供商不存在时告警并回落完整当前 api 配置；不把全局 key 送到另一个端点。

管理员由 `autoUpdate.ownerUin` 指定。精确文本命令 `/skin fish`、`/skin cat`、`切鱼`、`切猫`
在唤醒前消费，确认文案由 `skins.ack` 配置（支持 `{label}`、`{id}`）。非管理员文本按原消息处理。
`switchCommands` 可以移除别名或更换 slash 前缀。协议重复投递同一命令不会再次切换和发送确认。

消息存档内的皮肤下拉只选择查看哪套存档，「使用所选皮肤」才改变绑定并关闭原线程。
运行记录可以按皮肤筛选，单轮留档包含 `skinId`，模型与原始提示词仍保留供核查。

```json
{
  "skins": {
    "enabled": false,
    "default": "fish",
    "list": [
      {"id":"fish","label":"蓝色大肥鱼","templateId":"blue_fish","provider":"provider_deepseek","model":"deepseek-flash","botName":"蓝色大肥鱼","commands":[]},
      {"id":"cat","label":"哈基米","templateId":"hajimi","provider":"provider_gemini","model":"gemini-3.8-flash","botName":"哈基米","commands":["变成哈基米"]}
    ],
    "switchCommands": ["/skin","切鱼","切猫"],
    "ack": "已切换到 {label}",
    "handoffOnSwitch": {"enabled":true,"maxChars":1200,"recentMessages":40,"provider":"","model":"deepseek-flash"}
  }
}
```

## 存储与切换

首次启用保存 `skin_state.legacy_skin`，旧行归属当时的默认皮肤；之后改变默认皮肤不会挪走旧数据。
SQLite `chat_skins` 记录会话绑定，消息、线程、检查点和线程回合补充 `skin_id`。
旧默认仓保持原 `chat_key`，其它仓使用 `<chat_key>/skin/<skin_id>`；所有公开返回仍是原会话 key。
这样租约、待处理消息、发送记录和线程主键也一起隔离，无需破坏旧表的约束。
同一协议消息 ID 在会话各皮肤间去重，避免补拉复制对方历史。

人物印象、工作状态、运行交接和备份位于：
`data/memory/<group_N|private_N>/skins/<skin_id>/`。
每仓有独立 `people/`、`backups/`，工作状态和运行交接在该根下面的 `<group_N|private_N>/`。
第一次读取默认仓时复制旧状态和本会话来源的全局印象/备份；原文件保留。
背景整合、记忆工具和身份提示词使用同一路由。异步任务固定所属皮肤，切换后的迟到写入仍回原仓。
切换会阻止新唤醒、取消并等待原运行收尾，然后原子保存摘要与绑定；再次切回读回原消息和记忆。

摘要默认使用 deepseek-flash；通过人格页独立选择总结提供商和模型，不随离开人格的聊天模型变化。
自动选择优先找目录中提供该模型的提供商，否则使用全局 API。示例提供商 ID 为占位符，应选择本实例保存的目录项。
调用最多等待 20 秒，失败仍完成切换。结果返回 `handoffStatus`（created/disabled/no-messages/empty-response/failed）；失败时附不含上游原文的 `handoffError`，日志、人格页及 QQ 指令回执均显示原因。
正文被限制到 `maxChars`，必含另一 AI 的转述、非亲历声明。
下一轮系统提示词增加独立块 `【另一人格留下的交接摘要（转述，非亲历）】`，之后标为已消费。
摘要开关关闭时不调用摘要器，也不注入待消费摘要。
皮肤系统关闭时使用原单仓和全局人设；分仓数据保留，重新启用仍恢复分仓。

## API

所有端点沿用控制台鉴权：

- `GET /api/skins`：配置、可用 provider id、人格模板，不返回密钥。
- `POST /api/skins`：皮肤配置或 `{skins:{...}}`，允许部分更新，后端验证 id/模板/范围。
- `GET /api/chat-skins?chatKey=group:123`：启用状态与绑定；不传 key 返回已知会话。
- `POST /api/chat-skins`：`{chatKey:"group:123",skinId:"cat"}`，执行与命令相同的切换。
- `GET /api/chats/group_123/messages?skinId=fish`：指定仓历史，不改变绑定。
- `GET /api/sessions?skinId=cat`：按皮肤筛选运行记录。

## 验收

自动测试：`test/skins.test.mjs`、`test/skins-api.test.mjs`、`test/skins-ui.test.mjs`；
再执行 `npm test`、`npm run lint`、`npm run test:local` 和严格 ops 扫描。
发布工作流在 Linux/Node 22/ffmpeg 环境重跑完整门禁，任一步失败不发布。

服务器部署后实际 QQ 验收由部署方完成：启用 → 鱼聊天/写记忆 → owner 切猫 → 猫确认转述边界并独立写记忆
→ 切回鱼恢复旧仓 → 关闭摘要再次切换 → 关闭整个功能确认旧路径；另检查非 owner 命令和控制台筛选。
人工浏览器布局烟测按 [UI-SMOKE.md](UI-SMOKE.md)；DOM 自动测试不代表服务器实聊验收。

# 扩展功能（src/extensions/）

参考 AstrBot 插件市场里常用的几类插件（2026-11 合并上游 0.9.12 / hajimi-and-fatfish 后的版本），按本项目的规矩（默认关、各自独立、关闭不删数据、外部写入不自动重试）
重新实现的一组功能。每个功能都有**自己的配置段、自己的持久化文件、自己的控制台页面与 `/api/ext/*` 接口**，
核心代码只在几个挂点上接入（见文末「接入点」）。

| 功能 | 配置段 | 控制台页面 | 模型工具 | 数据 |
| --- | --- | --- | --- | --- |
| 群聊总结 | `chatSummary` | 侧栏 → 群聊总结 | `summarize_chat` + 指令 `/总结` | 无（最近 20 次总结只在内存里） |
| 大肥鱼桥 | `labBridge` | 侧栏 → 大肥鱼桥 | `lab_harness` + 指令 `/lab` | `data/lab-bridge/tasks.json`（0600，最近 200 个任务） |
| 趣味功能 | `funTools` | 侧栏 → 趣味功能 | `daily_fun` | 无（结果由代码确定性算出） |

全部默认 `enabled: false`。没开的功能：工具不进模型工具表、提示词不多一个字、不建库、不起定时器。

## 长期记忆

由上游的 **livingMemory**（`src/living-memory/`，侧栏「长期记忆」）提供：语义检索、知识图谱，并且按人格分仓。
本目录早先自带的一份长期记忆实现在合并上游 0.9.12 时移除，避免两套记忆同时往提示词里塞内容。

## 群聊总结

参考：AstrBot 的 chatsummary 类插件。

- 群友说"刚才聊了啥 / 我错过了什么 / 总结一下"，模型调 `summarize_chat`（按条数或最近几小时取样），
  拿到分话题的总结草稿后用 `send_message` 以自己的口吻发出去。
- 两种风格：`structured`（分话题要点、约定待办单列、可带一句金句）/ `casual`（三五句随口复盘）。
- 成本闸门：每会话每小时 + 全局每小时两道上限；模型调用失败会退回额度。
- 控制台可以对任意会话「生成预览」（不发送、不占聊天侧额度），改完再确认发到群里。
- 与「群日报」（`groupDigest`，每天定时自动发）互补，后者不变。

## 大肥鱼桥（Lab Bridge）

让管理员在 QQ 里把活派给**实验室电脑上的 DeepSeek Harness**，跑完把结果发回来。

### 安全底线

- 只认管理员（`admin.ownerUin`）本人：本轮触发的消息**全部**来自管理员才执行；群聊里同一批消息混进任何别人的发言就拒绝。
- 默认只在与管理员的私聊里可用（`privateOnly`）；不可用的场合工具根本不注入。
- 派发前先落盘 `dispatching`；派发结果不确定（断连、超时、5xx、服务重启）记为 `unknown`，**绝不自动重试**——
  可能已经在实验室电脑上跑起来了。派发请求带 `idempotency-key`，参考脚本会据此去重。
- 每小时派发次数上限；回报进聊天前截断（保留开头一点 + 结尾大部分）。

### 两种协议

- **task（推荐）**：`POST {base}/v1/tasks` → `{id}`；`GET {base}/v1/tasks/:id` → `{status, output, error}`；
  `POST {base}/v1/tasks/:id/cancel`；`GET {base}/v1/health`。全部 `Authorization: Bearer <token>`。
  仓库自带实现：[`scripts/lab-bridge-agent.mjs`](../scripts/lab-bridge-agent.mjs)（零依赖，Node 18+，Windows/macOS/Linux）。
- **openai**：harness 自己暴露 OpenAI 兼容 `/chat/completions` 时直接打（同步、一次跑完；不能取消，重启后无法续接）。

### 实验室电脑端部署

```bash
# 1) 在实验室电脑上启动接收端（{prompt} 会被替换成任务文本；不写就从 stdin 传入）
LAB_BRIDGE_TOKEN='至少16位的长随机串' \
LAB_BRIDGE_CMD='你的 harness 命令 {prompt}' \
LAB_BRIDGE_WORKDIR=~/lab \
node lab-bridge-agent.mjs
```

```bash
# 2) 从实验室电脑反向隧道到服务器（服务器不用开任何端口）
ssh -N -R 8790:127.0.0.1:8790 user@your-server
```

3. 控制台「大肥鱼桥」里服务地址填 `http://127.0.0.1:8790`、令牌与上面一致，点「测试连接」。

Windows 上执行 `.cmd/.bat` 时加 `LAB_BRIDGE_SHELL=1`。接收端默认只监听 `127.0.0.1`，不要改成 `0.0.0.0` 暴露到公网。


## 专属指令（与「切鱼 / 切猫」同一形态）

在 OneBot 消息入库后、唤醒模型**之前**消费（`src/extensions/commands.js`，挂在 `skins.consumeCommand` 后面）：
命中的消息不进模型、不花聊天 token，结果由代码直接回复；同一条协议消息重复投递不会执行第二次
（大肥鱼桥另按任务记录里的来源消息 id 做持久去重，服务重启后的重放也挡得住）。
启用双人格时，读历史与回复都走当前人格的分仓。

| 指令（默认，可在各自页面改） | 谁能用 | 作用 |
| --- | --- | --- |
| `/总结`、`总结一下` | 所有人（可改成仅管理员），受每小时额度约束 | 按默认条数总结并直接发到当前会话 |
| `/总结 200` / `/总结 3h` / `/总结 周末聚餐` | 同上 | 最近 200 条 / 最近 3 小时 / 侧重某件事 |
| `/lab <任务>`、`/大肥鱼 <任务>` | 只有管理员本人；默认只在私聊 | 派给实验室电脑，回"已交给…（#N）"，跑完自动回报 |
| `/lab` · `/lab 结果 N` · `/lab 取消 N` · `/lab ping` | 同上 | 最近任务 / 看输出 / 取消 / 测连通 |

非管理员发 `/lab …` 会被当成普通消息（不暴露指令存在），与人格切换指令的处理一致。
指令词完整匹配：`/总结x` 不算，`/总结 x` 才算。清空指令栏即关闭指令（模型仍可在聊天里按需调用工具）。

## 趣味功能

参考：AstrBot 插件市场里的 jrrp（今日人品）、今日运势、塔罗牌。

- `jrrp`：0~100，按 QQ 号 + 北京日期确定性生成，一天内问几次都一样。
- `fortune`：吉凶签 + 宜/忌各两条 + 幸运数字与颜色，同样一天一固定。
- `tarot`：22 张大阿卡纳，单张指引或过去/现在/未来三张，正逆位随机。
- 结果由代码决定，模型只负责用自己的口吻说出来——不会同一个人一会儿 90 一会儿 12。

## 陪伴 → 改为独立插件

「我会永远陪着你」（原作 menglimi）已改为 QQ Agent 插件，代码在
[yyyyyfl6/astrbot_plugin_private_companion](https://github.com/yyyyyfl6/astrbot_plugin_private_companion/tree/qq-agent-port/qq-agent)
的 `qq-agent/`（已获原作者授权）：副 API 维护角色的生活长任务并挂进私聊背景，按不规则间隔提示主模型主动联系，私聊按日期记日记。
它依赖插件接口 apiVersion 3（`llm` / `context` / `wake`，见 [PLUGINS.md](PLUGINS.md)）。宿主里原先的内置「陪伴」页与 `companion` 配置段已移除。

## 生图参考图（提示词触发）

代码：`src/extensions/image-refs.js`，页面：侧栏「图片生成」（也是生图功能的总入口：状态、试画、直达生图设置）。

- 上传参考图（PNG / JPEG / WebP，≤ 4 MB，最多 12 张），每张配触发词（如「你自己」「你长什么样」「自拍」）和一句给生图模型的说明。
- 对方本轮原话（可选：也匹配模型写的画面描述）命中触发词时，`generate_image` 把这张图一起交给生图模型，提示词末尾补一句"参考所给图片里的形象"。
- 传图方式：`auto`（默认：gpt-image / dall-e-2 走 `/images/edits` multipart，其余走请求体）/ `body`（`/images/generations` 的 JSON 里多带 `image: data:URL`，
  豆包 Seedream 4.x、通义万相与多数网关认这个；字段名可改）/ `edits`。魔搭走 `image_url`；免 Key 的 pollinations 不支持，照常按纯文字画并在工具结果里说明。
- 文件：`data/image-refs/<id>.<ext>`；关掉后保留。

## 模型供应商（设置 → 模型 API）

参照 AstrBot 的"添加供应商 → 选模型"：左列供应商、右列它的模型，点「使用」即切换当前模型；
「＋ 添加供应商」按服务预设选类型 → 填地址与 Key（Vertex 粘服务账号 JSON）→ 拉模型列表勾选 → 添加。
供应商可改名、删除（`DELETE /api/providers` 需 `confirm`，正在使用的那家不让删，Key 一起删）。
原来那套手动表单（地址 / Key / 模型 id）收进「高级：手动编辑当前连接」，控件与保存逻辑不变。

## 人格界面

- 侧栏「人格」在控制台里打开**双人格页**（内容取自 `/skins.html`；蓝色大肥鱼 / 哈基米…，见 [DUAL_SKINS.md](DUAL_SKINS.md)）：
  每个会话绑定一套人格卡 + 模型，管理员发「切鱼」「切猫」等专属指令切换。
  2026-11 交互重做：总开关拨动即保存且只写 `enabled`（以前走整张表单，任何一格校验不过就"看着开了其实没存"）；
  卡片上直接「设为默认」并显示被几个会话使用；会话行改了下拉框才亮「切换」，可按群号 / QQ 筛选；
  交接设置收进折叠区；页内不再用 `#锚点`（嵌在控制台里会改地址栏 hash）；点弹窗外关闭编辑框。
- 设置 → 人设（人格卡本身的编辑）另有一层工作台增强：
  - 卡库搜索；分节大纲（点一下跳到那一节并展开）；字数与 token 粗估。
  - **试聊**：用草稿里的卡（没保存也行）跟它聊几句，看口吻对不对；不发到 QQ、不进记忆（`POST /api/persona/preview`）。
  - **AI 起草**：一句话设定 → 按内置卡的分节格式写一张新卡，可填入草稿或另存为自定义卡（`POST /api/persona/generate`）。
  - 导入 / 导出 `.md`；把改过的草稿覆盖保存回当前自定义卡（`PUT /api/persona-templates/custom_N`，以前只能新建/删除）。

另有全局 **Ctrl / ⌘ + K 命令面板**：输入几个字直达任意页面或设置分区。

## 接入点（核心代码只改了这些）

| 位置 | 改动 |
| --- | --- |
| `src/tools/tools.js` | `buildToolDefs()` 末尾追加 `extensionToolDefs()` |
| `src/core/orchestrator.js` | 工具过滤加 `extensionToolAvailable()`（权限判断复用上游已有的 `ctx.triggerEntries`）；每轮 user 内容加 `pluginContextFor()`（插件 v3 挂的背景） |
| `src/tools/tools-core.js` | `generate_image` 调用前问一次 `getImageRefs().resolve()`，命中就带参考图 |
| `src/llm/image-gen.js` | `generateImage({ reference })`：请求体 / `/images/edits` 两种带图形状 |
| `src/core/providers.js` | `removeProvider` / `renameProvider`，新建可带名称 |
| `src/console/app.js` | `initExtensions`（读写包一层 `skins.scope`）；`PluginRegistry` 的 `getAgent`（插件 v3 的主动唤醒走 `orchestrator.wake`）/ `ExtensionCommands.consume`（紧跟人格切换指令）/ 路由 / 启停；`registerPersonaRoutes` |
| `src/core/config-legacy.js` | 三个配置段与谷歌 / Edge 搜索的默认值（全部关闭） |

回滚：把各配置段（chatSummary / labBridge / funTools / imageRefs）的 `enabled` 关掉即恢复原行为；数据文件保留，删掉 `data/lab-bridge/`、`data/image-refs/` 即彻底清除。

## 界面

配色、明暗、材质、字体、圆角等外观全部由上游的外观系统（设置 → 外观，`ui/core/appearance.js`）负责；
图标统一用上游的线条 SVG 图标库（`ui/core/icons.js`，本次补了 `fish` / `mask` / `dice` / `summary` / `heart`）。

## 搜索：谷歌与 Edge

设置 → 搜索服务 → 搜索提供方新增两项（聚合搜索的源名也可用 `google` / `edge`）：

- **谷歌 Google**：官方 Custom Search JSON API，国际域名 `https://www.googleapis.com/customsearch/v1`。
  需要 API Key（Google Cloud 控制台启用 Custom Search API）与搜索引擎 ID `cx`（programmablesearchengine.google.com
  新建"搜索整个网络"的引擎）；也可用环境变量 `GOOGLE_SEARCH_API_KEY` / `GOOGLE_SEARCH_CX`。界面语言留空由谷歌自动判断。
- **Edge（必应国际版）**：Edge 浏览器默认引擎 `https://www.bing.com/search`，免 Key；`market` 留空由必应自动判断地区，
  也可填 `en-US`、`ja-JP` 等。原有的「必应国内版 cn.bing.com」保留不变。

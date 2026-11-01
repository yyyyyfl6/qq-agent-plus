# 扩展功能（src/extensions/）

参考 AstrBot 插件市场里常用的几类插件，按本项目的规矩（默认关、各自独立、关闭不删数据、外部写入不自动重试）
重新实现的一组功能。每个功能都有**自己的配置段、自己的持久化文件、自己的控制台页面与 `/api/ext/*` 接口**，
核心代码只在几个挂点上接入（见文末「接入点」）。

| 功能 | 配置段 | 控制台页面 | 模型工具 | 数据 |
| --- | --- | --- | --- | --- |
| 长期记忆 | `longMemory` | 记忆 → 长期记忆 | `long_memory_save` / `long_memory_search` / `long_memory_forget` | `data/long-memory.sqlite`（0600，首次启用才创建） |
| 群聊总结 | `chatSummary` | 扩展 → 群聊总结 | `summarize_chat` | 无（最近 20 次总结只在内存里） |
| 大肥鱼桥 | `labBridge` | 扩展 → 大肥鱼桥 | `lab_harness` | `data/lab-bridge/tasks.json`（0600，最近 200 个任务） |
| 趣味功能 | `funTools` | 扩展 → 趣味功能 | `daily_fun` | 无（结果由代码确定性算出） |

全部默认 `enabled: false`。没开的功能：工具不进模型工具表、提示词不多一个字、不建库、不起定时器。

## 长期记忆

参考：AstrBot 的 Mnemosyne / LivingMemory 一类长期记忆插件。

- **和「人物记忆」的分工**：人物记忆（`src/memory/`）按 QQ 号记"他是个什么样的人"；长期记忆记"发生过什么、说好了什么"——
  约定、群友的近况与计划、群里的大事、长期的梗。
- **写入**：模型调 `long_memory_save`；与同会话里高度相似（切词 Jaccard ≥ 0.72）的旧条目合并更新，不重复记。
  可选「自动提炼」：后台每 N 分钟扫一遍，攒够新消息（按消息 id 水位增量读）的会话就让模型挑出值得长期记住的事；
  有每小时次数上限。
- **召回**：每轮按触发消息检索，最相关的几条（≥ 相关度门槛）作为【长期记忆·可能相关】放进**用户提示词**
  （不放系统提示，不破坏前缀缓存）。检索是中文二元组 + 英文词的 BM25；开了向量检索（OpenAI 兼容 `/embeddings`）
  就按 0.65 向量 + 0.35 词法混合，再叠加重要度与新近度。向量服务挂了自动退回词法，不影响聊天。
- **可见范围**：`scope=chat`（默认）只在记下它的群/私聊里想起；`scope=global` 跨会话，但群聊里不召回私聊来源。
- **Key 归属**：与生图、语音同一条规矩——向量服务地址不是聊天模型那一家时，不会把聊天模型的 Key 发过去。
- **淘汰**：超过 `maxEntries` 时按"重要度低 + 很久没被想起"淘汰。

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

## 趣味功能

参考：AstrBot 插件市场里的 jrrp（今日人品）、今日运势、塔罗牌。

- `jrrp`：0~100，按 QQ 号 + 北京日期确定性生成，一天内问几次都一样。
- `fortune`：吉凶签 + 宜/忌各两条 + 幸运数字与颜色，同样一天一固定。
- `tarot`：22 张大阿卡纳，单张指引或过去/现在/未来三张，正逆位随机。
- 结果由代码决定，模型只负责用自己的口吻说出来——不会同一个人一会儿 90 一会儿 12。

## 生图增强

`generate_image` 新增 `send: true`：画完直接发到当前聊天（与 `send_sticker` 同一条发送链路），省一轮工具调用；
可带 `replyToMessageId` 引用点图的人。发送失败时图已在表情库里，返回 id 让模型改用 `send_sticker` 重发（不重画、不退额度）。

## 人格界面

- 侧栏「人格」直达 设置 → 人设。
- 卡库搜索；分节大纲（点一下跳到那一节并展开）；字数与 token 粗估。
- **试聊**：用草稿里的卡（没保存也行）跟它聊几句，看口吻对不对；不发到 QQ、不进记忆（`POST /api/persona/preview`）。
- **AI 起草**：一句话设定 → 按内置卡的分节格式写一张新卡，可填入草稿或另存为自定义卡（`POST /api/persona/generate`）。
- 导入 / 导出 `.md`；把改过的草稿覆盖保存回当前自定义卡（`PUT /api/persona-templates/custom_N`，以前只能新建/删除）。

另有全局 **Ctrl / ⌘ + K 命令面板**：输入几个字直达任意页面或设置分区。

## 接入点（核心代码只改了这些）

| 位置 | 改动 |
| --- | --- |
| `src/tools/tools.js` | `buildToolDefs()` 末尾追加 `extensionToolDefs()` |
| `src/core/orchestrator.js` | 工具过滤加 `extensionToolAvailable()`；运行前算 `extensionPromptContext()`；`ctx.triggerSenderIds` |
| `src/llm/prompt.js` | 【记忆】段之后插入扩展段落 |
| `src/console/app.js` | `initExtensions` / `registerExtensionRoutes` / `startExtensions` / `stopExtensions`；`registerPersonaRoutes` |
| `src/core/config-legacy.js` | 四个配置段的默认值（全部关闭） |
| `src/tools/tools-core.js` | `generate_image` 的 `send` / `replyToMessageId` 参数 |

回滚：把四个配置段的 `enabled` 关掉即恢复原行为；数据文件保留，删掉 `data/long-memory.sqlite` 与 `data/lab-bridge/` 即彻底清除。

## 界面：配色方案与图标（2026-11 第二轮）

- **配色方案**：设置 → 系统 → 界面，「主题」下面一行色卡：石墨紫（默认）/ 深海蓝（原版）/ 薄荷 / 樱花 / 琥珀 / 极夜（OLED 纯黑）。
  与明暗主题正交，每套都有暗色、亮色两版。选择存 `localStorage` + 后端 `config.ui.palette`，首屏由 `index.html`
  的预置脚本应用（不闪）。实现：`ui/palette.js`；配色变量在 `ui/style.css` 的「配色方案」段，新增一套只需加两行变量。
- **SVG 图标**：侧栏导航、扩展页页头、主题选择、空状态都换成一套线条 SVG（CSS mask 绘制，跟随 `currentColor`）。
- **无边框**：卡片、输入框、按钮、徽标去掉 1px 方框，改用底色明暗 + 柔和阴影 + 大圆角分层。

## 搜索：谷歌与 Edge

设置 → 搜索服务 → 搜索提供方新增两项（聚合搜索的源名也可用 `google` / `edge`）：

- **谷歌 Google**：官方 Custom Search JSON API，国际域名 `https://www.googleapis.com/customsearch/v1`。
  需要 API Key（Google Cloud 控制台启用 Custom Search API）与搜索引擎 ID `cx`（programmablesearchengine.google.com
  新建"搜索整个网络"的引擎）；也可用环境变量 `GOOGLE_SEARCH_API_KEY` / `GOOGLE_SEARCH_CX`。界面语言留空由谷歌自动判断。
- **Edge（必应国际版）**：Edge 浏览器默认引擎 `https://www.bing.com/search`，免 Key；`market` 留空由必应自动判断地区，
  也可填 `en-US`、`ja-JP` 等。原有的「必应国内版 cn.bing.com」保留不变。

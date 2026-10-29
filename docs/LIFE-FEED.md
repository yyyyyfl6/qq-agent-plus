# 生活层（见闻）

机器人自己的"日子"：定期去 B 站看一圈，把候选存进队列；主动发言时可以从队列里挑一条，
用自己的语气分享到群里。默认关闭。

## 开关与配置

控制台「设置 → 见闻」：

- 运行开关（`lifeFeed.enabled`）；
- 觅食间隔（默认 360 分钟，±20% 抖动；首次开启 1 分钟后先跑一次）；
- 每天最多领取/分享（默认 2 次）；
- 单次觅食上限、候选队列上限、时长范围、额外/排除关键词；
- 从哪些群提炼兴趣（不勾 = 沿用聊天白名单）。

配置段在 `config.json` 的 `lifeFeed`，默认值见 `src/core/config-legacy.js`。

## 数据流

```text
每 6 小时 ± 抖动
  -> 兴趣画像：人设 roles/interests.json topics + 群聊近 7 天高频词
  -> B 站热门 + 按兴趣搜索（只读公开接口，无登录无 Cookie）
  -> 打分/去重（同 BV 30 天、同 UP 每天 1、同标签最多 2）
  -> data/life-feed.json 候选队列

主动发言时机
  -> 提示词追加一句"可以调用 life_feed_next 看看"
  -> 模型挑选 -> 用自己的人设写 -> send_message（现有分条/限速/安静时段）
  -> life_feed_feedback 标记 shared/skip/more_like_this
```

分享**不新增发送通道**：它复用 `send_message`，所以安静时段、暂停、观察模式、白名单、限速、
预算全部照旧生效。

## 插件数据源（`feed`）

插件声明 `feed` 能力后，可调 `cap.feed.publish` 把条目提交到
`data/life-feed-inbox/<pluginId>.json`；生活层在下次觅食时吸收。插件不能调模型、不能发消息，
每插件每天最多 20 条。抖音/小红书等第三方数据源可以走这条路接入。

## 状态与运维

- 状态文件：`data/life-feed.json`（原子写 0600；损坏会留 `.broken-<时间戳>`）。
- 重启时若上次觅食未完成，会标成 `interrupted`，不会把半个队列当真。
- 失败退避 2/4/8/16/30 分钟；连续 3 次失败才值得看日志。
- 关闭功能不创建状态文件、不起定时器、不注册工具。
- 控制台接口：`GET /api/life-feed/status`、`POST /api/life-feed/forage|dismiss|share`。

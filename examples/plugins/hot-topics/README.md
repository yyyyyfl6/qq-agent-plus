# 热点 hot-topics

**科技圈当时在聊什么** —— V2EX / Hacker News 的热帖榜，整理成「标题 + 链接 + 热度」。
两个源都**不需要 Key**。

## 能做什么

- **两个榜**：V2EX（默认）与 Hacker News；每次几条可调（默认 5，最多 20）
- **只给榜单**：标题、链接、热度 —— 正文与摘要不抓，怎么念由模型决定
- **分别取源**：V2EX 直接读热帖接口；HN 先取 id 榜再并行取详情

## 群里怎么问

- 「今天有啥热点」
- 「V2EX 现在在聊什么」
- 「HN 头条前五条」

## 配置（可选，主要给测试 / 镜像用）

- `v2exUrl` —— 覆盖 V2EX 热帖地址
- `hnApiBase` —— 覆盖 HN 接口根（`/topstories.json` 与 `/item/<id>.json` 拼在它后面）

```json
{
  "plugins": {
    "settings": {
      "hot-topics": {
        "v2exUrl": "https://www.v2ex.com/api/topics/hot.json",
        "hnApiBase": "https://hacker-news.firebaseio.com/v0"
      }
    }
  }
}
```

指到内网地址会被宿主的网络守卫拦下 —— 有意的：插件不许绕过宿主自己上网。

## 边界

- **只读**，不能发言；不做定时播报（要等 v1.1 的 `send`）
- 排序与站点页面不一定逐条一致：读的是它们的公开接口
- 上游改接口会返回可读错误（例如「HN 的条目详情一条都没取到」），不会静默给空榜

## 装

控制台左侧「插件」→ 安装 → 启用。手工：把本目录拷到 `$DATA_DIR/plugins/hot-topics/`。

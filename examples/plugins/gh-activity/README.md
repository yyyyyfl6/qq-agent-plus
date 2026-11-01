# GitHub 仓库动态 gh-activity

**这个项目还活着吗** —— 一条命令看 star、最近提交、最新 issue、最后推送时间。
走 GitHub 公开 API，**不需要 Key**。

## 能做什么

- **一眼看活跃度**：star / fork、未关闭 issue 与 PR 数、最后推送时间、是否已归档
- **最近在改什么**：最近几次提交（作者 + 标题 + 时间）
- **最近在讨论什么**：最新几条 issue 标题

## 群里怎么问

- 「sakurawwwxh/qq-agent-plus 最近还更新吗」
- 「facebook/react 现在多少 star」
- 「这个库最近有没有人提 issue」+ 仓库地址

## 配置（可选）

- `perPage` —— 返回几条提交 / issue，默认 5（1-20）

```json
{ "plugins": { "settings": { "gh-activity": { "perPage": 5 } } } }
```

## 边界

- **只读**：不 star、不提 issue、不改任何东西；没有 `send`，不能在群里发言
- **不缓存**：每次即时查 GitHub —— 数字是最新的，也会消耗未认证的速率额度
- 提交 / issue 这两条子请求被限频或失败时，结果里带 `partial: true` 并写明哪一条没取到（不会把「没查到」说成「没有」）
- issue 正文很长的仓库（如 vscode / react）可能撞上宿主 40000 字符的取值上限：这时会先缩小窗口重试，仍不行就如实标 `partial`
- 请求经宿主的 `cap.http.request`（内网地址被拦、有体积上限与超时，日志里查得到）

## 装

控制台左侧「插件」→ 安装 → 启用。手工：把本目录拷到 `$DATA_DIR/plugins/gh-activity/`。

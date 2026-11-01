# 用 Google Vertex AI（服务账号 JSON）直连 Gemini

用自己 GCP 项目的额度 / 赠金调用 Gemini，**直连 Google 官方端点**，不经过任何第三方网关或中转。

## 原理

和 Google 官方 SDK（google-auth-library）做的是同一件事，只是用 `node:crypto` 写成零依赖（`src/llm/vertex-auth.js`）：

1. 用服务账号 JSON 里的 `private_key` 在本机签一个 JWT（RS256，scope `cloud-platform`）；
2. `POST https://oauth2.googleapis.com/token` 换一个 1 小时有效的访问令牌（到期前 5 分钟自动续，结果缓存）；
3. 用这个令牌请求 Vertex 官方的 OpenAI 兼容端点
   `https://aiplatform.googleapis.com/v1/projects/<project>/locations/global/endpoints/openapi/chat/completions`。

安全闸：访问令牌只发往 `aiplatform.googleapis.com` / `<region>-aiplatform.googleapis.com`；换令牌只请求
`oauth2.googleapis.com`（JSON 里 `token_uri` 指向别处直接拒绝）；报错不回显私钥、签名断言与令牌。
聊天、人格的总结模型、记忆整理、识图探测、控制台「测试连通性」全部走同一条鉴权。

## GCP 侧准备（一次）

1. 在要扣赠金的项目里启用 **Vertex AI API**（`aiplatform.googleapis.com`）。
2. IAM → 服务账号 → 新建，授予角色 **Vertex AI User**（`roles/aiplatform.user`）。
3. 该服务账号 → 密钥 → 添加密钥 → JSON，下载得到一份 `xxx.json`。妥善保管，别提交进仓库。

## 控制台配置

设置 → 模型 API：

- **服务预设**选「Google Vertex AI（服务账号 JSON）」，Base URL 会填成
  `https://aiplatform.googleapis.com/v1/projects/{project}/locations/global/endpoints/openapi`
  （`{project}` 自动换成 JSON 里的 `project_id`；要用别的地区就把 `global` 改成如 `us-central1`，
  主机同时改成 `us-central1-aiplatform.googleapis.com`）。
- **API Key** 一栏把整份 JSON 粘进去（换行被输入框去掉也没关系，仍是合法 JSON）。
- **模型 id** 手填，例如 `google/gemini-2.5-flash`、`google/gemini-2.5-pro`（Vertex 的 OpenAI 兼容端点用
  `google/` 前缀）。该端点不提供 `/models` 列表，「获取列表」拉不到是正常的。
- 点「测试连通性」确认能回 `pong`。

双人格（`/skins.html`）里也可以给某个人格单独选这家提供商与 Gemini 模型。

## 排错

| 现象 | 原因 |
| --- | --- |
| `换取访问令牌失败 HTTP 400（invalid_grant …）` | JSON 不完整 / 密钥已被删除 / 服务器时间偏差太大 |
| 聊天 `HTTP 403` | 服务账号缺 Vertex AI User 角色，或项目没启用 Vertex AI API |
| 聊天 `HTTP 404` | 模型名不对（要带 `google/` 前缀）或该地区不提供这个模型 |
| `服务地址不是 Vertex 官方地址` | Key 填的是服务账号 JSON，但 Base URL 指向了别家：安全闸拒绝外发 |

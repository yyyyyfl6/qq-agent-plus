# 提交技能到官方市场

官方技能市场是**审核制索引**：创作者把技能文件托管到公开地址，提交索引条目；维护者校验后合并到
[`qq-agent-skills`](https://github.com/sakurawwwxh/qq-agent-skills) 的 `index.json`。控制台不提供匿名上传接口 —— 自托管控制台可能直接暴露在公网，
开放任意文件写入等于把提示词和工具白名单交给陌生人。

普通用户不需要做任何事：在「技能 → 技能市场」点刷新，就能看到审核通过的技能并一键安装。

## 1. 准备技能目录

```
my-skill/
├── skill.json
└── SKILL.md
```

`skill.json` 最少要有：

```json
{
  "id": "trip-planner",
  "name": "出行规划",
  "version": "1.0.0",
  "description": "一句话说明这个技能解决什么问题",
  "allowedTools": ["web_search", "web_fetch", "send_message"],
  "triggers": ["帮我规划行程"]
}
```

约束：

- 只允许 Markdown / JSON，不执行代码；
- `id` 小写字母/数字/连字符，2–64 位，不能与内置技能重名；
- `SKILL.md` ≤64KB，单个文件 ≤128KB，整包 ≤512KB，最多 8 个文件；
- `allowedTools` 只能收窄工具，不能新增工具或权限。

## 2. 托管到公开地址

把目录里的 `skill.json`、`SKILL.md` 放到无需登录即可访问的地址。GitHub raw 最省事：

```
https://raw.githubusercontent.com/<you>/<repo>/main/skills/my-skill/
```

文件地址必须稳定；更新技能时换新版本号并更新哈希，不要直接覆盖旧文件（已安装用户不会自动重装）。

## 3. 生成索引条目

```bash
node scripts/skill-pack.mjs ./my-skill \
  --base-url https://raw.githubusercontent.com/<you>/<repo>/main/skills/my-skill \
  --author <you> \
  --category 生活 \
  --homepage https://github.com/<you>/<repo>
```

脚本会跑与安装相同的 manifest 校验，计算每个文件的 `sha256`，并输出一段 JSON。`preview` 默认取
`SKILL.md` 前 240 字，用来在控制台里免下载展示摘要。

## 4. 提交

二选一：

- 打开 [技能提交 issue](https://github.com/sakurawwwxh/qq-agent-skills/issues/new?template=skill-submission.yml)，
  贴上脚本输出；
- 或直接给 [qq-agent-skills](https://github.com/sakurawwwxh/qq-agent-skills) 提 PR，在 `index.json` 追加条目。

维护者会在索引仓库运行：

```bash
node scripts/check.mjs
```

它校验索引字段、semver、文件哈希/大小，以及本地文件与 manifest 是否一致。通过后合并，市场刷新即可见。

## 审核标准

- 技能流程不能要求模型忽略安全规则、泄露密钥或绕过工具审批；
- `allowedTools` 只包含技能真正需要的工具；
- 不包含个人信息、侵权素材、付费内容或需要登录才能访问的文件；
- 描述和 `preview` 要与实际流程一致，不能夸大成"自动执行"；
- 版本号必须递增，文件哈希必须与内容一致。

## 消费者侧

用户在「技能 → 技能市场」卡片上看到的是索引摘要，不会为了浏览列表下载整包；打开详情时读取 manifest 与 SKILL.md 两个文件，
点「安装」才下载全部文件并逐文件校验 `sha256`。安装后默认未启用，需要管理员在「已安装」里打开并按会话配置。

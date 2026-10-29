# 技能包（Skill Pack）

技能是**只读的工作方法**，不是插件：它不执行代码，也不直接拿网络、文件、密钥或模型权限。
宿主只读取这里的 `skill.json` 与 `SKILL.md`，模型在 `skill_use` 后按技能流程做事，本轮可用
工具会被收窄到 `allowedTools`。


> 官方市场索引现在独立在 [qq-agent-skills](https://github.com/sakurawwwxh/qq-agent-skills)；
> 这里的 `skills/market.json` 只作为本地示例/离线校验镜像保留。

## 目录

```text
skills/<id>/
  skill.json
  SKILL.md
```

用户技能放在 `data/skills/<id>/`，与内置技能同格式；同名 id 保留先加载的内置版本，
不会让用户文件静默覆盖官方技能。

## skill.json

```json
{
  "id": "chat-summary",
  "name": "群聊总结",
  "version": "1.0.0",
  "description": "把最近一段群聊整理成几条结论。",
  "allowedTools": ["get_recent_messages", "send_message"],
  "triggers": ["总结一下", "帮我回顾"]
}
```

- `id`：小写字母/数字/连字符，2–64 位；
- `allowedTools`：最多 40 个宿主工具名；`finish`、`skill_list`、`skill_use` 始终允许；
- `triggers`：只用于控制台展示/人工选择，不会自动触发；
- `SKILL.md`：≤64KB，只写流程、边界与输出格式，不写代码。

## 启用

控制台「技能」页打开总开关，再勾选全局或按群启用。默认关闭；关闭时不加载技能、
不注册 `skill_list` / `skill_use`，也不会改变任何工具表。

## 安全边界

技能是管理员显式启用的文本，但仍按第三方内容对待：

- 不能执行代码、读文件、拿 secrets；
- 不能新增工具，只能收窄；
- 不能改变安全规则、管理员权限或发送队列；
- 不自动触发，不能因为群友说“进入 xx 技能”就绕过启用状态。

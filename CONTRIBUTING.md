# 参与贡献

先感谢你愿意花时间。这个项目是单维护者的开源项目，下列约定是为了让改动能被快速评审、合入后
不返工。读完这份再动手，能省掉一轮往返。

## 四条硬约束（涉及部署与运行环境的改动尤其重要）

1. **不要以 root 部署**：`deploy-all.sh` 直接拒绝 root；`deploy.sh` 要求以服务用户身份运行。
2. **不要用 PM2 / 面板的 Node 项目启动**：进程由 systemd **用户**服务托管，`manage.sh` 依赖
   `systemctl --user`。
3. **`manage.sh` 必须在安装目录（含 `.deployment.json` 的那一层）里执行**：在源码 checkout
   里跑会报 `Deployed Node.js runtime is unavailable` —— 那是目录不对，不是 Node 坏了。
4. **更新时的参数会与安装记录强校验**：`deploy.sh` 在部署开始前比对
   `--install-dir/--data-dir/--service/--repository/--branch`（`scripts/verify-deployment-target.mjs`），
   不符直接拒绝（此时什么都没动，无需回滚）。数据目录迁移需 `--allow-path-change` +
   `QQ_AGENT_ALLOW_PATH_CHANGE=1` 双条件。

## 开发闭环（提交前必须全绿）

```bash
npm ci                    # 首次
npm run lint              # ESLint：0 error（含 ui/ 的体积闸门 max-lines 1800）
npm run test:unit         # 单元测试
npm run test:local        # 本地回归
node src/ops.js scan --strict   # 未定义调用扫描
bash -n deploy.sh && bash -n deploy-all.sh && bash -n manage.sh   # 改过 shell 才需要；bash -n 只查第一个文件，必须逐个跑
```

改了渲染/滚动/用量相关：另跑 `npm run test:render`、`node test/scroll-test.mjs`、
`node test/usage-e2e.mjs`。CI（`.github/workflows/ci.yml`）会跑全部这些。

**改了 `ui/`（控制台前端）另外三件事**（约定写在 `AGENTS.md`）：

- 跨文件引用一律 `import`（每个文件顶部列全、尾部 `export` 出被用到的）——
  **不许再有共享全局**，`test/ui-module-graph.test.mjs` 判红；新增文件要同时进 `ui/index.html` 清单；
- 接管渲染入口走 `QARegistry`（`onTransform` / `onAfter` / `override` + `base`），
  **不要**写 `window[name] = wrapped` 或裸赋值；跨文件可变状态挂 `state`（模块级 `let` + `export`
  会被判红：import 绑定只读，别人一写就 TypeError）；
- 跑一遍 `docs/UI-SMOKE.md` 的手工清单（自动化只覆盖"渲染不抛 + 钩子接上了"，布局与事件靠人看）。

**回归判断口径**：Windows 上只允许显式 skip，不允许 fail（`docs/KNOWN-ISSUES.md`
「环境相关」一节）。跨平台可修项直接修；POSIX/Linux-only 用例用
`test/helpers/platform.mjs` 带原因跳过。跑 `npm run test:unit:win` 时，任何未预期失败即红；
CI 的 ubuntu runner 仍是全量通过的权威结论。

## 改动的三条铁律

1. **修 bug 必配用例**，并且要做"把修复回退掉、用例必须变红"的验证（否则可能是假绿）。
   这个仓库的用例总数只涨不跌。
2. **新增配置一律"新增字段 + 默认值 = 现状"**：老 `config.json` 一字不改也能跑，新开关默认关闭。
3. **破坏性/不可逆操作要显式确认**：新的运维子命令涉及删数据、写系统目录、真实发送的，
   必须要求 `--confirm`（照 `src/ops.js` 现有子命令的样子），默认只预演。

## 提交与发布

- 提交信息用 `type(scope): 简述`，正文写**为什么**（失败模式 → 现行做法），别只写改了什么。
- 一个改动一个提交，独立可回滚；结构性重构拆小步、每步全绿。
- 版本号走补丁位（`0.8.x`），不跳 minor；发布节奏由维护者按批次攒着发（见 `AGENTS.md`）。
- **不要在 PR / Issue / Release 文案里写裸的 `@用户名`**：GitHub 会解析成真人账号并通知对方。

## 文档同步

- 改动涉及行为/配置/运维：同步 `docs/` 对应篇章，并在 `docs/CHANGES.md` 加一行
  （格式：`失败模式 → 现行做法`）。
- 新增文档：登记进 `docs/README.md` 索引（`test/docs-index.test.mjs` 会检查索引里的文件都存在）。
- 实验功能照 `docs/EXPERIMENTAL_FEATURE_STANDARD.md` 的规范（开关、默认值、降级、转正流程）。

## 环境与依赖

- Node **>= 22.19**（`node:sqlite` 内置模块；`.nvmrc` 记着线上版本）。
- 运行时依赖保持精简（当前 5 个）；开发工具走 `devDependencies`，生产 `npm ci --omit=dev` 不安装，
  自动更新器同样 `--omit=dev`。**测试要能容忍 devDeps 缺失**（缺件自动 skip，不许硬失败）。
- 提交前 `git status` 确认没把 `data/`、密钥、日志带进来。

## 安全

- 控制台的明文密钥端点只允许本机访问（`keyEndpointAllowed`），新增密钥相关接口必须走同一道闸门。
- 任何把外部文本（网页、群消息、昵称）注入模型提示词的地方，必须过 `sanitizeUserText`。
- 发现安全问题请走 GitHub Security Advisory 或私信维护者，不要开公开 Issue。

## 有问题

开 Issue 说清：版本（`/healthz` 的 version）、部署方式（systemd / 宝塔 / 容器）、
复现步骤、`journalctl --user -u qq-agent-linux -n 100` 的相关片段（**先脱敏**）。

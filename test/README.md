# 测试布局

所有用例都在这个目录下，分成四类。跑之前不需要任何额外服务（协议端与模型都是桩件）。

## 1. 单元测试（CI 跑）

```
test/*.test.mjs      # node:test，一个文件管一块（清单看 ls test/*.test.mjs，别写死数量）
```

- 命令：`npm run test:unit`（= `node scripts/test-suite.mjs unit`，等价于 `node --test test/*.test.mjs`）
- CI 与发版流程都会跑；**新增用例请放在这里**，文件名用 `*.test.mjs`。
- 需要连真协议端/真模型的用例不要写在这一类：这里必须能在无网、无 docker 的机器上跑。
- 其中 `layout.test.mjs` 是"目录布局不变量"（ROOT 指向仓库根、相对 import 全部可解析、
  硬编码入口没被挪走）——挪文件前后它最先报警。

## 2. 独立脚本（不在 test:unit 里，但 CI 会单独跑）

```
test/test-prompt.mjs    # 提示词自检：拼装结果与各段是否齐全
test/render-test.mjs    # 控制台各设置分区渲染（在 vm + DOM 桩里跑真实 ui/app.js）
test/scroll-test.mjs    # 会话列表滚动与节流
test/usage-e2e.mjs      # 用量页端到端（真起服务 + 真接口，无 mock）
test/browser/*.spec.mjs # 真 Chromium 冒烟（Playwright；脚本 scripts/e2e-server.mjs）
```

- 命令：`npm run test:prompt` / `test:render` / `test:scroll` / `test:usage`
- 真浏览器：`npm run test:browser`（先 `npx playwright install chromium`；CI 独立 job）。
- 四个脚本都在 `npm test` 里串起来跑；浏览器冒烟单独跑（它要起真服务 + Chromium）。
- `render-test.mjs` 与 `usage-e2e.mjs` 会各自现拿一个空闲端口起服务，不再固定占用 `127.0.0.1:3210`
  （开着控制台隧道也能跑）。

## 3. 本地回归（CI 跑）

```
test/local/run.mjs        # 串行跑下面的用例，自动用临时数据目录
test/local/test-*.mjs     # 发送/贴纸/空间互动/内联兜底等回归
```

- 命令：`npm run test:local`
- **必须用临时 `QQ_AGENT_DATA_DIR`**（`run.mjs` 已经处理）；这些用例会写 config.json，
  指到生产数据目录会把线上配置覆盖掉（血泪教训）。
- 需要真协议端行为的用例写在这里（用桩件模拟工具层）。

## 4. 约定

- 用例自己造临时目录（`mkdtemp`），跑完清理；不要依赖仓库里的 `data/`。
- 不要在用例里读真实凭据或碰网络：需要网络的一律注入 `fetchImpl` 桩件。
- 改完 `src/` 下的相对路径或移动文件，先跑 `layout.test.mjs` 与 `npm run test:local`。
- **Windows 口径（2026-10 起）**：只允许显式 skip，不允许 fail。跨平台可修的断言已经修掉
  （PATH 分隔符、权限位断言等）；真正依赖 POSIX/Linux 的用例用 `test/helpers/platform.mjs`
  的 `posixOnly` / `skipUnlessLinux` / `skipUnlessBash` / `skipUnlessDocker` 带原因跳过。
- Windows 门禁命令：`npm run test:unit:win`（spec 报告 + `scripts/baseline-diff.mjs`，
  `test/baseline-failures.json` 应为空；任何未预期失败都会红）。CI 有独立的 `windows` job。

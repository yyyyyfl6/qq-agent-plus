#!/usr/bin/env node
// 插件脚手架：一条命令生成一个**能跑、能自测**的插件骨架。
//
// 目标是把我写在 docs/PLUGINS.md 里的"怎么写"变成"敲一条命令就有了"：生成出来的东西
// 立刻能用 scripts/plugin-dev.mjs 起来调工具，能用 scripts/plugin-pack.mjs 打包自测、
// 生成索引条目。生成的代码刻意保持"人写的样子"（注释说清为什么，不留脚手架味儿）。
//
// 用法：
//   node scripts/plugin-create.mjs my-plugin
//   node scripts/plugin-create.mjs my-plugin --name "我的插件" --author 你的名字 --dir ~/plugins
import fs from 'node:fs';
import path from 'node:path';
import { parsePluginManifest } from '../src/plugins/manifest.js';

const args = process.argv.slice(2);
const id = args.find((a) => !a.startsWith('--'));
const flag = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : (args[i + 1] ?? fallback);
};

if (!id) {
  console.error('用法：node scripts/plugin-create.mjs <插件id> [--name 显示名] [--author 你的名字] [--dir 放到哪个目录] [--tool 工具名] [--api-version 1|2]');
  process.exit(2);
}
if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(id)) {
  console.error(`✗ 插件 id 只能是小写字母/数字/连字符（2-32 位，首字符为字母或数字），实际收到 ${JSON.stringify(id)}`);
  process.exit(2);
}

const parent = path.resolve(flag('dir') || process.cwd());
const target = path.join(parent, id);
if (fs.existsSync(target) && fs.readdirSync(target).length) {
  console.error(`✗ ${target} 已存在且不为空，换个 id 或换个 --dir`);
  process.exit(2);
}

const displayName = flag('name') || id;
const author = flag('author') || '<你的名字>';
const tool = flag('tool') || 'hello';
const apiVersion = Number(flag('api-version', '1')) === 2 ? 2 : 1;
if (!/^[a-z][a-z0-9_]{1,31}$/.test(tool)) {
  console.error(`✗ 工具名只能是小写字母开头的字母/数字/下划线（2-32 位），实际收到 ${JSON.stringify(tool)}`);
  process.exit(2);
}

const manifest = {
  id,
  apiVersion,
  name: displayName,
  version: '0.1.0',
  description: `${displayName}（一句话说清它给机器人加了什么能力）`,
  entry: 'index.mjs',
  capabilities: ['tools', 'log'],
  tools: [
    {
      name: tool,
      description: '把收到的参数原样回显（先把骨架跑通，再换成你要做的事）',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '想让插件回显的文字' } },
        required: ['text']
      }
    }
  ]
};

// v2 骨架：把 settings / http / storage / 写动作（approval+quota）都摆出来，
// 让作者知道"要联网、要配置、要写外部数据"分别该声明什么，而不是从文档里猜。
if (apiVersion === 2) {
  manifest.capabilities = ['tools', 'log', 'config', 'http', 'storage', 'approval', 'quota'];
  manifest.httpDomains = ['api.example.com'];
  manifest.settings = {
    groups: [{
      key: 'account',
      title: '插件设置',
      fields: [{
        key: 'channel',
        label: '频道 / 模式',
        type: 'text',
        default: 'demo',
        help: '示例字段：真实插件按需要改。密钥类字段把 type 改成 secret，宿主会加密保存。'
      }]
    }]
  };
  manifest.approvals = [{
    action: 'write',
    label: '写一条演示内容',
    description: '示例写动作：每次执行都需要管理员针对具体目标批准一次'
  }];
  manifest.quotas = { write: 10 };
  manifest.tools.push({
    name: 'write_demo',
    description: '写一条演示内容（需要管理员批准；真实插件请把这里换成实际写操作）',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '写到哪里（对象级批准会绑定这个值）' },
        text: { type: 'string', description: '要写入的内容（批准会绑定这段正文）' }
      },
      required: ['target', 'text']
    },
    action: 'write',
    actionTarget: 'target',
    actionPreview: 'text'
  });
}

// 先自己校验一遍：脚手架生出来的 manifest 必须过得了宿主那一关，否则作者第一步就踩坑
const checked = parsePluginManifest(manifest, { dir: target });
if (!checked.ok) {
  console.error(`✗ 生成的 manifest 没通过宿主校验（这是脚手架的 bug，请提 issue）：${checked.error}`);
  process.exit(1);
}

const indexJs = `// ${displayName}：插件入口。
//
// 这里只用 stdin/stdout 上的一段 JSON 协议（一行一个 JSON），不 import 宿主的任何内部模块 ——
// 契约见 docs/PLUGINS.md，${'`apiVersion: 1`'}。宿主会按 manifest 里声明的能力注入能力对象：
// 你现在声明了 tools / log，所以能调 cap.log.write；要用网络就加 http 声明再调 cap.http.request。
const send = (message) => { process.stdout.write(\`\${JSON.stringify(message)}\\n\`); };

let requestSeq = 0;
const pending = new Map();

/** 调宿主的能力：带自增 id，应答按 id 回来。 */
const callHost = (method, params) => new Promise((resolve, reject) => {
  const id = ++requestSeq;
  pending.set(id, { resolve, reject });
  send({ id, method, params });
});

const tools = {
  // 工具名与 manifest 里声明的一致；参数就是模型传进来的那个对象
  ${tool}: async (args) => {
    const text = String(args?.text ?? '');
    // 经宿主的日志出口写一行：好处是统一前缀、统一脱敏，控制台里能一起看到
    await callHost('cap.log.write', { level: 'info', message: \`有人调了 ${tool}：\${text.slice(0, 60)}\` });
    return { echo: text, at: new Date().toISOString() };
  }${apiVersion === 2 ? `,
  write_demo: async (args) => {
    const target = String(args?.target ?? '');
    const text = String(args?.text ?? '');
    // 真实写操作放在这里；宿主已经在调用前完成了开关/批准/配额/目标校验。
    await callHost('cap.log.write', { level: 'info', message: \`write_demo -> \${target}\` });
    return { ok: true, target, text };
  }` : ''}
};

async function handleRequest(message) {
  const reply = (payload) => send({ id: message.id, ...payload });
  switch (message.method) {
    case 'init':
      // 插件自己的配置在 message.params.settings 里（线上等价于 plugins.settings.${id}）
      reply({ result: { ok: true } });
      return;
    case 'ping':
      reply({ result: {} });
      return;
    case 'schedule':   // manifest 里没声明周期任务时宿主不会调；留着当模板
      reply({ result: {} });
      return;
    case 'callTool': {
      const name = String(message.params?.name ?? '');
      const fn = tools[name];
      if (!fn) return reply({ error: { code: 'E_NO_TOOL', message: \`没有这个工具：\${name}\` } });
      try { reply({ result: await fn(message.params?.args ?? {}) }); }
      catch (error) { reply({ error: { code: error?.code || 'E_TOOL', message: String(error?.message ?? error) } }); }
      return;
    }
    case 'shutdown':
      reply({ result: {} });
      setTimeout(() => process.exit(0), 10);
      return;
    default:
      reply({ error: { code: 'E_NO_METHOD', message: \`未知方法：\${message.method}\` } });
  }
}

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index = buffer.indexOf('\\n');
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      let message = null;
      try { message = JSON.parse(line); } catch { message = null; }
      if (message && typeof message.method === 'string' && message.id !== undefined) handleRequest(message);
      else if (message && message.id !== undefined) {
        const entry = pending.get(message.id);
        if (entry) {
          pending.delete(message.id);
          if (message.error) entry.reject(Object.assign(new Error(message.error.message || '能力调用失败'), { code: message.error.code }));
          else entry.resolve(message.result ?? null);
        }
      }
    }
    index = buffer.indexOf('\\n');
  }
});
`;

// ⚠️ 这个 README 会**原样成为插件市场的详情页正文**（索引条目的 readme 字段就是它）。
// 所以第一段必须先是"给使用者看的"：能做什么、怎么问 —— 开发说明放后半段。
// （2026-10-17 模拟外部作者发布时发现：默认模板整篇是开发步骤，装的人打开详情页看到的是
// "cd <宿主仓库> / 提交 PR"，完全不是他要的东西。）
const readme = `# ${displayName}

**一句话说清它给机器人加了什么能力**（这句会显示在市场的卡片上）。

## 能做什么

- **第一个卖点**：一句人话，说清用它之后群里能做什么
- **第二个卖点**：一条一行，不要写实现细节（读者是"装插件的人"，不是作者）

## 群里怎么问

- 「……」
- 「……」

_（上面两节请改成你自己的；它们就是插件的市场页面。下面几节是给作者自己的开发说明。）_

---

机器人插件（OneBot 生态的第三方扩展）。契约：\`docs/PLUGINS.md\`（宿主仓库里）。

## 先跑起来

\`\`\`bash
cd <宿主仓库>

# 1) 本地起这个插件（真协议 + 真隔离 + 假 QQ），交互式试工具
node scripts/plugin-dev.mjs ${target}

#   或者一次性调用（脚本/CI 友好）
node scripts/plugin-dev.mjs <插件目录> --call ${tool} --args '{"text":"你好"}'
\`\`\`

## 打包 + 自测 + 生成索引条目

\`\`\`bash
node scripts/plugin-pack.mjs <插件目录> --base-url https://github.com/${author}/${id} --tag v0.1.0 --min-version 0.8.5 --tags 工具
\`\`\`

它会：打成 \`${id}-0.1.0.tar.gz\`（同一份源码打出的包逐字节相同）→ **用宿主自己的安装器真装一遍**
→ 打印可直接粘进索引的 JSON。自测不过就不用往下走。

## 发布

1. 把包传到你的 GitHub Release（tag 可以在同一个 Release 上兜多份包，不必每个版本一个 tag；
   默认沿用条目里已经挂着的那个 tag，避免写出一个不存在的 Release 地址），
2. 把生成的索引条目提 PR 到索引仓库（宿主仓库里的 \`plugins/index.json\` 只是指路牌）：
   \`https://github.com/sakurawwwxh/qq-agent-plugins\`。索引条目里的 \`sha256\` 必须与 Release
   上那个文件一致 —— 索引仓库的 CI 会校验，不一致会被挡下。

## 三个约定（v1 的硬约束）

- **零第三方依赖**：不打 npm 包，依赖内联进来（安装时不会在用户机器上跑 npm）。
- **拿不到凭据**：插件进程被关在只读自己目录的沙箱里，读不到 \`config.json\`；要配置就声明 \`config\` 能力，
  让用户填在 \`plugins.settings.${id}\`（**密钥不要写进代码**）。
- **不能拖垮机器人**：宿主有超时与心跳，崩了会自动重启、连续崩到第 4 次时停用；但别写死循环。
`;

fs.mkdirSync(target, { recursive: true });
fs.writeFileSync(path.join(target, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
fs.writeFileSync(path.join(target, 'index.mjs'), indexJs);
fs.writeFileSync(path.join(target, 'README.md'), readme);
if (apiVersion === 2) {
  fs.writeFileSync(path.join(target, 'dev-settings.json'), `${JSON.stringify({ channel: 'demo' }, null, 2)}\n`);
}

console.log(`✓ 已生成插件骨架：${target}`);
console.log(`
  plugin.json   清单（id=${id}，apiVersion=${apiVersion}，能力=${manifest.capabilities.join('/')}，工具=${manifest.tools.map((t) => t.name).join('/')}）
  index.mjs     入口（真协议骨架，直接能用）
  README.md     怎么起、怎么打包、怎么发布

下一步：
  1) 本地起起来试试（交互式，能敲工具名）：
     node scripts/plugin-dev.mjs ${target}
  2) 打包 + 自测 + 生成索引条目：
     node scripts/plugin-pack.mjs ${target} --base-url https://github.com/${author}/${id} --tag v0.1.0
  3) 改 index.mjs 里那个 ${tool} 工具，把它换成你真正想做的事。`);

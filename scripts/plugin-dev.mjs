#!/usr/bin/env node
// 假宿主：本地起一个插件、按真协议对话，不用跑机器人本体。
//
// 作者写插件最缺的就是这个：真协议 + 真隔离 + 假 QQ。它做的事：
//   · 用**真** manifest 校验 + **真** PluginHost（同一条隔离参数、同样的能力鉴权）起插件；
//   · 一次性模式：--call / --observe / --schedule，脚本与 CI 都能用；
//   · 交互模式：一个命令循环，手敲就能试工具、看越权被拒、看日志；
//   · 能力调用（cap.http.request 等）走**宿主侧实现**——所以你在这里看到的网络拦截/体积上限
//     就是线上那一套，不会"本地过、线上挂"。
//
// 用法：
//   node scripts/plugin-dev.mjs <插件目录>
//   node scripts/plugin-dev.mjs <插件目录> --call players --args '{"host":"play.example.com"}'
//   node scripts/plugin-dev.mjs <插件目录> --observe '{"chatKey":"group:1","text":"喂"}'
//   node scripts/plugin-dev.mjs <插件目录> --json          # 机器可读输出
//   node scripts/plugin-dev.mjs <插件目录> --call write_demo --approve-all
//   node scripts/plugin-dev.mjs <插件目录> --call fetch_demo --http-mock '{"api.example.com":{"status":200,"body":"{\"ok\":true}"}}'
//
// --approve-all / --http-mock 只在这个假宿主里生效，生产宿主没有这两个注入点。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { parsePluginManifest } from '../src/plugins/manifest.js';
import { PluginHost } from '../src/plugins/host.js';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? '' : (args[i + 1] ?? '');
};
const has = (name) => args.includes(`--${name}`);
const asJson = has('json');

if (!dir) {
  console.error('用法：node scripts/plugin-dev.mjs <插件目录> [--call 工具名 --args \'{"…":1}\'] [--observe \'{"…":1}\'] [--schedule 任务名] [--approve-all] [--http-mock JSON或文件] [--json]');
  process.exit(2);
}

const fail = (message) => {
  console.error(asJson ? JSON.stringify({ ok: false, error: message }) : `✗ ${message}`);
  process.exit(1);
};

const root = path.resolve(dir);
const manifestPath = path.join(root, 'plugin.json');
if (!fs.existsSync(manifestPath)) fail(`${root} 里没有 plugin.json`);
let raw = null;
try { raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
catch (error) { fail(`plugin.json 不是合法 JSON：${error?.message ?? error}`); }
const parsed = parsePluginManifest(raw, { dir: root });
if (!parsed.ok) fail(`manifest 校验没过：${parsed.error}`);

const logs = [];
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-dev-'));
// 开发者本机的"插件配置"：读插件目录旁的 dev-settings.json（若你给的话），方便试需要配置的分支
let settings = {};
const settingsFile = path.join(root, 'dev-settings.json');
if (fs.existsSync(settingsFile)) {
  try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); }
  catch (error) { console.warn(`（dev-settings.json 读不了，按空配置跑：${error?.message ?? error}）`); }
}

// --approve-all：写动作不再需要人工批准（只影响 approvalCheck；配额/开关仍按 manifest 走）
const approveAll = has('approve-all');
// --http-mock：把指定 URL 的 cap.http.request 直接返回固定响应，格式两种都吃：
//   { "api.example.com": { "status": 200, "body": "..." } }   按 URL 子串匹配
//   [{ "match": "/v1/play", "method": "POST", "status": 200, "body": "..." }]
const httpMockRaw = flag('http-mock');
let httpMock = null;
if (httpMockRaw) {
  let spec = null;
  try {
    const text = /^[\[{]/.test(httpMockRaw.trim())
      ? httpMockRaw
      : fs.readFileSync(path.resolve(httpMockRaw), 'utf8');
    spec = JSON.parse(text);
  } catch (error) {
    fail(`--http-mock 需要 JSON 或 JSON 文件：${error?.message ?? error}`);
  }
  const entries = Array.isArray(spec)
    ? spec
    : Object.entries(spec && typeof spec === 'object' ? spec : {}).map(([match, value]) => (
      value && typeof value === 'object' ? { match, ...value } : { match, body: String(value ?? '') }
    ));
  if (!entries.length) fail('--http-mock 里没有规则');
  for (const entry of entries) {
    if (!entry || typeof entry.match !== 'string' || !entry.match) fail('每条 --http-mock 规则都要有 match 字符串');
  }
  httpMock = ({ url, method }) => {
    const hit = entries.find((entry) => (!entry.method || String(entry.method).toUpperCase() === method)
      && url.includes(entry.match));
    if (!hit) return null;
    return { status: Number(hit.status) || 200, body: hit.body ?? '', headers: hit.headers || {} };
  };
}

const host = new PluginHost({
  manifest: parsed.manifest,
  dataDir,
  // 插件自己的那段配置：从 dev-settings.json 读（线上等价于 plugins.settings.<id>）
  getSettings: () => settings,
  approveAll,
  httpMock,
  log: (...parts) => { const line = parts.map(String).join(' '); logs.push(line); if (!asJson) console.log(`  [宿主日志] ${line}`); }
});
const cleanup = () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 上句柄占用就算了 */ } };

const started = await host.start();
if (!asJson) {
  console.log(`插件：${parsed.manifest.name} v${parsed.manifest.version}（${parsed.manifest.id}）`);
  console.log(`能力：${parsed.manifest.capabilities.join(' / ')}`);
  console.log(`工具：${parsed.manifest.tools.map((t) => t.name).join(', ') || '（无）'}`);
  console.log(`周期：${parsed.manifest.schedule.map((s) => `${s.name} 每 ${Math.round(s.everyMs / 60000)} 分钟`).join(', ') || '（无）'}`);
  console.log(`隔离：${host.unconfined ? '⚠️ 未隔离（本机不支持或配置关掉了 requireIsolation）' : '已开启（读不到插件目录外的文件、起不了子进程）'}`);
  if (approveAll || httpMock) {
    console.log(`开发开关：${[approveAll ? '--approve-all' : '', httpMock ? '--http-mock' : ''].filter(Boolean).join(' ')}（只在本脚本生效）`);
  }
}
if (!started) {
  if (asJson) console.log(JSON.stringify({ ok: false, started: false, error: host.lastError, logs }));
  else console.error(`✗ 启动失败：${host.lastError}`);
  await host.stop(); cleanup();
  process.exit(1);
}

/** 统一的调用出口：结果按"人看"或"机器看"两种格式打印。 */
async function callTool(name, payload) {
  const startedAt = Date.now();
  try {
    const result = await host.callTool(name, payload);
    const ms = Date.now() - startedAt;
    if (asJson) console.log(JSON.stringify({ ok: true, tool: name, ms, result }));
    else console.log(`✓ ${name}（${ms}ms）\n${JSON.stringify(result, null, 2)}`);
    return true;
  } catch (error) {
    const ms = Date.now() - startedAt;
    if (asJson) console.log(JSON.stringify({ ok: false, tool: name, ms, error: String(error?.message ?? error) }));
    else console.error(`✗ ${name} 失败（${ms}ms）：${error?.message ?? error}`);
    return false;
  }
}

const oneShot = flag('call') || flag('observe') || flag('schedule');
if (oneShot) {
  let ok = true;
  if (flag('call')) {
    let payload = {};
    const rawArgs = flag('args');
    if (rawArgs) {
      try { payload = JSON.parse(rawArgs); }
      catch (error) { fail(`--args 不是合法 JSON：${error?.message ?? error}`); }
    }
    ok = await callTool(flag('call'), payload) && ok;
  }
  if (flag('observe')) {
    let event = {};
    try { event = JSON.parse(flag('observe')); }
    catch (error) { fail(`--observe 不是合法 JSON：${error?.message ?? error}`); }
    // observe 是通知：宿主不等回执，给它一拍时间让插件处理
    host.observe(event);
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (!asJson) console.log('✓ 已投递一条 observe 事件（插件侧应有反应，可再用 --call 查它的计数）');
  }
  if (flag('schedule')) {
    const ran = await host.runSchedule(flag('schedule'));
    if (asJson) console.log(JSON.stringify({ ok: ran, schedule: flag('schedule') }));
    else console.log(ran ? `✓ 已触发周期任务 ${flag('schedule')}` : `✗ 周期任务 ${flag('schedule')} 失败`);
    ok = ran && ok;
  }
  if (host.stats.denied && !asJson) console.log(`（本次被拒的越权调用：${host.stats.denied} 次——见上面的宿主日志）`);
  await host.stop(); cleanup();
  process.exit(ok ? 0 : 1);
}

// 交互模式
if (!process.stdin.isTTY) {
  await host.stop(); cleanup();
  fail('一次性用法要带参数，比如 --call <工具名> --args \'{"k":1}\'');
}
console.log('\n交互模式（默认发消息假 QQ=10001，群 group:1）。命令：');
console.log('  t <工具名> \'{"参数":1}\'   调一个工具；只敲 t 看已声明的工具');
console.log('  o \'{"text":"喂"}\'          投递一条入站消息（observe）');
console.log('  s [任务名]                  触发周期任务（只敲 s 看已声明的）');
console.log('  l                           看宿主日志（含越权被拒记录）');
console.log('  q                           退出\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'plugin-dev> ' });
rl.prompt();
rl.on('line', async (line) => {
  const text = String(line || '').trim();
  if (!text) { rl.prompt(); return; }
  const [cmd, ...rest] = text.split(/\s+/);
  const restText = text.slice(cmd.length).trim();
  const parseRest = () => {
    if (!restText) return {};
    try { return JSON.parse(restText); }
    catch { return null; }
  };
  if (cmd === 'q' || cmd === 'quit') { rl.close(); return; }
  if (cmd === 'l') { logs.forEach((l) => console.log(`  ${l}`)); rl.prompt(); return; }
  if (cmd === 't') {
    if (!rest.length) { console.log(`可用的工具：${parsed.manifest.tools.map((t) => t.name).join(', ') || '（无）'}`); rl.prompt(); return; }
    const payload = parseRest();
    if (payload === null) console.error('参数要是合法 JSON');
    else await callTool(rest[0], payload);
    rl.prompt(); return;
  }
  if (cmd === 'o') {
    const event = parseRest();
    if (event === null) console.error('参数要是合法 JSON');
    else { host.observe(event); console.log('✓ 已投递（宿主不等回执）'); }
    rl.prompt(); return;
  }
  if (cmd === 's') {
    const names = parsed.manifest.schedule.map((s) => s.name);
    if (!rest.length) { console.log(`已声明的周期任务：${names.join(', ') || '（无）'}`); rl.prompt(); return; }
    console.log(await host.runSchedule(rest[0]) ? '✓ 已触发' : '✗ 触发失败');
    rl.prompt(); return;
  }
  console.log('认不得的命令。t / o / s / l / q');
  rl.prompt();
});
rl.on('close', async () => {
  await host.stop();
  cleanup();
  console.log('已退出。');
  process.exit(0);
});

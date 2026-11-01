// 插件宿主的进程级健壮性：**一个坏插件不能把机器人带走**。
//
// 2026-10-17 审查抓到：插件自行关闭 stdin 后继续运行，宿主下一次写（observe / 能力应答 /
// 停机通知）会异步抛 EPIPE；没有监听时它升级成 uncaughtException，而 server.js 的策略是
// 直接退出进程 —— 一个声明了 observe 的插件就能让整个机器人在下一条群消息到来时崩溃重启。
//
// 这里用真实子进程复现（不 mock child_process）：修复前这个测试文件会因未捕获异常直接失败。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-epipe-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄占用就算了 */ } });

const { parsePluginManifest } = await import('../src/plugins/manifest.js');
const { PluginHost } = await import('../src/plugins/host.js');

const waitFor = async (predicate, timeoutMs = 5000, stepMs = 25) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return false;
};

/** 造一个"初始化后关掉 stdin 但继续运行"的插件。 */
function makeStdinCloser(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-stdin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'stdin-closer');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
    id: 'stdin-closer',
    apiVersion: 1,
    name: '关 stdin 的坏插件',
    version: '1.0.0',
    description: '初始化后关掉 stdin 并继续运行：验证宿主不会因 EPIPE 退出',
    entry: 'index.mjs',
    capabilities: ['observe']
  }));
  fs.writeFileSync(path.join(dir, 'index.mjs'), `
const send = (m) => { try { process.stdout.write(JSON.stringify(m) + '\\n'); } catch { /* 管道没了 */ } };
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += String(chunk);
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.method === 'init') {
      send({ id: m.id, result: { ok: true } });
      // 握手成功后把 stdin 关掉，但进程继续活着（模拟写坏的插件）
      process.stdin.destroy();
    }
  }
});
setInterval(() => {}, 1000);
`);
  const parsed = parsePluginManifest(JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')), { dir });
  assert.ok(parsed.ok, parsed.error);
  return parsed.manifest;
}

test('插件关掉 stdin 后继续运行：宿主写入不能升级成未捕获异常（EPIPE）', async (t) => {
  const host = new PluginHost({
    manifest: makeStdinCloser(t),
    dataDir,
    log: () => {},
    requireIsolation: false,
    networkIsolation: false,
    requireNetworkIsolation: false
  });
  t.after(() => host.stop());
  assert.equal(await host.start(), true, `启动失败：${host.lastError}`);
  assert.equal(await waitFor(() => host.status().state === 'running'), true, '插件应进入 running');

  // ① 直接验证"管道错误不会升级成未捕获异常"：Node 对没有 error 监听的 EventEmitter
  //    `emit('error')` 会同步抛出（在真实链路里就是 uncaughtException → process.exit）。
  //    这一步是确定性的；靠真实 EPIPE 复现会受事件循环竞速影响，有时测不到。
  const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
  assert.doesNotThrow(() => host.child.stdin.emit('error', epipe), 'EPIPE 必须被宿主吞掉');

  // ② 插件关掉 stdin 后宿主继续投递消息：不能抛、也不能把插件判成崩溃
  host.child.stdin.destroy();
  for (let i = 0; i < 5; i += 1) {
    assert.doesNotThrow(() => host.observe({ chatKey: 'group:1', senderId: '2', senderName: '群友', text: `消息 ${i}`, ts: Date.now() }));
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(host.status().state, 'running');
  await host.stop();
});

test('语法检查失败要标 failed（不能永远停在"启动中"并每次调用重试）', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-syntax-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'broken');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
    id: 'broken',
    apiVersion: 1,
    name: '语法错的插件',
    version: '1.0.0',
    description: 'index.mjs 有语法错误',
    entry: 'index.mjs',
    capabilities: ['tools'],
    tools: [{ name: 'ping', description: 'p', parameters: { type: 'object', properties: {} } }]
  }));
  fs.writeFileSync(path.join(dir, 'index.mjs'), 'const = ;');
  const parsed = parsePluginManifest(JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')), { dir });
  assert.ok(parsed.ok, parsed.error);
  const host = new PluginHost({
    manifest: parsed.manifest,
    dataDir,
    log: () => {},
    requireIsolation: false,
    networkIsolation: false,
    requireNetworkIsolation: false
  });
  t.after(() => host.stop());
  assert.equal(await host.start(), false);
  assert.equal(host.status().state, 'failed', '语法错误属于永久失败，必须标 failed（否则每次调用都会重跑一次 node --check）');
  assert.match(host.lastError, /语法检查未通过/);
});

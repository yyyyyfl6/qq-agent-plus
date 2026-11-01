// 容器模式守卫：更新、巡检、协议端、通知通道都不能再按宿主机/systemd 假设运行。
// 这些用例把"容器里会发生什么"钉住，避免以后改回 127.0.0.1 / systemctl 时静默回归。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isContainerRuntime, runtimeKind, containerUpdateHint } from '../src/core/runtime.js';
import { AutoUpdateManager } from '../src/auto-update.js';
import { runHealthCheck } from '../src/core/health-check.js';
import { sendOwnerText } from '../src/core/notify-owner.js';
import { snowlumaApiBase } from '../src/console/integrations.js';

const tmpDirs = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-container-guard-'));
  tmpDirs.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const originalRuntime = process.env.QQ_AGENT_RUNTIME;
process.on('exit', () => {
  if (originalRuntime === undefined) delete process.env.QQ_AGENT_RUNTIME;
  else process.env.QQ_AGENT_RUNTIME = originalRuntime;
});

test('运行环境识别：显式变量优先于标记文件', () => {
  process.env.QQ_AGENT_RUNTIME = 'docker';
  assert.equal(isContainerRuntime(), true);
  assert.equal(runtimeKind(), 'docker');
  process.env.QQ_AGENT_RUNTIME = 'host';
  assert.equal(isContainerRuntime(), false);
  assert.equal(runtimeKind(), 'systemd');
  delete process.env.QQ_AGENT_RUNTIME;
  // 没有显式变量时按真实标记判断：这里不断言具体值（CI 本身可能就在容器里），
  // 只要求与 runtimeKind 自洽。
  assert.equal(runtimeKind(), isContainerRuntime() ? 'docker' : 'systemd');
});

test('更新提示包含可执行的 compose 命令', () => {
  const hint = containerUpdateHint();
  assert.match(hint, /QQ_AGENT_IMAGE/);
  assert.match(hint, /docker compose pull/);
  assert.match(hint, /docker compose up -d/);
});

test('AutoUpdateManager：容器里不探测 systemd、不提供手动更新、不沿用旧失败状态', () => {
  process.env.QQ_AGENT_RUNTIME = 'docker';
  const dir = tmpDir();
  // 模拟从裸机迁移过来的旧状态：失败 + 一条待投递通知
  fs.writeFileSync(path.join(dir, 'auto-update.json'), JSON.stringify({
    status: 'failed',
    error: '旧部署失败',
    targetVersion: '0.9.2',
    notification: { pending: true, text: '旧的更新失败通知' }
  }));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  let systemctlCalls = 0;
  let notifyCalls = 0;
  const manager = new AutoUpdateManager({
    appDir: dir,
    dataDir: dir,
    config: () => ({ autoUpdate: {}, admin: { ownerUin: '' } }),
    updateConfig: (patch) => patch,
    notify: () => { notifyCalls += 1; },
    runSystemctl: () => { systemctlCalls += 1; return { status: 0 }; }
  });

  assert.equal(manager.installed(), false);
  assert.equal(manager.serviceActive(), false);
  assert.equal(systemctlCalls, 0, '容器模式不应该调用 systemctl');

  const status = manager.status();
  assert.equal(status.container, true);
  assert.equal(status.managedBy, 'docker');
  assert.equal(status.installed, false);
  assert.equal(status.busy, false);
  assert.equal(status.nextCheckAt, 0);
  assert.equal(status.status, 'idle', '旧 failed 状态不能泄漏到容器控制台');
  assert.equal(status.error, '');
  assert.equal(status.targetVersion, '');
  assert.equal(status.currentRevision, '9.9.9', '容器里应显示镜像版本，不是旧 deployed-revision');
  assert.match(status.hint, /docker compose pull/);

  // OneBot 连上时 console/app.js 会调 resumeNotifications：容器里不能发旧失败通知
  assert.equal(manager.resumeNotifications(), null);
  assert.equal(notifyCalls, 0, '容器模式不应投递旧更新通知');

  assert.throws(() => manager.requestManual(), (error) => error.httpStatus === 409);
  assert.throws(() => manager.resume(), (error) => error.httpStatus === 409);

  manager.start();
  assert.equal(manager.notificationTimer, null, '容器模式不启动通知器定时器');
  manager.stop();
});

test('巡检：容器里跳过自动更新/部署中断标记，并用协议端服务名探测', async () => {
  process.env.QQ_AGENT_RUNTIME = 'docker';
  const dir = tmpDir();
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    if (String(url).includes('/healthz')) {
      return { ok: true, status: 200, text: async () => '{}' };
    }
    if (String(url).includes('/get_status')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'ok', retcode: 0 }) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  fs.writeFileSync(path.join(dir, '.deploy-in-progress'), '{}');
  fs.writeFileSync(path.join(dir, 'auto-update.json'), JSON.stringify({ status: 'failed', error: '旧状态' }));

  const result = await runHealthCheck({
    dataDir: dir,
    mode: 'active',
    consolePort: 3210,
    onebotHttpUrl: 'http://snowluma:3000',
    containerRuntime: true,
    fetchImpl,
    statfs: () => ({ bavail: 10 * 1024 * 1024, bsize: 1024 }),
    notify: null
  });

  assert.ok(urls.includes('http://snowluma:3000/get_status'), `应探测 compose 服务名，实际：${urls.join(', ')}`);
  const byName = Object.fromEntries(result.checks.map((c) => [c.name, c]));
  assert.equal(byName['onebot-status'].ok, true);
  assert.match(byName['auto-update'].detail, /容器模式/);
  assert.equal(byName['auto-update'].ok, true, '旧卷里的 failed 状态不能在容器里报红');
  assert.equal(byName['deploy-interrupted'].ok, true);
  assert.match(byName['deploy-interrupted'].detail, /容器模式/);
});

test('巡检：非容器仍用 127.0.0.1 + 端口（不破坏原部署）', async () => {
  const dir = tmpDir();
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    if (String(url).includes('/healthz')) return { ok: true, status: 200, text: async () => '{}' };
    if (String(url).includes('/get_status')) return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'ok' }) };
    throw new Error(`unexpected fetch: ${url}`);
  };
  await runHealthCheck({
    dataDir: dir,
    onebotHttpPort: 3390,
    containerRuntime: false,
    fetchImpl,
    statfs: () => ({ bavail: 10 * 1024 * 1024, bsize: 1024 }),
    notify: null
  });
  assert.ok(urls.includes('http://127.0.0.1:3390/get_status'));
});

test('协议端地址：浏览器链接与服务端探测分开，容器内不探 127.0.0.1', () => {
  assert.equal(snowlumaApiBase({ SNOWLUMA_INTERNAL_URL: 'http://snowluma:5099/' }), 'http://snowluma:5099');
  assert.equal(snowlumaApiBase({ SNOWLUMA_WEBUI_URL: 'http://127.0.0.1:5099' }), 'http://127.0.0.1:5099');
  assert.equal(snowlumaApiBase({}), 'http://127.0.0.1:5099');
});

test('owner 通知通道支持完整 OneBot URL（容器内 snowluma:3000）', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'ok', retcode: 0 }) };
  };
  const result = await sendOwnerText({
    httpUrl: 'http://snowluma:3000/',
    token: 'secret',
    ownerUin: '123456',
    text: 'hi',
    fetchImpl
  });
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, 'http://snowluma:3000/send_private_msg');
  assert.equal(calls[0].options.headers.authorization, 'Bearer secret');
});

// 控制台「协议端（SnowLuma）」三个接口的契约：GET /api/snowluma/version、
// POST /api/snowluma/update、POST /api/snowluma/rollback。
// 真的去 pull 镜像/重建容器不可能在单测里做，所以把 app.snowlumaUpdater 换成替身
// （与 test/platform-voice-api.test.mjs 里替换 app.onebot.* 是同一个套路）——
// 这里验的是**接口契约与审计留痕**，命令序列与回滚语义在 test/snowluma-update.test.mjs 里。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-snowluma-api-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');
const { createApp } = await import('../src/console/app.js');

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function request(port, method, urlPath, body) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method,
      headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json' }
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* 非 JSON */ }
        resolve({ status: res.statusCode, text, body: parsed });
      });
    });
    req.on('error', (e) => resolve({ status: 0, text: String(e.message), body: null }));
    if (payload) req.write(payload);
    req.end();
  });
}

/** 假的协议端更新器：只记调用、返回脚本化结果。 */
function fakeUpdater(overrides = {}) {
  const calls = [];
  return {
    calls,
    status() {
      return {
        composeDir: '/data/qq-agent/snowluma', installed: true, container: 'qq-agent-snowluma',
        running: true, runningState: 'running',
        currentImage: 'mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.15',
        currentVersion: '1.14.15',
        targetImage: 'mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.22',
        targetVersion: '1.14.22',
        outdated: true, belowRecommended: true, minRecommended: '1.14.20',
        baseline: 'motricseven7/snowluma:v1.14.22', busy: false, lastResult: null,
        ...overrides.status
      };
    },
    async update(options = {}) {
      calls.push(['update', options]);
      return { ok: true, from: 'x:v1.14.15', to: 'x:v1.14.22', waitedMs: 8000, log: ['ok'], ...overrides.update };
    },
    async rollback() {
      calls.push(['rollback']);
      return { ok: true, from: 'x:v1.14.22', to: 'x:v1.14.15', waitedMs: 7000, log: ['back'], ...overrides.rollback };
    }
  };
}

async function boot(t, { updater } = {}) {
  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
  cfg.runtime.mode = 'active';
  // 用 __replace__ 整体重置 snowluma 段：既清掉上一个用例可能设过的 followBaseline，
  // 又刻意让它处于**缺键**状态（真实用户配置就是这样）—— 顺带验证"缺键即默认开"。
  cfg.autoUpdate = { ...cfg.autoUpdate, snowluma: { __replace__: { enabled: false, image: '' } } };
  updateConfig(cfg);
  const app = createApp({ log: () => {} });
  if (updater) app.snowlumaUpdater = updater;
  t.after(async () => {
    await app.stop();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 句柄 */ }
  });
  await app.start();
  return {
    app, port,
    get: (p) => request(port, 'GET', p),
    post: (p, b) => request(port, 'POST', p, b)
  };
}

test('GET /api/snowluma/version：给出版本、目标、是否落后与自动更新开关', async (t) => {
  const { get } = await boot(t, { updater: fakeUpdater() });
  const res = await get('/api/snowluma/version');
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.currentVersion, '1.14.15');
  assert.equal(res.body.targetVersion, '1.14.22');
  assert.equal(res.body.outdated, true);
  assert.equal(res.body.belowRecommended, true);
  assert.equal(res.body.minRecommended, '1.14.20');
  assert.deepEqual(res.body.auto, { enabled: false, image: '', followBaseline: true },
    '缺键（真实用户配置的常态）也要下发 followBaseline: true —— 默认开在接口层可见');
});

test('POST /api/snowluma/update：转发给更新器、带目标镜像，并把结果与审计一起留下', async (t) => {
  const updater = fakeUpdater();
  const { post } = await boot(t, { updater });
  const res = await post('/api/snowluma/update', {});
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.to, 'x:v1.14.22');
  assert.equal(updater.calls.length, 1);
  assert.equal(updater.calls[0][0], 'update');
  // 审计日志要有一条（控制台所有写操作都留痕）
  const auditDir = path.join(root, 'audit-log');
  const files = fs.existsSync(auditDir) ? fs.readdirSync(auditDir) : [];
  const text = files.map((f) => fs.readFileSync(path.join(auditDir, f), 'utf8')).join('\n');
  assert.match(text, /snowluma-update/, '更新要进审计日志');
});

test('POST /api/snowluma/update：更新器报失败 → 500 且把原因带回控制台', async (t) => {
  const updater = fakeUpdater({ update: { ok: false, error: 'manifest unknown', rolledBack: true } });
  const { post } = await boot(t, { updater });
  const res = await post('/api/snowluma/update', {});
  assert.equal(res.status, 500, res.text);
  assert.equal(res.body.ok, false);
  assert.match(res.body.error, /manifest unknown/);
  assert.equal(res.body.rolledBack, true);
});

test('POST /api/snowluma/update：配置里写了自定义镜像时优先用它（--to 覆盖）', async (t) => {
  const updater = fakeUpdater();
  const { app, post } = await boot(t, { updater });
  updateConfig({ autoUpdate: { snowluma: { enabled: false, image: 'registry.local/snowluma:v9.9.9' } } });
  await post('/api/snowluma/update', {});
  assert.equal(updater.calls[0][1].to, 'registry.local/snowluma:v9.9.9', '配置里的镜像优先');
  const body = await post('/api/snowluma/update', { to: 'other/one:v1' });
  assert.equal(body.status, 200);
  assert.equal(updater.calls[1][1].to, 'other/one:v1', '请求里显式给的目标优先于配置');
  assert.ok(app.snowlumaUpdater === updater);
});

test('POST /api/snowluma/rollback：转发回滚并留审计', async (t) => {
  const updater = fakeUpdater();
  const { post } = await boot(t, { updater });
  const res = await post('/api/snowluma/rollback', {});
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(updater.calls[0], ['rollback']);
  assert.equal(res.body.to, 'x:v1.14.15');
});

// ── 随 Agent 版本对齐（2026-10-09）──────────────────────────────────────────
// 语义：协议端基线是代码常量、只随 Agent 新版本到达用户机器 —— "更新 Agent 后主服务带新
// 代码重启"是看到新基线的唯一时刻，在这一刻对齐一次（基线没变则天然 no-op）。

test('随版本对齐：基线落后 + 默认开 → 自动触发一次更新（to 传空 = 由更新器取基线）', async (t) => {
  const updater = fakeUpdater();   // status.outdated = true（1.14.15 → 1.14.22）
  const { app } = await boot(t, { updater });
  await app.snowlumaBaselineAlign();
  assert.equal(updater.calls.length, 1, '基线落后时应当自动对齐一次');
  assert.equal(updater.calls[0][0], 'update');
  assert.equal(updater.calls[0][1].to, '', '无自定义镜像时应传空串，由更新器取基线');
});

test('随版本对齐：已是最新 / 自定义镜像 / 显式关闭 → 一次都不动', async (t) => {
  const upToDate = fakeUpdater({ status: { outdated: false } });
  const a = await boot(t, { updater: upToDate });
  await a.app.snowlumaBaselineAlign();
  assert.equal(upToDate.calls.length, 0, '已是最新不该动（发版没动基线时就是这条）');

  const overridden = fakeUpdater();
  const b = await boot(t, { updater: overridden });
  updateConfig({ autoUpdate: { snowluma: { enabled: false, image: 'registry.local/snowluma:v9.9.9' } } });
  await b.app.snowlumaBaselineAlign();
  assert.equal(overridden.calls.length, 0, '设了自定义镜像就不自动动（锁版本优先）');

  const disabled = fakeUpdater();
  const c = await boot(t, { updater: disabled });
  updateConfig({ autoUpdate: { snowluma: { enabled: false, image: '', followBaseline: false } } });
  await c.app.snowlumaBaselineAlign();
  assert.equal(disabled.calls.length, 0, '显式关掉 followBaseline 就不自动动');
});

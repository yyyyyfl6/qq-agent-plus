// 全局待批列表接口：侧栏徽标与插件页顶部汇总条都读它。
// 这里钉住形状（含通知状态）与排序，避免 UI 改完才发现字段名对不上。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-pending-api-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');
const { createApp } = await import('../src/console/app.js');
const { requestPendingApproval, markPendingNotified } = await import('../src/plugins/grants.js');

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function boot(t) {
  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
  cfg.runtime.mode = 'observe';
  cfg.onebot.wsUrl = 'ws://127.0.0.1:1';
  cfg.onebot.httpUrl = 'http://127.0.0.1:1';
  updateConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(async () => {
    await app.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await app.start();
  return { port };
}

test('GET /api/plugins/pending：字段齐全、按过期时间排序、通知失败可见', async (t) => {
  const { port } = await boot(t);
  const first = requestPendingApproval(root, {
    pluginId: 'demo', pluginName: '演示', action: 'write', label: '写', target: 'BV1', preview: '内容一', now: Date.now() - 60000
  });
  markPendingNotified(root, first.id, { ok: false, error: 'WS 私聊：private not allowed' });
  const second = requestPendingApproval(root, {
    pluginId: 'demo', pluginName: '演示', action: 'write', label: '写', target: 'BV2', preview: '内容二', now: Date.now()
  });

  const response = await fetch(`http://127.0.0.1:${port}/api/plugins/pending`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.pending.length, 2);
  assert.deepEqual(body.pending.map((item) => item.id), [first.id, second.id], '按过期时间升序');
  const hit = body.pending.find((item) => item.id === first.id);
  assert.equal(hit.pluginName, '演示');
  assert.equal(hit.label, '写');
  assert.equal(hit.target, 'BV1');
  assert.equal(hit.preview, '内容一');
  assert.equal(hit.notify.ok, false);
  assert.match(hit.notify.error, /private not allowed/);
  assert.equal(Number.isFinite(hit.expiresAt), true);

  const count = await (await fetch(`http://127.0.0.1:${port}/api/plugins/pending-count`)).json();
  assert.equal(count.count, 2);
});

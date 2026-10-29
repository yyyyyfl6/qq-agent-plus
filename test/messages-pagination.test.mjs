import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-messages-page-'));
process.env.QQ_AGENT_DATA_DIR = root;

const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');
const { createApp } = await import('../src/console/app.js');
const { ChatStore } = await import('../src/core/store.js');

const OPS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ops.js');

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
  updateConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(async () => {
    await app.stop();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await app.start();
  return { port, app };
}

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET' }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('消息接口：服务端游标分页（默认/更早/更新），旧大 limit 被封顶', async (t) => {
  const { port, app } = await boot(t);
  for (let mid = 1; mid <= 5; mid += 1) {
    app.store.appendIncoming('group:1', { mid, text: `m${mid}`, senderId: '42', senderName: 'member' });
  }

  const first = JSON.parse((await get(port, '/api/chats/group_1/messages?limit=2')).text);
  assert.deepEqual(first.messages.map((m) => String(m.mid)), ['4', '5']);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextBefore > 0);
  assert.equal(first.total, 5);

  const older = JSON.parse((await get(port, `/api/chats/group_1/messages?limit=2&before=${first.nextBefore}`)).text);
  assert.deepEqual(older.messages.map((m) => String(m.mid)), ['2', '3']);
  assert.equal(older.hasMore, true);

  const oldest = JSON.parse((await get(port, `/api/chats/group_1/messages?limit=2&before=${older.nextBefore}`)).text);
  assert.deepEqual(oldest.messages.map((m) => String(m.mid)), ['1']);
  assert.equal(oldest.hasMore, false);

  const after = JSON.parse((await get(port, `/api/chats/group_1/messages?limit=2&after=${older.nextBefore}`)).text);
  assert.deepEqual(after.messages.map((m) => String(m.mid)), ['3', '4']);
  assert.equal(after.hasMore, true);

  // 旧客户端传 100000：兼容但封顶 2000，不再把全库一次吐出
  const huge = JSON.parse((await get(port, '/api/chats/group_1/messages?limit=100000')).text);
  assert.equal(huge.messages.length, 5);
});

test('全量导出：jsonl/csv 流式输出，内容与表头正确', async (t) => {
  const { port, app } = await boot(t);
  for (let mid = 1; mid <= 3; mid += 1) {
    app.store.appendIncoming('group:1', { mid, text: `m${mid},"quoted"`, senderId: '42', senderName: 'member' });
  }

  const jsonl = await get(port, '/api/chats/group_1/export?format=jsonl');
  assert.match(jsonl.headers['content-type'], /ndjson/);
  assert.match(jsonl.headers['content-disposition'], /group_1\.jsonl/);
  const lines = jsonl.text.trim().split('\n');
  assert.equal(lines.length, 3);
  assert.equal(String(JSON.parse(lines[0]).mid), '1');

  const csv = await get(port, '/api/chats/group_1/export?format=csv');
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.ok(csv.text.startsWith('\uFEFFid,ts,senderId,senderName,self,text\n'));
  assert.equal(csv.text.trim().split('\n').length, 4);
  assert.match(csv.text, /""quoted""/);
});

test('ops prune：只删 acked 且超期的消息，pending 不动', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-prune-'));
  const store = new ChatStore(0, { dataDir: dir });
  try {
    store.appendIncoming('group:1', { mid: 1, text: 'old', senderId: '42', senderName: 'a' });
    const batch = store.claimUnread('group:1');
    store.ackLease(batch.id);
    store.db.prepare('UPDATE messages SET ts=? WHERE mid=1').run(Date.now() - 3 * 86400000);
    store.appendIncoming('group:1', { mid: 2, text: 'new', senderId: '42', senderName: 'a' });
  } finally {
    store.close();
  }

  const run = spawnSync(process.execPath, [OPS, 'prune', '--days=1', '--data', dir, '--confirm'], {
    encoding: 'utf8',
    env: { ...process.env, QQ_AGENT_DATA_DIR: dir }
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);

  const check = new ChatStore(0, { dataDir: dir });
  try {
    assert.equal(check.findByMid('group:1', 1), null, '超期 acked 应被删除');
    assert.ok(check.findByMid('group:1', 2), 'pending 不应被删除');
  } finally {
    check.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

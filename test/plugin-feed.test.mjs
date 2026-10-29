import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createCapabilities } from '../src/plugins/capabilities.js';
import { CAP_METHODS } from '../src/plugins/protocol.js';
import { LifeFeedManager } from '../src/features/life-feed.js';

const NOW = 1792900000000;

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-feed-cap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

test('cap.feed.publish：只收公开元数据、按 id 去重、每插件每天 20 条', (t) => {
  const dir = tempDir(t);
  const caps = createCapabilities({
    pluginId: 'demo',
    dataDir: dir,
    manifest: { capabilities: ['feed'] },
    now: () => NOW
  });
  const result = caps.methods[CAP_METHODS.feedPublish]({
    items: [
      { id: 'p1', title: '插件见闻', url: 'https://example.com/p1', up: 'UP', durationSec: 120, tags: ['游戏'], summary: '摘要' },
      { id: 'p1', title: '重复', url: 'https://example.com/dup' },
      { id: 'bad', title: '没有链接', url: 'ftp://example.com/x' }
    ]
  });
  assert.equal(result.accepted, 1);
  assert.equal(result.rejected, 2);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'life-feed-inbox', 'demo.json'), 'utf8'));
  assert.equal(saved.pluginId, 'demo');
  assert.equal(saved.items[0].source, 'plugin:demo');
  assert.equal(saved.items[0].title, '插件见闻');

  // 同一天再发同一个 id：不重复收
  const again = caps.methods[CAP_METHODS.feedPublish]({ items: [{ id: 'p1', title: 'x', url: 'https://example.com/p1' }] });
  assert.equal(again.accepted, 0);
});

test('生活层会吸收插件的见闻候选，并参与正常的分享选择', async (t) => {
  const dir = tempDir(t);
  // 先由插件写 inbox
  const caps = createCapabilities({
    pluginId: 'demo', dataDir: dir, manifest: { capabilities: ['feed'] }, now: () => NOW
  });
  caps.methods[CAP_METHODS.feedPublish]({
    items: [{ id: 'p1', title: '插件提交的见闻', url: 'https://example.com/p1', tags: ['游戏'], summary: '来自插件' }]
  });

  const cfg = {
    lifeFeed: {
      enabled: true, maxCandidates: 20, maxPerForage: 10, maxOffersPerDay: 2,
      minDurationSec: 0, maxDurationSec: 3600
    },
    persona: {},
    allow: { groups: [] }
  };
  const manager = new LifeFeedManager({
    dataDir: dir,
    store: { recent: () => [], listChats: () => [] },
    config: () => cfg,
    fetchImpl: async () => ({ statusCode: 200, body: JSON.stringify({ code: 0, data: { list: [] } }) }),
    now: () => NOW,
    random: () => 0.5
  });

  const result = await manager.forageNow({ reason: 'test' });
  assert.equal(result.ok, true, result.error);
  const status = manager.status();
  const item = status.candidates.find((candidate) => candidate.id === 'p1');
  assert.ok(item, '插件候选应进入队列');
  assert.equal(item.source, 'plugin:demo');

  const picked = manager.next({ count: 1 });
  assert.equal(picked.items[0].id, 'p1');
});

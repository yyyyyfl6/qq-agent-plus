// 索引这条链路的"一致性"用例（2026-10-17 全面审查后补）：
//   · 索引是**第三方内容源**：version 会被拼进按钮文案，形状必须收敛（存储型 XSS 的根因）
//   · 撤回名单是 fail-closed 的：部分来源拉不动时，不能把那个来源的规则一起清掉
//   · 撤回是版本粒度的：作者发新版后，旧版本的撤回规则要继续生效（revokedVersions）
//   · 索引被体积上限截断时要明说，不能报成"不是合法 JSON"
import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  normalizePluginIndexEntry, createIndexRevokedCache, fetchPluginIndexes, fetchPluginIndex
} = await import('../src/plugins/install.js');

const sha = 'a'.repeat(64);
const base = {
  id: 'demo', name: '演示', version: '1.0.0', description: '',
  downloadUrl: 'https://github.com/x/y/releases/download/v1/demo-1.0.0.tar.gz', sha256: sha
};

test('索引里的 version 只能是版本号形状（界面会把它拼进 innerHTML 的按钮文案）', () => {
  const evil = normalizePluginIndexEntry({ ...base, version: '9.0.0"><img src=x onerror=alert(1)>' });
  assert.equal(evil.ok, true);
  assert.equal(evil.entry.version, '9.0.0', '标记必须被剥掉，只留版本号本身');

  // 作者常写 `1.0`（两段）—— 保留，否则"升级到 vX"提示会失效
  assert.equal(normalizePluginIndexEntry({ ...base, version: '1.0' }).entry.version, '1.0');
  assert.equal(normalizePluginIndexEntry({ ...base, version: 'v2.3.4' }).entry.version, '2.3.4');
  // 完全取不到版本号：置空（只是不显示升级提示，不影响安装）
  assert.equal(normalizePluginIndexEntry({ ...base, version: '<b>x</b>' }).entry.version, '');
});

test('撤回名单：部分来源拉不动时，只替换这次真的拉到的来源（不能 fail-open）', () => {
  const cache = createIndexRevokedCache();
  cache.update({
    sources: [
      { name: 'A', url: 'https://a/index.json', ok: true, count: 1 },
      { name: 'B', url: 'https://b/index.json', ok: true, count: 1 }
    ],
    revoked: [
      { source: 'A', rules: [] },
      { source: 'B', rules: ['demo@1.0.0'] }
    ]
  });
  assert.deepEqual(cache.rules(), ['demo@1.0.0'], '两来源都成功时取并集');

  // B 这次超时、A 正常且 A 里没有 demo：B 上一次的规则必须保留
  cache.update({
    sources: [
      { name: 'A', url: 'https://a/index.json', ok: true, count: 1 },
      { name: 'B', url: 'https://b/index.json', ok: false, count: 0, error: 'timeout' }
    ],
    revoked: [{ source: 'A', rules: [] }]
  });
  assert.deepEqual(cache.rules(), ['demo@1.0.0'], 'B 拉不动不等于 B 没撤回 demo（旧规则沿用）');

  // 全失败：一个字都不该动
  cache.update({ sources: [{ name: 'A', ok: false, error: 'timeout' }], revoked: [] });
  assert.deepEqual(cache.rules(), ['demo@1.0.0'], '全失败时沿用旧名单');
});

test('撤回名单：revokedVersions 让"发新版"不会顺手解除旧版的撤回', () => {
  const cache = createIndexRevokedCache();
  cache.update({
    sources: [{ name: 'A', ok: true, count: 1 }],
    revoked: [{ source: 'A', rules: ['demo@1.0.0'] }]
  });
  assert.deepEqual(cache.rules(), ['demo@1.0.0']);

  // 索引条目现在是 v1.1.0（本身没被撤），但历史版本 1.0.0 记在 revokedVersions 里
  const entry = normalizePluginIndexEntry({ ...base, version: '1.1.0', revokedVersions: ['1.0.0', 'v1.0.0', 'bad'] });
  assert.equal(entry.ok, true);
  assert.deepEqual(entry.entry.revokedVersions, ['1.0.0'], '去重 + 归一化 + 丢掉形状不对的');
});

test('多来源：重名条目落选，但它自己那份索引里的撤回规则仍然算数', async () => {
  const make = (id, extra = {}) => JSON.stringify({
    plugins: [{ ...base, id, ...extra }]
  });
  const fetchText = async (url) => ({
    statusCode: 200,
    body: url.includes('b.example')
      ? make('demo', { revoked: true, revokedReason: '恶意行为' })
      : make('demo')
  });
  const result = await fetchPluginIndexes({
    sources: [
      { name: 'A', url: 'https://a.example/index.json' },
      { name: 'B', url: 'https://b.example/index.json' }
    ],
    fetchText
  });
  // A 在前：市场里留下的是 A 的那条；B 的那条进 skipped
  assert.equal(result.plugins.length, 1);
  assert.ok(result.skipped.some((item) => item.source === 'B' && /重复/.test(item.reason)));
  // 但撤回规则必须包含 B 标的那一版 —— 否则"重名"就是一条绕过下架的路
  const cache = createIndexRevokedCache();
  assert.deepEqual(cache.update(result), ['demo@1.0.0']);
});

test('索引被体积上限截断：报"超上限被截断"，不要报成"不是合法 JSON"', async () => {
  await assert.rejects(
    () => fetchPluginIndex({
      url: 'https://a.example/index.json',
      fetchText: async () => ({ statusCode: 200, truncated: true, body: '{"plugins":[{"id":"dem' })
    }),
    (error) => error.code === 'E_INDEX' && /截断/.test(error.message)
  );
});

test('撤回缓存按 URL 区分同名来源：两个都叫「官方索引」也不互相覆盖，移除的来源会被剪掉', () => {
  const cache = createIndexRevokedCache();
  cache.update({
    sources: [
      { name: '官方索引', url: 'https://a/index.json', ok: true, count: 1 },
      { name: '官方索引', url: 'https://b/index.json', ok: true, count: 1 }
    ],
    revoked: [
      { source: '官方索引', url: 'https://a/index.json', rules: ['x@1.0.0'] },
      { source: '官方索引', url: 'https://b/index.json', rules: ['y@2.0.0'] }
    ]
  });
  assert.deepEqual(cache.rules().sort(), ['x@1.0.0', 'y@2.0.0'], '同名来源的规则都要保留');

  // 移除 b 之后，只保留 a 的规则（不能让已移除索引的撤回永久生效）
  cache.update({
    sources: [{ name: '官方索引', url: 'https://a/index.json', ok: true, count: 1 }],
    revoked: [{ source: '官方索引', url: 'https://a/index.json', rules: ['x@1.0.0'] }]
  });
  assert.deepEqual(cache.rules(), ['x@1.0.0']);
});

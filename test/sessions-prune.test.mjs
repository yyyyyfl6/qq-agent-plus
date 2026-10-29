// 会话留档保留期（2026-10-10 审查）：默认 90 天，过期文件删除且内存索引同步收缩；
// 运行中/等待中的会话不删；构造时清一次（与运行台账 pruneRuns 同款）。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sessions-prune-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const { SessionRegistry } = await import('../src/core/sessions.js');

const writeSession = (id, patch = {}, { ageMs = 0 } = {}) => {
  const file = path.join(dataDir, 'sessions', `${id}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    id, chatKey: 'group:1', status: 'done', startedAt: Date.now() - 1000, endedAt: Date.now() - 1000, ...patch
  }));
  if (ageMs > 0) {
    // 现实里会话文件写于结束时刻：mtime 预筛（pruneSessions 的快速路径）按文件 mtime 判
    const past = new Date(Date.now() - ageMs);
    fs.utimesSync(file, past, past);
  }
};

test('构造时清一次：过期的删、运行中的不删、索引只留活下来的', () => {
  const old = Date.now() - 91 * 24 * 60 * 60 * 1000;
  writeSession('old-1', { endedAt: old, startedAt: old }, { ageMs: 91 * 24 * 60 * 60 * 1000 });
  writeSession('new-1');
  writeSession('running-1', { status: 'running', endedAt: null, startedAt: old });
  const reg = new SessionRegistry(0);
  assert.equal(fs.existsSync(path.join(dataDir, 'sessions', 'old-1.json')), false, '91 天前的留档在构造时被清');
  assert.equal(fs.existsSync(path.join(dataDir, 'sessions', 'running-1.json')), true, '运行中的不能删');
  assert.equal(reg.index.some((e) => e.id === 'old-1'), false, '索引里不能有已删文件');
  assert.equal(reg.index.some((e) => e.id === 'running-1'), true);
  assert.equal(reg.index.some((e) => e.id === 'new-1'), true);
});

test('pruneSessions：方法可复用（每日调度）、内存索引同步收缩、返回计数', () => {
  const reg = new SessionRegistry(0);
  writeSession('old-2', { endedAt: Date.now() - 200 * 24 * 60 * 60 * 1000, startedAt: Date.now() - 200 * 24 * 60 * 60 * 1000 }, { ageMs: 200 * 24 * 60 * 60 * 1000 });
  writeSession('keep-2');
  // 模拟"启动时已加载进索引"的形态：index 是构造时全量读入的，运行期删了文件要跟着收缩
  reg.index.push({ id: 'old-2' }, { id: 'keep-2' });
  const r = reg.pruneSessions(90);
  assert.equal(r.removed, 1, '只有过期的那份被删');
  assert.equal(fs.existsSync(path.join(dataDir, 'sessions', 'old-2.json')), false);
  assert.equal(fs.existsSync(path.join(dataDir, 'sessions', 'keep-2.json')), true, '保留期内的不删');
  assert.equal(reg.index.some((e) => e.id === 'old-2'), false, '内存索引要同步收缩');
  assert.equal(reg.index.some((e) => e.id === 'keep-2'), true);
});

test('落盘间隔可配并即时生效（Issue #45）', () => {
  const reg = new SessionRegistry(0);
  assert.equal(reg.persistIntervalMs, 10000, '默认 10 秒，减少小云盘写放大');
  const low = new SessionRegistry(0, { persistIntervalMs: 500 });
  assert.equal(low.persistIntervalMs, 2000, '低于 2 秒按 2 秒收口');
  const high = new SessionRegistry(0, { persistIntervalMs: 999999 });
  assert.equal(high.persistIntervalMs, 60000, '高于 60 秒按 60 秒收口');
  low.setPersistIntervalMs(30000);
  assert.equal(low.persistIntervalMs, 30000, '控制台保存后无需重启');
});

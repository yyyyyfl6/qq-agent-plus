import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const __dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-mem-search-'));
process.env.QQ_AGENT_DATA_DIR = __dir;
process.on('exit', () => { try { fs.rmSync(__dir, { recursive: true, force: true }); } catch { /* ignore */ } });

const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');
const { MemoryStore } = await import('../src/memory/memory-global.js');

function resetData() {
  try { fs.rmSync(path.join(__dir, 'memory'), { recursive: true, force: true }); } catch { /* ignore */ }
}

function config(overrides = {}) {
  updateConfig({
    ...structuredClone(DEFAULT_CONFIG),
    memory: {
      ...structuredClone(DEFAULT_CONFIG.memory),
      ...(overrides.memory || {})
    }
  });
}

function seed(store) {
  const rows = [
    ['2001', '运维饭桶', '昨天中午去新开的面馆排队半小时，汤有点咸'],
    ['2001', '运维饭桶', '周会改到周四了，记得把周报提前发'],
    ['2001', '运维饭桶', '周末去爬山，九点地铁口集合'],
    ['2001', '运维饭桶', '周六 15:00 提醒你取快递'],
    ['2002', '深海炸鸡代表', '家里的猫又把窗帘抓坏了，想买个猫抓板'],
    ['2002', '深海炸鸡代表', '晚上开黑打游戏，缺一个辅助'],
    ['2003', '阿澄', '最近在看一部老电影，配乐很好听'],
    ['2003', '阿澄', '下个月想去旅行，正在做攻略'],
    ['2004', '加班怪', '项目这周要上线，连续加班三天了'],
    ['2004', '加班怪', '老板又临时改需求，心态有点崩'],
    ['2005', '跑步机', '最近在健身，每周跑三次'],
    ['2005', '跑步机', '游泳馆新开的，水质还不错'],
    ['2006', '火锅侠', '周末在家做饭，研究了新的菜谱'],
    ['2006', '火锅侠', '冬天最适合吃火锅，尤其是牛油锅底']
  ];
  for (const [userId, target, content] of rows) {
    store.append('group:1', 'memberImpression', content, { userId, target });
  }
}

test('记忆检索：关键词、二字词、单字和短句都能找回', (t) => {
  resetData();
  config();
  const store = new MemoryStore();
  t.after(() => store.close());
  seed(store);
  assert.ok(store.stats().entries >= 14);
  const cases = [
    ['面馆', '面馆'],
    ['汤有点咸', '汤有点咸'],
    ['周会', '周会'],
    ['爬山', '爬山'],
    ['取快递', '取快递'],
    ['猫', '猫'],
    ['火锅', '火锅'],
    ['那家新开的店', '面馆'],
    ['周末去哪儿', '爬山'],
    ['谁提过面馆', '面馆']
  ];
  let hits = 0;
  const report = [];
  for (const [query, expected] of cases) {
    const result = store.search('group:1', query, { limit: 3 });
    const found = result.results.some((item) => item.content.includes(expected));
    if (found) hits += 1;
    report.push(`${query} -> ${found ? 'hit' : 'miss'} (${result.results.map((r) => r.content.slice(0, 12)).join(' | ')})`);
  }
  console.log(`[memory benchmark] recall@3 = ${hits}/${cases.length}\n${report.join('\n')}`);
  assert.ok(hits >= 8, `关键词召回低于预期：${hits}/${cases.length}`);
  assert.ok(store.search('group:1', '完全不存在的东西').results.length === 0);
  assert.ok(store.stats().index.docs > 0);
  store.close();
});

test('记忆检索遵守 perChat / hidePrivateInGroup，不把私聊来源带进群', (t) => {
  resetData();
  config({ memory: { visibility: { mode: 'perChat', hidePrivateInGroup: true } } });
  const store = new MemoryStore();
  t.after(() => store.close());
  store.append('group:1', 'memberImpression', '群里说周末去爬山', { userId: '1', target: '甲' });
  store.append('private:9', 'memberImpression', '私聊说过喜欢猫', { userId: '9', target: '乙' });
  const group = store.search('group:1', '猫', { limit: 5 });
  assert.equal(group.results.length, 0, '群聊不能看到私聊来源');
  const priv = store.search('private:9', '猫', { limit: 5 });
  assert.equal(priv.results.length, 1);
  const byUser = store.search('private:9', '猫', { limit: 5, userId: '999' });
  assert.equal(byUser.results.length, 0);
  store.close();
});

test('记忆容量与保留期：自动条目可淘汰，手写条目永远保留', (t) => {
  resetData();
  config({ memory: { maxImpressionsPerPerson: 20, impressionRetentionDays: 0 } });
  const store = new MemoryStore();
  t.after(() => store.close());
  const now = Date.now();
  for (let i = 0; i < 10; i += 1) {
    store.append('group:1', 'memberImpression', `自动印象 ${i}`, { userId: '1', target: '甲' });
  }
  store.append('group:1', 'memberImpression', '手写印象要保留', { userId: '1', target: '甲', origin: 'manual' });
  let member = store.people.get('1');
  assert.equal(member.impressions.length, 11);
  assert.ok(member.impressions.some((entry) => entry.content === '手写印象要保留'));

  const old = now - 40 * 86400000;
  store.people.append('group:1', '1', '甲', '四十天前的自动印象', old, 'model', old);
  // 先把保留期改成 30 天，再跑清理：append 时的 0 天保留期不会立刻删掉这条旧记录。
  config({ memory: { maxImpressionsPerPerson: 20, impressionRetentionDays: 30 } });
  const pruned = store.people.pruneExpired({ now });
  assert.ok(pruned.removed >= 1);
  member = store.people.get('1');
  assert.ok(member.impressions.some((entry) => entry.content === '手写印象要保留'));
  assert.ok(!member.impressions.some((entry) => entry.content === '四十天前的自动印象'));
  assert.equal(store.stats().limits.max, 20);
  assert.equal(store.stats().limits.days, 30);
  store.close();
});


test('容量上限：超过每人上限时只淘汰自动条目，手写条目保留', (t) => {
  resetData();
  config({ memory: { maxImpressionsPerPerson: 5, impressionRetentionDays: 0 } });
  const store = new MemoryStore();
  t.after(() => store.close());
  for (let i = 0; i < 10; i += 1) {
    store.append('group:1', 'memberImpression', `自动 ${i}`, { userId: '1', target: '甲' });
  }
  store.append('group:1', 'memberImpression', '手写不能丢', { userId: '1', target: '甲', origin: 'manual' });
  const member = store.people.get('1');
  assert.equal(member.impressions.length, 5);
  assert.ok(member.impressions.some((entry) => entry.content === '手写不能丢'));
});

test('记忆索引可跨进程重建，统计数据可读', () => {
  resetData();
  config();
  const first = new MemoryStore();
  first.append('group:1', 'memberImpression', '新开的面馆汤有点咸', { userId: '1', target: '甲' });
  assert.equal(first.search('group:1', '面馆', { limit: 3 }).results.length, 1, '先建立索引');
  first.close();
  const second = new MemoryStore();
  second.append('group:1', 'memberImpression', '周六去爬山', { userId: '2', target: '乙' });
  const result = second.search('group:1', '面馆', { limit: 3 });
  assert.equal(result.results.length, 1);
  assert.equal(second.search('group:1', '爬山', { limit: 3 }).results.length, 1, '进程外变化后要重建');
  const stats = second.stats();
  assert.ok(stats.entries >= 1);
  assert.ok(stats.index.bytes > 0);
  assert.equal(stats.index.available, true);
  second.close();
});

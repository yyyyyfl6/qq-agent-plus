import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memory-query-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');
updateConfig(structuredClone(DEFAULT_CONFIG));
const { MemoryStore } = await import('../src/memory/memory-global.js');
const { buildToolDefs, executeTool } = await import('../src/tools/tools-core.js');

test('memory_query 的 query 返回相关记忆，并剥掉来源会话', async (t) => {
  const store = new MemoryStore();
  t.after(() => store.close());
  store.append('group:1', 'memberImpression', '昨天去新开的面馆，汤有点咸', { userId: '2001', target: '运维饭桶' });
  store.append('group:1', 'memberImpression', '周末去爬山，九点集合', { userId: '2002', target: '深海炸鸡代表' });
  const defs = buildToolDefs();
  const ctx = { chatKey: 'group:1', memory: store, session: {} };
  const found = await executeTool(defs, ctx, 'memory_query', JSON.stringify({ query: '面馆', limit: 3 }));
  assert.equal(found.isError, undefined);
  assert.match(found.content, /面馆/);
  assert.doesNotMatch(found.content, /sourceChatKeys|group:1/);
  const miss = await executeTool(defs, ctx, 'memory_query', JSON.stringify({ query: '完全不存在的主题' }));
  assert.match(miss.content, /没有找到/);
});

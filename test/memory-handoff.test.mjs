import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memory-handoff-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { MemoryStore } = await import('../src/memory/memory.js');
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');

test('persists, updates and clears structured session handoff state', (t) => {
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.memory.handoffEnabled = true;
  cfg.memory.handoffTtlMinutes = 30;
  cfg.memory.handoffMaxChars = 4000;
  setRuntimeConfig(cfg);

  const memory = new MemoryStore();
  const first = memory.setHandoff('group:123', {
    topic: '排查图片发送问题',
    summary: '已经确认图片成功下载',
    hypotheses: ['发送段可能被重复组装'],
    evidence: ['入站事件只有一个 image 段'],
    facts: ['OneBot 在线', '附件路径可写', '附件路径可写'],
    decisions: ['继续检查发送段'],
    rejectedDirections: ['不是附件下载失败'],
    openQuestions: ['是否重复组装 image 段'],
    nextStep: '发送一张表情复现',
    ttlMinutes: 30
  }, {
    participantIds: ['1001'],
    lastReply: '请只发一个表情',
    sourceSessionId: 'session-a'
  });

  assert.equal(first.topic, '排查图片发送问题');
  assert.deepEqual(first.facts, ['OneBot 在线', '附件路径可写']);
  assert.ok(first.expiresAt > first.updatedAt);
  assert.match(memory.formatHandoffForPrompt('group:123'), /是否重复组装 image 段/);
  assert.match(memory.formatHandoffForPrompt('group:123'), /发送段可能被重复组装/);
  assert.match(memory.formatHandoffForPrompt('group:123'), /不是附件下载失败/);

  const second = memory.setHandoff('group:123', {
    summary: '复现后确认发送段只出现一次',
    hypotheses: [],
    evidence: ['出站观测仅记录一次发送'],
    facts: [],
    rejectedDirections: [],
    openQuestions: [],
    nextStep: ''
  }, {
    participantIds: ['1002'],
    sourceSessionId: 'session-b'
  });

  assert.equal(second.topic, first.topic, '未提供的字段应保留');
  assert.deepEqual(second.hypotheses, [], '显式空数组应清空旧假设');
  assert.deepEqual(second.evidence, ['出站观测仅记录一次发送']);
  assert.deepEqual(second.facts, [], '显式空数组应清空旧事实');
  assert.deepEqual(second.rejectedDirections, [], '显式空数组应清空已排除方向');
  assert.deepEqual(second.openQuestions, [], '显式空数组应清空旧问题');
  assert.deepEqual(second.participantIds, ['1001', '1002']);
  assert.equal(second.sourceSessionId, 'session-b');

  memory.clearHandoff('group:123');
  assert.equal(memory.getHandoff('group:123'), null);
});

test('does not inject handoff when the feature is disabled', () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.memory.handoffEnabled = false;
  setRuntimeConfig(cfg);
  const memory = new MemoryStore();
  memory.setHandoff('private:456', { summary: '仍然保存在磁盘' });
  assert.ok(memory.getHandoff('private:456'));
  assert.equal(memory.formatHandoffForPrompt('private:456'), '');
});

test('私聊共享上下文：合并最近私聊交接，当前会话优先，默认关仍隔离', () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.memory.handoffEnabled = true;
  cfg.memory.handoffMaxChars = 4000;
  cfg.memory.privateSharedContext = true;
  setRuntimeConfig(cfg);
  const memory = new MemoryStore();
  memory.clearHandoff('private:456');
  memory.setHandoff('private:1', { topic: '与 A 的话题', summary: 'A 的交接' });
  memory.setHandoff('private:2', { topic: '与 B 的话题', summary: 'B 的交接' });

  const merged = memory.formatHandoffForPrompt('private:1');
  assert.match(merged, /A 的交接/);
  assert.match(merged, /B 的交接/);
  assert.match(merged, /【上次会话交接 · 与 2】/);
  assert.ok(merged.indexOf('A 的交接') < merged.indexOf('B 的交接'), '当前会话的交接排在最前');

  // 当前会话的交接很长时，也不能把别的私聊整段挤掉（总预算要分给每一份）
  memory.setHandoff('private:1', { summary: 'A'.repeat(3000) });
  const longCurrent = memory.formatHandoffForPrompt('private:1');
  assert.match(longCurrent, /B 的交接/, '当前会话很长时，别的私聊交接也要留出预算');

  cfg.memory.privateSharedContext = false;
  setRuntimeConfig(cfg);
  const isolated = memory.formatHandoffForPrompt('private:1');
  assert.match(isolated, /A{100}/);
  assert.doesNotMatch(isolated, /B 的交接/);
  assert.doesNotMatch(isolated, /与 2/);
});

test('群聊与私聊共用上下文：交接跨群/私聊合并并标来源，默认关仍隔离', () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.memory.handoffEnabled = true;
  cfg.memory.handoffMaxChars = 4000;
  cfg.memory.crossScopeSharedContext = true;
  setRuntimeConfig(cfg);
  const memory = new MemoryStore();
  for (const key of ['private:1', 'private:2', 'group:123', 'private:456']) memory.clearHandoff(key);
  memory.setHandoff('private:1', { summary: 'A 的交接' });
  memory.setHandoff('private:2', { summary: 'B 的交接' });
  memory.setHandoff('group:123', { summary: '群 123 的交接' });

  const merged = memory.formatHandoffForPrompt('group:123');
  assert.match(merged, /群 123 的交接/);
  assert.match(merged, /【上次会话交接 · 与 1】/);
  assert.match(merged, /【上次会话交接 · 与 2】/);

  const fromPrivate = memory.formatHandoffForPrompt('private:1');
  assert.match(fromPrivate, /群 123 的交接/);
  assert.match(fromPrivate, /【上次会话交接 · 群 123】/);

  cfg.memory.crossScopeSharedContext = false;
  setRuntimeConfig(cfg);
  const isolated = memory.formatHandoffForPrompt('group:123');
  assert.match(isolated, /群 123 的交接/);
  assert.doesNotMatch(isolated, /A 的交接/);
  assert.doesNotMatch(isolated, /B 的交接/);
});

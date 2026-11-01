import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-private-context-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 句柄 */ } });

const { ChatStore } = await import('../src/core/store.js');
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');
const { buildPastState } = await import('../src/llm/prompt.js');
const { buildToolDefs, executeTool } = await import('../src/tools/tools.js');

function seed() {
  const store = new ChatStore(0);
  store.appendIncoming('group:9', { mid: 91, ts: 500, senderId: '9', senderName: '群友', text: '群里说的话' });
  store.appendIncoming('private:1', { mid: 11, ts: 1000, senderId: '1', senderName: 'A', text: '和 A 说的话' });
  store.appendIncoming('private:2', { mid: 22, ts: 2000, senderId: '2', senderName: 'B', text: '[引用#22·B：原话] 和 B 说的话' });
  store.appendIncoming('group:8', { mid: 81, ts: 2500, senderId: '8', senderName: '别群群友', text: '另一个群的话' });
  store.appendIncoming('private:1', { mid: 12, ts: 3000, senderId: '1', senderName: 'A', text: 'A 又说了一句' });
  store.drainUnread('group:9');
  store.drainUnread('group:8');
  store.drainUnread('private:1');
  store.drainUnread('private:2');
  return store;
}

function configWith(shared, cross = false, blocklist = null) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.memory.privateSharedContext = shared;
  cfg.memory.crossScopeSharedContext = cross;
  if (blocklist) cfg.blocklist = blocklist;
  cfg.store.allCount = 500;
  cfg.store.pastStateMaxChars = 100000;
  setRuntimeConfig(cfg);
}

test('store.recent(scope=private) 跨私聊按时间读取，默认仍只读当前会话', () => {
  configWith(false);
  const store = seed();
  const only = store.recent('private:1', { limit: 10 });
  assert.deepEqual(only.map((m) => m.text), ['和 A 说的话', 'A 又说了一句']);
  assert.equal(only[0].chatKey, 'private:1');

  const all = store.recent('private:1', { limit: 10, scope: 'private' });
  assert.deepEqual(all.map((m) => m.text), ['和 A 说的话', '[引用#22·B：原话] 和 B 说的话', 'A 又说了一句']);
  assert.deepEqual(all.map((m) => m.chatKey), ['private:1', 'private:2', 'private:1']);
  store.close();
});

test('私聊共享上下文：历史带 [与 <QQ>] 标签，别的会话 mid 不暴露；默认关仍隔离', async () => {
  configWith(true);
  const store = seed();
  const state = buildPastState(store, 'private:1');
  assert.match(state.text, /和 B 说的话/);
  assert.match(state.text, /\[与 2\]/);
  assert.doesNotMatch(state.text, /#22/, '别的私聊的 mid 不能出现在引用块里');
  assert.match(state.text, /#11/);

  // 本地 id 冲突：当前会话的 excludeIds 不能误伤别的私聊同号消息
  const withExclude = buildPastState(store, 'private:1', { excludeIds: [2] });
  assert.match(withExclude.text, /和 B 说的话/);

  const tool = buildToolDefs().find((d) => d.name === 'get_recent_messages');
  const result = await executeTool([tool], {
    chatKey: 'private:1',
    store,
    session: { pastStateCount: 0 }
  }, 'get_recent_messages', JSON.stringify({ limit: 10 }));
  const payload = JSON.parse(result.content);
  const cross = payload.messages.find((m) => m.text.includes('和 B 说的话'));
  assert.ok(cross);
  assert.match(cross.text, /^\[与 2\]/);
  assert.equal(cross.messageId, undefined);

  configWith(false);
  const isolated = buildPastState(store, 'private:1');
  assert.doesNotMatch(isolated.text, /和 B 说的话/);
  store.close();
});

test('群聊与私聊共用上下文：跨会话消息带来源标签、无 mid；默认关仍隔离', async () => {
  configWith(false, true);
  const store = seed();
  const state = buildPastState(store, 'private:1');
  assert.match(state.text, /群里说的话/);
  assert.match(state.text, /\[群 9\]/);
  assert.match(state.text, /另一个群的话/);
  assert.match(state.text, /\[群 8\]/);
  assert.match(state.text, /\[与 2\]/, '私聊之间也一起共享');
  assert.doesNotMatch(state.text, /#91/, '别的群的 mid 不能暴露');
  assert.doesNotMatch(state.text, /#81/);
  assert.match(state.text, /#11/, '当前会话的 mid 保留');

  const groupView = buildPastState(store, 'group:9');
  assert.match(groupView.text, /和 A 说的话/);
  assert.match(groupView.text, /\[与 1\]/, '群聊里也能看到私聊来源，并标明 QQ');

  const tool = buildToolDefs().find((d) => d.name === 'get_recent_messages');
  const result = await executeTool([tool], {
    chatKey: 'private:1',
    store,
    session: { pastStateCount: 0 }
  }, 'get_recent_messages', JSON.stringify({ limit: 10 }));
  const payload = JSON.parse(result.content);
  const fromGroup = payload.messages.find((m) => m.text.includes('群里说的话'));
  assert.ok(fromGroup, '翻页也要能看到跨会话消息');
  assert.match(fromGroup.text, /^\[群 9\]/);
  assert.equal(fromGroup.messageId, undefined, '别的群的 mid 在当前会话无效');

  configWith(false, false);
  const isolated = buildPastState(store, 'private:1');
  assert.doesNotMatch(isolated.text, /群里说的话/);
  store.close();
});

test('跨会话共享时屏蔽名单按消息自己的群过滤（提示词与翻页同口径）', async () => {
  configWith(false, true, { 9: ['9'] });
  const store = seed();
  const state = buildPastState(store, 'private:1');
  assert.doesNotMatch(state.text, /群里说的话/, '被屏蔽群员的消息不能随共享漏进别的会话');
  assert.match(state.text, /另一个群的话/, '别的群不受影响');

  const tool = buildToolDefs().find((d) => d.name === 'get_recent_messages');
  const result = await executeTool([tool], {
    chatKey: 'private:1',
    store,
    session: { pastStateCount: 0 }
  }, 'get_recent_messages', JSON.stringify({ limit: 10 }));
  const payload = JSON.parse(result.content);
  assert.ok(payload.messages.some((m) => m.text.includes('另一个群的话')), '未屏蔽的群仍可翻到');
  assert.ok(!payload.messages.some((m) => m.text.includes('群里说的话')), '翻页不能绕过屏蔽名单');
  store.close();
});

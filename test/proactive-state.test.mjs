import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { readProactiveAttempts, readProactiveState, writeProactiveAttempt, writeProactiveChatAttempt, writeProactiveChatAttempts } from '../src/core/proactive-state.js';

const tempFile = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-proactive-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'proactive-state.json');
};

test('旧格式单时间戳迁移成群聊/私聊共用，升级后不会额外多一次机会', (t) => {
  const file = tempFile(t);
  fs.writeFileSync(file, JSON.stringify({ lastAttemptAt: 123456 }));
  assert.deepEqual(readProactiveAttempts(file), { group: 123456, private: 123456 });
});

test('两个范围各自记录：写一个不会改另一个', (t) => {
  const file = tempFile(t);
  writeProactiveAttempt(file, 'group', 1000);
  writeProactiveAttempt(file, 'private', 2000);
  assert.deepEqual(readProactiveAttempts(file), { group: 1000, private: 2000 });
  writeProactiveAttempt(file, 'group', 3000);
  assert.deepEqual(readProactiveAttempts(file), { group: 3000, private: 2000 });
});

test('状态文件损坏/缺失按 0 处理，不抛错', (t) => {
  const file = tempFile(t);
  assert.deepEqual(readProactiveAttempts(file), { group: 0, private: 0 });
  fs.writeFileSync(file, '{坏 json');
  assert.deepEqual(readProactiveAttempts(file), { group: 0, private: 0 });
});

test('主动循环为群聊和私聊分别排程，候选也按范围过滤', () => {
  const source = fs.readFileSync(new URL('../src/core/orchestrator.js', import.meta.url), 'utf8');
  assert.match(source, /if \(scopes\.groups\) schedule\('group', 15000\)/);
  assert.match(source, /if \(scopes\.private\) schedule\('private', 45000\)/,
    '私聊错开 30 秒启动，避免重启后同一秒成对开口');
  assert.match(source, /const candidates = this\.#proactiveCandidates\(cfg, scope\)/,
    '调用点必须带 scope；只匹配方法定义会把“调用点漏传 scope”放过去');
  assert.match(source, /chatKeys: this\.store\.listChats\(\)\.filter\(\(key\) => String\(key\)\.startsWith\(prefix\)\)/);
});

test('per-chat 模式各会话独立记录，写范围不会清掉会话记录', (t) => {
  const file = tempFile(t);
  const now = Date.now();
  writeProactiveChatAttempt(file, 'group:1', now - 3000);
  writeProactiveChatAttempt(file, 'group:2', now - 2000);
  writeProactiveChatAttempt(file, 'private:3', now - 1000);
  let state = readProactiveState(file);
  assert.equal(state.chats['group:1'], now - 3000);
  assert.equal(state.chats['group:2'], now - 2000);
  assert.equal(state.chats['private:3'], now - 1000);
  writeProactiveAttempt(file, 'group', now);
  state = readProactiveState(file);
  assert.equal(state.group, now);
  assert.equal(state.chats['group:1'], now - 3000, '范围记录不能清掉 per-chat 记录');
  writeProactiveChatAttempt(file, 'group:1', now + 1000);
  state = readProactiveState(file);
  assert.equal(state.chats['group:1'], now + 1000);
  assert.equal(state.group, now, 'per-chat 记录不能清掉范围记录');
});

test('per-chat 批量写只落盘一次，且不覆盖范围记录', (t) => {
  const file = tempFile(t);
  const now = Date.now();
  writeProactiveAttempt(file, 'group', now - 1000);
  writeProactiveChatAttempts(file, ['group:1', 'group:2', 'group:1'], now);
  const state = readProactiveState(file);
  assert.equal(state.group, now - 1000);
  assert.equal(state.chats['group:1'], now);
  assert.equal(state.chats['group:2'], now);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-store-recent-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

const { ChatStore } = await import('../src/core/store.js');

test('recent(afterId) 返回游标之后最早的一批，不跳过积压', () => {
  const store = new ChatStore(0, { dataDir: dir, filename: 'recent.sqlite' });
  try {
    const entries = [];
    for (let i = 0; i < 5; i += 1) {
      entries.push(store.appendIncoming('group:1', {
        mid: `m${i}`, ts: 1000 + i, senderId: '1', senderName: 'a', text: `t${i}`
      }));
    }
    const first = entries[0].id;
    const batch = store.recent('group:1', { afterId: first, limit: 2 });
    assert.deepEqual(batch.map((item) => item.text), ['t1', 't2']);
    // 非增量的既有语义不变：最新 N 条、按时间正序返回
    assert.deepEqual(store.recent('group:1', { limit: 2 }).map((item) => item.text), ['t3', 't4']);
  } finally {
    store.close();
  }
});

test('hasSelfSince 不受"最新 N 条"窗口影响', () => {
  const store = new ChatStore(0, { dataDir: dir, filename: 'self.sqlite' });
  try {
    store.appendSelf('group:1', { mid: 's0', ts: 1000, text: '旧' });
    assert.equal(store.hasSelfSince('group:1', 1001), false);
    assert.equal(store.hasSelfSince('group:1', 1000), true);
    store.appendSelf('group:1', { mid: 's1', ts: 2000, text: '新' });
    for (let i = 0; i < 30; i += 1) {
      store.appendIncoming('group:1', { mid: `x${i}`, ts: 2001 + i, senderId: '2', senderName: 'b', text: 'x' });
    }
    assert.equal(store.hasSelfSince('group:1', 1500), true, '自述被挤出最新 20 条也要能查到');
  } finally {
    store.close();
  }
});

test('getChatMeta.total 随插入与保留期清理同步，不虚报已删行', () => {
  const store = new ChatStore(3, { dataDir: dir, filename: 'meta-total.sqlite' });
  try {
    for (let i = 0; i < 5; i += 1) {
      store.appendSelf('group:1', { mid: `s${i}`, ts: 1000 + i, text: `t${i}` });
    }
    const rows = store.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_key=?').get('group:1').n;
    assert.equal(rows, 3, '保留期只留 3 条');
    assert.equal(store.getChatMeta('group:1').total, 3, '计数必须跟着清理减，不能拿 next_id 虚报');
  } finally {
    store.close();
  }
});

test('老库升级：message_count 缺失时按现有行数回填一次', () => {
  const file = 'meta-backfill.sqlite';
  const first = new ChatStore(0, { dataDir: dir, filename: file });
  for (let i = 0; i < 4; i += 1) {
    first.appendSelf('group:1', { mid: `b${i}`, ts: 2000 + i, text: `t${i}` });
  }
  // 模拟升级前的库：没有迁移标记、计数还是 0。
  first.db.prepare("DELETE FROM migrations WHERE name='chats_message_count'").run();
  first.db.prepare('UPDATE chats SET message_count=0').run();
  first.close();

  const reopened = new ChatStore(0, { dataDir: dir, filename: file });
  try {
    assert.equal(reopened.getChatMeta('group:1').total, 4);
  } finally {
    reopened.close();
  }
});

test('getChatMeta 的最新消息查询有 (chat_key, ts) 索引', () => {
  const store = new ChatStore(0, { dataDir: dir, filename: 'meta-index.sqlite' });
  try {
    const names = store.db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all()
      .map((row) => row.name);
    assert.ok(names.includes('messages_chat_ts'), '按 ts 取最新一条不能再全表排序');
  } finally {
    store.close();
  }
});

test('pruneOutbox 保留最近 N 条无 runId 的终态行，并清掉 runs 已不存在的孤儿行', () => {
  const store = new ChatStore(0, { dataDir: dir, filename: 'outbox.sqlite' });
  try {
    for (let i = 0; i < 5; i += 1) {
      const id = store.beginSend('group:1', null, { text: `x${i}` });
      store.finishSend(id, { messageId: `m${i}`, outcome: 'sent' });
    }
    // 有 runs 行的终态 outbox 由 run 收尾/保留期管，不算孤儿。
    store.db.prepare('INSERT INTO runs(id, chat_key, state, expires_at) VALUES(?,?,?,?)')
      .run('run-1', 'group:1', 'acked', Date.now() + 86400000);
    const runRow = store.beginSend('group:1', 'run-1', { text: 'keep' });
    store.finishSend(runRow, { outcome: 'sent' });
    // runs 已被保留期清掉，这条 outbox 是孤儿，必须一起回收。
    const orphanRow = store.beginSend('group:1', 'run-gone', { text: 'orphan' });
    store.finishSend(orphanRow, { outcome: 'sent' });

    assert.equal(store.pruneOutbox({ keep: 2 }), 4);
    const rows = store.db.prepare('SELECT id FROM outbox ORDER BY rowid').all();
    assert.equal(rows.length, 3, '保留 2 条无 runId + 1 条有 runs 的');
    assert.ok(rows.some((row) => row.id === runRow), '有 runs 行的终态 outbox 保留');
    assert.equal(rows.some((row) => row.id === orphanRow), false, '孤儿行应被清理');
  } finally {
    store.close();
  }
});

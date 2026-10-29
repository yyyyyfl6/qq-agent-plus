// 群日报（group-digest）门禁：读消息与调模型**之前**就该挡住观察模式/白名单外的群。
// 原来只在最后 sendTextBatch 时才被 access 挡 —— 于是每天照样读 400 条消息 + 调一次模型
// 才被拒（白花钱，还把群消息送出了网）。2026-10-03 全量审查。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-group-digest-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

const { GroupDigestManager } = await import('../src/features/group-digest.js');
const { updateConfig, DEFAULT_CONFIG } = await import('../src/core/config.js');

function fixture({ mode = 'active', allow = ['1'], sender = null, platform = null, persona = null } = {}) {
  const rows = Array.from({ length: 20 }, (_, i) => ({
    mid: `m${i}`, ts: Date.now() - 60_000, self: false,
    sender: { uin: 100 + i, nickname: `群友${i}` }, text: `第 ${i} 条消息`
  }));
  const stats = { modelCalls: 0, sent: 0 };
  const manager = new GroupDigestManager({
    store: { recent: () => rows, listChats: () => ['group:1'] },
    sender: sender ?? { sendTextBatch: async () => { stats.sent += 1; return { sent: [] }; } }
  });
  updateConfig({
    ...DEFAULT_CONFIG,
    runtime: { ...DEFAULT_CONFIG.runtime, mode },
    allow: { groups: allow },
    platform: { ...DEFAULT_CONFIG.platform, ...(platform ?? {}) },
    persona: { ...DEFAULT_CONFIG.persona, ...(persona ?? {}) },
    groupDigest: { ...DEFAULT_CONFIG.groupDigest, enabled: true, chats: ['group:1'] }
  });
  // 群日报用 llm.chatCompletion（全局 fetch）→ 用 fetch 桩数调用次数
  globalThis.fetch = async () => {
    stats.modelCalls += 1;
    return Response.json({ choices: [{ message: { content: '群里在聊啥' } }], usage: { total_tokens: 5 } });
  };
  return { manager, stats };
}

test('观察模式：群日报不调模型也不发', async () => {
  const f = fixture({ mode: 'observe' });
  await f.manager.runOnce();
  assert.equal(f.stats.modelCalls, 0, '观察模式不该花钱');
  assert.equal(f.stats.sent, 0);
});

test('白名单之外的群：群日报不调模型', async () => {
  const f = fixture({ mode: 'active', allow: ['999'] });
  await f.manager.runOnce();
  assert.equal(f.stats.modelCalls, 0, '不在白名单的群不该花钱（门禁要放在调模型之前）');
});

test('正常放行时仍会调模型并发送（门禁没把功能打死）', async () => {
  const f = fixture({ mode: 'active', allow: ['1'] });
  await f.manager.runOnce();
  assert.equal(f.stats.modelCalls, 1, '白名单 + active 模式要照常跑');
  assert.equal(f.stats.sent, 1);
});

test('日报卡片：forwardCards 开（默认）→ 发合并转发卡片（带群内昵称），不再发纯文本', async () => {
  const cards = [];
  const texts = [];
  const f = fixture({
    persona: { selfNickname: '犊子' },
    sender: {
      sendForwardCard: async (chatKey, nodes, options) => { cards.push({ chatKey, nodes, options }); return { message_id: 7 }; },
      sendTextBatch: async (chatKey, messages) => { texts.push({ chatKey, messages }); return { sent: [] }; }
    }
  });
  const out = await f.manager.runOnce();
  assert.equal(cards.length, 1, '默认要发卡片');
  assert.equal(texts.length, 0, '发了卡片就不该再发文本（否则群里两条日报）');
  assert.deepEqual(cards[0].nodes, [{
    type: 'node',
    data: { nickname: '犊子', content: [{ type: 'text', data: { text: '群里在聊啥' } }] }
  }]);
  assert.equal(cards[0].chatKey, 'group:1');
  assert.equal(out.results[0].asCard, true);
});

test('日报卡片：开关关掉 / 老 sender 没有 sendForwardCard → 回落纯文本', async () => {
  // ① 控制台「平台能力」里关掉 forwardCards
  const texts = [];
  const f1 = fixture({
    platform: { forwardCards: false },
    sender: {
      sendForwardCard: async () => { throw new Error('关了开关还走卡片 = 回归'); },
      sendTextBatch: async (chatKey, messages) => { texts.push({ chatKey, messages }); return { sent: [] }; }
    }
  });
  const out1 = await f1.manager.runOnce();
  assert.equal(texts.length, 1, '关掉开关要回到纯文本');
  assert.deepEqual(texts[0].messages, ['群里在聊啥']);
  assert.equal(out1.results[0].asCard, false);

  // ② sender 没有 sendForwardCard 能力（老接线/降级场景）也要能跑
  const texts2 = [];
  const f2 = fixture({
    sender: { sendTextBatch: async (chatKey, messages) => { texts2.push({ chatKey, messages }); return { sent: [] }; } }
  });
  const out2 = await f2.manager.runOnce();
  assert.deepEqual(texts2[0].messages, ['群里在聊啥'], '没有卡片能力就回落文本，不能抛错');
  assert.equal(out2.results[0].asCard, false, 'asCard 要如实报"没走卡片"（2026-10-07 复审 P3）');
});

test('观察模式挡下的群不记当日完成，恢复后可以补跑', async () => {
  // 同一文件的用例共享 DATA_DIR；先清掉前面用例写下的"今天已跑过"
  fs.rmSync(path.join(root, 'group-digest-state.json'), { force: true });
  const f = fixture({ mode: 'observe' });
  await f.manager.runOnce();
  const stateFile = path.join(root, 'group-digest-state.json');
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
  assert.equal(state?.doneChats?.includes('group:1') || false, false, '被挡下的群不能记完成');

  updateConfig({
    ...DEFAULT_CONFIG,
    runtime: { ...DEFAULT_CONFIG.runtime, mode: 'active' },
    allow: { groups: ['1'] },
    groupDigest: { ...DEFAULT_CONFIG.groupDigest, enabled: true, chats: ['group:1'] }
  });
  await f.manager.runOnce({ skipDone: true });
  assert.equal(f.stats.sent, 1, '恢复 active 后应补发，而不是被 already-sent-today 跳过');
});

test('关闭群日报后，自动补跑（skipDone）不再发送', async () => {
  const f = fixture({ mode: 'active' });
  updateConfig({
    ...DEFAULT_CONFIG,
    runtime: { ...DEFAULT_CONFIG.runtime, mode: 'active' },
    allow: { groups: ['1'] },
    groupDigest: { ...DEFAULT_CONFIG.groupDigest, enabled: false, chats: ['group:1'] }
  });
  const out = await f.manager.runOnce({ skipDone: true });
  assert.equal(out.skipped, 'disabled');
  assert.equal(f.stats.sent, 0, '功能已关闭，孤儿补跑不能发消息');
});

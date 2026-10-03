import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatStore } from '../src/core/store.js';
import { setRuntimeConfig, getConfig, DEFAULT_CONFIG } from '../src/core/config.js';
import { MemoryStore } from '../src/memory/memory.js';
import { SkinMemoryStore } from '../src/skins/memory.js';
import { backupPersonBeforeConsolidation } from '../src/memory/memory-consolidation-backup.js';
import { buildSystemPrompt } from '../src/llm/prompt.js';

const skinModule = await import('../src/skins/skins.js').catch(() => ({}));
const { normalizeSkins, resolveSkinConfig, parseSkinCommand, SkinManager, skinSummaryInput } = skinModule;
const cfg = () => ({ ...structuredClone(DEFAULT_CONFIG), skins: {
  enabled: true, default: 'fish',
  list: [
    { id: 'fish', label: '鱼', templateId: 'blue_fish', provider: 'ds', model: 'deepseek-flash', botName: '小鲸鱼' },
    { id: 'cat', label: '猫', templateId: 'hajimi', provider: 'gm', model: 'gemini-3.8-flash', botName: '哈基米' }
  ], switchCommands: ['/skin', '切鱼', '切猫'],
  handoffOnSwitch: { enabled: true, maxChars: 1200, recentMessages: 40, provider: '', model: '' }
}, providers: [{ id: 'ds', baseURL: 'https://ds.example/v1' }, { id: 'gm', baseURL: 'https://gm.example/v1' }],
providerKeys: { ds: 'test-ds', gm: 'test-gm' }, api: { baseUrl: 'https://old.example/v1', model: 'old', apiKey: 'test-old' },
admin: { ownerUin: '10001' }, autoUpdate: { ownerUin: '10001' } });

test('skins configuration defaults are disabled; reject ambiguous IDs', () => {
  assert.equal(typeof normalizeSkins, 'function');
  assert.equal(normalizeSkins().enabled, false);
  assert.throws(() => normalizeSkins({ ...cfg().skins, list: [{ id: '../cat' }] }));
  assert.throws(() => normalizeSkins({ ...cfg().skins, list: [cfg().skins.list[0], cfg().skins.list[0]] }));
});

test('chat skin wins over global persona, provider keys follow endpoint, missing provider keeps api', () => {
  assert.equal(typeof resolveSkinConfig, 'function');
  const base = cfg();
  const cat = resolveSkinConfig(base, 'cat');
  assert.equal(cat.persona.templateId, 'hajimi');
  assert.equal(cat.api.model, 'gemini-3.8-flash');
  assert.equal(cat.api.baseUrl, 'https://gm.example/v1');
  assert.equal(cat.api.apiKey, 'test-gm');
  assert.equal(base.api.model, 'old');
  base.providers = [];
  const warnings = [];
  assert.deepEqual(resolveSkinConfig(base, 'cat', (m) => warnings.push(m)).api, base.api);
  assert.equal(warnings.length, 1);
  base.skins.enabled = false;
  assert.equal(resolveSkinConfig(base, 'cat'), base);
});

test('exact owner commands only, aliases configurable, disabled commands ignored', () => {
  assert.equal(typeof parseSkinCommand, 'function');
  assert.equal(parseSkinCommand('/skin cat', cfg()).skinId, 'cat');
  assert.equal(parseSkinCommand('切鱼', cfg()).skinId, 'fish');
  assert.equal(parseSkinCommand('请切猫', cfg()), null);
  assert.equal(parseSkinCommand('/skin cat extra', cfg()).error, true);
  const disabled = cfg(); disabled.skins.enabled = false;
  assert.equal(parseSkinCommand('切猫', disabled), null);
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-skins-'));
  const store = new ChatStore(0, { dataDir: dir });
  t.after(() => { store.close(); setRuntimeConfig(structuredClone(DEFAULT_CONFIG)); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, dir };
}

test('old messages belong to default skin; switch back restores isolated history and threads', async (t) => {
  const { store } = fixture(t);
  setRuntimeConfig({ ...cfg(), skins: { ...cfg().skins, enabled: false } });
  store.appendIncoming('group:1', { mid: '1', text: 'old fish', senderId: '42' });
  const old = store.recent('group:1');
  assert.equal(typeof SkinManager, 'function');
  setRuntimeConfig(cfg());
  const skins = new SkinManager({ store, getConfig, summarize: async () => '转述' });
  const thread = store.upsertConversationThread('group:1');
  await skins.switchSkin('group:1', 'cat');
  assert.deepEqual(store.recent('group:1'), []);
  assert.equal(store.getConversationThread('group:1'), null);
  store.appendIncoming('group:1', { mid: '2', text: 'cat only', senderId: '42' });
  await skins.switchSkin('group:1', 'fish');
  assert.deepEqual(store.recent('group:1').map((m) => m.text), ['old fish']);
  assert.notEqual(store.upsertConversationThread('group:1').threadId, thread.threadId);
  assert.deepEqual(store.listChats(), ['group:1']);
  setRuntimeConfig({ ...cfg(), skins: { ...cfg().skins, enabled: false } });
  assert.deepEqual(store.recent('group:1'), old);
});

test('handoff on/off, failure and non-owner handling never leak or stop a switch', async (t) => {
  const { store } = fixture(t);
  setRuntimeConfig(cfg());
  let calls = 0;
  const skins = new SkinManager({ store, getConfig, summarize: async () => { calls++; return '鱼刚刚谈了项目'; } });
  store.appendIncoming('group:1', { text: '项目', mid: 1 });
  await skins.switchSkin('group:1', 'cat');
  assert.equal(calls, 1);
  assert.match(skins.handoffPrompt('group:1'), /另一个 AI.*不是你亲历/);
  assert.match(skins.handoffPrompt('group:1'), /另一人格留下的交接摘要（转述，非亲历）/);
  assert.match(skins.handoffPrompt('group:1'), /来源人格：【鱼】/);
  const disabled = cfg(); disabled.skins.handoffOnSwitch.enabled = false; setRuntimeConfig(disabled);
  assert.equal(skins.handoffPrompt('group:1'), '');
  await skins.switchSkin('group:1', 'fish');
  assert.equal(calls, 1);
  assert.equal(await skins.consumeCommand('group:1', '42', '切猫'), false);
  assert.equal(skins.current('group:1').id, 'fish');
  const warnings = []; skins.warn = (text) => warnings.push(text);
  skins.summarize = async () => { throw new Error('模型 API HTTP 401：Bearer secret-test and private prompt'); };
  setRuntimeConfig(cfg());
  const result = await skins.switchSkin('group:1', 'cat');
  assert.equal(result.handoffStatus, 'failed');
  assert.match(result.handoffError, /HTTP 401/);
  assert.ok(!JSON.stringify([result, warnings]).includes('secret-test'));
  assert.ok(!JSON.stringify([result, warnings]).includes('private prompt'));
  assert.equal(skins.current('group:1').id, 'cat');
  assert.equal(skins.handoffPrompt('group:1'), '');
});

test('summary states distinguish disabled, no messages, empty reply and successful handoff', async (t) => {
  const { store } = fixture(t); setRuntimeConfig(cfg());
  const skins = new SkinManager({ store, getConfig, summarize: async () => '' });
  assert.equal((await skins.switchSkin('group:1', 'cat')).handoffStatus, 'no-messages');
  store.appendIncoming('group:1', { text: 'test', mid: '1' });
  assert.equal((await skins.switchSkin('group:1', 'fish')).handoffStatus, 'empty-response');
});

test('message replay never copies old history; delivered handoff persists until replaced', async (t) => {
  const { store } = fixture(t); setRuntimeConfig(cfg());
  const skins = new SkinManager({ store, getConfig, summarize: async () => '旧鱼的话题' });
  store.appendIncoming('group:1', { mid: 'old', text: '旧鱼', senderId: '42' });
  await skins.switchSkin('group:1', 'cat');
  assert.equal(store.appendIncoming('group:1', { mid: 'old', text: '补拉的旧鱼' }).duplicate, true);
  assert.deepEqual(store.recent('group:1'), []);
  assert.equal(store.getChatMeta('group:1').chatKey, 'group:1');
  assert.equal(store.identityActivityRows().length, 0);
  assert.ok(skins.handoffPrompt('group:1'));
  skins.markHandoffUsed('group:1');
  assert.match(skins.handoffPrompt('group:1'), /旧鱼的话题/);
  store.appendIncoming('group:1', { mid: 'new', text: '新猫', senderId: '42' });
  assert.equal(store.identityActivityRows()[0].chatKey, 'group:1');
  await skins.switchSkin('group:1', 'fish');
  skins.summarize = async () => '新鱼的话题';
  await skins.switchSkin('group:1', 'cat');
  assert.match(skins.handoffPrompt('group:1'), /新鱼的话题/);
  assert.doesNotMatch(skins.handoffPrompt('group:1'), /旧鱼的话题/);
});

test('summary input keeps complete recent questions and answers when the old history exceeds the budget', () => {
  const messages = Array.from({ length: 40 }, (_, i) => ({ text: `${i}:` + '旧话题'.repeat(2000), senderName: '用户' }));
  messages.push({ text: '你是谁', senderName: '用户' }, { text: 'DeepSeek，小鲸鱼', self: true });
  const input = skinSummaryInput(messages, { label: '鲸鱼娘' });
  assert.ok(input.length <= 20000);
  const rows = JSON.parse(input);
  assert.deepEqual(rows.slice(-2), [{ speaker: '用户', text: '你是谁' }, { speaker: '鲸鱼娘', text: 'DeepSeek，小鲸鱼' }]);
  assert.ok(!rows[0].text.startsWith('0:'));
  const escaped = skinSummaryInput([{ text: '最新问题：' + '\u0001'.repeat(6000), senderName: '用户' }], { label: '鲸鱼娘' });
  assert.ok(escaped.length <= 20000);
  assert.match(JSON.parse(escaped)[0].text, /^最新问题：/);
});

test('disabling during a cat task pins its writes; bindings and legacy owner survive restart', async (t) => {
  const { store, dir } = fixture(t); setRuntimeConfig(cfg());
  let skins = new SkinManager({ store, getConfig });
  const memoryDir = path.join(dir, 'memory');
  const memory = new SkinMemoryStore({ legacy: new MemoryStore({ memoryDir }), skins, memoryDir });
  await skins.switchSkin('group:1', 'cat');
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const task = skins.scope('group:1', async () => {
    await gate;
    assert.equal(getConfig().api.model, 'gemini-3.8-flash');
    store.appendIncoming('group:1', { mid: 'cat', text: 'cat late' });
    memory.append('group:1', 'memberImpression', 'cat late', { userId: '42', target: '甲' });
  });
  const disabled = cfg(); disabled.skins.enabled = false; setRuntimeConfig(disabled);
  release(); await task;
  assert.deepEqual(store.recent('group:1'), []);
  assert.deepEqual(memory.query('group:1').memberImpression, []);
  const changedDefault = cfg(); changedDefault.skins.default = 'cat'; setRuntimeConfig(changedDefault);
  skins = new SkinManager({ store, getConfig });
  assert.equal(skins.legacySkin, 'fish');
  assert.equal(skins.current('group:1').id, 'cat');
  assert.equal(store.recent('group:1')[0].text, 'cat late');
  await skins.switchSkin('group:1', 'fish');
  assert.deepEqual(store.recent('group:1'), []);
});

test('short handoff always preserves the non-lived statement even with a long source label', async (t) => {
  const { store } = fixture(t); const config = cfg();
  config.skins.list[0].label = '鱼'.repeat(200); config.skins.handoffOnSwitch.maxChars = 120;
  setRuntimeConfig(config);
  const skins = new SkinManager({ store, getConfig, summarize: async () => '事情'.repeat(100) });
  store.appendIncoming('group:1', { mid: '1', text: '事情' });
  await skins.switchSkin('group:1', 'cat');
  const summary = store.db.prepare('SELECT summary FROM skin_handoffs').get().summary;
  assert.ok(summary.length <= 120);
  assert.match(summary, /^这是另一个 AI 在这个身体里干的，不是你亲历的。/);
});

test('memory migration preserves originals, meta, handoff, people and backup isolation', async (t) => {
  const { store, dir } = fixture(t);
  setRuntimeConfig(cfg());
  const memoryDir = path.join(dir, 'memory');
  const legacy = new MemoryStore({ memoryDir });
  legacy.append('group:1', 'memberImpression', '鱼认识这个人', { userId: '42', target: '甲' });
  // 上游旧备份包含全局人物快照；迁移时既要留下审计历史，也要剔除其它会话来源。
  const person = legacy.getMember('', '42');
  const mixed = { ...person, impressions: [...person.impressions, { content: '另一个会话的秘密', sourceChatKeys: ['group:2'] }] };
  backupPersonBeforeConsolidation(mixed, { memoryDir, sourceChatKey: 'group:1' });
  legacy.setHandoff('group:1', { summary: '旧交接' });
  legacy.markConsolidated('group:1', 12345);
  const skins = new SkinManager({ store, getConfig });
  const memory = new SkinMemoryStore({ legacy, skins, memoryDir });
  assert.match(memory.query('group:1').memberImpression[0].content, /鱼/);
  assert.equal(memory.getHandoff('group:1').summary, '旧交接');
  assert.ok(memory.consolidationState('group:1').lastConsolidatedAt >= 12345);
  const fishRoot = path.join(memoryDir, 'group_1', 'skins', 'fish');
  const snapshots = fs.readdirSync(path.join(fishRoot, 'backups', 'consolidation', '42'));
  assert.equal(snapshots.length, 1);
  const migratedSnapshot = fs.readFileSync(path.join(fishRoot, 'backups', 'consolidation', '42', snapshots[0]), 'utf8');
  assert.match(migratedSnapshot, /鱼认识这个人/);
  assert.ok(!migratedSnapshot.includes('秘密'));
  assert.ok(!fs.readFileSync(path.join(fishRoot, 'backups', 'group_1', '42.json'), 'utf8').includes('秘密'));
  await skins.switchSkin('group:1', 'cat');
  assert.deepEqual(memory.query('group:1').memberImpression, []);
  assert.equal(memory.getHandoff('group:1'), null);
  memory.append('group:1', 'memberImpression', '猫自己的印象', { userId: '42', target: '甲' });
  memory.replaceMember('group:1', '42', '甲', ['猫整合后的印象']);
  const catBackups = path.join(memoryDir, 'group_1', 'skins', 'cat', 'backups', 'consolidation', '42');
  assert.ok(fs.readdirSync(catBackups).length > 0);
  await skins.switchSkin('group:1', 'fish');
  assert.equal(memory.query('group:1').memberImpression[0].content, '鱼认识这个人');
  assert.equal(legacy.getHandoff('group:1').summary, '旧交接');
  assert.equal(legacy.getMember('', '42').impressions[0].content, '鱼认识这个人');
  assert.deepEqual(memory.query('group:2').memberImpression, []);
});

test('running scopes pin provider, message writes, memory writes and identity lookups across switch', async (t) => {
  const { store, dir } = fixture(t);
  setRuntimeConfig(cfg());
  const skins = new SkinManager({ store, getConfig });
  const memoryDir = path.join(dir, 'memory');
  const memory = new SkinMemoryStore({ legacy: new MemoryStore({ memoryDir }), skins, memoryDir });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const oldRun = skins.scope('group:1', async () => {
    await gate;
    assert.equal(getConfig().api.model, 'deepseek-flash');
    store.appendSelf('group:1', { mid: 'late', text: '迟到的鱼' });
    memory.append('group:1', 'memberImpression', '迟到的鱼记忆', { userId: '42', target: '甲' });
    assert.equal(memory.getMember('', '42').impressions[0].content, '迟到的鱼记忆');
  });
  await skins.switchSkin('group:1', 'cat');
  release(); await oldRun;
  assert.deepEqual(store.recent('group:1'), []);
  assert.deepEqual(memory.query('group:1').memberImpression, []);
  await skins.switchSkin('group:1', 'fish');
  assert.equal(store.recent('group:1')[0].text, '迟到的鱼');
  assert.equal(memory.query('group:1').memberImpression[0].content, '迟到的鱼记忆');
});

test('disabled skins create no mutable skin state, do not change prompts or consume commands', async (t) => {
  const { store } = fixture(t);
  const disabled = cfg(); disabled.skins.enabled = false; setRuntimeConfig(disabled);
  const prompt = buildSystemPrompt({});
  const skins = new SkinManager({ store, getConfig });
  assert.equal(await skins.consumeCommand('group:1', '10001', '切猫', '1'), false);
  assert.equal(skins.scope('group:1', () => buildSystemPrompt({})), prompt);
  assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE name='chat_skins'").get(), undefined);
});

test('owner command replay is consumed once and acknowledgement uses configuration', async (t) => {
  const { store } = fixture(t); setRuntimeConfig(cfg());
  const acks = [];
  const skins = new SkinManager({ store, getConfig, sendAck: async (_key, text) => acks.push(text) });
  assert.equal(await skins.consumeCommand('group:1', '10001', '/skin cat', '99'), true);
  assert.equal(await skins.consumeCommand('group:1', '10001', '/skin cat', '99'), true);
  assert.deepEqual(acks, ['已切换到 猫\n原人格没有可总结的消息，未生成交接摘要']);
  assert.deepEqual(store.recent('group:1'), []);
});

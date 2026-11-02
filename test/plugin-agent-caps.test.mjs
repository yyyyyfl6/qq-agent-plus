// 插件接口 v3（src/plugins/agent-caps.js）：副 API 调模型、给会话挂背景、请求主动唤醒。
// 钉住：只有 v3 能声明；Key 由宿主解析；每日上限与先记账、失败退回；背景有过期且停用即撤；唤醒有间隔。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agentcaps-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  api: { baseUrl: 'https://main.example.com/v1', apiKey: 'main-key', model: 'main-model', provider: 'p_main' },
  providers: [
    { id: 'p_main', baseURL: 'https://main.example.com/v1', models: ['main-model'], apiKeyFrom: 'manual' },
    { id: 'p_side', baseURL: 'https://side.example.com/v1', models: ['cheap-model'], apiKeyFrom: 'manual' }
  ],
  providerKeys: { p_main: 'main-key', p_side: 'side-key' }
}));

const { createAgentCapabilities, pluginContextFor, clearPluginContext } = await import('../src/plugins/agent-caps.js');
const { parsePluginManifest: validateManifest } = await import('../src/plugins/manifest.js');

const base = { id: 'demo', name: '演示', version: '1.0.0' };

test('v3 能力只有 apiVersion 3 能声明', () => {
  assert.equal(validateManifest({ ...base, apiVersion: 2, capabilities: ['llm'] }).ok, false);
  assert.match(validateManifest({ ...base, apiVersion: 2, capabilities: ['wake'] }).error, /apiVersion 3/);
  assert.equal(validateManifest({ ...base, apiVersion: 3, capabilities: ['llm', 'context', 'wake', 'schedule'] }).ok, true);
});

test('llm：按插件设置里的副 API 解析 Key，有每日上限，失败退回', async () => {
  let now = Date.parse('2026-11-01T10:00:00+08:00');
  const calls = [];
  let failNext = false;
  const caps = createAgentCapabilities({
    pluginId: 'demo', manifest: { name: '演示' }, dataDir, now: () => now,
    getSettings: () => ({ llmProvider: 'p_side', llmModel: 'cheap-model' }),
    limits: { llmDailyCalls: 2 },
    complete: async (req) => { calls.push(req); if (failNext) { failNext = false; throw new Error('boom'); } return { message: { content: '好的' } }; }
  });
  const r = await caps.methods['cap.llm.complete']({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.content, '好的');
  assert.equal(calls[0].overrides.apiKey, 'side-key');
  assert.equal(calls[0].overrides.baseUrl, 'https://side.example.com/v1');
  assert.equal(calls[0].overrides.model, 'cheap-model');
  assert.equal(calls[0].thinking, 'off');
  failNext = true;
  await assert.rejects(caps.methods['cap.llm.complete']({ messages: [{ role: 'user', content: 'x' }] }), /副 API 调用失败/);
  await caps.methods['cap.llm.complete']({ messages: [{ role: 'user', content: 'y' }] });   // 失败那次退回了额度
  await assert.rejects(caps.methods['cap.llm.complete']({ messages: [{ role: 'user', content: 'z' }] }), /用完/);
  now += 24 * 3600_000;
  await caps.methods['cap.llm.complete']({ messages: [{ role: 'user', content: '第二天' }] });
});

test('llm：user 消息可带图（data URL，最多 2 张），格式不对 / 非 user 消息带图就拒', async () => {
  const calls = [];
  const caps = createAgentCapabilities({
    pluginId: 'pics', manifest: { name: '看图' }, dataDir,
    getSettings: () => ({ llmProvider: 'p_side', llmModel: 'cheap-model' }),
    complete: async (req) => { calls.push(req); return { message: { content: '一只猫' } }; }
  });
  const img = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
  await caps.methods['cap.llm.complete']({ messages: [{ role: 'user', content: '这是什么', images: [img] }] });
  assert.deepEqual(calls[0].messages[0].content, [{ type: 'text', text: '这是什么' }, { type: 'image_url', image_url: { url: img } }]);
  await assert.rejects(caps.methods['cap.llm.complete']({ messages: [{ role: 'user', content: 'x', images: [img, img, img] }] }), /最多/);
  await assert.rejects(caps.methods['cap.llm.complete']({ messages: [{ role: 'user', content: 'x', images: ['https://e.com/a.png'] }] }), /data:image/);
  await assert.rejects(caps.methods['cap.llm.complete']({ messages: [{ role: 'system', content: 'x', images: [img] }] }), /user/);
  assert.equal(calls.length, 1, '被拒的不调模型、不记账');
});

test('context：挂到会话、按 chatKey 取、过期与停用即撤', () => {
  let now = 1_000_000;
  const caps = createAgentCapabilities({ pluginId: 'ctx', manifest: { name: '生活' }, dataDir, now: () => now, getSettings: () => ({}) });
  caps.methods['cap.context.set']({ chatKey: 'private:10001', text: '此刻在图书馆看书', ttlMinutes: 30 });
  assert.match(pluginContextFor('private:10001', now), /插件「生活」.*\n此刻在图书馆看书/);
  assert.equal(pluginContextFor('private:20002', now), '');
  assert.throws(() => caps.methods['cap.context.set']({ chatKey: 'bad', text: 'x' }), /chatKey/);
  assert.throws(() => caps.methods['cap.context.set']({ chatKey: 'private:10001', text: 'x'.repeat(2000) }), /太长/);
  assert.equal(pluginContextFor('private:10001', now + 31 * 60_000), '');
  caps.methods['cap.context.set']({ chatKey: 'private:10001', text: '又在了' });
  clearPluginContext('ctx');
  assert.equal(pluginContextFor('private:10001', now), '');
});

test('wake：交给主链路 proactive 唤醒，有会话间隔与每日上限', async () => {
  let now = Date.parse('2026-11-01T12:00:00+08:00');
  const woke = [];
  const caps = createAgentCapabilities({
    pluginId: 'wk', manifest: { name: '生活' }, dataDir, now: () => now, getSettings: () => ({}),
    getAgent: () => ({ wake: async (k, o) => { woke.push([k, o]); } }), limits: { wakeDailyCalls: 2, wakeMinGapMinutes: 20 }
  });
  await caps.methods['cap.wake.request']({ chatKey: 'private:10001', note: '你刚下课，想问问对方午饭吃了啥' });
  assert.equal(woke[0][0], 'private:10001');
  assert.equal(woke[0][1].proactive, true);
  assert.match(woke[0][1].wakeNote, /^【系统提醒】（插件「生活」）你刚下课/);
  await assert.rejects(caps.methods['cap.wake.request']({ chatKey: 'private:10001' }), /分钟内已经唤醒过/);
  now += 21 * 60_000;
  await caps.methods['cap.wake.request']({ chatKey: 'private:10001' });
  now += 21 * 60_000;
  await assert.rejects(caps.methods['cap.wake.request']({ chatKey: 'private:10001' }), /用完/);
  const none = createAgentCapabilities({ pluginId: 'wk2', manifest: {}, dataDir, getSettings: () => ({}) });
  await assert.rejects(none.methods['cap.wake.request']({ chatKey: 'private:1001' }), /主链路不可用/);
});

test('context.persona：读会话当前人格（由宿主解析），参数校验', async () => {
  const caps = createAgentCapabilities({
    pluginId: 'pp', manifest: { name: 'x' }, dataDir, getSettings: () => ({}),
    getAgent: () => ({ persona: (k) => ({ skinId: k === 'private:10001' ? 'cat' : 'fish', label: '哈基米', botName: '哈基米', roleText: 'x'.repeat(5000) }) })
  });
  const p = await caps.methods['cap.context.persona']({ chatKey: 'private:10001' });
  assert.equal(p.skinId, 'cat');
  assert.equal(p.roleText.length, 3000);
  assert.throws(() => caps.methods['cap.context.persona']({ chatKey: 'x' }), /chatKey/);
  const none = createAgentCapabilities({ pluginId: 'pp2', manifest: {}, dataDir, getSettings: () => ({}) });
  assert.throws(() => none.methods['cap.context.persona']({ chatKey: 'private:10001' }), /主链路不可用/);
});

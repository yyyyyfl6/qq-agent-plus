import assert from 'node:assert/strict';
import { test } from 'node:test';
const { resolveSkinConfig, normalizeSkins, parseSkinCommand, resolveSummaryApi } = await import('../src/skins/skins.js');
import { resolveApiKey, chatCompletion } from '../src/llm/llm.js';

const config = () => ({
  api: { baseUrl: 'https://gateway.example/v1/', apiKey: 'global-test', model: 'gemini-chat' },
  providers: [{ id: 'gateway', baseURL: 'https://gateway.example/v1', apiKeyFrom: '', apiKey: '******', models: ['deepseek-flash', 'gemini-chat'] }],
  providerKeys: { gateway: 'stale-test' },
  skins: { enabled: true, default: 'fish', list: [{ id: 'fish', label: '鱼', templateId: 'blue_fish', provider: 'gateway', model: 'gemini-chat', commands: ['变成鱼'] }] }
});

test('same endpoint with global key source uses current global key, not a stale copy', () => {
  const cfg = config();
  assert.equal(resolveApiKey(resolveSkinConfig(cfg, 'fish')), 'global-test');
  cfg.api.apiKey = 'rotated-test';
  assert.equal(resolveApiKey(resolveSkinConfig(cfg, 'fish')), 'rotated-test');
  delete cfg.providers[0].apiKeyFrom; delete cfg.providerKeys.gateway;
  assert.equal(resolveSkinConfig(cfg, 'fish').api.apiKey, 'rotated-test');
});

test('cross endpoint without own key fails before sending a request', async (t) => {
  const cfg = config(); cfg.providers[0].baseURL = 'https://other.example/v1';
  const api = resolveSkinConfig(cfg, 'fish').api;
  assert.equal(api.apiKey, '');
  let requests = 0; t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('unexpected'); });
  await assert.rejects(chatCompletion({ messages: [], overrides: api }), /API Key/);
  assert.equal(requests, 0);
});

test('summary model defaults to deepseek-flash independently of chat model', () => {
  const cfg = config();
  assert.equal(normalizeSkins(cfg.skins).handoffOnSwitch.model, 'deepseek-flash');
  assert.equal(resolveSummaryApi(cfg, normalizeSkins(cfg.skins).handoffOnSwitch).model, 'deepseek-flash');
  cfg.providers.push({ id: 'other', baseURL: 'https://other.example/v1', apiKeyFrom: 'manual', models: ['summary-model'] });
  cfg.providerKeys.other = 'other-test';
  assert.deepEqual(resolveSummaryApi(cfg, { provider: 'other', model: 'summary-model' }).apiKey, 'other-test');
  assert.equal(resolveSummaryApi(cfg, { provider: 'other', model: 'summary-model' }).model, 'summary-model');
  assert.throws(() => resolveSummaryApi(cfg, { provider: 'missing' }), /不存在/);
  cfg.api = { provider: 'other', baseUrl: 'https://other.example/v1', apiKey: '', model: 'chat-other' };
  assert.equal(resolveSummaryApi(cfg, { model: 'unlisted-summary' }).apiKey, 'other-test');
});

test('custom presets and exact per-personality commands validate conflicts', () => {
  const cfg = config(); cfg.customPersonas = [{ name: '自定义', text: '自定义预设正文', customRules: '自己的规则' }];
  cfg.skins.list[0].templateId = 'custom_0';
  const resolved = resolveSkinConfig(cfg, 'fish');
  assert.equal(resolved.persona.roleText, '自定义预设正文');
  assert.equal(resolved.persona.customRules, '自己的规则');
  assert.equal(parseSkinCommand('变成鱼', cfg).skinId, 'fish');
  assert.equal(parseSkinCommand('请变成鱼', cfg), null);
  cfg.skins.list.push({ ...cfg.skins.list[0], id: 'other' });
  assert.throws(() => normalizeSkins(cfg.skins, cfg.customPersonas), /重复/);
});

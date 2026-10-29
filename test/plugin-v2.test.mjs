// 插件 apiVersion 2：设置 schema / 加密凭据 / owner 授权 / 每日配额 / 媒体边界。
// 这里只碰纯宿主侧逻辑与文件，不 spawn 子进程（真进程的护栏在 plugins.test.mjs）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-v2-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄占用就算了 */ } });

const { parsePluginManifest, V2_CAPABILITIES } = await import('../src/plugins/manifest.js');
const { readPluginSecrets, writePluginSecrets, pluginSecretStatus, secretFieldKeys } = await import('../src/plugins/secrets.js');
const { grantApproval, checkApproval, consumeQuota, grantsStatus } = await import('../src/plugins/grants.js');
const { createCapabilities } = await import('../src/plugins/capabilities.js');
const { CAP_METHODS } = await import('../src/plugins/protocol.js');

const v2 = (extra = {}) => ({
  id: 'demo2',
  apiVersion: 2,
  name: '演示 v2',
  version: '1.0.0',
  capabilities: ['tools', 'http', 'secrets', 'approval', 'quota'],
  settings: {
    groups: [{
      key: 'account',
      title: '账号',
      fields: [
        { key: 'sessdata', label: 'SESSDATA', type: 'secret' },
        { key: 'autoLike', label: '自动点赞', type: 'boolean', default: false },
        { key: 'speed', label: '速度', type: 'select', options: [{ value: 'slow', label: '慢' }, { value: 'fast', label: '快' }] }
      ]
    }]
  },
  approvals: [{ action: 'like', label: '点赞' }],
  quotas: { like: 5 },
  httpDomains: ['api.example.com'],
  ...extra
});

const parse = (raw) => parsePluginManifest(raw, { dir: path.join(dataDir, 'plugins', raw.id) });

test('apiVersion 2：合法 manifest 通过，v1 不能声明 v2 能力', () => {
  const ok = parse(v2());
  assert.ok(ok.ok, ok.error);
  assert.equal(ok.manifest.apiVersion, 2);
  assert.equal(ok.manifest.settings.groups[0].fields[0].type, 'secret');
  assert.deepEqual(ok.manifest.httpDomains, ['api.example.com']);
  assert.equal(ok.manifest.quotas.like, 5);

  const legacy = parse({
    id: 'old', apiVersion: 1, name: '老插件', version: '1.0.0', capabilities: ['tools', 'secrets']
  });
  assert.equal(legacy.ok, false);
  assert.match(legacy.error, /apiVersion 1 不能声明/);
});

test('保留 id：pending 不能作为插件 id（会覆盖全局待批队列）', () => {
  const result = parse({ ...v2(), id: 'pending' });
  assert.equal(result.ok, false);
  assert.match(result.error, /保留名/);
});

test('apiVersion 2：schema / 授权 / 配额校验 fail-closed', () => {
  const cases = [
    [v2({ capabilities: ['tools'] }), /secret 字段就必须.*secrets/],
    [v2({ capabilities: ['tools', 'http', 'secrets', 'quota'] }), /approvals 就必须.*approval/],
    [v2({ capabilities: ['tools', 'http', 'secrets', 'approval'] }), /quotas 就必须.*quota/],
    [v2({ quotas: { like: 0 } }), /1-10000/],
    [v2({ quotas: { dance: 3 } }), /没有在 approvals 里声明/],
    [v2({ httpDomains: ['localhost'] }), /非法域名/],
    [v2({ settings: { groups: [{ key: 'a', title: 'A', fields: [{ key: 'x', label: 'X', type: 'html' }] }] } }), /type 只能是/],
    [v2({ settings: { groups: [{ key: 'a', title: 'A', fields: [{ key: 'x', label: 'X', type: 'secret' }] }] }, capabilities: ['tools', 'http', 'secrets'] }), /approvals|quotas/]
  ];
  for (const [raw, pattern] of cases) {
    const result = parse(raw);
    assert.equal(result.ok, false, `${JSON.stringify(raw.quotas || raw.httpDomains || raw.settings)} 应该被拒`);
    assert.match(result.error, pattern);
  }
  assert.ok(V2_CAPABILITIES.includes('media'));
});

test('凭据：加密落盘、控制台只看到配置状态、未声明字段写不进去', () => {
  const id = 'vault';
  const allowed = secretFieldKeys(v2().settings);
  assert.deepEqual(allowed, ['sessdata']);
  writePluginSecrets(dataDir, id, { sessdata: 'super-secret-cookie' }, allowed);
  assert.equal(readPluginSecrets(dataDir, id).sessdata, 'super-secret-cookie');

  const raw = fs.readFileSync(path.join(dataDir, 'plugin-secrets', `${id}.json`), 'utf8');
  assert.ok(!raw.includes('super-secret-cookie'), '密文文件里不能出现明文');
  const status = pluginSecretStatus(dataDir, id, ['sessdata', 'other']);
  assert.equal(status.configured.sessdata, true);
  assert.equal(status.configured.other, false);
  assert.equal(JSON.stringify(status).includes('super-secret'), false);

  assert.throws(() => writePluginSecrets(dataDir, id, { password: 'x' }, allowed), /没有在 manifest/);
  // 空值 = 删除
  writePluginSecrets(dataDir, id, { sessdata: '' }, allowed);
  assert.equal(readPluginSecrets(dataDir, id).sessdata, undefined);
});

test('授权：默认拒绝、按次消费、过期失效', () => {
  const id = 'approve-me';
  const at = 1_700_000_000_000;
  const denied = checkApproval(dataDir, id, 'like', { now: at });
  assert.equal(denied.approved, false);
  grantApproval(dataDir, id, 'like', { uses: 2, ttlMs: 60_000, now: at });
  assert.equal(checkApproval(dataDir, id, 'like', { consume: false, now: at + 1 }).approved, true);
  assert.equal(checkApproval(dataDir, id, 'like', { consume: true, now: at + 2 }).usesLeft, 1);
  assert.equal(checkApproval(dataDir, id, 'like', { consume: true, now: at + 3 }).approved, true);
  assert.equal(checkApproval(dataDir, id, 'like', { now: at + 4 }).approved, false);
  grantApproval(dataDir, id, 'like', { uses: 1, ttlMs: 60_000, now: at });
  assert.equal(checkApproval(dataDir, id, 'like', { now: at + 61_000 }).approved, false);
  const status = grantsStatus(dataDir, id, { approvals: [{ action: 'like' }], quotas: { like: 5 }, now: at + 62_000 });
  assert.deepEqual(status.approvals, {});
});

test('配额：按天累计、超限拒绝、未声明动作拒绝', () => {
  const id = 'quota-me';
  const at = new Date('2026-10-23T10:00:00').getTime();
  assert.equal(consumeQuota(dataDir, id, 'like', 0, { now: at }).ok, false);
  for (let i = 0; i < 2; i += 1) {
    assert.equal(consumeQuota(dataDir, id, 'like', 2, { now: at + i }).ok, true);
  }
  const blocked = consumeQuota(dataDir, id, 'like', 2, { now: at + 10 });
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /配额已用完/);
  // 第二天归零
  assert.equal(consumeQuota(dataDir, id, 'like', 2, { now: at + 24 * 3600_000 }).ok, true);
  const status = grantsStatus(dataDir, id, { quotas: { like: 2 }, now: at + 24 * 3600_000 });
  assert.deepEqual(status.quota.like, { used: 1, limit: 2 });
});

test('能力：未声明的动作/配额/域名一律拒绝，媒体文件名不能越界', async () => {
  const manifest = parse(v2()).manifest;
  const cap = createCapabilities({
    pluginId: 'demo2', dataDir, manifest, log: () => {}, now: () => Date.now(),
    getSettings: () => ({})
  });
  assert.throws(() => cap.methods[CAP_METHODS.approvalCheck]({ action: 'delete-all' }), /没有在 manifest.approvals/);
  assert.throws(() => cap.methods[CAP_METHODS.quotaConsume]({ action: 'dance' }), /没有在 manifest.quotas/);
  await assert.rejects(cap.methods[CAP_METHODS.httpRequest]({ url: 'https://evil.example.net/x' }), /白名单/);

  const secrets = cap.methods[CAP_METHODS.secretsGet]();
  assert.deepEqual(secrets.configured, []);
  cap.methods[CAP_METHODS.secretsSet]({ values: { sessdata: 'abc' } });
  assert.equal(cap.methods[CAP_METHODS.secretsGet]().values.sessdata, 'abc');

  const granted = cap.methods[CAP_METHODS.approvalCheck]({ action: 'like', consume: false });
  assert.equal(granted.approved, false);
  grantApproval(dataDir, 'demo2', 'like', { uses: 1 });
  assert.equal(cap.methods[CAP_METHODS.approvalCheck]({ action: 'like' }).approved, true);
  assert.equal(cap.methods[CAP_METHODS.quotaConsume]({ action: 'like' }).ok, true);

  await assert.rejects(cap.methods[CAP_METHODS.mediaProbe]({ file: '../storage.json' }), /必须是 download|越界|找不到/);
  await assert.rejects(cap.methods[CAP_METHODS.sendFile]({ chatKey: 'private:1', file: 'x.mp4' }), /只支持群聊/);
});

test('兼容：v1 插件带着 v2 字段（settings 等）仍然能加载，但拿不到 v2 能力', () => {
  const result = parse({
    id: 'legacy-settings',
    apiVersion: 1,
    name: '老插件',
    version: '1.0.0',
    capabilities: ['tools', 'http'],
    settings: { groups: [{ key: 'a', title: 'A', fields: [{ key: 'x', label: 'X', type: 'text' }] }] },
    approvals: [{ action: 'like', label: '点赞' }],
    quotas: { like: 5 },
    httpDomains: ['api.example.com']
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.manifest.settings, null, 'v1 的 settings 被忽略');
  assert.deepEqual(result.manifest.approvals, []);
  assert.deepEqual(result.manifest.quotas, {});
  assert.deepEqual(result.manifest.httpDomains, []);
});

test('工具级超时：manifest.timeoutMs 生效并夹在 1s-300s，注册表优先读它', () => {
  const base = v2({ tools: [{ name: 'slow_tool', description: '慢工具', parameters: { type: 'object' }, timeoutMs: 240000 }] });
  const ok = parse(base);
  assert.ok(ok.ok, ok.error);
  assert.equal(ok.manifest.tools[0].timeoutMs, 240000);
  // 越界按边界夹住，不拒载：超时是性能参数，不是安全参数
  const tooBig = parse(v2({ tools: [{ name: 'slow_tool', description: 'x', parameters: { type: 'object' }, timeoutMs: 999999 }] }));
  assert.equal(tooBig.manifest.tools[0].timeoutMs, 300000);
  const tooSmall = parse(v2({ tools: [{ name: 'slow_tool', description: 'x', parameters: { type: 'object' }, timeoutMs: 10 }] }));
  assert.equal(tooSmall.manifest.tools[0].timeoutMs, 1000);
  // 注册表必须优先用工具级超时（锚点：媒体工具不该被全局 20s 一刀切）
  const registrySource = fs.readFileSync(path.join(process.cwd(), 'src', 'plugins', 'registry.js'), 'utf8');
  assert.match(registrySource, /tool\.timeoutMs/, '注册表要读 manifest 的工具级超时');
});

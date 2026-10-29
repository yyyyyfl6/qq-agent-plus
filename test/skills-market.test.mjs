import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-skills-market-'));
process.env.QQ_AGENT_DATA_DIR = path.join(root, 'data');

const skillJson = JSON.stringify({
  id: 'trip-planner',
  name: '出行规划',
  version: '1.0.0',
  description: '测试用技能',
  allowedTools: ['web_search', 'send_message'],
  triggers: ['规划行程']
}, null, 2);
const skillMd = '# 出行规划\n\n先问日期，再给方案。\n';
const files = { 'skill.json': skillJson, 'SKILL.md': skillMd };
const hashes = Object.fromEntries(Object.entries(files).map(([name, text]) => [name, crypto.createHash('sha256').update(text).digest('hex')]));

let server;
let port;
let indexUrl;
let market;
let configModule;
let registryModule;

function indexPayload({ shaOverride = '', id = 'trip-planner', extraFiles = {}, description = '测试用技能' } = {}) {
  return {
    version: 1,
    name: '测试索引',
    updatedAt: '2026-10-26',
    skills: [{
      id,
      name: '出行规划',
      description,
      version: '1.0.0',
      preview: '先问日期，再给方案。',
      author: 'tester',
      category: '生活',
      homepage: 'https://example.com/skill',
      allowedTools: ['web_search', 'send_message'],
      triggers: ['规划行程'],
      files: {
        'skill.json': { path: '/files/skill.json', sha256: shaOverride || hashes['skill.json'], bytes: Buffer.byteLength(skillJson) },
        ...extraFiles,
        'SKILL.md': { path: '/files/SKILL.md', sha256: hashes['SKILL.md'], bytes: Buffer.byteLength(skillMd) }
      }
    }]
  };
}

let currentIndex = indexPayload();
let fileRequests = 0;
let indexRequests = 0;

before(async () => {
  configModule = await import('../src/core/config.js');
  registryModule = await import('../src/skills/registry.js');
  market = await import('../src/skills/market.js');
  server = http.createServer((req, res) => {
    if (req.url === '/index.json' || req.url.startsWith('/index.json?')) {
      indexRequests += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(currentIndex));
      return;
    }
    const name = decodeURIComponent(String(req.url || '').replace('/files/', ''));
    if (files[name]) {
      fileRequests += 1;
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(files[name]);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  indexUrl = `http://127.0.0.1:${port}/index.json`;
  configModule.updateConfig({
    ...structuredClone(configModule.DEFAULT_CONFIG),
    skills: { ...structuredClone(configModule.DEFAULT_CONFIG.skills), enabled: true, indexUrl, allowPrivateIndex: true }
  });
  registryModule.resetSkillRegistryForTests();
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

test('market lists, previews, installs and uninstalls a user skill', async () => {
  registryModule.resetSkillRegistryForTests();
  const listed = await market.listMarketSkills({ force: true });
  const entry = listed.skills.find((item) => item.id === 'trip-planner');
  assert.equal(entry.installed, false);
  assert.equal(entry.sha256.length, 64);

  const requestsBefore = fileRequests;
  const preview = await market.previewMarketSkill('trip-planner');
  assert.equal(preview.previewOnly, true);
  assert.match(preview.instructions, /先问日期/);
  assert.equal(fileRequests, requestsBefore, '查看摘要不应该下载技能文件');
  const full = await market.previewMarketSkill('trip-planner', { full: true });
  assert.equal(full.previewOnly, false);
  assert.match(full.instructions, /# 出行规划/);
  assert.equal(fileRequests > requestsBefore, true, '加载完整说明才下载文件');

  await assert.rejects(() => market.installMarketSkill({ id: 'trip-planner' }), /确认/);
  await assert.rejects(() => market.installMarketSkill({ id: 'trip-planner', confirm: true, expectedSha256: '0'.repeat(64) }), /已变化/);

  const installed = await market.installMarketSkill({ id: 'trip-planner', confirm: true, expectedSha256: entry.sha256 });
  assert.equal(installed.ok, true);
  assert.equal(installed.skill.source, 'user');
  assert.equal(fs.existsSync(path.join(root, 'data', 'skills', 'trip-planner', 'SKILL.md')), true);
  assert.equal(registryModule.getSkillRegistry().get('trip-planner')?.source, 'user');

  const afterList = await market.listMarketSkills();
  assert.equal(afterList.skills.find((item) => item.id === 'trip-planner').installed, true);

  await assert.rejects(() => market.uninstallMarketSkill({ id: 'trip-planner' }), /确认/);
  const removed = await market.uninstallMarketSkill({ id: 'trip-planner', confirm: true });
  assert.equal(removed.ok, true);
  assert.equal(fs.existsSync(path.join(root, 'data', 'skills', 'trip-planner')), false);
  assert.equal(registryModule.getSkillRegistry().get('trip-planner'), null);
});

test('hash mismatch is rejected before writing anything', async () => {
  registryModule.resetSkillRegistryForTests();
  currentIndex = indexPayload({ shaOverride: 'f'.repeat(64) });
  market.resetMarketCacheForTests();
  await assert.rejects(() => market.installMarketSkill({ id: 'trip-planner', confirm: true }), /哈希不匹配/);
  assert.equal(fs.existsSync(path.join(root, 'data', 'skills', 'trip-planner')), false);
  currentIndex = indexPayload();
});

test('builtin skills cannot be replaced from the market', async () => {
  registryModule.resetSkillRegistryForTests();
  currentIndex = indexPayload({ id: 'chat-summary' });
  market.resetMarketCacheForTests();
  await assert.rejects(() => market.installMarketSkill({ id: 'chat-summary', confirm: true }), /内置技能/);
  currentIndex = indexPayload();
});

test('private index is refused unless explicitly allowed', async () => {
  registryModule.resetSkillRegistryForTests();
  configModule.updateConfig({ skills: { allowPrivateIndex: false, indexUrl: `${indexUrl}?private=1` } });
  market.resetMarketCacheForTests();
  await assert.rejects(() => market.listMarketSkills({ force: true }), /读取技能索引失败|内网|私有/);
  configModule.updateConfig({ skills: { allowPrivateIndex: true, indexUrl } });
});

test('过期缓存先返回旧索引，同时后台刷新', async () => {
  registryModule.resetSkillRegistryForTests();
  await market.listMarketSkills({ force: true });
  const cachePath = path.join(root, 'data', 'skills', '.market-cache.json');
  const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  market.resetMarketCacheForTests();
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify({ ...cached, at: Date.now() - 31 * 60 * 1000 }));

  currentIndex = indexPayload({ description: '后台刷新后的描述' });
  const started = Date.now();
  const stale = await market.listMarketSkills();
  assert.equal(stale.index.stale, true, '过期缓存要先按 stale 返回');
  assert.equal(stale.skills[0].description, '测试用技能', '先返回旧数据');
  assert.ok(Date.now() - started < 1000, '不应为了刷新索引卡住页面');

  let fresh = null;
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    fresh = await market.listMarketSkills();
    if (fresh.index.stale === false) break;
  }
  assert.equal(fresh?.index.stale, false, '后台刷新完成后应回到 fresh');
  assert.equal(fresh.skills[0].description, '后台刷新后的描述');
  currentIndex = indexPayload();
  market.resetMarketCacheForTests();
});

test('冷启动预热与首次打开共用同一次索引请求', async () => {
  market.resetMarketCacheForTests();
  indexRequests = 0;
  const warm = market.warmMarketIndex();
  const listed = await market.listMarketSkills();
  await warm;
  assert.equal(indexRequests, 1, '并发冷启动不应重复下载索引');
  assert.equal(listed.skills[0].id, 'trip-planner');
  market.resetMarketCacheForTests();
});

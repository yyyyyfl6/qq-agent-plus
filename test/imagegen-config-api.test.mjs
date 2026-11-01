// 图片生成的配置接口（2026-09-30 审查回归）：
//  - GET /api/config 下发的 imageGen.available / hasApiKey 是"给界面看的派生结论"，
//    前端会把整段 imageGen 展开回传（...g），不剥掉就会写进 config.json；
//    之后真实 Key 被清掉、文件里的 hasApiKey:true 还会冒充"已存过 Key"（探针复现）。
//  - 「显示」按钮曾是个死按钮：控件在（cfg-img-reveal-key-btn），却没有任何绑定，
//    也没有可取的端点 —— 这里钉住 /api/imagegen/key 的存在与守卫。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-imagegen-config-api-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { DEFAULT_CONFIG, updateConfig, getConfig } = await import('../src/core/config.js');
const { createApp } = await import('../src/console/app.js');

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function boot(t, mutate) {
  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
  cfg.runtime.mode = 'active';
  cfg.onebot.wsUrl = 'ws://127.0.0.1:1';
  cfg.onebot.httpUrl = 'http://127.0.0.1:1';
  cfg.api = { ...cfg.api, baseUrl: 'https://gateway.example.com/v1', apiKey: 'model-key', model: 'm' };
  cfg.imageGen = { ...cfg.imageGen, enabled: true, model: 'gpt-image-1', baseUrl: '' };
  mutate?.(cfg);
  updateConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(async () => {
    await app.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await app.start();
  const request = async (route, { method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
  return { request, disk: () => JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')) };
}

test('GET 下发 imageGen 的派生结论（available/hasApiKey），供界面提示用', async (t) => {
  const { request } = await boot(t, (cfg) => { cfg.imageGen = { ...cfg.imageGen, apiKey: 'img-key' }; });
  const got = await request('/api/config');
  assert.equal(got.status, 200);
  assert.equal(got.body.imageGen?.available, true, '配齐了要报"能画"');
  assert.equal(got.body.imageGen?.hasApiKey, true, '存过 Key 要有派生标志供界面显示');
  assert.equal(got.body.imageGen?.apiKey, undefined, '绝不下发明文 Key');
});

test('前端整段展开回传 imageGen（...g）：派生结论不落盘，真实 Key 也不被掩码冲掉', async (t) => {
  const { request, disk } = await boot(t, (cfg) => { cfg.imageGen = { ...cfg.imageGen, apiKey: 'img-key' }; });

  // 前端保存就是这样：拿上次 GET 的 imageGen（含 hasApiKey/available）整段展开回去
  const safe = (await request('/api/config')).body;
  assert.equal(safe.imageGen?.available, true);
  const saved = await request('/api/config', {
    method: 'POST',
    body: { imageGen: { ...safe.imageGen, enabled: true } }
  });
  assert.equal(saved.status, 200);

  // ① 响应里的派生结论是**当场重算**的（GET/POST 走同一个脱敏器），不是照抄回传值
  assert.equal(saved.body.config?.imageGen?.available, true, '响应要按当前状态重算 available');
  assert.equal(saved.body.config?.imageGen?.hasApiKey, true, '响应要按当前状态重算 hasApiKey');
  // ② 落盘必须干净：派生结论不写进 config.json（旧结论会冒充当前状态）
  const onDisk = disk();
  assert.equal(onDisk.imageGen?.hasApiKey, undefined, 'config.json 不该留着 hasApiKey（旧结论会冒充当前状态）');
  assert.equal(onDisk.imageGen?.available, undefined, 'config.json 不该留着 available');
  // ③ 真 Key 仍在（展开回传没把它冲掉）
  assert.equal(getConfig().imageGen?.apiKey, 'img-key', '整段展开回传不该冲掉已存的 Key');

  // ④ 掩码回传 = 保持原值；新值 = 替换
  await request('/api/config', { method: 'POST', body: { imageGen: { ...safe.imageGen, apiKey: '******' } } });
  assert.equal(getConfig().imageGen?.apiKey, 'img-key', '掩码不该把真 Key 冲成 ******');
  await request('/api/config', { method: 'POST', body: { imageGen: { ...safe.imageGen, apiKey: 'new-key' } } });
  assert.equal(getConfig().imageGen?.apiKey, 'new-key', '新填的 Key 要生效');
});

test('从磁盘读回被污染的配置：残留的派生结论在载入时被清掉，不再冒充当前状态', async (t) => {
  // 模拟"上个版本留下的脏文件"：Key 已被清掉，但 hasApiKey/available 还在
  const { request } = await boot(t, (cfg) => { cfg.imageGen = { ...cfg.imageGen, apiKey: '' }; });
  const file = path.join(root, 'config.json');
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  disk.imageGen = { ...disk.imageGen, hasApiKey: true, available: true };
  fs.writeFileSync(file, JSON.stringify(disk, null, 2));
  // 载入会走 migrateConfig：把这两枚派生结论剔掉，之后 GET 重新算 → 不能画
  const { getConfig: fresh } = await import('../src/core/config.js');
  assert.equal(fresh().imageGen?.hasApiKey, undefined, '载入时就要清掉残留的 hasApiKey');
  assert.equal(fresh().imageGen?.available, undefined, '载入时就要清掉残留的 available');
  // GET 重新判定的结论才是真的（Key 没了 → 不再说"已存过"）
  const got = await request('/api/config');
  assert.equal(got.body.imageGen?.hasApiKey, false, 'Key 没了就不能再说"已存过 Key"');
});

test('imageGen.extraBody：自定义参数能落盘，清空用 __replace__ 真删键', async (t) => {
  const { request, disk } = await boot(t);
  const saved = await request('/api/config', {
    method: 'POST',
    body: { imageGen: { extraBody: { __replace__: { output_watermark: false } } } }
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(getConfig().imageGen?.extraBody, { output_watermark: false });
  assert.deepEqual(disk().imageGen?.extraBody, { output_watermark: false });

  await request('/api/config', { method: 'POST', body: { imageGen: { extraBody: { __replace__: {} } } } });
  assert.deepEqual(getConfig().imageGen?.extraBody, {}, '清空后不能留下旧参数');
});

test('imageGen.extraBody 的脱敏占位不会覆盖真值', async (t) => {
  const secret = { scheme: 'Bearer', value: 'sk-imagegen-secret' };
  const { request } = await boot(t, (cfg) => {
    cfg.imageGen = { ...cfg.imageGen, extraBody: { normal: 'ok', authorization: secret } };
  });
  const view = (await request('/api/config')).body.imageGen.extraBody;
  assert.equal(view.normal, 'ok');
  assert.equal(view.authorization, undefined, '视图里不能出现明文');
  assert.equal(view.hasAuthorization, true, '脱敏后应留下占位');

  // 原样回传 = 没动过：不能把 hasAuthorization 落盘
  await request('/api/config', { method: 'POST', body: { imageGen: { extraBody: { __replace__: { ...view } } } } });
  assert.deepEqual(getConfig().imageGen.extraBody, { normal: 'ok', authorization: secret });
  assert.equal('hasAuthorization' in getConfig().imageGen.extraBody, false);

  // 改了别的字段：真值要回填，新字段也要生效
  await request('/api/config', {
    method: 'POST',
    body: { imageGen: { extraBody: { __replace__: { ...view, output_watermark: false } } } }
  });
  assert.deepEqual(getConfig().imageGen.extraBody, {
    normal: 'ok',
    authorization: secret,
    output_watermark: false
  });
});

test('「显示」按钮的端点：回环请求能取回明文 Key；不可信来源被拒', async (t) => {
  const { request } = await boot(t, (cfg) => { cfg.imageGen = { ...cfg.imageGen, apiKey: 'img-secret' }; });
  // 本机控制台：能取回（与 /api/tts/key 同一道守卫）
  const ok = await request('/api/imagegen/key');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.apiKey, 'img-secret');
  // 跨站来源：被拒（不能把明文 Key 交给别处）
  const evil = await request('/api/imagegen/key', { headers: { origin: 'http://evil.example.com' } });
  assert.notEqual(evil.status, 200, '跨站来源不该拿到明文 Key');
  assert.equal(evil.body?.apiKey, undefined);
});

test('imageGen.sendAs：默认 sticker，可保存 image，非法值回落 sticker', async (t) => {
  const { request } = await boot(t);
  const initial = await request('/api/config');
  assert.equal(initial.body.imageGen.sendAs, 'sticker', '默认保持旧行为（表情）');

  const saved = await request('/api/config', { method: 'POST', body: { imageGen: { sendAs: 'image' } } });
  assert.equal(saved.status, 200);
  assert.equal(getConfig().imageGen.sendAs, 'image');

  await request('/api/config', { method: 'POST', body: { imageGen: { sendAs: 'bogus' } } });
  assert.equal(getConfig().imageGen.sendAs, 'sticker', '非法值不能落盘成第三种状态');
});

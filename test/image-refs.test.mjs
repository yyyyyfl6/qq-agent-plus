// 生图参考图（image-refs）：按触发词命中、body / edits 两种传图形状。
// （原先同文件里的内置「陪伴」已移出宿主，改为独立插件：yyyyyfl6/astrbot_plugin_private_companion 的 qq-agent/）
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-imgref-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  runtime: { mode: 'active' },
  admin: { ownerUin: '10001' },
  allow: { private: ['10001'] },
  api: { baseUrl: 'https://gateway.example.com/v1', apiKey: 'model-key', model: 'm' }
}));

const { updateConfig } = await import('../src/core/config.js');
const refs = await import('../src/extensions/image-refs.js');
const { generateImage } = await import('../src/llm/image-gen.js');

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `qq-comp-${name}-`));

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4050000000049454e44ae426082', 'hex');

test('参考图：新增、关键词命中、自动选传图方式', () => {
  updateConfig({ imageRefs: { enabled: true, mode: 'auto', items: [] } });
  const store = new refs.ImageRefs({ dataDir: tmp('refs') });
  assert.equal(refs.getImageRefs(), store);
  const item = store.add({ label: '我的形象', keywords: '你自己，你长什么样', hint: '银发蓝眼', image: `data:image/png;base64,${PNG.toString('base64')}` });
  assert.deepEqual(item.keywords, ['你自己', '你长什么样']);
  assert.equal(store.resolve({ userText: '阿明: 画一张你自己在海边' , model: 'seedream-4.0' }).mode, 'body');
  assert.equal(store.resolve({ userText: '画一下你自己', model: 'gpt-image-1' }).mode, 'edits');
  assert.equal(store.resolve({ userText: '画只猫' }), null);
  assert.throws(() => store.add({ label: 'x', keywords: ['a'], image: Buffer.from('not image').toString('base64') }), /PNG/);
  store.update(item.id, { enabled: false });
  assert.equal(store.resolve({ userText: '画你自己' }), null);
  assert.equal(store.remove(item.id), true);
});

test('生图请求：body 模式带 data:URL，edits 模式走 multipart', async () => {
  const seen = [];
  const fetchFn = async (url, init) => {
    seen.push({ url, init });
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, body: null,
      text: async () => JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }) };
  };
  const cfg = { imageGen: { enabled: true, baseUrl: 'https://img.example.com/v1', apiKey: 'k', apiKeyHost: 'img.example.com', model: 'seedream-4.0' } };
  const reference = { buffer: PNG, mime: 'image/png', mode: 'body', field: 'image', hint: '银发' };
  await generateImage({ cfg, apiCfg: {}, prompt: '画你自己', fetchFn, reference }).catch((e) => { if (!/读取|body/.test(e.message)) throw e; });
  assert.ok(seen[0].url.endsWith('/images/generations'));
  const sentBody = JSON.parse(seen[0].init.body);
  assert.match(sentBody.image, /^data:image\/png;base64,/);
  assert.match(sentBody.prompt, /参考所给图片.*银发/);
  await generateImage({ cfg, apiCfg: {}, prompt: '画你自己', fetchFn, reference: { ...reference, mode: 'edits' } }).catch((e) => { if (!/读取|body/.test(e.message)) throw e; });
  assert.ok(seen[1].url.endsWith('/images/edits'));
  assert.ok(seen[1].init.body instanceof FormData);
  assert.ok(seen[1].init.body.get('image') instanceof Blob);
});

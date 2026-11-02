// 人格设定图（src/extensions/persona-refs.js）：每个人格一张"自己"的设定图，画它自己时交给生图模型。
// 钉住：按人格存取；多人格时跟着**本轮的人格**走（A 的脸不会拿去画 B）、单人格用 default；
// self:true / 对方原话"你自己 / 自拍…" / 画面描述里有它的名字 → 带图，画别的不带；点名的参考图优先；
// generate_image 端到端：请求体里真的带了这张图与外貌要点。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-personaref-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄 */ } });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
// 一张最小 JPEG 头（只要魔数对：设定图用它区分两个人格）
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);

fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  runtime: { mode: 'active' },
  allow: { private: ['1'] },
  api: { baseUrl: 'https://gateway.example.com/v1', apiKey: 'model-key', model: 'm' },
  persona: { botName: '小鲸鱼' },
  sticker: { enabled: true },
  imageGen: { enabled: true, model: 'seedream-4.0', baseUrl: '', maxPerHour: 50 },
  skins: {
    enabled: true, default: 'fish',
    list: [
      { id: 'fish', label: '蓝色大肥鱼', templateId: 'blue_fish', botName: '蓝色大肥鱼' },
      { id: 'cat', label: '哈基米', templateId: 'hajimi', botName: '哈基米' }
    ]
  }
}));

const { updateConfig, getConfig } = await import('../src/core/config.js');
const { PersonaRefs, activePersonaKey, wantsSelf, getPersonaRefs } = await import('../src/extensions/persona-refs.js');
const { resolveSkinConfig } = await import('../src/skins/skins.js');
const { withSkinScope } = await import('../src/skins/context.js');
const { buildToolDefs, resetImageQuotaForTest } = await import('../src/tools/tools-core.js');
const { StickerManager } = await import('../src/onebot/sticker-manager.js');

const inSkin = (skinId, fn) => withSkinScope({ chatKey: 'private:1', skinId, resolveConfig: (base) => resolveSkinConfig(base, skinId) }, fn);
const dataUrl = (buf, mime) => `data:${mime};base64,${buf.toString('base64')}`;

test('存取：按人格 id 存，校验格式与 id；只改说明不换图', () => {
  const refs = new PersonaRefs({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'qq-pr-')) });
  assert.equal(refs.get('fish'), null);
  refs.set('fish', { image: dataUrl(PNG, 'image/png'), hint: '蓝色圆滚滚的鱼' });
  assert.equal(refs.load('fish').mime, 'image/png');
  assert.equal(refs.load('fish').hint, '蓝色圆滚滚的鱼');
  refs.set('fish', { hint: '改了说明' });
  assert.equal(refs.load('fish').buffer.length, PNG.length, '只改说明时图不动');
  refs.set('fish', { image: dataUrl(JPG, 'image/jpeg') });
  assert.equal(refs.load('fish').mime, 'image/jpeg', '换成 JPEG 后旧 PNG 删掉、记新扩展名');
  assert.equal(refs.get('fish').hint, '改了说明', '只换图时说明保留');
  assert.throws(() => refs.set('../x', { image: dataUrl(PNG, 'image/png') }), /id/);
  assert.throws(() => refs.set('cat', { image: Buffer.from('not an image').toString('base64') }), /PNG/);
  assert.throws(() => refs.set('cat', { hint: 'x' }), /先上传/);
  assert.equal(refs.remove('fish'), true);
  assert.equal(refs.load('fish'), null);
});

test('当前人格：多人格开着跟本轮人格走；没开用 default', () => {
  assert.equal(inSkin('cat', () => activePersonaKey(getConfig())), 'cat');
  assert.equal(inSkin('fish', () => activePersonaKey(getConfig())), 'fish');
  assert.equal(activePersonaKey({ ...getConfig({ unscoped: true }), skins: { enabled: false } }), 'default');
  assert.equal(activePersonaKey(getConfig({ unscoped: true })), 'fish', '开着但不在任何会话里：默认人格');
});

test('画不画自己：self 显式优先；对方原话的说法兜底；画面描述里有名字也算', () => {
  assert.equal(wantsSelf({ self: true }), true);
  assert.equal(wantsSelf({ self: false, userText: '画一张你自己' }), false);
  assert.equal(wantsSelf({ userText: '来张自拍' }), true);
  assert.equal(wantsSelf({ userText: '你长什么样啊' }), true);
  assert.equal(wantsSelf({ userText: '画只猫', prompt: '一只橘猫' }), false);
  assert.equal(wantsSelf({ prompt: '哈基米在海边晒太阳', botName: '哈基米' }), true);
  assert.equal(wantsSelf({ userText: '你和我说说' }), false, '"你和我"这种日常说法不算');
});

function context() {
  const manager = new StickerManager({});
  return {
    kind: 'private', chatId: '1', chatKey: 'private:1',
    session: { id: 's', leaseId: 'l', sent: [], feedbacks: [], triggerText: '' },
    sender: { sendSticker: async () => ({ message_id: 1 }), sendImage: async () => ({ message_id: 2 }) },
    stickers: manager, store: { activeMembers: () => [], recent: () => [], findByMid: () => null }, onebot: {}, emit: () => {}
  };
}

test('generate_image 端到端：画自己带的是**当前人格**的设定图与外貌要点；画别的不带', async () => {
  const refs = new PersonaRefs({ dataDir });
  assert.equal(getPersonaRefs(), refs);
  refs.set('fish', { image: dataUrl(PNG, 'image/png'), hint: '蓝色圆滚滚的鱼' });
  refs.set('cat', { image: dataUrl(JPG, 'image/jpeg'), hint: '橘白相间的猫，戴铃铛' });
  updateConfig({ imageRefs: { enabled: false, mode: 'body', items: [] } });
  const tool = buildToolDefs().find((t) => t.name === 'generate_image');
  assert.ok(tool.parameters.properties.self, '工具参数里有 self');
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, req) => {
    calls.push({ url: String(url), body: JSON.parse(req.body || '{}') });
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }) };
  };
  try {
    resetImageQuotaForTest();
    const r1 = await inSkin('cat', () => tool.execute(context(), { prompt: '在窗台上打哈欠', self: true }));
    assert.equal(r1.isError, undefined, r1.content);
    assert.match(calls[0].body.image, /^data:image\/jpeg;base64,/, '哈基米用自己的设定图（JPEG）');
    assert.match(calls[0].body.prompt, /橘白相间的猫/);
    assert.match(JSON.parse(r1.content).reference, /人格设定图/);

    const r2 = await inSkin('fish', () => { const ctx = context(); ctx.session.triggerText = '来张自拍'; return tool.execute(ctx, { prompt: '在海边' }); });
    assert.equal(r2.isError, undefined, r2.content);
    assert.match(calls[1].body.image, /^data:image\/png;base64,/, '切到大肥鱼就换成大肥鱼的图（没传 self 靠原话兜底）');
    assert.match(calls[1].body.prompt, /蓝色圆滚滚的鱼/);

    await inSkin('fish', () => tool.execute(context(), { prompt: '一碗拉面' }));
    assert.equal(calls[2].body.image, undefined, '画别的不带设定图');
    assert.equal(calls[2].body.prompt, '一碗拉面');

    // 多人格：这个人格没传设定图时，不拿通用参考图（别人的脸）去画它；点名的照用
    const { ImageRefs } = await import('../src/extensions/image-refs.js');
    updateConfig({ imageRefs: { enabled: true, mode: 'body', items: [] } });
    const generic = new ImageRefs({ dataDir });
    generic.add({ label: '老形象', keywords: '你自己,自拍', image: dataUrl(PNG, 'image/png') });
    refs.remove('cat');
    await inSkin('cat', () => { const ctx = context(); ctx.session.triggerText = '来张自拍'; return tool.execute(ctx, { prompt: '自拍' }); });
    assert.equal(calls.at(-1).body.image, undefined, '猫没有设定图：不套通用参考图');
    await inSkin('cat', () => tool.execute(context(), { prompt: '自拍', reference: '老形象' }));
    assert.match(calls.at(-1).body.image, /^data:image\/png/, '点名的参考图照用');
    updateConfig({ imageRefs: { enabled: false, mode: 'body', items: [] } });
    calls.length = 3;

    // 多人格关掉：用 default 那张；没传过 default 就不带
    updateConfig({ skins: { ...getConfig({ unscoped: true }).skins, enabled: false } });
    await tool.execute(context(), { prompt: '自画像', self: true });
    assert.equal(calls[3].body.image, undefined, '单人格还没有设定图');
    refs.set('default', { image: dataUrl(PNG, 'image/png'), hint: '小鲸鱼' });
    await tool.execute(context(), { prompt: '小鲸鱼在跳舞' });
    assert.match(calls[4].body.image, /^data:image\/png/, '画面描述里出现了自己的名字');
  } finally {
    globalThis.fetch = realFetch;
  }
});

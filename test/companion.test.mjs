// 陪伴（companion）与生图参考图（image-refs）。
// 钉住：私聊按日期记日记并注入上下文、日记检索、免打扰 / 上限 / "没回就不追"、先记账再唤醒；
// 参考图按触发词命中、body / edits 两种传图形状。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-comp-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  runtime: { mode: 'active' },
  admin: { ownerUin: '10001' },
  allow: { private: ['10001'] },
  api: { baseUrl: 'https://gateway.example.com/v1', apiKey: 'model-key', model: 'm' }
}));

const { updateConfig } = await import('../src/core/config.js');
const comp = await import('../src/extensions/companion.js');
const refs = await import('../src/extensions/image-refs.js');
const { generateImage } = await import('../src/llm/image-gen.js');
const { ExtensionCommands } = await import('../src/extensions/commands.js');

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `qq-comp-${name}-`));
// 北京时间 2026-11-01 某时刻
const at = (hm, date = '2026-11-01') => Date.parse(`${date}T${hm}:00+08:00`);

function fakeStore(rows) {
  return {
    listChats: () => [...new Set(rows.map((r) => r.chatKey))],
    recent: (chatKey, { limit = 80 } = {}) => rows.filter((r) => r.chatKey === chatKey).slice(-limit)
  };
}

function chatRows(chatKey, date, count, startHm = '10:00') {
  const base = at(startHm, date);
  return Array.from({ length: count }, (_, i) => ({
    chatKey, id: i + 1, ts: base + i * 60_000, self: i % 3 === 2, senderId: '10001', senderName: '阿明', text: `第${i}句：周五要面试了好紧张`
  }));
}

test('免打扰跨零点、时间换算', () => {
  const c = comp.companionConfig({ companion: { quietStart: '23:30', quietEnd: '08:00' } });
  assert.equal(comp.inQuietHours(c, at('23:45')), true);
  assert.equal(comp.inQuietHours(c, at('03:00')), true);
  assert.equal(comp.inQuietHours(c, at('08:01')), false);
  assert.equal(comp.shanghaiMinutes(at('12:34')), 12 * 60 + 34);
});

test('配置归一：时间、日期、强度', () => {
  const c = comp.companionConfig({ companion: { quietStart: '25:00', intensity: 'xx', dates: [{ md: '5-20', label: '纪念日' }, { md: '13-01', label: 'x' }], targets: ['abc123'] } });
  assert.equal(c.quietStart, '23:30');
  assert.equal(c.intensity, 'normal');
  assert.deepEqual(c.dates, [{ md: '05-20', label: '纪念日', uin: '' }]);
  assert.deepEqual(c.targets, ['123']);
});

test('写日记、注入最近几天、按日期 / 关键词检索', async () => {
  updateConfig({ companion: { enabled: true, diaryEnabled: true, diaryScope: 'all', diaryInjectDays: 3, scheduleEnabled: false } });
  const chatKey = 'private:10001';
  const store = fakeStore([...chatRows(chatKey, '2026-10-31', 12)]);
  let now = at('09:00');
  const calls = [];
  const rt = new comp.CompanionRuntime({
    dataDir: tmp('diary'), store, now: () => now,
    complete: async (req) => {
      calls.push(req);
      return { message: { content: '```json\n{"summary":"阿明说周五要面试，有点紧张。","events":["周五面试"],"mood":"紧张","followups":["周五面试 → 之后问问结果"]}\n```' } };
    }
  });
  const entry = await rt.writeDiary(chatKey, '2026-10-31');
  assert.equal(entry.summary, '阿明说周五要面试，有点紧张。');
  assert.deepEqual(entry.followups, ['周五面试 → 之后问问结果']);
  assert.equal(entry.partial, false);
  assert.match(calls[0].messages[1].content, /日期：2026-10-31/);
  const prompt = rt.promptText(chatKey);
  assert.match(prompt, /私聊日记/);
  assert.match(prompt, /10-31：阿明说周五要面试/);
  assert.match(prompt, /待跟进：周五面试/);
  assert.equal(rt.searchDiary(chatKey, { date: '10-31' }).length, 1);
  assert.equal(rt.searchDiary(chatKey, { keyword: '面试' }).length, 1);
  assert.equal(rt.searchDiary(chatKey, { keyword: '旅游' }).length, 0);
  // 群聊不进日记
  assert.equal(rt.diaryInScope('group:1'), false);
  // 落盘后新实例能读回
  const again = new comp.CompanionRuntime({ dataDir: rt.dir.replace(/companion$/, ''), store, now: () => now });
  assert.equal(again.diaryOf(chatKey).length, 1);
  // 消息太少不写（非 force）
  await assert.rejects(rt.writeDiary(chatKey, '2026-10-30'), /太少/);
  now = at('10:00');
});

test('主动判定：早安 → 已主动后不追；免打扰；上限', async () => {
  updateConfig({ companion: { enabled: true, proactiveEnabled: true, intensity: 'normal', quietStart: '23:30', quietEnd: '08:00', morning: true, meals: true, followups: true, idle: true, targets: [], dates: [] } });
  const chatKey = 'private:10001';
  const rows = chatRows(chatKey, '2026-10-31', 4, '20:00');
  const store = fakeStore(rows);
  let now = at('08:30');
  const woke = [];
  const rt = new comp.CompanionRuntime({ dataDir: tmp('pro'), store, now: () => now, random: () => 0, wake: async (key, opts) => { woke.push([key, opts]); }, complete: async () => ({ message: { content: '{}' } }) });
  const ev = rt.evaluate(chatKey);
  assert.equal(ev.kind, 'morning');
  await rt.fire(chatKey, ev);
  assert.equal(woke.length, 1);
  assert.equal(woke[0][1].proactive, true);
  assert.match(woke[0][1].wakeNote, /^【系统提醒】（陪伴·早安）/);
  // 对方还没回：不再追
  now = at('13:00');
  assert.match(rt.evaluate(chatKey).blocked, /还没回/);
  // 对方回了之后，过了间隔才有下一条（午饭窗口 11:40~13:00 已过 → 晚饭）
  rows.push({ chatKey, id: 99, ts: at('09:00'), self: false, senderId: '10001', text: '早' });
  now = at('18:00');
  assert.equal(rt.evaluate(chatKey).kind, 'dinner');
  now = at('23:50');
  assert.match(rt.evaluate(chatKey).blocked, /免打扰/);
});

test('重要日子优先；只对指定 QQ 的日子不串到别人', () => {
  updateConfig({ companion: { enabled: true, proactiveEnabled: true, targets: ['10001', '20002'], dates: [{ md: '11-01', label: 'TA 的生日', uin: '20002' }] } });
  const rt = new comp.CompanionRuntime({ dataDir: tmp('date'), store: fakeStore([]), now: () => at('15:00') });
  assert.equal(rt.evaluate('private:20002').kind, 'date');
  assert.notEqual(rt.evaluate('private:10001').kind, 'date');
  assert.match(rt.promptText('private:20002'), /TA 的生日/);
});

test('/陪伴 指令只在私聊、只认本人', async () => {
  updateConfig({ companion: { enabled: true, targets: [], commands: ['/陪伴'], dates: [] } });
  const rt = new comp.CompanionRuntime({ dataDir: tmp('cmd'), store: fakeStore([]), now: () => at('15:00') });
  const sent = [];
  const cmds = new ExtensionCommands({ getRuntimes: () => ({ companion: rt }), send: async (k, t) => { sent.push([k, t]); } });
  assert.equal(await cmds.consume('private:10001', '10001', '/陪伴 状态', 1), true);
  assert.match(sent[0][1], /陪伴：主动消息开/);
  assert.equal(await cmds.consume('group:5', '10001', '/陪伴', 2), false);
  assert.equal(await cmds.consume('private:30003', '30003', '/陪伴', 3), false);
  // 重放同一条不重复执行
  assert.equal(await cmds.consume('private:10001', '10001', '/陪伴 状态', 1), true);
  assert.equal(sent.length, 1);
});

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

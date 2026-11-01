// 整理链路上"按名字反查 QQ 号"的回归用例（2026-09-23 全面审查发现）：
//   1) 遗留条目（只有名字、没有 QQ 号）反查出的 QQ 号如果本人也已经有一条记录，
//      两条必须并成一条整理 —— 分开整理时，后写回的那条会把并集结果整份覆盖掉；
//   2) 反查只认唯一名字；条目自带 QQ 号时不再按名字改写（重名会把印象写到别人头上）；
//   3) 坏时间戳（负数/纳秒级/超范围）不能让这条人物永远整理不了
//      （toISOString 遇到 Invalid Date 抛 RangeError，异常被记成 failed，坏值没人清理）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-mem-identity-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 上可能被句柄占着 */ } });

const { ChatStore } = await import('../src/core/store.js');
const { SessionRegistry } = await import('../src/core/sessions.js');
const { SendQueue } = await import('../src/onebot/sender.js');
const { Orchestrator } = await import('../src/core/orchestrator.js');
const { setRuntimeConfig, DEFAULT_CONFIG } = await import('../src/core/config.js');
const { MemoryStore } = await import('../src/memory/memory.js');

function writeMemberFile(userId, name, impressions, sourceChatKeys, updatedAt) {
  const peopleDir = path.join(dir, 'memory', 'people');
  fs.mkdirSync(peopleDir, { recursive: true });
  const file = userId ? `${userId}.json` : `_n_${name}.json`;
  fs.writeFileSync(path.join(peopleDir, file), JSON.stringify({
    version: 2,
    userId,
    name,
    sourceChatKeys,
    updatedAt,
    impressions: impressions.map((entry) => ({ ...entry, sourceChatKeys }))
  }), 'utf8');
  return path.join(peopleDir, file);
}

function makeRunner(groupIds) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active';
  cfg.allow.groups = groupIds;
  cfg.api = { ...cfg.api, model: 'test', baseUrl: 'https://model.invalid/v1', apiKey: 'k' };
  cfg.sticker.enabled = false;
  setRuntimeConfig(cfg);
  const store = new ChatStore(0, { dataDir: dir });
  const sessions = new SessionRegistry();
  const sender = new SendQueue({ store, onebot: {} });
  const memory = new MemoryStore();
  const runner = new Orchestrator({ store, sessions, sender, onebot: {}, stickers: {}, memory });
  return { runner, store, memory };
}

/** 模型桩：把提示词里读到的现有印象原样回吐（等价于"整理后一条没变"）。 */
function stubEchoModel() {
  globalThis.fetch = async (url, options = {}) => {
    const body = JSON.parse(String(options.body || '{}'));
    const user = String((body.messages || []).find((m) => m.role === 'user')?.content || '');
    const seen = [...user.matchAll(/^-\s+(.*?)（记于/gm)].map((m) => m[1]);
    return Response.json({
      choices: [{ message: { content: JSON.stringify({ impressions: seen }) } }],
      usage: { total_tokens: 10 }
    });
  };
}

function seedChat(store, chatKey, speakers) {
  let mid = 1;
  for (const [senderId, senderName, times] of speakers) {
    for (let i = 0; i < times; i += 1) {
      store.appendIncoming(chatKey, { mid: mid++, text: `${senderName} 的第 ${i + 1} 句话`, senderId, senderName });
    }
  }
}

test('整理链路：遗留条目并到本人名下、重名不猜、坏时间戳不卡死', async (t) => {
  const oldFetch = globalThis.fetch;
  stubEchoModel();
  t.after(() => { globalThis.fetch = oldFetch; });

  // ── 场景 1：遗留条目（只有名字）反查出的 QQ 本人也有记录 ──
  // 成员文件必须在 new MemoryStore() **之前**写好：构造函数里就会加载 people 目录并缓存。
  writeMemberFile('123', '小明', [{ content: '本人原有的印象', createdAt: 2000, lastObservedAt: 2000 }], ['group:1'], 2000);
  const legacyFile = writeMemberFile('', '小明', [{ content: '遗留条目里的印象', createdAt: 1000, lastObservedAt: 1000 }], ['group:1'], 1000);
  const first = makeRunner(['1']);
  seedChat(first.store, 'group:1', [['123', '小明', 4]]);

  const result1 = await first.runner.consolidateMemoryForChat('group:1');
  assert.deepEqual(result1.failed, [], '不该有整理失败的人');
  assert.deepEqual(
    first.memory.getMember('group:1', '123').impressions.map((x) => x.content).sort(),
    ['本人原有的印象', '遗留条目里的印象'].sort(),
    '两条记录要并成一条整理：本人已有印象 + 遗留印象都在'
  );
  assert.ok(!fs.existsSync(legacyFile), '并进来之后，遗留条目文件要退休（不然每轮都重复处理）');
  first.store.close();

  // ── 场景 2：同名两个人，旧条目不敢猜 ──
  writeMemberFile('201', '同名', [{ content: '甲原本的印象', createdAt: 2000, lastObservedAt: 2000 }], ['group:2'], 2000);
  writeMemberFile('202', '同名', [{ content: '乙原本的印象', createdAt: 2000, lastObservedAt: 2000 }], ['group:2'], 2000);
  const ambiguousFile = writeMemberFile('', '同名', [{ content: '不知道是谁的旧印象', createdAt: 1000, lastObservedAt: 1000 }], ['group:2'], 1000);
  const second = makeRunner(['2']);
  seedChat(second.store, 'group:2', [['201', '同名', 4], ['202', '同名', 4]]);

  const result2 = await second.runner.consolidateMemoryForChat('group:2');
  assert.ok(
    result2.skipped.some((s) => String(s.reason || '').includes('只有名字')),
    '重名时的旧条目应该被跳过（而不是猜一个）'
  );
  assert.deepEqual(
    second.memory.getMember('group:2', '201').impressions.map((x) => x.content),
    ['甲原本的印象'],
    '不能把旧印象写到同名的人头上'
  );
  assert.deepEqual(
    second.memory.getMember('group:2', '202').impressions.map((x) => x.content),
    ['乙原本的印象'],
    '不能把旧印象写到同名的人头上'
  );
  assert.ok(fs.existsSync(ambiguousFile), '猜不出来就别动它：文件要原样留着');
  second.store.close();

  // ── 场景 3：坏时间戳 ──
  writeMemberFile('456', '小刚', [{ content: '时间戳坏掉的印象', createdAt: 1000, lastObservedAt: 1e18 }], ['group:3'], 1000);
  const third = makeRunner(['3']);
  seedChat(third.store, 'group:3', [['456', '小刚', 4]]);

  const result3 = await third.runner.consolidateMemoryForChat('group:3');
  assert.deepEqual(result3.failed, [], '坏时间戳不该让这条人物永远整理不了');
  assert.ok(result3.results.some((r) => r.userId === '456'), '这条人物应该被正常整理');
  third.store.close();
});

test('整理不覆盖控制台手写的 manual 印象（issue #55）', async (t) => {
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  writeMemberFile('789', '小美', [
    { content: '手写：别叫她全名', createdAt: 2000, lastObservedAt: 2000, origin: 'manual' },
    { content: '模型：爱吃辣', createdAt: 2000, lastObservedAt: 2000, origin: 'consolidated' }
  ], ['group:4'], 2000);
  const runner = makeRunner(['4']);
  seedChat(runner.store, 'group:4', [['789', '小美', 4]]);
  // 模型只回了自动条目，完全没有提手工那条 —— 写回时也必须把手工条目强制保留。
  globalThis.fetch = async () => Response.json({
    choices: [{
      message: {
        // 模拟模型把手工条目连同"（记于 …）"尾注一起抄回来 —— 不能再生成一条重复副本。
        content: JSON.stringify({ impressions: ['手写：别叫她全名（记于 2026-10-25 10:00）', '模型：爱吃辣，也爱喝奶茶'] })
      }
    }],
    usage: { total_tokens: 10 }
  });

  const result = await runner.runner.consolidateMemoryForChat('group:4');
  assert.deepEqual(result.failed, []);
  const impressions = runner.memory.getMember('group:4', '789').impressions;
  const manual = impressions.find((e) => e.content === '手写：别叫她全名');
  assert.ok(manual, '手工印象不能被模型删掉');
  assert.equal(manual.origin, 'manual', '手工来源要保持 manual');
  assert.equal(impressions.filter((e) => e.content.includes('别叫她全名')).length, 1, '不能留下模型抄回的重复副本');
  assert.ok(impressions.some((e) => e.content.includes('爱喝奶茶')), '模型整理结果仍要生效');
  runner.store.close();
});

test('整理期间控制台改手工印象：旧内容不复活、新内容保留 manual（issue #55 复审）', async (t) => {
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  writeMemberFile('790', '小美', [
    { content: '手写：别叫她全名', createdAt: 2000, lastObservedAt: 2000, origin: 'manual' }
  ], ['group:5'], 2000);
  const runner = makeRunner(['5']);
  seedChat(runner.store, 'group:5', [['790', '小美', 4]]);
  globalThis.fetch = async () => {
    // 模拟模型跑着的这段时间里，管理员在控制台把手工印象改了。
    runner.memory.editMemberImpression('group:5', {
      userId: '790', name: '小美', impressions: ['手写：改过的内容']
    });
    return Response.json({
      choices: [{ message: { content: JSON.stringify({ impressions: ['模型：新条目'] }) } }],
      usage: { total_tokens: 10 }
    });
  };

  await runner.runner.consolidateMemoryForChat('group:5');
  const impressions = runner.memory.getMember('group:5', '790').impressions;
  assert.equal(impressions.some((e) => e.content === '手写：别叫她全名'), false, '旧快照里的手工条目不能被复活');
  const edited = impressions.find((e) => e.content === '手写：改过的内容');
  assert.ok(edited, '整理期间的新手工内容要保留');
  assert.equal(edited.origin, 'manual');
  assert.ok(impressions.some((e) => e.content === '模型：新条目'), '模型整理结果仍要生效');
  runner.store.close();
});

test('手工印象达到存储上限 50 条时跳过整理，不截断用户内容（issue #55 复审）', async (t) => {
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  const fifty = Array.from({ length: 50 }, (_, i) => ({
    content: `手写第 ${i + 1} 条`, createdAt: 2000 + i, lastObservedAt: 2000 + i, origin: 'manual'
  }));
  writeMemberFile('791', '小美', fifty, ['group:6'], 2000);
  const runner = makeRunner(['6']);
  seedChat(runner.store, 'group:6', [['791', '小美', 4]]);
  globalThis.fetch = async () => Response.json({
    choices: [{ message: { content: JSON.stringify({ impressions: ['模型新条目'] }) } }],
    usage: { total_tokens: 10 }
  });

  await runner.runner.consolidateMemoryForChat('group:6');
  const impressions = runner.memory.getMember('group:6', '791').impressions;
  assert.equal(impressions.length, 50, '不能因为 replace 的存储上限静默丢掉尾部手工条目');
  assert.equal(impressions.filter((e) => e.origin === 'manual').length, 50);
  runner.store.close();
});

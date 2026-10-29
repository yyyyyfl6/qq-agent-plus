// 2026-10-10 第三轮审查的运行时修复（A1-A4 / C1-C5 / D1 / D3）：
// 能行为验证的行为验证，触发成本过高的用源码锚点钉住（剥注释的锚点文化见 review-2026-10-09）。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-audit-fix-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  runtime: { mode: 'active', paused: false },
  allow: { groups: ['1'], private: ['100000001'] },
  api: { baseUrl: 'https://example.com/v1', apiKey: 'k', model: 'mock' },
  groupGame: { enabled: true, chats: ['group:1'], recruitSeconds: 0, games: ['number-bomb'] }
}));

const { Orchestrator, consolidationRejectionReason } = await import('../src/core/orchestrator.js');
const { ChatStore } = await import('../src/core/store.js');
const { setRuntimeConfig, DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');
const { GroupGameManager } = await import('../src/features/group-game.js');

// ── A1：整理护栏先于 isNew ──
test('A1：整理护栏先于 isNew —— 新建模式也不收坏结构', () => {
  assert.match(consolidationRejectionReason({ isNew: true, next: { bad: 1 } }), /坏结构/);
  assert.match(consolidationRejectionReason({ isNew: true, next: [{ obj: 1 }] }), /非字符串/);
  assert.equal(consolidationRejectionReason({ isNew: true, next: ['正常的印象'] }), '');
  assert.equal(consolidationRejectionReason({ isNew: false, existing: [], next: ['正常的印象'] }), '');
});

// ── A2：手动唤醒在有未回收租约时明确拒绝 ──
test('A2：手动唤醒在有未回收租约时明确拒绝，不再静默吞', async (t) => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active';
  cfg.allow.groups = ['1'];
  cfg.api.model = 'mock';
  setRuntimeConfig(cfg);
  const store = new ChatStore(0, { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'qq-audit-store-')) });
  t.after(() => store.close());
  // 造一条未读 + 一个在租的 run：claimUnread 会因此拿不到批次
  store.appendIncoming('group:1', { mid: 1, ts: Date.now(), senderId: 'u1', senderName: 'u1', text: '在吗' });
  const lease = store.claimUnread('group:1', { limit: 10, maxChars: 20000, leaseMs: 60000 });
  assert.ok(lease, '前置：造出一个在租的 run');
  const runner = new Orchestrator({
    store,
    sessions: { create: () => ({ id: 's' }) },
    memory: { formatForPrompt: () => '', formatHandoffForPrompt: () => '', getHandoff: () => null, setHandoff: () => null, clearHandoff: () => {} },
    stickers: {},
    sender: { sendTextBatch: async () => ({ sent: [], failed: [] }) },
    onebot: { selfId: '888', selfNickname: 'bot', getGroupInfo: async () => ({ group_name: 't' }) }
  });
  t.after(() => runner.abortAll());
  let woke = 0;
  runner.wake = async () => { woke += 1; };
  const r = runner.requestManualWake('group:1');
  assert.equal(r.ok, false, '有未回收租约时手动唤醒要拒绝');
  assert.match(String(r.reason), /租约/);
  assert.equal(woke, 0, '拒绝时不能真的触发唤醒');
  // 反向：租约回收后正常触发
  store.ackLease(lease.id);
  const r2 = runner.requestManualWake('group:1');
  assert.equal(r2.ok, true, '租约清掉后要能手动唤醒');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(woke, 1);
});

// ── C1：终局播报失败不丢局 ──
test('C1：终局播报发送失败不丢局——挂起重试，送达后才收尾', async (t) => {
  updateConfig({
    groupGame: { enabled: true, chats: ['group:1'], allowPrivateInvite: true, recruitSeconds: 0, games: ['number-bomb'], maxPlayers: 10, maxDurationMin: 60 }
  });
  const store = new ChatStore(0, { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'qq-audit-games-')) });
  t.after(() => store.close());
  for (let i = 1; i <= 4; i += 1) {
    store.appendIncoming('group:1', {
      mid: 100 + i, ts: Date.now() - i * 1000, senderId: `u${i}`, senderName: `群友${i}`, text: '在'
    }, { recordOnly: true });
  }
  let failEnd = true;
  const sent = [];
  const sender = { sendTextBatch: async (chatKey, msgs) => {
    if (failEnd && /结束：/.test(msgs[0])) throw new Error('protocol down');
    sent.push({ chatKey, msgs: [...msgs] });
    return { message_id: sent.length };
  } };
  let clock = Date.now();
  const mgr = new GroupGameManager({ store, sender, log: () => {}, now: () => clock, rng: () => 0.42 });
  t.after(() => mgr.stop?.());
  const r = await mgr.start({ chatKey: 'group:1', gameId: 'number-bomb' });
  assert.equal(r.ok, true);
  clock += 61 * 60 * 1000;   // 拨过 maxDurationMin(60) 的 deadline
  await mgr.tick();
  assert.ok(mgr.games.get('group:1'), '局不能被就地删掉（终局播报还没送出去）');
  assert.equal(sent.some((s) => /结束：/.test(s.msgs[0])), false, '失败的播报不算送达');
  // 恢复后重试：播报送达 → 局收尾
  failEnd = false;
  await mgr.tick();
  assert.ok(sent.some((s) => /结束：/.test(s.msgs[0])), '重试要真的把终局播报送出去');
  assert.equal(mgr.games.get('group:1'), undefined, '播报送达后才收尾');
});

test('C1b：猜中炸弹的终局播报失败也不丢局（handleNewMessages 路径，2026-10-10 审查 P1-1）', async (t) => {
  updateConfig({
    groupGame: { enabled: true, chats: ['group:1'], allowPrivateInvite: true, recruitSeconds: 0, games: ['number-bomb'], maxPlayers: 10, maxDurationMin: 60 }
  });
  const store = new ChatStore(0, { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'qq-audit-games2-')) });
  t.after(() => store.close());
  for (let i = 1; i <= 4; i += 1) {
    store.appendIncoming('group:1', {
      mid: 200 + i, ts: Date.now() - i * 1000, senderId: `u${i}`, senderName: `群友${i}`, text: '在'
    }, { recordOnly: true });
  }
  let failEnd = true;
  const sent = [];
  const sender = { sendTextBatch: async (chatKey, msgs) => {
    if (failEnd && /结束：/.test(msgs[0])) throw new Error('protocol down');
    sent.push({ chatKey, msgs: [...msgs] });
    return { message_id: sent.length };
  } };
  const mgr = new GroupGameManager({ store, sender, log: () => {}, now: () => Date.now(), rng: () => 0.42 });
  t.after(() => mgr.stop?.());
  const r = await mgr.start({ chatKey: 'group:1', gameId: 'number-bomb' });
  assert.equal(r.ok, true);
  // 猜中炸弹（rng 0.42 → 43）→ 消息终局 → 播报恰好失败
  store.appendIncoming('group:1', {
    mid: 999, ts: Date.now(), senderId: 'u1', senderName: '群友1', text: '43'
  }, { recordOnly: true });
  await mgr.tick();
  assert.ok(mgr.games.get('group:1'), '猜中终局+播报失败：局不能被就地删掉');
  assert.equal(sent.some((s) => /结束：/.test(s.msgs[0])), false, '失败的播报不算送达');
  failEnd = false;
  await mgr.tick();
  assert.ok(sent.some((s) => /结束：/.test(s.msgs[0])), '重试要真的把终局播报送出去');
  assert.equal(mgr.games.get('group:1'), undefined, '播报送达后才收尾');
});

// ── 触发成本高的用源码锚点钉住 ──
test('A3/A4 锚点：排程失败收尾后必须 return；无租约失败路径也要 completeRun', () => {
  const orch = src('src/core/orchestrator.js');
  assert.match(orch, /#abortSchedule\(chatKey, error\);\s*return;/, 'scheduleWake 的 catch 收尾后要 return');
  assert.equal((orch.match(/completeRun\(session\.leaseId\)/g) || []).length, 2,
    'completeRun(session.leaseId) 必须在成功与失败两条路径各出现一次');
  assert.match(orch, /cfg\.groupGame\?\.enabled !== true && d\.name === 'group_game'/, 'D3：群游戏关掉要摘 group_game 工具');
});

test('C2/C3/C4 锚点：账号不一致走退避；MOMENT_BUSY 保住 deferredDay；槽位用自己的 dayKey', () => {
  assert.match(src('src/features/qzone-interactions.js'),
    /#recordFailure\('QQ 登录账号与 qzone-interactions 状态文件不一致，本轮跳过'\)/);
  assert.match(src('src/features/daily-moments.js'),
    /error\?\.code === 'TIME_CONTROL_INACTIVE' \|\| error\?\.code === 'MOMENT_BUSY'\) this\.deferredDay = dayKey;/);
  assert.match(src('src/features/daily-moments.js'), /dayKey: slot\.dayKey, publish: cfg\.autoPublish === true/);
});

test('C5/D1 锚点：狼人杀毒药解析最长前缀优先；好友列表失败沿用旧库', () => {
  const wolf = src('src/features/games/werewolf.js');
  assert.equal((wolf.match(/\^\(下毒\|毒药\|用毒\|毒\)/g) || []).length, 2,
    'test 与 replace 两处的正则都要最长前缀优先（"毒药 3"不再被切成"药 3"）');
  assert.equal(/\/\^\(毒\|下毒/.test(wolf), false, '旧顺序（毒 在前）必须消失');
  assert.match(src('src/identity/identity-pilot-core.js'), /friends = db\.listKnownFriends\(\);/,
    'D1：#start 拉不到好友列表时沿用旧库，不再拿空表清零 is_friend');
});

test('称呼统一：日报与每日动态的材料都走 displayNameOf（2026-10-11 反馈）', () => {
  const digest = src('src/features/group-digest.js');
  assert.equal((digest.match(/displayNameOf\(/g) || []).length >= 2, true,
    'digest 的参与者统计与样本行两个入口都要接（卸掉任何一个这条就红）');
  assert.match(src('src/features/daily-moments.js'),
    /displayNameOf\(String\(message\.senderId \|\| ''\)/,
    '每日动态材料（图片 label 与 sender 字段）要接');
});

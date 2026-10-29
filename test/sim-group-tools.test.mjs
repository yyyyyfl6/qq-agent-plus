// 工具循环 / 记忆 / 会话层的深水区验收（2026-10-08）。
//
// 与 platform-simulated-group.test.mjs、sim-group-complex.test.mjs 同一套台架：
// 起一个**假的 SnowLuma HTTP 协议端**（POST /<action>），把**真的**
// OneBotClient / SendQueue / Orchestrator / ChatStore / 工具定义 / MemoryStore / ReminderStore
// 接上去跑完整链路，断言协议端实际收到的 action 与顺序、库里的落账、记忆与会话的归属。
//
// 本文件专挑已有用例没碰的面：一轮多工具、工具报错、未知副作用→held、轮数上限、
// 双群会话隔离、记忆交接归属、运行中来消息的排队、定时提醒/延后唤醒、配额跨窗口恢复、
// 超长工具结果截断。
//
// 铁律：绝不碰真实 QQ / 真实协议端；每个用例一份独立临时数据目录 + 自己的假服务端。
//
// 数据目录说明：config-legacy 的 DATA_DIR 是**模块级 const**（只在动态 import 之前读一次
// QQ_AGENT_DATA_DIR），sessions/memory 的落盘目录都在 import 时定死（bootDir）。所以本文件
// 沿用参照用例的做法：bootDir 只定一次，**每个用例另拿一份自己的目录**给 ChatStore/ReminderStore
// （它们都接受显式路径），并让各用例使用**互不相同的 QQ 号与会话号**保证互不串台。
import assert from 'node:assert/strict';
import { it } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const bootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-simt-boot-'));
process.env.QQ_AGENT_DATA_DIR = bootDir;

const { ChatStore } = await import('../src/core/store.js');
const { SendQueue } = await import('../src/onebot/sender.js');
const { OneBotClient } = await import('../src/onebot/onebot.js');
const { Orchestrator } = await import('../src/core/orchestrator.js');
const { SessionRegistry } = await import('../src/core/sessions.js');
const { MemoryStore } = await import('../src/memory/memory.js');
const { ReminderStore } = await import('../src/core/reminders.js');
const { createQuota } = await import('../src/core/quota.js');
const { buildToolDefs, resetPlatformQuotasForTest } = await import('../src/tools/tools-core.js');
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');

// ── 每个用例一份独立临时目录（Windows 上句柄可能没释放，rm 会 EPERM —— 清理失败不算失败）──
const caseDirs = [];
function makeCaseDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-simt-'));
  process.env.QQ_AGENT_DATA_DIR = dir;
  caseDirs.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of [...caseDirs, bootDir]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 句柄占用就留着 */ }
  }
});

/** 基础配置：active + 放行 + 假模型地址；每个用例拿一份新克隆再改。 */
function baseConfig() {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active';
  cfg.allow.groups = ['1'];
  cfg.allow.private = [];
  cfg.api.model = 'test';
  cfg.api.baseUrl = 'https://model.invalid';
  cfg.sticker.enabled = false;
  // 自动整理会额外调一次模型、把"模型调用次数"搅浑：本文件不测它，统一关掉
  cfg.memory.consolidateEnabled = false;
  return cfg;
}

/**
 * 假 SnowLuma：POST /<action>，把 {action, params, headers} 记进 calls，回 {status:'ok',retcode:0,data}。
 * respond(action, params) 给 data；envelope(action, params) 可整体接管响应体（造失败响应用，返回 null 走默认）。
 * envelope 可用 { __httpStatus, body } 造 HTTP 层失败（5xx=结果未知）。
 */
function startFakeSnowLuma({ respond = () => ({}), envelope = null } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const action = String(req.url || '/').replace(/^\/+/, '').split('?')[0];
      let params = null;
      try { params = JSON.parse(raw || '{}'); } catch { params = raw; }
      calls.push({ action, params, headers: req.headers, method: req.method });
      const override = envelope ? envelope(action, params) : null;
      if (override && override.__httpStatus) {
        res.writeHead(override.__httpStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify(override.body ?? { status: 'error' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(override ?? { status: 'ok', retcode: 0, data: respond(action, params) ?? {} }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        calls,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
        byAction: (name) => calls.filter((c) => c.action === name),
        last: (name) => calls.filter((c) => c.action === name).at(-1)
      });
    });
  });
}

/** 只挡模型端点：协议端的 127.0.0.1 必须放行给真 fetch，否则真客户端到不了假 SnowLuma。 */
function modelFetch(realFetch, sim, handler) {
  const fn = async (input, init) => {
    const url = String(typeof input === 'string' ? input : (input?.url ?? ''));
    if (url.startsWith(sim.url)) return realFetch(input, init);
    fn.modelCalls += 1;
    return handler(init, fn.modelCalls);
  };
  fn.modelCalls = 0;
  return fn;
}

const USAGE = { total_tokens: 5 };
const replyText = (content) => Response.json({ choices: [{ message: { content } }], usage: USAGE });
/** 模型回一轮工具调用：calls = [{ id?, name, args }]（args 是对象或已序列化字符串）。 */
const replyTools = (calls) => Response.json({
  choices: [{
    message: {
      tool_calls: calls.map((c, i) => ({
        id: c.id || `call_${i}`,
        type: 'function',
        function: {
          name: c.name,
          arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args ?? {})
        }
      }))
    }
  }],
  usage: USAGE
});

/** 表情库桩：只有 st1 可发（其余查不到 → 走"找不到表情"分支）。 */
function defaultStickers() {
  return {
    sync: async () => ({ entries: [] }),
    list: async () => ({ entries: [] }),
    find: async () => null,
    findForSend: async (id) => (String(id) === 'st1'
      ? { id: 'st1', url: 'base64://aGVsbG8=', localFile: 'f.png', desc: '测试表情' }
      : null),
    markUsed: async () => {}
  };
}

/** 起假协议端 + 真客户端/队列/编排器，跑完 body 一起收摊。 */
async function runSim(options, body) {
  const sim = await startFakeSnowLuma({ respond: options.respond ?? (() => ({})), envelope: options.envelope ?? null });
  const client = new OneBotClient({ wsUrl: 'ws://127.0.0.1:1', httpUrl: sim.url });
  const store = new ChatStore(0, { dataDir: options.dataDir });
  const sessions = new SessionRegistry();
  const sender = new SendQueue({ store, onebot: client });
  const runner = new Orchestrator({
    store, sessions, sender, onebot: client,
    stickers: options.stickers ?? defaultStickers(),
    memory: options.memory ?? { formatForPrompt: () => '' },
    reminders: options.reminders ?? null
  });
  const realFetch = globalThis.fetch;
  const fetchStub = modelFetch(realFetch, sim, options.fetchHandler ?? (() => replyText('好')));
  globalThis.fetch = fetchStub;
  try {
    return await body({ sim, client, store, sessions, runner, sender, fetchStub });
  } finally {
    globalThis.fetch = realFetch;
    try { await runner.abortAll(); } catch { /* 会话已结束 */ }
    store.close();
    await sim.close();
  }
}

const tool = (name) => {
  const def = buildToolDefs().find((d) => d.name === name);
  assert.ok(def, `工具 ${name} 应存在`);
  return def;
};
const parse = (r) => JSON.parse(r.content);
const groupCtx = (client, overrides = {}) => ({
  kind: 'group', chatId: '1', chatKey: 'group:1',
  session: { id: 's', sent: [], leaseId: 'l' },
  onebot: client,
  store: { findByMid: () => null, recent: () => [] },
  emit: () => {},
  ...overrides
});

const outboxState = (store, chatKey) => store.db
  .prepare('SELECT state FROM outbox WHERE chat_key=? ORDER BY rowid DESC LIMIT 1')
  .get(chatKey)?.state;
// 会话索引的落盘目录是模块级常量（bootDir/sessions），同一次运行里各用例共用 ——
// 断言必须按 chatKey 取"这一次的会话"，不能拿 listSummaries(1)[0] 当唯一（前面的用例也留下了记录）。
const latestSession = (sessions, chatKey) => sessions.listSummaries(500).find((s) => s.chatKey === chatKey);
const wireTexts = (sim, groupId = 1) => sim.byAction('send_group_msg')
  .filter((c) => c.params.group_id === groupId)
  .map((c) => c.params.message.filter((s) => s.type === 'text').map((s) => s.data.text).join(''));

function waitFor(check, timeoutMs = 3000, stepMs = 25) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      let ok = false;
      try { ok = check(); } catch { ok = false; }
      if (ok) return resolve();
      if (Date.now() - startedAt > timeoutMs) return reject(new Error('waitFor 超时'));
      return setTimeout(tick, stepMs);
    };
    tick();
  });
}

// ═════════════ ① 一轮多工具：结果按序回填 ═════════════
it('工具循环·一轮多工具：两个工具结果按调用顺序回填，最终回复只发一次', async () => {
  setRuntimeConfig(baseConfig());
  const dataDir = makeCaseDir();
  const bodies = [];
  await runSim({
    dataDir,
    respond: (action) => {
      if (action === 'get_group_detail_info') return { group_name: '模拟群', group_memo: '简介', member_count: 3 };
      if (action === '_get_group_notice') return [{ publish_time: 1, message: { text: '周三维护' } }];
      if (action === 'get_group_honor_info') return { talkative: { users: [] } };
      if (action === 'get_stranger_info') return { nickname: '甲' };
      return {};
    },
    fetchHandler: (init, n) => {
      bodies.push(JSON.parse(init?.body || '{}'));
      if (n === 1) {
        return replyTools([
          { id: 'c1', name: 'get_group_profile', args: {} },
          { id: 'c2', name: 'get_user_info', args: { userId: '2002' } }
        ]);
      }
      if (n === 2) return replyTools([{ id: 'c3', name: 'send_message', args: { messages: '收到' } }]);
      return replyText('本轮结束');
    }
  }, async ({ sim, store, runner, sessions }) => {
    store.appendIncoming('group:1', { mid: 101, text: '看看群资料和别人', senderId: '42', senderName: '群友' });
    await runner.wake('group:1', { manual: true });

    // 两个只读工具都真的打到了协议端（各自形状也对）
    assert.equal(sim.byAction('get_group_detail_info').length, 1);
    assert.deepEqual(sim.last('get_group_detail_info').params, { group_id: 1 });
    assert.equal(sim.byAction('get_stranger_info').length, 1);
    assert.deepEqual(sim.last('get_stranger_info').params, { user_id: 2002 });

    // 第二轮请求里，工具结果按**调用顺序**、以对应 tool_call_id 回填
    const toolMsgs = bodies[1].messages.filter((m) => m.role === 'tool');
    assert.equal(toolMsgs.length, 2, '两个工具结果都要回到模型');
    assert.deepEqual(toolMsgs.map((m) => m.tool_call_id), ['c1', 'c2'], '顺序 = 模型调用顺序');
    assert.equal(JSON.parse(toolMsgs[0].content).detail.name, '模拟群', '第一条结果来自第一个工具');
    assert.equal(JSON.parse(toolMsgs[1].content).nickname, '甲', '第二条结果来自第二个工具');

    // 会话审计里的顺序与之一致（后续轮的 send_message 追加在它们之后）
    const audit = sessions.get(latestSession(sessions, 'group:1').id).messages
      .filter((m) => m.toolCall).map((m) => m.toolCall.name);
    assert.deepEqual(audit, ['get_group_profile', 'get_user_info', 'send_message']);

    // 最终回复只发一次
    assert.deepEqual(wireTexts(sim, 1), ['收到']);
    assert.equal(sim.byAction('send_group_msg').length, 1);
  });
});

// ═════════════ ② 工具报错：运行继续 ═════════════
it('工具循环·工具报错：错误回给模型、运行继续、用户仍收到回复且无重复外发', async () => {
  setRuntimeConfig(baseConfig());
  const dataDir = makeCaseDir();
  const memory = new MemoryStore();
  const bodies = [];
  await runSim({
    dataDir,
    memory,
    fetchHandler: (init, n) => {
      bodies.push(JSON.parse(init?.body || '{}'));
      if (n === 1) {
        // 业务校验会拒：这个 QQ 号没在当前会话出现过
        return replyTools([{ id: 'e1', name: 'memory_append', args: { category: 'memberImpression', userId: '999999', content: '编出来的人' } }]);
      }
      if (n === 2) return replyTools([{ id: 's1', name: 'send_message', args: { messages: '收到' } }]);
      return replyText('');
    }
  }, async ({ sim, store, runner, sessions }) => {
    store.appendIncoming('group:1', { mid: 102, text: '你好', senderId: '42', senderName: '群友' });
    await runner.wake('group:1', { manual: true });

    // 报错以「错误：…」工具结果回到模型，且 tool_call_id 对得上
    const toolMsg = bodies[1].messages.find((m) => m.role === 'tool');
    assert.ok(toolMsg, '报错也要作为工具结果回给模型');
    assert.match(String(toolMsg.content), /^错误：/, '工具错误以"错误："文案回给模型');
    assert.equal(toolMsg.tool_call_id, 'e1');

    // 错的人没被记进记忆（业务校验真的拦住了）
    assert.equal(memory.members('group:1').some((m) => m.userId === '999999'), false);

    // 运行继续、用户仍拿到回复，且只有一条（没有因报错而重发）
    assert.equal(latestSession(sessions, 'group:1').status, 'done');
    assert.deepEqual(wireTexts(sim, 1), ['收到']);
    assert.equal(sim.byAction('send_group_msg').length, 1, '报错不触发任何重复外发');
    assert.equal(bodies.length, 3, '报错轮 + 回复轮 + 收尾轮');
  });
});

// ═════════════ ③ 未知副作用 → held，重试被拒 ═════════════
it('工具循环·副作用后运行失败：结果未知→outbox unknown、批次 held、同 runId 重试被拒', async () => {
  const cfg = baseConfig();
  cfg.sticker.enabled = true;
  setRuntimeConfig(cfg);
  const dataDir = makeCaseDir();
  await runSim({
    dataDir,
    // 协议端 5xx = "结果未知"：表情那一次发送可能已经到达
    envelope: (action) => (action === 'send_group_msg' ? { __httpStatus: 500, body: { status: 'error' } } : null),
    fetchHandler: () => replyTools([{ id: 'k1', name: 'send_sticker', args: { stickerId: 'st1' } }])
  }, async ({ sim, store, runner, sessions, sender }) => {
    store.appendIncoming('group:1', { mid: 103, text: '来个表情', senderId: '42', senderName: '群友' });
    await runner.wake('group:1', { manual: true });

    // 只发起过一次：结果未知的消息绝不自动重发（否则群里两条一样）
    assert.equal(sim.byAction('send_group_msg').length, 1, '5xx 不重发');
    // outbox 记成 unknown（持有待人工核对）
    assert.equal(outboxState(store, 'group:1'), 'unknown');
    // 有副作用 → 整批进 held（不是 failed：failed 会被"重试失败批次"捞回去重跑，凭空多一次副作用）
    assert.ok(store.getChatMeta('group:1').held >= 1, '有未知副作用的批次要 held 待核对');
    assert.equal(store.findByMid('group:1', 103).state, 'held');
    assert.equal(latestSession(sessions, 'group:1').status, 'error');

    // 拿产生该副作用的 runId 再发一次（模拟"重跑这批"）→ 被发送层的未知副作用闸门拦下
    const runId = store.db.prepare('SELECT run_id FROM outbox WHERE chat_key=? ORDER BY rowid DESC LIMIT 1').get('group:1').run_id;
    assert.ok(runId, 'outbox 行要绑定产生它的 runId');
    await assert.rejects(
      () => sender.sendTextBatch('group:1', ['补一句'], { runId }),
      /uncertain/i
    );
    assert.equal(sim.byAction('send_group_msg').length, 1, '被拦下 = 没有第二个副作用落到协议端');
  });
});

// ═════════════ ④ 轮数上限 ═════════════
it('工具循环·轮数上限：maxRounds 用尽即安全收尾，已说的话照发、消息正常 ack', async () => {
  const cfg = baseConfig();
  cfg.api.maxRounds = 2;
  setRuntimeConfig(cfg);
  const dataDir = makeCaseDir();
  await runSim({
    dataDir,
    // 第 1 轮发言，之后每轮都调一个没有 finish 的工具 → 永远"干不完"
    fetchHandler: (init, n) => (n === 1
      ? replyTools([{ id: 'm1', name: 'send_message', args: { messages: '在的' } }])
      : replyTools([{ id: `r${n}`, name: 'get_recent_messages', args: { limit: 5 } }]))
  }, async ({ sim, store, runner, sessions, fetchStub }) => {
    store.appendIncoming('group:1', { mid: 104, text: '在吗', senderId: '42', senderName: '群友' });
    await runner.wake('group:1', { manual: true });

    assert.equal(fetchStub.modelCalls, 2, 'maxRounds=2 → 恰好两次模型调用');
    const summary = latestSession(sessions, 'group:1');
    const persisted = sessions.get(summary.id);
    assert.equal(persisted.roundBudgetStopped, true, '轮数用尽是"安全收尾"，要标注而不是当故障');
    assert.equal(persisted.rounds, 2);
    assert.match(String(persisted.finishReason), /轮数用尽/);
    // 安全收尾：已发的话照发，批次正常 ack（不是 held/failed）
    assert.deepEqual(wireTexts(sim, 1), ['在的']);
    assert.equal(store.getChatMeta('group:1').held, 0);
    assert.equal(store.findByMid('group:1', 104).state, 'acked');
    assert.notEqual(summary.status, 'error');
  });
});

// ═════════════ ⑤ 双群并发：会话 / 记忆隔离 ═════════════
it('会话隔离·双群并发：回复各落各群，记忆写回带正确来源、不串群', async () => {
  const cfg = baseConfig();
  cfg.allow.groups = ['501', '502'];
  cfg.maxConcurrentRuns = 2;
  setRuntimeConfig(cfg);
  const dataDir = makeCaseDir();
  const memory = new MemoryStore();
  await runSim({
    dataDir,
    memory,
    fetchHandler: (init) => {
      const body = JSON.parse(init?.body || '{}');
      if ((body.messages || []).some((m) => m.role === 'tool')) return replyText('好');
      const joined = (body.messages || []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
      const one = joined.includes('群一的暗号');
      return replyTools([
        { id: 'a', name: 'memory_append', args: { category: 'memberImpression', userId: one ? '41' : '42', target: one ? '甲' : '乙', content: one ? '甲爱聊群一的话题' : '乙爱聊群二的话题' } },
        { id: 'b', name: 'send_message', args: { messages: one ? '群一收到' : '群二收到' } }
      ]);
    }
  }, async ({ sim, store, runner, sessions }) => {
    store.appendIncoming('group:501', { mid: 11, text: '群一的暗号', senderId: '41', senderName: '甲' });
    store.appendIncoming('group:502', { mid: 21, text: '群二的暗号', senderId: '42', senderName: '乙' });
    await Promise.all([
      runner.wake('group:501', { manual: true }),
      runner.wake('group:502', { manual: true })
    ]);

    // 回复各落各群（串台就会被这一对断言抓到）
    assert.deepEqual(wireTexts(sim, 501), ['群一收到']);
    assert.deepEqual(wireTexts(sim, 502), ['群二收到']);

    // 记忆写回带正确来源：各自的印象只挂在自己的会话名下
    assert.deepEqual(memory.getMember('', '41').impressions.map((e) => e.content), ['甲爱聊群一的话题']);
    assert.deepEqual(memory.getMember('', '41').impressions[0].sourceChatKeys, ['group:501']);
    assert.deepEqual(memory.getMember('', '42').impressions[0].sourceChatKeys, ['group:502']);
    assert.deepEqual(memory.members('group:501').map((m) => m.userId), ['41'], '群 501 只该看到 41 的印象');
    assert.deepEqual(memory.members('group:502').map((m) => m.userId), ['42'], '群 502 只该看到 42 的印象');

    // 两个独立会话各记各的 chatKey
    const mine = sessions.listSummaries(500).filter((s) => s.chatKey === 'group:501' || s.chatKey === 'group:502');
    assert.deepEqual([...new Set(mine.map((s) => s.chatKey))].sort(), ['group:501', 'group:502']);
    assert.equal(mine.every((s) => s.status === 'done'), true, '两次运行都正常收尾');
  });
});

// ═════════════ ⑥ 记忆写回：会话交接归属 ═════════════
it('记忆写回·会话交接：按 chatKey 归属，另一群既不凭空出现也不串内容', async () => {
  const cfg = baseConfig();
  cfg.allow.groups = ['601', '602'];
  setRuntimeConfig(cfg);
  const dataDir = makeCaseDir();
  const memory = new MemoryStore();
  await runSim({
    dataDir,
    memory,
    fetchHandler: (init) => {
      const body = JSON.parse(init?.body || '{}');
      if ((body.messages || []).some((m) => m.role === 'tool')) return replyText('好');
      const one = (body.messages || []).some((m) => typeof m.content === 'string' && m.content.includes('只属于601'));
      return replyTools([{ id: 'h', name: 'send_message', args: { messages: one ? '601的回复' : '602的回复' } }]);
    }
  }, async ({ store, runner }) => {
    store.appendIncoming('group:601', { mid: 31, text: '只属于601的秘密', senderId: '61', senderName: '甲' });
    await runner.wake('group:601', { manual: true });

    // 发过言的会话留下交接，交接内容属于它自己
    const h601 = memory.getHandoff('group:601');
    assert.ok(h601, '发过言的会话要留下交接');
    assert.match(String(h601.summary), /只属于601/);
    assert.match(String(h601.lastReply), /601的回复/);
    // 另一群从没跑过：不该凭空出现交接，更不该串进 601 的内容
    assert.equal(memory.getHandoff('group:602'), null);
    assert.equal(memory.formatHandoffForPrompt('group:602'), '', '别群的会话不该被注入 601 的交接');
  });
});

// ═════════════ ⑦ 运行中来消息：排队不交错、不丢 ═════════════
it('会话隔离·运行中来消息：本轮不交错，消息不丢、下一轮处理', async () => {
  const cfg = baseConfig();
  cfg.drainDelayMs = 60000;   // 别让 drain 定时器在断言前插一脚
  setRuntimeConfig(cfg);
  const dataDir = makeCaseDir();
  let injected = false;
  let sends = 0;
  let storeRef = null;
  await runSim({
    dataDir,
    fetchHandler: (init) => {
      const body = JSON.parse(init?.body || '{}');
      const hasTool = (body.messages || []).some((m) => m.role === 'tool');
      if (hasTool) return replyText('好');
      sends += 1;
      // 本轮运行进行中，同一会话又来了新消息
      if (!injected) {
        injected = true;
        storeRef.appendIncoming('group:1', { mid: 202, text: '运行中来的第二条', senderId: '43', senderName: '群友乙' });
      }
      return replyTools([{ id: `p${sends}`, name: 'send_message', args: { messages: sends === 1 ? '第一条回复' : '第二条回复' } }]);
    }
  }, async ({ sim, store, runner }) => {
    storeRef = store;
    store.appendIncoming('group:1', { mid: 201, text: '第一条', senderId: '42', senderName: '群友' });
    await runner.wake('group:1', { manual: true });

    // 本轮只处理了自己的批次：运行中进来的那条没被塞进本轮
    assert.deepEqual(wireTexts(sim, 1), ['第一条回复']);
    assert.equal(store.unreadCount('group:1'), 1, '运行中来的消息仍是未读，等着下游处理');
    assert.equal(store.findByMid('group:1', 202).state, 'pending');

    // 下一轮把它处理掉 —— 没有丢
    await runner.wake('group:1', { manual: true });
    assert.deepEqual(wireTexts(sim, 1), ['第一条回复', '第二条回复']);
    assert.equal(store.findByMid('group:1', 202).state, 'acked');
    assert.equal(store.unreadCount('group:1'), 0);
  });
});

// ═════════════ ⑧ 定时提醒 / 延后唤醒 ═════════════
it('定时提醒·延后唤醒：deferTo 到点只对目标群触发一次，不串群、不重复', async () => {
  const cfg = baseConfig();
  cfg.allow.groups = ['701', '702'];
  setRuntimeConfig(cfg);
  const dataDir = makeCaseDir();
  const reminders = new ReminderStore(path.join(dataDir, 'reminders.json'));
  const bodies = [];
  await runSim({
    dataDir,
    reminders,
    fetchHandler: (init) => {
      const body = JSON.parse(init?.body || '{}');
      bodies.push(body);
      // 发过一次就收尾：否则每轮都再发一条，就不是"触发一次"了
      if ((body.messages || []).some((m) => m.role === 'tool')) return replyText('');
      return replyTools([{ id: 't1', name: 'send_message', args: { messages: '该喝水了' } }]);
    }
  }, async ({ sim, runner }) => {
    const soon = Date.now() + 60 * 60 * 1000;
    const a = reminders.add({ chatKey: 'group:701', at: soon, text: '提醒701喝水' });
    reminders.add({ chatKey: 'group:702', at: soon, text: '提醒702吃饭' });
    assert.equal(reminders.due().length, 0, '都还没到点');

    // deferTo 把 701 那条挪到"刚过去"→ 只有它到期
    reminders.deferTo(a.id, Date.now() - 1000);
    assert.deepEqual(reminders.due().map((x) => x.chatKey), ['group:701']);

    runner.fireDueReminders();
    // 标记已触发改到"唤醒完成并确认播报"之后，等它落定
    await waitFor(() => reminders.list('group:701', { includeDone: true }).find((x) => x.id === a.id).status === 'fired');
    assert.equal(reminders.list('group:701', { includeDone: true }).find((x) => x.id === a.id).status, 'fired');
    assert.equal(reminders.list('group:702')[0].status, 'pending', '没到的群不该被触发');

    await waitFor(() => sim.byAction('send_group_msg').length >= 1);
    assert.deepEqual(wireTexts(sim, 701), ['该喝水了']);
    assert.equal(sim.byAction('send_group_msg').filter((c) => c.params.group_id === 702).length, 0, '不串群');
    // 提醒内容真的进了提示词（不是一次空唤醒）
    assert.ok(bodies.some((b) => (b.messages || []).some((m) => typeof m.content === 'string' && m.content.includes('提醒701喝水'))));

    // 再 tick 一次：已 fired → 不再重复唤醒
    const before = sim.byAction('send_group_msg').length;
    runner.fireDueReminders();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(sim.byAction('send_group_msg').length, before, '已触发的提醒不会重复派发');
  });
});

// ═════════════ ⑨ 配额跨窗口恢复 ═════════════
it('配额·跨窗口恢复：滑动窗口过期后重新可用（拒绝不粘），工具层超限不打协议端', async () => {
  // A) 真 quota 模块 + 显式时间戳模拟跨天：同一天第二次被拒、跨过 24h 窗口恢复
  const dayMs = 24 * 60 * 60 * 1000;
  const quota = createQuota({ windowMs: dayMs, globalMax: 1, perChatMax: Infinity });
  const t0 = 1_700_000_000_000;
  assert.equal(quota.tryConsume('group:901', t0).ok, true, '当天第一次可用');
  const sameDay = quota.tryConsume('group:901', t0 + 6 * 60 * 60 * 1000);
  assert.equal(sameDay.ok, false, '同一天第二次要被拒');
  assert.equal(sameDay.scope, 'global');
  assert.ok(sameDay.retryAfterMs > 0, '拒绝要带"多久后可再试"');
  assert.equal(quota.tryConsume('group:901', t0 + dayMs + 1).ok, true, '跨过 24h 窗口后恢复（拒绝不是永久的）');
  assert.equal(quota.snapshot(t0 + dayMs + 1).globalUsed, 1, '旧记录已滑出窗口，只剩刚记的那次');

  // B) 工具层：真 set_my_signature 打到假协议端；超限只回错误、不再打协议端
  const cfg = baseConfig();
  cfg.platform = { ...cfg.platform, quotas: { ...cfg.platform.quotas, profilePerDay: 1 } };
  setRuntimeConfig(cfg);
  resetPlatformQuotasForTest();
  const dataDir = makeCaseDir();
  try {
    await runSim({ dataDir, respond: () => ({}) }, async ({ sim, client }) => {
      const ctx = groupCtx(client);
      const first = parse(await tool('set_my_signature').execute(ctx, { signature: '摸鱼中' }));
      assert.equal(first.signature, '摸鱼中');
      assert.deepEqual(sim.last('set_self_longnick').params, { long_nick: '摸鱼中' });

      const second = await tool('set_my_signature').execute(ctx, { signature: '再改一次' });
      assert.equal(second.isError, true, '超限要被拒');
      assert.match(String(second.content), /用完了/);
      assert.equal(sim.byAction('set_self_longnick').length, 1, '被拒的那次不打协议端');

      // 闸门是内存态滑动窗口：清掉记录（等价于跨日/重启重置）后立即恢复
      resetPlatformQuotasForTest();
      await tool('set_my_signature').execute(ctx, { signature: '跨日再改' });
      assert.equal(sim.byAction('set_self_longnick').length, 2, '额度释放后立即可用（拒绝不粘）');
    });
  } finally {
    resetPlatformQuotasForTest();
    setRuntimeConfig(baseConfig());
  }
});

// ═════════════ ⑩ 超长工具结果截断 ═════════════
it('超长工具结果：按文档上限截断（工具 4000 / 会话审计 2000），不撑爆提示词', async () => {
  setRuntimeConfig(baseConfig());
  const dataDir = makeCaseDir();
  const bodies = [];
  await runSim({
    dataDir,
    // OCR 返回 20 行、每行约 300 字 → 合计约 6000 字，超过工具文档的 4000 上限
    respond: (action) => (action === 'ocr_image'
      ? { texts: Array.from({ length: 20 }, (_v, i) => ({ text: `第${i}行${'X'.repeat(296)}` })) }
      : {}),
    fetchHandler: (init, n) => {
      bodies.push(JSON.parse(init?.body || '{}'));
      if (n === 1) return replyTools([{ id: 'o1', name: 'read_image_text', args: { messageId: '5' } }]);
      if (n === 2) return replyTools([{ id: 'o2', name: 'send_message', args: { messages: '看完了' } }]);
      return replyText('');
    }
  }, async ({ sim, store, runner, sessions }) => {
    store.appendIncoming('group:1', {
      mid: 5, text: '帮我读图', senderId: '42', senderName: '群友',
      media: [{ kind: 'image', url: 'https://example.com/a.png' }]
    });
    await runner.wake('group:1', { manual: true });

    // 工具结果被截到 4000（文档上限），原始 ~6000 字不可能整串进提示词
    const toolMsg = bodies[1].messages.find((m) => m.role === 'tool' && m.tool_call_id === 'o1');
    assert.ok(toolMsg, 'OCR 结果要回到模型');
    const payload = JSON.parse(toolMsg.content);
    assert.equal(payload.text.length, 4000, 'OCR 结果按 ≤4000 字截断');
    assert.ok(String(toolMsg.content).length < 4200, '回给模型的那条不会远超上限');

    // 会话审计里进一步压到 2000（引用压缩）
    const audit = sessions.get(latestSession(sessions, 'group:1').id).messages
      .find((m) => m.toolCall?.name === 'read_image_text').toolCall.result;
    assert.equal(audit.length, 2000, '会话档案里的工具结果再压到 2000');

    // 运行照常结束并回复
    assert.deepEqual(wireTexts(sim, 1), ['看完了']);
  });
});

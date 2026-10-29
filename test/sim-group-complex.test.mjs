// 复杂多步场景：**真的** pipeline（OneBotClient / SendQueue / Orchestrator / ChatStore / 真工具）
// 打在**假的 SnowLuma HTTP 协议端**上，断言协议端实际收到的 action / 参数 / 顺序，以及库里的落账。
//
// 与 platform-simulated-group.test.mjs 同一套台架（假协议端 + 真客户端 + 真发送队列），
// 但这里专挑"跨子系统组合"的路径：混合消息段解析、并发双群、硬切分、失败定性/重试、
// 禁言/时间窗外、表情包开关的 wire 差异、配额闸门、补课窗口。
//
// 铁律：绝不碰真实 QQ / 真实协议端；每个用例一份独立临时数据目录 + 自己的假服务端。
import assert from 'node:assert/strict';
import { it } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// 配置落盘的目录在**动态 import 之前**固定（config-legacy 的 DATA_DIR 是模块级 const）：
// 先设好，别让 setRuntimeConfig / getConfig 的把 config.json 写进仓库 data/。
const bootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-simc-boot-'));
process.env.QQ_AGENT_DATA_DIR = bootDir;

const { ChatStore } = await import('../src/core/store.js');
const { SendQueue } = await import('../src/onebot/sender.js');
const { OneBotClient, segmentsToText } = await import('../src/onebot/onebot.js');
const { Orchestrator } = await import('../src/core/orchestrator.js');
const { SessionRegistry } = await import('../src/core/sessions.js');
const { buildToolDefs, resetPlatformQuotasForTest } = await import('../src/tools/tools-core.js');
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');
const { resetFaceCatalogForTest } = await import('../src/onebot/face-catalog.js');
const { catchupReplyWindowMs, isFreshForReply } = await import('../src/core/catchup-policy.js');

const FACE_NAMES = JSON.stringify({ bySid: { 14: '微笑', 128077: '强' } });

// ── 每个用例一份独立临时目录（Windows 上句柄可能没释放，rm 会 EPERM —— 清理失败不算失败）──
const caseDirs = [];
function makeCaseDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-simc-'));
  fs.writeFileSync(path.join(dir, 'face-names.json'), FACE_NAMES);
  // face-catalog 的目录是懒读 env 的：切目录后必须重置模块缓存，否则沿用上一份表情表
  process.env.QQ_AGENT_DATA_DIR = dir;
  resetFaceCatalogForTest();
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
  cfg.allow.private = ['2'];
  cfg.api.model = 'test';
  cfg.api.baseUrl = 'https://model.invalid';
  cfg.sticker.enabled = false;
  cfg.memory.consolidateEnabled = false;
  return cfg;
}

/**
 * 假 SnowLuma：POST /<action>，把 {action, params, headers} 记进 calls，回 {status:'ok',retcode:0,data}。
 * respond(action, params) 给 data；envelope(action, params) 可整体接管响应体（造失败响应用，返回 null 走默认）。
 */
function startFakeSnowLuma({ respond = () => ({}), envelope = null, port = 0 } = {}) {
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
      // envelope 可用 { __httpStatus, body } 造 HTTP 层失败（5xx=结果未知 / 4xx=确定被拒）
      if (override && override.__httpStatus) {
        res.writeHead(override.__httpStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify(override.body ?? { status: 'error' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(override ?? { status: 'ok', retcode: 0, data: respond(action, params) ?? {} }));
    });
  });
  return new Promise((resolve, reject) => {
    // 端口被别的进程抢走（CI 上并行跑时可能）时：拒绝，而不是留一个 'error' 事件让测试静默挂住
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const actual = server.address().port;
      resolve({
        calls,
        port: actual,
        url: `http://127.0.0.1:${actual}`,
        close: () => new Promise((r) => server.close(() => r())),
        byAction: (name) => calls.filter((c) => c.action === name),
        last: (name) => calls.filter((c) => c.action === name).at(-1)
      });
    });
  });
}

/** 轮询等到条件成立（或超时）：用"等某件事真的发生了"代替固定睡眠，慢机器上不会假红。 */
async function until(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return predicate();
}

/** 借一个当前空闲的端口（起个探针再关掉）：用于"第一次连不上、重试时服务已起"的确定失败用例。 */
function freePort() {
  return new Promise((resolve) => {
    const probe = http.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** 只挡模型端点：协议端的 127.0.0.1 必须放行给真 fetch，否则真客户端到不了假 SnowLuma。 */
function modelFetch(realFetch, sim, handler) {
  const fn = async (input, init) => {
    const url = String(typeof input === 'string' ? input : (input?.url ?? ''));
    if (url.startsWith(sim.url)) return realFetch(input, init);
    fn.modelCalls += 1;
    return handler(input, init);
  };
  fn.modelCalls = 0;
  return fn;
}

const tool = (name) => {
  const def = buildToolDefs().find((d) => d.name === name);
  assert.ok(def, `工具 ${name} 应存在`);
  return def;
};
const parse = (r) => JSON.parse(r.content);

/** 起假协议端 + 真客户端/队列/编排器，跑完 body 一起收摊。 */
async function runSim({ dataDir, respond, envelope = null, fetchHandler }, body) {
  const sim = await startFakeSnowLuma({ respond: respond ?? (() => ({})), envelope });
  const client = new OneBotClient({ wsUrl: 'ws://127.0.0.1:1', httpUrl: sim.url });
  const store = new ChatStore(0, { dataDir });
  const sessions = new SessionRegistry();
  const sender = new SendQueue({ store, onebot: client });
  const stickers = {
    sync: async () => ({ entries: [] }),
    findForSend: async () => ({ id: 'st1', url: 'base64://aGVsbG8=', localFile: 'f.png', desc: '测试表情' }),
    markUsed: async () => {}
  };
  const runner = new Orchestrator({
    store, sessions, sender, onebot: client, stickers,
    memory: { formatForPrompt: () => '' }
  });
  const realFetch = globalThis.fetch;
  const fetchStub = modelFetch(realFetch, sim, fetchHandler
    ?? (() => Response.json({ choices: [{ message: { content: '好' } }], usage: { total_tokens: 5 } })));
  globalThis.fetch = fetchStub;
  try {
    return await body({ sim, client, store, sessions, runner, sender, fetchStub });
  } finally {
    globalThis.fetch = realFetch;
    try { await runner.abortAll(); } catch { /* 已结束 */ }
    store.close();
    await sim.close();
  }
}

const outboxState = (store, chatKey) => store.db
  .prepare('SELECT state FROM outbox WHERE chat_key=? ORDER BY rowid DESC LIMIT 1')
  .get(chatKey)?.state;
const wireTexts = (sim, groupId = 1) => sim.byAction('send_group_msg')
  .filter((c) => c.params.group_id === groupId)
  .map((c) => c.params.message.filter((s) => s.type === 'text').map((s) => s.data.text).join(''));

// ═════════════ ① 混合消息段 ═════════════
// text + at + image + face + reply 一起进来：文本抽取、表情名回落、引用解析要各就各位，
// 且解析引用必须是对**那一条 id** 发 get_msg（协议端的 wire 证据），发出的回复也要带上同一个 id。
it('模拟群·混合段：文本/表情名/@ 抽取 + 引用按正确的 message_id 解析与回引用', async () => {
  setRuntimeConfig(baseConfig());
  const dataDir = makeCaseDir();
  await runSim({
    dataDir,
    respond: (action) => {
      if (action === 'get_msg') return { sender: { card: '阿卡林', user_id: 20002 }, message: [{ type: 'text', data: { text: '在吗' } }] };
      if (action === 'get_group_member_info') return { card: '群友甲', nickname: '群友甲' };
      return {};
    }
  }, async ({ sim, client, store, sender }) => {
    const segments = [
      { type: 'reply', data: { id: '555' } },
      { type: 'text', data: { text: '你好' } },
      { type: 'at', data: { qq: '20002' } },
      { type: 'image', data: { file: 'https://example.com/a.png', summary: '' } },
      { type: 'face', data: { id: 14 } },
      { type: 'text', data: { text: '快看' } }
    ];
    const text = await segmentsToText(segments, {
      selfId: '100',
      resolveReply: async (mid) => {
        const msg = await client.getMsg(mid);
        return {
          messageId: String(mid),
          sender: msg.sender.card,
          senderId: String(msg.sender.user_id),
          self: false,
          text: msg.message[0].data.text
        };
      },
      resolveAtName: async (qq) => (await client.getGroupMemberInfo('1001', qq)).card
    });

    assert.equal(text, '[引用#555·阿卡林：在吗]你好@群友甲[图片][QQ表情14微笑]快看',
      '文本抽取 + 表情名（14→微笑）+ @ 名字 + 引用块要拼出这一串（方括号内空白由 sanitize 折叠）');
    // 引用解析打的是被引用那一条的 id（不是别的）
    assert.equal(sim.byAction('get_msg').length, 1);
    assert.deepEqual(sim.last('get_msg').params, { message_id: 555 });
    assert.deepEqual(sim.last('get_group_member_info').params, { group_id: 1001, user_id: 20002 });

    // 出站：回复带上同一个 message_id 的 reply 段（挂在第一条前面）
    // 被引用的那条先落库，发送端才能据此把"回的是谁"记进自己的存档
    store.appendIncoming('group:1', { mid: 555, text: '在吗', senderId: '20002', senderName: '阿卡林' });
    await sender.sendTextBatch('group:1', ['收到'], { replyToMessageId: '555' });
    assert.deepEqual(sim.last('send_group_msg').params, {
      group_id: 1,
      message: [{ type: 'reply', data: { id: '555' } }, { type: 'text', data: { text: '收到' } }]
    });
    // 留档：引用目标（群友 20002）要落到自己的存档里
    const self = store.recent('group:1', { limit: 5 }).filter((m) => m.self).at(-1);
    assert.equal(self?.targetUserId, '20002', '回引用时留档的 targetUserId 应是被引用者');
  });
});

// ═════════════ ② 并发双群 ═════════════
// 两个群同时进入运行：各自的回复必须只落在自己群的 group_id 上，且同群多条保持队列顺序。
it('模拟群·并发双群：两个 drain 同时在飞时不串台，各自 group_id 与队列顺序都对', async () => {
  const cfg = baseConfig();
  cfg.allow.groups = ['1', '2'];
  cfg.maxConcurrentRuns = 2;
  setRuntimeConfig(cfg);
  const dataDir = makeCaseDir();
  await runSim({
    dataDir,
    respond: (action) => {
      if (action === 'get_group_info') return { group_name: '模拟群' };
      return {};
    },
    fetchHandler: (input, init) => {
      const body = JSON.parse(init?.body || '{}');
      const msgs = Array.isArray(body.messages) ? body.messages : [];
      const hasToolResult = msgs.some((m) => m.role === 'tool');
      if (hasToolResult) return Response.json({ choices: [{ message: { content: '好' } }], usage: { total_tokens: 5 } });
      const joined = msgs.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
      // 模型按"这一批里是谁的问题"回不同的话：串台就会被下面的断言抓到
      const replies = joined.includes('甲的问题') ? ['答甲一', '答甲二'] : ['答乙一'];
      return Response.json({
        choices: [{ message: { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'send_message', arguments: JSON.stringify({ messages: replies }) } }] } }],
        usage: { total_tokens: 5 }
      });
    }
  }, async ({ store, runner, sim }) => {
    store.appendIncoming('group:1', { mid: 11, text: '甲的问题', senderId: '41', senderName: '甲' });
    store.appendIncoming('group:2', { mid: 21, text: '乙的问题', senderId: '42', senderName: '乙' });
    await Promise.all([
      runner.wake('group:1', { manual: true }),
      runner.wake('group:2', { manual: true })
    ]);

    assert.deepEqual(wireTexts(sim, 1), ['答甲一', '答甲二'], '群 1 的两条要落在群 1，且保持队列顺序');
    assert.deepEqual(wireTexts(sim, 2), ['答乙一'], '群 2 只拿到自己那条');
    const groupIds = [...new Set(sim.byAction('send_group_msg').map((c) => c.params.group_id))].sort();
    assert.deepEqual(groupIds, [1, 2]);
  });
});

// ═════════════ ③ 硬切分 + 按长度附加延迟 ═════════════
it('模拟群·硬切分：按 send.hardSplitAt 切段（顺序/长度），关掉则不切；按字数附加的间隔确实生效', async () => {
  const cfg = baseConfig();
  cfg.send = { ...cfg.send, minGapMs: 200, maxGapMs: 200, byLengthMs: 200, hardSplitAt: 15 };
  setRuntimeConfig(cfg);
  const dataDir = makeCaseDir();
  await runSim({ dataDir }, async ({ sender, sim }) => {
    // A) 硬切：20 个字按 15 切 → [15, 5]，顺序与长度都对
    const aStart = Date.now();
    const a = await sender.sendTextBatch('group:1', ['A'.repeat(20)]);
    const aElapsed = Date.now() - aStart;
    assert.deepEqual(a.sent.map((s) => s.text.length), [15, 5], '切点与段数');
    assert.deepEqual(wireTexts(sim, 1), ['A'.repeat(15), 'A'.repeat(5)], '协议端收到的两段顺序/长度');
    assert.equal(sim.byAction('send_group_msg').length, 2);

    // B) 同样的文本、byLengthMs=0：不按字数附加间隔，明显更快
    setRuntimeConfig({ ...cfg, send: { ...cfg.send, byLengthMs: 0 } });
    const bStart = Date.now();
    await sender.sendTextBatch('group:1', ['A'.repeat(20)]);
    const bElapsed = Date.now() - bStart;
    assert.equal(sim.byAction('send_group_msg').length, 4, 'B 仍是两段');
    assert.ok(aElapsed >= 1200, `byLengthMs=200 时 15 字那段的间隔应 ≥1.2s（实测 ${aElapsed}ms）`);
    // 判据用**差值**而不是绝对上限：CI 机器慢只会把 A、B 一起抬高，差值仍稳定在 1.2s 上下；
    // 绝对上限（曾经是 `bElapsed <= 1000`）在负载高的 runner 上会抖（2026-10-08 审查）
    assert.ok(aElapsed - bElapsed >= 600,
      `byLengthMs=0 时不该有按字数的附加延迟（A ${aElapsed}ms − B ${bElapsed}ms = ${aElapsed - bElapsed}ms）`);

    // C) hardSplitAt=0：不限制长度 → 一整条
    setRuntimeConfig({ ...cfg, send: { ...cfg.send, hardSplitAt: 0 } });
    const before = sim.byAction('send_group_msg').length;
    await sender.sendTextBatch('group:1', ['A'.repeat(20)]);
    const added = sim.byAction('send_group_msg').slice(before);
    assert.equal(added.length, 1, 'hardSplitAt=0 时不该切');
    assert.equal(added[0].params.message[0].data.text, 'A'.repeat(20));
  });
});

// ═════════════ ④ 失败定性 + 重试 ═════════════
// 重试判定与 outbox 记账同一口径（classifyTransportFailure）：只有"确定没送达"的才重试一次。
// 全程走真 OneBotClient 到真 HTTP 服务端：确定失败靠"第一次连接被拒、重试时服务已起"来造，
// 结果未知靠协议端 5xx。sendText 的调用次数只做计数包装，实际请求仍由真客户端发出。
it('模拟群·失败定性：确定未送达重试一次后成功；协议端 5xx 不重试；一直连不上最多两次', async () => {
  const cfg = baseConfig();
  cfg.allow.groups = ['1', '11', '12', '13'];
  setRuntimeConfig(cfg);
  const dataDir = makeCaseDir();
  const store = new ChatStore(0, { dataDir });
  const countSends = (client) => {
    const real = client.sendText.bind(client);
    const wrapper = (...args) => { wrapper.calls += 1; return real(...args); };
    wrapper.calls = 0;
    client.sendText = wrapper;
    return wrapper;
  };
  try {
    // A) 第一次连不上（ECONNREFUSED=确定未送达）→ 重试 → 第二次服务已起、成功
    const portA = await freePort();
    const clientA = new OneBotClient({ wsUrl: 'ws://127.0.0.1:1', httpUrl: `http://127.0.0.1:${portA}` });
    const attemptsA = countSends(clientA);
    const senderA = new SendQueue({ store, onebot: clientA });
    const pending = senderA.sendTextBatch('group:11', ['hi']);
    // 等"第一次尝试真的已经发生"再起服务 —— 用固定睡眠是赌机器速度（CI 负载高时会赌输）
    await until(() => attemptsA.calls >= 1, 3000);
    assert.ok(attemptsA.calls >= 1, '第一次尝试应当已经发生（ECONNREFUSED 属确定未送达 → 会重试）');
    const simA = await startFakeSnowLuma({ port: portA });
    try {
      const a = await pending;
      assert.equal(attemptsA.calls, 2, '确定未送达的重试一次');
      assert.equal(a.sent.length, 1);
      assert.equal(simA.byAction('send_group_msg').length, 1, '重试那一次才真正到协议端');
      assert.equal(outboxState(store, 'group:11'), 'sent');
    } finally {
      await simA.close();
    }

    // B) 协议端 5xx（结果未知）→ 不自动重发；outbox 记 unknown
    const simB = await startFakeSnowLuma({
      envelope: (action) => (action === 'send_group_msg' ? { __httpStatus: 500, body: { status: 'error' } } : null)
    });
    const clientB = new OneBotClient({ wsUrl: 'ws://127.0.0.1:1', httpUrl: simB.url });
    const attemptsB = countSends(clientB);
    const senderB = new SendQueue({ store, onebot: clientB });
    try {
      await assert.rejects(() => senderB.sendTextBatch('group:12', ['hi']));
      assert.equal(attemptsB.calls, 1, '5xx 结果未知，一律不自动重发');
      assert.equal(simB.byAction('send_group_msg').length, 1);
      assert.equal(outboxState(store, 'group:12'), 'unknown', '未知写入要持有待人工核对');
    } finally {
      await simB.close();
    }

    // C) 一直连不上 → 只重试一次（共两次），最终抛错、记账 failed
    const portC = await freePort();
    const clientC = new OneBotClient({ wsUrl: 'ws://127.0.0.1:1', httpUrl: `http://127.0.0.1:${portC}` });
    const attemptsC = countSends(clientC);
    const senderC = new SendQueue({ store, onebot: clientC });
    await assert.rejects(() => senderC.sendTextBatch('group:13', ['hi']));
    assert.equal(attemptsC.calls, 2, '最多重试一次');
    assert.equal(outboxState(store, 'group:13'), 'failed', '确定未送达的记账为 failed（可重试）');
  } finally {
    store.close();
  }
});

// ═════════════ ⑤ 业务 retcode≠0 不重试，且不阻塞队列后面的消息 ═════════════
it('模拟群·业务失败：retcode≠0 只发一次（不按网络错误重试），失败条不阻塞后续条', async () => {
  setRuntimeConfig(baseConfig());
  const dataDir = makeCaseDir();
  // 含 FAIL 的那条被协议端按业务失败拒（retcode=120），其余照常成功
  await runSim({
    dataDir,
    envelope: (action, params) => {
      if (action !== 'send_group_msg') return null;
      const text = JSON.stringify(params?.message ?? '');
      return text.includes('FAIL') ? { status: 'failed', retcode: 120, wording: '被禁言' } : null;
    }
  }, async ({ sim, store, sender }) => {
    const result = await sender.sendTextBatch('group:1', ['FAIL这条', '正常这条']);
    assert.equal(result.sent.length, 1, '成功一条');
    assert.equal(result.failed.length, 1, '失败一条');
    assert.equal(result.failed[0].index, 0);
    assert.match(result.failed[0].error, /retcode=120/);
    // 失败条只被请求一次（业务失败不是"确定未送达"的传输错误，不自动重试）
    const failCalls = sim.byAction('send_group_msg').filter((c) => JSON.stringify(c.params).includes('FAIL'));
    assert.equal(failCalls.length, 1, 'retcode≠0 不重试');
    // 后面那条照常发出，证明失败条没有卡住队列
    assert.deepEqual(wireTexts(sim, 1), ['FAIL这条', '正常这条'], '失败条不阻塞后续条');
    assert.equal(outboxState(store, 'group:1'), 'sent', '最后一条（成功）的记账');
  });
});

// ═════════════ ⑥ 禁言预检 ═════════════
it('模拟群·禁言：发送前预检把消息拦下（不发协议端），消息仍在库里', async () => {
  setRuntimeConfig(baseConfig());
  const dataDir = makeCaseDir();
  const nowSec = () => Math.floor(Date.now() / 1000);
  await runSim({
    dataDir,
    respond: (action) => {
      if (action === 'get_group_member_info') return { shut_up_timestamp: nowSec() + 600 };
      return {};
    }
  }, async ({ sim, client, store, sender }) => {
    client.selfInfo = { user_id: 100, nickname: '犊子' };
    store.appendIncoming('group:1', { mid: 1, text: '在吗', senderId: '42', senderName: '群友' });
    const error = await sender.sendTextBatch('group:1', ['hi']).then(() => null, (e) => e);
    assert.equal(error?.code, 'GROUP_MUTED', '禁言错误带 GROUP_MUTED（工具据此不当事故）');
    assert.match(String(error?.message), /禁言中/);
    // 预检走的是真 HTTP：协议端确实被问过，但一条消息都没让它发
    assert.equal(sim.byAction('get_group_member_info').length, 1);
    assert.deepEqual(sim.last('get_group_member_info').params, { group_id: 1, user_id: 100 });
    assert.equal(sim.byAction('send_group_msg').length, 0, '禁言时不该调用协议端发送');
    assert.equal(outboxState(store, 'group:1'), undefined, '禁言拦截发生在 beginSend 之前，不产生 outbox');
    // 消息仍在库里、仍是未读（等解禁后还能处理）
    assert.equal(store.findByMid('group:1', 1)?.text, '在吗');
    assert.equal(store.getChatMeta('group:1').unread, 1);
  });
});

// ═════════════ ⑦ 时间窗外 ═════════════
it('模拟群·时间窗外：窗口外不唤醒/不发送，但消息照样落库', async () => {
  const cfg = baseConfig();
  // custom + 空窗口 = 任何时刻都非活跃（timeControlState 的 intervalsFor 返回空区间）
  cfg.timeControl = { enabled: true, schedule: { mode: 'custom', windows: [] }, overrides: {} };
  setRuntimeConfig(cfg);
  const dataDir = makeCaseDir();
  await runSim({ dataDir }, async ({ sim, store, runner, sender, fetchStub }) => {
    store.appendIncoming('group:1', { mid: 1, text: '时间外的消息', senderId: '42', senderName: '群友' });
    await runner.wake('group:1', { manual: true });
    assert.equal(fetchStub.modelCalls, 0, '窗口外不该调用模型');
    assert.equal(sim.byAction('send_group_msg').length, 0, '窗口外一条都不发');
    // 发送层自身也拒绝（不靠编排器兜底）
    await assert.rejects(() => sender.sendTextBatch('group:1', ['hi']), /非活跃时间/);
    assert.equal(sim.byAction('send_group_msg').length, 0);
    // 消息仍被记录（未读保留，等窗口内再处理）
    assert.equal(store.findByMid('group:1', 1)?.text, '时间外的消息');
    assert.equal(store.getChatMeta('group:1').unread, 1);
  });
});

// ═════════════ ⑧ 表情包开：wire 形态 ═════════════
it('模拟群·表情包开：send_sticker 是 image+sub_type=1+summary，send_face 是 face 段（不是图）', async () => {
  const cfg = baseConfig();
  cfg.sticker.enabled = true;
  setRuntimeConfig(cfg);
  const dataDir = makeCaseDir();
  await runSim({
    dataDir,
    respond: (action) => (action === 'get_group_info' ? { group_name: '模拟群' } : {}),
    fetchHandler: (input, init) => {
      const body = JSON.parse(init?.body || '{}');
      const hasToolResult = (body.messages || []).some((m) => m.role === 'tool');
      if (hasToolResult) return Response.json({ choices: [{ message: { content: '好' } }], usage: { total_tokens: 5 } });
      return Response.json({
        choices: [{ message: { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'send_sticker', arguments: '{"stickerId":"st1"}' } }] } }],
        usage: { total_tokens: 5 }
      });
    }
  }, async ({ sim, store, runner, client, sender }) => {
    store.appendIncoming('group:1', { mid: 1, text: '来个表情', senderId: '42', senderName: '群友' });
    await runner.wake('group:1', { manual: true });
    const stickerSends = sim.byAction('send_group_msg');
    assert.equal(stickerSends.length, 1, '贴纸应发出一条');
    assert.deepEqual(stickerSends[0].params.message, [
      { type: 'image', data: { file: 'base64://aGVsbG8=', sub_type: 1, summary: '[动画表情]' } }
    ], '贴纸走 image 段并带 sub_type/summary（QQ 才会渲染成表情而不是普通图）');

    // 对照组：QQ 系统表情走的是 face 段，与图片完全不同的形状
    const ctx = {
      kind: 'group', chatId: '1', chatKey: 'group:1',
      session: { id: 's', sent: [], leaseId: 'l' },
      onebot: client, sender, store, emit: () => {}
    };
    const r = parse(await tool('send_face').execute(ctx, { name: '微笑', text: '行' }));
    assert.equal(r.sent, true);
    assert.deepEqual(sim.last('send_group_msg').params.message, [
      { type: 'text', data: { text: '行' } },
      { type: 'face', data: { id: '14' } }
    ], '系统表情是 face 段，不是 image 段');
    assert.notEqual(sim.last('send_group_msg').params.message[1].type, 'image');
  });
});

// ═════════════ ⑨ 表情包关：工具被摘 ═════════════
it('模拟群·表情包关：send_sticker 工具被摘除（模型调了也是未知工具，协议端收不到图）', async () => {
  const cfg = baseConfig();
  cfg.sticker.enabled = false;
  setRuntimeConfig(cfg);
  const dataDir = makeCaseDir();
  const bodies = [];
  await runSim({
    dataDir,
    respond: (action) => (action === 'get_group_info' ? { group_name: '模拟群' } : {}),
    fetchHandler: (input, init) => {
      const body = JSON.parse(init?.body || '{}');
      bodies.push(body);
      const hasToolResult = (body.messages || []).some((m) => m.role === 'tool');
      if (hasToolResult) return Response.json({ choices: [{ message: { content: '好' } }], usage: { total_tokens: 5 } });
      return Response.json({
        choices: [{ message: { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'send_sticker', arguments: '{"stickerId":"st1"}' } }] } }],
        usage: { total_tokens: 5 }
      });
    }
  }, async ({ sim, store, runner }) => {
    store.appendIncoming('group:1', { mid: 1, text: '来个表情', senderId: '42', senderName: '群友' });
    await runner.wake('group:1', { manual: true });
    assert.equal(sim.byAction('send_group_msg').length, 0, '开关关掉后协议端不该收到任何图片');
    // 工具确实被摘了：模型拿回的是"未知工具"，不是一次失败的发送
    const toolResult = bodies.flatMap((b) => b.messages || []).find((m) => m.role === 'tool');
    assert.ok(toolResult, '应有一轮 tool 结果回到模型');
    assert.match(String(toolResult.content), /未知工具.*send_sticker/, '被摘掉的工具调用要回"未知工具"');
  });
});

// ═════════════ ⑩ 配额闸门 ═════════════
it('模拟群·配额：超出 reactionsPerHour 上限后拒绝，且不再打协议端', async () => {
  const cfg = baseConfig();
  cfg.platform = { ...cfg.platform, quotas: { ...cfg.platform.quotas, reactionsPerHour: 1 } };
  setRuntimeConfig(cfg);
  resetPlatformQuotasForTest();
  const dataDir = makeCaseDir();
  try {
    await runSim({ dataDir }, async ({ sim, client }) => {
      const ctx = {
        kind: 'group', chatId: '1', chatKey: 'group:1',
        session: { id: 's', sent: [], leaseId: 'l' },
        onebot: client, store: { findByMid: () => null, recent: () => [] }, emit: () => {}
      };
      const first = parse(await tool('react_to_message').execute(ctx, { messageId: '77', emojiId: 14 }));
      assert.equal(first.reacted, true);
      assert.deepEqual(sim.last('set_msg_emoji_like').params, { message_id: 77, emoji_id: '14', set: true });

      const second = await tool('react_to_message').execute(ctx, { messageId: '78', emojiId: 14 });
      assert.equal(second.isError, true, '超限要被拒');
      assert.match(String(second.content), /够多了/);
      assert.match(String(second.content), /上限 1 次/);
      assert.equal(sim.byAction('set_msg_emoji_like').length, 1, '被拒的那次绝不能打到协议端');
    });
  } finally {
    resetPlatformQuotasForTest();
    setRuntimeConfig(baseConfig());
  }
});

// ═════════════ ⑪ 补课窗口 ═════════════
// 补课循环本身在 src/console/app.js 的闭包里（import 不到），但它的判定函数是 core/catchup-policy.js，
// 落库语义是 store.appendIncoming(recordOnly) —— 这里把"窗口判定 + 落库状态 + 编排器只看新鲜消息"
// 串成一条链来验。
it('模拟群·补课窗口：超窗消息只补记录（不进未读、不回复），窗口内的照常回复', async () => {
  const cfg = baseConfig();
  cfg.onebot = { ...cfg.onebot, catchupReplyWindowMs: 30 * 60 * 1000 };
  setRuntimeConfig(cfg);
  const dataDir = makeCaseDir();
  const windowMs = catchupReplyWindowMs(cfg);
  const now = Date.now();
  const oldTs = now - windowMs - 60_000;
  const freshTs = now - 60_000;
  assert.equal(isFreshForReply(oldTs, now, windowMs), false, '窗口外的判定');
  assert.equal(isFreshForReply(freshTs, now, windowMs), true, '窗口内的判定（含边界语义由 policy 单测覆盖）');

  await runSim({
    dataDir,
    respond: (action) => (action === 'get_group_info' ? { group_name: '模拟群' } : {}),
    fetchHandler: (input, init) => {
      const body = JSON.parse(init?.body || '{}');
      const hasToolResult = (body.messages || []).some((m) => m.role === 'tool');
      if (hasToolResult) return Response.json({ choices: [{ message: { content: '好' } }], usage: { total_tokens: 5 } });
      return Response.json({
        choices: [{ message: { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'send_message', arguments: '{"messages":"收到"}' } }] } }],
        usage: { total_tokens: 5 }
      });
    }
  }, async ({ sim, store, runner }) => {
    // 真实补课路径：超窗的 recordOnly=true（state=acked），窗口内的正常未读
    store.appendIncoming('group:1', { mid: 1, ts: oldTs, text: '一小时前的老消息', senderId: '42', senderName: '群友' },
      { recordOnly: !isFreshForReply(oldTs, now, windowMs) });
    store.appendIncoming('group:1', { mid: 2, ts: freshTs, text: '刚发的新消息', senderId: '43', senderName: '群友乙' },
      { recordOnly: !isFreshForReply(freshTs, now, windowMs) });

    assert.equal(store.findByMid('group:1', 1).state, 'acked', '超窗消息只补记录（不进未读）');
    assert.equal(store.findByMid('group:1', 2).state, 'pending', '窗口内的仍是未读');
    assert.deepEqual(store.peekUnread('group:1').map((m) => m.text), ['刚发的新消息'],
      '编排器看到的未读只该有窗口内那条');
    // 两条都确实落库了（"只补记录"≠"扔掉"）
    assert.equal(store.getChatMeta('group:1').total, 2);

    await runner.wake('group:1', { manual: true });
    assert.deepEqual(wireTexts(sim, 1), ['收到'], '只对窗口内那条回一次');
  });
});

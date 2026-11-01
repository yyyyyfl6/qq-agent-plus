// Issue #21 根因修复的行为用例：SnowLuma 1.14.15 的 OneBot HTTP 端点对请求体有 ≈2MiB
// 上限（实测 2MB 过 / 2.5MB 被掐），生成贴纸是整张图 base64，正好压线 —— "时好时坏"。
// 修复：超过 HTTP_BODY_SAFE_MAX 的调用自动改走 WebSocket 通道（同版本实测 3MB 无恙）；
// 顺带：incident 落库补 cause 链（undici 外层恒为 "fetch failed"，真因在 cause 里）。
//
// 断言纪律（2026-10-07 复核补齐）：
//   1. 大请求经 WS 时，必须验证服务端收到的 params 载荷完整（只查"发了帧"挡不住"漏带 params"）；
//   2. 断线/断链类用例先等帧真的到达服务端再动手，不用魔法 sleep 撑时序；
//   3. 假服务端只对带 echo 的帧应答（真实协议端行为），并记录 HTTP 请求体。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-ws-oversize-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 句柄延迟释放 */ } });

const { OneBotClient } = await import('../src/onebot/onebot.js');
const { IncidentPilotManager } = await import('../src/pilots/incident-pilot.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 与 src/onebot/onebot.js 的 HTTP_BODY_SAFE_MAX 对齐（改了常量必须同步改这里，
// 阈值边界用例会立刻红）。overhead = JSON.stringify({ big: '' }).length。
const BODY_SAFE_MAX = 1536 * 1024;
const BIG_JSON_OVERHEAD = Buffer.byteLength(JSON.stringify({ big: '' }));
const BIG = 'A'.repeat(2 * 1024 * 1024);

// 全量并行跑时机器很卡：心跳 ping 的 pong 一旦晚于 2 秒 kill 窗口，客户端就会掐连接
// （code=1006 → 重连风暴，用例全体超时）。心跳不是这些用例的被测对象，直接关掉。
async function waitConnected(client, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (client.connected) return true;
    await sleep(25);
  }
  return client.connected;
}

/** 轮询等一个可判定条件（替代 sleep 撑时序）；超时即断言失败并说明前提。 */
async function waitFor(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(10);
  }
  assert.ok(predicate(), `前提：${label}（${timeoutMs}ms 内）`);
  return true;
}

/** 一套假协议端：WS 服务端（echo 应答 + 可主动推事件/扣住不回）+ HTTP 计数服务端。 */
async function makeFakes(t, { wsReplyDelayMs = 0, wsStatus = 'ok', holdActions = [] } = {}) {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.on('listening', r));
  const wsPort = wss.address().port;
  const wsReceived = [];
  const holdSet = new Set(holdActions);   // 这些 action 收到后故意不回（测超时/断线）
  let clientSocket = null;
  wss.on('connection', (socket) => {
    clientSocket = socket;
    socket.on('message', (data) => {
      let frame = null;
      try { frame = JSON.parse(String(data)); } catch { return; }
      if (!frame || typeof frame !== 'object') return;
      wsReceived.push(frame);
      // 真实协议端只对带 echo 的调用帧应答；事件帧（客户端不会发）不回。
      if (frame.echo === undefined) return;
      if (holdSet.has(frame.action)) return;   // 扣住不回
      const reply = { status: wsStatus, retcode: wsStatus === 'ok' ? 0 : 1200, data: { message_id: 777, echoed: frame.echo }, echo: frame.echo };
      if (wsReplyDelayMs > 0) setTimeout(() => socket.send(JSON.stringify(reply)), wsReplyDelayMs);
      else socket.send(JSON.stringify(reply));
    });
  });

  const httpRequests = [];
  const httpServer = http.createServer((req, res) => {
    // ⚠️ 必须消费请求体：没有 data/resume 时流处于 paused 态，'end' 永不触发，假服务端
    // 就永远不响应 —— 所有调用挂到各自的超时（lint 修 no-unused-vars 时踩过这个坑）。
    // 顺带把 body 收下来：断言"回落 HTTP 时确实带了完整载荷"，而不是只查了路径。
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      httpRequests.push({ path: String(req.url || ''), body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { via: 'http', path: req.url } }));
    });
  });
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const httpPort = httpServer.address().port;

  const events = [];
  const client = new OneBotClient({
    wsUrl: `ws://127.0.0.1:${wsPort}`,
    httpUrl: `http://127.0.0.1:${httpPort}`,
    accessToken: 'test-token',
    onEvent: (e) => events.push(e),
    heartbeat: 'off'
  });
  t.after(async () => {
    client.close();
    await new Promise((r) => wss.close(r));
    await new Promise((r) => httpServer.close(r));
  });
  await client.connect();
  assert.ok(await waitConnected(client), '前提：WS 建联（8 秒内）');
  return {
    client, wss, wsReceived, events, httpServer,
    get httpPaths() { return httpRequests.map((r) => r.path); },
    get httpRequests() { return httpRequests; },
    get socket() { return clientSocket; },
    holdReplies: holdSet
  };
}

test('超过 HTTP 安全阈值的大请求自动改走 WS，HTTP 零请求，且载荷完整送达', async (t) => {
  const f = await makeFakes(t);
  const big = { message_type: 'group', group_id: 1, big: 'A'.repeat(2 * 1024 * 1024) };
  const data = await f.client.call('send_group_msg', big, 5000);
  assert.equal(data.message_id, 777, 'WS 应答要被正确解析返回');
  assert.equal(f.httpPaths.filter((p) => p.includes('send_group_msg')).length, 0,
    `大请求不许走 HTTP（HTTP 收到的路径：${f.httpPaths.join(', ')}）`);
  assert.equal(f.wsReceived.length >= 1, true);
  assert.equal(f.wsReceived[0].action, 'send_group_msg');
  assert.ok(f.wsReceived[0].echo, 'WS 调用必须带 echo');
  // 最核心的不变式：params 必须原样在线（只断言"发了帧"挡不住"漏带 params"——
  // 那正是 Issue #21 里"图发不出去"的形态）。
  assert.equal(f.wsReceived[0].params.big.length, 2 * 1024 * 1024, 'payload 必须完整');
  assert.equal(f.wsReceived[0].params.group_id, 1);
  assert.equal(f.wsReceived[0].params.message_type, 'group');
});

test('小请求仍走原 HTTP 路线（守卫不许变成一律走 WS），且请求体完整', async (t) => {
  const f = await makeFakes(t);
  const data = await f.client.call('get_version_info', {}, 5000);
  assert.equal(data.via, 'http');
  assert.equal(f.httpPaths.filter((p) => p.includes('get_version_info')).length, 1, '小请求应走 HTTP');
  assert.equal(f.wsReceived.filter((fr) => fr.action === 'get_version_info').length, 0, '小请求不该上 WS');
  assert.equal(f.httpRequests[0].body, '{}', 'HTTP 请求体要带上（发空体也算"漏带 params"）');
});

test('阈值边界：恰好等于上限仍走 HTTP，多 1 字节改走 WS', async (t) => {
  const f = await makeFakes(t);
  const exact = 'A'.repeat(BODY_SAFE_MAX - BIG_JSON_OVERHEAD);
  assert.equal(Buffer.byteLength(JSON.stringify({ big: exact })), BODY_SAFE_MAX, '构造的前提：恰好等于阈值');
  await f.client.call('get_version_info', { big: exact }, 5000);
  assert.equal(f.httpPaths.filter((p) => p.includes('get_version_info')).length, 1, '== 阈值仍走 HTTP（判定是 >）');
  assert.equal(f.wsReceived.length, 0);

  const over = 'A'.repeat(BODY_SAFE_MAX - BIG_JSON_OVERHEAD + 1);
  await f.client.call('send_group_msg', { big: over }, 5000);
  assert.equal(f.wsReceived.length, 1, '> 阈值必须改走 WS');
  assert.equal(f.wsReceived[0].params.big.length, over.length);
});

test('WS 响应 status=failed 按明确失败结清（口径与 HTTP 通道一致）', async (t) => {
  const f = await makeFakes(t, { wsStatus: 'failed' });
  await assert.rejects(
    () => f.client.call('send_group_msg', { big: 'A'.repeat(2 * 1024 * 1024) }, 5000),
    (error) => error.name === 'OneBotActionError' && error.outcome === 'failed' && /retcode=1200/.test(error.message)
  );
});

test('WS 中途断线：在途调用立即按 unknown 结清，不挂到超时', async (t) => {
  const f = await makeFakes(t, { holdActions: ['send_group_msg'] });   // 服务端收下但永不回
  const pendingCall = f.client.call('send_group_msg', { big: BIG }, 30000);
  // 等大帧真的落到服务端（"在途"这个前提必须被断言，不能靠 sleep 猜）
  await waitFor(() => f.wsReceived.length >= 1, '大帧已送达服务端');
  for (const socket of f.wss.clients) socket.terminate();   // 服务端掐断
  await assert.rejects(() => pendingCall, (error) => {
    assert.match(error.message, /断开|投递状态未知/);
    assert.equal(error.outcome, 'unknown', '断线 = 不知道对方收没收到，必须 unknown');
    return true;
  });
});

test('WS 响应超时按 unknown 结清', async (t) => {
  const f = await makeFakes(t, { holdActions: ['send_group_msg'] });   // 服务端收下但永不回
  await assert.rejects(
    () => f.client.call('send_group_msg', { big: BIG }, 400),
    (error) => error.name === 'OneBotActionError' && error.outcome === 'unknown' && /超时/.test(error.message)
  );
});

test('WS 调用期间事件帧照常分发（共用通道不许互吞）', async (t) => {
  const f = await makeFakes(t, { wsReplyDelayMs: 400 });
  const pendingCall = f.client.call('send_group_msg', { big: BIG }, 8000);
  // 大帧已到、应答还在路上 —— 这个时序前提先被断言再推事件帧
  await waitFor(() => f.wsReceived.some((fr) => fr.action === 'send_group_msg'), '大帧已送达');
  for (const socket of f.wss.clients) {
    socket.send(JSON.stringify({ post_type: 'message', message_type: 'group', group_id: 9, raw_message: 'hello' }));
  }
  await pendingCall;
  const got = f.events.find((e) => e?.post_type === 'message');
  assert.ok(got, '事件帧必须照常进 onEvent（不许被 echo 应答逻辑吞掉）');
  assert.equal(got.group_id, 9);
});

test('WS send 回调报错（帧确定没写进 socket）按 failed 结清', async (t) => {
  const f = await makeFakes(t);
  // 伪造"连接标志还在、socket 已死"的窗口：readyState 仍装 OPEN 但 send 回调立刻报错
  // —— 这是 ws 对 CLOSING/CLOSED 的真实形态（readyState 非 OPEN 时走回调报错）。
  const deadSocket = {
    readyState: 1,
    send: (payload, cb) => { cb(new Error('WebSocket is not open: readyState 2')); }
  };
  const realSocket = f.client.socket;
  f.client.socket = deadSocket;
  try {
    await assert.rejects(
      () => f.client.call('send_group_msg', { big: BIG }, 5000),
      (error) => {
        assert.equal(error.outcome, 'failed', 'send 回调报错 = 确定未投递，必须 failed（unknown 会升级成 critical 人工核对）');
        assert.match(error.message, /WS 发送失败/);
        return true;
      }
    );
  } finally {
    f.client.socket = realSocket;
  }
});

test('WS 未连接时大请求回落 HTTP（保留原有网络行为 + 告警日志 + 完整载荷）', async (t) => {
  const f = await makeFakes(t);
  // 模拟 WS 掉了：connected=false、socket 为空 —— call 应照旧走 HTTP 而不是拒绝
  f.client.connected = false;
  const realSocket = f.client.socket;
  f.client.socket = null;
  const warns = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warns.push(args.map(String).join(' '));
  try {
    const big = { message_type: 'group', group_id: 1, big: 'A'.repeat(2 * 1024 * 1024) };
    const data = await f.client.call('send_group_msg', big, 5000);
    assert.equal(data.via, 'http', 'WS 未连接时大请求回落 HTTP');
    const sent = f.httpRequests.find((r) => r.path.includes('send_group_msg'));
    assert.ok(sent, `回落必须真的发出（HTTP 收到：${f.httpPaths.join(', ')}）`);
    assert.ok(sent.body.includes('"big"') && sent.body.length > 2 * 1024 * 1024, '回落时也要带完整 payload');
    assert.ok(warns.some((line) => /超过 HTTP 安全阈值且 WS 未连接/.test(line)),
      `要有告警日志（否则这条降级路径完全不可见），实际：${warns.join(' | ')}`);
  } finally {
    console.warn = originalWarn;
    f.client.connected = true;
    f.client.socket = realSocket;
  }
});

test('callViaWs 直连兜底：未连接时按 failed 拒绝（确定没写进任何连接）', async (t) => {
  const f = await makeFakes(t);
  const realSocket = f.client.socket;
  f.client.connected = false;
  f.client.socket = null;
  try {
    await assert.rejects(
      () => f.client.callViaWs('send_group_msg', { big: BIG }, 5000),
      (error) => error.name === 'OneBotActionError' && error.outcome === 'failed' && /未连接/.test(error.message)
    );
  } finally {
    f.client.connected = true;
    f.client.socket = realSocket;
  }
});

test('并发在途 WS 调用各拿各的 echo 应答，不串扰', async (t) => {
  const f = await makeFakes(t);
  const [r1, r2] = await Promise.all([
    f.client.call('send_group_msg', { big: BIG, tag: 1 }, 8000),
    f.client.call('set_group_card', { big: BIG, tag: 2 }, 8000)
  ]);
  assert.notEqual(r1.echoed, r2.echoed, '两个在途调用必须拿到各自 echo 的应答');
  assert.equal(r1.echoed, 'ws_1');
  assert.equal(r2.echoed, 'ws_2');
  assert.equal(f.wsReceived.filter((fr) => fr.echo).length, 2);
});

test('signal 预中止 / 在途中止：按中止原因结清，wsPending 不留残骸', async (t) => {
  const f = await makeFakes(t, { holdActions: ['send_group_msg'] });
  // 预中止：立即按 reason 拒绝，帧不下发
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(
    () => f.client.call('send_group_msg', { big: BIG }, 5000, pre.signal),
    (error) => error.name === 'AbortError'
  );
  assert.equal(f.wsReceived.length, 0, '预中止的帧根本不该发出');

  // 在途中止：帧已发出后 abort —— 按 reason 结清（不是超时、不是 unknown）
  const inflight = new AbortController();
  const pending = f.client.call('send_group_msg', { big: BIG }, 30000, inflight.signal);
  await waitFor(() => f.wsReceived.length >= 1, '在途帧已送达');
  inflight.abort(new Error('测试取消'));
  await assert.rejects(() => pending, (error) => /测试取消/.test(String(error.message)));

  // 残骸自证：中止后新调用不受影响（服务端此刻仍在扣着 send_group_msg 不回）
  const other = await f.client.call('get_group_info', { big: BIG }, 5000);
  assert.equal(other.message_id, 777);
});

test('close() 会把在途 WS 调用按 unknown 结清并给出关闭原因', async (t) => {
  const f = await makeFakes(t, { holdActions: ['send_group_msg'] });
  const pending = f.client.call('send_group_msg', { big: BIG }, 30000);
  await waitFor(() => f.wsReceived.length >= 1, '在途帧已送达');
  f.client.close();
  await assert.rejects(() => pending, (error) => {
    assert.equal(error.outcome, 'unknown');
    assert.match(error.message, /已关闭/);
    return true;
  });
});

test('reconnect() 立刻作废连接态与在途调用，重连后大请求仍走 WS', async (t) => {
  const f = await makeFakes(t, { holdActions: ['send_group_msg'] });
  const pending = f.client.call('send_group_msg', { big: BIG }, 30000);
  await waitFor(() => f.wsReceived.length >= 1, '在途帧已送达');
  await f.client.reconnect();
  // 连接态必须立刻为 false（新 socket 还在 CONNECTING）——否则大请求会交给连不上的 socket
  assert.equal(f.client.connected, false, 'reconnect 后、重连完成前必须处于未连接态');
  await assert.rejects(() => pending, (error) => {
    assert.equal(error.outcome, 'unknown');
    assert.match(error.message, /正在重连/);
    return true;
  });
  assert.ok(await waitConnected(f.client), '重连应在 8 秒内完成');
  // 新连接上的大请求照常走 WS
  f.holdReplies.delete('set_group_card');
  const data = await f.client.call('set_group_card', { big: BIG }, 8000);
  assert.equal(data.message_id, 777);
});

test('sendSticker 端到端：整图 base64 超阈值时整条链路自动落到 WS', async (t) => {
  const f = await makeFakes(t);
  const image = `base64://${'A'.repeat(2 * 1024 * 1024)}`;   // ≈2MiB base64 的本地贴纸形态
  const data = await f.client.sendSticker('group', 12345, image);
  assert.equal(data.message_id, 777);
  // 建联时的 get_login_info 走 HTTP 属正常噪声，这里只禁"发送类"请求走 HTTP
  assert.equal(f.httpPaths.filter((p) => /send_/.test(p)).length, 0,
    `贴纸发送不允许走 HTTP（Issue #21 就是这条路径被掐），实际：${f.httpPaths.join(', ')}`);
  const frame = f.wsReceived.at(-1);
  assert.equal(frame.action, 'send_group_msg');
  assert.equal(String(frame.params.group_id), '12345');
  const segment = frame.params.message.find((s) => s.type === 'image');
  assert.equal(segment.data.file, image, 'image 段必须带完整 base64（不是被截断或漏带）');
  assert.equal(segment.data.sub_type, 1, '贴纸要带 sub_type=1（表情呈现，2026-10-07）');
  assert.equal(segment.data.summary, '[动画表情]', '贴纸要带 [动画表情] 摘要（表情呈现）');
});

// ── incident 落库补 cause 链 ──
test('incident：undici 外层 "fetch failed" 的真因（cause 链）要落进消息', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-incident-cause-'));
  const cfg = {
    incidentPilot: {
      enabled: true, graduated: false, ownerUin: '10000003', notifyWarnings: true,
      duplicateWindowMinutes: 10, unknownWritesBlockChat: false, retentionDays: 90
    }
  };
  const manager = new IncidentPilotManager({
    dataDir,
    config: () => cfg,
    notifyAvailable: () => true,
    notify: async () => {},
    now: () => Date.now(),
    emit: () => {},
    log: () => {}
  });
  manager.start();   // active 的前提是 db 已建（capture 在未 start 时返回 null）
  t.after(async () => {
    await manager.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const undiciStyle = new TypeError('fetch failed', {
    cause: Object.assign(new Error('other side closed'), { code: 'ECONNRESET' })
  });
  const incident = manager.capture(undiciStyle, { source: 'onebot', category: 'external_write' });
  assert.ok(incident, '前提：incident 已捕获');
  assert.match(incident.message, /fetch failed/);
  assert.match(incident.message, /ECONNRESET/, `真因 code 必须进消息（面板才有的看），实际：${incident.message}`);
  assert.match(incident.message, /other side closed/, '真因 message 也要进消息');

  const noCause = manager.capture(new Error('普通错误没有 cause'), { source: 'onebot', category: 'external_write', code: 'PLAIN_ERROR' });
  assert.ok(noCause);
  assert.doesNotMatch(noCause.message, /真因/, '没有 cause 的错误保持原样（不许拼出空真因）');
});

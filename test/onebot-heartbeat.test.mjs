// WebSocket 心跳与 NapCat 的兼容（Issue #22）。
//
// 报告人实测：NapCat 的 OneBot WS 服务端不回应 PING，而是直接销毁连接 —— 客户端看到
// close code=1006、全程 0 次 pong。老实现 30 秒发一次 ping，于是连接生命周期被压到约
// 30 秒（每轮还有 3~4 秒接收盲窗），而 close 回调一行日志都没有，只能靠 catchup 计数反推。
//
// 这里的用例用真实 `ws` 起一个"NapCat 行为"的服务端（autoPong:false + 收到 ping 就 terminate）
// 和一个正常服务端（默认 autoPong，会回 pong），验证三件事：
//   ① 被 ping 断开时：留下警告 + 断开日志；此后重连不再发 ping（auto 模式）；
//   ② 正常对端：照常发 ping、不被误判（不能因为修 NapCat 把"发现半开连接"的能力丢掉）；
//   ③ 显式 on / off 覆盖自适应判断。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-onebot-heartbeat-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ runtime: { mode: 'active' } }));

const { OneBotClient } = await import('../src/onebot/onebot.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(20);
  }
  return predicate();
}

/** 捕获 console 输出（心跳/断线的行为全在日志里，不抓就断言不了）。 */
function captureConsole() {
  const lines = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  const wrap = (level) => (...args) => { lines.push(`${level} ${args.map(String).join(' ')}`); };
  console.log = wrap('log');
  console.warn = wrap('warn');
  console.error = wrap('error');
  return {
    lines,
    text: () => lines.join('\n'),
    restore() { Object.assign(console, originals); }
  };
}

/** 起一个协议端：poke=true 时模拟 NapCat（不回 pong，收到 ping 直接销毁连接）。 */
async function startOneBotServer({ poke = false } = {}) {
  const wss = new WebSocketServer({ port: 0, autoPong: !poke });
  await new Promise((resolve) => wss.once('listening', resolve));
  const pingsPerConnection = [];
  let connections = 0;
  const sockets = [];
  wss.on('connection', (socket) => {
    const index = connections++;
    sockets.push(socket);
    pingsPerConnection[index] = 0;
    socket.on('ping', () => {
      pingsPerConnection[index] += 1;
      if (poke) socket.terminate();     // NapCat：不答 pong，直接销毁
    });
  });
  return {
    port: wss.address().port,
    pingsPerConnection,
    connections: () => connections,
    sockets,
    close: () => new Promise((resolve) => wss.close(resolve))
  };
}

test('auto 模式：对端收到 ping 就断开 → 警告 + 断开日志，重连后不再发 ping', async (t) => {
  const server = await startOneBotServer({ poke: true });
  const logs = captureConsole();
  const bot = new OneBotClient({
    wsUrl: `ws://127.0.0.1:${server.port}`,
    httpUrl: 'http://127.0.0.1:1',
    heartbeat: 'auto',
    heartbeatMs: 40
  });
  t.after(async () => { logs.restore(); bot.close(); await server.close(); });

  await bot.connect();
  assert.ok(await waitFor(() => bot.pingUnsupported), '发出 ping 被杀之后应标记"对端不吃 ping"');
  assert.match(logs.text(), /收到 WebSocket PING 后立即断开/, '要有一条说清原因（NapCat）的警告');
  assert.match(logs.text(), /连接已断开（code=1006/, '断开事件必须留日志（这是 Issue #22 最难查的一点）');
  assert.equal(server.pingsPerConnection[0], 1, '第一条连接只发过一次 ping');

  // 不等 3 秒退避，直接再连一次：第二条连接不许再发 ping
  bot.reconnect();
  assert.ok(await waitFor(() => server.connections() >= 2), '应重连出第二条连接');
  await sleep(150);   // 覆盖两个以上心跳周期
  assert.equal(server.pingsPerConnection[1], 0, 'auto 模式下第二条连接不再发 ping');
  assert.equal(bot.connected, true, '不发 ping 的连接本身是健康的（NapCat 不会主动断它）');
});

test('auto 模式：正常对端（会回 pong）照常心跳，不被误判', async (t) => {
  const server = await startOneBotServer({ poke: false });
  const logs = captureConsole();
  const bot = new OneBotClient({
    wsUrl: `ws://127.0.0.1:${server.port}`,
    httpUrl: 'http://127.0.0.1:1',
    heartbeat: 'auto',
    heartbeatMs: 40
  });
  t.after(async () => { logs.restore(); bot.close(); await server.close(); });

  await bot.connect();
  assert.ok(await waitFor(() => (server.pingsPerConnection[0] || 0) >= 2), '正常对端要持续收到 ping');
  assert.equal(bot.pingUnsupported, false, '有 pong 的对端不能被标成"不吃 ping"');
  assert.doesNotMatch(logs.text(), /收到 WebSocket PING 后立即断开/);
  assert.doesNotMatch(logs.text(), /连接已断开/, '健康连接不该有断开日志');
  assert.equal(bot.connected, true);
});

test('显式 on / off 覆盖自适应：on 被断开也继续发；off 从不发', async (t) => {
  const logs = captureConsole();
  t.after(() => logs.restore());

  // on：NapCat 式对端，第一条被杀之后第二条仍要发 ping（用户显式要求）
  {
    const server = await startOneBotServer({ poke: true });
    const bot = new OneBotClient({
      wsUrl: `ws://127.0.0.1:${server.port}`, httpUrl: 'http://127.0.0.1:1',
      heartbeat: 'on', heartbeatMs: 40
    });
    await bot.connect();
    assert.ok(await waitFor(() => (server.pingsPerConnection[0] || 0) >= 1));
    assert.equal(bot.pingUnsupported, false, 'on 模式不做自适应判断');
    bot.reconnect();
    assert.ok(await waitFor(() => server.connections() >= 2));
    assert.ok(await waitFor(() => (server.pingsPerConnection[1] || 0) >= 1), 'on 模式第二条连接仍要发 ping');
    bot.close();
    await server.close();
  }

  // off：NapCat 式对端也不会被杀（我们根本不发 ping），连接保持
  {
    const server = await startOneBotServer({ poke: true });
    const bot = new OneBotClient({
      wsUrl: `ws://127.0.0.1:${server.port}`, httpUrl: 'http://127.0.0.1:1',
      heartbeat: 'off', heartbeatMs: 40
    });
    await bot.connect();
    await sleep(150);
    assert.equal(server.pingsPerConnection[0], 0, 'off 模式一个 ping 都不发');
    assert.equal(bot.connected, true, '不发 ping 就不会被 NapCat 断，连接应该是活的');
    bot.close();
    await server.close();
  }

  // 非法值按 auto 兜底
  {
    const bot = new OneBotClient({ wsUrl: 'ws://127.0.0.1:1', httpUrl: 'http://127.0.0.1:1', heartbeat: 'banana' });
    assert.equal(bot.heartbeatMode, 'auto');
    bot.close();
  }
});

test('入站新鲜度：收到事件/心跳就记时间（连接还在但事件停了要能被发现）', async () => {
  const server = await startOneBotServer();
  const bot = new OneBotClient({
    wsUrl: `ws://127.0.0.1:${server.port}`, httpUrl: 'http://127.0.0.1:1',
    heartbeat: 'off'
  });
  await bot.connect();
  assert.equal(await waitFor(() => server.sockets.length > 0), true, '应该有连接');
  assert.equal(bot.lastEventAt, 0, '还没收到事件时是 0（控制台据此显示"尚未收到"）');
  assert.equal(bot.lastHeartbeatAt, 0);

  const socket = server.sockets[0];
  socket.send(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'heartbeat', time: 1, self_id: 100 }));
  assert.equal(await waitFor(() => bot.lastHeartbeatAt > 0), true, '心跳应记进 lastHeartbeatAt');
  assert.equal(bot.lastHeartbeatAt, bot.lastEventAt, '心跳也算入站事件');

  const before = bot.lastEventAt;
  await new Promise((resolve) => setTimeout(resolve, 5));
  socket.send(JSON.stringify({ post_type: 'message', message_type: 'private', time: 2, self_id: 100, user_id: 1, message: [] }));
  assert.equal(await waitFor(() => bot.lastEventAt > before), true, '普通消息也要刷新 lastEventAt');
  assert.equal(bot.lastHeartbeatAt < bot.lastEventAt, true, '普通消息不该改心跳时间');
  bot.close();
  await server.close();
});

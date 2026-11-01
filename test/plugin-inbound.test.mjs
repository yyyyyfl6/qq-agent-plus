// 插件 v3 入站 HTTP（src/plugins/inbound.js）：不走控制台令牌的唯一入口，宿主在这里守住能守的。
// 钉住：只认 /plugin-hooks/<id>/（独立端口可设根路径插件）、只转发白名单请求头、体积 / 频率 / 方法上限、
// JSON 解析、注册表默认拒（未启用 / 没声明 inbound → 404）。
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { createInboundHandler } from '../src/plugins/inbound.js';
import { parsePluginManifest } from '../src/plugins/manifest.js';

function fakeRegistry() {
  const seen = [];
  return {
    seen,
    inbound: async (id, request) => {
      seen.push({ id, request });
      if (id !== 'phone') return { status: 404, body: { ok: false, message: 'not found' } };
      return { status: 200, body: { ok: true, data: { path: request.path } } };
    }
  };
}

async function serve(handler, opts = {}) {
  const server = http.createServer((req, res) => {
    handler.handle(req, res, opts).then((handled) => { if (!handled) { res.writeHead(418); res.end(); } });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

test('manifest：inbound 只有 apiVersion 3 能声明', () => {
  const base = { id: 'phone', name: 'x', version: '1.0.0' };
  assert.equal(parsePluginManifest({ ...base, apiVersion: 2, capabilities: ['inbound'] }).ok, false);
  assert.equal(parsePluginManifest({ ...base, apiVersion: 3, capabilities: ['inbound'] }).ok, true);
});

test('转发：路径、白名单请求头、JSON 体；非插件路径不处理', async () => {
  const reg = fakeRegistry();
  const s = await serve(createInboundHandler({ getRegistry: () => reg }));
  try {
    const r = await fetch(`${s.base}/plugin-hooks/phone/pair?x=1`, {
      method: 'POST',
      headers: { authorization: 'Bearer abc', 'x-companion-mobile-token': 't', cookie: 'secret=1', 'content-type': 'application/json' },
      body: JSON.stringify({ device_name: 'Pixel' })
    });
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).data, { path: '/pair' });
    const got = reg.seen[0].request;
    assert.equal(reg.seen[0].id, 'phone');
    assert.equal(got.method, 'POST');
    assert.equal(got.headers.authorization, 'Bearer abc');
    assert.equal(got.headers['x-companion-mobile-token'], 't');
    assert.equal(got.headers.cookie, undefined, 'cookie 不转发');
    assert.deepEqual(got.body, { device_name: 'Pixel' });
    assert.deepEqual(got.query, { x: '1' });
    assert.equal((await fetch(`${s.base}/plugin-hooks/other/x`)).status, 404);
    assert.equal((await fetch(`${s.base}/plugin-hooks/BAD_ID/etc`)).status, 404);
    assert.equal((await fetch(`${s.base}/api/config`)).status, 418, '非 /plugin-hooks/ 不处理（交回控制台路由）');
    assert.equal((await fetch(`${s.base}/plugin-hooks/phone/x`, { method: 'DELETE' })).status, 405);
    assert.equal((await fetch(`${s.base}/plugin-hooks/phone/x`, { method: 'POST', body: '{bad' })).status, 400);
    assert.equal((await fetch(`${s.base}/plugin-hooks/phone/x`, { method: 'POST', body: 'x'.repeat(300 * 1024) }).catch(() => ({ status: 413 }))).status, 413);
  } finally { await s.close(); }
});

test('独立端口：根路径交给 defaultPlugin', async () => {
  const reg = fakeRegistry();
  const s = await serve(createInboundHandler({ getRegistry: () => reg }), { rootPlugin: 'phone' });
  try {
    const r = await fetch(`${s.base}/status`);
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).data, { path: '/status' });
  } finally { await s.close(); }
});

test('每个来源 IP 每分钟 120 次', async () => {
  const reg = fakeRegistry();
  let now = 1_000_000;
  const s = await serve(createInboundHandler({ getRegistry: () => reg, now: () => now }));
  try {
    for (let i = 0; i < 120; i += 1) await fetch(`${s.base}/plugin-hooks/phone/health`);
    assert.equal((await fetch(`${s.base}/plugin-hooks/phone/health`)).status, 429);
    now += 61_000;
    assert.equal((await fetch(`${s.base}/plugin-hooks/phone/health`)).status, 200);
  } finally { await s.close(); }
});

test('独立端口按插件设置开：只给 enabledIds 里 inboundListen=true 的插件，根路径交给它', async () => {
  const reg = fakeRegistry();
  const cfg = { plugins: { enabled: true, enabledIds: ['phone', 'other'], settings: { phone: { inboundListen: true, inboundHost: '127.0.0.1', inboundPort: 0 }, other: { inboundListen: false } } } };
  const h = createInboundHandler({ getRegistry: () => reg, getConfig: () => cfg });
  assert.equal(createInboundHandler({ getRegistry: () => reg, getConfig: () => ({ plugins: { ...cfg.plugins, enabled: false } }) }).listen().length, 0, '总开关关着不开端口');
  cfg.plugins.settings.phone.inboundPort = 47000 + Math.floor(Math.random() * 1000);
  const servers = h.listen();
  try {
    assert.deepEqual(servers.map((s) => s.id), ['phone']);
    await new Promise((r) => (servers[0].server.listening ? r() : servers[0].server.once('listening', r)));
    const r = await fetch(`http://127.0.0.1:${cfg.plugins.settings.phone.inboundPort}/status`);
    assert.deepEqual((await r.json()).data, { path: '/status' });
  } finally { await Promise.all(servers.map((s) => s.close())); }
});

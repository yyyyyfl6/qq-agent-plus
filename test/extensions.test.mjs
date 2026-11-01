// 扩展功能（src/extensions/*）：群聊总结 / 大肥鱼桥 / 趣味功能 / 专属指令 + 实验室电脑端脚本。
// 重点钉住：派发结果不确定时不重试、只认管理员本人、指令唤醒前消费且不重复执行。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-ext-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  runtime: { mode: 'active' },
  admin: { ownerUin: '10001' },
  allow: { private: ['10001'] },
  api: { baseUrl: 'https://gateway.example.com/v1', apiKey: 'model-key', model: 'm' }
}));

const { updateConfig } = await import('../src/core/config.js');
const shared = await import('../src/extensions/shared.js');
const cs = await import('../src/extensions/chat-summary.js');
const lab = await import('../src/extensions/lab-bridge.js');
const fun = await import('../src/extensions/fun-tools.js');
const ext = await import('../src/extensions/index.js');

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `qq-ext-${name}-`));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeStore(rows) {
  return {
    listChats: () => [...new Set(rows.map((r) => r.chatKey))],
    recent: (chatKey, { limit = 80, afterId = 0 } = {}) => rows
      .filter((r) => r.chatKey === chatKey && r.id > afterId)
      .slice(-limit)
  };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body };
}

// ── shared ──────────────────────────────────────────────────────
test('切词：中文出单字+二元组、英文按词小写，停用字不进', () => {
  const t = shared.tokenize('阿杰考研 GPU OK');
  assert.ok(t.includes('考研') && t.includes('阿杰') && t.includes('gpu') && t.includes('ok'));
  assert.ok(!shared.tokenize('的了').includes('的'));
  assert.ok(shared.textSimilarity('阿杰下个月考研', '阿杰下个月要考研') > 0.6);
  assert.ok(shared.textSimilarity('阿杰下个月考研', '今晚吃火锅') < 0.1);
});

test('triggeredOnlyByOwner：全部触发者都是管理员才算；混进别人或没设管理员都不算', () => {
  const cfg = { admin: { ownerUin: '10001' } };
  assert.equal(shared.triggeredOnlyByOwner({ triggerSenderIds: ['10001', '10001'] }, cfg), true);
  assert.equal(shared.triggeredOnlyByOwner({ triggerSenderIds: ['10001', '20002'] }, cfg), false);
  assert.equal(shared.triggeredOnlyByOwner({ triggerSenderIds: [] }, cfg), false);
  assert.equal(shared.triggeredOnlyByOwner({ triggerSenderIds: ['10001'] }, { admin: {} }), false);
});

// ── 群聊总结 ────────────────────────────────────────────────────
test('群聊总结：样本带时间与活跃榜；每会话额度用完拒绝，失败时退回额度', async () => {
  updateConfig({ chatSummary: { enabled: true, maxPerHourPerChat: 1 } });
  const rows = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, chatKey: 'group:7', ts: Date.now() - (30 - i) * 1000, senderId: i % 2 ? '1' : '2', senderName: i % 2 ? '甲' : '乙', text: `聊天${i}` }));
  let fail = true;
  let seen = '';
  const rt = new cs.ChatSummaryRuntime({
    store: fakeStore(rows),
    complete: async ({ messages }) => {
      seen = messages[1].content;
      if (fail) { fail = false; throw new Error('模型挂了'); }
      return { message: { content: '大家在聊天。' } };
    }
  });
  await assert.rejects(rt.summarize('group:7', { count: 20 }), /模型挂了/);
  const rec = await rt.summarize('group:7', { count: 20 });   // 上次失败退回了额度
  assert.equal(rec.text, '大家在聊天。');
  assert.match(seen, /发言最多：/);
  assert.equal(rec.messages, 20);
  await assert.rejects(rt.summarize('group:7', { count: 20 }), /总结过好几次/);
  const bypass = await rt.summarize('group:7', { count: 20, bypassQuota: true });
  assert.ok(bypass.text);
  updateConfig({ chatSummary: { enabled: false } });
});

// ── 大肥鱼桥 ────────────────────────────────────────────────────
function labFetch(script) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, method: opts.method, headers: opts.headers, body: opts.body });
    return script(url, opts, calls);
  };
  return { fn, calls };
}

test('大肥鱼桥：task 协议派发 → 轮询 → 完成后回报到原会话', async () => {
  updateConfig({ labBridge: { enabled: true, baseUrl: 'http://127.0.0.1:8790', token: 'tok-1234567890abcdef', pollSeconds: 2 } });
  let polls = 0;
  const { fn, calls } = labFetch((url) => {
    if (url.endsWith('/v1/tasks')) return jsonResponse(202, { id: 'r1', status: 'queued' });
    polls += 1;
    return jsonResponse(200, polls < 2 ? { status: 'running', output: '...' } : { status: 'succeeded', output: 'loss 收敛到 0.12' });
  });
  const sent = [];
  const rt = new lab.LabBridgeRuntime({ dataDir: tmp('lab1'), fetchFn: fn, sender: { sendTextBatch: async (k, m) => { sent.push([k, m]); return { sent: m }; } }, log: () => {} });
  const t = await rt.dispatch('看下 train.log', { chatKey: 'private:10001', userId: '10001' });
  assert.equal(t.state, 'running');
  assert.equal(calls[0].headers.authorization, 'Bearer tok-1234567890abcdef');
  assert.ok(calls[0].headers['idempotency-key'], '带幂等键，对端可去重');
  await rt.refresh(t.id);
  const done = await rt.refresh(t.id);
  assert.equal(done.state, 'succeeded');
  await wait(20);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'private:10001');
  assert.match(sent[0][1][0], /完成了[\s\S]*loss 收敛/);
  rt.stop();
});

test('大肥鱼桥：派发请求断连/5xx 记 unknown 且不重试；4xx 记 failed', async () => {
  const dir = tmp('lab2');
  let n = 0;
  const { fn, calls } = labFetch(() => {
    n += 1;
    if (n === 1) throw new Error('socket hang up');
    if (n === 2) return jsonResponse(502, { error: 'bad gateway' });
    return jsonResponse(400, { error: 'prompt 为空' });
  });
  const rt = new lab.LabBridgeRuntime({ dataDir: dir, fetchFn: fn, log: () => {} });
  const a = await rt.dispatch('任务A', {});
  assert.equal(a.state, 'unknown');
  assert.match(a.error, /不会自动重试/);
  const b = await rt.dispatch('任务B', {});
  assert.equal(b.state, 'unknown');
  const c = await rt.dispatch('任务C', {});
  assert.equal(c.state, 'failed');
  assert.equal(calls.length, 3, '每个任务只发一次请求');
  rt.stop();
});

test('大肥鱼桥：重启时"派发中"的任务记为 unknown，不会重新派发', () => {
  const dir = tmp('lab3');
  fs.mkdirSync(path.join(dir, 'lab-bridge'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lab-bridge', 'tasks.json'), JSON.stringify({ tasks: [
    { id: 2, protocol: 'task', state: 'dispatching', prompt: 'x', createdAt: Date.now() },
    { id: 1, protocol: 'openai', state: 'running', prompt: 'y', createdAt: Date.now() }
  ] }));
  let fetched = 0;
  const rt = new lab.LabBridgeRuntime({ dataDir: dir, fetchFn: async () => { fetched += 1; return jsonResponse(200, {}); }, log: () => {} });
  rt.start();
  assert.equal(rt.get(2).state, 'unknown');
  assert.equal(rt.get(1).state, 'unknown');
  assert.equal(fetched, 0);
  rt.stop();
});

test('大肥鱼桥工具：只认管理员本人；默认仅私聊；群里不注入', async () => {
  updateConfig({ labBridge: { enabled: true, baseUrl: 'http://127.0.0.1:8790', token: 'tok-1234567890abcdef', privateOnly: true } });
  const [def] = lab.labBridgeToolDefs(() => new lab.LabBridgeRuntime({ dataDir: tmp('lab4'), fetchFn: async () => jsonResponse(200, { ok: true }), log: () => {} }));
  const { getConfig } = await import('../src/core/config.js');
  assert.equal(def.available({ cfg: getConfig(), kind: 'group' }), false, '私聊限定时群里不注入');
  assert.equal(def.available({ cfg: getConfig(), kind: 'private' }), true);
  const stranger = await def.execute({ kind: 'private', chatKey: 'private:20002', triggerSenderIds: ['20002'] }, { action: 'ping' });
  assert.equal(stranger.isError, true);
  assert.match(stranger.content, /不是管理员本人/);
  const owner = await def.execute({ kind: 'private', chatKey: 'private:10001', triggerSenderIds: ['10001'] }, { action: 'ping' });
  assert.ok(!owner.isError, owner.content);
  const group = await def.execute({ kind: 'group', chatKey: 'group:1', triggerSenderIds: ['10001'] }, { action: 'ping' });
  assert.match(group.content, /只在和管理员的私聊/);
  updateConfig({ labBridge: { privateOnly: false } });
  const mixed = await def.execute({ kind: 'group', chatKey: 'group:1', triggerSenderIds: ['10001', '20002'] }, { action: 'ping' });
  assert.match(mixed.content, /混了别人的消息|不是管理员本人/);
  updateConfig({ labBridge: { enabled: false, privateOnly: true } });
});

test('大肥鱼桥：令牌留空/掩码保持原值；下发配置不带令牌；地址必须 http(s)', () => {
  lab.saveLabBridgeConfig({ token: 'secret-token-abcdefgh' });
  lab.saveLabBridgeConfig({ name: '实验室', token: '******' });
  assert.equal(lab.labBridgeConfig().token, 'secret-token-abcdefgh');
  assert.equal(lab.publicLabBridgeConfig().token, undefined);
  assert.equal(lab.publicLabBridgeConfig().hasToken, true);
  assert.throws(() => lab.saveLabBridgeConfig({ baseUrl: 'file:///etc/passwd' }), /http/);
});

test('实验室电脑端脚本：鉴权、派发、执行命令、轮询拿到输出', async () => {
  process.env.LAB_BRIDGE_TOKEN = 'agent-token-0123456789';
  process.env.LAB_BRIDGE_CMD = `"${process.execPath}" -e "process.stdin.on('data',d=>process.stdout.write('got:'+d))"`;
  const { createServer, splitCommand } = await import(`../scripts/lab-bridge-agent.mjs?t=${Date.now()}`);
  assert.deepEqual(splitCommand(`run --x "a b" 'c d' {prompt}`), ['run', '--x', 'a b', 'c d', '{prompt}']);
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const denied = await fetch(`${base}/v1/health`);
    assert.equal(denied.status, 401);
    const headers = { authorization: 'Bearer agent-token-0123456789', 'content-type': 'application/json', 'idempotency-key': 'k1' };
    const created = await (await fetch(`${base}/v1/tasks`, { method: 'POST', headers, body: JSON.stringify({ prompt: 'hello' }) })).json();
    const again = await (await fetch(`${base}/v1/tasks`, { method: 'POST', headers, body: JSON.stringify({ prompt: 'hello' }) })).json();
    assert.equal(again.id, created.id, '同一幂等键不会派出第二个任务');
    let task = null;
    for (let i = 0; i < 50; i += 1) {
      task = await (await fetch(`${base}/v1/tasks/${created.id}`, { headers })).json();
      if (task.status !== 'queued' && task.status !== 'running') break;
      await wait(100);
    }
    assert.equal(task.status, 'succeeded', JSON.stringify(task));
    assert.equal(task.output, 'got:hello');
  } finally {
    server.close();
  }
});

// ── 趣味功能 ────────────────────────────────────────────────────
test('趣味：今日人品/运势同一天同一人固定，换天会变；塔罗三张不重复', () => {
  const day = Date.UTC(2026, 10, 1, 4);
  assert.deepEqual(fun.jrrp('123', day), fun.jrrp('123', day + 3600_000));
  const values = new Set(Array.from({ length: 10 }, (_, i) => fun.jrrp('123', day + i * 86400_000).value));
  assert.ok(values.size > 3);
  const f = fun.fortune('123', day);
  assert.equal(f.good.length, 2);
  assert.ok(!f.good.some((g) => f.bad.includes(g)));
  const cards = fun.drawTarot(3);
  assert.equal(new Set(cards.map((c) => c.name)).size, 3);
  assert.deepEqual(cards.map((c) => c.position), ['过去', '现在', '未来']);
});

// ── 组装 ────────────────────────────────────────────────────────
test('扩展工具：关闭时全部不注入；打开后按场合注入', async () => {
  const { getConfig } = await import('../src/core/config.js');
  ext.initExtensions({ dataDir: tmp('idx'), store: fakeStore([]), sender: null, log: () => {} });
  const defs = ext.extensionToolDefs();
  const names = (kind) => defs.filter((d) => ext.extensionToolAvailable(d, { cfg: getConfig(), kind })).map((d) => d.name);
  assert.deepEqual(names('group'), []);
  updateConfig({ funTools: { enabled: true }, chatSummary: { enabled: true } });
  assert.deepEqual(names('group').sort(), ['daily_fun', 'summarize_chat']);
  updateConfig({ funTools: { enabled: false }, chatSummary: { enabled: false } });
  assert.equal(ext.extensionToolAvailable({ name: 'send_message' }, {}), true, '普通工具不受影响');
});

test('人设接口：试聊带上草稿卡与历史；起草校验格式；覆盖保存自定义卡', async () => {
  const { registerPersonaRoutes, personaPreviewMessages } = await import('../src/console/persona-routes.js');
  const msgs = personaPreviewMessages({ roleText: '# 卡\n## 一、你是谁\n猫', customRules: '别说脏话', history: [{ role: 'user', content: '在吗' }, { role: 'assistant', content: '在' }] });
  assert.match(msgs[0].content, /角色设定[\s\S]*猫[\s\S]*别说脏话/);
  assert.deepEqual(msgs.slice(1).map((m) => m.role), ['user', 'assistant']);

  const routes = [];
  const router = { add: (method, p, handler) => routes.push({ method, p, handler }) };
  let reply = '在的\n怎么了';
  registerPersonaRoutes(router, {
    json: (res, code, data) => Object.assign(res, { code, data }),
    readBody: async (req) => req.body,
    complete: async () => ({ message: { content: reply } })
  });
  const call = async (method, url, body) => {
    const r = routes.find((x) => x.method === method && (typeof x.p === 'string' ? x.p === url : x.p.test(url)));
    const res = {};
    const m = typeof r.p === 'string' ? [] : r.p.exec(url);
    await r.handler({ body }, res, m);
    return res;
  };
  const preview = await call('POST', '/api/persona/preview', { roleText: '# 卡', history: [{ role: 'user', content: '在吗' }] });
  assert.deepEqual(preview.data.reply, ['在的', '怎么了']);
  assert.equal((await call('POST', '/api/persona/preview', { roleText: '', history: [] })).code, 400);
  reply = '随便写的';
  assert.equal((await call('POST', '/api/persona/generate', { name: 'a', idea: 'b' })).code, 502);
  reply = '```markdown\n# 角色卡：a\n\n## 一、你是谁\n…\n```';
  const gen = await call('POST', '/api/persona/generate', { name: 'a', idea: 'b' });
  assert.match(gen.data.text, /^# 角色卡：a/);

  updateConfig({ customPersonas: [{ name: '旧卡', text: '旧正文', behaviorProfile: 'legacy' }] });
  const put = await call('PUT', '/api/persona-templates/custom_0', { text: '新正文', customRules: '规则' });
  assert.equal(put.code, 200);
  const { getConfig } = await import('../src/core/config.js');
  assert.deepEqual(getConfig().customPersonas[0], { name: '旧卡', text: '新正文', behaviorProfile: 'legacy', customRules: '规则' });
  assert.equal((await call('PUT', '/api/persona-templates/custom_5', { text: 'x' })).code, 404);
});

// ── 专属指令 ────────────────────────────────────────────────────
test('triggerSenderIdsOf：读宿主 ctx.triggerEntries（排除自己）', () => {
  const ctx = { triggerEntries: [{ senderId: '10001' }, { senderId: 'self', self: true }, { senderId: '' }] };
  assert.deepEqual(shared.triggerSenderIdsOf(ctx), ['10001']);
  assert.equal(shared.triggeredOnlyByOwner(ctx, { admin: { ownerUin: '10001' } }), true);
});

test('指令匹配：完整词 + 参数；/总结 的条数 / 小时 / 侧重点', async () => {
  const { matchCommand, parseSummaryArgs } = await import('../src/extensions/commands.js');
  assert.equal(matchCommand('/总结', ['/总结']), '');
  assert.equal(matchCommand(' /总结  200 ', ['/总结']), '200');
  assert.equal(matchCommand('/总结x', ['/总结']), null);
  assert.equal(matchCommand('我想/总结', ['/总结']), null);
  assert.deepEqual(parseSummaryArgs('200'), { count: 200, hours: 0, focus: '' });
  assert.deepEqual(parseSummaryArgs('3h'), { count: 0, hours: 3, focus: '' });
  assert.deepEqual(parseSummaryArgs('5小时 周末 聚餐'), { count: 0, hours: 5, focus: '周末 聚餐' });
});

test('/总结：唤醒前消费、直接发出、同一条消息不重复；关掉功能或清空指令就不拦', async () => {
  const { ExtensionCommands } = await import('../src/extensions/commands.js');
  updateConfig({ chatSummary: { enabled: true, commands: ['/总结'], commandAccess: 'everyone', maxPerHourPerChat: 5 } });
  const rows = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, chatKey: 'group:9', ts: Date.now(), senderId: '2', senderName: '乙', text: `话${i}` }));
  const sent = [];
  const summary = new cs.ChatSummaryRuntime({
    store: fakeStore(rows),
    sender: { sendTextBatch: async (k, m) => { sent.push([k, m]); return { sent: m }; } },
    complete: async ({ messages }) => ({ message: { content: `总结：${/最近|发言最多/.test(messages[1].content) ? 'ok' : ''}` } })
  });
  const replies = [];
  const cmds = new ExtensionCommands({ getRuntimes: () => ({ chatSummary: summary }), send: async (k, t) => replies.push([k, t]), log: () => {} });
  assert.equal(await cmds.consume('group:9', '2', '/总结 20', 'm1'), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'group:9');
  assert.match(sent[0][1][0], /总结：ok/);
  assert.equal(await cmds.consume('group:9', '2', '/总结 20', 'm1'), true, '重复投递仍算已处理');
  assert.equal(sent.length, 1, '但不会再总结一次');
  assert.equal(await cmds.consume('group:9', '2', '随便聊聊', 'm2'), false);
  updateConfig({ chatSummary: { commandAccess: 'owner' } });
  assert.equal(await cmds.consume('group:9', '2', '/总结', 'm3'), false, '仅管理员时群友的 /总结 当普通消息');
  updateConfig({ chatSummary: { commandAccess: 'everyone', commands: [] } });
  assert.equal(await cmds.consume('group:9', '2', '/总结', 'm4'), false, '清空指令即关闭');
  updateConfig({ chatSummary: { enabled: false, commands: ['/总结', '总结一下'] } });
  assert.equal(await cmds.consume('group:9', '2', '/总结', 'm5'), false);
});

test('/lab：只认管理员私聊；派发、列表、重启后重放同一条消息不重复派发', async () => {
  const { ExtensionCommands } = await import('../src/extensions/commands.js');
  updateConfig({ labBridge: { enabled: true, baseUrl: 'http://127.0.0.1:8790', token: 'tok-1234567890abcdef', privateOnly: true, commands: ['/lab'] } });
  const dir = tmp('labcmd');
  let posts = 0;
  const fetchFn = async (url) => {
    if (String(url).endsWith('/v1/tasks')) { posts += 1; return jsonResponse(202, { id: `r${posts}` }); }
    return jsonResponse(200, { status: 'running', output: '' });
  };
  const replies = [];
  const make = () => {
    const labRt = new lab.LabBridgeRuntime({ dataDir: dir, fetchFn, log: () => {} });
    return { labRt, cmds: new ExtensionCommands({ getRuntimes: () => ({ labBridge: labRt }), send: async (k, t) => replies.push([k, t]), log: () => {} }) };
  };
  let { labRt, cmds } = make();
  assert.equal(await cmds.consume('private:20002', '20002', '/lab rm -rf /', 'x1'), false, '非管理员当普通消息');
  assert.equal(await cmds.consume('group:1', '10001', '/lab 看日志', 'x2'), false, '私聊限定时群里不拦');
  assert.equal(posts, 0);
  assert.equal(await cmds.consume('private:10001', '10001', '/lab 看一下 train.log', 'x3'), true);
  assert.equal(posts, 1);
  assert.match(replies.at(-1)[1], /已交给.*（#1）/);
  assert.equal(labRt.get(1).originMid, 'x3');
  labRt.stop();
  ({ labRt, cmds } = make());   // 模拟重启：内存去重清空
  assert.equal(await cmds.consume('private:10001', '10001', '/lab 看一下 train.log', 'x3'), true);
  assert.equal(posts, 1, '同一条消息重放不会派第二次');
  await cmds.consume('private:10001', '10001', '/lab', 'x4');
  assert.match(replies.at(-1)[1], /#1 running/);
  labRt.stop();
  updateConfig({ labBridge: { enabled: false } });
});

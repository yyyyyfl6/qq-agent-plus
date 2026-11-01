// 测试用插件（good）：手写实现插件协议。
// v1 刻意不提供 SDK —— 协议要简单到人能手写，这个夹具同时就是"协议够用"的证明。
import fs from 'node:fs';
import os from 'node:os';
import cp from 'node:child_process';

let seq = 0;
const pending = new Map();
let settings = {};
let seen = 0;
let ticks = 0;

const send = (message) => { process.stdout.write(`${JSON.stringify(message)}\n`); };
const call = (method, params) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  send({ id, method, params });
});

const tools = {
  echo: async (args) => ({ echo: args ?? null }),
  settings: async () => ({ settings }),
  remember: async (args) => {
    await call('cap.storage.set', { key: 'last', value: String(args?.value ?? '') });
    const read = await call('cap.storage.get', { key: 'last' });
    return { saved: read?.value ?? null };
  },
  probe_isolation: async () => {
    const out = { probePath: String(settings.probePath ?? '') };
    try { out.readOutside = `OK:${fs.readFileSync(settings.probePath, 'utf8').length}`; }
    catch (error) { out.readOutside = error?.code || 'error'; }
    try { cp.spawnSync('id'); out.spawn = 'OK'; } catch (error) { out.spawn = error?.code || 'error'; }
    try { fs.writeFileSync(`${os.tmpdir()}/qq-plugin-write-probe.txt`, 'x'); out.write = 'OK'; }
    catch (error) { out.write = error?.code || 'error'; }
    out.envLeaked = typeof process.env.QQ_AGENT_DATA_DIR === 'string';
    return out;
  },
  counters: async () => ({ seen, ticks }),
  log_probe: async () => {
    await call('cap.log.write', { level: 'info', message: '来自插件的日志行' });
    return { ok: true };
  }
};

async function handleRequest(message) {
  const reply = (payload) => send({ id: message.id, ...payload });
  const fail = (code, text) => reply({ error: { code, message: text } });
  switch (message.method) {
    case 'init':
      settings = message.params?.settings ?? {};
      reply({ result: { ok: true, apiVersion: 1 } });
      return;
    case 'ping':
      reply({ result: {} });
      return;
    case 'callTool': {
      const name = String(message.params?.name ?? '');
      const fn = tools[name];
      if (!fn) return fail('E_NO_TOOL', `没有这个工具：${name}`);
      try { reply({ result: await fn(message.params?.args ?? {}) }); }
      catch (error) { fail(error?.code || 'E_TOOL', String(error?.message ?? error)); }
      return;
    }
    case 'schedule':
      ticks += 1;
      reply({ result: { ok: true } });
      return;
    case 'shutdown':
      reply({ result: {} });
      setTimeout(() => process.exit(0), 10);
      return;
    default:
      fail('E_NO_METHOD', `未知方法：${message.method}`);
  }
}

function handleReply(message) {
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.error) entry.reject(Object.assign(new Error(message.error.message || 'cap 失败'), { code: message.error.code }));
  else entry.resolve(message.result ?? null);
}

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index = buffer.indexOf('\n');
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      let message = null;
      try { message = JSON.parse(line); } catch { message = null; }
      if (message && typeof message.method === 'string' && message.id !== undefined) handleRequest(message);
      else if (message && message.id !== undefined) handleReply(message);
      else if (message?.method === 'observe') seen += 1;
    }
    index = buffer.indexOf('\n');
  }
});

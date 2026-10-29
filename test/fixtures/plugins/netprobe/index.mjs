// 网络探针：把"自己连不出去"与"经宿主能走"两条路的结果如实报回来。
// 断言方看的是**错误码的差别**：被隔离时是 ENETUNREACH（网络栈根本不可达），没隔离时
// 是 ECONNREFUSED（栈是通的，只是没人监听）—— 两者不靠网络就能区分，测试不用打真实网络。
import net from 'node:net';

let seq = 0;
const pending = new Map();
const send = (message) => { process.stdout.write(`${JSON.stringify(message)}\n`); };
const call = (method, params) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  send({ id, method, params });
});

const probe = (port) => new Promise((resolve) => {
  const socket = net.connect({ host: '127.0.0.1', port: Number(port) || 1 });
  const done = (code) => { try { socket.destroy(); } catch { /* 已经断了 */ } resolve(code); };
  socket.on('connect', () => done('CONNECTED'));
  socket.on('error', (error) => done(error.code || 'ERROR'));
  setTimeout(() => done('TIMEOUT'), 3000);
});

const tools = {
  async direct_probe(args) {
    return { code: await probe(args?.port) };
  },
  async via_host(args) {
    try {
      const result = await call('cap.http.request', { url: String(args?.url || ''), method: 'GET' });
      return { ok: true, status: result?.status };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  }
};

process.stdin.on('data', (chunk) => {
  let buffer = String(chunk);
  let index = buffer.indexOf('\n');
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      let message = null;
      try { message = JSON.parse(line); } catch { message = null; }
      if (message?.method === 'callTool') {
        tools[message.params?.name]?.(message.params?.args || {})
          .then((result) => send({ id: message.id, result }))
          .catch((error) => send({ id: message.id, error: { code: 'E_TOOL', message: String(error?.message || error) } }));
      } else if (message?.method === 'init') {
        send({ id: message.id, result: { ok: true } });
      } else if (message?.method === 'ping') {
        send({ id: message.id, result: {} });
      } else if (message?.method === 'schedule') {
        send({ id: message.id, result: {} });
      } else if (message?.method === 'shutdown') {
        send({ id: message.id, result: {} });
        setTimeout(() => process.exit(0), 10);
      } else if (message?.id !== undefined) {
        const entry = pending.get(message.id);
        if (entry) {
          pending.delete(message.id);
          if (message.error) entry.reject(Object.assign(new Error(message.error.message || '能力调用失败'), { code: message.error.code }));
          else entry.resolve(message.result ?? null);
        }
      }
    }
    index = buffer.indexOf('\n');
  }
});

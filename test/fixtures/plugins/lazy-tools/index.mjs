// 懒启动夹具：只有工具、不调任何宿主能力 —— 最少的一份实现（"协议简单到能手写"的又一处证明）。
const send = (message) => { process.stdout.write(`${JSON.stringify(message)}\n`); };
const reply = (message, payload) => send({ id: message.id, ...payload });

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
        if (message.params?.name === 'ping') reply(message, { result: { pong: true } });
        else reply(message, { error: { code: 'E_NO_TOOL', message: `没有这个工具：${message.params?.name}` } });
      } else if (message?.method === 'init') reply(message, { result: { ok: true } });
      else if (message?.method === 'ping') reply(message, { result: {} });
      else if (message?.method === 'schedule') reply(message, { result: {} });
      else if (message?.method === 'shutdown') {
        reply(message, { result: {} });
        setTimeout(() => process.exit(0), 10);
      }
    }
    index = buffer.indexOf('\n');
  }
});

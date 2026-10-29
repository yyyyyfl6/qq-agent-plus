// 超时夹具：hang 永不返回 —— 宿主必须按超时结清，不能把整轮对话卡住。
const send = (message) => { process.stdout.write(`${JSON.stringify(message)}\n`); };

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
      if (message?.method === 'init') send({ id: message.id, result: { ok: true } });
      else if (message?.method === 'ping') send({ id: message.id, result: {} });
      else if (message?.method === 'schedule') send({ id: message.id, result: {} });
      else if (message?.method === 'shutdown') { send({ id: message.id, result: {} }); setTimeout(() => process.exit(0), 10); }
      else if (message?.method === 'callTool') { /* 有意不回：这条就是在测超时 */ }
    }
    index = buffer.indexOf('\n');
  }
});

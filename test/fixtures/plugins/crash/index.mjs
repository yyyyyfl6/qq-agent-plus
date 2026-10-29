// 崩溃夹具：boom 让进程直接退出（模拟第三方插件里的漏 catch / 主动自杀）。
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
      else if (message?.method === 'shutdown') process.exit(0);
      else if (message?.method === 'callTool') process.exit(3);
    }
    index = buffer.indexOf('\n');
  }
});

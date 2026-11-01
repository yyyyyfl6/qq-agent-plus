#!/usr/bin/env node
// 大肥鱼桥 · 实验室电脑端（零依赖，Node ≥ 18；Windows / macOS / Linux 都能跑）。
//
// 作用：在实验室电脑上实现 QQ Agent「大肥鱼桥」的 task 协议，把收到的任务交给本机的
// DeepSeek Harness（或任何命令行 agent）去跑，并把输出交回去。
//
//   POST /v1/tasks             { prompt }        → 202 { id, status }
//   GET  /v1/tasks/:id                           → { id, status, output, error, startedAt, finishedAt }
//   POST /v1/tasks/:id/cancel                    → { id, status }
//   GET  /v1/health                              → { ok, name, busy, queued }
//   全部要求 Authorization: Bearer <LAB_BRIDGE_TOKEN>
//
// 环境变量：
//   LAB_BRIDGE_TOKEN     必填，与服务器控制台「大肥鱼桥 → 令牌」一致（建议 32 位以上随机串）
//   LAB_BRIDGE_CMD       必填，执行任务的命令。含 {prompt} 时就地替换成任务文本（作为单个参数，不经 shell）；
//                        不含则把任务文本写进命令的 stdin。例：
//                          LAB_BRIDGE_CMD='dsh run --yes {prompt}'
//                          LAB_BRIDGE_CMD='python C:\harness\run.py'
//   LAB_BRIDGE_WORKDIR   命令的工作目录（默认当前目录）
//   LAB_BRIDGE_HOST      监听地址（默认 127.0.0.1；配合 SSH 反向隧道使用，不要改成 0.0.0.0 暴露到公网）
//   LAB_BRIDGE_PORT      监听端口（默认 8790）
//   LAB_BRIDGE_TIMEOUT_MIN 单个任务最长分钟数（默认 30，超时杀进程记 failed）
//   LAB_BRIDGE_SHELL=1   用系统 shell 执行（Windows 上跑 .cmd/.bat 时需要；此时 {prompt} 会被安全转义成一个参数）
//   LAB_BRIDGE_NAME      显示名（默认 lab）
//
// 连到服务器（实验室电脑在 NAT 后面时，推荐反向隧道，服务器不用开任何端口）：
//   ssh -N -R 8790:127.0.0.1:8790 user@your-server
// 然后在服务器控制台把「服务地址」填成 http://127.0.0.1:8790。
//
// 同一时间只跑一个任务，其余排队；任务记录只在内存里（重启后服务器那边会把在途任务标成"结果未知"）。
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const TOKEN = String(process.env.LAB_BRIDGE_TOKEN || '');
const CMD = String(process.env.LAB_BRIDGE_CMD || '');
const HOST = process.env.LAB_BRIDGE_HOST || '127.0.0.1';
const PORT = Number(process.env.LAB_BRIDGE_PORT || 8790);
const WORKDIR = process.env.LAB_BRIDGE_WORKDIR || process.cwd();
const TIMEOUT_MS = Math.max(1, Number(process.env.LAB_BRIDGE_TIMEOUT_MIN || 30)) * 60_000;
const USE_SHELL = process.env.LAB_BRIDGE_SHELL === '1';
const NAME = process.env.LAB_BRIDGE_NAME || 'lab';
const MAX_OUTPUT = 400_000;

/** 把命令模板切成 argv（支持单/双引号），不经 shell。 */
export function splitCommand(cmd) {
  const out = [];
  let cur = '';
  let quote = '';
  let has = false;
  for (const ch of String(cmd)) {
    if (quote) {
      if (ch === quote) quote = '';
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch; has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = ''; has = false;
    } else {
      cur += ch;
    }
  }
  if (cur || has) out.push(cur);
  return out;
}

function shellQuote(s) {
  if (process.platform === 'win32') return `"${String(s).replace(/"/g, '""')}"`;
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

const tasks = new Map();
const queue = [];
let current = null;

function publicTask(t) {
  return {
    id: t.id, status: t.status, output: t.output, error: t.error,
    createdAt: t.createdAt, startedAt: t.startedAt, finishedAt: t.finishedAt
  };
}

function runNext() {
  if (current || !queue.length) return;
  const task = queue.shift();
  if (task.status !== 'queued') return runNext();
  current = task;
  task.status = 'running';
  task.startedAt = Date.now();
  const argv = splitCommand(CMD);
  const usesPlaceholder = argv.some((a) => a.includes('{prompt}'));
  let child;
  try {
    if (USE_SHELL) {
      const line = argv.map((a) => (a.includes('{prompt}') ? a.split('{prompt}').join(shellQuote(task.prompt)) : a)).join(' ');
      child = spawn(line, { cwd: WORKDIR, shell: true, windowsHide: true });
    } else {
      const [bin, ...rest] = argv.map((a) => a.split('{prompt}').join(task.prompt));
      child = spawn(bin, rest, { cwd: WORKDIR, shell: false, windowsHide: true });
    }
  } catch (error) {
    finish(task, 'failed', `启动命令失败：${error.message}`);
    return;
  }
  task.child = child;
  const append = (chunk) => {
    task.output += chunk.toString('utf8');
    if (task.output.length > MAX_OUTPUT) task.output = task.output.slice(-MAX_OUTPUT);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  child.on('error', (error) => finish(task, 'failed', `命令出错：${error.message}`));
  child.on('close', (code, signal) => {
    if (task.status === 'cancelled') return finish(task, 'cancelled', '已取消');
    if (code === 0) finish(task, 'succeeded', '');
    else finish(task, 'failed', signal ? `被信号 ${signal} 终止` : `退出码 ${code}`);
  });
  if (!usesPlaceholder) {
    child.stdin?.end(task.prompt);
  } else {
    child.stdin?.end();
  }
  task.timer = setTimeout(() => {
    task.timedOut = true;
    try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
  }, TIMEOUT_MS);
}

function finish(task, status, error) {
  if (task.finishedAt) return;
  clearTimeout(task.timer);
  task.status = task.timedOut ? 'failed' : status;
  task.error = task.timedOut ? `超过 ${Math.round(TIMEOUT_MS / 60000)} 分钟，已终止` : error;
  task.finishedAt = Date.now();
  task.child = null;
  if (current === task) current = null;
  console.log(`[lab-bridge] 任务 ${task.id} ${task.status}${task.error ? `：${task.error}` : ''}`);
  // 只留最近 100 个
  if (tasks.size > 100) {
    for (const [id, t] of tasks) { if (t.finishedAt) { tasks.delete(id); if (tasks.size <= 100) break; } }
  }
  setImmediate(runNext);
}

function authorized(req) {
  const got = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(TOKEN);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function send(res, code, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': data.length });
  res.end(data);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 256 * 1024) throw new Error('请求体过大');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

export function createServer() {
  const seenKeys = new Map();   // idempotency-key → task id（防止服务器端重复派发）
  return http.createServer(async (req, res) => {
    try {
      if (!authorized(req)) return send(res, 401, { error: 'unauthorized' });
      const url = new URL(req.url, 'http://x');
      const parts = url.pathname.split('/').filter(Boolean);
      if (req.method === 'GET' && url.pathname === '/v1/health') {
        return send(res, 200, { ok: true, name: NAME, busy: Boolean(current), queued: queue.length });
      }
      if (req.method === 'POST' && url.pathname === '/v1/tasks') {
        const key = String(req.headers['idempotency-key'] || '');
        if (key && seenKeys.has(key)) return send(res, 202, publicTask(tasks.get(seenKeys.get(key))));
        const body = await readJson(req);
        const prompt = String(body.prompt || '').trim().slice(0, 20000);
        if (!prompt) return send(res, 400, { error: 'prompt 为空' });
        const task = { id: crypto.randomUUID(), prompt, status: 'queued', output: '', error: '', createdAt: Date.now(), startedAt: 0, finishedAt: 0 };
        tasks.set(task.id, task);
        if (key) seenKeys.set(key, task.id);
        queue.push(task);
        console.log(`[lab-bridge] 收到任务 ${task.id}：${prompt.slice(0, 80)}`);
        setImmediate(runNext);
        return send(res, 202, publicTask(task));
      }
      if (parts[0] === 'v1' && parts[1] === 'tasks' && parts[2]) {
        const task = tasks.get(parts[2]);
        if (!task) return send(res, 404, { error: 'not found' });
        if (req.method === 'GET' && parts.length === 3) return send(res, 200, publicTask(task));
        if (req.method === 'POST' && parts[3] === 'cancel') {
          if (task.status === 'queued') { task.status = 'cancelled'; task.finishedAt = Date.now(); task.error = '已取消'; }
          else if (task.status === 'running') { task.status = 'cancelled'; try { task.child?.kill(); } catch { /* 已退出 */ } }
          return send(res, 200, publicTask(task));
        }
      }
      return send(res, 404, { error: 'not found' });
    } catch (error) {
      return send(res, 400, { error: String(error?.message ?? error) });
    }
  });
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  if (TOKEN.length < 16) {
    console.error('请设置 LAB_BRIDGE_TOKEN（至少 16 个字符），与服务器控制台里填的令牌一致。');
    process.exit(2);
  }
  if (!CMD) {
    console.error('请设置 LAB_BRIDGE_CMD，例如：LAB_BRIDGE_CMD="dsh run {prompt}"');
    process.exit(2);
  }
  createServer().listen(PORT, HOST, () => {
    console.log(`[lab-bridge] ${NAME} 已就绪：http://${HOST}:${PORT}  命令：${CMD}  工作目录：${WORKDIR}`);
  });
}

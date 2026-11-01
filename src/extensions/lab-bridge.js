// 大肥鱼桥（Lab Bridge）：让机器人在 QQ 里接管理员的话，把任务派给**实验室电脑上的 DeepSeek Harness**，
// 跑完把结果带回聊天。
//
// 两种对接协议（控制台二选一）：
//   · task（推荐）：异步任务协议 —— POST {base}/v1/tasks 派发、GET {base}/v1/tasks/:id 轮询、
//     POST {base}/v1/tasks/:id/cancel 取消。实验室电脑上跑仓库自带的 scripts/lab-bridge-agent.mjs
//     （零依赖 Node 脚本）即可实现这套协议，它再去调本机的 harness 命令行。
//   · openai：harness 本身暴露 OpenAI 兼容的 /chat/completions 时直接打（同步、一次跑完）。
//
// 网络：实验室电脑一般在内网/NAT 后面，推荐从实验室电脑反向隧道到服务器：
//   ssh -N -R 8790:127.0.0.1:8790 user@server   → 服务器上 baseUrl 填 http://127.0.0.1:8790
// 不要求任何一端开公网端口。令牌只存在服务器 config.json 与实验室电脑的环境变量里。
//
// 安全底线（这是"能在别人电脑上干活"的功能）：
//   · 只有管理员（admin.ownerUin）本人下的指令才执行；群聊里同一批消息混进任何别人的发言就拒绝。
//   · 默认只在私聊里可用（privateOnly）；工具不在不可用的场合注入。
//   · 派发前先落盘"dispatching"；派发结果不确定（超时/断连/重启）记为 unknown，**绝不自动重试**
//     （实验功能规范 §4）——可能已经在实验室电脑上跑起来了，重复派发会让同一件事执行两遍。
//   · 每小时派发次数上限；输出截断后才进聊天。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getConfig, updateConfig } from '../core/config.js';
import { createQuota } from '../core/quota.js';
import {
  clampInt, err, fetchWithTimeout, isPlainObject, ok, ownerUin, str, triggeredOnlyByOwner
} from './shared.js';

export const LAB_BRIDGE_DEFAULTS = Object.freeze({
  enabled: false,
  name: '实验室电脑',
  protocol: 'task',            // task | openai
  baseUrl: '',                 // 如 http://127.0.0.1:8790（task）或 http://127.0.0.1:3080/v1（openai）
  token: '',                   // Bearer 令牌（task 协议必填；openai 协议按 harness 要求）
  model: '',                   // openai 协议的 model 字段（harness 不看也可以留空）
  systemPrompt: '',            // openai 协议可选的 system 消息
  privateOnly: true,           // 只在与管理员的私聊里可用
  maxPerHour: 10,
  timeoutMinutes: 30,          // 单个任务最长等多久（超了记 unknown，不自动重试）
  pollSeconds: 5,
  reportBack: true,            // 任务结束后把结果摘要主动发回下指令的会话
  reportMaxChars: 900
});

export function labBridgeConfig(cfg = getConfig()) {
  const raw = isPlainObject(cfg?.labBridge) ? cfg.labBridge : {};
  return {
    enabled: raw.enabled === true,
    name: str(raw.name, 30) || LAB_BRIDGE_DEFAULTS.name,
    protocol: raw.protocol === 'openai' ? 'openai' : 'task',
    baseUrl: str(raw.baseUrl, 300).replace(/\/+$/, ''),
    token: str(raw.token, 500),
    model: str(raw.model, 120),
    systemPrompt: str(raw.systemPrompt, 4000),
    privateOnly: raw.privateOnly !== false,
    maxPerHour: clampInt(raw.maxPerHour, 1, 120, LAB_BRIDGE_DEFAULTS.maxPerHour),
    timeoutMinutes: clampInt(raw.timeoutMinutes, 1, 24 * 60, LAB_BRIDGE_DEFAULTS.timeoutMinutes),
    pollSeconds: clampInt(raw.pollSeconds, 2, 120, LAB_BRIDGE_DEFAULTS.pollSeconds),
    reportBack: raw.reportBack !== false,
    reportMaxChars: clampInt(raw.reportMaxChars, 100, 3000, LAB_BRIDGE_DEFAULTS.reportMaxChars)
  };
}

export function labBridgeConfigured(cfg = getConfig()) {
  const c = labBridgeConfig(cfg);
  if (!c.enabled || !c.baseUrl) return false;
  try { new URL(c.baseUrl); } catch { return false; }
  return c.protocol === 'openai' || Boolean(c.token);
}

export function publicLabBridgeConfig(cfg = getConfig()) {
  const { token, ...rest } = labBridgeConfig(cfg);
  return { ...rest, hasToken: Boolean(token), configured: labBridgeConfigured(cfg) };
}

export function saveLabBridgeConfig(patch = {}) {
  const current = labBridgeConfig();
  const p = isPlainObject(patch) ? patch : {};
  const nextToken = str(p.token, 500);
  const merged = {
    ...current,
    ...p,
    token: nextToken && nextToken !== '******' ? nextToken : (p.clearToken === true ? '' : current.token)
  };
  delete merged.clearToken;
  delete merged.hasToken;
  delete merged.configured;
  if (merged.baseUrl) {
    let u;
    try { u = new URL(String(merged.baseUrl)); } catch { throw new Error('服务地址不是合法的 URL'); }
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('服务地址只支持 http / https');
  }
  updateConfig({ labBridge: labBridgeConfig({ labBridge: merged }) });
  return publicLabBridgeConfig();
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'unknown']);

function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} 分 ${s % 60} 秒` : `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

/** 输出截断：保留开头一点 + 结尾大部分（命令行任务的结论通常在最后）。 */
export function clipOutput(text, max) {
  const s = String(text || '').replace(/\r\n/g, '\n').trim();
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.25);
  return `${s.slice(0, head)}\n…（中间省略 ${s.length - max} 字）…\n${s.slice(-(max - head))}`;
}

export class LabBridgeRuntime {
  constructor({ dataDir, sender = null, log = console.log, now = () => Date.now(), fetchFn = fetch } = {}) {
    this.dir = path.join(dataDir, 'lab-bridge');
    this.file = path.join(this.dir, 'tasks.json');
    this.sender = sender;
    this.log = log;
    this.now = now;
    this.fetchFn = fetchFn;
    this.tasks = null;
    this.pollers = new Map();
    this.quota = createQuota({ windowMs: 3600_000 });
    this.started = false;
  }

  #load() {
    if (this.tasks) return this.tasks;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
    } catch {
      this.tasks = [];
    }
    return this.tasks;
  }

  #save() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, tasks: this.tasks.slice(0, 200) }, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  #patch(id, patch) {
    const task = this.#load().find((t) => t.id === id);
    if (!task) return null;
    Object.assign(task, patch, { updatedAt: this.now() });
    this.#save();
    return task;
  }

  list(limit = 30) {
    if (!fs.existsSync(this.file) && !this.tasks) return [];
    return this.#load().slice(0, limit);
  }

  get(id) {
    if (!fs.existsSync(this.file) && !this.tasks) return null;
    return this.#load().find((t) => t.id === Number(id)) || null;
  }

  /** 启动：把重启前没收尾的任务按规则处理（不自动重派）。 */
  start() {
    this.stop();
    const c = labBridgeConfig();
    if (!c.enabled || !fs.existsSync(this.file)) { this.started = c.enabled; return; }
    this.started = true;
    let changed = false;
    for (const t of this.#load()) {
      if (t.state === 'dispatching') {
        Object.assign(t, { state: 'unknown', error: '服务在派发途中重启，派发结果未知；不会自动重试，请到实验室电脑上确认', updatedAt: this.now() });
        changed = true;
      } else if (t.state === 'running' && t.protocol === 'openai') {
        Object.assign(t, { state: 'unknown', error: '服务在等待结果时重启（同步协议无法续接），结果未知', updatedAt: this.now() });
        changed = true;
      } else if (t.state === 'running' && t.protocol === 'task' && t.remoteId) {
        this.#poll(t.id);
      }
    }
    if (changed) this.#save();
  }

  stop() {
    for (const timer of this.pollers.values()) clearTimeout(timer);
    this.pollers.clear();
    this.started = false;
  }

  reconfigure() { this.start(); }

  status() {
    const tasks = this.list(30);
    return {
      config: publicLabBridgeConfig(),
      running: tasks.filter((t) => !TERMINAL.has(t.state)).length,
      tasks
    };
  }

  #headers(c) {
    return {
      'content-type': 'application/json',
      ...(c.token ? { authorization: `Bearer ${c.token}` } : {})
    };
  }

  async ping() {
    const c = labBridgeConfig();
    if (!c.baseUrl) throw new Error('还没填服务地址');
    const started = this.now();
    const url = c.protocol === 'task' ? `${c.baseUrl}/v1/health` : `${c.baseUrl}/models`;
    const res = await fetchWithTimeout(url, { method: 'GET', headers: this.#headers(c) }, { timeoutMs: 8000, fetchFn: this.fetchFn });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* 非 JSON 也算连上了 */ }
    if (res.status === 401 || res.status === 403) throw new Error(`连上了，但令牌不对（HTTP ${res.status}）`);
    if (!res.ok) throw new Error(`HTTP ${res.status}：${text.slice(0, 160)}`);
    return { ok: true, ms: Date.now() - started, info: body && typeof body === 'object' ? body : { raw: text.slice(0, 120) } };
  }

  /**
   * 派发一个任务。origin: { chatKey, userId, via: 'qq'|'console' }。
   * 返回落盘后的任务记录（派发失败也返回记录，state 说明结果）。
   */
  async dispatch(prompt, origin = {}, { bypassQuota = false } = {}) {
    const c = labBridgeConfig();
    if (!labBridgeConfigured()) throw new Error('大肥鱼桥未启用或未配置（控制台 → 大肥鱼桥）');
    const text = str(prompt, 8000);
    if (!text) throw new Error('任务内容为空');
    if (!bypassQuota) {
      this.quota.configure({ globalMax: c.maxPerHour });
      const gate = this.quota.tryConsume('', this.now());
      if (!gate.ok) throw new Error('这小时派到实验室电脑的任务已达上限，过会儿再来');
    }
    const tasks = this.#load();
    const id = (tasks.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0) || 0) + 1;
    const task = {
      id,
      protocol: c.protocol,
      prompt: text,
      state: 'dispatching',
      remoteId: '',
      output: '',
      error: '',
      chatKey: str(origin.chatKey, 64),
      userId: str(origin.userId, 32),
      via: origin.via === 'console' ? 'console' : 'qq',
      createdAt: this.now(),
      updatedAt: this.now(),
      finishedAt: 0,
      reported: false,
      idempotencyKey: crypto.randomUUID()
    };
    tasks.unshift(task);
    this.#save();   // 先落盘再发请求：进程在发请求途中死掉也能知道"可能派出去了"

    if (c.protocol === 'openai') {
      this.#patch(id, { state: 'running' });
      this.#runOpenAi(id, c).catch(() => { /* 内部已记状态 */ });
      return this.get(id);
    }

    let res;
    try {
      res = await fetchWithTimeout(`${c.baseUrl}/v1/tasks`, {
        method: 'POST',
        headers: { ...this.#headers(c), 'idempotency-key': task.idempotencyKey },
        body: JSON.stringify({ prompt: text, meta: { from: 'qq-agent', chatKey: task.chatKey, taskId: id } })
      }, { timeoutMs: 15000, fetchFn: this.fetchFn });
    } catch (error) {
      // 请求可能已经到达对端：结果未知，不重试
      return this.#patch(id, { state: 'unknown', error: `派发请求没有收到回应（${String(error?.message ?? error).slice(0, 120)}）：可能已在实验室电脑上开始执行，不会自动重试` });
    }
    const raw = await res.text().catch(() => '');
    let body = null;
    try { body = JSON.parse(raw); } catch { /* 下面判 */ }
    if (res.status >= 500) {
      return this.#patch(id, { state: 'unknown', error: `对端返回 HTTP ${res.status}，不确定是否已开始执行，不会自动重试` });
    }
    if (!res.ok || !body?.id) {
      // 4xx：对端明确拒绝 = 确定没执行
      return this.#patch(id, { state: 'failed', error: `派发被拒绝 HTTP ${res.status}：${String(body?.error || raw).slice(0, 200)}`, finishedAt: this.now() });
    }
    this.#patch(id, { state: 'running', remoteId: String(body.id) });
    this.#poll(id);
    return this.get(id);
  }

  async #runOpenAi(id, c) {
    const task = this.get(id);
    const messages = [
      ...(c.systemPrompt ? [{ role: 'system', content: c.systemPrompt }] : []),
      { role: 'user', content: task.prompt }
    ];
    try {
      const res = await fetchWithTimeout(`${c.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.#headers(c),
        body: JSON.stringify({ model: c.model || 'default', messages, stream: false })
      }, { timeoutMs: c.timeoutMinutes * 60_000, fetchFn: this.fetchFn });
      const raw = await res.text();
      let body = null;
      try { body = JSON.parse(raw); } catch { /* 下面判 */ }
      if (!res.ok) {
        const state = res.status >= 500 ? 'unknown' : 'failed';
        this.#finish(id, { state, error: `HTTP ${res.status}：${String(body?.error?.message || raw).slice(0, 300)}` });
        return;
      }
      const content = String(body?.choices?.[0]?.message?.content ?? '').trim();
      this.#finish(id, { state: 'succeeded', output: content.slice(0, 200_000) });
    } catch (error) {
      this.#finish(id, { state: 'unknown', error: `等待结果时连接中断（${String(error?.message ?? error).slice(0, 160)}），不确定是否执行完，不会自动重试` });
    }
  }

  #poll(id) {
    const c = labBridgeConfig();
    if (this.pollers.has(id)) clearTimeout(this.pollers.get(id));
    const timer = setTimeout(() => {
      this.pollers.delete(id);
      this.refresh(id).then((task) => {
        if (task && !TERMINAL.has(task.state)) this.#poll(id);
      }).catch(() => this.#poll(id));
    }, c.pollSeconds * 1000);
    if (timer.unref) timer.unref();
    this.pollers.set(id, timer);
  }

  /** 查一次远端状态（控制台「刷新」与轮询共用）。 */
  async refresh(id) {
    const task = this.get(id);
    if (!task || task.protocol !== 'task' || !task.remoteId) return task;
    const c = labBridgeConfig();
    if (task.state === 'running' && this.now() - task.createdAt > c.timeoutMinutes * 60_000) {
      return this.#finish(id, { state: 'unknown', error: `超过 ${c.timeoutMinutes} 分钟还没结束：停止等待（实验室电脑上可能仍在跑），可稍后在控制台手动刷新` });
    }
    const res = await fetchWithTimeout(`${c.baseUrl}/v1/tasks/${encodeURIComponent(task.remoteId)}`, {
      method: 'GET', headers: this.#headers(c)
    }, { timeoutMs: 10000, fetchFn: this.fetchFn });
    if (res.status === 404) return this.#finish(id, { state: 'unknown', error: '实验室电脑上找不到这个任务了（可能那边重启过）' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json().catch(() => ({}));
    const remote = String(body?.status || '');
    const output = String(body?.output ?? '').slice(0, 200_000);
    if (['succeeded', 'failed', 'cancelled'].includes(remote)) {
      return this.#finish(id, { state: remote, output, error: str(body?.error, 500) });
    }
    return this.#patch(id, { state: 'running', output, remoteStatus: remote });
  }

  async cancel(id) {
    const task = this.get(id);
    if (!task) throw new Error(`没有任务 #${id}`);
    if (TERMINAL.has(task.state)) return task;
    if (task.protocol !== 'task' || !task.remoteId) throw new Error('这个任务不支持取消（同步协议或尚未派发成功）');
    const c = labBridgeConfig();
    const res = await fetchWithTimeout(`${c.baseUrl}/v1/tasks/${encodeURIComponent(task.remoteId)}/cancel`, {
      method: 'POST', headers: this.#headers(c), body: '{}'
    }, { timeoutMs: 10000, fetchFn: this.fetchFn });
    if (!res.ok) throw new Error(`取消失败 HTTP ${res.status}`);
    return this.refresh(id);
  }

  #finish(id, patch) {
    const task = this.#patch(id, { ...patch, finishedAt: this.now() });
    if (this.pollers.has(id)) { clearTimeout(this.pollers.get(id)); this.pollers.delete(id); }
    if (task) this.#report(task).catch((error) => this.log(`[lab-bridge] 回报 #${id} 失败：${error?.message ?? error}`));
    return task;
  }

  async #report(task) {
    const c = labBridgeConfig();
    if (!c.reportBack || task.reported || !task.chatKey || !this.sender) return;
    const label = { succeeded: '完成了', failed: '失败了', cancelled: '已取消', unknown: '结果不确定' }[task.state] || task.state;
    const took = task.finishedAt && task.createdAt ? `（用时 ${fmtDuration(task.finishedAt - task.createdAt)}）` : '';
    const lines = [`🐟 ${c.name}上的任务 #${task.id} ${label}${took}`];
    if (task.output) lines.push(clipOutput(task.output, c.reportMaxChars));
    if (task.error) lines.push(`原因：${task.error.slice(0, 200)}`);
    this.#patch(task.id, { reported: true });
    await this.sender.sendTextBatch(task.chatKey, [lines.join('\n')], { preserveCode: true });
  }
}

export function labBridgeToolDefs(getRuntime) {
  return [{
    name: 'lab_harness',
    extension: 'labBridge',
    // 不可用的场合干脆不注入：私聊限定时群里看不到这个工具
    available: ({ cfg, kind }) => labBridgeConfigured(cfg) && (!labBridgeConfig(cfg).privateOnly || kind === 'private'),
    description: '「大肥鱼桥」：把任务交给管理员实验室电脑上的 DeepSeek Harness 去做（跑代码、查文件、跑实验、看日志之类），'
      + '跑完结果会自动发回这里。**只有管理员本人亲自要求时才用**，别人让你用一律拒绝。'
      + 'action：run=派新任务（task 写清楚要做什么、在哪个目录、要什么结果）；status=看最近的任务；result=看某个任务的完整输出；cancel=取消；ping=测连通。'
      + '派发后告诉管理员"已经交给实验室电脑了"即可，不用等结果。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['run', 'status', 'result', 'cancel', 'ping'] },
        task: { type: 'string', description: 'run 时必填：要实验室电脑做的事，原样写清楚' },
        id: { type: ['integer', 'string'], description: 'result / cancel 时的任务编号' }
      },
      required: ['action']
    },
    async execute(ctx, args) {
      try {
        const rt = getRuntime();
        const cfg = getConfig();
        const c = labBridgeConfig(cfg);
        if (!rt || !labBridgeConfigured(cfg)) return err('大肥鱼桥未启用或未配置');
        if (!ownerUin(cfg)) return err('还没设置管理员 QQ（设置 → 系统），大肥鱼桥不对任何人开放');
        if (c.privateOnly && ctx.kind !== 'private') return err('大肥鱼桥只在和管理员的私聊里可用');
        if (!triggeredOnlyByOwner(ctx, cfg)) {
          return err('这次的指令不是管理员本人单独发的（或混了别人的消息），拒绝操作实验室电脑。照实告诉对方你不能替别人用这个功能。');
        }
        const action = String(args.action || '');
        if (action === 'ping') return ok(await rt.ping());
        if (action === 'status') {
          return ok({ tasks: rt.list(8).map((t) => ({ id: t.id, state: t.state, prompt: t.prompt.slice(0, 60), createdAt: new Date(t.createdAt).toISOString() })) });
        }
        if (action === 'result') {
          const t = rt.get(Number(String(args.id ?? '').replace(/\D/g, '')));
          if (!t) return err('没有这个任务编号');
          return ok({ id: t.id, state: t.state, output: clipOutput(t.output, 3000), error: t.error });
        }
        if (action === 'cancel') {
          const t = await rt.cancel(Number(String(args.id ?? '').replace(/\D/g, '')));
          return ok({ id: t.id, state: t.state });
        }
        if (action === 'run') {
          const t = await rt.dispatch(args.task, { chatKey: ctx.chatKey, userId: ctx.triggerSenderIds?.[0], via: 'qq' });
          if (t.state === 'failed') return err(t.error);
          if (t.state === 'unknown') return ok({ id: t.id, state: t.state, note: `${t.error}。如实告诉管理员这个情况。` });
          return ok({ id: t.id, state: t.state, note: `已派给${c.name}，结束后会自动把结果发回来。简短告诉管理员一声就行。` });
        }
        return err('未知 action');
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  }];
}

export function registerLabBridgeRoutes(router, deps = {}) {
  // 显式取别名而不是解构参数：ops scan 的未定义调用扫描器不认识解构参数（见 console/router.js）
  const json = deps.json;
  const readBody = deps.readBody;
  const getRuntime = deps.getRuntime;
  const keyEndpointAllowed = deps.keyEndpointAllowed || (() => true);
  router.add('GET', '/api/ext/lab-bridge', async (req, res) => json(res, 200, { ok: true, ...getRuntime().status() }));
  router.add('GET', /^\/api\/ext\/lab-bridge\/tasks\/(\d+)$/, async (req, res, params) => {
    const task = getRuntime().get(Number(params[1]));
    return json(res, task ? 200 : 404, task ? { ok: true, task } : { ok: false, error: '没有这个任务' });
  });
  router.add('POST', '/api/ext/lab-bridge/config', async (req, res) => {
    if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝。' });
    const body = await readBody(req).catch(() => ({}));
    try {
      const config = saveLabBridgeConfig(body?.config || body);
      getRuntime().reconfigure();
      return json(res, 200, { ok: true, config });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });
  router.add('POST', '/api/ext/lab-bridge/ping', async (req, res) => {
    try {
      return json(res, 200, await getRuntime().ping());
    } catch (error) {
      return json(res, 200, { ok: false, error: String(error?.message ?? error) });
    }
  });
  router.add('POST', '/api/ext/lab-bridge/dispatch', async (req, res) => {
    if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝。' });
    const body = await readBody(req).catch(() => ({}));
    if (body?.confirm !== true) return json(res, 409, { ok: false, error: '会在实验室电脑上执行：请带 confirm=true' });
    try {
      const task = await getRuntime().dispatch(body.prompt, { chatKey: str(body.reportTo, 64), via: 'console' }, { bypassQuota: true });
      return json(res, 200, { ok: task.state !== 'failed', task });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });
  router.add('POST', /^\/api\/ext\/lab-bridge\/tasks\/(\d+)\/(refresh|cancel)$/, async (req, res, params) => {
    try {
      const rt = getRuntime();
      const task = params[2] === 'cancel' ? await rt.cancel(Number(params[1])) : await rt.refresh(Number(params[1]));
      return json(res, 200, { ok: true, task });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });
}

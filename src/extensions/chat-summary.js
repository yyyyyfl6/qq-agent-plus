// 群聊总结（参考 AstrBot 的 chatsummary 类插件）：群友说"总结一下刚才聊了啥 / 我错过了什么"时，
// 模型调 summarize_chat，把最近 N 条（或最近 N 小时）的聊天交给模型做一次结构化总结，
// 结果交还给聊天模型，由它用自己的口吻发出去。
//
// 与已有的「群日报」（features/group-digest.js，每天定时自动发）互补：这里是**按需**的。
// 控制台页面可以对任意会话"生成预览"（不发送）或确认后发到群里。
//
// 成本闸门：每会话每小时次数上限 + 全局每小时上限（一次总结 ≈ 一次长输入的模型调用）。
import { getConfig, updateConfig } from '../core/config.js';
import { chatCompletion } from '../llm/llm.js';
import { createQuota } from '../core/quota.js';
import { sanitizeUserText } from '../core/util.js';
import { clampInt, err, isPlainObject, ok, str } from './shared.js';

export const CHAT_SUMMARY_DEFAULTS = Object.freeze({
  enabled: false,
  defaultMessages: 120,     // 没说条数时总结最近多少条
  maxMessages: 500,         // 单次最多读多少条
  maxInputChars: 16000,     // 喂给模型的聊天样本上限
  maxPerHourPerChat: 3,
  maxPerHour: 12,
  style: 'structured',      // structured = 分话题要点；casual = 群友口吻三五句
  // 专属指令（唤醒前消费，结果直接发出；见 extensions/commands.js）
  commands: ['/总结', '总结一下'],
  commandAccess: 'everyone' // everyone（受每小时额度约束）| owner
});

/** 指令列表：去空白、去重、限长；不允许换行。 */
function normalizeCommands(value, fallback) {
  const list = Array.isArray(value) ? value : fallback;
  return [...new Set(list.map((c) => String(c ?? '').trim()).filter((c) => c && c.length <= 20 && !/[\r\n]/.test(c)))].slice(0, 6);
}


export function chatSummaryConfig(cfg = getConfig()) {
  const raw = isPlainObject(cfg?.chatSummary) ? cfg.chatSummary : {};
  return {
    enabled: raw.enabled === true,
    defaultMessages: clampInt(raw.defaultMessages, 20, 1000, CHAT_SUMMARY_DEFAULTS.defaultMessages),
    maxMessages: clampInt(raw.maxMessages, 20, 2000, CHAT_SUMMARY_DEFAULTS.maxMessages),
    maxInputChars: clampInt(raw.maxInputChars, 2000, 60000, CHAT_SUMMARY_DEFAULTS.maxInputChars),
    maxPerHourPerChat: clampInt(raw.maxPerHourPerChat, 1, 60, CHAT_SUMMARY_DEFAULTS.maxPerHourPerChat),
    maxPerHour: clampInt(raw.maxPerHour, 1, 200, CHAT_SUMMARY_DEFAULTS.maxPerHour),
    style: raw.style === 'casual' ? 'casual' : 'structured',
    commands: normalizeCommands(raw.commands, CHAT_SUMMARY_DEFAULTS.commands),
    commandAccess: raw.commandAccess === 'owner' ? 'owner' : 'everyone'
  };
}

export function saveChatSummaryConfig(patch = {}) {
  const merged = { ...chatSummaryConfig(), ...(isPlainObject(patch) ? patch : {}) };
  const normalized = chatSummaryConfig({ chatSummary: merged });
  updateConfig({ chatSummary: normalized });
  return normalized;
}

const STYLE_PROMPTS = {
  structured: [
    '请把下面这段群聊整理成一份"错过的人看了就能跟上"的总结，纯文本、不用 Markdown 符号（不要 #、**、表格）。格式：',
    '第一行：一句话概括这段时间大家主要在聊什么。',
    '接着按话题分段（最多 5 个，按热度排序），每段一行起头写"· 话题名（主要参与：名字1、名字2）"，下面 1~2 行写经过与结论/没定下来的地方。',
    '如果有明确的约定、待办、时间安排，最后单独一行"📌 "开头列出来。',
    '可以挑一句有意思的原话作为"💬 金句"（不要挑涉及隐私或会让人难堪的）。',
    '整体不超过 400 字。只写聊天里真有的内容，不要编。'
  ].join('\n'),
  casual: [
    '请用群友随口复盘的口吻，3~5 句话说说下面这段群聊大家都聊了啥、有啥好玩的、定下了什么事。',
    '不列清单、不用 Markdown、不写"总结如下"这类公文腔；带上关键人物的名字；只写聊天里真有的内容。'
  ].join('\n')
};

export class ChatSummaryRuntime {
  constructor({ store = null, sender = null, log = console.log, now = () => Date.now(), complete = chatCompletion } = {}) {
    this.store = store;
    this.sender = sender;
    this.log = log;
    this.now = now;
    this.complete = complete;
    this.quota = createQuota({ windowMs: 3600_000 });
    this.history = [];        // 最近 20 次（控制台查看用；内存即可，重启清空无妨）
  }

  status() {
    return { config: chatSummaryConfig(), history: this.history.slice(0, 20) };
  }

  /** 取样本：按条数或按小时取最近的消息，跳过空文本，保留机器人自己的发言（标为"我"）。 */
  collect(chatKey, { count = 0, hours = 0 } = {}) {
    const c = chatSummaryConfig();
    const limit = clampInt(count || c.defaultMessages, 5, c.maxMessages, c.defaultMessages);
    let rows = this.store.recent(chatKey, { limit: hours ? c.maxMessages : limit, includeSelf: true, readOnly: false });
    if (hours) {
      const since = this.now() - clampInt(hours, 1, 72, 6) * 3600_000;
      rows = rows.filter((m) => Number(m.ts) >= since).slice(-c.maxMessages);
    }
    const usable = rows.filter((m) => String(m?.text || '').trim());
    const byUser = new Map();
    for (const m of usable) {
      if (m.self) continue;
      const id = String(m.senderId || '');
      const cur = byUser.get(id) || { name: sanitizeUserText(m.senderName || id), count: 0 };
      cur.count += 1;
      byUser.set(id, cur);
    }
    const lines = [];
    let used = 0;
    for (const m of [...usable].reverse()) {
      const who = m.self ? '我' : sanitizeUserText(m.senderName || m.senderId);
      const line = `${who}: ${String(m.text).replace(/\s+/g, ' ').slice(0, 200)}`;
      if (used + line.length > c.maxInputChars) break;
      lines.push(line);
      used += line.length;
    }
    lines.reverse();
    const first = usable[usable.length - lines.length] || usable[0];
    const last = usable[usable.length - 1];
    return {
      lines,
      total: usable.length,
      used: lines.length,
      from: Number(first?.ts) || 0,
      to: Number(last?.ts) || 0,
      top: [...byUser.values()].sort((a, b) => b.count - a.count).slice(0, 5)
    };
  }

  #gate(chatKey) {
    const c = chatSummaryConfig();
    this.quota.configure({ globalMax: c.maxPerHour, perChatMax: c.maxPerHourPerChat });
    const at = this.now();
    const gate = this.quota.tryConsume(chatKey, at);
    return { ...gate, at };
  }

  async summarize(chatKey, { count = 0, hours = 0, focus = '', style = '', signal = null, bypassQuota = false } = {}) {
    if (!this.store) throw new Error('消息存储不可用');
    const c = chatSummaryConfig();
    const sample = this.collect(chatKey, { count, hours });
    if (sample.used < 5) throw new Error(`可总结的消息太少（${sample.used} 条）`);
    let reserved = null;
    if (!bypassQuota) {
      reserved = this.#gate(chatKey);
      if (!reserved.ok) {
        throw new Error(reserved.scope === 'chat'
          ? '这个群这小时已经总结过好几次了，过一会儿再来'
          : '总结次数这小时用完了（全局上限）');
      }
    }
    try {
      const fmt = (ts) => new Date(ts + 8 * 3600_000).toISOString().slice(5, 16).replace('T', ' ');
      const header = [
        `时间范围：${fmt(sample.from)} ~ ${fmt(sample.to)}（北京时间），共 ${sample.used} 条。`,
        `发言最多：${sample.top.map((t) => `${t.name}(${t.count})`).join('、') || '无'}`,
        focus ? `提问的人特别想知道：${str(focus, 120)}（总结时侧重这一点）` : ''
      ].filter(Boolean).join('\n');
      const r = await this.complete({
        messages: [
          { role: 'system', content: STYLE_PROMPTS[style === 'casual' || style === 'structured' ? style : c.style] },
          { role: 'user', content: `${header}\n\n${sample.lines.join('\n')}` }
        ],
        temperature: 0.4,
        signal,
        purpose: 'write'
      });
      const text = String(r?.message?.content || '').trim().slice(0, 1500);
      if (!text) throw new Error('模型没有产出总结');
      const record = { at: this.now(), chatKey, messages: sample.used, from: sample.from, to: sample.to, text, sent: false };
      this.history.unshift(record);
      this.history = this.history.slice(0, 20);
      return record;
    } catch (error) {
      if (reserved?.ok) this.quota.refund(chatKey, reserved.at);
      throw error;
    }
  }

  async send(chatKey, text) {
    if (!this.sender) throw new Error('发送通道不可用');
    const parts = String(text || '').split(/\n{2,}/).map((s) => s.trim()).filter(Boolean).slice(0, 6);
    if (!parts.length) throw new Error('内容为空');
    const result = await this.sender.sendTextBatch(chatKey, parts, {});
    const rec = this.history.find((h) => h.chatKey === chatKey && h.text === text);
    if (rec) rec.sent = true;
    return { sent: result?.sent?.length ?? parts.length, failed: result?.failed?.length ?? 0 };
  }
}

export function chatSummaryToolDefs(getRuntime) {
  return [{
    name: 'summarize_chat',
    extension: 'chatSummary',
    available: ({ cfg }) => chatSummaryConfig(cfg).enabled,
    description: '总结当前群/私聊最近的聊天（群友问"刚才聊了啥""我错过了什么""总结一下"时用）。'
      + '可按条数（count）或按最近几小时（hours）取；focus 写对方特别想知道的点。'
      + '返回的是总结草稿：用 send_message 发出去（可以按段分几条，口吻随你），别原样加"总结如下"。有每小时次数上限。',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'integer', description: '总结最近多少条消息（默认按设置，常见 50~300）' },
        hours: { type: 'integer', description: '或者：总结最近几小时（1~72），给了就优先按时间取' },
        focus: { type: 'string', description: '可选：对方特别关心的点，如"关于周末聚餐定了没"' },
        style: { type: 'string', enum: ['structured', 'casual'], description: '可选：structured=分话题要点；casual=三五句随口复盘' }
      }
    },
    async execute(ctx, args) {
      try {
        const rt = getRuntime();
        if (!rt) return err('群聊总结未初始化');
        const rec = await rt.summarize(ctx.chatKey, {
          count: args.count, hours: args.hours, focus: args.focus, style: args.style, signal: ctx.signal
        });
        return ok({ messages: rec.messages, summary: rec.text, next: '用 send_message 把它发出去（长的话按段分几条）' });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  }];
}

export function registerChatSummaryRoutes(router, deps = {}) {
  // 显式取别名而不是解构参数：ops scan 的未定义调用扫描器不认识解构参数（见 console/router.js）
  const json = deps.json;
  const readBody = deps.readBody;
  const getRuntime = deps.getRuntime;
  const keyEndpointAllowed = deps.keyEndpointAllowed || (() => true);
  router.add('GET', '/api/ext/chat-summary', async (req, res) => json(res, 200, { ok: true, ...getRuntime().status() }));
  router.add('POST', '/api/ext/chat-summary/config', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    try {
      return json(res, 200, { ok: true, config: saveChatSummaryConfig(body?.config || body) });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });
  router.add('POST', '/api/ext/chat-summary/preview', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const chatKey = str(body.chatKey, 64);
    if (!/^(group|private):\d+$/.test(chatKey)) return json(res, 400, { ok: false, error: '请选择一个会话' });
    try {
      // 控制台预览由管理员手动触发：不占聊天侧的每小时额度
      const rec = await getRuntime().summarize(chatKey, {
        count: body.count, hours: body.hours, focus: body.focus, style: body.style, bypassQuota: true
      });
      return json(res, 200, { ok: true, record: rec });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });
  router.add('POST', '/api/ext/chat-summary/send', async (req, res) => {
    if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝。' });
    const body = await readBody(req).catch(() => ({}));
    if (body?.confirm !== true) return json(res, 409, { ok: false, error: '发到群里是对外可见操作：请带 confirm=true' });
    const chatKey = str(body.chatKey, 64);
    if (!/^(group|private):\d+$/.test(chatKey)) return json(res, 400, { ok: false, error: '请选择一个会话' });
    try {
      return json(res, 200, { ok: true, ...(await getRuntime().send(chatKey, str(body.text, 1500))) });
    } catch (error) {
      return json(res, 502, { ok: false, error: String(error?.message ?? error) });
    }
  });
}

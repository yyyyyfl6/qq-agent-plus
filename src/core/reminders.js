// 定时提醒：群友让机器人"X 点提醒我 Y" —— 落盘持久化（重启不丢），到点走主动唤醒，
// 由模型用人设口吻把提醒说出来（而不是系统模板直发）。
// 与 schedule_wake 的区别：那个是"给自己排开口时机"、内存态、每会话只留一条；
// 这里是"给别人设的承诺"、持久化、可多条、可查询/取消。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';
import { minuteOfDayInZone, sanitizeUserText } from './util.js';

const FILE = path.join(DATA_DIR, 'reminders.json');
export const MAX_REMINDER_TEXT = 200;
const MAX_PER_CHAT = 10;      // 单个会话待触发上限（防刷）
const MAX_PENDING = 50;       // 全局待触发上限
const DONE_KEEP = 5;          // 每个会话保留最近几条已完成记录（供 list 查看）
const MAX_DELAY_MS = 30 * 24 * 60 * 60 * 1000; // 最多 30 天后（再远没意义）
const EXPIRE_AFTER_MS = 12 * 60 * 60 * 1000;   // 离线导致迟到超过 12 小时 → 作废不补发

// ── 周期提醒（repeat）与 IANA 时区 ─────────────────────────────────────────
// repeat = { kind: 'daily'|'weekly'|'cron', hour, minute, weekday, cron, tz, jitterMs }
// 到点触发后 markFired 不再结束，而是重算下一次（re-arm）；错过只补最近一次（见 reconcileRecurring）。
const DOW_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/** IANA 时区合法性（本机 Intl 认不出就拒，fail-closed）。 */
export function validTimezone(tz) {
  const name = String(tz || '').trim();
  if (!name) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: name }); return true; } catch { return false; }
}

/** 时刻 ms 在时区 tz 里的挂钟时间 { hour, minute, dow }。 */
export function zonedWallClock(ms, tz) {
  const parts = {};
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit'
  }).formatToParts(ms)) parts[part.type] = part.value;
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;   // 某些 ICU 把午夜格式化成 24
  return { hour, minute: Number(parts.minute), dow: DOW_NAMES[String(parts.weekday || '').toLowerCase()] ?? 0 };
}

/** 下一天（挂钟）的 hour:minute。跨 DST 用"结果回读校正"兜一圈（最多 2 次）。 */
export function nextDailyAt({ hour, minute }, tz, afterMs) {
  const cur = zonedWallClock(afterMs, tz);
  let delta = (hour * 60 + minute) - (cur.hour * 60 + cur.minute);
  if (delta <= 0) delta += 1440;
  let result = afterMs + delta * 60000;
  for (let i = 0; i < 2; i += 1) {
    const wall = zonedWallClock(result, tz);
    const want = (hour * 60 + minute) - (wall.hour * 60 + wall.minute);
    if (want === 0) break;
    result += want * 60000;
  }
  return result;
}

/** 下一个星期几的 hour:minute（weekday 0=周日）。 */
export function nextWeeklyAt({ weekday, hour, minute }, tz, afterMs) {
  const cur = zonedWallClock(afterMs, tz);
  const curAbs = cur.dow * 1440 + cur.hour * 60 + cur.minute;
  const want = ((weekday % 7) * 1440) + hour * 60 + minute;
  let delta = want - curAbs;
  while (delta <= 0) delta += 10080;
  let result = afterMs + delta * 60000;
  for (let i = 0; i < 2; i += 1) {
    const wall = zonedWallClock(result, tz);
    const wallAbs = wall.dow * 1440 + wall.hour * 60 + wall.minute;
    const fix = want - wallAbs;
    if (fix === 0) break;
    result += fix * 60000;
  }
  return result;
}

/** 5 字段简化 cron：分 时 日 月 周。日/月只认 *；分/时/周支持数字、列表 a,b、区间 a-b、步进 。
 *  返回 { minutes:Set, hours:Set, dows:Set } 或 null（不合法）。 */
export function parseCron5(expr) {
  const fields = String(expr || '').trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minF, hourF, domF, monF, dowF] = fields;
  if (domF !== '*' || monF !== '*') return null;
  const parseField = (field, min, max, names = {}) => {
    const out = new Set();
    for (const part of field.split(',')) {
      if (part === '*') {   // 裸 * = 全量（每分钟/每小时/每天）：漏了它 '0 9 * * *' 都解析不出来
        for (let v = min; v <= max; v += 1) out.add(v);
        continue;
      }
      const stepMatch = /^\*\/(\d+)$/.exec(part);
      if (stepMatch) {
        const step = Number(stepMatch[1]);
        if (!Number.isInteger(step) || step <= 0) return null;
        for (let v = min; v <= max; v += step) out.add(v);
        continue;
      }
      const range = /^(\w+)-(\w+)(?:\/(\d+))?$/.exec(part);
      if (range) {
        const a = /^\d+$/.test(range[1]) ? Number(range[1]) : names[range[1].toLowerCase()];
        const b = /^\d+$/.test(range[2]) ? Number(range[2]) : names[range[2].toLowerCase()];
        const step = range[3] ? Number(range[3]) : 1;
        if (!Number.isInteger(a) || !Number.isInteger(b) || a < min || b > max || a > b || step <= 0) return null;
        for (let v = a; v <= b; v += step) out.add(v);
        continue;
      }
      const single = /^\d+$/.test(part) ? Number(part) : names[part.toLowerCase()];
      if (!Number.isInteger(single) || single < min || single > max) return null;
      out.add(single);
    }
    return out.size ? out : null;
  };
  const minutes = parseField(minF, 0, 59);
  const hours = parseField(hourF, 0, 23);
  const dows = parseField(dowF, 0, 6, DOW_NAMES);
  if (!minutes || !hours || !dows) return null;
  if (dows.has(7)) { dows.delete(7); dows.add(0); }
  return { minutes, hours, dows };
}

/** 下一个满足 cron 的时刻（逐分钟扫描，一周上限 10080 次循环，开销可忽略）。 */
export function nextCronAt(cron, tz, afterMs) {
  const parsed = typeof cron === 'string' ? parseCron5(cron) : cron;
  if (!parsed) return null;
  let cursor = afterMs - (afterMs % 60000) + 60000;
  for (let i = 0; i < 10080; i += 1) {
    const wall = zonedWallClock(cursor, tz);
    if (parsed.minutes.has(wall.minute) && parsed.hours.has(wall.hour) && parsed.dows.has(wall.dow)) return cursor;
    cursor += 60000;
  }
  return null;
}

/** 落在免打扰窗口（挂钟 HH:MM-HH:MM）内 → 顺延到窗口结束；最多顺延两次防死循环。 */
function pushOutOfQuiet(atMs, tz, quiet) {
  if (!quiet || !quiet.start || !quiet.end) return atMs;
  const toMin = (t) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(t).trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const start = toMin(quiet.start);
  const end = toMin(quiet.end);
  if (start === null || end === null) return atMs;
  let result = atMs;
  for (let i = 0; i < 2; i += 1) {
    const wall = zonedWallClock(result, tz);
    const cur = wall.hour * 60 + wall.minute;
    const inWindow = start <= end ? (cur >= start && cur < end) : (cur >= start || cur < end);
    if (!inWindow) return result;
    let delta = end - cur;
    if (delta <= 0) delta += 1440;
    result += delta * 60000;
  }
  return result;
}

/** repeat 项的"下一次出现"：目标时刻 + 抖动 + 免打扰顺延。非法 repeat 返回 null。 */
export function nextOccurrenceAt(item, afterMs, { quiet = null } = {}) {
  const repeat = item?.repeat;
  if (!repeat || typeof repeat !== 'object') return null;
  const tz = validTimezone(repeat.tz) ? repeat.tz : 'Asia/Shanghai';
  const jitter = Math.max(0, Math.min(3600000, Number(repeat.jitterMs) || 0));
  let at = null;
  if (repeat.kind === 'daily') {
    if (!Number.isInteger(repeat.hour) || !Number.isInteger(repeat.minute)) return null;
    at = nextDailyAt({ hour: repeat.hour, minute: repeat.minute }, tz, afterMs);
  } else if (repeat.kind === 'weekly') {
    if (!Number.isInteger(repeat.weekday) || !Number.isInteger(repeat.hour) || !Number.isInteger(repeat.minute)) return null;
    at = nextWeeklyAt({ weekday: repeat.weekday, hour: repeat.hour, minute: repeat.minute }, tz, afterMs);
  } else if (repeat.kind === 'cron') {
    at = nextCronAt(repeat.cron, tz, afterMs);
  }
  if (at === null) return null;
  if (jitter) at += Math.floor(Math.random() * jitter);
  return pushOutOfQuiet(at, tz, quiet);
}

/** repeat 描述的校验与归一（add 入口用）：非法抛可读错误。 */
export function normalizeRepeat(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (/^daily$/i.test(text)) return { kind: 'daily', hour: 9, minute: 0 };
    const weekly = /^weekly[:：]\s*(sun|mon|tue|wed|thu|fri|sat|\d)$/i.exec(text);
    if (weekly) {
      const w = weekly[1].toLowerCase();
      return { kind: 'weekly', weekday: DOW_NAMES[w] ?? (Number(w) % 7), hour: 9, minute: 0 };
    }
    if (/\s/.test(text)) {
      if (parseCron5(text)) return { kind: 'cron', cron: text };
      throw new Error('cron 表达式不合法（5 字段：分 时 日 月 周；日/月只认 *）');
    }
    throw new Error('repeat 只支持 daily / weekly:周几 / 5 字段 cron');
  }
  if (typeof raw !== 'object') throw new Error('repeat 格式不合法');
  const kind = String(raw.kind || '').toLowerCase();
  if (!['daily', 'weekly', 'cron'].includes(kind)) throw new Error('repeat.kind 只能是 daily / weekly / cron');
  const tz = raw.tz === undefined || raw.tz === null || raw.tz === '' ? undefined : String(raw.tz).trim();
  if (tz !== undefined && !validTimezone(tz)) throw new Error(`tz 不是合法的 IANA 时区：${tz}`);
  const jitterMs = raw.jitterMs === undefined ? 0 : Math.max(0, Math.min(3600000, Math.floor(Number(raw.jitterMs) || 0)));
  if (kind === 'cron') {
    if (!parseCron5(String(raw.cron || ''))) throw new Error('cron 表达式不合法（5 字段，日/月只认 *）');
    return { kind, cron: String(raw.cron).trim(), ...(tz ? { tz } : {}), ...(jitterMs ? { jitterMs } : {}) };
  }
  // 缺省与字符串写法同口径：只给 kind 时按 09:00；给了 hour 没给 minute 按整点。
  const hour = raw.hour === undefined ? 9 : Number(raw.hour);
  const minute = raw.minute === undefined ? 0 : Number(raw.minute);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error('repeat 需要 hour(0-23) 与 minute(0-59)');
  }
  if (kind === 'weekly') {
    const weekday = Number(raw.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new Error('weekly 需要 weekday(0=周日 … 6=周六)');
    return { kind, weekday, hour, minute, ...(tz ? { tz } : {}), ...(jitterMs ? { jitterMs } : {}) };
  }
  return { kind, hour, minute, ...(tz ? { tz } : {}), ...(jitterMs ? { jitterMs } : {}) };
}

/** "HH:MM" → 下一次出现的绝对毫秒（按项目统一时区 UTC+8；已过则算明天）。非法返回 null。 */
export function nextAtFromHHMM(hhmm, now = Date.now()) {
  const m = /^(\d{1,2})[:：](\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  const nowMin = minuteOfDayInZone(now);
  const targetMin = hour * 60 + minute;
  let deltaMin = targetMin - nowMin;
  if (deltaMin <= 0) deltaMin += 24 * 60;   // 已过（或就是此刻）→ 明天同一时刻
  return now + deltaMin * 60 * 1000;
}

export class ReminderStore {
  constructor(file = FILE) {
    this.file = file;
    this.items = this.#load();
  }

  #load() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (error) {
      // 首次运行没有文件是正常的，只有"文件在但读不了"才值得报警并留档：
      // 静默返回空数组的后果是「提示没设成」——下一次 #save 会用空列表覆盖掉
      // 那份损坏文件，用户再也查不出提醒为什么消失（2026-09-29 审查 P2）。
      if (error?.code !== 'ENOENT') {
        console.error(`[reminder] 读取 ${this.file} 失败，本次按"没有提醒"处理，原文件已备份为 .broken-<时间戳>：`, error?.message ?? error);
        try { fs.renameSync(this.file, `${this.file}.broken-${Date.now()}`); } catch { /* 备份失败就留在原处，至少不覆盖 */ }
      }
      return [];
    }
    return Array.isArray(raw?.items) ? raw.items.filter((x) => x && x.id && x.chatKey && x.at) : [];
  }

  #save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      // 与全仓其它落盘点同口径：tmp + rename 原子替换（此前这里是唯一的直接覆盖写），
      // flush 让 rename 之前数据已经落盘，避免断电后留下"改名成功、内容为空"的文件。
      const tmp = `${this.file}.${process.pid}.tmp`;
      try { fs.rmSync(tmp, { force: true }); } catch { /* 不存在就算了 */ }
      fs.writeFileSync(tmp, JSON.stringify({ items: this.items }, null, 2), { encoding: 'utf8', mode: 0o600, flush: true });
      fs.renameSync(tmp, this.file);
      fs.chmodSync(this.file, 0o600);
    } catch (error) {
      // 落盘失败不影响内存态，但必须留痕：此前静默吞掉，磁盘满时用户看到"设好了"，
      // 重启后提醒全没了且没有任何线索（2026-09-29 审查 P2）。
      console.error('[reminder] 落盘失败（内存态继续用，重启会丢）:', error?.message ?? error);
    }
  }

  #prune() {
    // 每个会话只保留最近 DONE_KEEP 条已完成（fired/expired/canceled），pending 不剪
    const byChat = new Map();
    for (const it of this.items) {
      if (it.status === 'pending') continue;
      const list = byChat.get(it.chatKey) || [];
      list.push(it);
      byChat.set(it.chatKey, list);
    }
    const drop = new Set();
    for (const list of byChat.values()) {
      list.sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
      for (const it of list.slice(DONE_KEEP)) drop.add(it.id);
    }
    if (drop.size) this.items = this.items.filter((it) => !drop.has(it.id));
  }

  /** 新增一条提醒。返回 { id, at }；超出限制/参数非法时抛带可读原因的错。
   *  createdBy = 谁提的（"a 让你提醒 b"里的 a）；targetName = 提醒谁（b）。
   *  两者都是可选的事实信息，只用于到点派发时的话术归属（2026-10-10 用户反馈：
   *  此前不记归属，派发话术又套着"你给自己留过话"的框架，模型会自己圆归属）。 */
  add({ chatKey, at, text, createdBy = '', targetName = '', repeat = null, quiet = null }) {
    const when = Number(at);
    // 提醒正文是"用户可诱导模型原样搬运"的文本，落盘前统一弱化段头（提示注入面，2026-09-28 审查 P2）
    const body = sanitizeUserText(String(text || '').trim()).slice(0, MAX_REMINDER_TEXT);
    if (!chatKey) throw new Error('缺少会话');
    if (!body) throw new Error('提醒内容不能为空');
    if (!Number.isFinite(when)) throw new Error('提醒时间不合法');
    const now = Date.now();
    if (when <= now + 5000) throw new Error('提醒时间必须晚于现在');
    if (when - now > MAX_DELAY_MS) throw new Error('最多只能设到 30 天后');
    // #9：先把"早就过期、还没被巡检标掉"的项标成 expired（它们才是真占着 pending 名额的那批），
    // 再剪留档，最后判上限 —— 否则用户会因为一堆早该作废的提醒而被告知"满了"。
    let expiredNow = false;
    for (const it of this.expired(now)) { it.status = 'expired'; it.finishedAt = now; expiredNow = true; }
    this.#prune();
    if (expiredNow) this.#save();
    const pendingNow = () => this.items.filter((it) => it.status === 'pending');
    if (pendingNow().filter((it) => it.chatKey === chatKey).length >= MAX_PER_CHAT) {
      throw new Error('本会话待触发提醒已达上限（10 条），先取消一些');
    }
    if (pendingNow().length >= MAX_PENDING) {
      throw new Error('全局提醒位已满（每人上限 10 条，共 50 条），先取消一些');
    }
    const repeatNormalized = normalizeRepeat(repeat);
    if (repeatNormalized) {
      // 周期项：传入的 at 只是"第一次触发点"，之后 markFired 自动续
      if (when - now > MAX_DELAY_MS) throw new Error('首次触发最多只能设到 30 天后');
    }
    const item = {
      id: crypto.randomBytes(4).toString('hex'),
      chatKey,
      at: when,
      text: body,
      // 归属名与其他入口同口径（段头弱化 + 截断）：它们会进派发 note，也在注入面里
      createdBy: sanitizeUserText(String(createdBy || '').trim()).slice(0, 40),
      targetName: sanitizeUserText(String(targetName || '').trim()).slice(0, 40),
      status: 'pending',
      createdAt: now,
      // originalAt 是承诺时间，deferTo 外因顺延会更新；投递重试不会。
      originalAt: when,
      deliveryAttempts: 0,
      firedAt: null,
      finishedAt: null,
      ...(repeatNormalized ? { repeat: repeatNormalized, fireCount: 0, dueKeys: [] } : {}),
      ...(repeatNormalized && quiet && quiet.start && quiet.end ? { quiet: { start: String(quiet.start).slice(0, 5), end: String(quiet.end).slice(0, 5) } } : {})
    };
    this.items.push(item);
    this.#save();
    return { id: item.id, at: item.at };
  }

  cancel({ id = '', chatKey = '' }) {
    const key = String(id || '').trim();
    // 不传 id 时：取消该会话**最近一条**待触发（"算了别提醒了"这种口语）。
    // 之前的写法 find(… && true) 恒命中数组里最早的一条，reverse 兜底是死代码
    // （2026-09-29 审查 P2：同一会话有两条 pending 时会取消错条）
    const hit = key
      ? this.items.find((it) => it.chatKey === chatKey && it.status === 'pending' && it.id === key)
      : [...this.items].reverse().find((it) => it.chatKey === chatKey && it.status === 'pending');
    if (!hit) return null;
    hit.status = 'canceled';
    hit.finishedAt = Date.now();
    this.#prune();
    this.#save();
    return hit;
  }

  list(chatKey, { includeDone = false } = {}) {
    return this.items
      .filter((it) => it.chatKey === chatKey && (includeDone || it.status === 'pending'))
      .sort((a, b) => a.at - b.at);
  }

  due(now = Date.now()) {
    return this.items.filter((it) => it.status === 'pending' && it.at <= now);
  }

  /** 迟到的提醒：超过 12 小时的直接作废（不补发一串"迟到的提醒"）。
   *  originalAt 是"对外承诺的到点时间"；投递重试只改 at，不能把作废时钟一起推走，
   *  否则一条永远发不出去的提醒会每 5 分钟重试、永远不过期（2026-10-21 复审 P1）。 */
  expired(now = Date.now()) {
    return this.items.filter((it) => {
      if (it.status !== 'pending') return false;
      const at = Number(it.at) || 0;
      const originalAt = Number(it.originalAt) || at;
      // 取更早的那个：投递重试只把 at 推后（仍按原承诺作废）；
      // 手工/迁移把 at 改成更早（或旧数据没有 originalAt）时也按 at 判。
      return Math.min(originalAt, at) <= now - EXPIRE_AFTER_MS;
    });
  }

  /**
   * 预算等外因挡住派发时，把到点时间显式顺延（2026-10-04 复审 P2）。
   * 只改 at、不动 status：12 小时作废时钟随新 at 重新起算 —— 否则持续超预算的当天，
   * "保持到期等明天"的提醒会在迟到满 12 小时时被 expired() 静默作废，与"顺延到明天"相反。
   */
  deferTo(id, at) {
    const hit = this.items.find((x) => x.id === id && x.status === 'pending');
    if (!hit) return null;
    hit.at = Number(at) || hit.at;
    // 预算/静默段属于"外因顺延"：承诺时间确实改到新窗口，作废时钟跟着新 at 起算。
    hit.originalAt = hit.at;
    // 外因顺延之间没有尝试过，不能把"连续未确认播报"的计数接着累计。
    hit.deliveryAttempts = 0;
    this.#save();
    return hit;
  }

  /** 投递失败后的短暂重试：只改 at，不改 originalAt；超过上限就停止自动重试。
   *  返回 { exhausted, attempts }，调用方据此记日志/告警。 */
  retryLater(id, at, { maxAttempts = 3 } = {}) {
    const hit = this.items.find((x) => x.id === id && x.status === 'pending');
    if (!hit) return { exhausted: false, attempts: 0, missing: true };
    hit.deliveryAttempts = (Number(hit.deliveryAttempts) || 0) + 1;
    if (hit.deliveryAttempts > maxAttempts) {
      hit.status = 'failed';
      hit.finishedAt = Date.now();
      hit.error = `连续 ${hit.deliveryAttempts} 次未确认播报，已停止自动重试`;
      this.#prune();
      this.#save();
      return { exhausted: true, attempts: hit.deliveryAttempts };
    }
    hit.at = Number(at) || hit.at;
    this.#save();
    return { exhausted: false, attempts: hit.deliveryAttempts };
  }

  /** 发送结果未知/确认失败时停止自动重试（避免重复发送），保留原因供人工核对。 */
  failDelivery(id, reason = '') {
    const hit = this.items.find((x) => x.id === id && x.status === 'pending');
    if (!hit) return null;
    hit.status = 'failed';
    hit.finishedAt = Date.now();
    hit.error = String(reason || '投递结果未知，已停止自动重试');
    this.#prune();
    this.#save();
    return hit;
  }

  markFired(id, now = Date.now()) {
    const it = this.items.find((x) => x.id === id);
    if (!it) return null;
    // 周期项：记下这次触发的 dueKey，重算下一次（re-arm），状态保持 pending。
    // 错过补最近一次的语义由 reconcileRecurring 在启动时处理；这里只管"触发后继续"。
    if (it.repeat && typeof it.repeat === 'object') {
      it.dueKeys = [...(Array.isArray(it.dueKeys) ? it.dueKeys : []), { due: Number(it.at) || 0, firedAt: now }].slice(-10);
      it.fireCount = (Number(it.fireCount) || 0) + 1;
      it.lastFiredAt = now;
      let next = nextOccurrenceAt(it, now, { quiet: it.quiet });
      // 护栏：markFired 被提前调用（非到期时刻）时，cron 会算回同一槽位 ——
      // 从原 at 之后重算一次，保证 re-arm 严格指向未来，避免同一期重复触发
      if (next !== null && next <= Number(it.at)) next = nextOccurrenceAt(it, Number(it.at), { quiet: it.quiet });
      if (next === null) {
        it.repeatError = '算不出下一次触发点（repeat 配置可能在时区库更新后失效），已停止';
        it.status = 'failed';
        it.finishedAt = now;
        this.#prune();
        this.#save();
        return it;
      }
      it.at = next;
      it.originalAt = next;
      it.deliveryAttempts = 0;
      this.#save();
      return { ...it, rearmed: true, nextAt: next };
    }
    it.status = 'fired';
    it.firedAt = now;
    it.finishedAt = now;
    this.#prune();
    this.#save();
    return it;
  }

  /** 启动/巡检用：错过多次只补最近一次。迟到期在 EXPIRE_AFTER_MS 内 → 留在原 at 正常晚触发
   *  （派发 note 自带"迟到了"说明）；超窗 → 直接跳到下一次未来触发点，不补发。 */
  reconcileRecurring(now = Date.now(), { quiet = null } = {}) {
    const touched = [];
    for (const it of this.items) {
      if (it.status !== 'pending' || !it.repeat || typeof it.repeat !== 'object') continue;
      if (Number(it.at) > now) continue;
      const lateMs = now - Number(it.at);
      if (lateMs <= EXPIRE_AFTER_MS) continue;   // 留着晚触发 = "补最近一次"
      const missed = it.at;
      const next = nextOccurrenceAt(it, now, { quiet: it.quiet || quiet });
      if (next === null) continue;
      it.missedCount = (Number(it.missedCount) || 0) + 1;
      it.lastMissedAt = missed;
      it.at = next;
      it.originalAt = next;
      it.deliveryAttempts = 0;
      touched.push({ id: it.id, skippedFrom: missed, nextAt: next });
    }
    if (touched.length) this.#save();
    return touched;
  }

  markExpired(id, now = Date.now()) {
    const it = this.items.find((x) => x.id === id);
    if (!it) return null;
    it.status = 'expired';
    it.finishedAt = now;
    this.#prune();
    this.#save();
    return it;
  }
}

export { EXPIRE_AFTER_MS };

// ── 派发话术（唯一真源）────────────────────────────────────────────────────
// 到点唤醒时给模型的那条 note 由这里生成；orchestrator 只管条数预算与派发。
// 归属（谁提的/提醒谁）只作为事实写进来；缺归属时明确要求"别猜"——此前话术是
// "之前有人让你…"且外面套着"你之前给自己留过话"的框架，模型只能自己圆，会把
// 别人托的提醒说成被提醒人自己设的（2026-10-10 用户反馈）。

const REMINDER_AT_FMT = { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit' };

/** 单条提醒在派发 note 里的预估占用（正文 + 归属名 + 引号/分隔开销）。
 *  派发侧的条数预算（orchestrator 的 REMINDER_NOTE_BODY_MAX）与 note 截断（600 字）
 *  必须同一口径：漏算归属名会让"装得下"的条目在截断后丢内容却照样被标记已触发。 */
export function reminderNoteCost(item) {
  return String(item?.text || '').length
    + String(item?.createdBy || '').length
    + String(item?.targetName || '').length
    + 8;
}

/** 把到点的一组提醒拼成唤醒 note（纯函数，便于单测）。 */
export function buildReminderNote(items, { now = Date.now(), lateMs = 3 * 60000 } = {}) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!list.length) return '';
  const first = list[0];
  const at = new Date(first.at).toLocaleTimeString('zh-CN', REMINDER_AT_FMT);
  const late = now - first.at;
  const whoOf = (it) => {
    const from = String(it.createdBy || '').trim();
    const to = String(it.targetName || '').trim();
    if (from && to) return `${from}请你提醒${to}`;
    if (from) return `${from}请你提醒`;
    if (to) return `有人请你提醒${to}`;
    return '';
  };
  const body = list.length === 1
    ? `之前${String(first.createdBy || '').trim() || '有人'}让你在 ${at} 提醒`
      + `${String(first.targetName || '').trim() ? `${String(first.targetName).trim()}：` : '：'}${first.text}`
    : `到点了，要你提醒的事有 ${list.length} 件：${list.map((x) => `「${x.text}」${whoOf(x) ? `（${whoOf(x)}）` : ''}`).join('、')}`;
  const hasNames = list.some((x) => String(x.createdBy || '').trim() || String(x.targetName || '').trim());
  const howto = hasNames
    ? '现在自然地把这些说出来（一两句，别说"系统提醒"）：是谁请你提醒谁的要说清，别猜也别含糊。'
    : '现在自然地把这些说出来（一两句，别说"系统提醒"）：不确定是谁托你提醒的就别猜（说"有人托我提醒"即可），更不要说是被提醒的人自己设的。';
  return `【定时提醒】${body}${late > lateMs ? '（已经迟到了一点，顺口说明下）' : ''}。${howto}`;
}

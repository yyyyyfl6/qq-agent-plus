// 扩展功能（src/extensions/*）共用的小工具：工具返回值、配置读取、文本切词、权限判定。
//
// 每个扩展是独立模块（见 docs/EXTENSIONS.md 与 docs/EXPERIMENTAL_FEATURE_STANDARD.md）：
// 自己的配置段、自己的持久化文件、自己的控制台页面与 API。这里只放"谁都要用、又不该互相 import"的部分。
import { getConfig } from '../core/config.js';

export function ok(payload) {
  return { content: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 1) };
}

export function err(message, metadata = {}) {
  return { content: `错误：${message}`, isError: true, ...metadata };
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function str(value, max = 2000) {
  return String(value ?? '').trim().slice(0, max);
}

export function ownerUin(cfg = getConfig()) {
  return String(cfg?.admin?.ownerUin || '').trim();
}

/** 取主机名（比较"是不是同一家"用；解析失败返回空串）。 */
export function hostOf(url) {
  try { return new URL(String(url || '').trim()).host.toLowerCase(); } catch { return ''; }
}

/**
 * 本轮触发者是否**全部**是管理员本人。
 * 群聊会把多人的消息聚成一批：只要批里混进一个别人的消息，就不算"管理员在下指令"——
 * 否则别人一句"让它在实验室电脑上执行 xxx"就能借管理员同批的发言提权。
 */
export function triggeredOnlyByOwner(ctx, cfg = getConfig()) {
  const owner = ownerUin(cfg);
  if (!owner) return false;
  const ids = Array.isArray(ctx?.triggerSenderIds) ? ctx.triggerSenderIds.filter(Boolean) : [];
  if (!ids.length) return false;
  return ids.every((id) => String(id) === owner);
}

/**
 * 中英混排的检索切词：英文/数字按词（小写），中日韩按"单字 + 相邻二字"。
 * 不引外部分词库：长期记忆条目短（一两句话），二元组对中文召回已经够用，且零依赖。
 */
const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/;
const STOP = new Set(['的', '了', '是', '我', '你', '他', '她', '它', '在', '有', '和', '就', '也', '都', '吗', '吧', '啊', '呢', '这', '那', '个', '不', '人']);
export function tokenize(text) {
  const out = [];
  const source = String(text || '').toLowerCase();
  let latin = '';
  let prevCjk = '';
  const flushLatin = () => {
    if (latin.length >= 2) out.push(latin);
    latin = '';
  };
  for (const ch of source) {
    if (CJK.test(ch)) {
      flushLatin();
      if (!STOP.has(ch)) out.push(ch);
      if (prevCjk) out.push(prevCjk + ch);
      prevCjk = ch;
    } else if (/[a-z0-9_]/.test(ch)) {
      prevCjk = '';
      latin += ch;
    } else {
      prevCjk = '';
      flushLatin();
    }
  }
  flushLatin();
  return out;
}

/** 两段文本的切词 Jaccard 相似度（去重判定用）。 */
export function textSimilarity(a, b) {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}

export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** 上海时区的 YYYY-MM-DD（"今日"类玩法按北京时间换日）。 */
export function shanghaiDate(ts = Date.now()) {
  return new Date(ts + 8 * 3600_000).toISOString().slice(0, 10);
}

/** 带超时的 fetch（外部服务调用统一走它，避免一次挂死拖住整轮）。 */
export async function fetchWithTimeout(url, options = {}, { timeoutMs = 30000, signal = null, fetchFn = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`)), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason ?? new Error('aborted'));
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason ?? new Error('aborted'));
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    return await fetchFn(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

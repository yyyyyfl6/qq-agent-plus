// 官方插件：热点（V2EX 热帖 + Hacker News 头条，两个源都不需要 Key）。
//
// 群里每天都会有人问"今天有啥热闹"。这个插件把它变成一个工具：模型选源、要几条，拿回一份
// 已经整理好的榜单（标题 + 链接 + 热度），直接照着讲就行。
//
// 两个源的分工：V2EX 是中文技术社区（群里中文语境用得多），HN 是英文技术圈的头条。
// 都不用 Key、都是只读查询。
//
// 配置（可选）：
//   plugins.settings.hot-topics.v2exUrl   —— 覆盖 V2EX 热帖地址（默认官方公开接口）
//   plugins.settings.hot-topics.hnApiBase —— 覆盖 HN 接口根（默认官方 firebase 地址）
//   这两个值主要是给测试与自建镜像用的：把它们指到内网会被宿主的网络守卫拦下。
const send = (message) => { process.stdout.write(`${JSON.stringify(message)}\n`); };

const V2EX_HOT = 'https://www.v2ex.com/api/topics/hot.json';
const HN_API = 'https://hacker-news.firebaseio.com/v0';
const HN_ITEM_PAGE = 'https://news.ycombinator.com/item?id=';
const MAX_LIMIT = 20;
const DEFAULT_LIMIT = 5;

let settings = {};
let requestSeq = 0;
const pending = new Map();

/** 调宿主的能力（这里是 cap.http.request）：带自增 id，应答按 id 回来。 */
const callHost = (method, params) => new Promise((resolve, reject) => {
  const id = ++requestSeq;
  pending.set(id, { resolve, reject });
  send({ id, method, params });
});

/** 经宿主发一个 GET 并解析 JSON（那条路有内网拦截、体积上限、超时与审计）。 */
async function getJson(url) {
  const result = await callHost('cap.http.request', { url, method: 'GET' });
  const status = Number(result?.status) || 0;
  if (status !== 200) return { error: `上游返回 HTTP ${status || '?'}（${url}）` };
  try { return { data: JSON.parse(String(result?.body ?? '')) }; }
  catch { return { error: '上游返回的不是 JSON（源头可能挂了或改接口了）' }; }
}

/** 标题里可能有换行/多余空白，压成一行再交给模型（否则会污染它要讲的那句话）。 */
const oneLine = (text, max = 200) => {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
};

/** limit 参数：默认 5，必须是 1..20 的整数（坏参数本地拦掉，不打上游）。 */
function parseLimit(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { value: DEFAULT_LIMIT };
  const n = Number(raw);
  if (!Number.isFinite(n) || Math.trunc(n) !== n || n < 1 || n > MAX_LIMIT) {
    return { error: `limit 要是 1 到 ${MAX_LIMIT} 之间的整数，收到的是「${raw}」` };
  }
  return { value: n };
}

async function v2exHot(limit) {
  const found = await getJson(String(settings.v2exUrl || V2EX_HOT));
  if (found.error) return { error: found.error };
  const topics = Array.isArray(found.data) ? found.data : [];
  if (!topics.length) return { error: 'V2EX 这会儿没有返回热帖（可能是接口临时空了）' };
  const items = topics.slice(0, limit).map((topic) => ({
    title: oneLine(topic?.title, 120),
    url: String(topic?.url || ''),
    replies: Number(topic?.replies) || 0,
    node: oneLine(topic?.node?.title || topic?.node?.name, 40)
  }));
  return {
    source: 'v2ex',
    items,
    note: '数据来自 V2EX 公开接口 /api/topics/hot.json（不需要 Key）。'
  };
}

async function hackerNews(limit) {
  const base = String(settings.hnApiBase || HN_API).replace(/\/+$/, '');
  const ids = await getJson(`${base}/topstories.json`);
  if (ids.error) return { error: ids.error };
  const list = Array.isArray(ids.data) ? ids.data.slice(0, limit) : [];
  if (!list.length) return { error: 'Hacker News 这会儿没有返回头条（可能是接口临时空了）' };

  // 头条接口只给 id，还要逐条取详情。并行取，串行会让 5 条就等好几秒。
  // 单条失败（超时 / 网络错误）不能让整个 Promise.all reject —— 否则一份榜单因为一条详情挂掉
  const details = await Promise.all(list.map((id) => getJson(`${base}/item/${id}.json`).catch(() => ({ error: '单条详情请求失败' }))));
  const items = [];
  for (const [index, detail] of details.entries()) {
    const item = detail?.data;
    if (!item || typeof item !== 'object') continue;   // 单条取不到就跳过，不让它毁掉整份榜单
    const hnId = Number(item.id) || list[index];
    items.push({
      title: oneLine(item.title, 120),
      // "Ask HN / Show HN" 这类没有外链，指向 HN 讨论页
      url: String(item.url || `${HN_ITEM_PAGE}${hnId}`),
      score: Number(item.score) || 0,
      comments: Number(item.descendants) || 0,
      by: oneLine(item.by, 40)
    });
  }
  if (!items.length) return { error: 'HN 的条目详情一条都没取到（接口可能被限流了）' };
  return {
    source: 'hn',
    items,
    note: '数据来自 Hacker News 官方 firebase 接口（不需要 Key）。'
  };
}

const tools = {
  async list(args) {
    // 校验放在发请求之前：来源要么不传（默认 v2ex），要么必须是我认识的两个之一 ——
    // **传了但是空的**也算写错，而不是悄悄用默认值（那样模型以为自己指定成功了）。
    const provided = args?.source !== undefined && args?.source !== null;
    const source = provided ? String(args.source).trim().toLowerCase() : 'v2ex';
    if (!source) return { error: 'source 传了但是空的 —— 不传就用默认 v2ex，或者写 v2ex / hn' };
    if (source !== 'v2ex' && source !== 'hn') {
      return { error: `不认识的来源「${args?.source}」—— 只能是 v2ex 或 hn` };
    }
    const limit = parseLimit(args?.limit);
    if (limit.error) return { error: limit.error };
    return source === 'hn' ? hackerNews(limit.value) : v2exHot(limit.value);
  }
};

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
      if (message?.method === 'callTool') {
        const fn = tools[message.params?.name];
        if (!fn) send({ id: message.id, error: { code: 'E_NO_TOOL', message: `没有这个工具：${message.params?.name}` } });
        else {
          Promise.resolve()
            .then(() => fn(message.params?.args ?? {}))
            .then((result) => send({ id: message.id, result }))
            .catch((error) => send({ id: message.id, error: { code: 'E_TOOL', message: String(error?.message || error) } }));
        }
      } else if (message?.method === 'init') {
        settings = message.params?.settings && typeof message.params.settings === 'object' ? message.params.settings : {};
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

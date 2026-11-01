// 官方插件：RSS 订阅（正则解析，不引任何 XML 库）。
//
// 群里常有人丢一个博客/新闻/播客的订阅地址问"最近更新了啥"。这个插件抓那个源、把最新几条
// 整理成"标题 + 链接 + 时间"给模型。
//
// 【为什么用正则而不是 XML 解析器】—— 这是硬约束（v1 只收零依赖插件，宿主不装构建工具），
// 而且在这儿恰好够用：RSS/Atom 的结构极稳定（`<item>`/`<entry>` + 几个固定子标签），我们要的
// 又只有标题/链接/时间三个字段。用正则的代价是"遇到不规则源可能解析不全"—— 所以这里对
// 非 XML、超大响应、没有条目三种情况都做了显式处理，宁可如实报错也不返回空壳。
//
// 这个插件不读配置（capabilities 里没有 config）：订阅地址由调用方每次给。
const send = (message) => { process.stdout.write(`${JSON.stringify(message)}\n`); };

const MAX_LIMIT = 20;
const DEFAULT_LIMIT = 5;

let requestSeq = 0;
const pending = new Map();

/** 调宿主的能力（这里是 cap.http.request）：带自增 id，应答按 id 回来。 */
const callHost = (method, params) => new Promise((resolve, reject) => {
  const id = ++requestSeq;
  pending.set(id, { resolve, reject });
  send({ id, method, params });
});

/** 解 XML 实体。&amp; 必须**最后**解：否则 "&amp;lt;" 会被二次解码成 "<"。 */
function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (whole, hex) => safeCodePoint(parseInt(hex, 16), whole))
    .replace(/&#(\d+);/g, (whole, dec) => safeCodePoint(Number(dec), whole))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function safeCodePoint(code, fallback) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return fallback;
  try { return String.fromCodePoint(code); } catch { return fallback; }
}

/** 去掉 HTML 标签并把空白压成一行（标题里常有 <br>、多余换行，直接给模型会污染它要讲的话）。 */
const collapse = (text) => String(text ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

/** 取出某个标签的首个内容（含 CDATA 原样），标签名可带命名空间前缀如 dc:date。 */
function tagInner(block, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = re.exec(block);
  return match ? match[1] : '';
}

/** CDATA 拆壳：<![CDATA[ 内容 ]]> → 内容。 */
function unwrapCdata(text) {
  const match = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(String(text ?? ''));
  return match ? match[1] : String(text ?? '');
}

/** 标签内容 → 干净的纯文本（先拆 CDATA，再解实体，再去标签）。 */
const tagText = (block, tag) => collapse(decodeEntities(unwrapCdata(tagInner(block, tag))));

/** 取出所有同名条目的内部块（RSS 的 <item>、Atom 的 <entry>）。 */
function blocksOf(body, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  return [...body.matchAll(re)].map((match) => match[1]);
}

/** 链接：Atom 用 <link href="…"/>，RSS 用 <link>…</link>。 */
function extractLink(block, isAtom) {
  if (isAtom) {
    const attrs = [...block.matchAll(/<link\b([^>]*?)\/?>/gi)].map((match) => match[1]);
    const hrefOf = (attr) => /href\s*=\s*["']([^"']+)["']/i.exec(attr);
    const isAlternate = (attr) => {
      const rel = /rel\s*=\s*["']([^"']+)["']/i.exec(attr);
      return !rel || rel[1].toLowerCase() === 'alternate';
    };
    // 先找 rel="alternate"（正文链接），没有就退而取任意带 href 的 link
    for (const attr of attrs) {
      const href = hrefOf(attr);
      if (href && isAlternate(attr)) return decodeEntities(href[1]).trim();
    }
    for (const attr of attrs) {
      const href = hrefOf(attr);
      if (href) return decodeEntities(href[1]).trim();
    }
    return '';
  }
  const inner = decodeEntities(unwrapCdata(tagInner(block, 'link'))).trim();
  if (inner) return inner;
  const attr = /<link\b[^>]*href\s*=\s*["']([^"']+)["']/i.exec(block);
  return attr ? decodeEntities(attr[1]).trim() : '';
}

/** 时间：Atom 优先 published 再 updated；RSS 用 pubDate / dc:date。 */
function extractDate(block, isAtom) {
  for (const tag of (isAtom ? ['published', 'updated'] : ['pubDate', 'dc:date', 'date'])) {
    const value = tagText(block, tag);
    if (value) return value;
  }
  return '';
}

/** 把各种日期写法归一成 ISO；认不出来就原样返回（不编造时间）。 */
function toIso(raw) {
  if (!raw) return '';
  const at = Date.parse(raw);
  return Number.isFinite(at) ? new Date(at).toISOString() : raw;
}

/** 源本身的标题：在第一个条目之前找（避免把第一条的标题当源名）。 */
function feedTitle(body, isAtom) {
  const firstEntry = body.search(isAtom ? /<entry\b/i : /<item\b/i);
  const head = firstEntry === -1 ? body : body.slice(0, firstEntry);
  return tagText(head, 'title');
}

/** limit 参数：默认 5，必须是 1..20 的整数（坏参数本地拦掉，不打上游）。 */
function parseLimit(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { value: DEFAULT_LIMIT };
  const n = Number(raw);
  if (!Number.isFinite(n) || Math.trunc(n) !== n || n < 1 || n > MAX_LIMIT) {
    return { error: `limit 要是 1 到 ${MAX_LIMIT} 之间的整数，收到的是「${raw}」` };
  }
  return { value: n };
}

const tools = {
  async latest(args) {
    // 校验放在发请求之前：地址不是 http(s) 就别去抓
    const raw = String(args?.url ?? '').trim();
    if (!raw) return { error: '要给我订阅源的地址（url 不能为空）' };
    let parsed = null;
    try { parsed = new URL(raw); } catch { return { error: `「${raw}」不是有效的网址` }; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { error: `只支持 http/https 的订阅地址，收到的是 ${parsed.protocol}` };
    }
    const limit = parseLimit(args?.limit);
    if (limit.error) return { error: limit.error };

    const result = await callHost('cap.http.request', { url: raw, method: 'GET' });
    const status = Number(result?.status) || 0;
    if (status !== 200) return { error: `抓取订阅源失败：HTTP ${status || '?'}` };

    const body = String(result?.body ?? '');
    if (!body.trim()) return { error: '订阅源返回了空内容' };

    // 防"非 XML"：既不是 RSS 也不是 Atom 的，明确说清它像什么，而不是硬解析出一堆空条目
    if (!/<(?:rss|feed|channel|item|entry)\b/i.test(body)) {
      const hint = /<html\b|<!doctype\s+html/i.test(body)
        ? '这个地址返回的是一个网页（HTML），不是订阅源 —— 多半是博客首页而不是 feed 地址'
        : '这个地址返回的内容不是 RSS/Atom';
      return { error: `${hint}（订阅地址通常以 /feed、/rss、/atom.xml、/index.xml 结尾）` };
    }

    const isAtom = !/<item\b/i.test(body) && /<entry\b/i.test(body);
    const blocks = blocksOf(body, isAtom ? 'entry' : 'item');
    if (!blocks.length) {
      return { error: '这个源里没有解析出任何条目（可能是空源，或格式不是我认识的 RSS/Atom）' };
    }

    const title = feedTitle(body, isAtom);
    const items = blocks.slice(0, limit.value).map((block) => ({
      title: tagText(block, 'title'),
      link: extractLink(block, isAtom),
      published: toIso(extractDate(block, isAtom))
    })).filter((item) => item.title || item.link);

    if (!items.length) return { error: '这个源的条目里既没有标题也没有链接，解析不出可读内容' };

    return {
      feed: title,
      format: isAtom ? 'Atom' : 'RSS',
      count: items.length,
      items,
      // 宿主有两层上限：safeFetch 的 50KB（带 truncated 标记）与 cap.http 的 40000 **字符**
      // （只截不断，不置标记）。所以再按长度兜一道：字符数贴着 40000 的一定是被截过的。
      truncated: Boolean(result?.truncated) || String(result?.body ?? '').length >= 40000,
      note: (Boolean(result?.truncated) || String(result?.body ?? '').length >= 40000)
        // 注意别建议"缩短 limit"：limit 是在完整响应抓回之后才切片的，改小只会少给几条，
        // 拿不到被截掉的尾部。换个更小的源/镜像才有用。
        ? '这个源一次返回的内容超过了宿主的取值上限，只解析到前面一段（尾部条目拿不到）；换个更小的源或镜像再试。'
        : '以上是订阅源里最新的几条（按源里的顺序）。'
    };
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

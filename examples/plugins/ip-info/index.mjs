// 官方插件：IP 查询（走 ip-api 免费接口，不需要 Key）。
//
// 群里问"这个 IP 是哪儿的""域名解析到哪台机"很常见。这个插件把它变成一个工具：给一个 IP 或
// 域名，拿回国家/省市、运营商、组织、ASN 与反向解析。
//
// 【为什么不在插件里自己解析域名】—— 这一条是刻意的设计，值得写下来：
//   ip-api 本身接受域名（它会在服务端解析），所以插件不需要先本地 DNS 再查 IP。
//   反过来做会有真实代价：宿主在 Linux 上把插件进程放进**没有网络接口的命名空间**
//   （见 docs/PLUGINS.md 的信任声明），那种环境下插件进程内的 dns 解析会直接失败
//   （解析器地址不可达），于是"能查 IP 却查不了域名"—— 一个看起来能用、实际半废的工具。
//   把解析交给上游，插件对网络的唯一出口就只剩宿主的 cap.http.request，两种部署下行为一致。
//
// 接口是 http（ip-api 免费层只给 http），所以用的是 `http://`；宿主那条路允许 http。
//
// 配置（可选）：plugins.settings.ip-info.endpoint，默认 http://ip-api.com/json
// 只用 net.isIP 做"像不像 IP"的本地判断：它是 Node 内置模块，不碰网络（不是 node:http(s)，
// 插件依然只能经宿主出网）。比手写 IP 正则可靠，尤其 IPv6。
import net from 'node:net';

const send = (message) => { process.stdout.write(`${JSON.stringify(message)}\n`); };

const ENDPOINT = 'http://ip-api.com/json';
// 只要这几个字段：ip-api 默认会给一大坨（含经纬度、时区、邮编），对群里回答问题是噪音
const FIELDS = 'status,message,country,regionName,city,isp,org,as,reverse';

let settings = {};
let requestSeq = 0;
const pending = new Map();

/** 调宿主的能力（这里是 cap.http.request）：带自增 id，应答按 id 回来。 */
const callHost = (method, params) => new Promise((resolve, reject) => {
  const id = ++requestSeq;
  pending.set(id, { resolve, reject });
  send({ id, method, params });
});

const DOMAIN_RE = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

/**
 * 内网 / 回环 / 链路本地地址：**不往上送**。
 * 查不到是次要的 —— 把内网地址发给第三方等于把内网拓扑告诉别人，而 README 里承诺了不查内网。
 */
function isPrivateAddress(text) {
  if (net.isIPv4(text)) {
    const [a, b] = text.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;          // 链路本地
    if (a >= 224) return true;                        // 组播 / 保留
    return false;
  }
  if (net.isIPv6(text)) {
    const lower = text.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;   // 唯一本地 fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;   // 链路本地 fe80::/10
    // IPv4 映射（::ffff:192.168.1.1）
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return false;
}

/** 判断查询串像不像 IP 或域名 —— 不像就本地报错，不拿垃圾去打上游。 */
function looksLikeTarget(raw) {
  const text = raw.replace(/^\[|\]$/g, '');   // IPv6 常写成 [::1]
  if (net.isIP(text)) return true;
  return DOMAIN_RE.test(text);
}

/** 把 ip-api 的英文失败原因翻成人话（这些原因群里真会遇到，直接抛英文等于没解释）。 */
function explainFailure(message) {
  const key = String(message || '').toLowerCase();
  if (key.includes('private')) return '这是个内网/私有地址，公开接口查不到它的归属地';
  if (key.includes('reserved')) return '这是个保留地址（比如回环、链路本地），没有公开归属信息';
  if (key.includes('invalid')) return '不是有效的 IP 或域名';
  return message ? `查询失败：${message}` : '查询失败（接口没有说明原因）';
}

const tools = {
  async lookup(args) {
    // 校验放在发请求之前
    const query = String(args?.query ?? '').trim();
    if (!query) return { error: '要给我一个 IP 或域名（query 不能为空）' };
    if (!looksLikeTarget(query)) {
      return { error: `「${query}」看起来不是 IP 也不是域名 —— 例如 8.8.8.8 或 github.com` };
    }
    // 内网地址在本地拦掉：上游查不到，而且没有理由把你的内网地址交给第三方
    if (isPrivateAddress(query.replace(/^\[|\]$/g, ''))) {
      return { error: `「${query}」是内网/回环/保留地址，公开接口查不到归属地（这类地址也不会发出去）` };
    }

    const base = String(settings.endpoint || ENDPOINT).replace(/\/+$/, '');
    const url = `${base}/${encodeURIComponent(query)}?lang=zh-CN&fields=${FIELDS}`;
    const result = await callHost('cap.http.request', { url, method: 'GET' });
    const status = Number(result?.status) || 0;
    if (status !== 200) return { error: `查询接口返回 HTTP ${status || '?'}（可能是限频了，免费层每分钟 45 次）` };

    let payload = null;
    try { payload = JSON.parse(String(result?.body ?? '')); }
    catch { return { error: '查询接口返回的不是 JSON' }; }

    if (String(payload?.status || '') !== 'success') {
      return { error: explainFailure(payload?.message) };
    }

    const place = [payload.country, payload.regionName, payload.city].filter(Boolean).join(' · ');
    return {
      query,
      country: payload.country || '',
      region: payload.regionName || '',
      city: payload.city || '',
      place: place || '（接口没给地理位置）',
      isp: payload.isp || '',
      org: payload.org || '',
      asn: payload.as || '',
      reverse: payload.reverse || '',
      note: '数据来自 ip-api.com 免费接口（不需要 Key，每分钟限 45 次）。归属地是登记信息，'
        + '不保证就是服务器的实际物理位置（CDN/代理会让它看起来在别处）。'
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

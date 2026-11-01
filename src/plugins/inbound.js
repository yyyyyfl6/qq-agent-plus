// 插件 v3 的入站 HTTP（能力 `inbound`）：让外部设备（如「我会永远陪着你」移植插件配套的安卓陪伴终端）
// 直接把数据推给插件。
//
//   路径：/plugin-hooks/<插件id>/<其余路径>     —— 控制台端口上认
//   独立端口：插件设置里 inboundListen = true（端口 inboundPort，默认 6322）时，宿主替**这个插件**单开一个端口，
//   **只**提供它的路径、根路径（/pair、/status …）直接交给它，不暴露控制台 ——
//   原插件的手机网关就是 6322 端口、根路径，配套 App 不用改地址格式。开关放在插件自己的设置里，宿主配置不加键。
//
// 这条路**不走控制台令牌**（手机拿不到也不该拿到控制台令牌）：鉴权由插件自己做（配对令牌 → 会话令牌）。
// 所以宿主在这里守住它能守的：插件必须已启用且声明了 inbound（否则一律 404，不泄露装了什么）、
// 请求体 ≤256KB、每个来源 IP 每分钟 ≤120 次、只转发白名单里的请求头、插件 10 秒没回就 502。
// 这是 app.js 里路由表 auth:false 白名单之外唯一的免令牌入口，审计用例见 test/plugin-inbound.test.mjs。
import http from 'node:http';

export const INBOUND_PREFIX = '/plugin-hooks/';
const MAX_BODY_BYTES = 256 * 1024;
const RATE_PER_MIN = 120;
const FORWARD_HEADERS = ['authorization', 'x-companion-mobile-token', 'content-type', 'user-agent', 'accept-language'];
const ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

function send(res, status, body) {
  const text = JSON.stringify(body ?? {});
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * @param getRegistry  () => PluginRegistry（有 inbound(id, request)）
 * @param getConfig    () => 完整配置（读 plugins.enabled / enabledIds / settings[id].inboundListen）
 */
export function createInboundHandler({ getRegistry, getConfig = () => ({}), log = () => {}, now = () => Date.now() } = {}) {
  const registryOf = getRegistry;
  const configOf = getConfig;
  const nowFn = now;
  const hits = new Map();   // ip -> [ts]
  const limited = (ip) => {
    const t = nowFn();
    const list = (hits.get(ip) || []).filter((at) => t - at < 60_000);
    if (list.length >= RATE_PER_MIN) { hits.set(ip, list); return true; }
    list.push(t);
    hits.set(ip, list);
    if (hits.size > 2000) for (const key of [...hits.keys()].slice(0, 500)) hits.delete(key);
    return false;
  };

  /**
   * 处理一条请求。rootPlugin：独立端口上"根路径交给谁"（控制台端口不传 = 只认 /plugin-hooks/）。
   * 返回 true = 已处理。
   */
  async function handle(req, res, { rootPlugin = '' } = {}) {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    let id = '';
    let rest = '';
    if (url.pathname.startsWith(INBOUND_PREFIX)) {
      const tail = url.pathname.slice(INBOUND_PREFIX.length);
      const slash = tail.indexOf('/');
      id = slash < 0 ? tail : tail.slice(0, slash);
      rest = slash < 0 ? '/' : tail.slice(slash);
    } else if (rootPlugin) {
      id = rootPlugin;
      rest = url.pathname || '/';
    } else {
      return false;
    }
    if (!ID_RE.test(id)) { send(res, 404, { ok: false, message: 'not found' }); return true; }
    const ip = String(req.socket?.remoteAddress || '');
    if (limited(ip)) { send(res, 429, { ok: false, message: '请求过于频繁，请稍后再试' }); return true; }
    const method = String(req.method || 'GET').toUpperCase();
    if (!['GET', 'POST'].includes(method)) { send(res, 405, { ok: false, message: 'method not allowed' }); return true; }
    let raw = '';
    try {
      raw = method === 'POST' ? await readBody(req) : '';
    } catch (error) {
      send(res, error?.status || 400, { ok: false, message: String(error?.message || '请求读取失败') });
      return true;
    }
    let body = null;
    if (raw) {
      try { body = JSON.parse(raw); } catch { send(res, 400, { ok: false, message: '请求体必须是 JSON' }); return true; }
    }
    const headers = {};
    for (const name of FORWARD_HEADERS) {
      const value = req.headers?.[name];
      if (typeof value === 'string' && value) headers[name] = value.slice(0, 512);
    }
    const query = {};
    for (const [key, value] of [...url.searchParams.entries()].slice(0, 20)) query[key.slice(0, 40)] = value.slice(0, 200);
    const registry = registryOf?.();
    if (!registry?.inbound) { send(res, 404, { ok: false, message: 'not found' }); return true; }
    const result = await registry.inbound(id, {
      method, path: rest.slice(0, 300), query, headers, remoteAddr: ip.slice(0, 64), body: body ?? {}
    });
    send(res, result.status, result.body);
    return true;
  }

  /** 按插件设置给要求独立端口的插件各开一个端口（根路径交给它）。返回 [{ id, close() }]。 */
  function listen() {
    const plugins = configOf()?.plugins || {};
    if (plugins.enabled !== true) return [];
    const servers = [];
    for (const id of (Array.isArray(plugins.enabledIds) ? plugins.enabledIds : []).filter((v) => ID_RE.test(String(v)))) {
      const st = plugins.settings?.[id] || {};
      if (st.inboundListen !== true) continue;
      const host = String(st.inboundHost || '0.0.0.0').trim() || '0.0.0.0';
      const port = Math.min(65535, Math.max(1024, Number(st.inboundPort) || 6322));
      const server = http.createServer((req, res) => {
        handle(req, res, { rootPlugin: id }).then((handled) => {
          if (!handled) send(res, 404, { ok: false, message: 'not found' });
        }).catch((error) => {
          log(`[plugins] 入站请求出错：${error?.message ?? error}`);
          try { send(res, 500, { ok: false, message: 'internal error' }); } catch { /* 已经写过 */ }
        });
      });
      server.on('error', (error) => log(`[plugins] 插件 ${id} 的入站端口 ${host}:${port} 启动失败：${error?.message ?? error}`));
      server.listen(port, host, () => log(`[plugins] 插件 ${id} 的入站端口已监听 ${host}:${port}（只提供这个插件的路径）`));
      servers.push({ id, server, close: () => new Promise((resolve) => server.close(() => resolve())) });
    }
    return servers;
  }

  return { handle, listen };
}

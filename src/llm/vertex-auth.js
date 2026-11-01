// Google Vertex AI 直连鉴权：用**服务账号 JSON 密钥**换取 OAuth2 访问令牌，直接调用 Vertex 官方的
// OpenAI 兼容端点（Gemini 等模型），花的是自己 GCP 项目里的额度 / 赠金。
//
//   1) 本机用 JSON 里的 private_key 签一个 JWT（RS256，scope = cloud-platform）
//   2) POST https://oauth2.googleapis.com/token（grant_type = jwt-bearer）换 1 小时有效的 access_token
//   3) Bearer access_token 请求 https://aiplatform.googleapis.com/v1/projects/<project>/locations/<loc>/endpoints/openapi/chat/completions
//
// 全程只和 Google 官方域名通信，不经过任何第三方网关 / 中转。这就是 Google 官方 SDK
// （google-auth-library）做的同一件事，这里用 node:crypto 手写，零依赖。
//
// 用法：在「模型 API」里选「Google Vertex AI（服务账号）」预设，API Key 一栏粘贴整份服务账号 JSON。
// 服务地址里的 {project} 自动换成 JSON 里的 project_id，{location} 默认 global。
//
// 安全闸（宁可报错也不外发）：
//   · 访问令牌只会发给 aiplatform.googleapis.com / <region>-aiplatform.googleapis.com；
//   · 换令牌只会请求 oauth2.googleapis.com（JSON 里的 token_uri 指向别处一律拒绝）；
//   · 报错信息里不回显私钥、签名断言与令牌。
import crypto from 'node:crypto';

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const tokenCache = new Map();   // client_email|private_key_id → { token, exp }
const inflight = new Map();

/** 粘贴进 API Key 栏的是不是一份服务账号 JSON；是就返回解析结果，否则 null。 */
export function parseServiceAccount(key) {
  const text = String(key ?? '').trim();
  if (!text.startsWith('{')) return null;
  let obj;
  try { obj = JSON.parse(text); } catch { return null; }
  if (obj?.type !== 'service_account' || !obj.client_email || !obj.private_key) return null;
  return obj;
}

export function isVertexHost(url) {
  let host = '';
  try { host = new URL(String(url)).host.toLowerCase(); } catch { return false; }
  return host === 'aiplatform.googleapis.com' || /^[a-z0-9-]+-aiplatform\.googleapis\.com$/.test(host);
}

/** 把服务地址里的 {project} / {location} 换成实际值。 */
export function vertexBaseUrl(baseUrl, sa, { location = 'global' } = {}) {
  return String(baseUrl || '')
    .replaceAll('{project}', encodeURIComponent(String(sa?.project_id || '')))
    .replaceAll('{location}', encodeURIComponent(location))
    .replace(/\/+$/, '');
}

const b64url = (input) => Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

export function signServiceAccountJwt(sa, nowSec = Math.floor(Date.now() / 1000)) {
  const tokenUri = String(sa.token_uri || DEFAULT_TOKEN_URI);
  const header = { alg: 'RS256', typ: 'JWT', ...(sa.private_key_id ? { kid: sa.private_key_id } : {}) };
  const claims = { iss: sa.client_email, scope: SCOPE, aud: tokenUri, iat: nowSec, exp: nowSec + 3600 };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  let signature;
  try {
    signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), sa.private_key);
  } catch {
    throw new Error('服务账号 JSON 里的 private_key 无法用于签名（复制时是否少了一截？）');
  }
  return `${unsigned}.${b64url(signature)}`;
}

function assertTokenUri(sa) {
  const uri = String(sa.token_uri || DEFAULT_TOKEN_URI);
  let u;
  try { u = new URL(uri); } catch { throw new Error('服务账号 JSON 的 token_uri 不是合法地址'); }
  if (u.protocol !== 'https:' || u.host.toLowerCase() !== 'oauth2.googleapis.com') {
    throw new Error('服务账号 JSON 的 token_uri 不是 Google 官方地址（oauth2.googleapis.com），已拒绝');
  }
  return u.toString();
}

/** 取（必要时换新）访问令牌。到期前 5 分钟就续，同一账号并发只换一次。 */
export async function vertexAccessToken(sa, options = {}) {
  // 显式取别名而不是解构参数：ops scan 的未定义调用扫描器不认识解构参数（见 console/router.js）
  const fetchFn = options.fetchFn || fetch;
  const now = options.now || Date.now;
  const signal = options.signal || null;
  const cacheKey = `${sa.client_email}|${sa.private_key_id || ''}`;
  const hit = tokenCache.get(cacheKey);
  if (hit && hit.exp - now() > 5 * 60_000) return hit.token;
  if (inflight.has(cacheKey)) return inflight.get(cacheKey);
  const job = (async () => {
    const tokenUri = assertTokenUri(sa);
    const assertion = signServiceAccountJwt(sa, Math.floor(now() / 1000));
    const res = await fetchFn(tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      signal: signal || AbortSignal.timeout(15000)
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* 下面按状态码报错 */ }
    if (!res.ok || !data?.access_token) {
      // 只报 Google 给的错误码与说明，不回显断言 / 原始响应
      const reason = [data?.error, data?.error_description].filter(Boolean).join('：').slice(0, 200);
      const err = new Error(`Vertex 服务账号换取访问令牌失败 HTTP ${res.status}${reason ? `（${reason}）` : ''}`);
      err.status = res.status;
      throw err;
    }
    const token = String(data.access_token);
    tokenCache.set(cacheKey, { token, exp: now() + Math.max(60, Number(data.expires_in) || 3600) * 1000 });
    return token;
  })();
  inflight.set(cacheKey, job);
  try {
    return await job;
  } finally {
    inflight.delete(cacheKey);
  }
}

/**
 * 发请求前统一过一遍：普通 Key 原样返回；服务账号 JSON → 换成访问令牌 + 展开地址占位符。
 * 返回 { baseUrl, apiKey, vertex }。
 */
export async function resolveRequestAuth(api, { fetchFn = fetch, signal = null } = {}) {
  const sa = parseServiceAccount(api?.apiKey);
  if (!sa) return { baseUrl: api?.baseUrl, apiKey: api?.apiKey, vertex: false };
  const baseUrl = vertexBaseUrl(api.baseUrl, sa, { location: api.vertexLocation || 'global' });
  if (!isVertexHost(baseUrl)) {
    throw new Error('API Key 是 Google 服务账号 JSON，但服务地址不是 Vertex 官方地址（*aiplatform.googleapis.com）：为安全起见不会把它发出去');
  }
  if (/\/projects\/(\/|$)/.test(baseUrl)) throw new Error('服务账号 JSON 里没有 project_id，无法拼出 Vertex 地址');
  const apiKey = await vertexAccessToken(sa, { fetchFn, signal });
  return { baseUrl, apiKey, vertex: true };
}

/** 测试用：清空令牌缓存。 */
export function clearVertexTokenCache() {
  tokenCache.clear();
  inflight.clear();
}

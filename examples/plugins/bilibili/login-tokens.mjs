// 扫码登录的凭据解析（纯函数，便于单测）。
//
// 成功响应里凭据可能分散在两个地方：
//   · 回跳 URL 的查询串（可能嵌套 crossDomain URL，需要逐层解）；
//   · 本次响应的 Set-Cookie（有时只有 bili_jct / DedeUserID）。
// 两边都必须取、按字段合并 —— 不能因为 URL 里有 SESSDATA 就把 Set-Cookie 丢掉。

export function findSsoTokens(urlText) {
  const queue = [String(urlText ?? '')];
  const seen = new Set();
  while (queue.length) {
    const candidate = queue.shift();
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    let parsed;
    try { parsed = new URL(candidate); } catch { continue; }
    const sessdata = parsed.searchParams.get('SESSDATA');
    if (sessdata) {
      return {
        sessdata,
        bili_jct: parsed.searchParams.get('bili_jct') || '',
        dedeuserid: parsed.searchParams.get('DedeUserID') || ''
      };
    }
    for (const value of parsed.searchParams.values()) {
      let decoded = value;
      try { decoded = decodeURIComponent(value); } catch { /* 不是编码串就原样入队 */ }
      if (/crossDomain|SESSDATA|passport/i.test(decoded)) queue.push(decoded);
    }
  }
  return null;
}

export function parseSetCookieTokens(setCookies) {
  const jar = {};
  for (const line of (Array.isArray(setCookies) ? setCookies : [])) {
    const first = String(line).split(';')[0];
    const eq = first.indexOf('=');
    if (eq > 0) jar[first.slice(0, eq).trim()] = first.slice(eq + 1).trim();
  }
  // 只要有任何一项就返回：bili_jct 可能单独出现在 Set-Cookie 里
  if (!jar.SESSDATA && !jar.bili_jct && !jar.DedeUserID) return null;
  return {
    sessdata: jar.SESSDATA || '',
    bili_jct: jar.bili_jct || '',
    dedeuserid: jar.DedeUserID || ''
  };
}

export function mergeLoginTokens(urlText, setCookies) {
  const fromUrl = findSsoTokens(urlText) || {};
  const fromSet = parseSetCookieTokens(setCookies) || {};
  return {
    sessdata: fromUrl.sessdata || fromSet.sessdata || '',
    bili_jct: fromUrl.bili_jct || fromSet.bili_jct || '',
    dedeuserid: fromUrl.dedeuserid || fromSet.dedeuserid || ''
  };
}

// 明文只在服务端解析；全局 Key 只能继承到同一个规范化端点。
export function sameApiEndpoint(a, b) {
  try {
    const normalize = (raw) => { const u = new URL(String(raw || '').trim()); return `${u.origin}${u.pathname.replace(/\/+$/, '')}`; };
    return Boolean(a && b) && normalize(a) === normalize(b);
  } catch { return false; }
}

export function resolveProviderKey(provider, cfg) {
  if (!provider) return '';
  const key = (value) => { const s = String(value || '').trim(); return s === '******' ? '' : s; };
  const global = () => sameApiEndpoint(provider.baseURL || provider.baseUrl, cfg?.api?.baseUrl) ? key(cfg.api.apiKey) : '';
  // 显式空来源表示跟随全局 Key；部署时复制到 providerKeys 的旧值不能覆盖它。
  if (provider.apiKeyFrom === '') return global();
  const own = key(cfg?.providerKeys?.[provider.id]) || key(provider.apiKey);
  if (provider.apiKeyFrom === 'manual') return own;
  if (provider.apiKeyFrom) {
    const source = (cfg?.providers || []).find((p) => p.id === provider.apiKeyFrom);
    return source && sameApiEndpoint(source.baseURL || source.baseUrl, provider.baseURL || provider.baseUrl)
      ? key(cfg?.providerKeys?.[source.id]) || key(source.apiKey) || global() : '';
  }
  return own || global();
}

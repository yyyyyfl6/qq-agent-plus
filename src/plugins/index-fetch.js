// 插件索引的抓取：原始地址优先，失败时换 GitHub Contents API（仍是 GitHub，不引入第三方镜像）。
//
// 为什么需要：索引默认放在 raw.githubusercontent.com，国内不少机器上这个域名直接超时，
// 而 api.github.com 通常可达（2026-10-22 线上实测：raw 12 秒超时、API 0.8 秒返回 200）。
// 索引是信任根，不能像安装包那样交给公共 CDN —— 所以后备地址只换 GitHub 自己的 API。
import { githubContentsApiUrl } from './mirrors.js';

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

/**
 * 生成 fetchText 实现（与 `fetchPluginIndexes` 的注入点同形）。
 * `fetchImpl(url, { maxBytes, signal, headers })` 由调用方提供（线上是 safe-fetch）。
 */
export function createIndexTextFetcher({
  fetchImpl,
  log = () => {},
  rawTimeoutMs = 10000,
  apiTimeoutMs = 15000,
  totalTimeoutMs = 25000,
  maxBytes = DEFAULT_MAX_BYTES
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('createIndexTextFetcher 需要 fetchImpl');
  const grab = fetchImpl;
  return async function fetchIndexText(url) {
    const apiUrl = githubContentsApiUrl(url);
    // 只有能换 GitHub API 的 raw 地址才用 10 秒快速失败；自建/第三方索引沿用原来的 25 秒，
    // 不能因为加了兜底就把慢但可用的源判死。
    const firstTimeout = apiUrl ? rawTimeoutMs : totalTimeoutMs;
    let firstError = null;
    try {
      const result = await grab(url, { maxBytes, signal: AbortSignal.timeout(firstTimeout) });
      if (Number(result?.statusCode) === 200) return result;
      firstError = new Error(`索引拉取失败：HTTP ${result?.statusCode ?? '?'}`);
    } catch (error) {
      firstError = error;
    }
    if (!apiUrl) throw firstError;
    log(`[plugins] ${url} 取不动（${firstError?.message ?? firstError}），改走 GitHub API`);
    return grab(apiUrl, {
      maxBytes,
      signal: AbortSignal.timeout(apiTimeoutMs),
      // Contents API 默认回 JSON 信封；raw 媒体类型直接给文件正文，省掉 base64 解码
      headers: { accept: 'application/vnd.github.raw' }
    });
  };
}

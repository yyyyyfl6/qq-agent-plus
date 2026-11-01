import { asText } from './util.js';

function joinUrl(base, suffix) {
  return `${String(base || '').replace(/\/+$/, '')}/${String(suffix || '').replace(/^\/+/, '')}`;
}

function clampInt(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : fallback;
}

function normalizedUrl(value) {
  const raw = asText(value, 500).replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

/** Embedding 凭据只从进程环境读取，不进入主配置或控制台响应。 */
export function readLivingMemoryEmbeddingConfig(env = process.env) {
  const baseUrl = normalizedUrl(env?.LIVING_MEMORY_EMBEDDING_BASE_URL);
  const model = asText(env?.LIVING_MEMORY_EMBEDDING_MODEL, 200);
  return {
    enabled: Boolean(baseUrl && model),
    baseUrl,
    apiKey: asText(env?.LIVING_MEMORY_EMBEDDING_API_KEY, 1000),
    model,
    dimensions: clampInt(env?.LIVING_MEMORY_EMBEDDING_DIMENSIONS, 0, 8192, 0),
    timeoutMs: clampInt(env?.LIVING_MEMORY_EMBEDDING_TIMEOUT_MS, 1000, 120000, 30000),
    recallTimeoutMs: clampInt(env?.LIVING_MEMORY_RECALL_VECTOR_TIMEOUT_MS, 200, 5000, 1200),
    // 向量相似度是主线程上的同步 JS 计算；2 万条 1024 维向量会占几十 MB 并卡住
    // OneBot 收发。默认 5000，环境变量最多放到 20000（够一个中大型群，仍可控）。
    vectorScanLimit: clampInt(env?.LIVING_MEMORY_VECTOR_SCAN_LIMIT, 500, 20000, 5000)
  };
}

export class Embedder {
  constructor(config, { fetchImpl = fetch } = {}) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  ready() {
    return this.config.enabled === true;
  }

  async embed(input, { timeoutMs = 0 } = {}) {
    if (!this.ready()) throw new Error('Embedding 未配置');
    const values = Array.isArray(input) ? input : [input];
    const requestedTimeout = Number(timeoutMs);
    const effectiveTimeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? Math.max(100, Math.min(120000, Math.round(requestedTimeout)))
      : this.config.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Embedding 请求超时')), effectiveTimeoutMs);
    try {
      const response = await this.fetch(joinUrl(this.config.baseUrl, 'embeddings'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {})
        },
        body: JSON.stringify({ model: this.config.model, input: values }),
        signal: controller.signal
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(asText(payload?.error?.message || payload?.message || `Embedding HTTP ${response.status}`, 500));
      const ordered = Array.isArray(payload?.data) ? [...payload.data].sort((a, b) => Number(a.index) - Number(b.index)) : [];
      const vectors = ordered.map((item) => item?.embedding).filter((vector) => Array.isArray(vector) && vector.length);
      if (vectors.length !== values.length) throw new Error('Embedding 返回数量不匹配');
      if (this.config.dimensions && vectors.some((vector) => vector.length !== this.config.dimensions)) {
        throw new Error(`Embedding 维度与配置不匹配（期望 ${this.config.dimensions}）`);
      }
      return vectors;
    } finally {
      clearTimeout(timer);
    }
  }
}

// 秘塔搜索 provider（issue #38）。
//
// 报的问题是"404"：地址写成了 /api/open/v1/search。查下来请求体与响应路径也是错的
// （官方是 { q, scope, size } → webpages[]，原来发的是 { query, top_k } 读 results）——
// 也就是说这个 provider 从来没成功过。这里把三处契约都钉住：
//   ① 地址与鉴权、请求体字段名与类型（size 是数字，不是字符串）
//   ② 响应解析（webpages → title/link/snippet，summary 兜底，无链接的丢掉）
//   ③ 官方出错时 HTTP 仍是 200、body 里是 errCode/errMsg —— 不能被当成"没有有效结果"
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-metaso-search-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
delete process.env.METASO_API_KEY;
// 端口挑在 Linux/Windows 临时端口范围之外，和其他 web-search 用例并行跑不冲突
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ server: { port: 22499, host: '127.0.0.1' } }));
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄占用就算了 */ } });

const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');

const setWebSearch = (patch) => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.webSearch = { ...cfg.webSearch, ...patch };
  updateConfig(cfg);
};

/** 装一个只回一次的 fetch 桩，返回它看到的东西。 */
function stubFetch(responder) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method, headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : null });
    return responder(calls.length);
  };
  return calls;
}

test('metasoSearch：打到 /api/v1/search，body 是 {q,scope,size(数字),include*}，Bearer 鉴权', async () => {
  setWebSearch({ provider: 'metaso', metaso: { apiKey: 'mk-test', count: 99, timeoutMs: 15000 } });
  const calls = stubFetch(() => ({
    ok: true,
    json: async () => ({ webpages: [
      { title: 'T1', link: 'https://a.example/x', snippet: '摘要A' },
      { title: '  ', link: 'https://b.example/', summary: '只有 summary' },
      { title: '无链接', snippet: 'x' }
    ] })
  }));
  const { metasoSearch } = await import('../src/llm/web-search.js');
  const r = await metasoSearch('测试查询');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://metaso.cn/api/v1/search', '官方路径（/api/open/... 是 404）');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.authorization, 'Bearer mk-test');
  assert.deepEqual(calls[0].body, {
    q: '测试查询',
    scope: 'webpage',
    size: 50,                    // count 配成 99 要夹到官方上限 50，且必须是数字
    includeSummary: false,
    includeRawContent: false,
    conciseSnippet: false
  });
  // 解析：webpages → title/link/snippet；summary 兜底；无链接的丢掉
  assert.deepEqual(r.results, [
    { title: 'T1', url: 'https://a.example/x', snippet: '摘要A' },
    { title: '（无标题）', url: 'https://b.example/', snippet: '只有 summary' }
  ]);
});

test('metasoSearch：官方错误体（HTTP 200 + errCode/errMsg）要带出真实原因', async () => {
  setWebSearch({ provider: 'metaso', metaso: { apiKey: 'bad-key' } });
  stubFetch(() => ({ ok: true, json: async () => ({ errCode: 2005, errMsg: 'API密钥无效' }) }));
  const { metasoSearch } = await import('../src/llm/web-search.js');
  await assert.rejects(() => metasoSearch('x'), (error) => {
    assert.match(error.message, /2005/);
    assert.match(error.message, /API密钥无效/, '不能只说"没有返回有效结果"，那会盖掉 Key 错了这件事');
    return true;
  });
});

test('metasoSearch：size 默认 6、最小 1；Key 回退环境变量 METASO_API_KEY', async () => {
  process.env.METASO_API_KEY = 'env-key';
  try {
    setWebSearch({ provider: 'metaso', metaso: { apiKey: '', count: 0 } });
    const calls = stubFetch((n) => ({
      ok: true,
      json: async () => ({ webpages: [{ title: 'A', link: `https://a${n}.example/` }] })
    }));
    const { metasoSearch } = await import('../src/llm/web-search.js');
    await metasoSearch('x');
    // `Number(count) || 6` 的语义是"0 / 空 = 没配"，与其它 provider 一致
    assert.equal(calls[0].body.size, 6, 'count=0 视为没配 → 默认 6');
    assert.equal(calls[0].headers.authorization, 'Bearer env-key');

    setWebSearch({ provider: 'metaso', metaso: { apiKey: 'k', count: 1 } });
    await metasoSearch('y');
    assert.equal(calls[1].body.size, 1, '下限 1');
  } finally { delete process.env.METASO_API_KEY; }
});

test('metasoSearch：非 200 与坏 JSON 各给一句能读的错', async () => {
  setWebSearch({ provider: 'metaso', metaso: { apiKey: 'k' } });
  stubFetch(() => ({ ok: false, status: 500, text: async () => 'boom' }));
  const { metasoSearch } = await import('../src/llm/web-search.js');
  await assert.rejects(() => metasoSearch('x'), /秘塔搜索 HTTP 500/);

  // 真实链路是 JSON.parse 抛 SyntaxError；只有它才该被翻成"无法解析"，
  // 超时/连接中断要保留原始错误（2026-10-17 审查 P3）
  globalThis.fetch = async () => ({ ok: true, text: async () => '{not json' });
  await assert.rejects(() => metasoSearch('x'), /无法解析/);
});

test('配置迁移：老实例存的旧出厂地址搬到官方路径，用户自填的地址不动', async () => {
  const { migrateMetasoBaseUrl } = await import('../src/core/config-legacy.js');
  const legacy = migrateMetasoBaseUrl({ metaso: { baseUrl: 'https://metaso.cn/api/open/v1/search', apiKey: 'k' } });
  assert.equal(legacy.metaso.baseUrl, 'https://metaso.cn/api/v1/search', '旧出厂值要搬过来');
  assert.equal(legacy.metaso.apiKey, 'k', '同段其它键原样保留');

  const custom = migrateMetasoBaseUrl({ metaso: { baseUrl: 'https://my-proxy.example/metaso' } });
  assert.equal(custom.metaso.baseUrl, 'https://my-proxy.example/metaso', '用户自填的代理不能动');

  assert.deepEqual(migrateMetasoBaseUrl(undefined), undefined);
  assert.deepEqual(migrateMetasoBaseUrl({}), {});
});

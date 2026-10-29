import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-deepseek-search-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 句柄 */ } });

const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');
const { webSearch, deepSeekSearch } = await import('../src/llm/web-search.js');

function configure(extra = {}) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.webSearch = {
    ...cfg.webSearch,
    provider: 'deepseek',
    maxResults: 6,
    deepseek: {
      apiKey: 'sk-deepseek',
      // 老配置形态：代码应自动剥掉 /responses
      baseUrl: 'https://api.deepseek.com/responses',
      model: 'deepseek-v4-flash',
      count: 3,
      timeoutMs: 10000,
      ...extra
    }
  };
  setRuntimeConfig(cfg);
}

test('DeepSeek Search API：走 /v1/tools/search，返回结构化 title/url/summary', async (t) => {
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  configure();
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), headers: options.headers, body: JSON.parse(String(options.body || '{}')) });
    return Response.json({
      results: [
        { title: '标题 A', url: 'https://example.com/a', summary: '摘要 A' },
        { title: '', url: 'https://example.com/b', content: '正文 B' }
      ]
    });
  };

  const out = await webSearch('测试查询');
  assert.match(calls[0].url, /^https:\/\/api\.deepseek\.com\/v1\/tools\/search$/);
  assert.equal(calls[0].headers.authorization, 'Bearer sk-deepseek');
  assert.equal(calls[0].body.query, '测试查询');
  assert.equal(calls[0].body.count, 3);
  assert.equal(calls[0].body.need_content, false);
  assert.deepEqual(out.results, [
    { title: '标题 A', url: 'https://example.com/a', snippet: '摘要 A' },
    { title: 'https://example.com/b', url: 'https://example.com/b', snippet: '正文 B' }
  ]);
});

test('DeepSeek Search API 404 时回退旧 Responses；401 不伪装成 404', async (t) => {
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  configure();
  let call = 0;
  globalThis.fetch = async (url) => {
    call += 1;
    if (call === 1) return new Response('not found', { status: 404 });
    assert.match(String(url), /\/responses$/);
    return Response.json({ output_text: '旧接口总结' });
  };
  const out = await deepSeekSearch('兜底');
  assert.equal(call, 2);
  assert.equal(out.results[0].snippet, '旧接口总结');

  configure();
  globalThis.fetch = async () => new Response('invalid key', { status: 401 });
  await assert.rejects(() => deepSeekSearch('失败'), /HTTP 401/);
});

// 谷歌（Custom Search JSON API，国际域名）与 Edge（必应国际版 www.bing.com）两个搜索源：
// 请求地址与参数、结果解析、未配置时的报错、报错里不回显 Key、分发入口与聚合源名。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-google-edge-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
delete process.env.GOOGLE_SEARCH_API_KEY;
delete process.env.GOOGLE_SEARCH_CX;
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ server: { port: 22517, host: '127.0.0.1' } }));
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 忽略 */ } });

const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');
const { googleSearch, edgeSearch, webSearch, aggregateSearch } = await import('../src/llm/web-search.js');

const setWebSearch = (patch) => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.webSearch = { ...cfg.webSearch, ...patch };
  updateConfig(cfg);
};
const realFetch = globalThis.fetch;
const stubFetch = (fn) => { globalThis.fetch = fn; };
test.afterEach(() => { globalThis.fetch = realFetch; });

test('谷歌：打国际域名 www.googleapis.com，带 key/cx/q/num，解析 items', async () => {
  setWebSearch({ provider: 'google', google: { apiKey: 'g-key', cx: 'cx-1', count: 3, language: '' } });
  let seen = null;
  stubFetch(async (url) => {
    seen = new URL(String(url));
    return new Response(JSON.stringify({ items: [
      { title: 'A', link: 'https://a.example', snippet: 'one\n two' },
      { title: '', link: 'https://b.example' },
      { title: 'no link' }
    ] }), { status: 200 });
  });
  const r = await webSearch('hello world');
  assert.equal(seen.host, 'www.googleapis.com');
  assert.equal(seen.pathname, '/customsearch/v1');
  assert.equal(seen.searchParams.get('key'), 'g-key');
  assert.equal(seen.searchParams.get('cx'), 'cx-1');
  assert.equal(seen.searchParams.get('num'), '3');
  assert.equal(seen.searchParams.get('hl'), null, '语言留空时不带 hl，由谷歌自动判断');
  assert.deepEqual(r.results, [
    { title: 'A', url: 'https://a.example', snippet: 'one two' },
    { title: '（无标题）', url: 'https://b.example', snippet: '' }
  ]);
});

test('谷歌：没配 Key 或 cx 直接报错不发请求；HTTP 错误里不回显 Key', async () => {
  setWebSearch({ provider: 'google', google: { apiKey: '', cx: '' } });
  stubFetch(async () => { throw new Error('不该发请求'); });
  await assert.rejects(googleSearch('x'), /API Key 和搜索引擎 ID/);
  setWebSearch({ provider: 'google', google: { apiKey: 'secret-key', cx: 'cx' } });
  stubFetch(async () => new Response(JSON.stringify({ error: { message: 'bad key secret-key' } }), { status: 400 }));
  await assert.rejects(googleSearch('x'), (e) => /HTTP 400/.test(e.message) && !e.message.includes('secret-key'));
});

test('Edge：打 www.bing.com，market 留空不带地区参数，填了就带 mkt/setlang', async () => {
  const html = '<ol><li class="b_algo"><h2><a href="https://x.example">X 标题</a></h2><p>摘要</p></li></ol>';
  let seen = null;
  stubFetch(async (url) => { seen = new URL(String(url)); return new Response(html, { status: 200 }); });
  setWebSearch({ provider: 'edge', edge: { searchUrl: 'https://www.bing.com/search', market: '' } });
  const r = await webSearch('q1');
  assert.equal(seen.host, 'www.bing.com');
  assert.equal(seen.searchParams.get('mkt'), null);
  assert.deepEqual(r.results, [{ title: 'X 标题', url: 'https://x.example', snippet: '摘要' }]);
  setWebSearch({ provider: 'edge', edge: { market: 'en-US' } });
  await edgeSearch('q2');
  assert.equal(seen.searchParams.get('mkt'), 'en-US');
  assert.equal(seen.searchParams.get('setlang'), 'en-US');
  stubFetch(async () => new Response('<html></html>', { status: 200 }));
  await assert.rejects(edgeSearch('q3'), /Edge（必应国际版）/);
});

test('聚合搜索认识 google / edge 两个源名', async () => {
  setWebSearch({ provider: 'aggregate', aggregate: { sources: ['google', 'edge'], count: 2 }, google: { apiKey: '', cx: '' } });
  stubFetch(async () => new Response('<li class="b_algo"><h2><a href="https://e.example">E</a></h2></li>', { status: 200 }));
  const r = await aggregateSearch('x');
  assert.deepEqual(r.sources, ['edge']);
  assert.deepEqual(r.failed, ['google']);
});

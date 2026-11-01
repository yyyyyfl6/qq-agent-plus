// 官方插件索引放在 raw.githubusercontent.com；国内一些服务器上这个域名超时，
// 而 api.github.com 可达（2026-10-22 线上实测）。索引仍然只信任 GitHub：
// raw 拉不动时改走 Contents API 的 raw 媒体类型，不经过第三方 CDN。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createIndexTextFetcher } from '../src/plugins/index-fetch.js';
import { githubContentsApiUrl } from '../src/plugins/mirrors.js';

const RAW = 'https://raw.githubusercontent.com/sakurawwwxh/qq-agent-plugins/main/plugins/index.json';
const API = 'https://api.github.com/repos/sakurawwwxh/qq-agent-plugins/contents/plugins/index.json?ref=main';

test('raw.githubusercontent 能换成 Contents API，其他地址不换', () => {
  assert.equal(githubContentsApiUrl(RAW), API);
  assert.equal(githubContentsApiUrl('https://example.com/index.json'), '');
  assert.equal(githubContentsApiUrl('https://raw.githubusercontent.com/o/r/main/../secret'), '');
});

test('raw 正常时只请求一次，不触发 API 兜底', async () => {
  const calls = [];
  const fetchIndexText = createIndexTextFetcher({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { statusCode: 200, body: '{"version":1}' };
    }
  });
  const result = await fetchIndexText(RAW);
  assert.equal(result.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, RAW);
});

test('raw 超时后换 GitHub API，并带 raw 媒体类型', async () => {
  const calls = [];
  const logs = [];
  const fetchIndexText = createIndexTextFetcher({
    log: (line) => logs.push(line),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) throw new Error('请求超时：raw.githubusercontent.com');
      return { statusCode: 200, body: '{"version":1}' };
    }
  });
  const result = await fetchIndexText(RAW);
  assert.equal(result.statusCode, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, API);
  assert.equal(calls[1].options.headers.accept, 'application/vnd.github.raw');
  assert.match(logs.join('\n'), /改走 GitHub API/);
});

test('非 GitHub 地址失败时直接抛原始错误，不做 API 兜底', async () => {
  const calls = [];
  const fetchIndexText = createIndexTextFetcher({
    fetchImpl: async (url) => {
      calls.push(url);
      throw new Error('请求超时：example.com');
    }
  });
  await assert.rejects(() => fetchIndexText('https://example.com/index.json'), /请求超时：example\.com/);
  assert.deepEqual(calls, ['https://example.com/index.json']);
});

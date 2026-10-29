// 多门牌号（src/plugins/mirrors.js）：同一个文件几条取法，逐个试、记住哪条通。
//
// 存在的理由：索引与包都在 GitHub 上，而国内访问是"时快时慢"——同一台服务器上实测过 0.7s、9s、
// 以及偶发 >20s 超时。多备几条的价值不在"更快"，而在"一条断了还能装上"。
//
// 这里**不测真网络**：注入 fetchImpl。真正打网络的那条（safe-fetch）由既有的插件用例覆盖。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-mirrors-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄占用就算了 */ } });

const {
  DEFAULT_MIRROR_PREFIXES, jsdelivrForRaw, mirrorCandidates,
  fetchTextWithMirrors, fetchBinaryWithMirrors, resetMirrorPicks, defaultPickCache
} = await import('../src/plugins/mirrors.js');

const RAW = 'https://raw.githubusercontent.com/sakurawwwxh/qq-agent-plugins/main/plugins/index.json';
const RELEASE = 'https://github.com/sakurawwwxh/qq-agent-plugins/releases/download/v1.0.0/weather-1.0.0.tar.gz';

test('候选列表：原始地址排第一，显式 mirrors 其次，再派生 jsDelivr 与前缀镜像', () => {
  const list = mirrorCandidates({ url: RAW, mirrors: ['https://my-cdn.example/index.json'], prefixes: ['https://gh.example/'] });
  assert.equal(list[0], RAW, '原始地址必须排第一（最权威；国内快的时候它最快，也没必要绕第三方）');
  assert.equal(list[1], 'https://my-cdn.example/index.json', '显式给的 mirrors 紧随其后（我们不猜，用维护者列的）');
  assert.ok(list.includes('https://cdn.jsdelivr.net/gh/sakurawwwxh/qq-agent-plugins@main/plugins/index.json'), 'raw 有确定的 jsDelivr 等价写法');
  assert.ok(list.includes(`https://gh.example/${RAW}`), '前缀型镜像是"前缀 + 原始 URL"');
  assert.equal(new Set(list).size, list.length, '去重');
});

test('候选列表：非 GitHub 地址不加前缀镜像；前缀镜像只对 GitHub 域名有意义', () => {
  const list = mirrorCandidates({ url: 'https://my-own-host.example/plugins/index.json', prefixes: ['https://gh.example/'] });
  assert.deepEqual(list, ['https://my-own-host.example/plugins/index.json'], '自己的地址不该被塞进第三方前缀');
  assert.equal(jsdelivrForRaw('https://example.com/x.json'), '', '只有 raw.githubusercontent.com 有确定换法');
});

test('前缀列表可配：空数组＝只用原始地址（不绕第三方）', () => {
  const list = mirrorCandidates({ url: RAW, prefixes: [] });
  assert.ok(!list.some((item) => item.startsWith('https://' + 'gh')), '空列表时不应出现前缀镜像');
  assert.equal(list[0], RAW);
  assert.equal(DEFAULT_MIRROR_PREFIXES.length > 0, true, '默认要有内置的几个（否则"分流"是空话）');
});

test('取文本：第一条失败自动换下一条，成功后**记住**这条（下次直接用它）', async () => {
  resetMirrorPicks();
  const tried = [];
  const flaky = async (url) => {
    tried.push(url);
    if (url === RAW) throw new Error('连接超时');
    return { statusCode: 200, body: '{"version":1,"plugins":[]}' };
  };
  const first = await fetchTextWithMirrors({ url: RAW, mirrors: ['https://my-cdn.example/index.json'], prefixes: [], fetchImpl: flaky });
  assert.equal(first.ok, true);
  assert.equal(first.url, 'https://my-cdn.example/index.json', '应当落到第二条');
  assert.deepEqual(tried, [RAW, 'https://my-cdn.example/index.json'], '按顺序试，不跳步');

  tried.length = 0;
  const second = await fetchTextWithMirrors({ url: RAW, mirrors: ['https://my-cdn.example/index.json'], prefixes: [], fetchImpl: flaky });
  assert.equal(second.url, 'https://my-cdn.example/index.json');
  assert.equal(tried.length, 1, '记住上次通的那条之后，不必再从第一条开始试');
});

test('取文本：全都不通时把每条的错误都报出来（不要只说"失败"）', async () => {
  resetMirrorPicks();
  const result = await fetchTextWithMirrors({
    url: RAW, prefixes: [], fetchImpl: async (url) => { throw new Error(`拒绝：${url.slice(0, 18)}`); }
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /所有地址都取不动/);
  assert.equal(result.tried.length, 2, `没配镜像前缀，但 raw 还能派生一条 jsDelivr，所以是两条候选（实际 ${result.tried.length}）`);
  assert.equal(result.tried[0].url, RAW, '第一条永远是原始地址');
  assert.match(result.error, /拒绝/, '每条的原因都要带上（排查时才知道是"全超时"还是"其中一个 404"）');
  assert.equal(result.tried.every((item) => item.error.includes('拒绝')), true, '两个候选的失败原因都要留痕');
});

test('取二进制：拿到的内容交给调用方按 sha256 判定（本函数不判真伪）', async () => {
  resetMirrorPicks();
  const body = Buffer.from('假装这是一个包');
  const result = await fetchBinaryWithMirrors({
    url: RELEASE, prefixes: ['https://gh.example/'], maxBytes: 1024 * 1024,
    fetchImpl: async (url, maxBytes) => {
      assert.equal(maxBytes, 1024 * 1024, '体积上限要透传给下载实现（镜像也一样受上限约束）');
      if (url === RELEASE) throw new Error('TLS 握手失败');
      return { buffer: body };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.buffer, body);
  assert.equal(result.url, `https://gh.example/${RELEASE}`, 'Release asset 走前缀镜像');
});

test('镜像配置来自控制台：plugins.mirrorPrefixes 为 null 用默认、空数组则不用镜像', async () => {
  const { createApp } = await import('../src/console/app.js');
  const { updateConfig, DEFAULT_CONFIG } = await import('../src/core/config.js');
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port: 1, token: '' };
  cfg.plugins = { ...cfg.plugins, mirrorPrefixes: [] };
  updateConfig(cfg);
  // 只验证"配成空数组时不会被塞进镜像"这条语义：直接查配置读回来的值
  const { getConfig } = await import('../src/core/config.js');
  assert.deepEqual(getConfig().plugins.mirrorPrefixes, [], '空数组要原样保留（＝只用原始地址）');
  void createApp;
});

test('坏镜像（200 + 错误页/旧包）不能被记成"这条通"，要接着试下一条', async () => {
  resetMirrorPicks();
  const good = Buffer.from('真正的内容');
  const calls = [];
  const result = await fetchBinaryWithMirrors({
    url: RELEASE, prefixes: ['https://bad.example/', 'https://good.example/'], maxBytes: 1024,
    fetchImpl: async (url) => {
      calls.push(url);
      // 原始地址超时；第一个镜像回 200 但内容是错误页（sha 不符）
      if (url === RELEASE) throw new Error('timeout');
      if (url.startsWith('https://bad.example/')) return { buffer: Buffer.from('<html>rate limited</html>') };
      return { buffer: good };
    },
    // 安装器传入的校验：只有真内容才过
    verify: (buffer) => buffer.equals(good)
  });
  assert.equal(result.ok, true);
  assert.equal(result.buffer, good);
  assert.equal(result.url, `https://good.example/${RELEASE}`, '必须继续试到下一条能通过校验的');
  assert.equal(calls.length, 3, '三个候选都试过（原始 + 两个镜像）');

  // 关键：记住的是**通过校验**的那条，不是先回 200 的那条（否则之后每次都先试坏镜像）
  assert.equal(defaultPickCache.get(RELEASE), `https://good.example/${RELEASE}`,
    '坏镜像不能进 pickCache —— 它只"能连上"，内容是不对的');
});

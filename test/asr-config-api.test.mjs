// 语音转写的配置接口：/api/config 里带的服务端判定（configured / available / keySource / keyProvider）
// 与 /api/asr-key 的明文回读。前端只负责显示这些结论，界面与后端判定不能各算一套
// （2026-09-26 审查：此前界面按"有没有 Key"说"在生效"，而后端对 OpenAI 兼容还要求地址+模型名）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-asr-config-api-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');
const { createApp } = await import('../src/console/app.js');

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('ASR 状态由服务端判定，并随配置即时变化', async (t) => {
  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
  cfg.runtime.mode = 'observe';
  cfg.onebot.wsUrl = 'ws://127.0.0.1:1';
  cfg.onebot.httpUrl = 'http://127.0.0.1:1';
  updateConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(async () => {
    await app.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await app.start();
  const request = async (route, { method = 'GET', body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
  const asrStatus = async () => (await request('/api/config')).body.asr;

  // 1) 什么都没配：如实说"没配齐"，且 Key 明文不出现
  let st = await asrStatus();
  assert.equal(st.configured, false);
  assert.equal(st.available, false);
  assert.equal(st.keySource, '');
  assert.equal(Object.prototype.hasOwnProperty.call(st, 'apiKey'), false, '接口不得回传明文 Key');

  // 2) 火山 + Key（记下它是给火山存的）→ 配齐
  await request('/api/config', {
    method: 'POST',
    body: { asr: { ...cfg.asr, enabled: true, provider: 'volc', apiKey: 'volc-secret', apiKeyProvider: 'volc' } }
  });
  st = await asrStatus();
  assert.equal(st.configured, true);
  assert.equal(st.available, true);
  assert.equal(st.keySource, 'config');
  assert.equal(st.hasApiKey, true, 'sanitizeConfig 生成的 hasApiKey 仍在');

  // 3) 换成 OpenAI 兼容：Key 是给火山存的 → 不参与请求，判定回落到"没配齐"（凭据不跨供应商）
  // 只发被测字段（控制台保存时也是这个形状：Key 留空/掩码时不在 patch 里）
  await request('/api/config', {
    method: 'POST',
    body: { asr: { provider: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', model: 'FunAudioLLM/SenseVoiceSmall' } }
  });
  st = await asrStatus();
  assert.equal(st.configured, false, '换供应商后旧 Key 不算数');
  assert.equal(st.keyProvider, 'volc');

  // 4) 补上给这家用的 Key → 配齐；/api/asr-key 能回读明文（仅控制台来源）
  await request('/api/config', {
    method: 'POST',
    body: { asr: { apiKey: 'sf-secret', apiKeyProvider: 'openai' } }
  });
  st = await asrStatus();
  assert.equal(st.configured, true);
  const key = await request('/api/asr-key');
  assert.equal(key.status, 200);
  assert.equal(key.body.apiKey, 'sf-secret');

  // 5) 开关一关：available 立刻为假（工具不再注入）
  await request('/api/config', { method: 'POST', body: { asr: { enabled: false } } });
  st = await asrStatus();
  assert.equal(st.configured, true, '配置还在');
  assert.equal(st.available, false, '但开关关掉就不生效');
});

test('模型列表从服务商官网拉，且保存的 Key 只发给配置里的地址', async (t) => {
  // 造两个"服务商"：一个是我们配置里已知的地址，一个是陌生地址
  const seen = [];
  const makeProvider = async (models) => {
    const server = http.createServer((req, res) => {
      seen.push({ host: req.headers.host, auth: req.headers.authorization || '' , url: req.url });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { port: server.address().port, close: () => new Promise((r) => server.close(r)) };
  };
  // 故意混入 TTS 与通用 LLM：只应列出能转写的那些
  const known = await makeProvider([
    'FunAudioLLM/SenseVoiceSmall', 'Qwen/Qwen3-ASR-1.7B', 'deepseek-chat',
    'FunAudioLLM/CosyVoice2-0.5B', 'tts-1', 'gpt-4o-mini'
  ]);
  const stranger = await makeProvider(['whisper-large-v3-turbo']);
  t.after(async () => { await known.close(); await stranger.close(); });

  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
  cfg.runtime.mode = 'observe';
  cfg.onebot.wsUrl = 'ws://127.0.0.1:1';
  cfg.onebot.httpUrl = 'http://127.0.0.1:1';
  cfg.asr = {
    ...cfg.asr, enabled: true, provider: 'openai',
    baseUrl: `http://127.0.0.1:${known.port}/v1`, model: '', apiKey: 'saved-asr-key', apiKeyProvider: 'openai'
  };
  updateConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(async () => {
    await app.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await app.start();
  const post = async (body) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/asr/models`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };

  // ① 已知地址 + 不传 Key → 用保存的 Key；**只返回语音模型**（用户要求：列表里混着几百个 LLM 等于找不到）
  const first = await post({ baseUrl: `http://127.0.0.1:${known.port}/v1` });
  assert.equal(first.status, 200);
  assert.equal(seen[0].auth, 'Bearer saved-asr-key', '已知地址才用保存的 Key');
  assert.equal(first.body.speechOnly, true);
  assert.deepEqual(first.body.models, ['FunAudioLLM/SenseVoiceSmall', 'Qwen/Qwen3-ASR-1.7B'],
    '只列能转写的；TTS（CosyVoice2 / tts-1）与通用 LLM 都排除');
  assert.equal(first.body.total, 6, '同时报告全量条数，便于说明"从 6 个里筛出 2 个"');

  // ② 陌生地址 + 不传 Key → **不能**把保存的 Key 发过去
  seen.length = 0;
  const second = await post({ baseUrl: `http://127.0.0.1:${stranger.port}/v1` });
  assert.equal(second.status, 200);
  assert.equal(seen[0].auth, '', '陌生地址不得携带保存的 Key');

  // ③ 用户当场填了 Key → 发给他填的那个地址（这是他的明确意图）
  seen.length = 0;
  await post({ baseUrl: `http://127.0.0.1:${stranger.port}/v1`, apiKey: 'typed-key' });
  assert.equal(seen[0].auth, 'Bearer typed-key');
});

test('这家全是 LLM 时退回全量并说明（不让人以为"拉不到"）', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'deepseek-chat' }, { id: 'gpt-4o-mini' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const providerPort = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
  cfg.runtime.mode = 'observe';
  cfg.onebot.wsUrl = 'ws://127.0.0.1:1';
  cfg.onebot.httpUrl = 'http://127.0.0.1:1';
  cfg.asr = { ...cfg.asr, provider: 'openai', baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'k', apiKeyProvider: 'openai' };
  updateConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(async () => {
    await app.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await app.start();
  const response = await fetch(`http://127.0.0.1:${port}/api/asr/models`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({})
  });
  const body = await response.json();
  assert.equal(body.speechOnly, false);
  assert.deepEqual(body.models, ['deepseek-chat', 'gpt-4o-mini'], '认不出语音模型时退回全量');
});

test('语音模型筛选：名字里没有 asr 的转写模型也要留下，TTS 排除并如实回报', async (t) => {
  // 用户 2026-09-26 反馈"硅基流动明明有 8 个语音模型，列表只给 5 个"：
  // 漏掉的是 XingChenGSR（语音识别，名字里没有 asr），另外 2 个是文字转语音（不该进转写列表）。
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    // 照硅基流动当天的真实数据来：98 个模型里语音相关正好 8 个（6 个转写 + 2 个语音合成）
    res.end(JSON.stringify({ data: [
      { id: 'deepseek-ai/DeepSeek-V3' },
      { id: 'FunAudioLLM/SenseVoiceSmall' },
      { id: 'Qwen/Qwen3-ASR-1.7B' },
      { id: 'XingChenAGI/XingChenASR-V3.2' },
      { id: 'XingChenAGI/XingChenASR-V3.2-Ultra' },
      { id: 'XingChenAGI/XingChenASR-Diarize-V3.0' },
      { id: 'XingChenAGI/XingChenGSR-V1.0' },
      { id: 'FunAudioLLM/CosyVoice2-0.5B' },
      { id: 'fnlp/MOSS-TTSD-v0.5' },
      { id: 'zai-org/GLM-5.3' }
    ] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const providerPort = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
  cfg.runtime.mode = 'observe';
  cfg.onebot.wsUrl = 'ws://127.0.0.1:1';
  cfg.onebot.httpUrl = 'http://127.0.0.1:1';
  cfg.asr = { ...cfg.asr, provider: 'openai', baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'k', apiKeyProvider: 'openai' };
  updateConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(async () => {
    await app.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await app.start();
  const response = await fetch(`http://127.0.0.1:${port}/api/asr/models`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({})
  });
  const body = await response.json();
  assert.equal(body.speechOnly, true);
  assert.ok(body.models.includes('XingChenAGI/XingChenGSR-V1.0'), 'GSR 是语音识别，不该因为名字里没有 asr 就漏掉');
  assert.equal(body.models.includes('FunAudioLLM/CosyVoice2-0.5B'), false, 'TTS 不该进转写列表');
  assert.equal(body.speechCount, 6, '6 个转写类都要在（含名字里没有 asr 的那一个）');
  assert.equal(body.ttsCount, 2, '被排除的 TTS 要如实回报，界面才能解释"少的是哪几个"');
  assert.deepEqual([...body.ttsSample].sort(), ['FunAudioLLM/CosyVoice2-0.5B', 'fnlp/MOSS-TTSD-v0.5']);
  assert.equal(body.total, 10);
});

// 切换语音服务预设时凭据跟着切（2026-10-02 用户要求）：每家（槽位）存过的凭据由服务端记住 ——
// 切到存过的那家自动取回、切到没存过的留空（等用户填）；客户端送来的 keys 映射一律被忽略
// （与 tts.keys / imageGen.keys 同款：只准送"这一家新填的凭据"，映射由服务端合并）。
test('切换语音服务预设：凭据按服务记忆（存过取回 / 没存过留空 / 映射不可被客户端覆盖）', async (t) => {
  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
  cfg.runtime.mode = 'observe';
  cfg.onebot.wsUrl = 'ws://127.0.0.1:1';
  cfg.onebot.httpUrl = 'ws://127.0.0.1:1';
  // keys 是映射型字段：deepMerge 不删键，用 __replace__ 让本用例从空映射开始
  // （同文件里其它用例留下的记忆不许串进来，否则 keySlots 断言会随运行顺序漂移）
  cfg.asr = { ...cfg.asr, enabled: true, provider: 'openai', baseUrl: 'https://a.example.com/v1', model: 'm-a', keys: { __replace__: {} } };
  updateConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(async () => {
    await app.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await app.start();
  const request = async (route, { method = 'GET', body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
  const saveAsr = (patch) => request('/api/config', { method: 'POST', body: { asr: patch } });
  const asrStatus = async () => (await request('/api/config')).body.asr;
  const plain = async (field = 'apiKey', { slot = '' } = {}) => {
    const q = `field=${encodeURIComponent(field)}${slot ? `&slot=${encodeURIComponent(slot)}` : ''}`;
    return (await request(`/api/asr-key?${q}`)).body.apiKey;
  };

  // ① 在 A 家填 Key
  let res = await saveAsr({ provider: 'openai', baseUrl: 'https://a.example.com/v1', model: 'm-a', apiKey: 'sk-asr-a' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(await plain(), 'sk-asr-a');
  assert.deepEqual((await asrStatus()).keySlots['openai|a.example.com'], ['apiKey'], '存过 A 家要出现在 keySlots 里');

  // ② 切到没存过的 B 家（掩码/留空路径）→ 不留可用的 Key，回读也拿不到（不能把 A 家的当 B 家的）
  res = await saveAsr({ provider: 'openai', baseUrl: 'https://b.example.com/v1', model: 'm-b' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await asrStatus()).keyUsable, false, '没存过的那家不该显示成"已填"');
  assert.equal(await plain(), '', '回读走的是"这家实际会用的那把"，B 家没有就不给');

  // ③ 在 B 家填 Key → 两家都记着
  res = await saveAsr({ provider: 'openai', baseUrl: 'https://b.example.com/v1', model: 'm-b', apiKey: 'sk-asr-b' });
  assert.equal(await plain(), 'sk-asr-b');
  assert.deepEqual(Object.keys((await asrStatus()).keySlots).sort(),
    ['openai|a.example.com', 'openai|b.example.com'], '两家都要在 keySlots 里');

  // ④ 切回 A 家（不带 Key = 掩码路径）→ 自动取回 A 家的 Key（这条就是用户要的行为）
  res = await saveAsr({ provider: 'openai', baseUrl: 'https://a.example.com/v1', model: 'm-a' });
  assert.equal(await plain(), 'sk-asr-a', '切回存过的那家要自动取回 Key');
  assert.equal((await asrStatus()).keyUsable, true);
  assert.equal((await asrStatus()).keySource, 'config', '取回的 Key 来源是 config（不是 env）');

  // ④b 「显示」按钮带上表单里的目标槽位：刚切换、还没保存时要给**目标**那把，
  //     不能把当前这家（A）的明文显示在新服务名下（2026-10-02 全量审查）
  assert.equal(await plain('apiKey', { slot: 'openai|b.example.com' }), 'sk-asr-b', '表单切到 B → 回显 B 存过的');
  assert.equal(await plain('apiKey', { slot: 'openai|zzz.example.com' }), '', '没存过的主机回空，不许拿别家的顶上');
  assert.equal(await plain('apiKey'), 'sk-asr-a', '不带槽位 = 当前这家（A）');

  // ⑤ 本土服务的一套凭据（腾讯 SecretId + SecretKey）同样按服务记忆，且不会串给百度
  await saveAsr({ provider: 'tencent', baseUrl: '', model: '', secretId: 'AKID-tc', secretKey: 'SK-tc' });
  assert.equal(await plain('secretId'), 'AKID-tc');
  await saveAsr({ provider: 'baidu', baseUrl: '', model: '', apiKey: 'BD_KEY' });
  assert.equal(await plain('secretId'), '', '百度拿不到腾讯的 SecretId（跨服务不串用）');
  await saveAsr({ provider: 'tencent', baseUrl: '', model: '' });
  assert.equal(await plain('secretId'), 'AKID-tc', '切回腾讯要取回 SecretId');
  assert.equal(await plain('secretKey'), 'SK-tc', '切回腾讯要取回 SecretKey');

  // ⑥ 客户端送来的 keys 映射不许覆盖服务端记忆
  res = await saveAsr({ provider: 'tencent', baseUrl: '', model: '', keys: { hijack: { apiKey: 'sk-evil' } } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const slots = (await asrStatus()).keySlots;
  assert.equal(Object.prototype.hasOwnProperty.call(slots, 'hijack'), false, '客户端送的 keys 必须被忽略');
  assert.equal(await plain('secretId'), 'AKID-tc', '原有的记忆不能被冲掉');

  // ⑦ 升级上来的老配置只有单槽（apiKey + 归属钉，keys 映射里没有）：在别家新填凭据时，
  // 老那把必须先归档进映射 —— 否则活动槽被覆盖后就永远取不回（与生图同款，切回来要能取用）
  updateConfig({
    asr: {
      provider: 'openai', baseUrl: 'https://c.example.com/v1', model: 'm-c',
      apiKey: 'sk-legacy-c', apiKeyProvider: 'openai', apiKeyHost: 'c.example.com'
    }
  });
  await saveAsr({ provider: 'openai', baseUrl: 'https://d.example.com/v1', model: 'm-d', apiKey: 'sk-d' });
  assert.equal(await plain(), 'sk-d');
  await saveAsr({ provider: 'openai', baseUrl: 'https://c.example.com/v1', model: 'm-c' });
  assert.equal(await plain(), 'sk-legacy-c', '老配置单槽那把在别家新填时要归档，切回来才能取回');

  // ⑧ 同一家重填一把新凭据：切走再切回要取回**新的**那把（旧值不能被记忆复活）。
  // 这条钉住"新填即写入映射"：只靠"切走时归档"会保留上次归档的旧值，重填就白填了。
  await saveAsr({ provider: 'openai', baseUrl: 'https://c.example.com/v1', model: 'm-c', apiKey: 'sk-c-new' });
  await saveAsr({ provider: 'openai', baseUrl: 'https://d.example.com/v1', model: 'm-d' });   // 切走（触发归档）
  await saveAsr({ provider: 'openai', baseUrl: 'https://c.example.com/v1', model: 'm-c' });
  assert.equal(await plain(), 'sk-c-new', '同一家重填后，切回来要取回新那把');

  // ⑨ 归属未知的老凭据不许被"认领"（2026-10-02 全量审查）：切到讯飞保存（不填凭据）后，
  // secretKey 应仍是"归属未知"——认领会把它洗成讯飞的，百度那边从此取不回（跨服务串用）。
  updateConfig({
    asr: {
      provider: 'openai', baseUrl: 'https://c.example.com/v1', model: 'm-c',
      secretKey: 'UNBOUND-SK', secretKeyProvider: ''
    }
  });
  await saveAsr({ provider: 'iflytek', baseUrl: '', model: '', appId: 'APP-X' });
  const afterIflytek = await asrStatus();
  assert.equal(String(afterIflytek.secretKeyProvider || ''), '', '归属未知的老凭据不该被讯飞认领');
  const onDiskAsr = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).asr;
  assert.equal(Boolean(onDiskAsr.keys?.iflytek?.secretKey), false, '也不该写进讯飞的槽位映射（认领会把别家的凭据洗成这家的）');
  assert.equal(await plain('secretKey'), 'UNBOUND-SK', '讯飞仍能用它（值没丢）');
  await saveAsr({ provider: 'baidu', baseUrl: '', model: '' });
  assert.equal(await plain('secretKey'), 'UNBOUND-SK', '换到百度也还拿得到（没被洗成讯飞的）');

  // ⑩ 整节替换（__replace__）也不能把客户端 keys 写进配置：服务端把自己的映射钉回替换对象
  //    （deepMerge 会整节换成客户端对象 —— 2026-10-02 全量审查实测的绕过路径）
  res = await saveAsr({
    __replace__: {
      enabled: true, provider: 'openai', baseUrl: 'https://a.example.com/v1', model: 'm-a',
      apiKey: 'sk-attacker', keys: { 'openai|evil.example.com': { apiKey: 'sk-evil' } }
    }
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const slotsAfterReplace = (await asrStatus()).keySlots;
  assert.equal(Object.prototype.hasOwnProperty.call(slotsAfterReplace, 'openai|evil.example.com'), false,
    '整节替换里的 keys 必须被忽略');
  assert.ok(Object.keys(slotsAfterReplace).includes('openai|c.example.com'),
    '服务端自己的映射被钉回替换对象（记忆没被整节替换冲掉）');

  // ⑪ 手改成标量的槽位条目不许被摊成字符索引的垃圾（推前复审）：`{...'SCALAR'}` 会写进
  //    0/1/2… 这些键，配置从此多出一份看不懂的东西。同时：归属未知的 secretKey 不许被
  //    "归档兜底 + 取回"自证成这家的（同一批审查实测过这条自证链）
  updateConfig({ asr: { provider: 'tencent', baseUrl: '', model: '', keys: { __replace__: { tencent: 'SCALAR' } } } });
  await saveAsr({ provider: 'tencent', baseUrl: '', model: '', secretId: 'AKID-new' });
  const diskAsr2 = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).asr;
  assert.deepEqual(diskAsr2.keys.tencent, { secretId: 'AKID-new' }, '槽位条目只留服务端写的字段，不夹带字符索引');
  assert.equal(String(diskAsr2.secretKeyProvider || ''), '', '归属未知的 secretKey 不许被这次保存认领');
  assert.equal(diskAsr2.secretKey, 'UNBOUND-SK', '值仍在（当前这家还能用）');
});

// 2026-10-03 全量审查：配置写入口的两条凭据/令牌防线
//  ① 自定义搜索服务列表（providers，**密钥数组**）不许被"设置页回传的脱敏副本"冲掉 Key
//  ② 整节替换（__replace__）不许把 server.token 写进配置（写了下次 start() 直接抛、起不来）
test('设置页回传：自定义搜索服务的 Key 不被清空；整节替换带不进令牌', async (t) => {
  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
  cfg.runtime.mode = 'observe';
  cfg.onebot.wsUrl = 'ws://127.0.0.1:1';
  cfg.onebot.httpUrl = 'ws://127.0.0.1:1';
  cfg.webSearch = {
    ...cfg.webSearch,
    providers: [{ id: 'custom-a', name: '自建 A', baseUrl: 'https://a.example.com/v1', apiKey: 'sk-custom-a' }],
    deepseek: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-deepseek' }
  };
  updateConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(async () => { await app.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  await app.start();
  const request = async (route, { method = 'GET', body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
  const disk = () => JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));

  // ① 界面保存时的形状：GET 的脱敏视图整份展开回传（apiKey 被删、hasApiKey 被加）
  const view = (await request('/api/config')).body.webSearch;
  assert.equal('apiKey' in view.providers[0], false, '前提：视图里没有明文 Key');
  assert.equal(view.providers[0].hasApiKey, true, '前提：视图里有派生标记');
  let res = await request('/api/config', {
    method: 'POST',
    body: { webSearch: { ...view, enabled: true, provider: 'bing', searchUrl: view.searchUrl } }
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  let onDisk = disk();
  assert.equal(onDisk.webSearch.providers[0].apiKey, 'sk-custom-a', '保存设置页不许把自定义搜索服务的 Key 清空');
  assert.equal('hasApiKey' in onDisk.webSearch.providers[0], false, '派生标记不落盘');
  assert.equal('hasApiKey' in onDisk.webSearch, false, '顶层派生位也不落盘');

  // 换了新 Key 的要能写进去（守卫不能变成"永远不让改"）
  res = await request('/api/config', {
    method: 'POST',
    body: { webSearch: { providers: [{ id: 'custom-a', name: '自建 A', baseUrl: 'https://a.example.com/v1', apiKey: 'sk-custom-a-2' }] } }
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(disk().webSearch.providers[0].apiKey, 'sk-custom-a-2', '客户端带新值时要能替换');
  // 内置那七家的单槽（对象合并）本来就安全，顺带钉住
  assert.equal(disk().webSearch.deepseek.apiKey, 'sk-deepseek', '内置搜索服务的 Key 不受影响');

  // ② 整节替换带令牌：必须被剥掉
  res = await request('/api/config', {
    method: 'POST',
    body: { server: { __replace__: { host: '127.0.0.1', port, token: 'stolen-token', hasToken: true } } }
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  onDisk = disk();
  assert.equal(String(onDisk.server.token || ''), '', '替换体里的 token 不许落盘（下次 start() 会直接抛、起不来）');
  assert.equal(onDisk.server.port, port, '替换体里的其它字段照常生效（这条守卫只管凭据）');
});

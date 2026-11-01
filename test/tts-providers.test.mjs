// TTS 多供应商适配器测试（2026-09-28）：请求形状、鉴权位置、错误路径、音频解码。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-tts-providers-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  runtime: { mode: 'active' },
  allow: { private: ['1'] },
  api: { baseUrl: 'https://example.com/v1', apiKey: 'k', model: 'm', thinking: 'on' }
}));

const { synthesizeSpeech, synthesizeVolc, synthesizeMinimax, volcClusterForVoice } = await import('../src/llm/tts.js');
const { synthesizeDoubao, parseTtsStream, explainVolcError, doubaoResourceIdForVoice } = await import('../src/llm/tts-doubao.js');
const { TTS_SERVICES, ttsServiceById, ttsVoicesFor, ttsServiceOfBaseUrl, ttsKeyFor } = await import('../src/llm/tts-presets.js');

test('ttsKeyFor 的单槽兜底按归属走：换服务不带 Key 时不外发（2026-10-03）', async () => {
  const { ttsKeyFor } = await import('../src/llm/tts-presets.js');
  // 老配置形态：单槽 apiKey + 没有 keys 映射
  const legacy = { provider: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', apiKey: 'SK-OLD', keys: {} };
  assert.equal(ttsKeyFor(legacy, 'siliconflow'), 'SK-OLD', '自己家照旧能用（升级零行为变化）');
  assert.equal(ttsKeyFor(legacy, 'doubao'), '', '别家拿不到这把');

  // 提交过 Key 的：归属被记住，只有那家能用
  const owned = { ...legacy, apiKeyService: 'siliconflow' };
  assert.equal(ttsKeyFor(owned, 'siliconflow'), 'SK-OLD');
  assert.equal(ttsKeyFor(owned, 'volc'), '', '归属记在硅基流动，火山拿不到');

  // 缺省（不传 serviceId）= 当前这家
  assert.equal(ttsKeyFor(owned), 'SK-OLD');

  // **这条才区分得开**：配置当前指向豆包，但那把 Key 归属硅基流动（切换过、或手改过配置）——
  // 退回"只认当前这家"的实现会把这把硅基流动的 Key 发给豆包。
  const stale = {
    provider: 'doubao', baseUrl: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
    apiKey: 'SK-OLD', apiKeyService: 'siliconflow', keys: {}
  };
  assert.equal(ttsKeyFor(stale, 'doubao'), '', '当前是豆包、归属在硅基流动 → 豆包拿不到这把');
  assert.equal(ttsKeyFor(stale, 'siliconflow'), 'SK-OLD', '归属方照旧能用');
});

test('ttsKeyFor 只认自有属性：service=constructor 不会把函数源码当成 Key（2026-10-03 全量审查）', async () => {
  const { ttsKeyFor } = await import('../src/llm/tts-presets.js');
  const cfg = { provider: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', keys: {} };
  assert.equal(ttsKeyFor(cfg, 'constructor'), '', '不吃原型链上的 constructor');
  assert.equal(ttsKeyFor(cfg, '__proto__'), '');
  assert.equal(ttsKeyFor(cfg, 'toString'), '');
  assert.equal(ttsKeyFor({ ...cfg, keys: { minimax: 'MM-KEY' } }, 'minimax'), 'MM-KEY', '自有键照常读到');
});

test('预设表：七家齐全，火山 v1 / 豆包 2.0 / MiniMax / MiMo 标记了 provider 与凭据需求', () => {
  const ids = TTS_SERVICES.map((s) => s.id);
  assert.deepEqual(ids, ['siliconflow', 'openai', 'volc', 'doubao', 'minimax', 'mimo', 'custom']);
  assert.equal(ttsServiceById('volc').provider, 'volc');
  assert.deepEqual(ttsServiceById('volc').creds, ['appId', 'key']);
  assert.equal(ttsServiceById('doubao').provider, 'doubao');
  assert.equal(ttsServiceById('doubao').resourceId, 'seed-tts-2.0');
  assert.equal(ttsServiceById('minimax').provider, 'minimax');
  assert.deepEqual(ttsServiceById('minimax').creds, ['key', 'groupId']);
  assert.equal(ttsServiceById('mimo').provider, 'mimo');
  assert.deepEqual(ttsServiceById('mimo').creds, ['key']);
  assert.ok(ttsVoicesFor('mimo', 'mimo-v2.5-tts').includes('Chloe'));
  assert.ok(ttsVoicesFor('siliconflow', 'FunAudioLLM/CosyVoice2-0.5B').includes('anna'));
  assert.ok(ttsServiceById('volc').voicesFlat.includes('BV001_streaming'));
  assert.ok(ttsVoicesFor('minimax', 'speech-01-turbo').includes('female-shaonv'));
  // 豆包 2.0 的音色表 = 官方 2.0 全量清单（102 个），带中文名与分类（下拉按分类分组，和控制台一一对上）
  assert.equal(ttsServiceById('doubao').voicesFlat.length, 102);
  assert.ok(ttsVoicesFor('doubao').includes('zh_female_vv_uranus_bigtts'));
  assert.ok(ttsServiceById('doubao').voicesFlat.some((v) => v.label === 'Vivi 2.0'));
  assert.ok(ttsServiceById('doubao').voicesFlat.every((v) => v.id && v.label && v.cat));
  assert.ok(ttsServiceById('doubao').voicesFlat.some((v) => v.cat === '多语种 2.0' && /需账号开通/.test(v.label)));
});

test('地址认家：火山 v1 与豆包 v3 同域名，按路径区分；Key 不跨家兜底', () => {
  assert.equal(ttsServiceOfBaseUrl('https://openspeech.bytedance.com/api/v1/tts').id, 'volc');
  assert.equal(ttsServiceOfBaseUrl('https://openspeech.bytedance.com/api/v3/tts/unidirectional').id, 'doubao');
  assert.equal(ttsServiceOfBaseUrl('https://openspeech.bytedance.com').id, 'volc');   // 老配置只写域名 = v1
  // 旧配置只有一个 apiKey：问"别的家"时不能把它当成那家的 Key（否则硅基流动的 Key 会打到火山）
  const legacy = { provider: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', apiKey: 'sk-legacy' };
  assert.equal(ttsKeyFor(legacy, 'siliconflow'), 'sk-legacy');
  assert.equal(ttsKeyFor(legacy, 'doubao'), '');
  // keys 映射里有的按家取；问谁取谁
  const multi = { provider: 'doubao', baseUrl: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional', apiKey: 'sk-old', keys: { doubao: 'key-2.0', siliconflow: 'sk-sf' } };
  assert.equal(ttsKeyFor(multi, 'doubao'), 'key-2.0');
  assert.equal(ttsKeyFor(multi, 'siliconflow'), 'sk-sf');
  assert.equal(ttsKeyFor(multi), 'key-2.0');   // 缺省 = 当前这家（v3 地址）
});

test('豆包资源 ID 路由：复刻音色自动切 seed-icl-2.0，官方音色与显式配置不受影响', () => {
  // 复刻音色（控制台给的 S_xxx / 批量查询接口给的小写 icl_xxx）→ 必须走复刻资源，
  // 否则生产实测报 55000000 resource ID is mismatched with speaker related resource
  assert.equal(doubaoResourceIdForVoice('S_abc123', 'seed-tts-2.0'), 'seed-icl-2.0');
  assert.equal(doubaoResourceIdForVoice('S_abc123', ''), 'seed-icl-2.0');
  assert.equal(doubaoResourceIdForVoice('icl_abc123', 'seed-tts-2.0'), 'seed-icl-2.0');
  // 用户显式填了复刻资源就尊重（复刻 1.0 老音色要 seed-icl-1.0）
  assert.equal(doubaoResourceIdForVoice('S_abc123', 'seed-icl-1.0'), 'seed-icl-1.0');
  // 官方音色不受影响 —— 大小写是硬边界：大写 ICL_uranus_* 是火山自营投放音色，
  // 生产实测在 seed-tts-2.0 下正常出音频（2026-09-30）
  assert.equal(doubaoResourceIdForVoice('ICL_uranus_zh_female_bingruoshaonv_tob', 'seed-tts-2.0'), 'seed-tts-2.0');
  assert.equal(doubaoResourceIdForVoice('ICL_uranus_zh_female_bingruoshaonv_tob', ''), 'seed-tts-2.0');
  assert.equal(doubaoResourceIdForVoice('zh_female_vv_uranus_bigtts', 'seed-tts-2.0'), 'seed-tts-2.0');
  assert.equal(doubaoResourceIdForVoice('zh_male_yuanboxiaoshu_moon_bigtts', 'seed-tts-1.0'), 'seed-tts-1.0');
  // 配置为空 + 普通音色 → 默认 2.0
  assert.equal(doubaoResourceIdForVoice('zh_female_vv_uranus_bigtts', ''), 'seed-tts-2.0');
  assert.equal(doubaoResourceIdForVoice('', ''), 'seed-tts-2.0');
  // 请求头真的用了路由结果（不只是纯函数对）
  const calls = [];
  const ndjson = JSON.stringify({ code: 0, data: Buffer.from('Z').toString('base64') });
  return synthesizeDoubao({
    cfg: { apiKey: 'k', voice: 'S_clonevoice1', resourceId: 'seed-tts-2.0' },
    text: 'x',
    fetchFn: async (url, req) => {
      calls.push(req.headers);
      return { ok: true, status: 200, text: async () => ndjson };
    }
  }).then(() => {
    assert.equal(calls[0]['X-Api-Resource-Id'], 'seed-icl-2.0');
  });
});

test('豆包 2.0 适配器：X-Api-Key / AppID+AccessToken 两套鉴权、NDJSON 音频拼接、参数换算', async () => {
  const calls = [];
  const audioA = Buffer.from('AAA').toString('base64');
  const audioB = Buffer.from('BBB').toString('base64');
  const ndjson = [
    JSON.stringify({ code: 0, message: '', data: audioA }),
    JSON.stringify({ code: 0, message: '', data: audioB }),
    JSON.stringify({ code: 20000000, message: 'ok' })
  ].join('\n');
  const out = await synthesizeDoubao({
    cfg: { apiKey: 'key-2.0', voice: 'zh_female_vv_uranus_bigtts', speed: 1.1, gain: 6 },
    text: '你好呀',
    fetchFn: async (url, req) => {
      calls.push({ url: String(url), headers: req.headers, body: JSON.parse(req.body) });
      return { ok: true, status: 200, text: async () => ndjson };
    }
  });
  assert.equal(calls[0].url, 'https://openspeech.bytedance.com/api/v3/tts/unidirectional');
  assert.equal(calls[0].headers['X-Api-Key'], 'key-2.0');
  assert.equal(calls[0].headers['X-Api-Resource-Id'], 'seed-tts-2.0');
  assert.ok(calls[0].headers['X-Api-Request-Id']);
  assert.equal(calls[0].headers['X-Api-App-Id'], undefined);
  assert.equal(calls[0].body.req_params.speaker, 'zh_female_vv_uranus_bigtts');
  assert.equal(calls[0].body.req_params.audio_params.speech_rate, 10);        // (1.1-1)*100
  assert.ok(Math.abs(calls[0].body.req_params.audio_params.loudness_ratio - Math.pow(10, 0.3)) < 1e-9);   // 10^(6/20)
  assert.equal(out.buffer.toString(), 'AAABBB');   // 多块 base64 顺次拼起来
  assert.equal(out.format, 'mp3');

  // AppID 是纯数字 → 走 App-Id + Access-Key 那套
  const calls2 = [];
  await synthesizeDoubao({
    cfg: { appId: '1234567890', apiKey: 'access-token', voice: 'zh_female_vv_uranus_bigtts' },
    text: 'x',
    fetchFn: async (url, req) => {
      calls2.push({ headers: req.headers, body: JSON.parse(req.body) });
      return { ok: true, status: 200, text: async () => ndjson };
    }
  });
  assert.equal(calls2[0].headers['X-Api-App-Id'], '1234567890');
  assert.equal(calls2[0].headers['X-Api-Access-Key'], 'access-token');
  assert.equal(calls2[0].headers['X-Api-Key'], undefined);
  assert.equal(calls2[0].body.req_params.audio_params.speech_rate, 0);
  // 用户填错位置时：把资源 ID 当 AppID 不会误走 AppID 那套（不是纯数字）
  const calls3 = [];
  await synthesizeDoubao({
    cfg: { appId: 'seed-tts-2.0', apiKey: 'key-x', voice: 'zh_female_vv_uranus_bigtts' },
    text: 'x',
    fetchFn: async (url, req) => {
      calls3.push({ headers: req.headers });
      return { ok: true, status: 200, text: async () => ndjson };
    }
  });
  assert.equal(calls3[0].headers['X-Api-Key'], 'key-x');
  assert.equal(calls3[0].headers['X-Api-App-Id'], undefined);
});

test('豆包 2.0 报错：HTTP 层的 header.code 与流内 code 都要变成人话', async () => {
  await assert.rejects(
    synthesizeDoubao({
      cfg: { apiKey: 'bad', voice: 'v' },
      text: 'x',
      fetchFn: async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ header: { code: 45000010, message: 'Invalid X-Api-Key' } }) })
    }),
    /Invalid X-Api-Key.*控制台密钥/s
  );
  await assert.rejects(
    synthesizeDoubao({
      cfg: { apiKey: 'k', voice: 'zh_male_yuanboxiaoshu_moon_bigtts' },
      text: 'x',
      fetchFn: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 55000000, message: 'resource ID is mismatched with speaker related resource' }) })
    }),
    /资源 ID/
  );
  // 空音频 + 只有结束码 → 明确报"没有音频数据"，不能静默成功
  await assert.rejects(
    synthesizeDoubao({
      cfg: { apiKey: 'k', voice: 'v' },
      text: 'x',
      fetchFn: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 20000000, message: 'ok' }) })
    }),
    /没有音频数据/
  );
  // 解析器本身：坏行跳过、非 NDJSON 原文要能看出来
  const parsed = parseTtsStream('不是 JSON\n' + JSON.stringify({ code: 0, data: Buffer.from('X').toString('base64') }));
  assert.equal(parsed.buffer.toString(), 'X');
  assert.equal(parsed.parsedLines, 1);
  assert.match(explainVolcError(3001, ''), /AppID/);
  // 复刻场景的两种错要让用户知道下一步：没开通复刻资源 / 资源与音色不匹配
  assert.match(explainVolcError(45000030, 'requested resource not granted'), /声音复刻2\.0字符版/);
  assert.match(explainVolcError(45000030, ''), /后付费音色服务/);
  assert.match(explainVolcError(55000000, 'resource ID is mismatched'), /seed-icl-2\.0/);
});

test('火山 v1 cluster 路由：复刻音色走 volcano_icl，标准音色与显式配置不受影响', () => {
  // 官方 v1 文档：业务集群「标准音色、复刻等均不相同」；复刻音色配默认 volcano_tts 会报音色不存在/引擎初始化失败
  assert.equal(volcClusterForVoice('S_abc123', ''), 'volcano_icl');
  assert.equal(volcClusterForVoice('S_abc123', 'volcano_tts'), 'volcano_icl');
  assert.equal(volcClusterForVoice('icl_abc123', ''), 'volcano_icl');
  // 显式填复刻集群（含并发版）时尊重
  assert.equal(volcClusterForVoice('S_abc123', 'volcano_icl_concurr'), 'volcano_icl_concurr');
  assert.equal(volcClusterForVoice('S_abc123', 'seed-icl-2.0'), 'seed-icl-2.0');
  // 标准音色不受影响；大写 ICL_uranus_* 是官方自营音色，仍是 volcano_tts
  assert.equal(volcClusterForVoice('BV001_streaming', ''), 'volcano_tts');
  assert.equal(volcClusterForVoice('ICL_uranus_zh_female_bingruoshaonv_tob', 'volcano_tts'), 'volcano_tts');
  assert.equal(volcClusterForVoice('', ''), 'volcano_tts');
  // 请求体真的用了路由结果
  const calls = [];
  return synthesizeVolc({
    cfg: { appId: 'a', apiKey: 't', voice: 'S_clone1' },
    text: 'x',
    fetchFn: async (url, req) => {
      calls.push(JSON.parse(req.body));
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 3000, data: Buffer.from('M').toString('base64') }) };
    }
  }).then(() => {
    assert.equal(calls[0].app.cluster, 'volcano_icl');
  });
});

test('火山适配器：Bearer;<token> 鉴权、audio/request 结构、base64 解码；错误码要报出来', async () => {
  const calls = [];
  const okFetch = async (url, req) => {
    calls.push({ url: String(url), headers: req.headers, body: JSON.parse(req.body) });
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 3000, data: Buffer.from('MP3DATA').toString('base64') }) };
  };
  const out = await synthesizeVolc({
    cfg: { appId: 'app1', apiKey: 'tok1', cluster: 'volcano_tts', voice: 'BV001_streaming', speed: 1.2 },
    text: '你好呀',
    fetchFn: okFetch
  });
  assert.equal(calls[0].url, 'https://openspeech.bytedance.com/api/v1/tts');
  assert.equal(calls[0].headers.authorization, 'Bearer;tok1');
  assert.equal(calls[0].body.app.appid, 'app1');
  assert.equal(calls[0].body.audio.voice_type, 'BV001_streaming');
  assert.equal(calls[0].body.audio.speed_ratio, 1.2);
  assert.equal(calls[0].body.request.text, '你好呀');
  assert.ok(calls[0].body.request.reqid);
  assert.equal(out.buffer.toString(), 'MP3DATA');

  // 业务错误码：把网关原文带出来
  await assert.rejects(
    synthesizeVolc({
      cfg: { appId: 'a', apiKey: 't', voice: 'v' },
      text: 'x',
      fetchFn: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 3001, message: 'token invalid' }) })
    }),
    /token invalid/
  );
  // 缺凭据/缺音色
  await assert.rejects(synthesizeVolc({ cfg: { voice: 'v' }, text: 'x' }), /AppID/);
  await assert.rejects(synthesizeVolc({ cfg: { appId: 'a', apiKey: 't' }, text: 'x' }), /音色/);
});

test('MiniMax 适配器：GroupId 在查询串、hex 音频解码、base_resp 错误要报出来', async () => {
  const calls = [];
  const hex = Buffer.from('MINIMAXAUDIO').toString('hex');
  const out = await synthesizeMinimax({
    cfg: { apiKey: 'mk', groupId: 'gid 1', model: 'speech-01-turbo', voice: 'female-shaonv' },
    text: '在吗',
    fetchFn: async (url, req) => {
      calls.push({ url: String(url), headers: req.headers, body: JSON.parse(req.body) });
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: { audio: hex }, base_resp: { status_code: 0 } }) };
    }
  });
  assert.match(calls[0].url, /\/v1\/t2a_v2\?GroupId=gid%201$/);
  assert.equal(calls[0].headers.authorization, 'Bearer mk');
  assert.equal(calls[0].body.voice_setting.voice_id, 'female-shaonv');
  assert.equal(calls[0].body.model, 'speech-01-turbo');
  assert.equal(out.buffer.toString(), 'MINIMAXAUDIO');

  await assert.rejects(
    synthesizeMinimax({
      cfg: { apiKey: 'k', groupId: 'g', voice: 'v' },
      text: 'x',
      fetchFn: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ base_resp: { status_code: 1004, status_msg: 'invalid api key' } }) })
    }),
    /invalid api key/
  );
  await assert.rejects(synthesizeMinimax({ cfg: { apiKey: 'k', voice: 'v' }, text: 'x' }), /GroupId/);
});

test('统一入口按 provider 分发（openai 走兼容端点）', async () => {
  const calls = [];
  const out = await synthesizeSpeech({
    cfg: { provider: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', apiKey: 'sk', model: 'FunAudioLLM/CosyVoice2-0.5B', voice: 'FunAudioLLM/CosyVoice2-0.5B:anna' },
    text: '分发测试',
    fetchFn: async (url, req) => {
      calls.push({ url: String(url), body: JSON.parse(req.body) });
      return new Response(Buffer.from('OK'), { status: 200 });
    }
  });
  assert.match(calls[0].url, /\/audio\/speech$/);
  assert.equal(calls[0].body.model, 'FunAudioLLM/CosyVoice2-0.5B');
  assert.equal(out.buffer.toString(), 'OK');
});

test('统一入口：只写 v3 地址也会走豆包那条路（provider 可省），Key 按家取', async () => {
  const calls = [];
  const ndjson = JSON.stringify({ code: 0, data: Buffer.from('V3').toString('base64') });
  const out = await synthesizeSpeech({
    cfg: {
      baseUrl: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
      keys: { doubao: 'key-2.0', volc: 'access-token' },
      voice: 'zh_female_vv_uranus_bigtts'
    },
    text: '分发到豆包',
    fetchFn: async (url, req) => {
      calls.push({ url: String(url), headers: req.headers });
      return { ok: true, status: 200, text: async () => ndjson };
    }
  });
  assert.match(calls[0].url, /\/api\/v3\/tts\/unidirectional$/);
  assert.equal(calls[0].headers['X-Api-Key'], 'key-2.0');       // keys.volc 不能串用
  assert.equal(calls[0].headers['X-Api-Resource-Id'], 'seed-tts-2.0');
  assert.equal(out.buffer.toString(), 'V3');
});

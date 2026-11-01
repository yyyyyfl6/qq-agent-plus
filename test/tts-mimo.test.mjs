import assert from 'node:assert/strict';
import { test } from 'node:test';

const { synthesizeMimo, mimoInstruction, normalizeEmotion, MIMO_DEFAULT_URL } = await import('../src/llm/tts-mimo.js');
const { synthesizeSpeech } = await import('../src/llm/tts.js');
const { ttsConfigured } = await import('../src/llm/tts-openai.js');

function okAudio(text = 'MIMOAUDIO') {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      choices: [{ message: { audio: { data: Buffer.from(text).toString('base64') } } }]
    })
  };
}

test('MiMo：导演指令 + 情绪拼进 user 消息，音频从 choices[].message.audio.data 取', async () => {
  const calls = [];
  const out = await synthesizeMimo({
    cfg: {
      baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
      apiKey: 'mk',
      model: 'mimo-v2.5-tts',
      voice: 'Chloe',
      director: '你是小鲸鱼，声音软一点。'
    },
    text: '今天好累啊……',
    emotion: 'tired',
    fetchFn: async (url, req) => {
      calls.push({ url: String(url), headers: req.headers, body: JSON.parse(req.body) });
      return okAudio();
    }
  });

  assert.equal(calls[0].url, 'https://token-plan-cn.xiaomimimo.com/v1/chat/completions');
  assert.equal(calls[0].headers['api-key'], 'mk');
  assert.equal(calls[0].headers.authorization, undefined);
  assert.equal(calls[0].body.model, 'mimo-v2.5-tts');
  assert.equal(calls[0].body.audio.voice, 'Chloe');
  assert.equal(calls[0].body.audio.format, 'mp3');
  assert.equal(calls[0].body.messages.length, 2);
  assert.match(calls[0].body.messages[0].content, /小鲸鱼/);
  assert.match(calls[0].body.messages[0].content, /【情绪】疲惫/);
  assert.equal(calls[0].body.messages[1].role, 'assistant');
  assert.equal(calls[0].body.messages[1].content, '今天好累啊……');
  assert.equal(out.buffer.toString(), 'MIMOAUDIO');
  assert.equal(out.format, 'mp3');
});

test('MiMo：地址可填完整端点，缺省音色/模型走默认值', async () => {
  const calls = [];
  await synthesizeMimo({
    cfg: {
      baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1/chat/completions/',
      apiKey: 'mk'
    },
    text: '嗯。',
    fetchFn: async (url, req) => {
      calls.push({ url: String(url), body: JSON.parse(req.body) });
      return okAudio();
    }
  });
  assert.equal(calls[0].url, 'https://token-plan-cn.xiaomimimo.com/v1/chat/completions');
  assert.equal(calls[0].body.model, 'mimo-v2.5-tts');
  assert.equal(calls[0].body.audio.voice, 'mimo_default');
  assert.match(calls[0].body.messages[0].content, /QQ 群里随口说话/);
});

test('MiMo：上游报错带 HTTP 状态与原因；缺 Key 直接拒绝', async () => {
  await assert.rejects(
    synthesizeMimo({
      cfg: { apiKey: 'bad', voice: 'Chloe' },
      text: 'x',
      fetchFn: async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: { message: 'invalid api key' } }) })
    }),
    /HTTP 401：invalid api key/
  );
  await assert.rejects(synthesizeMimo({ cfg: { baseUrl: MIMO_DEFAULT_URL }, text: 'x' }), /API Key/);
});

test('情绪词中英文都认，未知值不硬塞', () => {
  assert.equal(normalizeEmotion('happy'), 'happy');
  assert.equal(normalizeEmotion('开心'), 'happy');
  assert.equal(normalizeEmotion('莫名其妙'), '');
  assert.match(mimoInstruction({ emotion: 'soft' }), /【情绪】温柔/);
  assert.equal(mimoInstruction({ emotion: '' }).includes('【情绪】'), false);
});

test('统一入口：只写 provider=mimo 也会打到 token-plan（Key 按家取）', async () => {
  const calls = [];
  const out = await synthesizeSpeech({
    cfg: { provider: 'mimo', keys: { mimo: 'key-mimo' }, voice: 'Chloe', model: 'mimo-v2.5-tts' },
    text: '分发到 MiMo',
    emotion: 'happy',
    fetchFn: async (url, req) => {
      calls.push({ url: String(url), headers: req.headers, body: JSON.parse(req.body) });
      return okAudio('DISPATCHED');
    }
  });
  assert.equal(calls[0].url, MIMO_DEFAULT_URL);
  assert.equal(calls[0].headers['api-key'], 'key-mimo');
  assert.match(calls[0].body.messages[0].content, /【情绪】开心/);
  assert.equal(out.buffer.toString(), 'DISPATCHED');
  assert.equal(ttsConfigured({ tts: { enabled: true, provider: 'mimo' } }), true);
});

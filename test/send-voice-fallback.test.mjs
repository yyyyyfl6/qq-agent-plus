import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// 配置在导入 tools-core 前落盘：send_voice 读的是 getConfig()。
// baseUrl 指向本机 1 端口（必然拒绝连接），这样既不碰外网，也能稳定走到失败回落分支。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-send-voice-fallback-'));
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  tts: {
    enabled: true,
    provider: 'mimo',
    baseUrl: 'http://127.0.0.1:1',
    keys: { mimo: 'test-key' },
    model: 'mimo-v2.5-tts',
    voice: 'Chloe',
    timeoutMs: 5000
  }
}));
process.env.QQ_AGENT_DATA_DIR = dataDir;
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 忽略 */ } });

const { buildToolDefs, executeTool } = await import('../src/tools/tools-core.js');
const defs = buildToolDefs();

test('send_voice：语音合成失败时回落成文字，不把这轮回复吞掉', async () => {
  const sent = [];
  let voiceCalled = false;
  const ctx = {
    chatKey: 'group:123',
    signal: new AbortController().signal,
    session: {},
    sender: {
      voice: async () => { voiceCalled = true; throw new Error('不应该走到发送语音'); },
      sendTextBatch: async (chatKey, messages, options) => {
        sent.push({ chatKey, messages, options });
        return { sent: [{ text: messages[0], messageId: 1 }], failed: [] };
      }
    }
  };

  const result = await executeTool(defs, ctx, 'send_voice', JSON.stringify({
    text: '今天有点累……',
    emotion: 'tired'
  }));

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content);
  assert.equal(payload.sent, true);
  assert.equal(payload.fallback, 'text');
  assert.match(payload.warning, /语音合成失败/);
  assert.match(payload.warning, /改用文字/);
  assert.equal(voiceCalled, false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatKey, 'group:123');
  assert.deepEqual(sent[0].messages, ['今天有点累……']);
  assert.equal(ctx.session.visibleReply, true);
});

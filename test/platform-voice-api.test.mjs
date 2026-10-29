// 控制台「平台能力」页「语音音色」下拉的数据源（2026-10-07）：
//   GET /api/onebot/ai-characters —— 目录按群取（默认第一个白名单群，可 ?groupId= 指定），
//   协议端失败要 502 且带可读原因（前端据此保留已保存值、提示"没拉到"）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-voice-api-'));
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

function get(port, urlPath, headers = {}) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'GET', headers },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          let body = null;
          try { body = JSON.parse(text); } catch { /* 非 JSON */ }
          resolve({ status: res.statusCode, text, body });
        });
      }
    );
    req.on('error', (e) => resolve({ status: 0, text: String(e.message), body: null }));
    req.end();
  });
}

/** 每个用例一个实例（同进程起两个实例时 Windows 上清理会 EPERM，且日志会互相干扰）。 */
async function boot(t, { groups = ['433397830'] } = {}) {
  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
  cfg.runtime.mode = 'active';
  cfg.allow = { ...cfg.allow, groups };
  cfg.onebot = { ...cfg.onebot, wsUrl: 'ws://127.0.0.1:1', httpUrl: 'http://127.0.0.1:1', accessToken: '' };
  updateConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(async () => {
    await app.stop();
    // Windows 上句柄可能还没释放（rm 会 EPERM）——清理失败不该让用例判失败
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 留着也无害 */ }
  });
  await app.start();
  return { port, app, get: (p, h = {}) => get(port, p, { host: `127.0.0.1:${port}`, ...h }) };
}

test('GET /api/onebot/ai-characters：默认取第一个白名单群，返回展平的音色目录；?groupId= 可指定', async (t) => {
  const { app, get: fetchPath } = await boot(t);
  const asked = [];
  app.onebot.getAiCharacters = async (groupId) => {
    asked.push(String(groupId));
    return [
      { characterId: 'lucy-voice-laibixiaoxin', name: '小新', category: '推荐' },
      { characterId: 'lucy-voice-daji', name: '妲己', category: '古风' }
    ];
  };

  const res = await fetchPath('/api/onebot/ai-characters');
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(asked, ['433397830'], '默认用第一个白名单群去取目录');
  assert.equal(res.body?.groupId, '433397830');
  assert.deepEqual(res.body?.characters, [
    { characterId: 'lucy-voice-laibixiaoxin', name: '小新', category: '推荐' },
    { characterId: 'lucy-voice-daji', name: '妲己', category: '古风' }
  ]);

  const explicit = await fetchPath('/api/onebot/ai-characters?groupId=999');
  assert.equal(explicit.status, 200, explicit.text);
  assert.deepEqual(asked, ['433397830', '999'], '?groupId= 要能指定群');
});

test('GET /api/onebot/ai-characters：没有群可查 → 400（提示去哪配）', async (t) => {
  const { get: fetchPath } = await boot(t, { groups: [] });
  const empty = await fetchPath('/api/onebot/ai-characters');
  assert.equal(empty.status, 400, empty.text);
  assert.match(String(empty.body?.error || ''), /白名单|groupId/);
});

test('GET /api/onebot/ai-characters：协议端失败 → 502 且带原因', async (t) => {
  const { app, get: fetchPath } = await boot(t);
  app.onebot.getAiCharacters = async () => { throw new Error('协议端未连接'); };
  const failed = await fetchPath('/api/onebot/ai-characters');
  assert.equal(failed.status, 502, failed.text);
  assert.match(String(failed.body?.error || ''), /协议端未连接/, '失败原因要带回控制台（前端据此提示"没拉到"）');
});

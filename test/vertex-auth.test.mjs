// Vertex AI 服务账号直连：JWT 签名、换令牌、缓存、地址占位符、安全闸（只发 Google 官方域名），
// 以及 chatCompletion 端到端（聊天请求带的是访问令牌而不是 JSON 本身）。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-vertex-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ server: { port: 22531, host: '127.0.0.1' } }));
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 忽略 */ } });

const va = await import('../src/llm/vertex-auth.js');
const { chatCompletion } = await import('../src/llm/llm.js');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA = {
  type: 'service_account',
  project_id: 'my-proj-123',
  private_key_id: 'kid-1',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  client_email: 'bot@my-proj-123.iam.gserviceaccount.com',
  token_uri: 'https://oauth2.googleapis.com/token'
};
const SA_TEXT = JSON.stringify(SA, null, 2);
const BASE = 'https://aiplatform.googleapis.com/v1/projects/{project}/locations/global/endpoints/openapi';

const fromB64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function tokenServer() {
  const calls = [];
  const fetchFn = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      const params = new URLSearchParams(opts.body);
      assert.equal(params.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
      const [h, c, sig] = params.get('assertion').split('.');
      assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, fromB64url(sig)), 'JWT 签名应能用公钥验证');
      const claims = JSON.parse(fromB64url(c).toString());
      assert.equal(claims.iss, SA.client_email);
      assert.equal(claims.aud, SA.token_uri);
      assert.equal(claims.scope, 'https://www.googleapis.com/auth/cloud-platform');
      assert.equal(claims.exp - claims.iat, 3600);
      assert.equal(JSON.parse(fromB64url(h).toString()).kid, 'kid-1');
      return json(200, { access_token: `ya29.token-${calls.length}`, expires_in: 3599, token_type: 'Bearer' });
    }
    throw new Error(`意外请求 ${url}`);
  };
  return { calls, fetchFn };
}

test('识别服务账号 JSON；普通 Key、坏 JSON、别的 JSON 都不当成服务账号', () => {
  assert.equal(va.parseServiceAccount(SA_TEXT).client_email, SA.client_email);
  assert.equal(va.parseServiceAccount(SA_TEXT.replace(/\n/g, '')).project_id, 'my-proj-123', '粘进单行输入框（换行被去掉）也能认');
  assert.equal(va.parseServiceAccount('sk-abc'), null);
  assert.equal(va.parseServiceAccount('{bad json'), null);
  assert.equal(va.parseServiceAccount('{"type":"authorized_user"}'), null);
});

test('换令牌：签名可验、结果缓存（同一账号只换一次）、并发合并', async () => {
  va.clearVertexTokenCache();
  const { calls, fetchFn } = tokenServer();
  const [a, b] = await Promise.all([va.vertexAccessToken(SA, { fetchFn }), va.vertexAccessToken(SA, { fetchFn })]);
  assert.equal(a, 'ya29.token-1');
  assert.equal(b, a);
  assert.equal(await va.vertexAccessToken(SA, { fetchFn }), a);
  assert.equal(calls.length, 1);
});

test('令牌快过期就续；换令牌失败只报 Google 的错误码，不回显断言', async () => {
  va.clearVertexTokenCache();
  let t = 1_000_000;
  const { calls, fetchFn } = tokenServer();
  await va.vertexAccessToken(SA, { fetchFn, now: () => t });
  t += 56 * 60_000;   // 离过期不到 5 分钟
  await va.vertexAccessToken(SA, { fetchFn, now: () => t });
  assert.equal(calls.length, 2);
  va.clearVertexTokenCache();
  const bad = async () => json(400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' });
  await assert.rejects(va.vertexAccessToken(SA, { fetchFn: bad }), (e) => /HTTP 400（invalid_grant：Invalid JWT Signature\.）/.test(e.message) && !/eyJ/.test(e.message));
});

test('安全闸：token_uri 不是 Google 官方、服务地址不是 Vertex 都拒绝且不发请求', async () => {
  va.clearVertexTokenCache();
  const never = async () => { throw new Error('不该发请求'); };
  await assert.rejects(va.vertexAccessToken({ ...SA, token_uri: 'https://evil.example/token' }, { fetchFn: never }), /不是 Google 官方地址/);
  await assert.rejects(va.resolveRequestAuth({ baseUrl: 'https://api.openai.com/v1', apiKey: SA_TEXT }, { fetchFn: never }), /不是 Vertex 官方地址/);
  await assert.rejects(va.resolveRequestAuth({ baseUrl: 'https://aiplatform.googleapis.com.evil.com/v1', apiKey: SA_TEXT }, { fetchFn: never }), /不是 Vertex 官方地址/);
  assert.equal(va.isVertexHost('https://us-central1-aiplatform.googleapis.com/v1'), true);
});

test('普通 Key 原样放行；服务账号展开 {project} 并换成令牌', async () => {
  va.clearVertexTokenCache();
  assert.deepEqual(await va.resolveRequestAuth({ baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-1' }), { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-1', vertex: false });
  const { fetchFn } = tokenServer();
  const r = await va.resolveRequestAuth({ baseUrl: BASE, apiKey: SA_TEXT }, { fetchFn });
  assert.equal(r.baseUrl, 'https://aiplatform.googleapis.com/v1/projects/my-proj-123/locations/global/endpoints/openapi');
  assert.equal(r.apiKey, 'ya29.token-1');
  assert.equal(r.vertex, true);
});

test('chatCompletion 端到端：聊天请求打到 Vertex，带的是访问令牌而不是 JSON', async () => {
  va.clearVertexTokenCache();
  const { calls, fetchFn } = tokenServer();
  const realFetch = globalThis.fetch;
  let chat = null;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('oauth2.googleapis.com')) return fetchFn(url, opts);
    chat = { url: String(url), auth: opts.headers.authorization, body: JSON.parse(opts.body) };
    return json(200, { choices: [{ message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } });
  };
  try {
    const r = await chatCompletion({
      messages: [{ role: 'user', content: 'ping' }],
      overrides: { baseUrl: BASE, apiKey: SA_TEXT, model: 'google/gemini-2.5-flash' }
    });
    assert.equal(r.message.content, 'pong');
    assert.equal(chat.url, 'https://aiplatform.googleapis.com/v1/projects/my-proj-123/locations/global/endpoints/openapi/chat/completions');
    assert.equal(chat.auth, 'Bearer ya29.token-1');
    assert.equal(chat.body.model, 'google/gemini-2.5-flash');
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

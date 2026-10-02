import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { DEFAULT_SKINS } from '../src/skins/skins.js';

let Window;
try { ({ Window } = await import('happy-dom')); } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
test('standalone skins console saves toggles, switches a chat and displays server errors', { skip: !Window }, async (t) => {
  const window = new Window({ url: 'http://localhost' });
  window.document.write(fs.readFileSync(new URL('../ui/skins.html', import.meta.url), 'utf8').replace(/<script[^>]*>\s*<\/script>/g, ''));
  let settings = structuredClone(DEFAULT_SKINS); settings.enabled = true;
  let binding = 'fish'; let fail = false; const writes = [];
  const old = { document: globalThis.document, fetch: globalThis.fetch, confirm: globalThis.confirm };
  globalThis.document = window.document; globalThis.confirm = () => true;
  globalThis.fetch = async (route, options = {}) => {
    if (fail) return { ok: false, status: 409, json: async () => ({ error: '测试失败' }) };
    if (options.method === 'POST') {
      const body = JSON.parse(options.body); writes.push({ route, body });
      if (route === '/api/skins') settings = body.skins;
      else binding = body.skinId;
    }
    return { ok: true, status: 200, json: async () => route === '/api/skins' ? { skins: settings, providers: [] } : { chats: [{ chatKey: 'group:1', skinId: binding }] } };
  };
  t.after(() => { Object.assign(globalThis, old); window.happyDOM.abort(); });
  await import('../ui/skins.js');
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await new Promise((r) => setTimeout(r, 20));
  assert.match(window.document.querySelector('#skin-status').textContent, /已启用/);
  window.document.querySelector('#skins-handoff').checked = false;
  await window.document.querySelector('#skins-form').onsubmit({ preventDefault() {} });
  assert.equal(writes[0].body.skins.handoffOnSwitch.enabled, false);
  const row = window.document.querySelector('[data-chat]'); row.querySelector('select').value = 'cat';
  await row.querySelector('button').onclick();
  assert.equal(binding, 'cat');
  assert.deepEqual(writes[1], { route: '/api/chat-skins', body: { chatKey: 'group:1', skinId: 'cat' } });
  fail = true;
  await window.document.querySelector('#skins-form').onsubmit({ preventDefault() {} });
  assert.match(window.document.querySelector('#skin-status').textContent, /保存失败：测试失败/);
});

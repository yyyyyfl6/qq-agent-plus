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
  settings.list[0].provider = 'ds'; settings.list[1].provider = 'gm';
  let providers = [{ id: 'ds', name: '同站多模型', baseURL: 'https://models.example/v1', models: ['deepseek-flash', 'gemini-added'], hasKey: true }];
  let binding = 'fish'; let fail = false; const writes = [];
  const old = { document: globalThis.document, fetch: globalThis.fetch, confirm: globalThis.confirm };
  globalThis.document = window.document; globalThis.confirm = () => true;
  globalThis.fetch = async (route, options = {}) => {
    if (fail) return { ok: false, status: 409, json: async () => ({ error: '测试失败' }) };
    if (options.method === 'POST') {
      const body = JSON.parse(options.body); writes.push({ route, body });
      if (route === '/api/skins') settings = body.skins;
      else if (route === '/api/providers') providers = [{ ...providers[0], models: body.models }];
      else if (route === '/api/chat-skins') binding = body.skinId;
    }
    const response = route === '/api/skins' ? { skins: settings, providers, templates: { blue_fish: { name: '鱼' }, hajimi: { name: '猫' }, custom_0: { name: '自定义预设' } }, globalApi: { model: 'global-chat' } }
      : route === '/api/providers/fetch-models' ? { models: ['deepseek-flash', 'gemini-retrieved'] }
        : route === '/api/providers' ? { provider: providers[0] }
          : { chats: [{ chatKey: 'group:1', skinId: binding }], changed: true, handoffStatus: 'failed', handoffError: 'HTTP 401：认证失败' };
    return { ok: true, status: 200, json: async () => response };
  };
  t.after(() => { Object.assign(globalThis, old); window.happyDOM.abort(); });
  await import('../ui/skins.js');
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await new Promise((r) => setTimeout(r, 20));
  assert.match(window.document.querySelector('#skin-status').textContent, /已启用/);
  const doc = window.document;
  assert.equal(doc.querySelector('#skins-list').tagName, 'DIV');
  assert.ok(doc.querySelector('#skin-models-0').innerHTML.includes('gemini-added'));
  assert.equal(doc.querySelector('#skins-summary-model').value, 'deepseek-flash');
  doc.querySelector('#skin-add').onclick();
  const addedRow = doc.querySelector('#skins-list').lastElementChild;
  addedRow.querySelector('[data-field="label"]').value = '第三人格';
  addedRow.querySelector('[data-field="templateId"]').value = 'custom_0';
  addedRow.querySelector('[data-field="commands"]').value = '变成第三人格';
  doc.querySelector('#skins-summary-model').value = 'summary-other';
  window.document.querySelector('#skins-handoff').checked = false;
  await window.document.querySelector('#skins-form').onsubmit({ preventDefault() {} });
  assert.equal(writes[0].body.skins.handoffOnSwitch.enabled, false);
  assert.equal(settings.list.length, 3);
  assert.equal(settings.list[2].templateId, 'custom_0');
  assert.deepEqual(settings.list[2].commands, ['变成第三人格']);
  assert.equal(settings.handoffOnSwitch.model, 'summary-other');
  const row = window.document.querySelector('[data-chat]'); row.querySelector('select').value = 'cat';
  await row.querySelector('button').onclick();
  assert.equal(binding, 'cat');
  assert.match(doc.querySelector('#skin-switch-status').textContent, /人格已切换.*HTTP 401/);
  assert.deepEqual(writes[1], { route: '/api/chat-skins', body: { chatKey: 'group:1', skinId: 'cat' } });
  doc.querySelector('#skin-provider-edit').value = 'ds'; doc.querySelector('#skin-provider-edit').onchange();
  assert.equal(doc.querySelector('#skin-provider-key').value, '');
  await doc.querySelector('#skin-fetch-models').onclick();
  assert.ok(doc.querySelector('#skin-provider-models').value.includes('gemini-retrieved'));
  doc.querySelector('#skin-provider-models').value += '\ngemini-manual';
  await doc.querySelector('#skins-provider-form').onsubmit({ preventDefault() {} });
  assert.equal(writes.at(-1).body.activate, false);
  assert.ok(doc.querySelector('#skin-models-0').innerHTML.includes('gemini-manual'));
  const { initSkinsPage } = await import('../ui/skins.js'); await initSkinsPage();
  assert.equal(doc.querySelectorAll('.persona-editor').length, 3);
  assert.equal(doc.querySelector('#skins-summary-model').value, 'summary-other');
  fail = true;
  await window.document.querySelector('#skins-form').onsubmit({ preventDefault() {} });
  assert.match(window.document.querySelector('#skin-status').textContent, /保存失败：测试失败/);
});

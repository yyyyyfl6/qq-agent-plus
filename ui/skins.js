import { api } from './core/api.js';
import { esc } from './core/dom.js';

export async function initSkinsPage() {
  const page = document.getElementById('skins-page');
  if (!page) return;
  const el = (id) => document.getElementById(id);
  const status = el('skin-status');
  const report = (node, message, error = false) => { node.textContent = message; node.classList.toggle('personas-error', error); };
  const lines = (value) => [...new Set(String(value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean))];
  const option = (value, label, selected) => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`;
  const modelIds = (p) => (p?.models || []).map((m) => typeof m === 'string' ? m : m.id).filter(Boolean);
  let data;
  let bindings;
  const readRows = () => [...el('skins-list').querySelectorAll('.persona-editor')].map((row) => Object.fromEntries(
    [...row.querySelectorAll('[data-field]')].map((input) => [input.dataset.field, input.dataset.field === 'commands' ? lines(input.value) : input.value.trim()])
  ));
  const providerOptions = (selected, auto = false) => {
    const known = data.providers.some((p) => p.id === selected);
    return option('', auto ? '自动选择（或全局 API）' : '全局 API', selected)
      + (!known && selected ? option(selected, `${selected}（未找到，请重新选择）`, selected) : '')
      + data.providers.map((p) => option(p.id, p.name, selected)).join('');
  };
  const updateModels = (input, list, pid) => {
    const models = pid ? modelIds(data.providers.find((p) => p.id === pid)) : [data.globalApi.model, ...data.providers.flatMap(modelIds)];
    list.innerHTML = [...new Set([input.value, ...models].filter(Boolean))].map((m) => option(m, m, '')).join('');
  };
  const updateDefault = () => {
    const current = el('skins-default').value || data.skins.default;
    el('skins-default').innerHTML = readRows().map((s) => option(s.id, s.label || s.id, current)).join('');
  };
  const renderRows = (list) => {
    el('skins-list').innerHTML = list.map((s, i) => `<article class="persona-editor">
      <div class="section-title"><h3>${esc(s.label || s.id)}</h3><button type="button" class="btn btn-small" data-remove ${list.length === 1 ? 'disabled' : ''}>移除配置</button></div>
      <div class="personas-fields">
        <label>人格 ID<input data-field="id" value="${esc(s.id)}" pattern="[a-z][a-z0-9_-]{0,39}" maxlength="40" required ${data.skins.list.some((old) => old.id === s.id) ? 'readonly' : ''}></label>
        <label>显示名称<input data-field="label" value="${esc(s.label)}" maxlength="200" required></label>
        <label>人格预设<select data-field="templateId">${Object.entries(data.templates).map(([id, p]) => option(id, p.name, s.templateId)).join('')}</select></label>
        <label>提供商<select data-field="provider">${providerOptions(s.provider)}</select></label>
        <label>模型（输入可搜索，也可手填 ID）<input data-field="model" value="${esc(s.model)}" list="skin-models-${i}" required><datalist id="skin-models-${i}"></datalist></label>
        <label>机器人称呼<input data-field="botName" value="${esc(s.botName)}" maxlength="200"></label>
      </div>
      <label>专属切换指令（每行一条，完整匹配）<textarea data-field="commands" rows="2" placeholder="例如：切换哈基米">${esc((s.commands || []).join('\n'))}</textarea></label>
      <p class="muted">已保存的人格 ID 保持固定，用于定位历史与记忆。移除配置会保留其数据。</p>
    </article>`).join('');
    for (const row of el('skins-list').querySelectorAll('.persona-editor')) {
      const provider = row.querySelector('[data-field="provider"]');
      const input = row.querySelector('[data-field="model"]');
      const listNode = row.querySelector('datalist');
      updateModels(input, listNode, provider.value);
      provider.onchange = () => { updateModels(input, listNode, provider.value); };
      row.querySelector('[data-field="label"]').oninput = () => { row.querySelector('h3').textContent = row.querySelector('[data-field="label"]').value; updateDefault(); };
      row.querySelector('[data-field="id"]').oninput = updateDefault;
      row.querySelector('[data-remove]').onclick = () => {
        if (!confirm('移除这个人格的配置？已有存档与记忆会保留。')) return;
        renderRows(readRows().filter((_, index) => index !== [...el('skins-list').children].indexOf(row)));
      };
    }
    updateDefault();
    el('skin-add').disabled = list.length >= 16;
  };
  const refreshCatalog = async () => {
    const rows = readRows();
    const fresh = await api('/api/skins');
    data.providers = fresh.providers; data.templates = fresh.templates; data.globalApi = fresh.globalApi;
    renderRows(rows);
    const selected = el('skins-summary-provider').value;
    el('skins-summary-provider').innerHTML = providerOptions(selected, true);
    updateModels(el('skins-summary-model'), el('summary-model-options'), selected);
    el('skin-provider-edit').innerHTML = option('', '＋ 添加提供商', '') + data.providers.map((p) => option(p.id, p.name, '')).join('');
  };
  const renderBindings = () => {
    const skins = data.skins;
    el('skins-chats').innerHTML = bindings.chats.length ? bindings.chats.map((c) => `<div class="skin-row" data-chat="${esc(c.chatKey)}"><strong>${esc(c.chatKey)}</strong>
      <select aria-label="${esc(c.chatKey)} 的人格">${skins.list.map((s) => option(s.id, s.label, c.skinId)).join('')}</select><button type="button" class="btn btn-small" ${skins.enabled ? '' : 'disabled'}>切换人格</button></div>`).join('') : '<p class="muted">尚无会话。收到消息后会在这里显示。</p>';
    for (const row of el('skins-chats').querySelectorAll('[data-chat]')) row.querySelector('button').onclick = async () => {
      if (!confirm('切换这个会话的人格并结束当前线程？')) return;
      const button = row.querySelector('button'); button.disabled = true;
      try {
        report(el('skin-switch-status'), '正在切换；交接总结可能需要几秒…');
        const result = await api('/api/chat-skins', { method: 'POST', body: JSON.stringify({ chatKey: row.dataset.chat, skinId: row.querySelector('select').value }) });
        report(el('skin-switch-status'), result.handoffError ? `人格已切换，交接总结失败：${result.handoffError}` : !result.changed ? '当前已使用这个人格。' : `人格已切换 · ${result.handoff ? '已生成交接总结' : result.handoffStatus === 'disabled' ? '交接总结已关闭' : result.handoffStatus === 'empty-response' ? '总结返回为空' : '没有最近对话可总结'}`, Boolean(result.handoffError));
        bindings = await api('/api/chat-skins'); renderBindings();
      } catch (error) { report(el('skin-switch-status'), '切换失败：' + error.message, true); button.disabled = false; }
    };
  };
  try {
    [data, bindings] = await Promise.all([api('/api/skins'), api('/api/chat-skins')]);
    const skins = data.skins;
    el('skins-enabled').checked = skins.enabled;
    el('skins-handoff').checked = skins.handoffOnSwitch.enabled;
    el('skins-ack').value = skins.ack;
    el('skins-prefixes').value = skins.switchCommands.join('\n');
    el('skins-summary-provider').innerHTML = providerOptions(skins.handoffOnSwitch.provider, true);
    el('skins-summary-model').value = skins.handoffOnSwitch.model || 'deepseek-flash';
    el('skins-summary-recent').value = skins.handoffOnSwitch.recentMessages;
    el('skins-summary-chars').value = skins.handoffOnSwitch.maxChars;
    el('skins-summary-provider').onchange = () => updateModels(el('skins-summary-model'), el('summary-model-options'), el('skins-summary-provider').value);
    updateModels(el('skins-summary-model'), el('summary-model-options'), skins.handoffOnSwitch.provider);
    renderRows(skins.list); renderBindings();
    report(status, skins.enabled ? '已启用 · 修改后记得保存' : '已关闭 · 保存时启用即可使用多个人格');
    el('skin-add').onclick = () => {
      const rows = readRows();
      renderRows([...rows, { id: `persona_${Date.now().toString(36)}`, label: '新人格', templateId: Object.keys(data.templates)[0], provider: data.providers[0]?.id || '', model: modelIds(data.providers[0])[0] || data.globalApi.model || 'deepseek-flash', botName: '', commands: [] }]);
      el('skins-list').lastElementChild.querySelector('[data-field="label"]').focus();
    };
    el('skins-form').onsubmit = async (event) => {
      event.preventDefault(); el('skins-save').disabled = true;
      try {
        const result = await api('/api/skins', { method: 'POST', body: JSON.stringify({ skins: { ...data.skins, enabled: el('skins-enabled').checked, default: el('skins-default').value, ack: el('skins-ack').value, switchCommands: lines(el('skins-prefixes').value), list: readRows(), handoffOnSwitch: { enabled: el('skins-handoff').checked, provider: el('skins-summary-provider').value, model: el('skins-summary-model').value.trim() || 'deepseek-flash', maxChars: Number(el('skins-summary-chars').value), recentMessages: Number(el('skins-summary-recent').value) } } }) });
        data.skins = result.skins; renderRows(data.skins.list); renderBindings();
        report(status, '人格与总结设置已保存。');
      } catch (error) { report(status, '保存失败：' + error.message, true); }
      finally { el('skins-save').disabled = false; }
    };
    el('skin-provider-edit').innerHTML = option('', '＋ 添加提供商', '') + data.providers.map((p) => option(p.id, p.name, '')).join('');
    el('skin-provider-edit').onchange = () => {
      const p = data.providers.find((p) => p.id === el('skin-provider-edit').value);
      el('skin-provider-url').value = p?.baseURL || '';
      el('skin-provider-key').value = '';
      el('skin-provider-key-note').textContent = p?.hasKey ? '已保存可用 Key；留空保留。修改 URL 会创建新提供商，需要填写它的 Key。' : '请输入这家提供商的 Key。Key 不会回显。';
      el('skin-provider-models').value = modelIds(p).join('\n');
      el('skin-model-count').textContent = `${modelIds(p).length} 个已保存模型`;
    };
    el('skin-fetch-models').onclick = async () => {
      const button = el('skin-fetch-models'); button.disabled = true;
      try {
        report(el('skin-provider-status'), '正在检索模型…');
        const result = await api('/api/providers/fetch-models', { method: 'POST', body: JSON.stringify({ providerId: el('skin-provider-edit').value, baseUrl: el('skin-provider-url').value.trim(), apiKey: el('skin-provider-key').value.trim() }) });
        el('skin-provider-models').value = [...new Set([...lines(el('skin-provider-models').value), ...result.models])].join('\n');
        el('skin-model-count').textContent = `${lines(el('skin-provider-models').value).length} 个模型`;
        report(el('skin-provider-status'), `检索到 ${result.models.length} 个模型；点击保存后即可在人格中选择。`);
      } catch (error) { report(el('skin-provider-status'), '检索失败：' + error.message + '；可以手动填写模型 ID 后保存。', true); }
      finally { button.disabled = false; }
    };
    el('skins-provider-form').onsubmit = async (event) => {
      event.preventDefault(); el('skin-provider-save').disabled = true;
      try {
        const result = await api('/api/providers', { method: 'POST', body: JSON.stringify({ baseUrl: el('skin-provider-url').value.trim(), apiKey: el('skin-provider-key').value.trim(), models: lines(el('skin-provider-models').value), activate: false }) });
        el('skin-provider-key').value = ''; await refreshCatalog();
        el('skin-provider-edit').value = result.provider.id; el('skin-provider-edit').onchange();
        report(el('skin-provider-status'), '提供商与模型已保存。现在可以在人格或总结设置中选择。');
      } catch (error) { report(el('skin-provider-status'), '保存失败：' + error.message, true); }
      finally { el('skin-provider-save').disabled = false; }
    };
    el('skins-preset-form').onsubmit = async (event) => {
      event.preventDefault();
      try {
        await api('/api/persona-templates', { method: 'POST', body: JSON.stringify({ name: el('skin-preset-name').value.trim(), text: el('skin-preset-text').value.trim(), behaviorProfile: el('skin-preset-profile').value }) });
        await refreshCatalog(); el('skins-preset-form').reset(); report(el('skin-preset-status'), '预设已保存，可以在上方选择。');
      } catch (error) { report(el('skin-preset-status'), '保存失败：' + error.message, true); }
    };
  } catch (error) { report(status, '加载失败：' + error.message + '。请先在主控制台登录，再刷新此页。', true); }
}

document.addEventListener('DOMContentLoaded', initSkinsPage);

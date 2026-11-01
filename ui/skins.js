import { api } from './core/api.js';
import { esc } from './core/dom.js';

export async function initSkinsPage() {
  if (!document.getElementById('skins-page')) return;
  const el = (id) => document.getElementById(id);
  const status = el('skin-status');
  const report = (node, message, error = false) => { node.textContent = message; node.classList.toggle('personas-error', error); };
  const lines = (value) => [...new Set(String(value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean))];
  const option = (value, label, selected) => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`;
  const modelIds = (p) => (p?.models || []).map((m) => typeof m === 'string' ? m : m.id).filter(Boolean);
  let data;
  let bindings = { chats: [] };
  let editing;
  let busy = false;
  // 把旧的鱼/猫快捷指令移入对应人格，保持原行为并允许在编辑框内修改。
  const editableSettings = (skins) => {
    const next = structuredClone(skins);
    for (const [command, id] of [['切鱼', 'fish'], ['切猫', 'cat']]) {
      const persona = next.list.find((s) => s.id === id);
      if (persona && next.switchCommands.includes(command) && (persona.commands || []).length < 10) {
        persona.commands = [...new Set([...(persona.commands || []), command])];
        next.switchCommands = next.switchCommands.filter((s) => s !== command);
      }
    }
    return next;
  };
  const providerOptions = (selected, auto = false) => option('', auto ? '自动选择（或全局 API）' : '全局 API', selected)
    + (selected && !data.providers.some((p) => p.id === selected) ? option(selected, `${selected}（未找到，请重新选择）`, selected) : '')
    + data.providers.map((p) => option(p.id, p.name, selected)).join('');
  const updateModels = (input, list, pid) => {
    const models = pid ? modelIds(data.providers.find((p) => p.id === pid)) : [data.globalApi.model, ...data.providers.flatMap(modelIds)];
    list.innerHTML = [...new Set([input.value, ...models].filter(Boolean))].map((m) => option(m, m, '')).join('');
  };
  const updateDefault = () => {
    const current = el('skins-default').value || data.skins.default;
    el('skins-default').innerHTML = data.skins.list.map((s) => option(s.id, s.label || s.id, current)).join('');
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
  const renderPersonas = () => {
    el('skins-list').innerHTML = data.skins.list.map((s) => `<article class="persona-card">
      <div class="section-title"><h3>${esc(s.label || s.id)}</h3><div class="personas-actions"><button type="button" class="btn" data-edit="${esc(s.id)}">编辑人格</button><button type="button" class="btn btn-small" data-remove="${esc(s.id)}" ${data.skins.list.length === 1 ? 'disabled' : ''}>移除</button></div></div>
      <dl><div><dt>预设</dt><dd>${esc(data.templates[s.templateId]?.name || s.templateId)}</dd></div><div><dt>模型</dt><dd>${esc(s.model || data.globalApi.model || '全局模型')}</dd></div><div><dt>切换指令</dt><dd>${s.commands?.length ? s.commands.map((c) => `<code>${esc(c)}</code>`).join(' ') : '未设置，点击编辑人格添加'}</dd></div></dl>
    </article>`).join('');
    for (const button of el('skins-list').querySelectorAll('[data-edit]')) button.onclick = () => openEditor(button.dataset.edit);
    for (const button of el('skins-list').querySelectorAll('[data-remove]')) button.onclick = async () => {
      if (busy || !confirm('移除这个人格的配置？已有存档与记忆会保留。')) return;
      busy = true; button.disabled = true;
      try {
        const next = structuredClone(data.skins); next.list = next.list.filter((s) => s.id !== button.dataset.remove);
        if (next.default === button.dataset.remove) next.default = next.list[0].id;
        await saveSettings(next); report(status, '人格已移除，已有存档与记忆保留。');
      } catch (error) { report(status, '移除失败：' + error.message, true); button.disabled = false; }
      finally { busy = false; }
    };
    el('skin-add').disabled = data.skins.list.length >= 16;
    updateDefault();
  };
  const saveSettings = async (skins) => {
    const result = await api('/api/skins', { method: 'POST', body: JSON.stringify({ skins }) });
    data.skins = editableSettings(result.skins); renderPersonas(); renderBindings();
  };
  const openEditor = (id) => {
    if (busy) return;
    editing = data.skins.list.find((s) => s.id === id);
    const preset = editing?.templateId || Object.keys(data.templates)[0];
    el('persona-form').reset();
    el('persona-title').textContent = editing ? '编辑人格' : '新增人格';
    el('persona-name').value = editing?.label || '';
    el('persona-preset').innerHTML = Object.entries(data.templates).map(([key, p]) => option(key, p.name, preset)).join('');
    const provider = editing?.provider || '';
    el('persona-provider').innerHTML = providerOptions(provider);
    el('persona-model').value = editing?.model || data.globalApi.model || 'deepseek-flash';
    updateModels(el('persona-model'), el('persona-model-options'), provider);
    el('persona-commands').value = (editing?.commands || []).join('\n');
    report(el('persona-error'), ''); el('persona-save').disabled = false;
    el('persona-dialog').showModal(); el('persona-name').focus();
  };
  try {
    data = await api('/api/skins'); data.skins = editableSettings(data.skins);
    const skins = data.skins;
    el('skins-enabled').checked = skins.enabled; el('skins-handoff').checked = skins.handoffOnSwitch.enabled;
    el('skins-ack').value = skins.ack; el('skins-prefixes').value = skins.switchCommands.join('\n');
    el('skins-summary-provider').innerHTML = providerOptions(skins.handoffOnSwitch.provider, true);
    el('skins-summary-model').value = skins.handoffOnSwitch.model || 'deepseek-flash';
    el('skins-summary-recent').value = skins.handoffOnSwitch.recentMessages; el('skins-summary-chars').value = skins.handoffOnSwitch.maxChars;
    el('skins-summary-provider').onchange = () => updateModels(el('skins-summary-model'), el('summary-model-options'), el('skins-summary-provider').value);
    updateModels(el('skins-summary-model'), el('summary-model-options'), skins.handoffOnSwitch.provider);
    renderPersonas(); report(status, skins.enabled ? '已启用多个人格' : '可以新增和编辑人格；启用多个人格后即可切换。');
    el('skin-add').onclick = () => openEditor();
    el('persona-provider').onchange = () => updateModels(el('persona-model'), el('persona-model-options'), el('persona-provider').value);
    el('persona-cancel').onclick = () => { if (!busy) el('persona-dialog').close(); };
    el('persona-dialog').oncancel = (event) => { if (busy) event.preventDefault(); };
    el('persona-form').onsubmit = async (event) => {
      event.preventDefault(); if (busy) return;
      const label = el('persona-name').value.trim();
      if (!label) { report(el('persona-error'), '请填写人格名称。', true); return; }
      if (!el('persona-model').value.trim()) { report(el('persona-error'), '请选择或填写模型。', true); return; }
      busy = true; el('persona-save').disabled = true;
      try {
        const next = structuredClone(data.skins);
        const persona = { ...editing, id: editing?.id || `persona_${Date.now().toString(36)}`, label, templateId: el('persona-preset').value, provider: el('persona-provider').value, model: el('persona-model').value.trim(), commands: lines(el('persona-commands').value), botName: !editing || editing.botName === editing.label ? label : editing.botName };
        if (editing) next.list = next.list.map((s) => s.id === editing.id ? persona : s);
        else next.list.push(persona);
        await saveSettings(next); el('persona-dialog').close();
        report(status, `${editing ? '人格修改已保存' : '新的人格已添加'}：${label}${data.skins.enabled ? '' : '。启用多个人格后即可切换。'}`);
      } catch (error) { report(el('persona-error'), '保存失败：' + error.message, true); }
      finally { busy = false; el('persona-save').disabled = false; }
    };
    el('skins-save').disabled = false;
    el('skins-form').onsubmit = async (event) => {
      event.preventDefault(); if (busy) return; busy = true; el('skins-save').disabled = true;
      try {
        await saveSettings({ ...data.skins, enabled: el('skins-enabled').checked, default: el('skins-default').value, ack: el('skins-ack').value, switchCommands: lines(el('skins-prefixes').value), handoffOnSwitch: { enabled: el('skins-handoff').checked, provider: el('skins-summary-provider').value, model: el('skins-summary-model').value.trim() || 'deepseek-flash', maxChars: Number(el('skins-summary-chars').value), recentMessages: Number(el('skins-summary-recent').value) } });
        report(status, '切换与总结设置已保存。');
      } catch (error) { report(status, '保存失败：' + error.message, true); }
      finally { busy = false; el('skins-save').disabled = false; }
    };
    try { bindings = await api('/api/chat-skins'); renderBindings(); }
    catch (error) { report(el('skin-switch-status'), '会话读取失败：' + error.message, true); }
  } catch (error) { report(status, '人格加载失败：' + error.message + '。请先在主控制台登录，再刷新此页。', true); }
}

document.addEventListener('DOMContentLoaded', initSkinsPage);

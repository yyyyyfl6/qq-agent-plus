// 人格页（/skins.html 与控制台侧栏「人格」共用；结构见 skins.html 文首）。
// 2026-11 交互重做：
//   · 总开关拨动即保存，只写 enabled（以前走整张表单提交：表单里任何一格校验不过，开关就"看着开了其实没存"）；
//   · 卡片上直接「设为默认」，并显示每个人格正被几个会话使用；
//   · 会话行：下拉框改了才亮「切换」按钮，筛选框按群号 / QQ 过滤；
//   · 交接设置收进「切换与交接设置」，有未保存改动时保存条才提示；
//   · 页内没有 #锚点（嵌在控制台里会改掉地址栏 hash）。
// 人物设定图（src/extensions/persona-refs.js）：每张卡的头像就是该人格的设定图，点头像或「设定图」上传 / 更换；
//   多人格没开时用的那一套（设置 → 人设）记在 default 名下，列表上方单独一块。生图画"自己"时带上这张图。
import { api } from './core/api.js';
import { esc } from './core/dom.js';

async function initSkinsPage() {
  if (!document.getElementById('skins-page')) return;
  const el = (id) => document.getElementById(id);
  const status = el('skin-status');
  const report = (node, message, error = false) => { if (!node) return; node.textContent = message; node.classList.toggle('personas-error', error); };
  const lines = (value) => [...new Set(String(value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean))];
  const option = (value, label, selected) => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`;
  const modelIds = (p) => (p?.models || []).map((m) => typeof m === 'string' ? m : m.id).filter(Boolean);
  const hue = (text) => [...String(text)].reduce((h, ch) => (h * 31 + ch.codePointAt(0)) % 360, 7);
  // 头像：有设定图就显示设定图，否则首字
  const avatar = (key, name, cls) => (refs[key]
    ? `<span class="${cls} has-ref"><img src="${esc(refs[key].url)}" alt="" loading="lazy"></span>`
    : `<span class="${cls}" aria-hidden="true">${esc([...name][0] || '?')}</span>`);
  const chatLabel = (key) => {
    const m = /^(group|private):(\d+)$/.exec(String(key));
    return m ? `${m[1] === 'group' ? '群' : '私聊'} ${m[2]}` : String(key);
  };
  let data;
  let refs = {};
  let refKey = '';
  let refImage = '';
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
    const current = data.skins.default;
    el('skins-default').innerHTML = data.skins.list.map((s) => option(s.id, s.label || s.id, current)).join('');
  };
  const paintMaster = () => {
    const on = el('skins-enabled').checked;
    document.getElementById('skins-page')?.classList.toggle('is-enabled', on);
    const label = el('skins-enabled-label');
    if (label) label.textContent = on ? '多人格已启用' : '多人格未启用';
  };
  const summaryLine = () => {
    const s = data.skins;
    const def = s.list.find((x) => x.id === s.default);
    return s.enabled
      ? `已启用 · 共 ${s.list.length} 个人格 · 没绑定过的会话用「${def?.label || s.default}」`
      : '多人格未启用：所有会话都用 设置 → 人设 里的那一套。可以先建好人格，再打开右上角开关。';
  };

  // ── 会话 ──
  const renderBindings = () => {
    const skins = data.skins;
    const q = String(el('skins-chat-filter')?.value || '').trim();
    const rows = bindings.chats.filter((c) => !q || String(c.chatKey).includes(q) || chatLabel(c.chatKey).includes(q));
    el('skins-chats').innerHTML = rows.length ? rows.map((c) => {
      const current = skins.list.find((s) => s.id === c.skinId);
      const name = current?.label || c.skinId || '默认';
      return `<div class="skin-row" data-chat="${esc(c.chatKey)}" data-current="${esc(c.skinId || '')}">
        ${avatar(c.skinId, name, 'skin-dot').replace('<span class="skin-dot', `<span style="--persona-hue:${hue(name)}" class="skin-dot`)}
        <div class="skin-row-name"><strong>${esc(chatLabel(c.chatKey))}</strong><span class="muted">正在用：${esc(name)}</span></div>
        <select aria-label="${esc(c.chatKey)} 的人格">${skins.list.map((s) => option(s.id, s.label, c.skinId)).join('')}</select>
        <button type="button" class="btn btn-small" ${skins.enabled ? '' : 'disabled'} title="${skins.enabled ? '' : '先打开右上角「多人格」开关'}">切换</button></div>`;
    }).join('') : `<p class="muted personas-empty">${bindings.chats.length ? '没有匹配的会话。' : '还没有会话。收到消息后会在这里出现。'}</p>`;
    for (const row of el('skins-chats').querySelectorAll('[data-chat]')) {
      const select = row.querySelector('select');
      const button = row.querySelector('button');
      select.onchange = () => row.classList.toggle('changed', select.value !== row.dataset.current);
      button.onclick = async () => {
        if (!confirm(`把 ${chatLabel(row.dataset.chat)} 切换到「${select.selectedOptions?.[0]?.textContent || select.value}」并结束当前线程？`)) return;
        button.disabled = true;
        try {
          report(el('skin-switch-status'), '正在切换；交接总结可能需要几秒…');
          const result = await api('/api/chat-skins', { method: 'POST', body: JSON.stringify({ chatKey: row.dataset.chat, skinId: select.value }) });
          report(el('skin-switch-status'), result.handoffError ? `人格已切换，交接总结失败：${result.handoffError}` : !result.changed ? '当前已使用这个人格。' : `人格已切换 · ${result.handoff ? '已生成交接总结' : result.handoffStatus === 'disabled' ? '交接总结已关闭' : result.handoffStatus === 'empty-response' ? '总结返回为空' : '没有最近对话可总结'}`, Boolean(result.handoffError));
          bindings = await api('/api/chat-skins'); renderBindings(); renderPersonas();
        } catch (error) { report(el('skin-switch-status'), '切换失败：' + error.message, true); button.disabled = false; }
      };
    }
  };

  // ── 人格卡片 ──
  const usage = (id) => bindings.chats.filter((c) => c.skinId === id).length;
  const renderPersonas = () => {
    const s = data.skins;
    el('skins-list').innerHTML = s.list.map((p) => {
      const name = p.label || p.id;
      const isDefault = p.id === s.default;
      const used = usage(p.id);
      const commands = p.commands?.length
        ? p.commands.map((c) => `<code class="persona-cmd">${esc(c)}</code>`).join('')
        : '<span class="muted">没有专属指令</span>';
      return `<article class="persona-card ${isDefault ? 'is-default' : ''}" style="--persona-hue:${hue(name)}">
        <header>
          <button type="button" class="persona-avatar-btn" data-ref="${esc(p.id)}" title="${refs[p.id] ? '更换设定图' : '上传设定图'}">${avatar(p.id, name, 'persona-avatar')}</button>
          <div class="persona-title"><h3>${esc(name)}</h3><span class="persona-id">${esc(p.id)}</span></div>
          <div class="persona-badges">${isDefault ? '<span class="persona-badge">默认</span>' : ''}${used ? `<span class="persona-badge soft">${used} 个会话</span>` : ''}</div>
        </header>
        <dl>
          <div><dt>角色卡</dt><dd>${esc(data.templates[p.templateId]?.name || p.templateId)}</dd></div>
          <div><dt>模型</dt><dd>${esc(p.model || data.globalApi.model || '全局模型')}</dd></div>
          <div><dt>设定图</dt><dd>${refs[p.id] ? (refs[p.id].hint ? esc(refs[p.id].hint) : '已上传') : '<span class="muted">没有（画自己时长相不固定）</span>'}</dd></div>
        </dl>
        <div class="persona-cmds">${commands}</div>
        <footer class="personas-actions">
          <button type="button" class="btn btn-small" data-edit="${esc(p.id)}">编辑</button>
          <button type="button" class="btn btn-small" data-ref="${esc(p.id)}">设定图</button>
          ${isDefault ? '' : `<button type="button" class="btn btn-small" data-default="${esc(p.id)}">设为默认</button>`}
          <span class="spacer"></span>
          <button type="button" class="btn btn-small btn-ghost-danger" data-remove="${esc(p.id)}" ${s.list.length === 1 ? 'disabled' : ''}>移除</button>
        </footer>
      </article>`;
    }).join('');
    const count = el('skins-count');
    if (count) count.textContent = `${s.list.length} / 16`;
    renderSoloRef();
    for (const button of el('skins-list').querySelectorAll('[data-edit]')) button.onclick = () => openEditor(button.dataset.edit);
    for (const button of el('skins-list').querySelectorAll('[data-ref]')) button.onclick = () => openRef(button.dataset.ref);
    for (const button of el('skins-list').querySelectorAll('[data-default]')) button.onclick = async () => {
      if (busy) return;
      busy = true; button.disabled = true;
      try {
        await saveSettings({ ...data.skins, default: button.dataset.default });
        report(status, `默认人格改为「${data.skins.list.find((x) => x.id === data.skins.default)?.label || data.skins.default}」`);
      } catch (error) { report(status, '保存失败：' + error.message, true); button.disabled = false; }
      finally { busy = false; }
    };
    for (const button of el('skins-list').querySelectorAll('[data-remove]')) button.onclick = async () => {
      if (busy || !confirm('移除这个人格的配置？已有存档与记忆会保留。')) return;
      busy = true; button.disabled = true;
      try {
        const next = structuredClone(data.skins); next.list = next.list.filter((x) => x.id !== button.dataset.remove);
        if (next.default === button.dataset.remove) next.default = next.list[0].id;
        await saveSettings(next); report(status, '人格已移除，已有存档与记忆保留。');
      } catch (error) { report(status, '移除失败：' + error.message, true); button.disabled = false; }
      finally { busy = false; }
    };
    el('skin-add').disabled = s.list.length >= 16;
    updateDefault();
  };
  // ── 人物设定图 ──
  const renderSoloRef = () => {
    const box = el('skins-default-ref');
    if (!box) return;
    const name = data.persona?.botName || '单人格';
    box.innerHTML = `<button type="button" class="persona-avatar-btn" data-ref="default" title="${refs.default ? '更换设定图' : '上传设定图'}">${avatar('default', name, 'persona-avatar')}</button>
      <div class="persona-solo-copy"><strong>多人格未启用时：${esc(name)}</strong><span class="muted">设置 → 人设 里那一套的设定图${refs.default ? (refs.default.hint ? `：${esc(refs.default.hint)}` : '（已上传）') : '（还没有）'}</span></div>
      <button type="button" class="btn btn-small" data-ref="default">设定图</button>`;
    box.classList.toggle('is-active', !data.skins.enabled);
    for (const button of box.querySelectorAll('[data-ref]')) button.onclick = () => openRef('default');
  };
  const refName = (key) => (key === 'default' ? (data.persona?.botName || '单人格') : (data.skins.list.find((x) => x.id === key)?.label || key));
  const showPreview = (src) => {
    el('persona-ref-preview').hidden = !src;
    if (src) el('persona-ref-preview').src = src; else el('persona-ref-preview').removeAttribute('src');
    el('persona-ref-empty').textContent = src ? '' : '点击选择设定图';
  };
  const openRef = (key) => {
    if (busy) return;
    refKey = key; refImage = '';
    el('persona-ref-form').reset();
    el('persona-ref-title').textContent = `「${refName(key)}」的人物设定图`;
    el('persona-ref-hint').value = refs[key]?.hint || '';
    showPreview(refs[key]?.url || '');
    el('persona-ref-remove').hidden = !refs[key];
    report(el('persona-ref-error'), '');
    el('persona-ref-dialog').showModal();
  };
  // 超过 3.5MB 或边长 > 2048 才压一下（设定图要清楚，尽量不动原图）
  const readImage = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读不了这张图'));
    reader.onload = () => {
      const url = String(reader.result || '');
      const img = new Image();
      img.onerror = () => reject(new Error('不是能识别的图片'));
      img.onload = () => {
        if (file.size <= 3.5 * 1024 * 1024 && Math.max(img.width, img.height) <= 2048) { resolve(url); return; }
        const scale = Math.min(1, 2048 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.9));
      };
      img.src = url;
    };
    reader.readAsDataURL(file);
  });
  const loadRefs = async () => {
    try { refs = (await api('/api/persona-refs')).refs || {}; } catch { refs = {}; }
  };
  const saveSettings = async (skins) => {
    const result = await api('/api/skins', { method: 'POST', body: JSON.stringify({ skins }) });
    data.skins = editableSettings(result.skins);
    el('skins-enabled').checked = data.skins.enabled;
    paintMaster(); renderPersonas(); renderBindings();
  };
  const openEditor = (id) => {
    if (busy) return;
    editing = data.skins.list.find((s) => s.id === id);
    const preset = editing?.templateId || Object.keys(data.templates)[0];
    el('persona-form').reset();
    el('persona-title').textContent = editing ? `编辑「${editing.label || editing.id}」` : '新增人格';
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
    await loadRefs();
    paintMaster(); renderPersonas(); report(status, summaryLine());
    el('skin-add').onclick = () => openEditor();
    el('persona-ref-file').onchange = async () => {
      const file = el('persona-ref-file').files?.[0];
      if (!file) return;
      try { refImage = await readImage(file); showPreview(refImage); report(el('persona-ref-error'), ''); }
      catch (error) { report(el('persona-ref-error'), error.message, true); }
    };
    el('persona-ref-cancel').onclick = () => { if (!busy) el('persona-ref-dialog').close(); };
    el('persona-ref-dialog').oncancel = (event) => { if (busy) event.preventDefault(); };
    el('persona-ref-dialog').onclick = (event) => { if (event.target === el('persona-ref-dialog') && !busy) el('persona-ref-dialog').close(); };
    el('persona-ref-remove').onclick = async () => {
      if (busy || !confirm(`移除「${refName(refKey)}」的设定图？之后画它自己时长相就不固定了。`)) return;
      busy = true;
      try {
        await api(`/api/persona-refs/${encodeURIComponent(refKey)}`, { method: 'DELETE' });
        await loadRefs(); renderPersonas(); renderBindings();
        el('persona-ref-dialog').close(); report(status, `已移除「${refName(refKey)}」的设定图`);
      } catch (error) { report(el('persona-ref-error'), '移除失败：' + error.message, true); }
      finally { busy = false; }
    };
    el('persona-ref-form').onsubmit = async (event) => {
      event.preventDefault(); if (busy) return;
      if (!refImage && !refs[refKey]) { report(el('persona-ref-error'), '先选一张图。', true); return; }
      busy = true; el('persona-ref-save').disabled = true;
      try {
        await api(`/api/persona-refs/${encodeURIComponent(refKey)}`, { method: 'POST', body: JSON.stringify({ ...(refImage ? { image: refImage } : {}), hint: el('persona-ref-hint').value.trim() }) });
        await loadRefs(); renderPersonas(); renderBindings();
        el('persona-ref-dialog').close(); report(status, `「${refName(refKey)}」的设定图已保存，画它自己时会带上`);
      } catch (error) { report(el('persona-ref-error'), '保存失败：' + error.message, true); }
      finally { busy = false; el('persona-ref-save').disabled = false; }
    };
    el('persona-provider').onchange = () => updateModels(el('persona-model'), el('persona-model-options'), el('persona-provider').value);
    el('persona-cancel').onclick = () => { if (!busy) el('persona-dialog').close(); };
    el('persona-dialog').oncancel = (event) => { if (busy) event.preventDefault(); };
    // 点对话框外面（backdrop）关闭；表单内部的点击不受影响
    el('persona-dialog').onclick = (event) => { if (event.target === el('persona-dialog') && !busy) el('persona-dialog').close(); };
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
        report(status, `${editing ? '人格修改已保存' : '新的人格已添加'}：${label}${data.skins.enabled ? '' : '。打开右上角「多人格」开关后即可切换。'}`);
      } catch (error) { report(el('persona-error'), '保存失败：' + error.message, true); }
      finally { busy = false; el('persona-save').disabled = false; }
    };
    el('skins-save').disabled = false;
    // 总开关：只写 enabled，拨动即存；失败就拨回去
    el('skins-enabled').onchange = async () => {
      const want = el('skins-enabled').checked;
      paintMaster();
      if (busy) return;
      busy = true;
      try {
        await saveSettings({ ...data.skins, enabled: want });
        report(status, summaryLine());
      } catch (error) {
        el('skins-enabled').checked = !want; paintMaster();
        report(status, '开关没保存上：' + error.message, true);
      } finally { busy = false; }
    };
    const dirty = el('skins-dirty');
    el('skins-form').oninput = () => { if (dirty) { dirty.textContent = '有未保存改动'; dirty.classList.add('is-dirty'); } };
    el('skins-form').onchange = el('skins-form').oninput;
    el('skins-form').onsubmit = async (event) => {
      event.preventDefault(); if (busy) return; busy = true; el('skins-save').disabled = true;
      try {
        await saveSettings({ ...data.skins, default: el('skins-default').value, ack: el('skins-ack').value, switchCommands: lines(el('skins-prefixes').value), handoffOnSwitch: { enabled: el('skins-handoff').checked, provider: el('skins-summary-provider').value, model: el('skins-summary-model').value.trim() || 'deepseek-flash', maxChars: Number(el('skins-summary-chars').value) || 1200, recentMessages: Number(el('skins-summary-recent').value) || 40 } });
        report(status, '设置已保存 · ' + summaryLine());
        if (dirty) { dirty.textContent = '已保存'; dirty.classList.remove('is-dirty'); }
      } catch (error) { report(status, '保存失败：' + error.message, true); }
      finally { busy = false; el('skins-save').disabled = false; }
    };
    if (el('skins-chat-filter')) el('skins-chat-filter').oninput = renderBindings;
    try { bindings = await api('/api/chat-skins'); renderBindings(); renderPersonas(); }
    catch (error) { report(el('skin-switch-status'), '会话读取失败：' + error.message, true); }
  } catch (error) { report(status, '人格加载失败：' + error.message + '。请先在主控制台登录，再刷新此页。', true); }
}

document.addEventListener('DOMContentLoaded', initSkinsPage);

export { initSkinsPage };

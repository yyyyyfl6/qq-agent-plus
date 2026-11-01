'use strict';

// 设置 → 模型 API 的「模型供应商」面板（2026-11 用户要求"像 AstrBot 那样：添加供应商 → 选模型"）：
//   左：已添加的供应商（名字 / 主机 / 模型数 / Key 状态 / 使用中）；右：选中那家的模型，点「使用」即切换。
//   「＋ 添加供应商」：选类型（服务预设）→ 填地址与 Key（Vertex 粘服务账号 JSON）→ 拉模型并勾选 → 添加。
// 全部走已有的 /api/providers* 端点（Key 只往服务端写、不回显）；原来那套手动表单收进「高级：手动编辑当前连接」，
// 所有控件 id 原样保留（保存逻辑与测试都按 id 找）。
// 挂法：QARegistry.onAfter('renderSettings')，只在 api 分区生效，幂等。

import { loadSettings } from './app.js';
import { api } from './core/api.js';
import { MODEL_SERVICES_UI } from './core/constants.js';
import { askForConfirmation } from './core/dom-util.js';
import { esc } from './core/dom.js';
import { QARegistry } from './core/registry.js';
import { state } from './core/state.js';

(function providerManager() {
  const ui = { selected: '', fetched: null, fetchedFor: '', busy: '', note: '' };
  const hostOf = (u) => { try { return new URL(String(u || '').replace(/\{[^}]+\}/g, 'x')).host; } catch { return ''; } };
  const presetOf = (p) => MODEL_SERVICES_UI.find((s) => s.id === p.preset)
    || MODEL_SERVICES_UI.find((s) => (s.hosts || []).includes(hostOf(p.baseURL))) || null;
  const hue = (text) => { let h = 0; for (const ch of String(text)) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
  const initial = (name) => String(name || '?').replace(/^https?:\/\//, '').trim().charAt(0).toUpperCase() || '?';

  function providers() { return state.providers || []; }
  function current() { return { pid: state.config?.api?.provider || '', model: state.config?.api?.model || '' }; }

  function listHtml() {
    const cur = current();
    const list = providers();
    if (!list.length) return '<div class="pm-empty">还没有供应商。点右上角「添加供应商」开始。</div>';
    return list.map((p) => {
      const preset = presetOf(p);
      const name = p.displayName || hostOf(p.baseURL) || p.id;
      return `<button type="button" class="pm-item ${p.id === ui.selected ? 'on' : ''}" data-pid="${esc(p.id)}">
        <span class="pm-avatar" style="--pm-hue:${hue(name)}">${esc(initial(preset?.label || name))}</span>
        <span class="pm-item-text"><b>${esc(name)}</b><i>${esc(preset?.label || hostOf(p.baseURL) || '自定义')} · ${p.models?.length || 0} 个模型</i></span>
        ${p.id === cur.pid ? '<em class="pm-badge">使用中</em>' : (p.hasKey ? '' : '<em class="pm-badge warn">无 Key</em>')}
      </button>`;
    }).join('');
  }

  function detailHtml() {
    const p = providers().find((x) => x.id === ui.selected);
    if (!p) return '<div class="pm-empty">选择左边的一家查看它的模型。</div>';
    const cur = current();
    const names = p.modelNames || {};
    const preset = presetOf(p);
    const fetched = ui.fetchedFor === p.id && Array.isArray(ui.fetched) ? ui.fetched.filter((m) => !(p.models || []).includes(m)) : null;
    return `
      <div class="pm-detail-head">
        <div class="pm-detail-title">
          <h4><span class="pm-name" data-rename title="点击改名">${esc(p.displayName || p.id)}</span>${p.id === cur.pid ? '<em class="pm-badge">使用中</em>' : ''}</h4>
          <div class="pm-meta"><code>${esc(p.baseURL || '')}</code><span>${p.hasKey ? '已保存 Key' : '未保存 Key'}</span>${preset ? `<span>${esc(preset.label)}</span>` : ''}</div>
        </div>
        <div class="pm-actions">
          <button type="button" class="btn btn-small" data-act="test">测试</button>
          <button type="button" class="btn btn-small" data-act="key">${p.hasKey ? '更换 Key' : '填 Key'}</button>
          <button type="button" class="btn btn-small btn-ghost-danger" data-act="remove" ${p.id === cur.pid ? 'disabled title="正在使用中，先切到别家"' : ''}>删除</button>
        </div>
      </div>
      <div class="pm-keyrow" hidden>
        ${preset?.keyKind === 'service-account'
          ? '<textarea class="pm-key-input" rows="4" placeholder="粘贴整份服务账号 JSON"></textarea>'
          : '<input type="password" class="pm-key-input" placeholder="新的 API Key" autocomplete="new-password" />'}
        <button type="button" class="btn btn-small btn-primary" data-act="key-save">保存 Key</button>
      </div>
      ${ui.note ? `<div class="pm-note">${esc(ui.note)}</div>` : ''}
      <div class="pm-models">
        ${(p.models || []).map((m) => {
          const active = p.id === cur.pid && m === cur.model;
          return `<div class="pm-model ${active ? 'on' : ''}">
            <span class="pm-model-text"><b>${esc(names[m] || m)}</b>${names[m] && names[m] !== m ? `<i>${esc(m)}</i>` : ''}</span>
            ${active ? '<em class="pm-badge">当前模型</em>' : `<button type="button" class="btn btn-small" data-use="${esc(m)}">使用</button>`}
            <button type="button" class="pm-x" data-drop="${esc(m)}" aria-label="移除 ${esc(m)}" ${active ? 'disabled' : ''}>✕</button>
          </div>`;
        }).join('') || '<div class="pm-empty">这家还没有模型：点下面「从服务商拉取」，或手动填模型 id。</div>'}
      </div>
      <div class="pm-add-models">
        <button type="button" class="btn btn-small" data-act="fetch" ${ui.busy === 'fetch' ? 'disabled' : ''}>${ui.busy === 'fetch' ? '拉取中…' : '从服务商拉取模型'}</button>
        <input type="text" class="pm-manual" placeholder="或手动填模型 id，回车添加" />
      </div>
      ${fetched ? `<div class="pm-fetched">
        <div class="pm-fetched-head"><input type="search" class="pm-filter" placeholder="筛选 ${fetched.length} 个可添加的模型…" />
          <button type="button" class="btn btn-small btn-primary" data-act="add-picked">添加选中</button></div>
        <div class="pm-chips">${fetched.map((m) => `<label class="pm-chip"><input type="checkbox" value="${esc(m)}" /><span>${esc(m)}</span></label>`).join('') || '<span class="muted">服务商列出的模型都已经加过了。</span>'}</div>
      </div>` : ''}`;
  }

  function panelHtml() {
    return `
      <div class="pm-head">
        <div><h3 id="settings-providers">模型供应商</h3>
          <p class="hint">先添加供应商（选类型 → 填 Key → 勾模型），再在右边点「使用」切换当前模型。Key 只存在服务器上，这里不回显。</p></div>
        <button type="button" class="btn btn-primary" id="pm-add">＋ 添加供应商</button>
      </div>
      <div class="pm-body">
        <nav class="pm-list" aria-label="供应商">${listHtml()}</nav>
        <div class="pm-detail">${detailHtml()}</div>
      </div>`;
  }

  async function refresh(note = '') {
    ui.note = note;
    await loadSettings();
  }

  async function act(name, el) {
    const p = providers().find((x) => x.id === ui.selected);
    const panel = document.getElementById('provider-manager');
    if (!p || !panel) return;
    try {
      if (name === 'test') {
        el.disabled = true; el.textContent = '测试中…';
        const r = await api('/api/providers/test-one', { method: 'POST', body: JSON.stringify({ providerId: p.id }) });
        ui.note = r.result?.ok ? `✓ 连通：${r.result.note || ''}（${r.result.latencyMs || 0} ms）` : `✗ ${r.result?.note || '不通'}`;
        repaint();
      } else if (name === 'key') {
        const row = panel.querySelector('.pm-keyrow');
        row.hidden = !row.hidden;
        if (!row.hidden) row.querySelector('.pm-key-input')?.focus();
      } else if (name === 'key-save') {
        const v = panel.querySelector('.pm-key-input')?.value.trim() || '';
        if (!v) return;
        await api('/api/providers/set-key', { method: 'POST', body: JSON.stringify({ providerId: p.id, apiKey: v }) });
        await refresh('Key 已保存');
      } else if (name === 'remove') {
        if (!await askForConfirmation(`删除供应商「${p.displayName || p.id}」？它的模型列表和保存的 Key 会一起删掉。`)) return;
        await api('/api/providers', { method: 'DELETE', body: JSON.stringify({ providerId: p.id, confirm: true }) });
        ui.selected = '';
        await refresh();
      } else if (name === 'fetch') {
        ui.busy = 'fetch'; repaint();
        try {
          const r = await api('/api/providers/fetch-models', { method: 'POST', body: JSON.stringify({ providerId: p.id, baseUrl: p.baseURL }) });
          ui.fetched = r.models || []; ui.fetchedFor = p.id;
          ui.note = r.ok === false ? `拉取失败：${r.error || ''}` : '';
        } finally { ui.busy = ''; repaint(); }
      } else if (name === 'add-picked') {
        const picked = [...panel.querySelectorAll('.pm-chip input:checked')].map((i) => i.value);
        if (!picked.length) return;
        await api('/api/providers/models', { method: 'POST', body: JSON.stringify({ providerId: p.id, models: picked }) });
        ui.fetched = null;
        await refresh(`已添加 ${picked.length} 个模型`);
      }
    } catch (error) {
      ui.note = `${error.message}`;
      ui.busy = '';
      repaint();
    }
  }

  async function useModel(model) {
    const p = providers().find((x) => x.id === ui.selected);
    if (!p) return;
    // 与「当前模型」弹窗同一个写法：只改 provider/model/baseUrl，Key 不经过前端
    await api('/api/config', { method: 'POST', body: JSON.stringify({ api: { provider: p.id, model, baseUrl: p.baseURL } }) });
    await refresh(`已切换到 ${model}`);
  }

  function bindPanel(panel) {
    panel.querySelector('#pm-add')?.addEventListener('click', openAddDialog);
    panel.querySelectorAll('.pm-item').forEach((el) => el.addEventListener('click', () => {
      ui.selected = el.dataset.pid; ui.note = ''; ui.fetched = null; repaint();
    }));
    panel.querySelectorAll('[data-act]').forEach((el) => el.addEventListener('click', () => act(el.dataset.act, el)));
    panel.querySelectorAll('[data-use]').forEach((el) => el.addEventListener('click', () => useModel(el.dataset.use).catch((e) => { ui.note = e.message; repaint(); })));
    panel.querySelectorAll('[data-drop]').forEach((el) => el.addEventListener('click', async () => {
      if (!await askForConfirmation(`从这家移除模型 ${el.dataset.drop}？`)) return;
      await api('/api/providers/models', { method: 'DELETE', body: JSON.stringify({ providerId: ui.selected, modelId: el.dataset.drop }) }).catch((e) => { ui.note = e.message; });
      await refresh();
    }));
    panel.querySelector('.pm-manual')?.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const ids = e.target.value.split(/[\s,，]+/).map((s) => s.trim()).filter(Boolean);
      if (!ids.length) return;
      await api('/api/providers/models', { method: 'POST', body: JSON.stringify({ providerId: ui.selected, models: ids }) }).catch((err) => { ui.note = err.message; });
      await refresh(`已添加 ${ids.join('、')}`);
    });
    panel.querySelector('.pm-filter')?.addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      panel.querySelectorAll('.pm-chip').forEach((chip) => { chip.hidden = Boolean(q) && !chip.textContent.toLowerCase().includes(q); });
    });
    panel.querySelector('[data-rename]')?.addEventListener('click', async (e) => {
      const el = e.currentTarget;
      const input = document.createElement('input');
      input.type = 'text'; input.value = el.textContent; input.maxLength = 40; input.className = 'pm-rename';
      el.replaceWith(input); input.focus(); input.select();
      const done = async (save) => {
        if (save && input.value.trim() && input.value.trim() !== el.textContent) {
          await api('/api/providers/rename', { method: 'POST', body: JSON.stringify({ providerId: ui.selected, displayName: input.value.trim() }) }).catch(() => {});
          await refresh();
        } else repaint();
      };
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') done(true); if (ev.key === 'Escape') done(false); });
      input.addEventListener('blur', () => done(true), { once: true });
    });
  }

  function repaint() {
    const panel = document.getElementById('provider-manager');
    if (!panel) return;
    panel.innerHTML = panelHtml();
    bindPanel(panel);
  }

  // ── 添加供应商（两步） ──
  function openAddDialog() {
    document.getElementById('pm-dialog')?.remove();
    const dlg = document.createElement('dialog');
    dlg.id = 'pm-dialog';
    dlg.className = 'pm-dialog';
    document.body.appendChild(dlg);
    const draft = { preset: null, models: [], fetched: [] };
    const step1 = () => {
      dlg.innerHTML = `
        <form method="dialog" class="pm-dlg">
          <header><h3>添加供应商</h3><p class="hint">选一家（选不到就选最后的「自定义」，任何 OpenAI 兼容服务都行）。</p></header>
          <div class="pm-types">${MODEL_SERVICES_UI.map((s) => `
            <button type="button" class="pm-type" data-type="${esc(s.id)}">
              <span class="pm-avatar" style="--pm-hue:${hue(s.label)}">${esc(initial(s.label))}</span>
              <span><b>${esc(s.label)}</b><i>${esc(s.hosts?.[0] || '自己填地址')}</i></span>
            </button>`).join('')}</div>
          <footer><button type="button" class="btn" data-close>取消</button></footer>
        </form>`;
      dlg.querySelector('[data-close]').addEventListener('click', () => dlg.close());
      dlg.querySelectorAll('[data-type]').forEach((b) => b.addEventListener('click', () => {
        draft.preset = MODEL_SERVICES_UI.find((s) => s.id === b.dataset.type);
        step2();
      }));
    };
    const step2 = () => {
      const s = draft.preset;
      const sa = s.keyKind === 'service-account';
      dlg.innerHTML = `
        <form method="dialog" class="pm-dlg">
          <header><button type="button" class="pm-back" data-back>← 换一家</button><h3>${esc(s.label)}</h3>${s.note ? `<p class="hint">${esc(s.note)}</p>` : ''}</header>
          <div class="field"><label>名称（可选）</label><input type="text" id="pm-new-name" maxlength="40" placeholder="${esc(s.label)}" /></div>
          <div class="field"><label>服务地址</label><input type="text" id="pm-new-base" value="${esc(s.baseUrl || '')}" placeholder="https://…/v1" /></div>
          <div class="field"><label>${sa ? '服务账号 JSON' : 'API Key'}</label>
            ${sa ? '<textarea id="pm-new-key" rows="5" placeholder=\'{"type": "service_account", "project_id": …}\'></textarea>'
              : '<input type="password" id="pm-new-key" autocomplete="new-password" placeholder="sk-…" />'}</div>
          <div class="pm-dlg-models">
            <div class="pm-fetched-head"><button type="button" class="btn btn-small" id="pm-new-fetch">获取模型列表</button>
              <input type="search" class="pm-filter" id="pm-new-filter" placeholder="筛选…" hidden /></div>
            <div class="pm-chips" id="pm-new-chips"></div>
            <div class="field"><label>手动添加模型 id（逗号或换行分隔；拉不到列表时用）</label><input type="text" id="pm-new-manual" placeholder="如 deepseek-chat, google/gemini-2.5-flash" /></div>
          </div>
          <label class="cmp-check"><input type="checkbox" id="pm-new-activate" checked /><span>添加后立即使用第一个模型</span></label>
          <div class="pm-note" id="pm-new-note"></div>
          <footer><button type="button" class="btn" data-close>取消</button><button type="button" class="btn btn-primary" id="pm-new-save">添加供应商</button></footer>
        </form>`;
      const note = (t) => { dlg.querySelector('#pm-new-note').textContent = t; };
      dlg.querySelector('[data-close]').addEventListener('click', () => dlg.close());
      dlg.querySelector('[data-back]').addEventListener('click', step1);
      dlg.querySelector('#pm-new-fetch').addEventListener('click', async (e) => {
        const baseUrl = dlg.querySelector('#pm-new-base').value.trim();
        if (!baseUrl) return note('先填服务地址');
        e.target.disabled = true; e.target.textContent = '拉取中…'; note('');
        try {
          const r = await api('/api/providers/fetch-models', { method: 'POST', body: JSON.stringify({ baseUrl, apiKey: dlg.querySelector('#pm-new-key').value.trim() }) });
          if (r.ok === false) throw new Error(r.error || '拉取失败');
          draft.fetched = r.models || [];
          dlg.querySelector('#pm-new-chips').innerHTML = draft.fetched.map((m) => `<label class="pm-chip"><input type="checkbox" value="${esc(m)}" /><span>${esc(m)}</span></label>`).join('') || '<span class="muted">这家没有返回模型列表，用下面手动添加。</span>';
          dlg.querySelector('#pm-new-filter').hidden = draft.fetched.length < 8;
          note(draft.fetched.length ? `拉到 ${draft.fetched.length} 个模型，勾选要用的。` : '');
        } catch (error) {
          note(`${error.message}（有的服务要先填对 Key 才给列模型；拉不到就手动填）`);
        } finally { e.target.disabled = false; e.target.textContent = '获取模型列表'; }
      });
      dlg.querySelector('#pm-new-filter').addEventListener('input', (e) => {
        const q = e.target.value.trim().toLowerCase();
        dlg.querySelectorAll('#pm-new-chips .pm-chip').forEach((chip) => { chip.hidden = Boolean(q) && !chip.textContent.toLowerCase().includes(q); });
      });
      dlg.querySelector('#pm-new-save').addEventListener('click', async (e) => {
        const baseUrl = dlg.querySelector('#pm-new-base').value.trim();
        const picked = [...dlg.querySelectorAll('#pm-new-chips input:checked')].map((i) => i.value);
        const manual = dlg.querySelector('#pm-new-manual').value.split(/[\s,，]+/).map((x) => x.trim()).filter(Boolean);
        const models = [...new Set([...picked, ...manual])];
        if (!baseUrl) return note('服务地址不能为空');
        if (!models.length) return note('至少选或填一个模型');
        e.target.disabled = true;
        try {
          const r = await api('/api/providers', {
            method: 'POST',
            body: JSON.stringify({
              baseUrl, apiKey: dlg.querySelector('#pm-new-key').value.trim(), models, preset: s.id === 'custom' ? '' : s.id,
              displayName: dlg.querySelector('#pm-new-name').value.trim(), activate: dlg.querySelector('#pm-new-activate').checked
            })
          });
          if (r.ok === false) throw new Error(r.error || '添加失败');
          ui.selected = r.provider?.id || '';
          dlg.close();
          await refresh(r.created === false ? '这个地址已经有了，已把模型合并进去' : '已添加');
        } catch (error) { note(error.message); e.target.disabled = false; }
      });
    };
    dlg.addEventListener('close', () => dlg.remove());
    step1();
    dlg.showModal?.();
  }

  // ── 挂进设置页 ──
  /** 把原来的连接表单（当前模型 … 操作提示）收进「高级：手动编辑当前连接」。 */
  function foldLegacy(form) {
    const pick = form.querySelector('#cfg-model-pick');
    const hint = form.querySelector('#provider-action-hint');
    const first = pick?.closest('.field');
    if (!first || !hint || first.parentElement !== hint.parentElement) return;
    const details = document.createElement('details');
    details.className = 'collapsible settings-advanced pm-legacy';
    details.innerHTML = '<summary>高级：手动编辑当前连接（地址 / Key / 模型 id）</summary>';
    const box = document.createElement('div');
    box.style.paddingTop = '8px';
    details.appendChild(box);
    first.before(details);
    let node = first;
    while (node) {
      const next = node.nextElementSibling;
      box.appendChild(node);
      if (node === hint) break;
      node = next;
    }
    const h3 = form.querySelector('#settings-api');
    if (h3) h3.textContent = '生成参数';
  }

  function mount() {
    if ((state.settingsSection || 'api') !== 'api' || String(state.settingsQuery || '').trim()) return;
    const form = document.getElementById('settings-form');
    if (!form || form.querySelector('#provider-manager')) return;
    const list = providers();
    if (!list.some((p) => p.id === ui.selected)) ui.selected = current().pid && list.some((p) => p.id === current().pid) ? current().pid : (list[0]?.id || '');
    const panel = document.createElement('section');
    panel.className = 'settings-card pm';
    panel.id = 'provider-manager';
    const firstCard = form.querySelector('.settings-card');
    if (firstCard) firstCard.before(panel); else form.prepend(panel);
    foldLegacy(form);
    repaint();
  }

  QARegistry.onAfter('renderSettings', mount);
})();

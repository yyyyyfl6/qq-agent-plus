'use strict';

// 人格工作台（2026-11 完善人格界面）：挂在「设置 → 人设」上的一层增强，不改 pages/persona.js 的既有实现。
//   · 侧栏「人格」入口：一键直达人设页（原来要 设置 → 往下找 → 人设）
//   · 卡库搜索、分节大纲（点一下跳到那一节并展开）、字数与 token 粗估
//   · 试聊：用**草稿里的**卡（没保存也行）跟它聊几句，看口吻对不对 —— 不发到 QQ、不进记忆
//   · AI 起草：一句话设定 → 按内置卡的分节格式写一张新卡，可填入草稿或另存为自定义卡
//   · 导入 / 导出 .md；把改过的草稿覆盖保存回当前自定义卡（以前只能新建/删除）
// 走 QARegistry.onAfter('renderSettings')：设置页每次整页重画后再把这些控件装回去。

import { closeModelModal, loadSettings, modelModalShell } from './app.js';
import { api } from './core/api.js';
import { $, esc } from './core/dom.js';
import { QARegistry } from './core/registry.js';
import { state } from './core/state.js';
import { applyPersonaDraft, parsePersonaCard } from './pages/persona.js';

(function personaStudio() {
  const studio = { chat: [], busy: false, lastCustomId: '', query: '', outlineTimer: null };
  const QUICK = ['在吗', '你是 AI 吗', '推荐个最近好看的番', '你好烦啊', '帮我看看这个报错：ECONNREFUSED', '今晚吃啥'];

  function draft() {
    return {
      roleText: $('#cfg-roletext')?.value ?? '',
      customRules: $('#cfg-customrules')?.value ?? '',
      behaviorProfile: $('#cfg-behavior-profile')?.value || 'legacy',
      botName: $('#cfg-botname')?.value || ''
    };
  }

  // ── 侧栏「人格」入口 ───────────────────────────────────────────
  function syncNavHighlight() {
    const onPersona = state.tab === 'settings' && state.settingsSection === 'persona';
    document.querySelectorAll('.tab[data-settings-jump="persona"]').forEach((b) => b.classList.toggle('active', onPersona));
    document.querySelectorAll('.tab[data-tab="settings"]:not([data-settings-jump])').forEach((b) => {
      b.classList.toggle('active', state.tab === 'settings' && !onPersona);
    });
  }

  document.querySelectorAll('.tab[data-settings-jump]').forEach((btn) => {
    btn.addEventListener('click', () => {
      // app.js 的 switchTab('settings') 先跑（它的监听先注册），loadSettings 是异步的：
      // 这里同步改分区，等它真正渲染时读到的就是人设页
      state.settingsSection = btn.dataset.settingsJump;
      syncNavHighlight();
    });
  });
  document.querySelectorAll('.tab[data-tab="settings"]:not([data-settings-jump])').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (state.settingsSection === 'persona') state.settingsSection = 'api';
    });
  });

  // ── 大纲 / 统计 ───────────────────────────────────────────────
  function outlineHtml() {
    const text = draft().roleText;
    const card = parsePersonaCard(text);
    const chars = text.replace(/\s/g, '').length;
    const tokens = Math.round(text.length / 1.6);
    const chips = card.sections.map((s, i) => `<button type="button" class="ps-outline-chip" data-jump="${i}">${esc(s.num || String(i + 1))} ${esc(s.name.replace(/（.*?）/g, '').slice(0, 14))}</button>`).join('');
    return `
      <div class="ps-outline">${chips || '<span class="muted">（正文没有分节）</span>'}</div>
      <div class="ps-stats muted">${card.sections.length} 节 · ${chars} 字 · 约 ${tokens} tokens（粗估，每轮都会进系统提示）</div>`;
  }

  function refreshOutline() {
    const box = $('#ps-outline-box');
    if (box) box.innerHTML = outlineHtml();
  }

  function scheduleOutline() {
    clearTimeout(studio.outlineTimer);
    studio.outlineTimer = setTimeout(() => { refreshOutline(); applyLibraryFilter(); updateSaveCustomButton(); }, 200);
  }

  function applyLibraryFilter() {
    const q = studio.query.trim().toLowerCase();
    document.querySelectorAll('#persona-grid .persona-card').forEach((card) => {
      const hit = !q || card.textContent.toLowerCase().includes(q);
      card.classList.toggle('hidden', !hit);
    });
  }

  function updateSaveCustomButton() {
    const btn = $('#ps-save-custom');
    if (!btn) return;
    const tpl = state.personaTemplates?.[studio.lastCustomId];
    const d = draft();
    const dirty = tpl && (tpl.text !== d.roleText || (tpl.customRules || '') !== d.customRules || (tpl.behaviorProfile || 'legacy') !== d.behaviorProfile);
    btn.classList.toggle('hidden', !dirty);
    const label = btn.querySelector('.ps-save-label');
    if (tpl && label) label.textContent = `覆盖保存「${tpl.name}」`;
  }

  // ── 试聊 ──────────────────────────────────────────────────────
  function chatHtml() {
    if (!studio.chat.length) {
      return `<div class="ps-chat-empty muted">用当前草稿里的卡跟它聊几句（不用先保存）。消息不会发到 QQ，也不会写进记忆。</div>`;
    }
    return studio.chat.map((m) => (m.role === 'user'
      ? `<div class="ps-msg me"><span class="bubble">${esc(m.content)}</span></div>`
      : `<div class="ps-msg bot">${String(m.content).split('\n').map((line) => `<span class="bubble">${esc(line)}</span>`).join('')}${m.meta ? `<span class="ps-meta muted">${esc(m.meta)}</span>` : ''}</div>`)).join('')
      + (studio.busy ? '<div class="ps-msg bot"><span class="bubble ps-typing">对方正在输入…</span></div>' : '');
  }

  function renderChat() {
    const box = $('#ps-chat-log');
    if (!box) return;
    box.innerHTML = chatHtml();
    box.scrollTop = box.scrollHeight;
  }

  async function sendChat(text) {
    const content = String(text || '').trim();
    if (!content || studio.busy) return;
    const d = draft();
    if (!d.roleText.trim()) { flash('角色设定是空的，先选一张卡', 'bad'); return; }
    studio.chat.push({ role: 'user', content });
    studio.busy = true;
    renderChat();
    try {
      const r = await api('/api/persona/preview', {
        method: 'POST',
        body: JSON.stringify({ ...d, history: studio.chat.map(({ role, content: c }) => ({ role, content: c })) })
      });
      const meta = `${(r.ms / 1000).toFixed(1)}s${r.usage ? ` · ${r.usage.prompt}+${r.usage.completion} tok` : ''}`;
      studio.chat.push({ role: 'assistant', content: (r.reply || []).join('\n') || '（没有回复）', meta });
    } catch (error) {
      studio.chat.push({ role: 'assistant', content: `（试聊失败：${error.message}）` });
    } finally {
      studio.busy = false;
      renderChat();
    }
  }

  function flash(text, kind = '') {
    const el = $('#ps-flash');
    if (!el) return;
    el.textContent = text;
    el.className = `ext-flash ${kind}`;
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.textContent = ''; }, kind === 'bad' ? 8000 : 4000);
  }

  // ── AI 起草 ───────────────────────────────────────────────────
  function openGenerateModal() {
    const overlay = modelModalShell({
      head: 'AI 起草一张人设卡',
      body: `
        <div class="field"><label>名字</label><input type="text" id="ps-gen-name" maxlength="40" placeholder="例如：社恐学妹" /></div>
        <div class="field"><label>一句话设定（越具体越好：性格、口癖、爱好、和群友的关系）</label>
          <textarea id="ps-gen-idea" rows="3" placeholder="例如：计算机系大一，社恐但一聊到 galgame 就话多，说话爱用省略号，怕被学长学姐点名"></textarea></div>
        <div class="field-row">
          <div class="field"><label>交流策略</label>
            <select id="ps-gen-profile"><option value="legacy">原版群友</option><option value="grounded">自然可靠</option></select></div>
          <div class="field" style="flex:2"><label>补充要求（可选）</label><input type="text" id="ps-gen-extra" placeholder="例如：不要说脏话；对管理员用敬语" /></div>
        </div>
        <div class="ext-actions"><button class="btn btn-primary" id="ps-gen-run">开始起草</button><span class="ext-flash" id="ps-gen-flash"></span></div>
        <div class="field hidden" id="ps-gen-result-wrap"><label>起草结果（可以先改）</label><textarea id="ps-gen-result" class="persona-role-text" style="min-height:260px"></textarea></div>`,
      foot: `<button class="btn" id="ps-gen-cancel">关闭</button>
             <button class="btn hidden" id="ps-gen-apply">填入草稿</button>
             <button class="btn btn-primary hidden" id="ps-gen-save">另存为自定义卡</button>`
    });
    const q = (sel) => overlay.querySelector(sel);
    q('#ps-gen-profile').value = draft().behaviorProfile;
    q('#ps-gen-cancel').addEventListener('click', () => closeModelModal(overlay));
    q('#ps-gen-run').addEventListener('click', async () => {
      const btn = q('#ps-gen-run');
      btn.disabled = true;
      btn.textContent = '起草中（约 20~60 秒）…';
      try {
        const r = await api('/api/persona/generate', {
          method: 'POST',
          body: JSON.stringify({ name: q('#ps-gen-name').value, idea: q('#ps-gen-idea').value, behaviorProfile: q('#ps-gen-profile').value, extra: q('#ps-gen-extra').value })
        });
        q('#ps-gen-result').value = r.text;
        q('#ps-gen-result-wrap').classList.remove('hidden');
        q('#ps-gen-apply').classList.remove('hidden');
        q('#ps-gen-save').classList.remove('hidden');
      } catch (error) {
        const el = q('#ps-gen-flash');
        el.textContent = error.message;
        el.className = 'ext-flash bad';
      } finally {
        btn.disabled = false;
        btn.textContent = '重新起草';
      }
    });
    q('#ps-gen-apply').addEventListener('click', () => {
      applyPersonaDraft({ text: q('#ps-gen-result').value, behaviorProfile: q('#ps-gen-profile').value, customRules: draft().customRules });
      closeModelModal(overlay);
      studio.chat = [];
      renderChat();
      scheduleOutline();
      flash('已填入草稿：先在下面试聊看看，满意了点底部「保存设置」生效', 'ok');
    });
    q('#ps-gen-save').addEventListener('click', async () => {
      const name = q('#ps-gen-name').value.trim() || '新人设';
      const text = q('#ps-gen-result').value.trim();
      const behaviorProfile = q('#ps-gen-profile').value;
      try {
        await api('/api/persona-templates', { method: 'POST', body: JSON.stringify({ name, text, behaviorProfile }) });
        closeModelModal(overlay);
        await loadSettings();
        applyPersonaDraft({ text, behaviorProfile, customRules: '' });
        flash(`已存为自定义卡「${name}」并填入草稿；点底部「保存设置」后生效`, 'ok');
      } catch (error) {
        const el = q('#ps-gen-flash');
        el.textContent = `保存失败：${error.message}`;
        el.className = 'ext-flash bad';
      }
    });
  }

  // ── 导入 / 导出 / 覆盖保存 ─────────────────────────────────────
  function exportCard() {
    const d = draft();
    if (!d.roleText.trim()) { flash('当前没有正文可以导出', 'bad'); return; }
    const title = parsePersonaCard(d.roleText).title || 'persona';
    const name = title.replace(/^角色卡[:：]\s*/, '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || 'persona';
    const blob = new Blob([`${d.roleText.trim()}\n`], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name}.md`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  function importCard(file) {
    if (!file) return;
    if (file.size > 200 * 1024) { flash('文件太大（>200KB），不像是一张角色卡', 'bad'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '').replace(/^﻿/, '').trim();
      if (!text) { flash('文件是空的', 'bad'); return; }
      const d = draft();
      applyPersonaDraft({ text, behaviorProfile: d.behaviorProfile, customRules: d.customRules });
      studio.chat = [];
      renderChat();
      scheduleOutline();
      flash(`已导入「${file.name}」到草稿（${parsePersonaCard(text).sections.length} 节）：可以试聊、另存为自定义卡，或直接保存设置`, 'ok');
    };
    reader.onerror = () => flash('读取文件失败', 'bad');
    reader.readAsText(file, 'utf-8');
  }

  async function saveCustom() {
    const id = studio.lastCustomId;
    const tpl = state.personaTemplates?.[id];
    if (!tpl) return;
    const d = draft();
    try {
      await api(`/api/persona-templates/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify({ name: tpl.name, text: d.roleText, customRules: d.customRules, behaviorProfile: d.behaviorProfile })
      });
      await loadSettings();
      applyPersonaDraft({ text: d.roleText, customRules: d.customRules, behaviorProfile: d.behaviorProfile }, id);
      flash(`自定义卡「${tpl.name}」已更新；点底部「保存设置」让实例用上它`, 'ok');
    } catch (error) {
      flash(`保存失败：${error.message}`, 'bad');
    }
  }

  // ── 装配 ──────────────────────────────────────────────────────
  function mount() {
    syncNavHighlight();
    if (state.settingsSection !== 'persona') return;
    const lib = document.querySelector('#settings-form .persona-lib');
    const detail = document.querySelector('#settings-form .persona-detail');
    if (!lib || !detail || $('#ps-bar')) return;

    const bar = document.createElement('div');
    bar.id = 'ps-bar';
    bar.className = 'ps-bar';
    bar.innerHTML = `
      <div class="ps-bar-row">
        <input type="search" id="ps-search" placeholder="搜索卡库…" value="${esc(studio.query)}" />
        <button type="button" class="btn btn-small" id="ps-generate"><span data-ico="ext-fun" aria-hidden="true"></span>AI 起草</button>
        <button type="button" class="btn btn-small" id="ps-import"><span data-ico="import" aria-hidden="true"></span>导入 .md</button>
        <button type="button" class="btn btn-small" id="ps-export"><span data-ico="export" aria-hidden="true"></span>导出当前卡</button>
        <button type="button" class="btn btn-small btn-primary hidden" id="ps-save-custom"><span data-ico="save" aria-hidden="true"></span><span class="ps-save-label">覆盖保存</span></button>
        <input type="file" id="ps-import-file" accept=".md,.txt,text/markdown,text/plain" hidden />
        <span class="ext-flash" id="ps-flash"></span>
      </div>
      <div id="ps-outline-box"></div>`;
    lib.parentNode.insertBefore(bar, lib);

    const chat = document.createElement('div');
    chat.id = 'ps-chat';
    chat.className = 'ps-chat';
    chat.innerHTML = `
      <div class="ps-chat-head">
        <strong>试聊</strong><span class="muted">用草稿里的卡回复（不发到 QQ）</span>
        <span class="spacer"></span>
        <button type="button" class="btn btn-small" id="ps-chat-clear">清空</button>
      </div>
      <div class="ps-chat-log" id="ps-chat-log"></div>
      <div class="ps-quick">${QUICK.map((t) => `<button type="button" class="pd-tag rule-chip" data-quick="${esc(t)}">${esc(t)}</button>`).join('')}</div>
      <form class="ps-chat-input" id="ps-chat-form">
        <input type="text" id="ps-chat-text" maxlength="500" placeholder="以群友的身份说一句…" autocomplete="off" />
        <button class="btn btn-primary" type="submit">发送</button>
      </form>`;
    detail.parentNode.insertBefore(chat, detail.nextSibling);

    refreshOutline();
    renderChat();
    applyLibraryFilter();
    updateSaveCustomButton();

    $('#ps-search').addEventListener('input', (ev) => { studio.query = ev.target.value; applyLibraryFilter(); });
    $('#ps-generate').addEventListener('click', openGenerateModal);
    $('#ps-export').addEventListener('click', exportCard);
    $('#ps-import').addEventListener('click', () => $('#ps-import-file').click());
    $('#ps-import-file').addEventListener('change', (ev) => { importCard(ev.target.files?.[0]); ev.target.value = ''; });
    $('#ps-save-custom').addEventListener('click', saveCustom);
    $('#ps-outline-box').addEventListener('click', (ev) => {
      const chip = ev.target.closest('[data-jump]');
      if (!chip) return;
      const idx = Number(chip.dataset.jump);
      state.personaCollapsedSections?.delete?.(idx);
      const sec = document.querySelector(`#persona-card-view .pd-sec[data-sec="${idx}"]`);
      sec?.classList.remove('collapsed');
      sec?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    $('#ps-chat-clear').addEventListener('click', () => { studio.chat = []; renderChat(); });
    $('#ps-chat-form').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const input = $('#ps-chat-text');
      const text = input.value;
      input.value = '';
      sendChat(text);
    });
    chat.querySelector('.ps-quick').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-quick]');
      if (b) sendChat(b.dataset.quick);
    });
    // 卡库点卡：记下"最近点的自定义卡"，覆盖保存按钮就有了目标；换卡时清空试聊
    $('#persona-grid')?.addEventListener('click', (ev) => {
      const id = ev.target.closest('.persona-card')?.dataset?.personaId || '';
      if (!id) return;
      studio.lastCustomId = id.startsWith('custom_') ? id : '';
      studio.chat = [];
      renderChat();
      scheduleOutline();
    });
    // #settings-form 本身不会被重建（重画只换 innerHTML）：监听只挂一次
    const form = $('#settings-form');
    if (form && !form.__psBound) {
      form.__psBound = true;
      form.addEventListener('input', () => { if (state.settingsSection === 'persona') scheduleOutline(); });
      form.addEventListener('click', () => { if (state.settingsSection === 'persona') scheduleOutline(); });
    }
  }

  QARegistry.onAfter('renderSettings', mount);
})();

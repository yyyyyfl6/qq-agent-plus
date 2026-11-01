'use strict';

// 长期记忆页面（扩展功能）：开关与检索参数、向量服务、自动提炼、条目浏览/搜索/编辑/删除、召回测试。
// 页面在功能关闭时也能用（看数据、修配置），符合 docs/EXPERIMENTAL_FEATURE_STANDARD.md §3。

import { api } from './core/api.js';
import { askForConfirmation } from './core/dom-util.js';
import { $, esc } from './core/dom.js';
import { formatChatTitle } from './core/format.js';
import { extChatOptions, extFlash, extFmtTime, extHead, extLoadChats, extOnTab, extStat } from './ext-kit.js';

(function longMemoryPage() {
  const view = { q: '', chatKey: '', offset: 0, data: null, chats: [], editing: 0 };

  async function load() {
    const box = $('#ext-memory-page');
    if (!box) return;
    if (!view.data) box.innerHTML = '<div class="empty-hint">正在读取长期记忆…</div>';
    try {
      const qs = new URLSearchParams({ q: view.q, chatKey: view.chatKey, offset: String(view.offset) });
      const [data, chats] = await Promise.all([api(`/api/ext/long-memory?${qs}`), extLoadChats()]);
      view.data = data;
      view.chats = chats;
      render();
    } catch (error) {
      box.innerHTML = `<div class="empty-hint">读取失败：${esc(error.message)}</div>`;
    }
  }

  function render() {
    const box = $('#ext-memory-page');
    const d = view.data || {};
    const st = d.status || {};
    const c = st.config || {};
    const emb = c.embedding || {};
    const items = d.items || [];
    const chatsWithMemory = (d.chats || []).map((x) => x.chatKey);
    const pickerChats = view.chats.length ? view.chats : chatsWithMemory.map((key) => ({ key }));
    box.innerHTML = `
      ${extHead({
        icon: 'ext-memory', title: '长期记忆', toggleId: 'lm-enabled', enabled: c.enabled,
        sub: '记住"发生过什么、说好了什么"：约定、群友的近况与计划、群里的大事。聊天时按相关度自动想起来。'
          + '与「人物记忆」（对人的印象）互补。关闭只停止召回与提炼，<strong>不会删除</strong>已有记忆。'
      })}
      <div class="ext-stats">
        ${extStat('条记忆', st.count ?? 0)}
        ${extStat('召回范围', c.scope === 'global' ? '全局' : '按会话')}
        ${extStat('向量检索', st.embeddingReady ? '已启用' : '仅词法')}
        ${extStat('自动提炼', st.autoExtractActive ? '运行中' : '关闭', st.lastRun ? `上次 ${extFmtTime(st.lastRun.at)}` : '')}
      </div>

      <details class="ext-card" ${c.enabled ? '' : 'open'}>
        <summary>召回与提炼设置</summary>
        <div class="field-row">
          <div class="field"><label>召回范围</label>
            <select id="lm-scope">
              <option value="chat" ${c.scope !== 'global' ? 'selected' : ''}>按会话（只在记下它的群/私聊里想起）</option>
              <option value="global" ${c.scope === 'global' ? 'selected' : ''}>全局（跨群；群里不会想起私聊的事）</option>
            </select></div>
          <div class="field"><label>每轮最多带几条</label><input type="number" id="lm-topk" min="1" max="12" value="${esc(c.recallTopK ?? 4)}" /></div>
          <div class="field"><label>相关度门槛（0~1）</label><input type="number" id="lm-minscore" min="0" max="1" step="0.01" value="${esc(c.recallMinScore ?? 0.18)}" /></div>
          <div class="field"><label>最多保存条数</label><input type="number" id="lm-max" min="100" max="50000" step="100" value="${esc(c.maxEntries ?? 5000)}" /></div>
        </div>
        <div class="checkbox-row"><input type="checkbox" id="lm-autorecall" ${c.autoRecall !== false ? 'checked' : ''} /><label for="lm-autorecall">每轮自动把相关记忆放进提示词（关掉后只能靠模型主动搜）</label></div>
        <div class="checkbox-row"><input type="checkbox" id="lm-autoextract" ${c.autoExtract ? 'checked' : ''} /><label for="lm-autoextract">后台自动提炼（攒够新消息后让模型挑出值得记的事；会额外消耗 token）</label></div>
        <div class="field-row">
          <div class="field"><label>攒够多少条新消息才提炼</label><input type="number" id="lm-extract-min" min="5" max="500" value="${esc(c.extractMinMessages ?? 30)}" /></div>
          <div class="field"><label>扫描间隔（分钟）</label><input type="number" id="lm-extract-interval" min="5" max="1440" value="${esc(c.extractIntervalMinutes ?? 30)}" /></div>
          <div class="field"><label>每小时最多提炼几次</label><input type="number" id="lm-extract-hour" min="1" max="60" value="${esc(c.extractMaxPerHour ?? 6)}" /></div>
        </div>
        <div class="field"><label>只提炼这些会话（每行一个，如 group:123456；留空 = 全部有新消息的会话）</label>
          <textarea id="lm-extract-chats" rows="2" placeholder="group:123456789">${esc((c.extractChats || []).join('\n'))}</textarea></div>
        <h4 class="ext-sub">向量检索（可选，语义更准）</h4>
        <div class="checkbox-row"><input type="checkbox" id="lm-emb-enabled" ${emb.enabled ? 'checked' : ''} /><label for="lm-emb-enabled">启用向量检索（OpenAI 兼容 /embeddings；不可用时自动退回词法检索）</label></div>
        <div class="field-row">
          <div class="field"><label>服务地址（留空 = 跟聊天模型同一家）</label><input type="text" id="lm-emb-base" value="${esc(emb.baseUrl || '')}" placeholder="https://api.siliconflow.cn/v1" /></div>
          <div class="field"><label>模型</label><input type="text" id="lm-emb-model" value="${esc(emb.model || '')}" placeholder="BAAI/bge-m3" /></div>
          <div class="field"><label>API Key</label><input type="password" id="lm-emb-key" value="${emb.hasApiKey ? '******' : ''}" placeholder="留空/掩码 = 保持原值" autocomplete="new-password" /></div>
        </div>
        <div class="hint">与生图、语音同一条规矩：服务地址不是聊天模型那一家时，<strong>不会</strong>把聊天模型的 Key 发过去，需要在这里单独填。</div>
        <div class="ext-actions">
          <button class="btn btn-primary" id="lm-save">保存设置</button>
          <button class="btn" id="lm-emb-test">测试向量服务</button>
          <span class="ext-flash" id="lm-flash"></span>
        </div>
      </details>

      <div class="ext-card">
        <div class="ext-card-title">召回测试 / 手动操作</div>
        <div class="field-row">
          <div class="field"><label>会话</label><select id="lm-tool-chat">${extChatOptions(pickerChats, view.chatKey)}</select></div>
          <div class="field" style="flex:2"><label>模拟一句群聊消息，看会想起哪些</label><input type="text" id="lm-test-q" placeholder="例如：阿杰考得怎么样了" /></div>
        </div>
        <div class="ext-actions">
          <button class="btn btn-small" id="lm-test-btn">试一下召回</button>
          <button class="btn btn-small" id="lm-extract-btn" title="对选中的会话立即提炼一次新消息">立即提炼这个会话</button>
          <button class="btn btn-small" id="lm-add-toggle">＋ 手动添加一条</button>
          <span class="ext-flash" id="lm-tool-flash"></span>
        </div>
        <div id="lm-add-form" class="hidden">
          <div class="field-row">
            <div class="field" style="flex:3"><label>内容</label><input type="text" id="lm-add-content" maxlength="200" placeholder="例如：小林 12 月要去日本交换半年" /></div>
            <div class="field"><label>重要度 1~5</label><input type="number" id="lm-add-imp" min="1" max="5" value="3" /></div>
            <div class="field"><label>标签（逗号分隔）</label><input type="text" id="lm-add-tags" placeholder="近况,出行" /></div>
          </div>
          <button class="btn btn-small btn-primary" id="lm-add-save">添加到选中的会话</button>
        </div>
        <div id="lm-test-out"></div>
      </div>

      <div class="ext-card">
        <div class="ext-card-title">
          <span>全部记忆 <span class="muted">（${esc(d.total ?? 0)} 条）</span></span>
          <span class="spacer"></span>
          <select id="lm-filter-chat" class="ext-inline">${extChatOptions(pickerChats.filter((x) => chatsWithMemory.includes(x.key)), view.chatKey, { placeholder: '全部会话' })}</select>
          <input type="text" id="lm-filter-q" class="ext-inline" placeholder="搜索内容 / 人名 / 标签" value="${esc(view.q)}" />
        </div>
        ${items.length ? `<div class="lm-list">${items.map(renderItem).join('')}</div>` : `<div class="ext-empty">${d.total === 0 && !view.q ? (c.enabled ? '还没有记忆。聊天时模型会自己记，也可以开「自动提炼」或手动添加。' : '还没有记忆。先打开右上角的开关。') : '没有匹配的记忆。'}</div>`}
        <div class="ext-pager">
          ${view.offset > 0 ? '<button class="btn btn-small" id="lm-prev">上一页</button>' : ''}
          ${view.offset + items.length < (d.total || 0) ? '<button class="btn btn-small" id="lm-next">下一页</button>' : ''}
        </div>
      </div>`;
    bind();
  }

  function renderItem(e) {
    const stars = '★'.repeat(e.importance) + '☆'.repeat(5 - e.importance);
    const src = { model: '聊天中记下', extract: '自动提炼', console: '控制台添加' }[e.source] || e.source;
    if (view.editing === e.id) {
      return `
        <div class="lm-item editing" data-id="${e.id}">
          <textarea class="lm-edit-content" rows="2" maxlength="200">${esc(e.content)}</textarea>
          <div class="ext-actions">
            <label class="muted">重要度 <input type="number" class="lm-edit-imp" min="1" max="5" value="${e.importance}" style="width:56px" /></label>
            <label class="muted">标签 <input type="text" class="lm-edit-tags" value="${esc((e.tags || []).join(','))}" /></label>
            <button class="btn btn-small btn-primary" data-act="save">保存</button>
            <button class="btn btn-small" data-act="cancel">取消</button>
          </div>
        </div>`;
    }
    return `
      <div class="lm-item" data-id="${e.id}">
        <div class="lm-item-main">
          <div class="lm-content">${esc(e.content)}</div>
          <div class="lm-meta">
            <span class="lm-stars" title="重要度 ${e.importance}">${stars}</span>
            <span>#${e.id}</span>
            <span>${esc(formatChatTitle(e.chatKey))}</span>
            ${e.subjectName || e.subjectId ? `<span>关于 ${esc(e.subjectName || e.subjectId)}</span>` : ''}
            ${(e.tags || []).map((t) => `<span class="gm-chip">${esc(t)}</span>`).join('')}
            <span>${esc(src)} · ${extFmtTime(e.createdAt)}</span>
            ${e.recallCount ? `<span title="被想起的次数">想起 ${e.recallCount} 次</span>` : ''}
          </div>
        </div>
        <div class="lm-item-actions">
          <button class="btn btn-small" data-act="edit">编辑</button>
          <button class="btn btn-small btn-danger" data-act="del">删除</button>
        </div>
      </div>`;
  }

  function collectConfig() {
    const n = (id) => Number($(id)?.value);
    return {
      enabled: $('#lm-enabled').checked,
      scope: $('#lm-scope').value,
      recallTopK: n('#lm-topk'),
      recallMinScore: n('#lm-minscore'),
      maxEntries: n('#lm-max'),
      autoRecall: $('#lm-autorecall').checked,
      autoExtract: $('#lm-autoextract').checked,
      extractMinMessages: n('#lm-extract-min'),
      extractIntervalMinutes: n('#lm-extract-interval'),
      extractMaxPerHour: n('#lm-extract-hour'),
      extractChats: $('#lm-extract-chats').value.split(/[\s,，]+/).filter(Boolean),
      embedding: {
        enabled: $('#lm-emb-enabled').checked,
        baseUrl: $('#lm-emb-base').value.trim(),
        model: $('#lm-emb-model').value.trim(),
        apiKey: $('#lm-emb-key').value.trim()
      }
    };
  }

  async function saveConfig(flashEl, patch = null) {
    try {
      await api('/api/ext/long-memory/config', { method: 'POST', body: JSON.stringify({ config: patch || collectConfig() }) });
      extFlash(flashEl, '已保存', 'ok');
      await load();
    } catch (error) {
      extFlash(flashEl, `保存失败：${error.message}`, 'bad');
    }
  }

  function bind() {
    $('#lm-enabled')?.addEventListener('change', (ev) => saveConfig($('#lm-flash'), { ...collectConfig(), enabled: ev.target.checked }));
    $('#lm-save')?.addEventListener('click', () => saveConfig($('#lm-flash')));
    $('#lm-emb-test')?.addEventListener('click', async () => {
      extFlash($('#lm-flash'), '测试中…');
      try {
        const r = await api('/api/ext/long-memory/test-embedding', { method: 'POST', body: '{}' });
        extFlash($('#lm-flash'), r.ok ? `连通：${r.dims} 维，${r.ms} ms${r.backfilled ? `，补算了 ${r.backfilled} 条` : ''}` : r.error, r.ok ? 'ok' : 'bad');
      } catch (error) { extFlash($('#lm-flash'), error.message, 'bad'); }
    });
    $('#lm-test-btn')?.addEventListener('click', async () => {
      const chatKey = $('#lm-tool-chat').value;
      const out = $('#lm-test-out');
      if (!chatKey) return extFlash($('#lm-tool-flash'), '先选一个会话', 'bad');
      try {
        const r = await api('/api/ext/long-memory/search', { method: 'POST', body: JSON.stringify({ chatKey, query: $('#lm-test-q').value }) });
        out.innerHTML = r.results?.length
          ? `<div class="lm-test">${r.results.map((h) => `<div><span class="chip ${h.score >= (view.data?.status?.config?.recallMinScore ?? 0.18) ? 'ok' : ''}">${h.score.toFixed(2)}</span> #${h.entry.id} ${esc(h.entry.content)}</div>`).join('')}
             <div class="hint">绿色的会被自动放进提示词（≥ 相关度门槛）；灰色的只有模型主动搜时才看得到。</div></div>`
          : '<div class="ext-empty">什么都没想起来。</div>';
      } catch (error) { extFlash($('#lm-tool-flash'), error.message, 'bad'); }
    });
    $('#lm-extract-btn')?.addEventListener('click', async () => {
      const chatKey = $('#lm-tool-chat').value;
      if (!chatKey) return extFlash($('#lm-tool-flash'), '先选一个会话', 'bad');
      extFlash($('#lm-tool-flash'), '提炼中（要调一次模型）…');
      try {
        const r = await api('/api/ext/long-memory/extract', { method: 'POST', body: JSON.stringify({ chatKey }) });
        extFlash($('#lm-tool-flash'), r.note || `新增 ${r.added} 条、合并 ${r.merged} 条`, 'ok');
        await load();
      } catch (error) { extFlash($('#lm-tool-flash'), error.message, 'bad'); }
    });
    $('#lm-add-toggle')?.addEventListener('click', () => $('#lm-add-form').classList.toggle('hidden'));
    $('#lm-add-save')?.addEventListener('click', async () => {
      const chatKey = $('#lm-tool-chat').value;
      if (!chatKey) return extFlash($('#lm-tool-flash'), '先选一个会话', 'bad');
      try {
        await api('/api/ext/long-memory', {
          method: 'POST',
          body: JSON.stringify({ chatKey, content: $('#lm-add-content').value, importance: Number($('#lm-add-imp').value), tags: $('#lm-add-tags').value })
        });
        extFlash($('#lm-tool-flash'), '已添加', 'ok');
        await load();
      } catch (error) { extFlash($('#lm-tool-flash'), error.message, 'bad'); }
    });
    let qTimer = null;
    $('#lm-filter-q')?.addEventListener('input', (ev) => {
      clearTimeout(qTimer);
      qTimer = setTimeout(() => { view.q = ev.target.value.trim(); view.offset = 0; load().then(() => { const el = $('#lm-filter-q'); el?.focus(); el?.setSelectionRange(el.value.length, el.value.length); }); }, 300);
    });
    $('#lm-filter-chat')?.addEventListener('change', (ev) => { view.chatKey = ev.target.value; view.offset = 0; load(); });
    $('#lm-prev')?.addEventListener('click', () => { view.offset = Math.max(0, view.offset - 50); load(); });
    $('#lm-next')?.addEventListener('click', () => { view.offset += 50; load(); });
    document.querySelector('#ext-memory-page .lm-list')?.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('[data-act]');
      const item = ev.target.closest('.lm-item');
      if (!btn || !item) return;
      const id = Number(item.dataset.id);
      if (btn.dataset.act === 'edit') { view.editing = id; render(); return; }
      if (btn.dataset.act === 'cancel') { view.editing = 0; render(); return; }
      if (btn.dataset.act === 'save') {
        try {
          await api(`/api/ext/long-memory/${id}`, {
            method: 'PATCH',
            body: JSON.stringify({
              content: item.querySelector('.lm-edit-content').value,
              importance: Number(item.querySelector('.lm-edit-imp').value),
              tags: item.querySelector('.lm-edit-tags').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
            })
          });
          view.editing = 0;
          await load();
        } catch (error) { extFlash($('#lm-tool-flash'), error.message, 'bad'); }
        return;
      }
      if (btn.dataset.act === 'del') {
        if (!(await askForConfirmation(`删除记忆 #${id}？删掉后它就不会再想起这件事了。`))) return;
        try {
          await api(`/api/ext/long-memory/${id}?confirm=1`, { method: 'DELETE' });
          await load();
        } catch (error) { extFlash($('#lm-tool-flash'), error.message, 'bad'); }
      }
    });
  }

  extOnTab('ext-memory', load);
})();

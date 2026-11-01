'use strict';

// 群聊总结页面（扩展功能）：开关与额度、对任意会话生成预览（不发送）、确认后发到群里、最近的总结记录。
// 定时的「群日报」仍在 设置 → 每日动态 附近原来的位置；这里是按需总结。

import { api } from './core/api.js';
import { askForConfirmation } from './core/dom-util.js';
import { $, esc } from './core/dom.js';
import { formatChatTitle } from './core/format.js';
import { extChatOptions, extFlash, extFmtTime, extHead, extLoadChats, extOnTab } from './ext-kit.js';

(function chatSummaryPage() {
  const view = { data: null, chats: [], draft: null, busy: false };

  async function load() {
    const box = $('#ext-summary-page');
    if (!box) return;
    if (!view.data) box.innerHTML = '<div class="empty-hint">正在读取…</div>';
    try {
      const [data, chats] = await Promise.all([api('/api/ext/chat-summary'), extLoadChats()]);
      view.data = data;
      view.chats = chats;
      render();
    } catch (error) {
      box.innerHTML = `<div class="empty-hint">读取失败：${esc(error.message)}</div>`;
    }
  }

  function render() {
    const box = $('#ext-summary-page');
    const c = view.data?.config || {};
    const history = view.data?.history || [];
    const draft = view.draft;
    box.innerHTML = `
      ${extHead({
        icon: '📝', title: '群聊总结', toggleId: 'cs-enabled', enabled: c.enabled,
        sub: '群友问"刚才聊了啥 / 我错过了什么"时，机器人会读最近的聊天、按话题整理后用自己的口吻发出来。'
          + '每次总结是一次长输入的模型调用，有每会话、全局两道每小时上限。'
      })}
      <details class="ext-card">
        <summary>设置</summary>
        <div class="field-row">
          <div class="field"><label>默认总结最近多少条</label><input type="number" id="cs-default" min="20" max="1000" value="${esc(c.defaultMessages ?? 120)}" /></div>
          <div class="field"><label>单次最多读多少条</label><input type="number" id="cs-max" min="20" max="2000" value="${esc(c.maxMessages ?? 500)}" /></div>
          <div class="field"><label>输入字符上限</label><input type="number" id="cs-chars" min="2000" max="60000" step="1000" value="${esc(c.maxInputChars ?? 16000)}" /></div>
        </div>
        <div class="field-row">
          <div class="field"><label>每个会话每小时最多</label><input type="number" id="cs-chat-hour" min="1" max="60" value="${esc(c.maxPerHourPerChat ?? 3)}" /></div>
          <div class="field"><label>全局每小时最多</label><input type="number" id="cs-hour" min="1" max="200" value="${esc(c.maxPerHour ?? 12)}" /></div>
          <div class="field"><label>默认风格</label>
            <select id="cs-style">
              <option value="structured" ${c.style !== 'casual' ? 'selected' : ''}>分话题要点（错过的人看了就能跟上）</option>
              <option value="casual" ${c.style === 'casual' ? 'selected' : ''}>随口复盘（三五句，像群友）</option>
            </select></div>
        </div>
        <div class="ext-actions"><button class="btn btn-primary" id="cs-save">保存设置</button><span class="ext-flash" id="cs-flash"></span></div>
      </details>

      <div class="ext-card">
        <div class="ext-card-title">生成一份总结</div>
        <div class="field-row">
          <div class="field" style="flex:2"><label>会话</label><select id="cs-chat">${extChatOptions(view.chats, draft?.chatKey || '')}</select></div>
          <div class="field"><label>范围</label>
            <select id="cs-range">
              <option value="count:50">最近 50 条</option>
              <option value="count:120" selected>最近 120 条</option>
              <option value="count:300">最近 300 条</option>
              <option value="hours:3">最近 3 小时</option>
              <option value="hours:12">最近 12 小时</option>
              <option value="hours:24">最近 24 小时</option>
            </select></div>
          <div class="field"><label>风格</label>
            <select id="cs-run-style"><option value="">按设置</option><option value="structured">分话题要点</option><option value="casual">随口复盘</option></select></div>
        </div>
        <div class="field"><label>侧重点（可选）</label><input type="text" id="cs-focus" placeholder="例如：周末聚餐最后定了没" /></div>
        <div class="ext-actions">
          <button class="btn btn-primary" id="cs-preview" ${view.busy ? 'disabled' : ''}>${view.busy ? '生成中…' : '生成预览（不发送）'}</button>
          <span class="ext-flash" id="cs-run-flash"></span>
        </div>
        ${draft ? `
          <div class="cs-draft">
            <div class="muted cs-draft-meta">${esc(formatChatTitle(draft.chatKey))} · ${draft.messages} 条消息 · ${extFmtTime(draft.from)} ~ ${extFmtTime(draft.to)}</div>
            <textarea id="cs-draft-text" rows="10">${esc(draft.text)}</textarea>
            <div class="ext-actions">
              <button class="btn" id="cs-send">发到这个会话…</button>
              <button class="btn btn-small" id="cs-copy">复制</button>
              <span class="hint">可以先改再发；空行分隔的段落会分成几条消息。</span>
            </div>
          </div>` : ''}
      </div>

      <div class="ext-card">
        <div class="ext-card-title">最近的总结 <span class="muted">（重启后清空）</span></div>
        ${history.length ? history.map((h) => `
          <details class="cs-hist">
            <summary><span>${esc(formatChatTitle(h.chatKey))}</span><span class="muted">${extFmtTime(h.at)} · ${h.messages} 条</span>${h.sent ? '<span class="chip ok">已发送</span>' : ''}</summary>
            <pre class="cs-hist-text">${esc(h.text)}</pre>
          </details>`).join('') : '<div class="ext-empty">还没有总结过。</div>'}
      </div>`;
    bind();
  }

  function bind() {
    const collect = () => ({
      enabled: $('#cs-enabled').checked,
      defaultMessages: Number($('#cs-default').value),
      maxMessages: Number($('#cs-max').value),
      maxInputChars: Number($('#cs-chars').value),
      maxPerHourPerChat: Number($('#cs-chat-hour').value),
      maxPerHour: Number($('#cs-hour').value),
      style: $('#cs-style').value
    });
    const save = async (patch) => {
      try {
        await api('/api/ext/chat-summary/config', { method: 'POST', body: JSON.stringify({ config: patch }) });
        extFlash($('#cs-flash'), '已保存', 'ok');
        await load();
      } catch (error) { extFlash($('#cs-flash'), `保存失败：${error.message}`, 'bad'); }
    };
    $('#cs-enabled')?.addEventListener('change', () => save(collect()));
    $('#cs-save')?.addEventListener('click', () => save(collect()));
    $('#cs-preview')?.addEventListener('click', async () => {
      const chatKey = $('#cs-chat').value;
      if (!chatKey) return extFlash($('#cs-run-flash'), '先选一个会话', 'bad');
      const [kind, n] = $('#cs-range').value.split(':');
      view.busy = true;
      render();
      try {
        const r = await api('/api/ext/chat-summary/preview', {
          method: 'POST',
          body: JSON.stringify({ chatKey, [kind]: Number(n), focus: $('#cs-focus')?.value || '', style: $('#cs-run-style')?.value || '' })
        });
        view.draft = r.record;
        view.busy = false;
        await load();
      } catch (error) {
        view.busy = false;
        render();
        extFlash($('#cs-run-flash'), error.message, 'bad');
      }
    });
    $('#cs-copy')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText($('#cs-draft-text').value); extFlash($('#cs-run-flash'), '已复制', 'ok'); } catch { extFlash($('#cs-run-flash'), '浏览器不允许复制，手动选中复制吧', 'bad'); }
    });
    $('#cs-send')?.addEventListener('click', async () => {
      const draft = view.draft;
      const text = $('#cs-draft-text').value.trim();
      if (!draft || !text) return;
      if (!(await askForConfirmation(`把这份总结发到「${formatChatTitle(draft.chatKey)}」？\n群里的人都会看到。`))) return;
      try {
        const r = await api('/api/ext/chat-summary/send', { method: 'POST', body: JSON.stringify({ chatKey: draft.chatKey, text, confirm: true }) });
        extFlash($('#cs-run-flash'), `已发送 ${r.sent} 条${r.failed ? `，失败 ${r.failed} 条` : ''}`, r.failed ? 'bad' : 'ok');
        view.draft = null;
        await load();
      } catch (error) { extFlash($('#cs-run-flash'), error.message, 'bad'); }
    });
  }

  extOnTab('ext-summary', load);
})();

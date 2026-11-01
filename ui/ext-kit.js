'use strict';

// 扩展页面（长期记忆 / 群聊总结 / 大肥鱼桥 / 趣味功能）共用的小工具。
// 这些页面是"外挂"层（排在 app.js 之后）：每个页面自己拥有一个 <section id="view-…">，
// 点侧栏 tab 时 app.js 的 switchTab 负责切视图，这里负责"切到我就加载"。
// 顶层名字一律 ext 前缀：vm 冒烟测试会把所有脚本按 classic 拼在同一个作用域里跑。

import { api } from './core/api.js';
import { esc } from './core/dom.js';
import { formatChatTitle } from './core/format.js';

/** 点中某个 tab 时调用 loader（另外导出给命令面板等主动跳转用）。 */
function extOnTab(tabName, loader) {
  document.querySelectorAll(`.tab[data-tab="${tabName}"]`).forEach((btn) => {
    btn.addEventListener('click', () => {
      try { loader(); } catch (error) { console.warn(`[ext] ${tabName} 加载失败`, error); }
    });
  });
}

function extFmtTime(ts) {
  const n = Number(ts) || 0;
  if (!n) return '-';
  const d = new Date(n);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

let extChatsCache = null;
let extChatsAt = 0;
/** 会话列表（下拉框用）；30 秒内复用。 */
async function extLoadChats() {
  if (extChatsCache && Date.now() - extChatsAt < 30_000) return extChatsCache;
  try {
    const data = await api('/api/chats');
    extChatsCache = Array.isArray(data?.chats) ? data.chats : [];
    extChatsAt = Date.now();
  } catch {
    extChatsCache = extChatsCache || [];
  }
  return extChatsCache;
}

function extChatOptions(chats, selected = '', { placeholder = '选择会话', groupsOnly = false } = {}) {
  const list = (chats || []).filter((c) => !groupsOnly || String(c.key).startsWith('group:'));
  return `<option value="">${esc(placeholder)}</option>${list.map((c) => `
    <option value="${esc(c.key)}" ${c.key === selected ? 'selected' : ''}>${esc(formatChatTitle(c.key, c.chatName || ''))}</option>`).join('')}`;
}

/** 页内短提示（成功/失败），几秒后淡出。 */
function extFlash(el, text, kind = '') {
  if (!el) return;
  el.textContent = text;
  el.className = `ext-flash ${kind}`;
  clearTimeout(el._extTimer);
  el._extTimer = setTimeout(() => { el.textContent = ''; el.className = 'ext-flash'; }, kind === 'bad' ? 9000 : 4000);
}

/** 统一的页头：标题 + 副标题 + 启用开关。 */
function extHead({ icon, title, sub, enabled, toggleId }) {
  return `
    <div class="ext-head">
      <div class="ext-head-copy">
        <h2><span class="ext-icon" data-ico="${esc(icon)}" aria-hidden="true"></span>${esc(title)}</h2>
        <p class="muted">${sub}</p>
      </div>
      <label class="ext-switch" title="启用 / 停用">
        <input type="checkbox" id="${esc(toggleId)}" ${enabled ? 'checked' : ''} />
        <span class="ext-switch-track"><span class="ext-switch-thumb"></span></span>
        <span class="ext-switch-label">${enabled ? '已启用' : '未启用'}</span>
      </label>
    </div>`;
}

function extStat(label, value, hint = '') {
  return `<div class="ext-stat"><div class="ext-stat-value">${esc(String(value))}</div><div class="ext-stat-label">${esc(label)}</div>${hint ? `<div class="ext-stat-hint">${esc(hint)}</div>` : ''}</div>`;
}

export { extChatOptions, extFlash, extFmtTime, extHead, extLoadChats, extOnTab, extStat };

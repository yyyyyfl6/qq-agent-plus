import { api } from './core/api.js';
import { esc } from './core/dom.js';

async function initSkinsPage() {
  const page = document.getElementById('skins-page');
  if (!page) return;
  const status = document.getElementById('skin-status');
  try {
    const [data, bindings] = await Promise.all([api('/api/skins'), api('/api/chat-skins')]);
    const skins = data.skins;
    document.getElementById('skins-enabled').checked = skins.enabled;
    document.getElementById('skins-handoff').checked = skins.handoffOnSwitch.enabled;
    document.getElementById('skins-default').innerHTML = skins.list.map((s) => `<option value="${esc(s.id)}" ${s.id === skins.default ? 'selected' : ''}>${esc(s.label)}</option>`).join('');
    document.getElementById('skins-ack').value = skins.ack;
    document.getElementById('skins-list').value = JSON.stringify(skins.list, null, 2);
    document.getElementById('skins-providers').textContent = '本实例提供商：' + (data.providers.map((p) => `${p.name} (${p.id})`).join('；') || '没有目录提供商；将回落当前模型 API');
    status.textContent = skins.enabled ? '已启用 · 人格与模型按会话绑定' : '已关闭 · 使用全局人设与旧存档';
    document.getElementById('skins-form').onsubmit = async (event) => {
      event.preventDefault();
      try {
        await api('/api/skins', { method: 'POST', body: JSON.stringify({ skins: {
          ...skins, enabled: document.getElementById('skins-enabled').checked,
          default: document.getElementById('skins-default').value,
          ack: document.getElementById('skins-ack').value,
          list: JSON.parse(document.getElementById('skins-list').value),
          handoffOnSwitch: { ...skins.handoffOnSwitch, enabled: document.getElementById('skins-handoff').checked }
        } }) });
        await initSkinsPage();
      } catch (error) { status.textContent = '保存失败：' + error.message; }
    };
    const chats = document.getElementById('skins-chats');
    chats.innerHTML = bindings.chats.length ? bindings.chats.map((c) => `
      <div class="skin-row" data-chat="${esc(c.chatKey)}"><strong>${esc(c.chatKey)}</strong>
      <select aria-label="${esc(c.chatKey)} 的皮肤">${skins.list.map((s) => `<option value="${esc(s.id)}" ${s.id === c.skinId ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select>
      <button class="btn btn-small" ${skins.enabled ? '' : 'disabled'}>切换</button></div>`).join('') : '<p>尚无会话。</p>';
    for (const row of chats.querySelectorAll('[data-chat]')) row.querySelector('button').onclick = async () => {
      if (!confirm('切换该会话的皮肤并结束当前线程？')) return;
      const button = row.querySelector('button'); button.disabled = true;
      try {
        await api('/api/chat-skins', { method: 'POST', body: JSON.stringify({ chatKey: row.dataset.chat, skinId: row.querySelector('select').value }) });
        await initSkinsPage();
      } catch (error) { status.textContent = '切换失败：' + error.message; button.disabled = false; }
    };
  } catch (error) { status.textContent = '加载失败：' + error.message + '。请先在主控制台登录。'; }
}

document.addEventListener('DOMContentLoaded', initSkinsPage);

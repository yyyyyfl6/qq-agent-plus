'use strict';

// 命令面板（Ctrl/⌘ + K）：页面越来越多（加上扩展功能已有十几个入口、设置里还有十几个分区），
// 靠侧栏一层层点太慢。按快捷键弹出搜索框，输入几个字回车直达；支持拼音首字母以外的任意子串匹配。
// 只做"导航"：跳转一律通过点击真实的侧栏按钮完成，保证与手动点击走同一条加载路径。

import { esc } from './core/dom.js';
import { iconSvg } from './core/icons.js';
import { state } from './core/state.js';

(function commandPalette() {
  // 设置分区（与 pages/settings.js 的菜单保持一致；对不上的只是跳到设置首页，不会出错）
  const SETTINGS = [
    ['api', '模型 API', 'model key 渠道'],
    ['search', '搜索服务', 'web search'],
    ['asr', '语音转文字 / 语音合成 / 图片生成', 'asr tts 语音 画图 生图 image'],
    ['memory', '记忆设置', 'memory'],
    ['experiments', '实验功能', 'experiment'],
    ['groupGame', '群游戏', 'game 狼人杀 卧底'],
    ['moments', '每日动态 / 群日报', 'qzone moments digest'],
    ['reminders', '定时提醒', 'remind'],
    ['qzone-interactions', '动态互动', 'qzone'],
    ['time-control', '时间控制', 'time'],
    ['token-saver', '省 Token', 'token'],
    ['persona', '人设 / 人格', 'persona role 角色卡'],
    ['allow', '聊天白名单', 'allow whitelist'],
    ['chat', '聊天设置', 'chat'],
    ['desktop', '系统 / 管理员', 'system admin'],
    ['onebot', 'OneBot 连接', 'onebot']
  ];

  function entries() {
    const list = [];
    document.querySelectorAll('#tabs .tab').forEach((btn) => {
      if (btn.classList.contains('hidden') || btn.hidden || btn.style.display === 'none') return;
      // 上游导航是两行（<b>主名</b><i>说明</i>）：面板只显示主名，说明进搜索关键词
      const label = (btn.querySelector('.tab-label b')?.textContent || btn.textContent).trim();
      const sub = btn.querySelector('.tab-label i')?.textContent || '';
      list.push({ label, hint: '页面', ico: btn.dataset.icon || 'chevron', keys: `${label} ${sub} ${btn.dataset.tab || ''}`, run: () => btn.click() });
    });
    // 「人格」（双人格页）不是侧栏页签，单独列一条
    list.push({ label: '人格（切换人格 / 专属指令）', hint: '页面', ico: 'mask', keys: '人格 皮肤 skins 切鱼 切猫 大肥鱼 哈基米 persona', run: () => { window.location.href = '/skins.html'; } });
    for (const [id, label, keys] of SETTINGS) {
      list.push({
        label: `设置 › ${label}`,
        hint: '设置',
        ico: 'gear',
        keys: `${label} ${keys} ${id} 设置 settings`,
        run: () => {
          state.settingsSection = id;
          document.querySelector('#tabs .tab[data-tab="settings"]')?.click();
          state.settingsSection = id;
        }
      });
    }
    list.push({ label: '切换主题（暗 / 亮 / 跟随系统）', hint: '操作', ico: 'moon', keys: 'theme 主题 暗色 亮色', run: () => document.querySelector('#theme-btn')?.click() });
    return list;
  }

  let overlay = null;
  let items = [];
  let active = 0;

  function score(entry, q) {
    if (!q) return 1;
    const hay = entry.keys.toLowerCase();
    const label = entry.label.toLowerCase();
    if (label.startsWith(q)) return 3;
    if (label.includes(q)) return 2;
    // 每个字都按顺序出现即可（"长记" 能匹配 "长期记忆"）
    let i = 0;
    for (const ch of hay) { if (ch === q[i]) i += 1; if (i === q.length) return 1; }
    return 0;
  }

  function renderList(q) {
    const query = q.trim().toLowerCase();
    items = entries().map((e) => ({ e, s: score(e, query) })).filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s).slice(0, 12).map((x) => x.e);
    active = Math.min(active, Math.max(0, items.length - 1));
    const list = overlay.querySelector('.cp-list');
    list.innerHTML = items.length
      ? items.map((e, i) => `<button type="button" class="cp-item ${i === active ? 'active' : ''}" data-idx="${i}">
          <span class="cp-icon" aria-hidden="true">${iconSvg(e.ico || 'chevron', { size: 16 })}</span><span class="cp-label">${esc(e.label)}</span><span class="cp-hint">${esc(e.hint)}</span></button>`).join('')
      : '<div class="cp-empty">没有匹配的页面</div>';
  }

  function close() {
    overlay?.remove();
    overlay = null;
  }

  function run(idx) {
    const e = items[idx];
    close();
    if (e) e.run();
  }

  function open() {
    if (overlay) { close(); return; }
    overlay = document.createElement('div');
    overlay.className = 'cp-overlay';
    overlay.innerHTML = `
      <div class="cp-panel" role="dialog" aria-label="快速跳转">
        <input type="text" class="cp-input" placeholder="跳转到…（页面、设置分区；↑↓ 选择，回车确认，Esc 关闭）" />
        <div class="cp-list"></div>
      </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('.cp-input');
    active = 0;
    renderList('');
    input.focus();
    input.addEventListener('input', () => { active = 0; renderList(input.value); });
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowDown') { ev.preventDefault(); active = Math.min(items.length - 1, active + 1); renderList(input.value); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); active = Math.max(0, active - 1); renderList(input.value); }
      else if (ev.key === 'Enter') { ev.preventDefault(); run(active); }
      else if (ev.key === 'Escape') { ev.preventDefault(); close(); }
    });
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) { close(); return; }
      const btn = ev.target.closest('.cp-item');
      if (btn) run(Number(btn.dataset.idx));
    });
  }

  document.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !ev.altKey && String(ev.key).toLowerCase() === 'k') {
      ev.preventDefault();
      open();
    }
  });
  document.querySelector('#cp-open')?.addEventListener('click', open);
})();

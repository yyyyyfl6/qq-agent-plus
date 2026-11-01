'use strict';

// 陪伴页面（扩展功能；移植自 AstrBot「我会永远陪着你」）：
//   今天的日程 · 主动判定（每个陪伴对象此刻会不会被主动问候、为什么）· 私聊日记（按日期）· 设置。
// 后端：src/extensions/companion.js（/api/ext/companion*）。

import { api } from './core/api.js';
import { askForConfirmation } from './core/dom-util.js';
import { $, esc } from './core/dom.js';
import { formatChatTitle } from './core/format.js';
import { extFlash, extFmtTime, extHead, extLoadChats, extOnTab, extStat } from './ext-kit.js';

(function companionPage() {
  const view = { data: null, chats: [], diaryChat: '', diary: [], openDate: '' };
  const KIND = { morning: '早安', lunch: '午饭', dinner: '晚饭', followup: '跟进昨天的事', date: '重要日子', idle: '久未联系', manual: '手动' };

  async function load() {
    const box = $('#ext-companion-page');
    if (!box) return;
    if (!view.data) box.innerHTML = '<div class="empty-hint">正在读取…</div>';
    try {
      const [data, chats] = await Promise.all([api('/api/ext/companion'), extLoadChats()]);
      view.data = data;
      view.chats = (chats || []).filter((c) => String(c.key).startsWith('private:'));
      if (!view.diaryChat) view.diaryChat = data.chats?.[0]?.chatKey || view.chats[0]?.key || '';
      await loadDiary();
      render();
    } catch (error) {
      box.innerHTML = `<div class="empty-hint">读取失败：${esc(error.message)}</div>`;
    }
  }

  async function loadDiary() {
    view.diary = [];
    if (!view.diaryChat) return;
    try {
      const r = await api(`/api/ext/companion/diary?chatKey=${encodeURIComponent(view.diaryChat)}`);
      view.diary = r.entries || [];
      if (!view.diary.some((e) => e.date === view.openDate)) view.openDate = view.diary[0]?.date || '';
    } catch { view.diary = []; }
  }

  const chatName = (key) => {
    const c = view.chats.find((x) => x.key === key);
    return formatChatTitle(key, c?.chatName || '');
  };

  function scheduleCard(d) {
    const s = d.schedule;
    const cur = d.current;
    const items = s?.items || [];
    return `
      <section class="ext-card cmp-card">
        <div class="ext-card-title">今天的日程<span class="spacer"></span>
          <button class="btn btn-small" id="cmp-regen" type="button">${s ? '重新排' : '现在排'}</button></div>
        ${items.length ? `<ol class="cmp-timeline">${items.map((it) => `
          <li class="${cur && cur.time === it.time ? 'now' : ''}"><time>${esc(it.time)}</time><span>${esc(it.text)}</span>${cur && cur.time === it.time ? '<em>此刻</em>' : ''}</li>`).join('')}</ol>`
          : `<div class="ext-empty">${d.config.scheduleEnabled ? '今天的日程还没排（启用后第一次巡检会按人设自动排）。' : '日程功能关着。'}</div>`}
        <p class="hint">日程只作为陪伴对象私聊时的生活背景（"此刻在干嘛"），模型自己决定提不提。</p>
      </section>`;
  }

  function proactiveCard(d) {
    const rows = d.chats || [];
    return `
      <section class="ext-card cmp-card">
        <div class="ext-card-title">主动判定<span class="spacer"></span><span class="muted">${d.quiet ? '🌙 免打扰中' : '每 5 分钟巡检一次'}</span></div>
        ${rows.length ? rows.map((r) => `
          <div class="cmp-target">
            <div class="cmp-target-main">
              <strong>${esc(chatName(r.chatKey))}</strong>
              <span class="muted">今天主动 ${r.today?.count || 0} 次${r.today?.lastAt ? ` · 上次 ${esc(extFmtTime(r.today.lastAt))}` : ''}</span>
              <span class="cmp-eval ${r.evaluation?.kind ? 'go' : ''}">${r.evaluation?.kind ? `下一条：${esc(KIND[r.evaluation.kind] || r.evaluation.kind)}` : esc(r.evaluation?.blocked || '')}</span>
            </div>
            <button class="btn btn-small" data-poke="${esc(r.chatKey)}" type="button">现在找 TA 说句话</button>
          </div>`).join('') : '<div class="ext-empty">没有陪伴对象：在下面「设置」里填 QQ 号，或先在 设置 → 系统 填管理员 QQ（留空时默认只陪管理员）。</div>'}
        ${(d.log || []).length ? `<div class="ext-sub">最近的主动联系</div><ul class="cmp-log">${d.log.slice(0, 6).map((l) => `<li>${esc(extFmtTime(l.at))} · ${esc(chatName(l.chatKey))} · ${esc(KIND[l.kind] || l.kind)}${l.manual ? '（手动）' : ''}</li>`).join('')}</ul>` : ''}
      </section>`;
  }

  function diaryCard() {
    const keys = new Set([...view.chats.map((c) => c.key), ...(view.data?.diaryChats || []).map((c) => c.chatKey)]);
    const open = view.diary.find((e) => e.date === view.openDate);
    return `
      <section class="ext-card cmp-diary">
        <div class="ext-card-title">私聊日记<span class="spacer"></span>
          <select class="ext-inline" id="cmp-diary-chat">${[...keys].map((k) => `<option value="${esc(k)}" ${k === view.diaryChat ? 'selected' : ''}>${esc(chatName(k))}</option>`).join('') || '<option value="">（还没有私聊）</option>'}</select>
          <button class="btn btn-small" id="cmp-diary-write" type="button" ${view.diaryChat ? '' : 'disabled'}>写今天的</button></div>
        <p class="hint" style="margin-top:0">每个私聊按日期记"那天发生了什么"。最近 ${esc(view.data?.config?.diaryInjectDays ?? 3)} 天自动进上下文，更早的模型会用 recall_diary 去翻。</p>
        ${view.diary.length ? `
          <div class="cmp-diary-body">
            <nav class="cmp-days" aria-label="日期">${view.diary.map((e) => `
              <button type="button" class="${e.date === view.openDate ? 'on' : ''}" data-day="${esc(e.date)}"><b>${esc(e.date.slice(5))}</b><span>${esc(e.mood || `${e.messages || 0} 条`)}</span></button>`).join('')}</nav>
            ${open ? `<article class="cmp-entry">
              <header><h3>${esc(open.date)}${open.partial ? ' <small>今天 · 未完稿</small>' : ''}</h3>
                <span class="muted">${esc(open.messages || 0)} 条对方消息 · 写于 ${esc(extFmtTime(open.at))}</span></header>
              <p class="cmp-summary">${esc(open.summary)}</p>
              ${open.events?.length ? `<div class="ext-sub">发生的事</div><ul>${open.events.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
              ${open.followups?.length ? `<div class="ext-sub">待跟进</div><ul class="cmp-follow">${open.followups.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
              <div class="ext-actions"><button class="btn btn-small" data-rewrite="${esc(open.date)}" type="button">重写这一天</button><button class="btn btn-small btn-ghost-danger" data-del="${esc(open.date)}" type="button">删除</button></div>
            </article>` : ''}
          </div>` : '<div class="ext-empty">这个会话还没有日记（当天对方说够几句后，后台会自动记；也可以点「写今天的」）。</div>'}
      </section>`;
  }

  function settingsCard(c, targets) {
    const sw = (id, on, label) => `<label class="cmp-check"><input type="checkbox" id="${id}" ${on ? 'checked' : ''} /><span>${label}</span></label>`;
    return `
      <details class="ext-card" id="cmp-settings">
        <summary>设置</summary>
        <div class="field"><label>陪伴对象（QQ 号，逗号分隔；留空 = 只陪管理员${targets.length && !c.targets.length ? `：${esc(targets.join(', '))}` : ''}）</label>
          <input type="text" id="cmp-targets" value="${esc((c.targets || []).join(', '))}" placeholder="如 10001, 20002" /></div>
        <div class="ext-sub">主动消息</div>
        <div class="cmp-checks">
          ${sw('cmp-proactive', c.proactiveEnabled, '允许主动找对方')}
          ${sw('cmp-morning', c.morning, '起床后的早安')}
          ${sw('cmp-meals', c.meals, '饭点问候')}
          ${sw('cmp-followups', c.followups, '跟进日记里"待跟进"的事')}
          ${sw('cmp-idle', c.idle, '久未联系时问候')}
        </div>
        <div class="field-row">
          <div class="field"><label>频率</label>
            <select id="cmp-intensity">
              <option value="low" ${c.intensity === 'low' ? 'selected' : ''}>低频（一天最多 1 次）</option>
              <option value="normal" ${c.intensity === 'normal' ? 'selected' : ''}>适中（一天最多 3 次）</option>
              <option value="high" ${c.intensity === 'high' ? 'selected' : ''}>较勤（一天最多 5 次）</option>
            </select></div>
          <div class="field"><label>免打扰 / 睡觉 从</label><input type="time" id="cmp-quiet-start" value="${esc(c.quietStart)}" /></div>
          <div class="field"><label>到（起床）</label><input type="time" id="cmp-quiet-end" value="${esc(c.quietEnd)}" /></div>
        </div>
        <p class="hint">上一条主动消息对方没回时，24 小时内不会再追；发不发、说什么最终由模型按人设判断，觉得不合适会安静结束。</p>
        <div class="ext-sub">日记与日程</div>
        <div class="cmp-checks">
          ${sw('cmp-diary', c.diaryEnabled, '按日期记私聊日记')}
          ${sw('cmp-schedule', c.scheduleEnabled, '每天按人设排一份生活日程')}
        </div>
        <div class="field-row">
          <div class="field"><label>给谁记日记</label>
            <select id="cmp-diary-scope">
              <option value="all" ${c.diaryScope === 'all' ? 'selected' : ''}>所有私聊</option>
              <option value="targets" ${c.diaryScope === 'targets' ? 'selected' : ''}>只给陪伴对象</option>
            </select></div>
          <div class="field"><label>当天至少几条才记</label><input type="number" id="cmp-diary-min" min="2" max="200" value="${esc(c.diaryMinMessages)}" /></div>
          <div class="field"><label>最近几天进上下文</label><input type="number" id="cmp-diary-days" min="0" max="14" value="${esc(c.diaryInjectDays)}" /></div>
          <div class="field"><label>当天日记多久补写（小时）</label><input type="number" id="cmp-diary-refresh" min="1" max="24" value="${esc(c.diaryRefreshHours)}" /></div>
        </div>
        <div class="ext-sub">重要的日子</div>
        <div id="cmp-dates">${(c.dates || []).map(dateRow).join('')}</div>
        <button class="btn btn-small" id="cmp-date-add" type="button">＋ 添加</button>
        <div class="field" style="margin-top:12px"><label>专属指令（逗号分隔；私聊里发「/陪伴 状态 / 日程 / 日记 / 日期」）</label>
          <input type="text" id="cmp-commands" value="${esc((c.commands || []).join(', '))}" /></div>
        <div class="ext-actions"><button class="btn btn-primary" id="cmp-save" type="button">保存设置</button><span class="ext-flash" id="cmp-save-flash"></span></div>
      </details>`;
  }

  function dateRow(d = {}) {
    return `<div class="cmp-date-row">
      <input type="text" data-k="md" value="${esc(d.md || '')}" placeholder="MM-DD" maxlength="5" />
      <input type="text" data-k="label" value="${esc(d.label || '')}" placeholder="如：TA 的生日" maxlength="40" />
      <input type="text" data-k="uin" value="${esc(d.uin || '')}" placeholder="只对这个 QQ（可空）" maxlength="20" />
      <button class="btn btn-small" data-date-del type="button" aria-label="删除">✕</button></div>`;
  }

  function render() {
    const box = $('#ext-companion-page');
    const d = view.data || {};
    const c = d.config || {};
    const targets = d.targets || [];
    const todayCount = (d.chats || []).reduce((n, r) => n + (r.today?.count || 0), 0);
    const diaryDays = (d.diaryChats || []).reduce((n, r) => n + (r.days || 0), 0);
    box.innerHTML = `
      ${extHead({
        icon: 'heart', title: '陪伴', toggleId: 'cmp-enabled', enabled: c.enabled,
        sub: '移植自 AstrBot 插件「我会永远陪着你」：按日期记私聊日记（长期记忆不止一张人物画像），每天按人设排一份生活日程，'
          + '记得重要的日子，并在合适的时候低频地主动问候。心情 / 精力状态沿用 设置 → 人设 里已有的「人设状态」。'
      })}
      <div class="ext-stats">
        ${extStat('陪伴对象', targets.length, c.targets?.length ? '' : '留空 = 管理员')}
        ${extStat('今天主动问候', todayCount, `${{ low: '低频', normal: '适中', high: '较勤' }[c.intensity] || ''}`)}
        ${extStat('日记', `${diaryDays} 篇`, `${(d.diaryChats || []).length} 个私聊`)}
        ${extStat('此刻', d.quiet ? '免打扰' : (d.current?.text || '—'), d.current ? `${d.current.time} 起` : '')}
      </div>
      <div class="cmp-grid">${scheduleCard(d)}${proactiveCard(d)}</div>
      ${diaryCard()}
      ${settingsCard(c, targets)}`;
    bind();
  }

  function collectConfig() {
    const v = (id) => $(`#${id}`)?.value ?? '';
    const ch = (id) => $(`#${id}`)?.checked === true;
    return {
      enabled: ch('cmp-enabled'),
      targets: v('cmp-targets').split(/[,，\s]+/).filter(Boolean),
      proactiveEnabled: ch('cmp-proactive'), morning: ch('cmp-morning'), meals: ch('cmp-meals'), followups: ch('cmp-followups'), idle: ch('cmp-idle'),
      intensity: v('cmp-intensity'), quietStart: v('cmp-quiet-start'), quietEnd: v('cmp-quiet-end'),
      diaryEnabled: ch('cmp-diary'), scheduleEnabled: ch('cmp-schedule'), diaryScope: v('cmp-diary-scope'),
      diaryMinMessages: Number(v('cmp-diary-min')), diaryInjectDays: Number(v('cmp-diary-days')), diaryRefreshHours: Number(v('cmp-diary-refresh')),
      dates: [...document.querySelectorAll('#cmp-dates .cmp-date-row')].map((row) => Object.fromEntries([...row.querySelectorAll('[data-k]')].map((i) => [i.dataset.k, i.value.trim()]))),
      commands: v('cmp-commands').split(/[,，]/).map((s) => s.trim()).filter(Boolean)
    };
  }

  async function save(flashEl) {
    try {
      await api('/api/ext/companion/config', { method: 'POST', body: JSON.stringify({ config: collectConfig() }) });
      view.data = null;
      await load();
      extFlash($('#cmp-save-flash') || flashEl, '已保存', 'ok');
    } catch (error) { extFlash($('#cmp-save-flash') || flashEl, `保存失败：${error.message}`, 'bad'); }
  }

  function bind() {
    $('#cmp-enabled')?.addEventListener('change', () => save());
    $('#cmp-save')?.addEventListener('click', () => save());
    $('#cmp-date-add')?.addEventListener('click', () => $('#cmp-dates').insertAdjacentHTML('beforeend', dateRow()));
    $('#cmp-dates')?.addEventListener('click', (e) => { if (e.target.closest('[data-date-del]')) e.target.closest('.cmp-date-row').remove(); });
    $('#cmp-regen')?.addEventListener('click', async (e) => {
      e.target.disabled = true; e.target.textContent = '排日程中…';
      try { await api('/api/ext/companion/schedule', { method: 'POST', body: '{}' }); await load(); }
      catch (error) { e.target.textContent = `失败：${error.message}`.slice(0, 40); }
    });
    document.querySelectorAll('[data-poke]').forEach((btn) => btn.addEventListener('click', async () => {
      if (!await askForConfirmation(`现在让机器人主动找 ${chatName(btn.dataset.poke)} 说句话？\n（会真的唤醒聊天模型并可能发出消息）`)) return;
      btn.disabled = true;
      try { await api('/api/ext/companion/poke', { method: 'POST', body: JSON.stringify({ chatKey: btn.dataset.poke, confirm: true }) }); btn.textContent = '已唤醒'; setTimeout(load, 1500); }
      catch (error) { btn.textContent = `失败：${error.message}`.slice(0, 40); }
    }));
    $('#cmp-diary-chat')?.addEventListener('change', async (e) => { view.diaryChat = e.target.value; view.openDate = ''; await loadDiary(); render(); });
    document.querySelectorAll('[data-day]').forEach((btn) => btn.addEventListener('click', () => { view.openDate = btn.dataset.day; render(); }));
    const write = async (btn, date) => {
      btn.disabled = true; btn.textContent = '写日记中…';
      try {
        const r = await api('/api/ext/companion/diary/write', { method: 'POST', body: JSON.stringify({ chatKey: view.diaryChat, date }) });
        view.openDate = r.entry?.date || '';
        await loadDiary(); render();
      } catch (error) { btn.disabled = false; btn.textContent = `失败：${error.message}`.slice(0, 50); }
    };
    $('#cmp-diary-write')?.addEventListener('click', (e) => write(e.target, ''));
    document.querySelectorAll('[data-rewrite]').forEach((btn) => btn.addEventListener('click', () => write(btn, btn.dataset.rewrite)));
    document.querySelectorAll('[data-del]').forEach((btn) => btn.addEventListener('click', async () => {
      if (!await askForConfirmation(`删除 ${btn.dataset.del} 的日记？`)) return;
      await api('/api/ext/companion/diary', { method: 'DELETE', body: JSON.stringify({ chatKey: view.diaryChat, date: btn.dataset.del }) });
      await loadDiary(); render();
    }));
  }

  extOnTab('ext-companion', load);
})();

'use strict';

// 大肥鱼桥页面（扩展功能）：连接设置、连通性测试、手动派发、任务列表（输出/刷新/取消）、实验室电脑端部署说明。

import { api } from './core/api.js';
import { askForConfirmation } from './core/dom-util.js';
import { $, esc } from './core/dom.js';
import { formatChatTitle } from './core/format.js';
import { extChatOptions, extFlash, extFmtTime, extHead, extLoadChats, extOnTab, extStat } from './ext-kit.js';

(function labBridgePage() {
  const view = { data: null, chats: [], openTask: 0, timer: null };
  const STATE = {
    dispatching: ['派发中', 'warn'],
    running: ['运行中', 'star'],
    succeeded: ['完成', 'ok'],
    failed: ['失败', 'bad'],
    cancelled: ['已取消', ''],
    unknown: ['结果未知', 'warn']
  };

  async function load() {
    const box = $('#ext-lab-page');
    if (!box) return;
    if (!view.data) box.innerHTML = '<div class="empty-hint">正在读取…</div>';
    try {
      const [data, chats] = await Promise.all([api('/api/ext/lab-bridge'), extLoadChats()]);
      view.data = data;
      view.chats = chats;
      render();
      // 有在跑的任务时，停在这页就每 5 秒刷新一次
      clearTimeout(view.timer);
      if (data.running > 0 && document.querySelector('#view-ext-lab.active')) view.timer = setTimeout(load, 5000);
    } catch (error) {
      box.innerHTML = `<div class="empty-hint">读取失败：${esc(error.message)}</div>`;
    }
  }

  function stateChip(s) {
    const [label, cls] = STATE[s] || [s, ''];
    return `<span class="chip ${cls === 'bad' ? 'lab-bad' : cls}">${esc(label)}</span>`;
  }

  function render() {
    const box = $('#ext-lab-page');
    const c = view.data?.config || {};
    const tasks = view.data?.tasks || [];
    const ownerChat = (view.chats || []).filter((x) => String(x.key).startsWith('private:'));
    box.innerHTML = `
      ${extHead({
        icon: '🐟', title: '大肥鱼桥', toggleId: 'lab-enabled', enabled: c.enabled,
        sub: '让机器人把管理员在 QQ 里交代的活派给<strong>实验室电脑上的 DeepSeek Harness</strong>，跑完把结果发回来。'
          + '只认管理员本人的指令；派发结果不确定时<strong>不会自动重试</strong>（免得同一件事在实验室电脑上执行两遍）。'
      })}
      <div class="ext-stats">
        ${extStat('连接', c.configured ? '已配置' : '未配置')}
        ${extStat('协议', c.protocol === 'openai' ? 'OpenAI 兼容' : '任务协议')}
        ${extStat('可用场合', c.privateOnly ? '仅管理员私聊' : '私聊 + 群聊')}
        ${extStat('进行中', view.data?.running ?? 0)}
      </div>

      <details class="ext-card" ${c.configured ? '' : 'open'}>
        <summary>连接设置</summary>
        <div class="field-row">
          <div class="field"><label>显示名</label><input type="text" id="lab-name" value="${esc(c.name || '实验室电脑')}" maxlength="30" /></div>
          <div class="field"><label>对接协议</label>
            <select id="lab-protocol">
              <option value="task" ${c.protocol !== 'openai' ? 'selected' : ''}>任务协议（推荐，配合 lab-bridge-agent.mjs）</option>
              <option value="openai" ${c.protocol === 'openai' ? 'selected' : ''}>OpenAI 兼容 /chat/completions（同步）</option>
            </select></div>
        </div>
        <div class="field-row">
          <div class="field" style="flex:2"><label>服务地址</label><input type="text" id="lab-base" value="${esc(c.baseUrl || '')}" placeholder="http://127.0.0.1:8790（SSH 反向隧道）" /></div>
          <div class="field"><label>令牌</label><input type="password" id="lab-token" value="${c.hasToken ? '******' : ''}" placeholder="留空/掩码 = 保持原值" autocomplete="new-password" /></div>
        </div>
        <div class="field-row lab-openai-only ${c.protocol === 'openai' ? '' : 'hidden'}">
          <div class="field"><label>model 字段</label><input type="text" id="lab-model" value="${esc(c.model || '')}" placeholder="harness 不看可留空" /></div>
          <div class="field" style="flex:2"><label>system 提示（可选）</label><input type="text" id="lab-system" value="${esc(c.systemPrompt || '')}" /></div>
        </div>
        <div class="field-row">
          <div class="field"><label>每小时最多派发</label><input type="number" id="lab-hour" min="1" max="120" value="${esc(c.maxPerHour ?? 10)}" /></div>
          <div class="field"><label>单个任务最长等（分钟）</label><input type="number" id="lab-timeout" min="1" max="1440" value="${esc(c.timeoutMinutes ?? 30)}" /></div>
          <div class="field"><label>轮询间隔（秒）</label><input type="number" id="lab-poll" min="2" max="120" value="${esc(c.pollSeconds ?? 5)}" /></div>
          <div class="field"><label>回报最多字数</label><input type="number" id="lab-report-chars" min="100" max="3000" value="${esc(c.reportMaxChars ?? 900)}" /></div>
        </div>
        <div class="checkbox-row"><input type="checkbox" id="lab-private" ${c.privateOnly !== false ? 'checked' : ''} /><label for="lab-private">只在与管理员的私聊里可用（推荐；关掉后群里管理员也能派活，但同批消息混进别人的话一律拒绝）</label></div>
        <div class="checkbox-row"><input type="checkbox" id="lab-report" ${c.reportBack !== false ? 'checked' : ''} /><label for="lab-report">任务结束后把结果摘要发回下指令的会话</label></div>
        <div class="ext-actions">
          <button class="btn btn-primary" id="lab-save">保存设置</button>
          <button class="btn" id="lab-ping">测试连接</button>
          <span class="ext-flash" id="lab-flash"></span>
        </div>
      </details>

      <details class="ext-card">
        <summary>实验室电脑端怎么装（3 步）</summary>
        <ol class="lab-steps">
          <li>把仓库里的 <code>scripts/lab-bridge-agent.mjs</code> 拷到实验室电脑（只要装了 Node 18+，零依赖）。</li>
          <li>设好令牌与执行命令后启动（<code>{prompt}</code> 会被替换成任务文本；不写就从 stdin 传入）：
            <pre>LAB_BRIDGE_TOKEN=与上面一致的长随机串 \\
LAB_BRIDGE_CMD='你的 harness 命令 {prompt}' \\
LAB_BRIDGE_WORKDIR=~/lab \\
node lab-bridge-agent.mjs</pre>
            Windows PowerShell：<code>$env:LAB_BRIDGE_TOKEN="…"; $env:LAB_BRIDGE_CMD="…"; node lab-bridge-agent.mjs</code></li>
          <li>从实验室电脑打一条反向隧道到服务器（服务器不用开端口），然后上面的服务地址填 <code>http://127.0.0.1:8790</code>：
            <pre>ssh -N -R 8790:127.0.0.1:8790 用户@服务器</pre></li>
        </ol>
        <div class="hint">harness 自己就有 OpenAI 兼容接口的话，也可以选「OpenAI 兼容」协议直接连，不用这个脚本（但任务不能取消、重启后无法续接）。</div>
      </details>

      <div class="ext-card">
        <div class="ext-card-title">手动派一个任务</div>
        <div class="field"><textarea id="lab-prompt" rows="3" placeholder="例如：到 ~/exp/run42 下看一下 train.log 最后 50 行，告诉我 loss 有没有收敛"></textarea></div>
        <div class="ext-actions">
          <label class="muted">结果发到 <select id="lab-report-to" class="ext-inline">${extChatOptions(ownerChat, '', { placeholder: '不发（只在这里看）' })}</select></label>
          <button class="btn btn-primary" id="lab-dispatch" ${c.configured ? '' : 'disabled'}>派发…</button>
          <span class="ext-flash" id="lab-run-flash"></span>
        </div>
      </div>

      <div class="ext-card">
        <div class="ext-card-title">任务 <span class="muted">（最近 30 个）</span><span class="spacer"></span><button class="btn btn-small" id="lab-reload">刷新</button></div>
        ${tasks.length ? `<div class="lab-tasks">${tasks.map(renderTask).join('')}</div>` : '<div class="ext-empty">还没有派过任务。</div>'}
      </div>`;
    bind();
  }

  function renderTask(t) {
    const open = view.openTask === t.id;
    const active = ['dispatching', 'running'].includes(t.state);
    return `
      <div class="lab-task ${open ? 'open' : ''}" data-id="${t.id}">
        <div class="lab-task-head" data-act="toggle">
          <span class="lab-task-id">#${t.id}</span>
          ${stateChip(t.state)}
          <span class="lab-task-prompt">${esc(t.prompt.slice(0, 120))}</span>
          <span class="muted lab-task-meta">${t.via === 'console' ? '控制台' : esc(formatChatTitle(t.chatKey))} · ${extFmtTime(t.createdAt)}</span>
        </div>
        ${open ? `
          <div class="lab-task-body">
            <div class="muted">任务：</div><pre>${esc(t.prompt)}</pre>
            ${t.error ? `<div class="lab-err">${esc(t.error)}</div>` : ''}
            <div class="muted">输出${active ? '（运行中，实时刷新）' : ''}：</div>
            <pre class="lab-output">${esc(t.output || '（暂无输出）')}</pre>
            <div class="ext-actions">
              ${t.protocol === 'task' && t.remoteId ? '<button class="btn btn-small" data-act="refresh">从实验室电脑刷新状态</button>' : ''}
              ${active && t.protocol === 'task' && t.remoteId ? '<button class="btn btn-small btn-danger" data-act="cancel">取消</button>' : ''}
            </div>
          </div>` : ''}
      </div>`;
  }

  function collect() {
    return {
      enabled: $('#lab-enabled').checked,
      name: $('#lab-name').value.trim(),
      protocol: $('#lab-protocol').value,
      baseUrl: $('#lab-base').value.trim(),
      token: $('#lab-token').value.trim(),
      model: $('#lab-model').value.trim(),
      systemPrompt: $('#lab-system').value.trim(),
      maxPerHour: Number($('#lab-hour').value),
      timeoutMinutes: Number($('#lab-timeout').value),
      pollSeconds: Number($('#lab-poll').value),
      reportMaxChars: Number($('#lab-report-chars').value),
      privateOnly: $('#lab-private').checked,
      reportBack: $('#lab-report').checked
    };
  }

  function bind() {
    const save = async () => {
      try {
        await api('/api/ext/lab-bridge/config', { method: 'POST', body: JSON.stringify({ config: collect() }) });
        extFlash($('#lab-flash'), '已保存', 'ok');
        await load();
      } catch (error) { extFlash($('#lab-flash'), `保存失败：${error.message}`, 'bad'); }
    };
    $('#lab-enabled')?.addEventListener('change', save);
    $('#lab-save')?.addEventListener('click', save);
    $('#lab-protocol')?.addEventListener('change', (ev) => {
      document.querySelectorAll('.lab-openai-only').forEach((el) => el.classList.toggle('hidden', ev.target.value !== 'openai'));
    });
    $('#lab-ping')?.addEventListener('click', async () => {
      extFlash($('#lab-flash'), '连接中…');
      try {
        const r = await api('/api/ext/lab-bridge/ping', { method: 'POST', body: '{}' });
        extFlash($('#lab-flash'), r.ok ? `连通（${r.ms} ms）${r.info?.name ? ` · ${r.info.name}` : ''}${r.info?.busy ? ' · 正忙' : ''}` : r.error, r.ok ? 'ok' : 'bad');
      } catch (error) { extFlash($('#lab-flash'), error.message, 'bad'); }
    });
    $('#lab-reload')?.addEventListener('click', load);
    $('#lab-dispatch')?.addEventListener('click', async () => {
      const prompt = $('#lab-prompt').value.trim();
      if (!prompt) return extFlash($('#lab-run-flash'), '先写任务内容', 'bad');
      if (!(await askForConfirmation(`在「${view.data?.config?.name || '实验室电脑'}」上执行这个任务？\n\n${prompt.slice(0, 300)}`))) return;
      try {
        const r = await api('/api/ext/lab-bridge/dispatch', { method: 'POST', body: JSON.stringify({ prompt, reportTo: $('#lab-report-to').value, confirm: true }) });
        view.openTask = r.task?.id || 0;
        extFlash($('#lab-run-flash'), r.ok ? `已派发 #${r.task.id}` : (r.task?.error || '派发失败'), r.ok ? 'ok' : 'bad');
        $('#lab-prompt').value = '';
        await load();
      } catch (error) { extFlash($('#lab-run-flash'), error.message, 'bad'); }
    });
    document.querySelector('#ext-lab-page .lab-tasks')?.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('[data-act]');
      const item = ev.target.closest('.lab-task');
      if (!btn || !item) return;
      const id = Number(item.dataset.id);
      if (btn.dataset.act === 'toggle') { view.openTask = view.openTask === id ? 0 : id; render(); return; }
      if (btn.dataset.act === 'cancel' && !(await askForConfirmation(`取消任务 #${id}？实验室电脑上的进程会被终止。`))) return;
      try {
        await api(`/api/ext/lab-bridge/tasks/${id}/${btn.dataset.act}`, { method: 'POST', body: '{}' });
        await load();
      } catch (error) { extFlash($('#lab-run-flash'), error.message, 'bad'); }
    });
  }

  extOnTab('ext-lab', load);
})();

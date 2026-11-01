'use strict';

// 图片生成页面（扩展功能）：生图功能的总入口 —— 当前服务状态、试画一张、参考图（提示词触发）管理。
// 服务地址 / Key / 模型这些连接设置仍在 设置 → 语音与生图（那里与 TTS 共用一套 Key 归属逻辑），
// 本页给一个直达按钮。参考图的后端：src/extensions/image-refs.js（/api/ext/image-refs*）。

import { api } from './core/api.js';
import { askForConfirmation } from './core/dom-util.js';
import { $, esc } from './core/dom.js';
import { state } from './core/state.js';
import { extFlash, extHead, extOnTab, extStat } from './ext-kit.js';

(function imageGenPage() {
  const view = { data: null, editing: '' };
  const MODE = { auto: '自动（gpt-image / dall-e-2 走图像编辑，其余放进请求体）', body: '放进生图请求体（Seedream / 万相 / 多数网关）', edits: 'OpenAI 图像编辑 /images/edits' };

  async function load() {
    const box = $('#ext-imagegen-page');
    if (!box) return;
    if (!view.data) box.innerHTML = '<div class="empty-hint">正在读取…</div>';
    try {
      view.data = await api('/api/ext/image-refs');
      render();
    } catch (error) {
      box.innerHTML = `<div class="empty-hint">读取失败：${esc(error.message)}</div>`;
    }
  }

  function openSettings() {
    state.settingsSection = 'asr';
    document.querySelector('#tabs .tab[data-tab="settings"]')?.click();
    state.settingsSection = 'asr';
    setTimeout(() => document.getElementById('settings-imagegen')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120);
  }

  function refCard(it) {
    if (view.editing === it.id) {
      return `<article class="ig-ref editing" data-id="${esc(it.id)}">
        <img src="${esc(it.url)}" alt="" loading="lazy" />
        <div class="ig-ref-body">
          <div class="field"><label>名称</label><input type="text" data-f="label" value="${esc(it.label)}" maxlength="30" /></div>
          <div class="field"><label>触发词（逗号分隔）</label><input type="text" data-f="keywords" value="${esc(it.keywords.join('，'))}" /></div>
          <div class="field"><label>给生图模型的说明（可选）</label><input type="text" data-f="hint" value="${esc(it.hint)}" maxlength="200" placeholder="如：银色短发、蓝眼睛、白色连帽衫" /></div>
          <div class="ext-actions"><button class="btn btn-small btn-primary" data-save type="button">保存</button><button class="btn btn-small" data-cancel type="button">取消</button></div>
        </div></article>`;
    }
    return `<article class="ig-ref ${it.enabled ? '' : 'off'}" data-id="${esc(it.id)}">
      <img src="${esc(it.url)}" alt="${esc(it.label)}" loading="lazy" />
      <div class="ig-ref-body">
        <div class="ig-ref-top"><strong>${esc(it.label)}</strong>
          <label class="cmp-check"><input type="checkbox" data-toggle ${it.enabled ? 'checked' : ''} /><span>启用</span></label></div>
        <div class="ig-chips">${it.keywords.map((k) => `<span>${esc(k)}</span>`).join('')}</div>
        ${it.hint ? `<p class="muted">${esc(it.hint)}</p>` : ''}
        <div class="ext-actions">
          <button class="btn btn-small" data-test type="button">用它试画</button>
          <button class="btn btn-small" data-edit type="button">编辑</button>
          <button class="btn btn-small btn-ghost-danger" data-del type="button">删除</button>
        </div>
        <div class="ig-test-out" data-out></div>
      </div></article>`;
  }

  function render() {
    const box = $('#ext-imagegen-page');
    const d = view.data || {};
    const c = d.config || {};
    const g = d.imageGen || {};
    const items = c.items || [];
    box.innerHTML = `
      ${extHead({
        icon: 'image', title: '图片生成', toggleId: 'ig-refs-enabled', enabled: c.enabled,
        sub: '机器人在聊天里被点名"画一张"时会调用生图模型（generate_image 工具，按张计费、有每小时上限）。'
          + '右上角开关管的是<b>参考图触发</b>：对方的话命中触发词（比如"画一下你自己"）时，把你上传的参考图一起交给生图模型，让它照着这个形象画。'
      })}
      <div class="ext-stats">
        ${extStat('生图功能', g.enabled ? '已开启' : '未开启', g.enabled ? '' : '去设置里开')}
        ${extStat('生图模型', g.model || '未填', g.baseUrl ? (() => { try { return new URL(g.baseUrl).host; } catch { return g.baseUrl; } })() : '与聊天模型同一家')}
        ${extStat('参考图', `${items.filter((x) => x.enabled).length} / ${items.length}`, '启用 / 全部')}
        ${extStat('传图方式', { body: '请求体', edits: '图像编辑' }[d.effectiveMode] || '-', c.mode === 'auto' ? '自动判断' : '手动指定')}
      </div>
      <section class="ext-card">
        <div class="ext-card-title">服务与试画<span class="spacer"></span>
          <button class="btn btn-small" id="ig-open-settings" type="button">打开生图设置</button></div>
        <p class="hint" style="margin-top:0">服务预设、地址、Key、模型、尺寸、每小时上限都在 设置 → 语音与生图 的「图片生成」一节。改完保存后可以在这里试画。</p>
        <div class="ig-row">
          <div class="field"><label for="ig-test-prompt">试画提示词</label><input type="text" id="ig-test-prompt" placeholder="一只橘猫戴着草帽坐在海边，卡通风格" maxlength="200" /></div>
          <button class="btn btn-primary" id="ig-test" type="button" ${g.enabled ? '' : 'disabled'} title="${g.enabled ? '' : '先在生图设置里开启并保存'}">试画一张</button>
        </div>
        <div id="ig-test-result" class="ig-test-out"></div>
      </section>
      <section class="ext-card">
        <div class="ext-card-title">参考图（提示词触发）<span class="spacer"></span><span class="muted">最多 12 张 · 每张 ≤ 4 MB</span></div>
        <div class="ig-row ig-row-2">
          <div class="field"><label for="ig-mode">传图方式</label>
            <select id="ig-mode">${Object.entries(MODE).map(([k, label]) => `<option value="${k}" ${c.mode === k ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></div>
          <div class="field"><label for="ig-field">请求体字段名</label><input type="text" id="ig-field" value="${esc(c.bodyField || 'image')}" maxlength="30" /></div>
        </div>
        <label class="cmp-check"><input type="checkbox" id="ig-match-prompt" ${c.matchPrompt !== false ? 'checked' : ''} /><span>触发词也匹配模型写的画面描述（不只看对方原话）</span></label>
        <p class="hint">「请求体」是在 /images/generations 的 JSON 里多带一个 <code>image</code> 字段（data:URL），豆包 Seedream 4.x、通义万相、多数聚合网关认这个；
          OpenAI 的 gpt-image-1 要走「图像编辑」。免 Key 的 pollinations 不支持参考图，会照常按纯文字画。</p>
        <div class="ig-refs">${items.map(refCard).join('') || '<div class="ext-empty">还没有参考图。上传一张角色立绘，触发词填「你自己」「你长什么样」「自拍」，机器人画自己时就会照着画。</div>'}</div>
        <div class="ext-sub">添加参考图</div>
        <div class="ig-add">
          <label class="ig-drop" id="ig-drop"><input type="file" id="ig-file" accept="image/png,image/jpeg,image/webp" hidden /><span id="ig-drop-text">点这里选一张图（PNG / JPEG / WebP）</span></label>
          <div class="ig-add-fields">
            <div class="field"><label>名称</label><input type="text" id="ig-label" placeholder="如：我的形象" maxlength="30" /></div>
            <div class="field"><label>触发词（逗号分隔）</label><input type="text" id="ig-keywords" placeholder="你自己，你长什么样，自拍" /></div>
            <div class="field"><label>给生图模型的说明（可选）</label><input type="text" id="ig-hint" placeholder="如：银色短发、蓝眼睛、白色连帽衫" maxlength="200" /></div>
            <div class="ext-actions"><button class="btn btn-primary" id="ig-add" type="button">添加</button><span class="ext-flash" id="ig-flash"></span></div>
          </div>
        </div>
      </section>`;
    bind();
  }

  const fileToDataUrl = (file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(new Error('读取文件失败'));
    r.readAsDataURL(file);
  });

  async function saveSettings(patch) {
    try {
      await api('/api/ext/image-refs/settings', { method: 'POST', body: JSON.stringify(patch) });
      await load();
    } catch (error) { extFlash($('#ig-flash'), `保存失败：${error.message}`, 'bad'); }
  }

  function bind() {
    $('#ig-open-settings')?.addEventListener('click', openSettings);
    $('#ig-refs-enabled')?.addEventListener('change', (e) => saveSettings({ enabled: e.target.checked }));
    $('#ig-mode')?.addEventListener('change', (e) => saveSettings({ mode: e.target.value }));
    $('#ig-field')?.addEventListener('change', (e) => saveSettings({ bodyField: e.target.value.trim() }));
    $('#ig-match-prompt')?.addEventListener('change', (e) => saveSettings({ matchPrompt: e.target.checked }));
    $('#ig-file')?.addEventListener('change', (e) => {
      const f = e.target.files?.[0];
      const drop = $('#ig-drop');
      if (!f || !drop) return;
      const url = URL.createObjectURL(f);
      drop.style.backgroundImage = `url("${url}")`;
      drop.classList.add('has');
      $('#ig-drop-text').textContent = `${f.name}（${Math.round(f.size / 1024)} KB）`;
    });
    $('#ig-add')?.addEventListener('click', async () => {
      const f = $('#ig-file')?.files?.[0];
      if (!f) return extFlash($('#ig-flash'), '先选一张图', 'bad');
      if (f.size > 4 * 1024 * 1024) return extFlash($('#ig-flash'), '图片太大（上限 4 MB）', 'bad');
      try {
        await api('/api/ext/image-refs', { method: 'POST', body: JSON.stringify({ label: $('#ig-label').value, keywords: $('#ig-keywords').value, hint: $('#ig-hint').value, image: await fileToDataUrl(f) }) });
        await load();
        extFlash($('#ig-flash'), '已添加', 'ok');
      } catch (error) { extFlash($('#ig-flash'), error.message, 'bad'); }
    });
    $('#ig-test')?.addEventListener('click', async (e) => {
      const out = $('#ig-test-result');
      e.target.disabled = true;
      out.textContent = '画图要十几秒到一分钟，稍等…（按张计费）';
      try {
        const r = await api('/api/imagegen/test', { method: 'POST', body: JSON.stringify({ prompt: $('#ig-test-prompt').value }) });
        out.innerHTML = r.ok && r.image ? `<img src="${r.image}" alt="试画结果" />` : esc(r.error || '画图失败');
      } catch (error) { out.textContent = `失败：${error.message}`; }
      finally { e.target.disabled = false; }
    });
    document.querySelectorAll('.ig-ref').forEach((card) => {
      const id = card.dataset.id;
      card.querySelector('[data-toggle]')?.addEventListener('change', async (e) => {
        await api(`/api/ext/image-refs/${id}`, { method: 'POST', body: JSON.stringify({ enabled: e.target.checked }) }).catch(() => {});
        await load();
      });
      card.querySelector('[data-edit]')?.addEventListener('click', () => { view.editing = id; render(); });
      card.querySelector('[data-cancel]')?.addEventListener('click', () => { view.editing = ''; render(); });
      card.querySelector('[data-save]')?.addEventListener('click', async () => {
        const patch = Object.fromEntries([...card.querySelectorAll('[data-f]')].map((i) => [i.dataset.f, i.value]));
        try { await api(`/api/ext/image-refs/${id}`, { method: 'POST', body: JSON.stringify(patch) }); view.editing = ''; await load(); }
        catch (error) { extFlash($('#ig-flash'), error.message, 'bad'); }
      });
      card.querySelector('[data-del]')?.addEventListener('click', async () => {
        if (!await askForConfirmation('删除这张参考图？')) return;
        await api(`/api/ext/image-refs/${id}`, { method: 'DELETE', body: '{}' });
        await load();
      });
      card.querySelector('[data-test]')?.addEventListener('click', async (e) => {
        if (!await askForConfirmation('用这张参考图试画一张？（按张计费）')) return;
        const out = card.querySelector('[data-out]');
        e.target.disabled = true;
        out.textContent = '画图中…';
        try {
          const r = await api(`/api/ext/image-refs/${id}/test`, { method: 'POST', body: JSON.stringify({ confirm: true }) });
          out.innerHTML = r.ok ? `<img src="${r.image}" alt="试画结果" />${r.note ? `<div class="muted">${esc(r.note)}</div>` : ''}` : esc(r.error || '失败');
        } catch (error) { out.textContent = `失败：${error.message}`; }
        finally { e.target.disabled = false; }
      });
    });
  }

  extOnTab('ext-imagegen', load);
})();

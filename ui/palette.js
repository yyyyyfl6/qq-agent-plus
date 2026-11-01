'use strict';

// 配色方案（与明暗主题正交）：<html data-palette="…"> 决定一套底色/描边/强调色，
// data-theme 仍决定明暗 —— 每套配色都有暗色与亮色两版（见 style.css「配色方案」）。
// 选择保存在 localStorage（即时生效、首屏由 index.html 的预置脚本应用，不闪）
// 并同步到后端 config.ui.palette（换设备/清缓存后还在）。
// UI 入口：设置 → 系统 → 界面，「主题」下面一行色卡。

import { api } from './core/api.js';
import { esc } from './core/dom.js';
import { QARegistry } from './core/registry.js';
import { state } from './core/state.js';

(function paletteSwitcher() {
  const PALETTES = [
    { id: 'graphite', name: '石墨紫', desc: '中性灰 · 柔和紫', swatch: ['#15161a', '#8b7cf6'] },
    { id: 'ocean', name: '深海蓝', desc: '原版海军蓝', swatch: ['#111b2d', '#4c8dff'] },
    { id: 'mint', name: '薄荷', desc: '墨绿 · 薄荷绿', swatch: ['#121b18', '#34d399'] },
    { id: 'sakura', name: '樱花', desc: '深梅 · 樱花粉', swatch: ['#1c1419', '#f472b6'] },
    { id: 'amber', name: '琥珀', desc: '暖棕 · 琥珀橙', swatch: ['#1b1712', '#f5a524'] },
    { id: 'midnight', name: '极夜', desc: '纯黑 · 青色（OLED）', swatch: ['#0a0a0b', '#22d3ee'] }
  ];
  const IDS = new Set(PALETTES.map((p) => p.id));

  function current() {
    const v = document.documentElement.getAttribute('data-palette') || 'graphite';
    return IDS.has(v) ? v : 'graphite';
  }

  function apply(id, { persist = true, sync = true } = {}) {
    const next = IDS.has(id) ? id : 'graphite';
    document.documentElement.setAttribute('data-palette', next);
    if (persist) { try { localStorage.setItem('qqa-palette', next); } catch { /* 隐私模式 */ } }
    if (sync) {
      api('/api/config', { method: 'POST', body: JSON.stringify({ ui: { palette: next } }) })
        .then(() => { if (state.config?.ui) state.config.ui.palette = next; })
        .catch(() => { /* 本机已生效；后端同步失败下次再说 */ });
    }
    document.querySelectorAll('.palette-option').forEach((el) => el.classList.toggle('on', el.dataset.palette === next));
  }

  function pickerHtml() {
    const cur = current();
    return `
      <div class="field" id="palette-field"><label>配色方案（每套都有明暗两版，跟上面的主题一起生效）</label>
        <div class="palette-picker" role="radiogroup" aria-label="配色方案">
          ${PALETTES.map((p) => `
            <button type="button" class="palette-option${p.id === cur ? ' on' : ''}" data-palette="${p.id}" role="radio" aria-checked="${p.id === cur}">
              <svg class="palette-swatch" viewBox="0 0 40 40" aria-hidden="true">
                <circle cx="20" cy="20" r="18" fill="${p.swatch[0]}" />
                <path d="M20 2 A18 18 0 0 1 20 38 Z" fill="${p.swatch[1]}" />
                <circle cx="20" cy="20" r="18" fill="none" stroke="rgba(127,127,127,.25)" stroke-width="1" />
              </svg>
              <span class="palette-copy"><strong>${esc(p.name)}</strong><small>${esc(p.desc)}</small></span>
              <svg class="palette-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
            </button>`).join('')}
        </div>
      </div>`;
  }

  function mount() {
    // 后端存的配色：本机没有显式选择时以它为准（换设备后的第一次进入）
    const serverPalette = state.config?.ui?.palette;
    let local = '';
    try { local = localStorage.getItem('qqa-palette') || ''; } catch { /* 忽略 */ }
    if (serverPalette && IDS.has(serverPalette)) {
      try { localStorage.setItem('qqa-palette-server', serverPalette); } catch { /* 忽略 */ }
      if (!local && serverPalette !== current()) apply(serverPalette, { persist: false, sync: false });
    }
    if (state.settingsSection !== 'desktop') return;
    const themeField = document.querySelector('#theme-picker')?.closest('.field');
    if (!themeField || document.querySelector('#palette-field')) return;
    themeField.insertAdjacentHTML('afterend', pickerHtml());
    document.querySelector('#palette-field .palette-picker')?.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.palette-option');
      if (btn) apply(btn.dataset.palette);
    });
  }

  QARegistry.onAfter('renderSettings', mount);
})();

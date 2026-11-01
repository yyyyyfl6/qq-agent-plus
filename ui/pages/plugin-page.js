// 插件详情里的「插件页面」（插件接口 v3 的 page 能力）。
//
// 安全模型：插件给的 HTML 放进 <iframe sandbox="allow-scripts" srcdoc>：
//   · 没有 allow-same-origin → 页面是 opaque origin，读不到控制台的 localStorage / cookie / 令牌；
//   · 宿主在最前面注入 CSP（default-src 'none'，只放行内联脚本 / 样式与 data: 图片）→ 页面发不出任何网络请求；
//   · 页面唯一的出口是注入的 window.qqa.call(method, params)：postMessage 给这里，这里校验来源窗口后
//     调 /api/plugins/page-rpc —— 只能调**它自己**的插件，不能碰宿主的其它接口。
// 主题：这里把控制台当前的 CSS 变量传进去（qqa.onTheme），插件页面跟着明暗 / 配色走。
import { api } from '../core/api.js';
import { esc } from '../core/dom.js';

const THEME_VARS = ['--bg', '--bg-2', '--bg-3', '--text', '--muted', '--faint', '--border', '--accent', '--accent-fg', '--red', '--green', '--amber', '--hover',
  '--r-sm', '--r-md', '--r-lg', '--r-card', '--r-pill', '--fs-2xs', '--fs-xs', '--fs-sm', '--fs-md', '--fs-lg', '--fs-xl', '--fs-2xl', '--mono', '--shadow-sm'];

const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:";

// 注入到插件页面里的桥（在插件自己的脚本之前执行）
const BRIDGE = `<script>(function(){
  var seq=0, waits={}, themeCbs=[], theme=null;
  window.addEventListener('message', function(e){
    if (e.source !== window.parent) return;
    var m = e.data || {};
    if (m.qqa === 'rpc-result' && waits[m.id]) { var w = waits[m.id]; delete waits[m.id]; m.ok ? w.resolve(m.result) : w.reject(new Error(m.error || '调用失败')); }
    if (m.qqa === 'theme') { theme = m; var r = document.documentElement; Object.keys(m.vars||{}).forEach(function(k){ r.style.setProperty(k, m.vars[k]); }); r.setAttribute('data-theme', m.mode||'light'); themeCbs.forEach(function(cb){ try{cb(m);}catch(_){} }); }
  });
  self.qqa = {
    call: function(method, params){ return new Promise(function(resolve, reject){ var id = ++seq; waits[id] = {resolve:resolve, reject:reject}; window.parent.postMessage({qqa:'rpc', id:id, method:String(method), params:params||{}}, '*'); setTimeout(function(){ if (waits[id]) { delete waits[id]; reject(new Error('超时')); } }, 90000); }); },
    onTheme: function(cb){ themeCbs.push(cb); if (theme) cb(theme); },
    resize: function(h){ window.parent.postMessage({qqa:'resize', height: Number(h)||0}, '*'); }
  };
  new ResizeObserver(function(){ self.qqa.resize(document.documentElement.scrollHeight); }).observe(document.documentElement);
})();</script>`;

function pageBlockHtml(own) {
  const page = own?.manifest?.page;
  if (!page || !own?.installed) return '';
  return `<div class="pd-block plugin-page-block" data-pd-page="${esc(own.id)}">
    <h4 class="pd-block-title">${esc(page.title || '插件页面')}</h4>
    <div class="plugin-page-body"><span class="plugin-note">正在打开插件页面…</span></div>
  </div>`;
}

function themeMessage() {
  const cs = getComputedStyle(document.documentElement);
  const vars = {};
  for (const name of THEME_VARS) {
    const v = cs.getPropertyValue(name).trim();
    if (v) vars[name] = v;
  }
  return { qqa: 'theme', mode: document.documentElement.getAttribute('data-theme') || 'light', vars };
}

let listening = false;
const frames = new Map();   // iframe.contentWindow -> pluginId

function ensureListener() {
  if (listening) return;
  listening = true;
  window.addEventListener('message', async (event) => {
    const pluginId = frames.get(event.source);
    if (!pluginId) return;                     // 只认我们自己建的那几个 iframe
    const m = event.data || {};
    if (m.qqa === 'resize') {
      for (const frame of document.querySelectorAll('iframe.plugin-page-frame')) {
        if (frame.contentWindow === event.source) frame.style.height = `${Math.max(360, Math.min(4000, Number(m.height) || 0) + 8)}px`;
      }
      return;
    }
    if (m.qqa !== 'rpc') return;
    const reply = (payload) => { try { event.source.postMessage({ qqa: 'rpc-result', id: m.id, ...payload }, '*'); } catch { /* 页面已关 */ } };
    try {
      const r = await api('/api/plugins/page-rpc', { method: 'POST', body: JSON.stringify({ id: pluginId, method: String(m.method || ''), params: m.params || {} }) });
      reply(r?.ok ? { ok: true, result: r.result } : { ok: false, error: r?.error || '调用失败' });
    } catch (error) {
      reply({ ok: false, error: String(error?.message || error) });
    }
  });
  // 控制台换明暗 / 配色时同步给所有插件页面
  new MutationObserver(() => {
    const msg = themeMessage();
    for (const win of frames.keys()) { try { win.postMessage(msg, '*'); } catch { /* 已关 */ } }
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] });
}

async function hydratePluginPage(id) {
  const block = document.querySelector(`[data-pd-page="${CSS.escape(String(id))}"]`);
  if (!block) return;
  const body = block.querySelector('.plugin-page-body');
  try {
    const r = await api(`/api/plugins/page?id=${encodeURIComponent(id)}`);
    if (!r?.ok) throw new Error(r?.error || '打不开');
    ensureListener();
    for (const win of [...frames.keys()]) if (!win || win.closed) frames.delete(win);
    const frame = document.createElement('iframe');
    frame.className = 'plugin-page-frame';
    frame.setAttribute('sandbox', 'allow-scripts allow-modals');   // allow-modals：页面里的「删除？」确认框；不给 same-origin / forms / popups
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('title', r.title || '插件页面');
    // 先挂进 DOM 并登记窗口，再设 srcdoc：页面脚本可能在 load 之前就发起 RPC
    // （WindowProxy 跨导航不变，所以登记的就是之后那页的窗口）
    body.replaceChildren(frame);
    frames.set(frame.contentWindow, String(id));
    frame.addEventListener('load', () => {
      try { frame.contentWindow.postMessage(themeMessage(), '*'); } catch { /* 忽略 */ }
    });
    frame.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${CSP}"><meta charset="utf-8">${BRIDGE}${r.html}`;
  } catch (error) {
    body.innerHTML = `<span class="plugin-note bad">插件页面打不开：${esc(String(error?.message || error))}</span>`;
  }
}

export { hydratePluginPage, pageBlockHtml };

// 控制台图标集（2026-10-08）：**内联 SVG，不用 emoji**。
//
// 为什么换掉 emoji：导航与主题按钮原来用 💬🗂🎛🧠… 这类字符图标 —— 它们在 Windows/macOS/
// Linux 上是三套不同形状（同一个 emoji 在不同系统里胖瘦不一），和界面的线性视觉也不搭，
// 而且没法跟着文字颜色走（emoji 自带配色）。线性 SVG 只做一件事：一条 currentColor 描边，
// 尺寸/粗细/颜色全部由 CSS 决定，明暗主题与选中态天然一致。
//
// 用法：容器上写 `data-icon="chat"`，启动时 applyIcons() 会往里塞 `<span class="ico">`；
// 动态渲染出来的节点再调一次 applyIcons(该节点) 即可（重复调用是幂等的）。
'use strict';

/** 24×24 视窗、纯描边路径（stroke=currentColor，fill=none）。 */
const PATHS = {
  // ── 导航 ──
  chat: '<path d="M20 15a2 2 0 0 1-2 2H8l-4 3.2V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z"/><path d="M8 8.5h8M8 12h5"/>',
  archive: '<rect x="3" y="4" width="18" height="4" rx="1.2"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/>',
  sliders: '<path d="M4 8h9M19 8h1"/><circle cx="15.5" cy="8" r="2.2"/><path d="M4 16h3M13 16h7"/><circle cx="9.5" cy="16" r="2.2"/>',
  database: '<ellipse cx="12" cy="6.5" rx="7.5" ry="3"/><path d="M4.5 6.5v11c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-11"/><path d="M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3"/>',
  brain: '<path d="M9 5.1A3.5 3.5 0 0 0 3.6 8a3.1 3.1 0 0 0 .5 5.7A3.7 3.7 0 0 0 8 19.5c1.5 0 2.8-.9 3.4-2.2"/><path d="M15 5.1A3.5 3.5 0 0 1 20.4 8a3.1 3.1 0 0 1-.5 5.7A3.7 3.7 0 0 1 16 19.5c-1.5 0-2.8-.9-3.4-2.2"/><path d="M12 4v16M8.2 8.5h3.8M12 12h3.8M8.2 15.5H12"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M2.8 20a6.2 6.2 0 0 1 12.4 0"/><path d="M16.4 5.4a3.2 3.2 0 0 1 0 5.3"/><path d="M18.2 14.3A6.2 6.2 0 0 1 21.2 20"/>',
  idcard: '<rect x="2.5" y="5" width="19" height="14" rx="2.2"/><circle cx="8.2" cy="11" r="2"/><path d="M5 16.4a3.4 3.4 0 0 1 6.4 0"/><path d="M14 10h5M14 13.5h5"/>',
  userplus: '<circle cx="10" cy="8" r="3.3"/><path d="M3.2 20a6.8 6.8 0 0 1 13.6 0"/><path d="M18.6 7v6M15.6 10h6"/>',
  activity: '<path d="M3 12.5h3.6L9.4 5l5 14 2.4-6.5H21"/>',
  coins: '<ellipse cx="12" cy="7" rx="7" ry="3"/><path d="M5 7v10c0 1.7 3.1 3 7 3s7-1.3 7-3V7"/><path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>',
  alert: '<path d="M12 4.2 3 19.8h18z"/><path d="M12 10v4.4M12 17.2h.01"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.4M12 18.6V21M4.3 7.6l2.1 1.2M17.6 15.2l2.1 1.2M4.3 16.4l2.1-1.2M17.6 8.8l2.1-1.2"/>',
  // ── 总览/状态 ──
  gauge: '<path d="M4.5 17.5a8.5 8.5 0 1 1 15 0"/><path d="M12 12.5 15.5 9"/><circle cx="12" cy="17.5" r="1"/>',
  signal: '<path d="M4 19v-3.5M9.3 19v-7M14.7 19V8M20 19V4.5"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="10" y="10" width="4" height="4" rx="1"/><path d="M9.5 3v3M14.5 3v3M9.5 18v3M14.5 18v3M3 9.5h3M3 14.5h3M18 9.5h3M18 14.5h3"/>',
  disk: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.6 12h16.8M12 3.5c2.6 2.6 2.6 14.4 0 17M12 3.5c-2.6 2.6-2.6 14.4 0 17"/>',
  chip: '<rect x="4" y="6" width="16" height="12" rx="2"/><path d="M8 10h4M8 14h8"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.4V12l3.4 2.1"/>',
  shield: '<path d="M12 3.5 5 6v6c0 4.2 3 7.4 7 8.5 4-1.1 7-4.3 7-8.5V6z"/><path d="M9 12.2l2.2 2.2L15.4 10"/>',
  // ── 侧栏 ──
  pin: '<path d="M9.4 4h5.2l-.7 5.3 3.2 3.2H6.9l3.2-3.2z"/><path d="M12 12.5V20"/>',
  // ── 主题 ──
  moon: '<path d="M20.2 14.6A8.6 8.6 0 1 1 9.4 3.8a7 7 0 0 0 10.8 10.8z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5V5M12 19v2.5M2.5 12H5M19 12h2.5M5.2 5.2l1.8 1.8M17 17l1.8 1.8M5.2 18.8 7 17M17 7l1.8-1.8"/>',
  monitor: '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M9 20h6M12 17v3"/>',
  // ── 动作/杂项 ──
  search: '<circle cx="11" cy="11" r="6"/><path d="M15.4 15.4 21 21"/>',
  refresh: '<path d="M20 11.5A8 8 0 1 0 17.6 17"/><path d="M20.5 5.5v6h-6"/>',
  check: '<path d="M4.5 12.5 9.7 17.7 19.5 6.8"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  chevron: '<path d="M6.5 9.5 12 15l5.5-5.5"/>',
  play: '<path d="M7 4.6v14.8L19.5 12z"/>',
  pause: '<path d="M8.6 5v14M15.4 5v14"/>',
  zap: '<path d="M13.5 2.5 5 13.6h5.4L9.6 21.5 18.5 10.4h-5.6z"/>',
  file: '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M14 3.5V8h4.5"/>',
  link: '<path d="M14.5 4.5H19.5v5"/><path d="M19.5 4.5 11 13"/><path d="M18.5 14.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1h4.5"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  download: '<path d="M12 3.8v11"/><path d="M7.6 10.4 12 14.8l4.4-4.4"/><path d="M4.8 19.5h14.4"/>',
  upload: '<path d="M12 14.2V3.4"/><path d="M7.6 7.8 12 3.4l4.4 4.4"/><path d="M4.8 19.5h14.4"/>',
  trash: '<path d="M4 7h16"/><path d="M9.5 7V4.8h5V7"/><path d="M6.4 7l.9 12.2a1 1 0 0 0 1 .8h7.4a1 1 0 0 0 1-.8L17.6 7"/>',
  filter: '<path d="M4 5.5h16l-6.2 7.4v5.6l-3.6 2v-7.6z"/>',
  image: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="M4 17l4.8-4.2 3.4 3 3-2.6L20 17"/>',
  sparkles: '<path d="M12 3.5l1.7 4.3L18 9.5l-4.3 1.7L12 15.5l-1.7-4.3L6 9.5l4.3-1.7z"/><path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  // ── 外观面板（2026-10-08 v3）──
  palette: '<path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.2 0 1.9-.8 1.9-1.8 0-.5-.2-.9-.5-1.2-.3-.3-.4-.7-.4-1.1 0-1 .8-1.8 1.8-1.8h1.4A4.8 4.8 0 0 0 21 9.8C21 6.3 17 3.5 12 3.5z"/><circle cx="7.6" cy="10.4" r="1.2"/><circle cx="11.4" cy="7.4" r="1.2"/><circle cx="16" cy="9.4" r="1.2"/>',
  type: '<path d="M5 6.5V5h14v1.5"/><path d="M12 5v14"/><path d="M9 19h6"/>',
  layout: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9.5h18M9 9.5V20"/>',
  droplet: '<path d="M12 3.5c3.2 3.6 5.5 6.5 5.5 9.3a5.5 5.5 0 0 1-11 0C6.5 10 8.8 7.1 12 3.5z"/>',
  // 材质轴（外观 · 液态玻璃）用的：叠起来的三层，读作“层次/厚度”。
  // 不从 droplet（背景卡在用）里借，两张卡挨在一起时同一个图标会分不清哪张是哪张。
  layers: '<path d="M12 3.2 3.4 7.8 12 12.4l8.6-4.6z"/><path d="M3.4 12.4 12 17l8.6-4.6"/><path d="M3.4 16.6 12 21.2l8.6-4.6"/>',
  accessibility: '<circle cx="12" cy="4.8" r="1.9"/><path d="M4.8 8.6h14.4"/><path d="M12 8.6v5.6"/><path d="M8.4 20.4 12 14.2l3.6 6.2"/>',
  undo: '<path d="M4.5 8.5h9a5.5 5.5 0 0 1 0 11H9"/><path d="M8 4.5 4.5 8.5 8 12.5"/>'
};

/**
 * 取一段 `<svg>` 字符串。size 默认 18（侧栏与卡片头用）；颜色跟随 currentColor。
 * 名字不认识时返回空串（并在控制台留一行警告，免得静默丢图标）。
 */
function iconSvg(name, { size = 18, cls = '' } = {}) {
  const path = PATHS[String(name || '')];
  if (!path) {
    if (name) console.warn(`[icons] 没有这个图标：${name}`);
    return '';
  }
  // 一律带上 `ico-svg`：SVG 的默认样式是 fill:black / stroke:none，而"描边 + 跟 currentColor"
  // 这套样式原来只挂在 `.ico svg` 上 —— 凡是不走 applyIcons 包装的直接调用（总览的 KPI 与卡片头、
  // 刷新按钮、顶栏主题按钮）就渲染成**黑色实心块**：深色下与卡片 1.22:1，等于看不见
  //（2026-10-08 用户反馈"总览卡片符号看不清"查到的就是它）。给 SVG 自带类，任何用法都不会漏。
  const clsAttr = ` class="${['ico-svg', cls].filter(Boolean).join(' ')}"`;
  return `<svg${clsAttr} viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false">${path}</svg>`;
}

/**
 * 把 root 里所有 `[data-icon]` 塞成 `<span class="ico">…</span>`（幂等：已有 .ico 就刷新内容）。
 * 传 root 可只处理某个子树（动态渲染后用）。
 */
function applyIcons(root = document) {
  const nodes = root.querySelectorAll ? root.querySelectorAll('[data-icon]') : [];
  for (const el of nodes) {
    const name = el.dataset.icon || '';
    if (!name) continue;
    let holder = el.querySelector(':scope > .ico');
    if (!holder) {
      holder = document.createElement('span');
      holder.className = 'ico';
      el.insertBefore(holder, el.firstChild);
    }
    const svg = iconSvg(name, { size: el.dataset.iconSize ? Number(el.dataset.iconSize) : 18 });
    if (holder.dataset.iconName !== name) {
      holder.innerHTML = svg;
      holder.dataset.iconName = name;
    }
  }
}

export { PATHS, applyIcons, iconSvg };

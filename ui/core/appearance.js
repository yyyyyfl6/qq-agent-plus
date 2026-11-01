// 外观设置模型（2026-10-08 v3，对齐参照控制台的外观页）。
//
// 为什么单独成模块：这些值要在三处用同一份 —— 启动时套到 <html> 上、设置页渲染当前值、
// 保存时算 patch。以前这里只有五项（预设/强调色/圆角/缩放/密度），参照实现有十来项且每一项
// 都能一眼看出差别，所以按同样的轴重新铺开：
//
//   ① mode          明暗（浅色 / 深色 / 跟随系统）
//   ② darkIntensity 深色强度（柔和 / 纯黑 OLED）
//   ③ scheme        表面色板（底/卡/边框/文字，不动强调色）
//   ④ 强调色         预设色 / 自定义色 + 应用范围（全局 / 仅侧栏）+ 侧栏样式
//   ⑤ background    背景（无 / 纯色 / 渐变）
//   ⑥ 排版          字体 / 圆角 / 界面缩放 / 显示密度
//   ⑦ tweaks        逐个覆盖主题颜色变量（白名单，未设置的保持色板默认）
//   ⑧ glass         材质（实心 / 磨砂 / 液态玻璃，见 2026-10-09 新增）
//
// 与前七轴的分工：前七轴决定“什么颜色”，材质轴只决定“表面怎么呈现”（透明度、模糊、
// 高光、阴影）。它不碰任何色板变量 —— 半透明表面永远压在 --bg 之上合成，
// 所以正文/次要文字的对比度仍然是色板那一套。
//
// 分工原则：色板只决定"表面与文字"，强调色只决定"按钮/选中/图表"，两者不互相绑架 ——
// 参照实现把两者揉在一套配色的 primary 里，换配色会连带换掉主色，我们分开更可控。
//
// 纯函数、零依赖：方便单测（hex → rgba 的换算最容易写错）。
'use strict';

/** 我们自己的默认蓝。`应用范围 = 仅侧栏`时全局仍用它，保证按钮不会突然变色。 */
const DEFAULT_ACCENT = '#4c8dff';

const MODES = [
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' },
  { id: 'system', label: '跟随系统' }
];

const DARK_INTENSITIES = [
  { id: 'soft', label: '柔和' },
  { id: 'oled', label: '纯黑 (OLED)' }
];

/** 表面色板：只给"底/卡/边框/文字"四组值，符合"配色方案"的直觉。每套在两种明暗下各一份。 */
const SCHEMES = [
  { id: 'default', label: '默认', hint: '中性蓝灰 · 最深' },
  { id: 'slate', label: '石板', hint: '中性冷灰 · 无彩度' },
  { id: 'rose', label: '玫瑰', hint: '紫调夜蓝' },
  { id: 'forest', label: '青林', hint: '墨绿' },
  { id: 'nord', label: '极地', hint: '北欧蓝 · 最亮' }
];

/** 强调色预设（原来叫"主题配色"，只有五个且和明暗混在一起 —— 现在拆干净）。 */
const ACCENTS = [
  { id: 'sky', label: '天蓝', hex: '#38bdf8' },
  { id: 'indigo', label: '靛蓝', hex: DEFAULT_ACCENT },
  { id: 'violet', label: '紫罗兰', hex: '#a78bfa' },
  { id: 'rose', label: '玫瑰', hex: '#f472b6' },
  { id: 'emerald', label: '翡翠', hex: '#2fd07a' },
  { id: 'amber', label: '琥珀', hex: '#f7b955' },
  { id: 'sunset', label: '夕橙', hex: '#f97316' }
];

const ACCENT_SCOPES = [
  { id: 'global', label: '全局' },
  { id: 'sidebar', label: '仅侧栏' }
];

const SIDEBAR_STYLES = [
  { id: 'follow', label: '跟随背景' },
  { id: 'panel', label: '浅色面板' },
  { id: 'accent', label: '强调色' }
];

const BACKGROUNDS = [
  { id: 'none', label: '无' },
  { id: 'solid', label: '纯色' },
  { id: 'gradient', label: '渐变' }
];

/**
 * 材质：表面是实心还是“玻璃”。
 *
 * 为什么单开一轴而不是并进「背景」：背景决定页面底层长什么样（玻璃要透的就是它），
 * 材质决定上层表面怎么呈现。两者可以任意组合 —— 「渐变背景 + 液态玻璃」才是这套东西
 * 最好看的一档，而“实心表面 + 渐变背景”同样是正当选择（看得清、不炫）。
 *
 * off 不写 data-glass 属性（空串＝不设），CSS 侧就不需要一条单独“关掉玻璃”的规则 ——
 * 这与 sidebarPinned / showBadges 那几个开关的取值口径一致。
 */
const GLASS = [
  { id: 'off', label: '实心', hint: '不透明表面' },
  { id: 'frost', label: '磨砂', hint: '轻微模糊，最克制的一档' },
  { id: 'liquid', label: '液态玻璃', hint: '强模糊 + 提饱和提亮 + 渐变高光边（默认）' },
  { id: 'acrylic', label: '亚克力', hint: '大模糊 + 降饱和 + 细颗粒' },
  { id: 'outline', label: '描边', hint: '几乎不填色，靠一条亮边划出边界' }
];

/**
 * 字体：不引外部字体（离线/内网也要一致），只用各系统都有的族。
 * 具体字体栈写在 ui/style.css 的 html[data-font=...] 里 —— 放在 CSS 有一个实在的好处：
 * 首屏那段内联脚本只要抄一个 data-font 值就行，不必把字体栈也复制一份（少一处会漂移的地方）。
 */
const FONTS = [
  { id: 'default', label: '默认（系统）' },
  { id: 'rounded', label: '圆润' },
  { id: 'serif', label: '衬线' }
];

/** 圆角：四档（与参照实现同样的"紧凑 / 默认 / 舒适 / 圆润"），值就是 --r-scale 倍率。 */
const RADII = [
  { id: 'compact', label: '紧凑', value: 0.6 },
  { id: 'default', label: '默认', value: 1 },
  { id: 'cozy', label: '舒适', value: 1.2 },
  { id: 'round', label: '圆润', value: 1.45 }
];

const DENSITIES = [
  { id: 'cozy', label: '舒适' },
  { id: 'compact', label: '紧凑' },
  { id: 'roomy', label: '宽松' }
];

/**
 * 主题微调白名单：只允许覆盖这几个变量，值必须是合法颜色。
 * 白名单不是洁癖 —— 这些是"表面色"，改坏了界面对比度会崩，但也只是难看、不会不可用；
 * 真正决定可用性的（--hover/--overlay/字体）一律不许覆盖。
 */
const TWEAK_VARS = [
  { key: '--bg', label: '页面背景', hint: '最底层' },
  { key: '--bg-2', label: '卡片 / 侧栏', hint: '表面层' },
  { key: '--bg-3', label: '次级面板', hint: '输入框 / 内嵌块' },
  { key: '--border', label: '边框', hint: '分隔线' },
  { key: '--text', label: '主文字', hint: '标题与正文' },
  { key: '--muted', label: '次要文字', hint: '说明与标签' }
];
const TWEAK_KEYS = TWEAK_VARS.map((v) => v.key);
const TWEAK_SET = new Set(TWEAK_KEYS);

const DEFAULTS = {
  // 项目默认外观 = 浅色 + 液态玻璃（2026-10-19 定版）：新装/清空偏好后的第一眼就是壁纸衬底
  // + 玻璃表面那套。已有用户存过的明暗与材质优先（localStorage / ui.theme），不会被打回。
  mode: 'light',
  darkIntensity: 'soft',
  scheme: 'default',
  accentPreset: 'indigo',
  accent: '',
  accentScope: 'global',
  sidebarStyle: 'follow',
  // 侧栏"悬停展开的图标条"：false = 鼠标移开就收成 64px 图标条、移上去自动展开（参照实现的默认），
  // true = 常驻展开。命名与参照实现一致（它的 appearance.sidebarPinned 就是这个意思）。
  sidebarPinned: false,
  background: 'none',
  // 材质默认液态玻璃：它要透的壁纸随 `background: none` 一起给（见 style.css 的 liquid 衬底）。
  glass: 'liquid',
  // 边缘折射（实验）：默认关。它要按元素尺寸现算位移图并挂 SVG 滤镜，属于「看起来值不值」的功能，
  // 不该默认塞给所有人（原理与三条降级见 ui/core/glass-refract.js 顶部）。
  refract: false,
  bgColor: '#0b1220',
  bgFrom: '#1b2a4a',
  bgTo: '#2e2440',
  bgAngle: 135,
  font: 'default',
  radius: 1,
  zoom: 1,
  density: 'cozy',
  tweaks: {},
  showBadges: true,
  showTopbarTheme: true,
  reduceMotion: false,
  noMotion: false,
  contrast: 'normal'
};

/** 旧版（v2）预设 id → 新版强调色 id。用户已经存过的偏好要接着用，不能一夜回到默认。 */
const LEGACY_PRESETS = { snow: 'indigo', mint: 'emerald', amber: 'amber', violet: 'violet', rose: 'rose' };

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const pick = (list, id, fallback) => (list.some((x) => x.id === id) ? id : fallback);
const firstOf = (list, id) => list.find((x) => x.id === id) || list[0];

/** `#rrggbb` / `#rgb` → {r,g,b}；认不出返回 null。 */
function hexToRgb(hex) {
  const s = String(hex || '').trim().replace(/^#/, '');
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16)
  };
}

/** 规整成 `#rrggbb`（小写），认不出返回 null。 */
function normalizeHex(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const two = (n) => n.toString(16).padStart(2, '0');
  return `#${two(rgb.r)}${two(rgb.g)}${two(rgb.b)}`;
}

/** 强调色的派生色：柔和底（卡片/hover）、描边（选中态边界）、焦点环（半透明）、可读前景色。 */
function accentShades(hex, alphaSoft = 0.12, alphaBorder = 0.36, alphaRing = 0.4) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const { r, g, b } = rgb;
  return {
    accent: hex,
    soft: `rgba(${r}, ${g}, ${b}, ${alphaSoft})`,
    border: `rgba(${r}, ${g}, ${b}, ${alphaBorder})`,
    ring: `rgba(${r}, ${g}, ${b}, ${alphaRing})`,
    fg: readableOn(rgb)
  };
}

/**
 * 压在强调色上的文字该用黑还是白。
 * 参照实现把"深色底配白字"写死，换成琥珀/翡翠这种亮强调色就会白字贴亮底看不清 ——
 * 这里按相对亮度选：深底白字、亮底深字。
 *
 * 阈值取 0.54 而不是数学上"黑字开始更易读"的 0.179：后者会把我们默认那个靛蓝
 * （#4c8dff，亮度约 .53）也判成黑字，全站主按钮的文字颜色一夜变色，这不是这次要改的东西。
 * 0.54 的分界线落在"白字确实糊了"的浅色上：七个预设里只有琥珀（#f7b955）判黑字，
 * 其余（含默认靛蓝）保持白字，所以默认外观一个像素都不动。自定义色同样按这条走。
 */
function readableOn(rgb, dark = '#0b1220', light = '#ffffff', threshold = 0.54) {
  const lin = (c) => {
    const s = c / 255;
    // 用 Math.pow 而不是 `**` 运算符：仓库有条守卫会扫 ui/ 里所有行的 `**`
    // （文字里的 markdown 加粗漏进界面就会原样显示给用户），它不区分代码与文案 ——
    // 与其去放宽那条守卫（放宽就会漏检），不如按它的口径写。
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const lum = 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
  return lum > threshold ? dark : light;
}

/** 保存值 → 生效值（坏值一律回默认，绝不让一个手改坏的数字把界面搞花）。 */
function resolveAppearance(ui = {}) {
  const src = ui && typeof ui === 'object' ? ui : {};

  // 强调色预设：新版字段优先，其次认旧版 preset（含旧版的"自定义色压过预设"语义）
  const legacy = LEGACY_PRESETS[String(src.preset || '')] || '';
  const accentPreset = pick(ACCENTS, src.accentPreset || legacy, DEFAULTS.accentPreset);
  const presetHex = firstOf(ACCENTS, accentPreset).hex;
  const custom = normalizeHex(src.accent);
  const accent = custom || presetHex;

  // 只接受白名单里的变量，且值必须是合法颜色（防止有人往 localStorage 里塞垃圾）
  const tweaks = {};
  const rawTweaks = src.tweaks && typeof src.tweaks === 'object' ? src.tweaks : {};
  for (const [k, v] of Object.entries(rawTweaks)) {
    if (!TWEAK_SET.has(k)) continue;
    const hex = normalizeHex(v);
    if (hex) tweaks[k] = hex;
  }

  const radius = clamp(Number(src.radius) || DEFAULTS.radius, 0.6, 1.45);
  const zoom = clamp(Number(src.zoom) || DEFAULTS.zoom, 0.8, 1.3);
  const bgAngle = clamp(Number.isFinite(Number(src.bgAngle)) ? Math.round(Number(src.bgAngle)) : DEFAULTS.bgAngle, 0, 360);

  return {
    // 明暗：v3 的字段叫 mode；v2 存在 ui.theme 上（服务端默认值里也是 theme），两个都认，
    // 新版优先 —— 老存档升上来不能一夜回到暗色。
    mode: pick(MODES, src.mode || src.theme, DEFAULTS.mode),
    darkIntensity: pick(DARK_INTENSITIES, src.darkIntensity, DEFAULTS.darkIntensity),
    scheme: pick(SCHEMES, src.scheme, DEFAULTS.scheme),
    accentPreset,
    accent,
    customAccent: Boolean(custom),
    accentScope: pick(ACCENT_SCOPES, src.accentScope, DEFAULTS.accentScope),
    sidebarStyle: pick(SIDEBAR_STYLES, src.sidebarStyle, DEFAULTS.sidebarStyle),
    sidebarPinned: src.sidebarPinned === true,
    background: pick(BACKGROUNDS, src.background, DEFAULTS.background),
    glass: pick(GLASS, src.glass, DEFAULTS.glass),
    refract: src.refract === true,
    bgColor: normalizeHex(src.bgColor) || DEFAULTS.bgColor,
    bgFrom: normalizeHex(src.bgFrom) || DEFAULTS.bgFrom,
    bgTo: normalizeHex(src.bgTo) || DEFAULTS.bgTo,
    bgAngle,
    font: pick(FONTS, src.font, DEFAULTS.font),
    radius,
    zoom,
    density: pick(DENSITIES, src.density, DEFAULTS.density),
    tweaks,
    showBadges: src.showBadges !== false,
    showTopbarTheme: src.showTopbarTheme !== false,
    reduceMotion: src.reduceMotion === true,
    noMotion: src.noMotion === true,
    contrast: src.contrast === 'high' ? 'high' : 'normal'
  };
}

/** 生效值 → 当前圆角档位 id（设置页要把滑条/分段控件对回档位）。 */
function radiusTier(radius) {
  let best = RADII[0];
  for (const r of RADII) if (Math.abs(r.value - radius) < Math.abs(best.value - radius)) best = r;
  return best.id;
}

/**
 * 生效值 → CSS 变量（套在 documentElement 的 inline style 上）。
 *
 * 这里刻意只放"JS 才给得出的那几个值"：
 *   · --accent / --accent-side  —— 选中的颜色（应用范围"仅侧栏"时两者不同）
 *   · --accent-fg               —— 压在强调色上的文字该黑还是白（要算相对亮度）
 *   · --r-scale / --zoom        —— 两个连续量
 *   · --bg-solid/--bg-from/--bg-to/--bg-angle —— 自定义背景的四个数据
 * 强调色的柔和底 / 描边 / 焦点环一律**不进这里**，改由 CSS 的 color-mix 从 --accent 现算
 * （见 ui/style.css「外观 v3」§0）。少写三个变量不是洁癖：首屏那段内联脚本也要抄一份，
 * 抄得越少越不会漂；而且换强调色时 CSS 只需要重算一个值。
 *
 * 返回 null 的键表示"要移除这个内联属性"：主题微调的「重置」靠它把控制权还给色板。
 */
function appearanceVars(app) {
  const shades = accentShades(app.accent) || accentShades(DEFAULT_ACCENT);
  const globalShades = app.accentScope === 'sidebar'
    ? (accentShades(DEFAULT_ACCENT) || shades)
    : shades;
  const vars = {
    '--accent': globalShades.accent,
    '--accent-side': shades.accent,
    '--accent-fg': globalShades.fg,
    '--r-scale': String(app.radius),
    '--zoom': String(app.zoom),
    '--bg-solid': app.bgColor,
    '--bg-from': app.bgFrom,
    '--bg-to': app.bgTo,
    '--bg-angle': `${app.bgAngle}deg`
  };
  // 主题微调：白名单内的逐个覆盖；没设置的不写（保留 null 语义 → 由调用方 removeProperty）
  for (const k of TWEAK_KEYS) vars[k] = app.tweaks[k] || null;
  return vars;
}

/**
 * 只算"文字该黑还是白"的入口（首屏内联脚本要抄的逻辑就这一条，测试会对着它逐色核对）。
 */
function accentForeground(hex) {
  const rgb = hexToRgb(hex);
  return rgb ? readableOn(rgb) : '#ffffff';
}

/**
 * 生效值 → <html> 上的 data-* 属性（能走选择器的轴就不进 inline style）。
 * 不含 data-theme：明暗由 applyTheme 负责（"跟随系统"要额外解析一次系统偏好）。
 */
function appearanceAttrs(app) {
  return {
    scheme: app.scheme,
    'dark-intensity': app.darkIntensity,
    'accent-scope': app.accentScope,
    'sidebar-style': app.sidebarStyle,
    // 图标条模式：值为 '1' 时才收（空串＝常驻展开）。取值口径与 html 上的其它开关一致。
    'side-rail': app.sidebarPinned ? '' : '1',
    background: app.background,
    // 材质：off 发空串＝不设属性（CSS 侧不需要一条“关掉玻璃”的规则）
    glass: app.glass === 'off' ? '' : app.glass,
    // 折射：空串＝不设。CSS 那边靠 var(--glass-refract, ) 的空回退，没设就等于没开。
    refract: app.refract ? '1' : '',
    font: app.font,
    density: app.density,
    contrast: app.contrast,
    // 动效：off > reduced —— 两个都开等于全关（更彻底的那条赢）
    motion: app.noMotion ? 'off' : (app.reduceMotion ? 'reduced' : ''),
    // 顶栏两个开关：值为 '1' 时才隐藏（空串等于"没设"，HTML 里写 data-x="" 也是假值）
    'hide-badges': app.showBadges ? '' : '1',
    'hide-theme-btn': app.showTopbarTheme ? '' : '1'
  };
}

/** 持久化用的最小对象：只留需要恢复的轴，附带色板/微调的当前值。 */
function appearancePatch(app) {
  return {
    mode: app.mode,
    darkIntensity: app.darkIntensity,
    scheme: app.scheme,
    accentPreset: app.accentPreset,
    accent: app.customAccent ? app.accent : '',
    accentScope: app.accentScope,
    sidebarStyle: app.sidebarStyle,
    sidebarPinned: app.sidebarPinned,
    background: app.background,
    glass: app.glass,
    refract: app.refract,
    bgColor: app.bgColor,
    bgFrom: app.bgFrom,
    bgTo: app.bgTo,
    bgAngle: app.bgAngle,
    font: app.font,
    radius: app.radius,
    zoom: app.zoom,
    density: app.density,
    tweaks: { ...app.tweaks },
    showBadges: app.showBadges,
    showTopbarTheme: app.showTopbarTheme,
    reduceMotion: app.reduceMotion,
    noMotion: app.noMotion,
    contrast: app.contrast
  };
}

export {
  ACCENTS, ACCENT_SCOPES, BACKGROUNDS, DARK_INTENSITIES, DEFAULTS, DEFAULT_ACCENT, DENSITIES, FONTS,
  GLASS, MODES, RADII, SCHEMES, SIDEBAR_STYLES, TWEAK_KEYS, TWEAK_VARS,
  accentForeground, accentShades, appearanceAttrs, appearancePatch, appearanceVars, hexToRgb,
  normalizeHex, radiusTier, readableOn, resolveAppearance
};

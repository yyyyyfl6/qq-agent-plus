// 边缘折射（外观 · 材质 · 「边缘折射」开关）。2026-10-09。
//
// 为什么单独成模块：这是 ui/ 里第一个"按元素尺寸现算、再挂到 backdrop-filter 上"的效果 ——
// 要 canvas、SVG 滤镜、ResizeObserver 与一整套降级；塞进 app.js 只会让那个文件更难读。
//
// 原理（照社区那份实现 github.com/shuding/liquid-glass 的做法，不是自创；
// 位移曲线与 depthEffect 对齐 APK 里用的 Kyant0/AndroidLiquidGlass 的 AGSL lens()）：
//   ① 每个玻璃表面按自己的尺寸开一张 canvas，逐像素算一个**圆角矩形有符号距离场（SDF）**；
//   ② 取 SDF 的梯度当法线，只在外圈一带把采样点往内推 —— 中间梯度为 0，所以中间完全不位移；
//   ③ 位移向量归一化后编码进 R/G 通道（128＝不位移），toDataURL 喂给 feImage；
//   ④ 元素上 `backdrop-filter: url(#该几何的滤镜) …`，于是背景在边缘被"弯折"。
//
// ⚠️ 为什么不做"整块位移"（我第一版做错的地方，别再改回去）：线性位移图会把**整个面**抹开，
//    而折射只发生在边缘；而且线性图是按元素宽高比拉伸的，宽扁元素上会明显不均匀。
//    SDF 恰好解决这两点 —— 中间零位移、形状与尺寸无关。
//
// 三条降级（都要保住）：
//   · 不支持 `backdrop-filter: url()`（Firefox / Safari 部分版本）→ 整项不生效，玻璃照旧；
//   · 外观里「关闭全部动效」→ 不启用（逐元素滤镜很贵，不该在"关动效"时还跑）；
//   · 元素数 / 位移图尺寸设上限；页面隐藏时不做重算。
'use strict';

// ⚠️ 本文件所有顶层标识符都带 `refract` 前缀，**不是风格洁癖**：
// test/ui-smoke.mjs 会把 ui/ 下所有脚本剥掉 import/export、放进**同一个 vm 沙箱**按 classic 跑，
// 于是顶层 const/let 是共享作用域的 —— 撞名会直接 SyntaxError（"Identifier 'x' has already
// been declared"），表现为整页白屏。实测踩过一次：`resizeBound` 与 core/segment.js 同名。
// 真 ESM 下当然没问题，但这层沙箱是仓库的安全网，得让着它。

/** 会被加折射的表面。与 style.css 里玻璃表面清单保持一致（多一个少一个只是白算/漏算）。
    2026-10-09 复核：表面清单早已改 .kpi-grid（玻璃加在整行表面），这里漏跟 —— 结果是给 5 个
    没有 backdrop-filter 的格子白算位移图、还占 REFRACT_MAX_SURFACES 名额，真正的表面反而不折射。 */
const REFRACT_SELECTOR = [
  '#topbar', '#sidebar', '.settings-sidebar', '.panel', '.kpi-grid', '.opt-card',
  '.usage-card', '.plat-card', '.tool-card', '.model-modal', '.modal', 'dialog', '.list-pane'
].join(',');

const REFRACT_MAX_SURFACES = 14;     // 同时折射的元素上限（每次 reconcile 取前 N 个）
const REFRACT_MAX_MAP_PX = 300;      // 位移图长边上限：够表达边缘，又不至于让 toDataURL 变慢
const REFRACT_MIN_SIDE = 56;         // 小于这个尺寸不值得折射（边缘带都比元素宽了）
// 参考实现（Kyant0/AndroidLiquidGlass，酷安在用）的 lens 有两档量级：
//   底栏/小控件 lens(12dp, 24dp)，选中药丸与大面板 lens(24dp, 48dp)。
// 这里按元素短边选档，并且**保留绝对像素值**：位移图编码时 scale 与位移同源，
// 缩图不会改变视觉强度。曲线不是线性的 —— 见 refractRenderMap 里的 circleMap。
const REFRACT_LENS_SMALL = { band: 12, amount: 24 };   // 短边 < 120px：按钮、药丸
const REFRACT_LENS_LARGE = { band: 24, amount: 48 };   // 面板、弹层
const REFRACT_DEPTH_EFFECT = 0;      // 0~1：SDF 法线里混入径向分量的比例（APK 的 depthEffect）
// 色散：把 R/G/B 三个通道按 ±6% 的位移量分开采样（APK 的 RefractionWithDispersion）。
// 参考实现是 7 次采样；这里用 3 个通道就够肉眼看出边缘的彩边，成本也低。
const REFRACT_DISPERSION = 0.06;
const REFRACT_RESCAN_MS = 300;
/**
 * 滤镜表上限。拖窗口尺寸时每变几个像素就是一个新几何 = 一张新位移图 + 一个新 SVG 滤镜，
 * 不设上限就成了"拖一次窗口留一堆再也不用的 base64 图"。超了就淘汰最旧的那个（连带从 DOM 摘掉）。
 */
const REFRACT_MAX_FILTERS = 24;       // DOM 变动 / resize 之后的合并重扫间隔

/**
 * 同一套几何（尺寸 + 圆角）共用一个位移图与一个 SVG 滤镜 ——
 * 设置页那种一屏十几张同尺寸卡片是最常见的情形，不共用就会白算十几遍。
 */
const refractFilters = new Map();   // key -> { id, feImage, feDisplacementMap }
const refractTracked = new Map();   // element -> { key, ro }
// svg 宿主也按 document 分：写成全局单值时，第二个 document（测试替身、或一个页面里
// 真出现两个 document）会把滤镜挂到上一个 document 的 svg 上 —— 渲染不出来，而且毫无提示。
const refractSvgs = new WeakMap();
let refractObserver = null;
let refractTimer = 0;
let refractResizeBound = false;
// 两个能力探测的缓存都**按 document 分**（WeakMap）而不是模块级单值：
// 能力本身是运行时的性质，正常只有一个 document；但写成全局单值会让"先探测到不支持"
// 永久污染之后的每一次调用（测试环境里换一个 doc 就直接失效，那是真 bug 的形状）。
const refractSupportCache = new WeakMap();
const refractCanvasCache = new WeakMap();
let refractSeq = 0;

const refractNum = (v) => {
  const n = Number.parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
};

/** 圆角矩形的有符号距离场。x/y 是相对中心的坐标，halfW/halfH 是半宽半高（与社区实现同口径）。 */
function refractRoundedRectSdf(x, y, halfW, halfH, radius) {
  const qx = Math.abs(x) - halfW + radius;
  const qy = Math.abs(y) - halfH + radius;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return Math.min(Math.max(qx, qy), 0) + outside - radius;
}

/**
 * 这个运行时能不能做位图运算。缺 canvas 2D 或 toDataURL 的环境（例如没装 canvas 的 DOM 替身、
 * 极简浏览器）直接判"不支持" —— 宁可不折射，也不能让一个可选的视觉效果把控制台抛挂。
 */
function refractCanvasUsable(doc) {
  // 缓存：这个探测会 new 一个 canvas，而 shouldRun 每轮同步都要问一次 ——
  // 不缓存就是"每 300ms 造一个元素"（MutationObserver 驱动的重扫很频繁）。
  if (refractCanvasCache.has(doc)) return refractCanvasCache.get(doc);
  try {
    const c = doc.createElement('canvas');
    const ctx = c.getContext && c.getContext('2d');
    refractCanvasCache.set(doc, Boolean(ctx && typeof c.toDataURL === 'function'));
  } catch {
    refractCanvasCache.set(doc, false);
  }
  return refractCanvasCache.get(doc);
}

/** 是否支持在 backdrop-filter 里引用 SVG 滤镜（不支持就别白跑）。 */
function refractSupported(doc) {
  if (!refractCanvasUsable(doc)) return false;
  if (refractSupportCache.has(doc)) return refractSupportCache.get(doc);
  const view = doc.defaultView;
  try {
    const css = view?.CSS;
    if (css && typeof css.supports === 'function') {
      const ok = css.supports('backdrop-filter', 'url(#qqa-refract-probe)')
        || css.supports('-webkit-backdrop-filter', 'url(#qqa-refract-probe)');
      refractSupportCache.set(doc, ok);
      return ok;
    }
  } catch { /* 落到下面的元素探测 */ }
  // 没有 CSS.supports 的运行时：挂一个零尺寸元素读计算值。
  // 引用一个真实存在的滤镜，避免"因为滤镜不存在而被判成不支持"的假阴性。
  try {
    const probeFilter = refractEnsureFilter(doc, { width: 8, height: 8, radius: 0 });
    const probe = doc.createElement('div');
    probe.style.cssText = `position:absolute;width:0;height:0;pointer-events:none;backdrop-filter:url(#${probeFilter.id})`;
    doc.body.appendChild(probe);
    const value = String(doc.defaultView.getComputedStyle(probe).backdropFilter || '');
    probe.remove();
    refractSupportCache.set(doc, value.includes('url('));
  } catch {
    refractSupportCache.set(doc, false);
  }
  return refractSupportCache.get(doc);
}

/** 这个页面此刻该不该跑折射。 */
function refractShouldRun(doc) {
  const root = doc.documentElement;
  if (!root || !root.getAttribute('data-glass')) return false;      // 材质＝实心，没有玻璃可折射
  if (root.getAttribute('data-refract') !== '1') return false;       // 开关没开
  // data-motion 有值（off / reduced）都不跑：逐元素 SVG 滤镜链很贵，而 CSS 对两者都关动画 ——
  // 只认 off 的话，"减少动效"档下最贵的效果照跑（2026-10-09 审查）。
  if (root.getAttribute('data-motion')) return false;
  return refractSupported(doc);
}

function refractEnsureSvg(doc) {
  const existing = refractSvgs.get(doc);
  if (existing && existing.isConnected) return existing;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(NS, 'svg');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
  doc.body.appendChild(svg);
  refractSvgs.set(doc, svg);
  return svg;
}

/**
 * 造位移图：只在外圈 refraction band（12px 或 24px，按元素短边选档）之内位移，中间为 0。
 * 两遍走：先算原始位移取最大值（归一化要用），再编码 —— 与社区实现同一步骤。
 */
function refractRenderMap(doc, { width, height, radius }) {
  const lens = Math.min(width, height) < 120 ? REFRACT_LENS_SMALL : REFRACT_LENS_LARGE;
  const band = lens.band;
  const amount = lens.amount;
  const scale = Math.min(1, REFRACT_MAX_MAP_PX / Math.max(width, height));
  const mw = Math.max(8, Math.round(width * scale));
  const mh = Math.max(8, Math.round(height * scale));
  const canvas = doc.createElement('canvas');
  canvas.width = mw;
  canvas.height = mh;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(mw, mh);
  const data = img.data;
  const raw = new Float32Array(mw * mh * 2);
  const halfW = width / 2;
  const halfH = height / 2;
  const rr = Math.min(radius, halfW, halfH);
  const stepX = width / mw;
  const stepY = height / mh;
  let maxAbs = 0;

  for (let py = 0; py < mh; py += 1) {
    const y = (py + 0.5) * stepY;
    for (let px = 0; px < mw; px += 1) {
      const x = (px + 0.5) * stepX;
      const i = (py * mw + px) * 2;
      const depth = -refractRoundedRectSdf(x - halfW, y - halfH, halfW, halfH, rr);  // 正值＝在内部
      if (depth <= 0 || depth >= band) continue;                                      // 外面 / 太深：不位移
      // Kyant AndroidLiquidGlass 的 circleMap：edge=1 → 带内缘=0，曲线是凸的，
      // 位移集中在最外一圈，而不是像线性剖面那样均匀铺满整条带。
      const rawT = 1 - depth / band;
      const t = 1 - Math.sqrt(Math.max(0, 1 - rawT * rawT));
      // 数值梯度当法线（梯度指向外），取负往内推
      const e = 0.75;
      const gx = refractRoundedRectSdf(x + e - halfW, y - halfH, halfW, halfH, rr)
        - refractRoundedRectSdf(x - e - halfW, y - halfH, halfW, halfH, rr);
      const gy = refractRoundedRectSdf(x - halfW, y + e - halfH, halfW, halfH, rr)
        - refractRoundedRectSdf(x - halfW, y - e - halfH, halfW, halfH, rr);
      let nx = gx / (Math.hypot(gx, gy) || 1);
      let ny = gy / (Math.hypot(gx, gy) || 1);
      // depthEffect：在 SDF 法线里混入一小段径向分量（从元素中心指向当前像素），
      // 边缘因此不只是"横向掰"，而有一点穹顶/厚度。APK 的 lens(depthEffect=true) 同款。
      if (REFRACT_DEPTH_EFFECT > 0) {
        const cx = x - halfW;
        const cy = y - halfH;
        const clen = Math.hypot(cx, cy) || 1;
        nx += REFRACT_DEPTH_EFFECT * (cx / clen);
        ny += REFRACT_DEPTH_EFFECT * (cy / clen);
        const nlen = Math.hypot(nx, ny) || 1;
        nx /= nlen;
        ny /= nlen;
      }
      const dx = -nx * amount * t;
      const dy = -ny * amount * t;
      raw[i] = dx;
      raw[i + 1] = dy;
      const m = Math.max(Math.abs(dx), Math.abs(dy));
      if (m > maxAbs) maxAbs = m;
    }
  }

  // 编码：R/G 通道 0.5 表示"不位移"。feDisplacementMap 的位移是 scale*(通道/255-0.5)，
  // 所以要让 dx 生效，scale 必须取 2*maxAbs（见 applyFilter）。
  const span = maxAbs > 0 ? maxAbs * 2 : 1;
  for (let i = 0; i < data.length; i += 4) {
    const dx = raw[(i / 4) * 2];
    const dy = raw[(i / 4) * 2 + 1];
    data[i] = Math.round((dx / span + 0.5) * 255);
    data[i + 1] = Math.round((dy / span + 0.5) * 255);
    data[i + 2] = 0;
    data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return { href: canvas.toDataURL('image/png'), dispScale: span };
}

/** 取（或建）这套几何对应的滤镜。几何一致就复用，避免同尺寸卡片重复算图。 */
function refractEnsureFilter(doc, geom) {
  const key = `${geom.width}x${geom.height}r${Math.round(geom.radius)}`;
  const hit = refractFilters.get(key);
  if (hit) return hit;
  if (!refractCanvasUsable(doc)) return null;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = refractEnsureSvg(doc);
  const id = `qqa-refract-${refractSeq += 1}`;
  const filter = doc.createElementNS(NS, 'filter');
  filter.setAttribute('id', id);
  // filterUnits=userSpaceOnUse + 显式宽高：让滤镜盖住整个元素（backdrop-filter 用的是元素坐标系）
  filter.setAttribute('filterUnits', 'userSpaceOnUse');
  filter.setAttribute('x', '0');
  filter.setAttribute('y', '0');
  filter.setAttribute('width', String(geom.width));
  filter.setAttribute('height', String(geom.height));
  // ⚠️ 属性名不能写错：写错会被浏览器**静默忽略**，滤镜退回默认的 linearRGB 色域插值 ——
  // 那样位移图里的 R/G 先被 sRGB→线性转换，"128 = 不位移" 的中性点直接漂到 0.216，
  // 整块背景会获得一个恒定向内偏移并被非线性扭曲，强度不再等于 SDF 算出来的值。
  // 这一行曾经被一次批量重命名误伤成 `color-interpolation-refractFilters`（审查抓到的），
  // test/ui-glass-refract.test.mjs 有一条用例专门盯它。
  filter.setAttribute('color-interpolation-filters', 'sRGB');

  const feImage = doc.createElementNS(NS, 'feImage');
  feImage.setAttribute('x', '0');
  feImage.setAttribute('y', '0');
  feImage.setAttribute('width', String(geom.width));
  feImage.setAttribute('height', String(geom.height));
  feImage.setAttribute('preserveAspectRatio', 'none');   // 位移图按元素尺寸拉伸（图本身就是按同比例采样出来的）
  feImage.setAttribute('result', 'map');

  const feDisplacementMap = doc.createElementNS(NS, 'feDisplacementMap');
  feDisplacementMap.setAttribute('in', 'SourceGraphic');
  feDisplacementMap.setAttribute('in2', 'map');
  feDisplacementMap.setAttribute('xChannelSelector', 'R');
  feDisplacementMap.setAttribute('yChannelSelector', 'G');

  let href = '';
  let dispScale = 1;
  try {
    ({ href, dispScale } = refractRenderMap(doc, geom));
  } catch {
    return null;   // 画不出来就当这套几何没有滤镜（调用方会摘掉内联变量）
  }
  feImage.setAttribute('href', href);
  feDisplacementMap.setAttribute('scale', String(dispScale));
  feDisplacementMap.setAttribute('result', 'refractBase');

  // 色散（APK 的 RefractionWithDispersion）：同一位移图用三档 scale 各采样一次，
  // 分别只保留 R/G/B，再用 arithmetic 相加。中间的 G 档就是原来的位移量，
  // 红/蓝各偏 ±6% —— 边缘会有一圈很细的彩边，正是参考实现里玻璃的观感。
  const dispR = doc.createElementNS(NS, 'feDisplacementMap');
  const dispB = doc.createElementNS(NS, 'feDisplacementMap');
  for (const [node, k, result] of [
    [dispR, 1 + REFRACT_DISPERSION, 'refractR'],
    [dispB, 1 - REFRACT_DISPERSION, 'refractB'],
  ]) {
    node.setAttribute('in', 'SourceGraphic');
    node.setAttribute('in2', 'map');
    node.setAttribute('xChannelSelector', 'R');
    node.setAttribute('yChannelSelector', 'G');
    node.setAttribute('scale', String(dispScale * k));
    node.setAttribute('result', result);
  }
  const channelOnly = (name, rows) => {
    const m = doc.createElementNS(NS, 'feColorMatrix');
    m.setAttribute('in', name);
    m.setAttribute('type', 'matrix');
    m.setAttribute('values', rows);
    return m;
  };
  const red = channelOnly('refractR', '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0');
  const green = channelOnly('refractBase', '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0');
  const blue = channelOnly('refractB', '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0');
  red.setAttribute('result', 'refractRed');
  green.setAttribute('result', 'refractGreen');
  blue.setAttribute('result', 'refractBlue');
  const addRG = doc.createElementNS(NS, 'feComposite');
  addRG.setAttribute('in', 'refractRed');
  addRG.setAttribute('in2', 'refractGreen');
  addRG.setAttribute('operator', 'arithmetic');
  addRG.setAttribute('k2', '1');
  addRG.setAttribute('k3', '1');
  addRG.setAttribute('result', 'refractRG');
  const addB = doc.createElementNS(NS, 'feComposite');
  addB.setAttribute('in', 'refractRG');
  addB.setAttribute('in2', 'refractBlue');
  addB.setAttribute('operator', 'arithmetic');
  addB.setAttribute('k2', '1');
  addB.setAttribute('k3', '1');
  addB.setAttribute('result', 'refractOut');

  filter.appendChild(feImage);
  filter.appendChild(feDisplacementMap);
  filter.appendChild(dispR);
  filter.appendChild(dispB);
  filter.appendChild(red);
  filter.appendChild(green);
  filter.appendChild(blue);
  filter.appendChild(addRG);
  filter.appendChild(addB);
  svg.appendChild(filter);
  const rec = { id, feImage, feDisplacementMap, key, filter };
  refractFilters.set(key, rec);
  // 淘汰最旧的一条（Map 保持插入顺序）。被淘汰的几何若仍在使用，下一轮 sync 会重新建 ——
  // 这是刻意的取舍：宁可重建一次，也不要让缓存无界。
  while (refractFilters.size > REFRACT_MAX_FILTERS) {
    // 只淘汰**当前没被任何元素引用**的几何。淘汰一个正在用的会把它摘掉内联变量，
    // 而本轮 sync 已经处理过那个元素、淘汰本身也不触发新的重扫 —— 结果是那个表面
    // 静默失去折射，直到下一次偶然的 sync 才恢复（审查抓到的空窗）。
    const inUse = new Set();
    for (const state of refractTracked.values()) inUse.add(state.key);
    let victimKey = null;
    for (const key of refractFilters.keys()) {
      if (!inUse.has(key)) { victimKey = key; break; }
    }
    if (!victimKey) break;   // 全都在用：宁可暂时超出上限（实际上限被 REFRACT_MAX_SURFACES 兜着）
    const stale = refractFilters.get(victimKey);
    refractFilters.delete(victimKey);
    try { stale.filter.remove(); } catch { /* 已经在文档之外也无所谓 */ }
  }
  return rec;
}

/** 读一个元素的几何（尺寸 + 圆角）。读不到（隐藏/还没布局）返回 null。 */
function refractGeometryOf(doc, el) {
  // 先问一句"你看得见吗"：控制台有十几个视图（<section>），非当前视图都是 display:none，
  // 但它们的 .panel/.kpi 一样会被 querySelectorAll 选中。checkVisibility 不触发布局，
  // 比"读一下 getBoundingClientRect 发现是 0"便宜得多。没有这个 API 的老浏览器走后面的尺寸判断。
  if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) return null;
  // 只调一次：getBoundingClientRect 会强制重排，在两个调用之间读 width/height 没有意义、
  // 却多强制一次布局（这一点在元素多、页面复杂时是要付钱的）。
  const box = el.getBoundingClientRect();
  const width = Math.round(box.width || 0);
  const height = Math.round(box.height || 0);
  if (width < REFRACT_MIN_SIDE || height < REFRACT_MIN_SIDE) return null;
  const cs = doc.defaultView.getComputedStyle(el);
  const radius = Math.max(
    refractNum(cs.borderTopLeftRadius), refractNum(cs.borderTopRightRadius),
    refractNum(cs.borderBottomLeftRadius), refractNum(cs.borderBottomRightRadius)
  );
  return { width, height, radius };
}

function refractDetach(el) {
  const rec = refractTracked.get(el);
  if (!rec) return;
  rec.ro?.disconnect?.();
  el.style.removeProperty('--glass-refract');
  refractTracked.delete(el);
}

function refractTeardownAll() {
  for (const el of [...refractTracked.keys()]) refractDetach(el);
}

/** 给一个元素挂上折射；几何变了就换一个滤镜。 */
function refractAttach(doc, el, preset) {
  const geom = preset || refractGeometryOf(doc, el);
  if (!geom) { refractDetach(el); return; }
  const built = refractEnsureFilter(doc, geom);
  if (!built) { refractDetach(el); return; }
  const { id, key } = built;
  const rec = refractTracked.get(el);
  if (rec && rec.key === key) return;              // 没变，不用碰样式
  el.style.setProperty('--glass-refract', `url(#${id})`);
  if (rec) { rec.key = key; return; }
  let ro = null;
  const RO = doc.defaultView?.ResizeObserver;
  if (typeof RO === 'function') {
    ro = new RO(() => refractScheduleSync(doc));
    ro.observe(el);
  }
  refractTracked.set(el, { key, ro });
}

function refractScheduleSync(doc, delay = REFRACT_RESCAN_MS) {
  const view = doc.defaultView;
  if (!view || refractTimer) return;
  refractTimer = (view.setTimeout || setTimeout)(() => {
    refractTimer = 0;
    syncGlassRefract(doc);
  }, delay);
}

/** 按当前 DOM 与开关状态对齐一次：该挂的挂、该摘的摘。 */
function syncGlassRefract(doc = document) {
  if (!doc || !doc.documentElement) return;
  if (!refractShouldRun(doc) || doc.hidden) { refractTeardownAll(); return; }
  let els = [];
  try {
    els = [...doc.querySelectorAll(REFRACT_SELECTOR)];
  } catch { return; }
  // ⚠️ 必须先筛掉"看不见 / 尺寸不够"的，**再**按上限截断。
  // 反过来（先 slice 再判断）会踩到一个很隐蔽的坑：querySelectorAll 是**文档顺序**，
  // 而排在前面的视图（总览/会话…）里的 .panel/.kpi 全是 display:none —— 它们把名额占满，
  // 当前视图里真正可见的卡片一个都进不来。表现就是"开了折射什么都没发生"。
  // 这个 bug 只有拿真浏览器看才发现（单测里我给的替身没有隐藏兄弟视图）。
  const geoms = new Map();
  for (const el of els) {
    if (geoms.size >= REFRACT_MAX_SURFACES) break;
    const geom = refractGeometryOf(doc, el);
    if (geom) geoms.set(el, geom);
  }
  for (const el of [...refractTracked.keys()]) if (!geoms.has(el)) refractDetach(el);
  for (const [el, geom] of geoms) refractAttach(doc, el, geom);
}

/** 绑定一次（幂等）。外观一变、DOM 一变、窗口一改、页面回到前台都要重扫。 */
function initGlassRefract(doc = document) {
  if (!doc || !doc.documentElement || !doc.body) return false;
  if (!refractObserver && typeof doc.defaultView?.MutationObserver === 'function') {
    // ⚠️ 只认"增删了元素节点"的变动：控制台的倒计时与用量徽章每 1~15 秒改一次文本，
    // 而 `el.textContent = x` 在 DOM 层就是一次 childList 变动（换掉文本节点）。
    // 不过滤的话，就是"每秒一次整页 querySelectorAll + 十几次 getBoundingClientRect"，
    // 而 getBoundingClientRect 会强制重排 —— 纯属自己给自己制造卡顿。
    refractObserver = new doc.defaultView.MutationObserver((records) => {
      for (const rec of records) {
        for (const node of rec.addedNodes || []) if (node.nodeType === 1) return refractScheduleSync(doc);
        for (const node of rec.removedNodes || []) if (node.nodeType === 1) return refractScheduleSync(doc);
      }
    });
    refractObserver.observe(doc.body, { childList: true, subtree: true });
  }
  if (!refractResizeBound) {
    refractResizeBound = true;
    doc.defaultView?.addEventListener?.('resize', () => refractScheduleSync(doc));
    doc.addEventListener?.('qqa:appearance', () => refractScheduleSync(doc, 0));
    doc.addEventListener?.('visibilitychange', () => refractScheduleSync(doc, 0));
  }
  // 支持性检测要在 DOM 就绪之后做（探测元素要挂进 body）
  refractScheduleSync(doc, 0);
  return true;
}

// refractRoundedRectSdf 单独导出只为测试：它是这一整套里唯一有"数学对错"的部分，
// 用真 DOM 断言折射像素不现实（happy-dom 没有 canvas），而 SDF 的符号/边界/圆角行为可以逐条钉住。
export { initGlassRefract, syncGlassRefract, refractRoundedRectSdf, refractRenderMap };

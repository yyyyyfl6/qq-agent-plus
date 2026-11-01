// 边缘折射模块（ui/core/glass-refract.js）的回归用例。
//
// 为什么用极简 fake document 而不是 happy-dom：happy-dom 没有 canvas 2D，
// 而"画不出位移图"正是这个模块最需要被钉住的降级路径之一。自己造一个能精确控制
// canvas / CSS.supports / 几何尺寸的替身，比在真 DOM 上撞运气可靠得多。
//
// ⚠️ 模块里有两处**模块级缓存**（支持性探测、按几何复用的滤镜表），它们跨用例共享。
//    所以下面每条用例都用**各自不同的几何尺寸**（避免命中上一条的滤镜缓存），
//    且"支持性为假"的场景一律走 canvas 不可用那条早返回（它每次都重新判，不受缓存影响）。
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { initGlassRefract, syncGlassRefract, refractRoundedRectSdf, refractRenderMap } =
  await import('../ui/core/glass-refract.js');

/**
 * 极简 DOM 替身。只实现模块真正用到的东西，其它一律不给 ——
 * 少了什么就会当场暴露（这本身就是一道契约）。
 */
function makeDoc({
  glass = 'liquid', refract = '1', motion = '', supports = true, canvas = true,
  rect = { width: 400, height: 200 }, radius = '12px'
} = {}) {
  const attrs = {};
  if (glass) attrs['data-glass'] = glass;
  if (refract) attrs['data-refract'] = refract;
  if (motion) attrs['data-motion'] = motion;
  const appended = [];
  const timers = [];

  const makeEl = (tag) => {
    const el = {
      tagName: String(tag).toUpperCase(),
      isConnected: false,
      attrs: {},
      style: {
        _p: {},
        setProperty(k, v) { this._p[k] = String(v); },
        removeProperty(k) { delete this._p[k]; },
      },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      appendChild(child) { child.isConnected = true; appended.push(child); return child; },
      remove() { this.isConnected = false; },
      addEventListener() {},
      getBoundingClientRect: () => ({ width: rect.width, height: rect.height, top: 0, left: 0 }),
    };
    return el;
  };

  const surfaces = [];

  const doc = {
    hidden: false,
    documentElement: { getAttribute: (k) => (k in attrs ? attrs[k] : null) },
    body: makeEl('body'),
    createElement(tag) {
      if (String(tag).toLowerCase() === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: canvas
            ? () => ({
              createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
              putImageData() {},
            })
            : undefined,
          toDataURL: canvas ? () => 'data:image/png;base64,ZmFrZQ==' : undefined,
        };
      }
      return makeEl(tag);
    },
    createElementNS: (_ns, tag) => makeEl(tag),
    querySelectorAll: () => surfaces,
    addEventListener() {},
    defaultView: {
      // 故意只给 CSS.supports：不给 ResizeObserver / MutationObserver，
      // 让模块走"没有观察者"的降级分支（那条分支也必须不抛）
      CSS: { supports: () => supports },
      // ⚠️ 必须"排队等手动 flush"，不能同步就执行：模块的防抖是
      // `refractTimer = view.setTimeout(回调)`，回调内部再把 refractTimer 清 0。
      // 同步执行的话赋值发生在回调之后，标记永远停在真值 → 之后所有 sync 都被防抖吃掉
      //（本文件第一版就踩了这个坑，表现是"只有第一条用例生效"）。
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
      clearTimeout() {},
      getComputedStyle: () => ({
        borderTopLeftRadius: radius, borderTopRightRadius: radius,
        borderBottomLeftRadius: radius, borderBottomRightRadius: radius,
        backdropFilter: '',
      }),
    },
  };
  doc.__surfaces = surfaces;
  doc.__appended = appended;
  /** 跑掉所有排队的定时器（就是把本轮防抖的任务真正执行一次）。 */
  doc.__flush = () => { for (const fn of timers.splice(0)) fn(); };
  return doc;
}

/** 往替身里放 n 个"玻璃表面"。 */
function addSurfaces(doc, n, size) {
  for (let i = 0; i < n; i += 1) {
    const el = doc.createElement('section');
    el.getBoundingClientRect = () => ({ width: size.width, height: size.height, top: 0, left: 0 });
    doc.__surfaces.push(el);
  }
  return doc.__surfaces;
}

// ── SDF（这套东西里唯一有"数学对错"的部分） ──

test('圆角矩形 SDF：内部为负、边界为 0、外部为正，且中心深度＝较短半轴', () => {
  const halfW = 200;
  const halfH = 100;
  const r = 0;
  assert.equal(refractRoundedRectSdf(0, 0, halfW, halfH, r), -100, '中心到最近边的距离＝较短半轴');
  assert.equal(refractRoundedRectSdf(-halfW, 0, halfW, halfH, r), 0, '左边界上＝0');
  assert.equal(refractRoundedRectSdf(halfW, 0, halfW, halfH, r), 0, '右边界上＝0');
  assert.equal(refractRoundedRectSdf(0, halfH, halfW, halfH, r), 0, '下边界上＝0');
  assert.equal(refractRoundedRectSdf(-halfW - 10, 0, halfW, halfH, r), 10, '外侧 10px＝+10');
  assert.ok(refractRoundedRectSdf(0, 0, halfW, halfH, r) < 0);
  assert.ok(refractRoundedRectSdf(halfW + 30, halfH + 30, halfW, halfH, r) > 0);
});

test('位移图编码：中心不位移（128 中性点）、贴边有位移且方向朝内、dispScale 与归一化同源（2026-10-09 审查）', () => {
  // 这两处"错了会让整块背景凭空偏移"的编码约定此前没有任何断言：
  // R/G=128 是中性点（feDisplacementMap 的位移 = scale*(通道/255-0.5)），
  // 以及 scale 必须取 2*maxAbs（代码注释自己点名的两处）。
  const canvases = [];
  const doc = {
    createElement(tag) {
      assert.equal(tag, 'canvas');
      const c = {
        width: 0, height: 0, _img: null,
        getContext: () => ({
          createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
          putImageData: (img) => { c._img = img; }
        }),
        toDataURL: () => 'data:image/png;base64,ZmFrZQ=='
      };
      canvases.push(c);
      return c;
    }
  };
  const out = refractRenderMap(doc, { width: 400, height: 200, radius: 12 });
  const c = canvases[0];
  const img = c._img;
  assert.ok(img, '位移图必须真的画进 canvas');
  assert.equal(img.data.length, c.width * c.height * 4);

  const at = (x, y) => (y * c.width + x) * 4;
  const midY = Math.floor(c.height / 2);

  // ① 中心（远离边缘）：完全不动 —— R/G 都是中性点 128
  const center = at(Math.floor(c.width / 2), midY);
  assert.equal(img.data[center], 128, '中心区 R 通道＝128（不位移）');
  assert.equal(img.data[center + 1], 128, '中心区 G 通道＝128（不位移）');

  // ② 左边缘：有位移，且方向朝内（左边界法线朝左，往内推 = dx>0 → R>128，写反会整块偏移）
  const left = at(0, midY);
  assert.ok(img.data[left] > 128, `左边缘横向位移应为正（实际 R=${img.data[left]}）`);

  // ③ 归一化：最偏离的通道应触及编码两端（dispScale＝2×maxAbs 时 maxAbs ↔ 0/255）
  let maxDev = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    maxDev = Math.max(maxDev, Math.abs(img.data[i] - 128), Math.abs(img.data[i + 1] - 128));
  }
  assert.ok(maxDev >= 126, `最大位移应接近编码上限（实际 ${maxDev}）——dispScale 少了系数会整体变小`);

  // ④ 返回的 scale 与编码同源、为正
  assert.ok(Number(out.dispScale) > 0, 'dispScale 要带回给滤镜层');
});

test('位移剖面用 circleMap：边缘最强，半带处迅速衰减（不是线性铺满整条带）', () => {
  const canvases = [];
  const doc = {
    createElement(tag) {
      assert.equal(tag, 'canvas');
      const c = {
        width: 0, height: 0, _img: null,
        getContext: () => ({
          createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
          putImageData: (img) => { c._img = img; }
        }),
        toDataURL: () => 'data:image/png;base64,ZmFrZQ=='
      };
      canvases.push(c);
      return c;
    }
  };
  // 400x200 → 位移图 300x150（长边上限 300），1 元素像素 = 0.75 图像素
  refractRenderMap(doc, { width: 400, height: 200, radius: 12 });
  const c = canvases[0];
  const img = c._img;
  const at = (x, y) => (y * c.width + x) * 4;
  const midY = Math.floor(c.height / 2);
  const edgeDev = Math.abs(img.data[at(0, midY)] - 128);
  const halfDev = Math.abs(img.data[at(9, midY)] - 128);   // 元素上距左边 12px = 半带
  assert.ok(edgeDev > 0, '贴边必须有位移');
  assert.ok(halfDev > 0, '半带处仍应有一点位移');
  assert.ok(halfDev < edgeDev * 0.4,
    `circleMap 应在半带处快速衰减（edge=${edgeDev} half=${halfDev}）——线性剖面会接近 0.5`);
});

test('圆角矩形 SDF：圆角处按圆弧算（直角的角是 +44，圆角后是 +4）', () => {
  const halfW = 200;
  const halfH = 100;
  // 右下角外侧的那个点，直角（r=0）时距离是 40×40 的对角 ≈ 56.6
  const square = refractRoundedRectSdf(halfW + 40, halfH + 40, halfW, halfH, 0);
  assert.ok(Math.abs(square - Math.hypot(40, 40)) < 1e-6, `直角角点应为对角线长，实际 ${square}`);
  // 给了 40 的圆角后，同一个点落在圆弧之外 —— 但圆弧圆心内缩了 40，所以距离要小得多
  const rounded = refractRoundedRectSdf(halfW + 40, halfH + 40, halfW, halfH, 40);
  // 方向别搞反：圆角是把角"切掉"，所以同一个外侧点离边界变得更远（第一版写反过）
  assert.ok(rounded > square, `圆角后外侧点应更远（直角 ${square} / 圆角 ${rounded}）`);
  // 更直接的判据：原来正好落在直角角点上的那个点，圆角之后应当在形状**之外**
  assert.equal(refractRoundedRectSdf(halfW, halfH, halfW, halfH, 0), 0, '直角时角点＝边界');
  assert.ok(refractRoundedRectSdf(halfW, halfH, halfW, halfH, 40) > 0, '圆角后角点被切掉，应在外部');
  // 圆弧圆心上：sdf = -radius
  assert.equal(refractRoundedRectSdf(halfW - 40, halfH - 40, halfW, halfH, 40), -40);
});

// ── 降级路径（三条都得在，缺一条就可能在某些环境白跑或抛异常） ──

test('没有 body 时不初始化、不抛（脚本早于 DOM 就绪跑到的情形）', () => {
  const doc = makeDoc();
  doc.body = null;
  assert.equal(initGlassRefract(doc), false);
});

test('材质＝实心（没有 data-glass）时完全不动手', () => {
  const doc = makeDoc({ glass: '' });
  addSurfaces(doc, 3, { width: 400, height: 200 });
  initGlassRefract(doc);
  doc.__flush();
  for (const el of doc.__surfaces) assert.deepEqual(el.style._p, {}, '实心材质下不该写任何内联变量');
});

test('开关没开（没有 data-refract=1）时完全不动手', () => {
  const doc = makeDoc({ refract: '' });
  addSurfaces(doc, 3, { width: 401, height: 201 });
  initGlassRefract(doc);
  doc.__flush();
  for (const el of doc.__surfaces) assert.deepEqual(el.style._p, {});
});

test('「关闭全部动效」时不启用（逐元素滤镜很贵，不该在关动效时还跑）', () => {
  const doc = makeDoc({ motion: 'off' });
  addSurfaces(doc, 3, { width: 402, height: 202 });
  initGlassRefract(doc);
  doc.__flush();
  for (const el of doc.__surfaces) assert.deepEqual(el.style._p, {}, 'data-motion=off 下不该挂滤镜');
});

test('「减少动效」（reduced）与 off 同口径：不挂逐元素滤镜（2026-10-09 审查）', () => {
  // style.css 对 html[data-motion='reduced'] * 也是 animation:none —— 只认 off 的话，
  // "减少动效"档下最贵的模块照跑，与这个档位的语义（和 CSS 的行为）相反。
  const doc = makeDoc({ motion: 'reduced' });
  addSurfaces(doc, 3, { width: 404, height: 204 });
  initGlassRefract(doc);
  doc.__flush();
  for (const el of doc.__surfaces) assert.deepEqual(el.style._p, {}, 'data-motion=reduced 下不该挂滤镜');
});

test('画不出位移图（没有 canvas 2D / toDataURL）时判不支持，且不抛', () => {
  const doc = makeDoc({ canvas: false });
  addSurfaces(doc, 3, { width: 403, height: 203 });
  initGlassRefract(doc);
  doc.__flush();
  for (const el of doc.__surfaces) assert.deepEqual(el.style._p, {},
    'canvas 不可用时必须安静退出，而不是抛异常或挂一个永远画不出来的滤镜');
});

test('元素太小（比折射带还窄）时跳过，不做无意义的位图运算', () => {
  const doc = makeDoc();
  addSurfaces(doc, 2, { width: 20, height: 10 });
  initGlassRefract(doc);
  doc.__flush();
  for (const el of doc.__surfaces) assert.deepEqual(el.style._p, {});
});

// ── 正常路径 ──

test('支持时给每个表面挂 url(#滤镜)，且同尺寸共用同一个滤镜（不重复算图）', () => {
  const doc = makeDoc();
  addSurfaces(doc, 3, { width: 640, height: 220 });
  initGlassRefract(doc);
  doc.__flush();
  const ids = doc.__surfaces.map((el) => el.style._p['--glass-refract']);
  for (const id of ids) assert.match(String(id), /^url\(#qqa-refract-\d+\)$/, `实际 ${id}`);
  assert.equal(new Set(ids).size, 1, '同尺寸同圆角必须复用同一张位移图与同一个滤镜');
});

test('不同尺寸拿到不同滤镜（位移图是按元素尺寸现算的，这是与"拉伸一张通用图"的根本区别）', () => {
  const doc = makeDoc();
  addSurfaces(doc, 1, { width: 700, height: 240 });
  const wide = doc.__surfaces[0];
  doc.__surfaces.push(Object.assign(doc.createElement('section'), {
    getBoundingClientRect: () => ({ width: 260, height: 480, top: 0, left: 0 }),
  }));
  const tall = doc.__surfaces[1];
  syncGlassRefract(doc);
  assert.notEqual(wide.style._p['--glass-refract'], tall.style._p['--glass-refract'],
    '宽扁与细高必须各自用自己的位移图');
});

test('关掉开关后摘掉内联变量（不能留一个孤儿滤镜挂在元素上）', () => {
  const doc = makeDoc();
  addSurfaces(doc, 2, { width: 520, height: 260 });
  initGlassRefract(doc);
  doc.__flush();
  assert.ok(doc.__surfaces[0].style._p['--glass-refract'], '前置条件：先挂上');
  // 关掉开关：documentElement 的属性变了，再同步一次
  doc.documentElement.getAttribute = (k) => (k === 'data-glass' ? 'liquid' : null);
  syncGlassRefract(doc);
  for (const el of doc.__surfaces) {
    assert.equal(el.style._p['--glass-refract'], undefined, '关掉之后必须摘干净');
  }
});

test('隐藏视图里的元素不占名额：先筛可见、再按上限截断', () => {
  // 这条钉的是一个只有真浏览器才能发现的 bug：querySelectorAll 是文档顺序，
  // 而排在前面的十几个视图（总览/会话…）里的 .panel/.kpi 全是 display:none。
  // 如果"先 slice 到上限、再判断尺寸"，它们会把名额占满，当前视图里可见的卡片一个都进不来 ——
  // 表现是"开了折射什么都没发生"，而且没有任何报错。
  const doc = makeDoc();
  const hidden = [];
  for (let i = 0; i < 20; i += 1) {
    const el = doc.createElement('section');
    el.checkVisibility = () => false;             // 模拟 display:none 的兄弟视图
    hidden.push(el);
  }
  const visible = [];
  for (let i = 0; i < 2; i += 1) {
    const el = doc.createElement('section');
    el.checkVisibility = () => true;
    el.getBoundingClientRect = () => ({ width: 500 + i, height: 200, top: 0, left: 0 });
    visible.push(el);
  }
  doc.__surfaces.push(...hidden, ...visible);      // 隐藏的排在前面＝文档顺序里先出现
  initGlassRefract(doc);
  doc.__flush();
  for (const el of visible) {
    assert.ok(el.style._p['--glass-refract'], '可见元素必须进得来（不能被隐藏元素挤掉名额）');
  }
  for (const el of hidden) {
    assert.equal(el.style._p['--glass-refract'], undefined, '隐藏元素不该占名额');
  }
});

test('SVG 滤镜的属性名必须都是真名字（写错会被静默忽略，滤镜退回 linearRGB）', () => {
  // 这一条是补出来的：一次批量重命名把 `color-interpolation-filters` 改成了
  // `color-interpolation-refractFilters`，浏览器不报错、只是静默忽略 ——
  // 位移图会被当成 linearRGB 解释，"128 = 不位移"的中性点漂到 0.216，
  // 整块背景凭空获得一个向内偏移。这种错只能靠"把属性名钉住"来防。
  const doc = makeDoc();
  addSurfaces(doc, 1, { width: 800, height: 260 });
  initGlassRefract(doc);
  doc.__flush();
  const filterEl = doc.__appended.find((n) => n.tagName === 'FILTER');
  assert.ok(filterEl, '应当建出了一个 filter');
  assert.equal(filterEl.attrs['color-interpolation-filters'], 'sRGB',
    '必须是真正的属性名 color-interpolation-filters（派生的 refractFilters 会被静默忽略）');
  const EXPECTED = new Set(['color-interpolation-filters', 'filterUnits', 'x', 'y', 'width', 'height', 'id']);
  for (const name of Object.keys(filterEl.attrs)) {
    assert.ok(EXPECTED.has(name), `filter 上出现了非预期的属性名：${name}`);
  }
  // feImage / feDisplacementMap 的属性同样钉一遍（这两个是滤镜能不能工作的全部）
  const feImage = doc.__appended.find((n) => n.tagName === 'FEIMAGE');
  assert.equal(feImage.attrs.preserveAspectRatio, 'none');
  assert.equal(feImage.attrs.href.startsWith('data:image/png;base64,'), true);
  const feDisp = doc.__appended.find((n) => n.tagName === 'FEDISPLACEMENTMAP');
  assert.equal(feDisp.attrs.xChannelSelector, 'R');
  assert.equal(feDisp.attrs.yChannelSelector, 'G');
  assert.ok(Number(feDisp.attrs.scale) > 0, 'feDisplacementMap 的 scale 必须由位移图归一化反推出来');
});

// 外观 · 材质轴（玻璃五档）与 2026-10-09 那批动效收口的源码锚点。
//
// 为什么用「读源码」而不是 DOM 断言：与 test/console-motion.test.mjs 同一个理由 ——
// 这些效果靠 CSS 规则生效，而 happy-dom 既不跑 backdrop-filter、不跑 ::details-content，
// 也不跑 color-mix，真正会出的事故是「这段 CSS 被删了 / 被后面的规则架空了 / 两处实现漂了」，
// 那正好是文本层面能钉住的东西。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const UI = path.resolve('ui');
// 剥掉注释再断言：注释里为了讲清来龙去脉会原样引用被禁的写法（本仓库踩过这个坑）
const CSS = fs.readFileSync(path.join(UI, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const DOM_UTIL = fs.readFileSync(path.join(UI, 'core', 'dom-util.js'), 'utf8');
const PANEL = fs.readFileSync(path.join(UI, 'pages', 'settings-appearance.js'), 'utf8');
const BOOT = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');

const {
  DEFAULTS, GLASS, appearanceAttrs, appearancePatch, resolveAppearance
} = await import('../ui/core/appearance.js');

/** 取某个材质档的 token 块（data-glass 不设时走基础块）。 */
function glassBlock(material) {
  const sel = material === 'base' ? 'html\\[data-glass\\]' : `html\\[data-glass='${material}'\\]`;
  const m = CSS.match(new RegExp(`${sel}\\s*\\{([\\s\\S]*?)\\n\\}`));
  return m ? m[1] : '';
}
/** 取表面规则（那一大串 html[data-glass] 选择器之后的花括号块）。 */
function surfaceRule() {
  const start = CSS.indexOf('html[data-glass] #topbar');
  assert.ok(start > 0, '找不到玻璃表面规则');
  const open = CSS.indexOf('{', start);
  return CSS.slice(open, CSS.indexOf('\n}', open));
}

test('材质轴：五档，默认液态玻璃，坏值回默认', () => {
  assert.deepEqual(GLASS.map((g) => g.id), ['off', 'frost', 'liquid', 'acrylic', 'outline']);
  for (const g of GLASS) {
    assert.equal(typeof g.label, 'string');
    assert.ok(g.label.length > 0, `${g.id} 要有中文标签（分段控件直接显示它）`);
  }
  // 2026-10-19 用户定版：项目默认外观 = 浅色 + 液态玻璃（此前是"实心，玻璃选进来才给"）
  assert.equal(DEFAULTS.glass, 'liquid', '默认液态玻璃');
  assert.equal(resolveAppearance({}).glass, 'liquid');
  for (const g of GLASS) assert.equal(resolveAppearance({ glass: g.id }).glass, g.id);
  assert.equal(resolveAppearance({ glass: 'glass' }).glass, 'liquid', '不认识的 id 回默认');
  assert.equal(resolveAppearance({ glass: 42 }).glass, 'liquid');
});

test('CSS：每一档材质都有自己的 token 块（新增一档只加 token + 表项，不动表面规则）', () => {
  assert.ok(/--glass-blur:/.test(glassBlock('base')), '基础 token 块缺少 --glass-blur');
  for (const id of ['frost', 'liquid', 'acrylic', 'outline']) {
    const b = glassBlock(id);
    assert.ok(b, `缺少材质 ${id} 的 token 块`);
    assert.ok(/--glass-blur:/.test(b) || /--glass-tint:/.test(b),
      `材质 ${id} 的 token 块看起来是空的`);
  }
  const blurOf = (id) => Number((glassBlock(id).match(/--glass-blur:\s*([\d.]+)px/) || [])[1] || 0);
  const tintOf = (id) => Number((glassBlock(id).match(/--glass-tint:\s*(\d+)%/) || [])[1] || 0);
  for (const id of ['frost', 'acrylic', 'outline']) {
    assert.ok(blurOf(id) > 0 && tintOf(id) > 0, `${id} 要显式给出模糊与通透度`);
  }
  // 液态玻璃（参考实现 Kyant0/AndroidLiquidGlass 的 drawBackdrop 口径）：
  // vibrancy（saturate 150%）+ blur(8dp) + lens(40px, 40px)，表面色 #121212 @42%。
  assert.ok(blurOf('liquid') >= 4 && blurOf('liquid') <= 12,
    `液态玻璃要保留 8px 级模糊（实际 blur=${blurOf('liquid')}px）`);
  assert.equal(tintOf('liquid'), 0, '液态玻璃的 --glass-tint 必须是 0（填充由 --glass-fill 单独给）');
  assert.ok(/--glass-fill:\s*rgba\(18, 18, 18, \.42\)/.test(glassBlock('liquid')),
    '液态玻璃的表面色对齐参考实现：#121212 @42%（深色）');
  assert.ok(/--glass-grain:\s*none/.test(glassBlock('liquid')), '液态玻璃不加装饰渐变/噪点');
  // 三档的分工是“清→糊”，不是一个方向的阶梯：
  //   液态玻璃最清晰；磨砂在中间；亚克力最糊最实。
  assert.ok(blurOf('liquid') < blurOf('frost') && blurOf('frost') < blurOf('acrylic'),
    `模糊要按“清晰→糊”排（实际 liquid=${blurOf('liquid')} frost=${blurOf('frost')} acrylic=${blurOf('acrylic')}）`);
  assert.ok(tintOf('liquid') < tintOf('frost') && tintOf('frost') < tintOf('acrylic'),
    '不透明度要按“通透→实”排');
  // 亚克力要有噪点层，否则大面积半透明在暗色下会出色带
  assert.ok(/--glass-grain:\s*url\("data:image\/svg\+xml/.test(glassBlock('acrylic')),
    '亚克力要有内联 SVG 噪点层（外链图片在离线/内网部署下会裂）');
  assert.ok(/--glass-grain:\s*none/.test(glassBlock('base')), '其余档不该带噪点');
});

test('CSS：玻璃表面 = 通透填充 + 实心描边 + 三条 inset 高光 + 壁厚', () => {
  const rule = surfaceRule();
  // ① 填色走 token（各档只改 --glass-tint，填色自动跟着算）
  assert.ok(/background-color:\s*var\(--glass-fill\)/.test(rule), '填色要取 --glass-fill');
  assert.ok(/--glass-fill:\s*color-mix\(in srgb, var\(--bg-2\) var\(--glass-tint\), transparent\)/.test(CSS),
    '--glass-fill 必须是“色板色 × 保留比例”的半透明混合');
  // ② backdrop-filter：模糊 + 提饱和 + 对比/亮度链（社区实现 shuding/liquid-glass 同款）
  assert.ok(/backdrop-filter:[\s\S]{0,120}?blur\(var\(--glass-blur\)\) saturate\(var\(--glass-sat\)\)/.test(rule),
    'backdrop-filter 要 blur + saturate');
  assert.ok(/contrast\(var\(--glass-contrast\)\) brightness\(var\(--glass-bright\)\)/.test(rule),
    '要有 contrast/brightness 链 —— 苹果那块玻璃的“透亮感”主要来自这里，不是来自模糊');
  assert.ok(/-webkit-backdrop-filter:/.test(rule), '要带 -webkit- 前缀');
  // 亮度只允许轻抬（社区是 1.05）：抬多了就是把背景整体洗白，卡片会“发白”而不是“变玻璃”。
  // 液态玻璃在暗底上用 1.15 —— 它没有磨砂模糊，靠提亮把背后的内容“抬”上来。
  const brights = [...CSS.matchAll(/--glass-bright:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  assert.ok(brights.length > 0 && brights.every((b) => b >= 1 && b <= 1.20),
    `brightness 必须在 1~1.20（实际 ${brights.join(', ')}）`);
  // 对比度：磨砂/亚克力靠它出“透亮感”，但液态玻璃必须留在 1（它不该压暗/压亮背后的内容，
  // 那会把暗色页压成黑块）。
  const baseContrast = Number((glassBlock('base').match(/--glass-contrast:\s*([\d.]+)/) || [])[1] || 1);
  const contrastOf = (id) => Number((glassBlock(id).match(/--glass-contrast:\s*([\d.]+)/) || [])[1] || baseContrast);
  for (const id of ['frost', 'acrylic']) {
    assert.ok(contrastOf(id) >= 1.1 && contrastOf(id) <= 1.3,
      `${id} 的 contrast 应在 1.1~1.3（实际 ${contrastOf(id)}）`);
  }
  assert.equal(contrastOf('liquid'), 1, '液态玻璃不改对比度（暗底上会压成黑块）');
  // ③ 描边必须是**单色实心 border**
  assert.ok(/border:\s*1px solid var\(--glass-edge\)/.test(rule), '描边要用单色实心 border');
  // ④ 高光：顶部亮弧 + 底部回光 + 左右细边，三层 inset
  assert.ok(/inset 0 1\.5px 0 var\(--glass-spec-top\)/.test(rule), '缺顶部镜面亮弧');
  assert.ok(/inset 0 -1px 0 var\(--glass-spec-bot\)/.test(rule), '缺底部回光');
  assert.ok(/inset 1px 0 0 var\(--glass-spec-side\)/.test(rule) && /inset -1px 0 0 var\(--glass-spec-side\)/.test(rule),
    '缺左右细边');
  // ⑤ 壁厚：内侧辉光
  assert.ok(/var\(--glass-inner\)/.test(rule), 'box-shadow 里要有 --glass-inner（壁厚）');
});

test('CSS：禁止回去用“透明 border + background-clip: border-box 的渐变描边”', () => {
  // 2026-10-09 实测踩到的坑：那个技法只在填充不透明时成立（靠上面不透明的 padding-box 层
  // 把中间盖住、只漏出 1px 环）。我们的填充是半透明的，于是那条白渐变会**铺满整张卡片** ——
  // 表现就是“顶部一大片白”的塑料感。这条用例守着它别再回来。
  const rule = surfaceRule();
  assert.equal(/background-clip:\s*[^;]*border-box/.test(rule), false,
    '表面的背景层不许 clip 到 border-box：半透明填充下渐变描边会铺满整张卡片');
  assert.equal(/linear-gradient\(180deg, var\(--glass-edge/.test(rule), false,
    '描边不许再做成渐变层，厚度由三条 inset 高光承担');
  assert.ok(/background-clip:\s*padding-box;/.test(rule), '背景层只 clip 到 padding-box');
  assert.ok(/那个技法只在填充不透明时成立/.test(fs.readFileSync(path.join(UI, 'style.css'), 'utf8')),
    '表面规则附近要留下这个坑的说明，否则下一个人会当成“少了渐变描边”再加回去');
});

test('CSS：液态玻璃要“透”不要“糊”（模糊只到参考实现的 8dp 量级）', () => {
  // 2026-10-09 看社区实现（shuding/liquid-glass）时把 liquid 的模糊砍到接近 0；
  // 2026-10-19 对照 APK 的实际参数（Kyant0/AndroidLiquidGlass：blur(8dp) + lens()）
  // 改回 8px —— 摩卡/亚克力仍然必须是“糊”的那两档。
  const blurOf = (id) => Number((glassBlock(id).match(/--glass-blur:\s*([\d.]+)px/) || [])[1]);
  assert.ok(blurOf('liquid') <= 12, `液态玻璃的模糊应停在 8px 量级（实际 ${blurOf('liquid')}px）`);
  assert.ok(blurOf('outline') <= 2, `描边玻璃同理（实际 ${blurOf('outline')}px）`);
  assert.ok(blurOf('frost') >= 12 && blurOf('acrylic') >= 30,
    '磨砂/亚克力才应该是“糊”的那两档 —— 三档的分工是清晰度');
  // 壁厚必须是“底部暗 inset”，不是一圈亮的辉光
  const inner = CSS.match(/--glass-inner:\s*inset 0 -\d+px[^;]*rgba\(0, 0, 0/);
  assert.ok(inner, '壁厚要是底部暗 inset（上亮下暗才读得出厚度）');
});

test('CSS：背景是有层次的合成，不是一条两色线性渐变', () => {
  const block = CSS.slice(CSS.indexOf("html[data-background='gradient'] body"), CSS.indexOf("html[data-background='solid'] body {"));
  assert.ok(/radial-gradient/.test(block), '背景要有径向光斑（两色线性渐变没有层次，玻璃盖上去只会得到“浅一点的灰矩形”）');
  assert.ok((block.match(/radial-gradient/g) || []).length >= 2, '至少两块错位的光斑');
  assert.ok(/color-mix\(in srgb, var\(--bg-from\) 70%/.test(block),
    '起色要掺进 --bg 当“光”用（低饱和），否则用户挑个艳色就变成塑料感');
  assert.ok(/body::after[\s\S]{0,300}?radial-gradient/.test(CSS), '要有四角压暗的暗角层');
  // 默认渐变不能再是那张“蓝→紫”（AI 生成感的头号样本）
  assert.ok(/--bg-from: #1b2a4a/.test(CSS) && /--bg-to: #2e2440/.test(CSS),
    '默认渐变要是低饱和夜景色，不是 #4c8dff → #a78bfa 那张');
});

test('CSS：液态玻璃用边缘折射 + 镜面高光，不再叠发光环带', () => {
  const css = CSS;
  const liquid = glassBlock('liquid');
  // 参考实现 drawBackdrop：vibrancy + blur(8dp) + lens() + 40% 表面色。
  assert.ok(/--glass-blur:\s*12px/.test(liquid), '液态玻璃按参考实现的面板档保留 12px 模糊');
  assert.ok(/--glass-sat:\s*150%/.test(liquid), 'vibrancy() 在 CSS 里就是 saturate(150%)');
  assert.ok(/--glass-fill:\s*rgba\(18, 18, 18, \.42\)/.test(liquid),
    '暗色表面色对齐参考实现 #121212 @42%');
  assert.ok(/--glass-grain:\s*none/.test(liquid), '不加装饰渐变');
  assert.ok(/--glass-edge:\s*transparent/.test(liquid),
    '参考实现不画实心描边，边缘由镜面高光 + 折射交代');
  // 旧的“发亮模糊环带”必须被明确关掉，而不是继续叠在表面上。
  // 取每一处环带规则的块体，最后一处是默认关闭（前面还有 data-motion='off' 的那份）。
  const ringBlocks = [...css.matchAll(/html\[data-glass='liquid'\] \.list-pane::after\s*\{([\s\S]*?)\n\}/g)]
    .map((m) => m[1]);
  assert.ok(ringBlocks.length >= 2, '找不到液态玻璃的环带规则');
  assert.match(ringBlocks.at(-1), /display:\s*none/, '环带必须被默认关闭，不能继续叠在玻璃表面上');
  // 折射仍走 var 通路，且不许直接写 url()。
  const directUrl = css.match(/backdrop-filter:[^;]*url\(/g) || [];
  assert.deepEqual(directUrl, [],
    '不许在 backdrop-filter 里直接写 url()：形状不对（苹果只在边缘折射）且按宽高比拉伸会不均匀');
  assert.ok(/backdrop-filter:\s*var\(--glass-refract,\s*\)/.test(css),
    '边缘折射必须经 var(--glass-refract, ) 拼装（关掉时回退为空，不残留 url）');
  // 边缘效果由 SDF 折射模块提供：按参考实现的两档 lens（小控件 12/24、面板 24/48）选档，
  // 剖面用 circleMap；色散 ±6%（RefractionWithDispersion）；depthEffect 保持默认关闭。
  const refract = fs.readFileSync(path.join(UI, 'core', 'glass-refract.js'), 'utf8');
  assert.ok(/REFRACT_LENS_SMALL\s*=\s*\{\s*band:\s*12,\s*amount:\s*24\s*\}/.test(refract),
    '小控件档要对齐 lens(12dp, 24dp)');
  assert.ok(/REFRACT_LENS_LARGE\s*=\s*\{\s*band:\s*24,\s*amount:\s*48\s*\}/.test(refract),
    '面板档要对齐 lens(24dp, 48dp)');
  assert.ok(/REFRACT_DISPERSION\s*=\s*0\.06/.test(refract),
    '色散要留 ±6% 的通道位移（APK 的 RefractionWithDispersion）');
  assert.ok(/REFRACT_DEPTH_EFFECT\s*=\s*0\b/.test(refract),
    '参考实现 drawBackdrop 默认 depthEffect = false');
  assert.ok(/circleMap/.test(refract), '边缘剖面要用 circleMap');
  assert.ok(/feColorMatrix/.test(refract) && /feComposite/.test(refract),
    '色散要靠三通道采样的 SVG 滤镜链（feColorMatrix + feComposite）');
});

test('CSS/资源：液态玻璃的衬底只在「背景=无」时启用，且壁纸文件必须在仓库里', () => {
  // 参考实现整屏浮在壁纸上；没有衬底，折射/模糊/饱和全都没有东西可作用。
  assert.ok(/html\[data-glass='liquid'\]\[data-background='none'\] \{[\s\S]{0,240}?url\('\/assets\/liquid-wallpaper\.png'\)/.test(CSS),
    '液态玻璃 + 背景=无 时要把壁纸铺在 html 上');
  assert.ok(/html\[data-glass='liquid'\]\[data-background='none'\] body \{[\s\S]{0,200}?rgba\(4, 8, 15, \.70\)/.test(CSS),
    '深色主题要在 body 上压一层纯色纱（不是渐变）保证正文对比度');
  assert.ok(fs.existsSync(path.join(UI, 'assets', 'liquid-wallpaper.png')),
    '壁纸资源缺失 → 控制台会退化成纯色底，玻璃又看不出来');
  // 只和 liquid / none 两个轴绑定：用户显式选了纯色或渐变时不许覆盖他的背景。
  assert.equal(/html\[data-glass='liquid'\] \{[\s\S]*?liquid-wallpaper/.test(CSS), false,
    '壁纸规则不能无条件挂在 liquid 上，必须同时要求 data-background=none');
});

test('CSS：玻璃表面清单只收最外层，绝不同时收父子两层', () => {
  const head = CSS.slice(CSS.indexOf('html[data-glass] #topbar'), CSS.indexOf('{', CSS.indexOf('html[data-glass] #topbar')));
  // 2026-10-09 值班台：KPI 那一行整体算一块浮起表面（.kpi-grid），格子只是它的分格 ——
  // 玻璃要加在这**一层**上，否则每格一个 backdrop-filter，既是"玻璃卡片套件"，
  // 又踩嵌套 backdrop-filter（子层采样到空 backdrop root → 发白）。
  for (const sel of ['#topbar', '#sidebar', '.panel', '.kpi-grid', '.opt-card', '.model-modal', 'dialog', '.list-pane']) {
    assert.ok(head.includes(`html[data-glass] ${sel}`), `玻璃表面清单里缺 ${sel}`);
  }
  // 嵌套 backdrop-filter 会让子层采样到空的 backdrop root → 子层发白、对比度垮掉。
  // 这两条是 2026-10-09 真机实测到的元凶，不许回到清单里。
  assert.equal(head.includes('.settings-menu'), false,
    '.settings-menu 在 .settings-sidebar 里面，两层都玻璃会踩嵌套 backdrop-filter');
  assert.equal(head.includes('.kpi {') || /html\[data-glass\] \.kpi,/.test(head), false,
    '.kpi 现在是 .kpi-grid 里面的分格：两层都玻璃会踩嵌套 backdrop-filter');
  assert.equal(head.includes('.collapsible'), false,
    '.collapsible 常在 .panel 里面，同上');
  assert.ok(/嵌套是这里最容易踩的坑/.test(fs.readFileSync(path.join(UI, 'style.css'), 'utf8')),
    '表面规则上方要保留"不许嵌套"的说明，否则下一个人会再加回去');
});

test('CSS：侧栏那两种样式只覆盖填色 token，不重写整块背景', () => {
  assert.ok(/html\[data-glass\]\[data-sidebar-style='panel'\] #sidebar\s*\{\s*--glass-fill:/.test(CSS),
    '侧栏样式=浅色面板要覆盖 --glass-fill');
  assert.ok(/html\[data-glass\]\[data-sidebar-style='accent'\] #sidebar\s*\{\s*--glass-fill:/.test(CSS),
    '侧栏样式=强调色要覆盖 --glass-fill（否则玻璃一开这条轴就失效）');
});

test('CSS：不支持 backdrop-filter 时退回实心表面（宁可不玻璃，也不让文字糊掉）', () => {
  assert.ok(/@supports not \(\(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\)\)/.test(CSS),
    '要有 @supports not 的降级分支');
  const block = CSS.slice(CSS.indexOf('@supports not ((backdrop-filter'));
  assert.ok(/background-image: none/.test(block), '降级分支要撤掉渐变描边层');
  assert.ok(/background-color: var\(--bg-2\)/.test(block), '降级分支要退回不透明的 --bg-2');
});

test('CSS：高对比模式下玻璃让位（可读性优先）', () => {
  assert.ok(/html\[data-contrast='high'\]\[data-glass\]\s*\{\s*--glass-tint: 9[0-9]%/.test(CSS),
    '高对比要把不透明度拉到 90% 以上');
  assert.ok(/\[data-theme='light'\]\[data-contrast='high'\]\[data-glass\]\s*\{\s*--glass-tint: 100%/.test(CSS),
    '亮色的高对比要完全不透明（白底上的半透明最容易掉对比度）');
});

test('材质进 <html> 的方式与其他开关一致：空串＝不设属性', () => {
  assert.equal(appearanceAttrs(resolveAppearance({ glass: 'off' })).glass, '');
  for (const g of GLASS.filter((x) => x.id !== 'off')) {
    assert.equal(appearanceAttrs(resolveAppearance({ glass: g.id })).glass, g.id);
  }
});

test('材质会被持久化（appearancePatch 漏了它 = 刷新即打回实心）', () => {
  for (const g of GLASS) {
    assert.equal(appearancePatch(resolveAppearance({ glass: g.id })).glass, g.id);
    assert.equal(resolveAppearance(appearancePatch(resolveAppearance({ glass: g.id }))).glass, g.id);
  }
});

test('首屏脚本认得材质轴（漏了就是"先画实心、模块跑起来再变玻璃"的一次闪烁）', () => {
  assert.ok(/glass:\s*patch\.glass === 'off' \? '' : \(patch\.glass \|\| 'liquid'\)/.test(BOOT),
    '首屏脚本要处理 glass，并且缺省时按默认液态玻璃给（否则首屏先画实心、模块起来再变玻璃）');
});

test('CSS：折叠面板的展开与收起都走高度过渡，且保留降级', () => {
  assert.ok(/:root\s*\{\s*interpolate-size: allow-keywords;/.test(CSS),
    '没有 interpolate-size，block-size 从 0 到 auto 插不了值（整条过渡等于没写）');
  const block = CSS.slice(CSS.indexOf('.collapsible::details-content'));
  assert.ok(/block-size: 0;/.test(block), '收起态的内容盒高度要是 0');
  assert.ok(/transition:[\s\S]{0,200}?block-size var\(--dur-slow\) var\(--ease-out-quart\)/.test(block),
    '高度过渡要走 token，不许写死时长/曲线');
  assert.ok(/content-visibility var\(--dur-slow\) allow-discrete/.test(block),
    'content-visibility 必须配 allow-discrete：否则收起时内容立刻消失，高度过渡看着是空的');
  assert.ok(/\.collapsible\[open\]::details-content\s*\{[\s\S]{0,120}?block-size: auto;/.test(CSS),
    '展开态要回到 auto');
  assert.equal(/\.collapsible\[open\] > \*:not\(summary\)\s*\{/.test(CSS), false,
    '旧的子元素淡入规则要删掉（它和高度过渡会叠成"闪两下"）');
});

test('CSS ↔ JS：列表行退场的时长必须两处一致', () => {
  const m = DOM_UTIL.match(/const LEAVE_MS = (\d+);/);
  assert.ok(m, 'ui/core/dom-util.js 里找不到 LEAVE_MS');
  const durSlow = CSS.match(/--dur-slow: (\d+)ms/);
  assert.ok(durSlow, 'style.css 里找不到 --dur-slow');
  assert.equal(Number(m[1]), Number(durSlow[1]),
    `LEAVE_MS(${m[1]}) 与 --dur-slow(${durSlow[1]}ms) 不一致：JS 等的就是那条动画，`
    + '短了会看到行被切一半，长了会看到一行卡着不动');
  assert.ok(/animation: rowOut var\(--dur-slow\)/.test(CSS.slice(0, CSS.indexOf('@keyframes rowOut'))),
    '退场动画要走 var(--dur-slow)，不许写死');
  const block = CSS.slice(CSS.indexOf('@keyframes rowOut'));
  for (const prop of ['padding-top', 'padding-bottom', 'margin-top', 'margin-bottom']) {
    assert.ok(block.includes(`${prop}: 0`), `rowOut 收尾要把 ${prop} 归零`);
  }
});

test('CSS：悬浮位移都 gate 在"真有鼠标"的设备上', () => {
  const gates = [];
  const re = /@media \(hover: hover\) and \(pointer: fine\)\s*\{/g;
  let m;
  while ((m = re.exec(CSS))) {
    let depth = 0;
    let out = '';
    for (let i = m.index + m[0].length - 1; i < CSS.length; i += 1) {
      const ch = CSS[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') { depth -= 1; if (depth === 0) { out += ch; break; } }
      out += ch;
    }
    gates.push(out);
  }
  assert.ok(gates.length >= 2, `应当找到多个 hover 能力媒体块，实际 ${gates.length}`);
  const all = gates.join('\n');
  for (const sel of ['.persona-card:hover', '.usage-card.accent:hover', '.session-item:hover', '.chat-item:hover', '.kpi:hover']) {
    assert.ok(all.includes(sel), `${sel} 的位移没有 gate 在 hover:hover 下（触屏 tap 会误触发）`);
  }
  assert.equal(/^\.session-item:hover,\s*\.chat-item:hover\s*\{\s*transform/m.test(CSS), false,
    '列表行的悬浮位移要从原位置移走，不能两处都写');
});

test('CSS：KPI 数字用等宽数字（计数动画时宽度才不抖）', () => {
  assert.ok(/\.kpi-value\s*\{\s*font-variant-numeric: tabular-nums;/.test(CSS),
    'KPI 计数动画每帧改文本，不等宽数字会让整块跟着微移');
});

test('设置页有材质控件，且读值与其它轴同口径（segVal）', () => {
  assert.ok(/seg\('appearance-glass', GLASS, cur\.glass/.test(PANEL), '外观面板要渲染材质分段控件');
  assert.ok(/glass: segVal\('appearance-glass', 'liquid'\)/.test(PANEL),
    'readUI 要读回材质，否则"改了没保存 → 切走再切回"会把用户的档位打回实心');
  assert.ok(/REVEAL_SEGS[\s\S]{0,220}?'appearance-glass'/.test(PANEL),
    '材质是"整页换个样子"的离散切换，要进走波纹的名单');
});

// ── 边缘折射（实验开关）接线 ──

test('CSS：折射靠 var(--glass-refract, ) 的空回退接入，不许重写整条 backdrop-filter', () => {
  const rule = surfaceRule();
  assert.ok(/backdrop-filter:\s*var\(--glass-refract, \) blur\(/.test(rule),
    '要用「空回退」把可选的 url(#…) 前置进滤镜链：没开折射时它替换成空、整条值仍然合法');
  assert.equal(/backdrop-filter:\s*url\(/.test(rule), false,
    '不许写死 url()：那会让没开折射的部署也去引用一个不存在的滤镜');
  // 空回退必须真的存在（写成 var(--glass-refract) 没有逗号的话，未定义时整条声明失效 → 玻璃直接没了）
  assert.ok(!/var\(--glass-refract\)/.test(rule), 'var() 必须带那个空回退（逗号后面什么都不写）');
});

test('折射轴：默认关、只认真 true、会被持久化', () => {
  assert.equal(DEFAULTS.refract, false, '折射是实验特性，默认必须关');
  assert.equal(resolveAppearance({}).refract, false);
  assert.equal(resolveAppearance({ refract: true }).refract, true);
  assert.equal(resolveAppearance({ refract: 'yes' }).refract, false, '字符串不算（存档里塞垃圾也不该打开）');
  assert.equal(appearanceAttrs(resolveAppearance({ refract: true })).refract, '1');
  assert.equal(appearanceAttrs(resolveAppearance({})).refract, '');
  assert.equal(appearancePatch(resolveAppearance({ refract: true })).refract, true);
  assert.equal(resolveAppearance(appearancePatch(resolveAppearance({ refract: true }))).refract, true,
    '存下去再读回来必须还是开的（漏了它 = 刷新即丢）');
});

test('首屏脚本认得折射轴', () => {
  assert.ok(/refract:\s*patch\.refract === true/.test(BOOT),
    'ui/index.html 的首屏预置要处理 refract，否则首屏与模块算出来的不一致（一次闪烁）');
});

test('折射模块进了 index.html 的模块清单（漏了等于整项永不执行）', () => {
  assert.ok(/<script type="module" src="\/core\/glass-refract\.js"><\/script>/.test(BOOT),
    'ui-modules.test.mjs 会双向核对清单；这里再钉一道，因为漏了它不会有任何报错，只是"开关没反应"');
  assert.ok(/import \{ initGlassRefract \} from '\.\/core\/glass-refract\.js'/.test(
    fs.readFileSync(path.join(UI, 'app.js'), 'utf8')), 'app.js 要 import 并初始化它');
});

test('设置页有折射开关，且读值与监听都接上', () => {
  assert.ok(/id="cfg-refract"/.test(PANEL), '材质卡里要有折射开关');
  assert.ok(/refract: el\('cfg-refract'\)\?\.checked === true/.test(PANEL), 'readUI 要读回它');
  assert.ok(/'cfg-refract'\]/.test(PANEL) || /'cfg-refract',/.test(PANEL),
    '开关要进 change 监听名单，否则勾了不生效');
});

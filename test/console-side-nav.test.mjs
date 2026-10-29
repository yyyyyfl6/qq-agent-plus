// 侧栏的两个"参照控制台"效果（2026-10-08）：
//   ① 悬停展开的图标条：248 ↔ 64，标签淡入淡出而不是被切断
//   ② 会滑动的选中块：换页签时滑块滑过去，而不是"旧的消失、新的出现"
//
// 参照实现（SnowLuma WebUI 打包产物）的取值是量出来的、写在 style.css 的注释里：
// aside 宽 248 / 收起 64、宽度过渡 260ms cubic-bezier(.4,0,.1,1)、文字淡入淡出 200ms、
// 选中块是 Framer spring(stiffness 380, damping 32)。这里分两段验：
//   · 能真跑的 DOM 行为（滑块几何、title、ARIA、钉住后不再收起）用 happy-dom；
//   · CSS 取值（宽度/曲线/时长/关闭动效）只能读源码 —— 但先剥注释，免得被注释满足。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import { toClassicScript } from './helpers/ui-module-source.mjs';

let WindowClass = null;
try {
  ({ Window: WindowClass } = await import('happy-dom'));
} catch (e) {
  if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e;
}
const SKIP = WindowClass ? false : 'happy-dom 未安装（devDependencies；--omit=dev 环境按约定跳过）';

const UI = path.resolve('ui');
const CSS = fs.readFileSync(path.join(UI, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
/** 读仓库根下的文件（新加的用例按「根相对路径」写，与 ui-review-fixes 那个文件同一口径）。 */
const read = (rel) => fs.readFileSync(path.resolve(rel), 'utf8');
/** 剥注释：本仓注释习惯好，很容易在注释里复述旧写法 —— 不剥的话"不许出现 X"会被注释满足。 */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** 只加载侧栏相关的脚本：index.html 的骨架 + core 那几个 + app.js（switchTab 在那里）。 */
const HTML = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
const FILES = [...HTML.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1].replace(/^\//, ''));

function loadPage() {
  const window = new WindowClass({ url: 'http://127.0.0.1:3210/' });
  window.document.write(HTML.replace(/<script[^>]*>\s*<\/script>/g, ''));
  window.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  if (typeof window.structuredClone !== 'function') window.structuredClone = (v) => JSON.parse(JSON.stringify(v));
  window.EventSource = class { constructor() { this.readyState = 0; } addEventListener() {} close() {} };
  const ctx = vm.createContext(window);
  for (const file of FILES) {
    new vm.Script(toClassicScript(fs.readFileSync(path.join(UI, file), 'utf8'), file), { filename: `ui/${file}` }).runInContext(ctx);
  }
  return window;
}

/** happy-dom 没有布局引擎：offsetTop/offsetHeight 恒为 0。给它一个可预测的假几何。 */
function fakeGeometry(window, heights = 50, gap = 2) {
  const doc = window.document;
  const tabs = [...doc.querySelectorAll('#tabs > .tab')];
  tabs.forEach((tab, i) => {
    Object.defineProperty(tab, 'offsetTop', { value: i * (heights + gap), configurable: true });
    Object.defineProperty(tab, 'offsetHeight', { value: heights, configurable: true });
  });
  return tabs;
}

test('侧栏滑块：换页签时滑到新的那一项上（translateY/height 跟着选中项走）', { skip: SKIP }, () => {
  const window = loadPage();
  const doc = window.document;
  fakeGeometry(window);
  const nav = doc.getElementById('tabs');

  window.switchTab('overview');
  const pill = nav.querySelector(':scope > .side-pill');
  assert.ok(pill, '侧栏要有一个滑块元素（#tabs 的第一个子元素，免得盖住每一项）');
  assert.equal(nav.firstElementChild, pill, '滑块必须是第一个子元素：同级后面的 .tab 才画在它上面');
  assert.ok(pill.querySelector(':scope > .side-pill-bar'), '滑块里要带左缘强调条（参照实现是 layoutId 的 active-bar）');
  assert.equal(pill.getAttribute('aria-hidden'), 'true', '装饰性元素不进无障碍树');

  const at = (name) => {
    window.switchTab(name);
    return { y: pill.style.getPropertyValue('--side-pill-y'), h: pill.style.getPropertyValue('--side-pill-h') };
  };
  const first = at('overview');
  assert.equal(first.y, '0px', '第一项的滑块在顶部');
  assert.equal(first.h, '50px', '滑块高度＝选中项高度');

  // 第三项（存档，index 2）→ 位移 = 2*(50+2) = 104
  const third = at('chats');
  assert.equal(third.y, `${2 * (50 + 2)}px`, `滑块要滑到第三项上，实际 ${third.y}`);
  assert.equal(third.h, '50px');

  // 只有一项带 active（避免两个高亮同时亮着）
  assert.equal(doc.querySelectorAll('#tabs > .tab.active').length, 1);
  // 无障碍：当前页有 aria-current（从 .active 现推，所以首屏那条不经过 switchTab 的路也有）
  assert.equal(doc.querySelector('#tabs > .tab.active')?.getAttribute('aria-current'), 'page');
  assert.equal(doc.querySelectorAll('#tabs > .tab[aria-current]').length, 1, 'aria-current 只该有一个');
  // 首屏：index.html 里就写着 class="tab active"，没人调 switchTab，syncSideNav 也必须补上
  doc.querySelectorAll('#tabs > .tab[aria-current]').forEach((t) => t.removeAttribute('aria-current'));
  window.syncSideNav();
  assert.equal(doc.querySelector('#tabs > .tab.active')?.getAttribute('aria-current'), 'page',
    '首屏那条路（不经过 switchTab）也要有 aria-current');
  window.happyDOM?.abort?.();
});

test('图标条：收起时挂 title、悬停/聚焦才展开、钉住后不再收', { skip: SKIP }, () => {
  const window = loadPage();
  const doc = window.document;
  fakeGeometry(window);
  const side = doc.getElementById('sidebar');
  const root = doc.documentElement;

  window.initSideNav();
  assert.equal(side.dataset.sideBound, '1', '绑定要幂等（再调一次不该重复挂监听）');
  window.initSideNav();

  // 默认（未钉住）＝ 图标条模式，但还没悬停 → 收起
  root.removeAttribute('data-side-rail');
  window.syncSideNav();
  assert.equal(side.hasAttribute('data-side-open'), false, '没悬停时不该是展开态');

  root.setAttribute('data-side-rail', '1');
  window.syncSideNav();
  const overview = doc.querySelector('#tabs > .tab[data-tab="overview"]');
  assert.ok(overview.getAttribute('title'), '收起时每一项要有 title（只剩图标时看不出这格是什么）');
  assert.ok(overview.getAttribute('title').includes('总览'), 'title 要带上主名');

  // 悬停进去 → 展开，并且摘掉 title（可见文字已经说明了一切）
  side.dispatchEvent(new window.Event('pointerenter'));
  assert.equal(side.getAttribute('data-side-open'), '1', '鼠标进入要展开');
  assert.equal(overview.hasAttribute('title'), false, '展开后不该再挂同义提示');

  // 移开 → 收起
  side.dispatchEvent(new window.Event('pointerleave'));
  assert.equal(side.hasAttribute('data-side-open'), false, '鼠标离开要收起');
  assert.ok(overview.getAttribute('title'), '收起后 title 要回来');

  // 键盘：焦点进侧栏也要展开
  side.dispatchEvent(new window.Event('focusin'));
  assert.equal(side.getAttribute('data-side-open'), '1', '焦点进入要展开（否则键盘用户读不到完整标签）');
  side.dispatchEvent(new window.Event('focusout'));
  assert.equal(side.hasAttribute('data-side-open'), false, '焦点离开要收起');

  // 钉住：不再随鼠标收放，且把悬停留下的瞬时状态清掉
  side.setAttribute('data-side-open', '1');
  root.removeAttribute('data-side-rail');
  window.syncSideNav();
  assert.equal(side.hasAttribute('data-side-open'), false, '钉住后不该停在展开态上');
  side.dispatchEvent(new window.Event('pointerenter'));
  assert.equal(side.hasAttribute('data-side-open'), false, '钉住后悬停也不再切换状态');
  assert.equal(overview.hasAttribute('title'), false, '钉住（常驻展开）时不挂 title');
  window.happyDOM?.abort?.();
});

test('导航项显隐变化后滑块重新对位（首屏门控页签是在 init 之后才收起的）', { skip: SKIP }, async () => {
  // syncGraduatedFeatureNavigation 会给页签加/去 .hidden（人物印象/好友管理/异常处理按已固化的
  // 能力显隐），行高与项数随之变化 —— 不补一次对位，高亮就会停在错的那一行上。
  const window = loadPage();
  const doc = window.document;
  const tabs = fakeGeometry(window);
  window.initSideNav();
  window.switchTab('chats');
  const pill = doc.querySelector('#tabs > .side-pill');
  const before = pill.style.getPropertyValue('--side-pill-y');
  assert.equal(before, `${2 * (50 + 2)}px`);
  // 假装前面的项被收起/变矮（happy-dom 没有布局，这里直接给新的几何）
  tabs.forEach((t, i) => Object.defineProperty(t, 'offsetTop', { value: i * 30, configurable: true }));
  window.syncGraduatedFeatureNavigation({});
  await new Promise((r) => setTimeout(r, 60));   // scheduleSideNav 合并到下一帧
  assert.equal(pill.style.getPropertyValue('--side-pill-y'), `${2 * 30}px`,
    '显隐变化后要按新的行高重新对位');
  window.happyDOM?.abort?.();
});

test('图标条的样式取值与参照实现一致（宽度/曲线/时长/关闭动效）', () => {
  // 尺寸与曲线：248 / 64、260ms cubic-bezier(.4,0,.1,1)、文字 200ms
  assert.ok(/--side-w-full:\s*248px/.test(CSS), '展开宽 248px');
  assert.ok(/--side-w-rail:\s*64px/.test(CSS), '收起宽 64px');
  assert.ok(/--side-dur-w:\s*260ms/.test(CSS), '宽度过渡 260ms');
  assert.ok(/--side-ease-w:\s*cubic-bezier\(\.4,\s*0,\s*\.1,\s*1\)/.test(CSS), '宽度曲线 cubic-bezier(.4,0,.1,1)');
  assert.ok(/--side-dur-fade:\s*200ms/.test(CSS), '文字淡入淡出 200ms');
  // 只改宽度靠裁切，内层内容固定成「内容盒」宽（否则标签是"重排"而不是"露出来"）。
  // 必须是 --side-w-inner（外框宽 − 2×内边距），不是 --side-w-full —— 写成后者会让内层比内容盒
  // 宽 20px，底部那一排顶出右缘、最右图标被裁掉（用户实测报过这个）。
  assert.ok(/#sidebar > \.side-head, #sidebar > #tabs, #sidebar > \.side-foot \{ min-width: var\(--side-w-inner\)/.test(CSS),
    '内层内容要固定成内容盒宽、由 aside 裁切（参照实现同一手法）');
  assert.ok(/html\[data-side-rail='1'\] #sidebar:not\(\[data-side-open\]\) \{ width: var\(--side-w-rail\)/.test(CSS),
    '收起规则要挂在 data-side-rail + 非 data-side-open 上');
  assert.ok(/opacity: 0/.test(CSS) && /\.tab-label, \.side-title \{ transition: opacity/.test(CSS),
    '标签要淡出（不能只是被裁掉）');
  // 只在宽屏用（≤900px 是横向布局）
  assert.ok(/@media \(min-width: 901px\)/.test(CSS), '图标条只在宽屏生效');
  // 滑块：位移/高度过渡 + 带一点过冲的 spring 近似曲线
  assert.ok(/\.side-pill \{/.test(CSS) && /\.side-pill-bar \{/.test(CSS), '滑块与左缘条都要有样式');
  assert.ok(/--ease-side-spring:\s*cubic-bezier\(\.3,\s*1\.18,\s*\.4,\s*1\)/.test(CSS),
    '滑块曲线要是 spring(380,32) 的近似（略过冲、收敛快）——不能用 --ease-spring 那种大回弹');
  assert.ok(/transform var\(--side-dur-slide\) var\(--ease-side-spring\)/.test(CSS), '滑块位移要挂这条曲线');
  // 逐项的旧指示器必须清掉（否则与滑块重复：选中项底下多一根横线 / 两根左缘条）
  assert.equal(/\.tab\.active::after/.test(CSS), false, '旧的页签下划线要删掉');
  assert.equal(/\.tab\.active::before/.test(CSS), false, '旧的逐项左缘条要删掉（改由滑块承担）');
  assert.equal(/keyframes tabSlide/.test(CSS), false, 'tabSlide 关键帧随下划线一起删');
  // 选中项自己不许再有底色：否则滑块滑过来时旧格子还留着底色。
  // 但**窄屏例外** —— ≤900px 时侧栏是顶部横向标签条、滑块 display:none，选中态得回到逐项底色。
  // 所以只在"窄屏断点之前"的 CSS 里禁止给 .tab.active 上色。
  // ⚠️ 不能用"文件里最后一个 900px 断点"来切宽/窄屏：任何**别的页面**加一条自己的
  // `@media (max-width: 900px)`（插件页 2026-10-16 就加了一条布局断点）都会把它带偏，
  // 于是侧栏的窄屏兜底被当成宽屏规则，这条用例开始假红。
  // 认准侧栏自己那一段：它里面一定有 `.side-pill { display: none`。
  // 认准侧栏自己那条窄屏回落：它同时含"藏滑块"与"逐项底色兜底"两件事
  //（`#view-settings .settings-menu .side-pill` 那条也提到 side-pill，但它不含 .tab.active 兜底）。
  const narrowBlocks = [...CSS.matchAll(/@media \(max-width: 900px\) \{/g)]
    .map((m) => m.index)
    .filter((idx) => {
      const body = CSS.slice(idx, idx + 3000);
      return /\.side-pill \{ display: none/.test(body) && /#sidebar \.tab\.active/.test(body);
    });
  assert.equal(narrowBlocks.length, 1, `侧栏的窄屏回落应当唯一（找到 ${narrowBlocks.length} 个）`);
  const narrowAt = narrowBlocks[0];
  assert.ok(narrowAt > 0, '窄屏断点要在（横向标签条那套）');
  const wideCss = CSS.slice(0, narrowAt);
  const wideBlocks = [...wideCss.matchAll(/\.tab\.active \{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(wideBlocks.some((b) => /background:\s*transparent/.test(b)), '宽屏下选中项背景必须是透明的（底色归滑块）');
  for (const b of wideBlocks) {
    // 先把"明确透明"的声明剔掉，再看还剩不剩 background —— 直接对 background: 后面下否定断言
    // 会漏（\s* 可以匹配零个字符，于是"background: transparent"被当成违规）
    const rest = b.replace(/background:\s*transparent;?/g, '');
    assert.equal(/background:/.test(rest), false, `宽屏下选中项还有底色：${b.trim().slice(0, 60)}`);
  }
  // 窄屏回落：滑块藏起来 + 逐项底色回来（两者必须成对出现，否则窄屏会没有选中态）
  const narrowCss = CSS.slice(narrowAt);
  assert.ok(/\.side-pill \{ display: none/.test(narrowCss), '窄屏要把滑块藏掉（位移只算 Y，在横向条里会盖住整条导航）');
  // 兜底那条必须写成 `#sidebar .tab.active`（带 id）—— 否则被「侧栏样式」那节的同选择器压回透明，
  // 窄屏就变成"没有选中态"（实测踩到：820px 下选中项与普通项长得一样）
  assert.ok(/#sidebar \.tab\.active \{ background: var\(--accent-side-soft\)/.test(narrowCss),
    '窄屏要有逐项底色兜底，且选择器权重够（带 #sidebar）');
  // 关掉动效时宽度与滑块都直接落位
  assert.ok(/html\[data-motion='off'\] #sidebar[\s\S]{0,400}transition: none/.test(CSS),
    '关闭动效后侧栏不该还有宽度过渡');
  assert.ok(/html\[data-motion='off'\] \.side-pill|html\[data-motion='reduced'\] \.side-pill/.test(CSS),
    '关闭动效后滑块也该直接落位');
});

test('滑块与分段控件同一口径：首次落位不滑动、几何用 offset 系', () => {
  // 2026-10-08：滑块的实现抽到 core/nav-pill.js（主导航与设置页分区菜单共用一份），锚点跟着搬
  const src = fs.readFileSync(path.join(UI, 'core', 'nav-pill.js'), 'utf8');
  assert.ok(/function positionNavPill\(/.test(src), '共用实现要在 nav-pill.js 里');
  assert.ok(/pill\.dataset\.fresh = '1'/.test(src), '首次落位要打 fresh 标记');
  assert.ok(/active\.offsetTop/.test(src) && /active\.offsetHeight/.test(src),
    '几何要用 offsetTop/offsetHeight（与 .tab 的盒模型同源，不受 zoom 影响）');
  // title（收起时的图标提示）归主导航管，仍在 side-nav.js 里 —— 滑块实现搬走了，这条没搬
  assert.ok(/\?\.textContent\?\.trim\(\)/.test(read('ui/core/side-nav.js')), 'title 文本要防御性取值');
  // 不许碰全局 window（仓库的 ui-module-graph 守卫盯这条）
  assert.equal(/\bwindow\.[a-zA-Z_$]+\s*=/.test(src), false, '不许往 window 上挂东西');
});

test('侧栏内层宽度按"内容盒"算（写死外框宽会让底部那一排顶出右缘、裁掉最右图标）', () => {
  // 用户实测报的："左下角图标快超出侧栏"。根因：内层三个块的 min-width 写成了 --side-w-full
  // （= 外框宽 248），而侧栏左右各有 10px 内边距 → 内容盒只有 228，于是那一排宽 248 顶出去，
  // 最右的图标被 overflow:hidden 裁掉。现在内层宽 = 外框宽 − 2×内边距，一个 token 说了算。
  assert.ok(/--side-pad-x:\s*10px/.test(CSS), '要有"侧栏左右内边距"这个 token');
  assert.ok(/--side-w-inner:\s*calc\(var\(--side-w-full\) - 2 \* var\(--side-pad-x\)\)/.test(CSS),
    '内层宽度必须是"外框宽 − 2×内边距"算出来的');
  assert.ok(/#sidebar > \.side-head, #sidebar > #tabs, #sidebar > \.side-foot \{ min-width: var\(--side-w-inner\)/.test(CSS),
    '三个内层块要用 --side-w-inner');
  assert.equal(/min-width: var\(--side-w-full\)/.test(CSS), false,
    '不许再拿外框宽当内层宽（就是这一条把底部那一排顶出去的）');
  // 底部那一排：三个按钮都不许收缩，否则宁可把图标挤出去而不是把下拉框变窄
  assert.ok(/\.side-foot \.icon-btn, \.side-foot #pause-btn \{ flex: 0 0 auto/.test(CSS), '按钮不参与收缩');
  assert.ok(/\.side-foot \{\n  display: flex;[\s\S]{0,120}padding: 10px 0 0;/.test(CSS.replace(/\r\n/g, '\n')),
    '底部那一排不该再左右各留 4px（那 8px 也要算进内容盒）');
});

test('侧栏自带"固定"按钮：与外观面板那个开关是同一个轴，两边状态一致', () => {
  const html = read('ui/index.html');
  assert.ok(/id="side-pin-btn"[^>]*data-icon="pin"/.test(html), '侧栏底部要有图钉按钮（带 pin 图标）');
  assert.ok(/id="side-pin-btn"[^>]*aria-pressed="false"/.test(html), '要有 aria-pressed（初始未固定）');
  assert.ok(/pin: '<path/.test(read('ui/core/icons.js')), '图标集里要有 pin');
  const app = stripComments(read('ui/app.js'));
  assert.ok(/function toggleSideRail\(/.test(app) && /sidebarPinned: next/.test(app),
    '点击要切换 ui.sidebarPinned');
  assert.ok(/api\('\/api\/config', \{ method: 'POST', body: JSON\.stringify\(\{ ui: \{ sidebarPinned: next \} \}\)/.test(app),
    '要尽力写回服务端 —— 否则在侧栏钉住、刷新一次又变回图标条');
  assert.ok(/btn\.setAttribute\('aria-pressed'/.test(app) && /classList\.toggle\('pinned'/.test(app),
    '按钮要反映当前态（点亮 + aria）');
  assert.ok(/\$\('#side-pin-btn'\)\?\.addEventListener\('click', toggleSideRail\)/.test(app), '要绑上点击');
  assert.ok(/document\.addEventListener\('qqa:appearance', syncSideRailButton\)/.test(app),
    '外观面板改同一项时按钮也要跟着变');
  // 面板里的勾也要跟着侧栏那颗按钮走（同一个轴，两边不许各说一套）
  const panel = stripComments(read('ui/pages/settings-appearance.js'));
  assert.ok(/pin\.checked = currentAppearance\(\)\.sidebarPinned === true/.test(panel),
    '面板的"固定侧栏"勾要在刷面板时同步当前生效值');
});

test('滑块只有一份实现：主导航与设置页的分区菜单都走 core/nav-pill.js', () => {
  const sideNav = read('ui/core/side-nav.js');
  const settings = read('ui/pages/settings.js');
  for (const [name, src] of [['side-nav.js', sideNav], ['settings.js', settings]]) {
    assert.ok(/from '\.\.\/core\/nav-pill\.js'|from '\.\/nav-pill\.js'/.test(src),
      `${name} 要用共用的滑块实现（不许各写一套）`);
    assert.ok(/positionNavPill\(/.test(src), `${name} 要调用 positionNavPill`);
    // 自己再插一个滑块/造一个滑块节点 = 分叉的开始
    assert.equal(/createElement\('span'\)[\s\S]{0,80}side-pill/.test(src), false,
      `${name} 里不该再自己造滑块节点`);
  }
  const pill = read('ui/core/nav-pill.js');
  assert.ok(/dataset\.fresh = '1'/.test(pill), '共用实现里保留"首次落位不滑动"的标记');
  assert.ok(/active\.offsetTop/.test(pill) && /active\.offsetHeight/.test(pill),
    '几何一律用 offsetTop/offsetHeight（不受 zoom 影响，与项自身的盒模型同源）');
});

test('设置页分区菜单：滑块就位、当前项带 aria-current、选区变化时只滚侧栏自己', () => {
  const settings = stripComments(read('ui/pages/settings.js'));
  // 当前项标记：一组同类元素里只标一个（Primer / MDN 的口径）
  assert.ok(/aria-current="page"/.test(settings), '选中的分区要带 aria-current="page"');
  // 滑块：接回上一次的节点，否则"换一项"是跳到终点而不是滑过去
  assert.ok(/previous: menuPill/.test(settings), '重建 DOM 时要把上一次的滑块节点接回来');
  assert.ok(/activeSelector: ':scope > \.settings-menu-item\.active'/.test(settings), '滑块要对准选中项');
  // 只滚侧栏自己 + 只在换分区时滚一次（否则每次保存都把用户滚到的位置拽回来）
  assert.ok(/revealedSection/.test(settings), '要有"只在换分区时滚动一次"的判据');
  assert.ok(/sidebar\.scrollTop \+= revealDelta\(/.test(settings),
    '滚动只能落在侧栏自己身上（用 scrollIntoView 会把外层表单一起带走）');
  // 外观变更（字体/密度改行高）后滑块要重新对位
  assert.ok(/addEventListener\('qqa:appearance', \(\) => \{[\s\S]{0,80}syncMenuPill\(\)/.test(settings),
    '外观一变（行高变了）要把滑块重新对位');
  // 离开再回到设置页时，"已经露过脸"的记忆要清掉：用户可能手动把菜单滚走了
  assert.ok(/function resetMenuReveal\(/.test(settings), '要有 resetMenuReveal');
  assert.ok(/resetMenuReveal, resolveTheme/.test(settings), 'resetMenuReveal 要导出');
  const app = stripComments(read('ui/app.js'));
  assert.ok(/resetMenuReveal\(\);\s*loadSettings\(\);/.test(app),
    "switchTab('settings') 时要清掉露脸记忆（否则手动滚走后回来高亮还是看不见）");
});

test('revealDelta：只在跑出视野时滚、且滚最小距离（对齐 scrollIntoView block:nearest）', { skip: SKIP }, async () => {
  const window = loadPage();
  await new Promise((r) => setTimeout(r, 60));
  const box = { top: 100, bottom: 500 };
  // 已经在视野里 → 不滚
  assert.equal(window.revealDelta(box, { top: 200, bottom: 235 }), 0, '可见就不动');
  // 挂在下面（含贴边）→ 往下滚，正好把它贴到视野底部（留 8px 余量）
  assert.equal(window.revealDelta(box, { top: 480, bottom: 515 }), 23, '下方跑出去 → 往下滚最小距离');
  assert.equal(window.revealDelta(box, { top: 700, bottom: 735 }), 243, '远在下方同理');
  // 跑到上面 → 往上滚（负数）
  assert.equal(window.revealDelta(box, { top: 60, bottom: 95 }), -48, '上方跑出去 → 往上滚');
  window.happyDOM?.abort?.();
});

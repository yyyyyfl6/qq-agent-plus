// 控制台动效系统的源码锚点（2026-10-08）。
//
// 为什么用"读源码"而不是 DOM 断言：动效是靠 CSS 规则生效的，而 happy-dom 不跑真实
// 过渡；真正会出的事故是"这段 CSS 被删了/被后面的规则架空了"—— 那正好是文本层面能钉住的。
// 实测教训：一条兜底 `transition: ... .2s ease` 把整套动效 token 架空，所有控件的计算值
// 都变成浏览器默认的 ease，看起来就是"没有设计过的过渡"。这条用例专门守它别再回来。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const UI = path.resolve('ui');
// **剥掉注释再断言**：注释里为了讲清来龙去脉，常常原样引用被禁掉的那行代码
// （"原来的 --accent-soft: var(--accent-soft) 是自引用…"），"不许出现 X" 这类断言会被
// 注释满足 —— 这条坑在本仓库踩过，所以这里统一剥注释，只对真实规则断言。
const css = fs.readFileSync(path.join(UI, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

test('交互过渡走 token（不许再出现写死的 .2s ease 兜底）', () => {
  assert.ok(css.includes('--dur-interaction: 150ms'), '要有交互过渡时长 token');
  assert.ok(css.includes('--dur-interaction) var(--ease-in-out)'), '兜底过渡要用 token');
  const blanket = /\.btn, \.icon-btn, input, select, textarea[\s\S]{0,400}?transition:\s*background-color \.2s ease/;
  assert.equal(blanket.test(css), false, '那条写死 .2s ease 的兜底过渡不许回来（它会架空 token）');
});

test('可交互元素都有过渡（chip / 菜单项 / 数据行 / 分段控件 / 外观面板组件）', () => {
  for (const sel of ['.tab', '.settings-menu-item', '.chip', '.seg-item', '.swatch', '.scheme-card',
    '.tweak-reset', '.feed li', '.plat-row']) {
    assert.ok(css.includes(sel), `动效覆盖清单里缺少 ${sel}`);
  }
  // 状态点会呼吸（参照实现是 animate-pulse）；减少动效偏好下必须关掉
  assert.ok(/\.dot\.dot-on \{ animation: breathe/.test(css), '已连接的状态点要有呼吸动画');
  assert.ok(/prefers-reduced-motion[\s\S]{0,200}\.dot\.dot-on \{ animation: none/.test(css),
    '减少动效偏好下呼吸动画要停');
});

test('键盘焦点可见：非按钮的可聚焦控件也有 focus-visible 环', () => {
  assert.ok(/a:focus-visible, \[tabindex\]:focus-visible/.test(css), '链接/自定义控件要有焦点环');
  assert.ok(/input:focus-visible, select:focus-visible, textarea:focus-visible/.test(css), '输入控件要有焦点环');
});

test('设计标度：间距/字号/圆角档位与卡片阴影都在，且圆角按角色分档', () => {
  for (const token of ['--sp-1: 4px', '--sp-4: 16px', '--fs-md:', '--fs-lg:', '--r-card:', '--r-input:', '--shadow-card:']) {
    assert.ok(css.includes(token), `标度 token 缺失：${token}`);
  }
  // 2026-10-09 值班台复核：.kpi/.panel 已不是卡片（表面内分格 / 细线分节），从卡片组移出 ——
  // 之前的断言钉的是旧设计（"kpi/panel 也在卡片组里"），两套设计并存时正是它在为被覆盖的
  // 旧样式站岗（浏览器实测：细线分格没落地、渲染的是卡片阴影）。剩下的卡片成员仍要带极轻阴影。
  assert.ok(/\.usage-card, \.tool-card[\s\S]{0,200}?box-shadow: var\(--shadow-card\)/.test(css),
    '卡片要带上极轻阴影（没有它卡片是"平"的）');
  assert.equal(/\.kpi, \.panel, \.usage-card/.test(css), false,
    '.kpi/.panel 不该回卡片组（它们的分格/细线分节会被整条覆盖 —— 2026-10-09 复核）');
});

test('主题切换是"从点击处扩散"的圆形波纹（View Transitions），并带三重降级', () => {
  // 参照实现的做法：换明暗/换配色时把整页交给 View Transition，再给新层挂一条
  // clip-path: circle() 的关键帧 —— 新主题从鼠标点下去的地方铺开。
  assert.ok(/@keyframes vt-reveal\s*\{[\s\S]{0,220}?clip-path: circle\(0px at var\(--vt-x/.test(css),
    '要有从圆心 0 半径开始的 vt-reveal 关键帧');
  assert.ok(/clip-path: circle\(var\(--vt-r/.test(css), '关键帧终点要铺到 --vt-r 的半径');
  assert.ok(/::view-transition-new\(root\) \{[^}]*animation: vt-reveal \.5s cubic-bezier\(\.16, 1, \.3, 1\)/
    .test(css), '新层用 .5s ease-out-expo（与参照实现同一量级）');
  assert.ok(/::view-transition-old\(root\) \{[^}]*animation: none/.test(css), '旧层不许自己播动画（不然两层互相盖）');
  // 三重降级：用户设置"减弱"、"关闭"，以及系统 prefers-reduced-motion
  assert.ok(/html\[data-motion='reduced'\]::view-transition-old\(root\)/.test(css), '减弱动效要能关掉波纹');
  assert.ok(/html\[data-motion='off'\]::view-transition-new\(root\)/.test(css), '关闭动效要能关掉波纹');
  assert.ok(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]{0,200}?::view-transition-new\(root\) \{ animation: none/
    .test(css), '系统偏好也要被尊重');
});

test('动效开关三态：减弱压时长、关闭去动画、转圈例外', () => {
  assert.ok(/html\[data-motion='reduced'\] \*,[\s\S]{0,200}?transition-duration: \.01ms !important/.test(css),
    '减弱动效要把过渡时长压到看不见');
  assert.ok(/html\[data-motion='off'\] \*,[\s\S]{0,200}?animation: none !important/.test(css),
    '关闭全部动效要直接去掉动画');
  assert.ok(/html\[data-motion='off'\] \.spin/.test(css), '转圈是"正在进行"的唯一提示，全关时留它');
  assert.ok(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]{0,320}?transition-duration: \.01ms !important/.test(css),
    '系统"减少动态效果"要自动降级');
});

test('高对比模式：边框加粗、次要文字提亮', () => {
  assert.ok(/:root\[data-contrast='high'\] \{[\s\S]{0,260}?--border: color-mix\(in srgb, var\(--text\)/.test(css),
    '高对比要靠 --border / --muted 的重算实现，且必须比色板规则更靠后（同权重靠顺序取胜）');
  assert.ok(/--muted: color-mix\(in srgb, var\(--text\)/.test(css), '次要文字也要提亮');
});

test('强调色的派生色由 CSS 现算，且不许再有自引用（那会让值直接失效）', () => {
  assert.ok(/--accent-soft: color-mix\(in srgb, var\(--accent\) 12%, transparent\)/.test(css),
    '柔和底要从 --accent 现算');
  assert.ok(/--accent-ring: color-mix\(in srgb, var\(--accent\) 40%, transparent\)/.test(css),
    '焦点环同理');
  assert.ok(/--accent-side-soft: color-mix\(in srgb, var\(--accent-side\)/.test(css),
    '侧栏那套也要能从 --accent-side 现算');
  assert.equal(/--accent-soft: var\(--accent-soft\)/.test(css), false,
    '『--accent-soft: var(--accent-soft)』是自引用（循环）→ 计算值失效，不许回来');
  // 老浏览器兜底：静态 rgba 要在 color-mix 之前
  const fb = css.indexOf('--accent-soft: rgba(76, 141, 255, .12)');
  const mix = css.indexOf('--accent-soft: color-mix(in srgb, var(--accent) 12%, transparent)');
  assert.ok(fb > -1 && mix > fb, 'color-mix 之前要留一条静态 rgba 兜底');
});

test('开关：设置页与平台页的 checkbox 长成胶囊开关（列表里的多选框不动）', () => {
  assert.ok(/\.checkbox-row > input\[type='checkbox'\],[\s\S]{0,400}?appearance: none/.test(css),
    '开关要 appearance:none 自绘');
  assert.ok(/--switch-w: 44px/.test(css) && /--switch-h: 24px/.test(css), '尺寸要按参照实现的 44×24');
  assert.ok(/translateX\(var\(--switch-travel\)\)/.test(css), '圆点靠位移过去');
  // 原来这条写成 `assert.ok(/…/.test(css) || true)` —— `|| true` 让它永远为真，等于没断言；
  // 「多选方块没被卷进开关样式」由下一行那条真实匹配断言守住（2026-10-08 审查）。
  const switchSel = css.match(/\.checkbox-row > input\[type='checkbox'\],[\s\S]{0,120}?\{/);
  assert.ok(switchSel && !switchSel[0].includes('.ma-check'), '多选方块不许被卷进开关样式');
});

test('分段控件：轨道 + 平移滑块（位置由 segment.js 算，CSS 只负责动）', () => {
  assert.ok(/\.seg-pill \{[\s\S]{0,400}?transform: translateX\(var\(--pill-x/.test(css), '滑块要能横向平移');
  assert.ok(/transition:[\s\S]{0,200}?transform var\(--dur-interaction\) var\(--ease-out-quart\)/.test(css),
    '滑块的位移要带过渡（"滑过去"而不是跳过去）');
  assert.ok(/\.seg-item\.selected \{[\s\S]{0,120}?color: var\(--accent-fg\)/.test(css),
    '选中项文字用按亮度算出的可读前景色');
});

test('滚动条：轨道透明、thumb 用 padding-box 裁边（不给它描一圈背景色的边）', () => {
  assert.ok(/background-clip: padding-box/.test(css), 'thumb 要用 padding-box 裁出透明边');
  assert.equal(/::-webkit-scrollbar-thumb\s*\{[^}]*border: 2px solid var\(--bg\)/.test(css), false,
    '『border: 2px solid var(--bg)』等于给滚动条贴一条灰胶带，不许回来');
});

test('外观面板的组件都在（卡片 / 行 / 色板 / 色板预览 / 主题微调）', () => {
  for (const sel of ['.opt-card', '.opt-head', '.opt-row', '.opt-row-title', '.swatch-row', '.swatch',
    '.scheme-card', '.tweak-row', '.tweak-swatch', '.range-value']) {
    assert.ok(css.includes(sel), `外观面板组件样式缺失：${sel}`);
  }
  // 色板预览要能在"当前明暗"下画（外框=该色板底色）
  assert.ok(/\.scheme-card \.sc-prev/.test(css), '色板预览卡要有预览块');
});

test('色板 / 深色强度 / 侧栏样式 / 字体 / 背景各有对应的生效规则', () => {
  for (const id of ['slate', 'nord', 'forest', 'rose']) {
    assert.ok(css.includes(`[data-scheme='${id}'][data-theme='dark']`), `色板 ${id} 缺深色一套`);
    assert.ok(css.includes(`[data-scheme='${id}'][data-theme='light']`), `色板 ${id} 缺亮色一套`);
  }
  assert.ok(/\[data-theme='dark'\]\[data-dark-intensity='oled'\]/.test(css), '深色强度要有 OLED 档');
  assert.ok(/html\[data-sidebar-style='accent'\] #sidebar/.test(css), '侧栏样式=强调色要生效');
  assert.ok(/html\[data-font='rounded'\] body/.test(css) && /html\[data-font='serif'\] body/.test(css),
    '字体档位要各有规则（字体栈放 CSS，首屏脚本只抄一个 data-font 值）');
  assert.ok(/html\[data-background='gradient'\] body/.test(css), '渐变背景要生效');
  assert.ok(/--bg-angle/.test(css), '渐变角度要走变量');
  // 顶栏开关
  assert.ok(/html\[data-hide-badges='1'\] \.top-status/.test(css), '顶栏徽章开关要生效');
  assert.ok(/html\[data-hide-theme-btn='1'\] #theme-btn/.test(css), '顶栏主题按钮开关要生效');
});

test('开关的覆盖范围包含外观面板（.opt-row-ctrl），且轨道用 inset 描边而非 1px 边框', () => {
  // 这条是实测抓到的回归：外观页的开关挂在 .opt-row-ctrl 里，选择器只写了 .checkbox-row / .plat-row，
  // 结果那一页的开关全是原生复选框（DOM 断言看不到 —— 它只查 checked，不查计算样式）。
  assert.ok(/\.opt-row-ctrl > input\[type='checkbox'\]/.test(css), '外观面板的开关也要被开关样式覆盖');
  assert.ok(/\.opt-row-ctrl > input\[type='checkbox'\]:checked::after/.test(css), '选中态的圆点位移也要覆盖它');
  // 分段轨道的边框：1px border 会被按 DPR 取成 0.667px，而 offsetLeft 只给整数，
  // 滑块按几何算位置就会差 1px —— 所以改用 inset 描边（padding box == border box）。
  const segBlock = css.match(/\.seg \{[\s\S]*?\}/);
  assert.ok(segBlock, '要有 .seg 规则');
  assert.equal(/border:\s*1px solid/.test(segBlock[0]), false, '分段轨道不许用 1px border（取整误差会让滑块对不齐）');
  // 描边色走 --ctl-line（= 掺主文字色的加深版边框）：亮色下 --border 贴白卡只有 1.24:1，
  // 分段轨道的槽、开关的槽、未选中的单选圈都靠它表达，用裸 --border 等于看不见控件。
  // 30%：22% 在白卡上够用，但玻璃档正文直接压在亮壁纸上时 1px 描边会被泛光吃掉（2026-10-19）。
  assert.ok(/box-shadow: inset 0 0 0 1px var\(--ctl-line\)/.test(segBlock[0]), '描边要用 inset box-shadow 画');
  assert.ok(/--ctl-line: color-mix\(in srgb, var\(--text\) 30%, var\(--border\)\)/.test(css), '要有统一的控制件轮廓色 --ctl-line');
});

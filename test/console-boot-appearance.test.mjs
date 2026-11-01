// 首屏外观预置（ui/index.html 里那段内联脚本）与模块的**一致性**。
//
// 为什么需要这条：外观必须在 CSS 生效前就套好，否则会"先按默认色画一版、启动完成再换"——
// 那一下换色就是用户看到的"闪"。要做到这点只有一条路：把预置逻辑放进 <head> 的内联脚本
// （ES module 是 defer 的，太晚）。于是同一件事有了两处实现，其中唯一带逻辑的是
// "压在强调色上的文字该黑还是白"（--accent-fg）。
//
// 这里的做法：把 index.html 里那段脚本真的抽出来、喂给一个假 DOM 跑起来，然后
//   ① 逐色核对它算出的 --accent-fg 与 ui/core/appearance.js 的 accentForeground 完全一致；
//   ② 核对它设置的 data-* 属性名覆盖了 appearanceAttrs() 的每一个键（少一个就是"某一轴
//      在首屏不生效、要等模块跑起来才纠正"，也就是一次闪）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const { ACCENTS, accentForeground, appearanceAttrs, resolveAppearance } =
  await import('../ui/core/appearance.js');

const HTML = fs.readFileSync(path.resolve('ui/index.html'), 'utf8');

/** 取出含 --accent-fg 的那段内联脚本（首屏主题 + 外观预置）。 */
function bootScript() {
  const blocks = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const found = blocks.filter((b) => b.includes('--accent-fg'));
  assert.equal(found.length, 1, `首屏外观预置脚本应当只有一段，实际 ${found.length} 段`);
  return found[0];
}

/** 在假 DOM 里跑一遍那段脚本，回传它写了哪些内联变量与 data-* 属性。 */
function runBoot(patch, themePref = 'dark', serverPref = '') {
  const vars = new Map();
  const attrs = new Map();
  const document = {
    documentElement: {
      style: {
        setProperty: (k, v) => vars.set(k, String(v)),
        getPropertyValue: (k) => vars.get(k) || ''
      },
      attrs,
      setAttribute: (k, v) => attrs.set(k, String(v)),
      getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
      removeAttribute: (k) => attrs.delete(k)
    }
  };
  const store = new Map([
    ['qqa-theme', themePref],
    ['qqa-theme-server', serverPref],
    ['qqa-appearance', JSON.stringify(patch)]
  ]);
  const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  const window = { matchMedia: () => ({ matches: false }), addEventListener() {} };
  // 脚本自带 try/catch 会吞异常，所以这里必须先确认它真的跑到了最后一行
  const fn = new Function('document', 'window', 'localStorage', 'setTimeout', `${bootScript()}\n;return true;`);
  assert.equal(fn(document, window, localStorage, () => 0), true, '首屏脚本应当整段跑完');
  return { vars, attrs };
}

test('首屏脚本与模块对 --accent-fg 的判断逐色一致（唯一带逻辑的一处）', () => {
  const colors = [
    ...ACCENTS.map((a) => a.hex),
    '#ffffff', '#000000', '#0b1220', '#f7b955', '#4c8dff', '#2f6fe4',
    '#ff8800', '#00ff00', '#7f7f7f', '#010203', '#fefefe'
  ];
  for (const hex of colors) {
    const { vars } = runBoot({ accent: hex });
    assert.equal(
      vars.get('--accent-fg'), accentForeground(hex),
      `首屏脚本对 ${hex} 判出的字色与 appearance.js 不一致（两处实现漂了）`
    );
  }
  // 自定义色非法 / 缺省时两边都要回默认蓝的白字
  assert.equal(runBoot({ accent: 'not-a-color' }).vars.get('--accent-fg'), accentForeground('#4c8dff'));
  assert.equal(runBoot({}).vars.get('--accent-fg'), accentForeground('#4c8dff'));
});

test('首屏脚本覆盖 appearanceAttrs 的每一个属性（少一个就是某一轴首屏不生效）', () => {
  // 每一项都取非默认值，逼出所有非空属性
  const patch = {
    mode: 'light', scheme: 'nord', darkIntensity: 'oled', accentPreset: 'amber', accent: '',
    accentScope: 'sidebar', sidebarStyle: 'accent', background: 'gradient', font: 'serif',
    density: 'compact', contrast: 'high', reduceMotion: true, showBadges: false, showTopbarTheme: false,
    glass: 'liquid'
  };
  const { attrs } = runBoot(patch);
  const expected = appearanceAttrs(resolveAppearance(patch));
  for (const [key, value] of Object.entries(expected)) {
    if (!value) continue;
    assert.equal(attrs.get(`data-${key}`), value, `首屏脚本漏设（或设错）data-${key}`);
  }
  // 反向：脚本不该自己发明属性名
  for (const key of attrs.keys()) {
    assert.ok(key === 'data-theme' || `data-${key.slice(5)}` in Object.fromEntries(
      Object.keys(expected).map((k) => [`data-${k}`, 1])
    ), `首屏脚本设了一个模块不认识的属性：${key}`);
  }
});

test('首屏脚本只认主题微调白名单，不把 localStorage 里的怪键写进样式', () => {
  const { vars } = runBoot({
    tweaks: { '--bg': '#123456', '--evil': '#000000', '--accent-soft': 'red', '--text': 'not-a-color', '--muted': '#abcdef' }
  });
  assert.equal(vars.get('--bg'), '#123456');
  assert.equal(vars.get('--muted'), '#abcdef');
  assert.equal(vars.has('--evil'), false, '非白名单变量不许注入');
  assert.equal(vars.has('--accent-soft'), false, '派生色变量由 CSS 现算，不该被存档覆盖');
  assert.equal(vars.has('--text'), false, '不是合法颜色的值不许注入');
});

test('首屏脚本：应用范围=仅侧栏时全局仍用默认蓝（与模块同口径）', () => {
  const sidebarOnly = runBoot({ accent: '#f7b955', accentScope: 'sidebar' }).vars;
  assert.equal(sidebarOnly.get('--accent'), '#4c8dff');
  assert.equal(sidebarOnly.get('--accent-side'), '#f7b955');
  const global = runBoot({ accent: '#f7b955' }).vars;
  assert.equal(global.get('--accent'), '#f7b955');
  assert.equal(global.get('--accent-side'), '#f7b955');
});

test('首屏脚本认得强调色预设：选了预设色也要即刻画出那一支（不能先画默认蓝）', () => {
  // 选了预设时存档里 accent 是空串（只有自定义色才存 hex），所以脚本必须按 accentPreset 查表。
  // 漏了这一步的表现就是：刷新后按钮/选中态先是一版默认蓝，模块跑起来才换成用户挑的那支 ——
  // 正是这段脚本存在的意义（2026-10-08 审查，真机实测到这一闪）。
  for (const a of ACCENTS) {
    const { vars } = runBoot({ accent: '', accentPreset: a.id });
    assert.equal(vars.get('--accent'), a.hex, `预设 ${a.id} 的首屏强调色应为 ${a.hex}（首屏那张表与 ACCENTS 漂了）`);
    assert.equal(vars.get('--accent-side'), a.hex);
    // 压在强调色上的字色也要跟着那支色算，而不是默认蓝的
    assert.equal(vars.get('--accent-fg'), accentForeground(a.hex), `预设 ${a.id} 的 --accent-fg 应按它自己的颜色算`);
  }
  // 自定义色优先于预设：两个都在时用自定义那一支
  assert.equal(runBoot({ accent: '#ff8800', accentPreset: 'amber' }).vars.get('--accent'), '#ff8800');
  // 预设 id 不认识 / 没存过 → 回默认蓝，不能抛
  assert.equal(runBoot({ accent: '', accentPreset: 'nope' }).vars.get('--accent'), '#4c8dff');
});

test('首屏脚本的强调色优先级：自定义 > 预设 > 默认蓝（自定义成默认蓝也不能被预设顶掉）', () => {
  // 拿"算出来等于默认蓝"当"没设自定义色"的判据会误判：用户把自定义色填成 #4c8dff、而记住的
  // 预设是 sky 时，首屏会画成 sky，模块跑起来再跳回 #4c8dff —— 一次闪烁 + 两处实现不一致
  // （2026-10-08 二轮审查）。判据必须是"存档里有没有自定义色"，不是"颜色值等不等于默认"。
  assert.equal(runBoot({ accent: '#4c8dff', accentPreset: 'sky' }).vars.get('--accent'), '#4c8dff');
  assert.equal(runBoot({ accent: '', accentPreset: 'sky' }).vars.get('--accent'), '#38bdf8', '没自定义才用预设');
  assert.equal(runBoot({ accent: '' }).vars.get('--accent'), '#4c8dff', '两者都没有回默认蓝');
});

test('首屏脚本的取值与模块 appearanceVars 对齐（同一份 patch，两边给同样的值）', async () => {
  const { appearanceVars } = await import('../ui/core/appearance.js');
  for (const bgAngle of [45, 0]) {
    const patch = { accent: '#ff8800', radius: 1.2, zoom: 0.85, bgColor: '#010203', bgFrom: '#111111', bgTo: '#222222', bgAngle };
    const boot = runBoot(patch).vars;
    const mod = appearanceVars(resolveAppearance(patch));
    for (const key of ['--accent', '--accent-side', '--accent-fg', '--r-scale', '--zoom', '--bg-solid', '--bg-from', '--bg-to', '--bg-angle']) {
      assert.equal(boot.get(key), mod[key], `bgAngle=${bgAngle} 时 ${key} 两处不一致：首屏 ${boot.get(key)} vs 模块 ${mod[key]}`);
    }
  }
});

test('首屏主题优先级：本机选择 > 显式跟随系统 > 后端缓存 > 默认浅色', () => {
  // 假 window.matchMedia 的 matches 恒为 false → 系统偏好按 dark 算
  assert.equal(runBoot({}, '').attrs.get('data-theme'), 'light', '没有任何偏好时默认浅色');
  assert.equal(runBoot({}, 'light', 'dark').attrs.get('data-theme'), 'light', '本机显式选择优先');
  assert.equal(runBoot({}, 'system', 'light').attrs.get('data-theme'), 'dark',
    '显式"跟随系统"要排在缓存的后端值之前（否则会先画缓存值再换成系统值）');
  assert.equal(runBoot({}, '', 'dark').attrs.get('data-theme'), 'dark', '没本机选择时才用后端缓存');
  assert.equal(runBoot({}, '', 'system').attrs.get('data-theme'), 'dark',
    '后端选的是"跟随系统"时首屏也要按系统值画（否则 dark 系统上每次加载都闪一下浅色）');
});

// 外观设置模型（七轴：明暗 / 深色强度 / 色板 / 强调色 / 背景 / 排版 / 主题微调 + 顶栏与无障碍）。
// 这些值直接写进 CSS 变量与 <html> 的 data-* 属性，坏一个字符就会把界面搞花，所以边界要钉死。
import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  ACCENTS, ACCENT_SCOPES, BACKGROUNDS, DARK_INTENSITIES, DEFAULTS, DEFAULT_ACCENT, DENSITIES, FONTS,
  MODES, RADII, SCHEMES, SIDEBAR_STYLES, TWEAK_KEYS, TWEAK_VARS,
  accentForeground, accentShades, appearanceAttrs, appearancePatch, appearanceVars, hexToRgb,
  normalizeHex, radiusTier, readableOn, resolveAppearance
} = await import('../ui/core/appearance.js');

test('hexToRgb：三位/六位/带不带 # 都认，垃圾值返回 null', () => {
  assert.deepEqual(hexToRgb('#4c8dff'), { r: 76, g: 141, b: 255 });
  assert.deepEqual(hexToRgb('4c8dff'), { r: 76, g: 141, b: 255 });
  assert.deepEqual(hexToRgb('#abc'), { r: 170, g: 187, b: 204 });
  assert.equal(hexToRgb('rgb(1,2,3)'), null);
  assert.equal(hexToRgb('#12345'), null);
  assert.equal(hexToRgb(''), null);
});

test('normalizeHex：一律小写补全，认不出给 null（存进去的值必须是干净色值）', () => {
  assert.equal(normalizeHex('#ABC'), '#aabbcc');
  assert.equal(normalizeHex(' 4C8DFF '), '#4c8dff');
  assert.equal(normalizeHex('color-mix(in srgb, red, blue)'), null);
  assert.equal(normalizeHex(null), null);
});

test('accentShades：派生出柔和底 / 描边 / 焦点环 / 可读前景色', () => {
  const s = accentShades('#4c8dff');
  assert.equal(s.accent, '#4c8dff');
  assert.equal(s.soft, 'rgba(76, 141, 255, 0.12)');
  assert.equal(s.border, 'rgba(76, 141, 255, 0.36)');
  assert.equal(s.ring, 'rgba(76, 141, 255, 0.4)');
  assert.equal(accentShades('nope'), null);
});

test('可读前景色：亮强调色判深字、深强调色判白字；七个预设只有琥珀翻深字', () => {
  // 相对亮度越高越该配深字。阈值 0.54 是刻意选的（见 readableOn 注释）：正好只把琥珀翻过去。
  assert.equal(ACCENTS.find((a) => a.id === 'amber').hex, '#f7b955');
  assert.equal(accentForeground('#f7b955'), '#0b1220', '琥珀（最亮的那个）要配深字');
  for (const id of ['sky', 'indigo', 'violet', 'rose', 'emerald', 'sunset']) {
    const hex = ACCENTS.find((a) => a.id === id).hex;
    assert.equal(accentForeground(hex), '#ffffff', `${id} 应保持白字（默认外观不变）`);
  }
  assert.equal(readableOn({ r: 255, g: 255, b: 255 }), '#0b1220', '纯白底必须深字');
  assert.equal(readableOn({ r: 0, g: 0, b: 0 }), '#ffffff', '纯黑底必须白字');
  assert.equal(accentForeground('不是颜色'), '#ffffff', '认不出的颜色也要给一个安全值');
});

test('resolveAppearance：默认值、坏值回默认、越界夹紧', () => {
  const def = resolveAppearance({});
  assert.equal(def.mode, DEFAULTS.mode);
  assert.equal(def.scheme, DEFAULTS.scheme);
  assert.equal(def.accentPreset, DEFAULTS.accentPreset);
  assert.equal(def.accent, DEFAULT_ACCENT);
  assert.equal(def.radius, 1);
  assert.equal(def.zoom, 1);
  assert.equal(def.density, 'cozy');
  assert.equal(def.contrast, 'normal');
  assert.deepEqual(def.tweaks, {});

  const bad = resolveAppearance({
    mode: '紫色', scheme: '不存在', darkIntensity: 'x', accentPreset: 'nope', accent: 'xxx',
    accentScope: 'q', sidebarStyle: 'q', background: 'q', font: 'q', density: 'huge',
    radius: 99, zoom: -3, bgAngle: 9999, contrast: 'yes'
  });
  assert.equal(bad.mode, DEFAULTS.mode);
  assert.equal(bad.scheme, DEFAULTS.scheme);
  assert.equal(bad.darkIntensity, DEFAULTS.darkIntensity);
  assert.equal(bad.accentPreset, DEFAULTS.accentPreset);
  assert.equal(bad.accent, DEFAULT_ACCENT, '坏自定义色要回落到预设色');
  assert.equal(bad.customAccent, false);
  assert.equal(bad.accentScope, DEFAULTS.accentScope);
  assert.equal(bad.sidebarStyle, DEFAULTS.sidebarStyle);
  assert.equal(bad.background, DEFAULTS.background);
  assert.equal(bad.font, DEFAULTS.font);
  assert.equal(bad.density, DEFAULTS.density);
  assert.equal(bad.radius, 1.45, '越界夹到上限');
  assert.equal(bad.zoom, 0.8, '越界夹到下限');
  assert.equal(bad.bgAngle, 360, '角度夹到 0~360');
  assert.equal(bad.contrast, 'normal');
});

test('resolveAppearance：旧版 preset / theme 能被认出来（升级不丢用户的选择）', () => {
  // v2 用 ui.preset = snow|mint|amber|violet|rose 表示"主题配色"
  assert.equal(resolveAppearance({ preset: 'mint' }).accentPreset, 'emerald');
  assert.equal(resolveAppearance({ preset: 'snow' }).accent, DEFAULT_ACCENT);
  assert.equal(resolveAppearance({ preset: 'violet' }).accent, '#a78bfa');
  // v2 把明暗存在 ui.theme 上；v3 的模型字段叫 mode
  assert.equal(resolveAppearance({ theme: 'light' }).mode, 'light');
  assert.equal(resolveAppearance({ theme: 'system' }).mode, 'system');
  // 新版字段优先于旧版
  assert.equal(resolveAppearance({ theme: 'light', mode: 'dark' }).mode, 'dark');
  assert.equal(resolveAppearance({ preset: 'mint', accentPreset: 'rose' }).accentPreset, 'rose');
});

test('主题微调：只认白名单变量，值必须是合法颜色', () => {
  const app = resolveAppearance({
    tweaks: { '--bg': '#123456', '--junk': '#ffffff', '--text': 'red', '--muted': '#ABCDEF' }
  });
  assert.deepEqual(app.tweaks, { '--bg': '#123456', '--muted': '#abcdef' }, '非白名单与非法色值都要丢掉');
  assert.deepEqual(TWEAK_KEYS, TWEAK_VARS.map((v) => v.key), '白名单常量要与视图列表同源');
});

test('appearanceVars：只给"JS 才算得出的值"，派生色交给 CSS', () => {
  const vars = appearanceVars(resolveAppearance({ accentPreset: 'rose', radius: 1.2, zoom: 1.1 }));
  assert.deepEqual(Object.keys(vars).sort(), [
    '--accent', '--accent-fg', '--accent-side', '--bg-angle', '--bg-from', '--bg-solid', '--bg-to',
    '--bg', '--bg-2', '--bg-3', '--border', '--muted', '--r-scale', '--text', '--zoom'
  ].sort());
  assert.equal(vars['--accent'], '#f472b6');
  assert.equal(vars['--accent-side'], '#f472b6', '应用范围=全局时侧栏用同一个色');
  assert.equal(vars['--r-scale'], '1.2');
  assert.equal(vars['--zoom'], '1.1');
  assert.equal(vars['--bg-angle'], '135deg');
  // 派生色**不该**出现在这里：它们由 CSS 的 color-mix 从 --accent 现算
  for (const derived of ['--accent-soft', '--accent-border', '--accent-ring']) {
    assert.equal(derived in vars, false, `${derived} 应由 CSS 现算，不该由 JS 塞内联样式`);
  }
  // 主题微调没设置的键要显式给 null（调用方据此 removeProperty，把控制权还给色板）
  assert.equal(vars['--bg'], null);
  for (const v of Object.values(vars)) assert.ok(v === null || typeof v === 'string');
});

test('appearanceVars：应用范围=仅侧栏时全局保持默认蓝，只有 --accent-side 跟着走', () => {
  const app = resolveAppearance({ accentPreset: 'amber', accentScope: 'sidebar' });
  const vars = appearanceVars(app);
  assert.equal(vars['--accent'], DEFAULT_ACCENT, '全局强调色不许被染色（否则按钮突然变黄）');
  assert.equal(vars['--accent-side'], '#f7b955');
  assert.equal(vars['--accent-fg'], '#ffffff', '按钮上的字色要按"全局那一个色"算');
  assert.equal(appearanceVars(resolveAppearance({ accentPreset: 'amber' }))['--accent'], '#f7b955');
});

test('appearanceAttrs：属性名与取值语义（动效 off 压过 reduced；顶栏开关反过来）', () => {
  const plain = appearanceAttrs(resolveAppearance({}));
  assert.deepEqual(Object.keys(plain).sort(), [
    'accent-scope', 'background', 'contrast', 'dark-intensity', 'density', 'font', 'glass',
    'hide-badges', 'hide-theme-btn', 'motion', 'refract', 'scheme', 'side-rail', 'sidebar-style'
  ].sort());
  assert.equal('data-theme' in plain, false, 'data-theme 归 applyTheme 管，不在这里重复设');
  assert.equal(plain.motion, '');
  // 材质默认是液态玻璃（2026-10-19 定的项目默认外观）；只有显式选“实心”才不设属性
  assert.equal(plain.glass, 'liquid', '默认液态玻璃 → data-glass=liquid');
  assert.equal(appearanceAttrs(resolveAppearance({ glass: 'off' })).glass, '', '选实心才不设属性');
  assert.equal(appearanceAttrs(resolveAppearance({ glass: 'frost' })).glass, 'frost');
  assert.equal(appearanceAttrs(resolveAppearance({ glass: 'liquid' })).glass, 'liquid',
    '材质是“空串＝不设”那几个开关里的一员，取值口径得与 side-rail / hide-badges 一致');
  assert.equal(appearanceAttrs(resolveAppearance({ glass: '液态' })).glass, 'liquid',
    '不认识的材质 id 要回默认（不能把一个手改坏的值写到 <html> 上）');
  // 边缘折射：默认关，开了才发 '1'（与 side-rail / hide-badges 同口径）
  assert.equal(plain.refract, '', '默认不开折射');
  assert.equal(appearanceAttrs(resolveAppearance({ refract: true })).refract, '1');
  assert.equal(appearanceAttrs(resolveAppearance({ refract: 'yes' })).refract, '',
    '折射只认真正的 true，字符串不算（存档里被塞了垃圾也不该打开）');
  assert.equal(plain['hide-badges'], '', '默认显示徽章 → 不给隐藏标记');
  assert.equal(plain['hide-theme-btn'], '');
  // 侧栏默认就是"悬停展开的图标条"（与参照实现同默认）→ 默认要给标记；钉住才不给
  assert.equal(plain['side-rail'], '1', '默认＝图标条模式');
  assert.equal(appearanceAttrs(resolveAppearance({ sidebarPinned: true }))['side-rail'], '',
    '钉住侧栏＝不给图标条标记');

  assert.equal(appearanceAttrs(resolveAppearance({ reduceMotion: true })).motion, 'reduced');
  assert.equal(appearanceAttrs(resolveAppearance({ noMotion: true })).motion, 'off');
  assert.equal(
    appearanceAttrs(resolveAppearance({ reduceMotion: true, noMotion: true })).motion, 'off',
    '两个都开时取更彻底的"关闭全部动效"'
  );
  assert.equal(appearanceAttrs(resolveAppearance({ showBadges: false }))['hide-badges'], '1');
  assert.equal(appearanceAttrs(resolveAppearance({ showTopbarTheme: false }))['hide-theme-btn'], '1');
  assert.equal(appearanceAttrs(resolveAppearance({ contrast: 'high' })).contrast, 'high');
});

test('appearancePatch ⇄ resolveAppearance 往返稳定（存下去再读回来必须一样）', () => {
  const cases = [
    {},
    { mode: 'light', scheme: 'nord', darkIntensity: 'oled', accentPreset: 'sky', accentScope: 'sidebar' },
    { accent: '#ff8800', sidebarStyle: 'accent', background: 'gradient', bgFrom: '#111111', bgTo: '#222222', bgAngle: 45 },
    { font: 'serif', radius: 1.45, zoom: 0.8, density: 'roomy', tweaks: { '--bg': '#010203' } },
    { showBadges: false, showTopbarTheme: false, reduceMotion: true, contrast: 'high' },
    { sidebarPinned: true, sidebarStyle: 'panel' }
  ];
  for (const c of cases) {
    const once = resolveAppearance(c);
    const back = resolveAppearance(appearancePatch(once));
    assert.deepEqual(back, once, `往返后不一致：${JSON.stringify(c)}`);
    // 再走一轮也不能漂
    assert.deepEqual(resolveAppearance(appearancePatch(back)), once);
  }
  // 自定义色才会被写进 patch.accent；用预设时必须留空，否则预设永远被它压着
  assert.equal(appearancePatch(resolveAppearance({ accentPreset: 'sky' })).accent, '');
  assert.equal(appearancePatch(resolveAppearance({ accent: '#ff8800' })).accent, '#ff8800');
});

test('radiusTier：把倍率对回四档之一（设置页要把分段控件定位到当前档）', () => {
  assert.equal(radiusTier(1), 'default');
  assert.equal(radiusTier(0.6), 'compact');
  assert.equal(radiusTier(1.2), 'cozy');
  assert.equal(radiusTier(1.45), 'round');
  assert.equal(radiusTier(1.05), 'default', '落在两档之间取更近的那个');
  assert.equal(radiusTier(9), 'round');
  for (const r of RADII) assert.equal(radiusTier(r.value), r.id);
});

test('选项表都是 {id,label} 形状，且 id 唯一（渲染与保存都按 id 对表）', () => {
  const tables = { MODES, DARK_INTENSITIES, SCHEMES, ACCENTS, ACCENT_SCOPES, SIDEBAR_STYLES, BACKGROUNDS, FONTS, DENSITIES };
  for (const [name, list] of Object.entries(tables)) {
    const ids = list.map((x) => x.id);
    assert.equal(new Set(ids).size, ids.length, `${name} 的 id 有重复`);
    for (const item of list) {
      assert.equal(typeof item.id, 'string');
      assert.ok(item.label, `${name}.${item.id} 缺 label`);
    }
  }
  for (const a of ACCENTS) assert.ok(/^#[0-9a-f]{6}$/i.test(a.hex), `强调色 ${a.id} 的 hex 不合法`);
  for (const s of SCHEMES) assert.ok(s.hint, `色板 ${s.id} 缺 hint`);
});

// ── 默认外观（2026-10-19 定版：浅色 + 液态玻璃）──
test('默认外观三处真源一致：DEFAULTS 与服务端默认配置模板', async () => {
  const fs = await import('node:fs');
  assert.equal(DEFAULTS.mode, 'light', '项目默认明暗 = 浅色');
  assert.equal(DEFAULTS.glass, 'liquid', '项目默认材质 = 液态玻璃');
  const legacy = fs.readFileSync(new URL('../src/core/config-legacy.js', import.meta.url), 'utf8');
  assert.match(legacy, /\n    theme: 'light',/, '服务端默认配置模板的 ui.theme 也要是浅色');
  assert.match(legacy, /\n    glass: 'liquid',/, '模板要写明默认材质（缺键会被 deepMerge 补成这里的值）');
});

// 配色方案（表面色板）的"看得出差别"与"两处真源一致"。
//
// 为什么需要这条：2026-10-08 用户反馈"配色方案的效果不明显"。实测原因是五套色板
// 只是"在默认底色上挪了几个 RGB 单位" —— 两两之间暗色 ΔL* 仅 0.2~2.8（肉眼门槛约 3），
// 亮色 ΔL* 0.0~0.1（**完全同色**）。
// 这条用例把"必须可分辨"这个要求钉死，顺带守住预览卡的取色表（它是 CSS 之外的第二份真源）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const CSS = fs.readFileSync(path.resolve('ui/style.css'), 'utf8');
const PANEL = fs.readFileSync(path.resolve('ui/pages/settings-appearance.js'), 'utf8');

const SCHEMES = ['default', 'slate', 'rose', 'forest', 'nord'];

/** 从 style.css 里取某套色板在某套明暗下的变量。 */
function paletteVars(theme, scheme) {
  let block = '';
  if (scheme === 'default') {
    // 默认色板就是基础主题块（:root,[data-theme=dark] / [data-theme=light]）
    const re = theme === 'dark'
      ? /:root,\s*\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/
      : /\[data-theme='light'\]\s*\{([\s\S]*?)\n\}/;
    const m = CSS.match(re);
    assert.ok(m, `找不到 ${theme} 的基础变量块`);
    block = m[1];
  } else {
    const m = CSS.match(new RegExp(`\\[data-scheme='${scheme}'\\]\\[data-theme='${theme}'\\]\\s*\\{([\\s\\S]*?)\\n\\}`));
    assert.ok(m, `找不到色板 ${scheme}/${theme} 的变量块`);
    block = m[1];
  }
  const out = {};
  for (const k of ['--bg', '--bg-2', '--bg-3', '--border', '--text', '--muted']) {
    const m = block.match(new RegExp(`${k}:\\s*(#[0-9a-fA-F]{6})`));
    if (m) out[k] = m[1].toLowerCase();
  }
  assert.ok(out['--bg'] && out['--bg-2'], `色板 ${scheme}/${theme} 缺少 --bg / --bg-2`);
  return out;
}

const toRgb = (hex) => { const h = hex.replace('#', ''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const Y = (hex) => { const [r, g, b] = toRgb(hex); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
const Lstar = (hex) => { const y = Y(hex); return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y; };
const ratio = (a, b) => { const ya = Y(a), yb = Y(b); return (Math.max(ya, yb) + 0.05) / (Math.min(ya, yb) + 0.05); };
const chroma = (hex) => { const [r, g, b] = toRgb(hex); return Math.max(r, g, b) - Math.min(r, g, b); };
/** 色相差（环形），任一色彩度 <3 时视为"无彩色"，返回 null。 */
const hueGap = (a, b) => {
  if (chroma(a) < 3 || chroma(b) < 3) return null;
  const H = (hex) => { const [r, g, b2] = toRgb(hex); const mx = Math.max(r, g, b2), mn = Math.min(r, g, b2); let h; if (mx === r) h = 60 * (((g - b2) / (mx - mn)) % 6); else if (mx === g) h = 60 * (((b2 - r) / (mx - mn)) + 2); else h = 60 * (((r - g) / (mx - mn)) + 4); return (h + 360) % 360; };
  const d = Math.abs(H(a) - H(b));
  return Math.min(d, 360 - d);
};

test('五套色板两两看得见差别（暗色走亮度阶梯，亮色走色相/彩度）', () => {
  for (const theme of ['dark', 'light']) {
    const rows = SCHEMES.map((s) => ({ s, v: paletteVars(theme, s) }));
    for (let i = 0; i < rows.length; i += 1) {
      for (let j = i + 1; j < rows.length; j += 1) {
        const a = rows[i], b = rows[j];
        const dL = Math.abs(Lstar(a.v['--bg']) - Lstar(b.v['--bg']));
        const dCardL = Math.abs(Lstar(a.v['--bg-2']) - Lstar(b.v['--bg-2']));
        const dC = Math.abs(chroma(a.v['--bg']) - chroma(b.v['--bg']));
        const dH = hueGap(a.v['--bg'], b.v['--bg']);
        const ok = dL >= 4 || dCardL >= 3 || dC >= 8 || (dH !== null && dH >= 25);
        assert.ok(ok,
          `${theme}：${a.s} 与 ${b.s} 分不开（ΔL*(底)=${dL.toFixed(1)} ΔL*(卡)=${dCardL.toFixed(1)} `
          + `Δ彩度=${dC} Δ色相=${dH === null ? 'n/a' : dH.toFixed(0) + '°'}）—— `
          + '至少要让其中一项达标，否则用户看不出换了配色');
      }
    }
  }
});

test('每套色板自己内部可读（正文/次级/描边）', () => {
  for (const theme of ['dark', 'light']) {
    for (const s of SCHEMES) {
      const v = paletteVars(theme, s);
      const textBg = ratio(v['--text'], v['--bg']);
      const mutedBg = ratio(v['--muted'], v['--bg']);
      const borderCard = ratio(v['--border'], v['--bg-2']);
      assert.ok(textBg >= 7, `${theme}/${s} 正文对比度只有 ${textBg.toFixed(2)}（要 ≥7）`);
      assert.ok(mutedBg >= 4.4, `${theme}/${s} 次级文字只有 ${mutedBg.toFixed(2)}（要 ≥4.4）`);
      assert.ok(borderCard >= 1.2, `${theme}/${s} 描边只有 ${borderCard.toFixed(2)}（要 ≥1.2）`);
    }
  }
});

test('设置页的预览卡取色表与 style.css 一致（第二份真源不许漂）', () => {
  // 预览卡要显示"没选中的那几套"长什么样，取不到计算样式，只能在 JS 里存一份；
  // 存了就必须与 CSS 同步，否则预览是假的（点下去变另一个颜色）。
  const table = PANEL.match(/const SCHEME_PREVIEW = \{([\s\S]*?)\n\};/);
  assert.ok(table, 'settings-appearance.js 里找不到 SCHEME_PREVIEW');
  const src = table[1];
  for (const theme of ['dark', 'light']) {
    const seg = src.match(new RegExp(`${theme}: \\{([\\s\\S]*?)\\n  \\}`));
    assert.ok(seg, `取色表缺少 ${theme}`);
    for (const s of SCHEMES) {
      const row = seg[1].match(new RegExp(`${s}: \\{ bg: '(#[0-9a-f]{6})', card: '(#[0-9a-f]{6})' \\}`));
      assert.ok(row, `取色表缺少 ${theme}/${s}`);
      const css = paletteVars(theme, s);
      assert.equal(row[1].toLowerCase(), css['--bg'].toLowerCase(), `${theme}/${s} 的预览底色与 CSS 不一致`);
      assert.equal(row[2].toLowerCase(), css['--bg-2'].toLowerCase(), `${theme}/${s} 的预览卡片色与 CSS 不一致`);
    }
  }
});

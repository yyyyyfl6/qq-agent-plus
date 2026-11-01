// 扫 ui/ 里"漏进界面的 markdown 星号" —— 抽成共享实现，两处共用：
//   ① test/render-test.mjs（CI 的端到端回归里那一段）
//   ② test/ui-markdown-stars.test.mjs（跨平台的小用例）
//
// 为什么要抽出来：这段判据原本只活在 render-test.mjs 里，而那个文件在 Windows 上会先因为
// 别的原因失败 → 这段检查**在本地永远跑不到**。事实经过：2026-10-08 我往 appearance.js 里
// 写了一行 `** 2.4`（JS 幂运算符），本地全绿、CI 直接红（Linux 上那个文件是通的）。
// 判据只写一次、两个入口都调，才不会出现"本地看不见的检查"。
//
// 判据的边界（这两条是它的核心价值，别顺手放宽）：
//   · 只剔掉"引号里的星号串"（'******' 这种掩码），**不**剔成对的 `**` —— 那正好把要找的东西吃掉；
//   · 不能因为行里有 `//`（比如提示文案带 URL）就整行豁免，只截掉行尾那段真注释。
'use strict';

import fs from 'node:fs';
import path from 'node:path';

/** 一行源码里的"会被渲染的那部分"（非注释行规则 + 行尾注释截断 + 掩码剔除）。 */
export function shownPartOf(line) {
  if (/^\s*(\/\/|\*|\/\*)/.test(line)) return null;          // 整行是注释：不管
  const commentAt = /\s\/\//.exec(line);
  const shown = commentAt ? line.slice(0, commentAt.index) : line;
  if (!shown.trim()) return null;
  return shown.replace(/'[*]+'|"[*]+"/g, "''");               // 掩码不是 markdown
}

/** 判据自检：钉住"掩码不算、带 URL 的提示行要算"两条边界。 */
export const PROBE_CASES = [
  ['        <div class="hint">详见 https://example.com/help **报名** 流程</div>', true, '带 URL 的提示行仍要检出'],
  ['      <div class="hint">留空即保持 \'******\'</div>', false, "掩码 '******' 不是 markdown"]
];

/**
 * 扫一个目录下的所有 .js。
 * 返回 { offenders, probeFailures, scanned }；offenders 形如 `core/appearance.js:192`。
 */
export function scanDirForMarkdownStars(rootDir, { relTo = rootDir } = {}) {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : (e.name.endsWith('.js') ? [full] : []);
  });
  const offenders = [];
  let scanned = 0;
  for (const file of walk(rootDir)) {
    scanned += 1;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const shown = shownPartOf(lines[i]);
      if (shown && shown.includes('**')) {
        offenders.push(path.relative(relTo, file).split(path.sep).join('/') + ':' + (i + 1));
      }
    }
  }
  const probeFailures = [];
  for (const [line, shouldFlag, why] of PROBE_CASES) {
    const flagged = (shownPartOf(line) || '').includes('**');
    if (flagged !== shouldFlag) probeFailures.push(why);
  }
  return { offenders, probeFailures, scanned };
}

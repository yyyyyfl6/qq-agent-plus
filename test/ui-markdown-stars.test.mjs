// 界面文案里不许混进 markdown 星号（会原样显示给用户）。
//
// 这条判据原本只活在 test/render-test.mjs 里，而那个文件在 Windows 上会先因别的原因失败 ——
// 于是**本地永远跑不到这条检查**。事实经过（2026-10-08）：往 ui/core/appearance.js 里写了
// 一行 `((s + 0.055) / 1.055) ** 2.4`（JS 幂运算符），本地全量绿、CI 直接红在
// 「提示文案里混进 markdown 星号」上。判据本体抽到 test/helpers/ui-markdown-stars.mjs，
// 这里跨平台再跑一遍，别让"本地看不见的检查"再出现第二次。
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { scanDirForMarkdownStars, shownPartOf } = await import('./helpers/ui-markdown-stars.mjs');

test('ui/ 源码里没有漏进 HTML 模板的 markdown 星号', () => {
  const { offenders, scanned } = scanDirForMarkdownStars('ui', { relTo: '.' });
  assert.ok(scanned > 20, `应当扫到 ui/ 下所有 js，实际只扫了 ${scanned} 个`);
  assert.deepEqual(offenders, [], `这些行里的 ** 会被原样显示给用户：\n${offenders.join('\n')}`);
});

test('判据自检：掩码不算、带 URL 的提示行仍要检出（边界别被改坏）', () => {
  const { probeFailures } = scanDirForMarkdownStars('ui', { relTo: '.' });
  assert.deepEqual(probeFailures, [], `判据自检失败：${probeFailures.join(' | ')}`);

  // 直接钉死这两条边界，避免"helper 被改宽了但没人发现"
  assert.equal(shownPartOf('  <div class="hint">留空即保持 \'******\'</div>').includes('**'), false,
    "'******' 是掩码，不是 markdown 强调");
  assert.equal(shownPartOf('  <div class="hint">详见 https://example.com/help **报名** 流程</div>').includes('**'), true,
    '带 URL 的提示行不能被整行豁免（早先的坑）');
  assert.equal(shownPartOf('  // 注释里写 ** 不该管'), null, '整行注释不参与判定');
  // 注意 trim：行尾注释的截断点落在 `\s//` 里那个空白上，会留下一个尾空格（原判据的行为，不动它）
  assert.equal(shownPartOf('  return x / 3;  // 行尾注释 ** 也不算').trim(), 'return x / 3;', '只截掉行尾那段真注释');
});

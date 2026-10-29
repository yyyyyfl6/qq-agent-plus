// 拟人化评估脚本：客观指标 + CLI 可运行。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';

const { evaluateSamples } = await import('../scripts/humanize-eval.mjs');

it('统计样本长度、分条、提问、助手腔与重复开场白', () => {
  const report = evaluateSamples([
    { messages: ['在吗？', '今天吃啥？'] },
    { text: '刚吃完，懒得动。' },
    { text: '作为一个AI语言模型，希望对你有帮助。' },
    { text: '刚吃完，懒得动。' }
  ]);
  assert.equal(report.samples, 4);
  assert.equal(report.multiBubbleRate, 0.25);
  assert.ok(report.questionRate >= 0.25);
  assert.ok(report.aiTellRate >= 0.25);
  assert.ok(report.duplicateOpenerRate >= 0.5);
});

it('--severe-only 不把 grounded 保留的连接词算成助手腔', () => {
  const soft = evaluateSamples([{ text: '首先，我不太想去。其次，外面在下雨。' }]);
  assert.ok(soft.aiTellRate > 0, '默认统计 soft tell');
  const severe = evaluateSamples([{ text: '首先，我不太想去。其次，外面在下雨。' }], { includeSoft: false });
  assert.equal(severe.aiTellRate, 0);
});

it('CLI 能读 JSONL 并输出 JSON 报告', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-humanize-eval-'));
  const file = path.join(dir, 'samples.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ text: '在吗？' }),
    JSON.stringify({ text: '刚到学校。' })
  ].join('\n'));
  const out = execFileSync(process.execPath, [path.resolve('scripts/humanize-eval.mjs'), file], { encoding: 'utf8' });
  const report = JSON.parse(out);
  assert.equal(report.samples, 2);
  assert.equal(report.questionRate, 0.5);
  fs.rmSync(dir, { recursive: true, force: true });
});
